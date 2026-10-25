/**
 * The Usage Profile view's reads.
 *
 * Everything scored lives in `claude_profile_daily` and `claude_discipline_scores`
 * (capture/rollup.sh), TheOne's ten-discipline / 600-point / 6-tier model plus its
 * 3-tier Matrix hygiene score. This file reads those two tables, parses their JSON
 * evidence and groups rows into a day/history shape -- it computes nothing (the
 * "no arithmetic" guard, tests/capture-scripts.test.ts, greps every file under
 * `lib/` for the scoring thresholds themselves). Days are LOCAL days, the same
 * bucketing the rollup uses.
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { eachDay } from "./history.ts";
import { DEFAULT_RANGE, rangeStartDay, type Range } from "./range.ts";

export type DisciplineId =
  | "prompt-hygiene"
  | "context-hygiene"
  | "session-hygiene"
  | "model-routing"
  | "cost-discipline"
  | "verification"
  | "automation"
  | "reuse"
  | "security"
  | "output-quality";

/** The spec's display order (§4.4's table, and `claude_discipline_scores`' own `ord`). */
export const DISCIPLINE_ORDER: readonly DisciplineId[] = [
  "prompt-hygiene",
  "context-hygiene",
  "session-hygiene",
  "model-routing",
  "cost-discipline",
  "verification",
  "automation",
  "reuse",
  "security",
  "output-quality",
];

export type DisciplineStatus = "needs-data" | "needs-work" | "ok" | "strong";

export interface DisciplineRow {
  id: DisciplineId;
  score: number;
  status: DisciplineStatus;
  definition: "theone" | "watchtower";
  evidence: Record<string, number | string | null>;
}

export interface ProfileDay {
  day: string;
  windowRequests: number;
  toolCovered: boolean;
  total: number | null;
  measured: number | null;
  tierIndex: number | null;
  tierPointsToNext: number | null;
  totalWow: number | null;
  matrixScore: number | null;
  matrixTier: number | null;
  matrixPointsToNext: number | null;
  factors: { context: number | null; compaction: number | null; sessionLength: number | null; efficiency: number | null };
  inputs: {
    medianCtx: number | null;
    medianRequests: number | null;
    longSessions: number | null;
    longWithReset: number | null;
    cacheFreshRatio: number | null;
  };
  /** The Matrix score over the 7 days ending `day` -- the figure `matrixWow` is a delta of. */
  matrix7d: number | null;
  matrixWow: number | null;
}

