/**
 * The Performance view (spec 4B §5): what the requests cost at API prices and
 * how long they took, by model, over the range. Six cards, in the spec's
 * order: cost by model, response time by model, the wait per turn, the
 * cache-write mix, what was not priced, and the prices used; then one card of
 * definitions. The definitions and the prices are the same in every range, so
 * the report carries each once rather than once per range (report.ts): the
 * ranged cards hold figures and a caption, not paragraphs.
 *
 * Labels, sorting and formatting only. Every cost arrives summed from the
 * rollup's stored per-request costs, every median and p90 from
 * `lib/read/perf.ts`'s order statistics, and every rate from `claude_prices`:
 * nothing here multiplies by a price.
 *
 * Pure: `serve` and `report` both render through here.
 */
import { sumApiCosts, type ModelPerf, type PerformanceData } from "../read/perf.ts";
import { rangeLabel, type Range } from "../read/range.ts";
import { donut, sortableTable, type SortCell } from "./charts.ts";
import { API_PRICES, CC_FIGURE, NO_READING, NOT_PRICED, apiCostCell, apiCostHtml, usd } from "./cost.ts";
import { compact, esc, grouped, localZone, millis, num, stamp, zoneNote } from "./html.ts";
import { card, viewPage, type View } from "./layout.ts";

/** "in the last 7 days" / "on record": for empty states. */
const within = (r: Range) => (r === "all" ? "on record" : `in the ${rangeLabel(r)}`);

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const absent = (text: string, title?: string) =>
  `<span class="absent"${title === undefined ? "" : ` title="${esc(title)}"`}>${esc(text)}</span>`;

function empty(text: string): string {
  return `<div class="chart-empty"><div class="empty-msg">${esc(text)}</div></div>`;
}

/** Requests in range for a model: priced and not, never `<synthetic>`. */
const requestsOf = (m: ModelPerf) => m.cost.priced + m.cost.unpriced;

/** A measured span, or "no reading" sorting last. */
function msCell(ms: number | null): SortCell {
  return ms === null ? { html: absent(NO_READING, "no timed request"), sort: null } : { html: millis(ms), sort: Math.round(ms) };
}

// ---------------------------------------------------------------------------
// 1. Cost by model.
// ---------------------------------------------------------------------------

const COST_COLUMNS = [
  { key: "model", label: "model" },
  { key: "requests", label: "requests", num: true },
  { key: "cost", label: API_PRICES, num: true },
  { key: "share", label: "share", num: true },
];

function costCard(d: PerformanceData): string {
  const title = `Cost by model · ${API_PRICES} · ${rangeLabel(d.range)}`;
  if (d.models.length === 0) {
    return card({ title, hero: true, wide: true, body: empty(`${NO_READING}: no request ${within(d.range)}`) });
  }
  const total = sumApiCosts(d.models.map((m) => m.cost));
  const rows = d.models.map((m) => ({
    cells: {
      model: { html: esc(m.model), sort: m.model },
      requests: { html: grouped(requestsOf(m)), sort: requestsOf(m) },
      cost: apiCostCell(m.cost),
      share:
        m.share === null
          ? { html: absent("—", "nothing priced"), sort: null }
          : // A real share too small for one decimal is "<0.1%", never a 0.0% that reads as none.
            { html: m.share > 0 && m.share < 0.0005 ? "&lt;0.1%" : `${num(100 * m.share, 1)}%`, sort: Math.round(m.share * 1e6) / 1e6 },
    } satisfies Record<string, SortCell>,
  }));
  return card({
    title,
    hero: true,
    wide: true,
    body: `<div class="block">${kv(`total · ${API_PRICES}`, `<b>${apiCostHtml(total)}</b>`)}</div>` + sortableTable(COST_COLUMNS, rows),
  });
}

// ---------------------------------------------------------------------------
// 2. Response time by model.
// ---------------------------------------------------------------------------

const RESPONSE_COLUMNS = [
  { key: "model", label: "model" },
  { key: "n", label: "requests timed", num: true },
  { key: "median", label: "median", num: true },
  { key: "p90", label: "p90", num: true },
  { key: "tps", label: "tok/s", num: true },
];

