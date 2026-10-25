import { createHash } from "node:crypto";
import { execSql, execSqlBatch, querySql, sqlStr, sqlNum } from "./sql.ts";
import { writeAuthority } from "./adapters.ts";
import { toEpochSeconds, type RecordKind, type WatchtowerRecord } from "./records.ts";
import { resolveCanonicalIds } from "./identity.ts";

export interface IngestResult {
  /** Records written because they were new or had changed. */
  ingested: number;
  /** Records skipped because they matched what was last written. */
  unchanged: number;
  metricsRejected: number;
  malformed: number;
}

/**
 * Records per chunk: one fingerprint lookup, one link lookup, one write batch.
 *
 * It bounds three things at once -- memory (a stream is never drained whole,
 * see ingestRecordsStream), the IN lists that ride in argv, and how long one
 * batch holds the write lock. capture/lib.sh waits 4s for that lock on the hook
 * path, and a chunk this size commits in milliseconds.
 */
export const INGEST_CHUNK_SIZE = 500;

/**
 * Bump when the WRITE side changes how a record lands in wt_* -- a new column,
 * a different upsert rule. It is part of every fingerprint, so bumping it makes
 * every record look changed and the next sync rewrites them all. Changes on the
 * adapter side need no bump: they change the record, and so the fingerprint.
 */
const WRITE_FORMAT_VERSION = 1;

export interface IngestStateRow {
  source: string;
  cursor: string | null;
  last_run_at: number | null;
  last_ok_at: number | null;
  records_ingested: number;
  metrics_rejected: number;
  records_malformed: number;
  health: string;
  last_error: string | null;
}

/**
 * Metrics that have a typed column on wt_requests.
 *
 * Scoped to kind 'request' at the call site: on any other kind the same name
 * has no typed home and must fall through to wt_usage rather than vanish.
 */
const TYPED_REQUEST_METRICS = new Set([
  "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_creation", "cost_usd",
]);

type Dimensions = NonNullable<WatchtowerRecord["dimensions"]>;

function dimStr(dim: Dimensions, key: string): string | undefined {
  const v = dim[key];
  return v === undefined ? undefined : String(v);
}

/** A dimension used as a flag. Anything not recognisably boolean is LOUD. */
function dimFlag(dim: Dimensions, key: string): number | undefined {
  const v = dim[key];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v === 0 ? 0 : 1;
  if (v === "true" || v === "1") return 1;
  if (v === "false" || v === "0") return 0;
  throw new Error(`dimension ${key} is not a boolean: ${v}`);
}

function requestSql(
  source: string, r: WatchtowerRecord, canonical: string | null,
  ts: number, observed: number | undefined, accepted: Record<string, number>,
): string {
  const dim: Dimensions = r.dimensions ?? {};
  return `INSERT INTO wt_requests
      (source, source_record_id, canonical_id, ts, observed_at, model, agent,
       project, repo, branch, is_subagent, tokens_in, tokens_out,
       tokens_cache_read, tokens_cache_creation, cost_usd, error_status)
    VALUES (${sqlStr(source)}, ${sqlStr(r.sourceRecordId)}, ${sqlStr(canonical)},
      ${sqlNum(ts)}, ${sqlNum(observed)}, ${sqlStr(r.model)}, ${sqlStr(r.agent)},
      ${sqlStr(r.project)}, ${sqlStr(r.repo)},
      ${sqlStr(r.branch ?? dimStr(dim, "branch"))},
      ${sqlNum(dimFlag(dim, "is_subagent"))},
      ${sqlNum(accepted.tokens_in)}, ${sqlNum(accepted.tokens_out)},
      ${sqlNum(accepted.tokens_cache_read)}, ${sqlNum(accepted.tokens_cache_creation)},
      ${sqlNum(accepted.cost_usd)}, ${sqlStr(dimStr(dim, "error_status"))})
    ON CONFLICT(source, source_record_id) DO UPDATE SET
      canonical_id = COALESCE(excluded.canonical_id, wt_requests.canonical_id),
      observed_at  = COALESCE(excluded.observed_at, wt_requests.observed_at),
      model        = COALESCE(excluded.model, wt_requests.model),
      agent        = COALESCE(excluded.agent, wt_requests.agent),
      project      = COALESCE(excluded.project, wt_requests.project),
      repo         = COALESCE(excluded.repo, wt_requests.repo),
      branch       = COALESCE(excluded.branch, wt_requests.branch),
      is_subagent  = COALESCE(excluded.is_subagent, wt_requests.is_subagent),
      tokens_in    = COALESCE(excluded.tokens_in, wt_requests.tokens_in),
      tokens_out   = COALESCE(excluded.tokens_out, wt_requests.tokens_out),
      tokens_cache_read = COALESCE(excluded.tokens_cache_read, wt_requests.tokens_cache_read),
      tokens_cache_creation =
        COALESCE(excluded.tokens_cache_creation, wt_requests.tokens_cache_creation),
      cost_usd     = COALESCE(excluded.cost_usd, wt_requests.cost_usd),
      error_status = COALESCE(excluded.error_status, wt_requests.error_status);`;
}

