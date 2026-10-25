import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAndRoll, ingestAndRoll } from "./helpers/fixture-db.ts";
import { hitCount } from "./helpers/marks.ts";
import { readHistory } from "@/lib/read/history";
import { readLive } from "@/lib/read/live";
import { readPerformance, type PerformanceData } from "@/lib/read/perf";
import { readProfile } from "@/lib/read/profile";
import { readProjects } from "@/lib/read/projects";
import { readSessions } from "@/lib/read/sessions";
import { readSkills } from "@/lib/read/skills";
import { API_PRICES, CC_FIGURE, apiCostLabel, claudeCodeCostLabel, hermesCostLabel } from "@/lib/render/cost";
import { esc } from "@/lib/render/html";
import { historyView } from "@/lib/render/history";
import { renderLivePage } from "@/lib/render/live";
import { performanceView } from "@/lib/render/perf";
import { profileView } from "@/lib/render/profile";
import { projectsView } from "@/lib/render/projects";
import { sessionsView } from "@/lib/render/sessions";
import { skillsView } from "@/lib/render/skills";
import { THEMES } from "@/lib/render/theme";
import { viewPage } from "@/lib/render/layout";

// Stage 4B Task 5: cost and latency on every page, and the Performance page.
// Spec §5: every page labels the two figures "at API prices" and "Claude
// Code's figure"; with no reading it says "no reading", with nothing priced
// "not priced", and a partial one shows the priced sum and "N not priced".
// None of these ever renders $0.00, in any theme.
process.env.TZ = "UTC";

const noon = (day: string) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);
const NEXT = noon("2026-09-11");

/** The card under an `<h2>` starting with `heading`, up to its section's end. */
function cardIn(html: string, heading: string): string {
  const at = html.indexOf(`<h2>${heading}`);
  if (at < 0) throw new Error(`no card ${heading}`);
  return html.slice(at, html.indexOf("</section>", at));
}

/** The page as a browser in theme `t` holds it: the document's own theme attribute swapped. */
function inTheme(html: string, t: string): string {
  return html.replace('<html lang="en" data-theme="amber"', `<html lang="en" data-theme="${t}"`);
}

const PARTIAL = /\$[\d,]+\.\d\d · \d+ not priced/;

let two: string; // turns-mixed (09-10: all no-split) + xrun-a/-b and sent-midstream (07-10: one priced, one not)
let mixed: string; // priced-mixed: opus-5 and sonnet-5 priced, claude-mystery-9 not

beforeAll(() => {
  two = ingestAndRoll(["turns-mixed", "xrun-a", "xrun-b", "sent-midstream"]);
  mixed = buildAndRoll("priced-mixed");
});

describe("cost labels (lib/render/cost.ts)", () => {
  it("names the two figures", () => {
    expect(API_PRICES).toBe("at API prices");
    expect(CC_FIGURE).toBe("Claude Code's figure");
  });

  it("says no reading, the priced sum, the unpriced count and <$0.01 in words", () => {
    expect(apiCostLabel(null)).toBe("no reading");
    expect(apiCostLabel({ usd: 0, priced: 0, unpriced: 0 })).toBe("no reading");
    expect(apiCostLabel({ usd: 1.234, priced: 3, unpriced: 0 })).toBe("$1.23");
    expect(apiCostLabel({ usd: 1234.567, priced: 3, unpriced: 4 })).toBe("$1,234.57 · 4 not priced");
    expect(apiCostLabel({ usd: 0.0004, priced: 1, unpriced: 0 })).toBe("<$0.01");
    expect(apiCostLabel({ usd: 0.0004, priced: 1, unpriced: 2 })).toBe("<$0.01 · 2 not priced");
    expect(claudeCodeCostLabel(null)).toBe("no reading");
    expect(claudeCodeCostLabel(2.5)).toBe("$2.50");
    expect(claudeCodeCostLabel(2345.678)).toBe("$2,345.68");
  });

  it("says Hermes's own figure in words: no reading, didn't price, a real $0.00, and the unpriced count", () => {
    expect(hermesCostLabel(null)).toBe("no reading");
    expect(hermesCostLabel({ usd: 0, priced: 0, unpriced: 1 })).toBe("Hermes didn't price this");
    expect(hermesCostLabel({ usd: 0, priced: 1, unpriced: 0 })).toBe("$0.00");
    expect(hermesCostLabel({ usd: 0.5123, priced: 3, unpriced: 1 })).toBe("$0.51 · 1 unpriced by Hermes");
  });
});

