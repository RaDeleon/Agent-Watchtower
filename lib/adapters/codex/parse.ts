/**
 * One Codex rollout file -> its session and its records. PURE: text in, values
 * out, no I/O, so every rule is testable without a filesystem.
 *
 * Read: timestamps, line and payload types, the session's id, cwd, originator,
 * source and git branch/url, turn_context.model, and token usage. NEVER copied
 * into a record: message text, reasoning, base_instructions, last_agent_message
 * (spec §3: a passive observer copies no content).
 */
import { epochToRfc3339, type WatchtowerRecord } from "../../core/records.ts";

export const CODEX_SOURCE = "codex";

export interface RolloutSession {
  id: string;
  startedAt: number;
  endedAt: number;
  cwd?: string;
  /** The originator, or `subagent:<kind>` for a spawned agent (R2). */
  entry?: string;
  subagent: boolean;
  branch?: string;
  repo?: string;
  model?: string;
}

export interface ParsedRollout {
  /** Null when the file has no session_meta: skipped, not malformed. */
  session: RolloutSession | null;
  records: WatchtowerRecord[];
  /** Complete lines that are not JSON objects, and usage that normalises negative. */
  malformed: number;
  /** The last line has no newline and does not parse: it is being written now (R17). */
  partialTail: boolean;
}

type Usage = Record<string, unknown>;
export interface CodexTokens {
  tokens_in: number; tokens_cache_read: number; tokens_cache_creation: number;
  tokens_out: number; reasoning_tokens: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Codex's input_tokens INCLUDES both cache counts; Claude's tokens_in does not.
 * output_tokens already includes reasoning, which is kept as its own metric and
 * never added again (spec §3.2, R16).
 */
export function normalise(u: Usage): CodexTokens {
  const input = n(u.input_tokens), cached = n(u.cached_input_tokens), write = n(u.cache_write_input_tokens);
  const tokensIn = input - cached - write;
  if (tokensIn < 0) throw new Error(`cache counts exceed input_tokens (${cached} + ${write} > ${input})`);
  return {
    tokens_in: tokensIn, tokens_cache_read: cached, tokens_cache_creation: write,
    tokens_out: n(u.output_tokens), reasoning_tokens: n(u.reasoning_output_tokens),
  };
}

const FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens",
  "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;

/** a − b per field: one response's usage out of two running totals (b null = from zero). */
function minus(a: Usage, b: Usage | null): Usage {
  const out: Usage = {};
  for (const f of FIELDS) out[f] = n(a[f]) - (b === null ? 0 : n(b[f]));
  return out;
}

/** R2: a spawned agent's entry point, or undefined when the source is not a subagent. */
export function subagentOf(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null || !("subagent" in source)) return undefined;
  const s = (source as { subagent: unknown }).subagent;
  if (typeof s === "string") return `subagent:${s}`;
  if (typeof s !== "object" || s === null) return "subagent:unknown";
  const key = Object.keys(s)[0];
  if (key === undefined) return "subagent:unknown";
  const v = (s as Record<string, unknown>)[key];
  return key === "other" && typeof v === "string" ? `subagent:${v}` : `subagent:${key}`;
}

type Ev = "session_start" | "prompt" | "stop" | "activity";
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export function parseRollout(text: string, fileStem: string): ParsedRollout {
  const raw = text.split("\n");
  const open = !text.endsWith("\n");
  const lines: { no: number; o: Record<string, unknown> }[] = [];
  let malformed = 0;
  let partialTail = false;
  raw.forEach((s, i) => {
    if (s.trim() === "") return;
    try {
      const o: unknown = JSON.parse(s);
      if (typeof o === "object" && o !== null && !Array.isArray(o)) lines.push({ no: i + 1, o: o as Record<string, unknown> });
      else malformed++;
    } catch {
      if (open && i === raw.length - 1) partialTail = true;
      else malformed++;
    }
  });

  const first = lines.find((l) => l.o.type === "session_meta");
  const meta = (first?.o.payload ?? null) as Record<string, unknown> | null;
  if (first === undefined || meta === null || typeof meta.id !== "string") {
    return { session: null, records: [], malformed, partialTail };
  }
  const sid = meta.id;
  const sub = subagentOf(meta.source);
  const git = (meta.git ?? null) as Record<string, unknown> | null;
  const session: RolloutSession = {
    id: sid, startedAt: 0, endedAt: 0, subagent: sub !== undefined,
    entry: sub ?? str(meta.originator), cwd: str(meta.cwd),
    branch: str(git?.branch), repo: str(git?.repository_url),
  };

  const records: WatchtowerRecord[] = [];
  let lastSec: number | null = null;
  let model: string | undefined;
  let sawUsageRecord = false;
  let prevTotal: Usage | null = null;
  const request = (id: string, sec: number, t: CodexTokens): WatchtowerRecord => ({
    source: CODEX_SOURCE, sourceRecordId: id, kind: "request",
    timestamp: epochToRfc3339(sec), sessionId: sid, model, metrics: { ...t },
    authority: "authoritative", schemaVersion: 1,
  });

  for (const { no, o } of lines) {
    if (no < first.no) continue;
    const ms = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(ms)) continue;            // R17: no timestamp, no event
    const sec = Math.floor(ms / 1000);
    const p = (o.payload ?? {}) as Record<string, unknown>;
    let event: Ev = "activity";

    if (o.type === "session_meta") {
      // The file's own id again is a resume re-append; another id is a parent's
      // meta copied into a subagent's file, which is just a timestamped line (R2).
      if (p.id === sid) event = "session_start";
    } else if (o.type === "turn_context") {
      if (typeof p.model === "string") { model = p.model; session.model ??= p.model; }
    } else if (o.type === "event_msg") {
      if (p.type === "task_started") event = "prompt";
      else if (p.type === "task_complete" || p.type === "turn_aborted") event = "stop";
      else if (p.type === "token_count" && !sawUsageRecord) {
        // OLD FORMAT ONLY (R16). total_token_usage is a RUNNING TOTAL: one request
        // per distinct total, worth the delta from the previous one. Summing the
        // totals is the snapshot-counter bug (CLAUDE.md, 63x to 281x).
        const info = (p.info ?? null) as Record<string, unknown> | null;
        const total = (info?.total_token_usage ?? null) as Usage | null;
        if (total !== null) {
          const t = n(total.total_tokens);
          if (prevTotal === null || t !== n(prevTotal.total_tokens)) {
            const base = prevTotal !== null && t < n(prevTotal.total_tokens) ? null : prevTotal;
            prevTotal = total;
            try { records.push(request(`${sid}:${t}`, sec, normalise(minus(total, base)))); }
            catch { malformed++; }
          }
        }
      }
    } else if (o.type === "token_usage_record") {
      sawUsageRecord = true;
      const id = str(p.response_id);
      if (id === undefined) malformed++;
      else {
        try { records.push(request(id, sec, normalise((p.usage ?? {}) as Usage))); }
        catch { malformed++; }
      }
    }

    if (no === first.no) session.startedAt = sec;
    session.endedAt = Math.max(session.endedAt, sec);
    // R6: a same-second activity line adds no time; markers are always kept.
    if (event !== "activity" || sec !== lastSec) {
      records.push({
        source: CODEX_SOURCE, sourceRecordId: `${fileStem}:${no}`, kind: "event",
        timestamp: epochToRfc3339(sec), sessionId: sid, dimensions: { event, seq: no },
        authority: "authoritative", schemaVersion: 1,
      });
      lastSec = sec;
    }
  }
  return { session, records, malformed, partialTail };
}
