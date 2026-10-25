/**
 * The Models & Skills view, as cards. The hero is the time series (requests,
 * output tokens and cost per day, one metric at a time); then the request- and
 * output-share donuts, the model table, the effort mix, the cache hit rate, the
 * model mix over time and the fresh / cache / total framing -- all of them
 * cover `d.range`. The main-thread split, the API errors and the skill / MCP /
 * plugin leaderboards are lifetime, and their headings say so.
 *
 * Claude-specific, and it says so: every figure is `claude_requests`, except
 * the time series' cost, which is the rollup's stored daily `cost_usd`
 * (Claude Code's figure), and the model table's cost at API prices, response
 * time and tok/s, which are the rollup's `claude_request_metrics`.
 *
 * Pure: `serve` and `report` both render through here.
 */
import type { Leaderboard, SkillsData, TokenTotals } from "../read/skills.ts";
import { bucketName, buckets, rangeLabel, sumOf, type Range } from "../read/range.ts";
import { WIDE_W, areaChart, donut, sortableTable, stackedBar, type Slice, type SortCell } from "./charts.ts";
import { API_PRICES, CC_FIGURE, NO_READING, apiCostCell, usd, usdTick } from "./cost.ts";
import { clock, compact, dateIn, esc, grouped, localZone, millis, num, stamp, zoneNote } from "./html.ts";
import { card, viewPage, type View } from "./layout.ts";

/** Named models in the donuts and the mix; the rest fold into one neutral "other" slice. */
const MIX_SERIES = 5;

const ABSENT = `<span class="absent">—</span>`;
const pct = (n: number | null) => (n === null ? `<span class="absent">no reading</span>` : `${num(n, 1)}%`);

/** "in the last 7 days" / "on record": for empty states. */
const within = (r: Range) => (r === "all" ? "on record" : `in the ${rangeLabel(r)}`);

function tile(value: string, label: string): string {
  return `<div class="tile"><div class="value">${value}</div><div class="label">${esc(label)}</div></div>`;
}

function empty(text: string): string {
  return `<div class="chart-empty"><div class="empty-msg">${esc(text)}</div></div>`;
}

function stat(big: string, label: string): string {
  return `<div class="stat">${big}<div class="muted label">${esc(label)}</div></div>`;
}

// ---------------------------------------------------------------------------
// The hero: the time series, with a metric toggle.
// ---------------------------------------------------------------------------

const METRICS = [
  { key: "requests", label: "Requests" },
  { key: "tokens", label: "Tokens" },
  { key: "cost", label: "Cost" },
] as const;

/**
 * Three charts rendered side by side, one shown: the client flips them with the
 * same toggle protocol as the report's ranges (`data-metric-to` inside
 * `data-metrics`). Every bucket with a reading has a tooltip; a day with no
 * row is a gap in the line and has none.
 */