function toolSql(
  source: string, r: WatchtowerRecord, canonical: string | null, ts: number,
): string {
  const dim: Dimensions = r.dimensions ?? {};
  const name = dimStr(dim, "tool_name");
  // wt_tools.tool_name is NOT NULL. Refusing here counts the record as
  // malformed; letting it fall through to wt_events would silently
  // reclassify a tool call as an untyped event.
  if (name === undefined || name === "") {
    throw new Error(`tool record ${r.sourceRecordId} requires dimensions.tool_name`);
  }
  return `INSERT INTO wt_tools
      (source, source_record_id, canonical_id, ts, tool_name, tool_kind, server, status)
    VALUES (${sqlStr(source)}, ${sqlStr(r.sourceRecordId)}, ${sqlStr(canonical)},
      ${sqlNum(ts)}, ${sqlStr(name)}, ${sqlStr(dimStr(dim, "tool_kind"))},
      ${sqlStr(dimStr(dim, "server"))}, ${sqlStr(dimStr(dim, "status"))})
    ON CONFLICT(source, source_record_id) DO UPDATE SET
      canonical_id = COALESCE(excluded.canonical_id, wt_tools.canonical_id),
      tool_name    = excluded.tool_name,
      tool_kind    = COALESCE(excluded.tool_kind, wt_tools.tool_kind),
      server       = COALESCE(excluded.server, wt_tools.server),
      status       = COALESCE(excluded.status, wt_tools.status);`;
}

function eventSql(
  source: string, r: WatchtowerRecord, canonical: string | null, ts: number,
): string {
  // Absent is not "{}" any more than it is 0: an empty object asserts "this
  // source reported no dimensions", which is a different fact from "this
  // source does not carry dimensions at all".
  const dims = r.dimensions === undefined ? null : JSON.stringify(r.dimensions);
  const meta = r.metadata === undefined ? null : JSON.stringify(r.metadata);
  return `INSERT INTO wt_events
      (source, source_record_id, canonical_id, ts, kind, project, repo, branch,
       dimensions, metadata)
    VALUES (${sqlStr(source)}, ${sqlStr(r.sourceRecordId)}, ${sqlStr(canonical)},
      ${sqlNum(ts)}, ${sqlStr(r.kind)}, ${sqlStr(r.project)}, ${sqlStr(r.repo)},
      ${sqlStr(r.branch)}, ${sqlStr(dims)}, ${sqlStr(meta)})
    ON CONFLICT(source, source_record_id) DO UPDATE SET
      ts           = excluded.ts, -- a re-sent record carries its newest time (OpenViking's single reachability probe)
      canonical_id = COALESCE(excluded.canonical_id, wt_events.canonical_id),
      project      = COALESCE(excluded.project, wt_events.project),
      repo         = COALESCE(excluded.repo, wt_events.repo),
      branch       = COALESCE(excluded.branch, wt_events.branch),
      dimensions   = COALESCE(excluded.dimensions, wt_events.dimensions),
      metadata     = COALESCE(excluded.metadata, wt_events.metadata);`;
}

