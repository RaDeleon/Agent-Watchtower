/**
 * The Live view's reads. Every query is bounded by an injected `now`, so the
 * whole view is reproducible against a fixture with a fixed epoch.
 *
 * Three different rules govern the three kinds of column this file touches, and
 * mixing them up is the bug class this project exists to correct:
 *
 *  - `claude_status_snapshots` CUMULATIVE counters (cost, lines, durations) --
 *    `MAX` per session, never `SUM` across rows (a `SUM` overcounts lines by
 *    281.7x).
 *  - `claude_status_snapshots` INSTANTANEOUS gauges (rate limits, context %) --
 *    the most recent reading, and for rate limits the most recent NON-NULL one.
 *  - Tokens -- `claude_requests` only, never snapshots, and never joined
 *    through `claude_sessions` (22.4% of requests have no session row).
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { lastNDays, snapshotDays, streaks } from "./history.ts";
import { readLevel, type LevelState } from "./level.ts";
import { orderStats, type ApiCost, type OrderStats } from "./perf.ts";
import { bucketOf, defaultTranscriptsDir, findSessionTranscripts, readSessionUsage } from "./transcript.ts";

/** A rate-limit reading. `pct` is null when there is no reading at all. */
export interface Gauge {
  pct: number | null;
  /** When the reading was taken, epoch seconds. Null when there is none. */
  ts: number | null;
}

export interface LiveSession {
  sessionId: string;
  /** Start of the CURRENT launch, not of the session_id. See below. */
  startedAt: number | null;
  elapsedSeconds: number | null;
  costUsd: number | null;
  contextPct: number | null;
  /** False once a SessionEnd has arrived for this launch. */
  active: boolean;
  /** The repo this session's newest event named. A label only; null when none did. */
  repo: string | null;
}

export interface LiveToday {
  day: string;
  /**
   * Null when `claude_daily_rollups` has no row for today. That is the state
   * from the day's first session until a SessionEnd runs the rollup, so it
   * means "not rolled up yet", never "0 hours": the page renders it as usage
   * pending while a session is in progress (spec §3C).
   */
  activeHours: number | null;
  /** Null exactly when `activeHours` is. */
  sessions: number | null;
  /** Null on a day with no sessions: the rollup stores 0 there, and 0 is not a score. */
  hygiene: number | null;
  /**
   * Null when there is no row, AND when there is a row but no session the
   * rollup buckets today has a status-line cost reading: the rollup stores
   * 0.0 there, and a spend nobody measured is not $0.00 (I1). Claude Code's
   * figure.
   */
  costUsd: number | null;
  /** Today's cost at API prices, as the rollup stored it; null with no row. */
  apiCost: ApiCost | null;
  /** Today's measured turns' waits (`claude_turns`), through orderStats: n = 0 is no reading. */
  wait: OrderStats;
}

export interface BurnRate {
  /** Null when no request landed in the window: idle is not zero throughput. */
  tokensPerMin: number | null;
  windowSeconds: number;
  requests: number;
  tokensOut: number;
  /**
   * Where the figure came from. `transcript` is live; `database` only sees work
   * that a SessionEnd has already ingested, and the page says so.
   */
  source: "transcript" | "database";
  /**
   * `tokensOut` split into {@link BURN_BUCKETS} equal slices of the window,
   * oldest first: the sparkline under the rate. Meaningful only when
   * `requests > 0`; an idle window draws no line at all.
   */
  buckets: number[];
}

/** Live totals for the session in progress, read from its transcript. */
export interface SessionUsage {
  requests: number;
  tokensOut: number;
  tokensIn: number;
  latestTs: number | null;
}

export interface LiveEvent {
  /** The newest event of the run. */
  ts: number;
  name: string;
  repo: string | null;
  /** Consecutive events with this name and repo, folded into this row: 1 for a lone event. */
  count: number;
  /** The oldest event of the run; `ts` when `count` is 1. */
  since: number;
}