describe("every page, every theme: both labels, the three states, and never $0.00", () => {
  it("renders no reading, not priced and N not priced in words wherever a cost appears", () => {
    const pages: [string, string][] = [
      // Live, on a day with no rollup row, an all-unpriced day and a partial one.
      ["live, no row", renderLivePage(readLive(two, { now: NEXT }))],
      ["live, not priced", renderLivePage(readLive(two, { now: noon("2026-09-10") }))],
      ["live, partial", renderLivePage(readLive(two, { now: noon("2026-07-10") }))],
      ["history", viewPage(historyView(readHistory(two, { now: NEXT, range: "all" })))],
      ["projects all", viewPage(projectsView(readProjects(two, { now: NEXT, range: "all" })))],
      ["projects 7d", viewPage(projectsView(readProjects(two, { now: NEXT, range: "7d" })))],
      ["sessions", viewPage(sessionsView(readSessions(two, { now: NEXT, range: "all" }), { now: NEXT }))],
      ["skills", viewPage(skillsView(readSkills(two, { now: NEXT, range: "all" })))],
      ["performance", viewPage(performanceView(readPerformance(two, { now: NEXT, range: "all" }), {}))],
    ];
    // The words each page can show on this DB. Only one model (claude-opus-5)
    // ran, partly priced; s5 is fully priced and every other session is not.
    const words: Record<string, (string | RegExp)[]> = {
      "live, no row": ["no reading"],
      "live, not priced": ["not priced"],
      "live, partial": [PARTIAL, "no reading"],
      history: ["not priced", PARTIAL, "no reading"],
      "projects all": [PARTIAL, "no reading"],
      "projects 7d": ["not priced", "no reading"],
      sessions: ["not priced"],
      skills: [PARTIAL],
      performance: [PARTIAL],
    };
    for (const t of THEMES) {
      for (const [name, page] of pages) {
        const html = inTheme(page, t);
        const where = `${name} · ${t}`;
        expect(html, where).toContain(`data-theme="${t}"`);
        expect(html, where).toContain(`[data-theme=${t}]`); // the theme's tokens ship in the page
        expect(html, where).toContain(esc(API_PRICES));
        expect(html, where).toContain(esc(CC_FIGURE));
        for (const w of words[name]) {
          if (typeof w === "string") {
            // A whole-cell state is drawn in the absent style, never as a figure.
            expect(html, `${where}: ${w}`).toMatch(new RegExp(`class="[^"]*absent[^"]*"[^>]*>${w}<`));
          } else expect(html, `${where}: ${w}`).toMatch(w);
        }
        expect(html, where).not.toContain("$0.00");
      }
    }
  });
});

// I1 (Stage 4B fix round): a status-line cost of exactly 0 is not a reading.
// zero-cost: S_Z0 (zero-proj, 2026-09-10) has one snapshot, total_cost_usd 0,
// beside a priced request; S_ZP (pos-proj, 09-11) reads 0 and then 1.25. The
// first group's Claude Code figure is "no reading" on every page -- through
// the rollup (History, Projects), snapshotDays (Live's today, Skills) and the
// per-session MAX (Sessions, Live's session) -- and the second is $1.25.
describe("a status-line cost of exactly 0 is no reading, on every page and in every theme", () => {
  it("says no reading for the group whose only reading is $0, and never $0.00", () => {
    const db = buildAndRoll("zero-cost");
    const at = noon("2026-09-11");
    /** The table row holding `needle`. */
    const rowOf = (html: string, needle: string): string => {
      const i = html.indexOf(needle);
      if (i < 0) throw new Error(`no row with ${needle}`);
      return html.slice(html.lastIndexOf("<tr>", i), html.indexOf("</tr>", i));
    };
    const ABSENT_CELL = '<td class="num"><span class="absent">no reading</span></td>';
    const ABSENT_SORT_CELL = '<td class="num" data-sort=""><span class="absent">no reading</span></td>';
    const skills = readSkills(db, { now: at, range: "all" });
    expect(skills.series.map((x) => [x.day, x.costUsd])).toEqual([["2026-09-10", null], ["2026-09-11", 1.25]]);
    const pages: [string, string, (html: string) => void][] = [
      ["live", renderLivePage(readLive(db, { now: noon("2026-09-10"), transcriptsDir: mkdtempSync(path.join(tmpdir(), "wt-none-")) })), (h) => {
        expect(h).toContain(`session cost · ${esc(CC_FIGURE)} · no reading`);
        expect(h).toContain(`<span>spend · ${esc(CC_FIGURE)}</span><b class="absent">no reading</b>`);
      }],
      ["history", viewPage(historyView(readHistory(db, { now: at, range: "all" }))), (h) => {
        const table = cardIn(h, "What drove it");
        expect(rowOf(table, "2026-09-10")).toContain(ABSENT_CELL);
        expect(rowOf(table, "2026-09-11")).toContain('<td class="num">$1.25</td>');
      }],
      ["projects", viewPage(projectsView(readProjects(db, { now: at, range: "all" }))), (h) => {
        expect(rowOf(h, ">zero-proj</span>")).toContain(ABSENT_SORT_CELL);
        expect(rowOf(h, ">pos-proj</span>")).toContain('data-sort="1.25">$1.25</td>');
      }],
      ["sessions", viewPage(sessionsView(readSessions(db, { now: at, range: "all" }), { now: at })), (h) => {
        expect(rowOf(h, 'data-sort="S_Z0"')).toContain(ABSENT_SORT_CELL);
        expect(rowOf(h, 'data-sort="S_ZP"')).toContain('data-sort="1.25">$1.25</td>');
      }],
      ["skills", viewPage(skillsView(skills)), (h) => {
        expect(h).toContain("<title>2026-09-11: $1.25</title>");
      }],
    ];
    for (const t of THEMES) {
      for (const [name, page, check] of pages) {
        const html = inTheme(page, t);
        expect(html, `${name} · ${t}`).toContain(`[data-theme=${t}]`);
        check(html);
        expect(html, `${name} · ${t}`).not.toContain("$0.00");
      }
    }
  });
});

