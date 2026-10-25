/**
 * The History view, as cards: Claude Code's level (the hero), the calendar, weekday
 * habits, when you work, hygiene and what drives it, the average context
 * trend, active against idle, cumulative cost, cost at API prices by model,
 * the wait per turn and coverage.
 *
 * Range: the trends and bars cover `d.range` (spec §5). The calendar heatmap is
 * always the last year, and the level, streaks and coverage are lifetime.
 *
 * Pure: `serve` and `report` both render through here.
 */
import type { HistoryData, HistoryDay, HygieneScale } from "../read/history.ts";
import { sumApiCosts } from "../read/perf.ts";
import { bucketName, buckets, meanOf, rangeLabel, sumOf, weekOf, type Range } from "../read/range.ts";
import {
  areaChart,
  calendarHeatmap,
  dayBars,
  hourWeekdayHeatmap,
  stackedBar,
} from "./charts.ts";
import { API_PRICES, CC_FIGURE, apiCostHtml, apiCostLabel, claudeCodeCostHtml, hasApiCost, usd as dollars, usdTick } from "./cost.ts";
import { esc, grouped, localZone, millis, num, stamp, zoneNote } from "./html.ts";
import { levelBlock } from "./level.ts";
import { card, viewPage, type View } from "./layout.ts";

/** Named models in the cost-by-model bars; the rest fold into one neutral "other" series. */
const COST_SERIES = 5;
/** Rows in the hygiene drivers table, newest first. */
const HYGIENE_TABLE_DAYS = 14;
/** The calendar heatmap is always a year, whatever the range. */
const CALENDAR_DAYS = 365;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function tile(value: string, label: string, unit = ""): string {
  return `<div class="tile"><div class="value">${value}${unit ? `<span class="unit">${esc(unit)}</span>` : ""}</div><div class="label">${esc(label)}</div></div>`;
}

function absentTile(label: string): string {
  return `<div class="tile"><div class="value absent">—</div><div class="label">${esc(label)}</div></div>`;
}

const hours = (n: number) => `${num(n, 1)}h`;
const usd = (n: number) => `$${grouped(n)}`;

/**
 * What a day's score is out of, in words: the denominator and which reading it
 * is missing. A rescaled day printed as a bare number would read as comparable
 * to a full one.
 */
export function scaleLabel(scale: HygieneScale): string {
  switch (scale) {
    case 100: return "of 100";
    case 75: return "of 75, rescaled · no cache reading";
    case 65: return "of 65, rescaled · no cache reading, zero window";
    case 70: return "of 70, rescaled · no context reading";
    case 60: return "of 60, rescaled · no context reading, zero window";
    case 45: return "of 45, rescaled · no cache or context reading";
    case 35: return "of 35, rescaled · no cache or context reading, zero window";
  }
}

/** Every rescaled denominator, in the order the note lists them. */
const RESCALED: readonly Exclude<HygieneScale, 100>[] = [75, 65, 70, 60, 45, 35];

/** "in the last 7 days" / "at all": for empty states. */
const within = (r: Range) => (r === "all" ? "at all" : `in the ${rangeLabel(r)}`);

/** A day's row, if it falls inside the range's window. */
const inRange = (d: HistoryData) => d.days.filter((x) => x.day >= d.rangeFrom);

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const dash = `<b class="absent">—</b>`;

/**
 * The hero: Claude Code's level (Stage 5; the 5,000 h ladder retired), the
 * lifetime active hours it is earned from, lifetime hygiene and the streaks.
 * A lifetime card -- the range never moves it. With nothing computed there is
 * no number at all, and a current streak of none is said in words.
 */
function levelHero(d: HistoryData): string {
  const r = d.rank;
  const s = d.streaks;
  const hrs = r === null ? null : num(r.activeHours, 1);
  const hours =
    r === null
      ? `<div class="muted label">no active hours computed yet</div>`
      : `<div class="big"${Number.isFinite(r.activeHours) ? ` data-count="${hrs}"` : ""}>${hrs}<span class="unit">h</span></div>` +
        `<div class="muted label">active hours, lifetime</div>`;
  const facts = [
    r === null ? kv("lifetime hygiene", dash) : kv("lifetime hygiene", `<b>${num(r.hygiene, 1)}</b>`),
    kv("current streak", s.current === 0 ? `<b class="absent">no current streak</b>` : `<b>${s.current} ${s.current === 1 ? "day" : "days"}</b>`),
    s.longest === 0
      ? kv("longest streak", dash)
      : kv(`longest · ended ${s.longestEndsOn}`, `<b>${s.longest} days</b>`),
  ].join("");
  return card({
    title: "Level",
    hero: true,
    body: `<div class="rank-hero"><div class="rank-side">${levelBlock(d.level, "claude")}<div class="block">${hours}</div><div class="block">${facts}</div></div></div>`,
  });
}

