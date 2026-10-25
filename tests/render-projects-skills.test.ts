import { describe, expect, it } from "vitest";
import { buildAndRoll } from "./helpers/fixture-db.ts";
import { hasSeg, hitCount } from "./helpers/marks.ts";
import { readProjects, type ProjectSummary, type ProjectsData } from "@/lib/read/projects";
import { readSkills, type SkillsData, type TokenTotals } from "@/lib/read/skills";
import { renderProjectsPage } from "@/lib/render/projects";
import { renderSkillsPage, skillsView } from "@/lib/render/skills";
import { stackedBar } from "@/lib/render/charts";

process.env.TZ = "UTC";

const BASE = 1750000000;
const NOW = BASE + 2 * 86400 + 1000;

const db = buildAndRoll("dashboard", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });

describe("Projects page, on the `dashboard` fixture", () => {
  const html = renderProjectsPage(readProjects(db, { now: NOW }));

  it("never names an excluded path or its branch", () => {
    expect(html).not.toContain("skipme");
    expect(html).not.toContain("secret");
    expect(html).not.toContain("(excluded)");
  });

  // The figures themselves are the reader's guard; this pins the format.
  it("shows lines added and removed", () => {
    expect(html).toMatch(/<span class="add">\+\d+<\/span> <span class="del">−\d+<\/span>/);
  });

  it("prints no price and no line count where there is no measurement", () => {
    const unfiled = html.slice(html.indexOf('<span title="(unfiled)">'));
    const row = unfiled.slice(0, unfiled.indexOf("</tr>"));
    expect(row).toContain('title="no active time">—');
    expect(row).toContain("no reading");
  });

  it("draws a sparkline per project and the repos donut", () => {
    // (unfiled) is tracked and had no active time: a real 0, so a flat line.
    expect(html.match(/<svg class="spark"/g)?.length).toBe(3);
    expect(html).toContain("active hours by project since 2025-05-19");
  });

  it("breaks tokens down by branch, a missing branch labelled as such", () => {
    expect(html).toContain("feature/x");
    expect(html).toContain('<td class="absent">(no branch)</td>');
  });

  it("links Projects in the nav as the current page, and does not poll", () => {
    expect(html).toContain('<a href="/projects" aria-current="page">Projects</a>');
    // The client script is on every page; the poll is its only fetch.
    expect(html).not.toContain("fetch(");
    expect(html).not.toContain("/api/live");
  });
});

// M11: `(unfiled)` is a non-answer, like "unknown": its donut slice is neutral,
// and it does not use up a categorical colour.
describe("Projects page: the repos donut", () => {
  it("draws (unfiled) neutral, never in a project's colour", () => {
    const d: ProjectsData = {
      generatedAt: NOW, today: "2025-06-17", range: "30d", projects: [], branches: [],
      recentShare: [{ key: "(unfiled)", label: "(unfiled)", activeHours: 3 }, { key: "/a/site", label: "site", activeHours: 2 }],
      recentFrom: "2025-05-19", sessionsWithLines: 0, terminals: [], lastRollup: null,
    };
    const html = renderProjectsPage(d);
    expect(html).toContain('<td><i class="sw s-other"></i>(unfiled)</td>');
    expect(html).toContain('<td><i class="sw s0"></i>site</td>');
  });
});

describe("Projects page: empty database is a named case", () => {
  const empty: ProjectsData = {
    generatedAt: NOW, today: "2025-06-17", range: "30d", projects: [], branches: [], recentShare: [],
    recentFrom: "2025-05-19", sessionsWithLines: 0, terminals: [], lastRollup: null,
  };
  const html = renderProjectsPage(empty);
  it("renders deliberate empty states, not an empty table", () => {
    expect(html).toContain("no project activity in the last 30 days");
    expect(html).toContain("no active time in the last 30 days");
    expect(html).toContain("no requests in the last 30 days");
    expect(html).not.toContain("<table");
  });
});

