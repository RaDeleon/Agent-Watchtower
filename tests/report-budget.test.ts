/**
 * The report's size over time (Stage 3D fix wave, I4).
 *
 * The `all` range grew by a day's worth of marks every day, and the only size
 * guard was a multiple of a three-day fixture, which cannot see growth. Past
 * 90 days every per-day series is now drawn one point per ISO week; these
 * tests pin that on a synthetic year and two years of history, and pin what
 * one more day costs the report.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { applyWtSchema } from "@/lib/core/schema";
import { roll, seedAgents, type SeedSession } from "./helpers/agent-seed.ts";
import { buildAndRoll, rows } from "./helpers/fixture-db.ts";
import { hitCount as hits } from "./helpers/marks.ts";
import { readHistory } from "@/lib/read/history.ts";
import { readProfile } from "@/lib/read/profile.ts";
import { readProjects } from "@/lib/read/projects.ts";
import { readSkills } from "@/lib/read/skills.ts";
import { WEEKLY_OVER_DAYS, bucketName, buckets, meanOf, sumOf, weekOf } from "@/lib/read/range.ts";
import { renderHistoryPage } from "@/lib/render/history.ts";
import { renderProfilePage } from "@/lib/render/profile.ts";
import { renderProjectsPage } from "@/lib/render/projects.ts";
import { REPORT_BUDGET_BYTES, budgetWarning } from "@/lib/render/report.ts";
import { renderSkillsPage } from "@/lib/render/skills.ts";
import { grouped } from "@/lib/render/html.ts";
import { buildReport } from "@/lib/views.ts";
import { slow } from "./helpers/timeout";

process.env.TZ = "UTC";

const BASE = 1750000000; // Sun 2025-06-15 (UTC)
const DAY = 86400;
/** Mid-morning of the last fixture day: every session is in the past. */
const nowAfter = (days: number) => BASE + (days - 1) * DAY + 7200;
const CONFIGURED = { claude: { enabled: true } };

const days = (from: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * DAY * 1000).toISOString().slice(0, 10));

/** The card under an `<h2>` starting with `heading`, up to its section's end. */
const cardIn = (html: string, heading: string) => {
  const at = html.indexOf(`<h2>${heading}`);
  if (at < 0) throw new Error(`no card ${heading}`);
  return html.slice(at, html.indexOf("</section>", at));
};

describe("weekly buckets", () => {
  it("starts a week on Monday", () => {
    expect(weekOf("2025-06-15")).toBe("2025-06-09"); // a Sunday ends its week
    expect(weekOf("2025-06-16")).toBe("2025-06-16");
    expect(weekOf("2026-01-01")).toBe("2025-12-29"); // across a year
  });

  it("keeps days up to 90, and groups by week past it, first and last weeks partial", () => {
    const ninety = buckets(days("2025-06-15", WEEKLY_OVER_DAYS));
    expect(ninety.weekly).toBe(false);
    expect(ninety.buckets).toHaveLength(90);
    const over = buckets(days("2025-06-15", WEEKLY_OVER_DAYS + 1));
    expect(over.weekly).toBe(true);
    expect(over.buckets[0]).toEqual({ label: "2025-06-15", days: ["2025-06-15"], week: true });
    expect(over.buckets[1].days).toEqual(days("2025-06-16", 7));
    expect(over.buckets.flatMap((b) => b.days)).toEqual(days("2025-06-15", 91));
    expect(over.buckets.at(-1)!.days).toHaveLength(6); // 06-15 + 12 full weeks + Mon..Sat
    expect(bucketName(over.buckets[1])).toBe("week of 2025-06-16 to 2025-06-22");
    expect(bucketName(over.buckets[0])).toBe("week of 2025-06-15, 1 day in range");
    expect(bucketName(ninety.buckets[0])).toBe("2025-06-15");
  });

  it("sums and averages readings only, and says null when there are none", () => {
    expect(sumOf([1, null, 2, undefined])).toBe(3);
    expect(sumOf([null, undefined])).toBeNull();
    expect(sumOf([0])).toBe(0);
    expect(meanOf([10, null, 20])).toEqual({ mean: 15, of: 2 });
    expect(meanOf([null])).toBeNull();
  });
});

