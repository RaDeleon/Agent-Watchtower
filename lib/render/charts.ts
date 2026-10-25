/**
 * Chart primitives: pure `data -> SVG string` functions.
 *
 * Deterministic by construction — no clock, no randomness, no locale — so each
 * one is snapshot-testable. Callers pass already-formatted labels.
 *
 * Empty or absent input renders an explicit empty state, never a broken axis
 * and never a zero. "Do not assert a measurement where there is none" is a
 * rendering rule here as much as a SQL one.
 *
 * Colour is never written here: every mark carries a class, and the classes
 * resolve to theme tokens (`var(--…)`) in layout.ts. A test greps this file for
 * a literal colour. Every mark carries its value as a `<title>` child, which
 * is there without script and for a screen reader, and which the client's
 * styled tooltip reads. There is no `data-tip` copy of it on an SVG mark: that
 * duplicated ~10% of the report's bytes (I4).
 *
 * The report carries every chart once per range, so a chart's per-point markup
 * is most of the report's growth with history (Stage 4B fix round, I3). Three
 * encodings keep it small without dropping a value:
 *  - a coordinate has one decimal, and none when it is whole ({@link px});
 *  - a chart's hover columns are one `<g class="hits">` whose `stroke-width` is
 *    the column's width, each column a vertical stroke carrying its `<title>`
 *    ({@link hitGroup}), rather than a four-attribute rect apiece;
 *  - a stacked bar's segments are one path per series ({@link stackedBar}):
 *    they carry no tooltip of their own, so nothing tells them apart.
 */
import type { Range } from "../read/range.ts";
import { RANGES } from "../read/range.ts";
import { esc, num } from "./html.ts";

const RING_SIZE = 132;
const RING_STROKE = 13;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Which band a rate-limit reading falls in. Labelling, not modelling: these
 * thresholds decide a colour and nothing else.
 */
function band(pct: number): string {
  if (pct >= 100) return "over";
  if (pct >= 80) return "high";
  if (pct >= 50) return "mid";
  return "low";
}

/**
 * The Live limit rings' states (spec §5): ok < 70 <= warn < 90 <= over. Each
 * state also prints a word under the percentage, so a theme whose `--ok` is
 * close to `--warn` (Raptors' silver) never leaves colour as the only signal.
 * Four words over three colours: at or past 100% the ring is not "near" the
 * limit any more. Labelling only.
 */
export function limitState(pct: number): { state: "ok" | "warn" | "over"; word: string } {
  if (pct >= 100) return { state: "over", word: "over limit" };
  if (pct >= 90) return { state: "over", word: "near limit" };
  if (pct >= 70) return { state: "warn", word: "high" };
  return { state: "ok", word: "ok" };
}

export interface ProgressRingOpts {
  /** Null means NO READING — rendered as such, never as 0%. */
  pct: number | null;
  label: string;
  /** Small line under the value, e.g. the time of the reading. */
  sublabel?: string;
  /**
   * `severity` (the default) bands the arc by how close a limit is. `progress`
   * is for a quantity where full is good news -- rank progress -- and must not
   * turn orange at 80%. `limit` is Live's rings: {@link limitState}'s three
   * states, each with its word printed under the value.
   */
  tone?: "severity" | "progress" | "limit";
  /** Printed in place of the percentage, e.g. "top rank". */
  valueText?: string;
  /**
   * Mark the printed percentage for the client's count-up. Opt-in, and only
   * ever emitted for a finite reading: a null never counts up from 0.
   */
  count?: boolean;
}

/**
 * A rate-limit gauge.
 *
 * Two rules, both load-bearing, both measured on real data:
 *
 *  - A null reading renders "no reading". One snapshot in four carries no 5h
 *    reading, and a 0% gauge is a lie that reads as good news.
 *  - A reading over 100% is NOT clamped. The all-time peak on this machine is
 *    108%. The arc saturates at a full sweep because a circle cannot show more,
 *    but the printed number stays true, and the ring is marked `over`.
 */
