/**
 * The History view's reads.
 *
 * Everything here is read off tables `rollup.sh` already derived. Nothing is
 * re-modelled: active and idle time, hygiene and rank all arrive computed.
 * What this file adds is grouping and sequencing -- filling the calendar,
 * bucketing prompts by hour, walking consecutive days for a streak -- which is
 * the line CLAUDE.md draws ("grouping and labelling only").
 *
 * Days are LOCAL days, the same bucketing the rollup uses. The reader's sqlite3
 * child inherits TZ, so `'localtime'` here agrees with the rollup's.
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { readLevel, type LevelState } from "./level.ts";
import { MODEL_KEY_SQL, orderStats, sumApiCosts, type ApiCost, type OrderStats } from "./perf.ts";
import { DEFAULT_RANGE, buckets, rangeStartDay, type Bucket, type Range } from "./range.ts";

/** Which maximum a day's hygiene score was rescaled against. */
export type HygieneScale = 100 | 75 | 70 | 65 | 60 | 45 | 35;

export interface HistoryDay {
  day: string;
  activeHours: number;
  idleHours: number;
  /** active + idle: the span a window was open at the desk. */
  windowHours: number;
  sessions: number;
  /**
   * Claude Code's figure: the rollup's `cost_usd`, but null on a day none of
   * whose sessions has a status-line cost reading (`sessions_with_cost = 0`),
   * where the rollup stores 0 and nothing was measured.
   */
  costUsd: number | null;
  /** The day's cost at API prices, as the rollup stored it. */
  apiCost: ApiCost;
  /**
   * Null on a day with no sessions. rollup.sh stores 0 there and
   * claude_rank_progress excludes those days from its average -- a plotted 0
   * would draw a cliff that does not exist.
   */
  hygiene: number | null;
  /** Null exactly when `hygiene` is. See {@link hygieneScale}. */
  hygieneScale: HygieneScale | null;
  /** Null when there was no cache traffic to measure: the transcript was gone. */
  cacheHitPct: number | null;
  /**
   * Null on a day none of whose sessions has a status-line context reading:
   * the rollup stores NULL there (Stage 4B) and hygiene drops the context term.
   */
  peakContextPct: number | null;
  compacts: number;
  clears: number;
  /** idle / window. Null when the window is zero -- there is nothing to divide. */
  idleShare: number | null;
}

/** One point of the range's cost and wait series: a day, or past 90 days a week. */
export interface HistoryPerfBucket extends Bucket {
  /** Priced cost per model, in {@link HistoryPerf.models} order; 0 where a model had none. */
  costByModel: number[];
  /** The bucket's cost at API prices, summed over its rollup rows; null when it has none. */
  apiCost: ApiCost | null;
  /** The bucket's measured turns' waits, through orderStats: n = 0 is no reading, never a 0 wait. */
  wait: OrderStats;
}

export interface HistoryPerf {
  weekly: boolean;
  /** Models with a priced cost in range, largest first. */
  models: string[];
  buckets: HistoryPerfBucket[];
}

export interface Rank {
  name: string;
  index: number;
  nextName: string | null;
  hoursIntoRank: number;
  /** Null at the top rank. */
  hoursToNext: number | null;
  activeHours: number;
  xp: number;
  /** Lifetime hygiene, as claude_rank_progress averages it: zero days excluded. */
  hygiene: number;
  sessions: number;
  lifetimeCostUsd: number;
}

export interface Streaks {
  /** Consecutive session days ending today, or yesterday while today is still empty. */
  current: number;
  longest: number;
  /** Last day of the longest run. Null when there has never been a session day. */
  longestEndsOn: string | null;
}

export interface Coverage {
  firstDay: string | null;
  lastDay: string | null;
  /** Days with a rollup row. */
  daysTracked: number;
  daysWithSessions: number;
  /** Session days with no transcript left to read: no tokens, no cache reading. */
  daysWithoutTranscripts: number;
}