/**
 * The running totals of one ingest RUN, whether it was fed synchronously or
 * streamed. It is a run, not a batch: the state row below is written once at
 * the end, so `health`, `last_ok_at` and `last_error` describe the whole run.
 */
interface RunTotals {
  res: IngestResult;
  lastError: string | null;
  may: (source: string, kind: RecordKind, metric: string) => boolean;
}

function newRun(db: string): RunTotals {
  return {
    res: { ingested: 0, unchanged: 0, metricsRejected: 0, malformed: 0 },
    lastError: null,
    may: writeAuthority(db),
  };
}

function fail(run: RunTotals, r: WatchtowerRecord, e: unknown): void {
  // A record that cannot be written is COUNTED and the run continues.
  // Aborting would make one bad record lose every good one behind it.
  run.res.malformed++;
  run.lastError = `${r.sourceRecordId}: ${String(e)}`.slice(0, 2000);
}

/** A record's planned write: its statements, then its fingerprint. */
interface PlannedWrite {
  r: WatchtowerRecord;
  statements: string[];
  rejected: number;
}

const fpKey = (id: string, kind: string) => `${id}\u0000${kind}`;

/**
 * Everything that decides what a record's write puts in wt_*: the record as
 * emitted, the canonical id it resolves to, and which of its metrics were
 * accepted. If none of those changed, rewriting the record changes nothing.
 */
function fingerprint(
  r: WatchtowerRecord, canonical: string | null, accepted: Record<string, number>,
): string {
  return createHash("sha1")
    .update(JSON.stringify([WRITE_FORMAT_VERSION, r, canonical, Object.keys(accepted).sort()]))
    .digest("hex");
}

/** One record's statements. Throws on a record that cannot be written. */
function plan(
  source: string, r: WatchtowerRecord, canonical: string | null,
  accepted: Record<string, number>, fp: string,
): string[] {
  const ts = toEpochSeconds(r.timestamp);
  const observed = r.observedAt ? toEpochSeconds(r.observedAt) : undefined;
  const out: string[] = [];

  if (r.kind === "request") out.push(requestSql(source, r, canonical, ts, observed, accepted));
  else if (r.kind === "tool") out.push(toolSql(source, r, canonical, ts));
  else out.push(eventSql(source, r, canonical, ts));

  // Accepted metrics with no typed home are preserved, never dropped.
  for (const [metric, value] of Object.entries(accepted)) {
    if (r.kind === "request" && TYPED_REQUEST_METRICS.has(metric)) continue;
    out.push(`INSERT INTO wt_usage
        (source, source_record_id, canonical_id, ts, metric, value)
      VALUES (${sqlStr(source)}, ${sqlStr(r.sourceRecordId)}, ${sqlStr(canonical)},
              ${sqlNum(ts)}, ${sqlStr(metric)}, ${sqlNum(value)})
      ON CONFLICT(source, source_record_id, metric) DO UPDATE SET
        ts = excluded.ts,
        value = excluded.value;`);
  }

  // LAST, so a record whose write fails is never marked as written.
  out.push(`INSERT INTO wt_record_fingerprints (source, source_record_id, kind, fingerprint)
    VALUES (${sqlStr(source)}, ${sqlStr(r.sourceRecordId)}, ${sqlStr(r.kind)}, ${sqlStr(fp)})
    ON CONFLICT(source, source_record_id, kind) DO UPDATE SET
      fingerprint = excluded.fingerprint;`);
  return out;
}

function storedFingerprints(
  db: string, source: string, chunk: WatchtowerRecord[],
): Map<string, string> {
  const ids = [...new Set(chunk.map((r) => r.sourceRecordId))];
  const rows = querySql<{ source_record_id: string; kind: string; fingerprint: string }>(db,
    `SELECT source_record_id, kind, fingerprint FROM wt_record_fingerprints
      WHERE source = ${sqlStr(source)}
        AND source_record_id IN (${ids.map(sqlStr).join(", ")});`);
  return new Map(rows.map((x) => [fpKey(x.source_record_id, x.kind), x.fingerprint]));
}

