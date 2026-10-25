/**
 * The Sessions view's read: one row per session in range, newest first.
 *
 * Every figure is aggregated from `claude_requests` ALONE, grouped by the
 * request's own `session_id`. `claude_sessions` is joined afterwards, with a
 * LEFT JOIN and for a label only (the terminal): 22.4% of requests carry a
 * session_id with no row there, and aggregating through it would drop them
 * and their tokens while every remaining figure still looked plausible.
 *
 * Cost is the status line's running total, so it is `MAX` per session -- a
 * SUM across snapshots multiplies it by the number of readings. A session with
 * no snapshot has no cost reading: `null`, which renders as "—" and sorts
 * last, never as `$0.00`.
 *
 * Project attribution is per request, through the same {@link projectKeySql}
 * lookup as the Projects page. A session that ran in two projects therefore
 * has a row in each, holding only that project's requests, so the rows summed
 * per project are exactly the Projects page's tokens for the same range.
 * `(excluded)` rows are dropped here, at read time.
 *
 * The range is whole local days, bounded exactly as the rollup buckets a
 * request (by its own timestamp's local day). A session that straddles the
 * start of the range contributes only its requests inside it.
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { hasTable } from "./level.ts";
import { API_COST_SQL, apiCostOf, type ApiCost } from "./perf.ts";
import { localDay, projectKeySql } from "./projects.ts";
import { DEFAULT_RANGE, rangeStartDay, type Range } from "./range.ts";

/** Rows the page lists at most: the most recent, with a note saying so. */
export const SESSION_CAP = 500;

export interface SessionRow {
  sessionId: string;
  /** The project key (a git toplevel, or `(unfiled)`), as on the Projects page. */
  project: string;
  /** `claude_sessions.terminal_app`; null when the session has no row or recorded none. */
  terminal: string | null;
  /** Epoch seconds of the first and last request in range. */
  firstTs: number;
  lastTs: number;
  requests: number;
  /** Fresh tokens: input + output. Cache traffic is counted separately. */
  freshTokens: number;
  cacheRead: number;
  /** ≈ context per turn: (input + cache read + cache creation) / requests. */
  contextPerTurn: number | null;
  /**
   * `MAX(total_cost_usd)` over the session's snapshots; null with none, and
   * null when that MAX is 0 -- a status line that has priced nothing yet is
   * not a reading (rollup.sh's `_sx.has_cost`). The WHOLE session's cost,
   * lifetime -- not just its requests in range.
   */
  costUsd: number | null;
  /**
   * The whole session's cost at API prices, lifetime like `costUsd`: every
   * request `claude_request_metrics` holds under this session_id, priced or
   * not, whatever the range and the project filter.
   */
  apiCost: ApiCost;
  /**
   * How many projects this session ran in, in range, `(excluded)` aside --
   * over every request of the session, whatever the project filter and
   * however many rows are listed (M7). More than 1 means it has a row per
   * project, each repeating the whole session's cost.
   */
  projectsInRange: number;
  /** Atlas's counts for this session (wt_usage, MAX over Atlas's duplicate rows); null when Atlas does not know it. */
  atlas: { checkpoints: number; files: number } | null;
}

export interface SessionsData {
  range: Range;
  /** The filter asked for, as given, or null. An unknown one matches nothing. */
  project: string | null;
  /** Newest first (by last request), at most {@link SESSION_CAP}. */
  rows: SessionRow[];
  /** True when more rows matched than {@link SESSION_CAP}. */
  capped: boolean;
  /** Every project key with a request on record, `(excluded)` aside, sorted: what a filter can name. */
  projects: string[];
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

/** Context per turn, or null where there is no turn to divide by (never a 0). */
export function contextPerTurn(tokensIn: number, cacheRead: number, cacheCreation: number, requests: number): number | null {
  return requests > 0 ? (tokensIn + cacheRead + cacheCreation) / requests : null;
}

export function readSessions(db: string, opts: { now?: number; range?: Range; project?: string } = {}): SessionsData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const range = opts.range ?? DEFAULT_RANGE;
  const project = opts.project ?? null;
  const today = read<{ d: string }>(db, `SELECT date(${sqlNum(now)}, 'unixepoch', 'localtime') AS d;`)[0].d;
  const from = rangeStartDay(today, range);

  const projects = read<{ pk: string }>(
    db,
    `SELECT DISTINCT ${projectKeySql("c.cwd")} AS pk
     FROM (SELECT DISTINCT cwd FROM claude_requests WHERE ts IS NOT NULL) c
     ORDER BY 1;`,
  )
    .map((r) => r.pk)
    .filter((k) => k !== "(excluded)");

  // A filter reaches SQL only when it names a project on record, so a hostile
  // or oversized query value never becomes part of a statement at all.
  if (project !== null && !projects.includes(project)) {
    return { range, project, rows: [], capped: false, projects };
  }

