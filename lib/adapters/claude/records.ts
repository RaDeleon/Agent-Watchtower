import { pagedRows } from "../../core/sql.ts";
import type { WatchtowerRecord } from "../../core/records.ts";
import { epochToRfc3339 } from "../../core/records.ts";
import { CLAUDE_SOURCE } from "./sessions.ts";

export { epochToRfc3339 } from "../../core/records.ts";

interface RequestRow {
  request_id: string;
  session_id: string | null;
  ts: number;
  project_path: string | null;
  git_branch: string | null;
  model: string | null;
  is_sidechain: number;
  tokens_in: number; tokens_out: number;
  tokens_cache_read: number; tokens_cache_creation: number;
  api_error_status: string | null;
}

/**
 * Every row of claude_requests, as a canonical record.
 *
 * The LEFT JOIN is to claude_project_paths and NOT to claude_sessions. 22.4% of
 * requests predate the tracker and have no session row; an inner join through
 * claude_sessions drops them while the reconciliation identity still passes,
 * which is why that specific join is prohibited rather than merely discouraged.
 *
 * claude_requests deliberately carries no project_path column -- cwd resolves
 * through the claude_project_paths cache at read time, exactly as rollup.sh
 * does it.
 *
 * Read in pages. As one query this rendered 9,895,624 bytes on the live
 * archive and blew Node's 1 MiB default maxBuffer, projecting nothing at all;
 * request_id is a PRIMARY KEY, so ORDER BY over it is the total order paging
 * needs to stay lossless.
 */
export function* claudeRequestRecords(db: string): Generator<WatchtowerRecord> {
  const rows = pagedRows<RequestRow>(db, `
    SELECT r.request_id, r.session_id, r.ts,
           p.project_path AS project_path,
           r.git_branch, r.model,
           COALESCE(r.is_sidechain, 0) AS is_sidechain,
           COALESCE(r.tokens_in, 0)              AS tokens_in,
           COALESCE(r.tokens_out, 0)             AS tokens_out,
           COALESCE(r.tokens_cache_read, 0)      AS tokens_cache_read,
           COALESCE(r.tokens_cache_creation, 0)  AS tokens_cache_creation,
           r.api_error_status
      FROM claude_requests r
      LEFT JOIN claude_project_paths p ON p.cwd = r.cwd
     WHERE r.ts IS NOT NULL
     ORDER BY r.request_id`);

  for (const row of rows) {
    yield {
      source: CLAUDE_SOURCE,
      sourceRecordId: row.request_id,
      kind: "request",
      timestamp: epochToRfc3339(row.ts),
      sessionId: row.session_id ?? undefined,
      project: row.project_path ?? undefined,
      branch: row.git_branch ?? undefined,
      agent: CLAUDE_SOURCE,
      model: row.model ?? undefined,
      metrics: {
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        tokens_cache_read: row.tokens_cache_read,
        tokens_cache_creation: row.tokens_cache_creation,
      },
      dimensions: {
        is_subagent: row.is_sidechain === 1,
        ...(row.api_error_status ? { error_status: row.api_error_status } : {}),
      },
      authority: "authoritative",
      schemaVersion: 1,
    };
  }
}

interface EventRow {
  id: number; ts: number; session_id: string | null;
  hook_event_name: string; project_path: string | null;
  repo: string | null; payload_json: string | null;
}

/**
 * claude_events -> canonical events.
 *
 * kind is 'event' for every row and the hook name rides in dimensions.
 * RECORD_KINDS is a closed set the validator enforces, and hook_event_name is
 * Claude-specific vocabulary -- widening the shared set for one source's
 * wording is the failure the taxonomy exists to prevent. See spec §3B.2.
 *
 * source_record_id is the autoincrement id, which is the only unique key
 * claude_events has.
 *
 * Read in pages: 2,097,717 bytes as one query on the live archive, twice the
 * old default ceiling. payload_json makes the row width genuinely unbounded,
 * which is the strongest reason of the four not to read this table whole.
 */
export function* claudeEventRecords(db: string): Generator<WatchtowerRecord> {
  const rows = pagedRows<EventRow>(db, `
    SELECT id, ts, session_id, hook_event_name, project_path, repo, payload_json
      FROM claude_events
     WHERE ts IS NOT NULL AND hook_event_name IS NOT NULL
     ORDER BY id`);

  for (const row of rows) {
    yield {
      source: CLAUDE_SOURCE,
      sourceRecordId: String(row.id),
      kind: "event",
      timestamp: epochToRfc3339(row.ts),
      sessionId: row.session_id ?? undefined,
      project: row.project_path ?? undefined,
      repo: row.repo ?? undefined,
      agent: CLAUDE_SOURCE,
      dimensions: { hook_event_name: row.hook_event_name },
      ...(row.payload_json ? { metadata: { payload: row.payload_json } } : {}),
      authority: "authoritative",
      schemaVersion: 1,
    };
  }
}

interface ToolRow {
  request_id: string; ts: number; session_id: string | null;
  project_path: string | null;
  attribution_skill: string | null;
  attribution_mcp_server: string | null;
  attribution_mcp_tool: string | null;
  attribution_plugin: string | null;
}

/**
 * claude_requests' attribution columns -> tool records.
 *
 * Only rows that actually name a tool are emitted. wt_tools.tool_name is NOT NULL
 * and writeTool counts a nameless record as malformed, so emitting a row per
 * request would turn most of the archive into a malformed-record count.
 *
 * The id is suffixed so it can never collide with the request record drawn
 * from the same row: wt_requests and wt_tools are different tables, but a
 * shared source_record_id would make the two rows indistinguishable in any
 * union across them.
 *
 * Read in pages: 2,062,152 bytes as one query on the live archive. The WHERE
 * clause narrows the rows but not the ordering key -- request_id stays unique
 * across whatever survives the filter, which is what paging requires.
 */