describe("the report over a long history", () => {
  let year: string;
  let twoYears: string;
  beforeAll(() => {
    year = buildAndRoll("long-history-365");
    twoYears = buildAndRoll("long-history-730");
  });

  // 15s for the reason given on the next test: it timed out at the default 5s
  // twice in full parallel runs during the Stage 4B fix round, never alone.
  it("stays under the report budget with a year of history", () => {
    const html = buildReport({ db: year, now: nowAfter(365), configured: CONFIGURED, tz: "UTC" });
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(REPORT_BUDGET_BYTES);
    expect(budgetWarning(Buffer.byteLength(html, "utf8"))).toBeNull();
  }, slow(15000));

  // One more day of history costs about a seventh of a bucket per chart.
  // Measured: 247 bytes a day from the first year to the second. Drawn daily,
  // it was 1,475, and the year alone was 1,040,227 bytes, over budget.
  //
  // Explicit 15s timeout (default is 5s): building two reports over a year and
  // two years of history is CPU-bound (~1.7s in isolation), and Stage 4A's
  // profile rebuild (capture/rollup.sh) now runs on every buildAndRoll() call
  // in this suite's beforeAll, adding modest but real aggregate CPU load
  // across the ~110 other buildAndRoll() calls in the full parallel run. That
  // was enough, under full-suite worker contention, to occasionally push this
  // specific assertion past the default timeout despite the assertion itself
  // always passing well under 400. Isolate: `npx vitest run
  // tests/report-budget.test.ts` never needed the extra headroom.
  it("grows by under 400 bytes per day of history, a year on", () => {
    const a = Buffer.byteLength(buildReport({ db: year, now: nowAfter(365), configured: CONFIGURED, tz: "UTC" }), "utf8");
    const b = Buffer.byteLength(buildReport({ db: twoYears, now: nowAfter(730), configured: CONFIGURED, tz: "UTC" }), "utf8");
    expect((b - a) / 365).toBeLessThan(400);
  }, slow(15000));

  it("draws History's all-time series by week, each week summed or averaged from its days", () => {
    const d = readHistory(year, { now: nowAfter(365), range: "all" });
    const weeks = buckets(d.span).buckets;
    expect(weeks.length).toBe(53);
    const html = renderHistoryPage(d);

    const idle = cardIn(html, "Active vs idle");
    expect(hits(idle)).toBe(weeks.length);
    expect(idle).toContain("hours per week");
    // An independent sum of the stored rows for one full week.
    const [w] = rows<{ a: number; i: number }>(year,
      `SELECT SUM(active_ms) / 3600000.0 AS a, SUM(idle_ms) / 3600000.0 AS i FROM claude_daily_rollups
       WHERE day BETWEEN '2025-06-16' AND '2025-06-22';`);
    expect(idle).toContain(`<title>week of 2025-06-16 to 2025-06-22: ${w.a.toFixed(1)}h active, ${w.i.toFixed(1)}h idle</title>`);

    const ctx = cardIn(html, "Average context");
    expect(hits(ctx)).toBe(weeks.length);
    expect(ctx).toContain("average context used per week");
    expect(ctx).toMatch(/<title>week of 2025-06-16 to 2025-06-22: [\d.]+% of the window, the mean of 7 days with a reading<\/title>/);

    const hyg = cardIn(html, "Hygiene");
    expect(hits(hyg)).toBe(weeks.length);
    expect(hyg).toContain("weekly hygiene");
    expect(hyg).toContain("Each point is the mean of that week's scored days");

    const cost = cardIn(html, "Cumulative cost");
    expect(hits(cost)).toBe(weeks.length);
    expect(cost).toContain("at each week&#39;s end");
  });

  it("draws Models & Skills' all-time series, mix and cache trend by week", () => {
    const d = readSkills(year, { now: nowAfter(365), range: "all" });
    const weeks = buckets(d.series.map((x) => x.day)).buckets.length;
    const html = renderSkillsPage(d);
    const hero = cardIn(html, "Requests, tokens and cost per week");
    expect(hits(hero)).toBe(3 * weeks);
    expect(hero).toContain("<title>week of 2025-06-16 to 2025-06-22: 21 requests</title>"); // 3 a day
    expect(hits(cardIn(html, "Model mix"))).toBe(weeks);
    expect(cardIn(html, "Model mix")).toContain("requests per week by model");

    // The rollup's formula over the week's summed tokens, not a mean of days.
    const cache = cardIn(html, "Cache hit rate");
    expect(hits(cache)).toBe(weeks);
    const [c] = rows<{ pct: number }>(year,
      `SELECT 100.0 * SUM(tokens_cache_read) / SUM(tokens_cache_read + tokens_cache_creation) AS pct
       FROM claude_daily_rollups WHERE day BETWEEN '2025-06-16' AND '2025-06-22';`);
    expect(cache).toContain(`<title>week of 2025-06-16 to 2025-06-22: ${c.pct.toFixed(1)}%</title>`);
  });

  it("draws the Projects sparklines by week", () => {
    const d = readProjects(year, { now: nowAfter(365), range: "all" });
    const html = renderProjectsPage(d);
    expect(html).toContain("active hours per week, all time");
    expect(html).not.toContain("active hours per day, all time");
    // One path point per week: 53 weeks, one run, so 52 " L" joins.
    const spark = html.match(/<svg class="spark"[^]*?<\/svg>/)![0];
    expect((spark.match(/ L/g) ?? []).length).toBe(52);
  });

  // Stage 4A's page: included in the report (buildReport walks STATIC_VIEWS),
  // and its "Total over time" chart is the same per-day-then-per-week series
  // as History's, so it is covered by the same budget guard above.
  it("includes the Usage Profile section, and draws its history by week past 90 days", () => {
    const html = buildReport({ db: year, now: nowAfter(365), configured: CONFIGURED, tz: "UTC" });
    expect(html).toContain('<article class="view" id="profile">');
    expect(html).toContain("<h2>Usage ladder</h2>");
    expect(html).toContain("<h2>Matrix score</h2>");

    const d = readProfile(year, { now: nowAfter(365), range: "all" });
    const weeks = buckets(d.history.map((h) => h.day)).buckets.length;
    const page = renderProfilePage(d);
    const total = cardIn(page, "Total over time");
    expect(hits(total)).toBeLessThanOrEqual(weeks);
    // buildReport reads every view in four ranges; the Overview made it pass 5s under full-suite load.
  }, slow(15000));

  // Stage 4B: the Performance page is a ranged view in STATIC_VIEWS, so the
  // report walks it like the others -- one body per range -- and a year of
  // history with it still fits the budget.
  it("includes the Performance section, and a year of history with it stays under budget", () => {
    const html = buildReport({ db: year, now: nowAfter(365), configured: CONFIGURED, tz: "UTC" });
    expect(html).toContain('<article class="view" id="performance">');
    expect(html).toContain('<a href="#performance">Performance</a>');
    expect(html).toContain("<h2>Prices used</h2>");
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(REPORT_BUDGET_BYTES);
  }, slow(15000));

  // M12: the running total starts its axis at what was spent before the
  // window opened, so a month's rise is not a flat line along the top.
  it("starts the cumulative cost axis at the spend before the range", () => {
    const d = readHistory(year, { now: nowAfter(365), range: "30d" });
    const [{ before }] = rows<{ before: number }>(year,
      `SELECT SUM(cost_usd) AS before FROM claude_daily_rollups WHERE day < '${d.rangeFrom}';`);
    const cost = cardIn(renderHistoryPage(d), "Cumulative cost");
    const ticks = [...cost.matchAll(/<text class="tick" x="42" y="[\d.]+" text-anchor="end">([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(before).toBeGreaterThan(0);
    expect(ticks[1]).toBe(`$${grouped(before)}`); // the bottom tick, in the chart's own format
  });

  it("keeps a 90-day range daily", () => {
    const html = renderHistoryPage(readHistory(year, { now: nowAfter(365), range: "90d" }));
    expect(hits(cardIn(html, "Active vs idle"))).toBe(90);
    expect(cardIn(html, "Active vs idle")).toContain("hours per day");
  });
});

// Stage 4B fix round, I3. The year above is one session, one project and
// three models a day, and the report stayed inside its budget on it while the
// live database, projected to a year, crossed 1 MB. `density-N` is N days at
// live-like per-day cardinality (four sessions in four of twelve projects,
// twelve requests over six priced models, four skills), ending Sunday
// 2026-09-27; 182 to 270 days is 88 days that every `all`-range chart and the
// year calendar draw and the 7d, 30d and 90d ranges do not. What each page
// costs per week of such history is pinned below.
//
// Measured, bytes per week (density-182 -> density-270):
//            9deabcc  after the trim
//   total      3,952     2,883
//   history    2,382     1,852
//   skills     1,283       807
//   profile      174       135
//   projects     113        90
// and 0 or -1 on Sessions, Performance and Sources, which draw no history.
// Stage 5 Task 7 adds the Overview: 156 B/week measured (its weekly stacked
// bar of active hours by tool, Claude-only on these fixtures), pinned at +15%
// rounded up to the next 10. `total` already had room for it.
// Final-review I1: the fixture now carries one Codex and one Hermes session a day
// (two requests each). Measured, B/week: codex 1,397 and hermes 1,394 (4,371 and
// 4,132 before the sessions tables were cut to REPORT_ROWS in the report), the
// Overview 208 (three tools in its stacked bar), total 5,883; each pinned at
// +15% rounded up to the next 10: 1,610, 1,610, 240 and 6,770.
// Stage 6 adds Character: 5 B/week measured (its level-up log is cut to 30 in the
// report and its tables to REPORT_ROWS, so it is flat), pinned at 50, the floor.
// Its fix wave (sub-skill time under an hour as minutes and seconds) re-measured
// it: 23,942 B on density-182 and 24,002 B on density-270, +3 B on each, so
// still 5 B/week.
// Stage 7 tags density's j = 2 request, so every session carries skill time,
// and Character gains Skill use (tile, section, two tables cut to REPORT_ROWS):
// 2 B/week and 5,885 B/week total measured; the pins hold.
// Stage 8 adds Quests: 271 B/week measured (its quest log grows a row a week,
// three quests on each of density's weeks; it is cut to REPORT_ROWS in the
// report, so it flattens after 60 weeks), pinned at +15% rounded up to the
// next 10: 320. Total 6,156 B/week measured; its pin holds.
// The limits sit between the two columns; 9deabcc's rendering fails five of them.
describe("the report's growth at live density", () => {
  const PER_WEEK_LIMIT: Record<string, number> = {
    total: 6770,
    overview: 240,
    history: 2050,
    skills: 900,
    profile: 155,
    projects: 100,
    sessions: 50,
    performance: 50,
    character: 50,
    quests: 320,
    codex: 1610,
    hermes: 1610,
    sources: 50,
  };
  const NOW = Math.floor(Date.parse("2026-09-27T22:00:00Z") / 1000);
  const pages = (html: string) => {
    const out: Record<string, number> = { total: Buffer.byteLength(html, "utf8") };
    for (const p of html.split(/(?=<article class="view" id=")/).slice(1)) {
      const id = p.match(/^<article class="view" id="([^"]+)"/)![1];
      out[id] = Buffer.byteLength(p.slice(0, p.indexOf("</article>") + "</article>".length), "utf8");
    }
    return out;
  };

  // Final-review I1: the density fixture held only Claude, so codex and hermes
  // measured 0 B/week against a pin of 50 and the live report crossed its
  // budget unseen. One Codex and one Hermes session a day, two requests each,
  // on the days the fixture covers, registered as synced.
  const withAgents = (n: number) => {
    const db = buildAndRoll(`density-${n}`);
    const start = Date.parse("2026-09-27T00:00:00Z") / 1000 - (n - 1) * 86400;
    const sessions: SeedSession[] = [];
    for (let i = 0; i < n; i++) {
      const t = start + i * 86400 + 36000;
      for (const source of ["codex", "hermes"] as const) {
        sessions.push({
          source, id: `${source}-${i}`, entry: source === "codex" ? "Codex Desktop" : "cli", driven: 1, startedAt: t, cwd: `/work/dn-${i % 12}`,
          events: [[t, "session_start"], [t + 5, "prompt"], [t + 60, "stop"], [t + 90, "session_end"]],
          requests: [
            { id: `${source}-${i}-a`, ts: t + 10, model: source === "codex" ? "gpt-5.5" : "claude-opus-5", tin: 900 + i, tout: 120, tcr: 4000, cost: source === "hermes" ? 0.05 : null },
            { id: `${source}-${i}-b`, ts: t + 40, model: source === "codex" ? "gpt-5.4" : "claude-sonnet-5", tin: 400, tout: 60, tcr: 2000, cost: source === "hermes" ? 0.02 : null },
          ],
        });
      }
    }
    seedAgents(db, sessions);
    applyWtSchema(db);
    for (const s of ["codex", "hermes"]) {
      execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO wt_ingest_state (source, last_run_at, last_ok_at, health) VALUES ('${s}', ${NOW}, ${NOW}, 'ok');`]);
    }
    roll(db);
    return db;
  };

  it("costs each page no more than its pinned bytes per week of history", () => {
    const [a, b] = [182, 270].map((n) =>
      pages(buildReport({ db: withAgents(n), now: NOW, configured: CONFIGURED, tz: "UTC" })));
    expect(Object.keys(b).sort()).toEqual(Object.keys(PER_WEEK_LIMIT).sort());
    const perWeek = Object.fromEntries(Object.keys(b).map((k) => [k, Math.round((b[k] - a[k]) / (88 / 7))]));
    const over = Object.entries(PER_WEEK_LIMIT)
      .filter(([page, limit]) => perWeek[page] > limit)
      .map(([page, limit]) => `${page}: ${perWeek[page]} B/week, over ${limit}`);
    expect(over).toEqual([]);
  }, slow(30000));
});