export interface ProfileData {
  /** The most recent day with a row, gated or not. Null before the tracker's first day. */
  latest: ProfileDay | null;
  /** The latest day's discipline rows, in {@link DISCIPLINE_ORDER}. Empty on a gated day (spec 4.6: no rows at all). */
  disciplines: DisciplineRow[];
  /** One entry per calendar day in the range, oldest first. Null where there is no row or the day is gated. */
  history: { day: string; total: number | null }[];
  /** The local day of `MIN(ts)` over main-thread (`is_sidechain = 0`) tool calls. Null with no tool rows at all. */
  coverageStart: string | null;
  /**
   * Whether the latest day's window is event-covered (`claude_profile_daily.event_covered`,
   * spec 4B §4.5): its first day is on or after {@link eventStart}. When it is not, the
   * rollup left compactions and security unmeasured. False with no latest day.
   */
  eventCovered: boolean;
  /** The local day of `MIN(ts)` over `claude_events`: when hook data starts. Null with no events at all. */
  eventStart: string | null;
  range: Range;
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

interface ProfileDayRow {
  day: string;
  window_requests: number;
  tool_covered: number;
  total: number | null;
  measured: number | null;
  tier_index: number | null;
  tier_points_to_next: number | null;
  total_wow: number | null;
  matrix_score: number | null;
  matrix_tier: number | null;
  matrix_points_to_next: number | null;
  f_context: number | null;
  f_compaction: number | null;
  f_session_length: number | null;
  f_efficiency: number | null;
  median_ctx: number | null;
  median_requests: number | null;
  long_sessions: number | null;
  long_with_reset: number | null;
  cache_fresh_ratio: number | null;
  matrix_7d: number | null;
  matrix_wow: number | null;
}

function toDay(r: ProfileDayRow): ProfileDay {
  return {
    day: r.day,
    windowRequests: r.window_requests,
    toolCovered: r.tool_covered === 1,
    total: r.total,
    measured: r.measured,
    tierIndex: r.tier_index,
    tierPointsToNext: r.tier_points_to_next,
    totalWow: r.total_wow,
    matrixScore: r.matrix_score,
    matrixTier: r.matrix_tier,
    matrixPointsToNext: r.matrix_points_to_next,
    factors: {
      context: r.f_context,
      compaction: r.f_compaction,
      sessionLength: r.f_session_length,
      efficiency: r.f_efficiency,
    },
    inputs: {
      medianCtx: r.median_ctx,
      medianRequests: r.median_requests,
      longSessions: r.long_sessions,
      longWithReset: r.long_with_reset,
      cacheFreshRatio: r.cache_fresh_ratio,
    },
    matrix7d: r.matrix_7d,
    matrixWow: r.matrix_wow,
  };
}

const PROFILE_COLUMNS =
  "day, window_requests, tool_covered, total, measured, tier_index, tier_points_to_next, total_wow, " +
  "matrix_score, matrix_tier, matrix_points_to_next, f_context, f_compaction, f_session_length, f_efficiency, " +
  "median_ctx, median_requests, long_sessions, long_with_reset, cache_fresh_ratio, matrix_7d, matrix_wow";

/**
 * The latest day's ten discipline rows, in spec order. A gated day has none at
 * all (spec 4.6), which this reflects rather than papering over: a missing id
 * is simply left out, not synthesized as needs-data here -- readProfile's
 * caller (the render layer) treats an empty array as "collecting".
 */
function readDisciplines(db: string, day: string): DisciplineRow[] {
  const rows = read<{
    discipline: DisciplineId;
    score: number;
    status: DisciplineStatus;
    definition: "theone" | "watchtower";
    evidence_json: string;
  }>(db, `SELECT discipline, score, status, definition, evidence_json FROM claude_discipline_scores WHERE day = ${sqlStr(day)};`);
  const byId = new Map(rows.map((r) => [r.discipline, r]));
  return DISCIPLINE_ORDER.flatMap((id) => {
    const r = byId.get(id);
    if (r === undefined) return [];
    return [
      {
        id,
        score: r.score,
        status: r.status,
        definition: r.definition,
        evidence: JSON.parse(r.evidence_json) as Record<string, number | string | null>,
      },
    ];
  });
}

export function readProfile(db: string, opts: { now?: number; range?: Range } = {}): ProfileData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const today = read<{ d: string }>(db, `SELECT date(${sqlNum(now)}, 'unixepoch', 'localtime') AS d;`)[0].d;

  const latestRows = read<ProfileDayRow & { event_covered: number }>(
    db,
    `SELECT ${PROFILE_COLUMNS}, event_covered FROM claude_profile_daily WHERE day <= ${sqlStr(today)} ORDER BY day DESC LIMIT 1;`,
  );
  const latest = latestRows.length === 0 ? null : toDay(latestRows[0]);
  const eventCovered = latestRows.length > 0 && latestRows[0].event_covered === 1;
  const disciplines = latest === null ? [] : readDisciplines(db, latest.day);

  const range = opts.range ?? DEFAULT_RANGE;
  const start = rangeStartDay(today, range);
  const firstDay = read<{ d: string | null }>(db, `SELECT MIN(day) AS d FROM claude_profile_daily;`)[0]?.d ?? null;
  const rangeFrom = start ?? firstDay ?? today;
  const span = eachDay(rangeFrom, today);
  const totals = read<{ day: string; total: number | null }>(
    db,
    `SELECT day, total FROM claude_profile_daily WHERE day BETWEEN ${sqlStr(rangeFrom)} AND ${sqlStr(today)};`,
  );
  const byDay = new Map(totals.map((r) => [r.day, r.total]));
  const history = span.map((day) => ({ day, total: byDay.get(day) ?? null }));

  const coverageStart =
    read<{ d: string | null }>(db, `SELECT date(MIN(ts), 'unixepoch', 'localtime') AS d FROM claude_tool_calls WHERE is_sidechain = 0;`)[0]
      ?.d ?? null;

  const eventStart =
    read<{ d: string | null }>(db, `SELECT date(MIN(ts), 'unixepoch', 'localtime') AS d FROM claude_events;`)[0]?.d ?? null;

  return { latest, disciplines, history, coverageStart, eventCovered, eventStart, range };
}
