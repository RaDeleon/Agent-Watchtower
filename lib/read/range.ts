/**
 * The time spans a page can be viewed over: `7d · 30d · 90d · All` (spec §4.5).
 *
 * A range reaches a page only through {@link parseRange}, which maps anything
 * it does not recognise to the default. The raw query string is never kept, so
 * no renderer can reflect it: a `Range` is one of four known literals.
 *
 * Calendar arithmetic only. Days are the rollup's LOCAL days, as strings; this
 * file adds whole days to them and never looks at a clock.
 */

export type Range = "7d" | "30d" | "90d" | "all";

export const RANGES: readonly Range[] = ["7d", "30d", "90d", "all"];

export const DEFAULT_RANGE: Range = "30d";

const DAYS: Record<Exclude<Range, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

/** The range a query value names, or the default for anything else -- hostile, empty or absent. */
export function parseRange(s: string | null | undefined): Range {
  return (RANGES as readonly string[]).includes(s ?? "") ? (s as Range) : DEFAULT_RANGE;
}

/**
 * The first day of the range's window ending on `today`, inclusive: 7d on
 * 2026-09-23 starts 2026-09-17. Null for `all`, whose start is the first day
 * there is data for -- which only a reader can know.
 */
export function rangeStartDay(today: string, r: Range): string | null {
  if (r === "all") return null;
  const [y, m, d] = today.split("-").map(Number);
  // UTC arithmetic on a date, so no zone or DST edge can move it.
  return new Date(Date.UTC(y, m - 1, d - (DAYS[r] - 1))).toISOString().slice(0, 10);
}

/** The range in words, for headings and captions: "last 7 days", "all time". */
export function rangeLabel(r: Range): string {
  return r === "all" ? "all time" : `last ${DAYS[r]} days`;
}

/**
 * Past this many days a per-day series is drawn one point per week. Only `all`
 * can be longer (90d is exactly 90), and it grows by a day's worth of marks
 * every day; weekly, it grows by one bucket a week, which keeps `watchtower
 * report` inside its budget indefinitely (Stage 3D fix wave, I4).
 */
export const WEEKLY_OVER_DAYS = 90;

/** One point of a series: a day, or a week's run of days. */
export interface Bucket {
  /** The first day in the bucket: the axis label. */
  label: string;
  days: string[];
  week: boolean;
}

/** The Monday that starts `day`'s ISO week. UTC arithmetic on a date, like {@link rangeStartDay}. */
export function weekOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const back = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
}

/**
 * The buckets a series over `days` (consecutive, oldest first) is drawn in:
 * one per day, or -- past {@link WEEKLY_OVER_DAYS} -- one per ISO week, the
 * first and last possibly partial. Grouping only: what a bucket's value is
 * (a sum, a mean of readings, the last running total) is the caller's to say
 * in its caption.
 */
export function buckets(days: readonly string[]): { weekly: boolean; buckets: Bucket[] } {
  if (days.length <= WEEKLY_OVER_DAYS) return { weekly: false, buckets: days.map((day) => ({ label: day, days: [day], week: false })) };
  const out: Bucket[] = [];
  let week = "";
  for (const day of days) {
    const w = weekOf(day);
    if (w !== week) {
      out.push({ label: day, days: [], week: true });
      week = w;
    }
    out[out.length - 1].days.push(day);
  }
  return { weekly: true, buckets: out };
}

/** A bucket's span in words: "2026-06-15" for a day, "week of 2026-06-15 to 2026-06-21" for a week. */
export function bucketName(b: Bucket): string {
  if (!b.week) return b.label;
  return b.days.length === 1 ? `week of ${b.label}, 1 day in range` : `week of ${b.label} to ${b.days[b.days.length - 1]}`;
}

/** The sum of the readings, or null when there is none: a gap, not 0. */
export function sumOf(vals: readonly (number | null | undefined)[]): number | null {
  let n = 0, any = false;
  for (const v of vals) if (v !== null && v !== undefined) { n += v; any = true; }
  return any ? n : null;
}

/** The mean of the readings, skipping days with none; null when there is none. */
export function meanOf(vals: readonly (number | null | undefined)[]): { mean: number; of: number } | null {
  const known = vals.filter((v): v is number => v !== null && v !== undefined);
  return known.length === 0 ? null : { mean: known.reduce((a, b) => a + b, 0) / known.length, of: known.length };
}