export function progressRing(opts: ProgressRingOpts): string {
  const { pct, label, sublabel, tone = "severity" } = opts;
  const known = pct !== null;
  const sweep = known ? Math.min(Math.max(pct, 0), 100) / 100 : 0;
  const dash = RING_CIRCUMFERENCE * sweep;
  const gap = RING_CIRCUMFERENCE - dash;
  const limit = known && tone === "limit" ? limitState(pct) : null;
  const state = !known ? "unknown" : tone === "progress" ? "progress" : limit !== null ? limit.state : band(pct);
  const value = opts.valueText ?? (known ? `${num(pct, 1)}%` : "no reading");
  const c = RING_SIZE / 2;
  const tip = esc(`${label}: ${value}${limit === null ? "" : ` · ${limit.word}`}`);
  const counted = opts.count === true && known && Number.isFinite(pct) && opts.valueText === undefined
    ? ` data-count="${num(pct, 1)}"`
    : "";

  return [
    `<figure class="ring ring-${state}">`,
    `<svg viewBox="0 0 ${RING_SIZE} ${RING_SIZE}" width="${RING_SIZE}" height="${RING_SIZE}" role="img" aria-label="${esc(label)}: ${esc(value)}">`,
    `<circle class="ring-track" cx="${RING_SIZE / 2}" cy="${RING_SIZE / 2}" r="${num(RING_RADIUS, 2)}" fill="none" stroke-width="${RING_STROKE}"/>`,
    known
      ? `<circle class="ring-arc" cx="${RING_SIZE / 2}" cy="${RING_SIZE / 2}" r="${num(RING_RADIUS, 2)}" fill="none" stroke-width="${RING_STROKE}" stroke-linecap="round" stroke-dasharray="${num(dash, 2)} ${num(gap, 2)}" transform="rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})"><title>${tip}</title></circle>`
      : `<circle class="ring-arc ring-arc-unknown" cx="${RING_SIZE / 2}" cy="${RING_SIZE / 2}" r="${num(RING_RADIUS, 2)}" fill="none" stroke-width="${RING_STROKE}" stroke-dasharray="4 8"><title>${tip}</title></circle>`,
    limit === null
      ? `<text class="ring-value" x="${c}" y="${c}" text-anchor="middle" dominant-baseline="central"${counted}>${esc(value)}</text>`
      : `<text class="ring-value" x="${c}" y="${c - 6}" text-anchor="middle" dominant-baseline="central"${counted}>${esc(value)}</text>` +
        `<text class="ring-state" x="${c}" y="${c + 16}" text-anchor="middle" dominant-baseline="central">${esc(limit.word)}</text>`,
    `</svg>`,
    `<figcaption>${esc(label)}${sublabel ? `<span class="ring-sub">${esc(sublabel)}</span>` : ""}</figcaption>`,
    `</figure>`,
  ].join("");
}

// ---------------------------------------------------------------------------
// Shared pieces for the chart primitives below.
// ---------------------------------------------------------------------------

/**
 * The empty state. A deliberate figure that says there is nothing to draw,
 * never a broken axis and never a row of zeros: a 77-day heatmap on a fresh
 * install with three days of data has to look intentional.
 */
function empty(label: string, message: string): string {
  return `<figure class="chart chart-empty"><div class="empty-msg">${esc(message)}</div><figcaption>${esc(label)}</figcaption></figure>`;
}

/**
 * Split a series into unbroken runs at every null.
 *
 * This is how a line chart refuses to invent a measurement: a null ends the
 * current run and the next value starts a new one, so the gap is drawn as a
 * gap. Mapping the null to 0 instead draws a cliff to the floor, the hygiene
 * trend's defining bug.
 */
function runs(values: (number | null)[]): { start: number; vals: number[] }[] {
  const out: { start: number; vals: number[] }[] = [];
  let cur: { start: number; vals: number[] } | null = null;
  values.forEach((v, i) => {
    if (v === null) {
      cur = null;
      return;
    }
    if (cur === null) {
      cur = { start: i, vals: [] };
      out.push(cur);
    }
    cur.vals.push(v);
  });
  return out;
}

/** 0-4 intensity for heatmaps. Zero stays level 0; any activity is at least 1. */
function level(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((v / max) * 4));
}

const fmt0 = (n: number) => num(n, 0);