function seriesCard(d: SkillsData): string {
  const s = d.series;
  const costDays = s.filter((x) => x.costUsd !== null);
  const cost = costDays.reduce((a, x) => a + (x.costUsd as number), 0);
  const title = `Requests, tokens and cost per ${buckets(s.map((x) => x.day)).weekly ? "week" : "day"} · ${rangeLabel(d.range)}`;
  if (d.recent.requests === 0 && costDays.length === 0) {
    return card({
      title,
      hero: true,
      wide: true,
      body: `<div class="big absent">—</div><div class="muted label">no requests ${within(d.range)}</div>`,
    });
  }
  const stats =
    `<div class="stats">` +
    stat(
      d.recent.requests === 0
        ? `<div class="big absent">—</div>`
        : `<div class="big" data-count="${d.recent.requests}">${grouped(d.recent.requests)}</div>`,
      d.recent.requests === 0 ? `no requests ${within(d.range)}` : "requests",
    ) +
    stat(
      d.recent.requests === 0 ? `<div class="big absent">—</div>` : `<div class="big">${compact(d.recent.output)}</div>`,
      "output tokens",
    ) +
    stat(
      costDays.length === 0
        ? `<div class="big absent">—</div>`
        : `<div class="big" data-count="${num(cost, 2)}">${usd(cost)}</div>`,
      costDays.length === 0
        ? `no cost reading · ${CC_FIGURE}`
        : `cost · ${costDays.length} of ${s.length} ${s.length === 1 ? "day" : "days"} with a cost reading · ${CC_FIGURE}`,
    ) +
    `</div>`;

  // Past 90 days (`all`), one point a week: each a sum over the week's days
  // with a reading, a gap only where the whole week had none.
  const b = buckets(s.map((x) => x.day));
  const byDay = new Map(s.map((x) => [x.day, x]));
  const per = b.weekly ? "week" : "day";
  const pts = b.buckets.map((k) => {
    const xs = k.days.flatMap((day) => byDay.get(day) ?? []);
    return {
      label: k.label,
      name: bucketName(k),
      requests: sumOf(xs.map((x) => x.requests)),
      tokensOut: sumOf(xs.map((x) => x.tokensOut)),
      costUsd: sumOf(xs.map((x) => x.costUsd)),
    };
  });
  const wide = { width: WIDE_W, height: 220 };
  const charts: Record<(typeof METRICS)[number]["key"], string> = {
    requests: areaChart({
      points: pts.map((x) => ({
        label: x.label,
        value: x.requests,
        title: x.requests === null ? undefined : `${x.name}: ${grouped(x.requests)} ${x.requests === 1 ? "request" : "requests"}`,
      })),
      label: `requests per ${per} · a gap is a ${per} with no request`,
      format: grouped,
      emptyText: `no requests ${within(d.range)}`,
      ...wide,
    }),
    tokens: areaChart({
      points: pts.map((x) => ({
        label: x.label,
        value: x.tokensOut,
        title: x.tokensOut === null ? undefined : `${x.name}: ${grouped(x.tokensOut)} output tokens`,
      })),
      label: `output tokens per ${per} · a gap is a ${per} with no request`,
      format: compact,
      emptyText: `no requests ${within(d.range)}`,
      ...wide,
    }),
    cost: areaChart({
      points: pts.map((x) => ({
        label: x.label,
        value: x.costUsd,
        title: x.costUsd === null ? undefined : `${x.name}: ${usd(x.costUsd)}`,
      })),
      label: b.weekly
        ? `cost per week, ${CC_FIGURE}, the sum of the days with a status-line cost reading · a gap is a week with none, not $0`
        : `cost per day, ${CC_FIGURE}, as the rollup stored it · a gap is a day with no status-line cost reading, not $0`,
      format: usdTick,
      emptyText: `no cost readings ${within(d.range)}`,
      ...wide,
    }),
  };
  const toggles =
    `<div class="ranges metric-pills" role="group" aria-label="Metric">` +
    METRICS.map(
      (m, i) => `<button type="button" class="rp" data-metric-to="${m.key}" aria-pressed="${i === 0}">${m.label}</button>`,
    ).join("") +
    `</div>`;
  const blocks = METRICS.map(
    (m, i) => `<div data-metric="${m.key}"${i === 0 ? "" : " hidden"}>${charts[m.key]}</div>`,
  ).join("");
  return card({
    title,
    hero: true,
    wide: true,
    body: stats + `<div class="metrics" data-metrics>${toggles}${blocks}</div>`,
  });
}

// ---------------------------------------------------------------------------
// Models: share donuts, the table, the mix.
// ---------------------------------------------------------------------------

/**
 * Not a model: `(unknown)` is a request that named none, and `<synthetic>` is
 * the message Claude Code writes for a failed call or a notice. Both are drawn
 * neutral, never in a model's colour.
 */
const notAModel = (m: string) => m === "(unknown)" || m === "<synthetic>";

/** The top models by name, the rest as one neutral remainder. A non-model is drawn neutral too. */
function modelSlices(rows: { model: string; value: number }[]): Slice[] {
  const named = rows.slice(0, MIX_SERIES);
  const rest = rows.slice(MIX_SERIES);
  const slices: Slice[] = named.map((m) => ({ label: m.model, value: m.value, other: notAModel(m.model) }));
  if (rest.length > 0) {
    slices.push({
      label: `${rest.length} other ${rest.length === 1 ? "model" : "models"}`,
      value: rest.reduce((a, m) => a + m.value, 0),
      other: true,
    });
  }
  return slices;
}

