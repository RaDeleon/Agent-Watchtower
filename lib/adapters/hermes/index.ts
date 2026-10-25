import os from "node:os";
import type { AdapterHealth, DetectionResult, WatchtowerAdapter } from "../../core/adapters.ts";
import { detectSource, lookedAt } from "../../core/discovery.ts";
import {
  agentSessionSql, linkExactSql, mintCanonicalId, resolveCanonicalIds, setSessionStateSql,
} from "../../core/identity.ts";
import { epochToRfc3339, type WatchtowerRecord } from "../../core/records.ts";
import { errorLine, execSql, execSqlBatch, pagedRows, querySql, SQL_PAGE_SIZE } from "../../core/sql.ts";
import { classifyEntry, reclassifySql, type EntryLists } from "../entry.ts";

export const HERMES_SOURCE = "hermes";
export const HERMES_ADAPTER_VERSION = 1;
const STOPS = new Set(["stop", "length", "error"]);

interface SessionRow {
  id: string; source: string; model: string | null; started_at: number; ended_at: number | null;
  cwd: string | null; git_branch: string | null; git_repo_root: string | null;
}
interface MessageRow { id: number; session_id: string; role: string; timestamp: number; finish_reason: string | null }
interface UsageRow {
  session_id: string; model: string; billing_provider: string; billing_base_url: string;
  billing_mode: string; task: string; started_at: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number;
  cache_write_tokens: number; reasoning_tokens: number;
  estimated_cost_usd: number | null; actual_cost_usd: number | null; cost_status: string | null;
}

/**
 * Hermes's own figure for one usage row (R8): the actual cost when there is one,
 * else the estimate when Hermes says it estimated, else nothing -- "Hermes didn't
 * price this", never $0. Never an input to "at API prices" (decision 4).
 */
export function hermesCost(u: Pick<UsageRow, "actual_cost_usd" | "estimated_cost_usd" | "cost_status">):
    { cost_usd: number; cost_actual: 0 | 1 } | null {
  if (u.actual_cost_usd !== null && u.actual_cost_usd > 0) return { cost_usd: u.actual_cost_usd, cost_actual: 1 };
  if (u.cost_status === "estimated" && u.estimated_cost_usd !== null) return { cost_usd: u.estimated_cost_usd, cost_actual: 0 };
  return null;
}

const ev = (id: string, sec: number, sessionId: string, event: string, seq: number): WatchtowerRecord => ({
  source: HERMES_SOURCE, sourceRecordId: id, kind: "event", authority: "authoritative", schemaVersion: 1,
  timestamp: epochToRfc3339(sec), sessionId, dimensions: { event, seq },
});

/**
 * Hermes, from ~/.hermes/state.db, opened READ-ONLY (sqlite3 -readonly with a
 * busy timeout; the WAL fallback in querySql). Only timestamps, roles, finish
 * reasons, models, token counts and costs are selected: never content,
 * reasoning, system_prompt, title or tool calls.
 */
