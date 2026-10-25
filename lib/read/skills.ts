/**
 * The Skills & Models view's reads. Claude-specific: every figure is read off
 * `claude_requests` directly, and the page says so.
 *
 * One rule governs the whole file: **aggregate `claude_requests` on its own.**
 * Never join it through `claude_sessions` -- 22.4% of requests predate the
 * tracker and have no session row, and the join drops them silently. Tokens
 * come from here and nowhere else; `claude_status_snapshots` reports a context
 * window, not usage.
 *
 * Nothing here is filtered by project, so `(excluded)` does not arise: these
 * totals are the same totals `claude_daily_rollups` carries, which include an
 * excluded directory's requests. No project is ever named on this page.
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { eachDay, snapshotDays } from "./history.ts";
import { API_COST_SQL, MODEL_KEY_SQL, NO_LATENCY, apiCostOf, latencyByModel, type ApiCost, type OrderStats } from "./perf.ts";
import { DEFAULT_RANGE, rangeStartDay, type Range } from "./range.ts";

/** Days in the model donut, the model mix and the cache trend. */
export const RECENT_DAYS = 30;
/** Rows per leaderboard. The page states how many more there are. */
export const LEADERBOARD_ROWS = 12;

export interface TokenTotals {
  requests: number;
  /** Uncached input: `tokens_in`. */
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** All four token columns. Dominated by cache reads, which is why fresh is shown beside it. */
  total: number;
  /** cache read / (cache read + cache write), the rollup's formula. Null with no cache traffic. */
  cacheHitPct: number | null;
}

export interface LeaderRow {
  name: string;
  /** For MCP servers: the tool used most under this server. */
  detail?: string;
  requests: number;
  output: number;
  total: number;
}

export interface Leaderboard {
  rows: LeaderRow[];
  /** Distinct names beyond the rows shown. */
  more: number;
  /** Requests carrying any attribution of this kind. */
  attributed: number;
}

export interface ModelRow {
  model: string;
  requests: number;
  output: number;
  total: number;
}

/** A model's share of the range: requests and output tokens. */
export interface ModelShareRow {
  model: string;
  requests: number;
  tokensOut: number;
}

/**
 * One model over the range. Its cost at API prices, response time and output
 * rate are the rollup's per-request values (Stage 4B), summed or handed to the
 * order statistics in perf.ts. Claude Code's own cost figure is per session
 * and cannot be split by model, so it is not here.
 */
export interface ModelTableRow {
  model: string;
  requests: number;
  /** `tokens_in + tokens_out`: "in + out", as the Sessions table counts them. */
  freshTokens: number;
  tokensOut: number;
  /**
   * `cache_read / (cache_read + cache_creation)`, as a percentage: the
   * rollup's formula, the same one every other cache-hit figure on the page
   * uses (M6). Null with no cache traffic -- under this formula there is
   * nothing to divide, so there is no reading.
   *
   * No per-model error rate (I2): Claude Code records a failed call as a
   * `<synthetic>` assistant message with no model of its own, so every API
   * error lands on `<synthetic>` and none on the model that failed. Inferring
   * it from the session's previous request would be a guess (a `/model`
   * switch, or a subagent on another model, moves it; 3 of 24 live errors
   * have no previous request at all), so the errors stay in their own card.
   */
  cacheHitPct: number | null;
  /** Cost at API prices over the model's requests in range. */
  apiCost: ApiCost;
  /** `response_ms` over the model's timed requests in range: end to end, time to first token included. */
  response: OrderStats;
  /** The median stored output rate; null with none. */
  tokPerSMedian: number | null;
}

export interface SeriesDay {
  day: string;
  /** Null on a day with no request: a gap, not 0. */
  requests: number | null;
  tokensOut: number | null;
  /**
   * The rollup's stored `cost_usd`, only on a day with a cost reading: a
   * session the rollup buckets there has a snapshot with a non-null
   * `total_cost_usd` ({@link snapshotDays}). Elsewhere null -- the rollup
   * stores 0.0 for a day none of whose sessions reported a cost (a token-only
   * day, a day of `claude -p` sessions), and that 0.0 was never measured (I1).
   */
  costUsd: number | null;
}

