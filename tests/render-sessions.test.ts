import { describe, expect, it } from "vitest";
import { buildAndRoll } from "./helpers/fixture-db.ts";
import { readProjects } from "@/lib/read/projects";
import { readSessions, type SessionRow, type SessionsData } from "@/lib/read/sessions";
import { sortableTable } from "@/lib/render/charts";
import { projectsView, renderProjectsPage } from "@/lib/render/projects";
import { REPORT_ROWS, renderSessionsBody, sessionsView } from "@/lib/render/sessions";

process.env.TZ = "UTC";

const BASE = 1750000000;
const DAY = 86400;
const NOW = BASE + 2 * DAY + 1000;

/** Every `<td>` of the first body row: its data-sort and its content. */
function cells(html: string, rowIndex = 0): { sort: string; html: string }[] {
  const body = html.slice(html.indexOf("<tbody>"));
  const row = body.split("<tr>")[rowIndex + 1];
  return [...row.matchAll(/<td[^>]*? data-sort="([^"]*)">(.*?)<\/td>/g)].map((m) => ({ sort: m[1], html: m[2] }));
}

const row = (over: Partial<SessionRow> = {}): SessionRow => ({
  sessionId: "0123456789abcdef", project: "/a/b/site", terminal: "ghostty", firstTs: BASE, lastTs: BASE + 600,
  requests: 4, freshTokens: 1200, cacheRead: 30000, contextPerTurn: 7800, costUsd: 2.5, projectsInRange: 1, atlas: null,
  apiCost: { usd: 1.75, priced: 4, unpriced: 0 }, ...over,
});
const data = (rows: SessionRow[], over: Partial<SessionsData> = {}): SessionsData => ({
  range: "30d", project: null, rows, capped: false, projects: ["/a/b/site", "(unfiled)"], ...over,
});

describe("sortableTable", () => {
  const cols = [{ key: "name", label: "name" }, { key: "cost", label: "cost", num: true }];

  it("renders a named empty state, not an empty table", () => {
    expect(sortableTable(cols, [], { empty: "no sessions in the last 7 days" })).toBe(
      '<div class="chart-empty"><div class="empty-msg">no sessions in the last 7 days</div></div>',
    );
  });

  it("writes each cell's sort value, and an empty one for a null", () => {
    const html = sortableTable(cols, [
      { cells: { name: { html: "a&amp;b", sort: "a&b" }, cost: { html: "$1.50", sort: 1.5 } } },
      { cells: { name: { html: "c", sort: "c" }, cost: { html: "—", sort: null } } },
    ]);
    expect(html).toBe(
      '<div class="scroll"><table class="sortable"><thead><tr><th data-text scope="col"><button type="button" class="th-sort">name</button></th><th class="num" scope="col"><button type="button" class="th-sort">cost</button></th></tr></thead><tbody>' +
        '<tr><td data-sort="a&amp;b">a&amp;b</td><td class="num" data-sort="1.5">$1.50</td></tr>' +
        '<tr><td data-sort="c">c</td><td class="num" data-sort="">—</td></tr>' +
        "</tbody></table></div>",
    );
  });

  it("treats a number that is not finite as no value, and a missing cell as empty", () => {
    const html = sortableTable(cols, [{ cells: { name: { html: "x", sort: Number.NaN } } }]);
    expect(html).toContain('<td data-sort="">x</td><td class="num" data-sort=""></td>');
  });
});