function requestShareCard(d: SkillsData): string {
  return card({
    title: `Request share · ${rangeLabel(d.range)}`,
    body: donut({
      slices: modelSlices(d.modelShare.map((m) => ({ model: m.model, value: m.requests }))),
      label: `requests by model since ${d.recentFrom}`,
      format: grouped,
      emptyText: `no requests ${within(d.range)}`,
    }),
  });
}

function outputShareCard(d: SkillsData): string {
  return card({
    title: `Output-token share · ${rangeLabel(d.range)}`,
    body: donut({
      // Ranked by output here, not by requests: this donut is about tokens.
      slices: modelSlices(
        [...d.modelShare]
          .sort((a, b) => b.tokensOut - a.tokensOut || a.model.localeCompare(b.model))
          .map((m) => ({ model: m.model, value: m.tokensOut })),
      ),
      label: `output tokens by model since ${d.recentFrom}`,
      format: compact,
      emptyText: `no output tokens ${within(d.range)}`,
    }),
  });
}

const MODEL_COLUMNS = [
  { key: "model", label: "model" },
  { key: "requests", label: "requests", num: true },
  { key: "share", label: "share", num: true },
  { key: "fresh", label: "in + out", num: true },
  { key: "out", label: "output", num: true },
  { key: "cache", label: "cache hit", num: true },
  { key: "api", label: API_PRICES, num: true },
  { key: "median", label: "response median", num: true },
  { key: "p90", label: "p90", num: true },
  { key: "tps", label: "tok/s", num: true },
];

/** A measured span, or "no reading" in the absent style, sorting last. */
function msCell(ms: number | null, n: number): SortCell {
  return ms === null
    ? { html: `<span class="absent" title="no timed request">${NO_READING}</span>`, sort: null }
    : { html: `<span title="over ${grouped(n)} timed ${n === 1 ? "request" : "requests"}">${millis(ms)}</span>`, sort: Math.round(ms) };
}

function modelTableCard(d: SkillsData): string {
  const total = d.modelTable.reduce((a, m) => a + m.requests, 0);
  const rows = d.modelTable.map((m) => ({
    cells: {
      model: { html: esc(m.model), sort: m.model },
      requests: { html: grouped(m.requests), sort: m.requests },
      share: { html: `${num((100 * m.requests) / total, 1)}%`, sort: m.requests },
      fresh: { html: compact(m.freshTokens), sort: m.freshTokens },
      out: { html: compact(m.tokensOut), sort: m.tokensOut },
      cache:
        m.cacheHitPct === null
          ? { html: `<span class="absent" title="no cache read or write">no reading</span>`, sort: null }
          : { html: `${num(m.cacheHitPct, 1)}%`, sort: Number(num(m.cacheHitPct, 2)) },
      api: apiCostCell(m.apiCost),
      median: msCell(m.response.median, m.response.n),
      p90: msCell(m.response.p90, m.response.n),
      tps:
        m.tokPerSMedian === null
          ? { html: `<span class="absent" title="no timed request">${NO_READING}</span>`, sort: null }
          : { html: num(m.tokPerSMedian, 1), sort: Number(num(m.tokPerSMedian, 2)) },
    } satisfies Record<string, SortCell>,
  }));
  return card({
    title: `Models · ${rangeLabel(d.range)}`,
    wide: true,
    body:
      sortableTable(MODEL_COLUMNS, rows, { empty: `no requests ${within(d.range)}` }) +
      `<p class="note">In + out is uncached input plus output. Cache hit is cache read ÷ (cache read + cache write), ` +
      `the rollup's formula and the same one as every cache figure on this page, with no reading for a model that never touched the cache. ` +
      `There is no error rate per model: Claude Code records a failed call as a &lt;synthetic&gt; message with no model, ` +
      `so an error cannot be tied to the model that failed. API errors have their own card.</p>` +
      `<p class="note">Cost ${esc(API_PRICES)}, "not priced" where none had a price. ${esc(`${CC_FIGURE} is per session and can't be split by model.`)} ` +
      `Response time is end to end, time to first token included; tok/s is its median output rate. Performance has the detail.</p>`,
  });
}