/**
 * Write one chunk.
 *
 * Unchanged records are skipped. The rest go to sqlite3 as ONE batch. If the
 * batch fails, nothing from it was written (execSqlBatch rolls back), and the
 * chunk is replayed one statement at a time -- exactly the old path -- so a
 * single bad record is counted as malformed and every good one still lands.
 */
function ingestChunk(
  db: string, source: string, chunk: WatchtowerRecord[], run: RunTotals,
): void {
  if (chunk.length === 0) return;
  const stored = storedFingerprints(db, source, chunk);
  const links = resolveCanonicalIds(db, source,
    chunk.flatMap((r) => (r.sessionId ? [r.sessionId] : [])), "same_session");
  const planned: PlannedWrite[] = [];

  for (const r of chunk) {
    // THE AUTHORITY RULE. Split the record's metrics into accepted and
    // rejected BEFORE any write, so a non-authoritative metric never reaches
    // the database even transiently. A rejection is not an error -- Atlas
    // legitimately carries token_totals and being refused is the system
    // working -- but it is COUNTED so the volume stays visible. Silent drops
    // are how a 2x error hides.
    //
    // Rejected metrics are not diverted to wt_usage either: the overflow
    // table is for accepted metrics with no typed column, and routing a
    // refused number there would readmit it by another door.
    const accepted: Record<string, number> = {};
    let rejected = 0;
    for (const [metric, value] of Object.entries(r.metrics ?? {})) {
      if (run.may(source, r.kind, metric)) accepted[metric] = value;
      else rejected++;
    }

    const canonical = r.sessionId ? links.get(r.sessionId) ?? null : null;
    const fp = fingerprint(r, canonical, accepted);
    const key = fpKey(r.sourceRecordId, r.kind);
    if (stored.get(key) === fp) {
      run.res.unchanged++;
      continue;
    }

    try {
      planned.push({ r, statements: plan(source, r, canonical, accepted, fp), rejected });
      // A repeat of this exact record later in the chunk is now unchanged.
      stored.set(key, fp);
    } catch (e) {
      fail(run, r, e);
    }
  }

  if (planned.length === 0) return;
  try {
    execSqlBatch(db, planned.flatMap((p) => p.statements));
    for (const p of planned) {
      run.res.ingested++;
      run.res.metricsRejected += p.rejected;
    }
  } catch {
    for (const p of planned) {
      try {
        for (const stmt of p.statements) execSql(db, stmt);
        run.res.ingested++;
        run.res.metricsRejected += p.rejected;
      } catch (e) {
        fail(run, p.r, e);
      }
    }
  }
}

/**
 * The run's outcome, written ONCE at the end.
 *
 * Once, and not per batch, is load-bearing: the counters accumulate with `+=`
 * and would survive being split, but `health`, `last_ok_at` and `last_error`
 * would not. Written per batch, a clean final batch would set last_ok_at and
 * flip health back to "ok" after an earlier batch had gone degraded, and
 * last_error would keep the FIRST failure rather than the last.
 */
function writeRunState(db: string, source: string, run: RunTotals): void {
  const now = Math.floor(Date.now() / 1000);
  const health = run.res.malformed > 0 ? "degraded" : "ok";
  execSql(db, `INSERT INTO wt_ingest_state
      (source, last_run_at, last_ok_at, records_ingested, metrics_rejected,
       records_malformed, health, last_error)
    VALUES (${sqlStr(source)}, ${sqlNum(now)},
            ${run.res.malformed > 0 ? "NULL" : sqlNum(now)},
            ${sqlNum(run.res.ingested)}, ${sqlNum(run.res.metricsRejected)},
            ${sqlNum(run.res.malformed)}, ${sqlStr(health)}, ${sqlStr(run.lastError)})
    ON CONFLICT(source) DO UPDATE SET
      last_run_at       = excluded.last_run_at,
      last_ok_at        = COALESCE(excluded.last_ok_at, wt_ingest_state.last_ok_at),
      records_ingested  = wt_ingest_state.records_ingested + excluded.records_ingested,
      metrics_rejected  = wt_ingest_state.metrics_rejected + excluded.metrics_rejected,
      records_malformed = wt_ingest_state.records_malformed + excluded.records_malformed,
      health            = excluded.health,
      last_error        = COALESCE(excluded.last_error, wt_ingest_state.last_error);`);
}