describe("Sessions view", () => {
  // GUARD 3. A session with no status-line reading has no cost: "no reading",
  // sorted last (an empty data-sort), never $0.00 and never a 0 among the cheapest.
  it("renders a null cost as no reading with an empty sort value, never $0.00", () => {
    const html = renderSessionsBody(data([row({ costUsd: null })]));
    const cost = cells(html)[9];
    expect(cost.sort).toBe("");
    expect(cost.html).toBe('<span class="absent">no reading</span>');
    expect(cost.html).not.toContain("$");
    expect(html).not.toContain("$0.00");
  });

  it("lays out one row per session with its figures and sort values", () => {
    const c = cells(renderSessionsBody(data([row()]), { tz: "America/Los_Angeles" }));
    expect(c.map((x) => x.sort)).toEqual([
      String(BASE), String(BASE + 600), "site", "ghostty", "4", "1200", "30000", "7800", "1.75", "2.5", "0123456789abcdef",
    ]);
    // I6: local, not UTC. The zone is named once, in the footer: a suffix on
    // every row pushed the table past its card.
    expect(c[0].html).toBe("2025-06-15 08:06");
    expect(c[5].html).toBe("1.2k");
    expect(c[8].html).toBe("$1.75");
    expect(c[9].html).toBe("$2.50");
    expect(c[10].html).toContain('<span class="sid" title="0123456789abcdef">01234567</span>');
  });

  it("shows no terminal and no context reading as absent, sorted last", () => {
    const c = cells(renderSessionsBody(data([row({ terminal: null, contextPerTurn: null })])));
    expect(c[3]).toEqual({ sort: "", html: '<span class="absent">unknown</span>' });
    expect(c[7].sort).toBe("");
  });

  it("crowns the most expensive session in the hero", () => {
    const html = renderSessionsBody(data([row({ sessionId: "cheap", costUsd: 1 }), row({ sessionId: "dear", costUsd: 9.25 }), row({ sessionId: "none", costUsd: null })]));
    const hero = html.slice(0, html.indexOf("</section>"));
    expect(hero).toContain('<section class="c hero">');
    expect(hero).toContain('<div class="big" data-count="9.25">$9.25</div>');
    expect(hero).toContain('<div class="sid">dear</div>');
  });

  it("says 'no cost data' in the hero when no listed session has a reading, never $0.00", () => {
    const html = renderSessionsBody(data([row({ costUsd: null }), row({ sessionId: "b", costUsd: null })]));
    const hero = html.slice(0, html.indexOf("</section>"));
    expect(hero).toContain('<div class="big absent">no cost data</div>');
    expect(hero).toContain("none of the 2 listed sessions have a status-line cost reading");
    expect(hero).not.toContain("$");
    expect(hero).not.toContain("data-count");
  });

  it("links each project to its filter when served, and prints text in the report", () => {
    const served = renderSessionsBody(data([row()]), { served: true });
    expect(served).toContain('<a href="/sessions?range=30d&amp;project=%2Fa%2Fb%2Fsite" title="/a/b/site">site</a>');
    const report = renderSessionsBody(data([row()]));
    expect(report).toContain('<span title="/a/b/site">site</span>');
    expect(report).not.toContain('href="/');
  });

  // M7: the marker comes from the reader's count over every request of the
  // session, not from the rows listed -- so a filtered table (one row) still
  // says the session ran elsewhere too.
  it("marks a session that ran in two projects on each of its rows, even when only one is listed", () => {
    const html = renderSessionsBody(data([row({ projectsInRange: 2 }), row({ project: "(unfiled)", freshTokens: 5, projectsInRange: 2 })]));
    expect(cells(html, 0)[10].html).toContain(">+1</span>");
    expect(cells(html, 1)[10].html).toContain(">+1</span>");
    const alone = renderSessionsBody(data([row({ projectsInRange: 2 })], { project: "/a/b/site" }));
    expect(cells(alone, 0)[10].html).toContain(">+1</span>");
    expect(cells(renderSessionsBody(data([row()])), 0)[10].html).not.toContain("+");
  });

  it("notes the cap when it applies", () => {
    expect(renderSessionsBody(data([row()], { capped: true }))).toContain("Showing the 500 most recent sessions in this range");
    expect(renderSessionsBody(data([row()]))).not.toContain("most recent sessions in this range");
  });

  // A report carries every range's table at once, under its size budget: it
  // lists the most recent REPORT_ROWS per range and says so. Served, all rows.
  it("lists at most REPORT_ROWS rows in the report, saying so, and every row when served", () => {
    const many = Array.from({ length: REPORT_ROWS + 5 }, (_, i) => row({ sessionId: `s${String(i).padStart(8, "0")}`, lastTs: BASE + 1000 - i }));
    const report = renderSessionsBody(data(many));
    expect(report.split("<tr>").length - 2).toBe(REPORT_ROWS);
    expect(report).toContain(`This report lists the ${REPORT_ROWS} most recent of ${REPORT_ROWS + 5} sessions in this range`);
    const served = renderSessionsBody(data(many), { served: true });
    expect(served.split("<tr>").length - 2).toBe(REPORT_ROWS + 5);
    expect(served).not.toContain("This report lists");
  });

  it("keeps a known filter across ranges and names it", () => {
    const v = sessionsView(data([row()], { project: "/a/b/site" }), { now: NOW, served: true });
    expect(v.pillQuery).toBe("&project=%2Fa%2Fb%2Fsite");
    expect(v.body).toContain("<h2>Sessions · last 30 days · site</h2>");
    expect(v.body).toContain('<a href="/sessions?range=30d">Show every project</a>');
  });

  // Review Focus 3, the renderer's half: a filter the reader did not match is
  // never echoed and never carried into the pills.
  it("never echoes an unknown filter, and shows the empty state", () => {
    const hostile = '"><script>alert(1)</script>';
    const v = sessionsView(data([], { project: hostile }), { now: NOW, served: true });
    expect(v.pillQuery).toBeUndefined();
    expect(v.body).not.toContain("alert(1)");
    expect(v.body).toContain("No sessions on record for that project.");
    expect(v.body).toContain("no sessions for this project in the last 30 days");
  });

  // Review Focus 2: a window with no rows is named empty states, and the hero
  // shows no 0 as a measurement.
  it("renders an empty window as named empty states, with no hero 0", () => {
    const db = buildAndRoll("dashboard", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });
    // The view body: the page around it carries the client script, which names data-count.
    const html = sessionsView(readSessions(db, { now: NOW + 100 * DAY, range: "7d" }), { now: NOW + 100 * DAY }).body;
    const hero = html.slice(html.indexOf('<section class="c hero">'));
    expect(hero.slice(0, hero.indexOf("</section>"))).toContain("no sessions in the last 7 days");
    expect(html).toContain('<div class="empty-msg">no sessions in the last 7 days</div>');
    expect(html).not.toContain("data-count");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("<table");
  });
});

