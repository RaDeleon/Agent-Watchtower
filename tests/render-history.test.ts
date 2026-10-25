import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAndRoll } from "./helpers/fixture-db.ts";
import { hitCount, whole } from "./helpers/marks.ts";
import {
  areaChart,
  calendarHeatmap,
  dayBars,
  donut,
  hourWeekdayHeatmap,
  progressRing,
  rangePills,
  sparkline,
  stackedBar,
  WIDE_W,
} from "@/lib/render/charts";
import { historyView, renderHistoryPage, scaleLabel } from "@/lib/render/history";
import { readHistory } from "@/lib/read/history";

process.env.TZ = "UTC";

const BASE = 1750000000;
const NOW = BASE + 5 * 86400 + 1000;

/** How many separate line runs an SVG draws. */
const lines = (svg: string) => (svg.match(/<path class="line"/g) ?? []).length;

describe("chart primitives: empty input is a named case", () => {
  // Each one must render a deliberate empty state: no axis, no zero.
  const cases: [string, string][] = [
    ["areaChart", areaChart({ points: [], label: "x" })],
    ["areaChart, all null", areaChart({ points: [{ label: "a", value: null }], label: "x" })],
    ["dayBars", dayBars({ bars: [], label: "x" })],
    ["stackedBar", stackedBar({ columns: [], series: ["a"], label: "x" })],
    ["donut", donut({ slices: [], label: "x" })],
    ["donut, zero total", donut({ slices: [{ label: "a", value: 0 }], label: "x" })],
    ["calendarHeatmap", calendarHeatmap({ days: [], label: "x" })],
    ["hourWeekdayHeatmap", hourWeekdayHeatmap({ grid: [], label: "x", unit: "prompts" })],
    [
      "hourWeekdayHeatmap, all zero",
      hourWeekdayHeatmap({ grid: Array.from({ length: 7 }, () => new Array(24).fill(0)), label: "x", unit: "prompts" }),
    ],
  ];
  for (const [name, html] of cases) {
    it(`${name} renders an empty state`, () => {
      expect(html).toContain("chart-empty");
      expect(html).not.toContain("<svg");
    });
  }

  it("sparkline renders a dash, not a flat line", () => {
    expect(sparkline({ values: [], label: "x" })).toContain("—");
    expect(sparkline({ values: [null, null], label: "x" })).not.toContain("<path");
  });
});

describe("chart primitives: deterministic", () => {
  const all = () => [
    areaChart({ points: [{ label: "a", value: 1 }, { label: "b", value: 3 }], label: "x" }),
    sparkline({ values: [1, 2, null, 4], label: "x" }),
    dayBars({ bars: [{ label: "a", value: 1 }, { label: "b", value: null }], label: "x" }),
    stackedBar({ columns: [{ label: "a", parts: [1, 2] }], series: ["p", "q"], label: "x" }),
    donut({ slices: [{ label: "a", value: 1 }, { label: "b", value: 3 }], label: "x" }),
    calendarHeatmap({ days: [{ day: "2025-06-15", value: 1 }, { day: "2025-06-16", value: null }], label: "x" }),
    hourWeekdayHeatmap({ grid: Array.from({ length: 7 }, (_, i) => new Array(24).fill(i)), label: "x", unit: "p" }),
  ];
  it("same input, same string", () => {
    expect(all()).toEqual(all());
  });

  it("escapes labels that came off disk", () => {
    expect(donut({ slices: [{ label: "<b>", value: 1 }], label: "x" })).toContain("&lt;b&gt;");
    expect(donut({ slices: [{ label: "<b>", value: 1 }], label: "x" })).not.toContain("<b>");
  });
});

describe("chart primitives: a null is a gap", () => {
  // Killing mutation: map a null to 0 inside the chart. The run is then
  // unbroken and the line dives to the floor instead of stopping.
  it("areaChart splits the line at a null", () => {
    const svg = areaChart({
      points: [
        { label: "a", value: 80 }, { label: "b", value: 90 }, { label: "c", value: null },
        { label: "d", value: 85 }, { label: "e", value: 88 },
      ],
      label: "x", fill: false, yMax: 100,
    });
    expect(lines(svg)).toBe(2);
  });

  it("dayBars draws a null as a stub distinct from a zero bar", () => {
    const svg = dayBars({ bars: [{ label: "a", value: 0 }, { label: "b", value: null }], label: "x" });
    expect(svg).toContain("bar-absent");
    expect(svg).toContain('class="bar"');
  });

  it("calendarHeatmap draws a null distinctly from a zero day", () => {
    const svg = calendarHeatmap({ days: [{ day: "2025-06-15", value: 0 }, { day: "2025-06-16", value: null }], label: "x" });
    expect(svg).toContain("cal-absent");
    expect(svg).toContain("cell l0");
  });

  it("calendarHeatmap starts on the first day's real weekday", () => {
    // 2025-06-15 is a Sunday: the first cell sits in row 0.
    const svg = calendarHeatmap({ days: [{ day: "2025-06-15", value: 1 }], label: "x" });
    expect(svg).toMatch(/<rect class="cell l4" x="18" y="14"/);
  });
});