  const day = localDay("r.ts");
  const inRange = from === null ? `${day} <= ${sqlStr(today)}` : `${day} BETWEEN ${sqlStr(from)} AND ${sqlStr(today)}`;
  const raw = read<{
    sid: string; pk: string; terminal: string | null; first_ts: number; last_ts: number; n: number;
    tin: number; tout: number; tcr: number; tcw: number; cost: number | null; projects: number;
    api_usd: number | null; priced: number | null; unpriced: number | null;
  }>(
    db,
    // One aggregate over claude_requests; the joins below it only label rows.
    `WITH req AS (
       SELECT COALESCE(r.session_id, '(no session id)') AS sid, ${projectKeySql("r.cwd")} AS pk, r.ts,
              r.tokens_in, r.tokens_out, r.tokens_cache_read, r.tokens_cache_creation
       FROM claude_requests r
       WHERE r.ts IS NOT NULL AND ${inRange}
     ),
     agg AS (
       SELECT sid, pk, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS n,
              SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
              SUM(tokens_cache_read) AS tcr, SUM(tokens_cache_creation) AS tcw
       FROM req
       WHERE pk <> '(excluded)'${project === null ? "" : ` AND pk = ${sqlStr(project)}`}
       GROUP BY sid, pk
     ),
     spans AS (
       -- Over every request of the session in range, BEFORE the project filter.
       SELECT sid, COUNT(DISTINCT pk) AS projects FROM req
       WHERE pk <> '(excluded)' AND sid IN (SELECT sid FROM agg)
       GROUP BY sid
     )
     SELECT a.sid, a.pk, s.terminal_app AS terminal, a.first_ts, a.last_ts, a.n,
            a.tin, a.tout, a.tcr, a.tcw, c.cost, sp.projects,
            m.usd AS api_usd, m.priced, m.unpriced
     FROM agg a
     JOIN spans sp ON sp.sid = a.sid
     LEFT JOIN claude_sessions s ON s.session_id = a.sid
     LEFT JOIN (SELECT session_id, NULLIF(MAX(total_cost_usd), 0) AS cost
                FROM claude_status_snapshots
                WHERE session_id IN (SELECT sid FROM agg) AND ts <= ${sqlNum(now)}
                GROUP BY session_id) c ON c.session_id = a.sid
     LEFT JOIN (SELECT COALESCE(session_id, '(no session id)') AS sid, ${API_COST_SQL}
                FROM claude_request_metrics
                WHERE COALESCE(session_id, '(no session id)') IN (SELECT sid FROM agg) AND day <= ${sqlStr(today)}
                GROUP BY 1) m ON m.sid = a.sid
     ORDER BY a.last_ts DESC, a.sid, a.pk
     LIMIT ${SESSION_CAP + 1};`,
  );

  const base = raw.slice(0, SESSION_CAP).map((r) => ({
    sessionId: r.sid,
    project: r.pk,
    terminal: r.terminal === null || r.terminal === "" ? null : r.terminal,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    requests: r.n,
    freshTokens: r.tin + r.tout,
    cacheRead: r.tcr,
    contextPerTurn: contextPerTurn(r.tin, r.tcr, r.tcw, r.n),
    costUsd: r.cost,
    apiCost: apiCostOf({ usd: r.api_usd, priced: r.priced, unpriced: r.unpriced }),
    projectsInRange: r.projects,
  }));
  // Spec §5: one line on the sessions Atlas knows. Atlas links its own rows to
  // Claude's canonical session; one native id can have two Atlas rows (acp and
  // external_jsonl), so MAX, never SUM.
  const atlas = new Map<string, { checkpoints: number; files: number }>();
  if (base.length > 0 && hasTable(db, "wt_links") && hasTable(db, "wt_usage")) {
    for (const a of read<{ sid: string; c: number | null; f: number | null }>(db,
      `SELECT l.source_local_id AS sid,
              MAX(CASE WHEN u.metric = 'atlas_checkpoints' THEN u.value END) AS c,
              MAX(CASE WHEN u.metric = 'atlas_files_touched' THEN u.value END) AS f
       FROM wt_links l JOIN wt_usage u ON u.canonical_id = l.canonical_id AND u.source = 'atlas'
       WHERE l.source = 'claude' AND l.link_kind = 'same_session'
         AND l.source_local_id IN (${base.map((r) => sqlStr(r.sessionId)).join(",")})
       GROUP BY l.source_local_id;`)) {
      atlas.set(a.sid, { checkpoints: a.c ?? 0, files: a.f ?? 0 });
    }
  }
  const rows = base.map((r) => ({ ...r, atlas: atlas.get(r.sessionId) ?? null }));
  return { range, project, rows, capped: raw.length > SESSION_CAP, projects };
}
