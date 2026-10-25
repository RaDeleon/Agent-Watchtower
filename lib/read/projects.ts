/**
 * The Projects view's reads.
 *
 * Hours, sessions, prompts and cost arrive per project already derived by
 * `rollup.sh` in `claude_project_rollups`; this file sums those rows and does
 * no time arithmetic. What it adds are the two breakdowns the rollup does not
 * store:
 *
 *  - per-branch tokens, straight off `claude_requests` -- every request carries
 *    its own cwd and `git_branch`, so a request attributes itself. Never joined
 *    through `claude_sessions`: 22.4% of requests have no session row.
 *  - lines added / removed, off `claude_status_snapshots`, whose counters are
 *    CUMULATIVE per session: `MAX` per session first, and only then summed
 *    across sessions. A `SUM` across rows overcounts lines 281.7x.
 *  - sessions per terminal, a `COUNT(*)` of `claude_sessions` rows -- a session
 *    count, never a request aggregate.
 *
 * Everything covers the range's whole local days, `recentFrom` to `today`
 * (spec §4.5), bounded by day exactly as the rollup buckets, so the page's
 * tokens and the Sessions page's reconcile per project.
 *
 * `(excluded)` is dropped here, at read time, never at write time: it exists in
 * the tables so the reconciliation identity is unconditional.
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { eachDay } from "./history.ts";
import type { ApiCost } from "./perf.ts";
import { DEFAULT_RANGE, rangeStartDay, type Range } from "./range.ts";

// The original read layer stays where it is with its signature unchanged
// (design §5). Its `readProjectRows` is not called from here: it opens the
// database without `readonly` and bounds its 30-day window by sqlite's wall
// clock, and the dashboard needs both a read-only handle and an injected `now`.
export { applyGroups, readProjectRows, type ProjectRow } from "../projects.ts";

/** Days in the sparklines and in the repos donut. */
export const RECENT_DAYS = 30;

export interface ProjectSummary {
  key: string;
  label: string;
  activeHours: number;
  windowHours: number;
  sessions: number;
  prompts: number;
  /**
   * Claude Code's figure, summed over the range; null when no session booked
   * here had a status-line cost reading (`sessions_with_cost = 0`), where the
   * rollup stores 0 and nothing was measured -- never `$0.00`.
   */
  costUsd: number | null;
  /** Cost at API prices, summed from the rollup's per-project columns over the range. */
  apiCost: ApiCost;
  /** Null with no active time or no cost reading: nothing to divide, and 0 would read as "free". */
  costPerActiveHour: number | null;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  /** Null when no session attributed here ever reported a line count. */
  linesAdded: number | null;
  linesRemoved: number | null;
  /** Active hours per day over the range, oldest first; a day with no row is 0. */
  recent: number[];
}

export interface BranchRow {
  projectKey: string;
  projectLabel: string;
  /** "(no branch)" when the request recorded none. */
  branch: string;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
}

export interface ProjectsData {
  generatedAt: number;
  today: string;
  /** The span every figure below covers: `recentFrom` to `today`, whole local days. */
  range: Range;
  /** Ranked by active hours in range. `(excluded)` never appears. */
  projects: ProjectSummary[];
  /** Largest first, by total tokens, from requests in range. */
  branches: BranchRow[];
  /** Active hours per project in range, largest first; projects with none are left out. */
  recentShare: { key: string; label: string; activeHours: number }[];
  recentFrom: string;
  /** Sessions whose line counts were attributed to a project; the rest never reported any. */
  sessionsWithLines: number;
  /**
   * Sessions started in range per `terminal_app`, largest first. A NULL
   * terminal is the row `"unknown"` (merged with any stored literal "unknown"),
   * never dropped.
   */
  terminals: { terminal: string; sessions: number }[];
  lastRollup: number | null;
}