function calendarCard(d: HistoryData): string {
  const year = d.calendar.slice(-CALENDAR_DAYS);
  return card({
    title: "Active hours by day · last year",
    body: calendarHeatmap({
      days: year.map((c) => ({
        day: c.day,
        value: c.activeHours,
        title: c.activeHours === null ? `${c.day}: no reading, after the last rollup` : `${c.day}: ${hours(c.activeHours)} active`,
      })),
      label: `${year.length} days, local time · always the last year, whatever the range`,
    }),
  });
}

function weekdayCard(d: HistoryData): string {
  const none = d.weekday.every((w) => w.avgActiveHours === null);
  return card({
    title: `Weekday habits · ${rangeLabel(d.range)}`,
    body: dayBars({
      bars: none
        ? []
        : d.weekday.map((w) => ({
            label: WEEKDAYS[w.dow],
            value: w.avgActiveHours,
            title:
              w.avgActiveHours === null
                ? `${WEEKDAYS[w.dow]}: no days with data`
                : `${WEEKDAYS[w.dow]}: ${hours(w.avgActiveHours)} average over ${w.days} ${w.days === 1 ? "day" : "days"}`,
          })),
      label: "average of days you used it · active hours per weekday",
      format: hours,
      emptyText: `no days with data ${within(d.range)}`,
    }),
  });
}

function whenCard(d: HistoryData): string {
  return card({
    title: `When you work · ${rangeLabel(d.range)}`,
    body: hourWeekdayHeatmap({
      grid: d.promptGrid,
      unit: "prompts",
      label: `prompts by local hour and weekday · ${grouped(d.promptsCounted)} prompts${d.promptsSince === null ? "" : ` · hooks installed ${d.promptsSince}`}`,
      emptyText: `no prompts recorded ${within(d.range)}`,
    }),
  });
}

function drivers(x: HistoryDay): string {
  const cache = x.cacheHitPct === null ? `<span class="absent">no reading</span>` : `${num(x.cacheHitPct, 1)}%`;
  // M14: no status-line reading that day. The rollup stores no peak and drops
  // the term (Stage 4B), so the cell says so rather than printing 0%.
  const ctx = x.peakContextPct === null
    ? `<span class="absent" title="no status-line context reading; hygiene drops the context term and rescales the rest">no data</span>`
    : `${num(x.peakContextPct, 0)}%`;
  const idle = x.idleShare === null ? `<span class="absent">zero window</span>` : `${num(100 * x.idleShare, 0)}%`;
  return `<td class="num">${cache}</td><td class="num">${ctx}</td><td class="num">${x.compacts} / ${x.clears}</td><td class="num">${idle}</td>`;
}

/** A day row's two cost cells: at API prices, then Claude Code's figure. */
function costs(x: HistoryDay): string {
  return `<td class="num">${apiCostHtml(x.apiCost)}</td><td class="num">${claudeCodeCostHtml(x.costUsd)}</td>`;
}