export interface LiveData {
  generatedAt: number;
  rateLimits: { fiveHour: Gauge; sevenDay: Gauge };
  session: LiveSession | null;
  /** Null when the session's transcript is not on this machine. */
  sessionUsage: SessionUsage | null;
  today: LiveToday;
  burnRate: BurnRate;
  events: LiveEvent[];
  /**
   * The last 7 calendar days, oldest first, ending today. `activeHours` is
   * null on a date with no `claude_daily_rollups` row -- a gap, never 0 (spec
   * §6, the same rule as History's M1).
   */
  week: { day: string; activeHours: number | null }[];
  /** Claude Code's level (agent_progress). */
  level: LevelState;
  /** Consecutive session days ending today (or yesterday while today is empty). */
  streak: number;
  /**
   * How current the stored tables are. Everything except the snapshots and the
   * transcript only moves when a SessionEnd fires, so the page states it rather
   * than letting an 11-minute-old total read as this second's.
   */
  freshness: { lastIngest: number | null; lastRollup: number | null };
}

/**
 * The burn-rate window: 5 minutes.
 *
 * At a 5s poll this reacts within a minute. A session average flattens into a
 * constant and stops being a live figure; a "last N requests" window silently
 * stretches to hours when you walk away, so a stale number reads as current.
 */
export const BURN_WINDOW_SECONDS = 300;

/** Slices of the burn window in the sparkline: 30 seconds each. */
export const BURN_BUCKETS = 10;

/** Rows shown in the ticker, after a run of identical events is folded into one. */
export const TICKER_LIMIT = 20;
/**
 * Raw events read to fill those rows. A burst of subagents writes dozens of
 * SubagentStop rows in a minute; read only 20 and the ticker was that burst.
 */
const TICKER_SCAN = 400;

/**
 * Fold each run of consecutive events (newest first) with the same name and
 * repo into one row with its count, keeping the first `limit` rows. Grouping
 * only: the events are the ones stored, in their stored order.
 */