function mixCard(d: SkillsData): string {
  const named = d.models.slice(0, MIX_SERIES);
  const others = d.models.length - named.length;
  const series = [...named.map((m) => m.model), ...(others > 0 ? [`${others} other ${others === 1 ? "model" : "models"}`] : [])];
  const anyRequests = d.modelMix.some((x) => x.requests.some((n) => n > 0));
  // Past 90 days (`all`), one column a week: each model's requests summed.
  const b = buckets(d.modelMix.map((x) => x.day));
  const byDay = new Map(d.modelMix.map((x) => [x.day, x.requests]));
  return card({
    title: `Model mix · ${rangeLabel(d.range)}`,
    wide: true,
    body: stackedBar({
      columns: anyRequests
        ? b.buckets.map((k) => {
            const reqs = d.models.map((_, m) => k.days.reduce((a, day) => a + (byDay.get(day)?.[m] ?? 0), 0));
            const parts = reqs.slice(0, MIX_SERIES);
            if (others > 0) parts.push(reqs.slice(MIX_SERIES).reduce((a, n) => a + n, 0));
            if (!k.week) return { label: k.label, parts };
            const named = parts.flatMap((p, i) => (p > 0 ? [`${series[i]} ${grouped(p)}`] : []));
            return { label: k.label, parts, title: `${bucketName(k)}: ${named.length === 0 ? "0" : named.join(", ")}` };
          })
        : [],
      series,
      other: others > 0,
      label: `requests per ${b.weekly ? "week" : "day"} by model, since ${d.recentFrom}`,
      format: grouped,
      emptyText: `no requests ${within(d.range)}`,
      width: WIDE_W,
      height: 200,
    }),
  });
}

function effortCard(d: SkillsData): string {
  return card({
    title: `Effort mix · ${rangeLabel(d.range)}`,
    body: donut({
      slices: d.effort.map((e) => ({ label: e.effort ?? "not recorded", value: e.requests, other: e.effort === null })),
      label: `requests by effort level · "not recorded" is a request whose transcript named none`,
      format: grouped,
      emptyText: `no requests ${within(d.range)}`,
    }),
  });
}

// ---------------------------------------------------------------------------
// Tokens and cache.
// ---------------------------------------------------------------------------

function totalsRow(label: string, t: TokenTotals): string {
  return (
    `<tr><td>${esc(label)}</td><td class="num">${grouped(t.requests)}</td>` +
    `<td class="num">${compact(t.fresh)}</td><td class="num">${compact(t.cacheWrite)}</td>` +
    `<td class="num">${compact(t.cacheRead)}</td><td class="num">${compact(t.output)}</td>` +
    `<td class="num">${compact(t.total)}</td><td class="num">${pct(t.cacheHitPct)}</td></tr>`
  );
}

const TOTALS_HEAD =
  `<thead><tr><th></th><th class="num">requests</th><th class="num">fresh in</th><th class="num">cache write</th>` +
  `<th class="num">cache read</th><th class="num">output</th><th class="num">total</th><th class="num">cache hit</th></tr></thead>`;

/**
 * Where the tokens went, as one bar: fresh input, cache write, cache read and
 * output, each its share of the total. Widths only -- colours are the series
 * classes. No bar at all when there are no tokens.
 */
function compositionBar(t: TokenTotals, label: string): string {
  if (t.total <= 0) return "";
  const parts = [
    { name: "fresh in", v: t.fresh },
    { name: "cache write", v: t.cacheWrite },
    { name: "cache read", v: t.cacheRead },
    { name: "output", v: t.output },
  ];
  const segs = parts
    .map((p, i) => {
      const share = (100 * p.v) / t.total;
      const tip = esc(`${p.name}: ${compact(p.v)} · ${num(share, 1)}%`);
      return p.v <= 0 ? "" : `<i class="sw s${i}" style="width:${num(share, 2)}%" data-tip="${tip}" title="${tip}"></i>`;
    })
    .join("");
  const key = parts.map((p, i) => `<span><i class="sw s${i}"></i>${esc(p.name)}</span>`).join("");
  return `<div class="comp" role="img" aria-label="${esc(label)}">${segs}</div><div class="legend">${key}</div>`;
}