describe("Projects view, restyled", () => {
  const db = buildAndRoll("dashboard", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });

  it("opens with the top project by active hours as the hero, and a sortable ranked table", () => {
    const html = renderProjectsPage(readProjects(db, { now: NOW }));
    const hero = html.slice(html.indexOf('<section class="c hero">'));
    expect(hero.slice(0, hero.indexOf("</section>"))).toContain(">proj-beta</div>");
    expect(html).toContain("<h2>Projects · ranked by active hours · last 30 days</h2>");
    expect(html).toContain('<table class="sortable">');
    // A project's line count with no reading sorts last.
    expect(html).toMatch(/<td class="num" data-sort=""><span class="absent" title="no session here reported a line count">no reading<\/span><\/td>/);
  });

  it("breaks sessions down by terminal, NULL as unknown", () => {
    const html = renderProjectsPage(readProjects(db, { now: NOW }));
    const at = html.indexOf("<h2>Terminals · last 30 days</h2>");
    const donut = html.slice(at, html.indexOf("</section>", at));
    expect(donut).toContain("unknown: 2 sessions");
    expect(donut).toContain("ghostty: 1 session");
  });

  it("links each project to its sessions only when served", () => {
    const d = readProjects(db, { now: NOW });
    const alpha = d.projects.find((p) => p.label === "proj-alpha")!.key;
    expect(renderProjectsPage(d, { served: true })).toContain(`href="/sessions?range=30d&amp;project=${encodeURIComponent(alpha)}"`);
    expect(renderProjectsPage(d)).not.toContain('href="/sessions?');
  });

  // Review Focus 2 for Projects.
  it("renders an empty window as named empty states, with no hero 0", () => {
    const html = projectsView(readProjects(db, { now: NOW + 100 * DAY, range: "7d" })).body;
    const hero = html.slice(html.indexOf('<section class="c hero">'));
    expect(hero.slice(0, hero.indexOf("</section>"))).toContain("no active time in the last 7 days");
    for (const msg of ["no project activity in the last 7 days", "no sessions started in the last 7 days", "no requests in the last 7 days"]) {
      expect(html).toContain(msg);
    }
    expect(html).not.toContain("data-count");
    expect(html).not.toContain("<table");
  });
});

describe("the Atlas line", () => {
  const line = (a: SessionRow["atlas"]) => renderSessionsBody(data([row({ atlas: a })]), { tz: "UTC" });
  it("says what Atlas counted, singular and plural", () => {
    expect(line({ checkpoints: 1, files: 2 })).toContain("Atlas: 1 checkpoint · 2 files touched");
    expect(line({ checkpoints: 3, files: 1 })).toContain("Atlas: 3 checkpoints · 1 file touched");
  });
  it("says nothing for a session Atlas does not know", () => {
    expect(line(null)).not.toContain("Atlas:");
  });
});