describe("chart primitives: restyle", () => {
  // Colour lives in theme tokens. A literal in a primitive would ignore the
  // theme -- and be invisible on four of the five.
  it("writes no literal colour: every mark is a class that resolves to a token", () => {
    const src = readFileSync(path.resolve(__dirname, "..", "lib", "render", "charts.ts"), "utf8");
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(src).not.toMatch(/\brgba?\(|\bhsla?\(/);
  });

  // A mark's tooltip is its own <title>, read by the client. A data-tip copy
  // doubled every tooltip's bytes in the report, so there is none (I4).
  const marks: [string, string][] = [
    ["progressRing", progressRing({ pct: 42, label: "5-hour limit", tone: "limit" })],
    ["progressRing, no reading", progressRing({ pct: null, label: "7-day limit" })],
    ["areaChart", areaChart({ points: [{ label: "a", value: 1 }, { label: "b", value: null }, { label: "c", value: 3, mark: "r75", title: "c: 3 of 75" }], label: "x" })],
    ["sparkline", sparkline({ values: [1, 2, null, 4], label: "active hours" })],
    ["dayBars", dayBars({ bars: [{ label: "a", value: 1 }, { label: "b", value: null }], label: "x" })],
    ["stackedBar", stackedBar({ columns: [{ label: "a", parts: [1, 2] }], series: ["p", "q"], label: "x" })],
    ["donut", donut({ slices: [{ label: "<a>", value: 1 }, { label: "b", value: 3 }], label: "x" })],
    ["calendarHeatmap", calendarHeatmap({ days: [{ day: "2025-06-15", value: 1 }, { day: "2025-06-16", value: null }], label: "x" })],
    ["hourWeekdayHeatmap", hourWeekdayHeatmap({ grid: Array.from({ length: 7 }, (_, i) => new Array(24).fill(i)), label: "x", unit: "prompts" })],
  ];
  for (const [name, html] of marks) {
    it(`${name}: every mark's <title> is its first child, with no data-tip copy`, () => {
      const titles = (html.match(/<title>/g) ?? []).length;
      const first = html.match(/<(svg|rect|circle|path|line|g|polyline)\b[^>]*><title>[^<]*<\/title>/g) ?? [];
      expect(titles).toBeGreaterThan(0);
      expect(first).toHaveLength(titles);
      expect(html).not.toContain("data-tip");
    });
  }

  // M12: a running total drawn from 0 is a flat line along the top of the card.
  it("starts the y axis at yMin, its lowest point on the baseline", () => {
    const svg = areaChart({ points: [{ label: "a", value: 100 }, { label: "b", value: 110 }], label: "x", yMin: 100, fill: false });
    expect(svg).toContain('text-anchor="end">100</text>'); // the bottom tick
    expect(whole(svg)).toContain('<path class="line" d="M48 158 L712 10"/>');
    const zero = areaChart({ points: [{ label: "a", value: 100 }, { label: "b", value: 110 }], label: "x", fill: false });
    expect(whole(zero)).toContain('<path class="line" d="M48 23.5 L712 10"/>'); // from 0: nearly flat
  });

  // M1: a full-width card gets a wider viewBox, so its text is drawn at the
  // same size as a half-width card's rather than twice it.
  it("sizes the viewBox from width and height, axis and ticks included", () => {
    const svg = areaChart({ points: [{ label: "a", value: 1 }, { label: "b", value: 2 }], label: "x", width: WIDE_W, height: 220 });
    expect(svg).toContain(`viewBox="0 0 ${WIDE_W} 220"`);
    expect(svg).toContain(`x2="${WIDE_W - 8}"`);
    expect(svg).toContain(`<text class="tick" x="${WIDE_W - 8}" y="216" text-anchor="end">b</text>`);
    const bars = stackedBar({ columns: [{ label: "a", parts: [1] }, { label: "b", parts: [2] }], series: ["p"], label: "x", width: WIDE_W, height: 200 });
    expect(bars).toContain(`viewBox="0 0 ${WIDE_W} 200"`);
    expect(bars).toContain(`<text class="tick" x="${WIDE_W - 8}" y="196" text-anchor="end">b</text>`);
  });

  it("gives every reading on an area chart a tooltip, and a null none", () => {
    const svg = areaChart({ points: [{ label: "d1", value: 5 }, { label: "d2", value: null }, { label: "d3", value: 7 }], label: "x" });
    expect(hitCount(svg)).toBe(2);
    expect(svg).toContain("<title>d1: 5</title>");
    expect(svg).not.toContain("d2");
  });

  it("marks a ring's percentage for count-up only when asked and only when finite", () => {
    expect(progressRing({ pct: 42, label: "x", count: true })).toContain('data-count="42.0">42.0%<');
    expect(progressRing({ pct: 42, label: "x" })).not.toContain("data-count");
    expect(progressRing({ pct: null, label: "x", count: true })).not.toContain("data-count");
    expect(progressRing({ pct: Number.NaN, label: "x", count: true })).not.toContain("data-count");
    expect(progressRing({ pct: 100, label: "x", count: true, valueText: "top rank" })).not.toContain("data-count");
  });
});

describe("rangePills", () => {
  it("links each range on the server, marking the active one", () => {
    const html = rangePills("7d", "link", (r) => `/history?range=${r}`);
    expect(html).toBe(
      '<nav class="ranges" aria-label="Range">' +
        '<a class="rp" href="/history?range=7d" aria-current="true">7d</a>' +
        '<a class="rp" href="/history?range=30d">30d</a>' +
        '<a class="rp" href="/history?range=90d">90d</a>' +
        '<a class="rp" href="/history?range=all">All</a></nav>',
    );
  });

  it("toggles in the report, with no link anywhere", () => {
    const html = rangePills("30d", "toggle", () => "/never");
    expect(html).not.toContain("href");
    expect(html).not.toContain("/never");
    expect(html.match(/data-range-to="(7d|30d|90d|all)"/g)).toHaveLength(4);
    expect(html).toContain('data-range-to="30d" aria-pressed="true">30d</button>');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it("escapes whatever the href function returns", () => {
    expect(rangePills("30d", "link", () => '"><script>')).not.toContain("<script>");
  });
});

// Spec 4B §4.4: every denominator names itself and the reading it is missing.
describe("scaleLabel", () => {
  it("names each denominator and what the day was missing", () => {
    expect(scaleLabel(100)).toBe("of 100");
    expect(scaleLabel(75)).toBe("of 75, rescaled · no cache reading");
    expect(scaleLabel(65)).toBe("of 65, rescaled · no cache reading, zero window");
    expect(scaleLabel(70)).toBe("of 70, rescaled · no context reading");
    expect(scaleLabel(60)).toBe("of 60, rescaled · no context reading, zero window");
    expect(scaleLabel(45)).toBe("of 45, rescaled · no cache or context reading");
    expect(scaleLabel(35)).toBe("of 35, rescaled · no cache or context reading, zero window");
  });
});

describe("History page, on the `history` fixture", () => {
  const hd = readHistory(buildAndRoll("history"), { now: NOW });
  const html = renderHistoryPage(hd);
  const start = html.indexOf("<h2>Hygiene</h2>");
  const hygieneChart = html.slice(start, html.indexOf("</figure>", start));

  // THE GUARD: 2025-06-18 is a tokens-only day (sessions 0, hygiene stored as
  // 0) and 2025-06-19 has no row. The trend line must stop at 06-17 and pick
  // up again at 06-20. Plot the stored 0 instead and it is one unbroken line.
  it("breaks the hygiene trend on a zero-session day rather than plotting 0", () => {
    expect(lines(hygieneChart)).toBe(1);
    expect(hygieneChart).toContain('class="pt-solo"'); // 06-20, alone after the gap
    expect(hygieneChart).not.toMatch(/ 158\.0(?= |")/); // the y of a 0: PAD_T + plot height
  });

  // THE GUARD: real days with no cache reading, no context reading or neither
  // are rescaled. A table that printed their score bare would present
  // 80.0-of-35 as comparable to 90.5-of-100. 06-16 and 06-17 have neither a
  // request nor a snapshot of their own (spec 4B §4.4's last row).
  it("shows which denominator a day missing a reading was scored against", () => {
    expect(html).toMatch(/2025-06-16<\/td><td class="num">84\.4<\/td><td>of 45, rescaled · no cache or context reading</);
    expect(html).toMatch(/2025-06-17<\/td><td class="num">80\.0<\/td><td>of 35, rescaled · no cache or context reading, zero window</);
    expect(html).toMatch(/2025-06-15<\/td><td class="num">90\.5<\/td><td>of 100</);
    expect(html).toContain("pt-r45");
    expect(html).toContain("pt-r35");
    expect(html).toContain('<span class="key r45">●</span> 1 out of 45, <span class="key r35">●</span> 1 out of 35');
  });

  it("marks the zero-session day as not scored in the table", () => {
    expect(html).toMatch(/2025-06-18<\/td><td class="absent" colspan="6">no sessions · not scored/);
  });

  // M14's render half: a day with no context reading says "no data", not 0%.
  it("shows peak context as no data, not 0%, on a day with no status-line reading", () => {
    const row = (day: string) => html.slice(html.indexOf(`<td>${day}</td>`), html.indexOf("</tr>", html.indexOf(`<td>${day}</td>`)));
    expect(row("2025-06-16")).toContain(">no data</span>");
    expect(row("2025-06-16")).toMatch(/no reading<\/span><\/td><td class="num"><span[^>]*>no data<\/span><\/td>/); // cache, then peak
    expect(row("2025-06-15")).toContain('<td class="num">30%</td>');
  });

  it("shows the streaks and the level", () => {
    expect(html).toContain("longest · ended 2025-06-17");
    expect(html).toMatch(/<div class="big lv">Lv 15<span class="muted">\/99<\/span><\/div>/);
  });

  it("links History in the nav as the current page", () => {
    expect(html).toContain('<a href="/history" aria-current="page">History</a>');
  });

  // Every page now carries the client script (settings, tooltips), so "no
  // script" no longer means "no poll". The poll is the page's only fetch.
  it("never polls: History is a static read", () => {
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("/api/live");
  });

  // I4: a footer with a time and no date hid the four-day freeze. Dated now.
  it("dates the freshness footer, not just times it", () => {
    expect(html).toMatch(/generated 2025-06-20 \d\d:\d\d:\d\d UTC/);
    expect(html).toMatch(/rollup \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/);
    // I6: a zone given is the zone printed, and the footer names it.
    const la = renderHistoryPage(hd, { tz: "America/Los_Angeles" });
    expect(la).toMatch(/generated 2025-06-20 \d\d:\d\d:\d\d PDT · days and times are local, America\/Los_Angeles \(PDT\)/);
  });

  // M10: the last 30 CALENDAR days. 2025-06-19 has no row and must keep its
  // own slot as a gap rather than being squeezed out.
  it("draws active vs idle over the last 30 calendar days, a missing date as a gap", () => {
    const start = html.indexOf("<h2>Active vs idle");
    const chart = html.slice(start, html.indexOf("</figure>", start));
    expect(chart).toContain("last 30 days");
    expect(chart).toContain(">2025-05-22</text>"); // first slot: 30 days ending 2025-06-20
    expect(chart).not.toContain("2025-06-19"); // no row: no rect, no tooltip, a gap
    // One hover mark per row (the column's tooltip); a date with no row has none.
    expect(hitCount(chart)).toBe(5); // one per row
  });

  // M13: View.hero was declared and never read. The hero is a card's class.
  it("carries no View.hero flag: the hero is the card, not the view", () => {
    expect(Object.keys(historyView(hd))).not.toContain("hero");
    const layout = readFileSync(path.resolve(__dirname, "..", "lib", "render", "layout.ts"), "utf8");
    const view = layout.slice(layout.indexOf("export interface View"), layout.indexOf("}", layout.indexOf("export interface View")));
    expect(view).not.toMatch(/\bhero\b/);
  });

  it("makes the level the one hero card", () => {
    expect(html.match(/class="c hero"/g)).toHaveLength(1);
    expect(html).toContain('<section class="c hero"><h2>Level</h2>');
    expect(html).toMatch(/<div class="big lv">Lv \d+<span class="muted">\/99<\/span><\/div>/);
    expect(html).toMatch(/<div class="big" data-count="0\.5">0\.5<span class="unit">h<\/span><\/div>/);
  });

  it("draws weekday habits as the average of days you used it", () => {
    const at = html.indexOf("<h2>Weekday habits");
    const chart = html.slice(at, html.indexOf("</figure>", at));
    expect(chart).toContain("<h2>Weekday habits · last 30 days</h2>");
    expect(chart).toContain("average of days you used it");
    expect(chart).toContain("<title>Sun: 0.2h average over 1 day</title>");
    expect(chart).toContain("<title>Thu: no days with data</title>"); // null: a stub, not a 0 bar
    // Wed 06-18 is tokens-only (no session): not a day "you used it" (M4).
    expect(chart).toContain("<title>Wed: no days with data</title>");
    expect(chart.match(/class="bar-absent"/g)).toHaveLength(3); // Wed, Thu, Sat
  });

  // The render half of the context trend: a null from the reader is a break
  // in the line, never a point at 0. Its data is set here rather than read, so
  // that guard 1 (the reader's snapshot-day condition) owns exactly one test.
  it("draws the average context trend with a gap on every day with no reading", () => {
    const d = readHistory(buildAndRoll("history"), { now: NOW, range: "7d" });
    d.contextTrend = d.span.map((day) => ({
      day,
      avgContextPct: day === "2025-06-15" ? 20 : day === "2025-06-17" ? 35 : day === "2025-06-18" ? 30 : day === "2025-06-20" ? 40 : null,
    }));
    const page = renderHistoryPage(d);
    const at = page.indexOf("<h2>Average context");
    const chart = page.slice(at, page.indexOf("</figure>", at));
    expect(chart).toContain("<h2>Average context · last 7 days</h2>");
    expect(chart).toContain("<title>2025-06-15: 20.0% of the window on average</title>");
    expect(lines(chart)).toBe(1); // 06-17..18, unbroken
    expect(chart.match(/class="pt-solo"/g)).toHaveLength(2); // 06-15 and 06-20, each cut off by a gap
    expect(chart).not.toContain("2025-06-16:");
    expect(chart).not.toContain("2025-06-19:");
    // 158 is the y of a 0. The area's fill closes along it by design; the
    // line and the points must never touch it.
    expect(whole((chart.match(/<path class="line" d="[^"]*"/g) ?? []).join(""))).not.toMatch(/ 158(?![\d.])/);
    expect(whole(chart)).not.toContain('cy="158"');
  });

  it("keeps the calendar a year and the level lifetime, whatever the range", () => {
    const db = buildAndRoll("history");
    const pick = (h: string, from: string) => h.slice(h.indexOf(from), h.indexOf("</section>", h.indexOf(from)));
    const week = renderHistoryPage(readHistory(db, { now: NOW, range: "7d" }));
    for (const heading of ["<h2>Level</h2>", "<h2>Active hours by day · last year</h2>", "<h2>Coverage"]) {
      expect(pick(week, heading)).toBe(pick(html, heading));
    }
    expect(week).toContain("<h2>Active vs idle · last 7 days</h2>");
  });

  // Review Focus 2: a range with no data -- a week away. Every ranged card
  // names its emptiness, and the hero shows no 0 as a measurement.
  it("renders a window with zero rows as named empty states, with no hero 0", () => {
    const away = renderHistoryPage(readHistory(buildAndRoll("history"), { now: NOW + 30 * 86400, range: "7d" }));
    for (const msg of [
      "no days with data in the last 7 days",
      "no prompts recorded in the last 7 days",
      "no session days in the last 7 days",
      "no status-line readings in the last 7 days",
    ]) {
      expect(away).toContain(`<div class="empty-msg">${msg}</div>`);
    }
    expect(away.match(/<div class="empty-msg">no rollup rows in the last 7 days<\/div>/g)).toHaveLength(2); // active/idle, cost
    const hero = away.slice(away.indexOf('<section class="c hero">'), away.indexOf("</section>", away.indexOf('<section class="c hero">')));
    expect(hero).toContain("no current streak");
    expect(hero).not.toMatch(/>0(\.0+)?(h| days?)?</);
    expect(hero).not.toMatch(/data-count="0(\.0+)?"/);
  });

  it("marks calendar dates after the last rollup as no reading", () => {
    const d = readHistory(buildAndRoll("history"), { now: NOW });
    d.calendar = d.calendar.map((c) => (c.day === "2025-06-19" ? { ...c, activeHours: null } : c));
    const page = renderHistoryPage(d);
    expect(page).toContain("2025-06-19: no reading, after the last rollup");
    expect(page).toContain("cal-absent");
  });
});