function tokensCard(d: SkillsData): string {
  const a = d.allTime;
  const share = a.total > 0 ? `${num((100 * a.cacheRead) / a.total, 1)}%` : null;
  const rows = totalsRow("all time", a) + (d.range === "all" ? "" : totalsRow(rangeLabel(d.range), d.recent));
  const shown = d.range === "all" ? a : d.recent;
  return card({
    title: "Fresh vs cache vs total",
    wide: true,
    body:
      compositionBar(shown, `token composition, ${rangeLabel(d.range)}`) +
      `<div class="scroll"><table class="totals">${TOTALS_HEAD}<tbody>${rows}</tbody></table></div>` +
      `<p class="note">"Total" counts every token column, and cache reads dominate it${share === null ? "" : ` (${share} all time)`}: ` +
      `they are re-reads of context already sent, billed at a fraction of fresh input. ` +
      `Fresh input and output are the work actually done. Cache hit here is cache read ÷ (cache read + cache write), the rollup's own formula; ` +
      `with no cache traffic there is no reading. The bar is the ${rangeLabel(d.range)}.</p>`,
  });
}

function cacheCard(d: SkillsData): string {
  const measured = d.cacheTrend.filter((c) => c.pct !== null).length;
  // Past 90 days (`all`), one point a week, by the rollup's own formula --
  // read / (read + write) -- over the week's summed cache tokens: not a mean of
  // daily percentages, which would weigh a quiet day like a busy one.
  const b = buckets(d.cacheTrend.map((c) => c.day));
  const byDay = new Map(d.cacheTrend.map((c) => [c.day, c]));
  const points = b.buckets.map((k) => {
    if (!k.week) {
      const c = byDay.get(k.label);
      const pct = c?.pct ?? null;
      return { label: k.label, value: pct, title: pct === null ? `${k.label}: no reading` : `${k.label}: ${num(pct, 1)}%` };
    }
    const r = k.days.reduce((a, day) => a + (byDay.get(day)?.read ?? 0), 0);
    const w = k.days.reduce((a, day) => a + (byDay.get(day)?.write ?? 0), 0);
    const pct = r + w > 0 ? (100 * r) / (r + w) : null;
    return { label: k.label, value: pct, title: pct === null ? `${bucketName(k)}: no reading` : `${bucketName(k)}: ${num(pct, 1)}%` };
  });
  return card({
    title: `Cache hit rate · ${rangeLabel(d.range)}`,
    body:
      `<div class="row">${tile(pct(d.recent.cacheHitPct), rangeLabel(d.range))}${d.range === "all" ? "" : tile(pct(d.allTime.cacheHitPct), "all time")}</div>` +
      areaChart({
        points,
        label: b.weekly
          ? `weekly cache hit %, cache read ÷ (read + write) over the week · ${measured} of ${d.cacheTrend.length} days measured; a week without cache traffic is a gap, not 0`
          : `daily cache hit %, as the rollup stored it · ${measured} of ${d.cacheTrend.length} days measured; a day without cache traffic is a gap, not 0`,
        fill: false,
        yMax: 100,
        format: (n) => `${num(n, 0)}%`,
        emptyText: `no cache readings ${within(d.range)}`,
      }),
  });
}

// ---------------------------------------------------------------------------
// Lifetime: main thread against subagents, API errors, leaderboards.
// ---------------------------------------------------------------------------

function sideCard(d: SkillsData): string {
  const m = d.mainThread;
  const s = d.subagents;
  const chart = donut({
    slices: [
      { label: "main thread", value: m.requests },
      { label: "subagents", value: s.requests },
    ],
    label: "requests, all time",
    format: grouped,
    emptyText: "no requests ingested yet",
  });
  return card({
    title: "Subagents vs main thread · all time",
    body: chart + `<div class="scroll"><table class="totals">${TOTALS_HEAD}<tbody>${totalsRow("main thread", m)}${totalsRow("subagents", s)}</tbody></table></div>`,
  });
}