describe("Projects page: honesty cases the fixture reader cannot reach", () => {
  const row = (key: string, label: string, over: Partial<ProjectSummary> = {}): ProjectSummary => ({
    key, label, activeHours: 1, windowHours: 1, sessions: 2, prompts: 2, costUsd: 3, costPerActiveHour: 3,
    apiCost: { usd: 2.25, priced: 5, unpriced: 0 },
    tokensIn: 1, tokensOut: 1, tokensCacheRead: 1, tokensCacheCreation: 1, linesAdded: 0, linesRemoved: 0,
    recent: [1], ...over,
  });
  const html = renderProjectsPage({
    generatedAt: NOW, today: "2025-06-17", range: "30d", recentFrom: "2025-05-19", sessionsWithLines: 0, terminals: [], lastRollup: null, branches: [],
    projects: [
      row("/a/one/site", "site"),
      row("/a/two/site", "site"),
      row("/a/gone", "gone", { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheCreation: 0 }),
      row("/a/half", "half", { linesAdded: 12, linesRemoved: null }),
    ],
    recentShare: [],
  });

  it("tells two repos with one basename apart", () => {
    expect(html).toContain(">one/site</span></td>");
    expect(html).toContain(">two/site</span></td>");
  });

  // Sessions with no transcript left to read: the rollup stores 0 tokens.
  it("shows no token figure, not 0, for sessions whose transcripts are gone", () => {
    const gone = html.slice(html.indexOf('<span title="/a/gone">'));
    expect(gone.slice(0, gone.indexOf("</tr>"))).toContain('title="no transcript left to read">—');
  });

  it("prints a genuine 0 lines reading as 0", () => {
    expect(html).toContain('<span class="add">+0</span>');
  });

  // M7: one side NULL must render as absent on its own, not as a measured 0.
  it("renders a missing side of the lines cell as absent, never −0", () => {
    const half = html.slice(html.indexOf('<span title="/a/half">'));
    const cell = half.slice(0, half.indexOf("</tr>"));
    expect(cell).toContain('<span class="add">+12</span>');
    expect(cell).toContain('<span class="del absent" title="no removed-line count reported">−—</span>');
    expect(cell).not.toContain("−0");
  });

  // I4: the footer is dated, so a rollup days old cannot read as today's.
  it("dates the rollup in the footer", () => {
    const dated = renderProjectsPage({
      generatedAt: NOW, today: "2025-06-17", range: "30d", recentFrom: "2025-05-19", sessionsWithLines: 0,
      terminals: [], lastRollup: 1750000150, branches: [], projects: [], recentShare: [],
    }, { tz: "America/Los_Angeles" });
    expect(dated).toContain("rollup 2025-06-15 08:09:10 PDT");
  });
});