/** A coordinate: one decimal, and none when it is whole -- "48", not "48.0". */
export function px(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** One hover column: centred at `cx`, `w` wide, carrying `tip` as its `<title>`. */
interface Hit {
  cx: number;
  w: number;
  tip: string;
}

/**
 * A chart's hover columns, one per reading, as ONE group: the group's
 * `stroke-width` is the usual column width and each column is a vertical
 * stroke from `top`, `h` tall, with its `<title>` -- about half the bytes of a
 * rect with four geometry attributes (I3). A column narrower than the rest (an
 * area chart's first and last, clamped at the plot's edges) carries its own
 * width. The strokes are transparent until hovered (layout.ts `.hits`); the
 * client tips any mark whose first child is a `<title>`, whatever its tag.
 */
function hitGroup(hits: Hit[], top: number, h: number): string {
  if (hits.length === 0) return "";
  const widths = new Map<string, number>();
  for (const x of hits) widths.set(px(x.w), (widths.get(px(x.w)) ?? 0) + 1);
  const common = [...widths].sort((a, b) => b[1] - a[1])[0][0];
  const marks = hits
    .map((x) => {
      const w = px(x.w);
      return `<path d="M${px(x.cx)} ${px(top)}v${px(h)}"${w === common ? "" : ` stroke-width="${w}"`}><title>${x.tip}</title></path>`;
    })
    .join("");
  return `<g class="hits" stroke-width="${common}">${marks}</g>`;
}

// ---------------------------------------------------------------------------
// areaChart / sparkline
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  label: string;
  /** Null is NO READING: the line breaks here rather than dropping to 0. */
  value: number | null;
  /** Adds a marker with this class suffix, e.g. a rescaled hygiene day. */
  mark?: string;
  /** Tooltip for the point's marker. */
  title?: string;
}

export interface AreaChartOpts {
  points: SeriesPoint[];
  label: string;
  /** Fill under the line. Off, it is a plain line chart. */
  fill?: boolean;
  /** Fixed top of the y axis, e.g. 100 for a score. Defaults to the data's max. */
  yMax?: number;
  /**
   * Bottom of the y axis, 0 by default. A running total starts it at what was
   * already spent, so a week's rise is not a flat line along the top (M12).
   */
  yMin?: number;
  format?: (n: number) => string;
  emptyText?: string;
  /** viewBox size. A full-width card passes {@link WIDE_W} so its text is not drawn at twice the size (M1). */
  width?: number;
  height?: number;
}

/**
 * The viewBox width for a chart in a full-width (`wide`) card. The chart is
 * scaled to its card, so a 720-wide viewBox in a card twice as wide as a
 * half-width one drew every tick at twice the size (M1).
 */
export const WIDE_W = 1440;
const AREA_W = 720;
const AREA_H = 180;
const PAD_L = 48;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 22;

export function areaChart(opts: AreaChartOpts): string {
  const { points, label, fill = true, format = fmt0 } = opts;
  const known = points.flatMap((p) => (p.value === null ? [] : [p.value]));
  if (known.length === 0) return empty(label, opts.emptyText ?? "no data yet");

  const W = opts.width ?? AREA_W;
  const H = opts.height ?? AREA_H;
  const yMin = Math.min(opts.yMin ?? 0, ...known);
  const yMax = opts.yMax ?? Math.max(...known);
  // An all-zero series is real data (a flat line at 0), not an empty one; only
  // the scale needs a non-zero height to divide by.
  const scale = yMax - yMin > 0 ? yMax - yMin : 1;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const n = points.length;
  const x = (i: number) => PAD_L + (n === 1 ? plotW / 2 : (i * plotW) / (n - 1));
  const y = (v: number) => PAD_T + plotH * (1 - Math.min(v - yMin, scale) / scale);
  const base = PAD_T + plotH;

  const parts: string[] = [];
  for (const r of runs(points.map((p) => p.value))) {
    if (r.vals.length === 1) {
      parts.push(`<circle class="pt-solo" cx="${px(x(r.start))}" cy="${px(y(r.vals[0]))}" r="2.5"/>`);
      continue;
    }
    const coords = r.vals.map((v, k) => `${px(x(r.start + k))} ${px(y(v))}`);
    if (fill) {
      const first = px(x(r.start));
      const last = px(x(r.start + r.vals.length - 1));
      parts.push(`<path class="area" d="M${first} ${px(base)} L${coords.join(" L")} L${last} ${px(base)} Z"/>`);
    }
    parts.push(`<path class="line" d="M${coords.join(" L")}"/>`);
  }
  const tipOf = (p: SeriesPoint & { value: number }) => esc(p.title ?? `${p.label}: ${format(p.value)}`);
  points.forEach((p, i) => {
    if (p.mark === undefined || p.value === null) return;
    const tip = tipOf(p as SeriesPoint & { value: number });
    parts.push(
      `<circle class="pt pt-${esc(p.mark)}" cx="${px(x(i))}" cy="${px(y(p.value))}" r="3.5">` +
        `<title>${tip}</title></circle>`,
    );
  });
  // One invisible hover column per reading, so every point has a tooltip even
  // where the line is too thin to aim at. A null gets none: there is nothing to
  // report there, and the gap in the line already says so.
  const slot = n === 1 ? plotW : plotW / (n - 1);
  const hits = points.flatMap((p, i) => {
    if (p.value === null) return [];
    const left = Math.max(PAD_L, x(i) - slot / 2);
    const right = Math.min(PAD_L + plotW, x(i) + slot / 2);
    const w = Math.max(1, right - left);
    return [{ cx: left + w / 2, w, tip: tipOf(p as SeriesPoint & { value: number }) }];
  });

  const axis = [
    `<line class="axis" x1="${PAD_L}" y1="${px(base)}" x2="${W - PAD_R}" y2="${px(base)}"/>`,
    `<text class="tick" x="${PAD_L - 6}" y="${PAD_T + 4}" text-anchor="end">${esc(format(yMax))}</text>`,
    `<text class="tick" x="${PAD_L - 6}" y="${px(base)}" text-anchor="end">${esc(format(yMin))}</text>`,
    `<text class="tick" x="${PAD_L}" y="${H - 4}">${esc(points[0].label)}</text>`,
    n > 1 ? `<text class="tick" x="${W - PAD_R}" y="${H - 4}" text-anchor="end">${esc(points[n - 1].label)}</text>` : "",
  ].join("");

  return (
    `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">` +
    axis + parts.join("") + hitGroup(hits, PAD_T, plotH) +
    `</svg><figcaption>${esc(label)}</figcaption></figure>`
  );
}