function responseCard(d: PerformanceData): string {
  const title = `Response time by model · ${rangeLabel(d.range)}`;
  const note = `<p class="note">Response time is end to end, includes time to first token.</p>`;
  const timed = d.models.filter((m) => m.response.n > 0);
  if (timed.length === 0) {
    return card({ title, wide: true, body: empty(`${NO_READING}: no timed request ${within(d.range)}`) + note });
  }
  const rows = d.models.map((m) => ({
    cells: {
      model: { html: esc(m.model), sort: m.model },
      n: { html: grouped(m.response.n), sort: m.response.n },
      median: msCell(m.response.median),
      p90: msCell(m.response.p90),
      tps:
        m.tokPerSMedian === null
          ? { html: absent(NO_READING, "no timed request with output"), sort: null }
          : { html: num(m.tokPerSMedian, 1), sort: Math.round(m.tokPerSMedian * 100) / 100 },
    } satisfies Record<string, SortCell>,
  }));
  return card({ title, wide: true, body: sortableTable(RESPONSE_COLUMNS, rows) + note });
}

// ---------------------------------------------------------------------------
// 3. Wait per turn.
// ---------------------------------------------------------------------------

function waitCard(d: PerformanceData): string {
  const t = d.turns;
  const figure = (ms: number | null) => (ms === null ? `<b class="absent">${NO_READING}</b>` : `<b>${millis(ms)}</b>`);
  const counts =
    `${grouped(t.measured)} measured · ${grouped(t.human)} human · ${grouped(t.headless)} headless`;
  return card({
    title: `Wait per turn · ${rangeLabel(d.range)}`,
    body:
      `<div class="block">` +
      kv(t.n === 0 ? "median · no measured turn" : `median of ${grouped(t.n)}`, figure(t.median)) +
      kv("p90", figure(t.p90)) +
      kv("turns", `<b>${esc(counts)}</b>`) +
      `</div>`,
  });
}

// ---------------------------------------------------------------------------
// 4. The cache-write mix.
// ---------------------------------------------------------------------------

function cacheCard(d: PerformanceData): string {
  const c = d.cacheMix;
  const cost = (n: number | null) => (n === null ? NOT_PRICED : usd(n));
  return card({
    title: `Cache writes · 5-minute vs 1-hour · ${rangeLabel(d.range)}`,
    body:
      donut({
        slices: [
          { label: `5-minute writes · ${cost(c.cost5m)}`, value: c.tokens5m },
          { label: `1-hour writes · ${cost(c.cost1h)}`, value: c.tokens1h },
        ],
        label: `cache-write tokens by lifetime, with their cost ${API_PRICES}`,
        format: (n) => `${compact(n)} tokens`,
        emptyText: `${NO_READING}: no split cache write ${within(d.range)}`,
      }),
  });
}

// ---------------------------------------------------------------------------
// 5. Not priced.
// ---------------------------------------------------------------------------

function notPricedCard(d: PerformanceData): string {
  const title = `Not priced · ${rangeLabel(d.range)}`;
  const speed =
    d.speedAbsentPriced > 0
      ? `<p class="note">${grouped(d.speedAbsentPriced)} priced at standard with no speed recorded: counted in the cost above, at standard rates.</p>`
      : "";
  if (d.models.length === 0) return card({ title, body: empty(`${NO_READING}: no request ${within(d.range)}`) });
  if (d.unpriced.length === 0) {
    return card({ title, body: `<p class="note">Every request ${within(d.range)} had a price.</p>` + speed });
  }
  const trs = d.unpriced
    .map((u) => `<tr><td>${esc(u.note)}</td><td>${esc(u.model)}</td><td class="num">${grouped(u.n)}</td></tr>`)
    .join("");
  return card({
    title,
    body:
      `<div class="scroll"><table><thead><tr><th>note</th><th>model</th><th class="num">requests</th></tr></thead><tbody>${trs}</tbody></table></div>` +
      speed,
  });
}

// ---------------------------------------------------------------------------
// 6. Prices used.
// ---------------------------------------------------------------------------

/**
 * A price row's source: a link when served. The report is a file that names
 * no address outside itself (sources-report.test.ts), so there the source is
 * text, without its scheme.
 */
