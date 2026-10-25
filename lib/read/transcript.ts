/**
 * The ACTIVE session's transcripts, read live: the main thread's file and
 * every subagent file under it.
 *
 * Why this exists: `claude_requests` is only filled by `ingest.sh`, which runs
 * on SessionEnd. Measured 2026-09-17 — the transcript had been written one
 * second earlier while the newest row in the database was 11 minutes old. So a
 * burn rate taken from the database reads "idle" during exactly the session
 * someone is watching the page for. This file reads the transcript the ingest
 * will later read, so the Live view is live.
 *
 * Three constraints shape it:
 *
 *  - **It never writes.** A read of the file Claude Code is appending to, and
 *    nothing else.
 *  - **It reads only the bytes it has not read before.** Transcripts reach
 *    38 MB (measured across 619 files, 782 MB total); re-reading one every 5
 *    seconds is not acceptable, so parsed progress is kept per file.
 *  - **It applies ingest's rule: MAX per token field per `requestId`.** 47% of
 *    usage rows repeat a requestId, and streaming writes partials with growing
 *    `output_tokens`, so summing rows overcounts and first-seen-wins
 *    undercounts. Diverging from that rule here would make the live number
 *    disagree with the stored one for the same work.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** One request, folded to its maxima — the same shape ingest.sh upserts. */
interface RequestTotals {
  /** First timestamp seen for this request, epoch seconds. MIN, as ingest takes. */
  ts: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface TranscriptUsage {
  /** Requests whose first timestamp falls inside the window. */
  windowRequests: number;
  windowTokensOut: number;
  /** Every request in the file, deduped: the session's own totals. */
  sessionRequests: number;
  sessionTokensOut: number;
  sessionTokensIn: number;
  latestTs: number | null;
  /**
   * `windowTokensOut` split into `buckets` equal slices of the window, oldest
   * first (empty when no bucket count was asked for). Grouping by timestamp,
   * for the burn-rate sparkline.
   */
  windowBuckets: number[];
}

interface FileState {
  /** Bytes already parsed. */
  offset: number;
  byId: Map<string, RequestTotals>;
}

/**
 * Parsed progress per file. The server is long-lived, so this turns each poll
 * into a read of just the new bytes.
 *
 * Bounded, least-recently-used: a session is its main file plus one file per
 * subagent it dispatched (up to dozens), so the cap is sized in files, not
 * sessions. Each entry is a map of a few hundred small records. A session with
 * more files than the cap still reads correctly -- the evicted files are simply
 * re-read from the start on the next poll.
 */
const CACHE_LIMIT = 256;
const cache = new Map<string, FileState>();

/** Default location of Claude Code's transcripts, matching ingest.sh. */
export function defaultTranscriptsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.WATCHTOWER_TRANSCRIPTS_DIR ?? path.join(os.homedir(), ".claude", "projects");
}

/**
 * The transcript for a session id: the main thread's file only.
 *
 * Claude Code names the file `<session-id>.jsonl` under a per-project
 * directory, so this is a scan of one level, not a recursive walk. Returns null
 * rather than throwing: a session with no transcript (an imported database, a
 * cleaned-up archive) is an ordinary state.
 *
 * Usage figures must come from {@link findSessionTranscripts}, which adds the
 * subagent files; this is the main thread alone.
 */
export function findTranscript(dir: string, sessionId: string): string | null {
  return findSessionTranscripts(dir, sessionId).find((f) => path.basename(f) === `${sessionId}.jsonl`) ?? null;
}

/**
 * Every transcript file that carries a session's requests.
 *
 * Claude Code writes a subagent's work to
 * `<project>/<session-id>/subagents/agent-*.jsonl`, and those rows carry the
 * PARENT's session id. `ingest.sh` walks the whole tree (`find -name
 * '*.jsonl'`), so `claude_requests` holds them under that session; a tail of the
 * main file alone reported 332 of a session's 747 requests and 63% of its
 * output (measured 2026-09-17). This returns the main file, when present, then
 * every `*.jsonl` in each `<session-id>/subagents/` directory -- the same files
 * ingest reads for this session, and no others.
 */
export function findSessionTranscripts(dir: string, sessionId: string): string[] {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return []; // never build a path from arbitrary text
  if (sessionId === "." || sessionId === "..") return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const main = path.join(dir, entry, `${sessionId}.jsonl`);
    if (existsSync(main)) files.push(main);
    const subDir = path.join(dir, entry, sessionId, "subagents");
    let subs: string[];
    try {
      subs = readdirSync(subDir);
    } catch {
      continue;
    }
    for (const f of subs.sort()) if (f.endsWith(".jsonl")) files.push(path.join(subDir, f));
  }
  return files;
}