function hygieneCard(d: HistoryData): string {
  // Positioned by CALENDAR date, not by row: a date with no rollup row is a
  // gap in the line like a zero-session day, rather than being squeezed out so
  // that two days a fortnight apart sit side by side.
  const byDay = new Map(d.days.map((x) => [x.day, x]));
  const daily = d.span.map((day) => {
    const x = byDay.get(day);
    if (x === undefined || x.hygiene === null || x.hygieneScale === null) return { label: day, value: null };
    return {
      label: day,
      value: x.hygiene,
      mark: x.hygieneScale === 100 ? undefined : `r${x.hygieneScale}`,
      title: `${day}: ${num(x.hygiene, 1)} ${scaleLabel(x.hygieneScale)}`,
    };
  });
  // Past 90 days (`all`), one point a week: the mean of that week's scored days.
  const b = buckets(d.span);
  const points = !b.weekly
    ? daily
    : b.buckets.map((k) => {
        const m = meanOf(k.days.map((day) => byDay.get(day)?.hygiene));
        return m === null
          ? { label: k.label, value: null }
          : { label: k.label, value: m.mean, title: `${bucketName(k)}: ${num(m.mean, 1)} mean over ${m.of} scored ${m.of === 1 ? "day" : "days"}` };
      });
  const rows = inRange(d);
  const byScale = RESCALED.map((scale) => ({ scale, n: rows.filter((x) => x.hygieneScale === scale).length }));
  const rescaled = byScale.reduce((a, x) => a + x.n, 0);
  // Unscored dates from the first rollup row on: before it there was no tracker to score anything.
  const first = d.days[0]?.day;
  const gaps = first === undefined ? 0 : daily.filter((p) => p.value === null && p.label >= first).length;

  const chart = areaChart({
    points,
    label: b.weekly ? "weekly hygiene, the mean of each week's scored days, 0-100" : "daily hygiene, 0-100",
    fill: false,
    yMax: 100,
    emptyText: `no session days ${within(d.range)}`,
  });

  const note =
    `<p class="note">` +
    (b.weekly
      ? `Each point is the mean of that week's scored days. A day with no sessions is left out of it rather than counted as 0, as lifetime hygiene leaves it out (${gaps} in this range); a week with none is a break in the line. `
      : `A day with no sessions has no point, and the line breaks there rather than dropping to 0: there is no behaviour to score, and lifetime hygiene excludes those days too (${gaps} in this range). `) +
    (rescaled === 0
      ? `Every scored day in this range has both a cache and a context reading, so each is out of 100.`
      : `${rescaled} ${rescaled === 1 ? "day is" : "days are"} missing a reading — no cache reading where the transcript was gone, no context reading where no session had a status-line snapshot — so each missing term is dropped and the rest rescaled to what they could reach: ` +
        byScale
          .filter((x) => x.n > 0)
          .map((x) => `<span class="key r${x.scale}">●</span> ${x.n} out of ${x.scale}`)
          .join(", ") +
        ` (65, 60 and 35 are a zero window, where focus/idle is a flat 10)` +
        `${b.weekly ? "; the 90-day range marks each one" : ""}.`) +
    `</p>`;

  return card({ title: "Hygiene", body: chart + note });
}

/** The hygiene drivers, newest first: a lifetime table of the last rows, whatever the range. */
function driversCard(d: HistoryData): string {
  const recent = d.days.slice(-HYGIENE_TABLE_DAYS).reverse();
  const trs = recent
    .map((x) =>
      x.hygiene === null || x.hygieneScale === null
        ? `<tr><td>${esc(x.day)}</td><td class="absent" colspan="6">no sessions · not scored</td>${costs(x)}</tr>`
        : `<tr${x.hygieneScale === 100 ? "" : ` class="rescaled r${x.hygieneScale}"`}><td>${esc(x.day)}</td><td class="num">${num(x.hygiene, 1)}</td><td>${esc(scaleLabel(x.hygieneScale))}</td>${drivers(x)}${costs(x)}</tr>`,
    )
    .join("");
  const table =
    `<div class="scroll"><table class="hygiene"><thead><tr><th>day</th><th class="num">score</th><th>out of</th>` +
    `<th class="num">cache hit · 25</th><th class="num">peak context · 30</th>` +
    `<th class="num">compacts / clears · 25</th><th class="num">idle · 20</th>` +
    `<th class="num">${esc(API_PRICES)}</th><th class="num">${esc(CC_FIGURE)}</th></tr></thead><tbody>${trs}</tbody></table></div>` +
    `<p class="note">The day's cost two ways (spec 4B): ${esc(API_PRICES)}, the rollup's price of its requests, and ${esc(CC_FIGURE)}, ` +
    `the status line's running total for the sessions that started that day. "No reading" is a day with nothing to price or no status-line reading, ` +
    `"not priced" one whose requests had no price, never $0.</p>`;

  return card({ title: `What drove it · last ${HYGIENE_TABLE_DAYS} days`, wide: true, body: table });
}

/**
 * Guard 1's render half: the reader has already made a no-snapshot day null,
 * and a null is a break in the line, never a point at 0.
 */
function contextCard(d: HistoryData): string {
  const b = buckets(d.span);
  const byDay = new Map(d.contextTrend.map((c) => [c.day, c.avgContextPct]));
  return card({
    title: `Average context · ${rangeLabel(d.range)}`,
    body: areaChart({
      points: b.buckets.map((k) => {
        const m = meanOf(k.days.map((day) => byDay.get(day)));
        return {
          label: k.label,
          value: m === null ? null : m.mean,
          title: m === null ? undefined
            : k.week ? `${bucketName(k)}: ${num(m.mean, 1)}% of the window, the mean of ${m.of} ${m.of === 1 ? "day" : "days"} with a reading`
            : `${k.label}: ${num(m.mean, 1)}% of the window on average`,
        };
      }),
      label: b.weekly
        ? "average context used per week, % of the window: the mean of the days with a reading · a gap is a week with no status-line reading"
        : "average context used per day, % of the window · a gap is a day with no status-line reading",
      yMax: 100,
      format: (n) => `${num(n, 0)}%`,
      emptyText: `no status-line readings ${within(d.range)}`,
    }),
  });
}