function leaderCard(title: string, noun: string, lb: Leaderboard, total: number, opts: { detailHead?: string; wide?: boolean } = {}): string {
  const heading = `${title} · all time`;
  if (lb.rows.length === 0) return card({ title: heading, wide: opts.wide, body: empty(`no request attributed to a ${noun} yet`) });
  const { detailHead } = opts;
  const rows = lb.rows
    .map(
      (r, i) =>
        `<tr><td class="num">${i + 1}</td><td>${esc(r.name)}</td>` +
        (detailHead === undefined ? "" : `<td>${r.detail === undefined ? ABSENT : esc(r.detail)}</td>`) +
        `<td class="num">${grouped(r.requests)}</td><td class="num">${compact(r.output)}</td><td class="num">${compact(r.total)}</td></tr>`,
    )
    .join("");
  const share = total > 0 ? ` (${num((100 * lb.attributed) / total, 1)}% of all requests)` : "";
  return card({
    title: heading,
    wide: opts.wide,
    body:
      `<div class="scroll"><table class="leaders"><thead><tr><th class="num">#</th><th>${esc(noun)}</th>` +
      (detailHead === undefined ? "" : `<th>${esc(detailHead)}</th>`) +
      `<th class="num">requests</th><th class="num">output</th><th class="num">all tokens</th></tr></thead><tbody>${rows}</tbody></table></div>` +
      `<p class="note">${grouped(lb.attributed)} requests attributed${share}, all time.${lb.more > 0 ? ` ${lb.more} more not shown.` : ""}</p>`,
  });
}

function errorsCard(d: SkillsData, tz: string): string {
  const e = d.apiErrors;
  const total = d.allTime.requests;
  const rows = e.byStatus
    .map((r) => `<tr><td>${esc(r.status)}</td><td class="num">${grouped(r.requests)}</td></tr>`)
    .join("");
  return card({
    title: "API errors · all time",
    body:
      `<div class="row">` +
      tile(grouped(e.total), "requests with an API error") +
      (total > 0 ? tile(`${num((100 * e.total) / total, 2)}%`, "of all requests") : `<div class="tile"><div class="value absent">—</div><div class="label">of all requests</div></div>`) +
      `</div>` +
      (e.byStatus.length === 0
        ? `<p class="note">No request recorded an API error.</p>`
        : `<table class="errors"><thead><tr><th>status</th><th class="num">requests</th></tr></thead><tbody>${rows}</tbody></table>` +
          `<p class="note">First ${clock(e.firstTs as number, tz)} on ${dateIn(e.firstTs as number, tz)}, ` +
          `last ${clock(e.lastTs as number, tz)} on ${dateIn(e.lastTs as number, tz)}, local time. ` +
          `Claude Code records a failed call as a &lt;synthetic&gt; message with no model, so errors are counted here, not per model.</p>`),
  });
}

/**
 * The body as a list of pieces, in order: `body` is their concatenation. Each
 * piece is a whole card or a grid row's bare open / close tag, never half an
 * element. The report emits a piece that is the same in every range once and
 * repeats only the cards that change (report.ts); the lifetime cards sit
 * together at the end.
 */
export function skillsSections(d: SkillsData, tz: string = localZone()): string[] {
  const total = d.allTime.requests;
  return [
    seriesCard(d),
    `<div class="g g-2">`, requestShareCard(d), outputShareCard(d), `</div>`,
    modelTableCard(d),
    `<div class="g g-2">`, effortCard(d), cacheCard(d), `</div>`,
    mixCard(d),
    tokensCard(d),
    `<div class="g g-2">`, sideCard(d), errorsCard(d, tz), `</div>`,
    `<div class="g g-2">`, leaderCard("Skills", "skill", d.skills, total), leaderCard("Plugins", "plugin", d.plugins, total), `</div>`,
    leaderCard("MCP servers", "server", d.mcpServers, total, { detailHead: "top tool", wide: true }),
  ];
}

export function renderSkillsBody(d: SkillsData, opts: { tz?: string } = {}): string {
  return skillsSections(d, opts.tz).join("");
}

export function skillsView(d: SkillsData, opts: { tz?: string } = {}): View {
  const tz = opts.tz ?? localZone();
  const sections = skillsSections(d, tz);
  return {
    href: "/skills",
    title: "Models & Skills",
    body: sections.join(""),
    sections,
    footer:
      `generated ${stamp(d.generatedAt, tz)} · times are local, ${zoneNote(tz, d.generatedAt)} · Claude-specific: every figure is read from claude_requests, ` +
      `cost per day from claude_daily_rollups · days are local, as the rollup buckets them`,
  };
}

export function renderSkillsPage(d: SkillsData, opts: { tz?: string } = {}): string {
  return viewPage(skillsView(d, opts));
}