export interface SkillsData {
  generatedAt: number;
  today: string;
  /** The span the ranged blocks cover. */
  range: Range;
  recentFrom: string;
  allTime: TokenTotals;
  recent: TokenTotals;
  skills: Leaderboard;
  mcpServers: Leaderboard;
  plugins: Leaderboard;
  /** `is_sidechain = 0` against `1`. The two sum to {@link allTime}. */
  mainThread: TokenTotals;
  subagents: TokenTotals;
  /** Last {@link RECENT_DAYS}, most requests first. */
  models: ModelRow[];
  /** One entry per calendar day of the recent window: requests per model, in `models` order. */
  modelMix: { day: string; requests: number[] }[];
  /**
   * Stored per-day `cache_hit_percentage`; null where the rollup measured none.
   * `read` and `write` are the day's stored cache tokens (0 with no row), so a
   * week can be drawn with the rollup's own formula over its summed tokens.
   */
  cacheTrend: { day: string; pct: number | null; read: number; write: number }[];
  apiErrors: { total: number; byStatus: { status: string; requests: number }[]; firstTs: number | null; lastTs: number | null };
  /** In range, most requests first: the two share donuts. */
  modelShare: ModelShareRow[];
  /** In range, in {@link modelShare}'s order. */
  modelTable: ModelTableRow[];
  /** In range, most requests first. `null` is "not recorded" (NULL or empty), its own row. */
  effort: { effort: string | null; requests: number }[];
  /** One entry per calendar day of the range, oldest first. */
  series: SeriesDay[];
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

interface TotalsRow { n: number; tin: number | null; tout: number | null; tcr: number | null; tcw: number | null }

const TOTALS = `COUNT(*) AS n, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
                SUM(tokens_cache_read) AS tcr, SUM(tokens_cache_creation) AS tcw`;

function toTotals(r: TotalsRow | undefined): TokenTotals {
  const fresh = r?.tin ?? 0;
  const output = r?.tout ?? 0;
  const cacheRead = r?.tcr ?? 0;
  const cacheWrite = r?.tcw ?? 0;
  return {
    requests: r?.n ?? 0,
    fresh,
    cacheRead,
    cacheWrite,
    output,
    total: fresh + output + cacheRead + cacheWrite,
    cacheHitPct: cacheRead + cacheWrite > 0 ? (100 * cacheRead) / (cacheRead + cacheWrite) : null,
  };
}

function leaderboard(db: string, column: string, bound: string, detailColumn?: string): Leaderboard {
  const rows = read<{ name: string; n: number; tout: number; total: number }>(
    db,
    `SELECT ${column} AS name, COUNT(*) AS n, SUM(tokens_out) AS tout,
            SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_creation) AS total
     FROM claude_requests
     WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${bound}
     GROUP BY 1 ORDER BY n DESC, name;`,
  );
  const shown = rows.slice(0, LEADERBOARD_ROWS);
  const details = new Map<string, string>();
  if (detailColumn !== undefined && shown.length > 0) {
    // The single most-used detail per name, ties broken by name for determinism.
    for (const d of read<{ name: string; detail: string }>(
      db,
      `SELECT name, detail FROM (
         SELECT ${column} AS name, ${detailColumn} AS detail,
                ROW_NUMBER() OVER (PARTITION BY ${column} ORDER BY COUNT(*) DESC, ${detailColumn}) AS rn
         FROM claude_requests
         WHERE ${column} IS NOT NULL AND ${column} <> '' AND ${detailColumn} IS NOT NULL AND ${bound}
         GROUP BY ${column}, ${detailColumn})
       WHERE rn = 1;`,
    )) {
      details.set(d.name, d.detail);
    }
  }
  return {
    rows: shown.map((r) => ({
      name: r.name,
      ...(details.has(r.name) ? { detail: details.get(r.name) } : {}),
      requests: r.n,
      output: r.tout,
      total: r.total,
    })),
    more: rows.length - shown.length,
    attributed: rows.reduce((a, r) => a + r.n, 0),
  };
}

/**
 * `range` sets the window of the ranged blocks: the model share, table, mix
 * and effort, the cache trend, the time series and the in-range totals. It is
 * the last {@link RECENT_DAYS} by default; `all` starts it on the first day
 * either table has data for, so the time series' cost covers every rollup day.
 * The leaderboards, main thread against subagents and the API errors are
 * lifetime whatever the range.
 */
export function readSkills(db: string, opts: { now?: number; range?: Range } = {}): SkillsData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const range = opts.range ?? DEFAULT_RANGE;
  const today = read<{ d: string }>(db, `SELECT date(${sqlNum(now)}, 'unixepoch', 'localtime') AS d;`)[0].d;
  const recentFrom =
    rangeStartDay(today, range) ??
    read<{ d: string | null }>(
      db,
      `SELECT MIN(d) AS d FROM (
         SELECT date(MIN(ts), 'unixepoch', 'localtime') AS d FROM claude_requests WHERE ts IS NOT NULL AND ts <= ${sqlNum(now)}
         UNION ALL
         SELECT MIN(day) FROM claude_daily_rollups WHERE day <= ${sqlStr(today)});`,
    )[0]?.d ??
    today;
  const days = eachDay(recentFrom, today);