export interface SparklineOpts {
  /** Null breaks the line, as in {@link areaChart}. */
  values: (number | null)[];
  label: string;
  width?: number;
  height?: number;
}

/** A word-sized trend. No axes: it sits next to a number that carries the scale. */
export function sparkline(opts: SparklineOpts): string {
  const { values, label, width = 120, height = 28 } = opts;
  const known = values.flatMap((v) => (v === null ? [] : [v]));
  if (known.length === 0) {
    return `<span class="spark spark-empty absent" title="${esc(label)}">—</span>`;
  }
  const max = Math.max(...known);
  const min = Math.min(...known, 0);
  const span = max - min || 1;
  const n = values.length;
  const x = (i: number) => (n === 1 ? width / 2 : (i * (width - 2)) / (n - 1) + 1);
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const parts = runs(values).map((r) =>
    r.vals.length === 1
      ? `<circle cx="${px(x(r.start))}" cy="${px(y(r.vals[0]))}" r="1.5"/>`
      : `<path d="M${r.vals.map((v, k) => `${px(x(r.start + k))} ${px(y(v))}`).join(" L")}"/>`,
  );
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${parts.join("")}</svg>`;
}

// ---------------------------------------------------------------------------
// dayBars / stackedBar
// ---------------------------------------------------------------------------

export interface Bar {
  label: string;
  /** Null is NO READING: a hatched stub, distinct from a genuine 0. */
  value: number | null;
  title?: string;
}

export interface DayBarsOpts {
  bars: Bar[];
  label: string;
  format?: (n: number) => string;
  emptyText?: string;
  /** Index of a bar to highlight, e.g. today in a week. */
  highlight?: number;
}

const BAR_H = 150;
const LABEL_EVERY_BAR_UP_TO = 12;

export function dayBars(opts: DayBarsOpts): string {
  const { bars, label, format = fmt0 } = opts;
  if (bars.length === 0) return empty(label, opts.emptyText ?? "no data yet");
  const known = bars.flatMap((b) => (b.value === null ? [] : [b.value]));
  const max = known.length === 0 ? 0 : Math.max(...known);
  const scale = max > 0 ? max : 1;
  const plotW = AREA_W - PAD_L - PAD_R;
  const plotH = BAR_H - PAD_T - PAD_B;
  const base = PAD_T + plotH;
  const slot = plotW / bars.length;
  const w = Math.max(1, slot * 0.72);

  const rects = bars.map((b, i) => {
    const bx = px(PAD_L + i * slot + (slot - w) / 2);
    const text = esc(b.title ?? `${b.label}: ${b.value === null ? "no reading" : format(b.value)}`);
    const tip = `<title>${text}</title>`;
    if (b.value === null) {
      return `<rect class="bar-absent" x="${bx}" y="${px(base - 4)}" width="${px(w)}" height="4">${tip}</rect>`;
    }
    const h = (plotH * Math.max(0, b.value)) / scale;
    const cls = i === opts.highlight ? "bar bar-today" : "bar";
    return `<rect class="${cls}" x="${bx}" y="${px(base - h)}" width="${px(w)}" height="${px(h)}">${tip}</rect>`;
  });

  const n = bars.length;
  const axis = [
    `<line class="axis" x1="${PAD_L}" y1="${px(base)}" x2="${AREA_W - PAD_R}" y2="${px(base)}"/>`,
    `<text class="tick" x="${PAD_L - 6}" y="${PAD_T + 4}" text-anchor="end">${esc(format(max))}</text>`,
    `<text class="tick" x="${PAD_L - 6}" y="${px(base)}" text-anchor="end">${esc(format(0))}</text>`,
    // Few bars (a week) get a label each; many (a month of days) get the ends.
    ...(n <= LABEL_EVERY_BAR_UP_TO
      ? bars.map((b, i) => `<text class="tick${i === opts.highlight ? " tick-today" : ""}" x="${px(PAD_L + (i + 0.5) * slot)}" y="${BAR_H - 4}" text-anchor="middle">${esc(b.label)}</text>`)
      : [
          `<text class="tick" x="${PAD_L}" y="${BAR_H - 4}">${esc(bars[0].label)}</text>`,
          `<text class="tick" x="${AREA_W - PAD_R}" y="${BAR_H - 4}" text-anchor="end">${esc(bars[n - 1].label)}</text>`,
        ]),
  ].join("");

  return (
    `<figure class="chart"><svg viewBox="0 0 ${AREA_W} ${BAR_H}" role="img" aria-label="${esc(label)}">` +
    axis + rects.join("") +
    `</svg><figcaption>${esc(label)}</figcaption></figure>`
  );
}

export interface StackedColumn {
  label: string;
  /** One value per series, bottom first. */
  parts: number[];
  title?: string;
}

export interface StackedBarOpts {
  columns: StackedColumn[];
  series: string[];
  /**
   * The last series is a remainder ("3 other models"): drawn in the neutral
   * `s-other`, not a categorical colour, so it never reads as a sixth series.
   */
  other?: boolean;
  label: string;
  format?: (n: number) => string;
  emptyText?: string;
  /** viewBox size; see {@link WIDE_W}. */
  width?: number;
  height?: number;
}

/**
 * The colour class of series `i` of `n`. Named series cycle the six
 * categorical colours (`--c0` … `--c5`); a remainder -- "N others", "not
 * recorded", "unknown" -- is `s-other`, the neutral, never an alarm colour.
 */
function seriesClass(i: number, n: number, other: boolean | undefined): string {
  return other === true && i === n - 1 ? "s-other" : `s${i % 6}`;
}

function legend(names: string[], other?: boolean): string {
  return `<div class="legend">${names
    .map((n, i) => `<span><i class="sw ${seriesClass(i, names.length, other)}"></i>${esc(n)}</span>`)
    .join("")}</div>`;
}

export function stackedBar(opts: StackedBarOpts): string {
  const { columns, series, label, format = fmt0 } = opts;
  if (columns.length === 0) return empty(label, opts.emptyText ?? "no data yet");
  const totals = columns.map((c) => c.parts.reduce((a, b) => a + Math.max(0, b), 0));
  const max = Math.max(...totals);
  const scale = max > 0 ? max : 1;
  const W = opts.width ?? AREA_W;
  const H = opts.height ?? BAR_H;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const base = PAD_T + plotH;
  const slot = plotW / columns.length;
  const w = Math.max(1, slot * 0.72);

  // One tooltip per COLUMN, on an invisible hover column over the whole slot,
  // not one per segment: a segment is a slice of the column's story, and a
  // month of six-series columns repeated the same tip up to six times each. A
  // part of 0 draws no segment (it has no height) and is left out of the
  // default tip; a column whose parts are all 0 still gets its hover column, so
  // a genuine zero keeps a tooltip. A column with no parts is a gap: no mark.
  //
  // With no tooltip of their own, a series' segments are indistinguishable
  // marks, so each series is ONE path of rectangles (I3): 20-odd bytes a
  // segment instead of 60-odd for a rect.
  const segs = new Map<string, string[]>();
  const hits: Hit[] = [];
  columns.forEach((c, i) => {
    if (c.parts.length === 0) return;
    const bx = px(PAD_L + i * slot + (slot - w) / 2);
    const bw = px(w);
    const named = c.parts.flatMap((p, k) => (p > 0 ? [`${series[k] ?? k} ${format(p)}`] : []));
    const tip = esc(c.title ?? `${c.label}: ${named.length === 0 ? format(0) : named.join(", ")}`);
    let top = base;
    c.parts.forEach((p, k) => {
      const h = (plotH * Math.max(0, p)) / scale;
      top -= h;
      if (h <= 0) return;
      const cls = seriesClass(k, series.length, opts.other);
      const d = `M${bx} ${px(top)}h${bw}v${px(h)}h-${bw}z`;
      segs.set(cls, [...(segs.get(cls) ?? []), d]);
    });
    hits.push({ cx: PAD_L + (i + 0.5) * slot, w: slot, tip });
  });
  const paths = [...segs].map(([cls, d]) => `<path class="seg ${cls}" d="${d.join("")}"/>`).join("");

  const n = columns.length;
  const axis = [
    `<line class="axis" x1="${PAD_L}" y1="${px(base)}" x2="${W - PAD_R}" y2="${px(base)}"/>`,
    `<text class="tick" x="${PAD_L - 6}" y="${PAD_T + 4}" text-anchor="end">${esc(format(max))}</text>`,
    `<text class="tick" x="${PAD_L - 6}" y="${px(base)}" text-anchor="end">${esc(format(0))}</text>`,
    `<text class="tick" x="${PAD_L}" y="${H - 4}">${esc(columns[0].label)}</text>`,
    n > 1 ? `<text class="tick" x="${W - PAD_R}" y="${H - 4}" text-anchor="end">${esc(columns[n - 1].label)}</text>` : "",
  ].join("");

  return (
    `<figure class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">` +
    axis + paths + hitGroup(hits, PAD_T, plotH) +
    `</svg>${legend(series, opts.other)}<figcaption>${esc(label)}</figcaption></figure>`
  );
}