function activeIdleCard(d: HistoryData): string {
  // CALENDAR days, not rows: a date with no row stays a gap in its own slot
  // rather than being squeezed out, so the heading's span is true and two days
  // a fortnight apart never sit side by side. Past 90 days, one bar a week.
  const byDay = new Map(d.days.map((x) => [x.day, x]));
  const any = d.span.some((day) => byDay.has(day));
  const b = buckets(d.span);
  return card({
    title: `Active vs idle · ${rangeLabel(d.range)}`,
    body: stackedBar({
      columns: !any
        ? []
        : b.buckets.map((k) => {
            const rows = k.days.flatMap((day) => byDay.get(day) ?? []);
            const name = bucketName(k);
            if (rows.length === 0) return { label: k.label, parts: [], title: `${name}: no rollup row` };
            const active = sumOf(rows.map((x) => x.activeHours)) ?? 0;
            const idle = sumOf(rows.map((x) => x.idleHours)) ?? 0;
            return { label: k.label, parts: [active, idle], title: `${name}: ${hours(active)} active, ${hours(idle)} idle` };
          }),
      series: ["active", "idle"],
      label: b.weekly ? "hours per week" : "hours per day",
      format: hours,
      emptyText: `no rollup rows ${within(d.range)}`,
    }),
  });
}

/**
 * The lifetime running total, drawn over the range: the line starts at what
 * had been spent before the window opened, so "to date" stays true.
 */
function costCard(d: HistoryData): string {
  let running = 0;
  let before = 0;
  const points: { label: string; value: number }[] = [];
  // A day with no status-line reading adds nothing to the running total; with
  // no reading on record at all there is no total to draw, not a flat $0.
  const read = d.days.some((x) => x.costUsd !== null);
  for (const x of d.days) {
    running += x.costUsd ?? 0;
    if (x.day < d.rangeFrom) before = running;
    else points.push({ label: x.day, value: running });
  }
  // Past 90 days, one point a week: the running total at the week's last row.
  const weekly = buckets(d.span).weekly;
  const drawn = !weekly
    ? points
    : points.filter((p, i) => i === points.length - 1 || weekOf(points[i + 1].label) !== weekOf(p.label));
  return card({
    title: `Cumulative cost · ${CC_FIGURE} · ${rangeLabel(d.range)}`,
    body: areaChart({
      points: read ? drawn : [],
      label: `${CC_FIGURE}, cumulative${weekly ? ", at each week's end" : ""} · ${usd(running - before)} in range · ${usd(running)} to date`,
      format: usd,
      yMin: before,
      emptyText: drawn.length === 0 ? `no rollup rows ${within(d.range)}` : `no reading: no session has reported a status-line cost`,
    }),
  });
}

/**
 * Cost at API prices per day (per week past 90 days), one series per model,
 * the rollup's stored per-request costs summed. A bucket with nothing priced
 * is a gap -- no reading, or not priced -- never a zero column. The range's
 * two totals sit under it, both figures named.
 */
function modelCostCard(d: HistoryData): string {
  const p = d.perf;
  const named = p.models.slice(0, COST_SERIES);
  const others = p.models.length - named.length;
  const series = [...named, ...(others > 0 ? [`${others} other ${others === 1 ? "model" : "models"}`] : [])];
  const per = p.weekly ? "week" : "day";
  const total = sumApiCosts(p.buckets.map((k) => k.apiCost));
  const any = p.buckets.some((k) => hasApiCost(k.apiCost));
  const columns = !any
    ? []
    : p.buckets.map((k) => {
        const name = bucketName(k);
        // A gap draws no mark, so it carries no tooltip either.
        if (!hasApiCost(k.apiCost)) return { label: k.label, parts: [] };
        const parts = k.costByModel.slice(0, COST_SERIES);
        if (others > 0) parts.push(k.costByModel.slice(COST_SERIES).reduce((a, n) => a + n, 0));
        const byModel = parts.flatMap((v, i) => (v > 0 ? [`${series[i]} ${dollars(v)}`] : []));
        return { label: k.label, parts, title: `${name}: ${apiCostLabel(k.apiCost)}${byModel.length === 0 ? "" : ` · ${byModel.join(", ")}`}` };
      });
  const cc = d.days.filter((x) => x.day >= d.rangeFrom).map((x) => x.costUsd);
  const ccTotal = cc.some((v) => v !== null) ? cc.reduce<number>((a, v) => a + (v ?? 0), 0) : null;
  const empty = total === null || total.priced + total.unpriced === 0 ? `no reading ${within(d.range)}` : `not priced ${within(d.range)}: no request in range had a price`;
  return card({
    title: `Cost by model · ${API_PRICES} · ${rangeLabel(d.range)}`,
    body:
      stackedBar({
        columns,
        series,
        other: others > 0,
        label: `cost ${API_PRICES} per ${per} by model · a gap is a ${per} with no priced request`,
        format: usdTick,
        emptyText: empty,
      }) +
      `<p class="note">In range: <b>${apiCostHtml(total)}</b> ${esc(API_PRICES)} · <b>${claudeCodeCostHtml(ccTotal)}</b> ${esc(CC_FIGURE)}, which can't be split by model.</p>`,
  });
}