/** A local-day expression over an epoch-seconds column, as the rollup buckets it. */
export function localDay(tsExpr: string): string {
  return `strftime('%Y-%m-%d', ${tsExpr}, 'unixepoch', 'localtime')`;
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

/**
 * cwd -> project_key, as `rollup.sh` mints it (the `_pk` table), as one SQL
 * expression over `cwdExpr`. Reproduced here as a lookup, not a decision: the
 * reserved keys are only ever produced by the rollup's resolution step, which
 * wrote `claude_project_paths`. A cwd with no row there -- NULL, empty, never
 * resolved -- lands in `(unfiled)`, exactly as the rollup's LEFT JOIN does.
 *
 * A correlated lookup rather than a join the caller must spell, so the
 * Projects and Sessions readers share this one definition and neither can
 * drift from it (`cwd` is the table's primary key: one indexed probe per row).
 * The reader tests pin per-branch and per-session tokens to the rollup's
 * per-project tokens, so a drift between the two goes red.
 */
export function projectKeySql(cwdExpr: string): string {
  return `COALESCE((SELECT CASE WHEN _pp.source = 'excluded' THEN '(excluded)'
                                WHEN _pp.project_path IS NULL THEN '(unfiled)'
                                ELSE _pp.project_path END
                    FROM claude_project_paths _pp WHERE _pp.cwd = ${cwdExpr}), '(unfiled)')`;
}

/** The basename, the same label the rollup stores as `display_name`. */
export function projectLabel(key: string): string {
  if (key.startsWith("(")) return key;
  return key.slice(key.lastIndexOf("/") + 1) || key;
}

/**
 * `range` sets the window every figure covers -- the ranked totals, the
 * sparklines, branches, lines and terminals -- which is the last
 * {@link RECENT_DAYS} by default; `all` starts it at the first project row
 * (which covers every request, since the rollup books request tokens to
 * project rows by the request's own day).
 *
 * Lines are cumulative per session and cannot be split by day without
 * differencing readings, so a session's highest reading is booked whole to the
 * range its LAST reading falls in.
 */
export function readProjects(db: string, opts: { now?: number; range?: Range } = {}): ProjectsData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const today = read<{ d: string }>(db, `SELECT date(${sqlNum(now)}, 'unixepoch', 'localtime') AS d;`)[0].d;
  const range = opts.range ?? DEFAULT_RANGE;
  const recentDays = eachDay(
    rangeStartDay(today, range) ??
      read<{ d: string | null }>(db, `SELECT MIN(day) AS d FROM claude_project_rollups WHERE day <= ${sqlStr(today)};`)[0]?.d ??
      today,
    today,
  );
  const recentFrom = recentDays[0];

  const totals = read<{
    project_key: string; display_name: string | null;
    active_ms: number; window_ms: number; sessions_count: number; prompts: number; cost_usd: number;
    tin: number; tout: number; tcr: number; tcw: number;
    api_usd: number | null; priced: number | null; unpriced: number | null; with_cost: number | null;
  }>(
    db,
    `SELECT project_key, MAX(display_name) AS display_name,
            SUM(active_ms) AS active_ms, SUM(window_ms) AS window_ms,
            SUM(sessions_count) AS sessions_count, SUM(prompts) AS prompts, SUM(cost_usd) AS cost_usd,
            SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
            SUM(tokens_cache_read) AS tcr, SUM(tokens_cache_creation) AS tcw,
            TOTAL(cost_table_usd) AS api_usd, SUM(priced_requests) AS priced,
            SUM(unpriced_requests) AS unpriced, SUM(sessions_with_cost) AS with_cost
     FROM claude_project_rollups
     WHERE day BETWEEN ${sqlStr(recentFrom)} AND ${sqlStr(today)} AND project_key <> '(excluded)'
     GROUP BY project_key;`,
  );

  const daily = read<{ project_key: string; day: string; active_ms: number }>(
    db,
    `SELECT project_key, day, active_ms FROM claude_project_rollups
     WHERE day BETWEEN ${sqlStr(recentFrom)} AND ${sqlStr(today)} AND project_key <> '(excluded)';`,
  );
  const byKeyDay = new Map(daily.map((r) => [`${r.project_key}\u0000${r.day}`, r.active_ms / 3_600_000]));

  // MAX per session, THEN summed per project. The session is attributed to the
  // project its LATEST snapshot's cwd resolves to: a session that changed
  // directory carries one cumulative counter, which cannot be split without
  // differencing readings, and the latest cwd is where the running total ended.
  const lines = read<{ project_key: string; added: number | null; removed: number | null; sessions: number }>(
    db,
    `WITH per_session AS (
       -- One pass: the per-session MAX rides along on the latest row's cwd.
       SELECT session_id, cwd, ts, added, removed FROM (
         SELECT session_id, cwd, ts,
                MAX(total_lines_added)   OVER w AS added,
                MAX(total_lines_removed) OVER w AS removed,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC, id DESC) AS rn
         FROM claude_status_snapshots
         WHERE session_id IS NOT NULL AND ts <= ${sqlNum(now)}
         WINDOW w AS (PARTITION BY session_id))
       WHERE rn = 1
     )
     SELECT ${projectKeySql("s.cwd")} AS project_key,
            SUM(s.added) AS added, SUM(s.removed) AS removed,
            COUNT(s.added) AS sessions
     FROM per_session s
     WHERE ${localDay("s.ts")} BETWEEN ${sqlStr(recentFrom)} AND ${sqlStr(today)}
     GROUP BY 1;`,
  );
  const linesByKey = new Map(lines.map((r) => [r.project_key, r]));

  const projects: ProjectSummary[] = totals
    .map((r) => {
      const activeHours = r.active_ms / 3_600_000;
      const l = linesByKey.get(r.project_key);
      const costUsd = (r.with_cost ?? 0) > 0 ? r.cost_usd : null;
      return {
        key: r.project_key,
        label: r.display_name ?? projectLabel(r.project_key),
        activeHours,
        windowHours: r.window_ms / 3_600_000,
        sessions: r.sessions_count,
        prompts: r.prompts,
        costUsd,
        apiCost: { usd: r.api_usd ?? 0, priced: r.priced ?? 0, unpriced: r.unpriced ?? 0 },
        costPerActiveHour: costUsd !== null && activeHours > 0 ? costUsd / activeHours : null,
        tokensIn: r.tin,
        tokensOut: r.tout,
        tokensCacheRead: r.tcr,
        tokensCacheCreation: r.tcw,
        linesAdded: l?.added ?? null,
        linesRemoved: l?.removed ?? null,
        recent: recentDays.map((d) => byKeyDay.get(`${r.project_key}\u0000${d}`) ?? 0),
      };
    })
    .sort((a, b) => b.activeHours - a.activeHours || b.tokensOut - a.tokensOut || a.key.localeCompare(b.key));

  // Straight off claude_requests: the request's own cwd and branch. Grouped by
  // position, not by alias -- claude_project_paths has a column called
  // project_path and sqlite binds a bare GROUP BY name to an input column first.
  const branches = read<{
    project_key: string; branch: string; n: number; tin: number; tout: number; tcr: number; tcw: number;
  }>(
    db,
    `SELECT ${projectKeySql("r.cwd")} AS project_key,
            COALESCE(NULLIF(r.git_branch, ''), '(no branch)') AS branch,
            COUNT(*) AS n,
            SUM(r.tokens_in) AS tin, SUM(r.tokens_out) AS tout,
            SUM(r.tokens_cache_read) AS tcr, SUM(r.tokens_cache_creation) AS tcw
     FROM claude_requests r
     WHERE r.ts IS NOT NULL AND ${localDay("r.ts")} BETWEEN ${sqlStr(recentFrom)} AND ${sqlStr(today)}
     GROUP BY 1, 2;`,
  )
    .filter((r) => r.project_key !== "(excluded)")
    .map((r) => ({
      projectKey: r.project_key,
      projectLabel: projectLabel(r.project_key),
      branch: r.branch,
      requests: r.n,
      tokensIn: r.tin,
      tokensOut: r.tout,
      tokensCacheRead: r.tcr,
      tokensCacheCreation: r.tcw,
    }))
    .sort(
      (a, b) =>
        b.tokensIn + b.tokensOut + b.tokensCacheRead + b.tokensCacheCreation -
          (a.tokensIn + a.tokensOut + a.tokensCacheRead + a.tokensCacheCreation) ||
        a.projectKey.localeCompare(b.projectKey) ||
        a.branch.localeCompare(b.branch),
    );

  const recentShare = projects
    .map((p) => ({ key: p.key, label: p.label, activeHours: p.recent.reduce((a, b) => a + b, 0) }))
    .filter((p) => p.activeHours > 0)
    .sort((a, b) => b.activeHours - a.activeHours);

  // A session count per terminal: rows of claude_sessions, never requests.
  const terminals = read<{ terminal: string; n: number }>(
    db,
    `SELECT COALESCE(NULLIF(terminal_app, ''), 'unknown') AS terminal, COUNT(*) AS n
     FROM claude_sessions
     WHERE started_at IS NOT NULL AND ${localDay("started_at")} BETWEEN ${sqlStr(recentFrom)} AND ${sqlStr(today)}
     GROUP BY 1 ORDER BY n DESC, terminal;`,
  ).map((r) => ({ terminal: r.terminal, sessions: r.n }));

  const last = read<{ t: number | null }>(db, `SELECT MAX(updated_at) AS t FROM claude_project_rollups;`);

  return {
    generatedAt: now,
    today,
    range,
    projects,
    branches,
    recentShare,
    recentFrom,
    sessionsWithLines: lines.filter((r) => r.project_key !== "(excluded)").reduce((a, r) => a + r.sessions, 0),
    terminals,
    lastRollup: last[0]?.t ?? null,
  };
}