/** 0 = Sunday, as sqlite's `%w` and `Date#getUTCDay` count. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface HistoryData {
  generatedAt: number;
  /** Today's LOCAL date, from the same clock the rollup buckets by. */
  today: string;
  /**
   * The span the trends and bars cover. The calendar heatmap (a year), the
   * rank and the streaks are lifetime figures and ignore it.
   */
  range: Range;
  /** First day of the range's window; for `all`, the first rollup row (today when there is none). */
  rangeFrom: string;
  /** Every calendar day from `rangeFrom` to `today`, inclusive, oldest first. */
  span: string[];
  /** Every rollup row, oldest first. Lifetime: filter by `rangeFrom` for a ranged view. */
  days: HistoryDay[];
  /**
   * Mean active hours per weekday over the days in range with a session --
   * "the average of the days you used it". `days` counts those days; a
   * weekday with none is null, not 0. Always seven entries, Sunday first.
   */
  weekday: { dow: Weekday; avgActiveHours: number | null; days: number }[];
  /**
   * `claude_daily_rollups.avg_context_pct` per calendar day in `span`, but
   * ONLY on a day with at least one `claude_status_snapshots` row (by local
   * day) from a session started that day. Elsewhere null: a day with no
   * reading has no measurement to plot (guard 1). Since the Stage 3D fix wave
   * (I5) the rollup itself skips an unread session and stores NULL for a day
   * none of whose sessions was read; this condition is kept as a second line.
   */
  contextTrend: { day: string; avgContextPct: number | null }[];
  /**
   * One entry per calendar day from the first row to today. A date with no row
   * up to the last rollup's day is 0 hours (the rollup ran and saw nothing); a
   * date with no row AFTER it is null -- nothing has measured it yet.
   */
  calendar: { day: string; activeHours: number | null }[];
  /** `[weekday 0=Sun..6][hour 0..23]` → prompts submitted in range, local time. */
  promptGrid: number[][];
  promptsCounted: number;
  /** Local date of the first prompt event: the hooks' install, not the first day of use. */
  promptsSince: string | null;
  rank: Rank | null;
  /** Claude Code's level (agent_progress); the hero shows it. */
  level: LevelState;
  streaks: Streaks;
  coverage: Coverage;
  lastRollup: number | null;
  /** Cost at API prices by model, and the median measured wait, per bucket of `span`. */
  perf: HistoryPerf;
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

/**
 * The maximum a day's hygiene score was rescaled against.
 *
 * This LABELS a rule rollup.sh has already applied (`rollup.sh`, the two rescale
 * UPDATEs); it computes nothing. A day with both a cache reading and a context
 * reading is scored out of the full 100. A term with no reading is dropped, and
 * the rest are rescaled against what they could attain that day -- cache 25,
 * context 30, compact-vs-clear 25, focus/idle 20, or a flat 10 when the window
 * was zero:
 *
 *   cache     context   window > 0   window = 0
 *   measured  measured  100          100
 *   none      measured   75           65
 *   measured  none       70           60
 *   none      none       45           35
 *
 * A trend that did not say so would present a rescaled day as comparable to a
 * full one.
 */
export function hygieneScale(cacheHitPct: number | null, peakPct: number | null, windowMs: number): HygieneScale {
  const zero = windowMs === 0;
  if (peakPct === null) {
    if (cacheHitPct === null) return zero ? 35 : 45;
    return zero ? 60 : 70;
  }
  if (cacheHitPct !== null) return 100;
  return zero ? 65 : 75;
}

/** "YYYY-MM-DD" -> whole days since the epoch. UTC arithmetic, so no DST edge. */
function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