  const bound = `ts IS NOT NULL AND ts <= ${sqlNum(now)}`;
  const dayOf = `strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime')`;
  const recentBound = `${bound} AND ${dayOf} >= ${sqlStr(recentFrom)}`;

  const allTime = toTotals(read<TotalsRow>(db, `SELECT ${TOTALS} FROM claude_requests WHERE ${bound};`)[0]);
  const recent = toTotals(read<TotalsRow>(db, `SELECT ${TOTALS} FROM claude_requests WHERE ${recentBound};`)[0]);

  const side = read<TotalsRow & { sc: number }>(
    db,
    `SELECT CASE WHEN COALESCE(is_sidechain, 0) = 0 THEN 0 ELSE 1 END AS sc, ${TOTALS} FROM claude_requests WHERE ${bound} GROUP BY 1;`,
  );

  // One pass per model over the range: the share donuts, the model table and
  // the mix's series order all come from these rows.
  const perModel = read<{
    model: string; n: number; tin: number | null; tout: number | null; total: number | null;
    tcr: number | null; tcw: number | null; hit: number | null;
  }>(
    db,
    `SELECT model, n, tin, tout, total, tcr, tcw,
            CASE WHEN tcr + tcw > 0 THEN 100.0 * tcr / (tcr + tcw) END AS hit
     FROM (
       SELECT COALESCE(NULLIF(model, ''), '(unknown)') AS model, COUNT(*) AS n,
              COALESCE(SUM(tokens_in), 0) AS tin, COALESCE(SUM(tokens_out), 0) AS tout,
              SUM(tokens_in + tokens_out + tokens_cache_read + tokens_cache_creation) AS total,
              COALESCE(SUM(tokens_cache_read), 0) AS tcr, COALESCE(SUM(tokens_cache_creation), 0) AS tcw
       FROM claude_requests WHERE ${recentBound}
       GROUP BY 1)
     ORDER BY n DESC, model;`,
  );
  const models = perModel.map((r) => ({ model: r.model, requests: r.n, output: r.tout ?? 0, total: r.total ?? 0 }));

  const effort = read<{ effort: string | null; n: number }>(
    db,
    `SELECT NULLIF(effort, '') AS effort, COUNT(*) AS n
     FROM claude_requests WHERE ${recentBound}
     GROUP BY 1 ORDER BY n DESC, effort IS NULL, effort;`,
  );

  const perDay = read<{ day: string; n: number; tout: number | null }>(
    db,
    `SELECT ${dayOf} AS day, COUNT(*) AS n, SUM(tokens_out) AS tout
     FROM claude_requests WHERE ${recentBound} GROUP BY 1;`,
  );
  const requestsByDay = new Map(perDay.map((r) => [r.day, r]));

  const mixRows = read<{ day: string; model: string; n: number }>(
    db,
    `SELECT ${dayOf} AS day, COALESCE(NULLIF(model, ''), '(unknown)') AS model, COUNT(*) AS n
     FROM claude_requests WHERE ${recentBound} GROUP BY 1, 2;`,
  );
  const mix = new Map(mixRows.map((r) => [`${r.day}\u0000${r.model}`, r.n]));

