/**
 * The cost labels: the ONLY place their words and states are decided.
 *
 * Every page shows two cost figures side by side (spec 4B §2 decision 1), and
 * names them the same way everywhere:
 *
 *  - {@link API_PRICES}: the rollup's cost of the requests at Anthropic's API
 *    rates (`claude_request_metrics`, the rollups' `cost_table_usd`);
 *  - {@link CC_FIGURE}: the status line's `total_cost_usd`, which Claude Code
 *    reports per session.
 *
 * Three states are never a dollar figure (spec §5): no reading at all, a cost
 * where nothing was priced, and -- shown beside the priced sum -- the count
 * that was not priced. None of them ever renders `$0.00`.
 *
 * Formatting only: every amount arrives summed from stored values. No rate
 * appears here, or anywhere under lib/.
 */
import type { ApiCost } from "../read/perf.ts";
import type { SortCell } from "./charts.ts";
import { esc } from "./html.ts";

export type { ApiCost } from "../read/perf.ts";

export const API_PRICES = "at API prices";
export const CC_FIGURE = "Claude Code's figure";

/** No measurement: nothing to price, or no status-line reading. */
export const NO_READING = "no reading";
/** Requests with no price: an unknown model, a model with no price yet on its day, fast mode, or no cache-write split. */
export const NOT_PRICED = "not priced";

/** $1,234.57: grouped dollars, two decimals. A positive amount under half a cent is "<$0.01", never $0.00. */
export function usd(n: number): string {
  if (n > 0 && n < 0.005) return "<$0.01";
  const [whole, cents] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

/** An axis tick: `usd`, except that the axis floor is "$0", a position rather than a reading. */
export function usdTick(n: number): string {
  return n === 0 ? "$0" : usd(n);
}

/**
 * A cost at API prices in words:
 *
 *  - null, or nothing priced and nothing unpriced -> "no reading";
 *  - nothing priced -> "not priced";
 *  - some not priced -> "$1.23 · 4 not priced";
 *  - otherwise the priced sum, with 0 < usd < 0.005 as "<$0.01".
 *
 * Never "$0.00" for the first two.
 */
export function apiCostLabel(c: ApiCost | null): string {
  if (c === null || c.priced + c.unpriced === 0) return NO_READING;
  if (c.priced === 0) return NOT_PRICED;
  return c.unpriced > 0 ? `${usd(c.usd)} · ${c.unpriced} ${NOT_PRICED}` : usd(c.usd);
}

/** Claude Code's figure in words: null is "no reading". */
export function claudeCodeCostLabel(n: number | null): string {
  return n === null ? NO_READING : usd(n);
}

/** Whether a cost at API prices is a dollar figure, rather than one of the two absent states. */
export function hasApiCost(c: ApiCost | null): c is ApiCost {
  return c !== null && c.priced > 0;
}

/** {@link apiCostLabel} as HTML: escaped text, and an absent state in the absent style. */
export function apiCostHtml(c: ApiCost | null): string {
  const text = esc(apiCostLabel(c));
  return hasApiCost(c) ? text : `<span class="absent">${text}</span>`;
}

/** {@link apiCostLabel} as a key-value figure: `<b>`, or `<b class="absent">` for an absent state. */
export function apiCostBold(c: ApiCost | null): string {
  return `<b${hasApiCost(c) ? "" : ` class="absent"`}>${esc(apiCostLabel(c))}</b>`;
}

/** {@link claudeCodeCostLabel} as HTML: escaped text, and "no reading" in the absent style. */
export function claudeCodeCostHtml(n: number | null): string {
  const text = esc(claudeCodeCostLabel(n));
  return n === null ? `<span class="absent">${text}</span>` : text;
}

/** {@link claudeCodeCostLabel} as a key-value figure: `<b>`, or `<b class="absent">` for no reading. */
export function claudeCodeCostBold(n: number | null): string {
  return `<b${n === null ? ` class="absent"` : ""}>${esc(claudeCodeCostLabel(n))}</b>`;
}

/** A table cell: the label, sorting by the priced sum; an absent state has no sort value, so it sorts last. */
export function apiCostCell(c: ApiCost | null): SortCell {
  return { html: apiCostHtml(c), sort: hasApiCost(c) ? Math.round(c.usd * 1e4) / 1e4 : null };
}

/** A table cell for Claude Code's figure; "no reading" sorts last. */
export function claudeCodeCostCell(n: number | null): SortCell {
  return { html: claudeCodeCostHtml(n), sort: n === null ? null : Math.round(n * 1e4) / 1e4 };
}

/** Hermes's own cost figure (spec decision 4): beside "at API prices", never inside it. */
export const HERMES_FIGURE = "Hermes's figure";
/** Hermes recorded no cost for these requests: neither an actual nor an estimate. */
export const HERMES_UNPRICED = "Hermes didn't price this";

/**
 * Hermes's figure in words, over `ApiCost`'s shape: `usd` is the sum of what
 * Hermes priced, `priced`/`unpriced` count the rows it did and did not price.
 * A genuine $0.00 is a reading here -- Hermes priced a free model at $0 -- but
 * "nothing priced" is never $0.
 */
export function hermesCostLabel(c: ApiCost | null): string {
  if (c === null || c.priced + c.unpriced === 0) return NO_READING;
  if (c.priced === 0) return HERMES_UNPRICED;
  return c.unpriced > 0 ? `${usd(c.usd)} · ${c.unpriced} unpriced by Hermes` : usd(c.usd);
}

export function hermesCostHtml(c: ApiCost | null): string {
  const text = esc(hermesCostLabel(c));
  return hasApiCost(c) ? text : `<span class="absent">${text}</span>`;
}

export function hermesCostBold(c: ApiCost | null): string {
  return `<b${hasApiCost(c) ? "" : ` class="absent"`}>${esc(hermesCostLabel(c))}</b>`;
}

export function hermesCostCell(c: ApiCost | null): SortCell {
  return { html: hermesCostHtml(c), sort: hasApiCost(c) ? Math.round(c.usd * 1e4) / 1e4 : null };
}