function dayString(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

/** The `n` calendar dates ending on `to`, inclusive, oldest first. */
export function lastNDays(to: string, n: number): string[] {
  return eachDay(dayString(dayNumber(to) - (n - 1)), to);
}

/** Every date from `from` to `to`, inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let n = dayNumber(from), end = dayNumber(to); n <= end; n++) out.push(dayString(n));
  return out;
}

/**
 * Current and longest runs of consecutive session days.
 *
 * Pure, over already-derived day rows, and deliberately isolated: sequencing
 * rows is grouping, not activity-model math, and Stage 4 can lift this into
 * rollup.sh as a stored column without touching a caller.
 *
 * A "session day" is `sessions > 0`, not `activeHours > 0`: nine real days
 * carry 100+ sessions and a zero window, and they were plainly days of use. A
 * date with no row at all breaks a run, as does a tokens-only day.
 *
 * Today still in progress does not end the current streak: with nothing yet
 * today, the run is counted back from yesterday.
 */
export function streaks(days: { day: string; sessions: number }[], today: string): Streaks {
  const active = new Set(days.filter((d) => d.sessions > 0).map((d) => dayNumber(d.day)));

  let longest = 0;
  let longestEnd: number | null = null;
  for (const n of [...active].sort((a, b) => a - b)) {
    if (active.has(n - 1)) continue; // not the start of a run
    let len = 1;
    while (active.has(n + len)) len++;
    if (len > longest) {
      longest = len;
      longestEnd = n + len - 1;
    }
  }

  const t = dayNumber(today);
  const end = active.has(t) ? t : t - 1;
  let current = 0;
  while (active.has(end - current)) current++;

  return { current, longest, longestEndsOn: longestEnd === null ? null : dayString(longestEnd) };
}

interface DayRow {
  day: string;
  active_ms: number;
  idle_ms: number;
  total_session_ms: number;
  sessions_count: number;
  cost_usd: number;
  cost_table_usd: number | null;
  priced_requests: number | null;
  unpriced_requests: number | null;
  sessions_with_cost: number | null;
  hygiene_score: number;
  cache_hit_percentage: number | null;
  peak_context_pct: number | null;
  compacts: number;
  clears: number;
}

function toDay(r: DayRow): HistoryDay {
  const hasSessions = r.sessions_count > 0;
  return {
    day: r.day,
    activeHours: r.active_ms / 3_600_000,
    idleHours: r.idle_ms / 3_600_000,
    windowHours: r.total_session_ms / 3_600_000,
    sessions: r.sessions_count,
    costUsd: (r.sessions_with_cost ?? 0) > 0 ? r.cost_usd : null,
    apiCost: { usd: r.cost_table_usd ?? 0, priced: r.priced_requests ?? 0, unpriced: r.unpriced_requests ?? 0 },
    hygiene: hasSessions ? r.hygiene_score : null,
    hygieneScale: hasSessions ? hygieneScale(r.cache_hit_percentage, r.peak_context_pct, r.total_session_ms) : null,
    cacheHitPct: r.cache_hit_percentage,
    peakContextPct: r.peak_context_pct,
    compacts: r.compacts,
    clears: r.clears,
    idleShare: r.total_session_ms > 0 ? r.idle_ms / r.total_session_ms : null,
  };
}

/** The stored rank, as `claude_rank_progress` has it. TypeScript never computes rank. */
export function readRank(db: string): Rank | null {
  const rows = read<{
    rank_name: string | null; rank_index: number; next_rank_name: string | null;
    hours_into_rank: number; hours_to_next: number | null; active_hours: number;
    xp: number; hygiene_score: number; sessions_count: number; lifetime_cost_usd: number;
  }>(
    db,
    `SELECT rank_name, rank_index, next_rank_name, hours_into_rank, hours_to_next,
            active_hours, xp, hygiene_score, sessions_count, lifetime_cost_usd
     FROM claude_rank_progress WHERE id = 1;`,
  );
  if (rows.length === 0 || rows[0].rank_name === null) return null;
  const r = rows[0];
  return {
    name: r.rank_name as string,
    index: r.rank_index,
    // The rollup writes '' for "no next rank" through its bash interpolation.
    nextName: r.next_rank_name ? r.next_rank_name : null,
    hoursIntoRank: r.hours_into_rank,
    hoursToNext: r.hours_to_next,
    activeHours: r.active_hours,
    xp: r.xp,
    hygiene: r.hygiene_score,
    sessions: r.sessions_count,
    lifetimeCostUsd: r.lifetime_cost_usd,
  };
}

/**
 * Prompts by local weekday and hour.
 *
 * Prompts, not active time: splitting active seconds across hour boundaries
 * would be activity-model math, which lives in rollup.sh and nowhere else. A
 * `UserPromptSubmit` is a single instant, so bucketing it is grouping. The
 * hooks only exist from the tracker's install onward, so this covers less
 * history than the day rows do, and the page says how many prompts it counts.
 */
function promptGrid(db: string, now: number, from: string | null): { grid: number[][]; total: number; since: string | null } {
  const inRange = from === null ? "" : ` AND ${sinceDay("ts", from)}`;
  const rows = read<{ wd: number; hr: number; n: number }>(
    db,
    `SELECT CAST(strftime('%w', ts, 'unixepoch', 'localtime') AS INTEGER) AS wd,
            CAST(strftime('%H', ts, 'unixepoch', 'localtime') AS INTEGER) AS hr,
            COUNT(*) AS n
     FROM claude_events
     WHERE hook_event_name = 'UserPromptSubmit' AND ts <= ${sqlNum(now)}${inRange}
     GROUP BY wd, hr;`,
  );
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let total = 0;
  for (const r of rows) {
    grid[r.wd][r.hr] = r.n;
    total += r.n;
  }
  const since = read<{ d: string | null }>(
    db,
    `SELECT date(MIN(ts), 'unixepoch', 'localtime') AS d FROM claude_events
     WHERE hook_event_name = 'UserPromptSubmit' AND ts <= ${sqlNum(now)};`,
  )[0]?.d ?? null;
  return { grid, total, since };
}

/**
 * `col` (epoch seconds) falls on or after the LOCAL day `from`. The first bound
 * is a coarse one a day early -- no zone is a whole day off UTC -- so an index
 * on the timestamp can narrow the scan; the second is the exact local-day test.
 */
function sinceDay(col: string, from: string): string {
  return `${col} >= CAST(strftime('%s', ${sqlStr(from)}, '-1 day') AS INTEGER)` +
    ` AND date(${col}, 'unixepoch', 'localtime') >= ${sqlStr(from)}`;
}

/**
 * Mean active hours per weekday, over the days in `[from, today]` with a
 * session -- "the days you used it", the same test the streaks use. A
 * tokens-only day (a pre-install day with requests and no session) has a row
 * but no active-time measurement, and averaging it in as 0 h would drag the
 * mean down (M4). Grouping stored rows; the hours arrive from the rollup.
 */
function weekdayMeans(db: string, from: string, today: string): HistoryData["weekday"] {
  const rows = read<{ dow: number; avg_ms: number; n: number }>(
    db,
    `SELECT CAST(strftime('%w', day) AS INTEGER) AS dow, AVG(active_ms) AS avg_ms, COUNT(*) AS n
     FROM claude_daily_rollups WHERE day BETWEEN ${sqlStr(from)} AND ${sqlStr(today)} AND sessions_count > 0
     GROUP BY dow;`,
  );
  const by = new Map(rows.map((r) => [r.dow, r]));
  return ([0, 1, 2, 3, 4, 5, 6] as const).map((dow) => {
    const r = by.get(dow);
    return { dow, avgActiveHours: r === undefined ? null : r.avg_ms / 3_600_000, days: r?.n ?? 0 };
  });
}

/**
 * The stored daily average context, kept only on days it measured something.
 * GUARD 1: before the Stage 3D fix wave (I5), rollup.sh coalesced a session
 * with no snapshot to 0, so a day that was never read stored 0 -- an empty
 * context window that never happened. It now stores NULL there; the reader
 * keeps its own condition anyway, so neither half alone can plot a 0.
 *
 * "Measured" is one condition: a snapshot with a context reading, taken ON that
 * local day, BY a session the rollup buckets on that day (its start day, as
 * rollup.sh's `_sx` has it). The day alone is not enough: on the live copy,
 * 2026-09-20 has 20 snapshots, all from sessions started on other days, while
 * its own two sessions have none -- so the rollup stored 0 for it.
 */
function contextTrend(db: string, from: string, today: string, span: string[]): HistoryData["contextTrend"] {
  const readDays = snapshotDays(db, "context_used_percentage", from, today, { sameDay: true });
  const rows = read<{ day: string; ctx: number | null }>(
    db,
    `SELECT day, avg_context_pct AS ctx FROM claude_daily_rollups
     WHERE day BETWEEN ${sqlStr(from)} AND ${sqlStr(today)};`,
  );
  const by = new Map(rows.filter((r) => readDays.has(r.day)).map((r) => [r.day, r.ctx]));
  return span.map((day) => ({ day, avgContextPct: by.get(day) ?? null }));
}

/**
 * The local days, in `[from, to]`, on which a status-line column was READ:
 * at least one snapshot with a reading in `column` belongs to a session the
 * rollup buckets on that day (its start day, as rollup.sh's `_sx` keys it).
 * This is the one definition of "the rollup measured this day" for the
 * figures the readers guard with it -- cost (`total_cost_usd`) and the average
 * context trend (`context_used_percentage`). A day outside the set can store a
 * number all the same (rollup.sh COALESCEs cost to 0), and that number is not
 * a measurement: the readers make it null. Peak context needs no such guard
 * since Stage 4B: the rollup itself stores NULL on a day with no reading.
 *
 * A reading is non-NULL, and for cost it is also POSITIVE: the status line
 * prints `total_cost_usd = 0` until a session has priced anything, and a 0
 * shown as Claude Code's figure is "$0.00" asserted (Stage 4B fix round, I1).
 * TWIN: rollup.sh's `_sx.has_cost` (`c.cost > 0`), which the stored
 * `sessions_with_cost` -- History's and Projects' guard -- counts. The two
 * must say the same thing; tests/cost-rollup.test.ts compares their sets.
 *
 * `sameDay` also requires the snapshot to be taken ON that local day, the
 * stricter guard 1 condition the context trend has always used: a session
 * resumed days later reads its context then, not on its start day.
 *
 * `claude_sessions` only buckets a snapshot's session by start day, the
 * rollup's own key; nothing is aggregated through it. One pass over the
 * snapshots (they have no session index), then a join on the session key.
 */
export function snapshotDays(
  db: string,
  column: "total_cost_usd" | "context_used_percentage",
  from: string,
  to: string,
  opts: { sameDay?: boolean; now?: number } = {},
): Set<string> {
  const sameDay = opts.sameDay === true;
  const bound = opts.now === undefined ? "" : ` AND ts <= ${sqlNum(opts.now)}`;
  const reading = column === "total_cost_usd" ? "total_cost_usd > 0" : `${column} IS NOT NULL`;
  const rows = read<{ day: string }>(
    db,
    `WITH snap AS (
       SELECT DISTINCT session_id${sameDay ? ", date(ts, 'unixepoch', 'localtime') AS sday" : ""}
       FROM claude_status_snapshots
       WHERE session_id IS NOT NULL AND ${reading}${bound}${sameDay ? ` AND ${sinceDay("ts", from)}` : ""}
     ),
     sess AS (
       SELECT c.session_id, date(COALESCE(c.started_at,
                (SELECT MIN(e.ts) FROM claude_events e WHERE e.session_id = c.session_id)), 'unixepoch', 'localtime') AS day
       FROM claude_sessions c
     )
     SELECT DISTINCT sess.day AS day FROM sess JOIN snap ON snap.session_id = sess.session_id${sameDay ? " AND snap.sday = sess.day" : ""}
     WHERE sess.day BETWEEN ${sqlStr(from)} AND ${sqlStr(to)};`,
  );
  return new Set(rows.map((r) => r.day));
}

/**
 * The range's cost at API prices by model and its median measured wait, per
 * bucket of `span` -- a day, or past 90 days an ISO week. The costs are the
 * rollup's stored per-request ones, summed; the waits are its stored per-turn
 * ones, and a bucket's median is taken over the bucket's own turns (a median
 * cannot be built from daily medians, spec §2.1 b). A bucket with no measured
 * turn has n = 0 and no median: a break in the line, never a 0-second wait.
 */
function perfSeries(db: string, days: HistoryDay[], span: string[], from: string, today: string): HistoryPerf {
  const inRange = `day BETWEEN ${sqlStr(from)} AND ${sqlStr(today)}`;
  const costs = read<{ day: string; model: string; usd: number }>(
    db,
    `SELECT day, ${MODEL_KEY_SQL} AS model, TOTAL(cost_table_usd) AS usd FROM claude_request_metrics
     WHERE priced = 1 AND ${inRange} GROUP BY 1, 2;`,
  );
  const totals = new Map<string, number>();
  for (const c of costs) totals.set(c.model, (totals.get(c.model) ?? 0) + c.usd);
  // A model with no priced dollar in range is not a series: it would draw a 0.
  const models = [...totals].filter(([, usd]) => usd > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m);
  const col = new Map(models.map((m, i) => [m, i]));
  const costByDay = new Map<string, number[]>();
  for (const c of costs) {
    const i = col.get(c.model);
    if (i === undefined) continue;
    let v = costByDay.get(c.day);
    if (v === undefined) costByDay.set(c.day, (v = new Array<number>(models.length).fill(0)));
    v[i] += c.usd;
  }
  const waits = new Map<string, (number | null)[]>();
  for (const t of read<{ day: string; w: number | null }>(
    db,
    `SELECT day, wait_ms AS w FROM claude_turns WHERE status = 'measured' AND ${inRange};`,
  )) {
    let v = waits.get(t.day);
    if (v === undefined) waits.set(t.day, (v = []));
    v.push(t.w);
  }
  const byDay = new Map(days.map((d) => [d.day, d]));
  const b = buckets(span);
  return {
    weekly: b.weekly,
    models,
    buckets: b.buckets.map((k) => ({
      ...k,
      costByModel: models.map((_, i) => k.days.reduce((a, day) => a + (costByDay.get(day)?.[i] ?? 0), 0)),
      apiCost: sumApiCosts(k.days.map((day) => byDay.get(day)?.apiCost)),
      wait: orderStats(k.days.flatMap((day) => waits.get(day) ?? [])),
    })),
  };
}

export function readHistory(db: string, opts: { now?: number; range?: Range } = {}): HistoryData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const today = read<{ d: string }>(db, `SELECT date(${sqlNum(now)}, 'unixepoch', 'localtime') AS d;`)[0].d;

  const days = read<DayRow>(
    db,
    `SELECT day, active_ms, idle_ms, total_session_ms, sessions_count, cost_usd,
            cost_table_usd, priced_requests, unpriced_requests, sessions_with_cost,
            hygiene_score, cache_hit_percentage, peak_context_pct, compacts, clears
     FROM claude_daily_rollups WHERE day <= ${sqlStr(today)} ORDER BY day;`,
  ).map(toDay);

  const last = read<{ t: number | null; d: string | null }>(
    db,
    `SELECT MAX(updated_at) AS t, date(MAX(updated_at), 'unixepoch', 'localtime') AS d FROM claude_daily_rollups;`,
  );
  const measuredThrough = last[0]?.d ?? null;

  const byDay = new Map(days.map((d) => [d.day, d.activeHours]));
  // A date inside the tracked range with no row had no sessions and no
  // requests: the hooks were running and saw nothing, which IS a reading of 0
  // -- but only up to the day the rollup last ran. A date after that has not
  // been measured at all (the 2026-09-12..16 freeze would otherwise have drawn
  // four quiet days), so it is null. Before the first row there is no calendar
  // at all rather than a run of zeros.
  const calendar =
    days.length === 0
      ? []
      : eachDay(days[0].day, today).map((day) => ({
          day,
          activeHours: byDay.get(day) ?? (measuredThrough !== null && day > measuredThrough ? null : 0),
        }));

  const range = opts.range ?? DEFAULT_RANGE;
  const start = rangeStartDay(today, range);
  const rangeFrom = start ?? days[0]?.day ?? today;
  const span = eachDay(rangeFrom, today);
  const prompts = promptGrid(db, now, start);

  return {
    generatedAt: now,
    today,
    range,
    rangeFrom,
    span,
    days,
    weekday: weekdayMeans(db, rangeFrom, today),
    contextTrend: contextTrend(db, rangeFrom, today, span),
    calendar,
    promptGrid: prompts.grid,
    promptsCounted: prompts.total,
    promptsSince: prompts.since,
    rank: readRank(db),
    level: readLevel(db, "claude"),
    streaks: streaks(days, today),
    coverage: {
      firstDay: days[0]?.day ?? null,
      lastDay: days.at(-1)?.day ?? null,
      daysTracked: days.length,
      daysWithSessions: days.filter((d) => d.sessions > 0).length,
      daysWithoutTranscripts: days.filter((d) => d.sessions > 0 && d.cacheHitPct === null).length,
    },
    lastRollup: last[0]?.t ?? null,
    perf: perfSeries(db, days, span, rangeFrom, today),
  };
}