export function collapseEvents(raw: { ts: number; name: string; repo: string | null }[], limit = TICKER_LIMIT): LiveEvent[] {
  const out: LiveEvent[] = [];
  for (const e of raw) {
    const last = out[out.length - 1];
    if (last !== undefined && last.name === e.name && last.repo === e.repo) {
      last.count += 1;
      last.since = e.ts;
      continue;
    }
    if (out.length === limit) break;
    out.push({ ts: e.ts, name: e.name, repo: e.repo, count: 1, since: e.ts });
  }
  return out;
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

/**
 * The most recent NON-NULL reading of one rate-limit column.
 *
 * Measured 2026-09-14: only 74.6% of snapshots carry a 5h reading, so "the
 * latest snapshot" is the wrong query -- one row in four would report no limit
 * at all. A missing reading stays null here and renders as "no reading"; it
 * must never become 0%, which reads as good news.
 */
function gauge(db: string, column: string, now: number): Gauge {
  const rows = read<{ pct: number | null; ts: number }>(
    db,
    `SELECT ${column} AS pct, ts FROM claude_status_snapshots
     WHERE ${column} IS NOT NULL AND ts <= ${sqlNum(now)}
     ORDER BY ts DESC LIMIT 1;`,
  );
  if (rows.length === 0) return { pct: null, ts: null };
  return { pct: rows[0].pct, ts: rows[0].ts };
}

/**
 * The session behind the most recent snapshot.
 *
 * `startedAt` is the latest SessionStart EVENT for that session, not
 * `claude_sessions.started_at`: a session_id survives `--resume`, so the stored
 * start spans every dormant calendar gap -- the phantom-hours defect this
 * project exists to correct. The latest SessionStart is the current launch.
 */
function currentSession(db: string, now: number): LiveSession | null {
  const latest = read<{ session_id: string; ts: number; context_used_percentage: number | null }>(
    db,
    `SELECT session_id, ts, context_used_percentage FROM claude_status_snapshots
     WHERE ts <= ${sqlNum(now)} ORDER BY ts DESC LIMIT 1;`,
  );
  if (latest.length === 0) return null;
  const sessionId = latest[0].session_id;
  const id = sqlStr(sessionId);

  // Cost is CUMULATIVE per session, so MAX -- summing multiplies it by the
  // number of snapshots. A MAX of 0 is no reading: the status line has priced
  // nothing yet (rollup.sh's `_sx.has_cost`), and "$0.00" would assert one.
  const cost = read<{ cost: number | null }>(
    db,
    `SELECT NULLIF(MAX(total_cost_usd), 0) AS cost FROM claude_status_snapshots
     WHERE session_id = ${id} AND ts <= ${sqlNum(now)};`,
  );
  const marks = read<{ started: number | null; ended: number | null }>(
    db,
    `SELECT MAX(CASE WHEN hook_event_name = 'SessionStart' THEN ts END) AS started,
            MAX(CASE WHEN hook_event_name = 'SessionEnd'   THEN ts END) AS ended
     FROM claude_events WHERE session_id = ${id} AND ts <= ${sqlNum(now)};`,
  );
  const startedAt = marks[0]?.started ?? null;
  const ended = marks[0]?.ended ?? null;
  const repo = read<{ repo: string }>(
    db,
    `SELECT repo FROM claude_events WHERE session_id = ${id} AND repo IS NOT NULL AND repo <> ''
       AND ts <= ${sqlNum(now)} ORDER BY ts DESC, id DESC LIMIT 1;`,
  );
  return {
    sessionId,
    startedAt,
    elapsedSeconds: startedAt === null ? null : Math.max(0, now - startedAt),
    costUsd: cost[0]?.cost ?? null,
    contextPct: latest[0].context_used_percentage,
    active: startedAt !== null && (ended === null || ended < startedAt),
    repo: repo[0]?.repo ?? null,
  };
}

function todayRow(db: string, now: number): LiveToday {
  const rows = read<{
    day: string; active_ms: number; sessions_count: number; hygiene_score: number | null; cost_usd: number;
    cost_table_usd: number | null; priced_requests: number | null; unpriced_requests: number | null;
  }>(
    db,
    `SELECT day, active_ms, sessions_count, hygiene_score, cost_usd,
            cost_table_usd, priced_requests, unpriced_requests FROM claude_daily_rollups
     WHERE day = date(${sqlNum(now)}, 'unixepoch', 'localtime');`,
  );
  const day = localDay(db, now);
  // The rollup's own turns for today: only `measured` ones have a wait to report.
  const wait = orderStats(
    read<{ w: number | null }>(db, `SELECT wait_ms AS w FROM claude_turns WHERE day = ${sqlStr(day)} AND status = 'measured';`)
      .map((x) => x.w),
  );
  // No row is no measurement: a 0 here would read "0.00h active today" all
  // through the first session of every day.
  if (rows.length === 0) return { day, activeHours: null, sessions: null, hygiene: null, costUsd: null, apiCost: null, wait };
  const r = rows[0];
  return {
    day: r.day,
    activeHours: r.active_ms / 3_600_000,
    sessions: r.sessions_count,
    // rollup.sh forces hygiene_score to 0 when sessions_count is 0, and
    // claude_rank_progress excludes those days rather than averaging the zero
    // in. A 0 shown as a score is a measurement that was never taken.
    hygiene: r.sessions_count === 0 ? null : r.hygiene_score,
    costUsd: snapshotDays(db, "total_cost_usd", r.day, r.day, { now }).has(r.day) ? r.cost_usd : null,
    apiCost: { usd: r.cost_table_usd ?? 0, priced: r.priced_requests ?? 0, unpriced: r.unpriced_requests ?? 0 },
    wait,
  };
}

function localDay(db: string, now: number): string {
  return read<{ d: string }>(db, `SELECT date(${sqlNum(now)}, 'unixepoch', 'localtime') AS d;`)[0].d;
}

/**
 * The last seven calendar days of active hours. A date with no rollup row is
 * null: the day has not been measured (or the rollup is frozen), and drawing it
 * as a zero bar would assert a quiet day nobody observed.
 */
function week(db: string, today: string): { day: string; activeHours: number | null }[] {
  const days = lastNDays(today, 7);
  const rows = read<{ day: string; active_ms: number }>(
    db,
    `SELECT day, active_ms FROM claude_daily_rollups
     WHERE day >= ${sqlStr(days[0])} AND day <= ${sqlStr(today)};`,
  );
  const byDay = new Map(rows.map((r) => [r.day, r.active_ms / 3_600_000]));
  return days.map((day) => ({ day, activeHours: byDay.get(day) ?? null }));
}

/** The current streak, walked over the stored day rows by the same function History uses. */
function streak(db: string, today: string): number {
  const rows = read<{ day: string; sessions: number }>(
    db,
    `SELECT day, sessions_count AS sessions FROM claude_daily_rollups WHERE day <= ${sqlStr(today)};`,
  );
  return streaks(rows, today).current;
}

/**
 * Output tokens per minute over the last {@link BURN_WINDOW_SECONDS}, from the
 * stored requests.
 *
 * This is the FALLBACK. `claude_requests` is filled by ingest at SessionEnd, so
 * during a live session it holds nothing newer than the last session to end —
 * measured 11 minutes stale while the transcript was a second old.
 */
function burnRateFromDb(db: string, now: number): BurnRate {
  const since = now - BURN_WINDOW_SECONDS;
  const rows = read<{ ts: number; out: number }>(
    db,
    `SELECT ts, COALESCE(tokens_out, 0) AS out FROM claude_requests
     WHERE ts > ${sqlNum(since)} AND ts <= ${sqlNum(now)};`,
  );
  const buckets = new Array<number>(BURN_BUCKETS).fill(0);
  let out = 0;
  for (const r of rows) {
    out += r.out;
    buckets[bucketOf(r.ts, since, BURN_WINDOW_SECONDS, BURN_BUCKETS)] += r.out;
  }
  const n = rows.length;
  return {
    tokensPerMin: n === 0 ? null : out / (BURN_WINDOW_SECONDS / 60),
    windowSeconds: BURN_WINDOW_SECONDS,
    requests: n,
    tokensOut: out,
    source: "database",
    buckets,
  };
}

function freshness(db: string): { lastIngest: number | null; lastRollup: number | null } {
  const ingest = read<{ t: number | null }>(db, `SELECT MAX(ingested_at) AS t FROM claude_requests;`);
  const rollup = read<{ t: number | null }>(db, `SELECT MAX(updated_at) AS t FROM claude_daily_rollups;`);
  return { lastIngest: ingest[0]?.t ?? null, lastRollup: rollup[0]?.t ?? null };
}

export function readLive(
  db: string,
  opts: { now?: number; transcriptsDir?: string } = {},
): LiveData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const events = read<{ ts: number; hook_event_name: string; repo: string | null }>(
    db,
    `SELECT ts, hook_event_name, repo FROM claude_events
     WHERE ts <= ${sqlNum(now)} ORDER BY ts DESC, id DESC LIMIT ${TICKER_SCAN};`,
  );
  const session = currentSession(db, now);

  // The live half. The transcript is the same file ingest will read at
  // SessionEnd, folded by the same MAX-per-requestId rule, so the live figure
  // and the stored one describe the same work rather than two versions of it.
  const dir = opts.transcriptsDir ?? defaultTranscriptsDir();
  // Main thread AND subagents: ingest reads both, and while the main thread
  // waits on agents only the subagent files are moving.
  const files = session === null ? [] : findSessionTranscripts(dir, session.sessionId);
  const usage =
    files.length === 0
      ? null
      : readSessionUsage(files, { until: now, windowSeconds: BURN_WINDOW_SECONDS, buckets: BURN_BUCKETS });
  const today = localDay(db, now);

  return {
    generatedAt: now,
    rateLimits: {
      fiveHour: gauge(db, "five_hour_rate_limit_used_percentage", now),
      sevenDay: gauge(db, "seven_day_rate_limit_used_percentage", now),
    },
    session,
    sessionUsage:
      usage === null
        ? null
        : {
            requests: usage.sessionRequests,
            tokensOut: usage.sessionTokensOut,
            tokensIn: usage.sessionTokensIn,
            latestTs: usage.latestTs,
          },
    today: todayRow(db, now),
    burnRate:
      usage === null
        ? burnRateFromDb(db, now)
        : {
            tokensPerMin:
              usage.windowRequests === 0 ? null : usage.windowTokensOut / (BURN_WINDOW_SECONDS / 60),
            windowSeconds: BURN_WINDOW_SECONDS,
            requests: usage.windowRequests,
            tokensOut: usage.windowTokensOut,
            source: "transcript",
            buckets: usage.windowBuckets,
          },
    events: collapseEvents(events.map((e) => ({ ts: e.ts, name: e.hook_event_name, repo: e.repo }))),
    week: week(db, today),
    level: readLevel(db, "claude"),
    streak: streak(db, today),
    freshness: freshness(db),
  };
}