// ---------------------------------------------------------------------------
// donut
// ---------------------------------------------------------------------------

export interface Slice {
  label: string;
  value: number;
  /** A remainder or a non-answer ("N others", "not recorded", "unknown"): drawn neutral. */
  other?: boolean;
}

export interface DonutOpts {
  slices: Slice[];
  label: string;
  format?: (n: number) => string;
  emptyText?: string;
}

const DONUT_SIZE = 150;
const DONUT_STROKE = 22;
const DONUT_R = (DONUT_SIZE - DONUT_STROKE) / 2;
const DONUT_C = 2 * Math.PI * DONUT_R;

/** Shares of a whole. Non-positive slices are dropped; a zero total is empty, not a ring of nothing. */
export function donut(opts: DonutOpts): string {
  const { label, format = fmt0 } = opts;
  const slices = opts.slices.filter((s) => s.value > 0);
  const total = slices.reduce((a, s) => a + s.value, 0);
  if (total <= 0) return empty(label, opts.emptyText ?? "no data yet");

  const c = DONUT_SIZE / 2;
  // Named slices take the categorical colours in order; a remainder takes the
  // neutral and does not use up a colour.
  let named = 0;
  const cls = slices.map((s) => (s.other === true ? "s-other" : `s${named++ % 6}`));
  let offset = 0;
  const arcs = slices.map((s, i) => {
    const len = (DONUT_C * s.value) / total;
    const arc =
      `<circle class="seg ${cls[i]}" cx="${c}" cy="${c}" r="${num(DONUT_R, 2)}" fill="none" stroke-width="${DONUT_STROKE}"` +
      ` stroke-dasharray="${num(len, 2)} ${num(DONUT_C - len, 2)}" stroke-dashoffset="${num(-offset, 2)}"` +
      ` transform="rotate(-90 ${c} ${c})"><title>${esc(s.label)}: ${esc(format(s.value))}</title></circle>`;
    offset += len;
    return arc;
  });
  const rows = slices
    .map(
      (s, i) =>
        `<tr><td><i class="sw ${cls[i]}"></i>${esc(s.label)}</td><td class="num">${esc(format(s.value))}</td><td class="num">${num((100 * s.value) / total, 1)}%</td></tr>`,
    )
    .join("");
  return (
    `<figure class="chart donut"><svg viewBox="0 0 ${DONUT_SIZE} ${DONUT_SIZE}" width="${DONUT_SIZE}" height="${DONUT_SIZE}" role="img" aria-label="${esc(label)}">` +
    arcs.join("") +
    `</svg><table class="donut-key"><tbody>${rows}</tbody></table><figcaption>${esc(label)}</figcaption></figure>`
  );
}