/**
 * The median wait per turn over time, measured turns only (spec 4B §4.3).
 * Review Focus 5: a day (a week, past 90 days) with no measured turn is a
 * break in the line -- a null point -- never a wait of 0.
 */
function waitCard(d: HistoryData): string {
  const p = d.perf;
  const per = p.weekly ? "week" : "day";
  const measured = p.buckets.reduce((a, k) => a + k.wait.n, 0);
  return card({
    title: `Wait per turn · ${rangeLabel(d.range)}`,
    body:
      areaChart({
        points: p.buckets.map((k) => ({
          label: k.label,
          value: k.wait.median,
          title:
            k.wait.median === null || k.wait.p90 === null
              ? undefined
              : `${bucketName(k)}: median ${millis(k.wait.median)}, p90 ${millis(k.wait.p90)}, ${k.wait.n} ${k.wait.n === 1 ? "turn" : "turns"}`,
        })),
        label: `median wait per turn, measured turns only, per ${per} · a gap is a ${per} with no measured turn`,
        fill: false,
        format: millis,
        emptyText: `no reading: no measured turn ${within(d.range)}`,
      }) +
      `<p class="note">Prompt to last response, over ${grouped(measured)} measured ${measured === 1 ? "turn" : "turns"}; human and headless turns are not timed.</p>`,
  });
}

function coverageCard(d: HistoryData): string {
  const c = d.coverage;
  if (c.firstDay === null) {
    return card({ title: "Coverage", body: `<div class="row">${absentTile("no days recorded yet")}</div>` });
  }
  return card({
    title: "Coverage · lifetime",
    body: `<div class="row">${[
      tile(grouped(c.daysTracked), `days since ${c.firstDay}`),
      tile(grouped(c.daysWithSessions), "days with sessions"),
      tile(grouped(d.rank?.sessions ?? d.days.reduce((a, x) => a + x.sessions, 0)), "sessions"),
      tile(grouped(c.daysWithoutTranscripts), "session days without transcripts"),
    ].join("")}</div>`,
  });
}

/**
 * The body as a list of pieces, in order: `body` is their concatenation. Each
 * piece is a whole card or a grid row's bare open / close tag, never half an
 * element. The report carries a piece that is the same in every range -- the
 * rank and calendar, the drivers table, coverage, every grid tag -- once, and
 * repeats only the cards that change with the range (report.ts).
 */
export function historySections(d: HistoryData): string[] {
  return [
    `<div class="g g-top">`, levelHero(d), calendarCard(d), `</div>`,
    `<div class="g g-2">`, weekdayCard(d), whenCard(d), `</div>`,
    `<div class="g g-2">`, hygieneCard(d), contextCard(d), `</div>`,
    driversCard(d),
    `<div class="g g-2">`, activeIdleCard(d), costCard(d), `</div>`,
    `<div class="g g-2">`, modelCostCard(d), waitCard(d), `</div>`,
    coverageCard(d),
  ];
}

export function renderHistoryBody(d: HistoryData): string {
  return historySections(d).join("");
}

export function historyView(d: HistoryData, opts: { tz?: string } = {}): View {
  const tz = opts.tz ?? localZone();
  const sections = historySections(d);
  return {
    href: "/history",
    title: "History",
    body: sections.join(""),
    sections,
    footer:
      // Dated, not just timed: a rollup four days old must not read as today's.
      `generated ${stamp(d.generatedAt, tz)} · days and times are local, ${zoneNote(tz, d.generatedAt)}, as the rollup buckets them · ` +
      `rollup ${d.lastRollup === null ? "never" : stamp(d.lastRollup, tz)}`,
  };
}

export function renderHistoryPage(d: HistoryData, opts: { tz?: string } = {}): string {
  return viewPage(historyView(d, opts));
}
