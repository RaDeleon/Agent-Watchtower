/**
 * Order statistics for the Performance page (spec 4.3).
 *
 * Sorts and picks, nothing else. Every value handed in -- a response time, a
 * token rate, a turn's wait -- was derived in capture/rollup.sh; this file
 * never computes one. NULL means "not measured": it is dropped, never read as
 * 0, and an input with nothing measured gives null, never 0.
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { DEFAULT_RANGE, rangeStartDay, type Range } from "./range.ts";

export interface OrderStats { n: number; median: number | null; p90: number | null }

/** The measured values, ascending, in a new array: the caller's is never reordered. */
function measured(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null).sort((a, b) => a - b);
}

function medianOfSorted(xs: readonly number[]): number | null {
  const n = xs.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function p90OfSorted(xs: readonly number[]): number | null {
  const n = xs.length;
  if (n === 0) return null;
  // ceil(0.9 * n), written as 9n / 10 so no binary rounding of 0.9 can push
  // an exact multiple of ten past its integer.
  return xs[Math.ceil((9 * n) / 10) - 1];
}

/** Spec 4.3's one definition. NULLs are dropped; n = 0 gives null. Sorts and picks only. */
export function median(values: readonly (number | null)[]): number | null {
  return medianOfSorted(measured(values));
}

/** Nearest rank: the value at 1-based position ceil(0.9 * n) in ascending order. */
export function p90(values: readonly (number | null)[]): number | null {
  return p90OfSorted(measured(values));
}

export function orderStats(values: readonly (number | null)[]): OrderStats {
  const xs = measured(values);
  return { n: xs.length, median: medianOfSorted(xs), p90: p90OfSorted(xs) };
}

// ---------------------------------------------------------------------------
// Cost at API prices and latency, as the readers take them (Stage 4B Task 5).
//
// Every figure below was decided in rollup.sh: which requests are priced
// (`priced`, `price_note`), what each costs (`cost_table_usd` and the two
// cache-write parts), each request's response time and output rate, and each
// turn's wait and status. The SQL here filters on those stored columns, sums
// the stored costs and counts; the order statistics go through the three
// functions above. Nothing here multiplies by a rate: no price appears in lib/.
// ---------------------------------------------------------------------------


/**
 * A cost at API prices over a set of requests: the sum of the priced ones'
 * stored costs, and how many were and were not priced. A `<synthetic>` row
 * (`priced` NULL) is in neither count: it made no API call.
 */
export interface ApiCost { usd: number; priced: number; unpriced: number }

/**
 * The three aggregate columns an {@link ApiCost} is read from, over
 * `claude_request_metrics` rows. `TOTAL` sums the priced rows' stored costs
 * and is 0.0 over none; the page never shows that 0 unless `priced > 0`.
 */
export const API_COST_SQL =
  "TOTAL(CASE WHEN priced = 1 THEN cost_table_usd END) AS usd, " +
  "COALESCE(SUM(priced = 1), 0) AS priced, COALESCE(SUM(priced = 0), 0) AS unpriced";

/** One row's three aggregates as an {@link ApiCost}; a missing row is nothing priced and nothing unpriced. */
export function apiCostOf(r: { usd: number | null; priced: number | null; unpriced: number | null } | undefined): ApiCost {
  return { usd: r?.usd ?? 0, priced: r?.priced ?? 0, unpriced: r?.unpriced ?? 0 };
}

/** The sum of several costs, or null when there is none to sum: a gap, not a zero. */
export function sumApiCosts(costs: readonly (ApiCost | null | undefined)[]): ApiCost | null {
  let out: ApiCost | null = null;
  for (const c of costs) {
    if (c === null || c === undefined) continue;
    out = out === null ? { ...c } : { usd: out.usd + c.usd, priced: out.priced + c.priced, unpriced: out.unpriced + c.unpriced };
  }
  return out;
}

/** The model a request is grouped under: the Models & Skills page's own key. */
export const MODEL_KEY_SQL = "COALESCE(NULLIF(model, ''), '(unknown)')";

export interface Latency {
  /** `response_ms` over the model's requests that have one. */
  response: OrderStats;
  /** The median of the stored `tok_per_s`; null with none. */
  tokPerSMedian: number | null;
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

/**
 * Each model's response-time order statistics and median output rate, over
 * the `claude_request_metrics` rows `where` selects (a SQL condition on its
 * stored columns). The values are the rollup's; this groups them by model and
 * hands each group to {@link orderStats} / {@link median}. A model with no
 * timed request is absent from the map: the caller reads it as n = 0.
 */
export function latencyByModel(db: string, where: string): Map<string, Latency> {
  const rows = read<{ model: string; r: number | null; t: number | null }>(
    db,
    `SELECT ${MODEL_KEY_SQL} AS model, response_ms AS r, tok_per_s AS t
     FROM claude_request_metrics
     WHERE (${where}) AND (response_ms IS NOT NULL OR tok_per_s IS NOT NULL);`,
  );
  const by = new Map<string, { r: (number | null)[]; t: (number | null)[] }>();
  for (const x of rows) {
    let g = by.get(x.model);
    if (g === undefined) by.set(x.model, (g = { r: [], t: [] }));
    g.r.push(x.r);
    g.t.push(x.t);
  }
  return new Map([...by].map(([m, g]) => [m, { response: orderStats(g.r), tokPerSMedian: median(g.t) }]));
}

/** No timed request at all. */
export const NO_LATENCY: Latency = { response: { n: 0, median: null, p90: null }, tokPerSMedian: null };

export interface ModelPerf {
  model: string;
  cost: ApiCost;
  /** This model's share of the priced cost in range; null when it had none priced, or nothing was. */
  share: number | null;
  response: OrderStats;
  tokPerSMedian: number | null;
}

export interface PriceRow {
  model: string; speed: string; effectiveFrom: string;
  input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number;
  verifiedOn: string; source: string;
}

export interface PerformanceData {
  generatedAt: number;
  today: string;
  range: Range;
  /** The range's first local day; for `all`, the first day with a request (today when there is none). */
  rangeFrom: string;
  /** By cost desc, then requests desc. `<synthetic>` rows are not a model. */
  models: ModelPerf[];
  /** Waits over `measured` turns only; the other two statuses are counted. */
  turns: OrderStats & { measured: number; human: number; headless: number };
  /** Split tokens off claude_requests; their costs over priced requests only (null when none was priced). */
  cacheMix: { tokens5m: number; tokens1h: number; cost5m: number | null; cost1h: number | null };
  /** Not-priced requests by note and model, most first. */
  unpriced: { note: string; model: string; n: number }[];
  /** Requests priced at standard rates with no `speed` recorded (spec §2.1 c). */
  speedAbsentPriced: number;
  /** The rates the rollup priced with, as `claude_prices` holds them. Not ranged. */
  prices: PriceRow[];
  lastRollup: number | null;
}

/**
 * The Performance page's reads (spec §5). Every ranged figure covers the
 * range's whole local days, `rangeFrom` to `today`, by the `day` the rollup
 * stored on each request and turn -- the same local day the token columns use.
 */
export function readPerformance(db: string, opts: { now?: number; range?: Range } = {}): PerformanceData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const range = opts.range ?? DEFAULT_RANGE;
  const today = read<{ d: string }>(db, `SELECT date(${sqlNum(now)}, 'unixepoch', 'localtime') AS d;`)[0].d;
  const start = rangeStartDay(today, range);
  const rangeFrom =
    start ?? read<{ d: string | null }>(db, `SELECT MIN(day) AS d FROM claude_request_metrics;`)[0]?.d ?? today;
  const dayIn = (col: string) =>
    start === null ? `${col} <= ${sqlStr(today)}` : `${col} BETWEEN ${sqlStr(start)} AND ${sqlStr(today)}`;
  const inRange = dayIn("day");

  const costs = read<{ model: string; usd: number | null; priced: number | null; unpriced: number | null }>(
    db,
    `SELECT ${MODEL_KEY_SQL} AS model, ${API_COST_SQL}
     FROM claude_request_metrics WHERE ${inRange} AND priced IS NOT NULL
     GROUP BY 1;`,
  );
  const lat = latencyByModel(db, `${inRange} AND priced IS NOT NULL`);
  const pricedTotal = costs.reduce((a, r) => a + ((r.priced ?? 0) > 0 ? r.usd ?? 0 : 0), 0);
  const models: ModelPerf[] = costs
    .map((r) => {
      const cost = apiCostOf(r);
      const l = lat.get(r.model) ?? NO_LATENCY;
      return {
        model: r.model,
        cost,
        share: cost.priced > 0 && pricedTotal > 0 ? cost.usd / pricedTotal : null,
        response: l.response,
        tokPerSMedian: l.tokPerSMedian,
      };
    })
    .sort(
      (a, b) =>
        (b.cost.priced > 0 ? b.cost.usd : -1) - (a.cost.priced > 0 ? a.cost.usd : -1) ||
        b.cost.priced + b.cost.unpriced - (a.cost.priced + a.cost.unpriced) ||
        a.model.localeCompare(b.model),
    );

  const byStatus = read<{ status: string; n: number }>(
    db,
    `SELECT status, COUNT(*) AS n FROM claude_turns WHERE ${inRange} GROUP BY status;`,
  );
  const count = (s: string) => byStatus.find((x) => x.status === s)?.n ?? 0;
  const waits = read<{ w: number | null }>(
    db,
    `SELECT wait_ms AS w FROM claude_turns WHERE ${inRange} AND status = 'measured';`,
  ).map((x) => x.w);

  const [mix] = read<{ t5: number | null; t1: number | null; c5: number | null; c1: number | null }>(
    db,
    `SELECT SUM(r.cache_write_5m) AS t5, SUM(r.cache_write_1h) AS t1,
            SUM(CASE WHEN m.priced = 1 THEN m.cost_write_5m_usd END) AS c5,
            SUM(CASE WHEN m.priced = 1 THEN m.cost_write_1h_usd END) AS c1
     FROM claude_request_metrics m JOIN claude_requests r ON r.request_id = m.request_id
     WHERE ${dayIn("m.day")};`,
  );

  const unpriced = read<{ note: string; model: string; n: number }>(
    db,
    `SELECT COALESCE(price_note, '(none)') AS note, ${MODEL_KEY_SQL} AS model, COUNT(*) AS n
     FROM claude_request_metrics WHERE ${inRange} AND priced = 0
     GROUP BY 1, 2 ORDER BY n DESC, note, model;`,
  );
  const speedAbsent = read<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM claude_request_metrics WHERE ${inRange} AND priced = 1 AND price_note = 'speed-absent';`,
  )[0]?.n ?? 0;

  const prices = read<{
    model: string; speed: string; effective_from: string; input: number; output: number; cache_read: number;
    cache_write_5m: number; cache_write_1h: number; verified_on: string; source: string;
  }>(
    db,
    `SELECT model, speed, effective_from, input, output, cache_read, cache_write_5m, cache_write_1h, verified_on, source
     FROM claude_prices ORDER BY model, speed, effective_from;`,
  ).map((p) => ({
    model: p.model, speed: p.speed, effectiveFrom: p.effective_from,
    input: p.input, output: p.output, cacheRead: p.cache_read,
    cacheWrite5m: p.cache_write_5m, cacheWrite1h: p.cache_write_1h,
    verifiedOn: p.verified_on, source: p.source,
  }));

  const last = read<{ t: number | null }>(db, `SELECT MAX(updated_at) AS t FROM claude_daily_rollups;`);

  return {
    generatedAt: now,
    today,
    range,
    rangeFrom,
    models,
    turns: { ...orderStats(waits), measured: count("measured"), human: count("human"), headless: count("headless") },
    cacheMix: { tokens5m: mix?.t5 ?? 0, tokens1h: mix?.t1 ?? 0, cost5m: mix?.c5 ?? null, cost1h: mix?.c1 ?? null },
    unpriced,
    speedAbsentPriced: speedAbsent,
    prices,
    lastRollup: last[0]?.t ?? null,
  };
}