describe("History: cost by model and the wait per turn", () => {
  it("draws one cost series per priced model", () => {
    const html = historyView(readHistory(mixed, { now: NEXT, range: "7d" })).body;
    const bar = cardIn(html, "Cost by model");
    expect(bar).toContain(esc(API_PRICES));
    const legend = [...bar.matchAll(/<span><i class="sw (s\d|s-other)"><\/i>([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
    expect(legend).toEqual([["s0", "claude-opus-5"], ["s1", "claude-sonnet-5"]]);
  });

  // Review Focus 5: a day with no measured turn is a break in the wait line,
  // never a drop to 0. Measured turns fall on 07-10 and 09-10 only.
  it("breaks the wait line on a day with no measured turn", () => {
    const html = historyView(readHistory(two, { now: NEXT, range: "90d" })).body;
    const wait = cardIn(html, "Wait per turn");
    expect(hitCount(wait)).toBe(2);
    expect(wait).not.toContain('<path class="line"');
    expect((wait.match(/class="pt-solo"/g) ?? []).length).toBe(2);
    expect(wait).toContain("a gap is a day with no measured turn");
  });

  it("puts both cost figures in the day table", () => {
    const html = historyView(readHistory(mixed, { now: NEXT, range: "7d" })).body;
    const table = cardIn(html, "What drove it");
    expect(table).toContain(`<th class="num">${esc(API_PRICES)}</th>`);
    expect(table).toContain(`<th class="num">${esc(CC_FIGURE)}</th>`);
    expect(table).toContain("$0.52 · 4 not priced");
    expect(table).toContain("$8.50");
  });
});

describe("Projects: Claude Code's figure", () => {
  it("says no reading where no session had a status-line cost reading, never $0.00", () => {
    const d = readProjects(mixed, { now: NEXT, range: "7d" });
    const html = projectsView(d).body;
    const row = html.slice(html.indexOf('<span title="') , html.indexOf("</tr>", html.indexOf('<span title="')));
    expect(row).toContain('<td class="num" data-sort=""><span class="absent">no reading</span></td>');
    expect(html).toContain(`>${esc(CC_FIGURE)}</button>`);
    expect(html).toContain(`>${esc(API_PRICES)}</button>`);
    expect(html).not.toContain("$0.00");
  });
});

describe("Models & Skills: per model at API prices", () => {
  it("says Claude Code's figure is per session and can't be split by model", () => {
    const html = skillsView(readSkills(mixed, { now: NEXT, range: "7d" })).body;
    expect(html).toContain(esc("Claude Code's figure is per session and can't be split by model."));
    const table = cardIn(html, "Models");
    for (const col of [API_PRICES, "response median", "p90", "tok/s"]) expect(table).toContain(`>${esc(col)}</button>`);
  });
});

describe("Usage Profile: hook data coverage", () => {
  it("says when hook data starts on the security card and in session hygiene's evidence", () => {
    const db = buildAndRoll("profile-event-edge");
    const before = profileView(readProfile(db, { now: noon("2026-09-17") })).body;
    expect(cardIn(before, "Security &amp; privacy discipline")).toContain("hook data starts 2026-08-20");
    expect(cardIn(before, "Session hygiene")).toContain("hook data starts 2026-08-20");
    const after = profileView(readProfile(db, { now: noon("2026-09-18") })).body;
    expect(after).not.toContain("hook data starts");
  });
});

describe("Performance page", () => {
  const SECTIONS = ["Cost by model", "Response time by model", "Wait per turn", "Cache writes", "Not priced", "Prices used"];

  it("renders its six sections in spec §5's order", () => {
    const html = performanceView(readPerformance(two, { now: NEXT, range: "all" }), {}).body;
    const at = SECTIONS.map((s) => html.indexOf(`<h2>${s}`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("shows cost and share by model, response time with its caveat, and the wait with its counts", () => {
    const html = performanceView(readPerformance(two, { now: NEXT, range: "all" }), {}).body;
    const cost = cardIn(html, "Cost by model");
    expect(cost).toContain(esc(API_PRICES));
    expect(cost).toContain(">100.0%<"); // opus-5 holds every priced dollar
    const response = cardIn(html, "Response time by model");
    expect(response).toContain("end to end, includes time to first token");
    for (const col of ["requests timed", "median", "p90", "tok/s"]) expect(response).toContain(`>${col}</button>`);
    const wait = cardIn(html, "Wait per turn");
    // Measured waits {5250, 1000, 0} on 09-10 and {3000, 3000} on 07-10:
    // sorted 0 1000 3000 3000 5250 -> median 3000, p90 = x[ceil(4.5)] = 5250.
    expect(wait).toContain("3.0 s");
    expect(wait).toContain("5.3 s");
    for (const k of ["5 measured", "1 human", "1 headless"]) expect(wait).toContain(k);
  });

  it("draws the cache-write mix as a donut of 5m and 1h tokens with their cost", () => {
    const html = performanceView(readPerformance(buildAndRoll("price-rows"), { now: NEXT, range: "7d" }), {}).body;
    const mix = cardIn(html, "Cache writes");
    expect(mix).toContain('class="chart donut"');
    expect(mix).toMatch(/5-minute writes · \$[\d.]+/);
    expect(mix).toMatch(/1-hour writes · \$[\d.]+/);
  });

  it("lists what is not priced by note and model, and the speed-absent requests priced at standard", () => {
    const html = performanceView(readPerformance(buildAndRoll("price-notes"), { now: NEXT, range: "7d" }), {}).body;
    const np = cardIn(html, "Not priced");
    for (const note of ["fast", "no-split", "unknown-model"]) expect(np).toContain(`>${note}<`);
    expect(np).toContain("claude-mystery-9");
    expect(np).toContain("1 priced at standard with no speed recorded");
  });

  // M1 (Stage 4B fix round): a known model dated before its first price row.
  // The page's data is edited, not re-rolled: this pins the words, and
  // cost-rollup.test.ts pins which requests the rollup files under the note.
  it("says what no-price-yet means: no price on or before that day", () => {
    const d = readPerformance(buildAndRoll("price-notes"), { now: NEXT, range: "7d" });
    const html = performanceView({ ...d, unpriced: [{ note: "no-price-yet", model: "claude-opus-5", n: 2 }] }, {}).body;
    expect(cardIn(html, "Not priced")).toContain("<tr><td>no-price-yet</td><td>claude-opus-5</td><td class=\"num\">2</td></tr>");
    expect(cardIn(html, "How these are measured")).toContain("no-price-yet has a price row, but no price on or before that day");
  });

  it("shows the prices it used, read from claude_prices, with their verified date and source", () => {
    const d = readPerformance(two, { now: NEXT, range: "all" });
    const prices = cardIn(performanceView(d, { served: true }).body, "Prices used");
    expect((prices.match(/<tr>/g) ?? []).length).toBe(1 + d.prices.length); // head + 11 rows
    expect(prices).toContain(`<a href="${esc(d.prices[0].source)}"`);
    expect(prices).toContain(d.prices[0].verifiedOn);
    // The report names no address outside itself: the source is text, without its scheme.
    const report = cardIn(performanceView(d, {}).body, "Prices used");
    expect(report).toContain(esc(d.prices[0].source.replace(/^https?:\/\//, "")));
    expect(report).not.toMatch(/href=|https?:\/\//);
    // The rates come from the data: a row edited in the data is what the page shows.
    const edited = { ...d, prices: [{ ...d.prices[0], model: "fx-model", input: 7.77 }] };
    const html = cardIn(performanceView(edited, {}).body, "Prices used");
    expect(html).toContain("fx-model");
    expect(html).toContain("$7.77");
  });

  it("says no reading in every section over an empty range, and draws no chart", () => {
    const d = readPerformance(two, { now: noon("2026-12-01"), range: "7d" });
    const html = performanceView(d, {}).body;
    for (const s of SECTIONS.slice(0, 5)) expect(cardIn(html, s), s).toContain("no reading");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("$0.00");
    const bare: PerformanceData = { ...d, prices: [] };
    expect(cardIn(performanceView(bare, {}).body, "Prices used")).toContain("no reading");
  });
});