function toEpochSeconds(iso: unknown): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** Fold one transcript line into the per-request maxima. */
function absorb(byId: Map<string, RequestTotals>, line: string): void {
  if (line === "" || !line.includes(`"usage"`)) return;
  let row: {
    requestId?: unknown; timestamp?: unknown;
    message?: { usage?: Record<string, unknown> };
  };
  try {
    row = JSON.parse(line);
  } catch {
    return; // a half-written final line is normal against a file being appended to
  }
  const usage = row.message?.usage;
  const id = row.requestId;
  if (usage === undefined || usage === null || typeof id !== "string" || id === "") return;
  const ts = toEpochSeconds(row.timestamp);
  if (ts === null) return;

  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const incoming: RequestTotals = {
    ts,
    tokensIn: n(usage.input_tokens),
    tokensOut: n(usage.output_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
    cacheCreation: n(usage.cache_creation_input_tokens),
  };
  const held = byId.get(id);
  if (held === undefined) {
    byId.set(id, incoming);
    return;
  }
  merge(held, incoming);
}

/**
 * MAX per token field, MIN on the timestamp — ingest.sh's rule, so the live
 * figure and the stored one describe the same work.
 */
function merge(held: RequestTotals, incoming: RequestTotals): void {
  held.ts = Math.min(held.ts, incoming.ts);
  held.tokensIn = Math.max(held.tokensIn, incoming.tokensIn);
  held.tokensOut = Math.max(held.tokensOut, incoming.tokensOut);
  held.cacheRead = Math.max(held.cacheRead, incoming.cacheRead);
  held.cacheCreation = Math.max(held.cacheCreation, incoming.cacheCreation);
}

/** Read the bytes appended since the last call and fold them in. */
function refresh(file: string): FileState | null {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return null;
  }
  let state = cache.get(file);
  if (state !== undefined) {
    // Re-insert to mark it recently used: eviction takes the oldest key.
    cache.delete(file);
    cache.set(file, state);
  }
  // A file that SHRANK was rewritten, so previously parsed offsets mean
  // nothing: start again rather than resume past the end, exactly as
  // ingest.sh's cursor does.
  if (state === undefined || size < state.offset) {
    state = { offset: 0, byId: new Map() };
    cache.set(file, state);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  }
  if (size === state.offset) return state;

  const length = size - state.offset;
  const buf = Buffer.allocUnsafe(length);
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return state;
  }
  let read = 0;
  try {
    read = readSync(fd, buf, 0, length, state.offset);
  } catch {
    return state;
  } finally {
    closeSync(fd);
  }

  const text = buf.subarray(0, read).toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  // Stop at the last complete line. The remainder is a record still being
  // written; leaving the offset before it means it is parsed once it is whole.
  if (lastNewline === -1) return state;
  for (const line of text.slice(0, lastNewline).split("\n")) absorb(state.byId, line.trim());
  state.offset += Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8");
  return state;
}

/**
 * Usage for one transcript: totals for the whole session, plus the subset
 * inside `[until - windowSeconds, until]`.
 */
export function readTranscriptUsage(
  file: string,
  opts: { until: number; windowSeconds: number },
): TranscriptUsage | null {
  return readSessionUsage([file], opts);
}

/**
 * Usage across every file of one session (see {@link findSessionTranscripts}),
 * folded as one: MAX per token field and MIN on the timestamp per `requestId`,
 * across files as well as within them -- ingest keys `claude_requests` on
 * `request_id` alone, so a request seen in two files is one request here too.
 * Null only when no file could be read at all.
 */
export function readSessionUsage(
  files: string[],
  opts: { until: number; windowSeconds: number; buckets?: number },
): TranscriptUsage | null {
  const states = files.map(refresh).filter((s): s is FileState => s !== null);
  if (states.length === 0) return null;
  const byId =
    states.length === 1 ? states[0].byId : new Map<string, RequestTotals>();
  if (states.length > 1) {
    for (const st of states) {
      for (const [id, r] of st.byId) {
        const held = byId.get(id);
        if (held === undefined) byId.set(id, { ...r });
        else merge(held, r);
      }
    }
  }

  const since = opts.until - opts.windowSeconds;
  let windowRequests = 0;
  let windowTokensOut = 0;
  let sessionTokensOut = 0;
  let sessionTokensIn = 0;
  let latestTs: number | null = null;
  const windowBuckets = new Array<number>(opts.buckets ?? 0).fill(0);
  for (const r of byId.values()) {
    sessionTokensOut += r.tokensOut;
    sessionTokensIn += r.tokensIn;
    if (latestTs === null || r.ts > latestTs) latestTs = r.ts;
    if (r.ts > since && r.ts <= opts.until) {
      windowRequests += 1;
      windowTokensOut += r.tokensOut;
      if (windowBuckets.length > 0) windowBuckets[bucketOf(r.ts, since, opts.windowSeconds, windowBuckets.length)] += r.tokensOut;
    }
  }
  return {
    windowRequests,
    windowTokensOut,
    sessionRequests: byId.size,
    sessionTokensOut,
    sessionTokensIn,
    latestTs,
    windowBuckets,
  };
}

/**
 * Which of `n` equal slices of `(since, since + window]` a timestamp falls in,
 * oldest first. The window's closing instant belongs to the last slice.
 */
export function bucketOf(ts: number, since: number, windowSeconds: number, n: number): number {
  return Math.max(0, Math.min(n - 1, Math.floor(((ts - since) / windowSeconds) * n)));
}

/** Test seam: forget parsed progress. */
export function resetTranscriptCache(): void {
  cache.clear();
}