function source(url: string, served: boolean): string {
  const text = esc(url.replace(/^[a-z]+:\/\//i, ""));
  return served ? `<a href="${esc(url)}" rel="noreferrer">${text}</a>` : `<span class="sid">${text}</span>`;
}

function pricesCard(d: PerformanceData, served: boolean): string {
  const title = "Prices used";
  if (d.prices.length === 0) return card({ title, wide: true, body: empty(`${NO_READING}: claude_prices is empty`) });
  // One verified date and source for every row is the usual case: said once
  // under the table rather than repeated on each row.
  const shared = d.prices.every((p) => p.verifiedOn === d.prices[0].verifiedOn && p.source === d.prices[0].source);
  const rate = (n: number) => `<td class="num">${esc(usd(n))}</td>`;
  const trs = d.prices
    .map(
      (p) =>
        `<tr><td>${esc(p.model)}</td><td>${esc(p.speed)}</td><td>${esc(p.effectiveFrom)}</td>` +
        rate(p.input) + rate(p.output) + rate(p.cacheRead) + rate(p.cacheWrite5m) + rate(p.cacheWrite1h) +
        (shared ? "" : `<td>${esc(p.verifiedOn)}</td><td>${source(p.source, served)}</td>`) +
        `</tr>`,
    )
    .join("");
  return card({
    title,
    wide: true,
    body:
      `<div class="scroll"><table><thead><tr><th>model</th><th>speed</th><th>from</th>` +
      `<th class="num">input</th><th class="num">output</th><th class="num">cache read</th>` +
      `<th class="num">5-minute write</th><th class="num">1-hour write</th>${shared ? "" : "<th>verified</th><th>source</th>"}</tr></thead>` +
      `<tbody>${trs}</tbody></table></div>` +
      `<p class="note">USD per million tokens, as the rollup holds them in claude_prices` +
      `${shared ? `, verified ${esc(d.prices[0].verifiedOn)} against ${source(d.prices[0].source, served)}` : ""}. ` +
      `A request is priced by its model's row with the latest start on or before its day, so a price change never reprices history.</p>`,
  });
}

/** The definitions behind every card above: the same in every range. */
function aboutCard(): string {
  const dl = (term: string, text: string) => `<dt>${esc(term)}</dt><dd>${esc(text)}</dd>`;
  return card({
    title: "How these are measured",
    wide: true,
    body:
      `<dl class="kv">` +
      dl(
        API_PRICES,
        "The rollup's price of each request at Anthropic's API rates, from the prices below, summed per model. Share is of the priced total. " +
          `${CC_FIGURE}, the status line's running total, is per session and can't be split by model; History, Projects and Sessions show it beside this one.`,
      ) +
      dl(
        "not priced",
        "A request with no price is left out of every cost and counted beside it, never as $0: unknown-model has no price row, " +
          "no-price-yet has a price row, but no price on or before that day, " +
          "fast ran in fast mode, which has none, and no-split wrote cache with no 5-minute / 1-hour split.",
      ) +
      dl(
        "response time",
        "End to end, from the prompt or tool result that sent the request to its last transcript entry: time to first token and hook time " +
          "before the send are in it, as transcripts can't separate them. Median and p90 (nearest rank) over the timed requests; tok/s is the median output rate.",
      ) +
      dl(
        "wait per turn",
        "From a prompt or command to its turn's last response. Only measured turns are timed: a human turn asked you something " +
          "(AskUserQuestion, ExitPlanMode), so its wait includes yours, and a headless one ran from the SDK.",
      ) +
      dl("cache writes", "Tokens from the requests that recorded the split; their cost is over priced requests only.") +
      `</dl>`,
  });
}

export function performanceSections(d: PerformanceData, served = false): string[] {
  return [
    costCard(d), responseCard(d), `<div class="g g-2">`, waitCard(d), cacheCard(d), `</div>`, notPricedCard(d), pricesCard(d, served), aboutCard(),
  ];
}

export function performanceView(d: PerformanceData, opts: { tz?: string; served?: boolean } = {}): View {
  const tz = opts.tz ?? localZone();
  const sections = performanceSections(d, opts.served === true);
  return {
    href: "/performance",
    title: "Performance",
    body: sections.join(""),
    sections,
    footer:
      `generated ${stamp(d.generatedAt, tz)} · days are local, ${zoneNote(tz, d.generatedAt)}, as the rollup buckets them · ` +
      `from claude_request_metrics, claude_turns and claude_prices · rollup ${d.lastRollup === null ? "never" : stamp(d.lastRollup, tz)}`,
  };
}

export function renderPerformancePage(d: PerformanceData, opts: { tz?: string; served?: boolean } = {}): string {
  return viewPage(performanceView(d, opts));
}