  const cache = read<{ day: string; pct: number | null; cost: number | null; tcr: number; tcw: number }>(
    db,
    `SELECT day, cache_hit_percentage AS pct, cost_usd AS cost,
            tokens_cache_read AS tcr, tokens_cache_creation AS tcw FROM claude_daily_rollups
     WHERE day BETWEEN ${sqlStr(recentFrom)} AND ${sqlStr(today)};`,
  );
  const cacheByDay = new Map(cache.map((r) => [r.day, r]));
  const costDays = snapshotDays(db, "total_cost_usd", recentFrom, today, { now });
  const costByDay = new Map(cache.filter((r) => costDays.has(r.day)).map((r) => [r.day, r.cost]));

  // Cost and latency per model, off the rollup's per-request metrics, by the
  // same local day the request bucket above uses.
  const metricsBound = `day BETWEEN ${sqlStr(recentFrom)} AND ${sqlStr(today)}`;
  const costByModel = new Map(
    read<{ model: string; usd: number | null; priced: number | null; unpriced: number | null }>(
      db,
      `SELECT ${MODEL_KEY_SQL} AS model, ${API_COST_SQL} FROM claude_request_metrics WHERE ${metricsBound} GROUP BY 1;`,
    ).map((r) => [r.model, apiCostOf(r)]),
  );
  const latency = latencyByModel(db, metricsBound);

  const errors = read<{ status: string; n: number; first: number; last: number }>(
    db,
    `SELECT api_error_status AS status, COUNT(*) AS n, MIN(ts) AS first, MAX(ts) AS last
     FROM claude_requests
     WHERE api_error_status IS NOT NULL AND api_error_status <> '' AND ${bound}
     GROUP BY 1 ORDER BY n DESC, status;`,
  );

  return {
    generatedAt: now,
    today,
    range,
    recentFrom,
    allTime,
    recent,
    skills: leaderboard(db, "attribution_skill", bound),
    mcpServers: leaderboard(db, "attribution_mcp_server", bound, "attribution_mcp_tool"),
    plugins: leaderboard(db, "attribution_plugin", bound),
    mainThread: toTotals(side.find((r) => r.sc === 0)),
    subagents: toTotals(side.find((r) => r.sc === 1)),
    models,
    modelMix: days.map((day) => ({ day, requests: models.map((m) => mix.get(`${day}\u0000${m.model}`) ?? 0) })),
    // A date with no rollup row had no requests and no sessions: no reading.
    cacheTrend: days.map((day) => {
      const c = cacheByDay.get(day);
      return { day, pct: c?.pct ?? null, read: c?.tcr ?? 0, write: c?.tcw ?? 0 };
    }),
    apiErrors: {
      total: errors.reduce((a, r) => a + r.n, 0),
      byStatus: errors.map((r) => ({ status: r.status, requests: r.n })),
      firstTs: errors.length === 0 ? null : Math.min(...errors.map((r) => r.first)),
      lastTs: errors.length === 0 ? null : Math.max(...errors.map((r) => r.last)),
    },
    modelShare: perModel.map((r) => ({ model: r.model, requests: r.n, tokensOut: r.tout ?? 0 })),
    modelTable: perModel.map((r) => ({
      model: r.model,
      requests: r.n,
      freshTokens: (r.tin ?? 0) + (r.tout ?? 0),
      tokensOut: r.tout ?? 0,
      cacheHitPct: r.hit,
      apiCost: costByModel.get(r.model) ?? apiCostOf(undefined),
      response: (latency.get(r.model) ?? NO_LATENCY).response,
      tokPerSMedian: (latency.get(r.model) ?? NO_LATENCY).tokPerSMedian,
    })),
    effort: effort.map((e) => ({ effort: e.effort, requests: e.n })),
    // A date with no request is a gap in requests and tokens; a date with no
    // cost reading is a gap in cost. Neither is 0.
    series: days.map((day) => {
      const r = requestsByDay.get(day);
      const cost = costByDay.get(day);
      return { day, requests: r?.n ?? null, tokensOut: r === undefined ? null : r.tout ?? 0, costUsd: cost ?? null };
    }),
  };
}