export function createHermesAdapter(opts: {
  db: string; home?: string; lists: EntryLists; stateDb?: string;
}): WatchtowerAdapter {
  const { db, lists } = opts;
  const home = opts.home ?? os.homedir();
  const src = opts.stateDb ?? lookedAt("hermes", home);
  const read = <T>(sql: string) => pagedRows<T>(src, sql, SQL_PAGE_SIZE, { readonly: true });

  return {
    id: HERMES_SOURCE,
    type: "agent",
    label: "Hermes",
    version: HERMES_ADAPTER_VERSION,
    capabilities: ["sessions", "requests", "usage"],
    authority: [{
      kind: "request", scope: "own",
      metrics: ["tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_creation",
        "reasoning_tokens", "cost_usd", "cost_actual"],
    }],

    async detect(): Promise<DetectionResult> {
      return detectSource("hermes", { home });
    },

    async health(): Promise<AdapterHealth> {
      const d = await this.detect();
      if (!d.detected) return { state: "unavailable", detail: d.detail };
      try {
        const n = querySql<{ n: number }>(src, "SELECT COUNT(*) AS n FROM sessions;", { readonly: true })[0].n;
        return { state: "ok", detail: `${n} sessions` };
      } catch (e) {
        return { state: "unavailable", detail: errorLine(e) };
      }
    },

    async *ingest(): AsyncIterable<WatchtowerRecord> {
      // Identity FIRST: every session and its link before any record that names it.
      const sessions = [...read<SessionRow>(
        "SELECT id, source, model, started_at, ended_at, cwd, git_branch, git_repo_root FROM sessions ORDER BY id")];
      for (let i = 0; i < sessions.length; i += 500) {
        const chunk = sessions.slice(i, i + 500);
        const known = resolveCanonicalIds(db, HERMES_SOURCE, chunk.map((s) => s.id), "same_session");
        execSqlBatch(db, chunk.flatMap((s) => {
          const canonical = known.get(s.id) ?? mintCanonicalId();
          return [
            agentSessionSql({
              canonicalId: canonical, source: HERMES_SOURCE,
              startedAt: Math.floor(s.started_at),
              endedAt: s.ended_at === null ? undefined : Math.floor(s.ended_at),
              cwd: s.cwd ?? undefined, entry: s.source, driven: classifyEntry(s.source, lists),
              repo: s.git_repo_root ?? undefined, branch: s.git_branch ?? undefined,
              model: s.model ?? undefined,
            }),
            linkExactSql({
              source: HERMES_SOURCE, sourceLocalId: s.id, linkKind: "same_session",
              canonicalId: canonical, evidence: `sessions.id=${s.id}`,
            }),
            setSessionStateSql(canonical, HERMES_SOURCE, s.ended_at === null ? "pending" : "complete"),
          ];
        }));
      }

      for (const s of sessions) {
        yield ev(`start:${s.id}`, Math.floor(s.started_at), s.id, "session_start", 0);
        if (s.ended_at !== null) {
          yield ev(`end:${s.id}`, Math.floor(s.ended_at), s.id, "session_end", Number.MAX_SAFE_INTEGER);
        }
      }

      for (const m of read<MessageRow>(
        "SELECT id, session_id, role, timestamp, finish_reason FROM messages ORDER BY id")) {
        const event = m.role === "user" ? "prompt"
          : m.role === "assistant" && STOPS.has(m.finish_reason ?? "") ? "stop" : "activity";
        yield ev(`msg:${m.id}`, Math.floor(m.timestamp), m.session_id, event, m.id);
      }

      // ts is the session's start: Hermes stores no per-call time (spec §3.3).
      for (const u of read<UsageRow>(
        `SELECT u.session_id, u.model, u.billing_provider, u.billing_base_url, u.billing_mode, u.task,
                s.started_at, u.input_tokens, u.output_tokens, u.cache_read_tokens,
                u.cache_write_tokens, u.reasoning_tokens, u.estimated_cost_usd,
                u.actual_cost_usd, u.cost_status
           FROM session_model_usage u JOIN sessions s ON s.id = u.session_id
          ORDER BY u.session_id, u.model, u.billing_provider, u.billing_base_url, u.billing_mode, u.task`)) {
        const cost = hermesCost(u);
        yield {
          source: HERMES_SOURCE,
          sourceRecordId: JSON.stringify([u.session_id, u.model, u.billing_provider,
            u.billing_base_url, u.billing_mode, u.task]),
          kind: "request", authority: "authoritative", schemaVersion: 1,
          timestamp: epochToRfc3339(Math.floor(u.started_at)),
          sessionId: u.session_id,
          model: u.model === "" ? undefined : u.model,
          metrics: {
            tokens_in: u.input_tokens, tokens_out: u.output_tokens,
            tokens_cache_read: u.cache_read_tokens, tokens_cache_creation: u.cache_write_tokens,
            reasoning_tokens: u.reasoning_tokens,
            ...(cost === null ? {} : cost),
          },
        };
      }
    },

    finish() {
      execSql(db, reclassifySql(HERMES_SOURCE, lists));
      return { malformed: 0 };
    },
  };
}
