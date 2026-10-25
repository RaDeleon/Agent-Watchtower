/**
 * Chart marks, read the same whatever their encoding (Stage 4B fix round, I3).
 *
 * The report's per-week density guard (report-budget.test.ts) pins the compact
 * encoding. Every other test reads what a chart SAYS -- how many hover
 * columns, which coordinates, which series -- through these helpers, so that
 * reverting the encoding reds the density guard and nothing else.
 */

/**
 * A chart's hover columns: a `<rect class="hit">` apiece, or a titled stroke
 * inside a `<g class="hits">` group (charts.ts `hitGroup`).
 */
export function hitCount(html: string): number {
  const rects = (html.match(/<rect class="hit"/g) ?? []).length;
  const strokes = [...html.matchAll(/<g class="hits"[^>]*>([^]*?)<\/g>/g)]
    .reduce((n, m) => n + (m[1].match(/<title>/g) ?? []).length, 0);
  return rects + strokes;
}

/** Coordinates with or without a trailing ".0": "M48.0 158.0" reads as "M48 158". */
export function whole(svg: string): string {
  return svg.replace(/(\d)\.0(?![\d])/g, "$1");
}

/** A stacked bar's segment of series class `cls` (e.g. "s-other"), as a rect or a path. */
export function hasSeg(html: string, cls: string): boolean {
  return new RegExp(`<(?:rect|path) class="seg ${cls}"`).test(html);
}