export function ingestRecords(
  db: string, source: string, records: Iterable<WatchtowerRecord>,
  chunkSize = INGEST_CHUNK_SIZE,
): IngestResult {
  const run = newRun(db);
  let chunk: WatchtowerRecord[] = [];
  for (const r of records) {
    chunk.push(r);
    if (chunk.length >= chunkSize) {
      ingestChunk(db, source, chunk, run);
      chunk = [];
    }
  }
  ingestChunk(db, source, chunk, run);
  writeRunState(db, source, run);
  return run.res;
}

/**
 * The same run, fed by an ASYNC iterable.
 *
 * This exists so runSync never has to drain an adapter into an array. The
 * adapter contract is async and ingestRecords is synchronous, and the obvious
 * bridge -- push every record into a `WatchtowerRecord[]` first -- puts the
 * whole archive back on the heap, which is exactly what paging the reads in
 * lib/core/sql.ts was for. At most one chunk is held at a time.
 *
 * The state row is written once, at the end, by the same writeRunState the
 * synchronous path uses, so the returned IngestResult and every column of
 * wt_ingest_state are identical to what draining would have produced.
 *
 * Interleaving the reads with the writes is safe because they touch different
 * tables. The generators read claude_*, ingestChunk writes wt_*, and each page
 * is its own sqlite3 process with no cursor held open across it -- so a write
 * between two pages cannot shift which source rows the next page sees.
 */
export async function ingestRecordsStream(
  db: string, source: string, records: AsyncIterable<WatchtowerRecord>,
  chunkSize = INGEST_CHUNK_SIZE,
): Promise<IngestResult> {
  const run = newRun(db);
  let chunk: WatchtowerRecord[] = [];
  for await (const r of records) {
    chunk.push(r);
    if (chunk.length >= chunkSize) {
      ingestChunk(db, source, chunk, run);
      chunk = [];
    }
  }
  ingestChunk(db, source, chunk, run);
  writeRunState(db, source, run);
  return run.res;
}

/**
 * The counters are CUMULATIVE across runs. Overwriting them would make a
 * rejection burst invisible the moment a clean run followed it.
 *
 * A source that has never run has no row, and that is not the same fact as a
 * source that ran and ingested nothing -- so this throws rather than
 * fabricating zeroes.
 */
export function readIngestState(db: string, source: string): IngestStateRow {
  const r = querySql<IngestStateRow>(db,
    `SELECT source, cursor, last_run_at, last_ok_at, records_ingested,
            metrics_rejected, records_malformed, health, last_error
       FROM wt_ingest_state WHERE source = ${sqlStr(source)};`);
  if (r.length === 0) throw new Error(`no ingest state for source ${source}`);
  return r[0];
}

/**
 * Add source-side malformed lines -- ones that never became records, such as a
 * complete Codex line that is not JSON -- to the state the run just wrote. The
 * run is degraded. last_ok_at is left alone: every record that did parse was
 * written, so "data as of" stays true.
 */
export function addMalformed(db: string, source: string, n: number, detail?: string): void {
  if (n <= 0) return;
  execSql(db, `UPDATE wt_ingest_state SET
      records_malformed = records_malformed + ${sqlNum(n)},
      health = 'degraded',
      last_error = COALESCE(${sqlStr(detail ?? null)}, last_error)
    WHERE source = ${sqlStr(source)};`);
}

/**
 * A run that threw before it finished. It is degraded, with the reason, and
 * nothing else changes: a run that never completed has no counters to add, and
 * last_ok_at keeps the last run that did.
 */
export function recordRunFailure(db: string, source: string, error: string): void {
  execSql(db, `INSERT INTO wt_ingest_state (source, last_run_at, health, last_error)
    VALUES (${sqlStr(source)}, ${sqlNum(Math.floor(Date.now() / 1000))}, 'degraded',
            ${sqlStr(error.slice(0, 2000))})
    ON CONFLICT(source) DO UPDATE SET
      last_run_at = excluded.last_run_at,
      health      = 'degraded',
      last_error  = excluded.last_error;`);
}