export function* claudeToolRecords(db: string): Generator<WatchtowerRecord> {
  const rows = pagedRows<ToolRow>(db, `
    SELECT r.request_id, r.ts, r.session_id, p.project_path,
           r.attribution_skill, r.attribution_mcp_server,
           r.attribution_mcp_tool, r.attribution_plugin
      FROM claude_requests r
      LEFT JOIN claude_project_paths p ON p.cwd = r.cwd
     WHERE r.ts IS NOT NULL
       AND COALESCE(r.attribution_skill, r.attribution_mcp_tool,
                    r.attribution_plugin) IS NOT NULL
     ORDER BY r.request_id`);

  for (const row of rows) {
    const name = row.attribution_skill ?? row.attribution_mcp_tool ?? row.attribution_plugin;
    if (name === null || name === "") continue;
    const kind = row.attribution_skill ? "skill"
      : row.attribution_mcp_tool ? "mcp" : "plugin";

    yield {
      source: CLAUDE_SOURCE,
      sourceRecordId: `${row.request_id}:tool`,
      kind: "tool",
      timestamp: epochToRfc3339(row.ts),
      sessionId: row.session_id ?? undefined,
      project: row.project_path ?? undefined,
      agent: CLAUDE_SOURCE,
      dimensions: {
        tool_name: name,
        tool_kind: kind,
        ...(row.attribution_mcp_server ? { server: row.attribution_mcp_server } : {}),
      },
      authority: "authoritative",
      schemaVersion: 1,
    };
  }
}

interface SessionMetricRow {
  session_id: string; ts: number;
  // NULLABLE, all three. A NULL is "the status line never reported this",
  // which is a different fact from a measured zero -- see the generator below.
  cost_usd: number | null;
  lines_added: number | null;
  lines_removed: number | null;
}

/**
 * Session-level metrics drawn from claude_status_snapshots.
 *
 * MAX per session, NEVER SUM. That table carries CUMULATIVE running totals, so
 * summing a column across its rows multiplies it by the number of snapshots:
 * measured on total_lines_added, the naive sum gives 80,885,856 against a true
 * 287,125 -- a 281.7x overcount. rollup.sh:423 already reduces cost this way.
 *
 * Three metrics and no more. The token columns on this table are context-window
 * OCCUPANCY, not consumption; taking them was wrong by 63x on input and 201x on
 * output, and is the defect Stage 2 exists to correct.
 *
 * PAGED TOO, though this one was never close to the limit: the GROUP BY reduces
 * 68,396 snapshot rows to 2,537 sessions and renders 119,473 bytes, a tenth of
 * even the OLD ceiling. It is paged anyway because "one row per session" is not
 * a bound -- sessions accumulate monotonically, exactly as requests do, so this
 * is the same cliff at a shallower gradient, and leaving it unpaged would mean
 * trusting a limit nobody is watching.
 *
 * LIMIT/OFFSET is applied AFTER the grouping, and session_id is the group key,
 * so the result set is unique on it -- the total order paging requires. This is
 * the one query here where a page costs a full re-aggregation, which is why the
 * short-page exit matters: at any session count that is not an exact multiple
 * of the page size, paging costs exactly the single query it always did.
 *
 * NO COALESCE ON THE THREE METRICS, deliberately. total_lines_added and
 * total_lines_removed are INTEGER with no default and total_cost_usd is a
 * nullable REAL (capture/lib.sh), so a NULL there means the status line never
 * reported that figure -- not that the figure was zero. rollup.sh:423 reduces
 * cost with a bare MAX(total_cost_usd) for exactly this reason, and an adapter
 * that wrapped the same column in COALESCE(...,0) would assert a measurement
 * where there is none: every session whose snapshots predate the line counters
 * -- the historical majority -- would land in wt_usage claiming "0 lines added".
 *
 * SQL MAX already ignores NULLs, so a session with one reported figure and one
 * missing keeps the reported one; the group reduces to NULL only when NO row
 * carried a value. validateRecord REJECTS a null metric, so an absent figure is
 * OMITTED from `metrics` rather than carried as null, and sqlNum(undefined)
 * writes SQL NULL from there.
 */
export function* claudeSessionMetricRecords(db: string): Generator<WatchtowerRecord> {
  const rows = pagedRows<SessionMetricRow>(db, `
    SELECT session_id,
           MAX(ts)                                AS ts,
           MAX(total_cost_usd)                    AS cost_usd,
           MAX(total_lines_added)                 AS lines_added,
           MAX(total_lines_removed)               AS lines_removed
      FROM claude_status_snapshots
     WHERE session_id IS NOT NULL AND session_id != ''
     GROUP BY session_id
     ORDER BY session_id`);

  for (const row of rows) {
    // An unmeasured figure is ABSENT from metrics, never 0 and never null.
    const metrics: Record<string, number> = {};
    if (row.cost_usd !== null) metrics.cost_usd = row.cost_usd;
    if (row.lines_added !== null) metrics.lines_added = row.lines_added;
    if (row.lines_removed !== null) metrics.lines_removed = row.lines_removed;

    yield {
      source: CLAUDE_SOURCE,
      sourceRecordId: row.session_id,
      kind: "session",
      timestamp: epochToRfc3339(row.ts),
      sessionId: row.session_id,
      agent: CLAUDE_SOURCE,
      // An empty object would assert "this session reported no figures", which
      // is the same over-claim one level up; a session that measured nothing
      // carries no metrics key at all.
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
      authority: "authoritative",
      schemaVersion: 1,
    };
  }
}