describe("Skills page, on the `dashboard` fixture", () => {
  const html = renderSkillsPage(readSkills(db, { now: NOW }));

  it("declares itself Claude-specific", () => {
    expect(html).toContain("Claude-specific: every figure is read from claude_requests");
  });

  // The last-30-days row: the all-time row's figures are the reader's guard.
  it("frames fresh against cache against total", () => {
    expect(html).toMatch(/<td>last 30 days<\/td><td class="num">7<\/td><td class="num">183<\/td><td class="num">145<\/td><td class="num">1\.9k<\/td><td class="num">12\.8k<\/td><td class="num">15\.1k<\/td><td class="num">93\.0%<\/td>/);
  });

  it("breaks the cache trend where there was no cache traffic", () => {
    const start = html.indexOf("<h2>Cache hit rate");
    const chart = html.slice(start, html.indexOf("</figure>", start));
    expect(chart).toContain("2 of 30 days measured");
    // 06-15 and 06-16 are one run; 06-17 has requests but no cache traffic and
    // must not be drawn down to 0.
    expect(chart.match(/<path class="line"/g)?.length).toBe(1);
    expect(chart).not.toContain("pt-solo");
    expect(chart).not.toMatch(/ 158\.0(?= |")/); // the y of a 0: PAD_T + plot height
  });

  it("shows the leaderboards, the model mix and the API errors", () => {
    expect(html).toContain("fx-skill");
    expect(html).toContain("<td>fx-mcp</td><td>search</td>");
    expect(html).toContain("fx-plugin");
    expect(html).toContain("claude-haiku-4-5");
    expect(html).toContain("<td>529</td>");
  });

  it("links Models & Skills in the nav as the current page", () => {
    expect(html).toContain('<a href="/skills" aria-current="page">Models &amp; Skills</a>');
  });
});

describe("Skills page: empty database is a named case", () => {
  const zero: TokenTotals = { requests: 0, fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, cacheHitPct: null };
  const board = { rows: [], more: 0, attributed: 0 };
  const empty: SkillsData = {
    generatedAt: NOW, today: "2025-06-17", recentFrom: "2025-05-19",
    allTime: zero, recent: zero, skills: board, mcpServers: board, plugins: board,
    mainThread: zero, subagents: zero, models: [],
    modelMix: [{ day: "2025-06-17", requests: [] }],
    cacheTrend: [{ day: "2025-06-17", pct: null, read: 0, write: 0 }],
    apiErrors: { total: 0, byStatus: [], firstTs: null, lastTs: null },
    range: "30d", modelShare: [], modelTable: [], effort: [],
    series: [{ day: "2025-06-17", requests: null, tokensOut: null, costUsd: null }],
  };
  const html = renderSkillsPage(empty);
  it("renders empty states and no-reading cache, never a 0% hit rate", () => {
    expect(html).toContain("no cache readings in the last 30 days");
    expect(html).toContain("no request attributed to a skill yet");
    expect(html).toContain("no requests in the last 30 days");
    expect(html).toContain("No request recorded an API error.");
    expect(html).not.toContain("0.0%");
  });
});

// Task 4: Models & Skills parity, as cards.
describe("Models & Skills page: the time series hero, shares, model table and effort", () => {
  const d = readSkills(db, { now: NOW });
  const html = renderSkillsPage(d);
  const cardAt = (h2: string) => {
    const at = html.indexOf(`<h2>${h2}`);
    return html.slice(at, html.indexOf("</section>", at));
  };

  it("makes the time series the one hero, with a Requests / Tokens / Cost toggle", () => {
    expect(html.match(/class="c hero/g)).toHaveLength(1);
    expect(html).toContain('<section class="c hero wide"><h2>Requests, tokens and cost per day · last 30 days</h2>');
    const hero = cardAt("Requests, tokens and cost per day");
    expect(hero).toContain('<div class="metrics" data-metrics>');
    expect([...hero.matchAll(/data-metric-to="(\w+)" aria-pressed="(true|false)"/g)].map((m) => [m[1], m[2]]))
      .toEqual([["requests", "true"], ["tokens", "false"], ["cost", "false"]]);
    expect([...hero.matchAll(/<div data-metric="(\w+)"( hidden)?>/g)].map((m) => [m[1], m[2] ?? ""]))
      .toEqual([["requests", ""], ["tokens", " hidden"], ["cost", " hidden"]]);
    // The headline: requests counted up, cost from the rollup.
    expect(hero).toContain('<div class="big" data-count="7">7</div>');
    // I1: 06-17 has a row and no cost reading, so it is not counted as one.
    expect(hero).toContain("cost · 2 of 30 days with a cost reading");
    expect(hero).not.toContain("rolled up");
  });

  // M1: the hero and the mix are full-width, so they get a full-width viewBox.
  it("draws the full-width charts on a full-width viewBox", () => {
    expect(cardAt("Requests, tokens and cost per day")).toContain('viewBox="0 0 1440 220"');
    expect(cardAt("Model mix")).toContain('viewBox="0 0 1440 200"');
  });

  it("tips every bucket with a reading, and leaves a day with no row as a gap", () => {
    const hero = cardAt("Requests, tokens and cost per day");
    expect(hero).toContain("<title>2025-06-15: 3 requests</title>");
    expect(hero).toContain("<title>2025-06-16: 9,521 output tokens</title>");
    expect(hero).not.toContain("<title>2025-06-14");
    const requests = hero.slice(hero.indexOf('<div data-metric="requests"'), hero.indexOf('<div data-metric="tokens"'));
    expect(hitCount(requests)).toBe(3); // 06-15, 06-16, 06-17
  });

  it("draws request-share and output-token-share donuts by model", () => {
    expect(cardAt("Request share · last 30 days")).toContain('<title>claude-opus-5: 4</title>');
    // Ranked by output, so sonnet (5.0k) leads the token donut.
    const out = cardAt("Output-token share · last 30 days");
    expect(out.indexOf("claude-opus-5")).toBeLessThan(out.indexOf("claude-sonnet-5"));
    expect(out).toContain('<i class="sw s0"></i>claude-opus-5');
  });

  // Stage 4B: cost at API prices, response median / p90 and tok/s per model.
  it("tables models sortably, with cost at API prices, response time and tok/s, and no error rate", () => {
    const t = cardAt("Models · last 30 days");
    expect(t).toContain('<table class="sortable">');
    const heads = [...t.matchAll(/<button type="button" class="th-sort">([^<]*)<\/button>/g)].map((m) => m[1]);
    // I2: no per-model error rate -- every real API error is a <synthetic> request.
    expect(heads).toEqual([
      "model", "requests", "share", "in + out", "output", "cache hit", "at API prices", "response median", "p90", "tok/s",
    ]);
    expect(heads.join(" ")).not.toMatch(/error/i);
    expect(t).not.toContain("arrive in Stage 4");
    expect(t).toContain("Claude Code&#39;s figure is per session and can&#39;t be split by model.");
    expect(t).toContain("There is no error rate per model");
    // M6: the rollup's formula, read / (read + write): opus 860 / 920.
    expect(t).toContain('<td class="num" data-sort="93.48">93.5%</td>');
  });

  it("shows a model with no cache traffic as no reading, sorting last -- never 0%", () => {
    const late = renderSkillsPage(readSkills(db, { now: BASE + 8 * 86400, range: "7d" }));
    const at = late.indexOf("<h2>Models · last 7 days");
    const t = late.slice(at, late.indexOf("</section>", at));
    expect(t).toContain('<td class="num" data-sort=""><span class="absent" title="no cache read or write">no reading</span></td>');
    expect(t).not.toContain(">0.0%<");
  });

  it("draws the effort mix with not recorded as its own neutral slice", () => {
    const e = cardAt("Effort mix · last 30 days");
    expect(e).toContain('<i class="sw s-other"></i>not recorded');
    expect(e).toContain('<i class="sw s0"></i>high');
    expect(e).toContain('<i class="sw s1"></i>medium');
  });

  it("keeps the leaderboards, main thread and API errors lifetime, and says so", () => {
    for (const h of ["Skills · all time", "Plugins · all time", "MCP servers · all time", "Subagents vs main thread · all time", "API errors · all time"]) {
      expect(html).toContain(`<h2>${h}</h2>`);
    }
    expect(html).toContain('class="comp" role="img" aria-label="token composition, last 30 days"');
  });

  it("builds its body from its pieces, and names the range in every ranged heading", () => {
    const v = skillsView(readSkills(db, { now: NOW, range: "7d" }));
    expect(v.sections!.join("")).toBe(v.body);
    for (const h of ["Request share", "Output-token share", "Models", "Effort mix", "Cache hit rate", "Model mix"]) {
      expect(v.body).toContain(`<h2>${h} · last 7 days</h2>`);
    }
  });

  // Review Focus 2: a range with no data names its empty state; the hero never
  // shows a 0 as a measurement and nothing counts up from 0.
  it("renders an empty range as named empty states, with no hero 0", () => {
    const e = renderSkillsPage(readSkills(db, { now: NOW + 100 * 86400, range: "7d" }));
    const at = e.indexOf("<h2>Requests, tokens and cost per day");
    const hero = e.slice(at, e.indexOf("</section>", at));
    expect(hero).toContain("no requests in the last 7 days");
    expect(hero).not.toContain("data-count");
    expect(hero).not.toMatch(/>0</);
    for (const t of ["Request share", "Models", "Effort mix"]) {
      const c = e.slice(e.indexOf(`<h2>${t} · last 7 days`));
      expect(c.slice(0, c.indexOf("</section>"))).toContain("no requests in the last 7 days");
    }
  });
});

describe("remainder slices are neutral, never an alarm colour", () => {
  it("draws others and unknown in s-other, and named slices from s0 without skipping", () => {
    const d = readSkills(db, { now: NOW });
    const many = { ...d, modelShare: ["a", "b", "c", "d", "e", "f", "(unknown)"].map((m, i) => ({ model: m, requests: 70 - i, tokensOut: 70 - i })) };
    const html = renderSkillsPage(many);
    const at = html.indexOf("<h2>Request share");
    const c = html.slice(at, html.indexOf("</section>", at));
    expect([...c.matchAll(/<i class="sw (s[\w-]+)"><\/i>([^<]+)</g)].map((m) => `${m[1]} ${m[2]}`)).toEqual([
      "s0 a", "s1 b", "s2 c", "s3 d", "s4 e", "s-other 2 other models",
    ]);
    expect(c).not.toContain("s5");
  });

  it("keeps a remainder series in the model mix neutral too", () => {
    const html = stackedBar({ columns: [{ label: "d", parts: [1, 2, 3] }], series: ["a", "b", "2 others"], other: true, label: "x" });
    expect(hasSeg(html, "s-other")).toBe(true);
    expect(html).toContain('<i class="sw s-other"></i>2 others');
  });
});