// ---------------------------------------------------------------------------
// calendarHeatmap / hourWeekdayHeatmap
// ---------------------------------------------------------------------------

export interface CalendarDay {
  /** YYYY-MM-DD. */
  day: string;
  /** Null is NO READING, drawn distinctly from a day of zero. */
  value: number | null;
  title?: string;
}

export interface CalendarHeatmapOpts {
  /** Consecutive days, oldest first. */
  days: CalendarDay[];
  label: string;
  emptyText?: string;
}

const CELL = 12;
const GAP = 2;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Weekday of a YYYY-MM-DD, 0 = Sunday. UTC arithmetic on a date, so no zone can shift it. */
function weekday(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** One column per week, Sunday on top. */
export function calendarHeatmap(opts: CalendarHeatmapOpts): string {
  const { days, label } = opts;
  if (days.length === 0) return empty(label, opts.emptyText ?? "no days recorded yet");
  const known = days.flatMap((d) => (d.value === null ? [] : [d.value]));
  const max = known.length === 0 ? 0 : Math.max(...known);
  const lead = weekday(days[0].day);
  const left = 18;
  const top = 14;
  const weeks = Math.ceil((lead + days.length) / 7);
  const w = left + weeks * (CELL + GAP);
  const h = top + 7 * (CELL + GAP);

  const cells: string[] = [];
  const months: string[] = [];
  days.forEach((d, i) => {
    const slot = lead + i;
    const col = Math.floor(slot / 7);
    const row = slot % 7;
    const cx = left + col * (CELL + GAP);
    const cy = top + row * (CELL + GAP);
    const cls = d.value === null ? "cal-absent" : `l${level(d.value, max)}`;
    const tip = d.title ?? `${d.day}: ${d.value === null ? "no reading" : num(d.value, 2)}`;
    cells.push(`<rect class="cell ${cls}" x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" rx="2"><title>${esc(tip)}</title></rect>`);
    if (i === 0 || d.day.endsWith("-01")) {
      months.push(`<text class="tick" x="${cx}" y="${top - 4}">${MONTHS[Number(d.day.slice(5, 7)) - 1]}</text>`);
    }
  });
  const dayLabels = [1, 3, 5]
    .map((r) => `<text class="tick" x="0" y="${top + r * (CELL + GAP) + CELL - 2}">${"SMTWTFS"[r]}</text>`)
    .join("");

  return (
    `<figure class="chart heat"><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">` +
    months.join("") + dayLabels + cells.join("") +
    `</svg><figcaption>${esc(label)}</figcaption></figure>`
  );
}

export interface HourWeekdayOpts {
  /** `grid[weekday 0=Sun][hour 0..23]`. */
  grid: number[][];
  label: string;
  /** What a cell counts, for the tooltip: "prompts". */
  unit: string;
  emptyText?: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function hourWeekdayHeatmap(opts: HourWeekdayOpts): string {
  const { grid, label, unit } = opts;
  const all = grid.flat();
  // Every cell at zero means nothing was recorded, not a week of perfect rest.
  if (all.length === 0 || all.every((v) => v <= 0)) return empty(label, opts.emptyText ?? `no ${unit} recorded yet`);
  const max = Math.max(...all);
  const cw = 20;
  const ch = 14;
  const left = 32;
  const top = 14;
  const w = left + 24 * (cw + GAP);
  const h = top + 7 * (ch + GAP);

  // Every hour with activity is its own mark with its own tooltip. The hours
  // with none are ONE mark -- a single path of every empty cell, tipped
  // "0 prompts" -- rather than up to 168 rects each saying so: the report
  // carries this chart once per range, and most of a week is empty.
  const cells: string[] = [];
  const zero: string[] = [];
  grid.forEach((row, wd) =>
    row.forEach((v, hr) => {
      const x = left + hr * (cw + GAP);
      const y = top + wd * (ch + GAP);
      if (v <= 0) {
        zero.push(`M${x} ${y}h${cw}v${ch}h-${cw}z`);
        return;
      }
      const tip = esc(`${WEEKDAYS[wd]} ${String(hr).padStart(2, "0")}:00: ${v} ${unit}`);
      cells.push(
        `<rect class="cell l${level(v, max)}" x="${x}" y="${y}" width="${cw}" height="${ch}" rx="2">` +
          `<title>${tip}</title></rect>`,
      );
    }),
  );
  if (zero.length > 0) {
    const tip = esc(`0 ${unit}`);
    cells.unshift(`<path class="cell l0" d="${zero.join("")}"><title>${tip}</title></path>`);
  }
  const hours = [0, 3, 6, 9, 12, 15, 18, 21]
    .map((hr) => `<text class="tick" x="${left + hr * (cw + GAP)}" y="${top - 4}">${String(hr).padStart(2, "0")}</text>`)
    .join("");
  const rows = WEEKDAYS.map(
    (d, wd) => `<text class="tick" x="0" y="${top + wd * (ch + GAP) + ch - 3}">${d}</text>`,
  ).join("");

  return (
    `<figure class="chart heat"><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(label)}">` +
    hours + rows + cells.join("") +
    `</svg><figcaption>${esc(label)}</figcaption></figure>`
  );
}

// ---------------------------------------------------------------------------
// rangePills
// ---------------------------------------------------------------------------

const RANGE_TEXT: Record<Range, string> = { "7d": "7d", "30d": "30d", "90d": "90d", all: "All" };

/**
 * The `7d · 30d · 90d · All` row (spec §4.5).
 *
 * `link`: served pages. Each pill is a plain link to `href(r)`, rendered on the
 * server; the active one is marked `aria-current`. `toggle`: the report, a file
 * with no server behind it. Each pill is a button the client script flips
 * (`data-range-to`), showing the matching `[data-range]` block inside the
 * nearest `[data-ranges]` and hiding the rest; `href` is unused.
 *
 * Every label and value is one of four known literals, so nothing from a query
 * string can reach this markup.
 */
export function rangePills(active: Range, mode: "link" | "toggle", href: (r: Range) => string): string {
  if (mode === "link") {
    const links = RANGES.map((r) =>
      `<a class="rp" href="${esc(href(r))}"${r === active ? ' aria-current="true"' : ""}>${RANGE_TEXT[r]}</a>`,
    ).join("");
    return `<nav class="ranges" aria-label="Range">${links}</nav>`;
  }
  const buttons = RANGES.map((r) =>
    `<button type="button" class="rp" data-range-to="${r}" aria-pressed="${r === active}">${RANGE_TEXT[r]}</button>`,
  ).join("");
  return `<div class="ranges" role="group" aria-label="Range">${buttons}</div>`;
}

// ---------------------------------------------------------------------------
// sortableTable
// ---------------------------------------------------------------------------

export interface SortColumn {
  key: string;
  label: string;
  /** Right-aligned, tabular figures. */
  num?: boolean;
}

export interface SortCell {
  /** The cell's content, already rendered and escaped by the caller. */
  html: string;
  /**
   * What the column sorts by. Null is NO VALUE: it is written `data-sort=""`,
   * which the client sorts last in both directions -- never as a 0. A number
   * that is not finite is the same.
   */
  sort: number | string | null;
}

function sortAttr(v: number | string | null): string {
  if (v === null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return esc(v);
}

/**
 * A table whose headers sort it in the page (spec §7). Each cell carries its
 * sort value in `data-sort`, so the client never parses display text ("1.2k",
 * "$3.00", "—"). No rows is a named empty state, not an empty table.
 */
export function sortableTable(
  cols: SortColumn[],
  rows: { cells: Record<string, SortCell> }[],
  opts?: { empty: string },
): string {
  if (rows.length === 0) {
    return `<div class="chart-empty"><div class="empty-msg">${esc(opts?.empty ?? "nothing to show")}</div></div>`;
  }
  // A column whose sort values are text is marked `data-text`, so the client
  // compares it as text even where a value looks like a number (M2). The
  // label is a button: sortable from the keyboard (M3).
  const text = (key: string) => rows.some((r) => typeof r.cells[key]?.sort === "string");
  const head = cols
    .map((c) => `<th${c.num ? ' class="num"' : ""}${text(c.key) ? " data-text" : ""} scope="col"><button type="button" class="th-sort">${esc(c.label)}</button></th>`)
    .join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${cols
          .map((c) => {
            const cell = r.cells[c.key];
            return `<td${c.num ? ' class="num"' : ""} data-sort="${cell === undefined ? "" : sortAttr(cell.sort)}">${cell?.html ?? ""}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="scroll"><table class="sortable"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
