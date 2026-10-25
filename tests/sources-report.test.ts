import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAndRoll } from "./helpers/fixture-db.ts";
import { applyWtSchema } from "@/lib/core/schema.ts";
import { registerSource, type WatchtowerAdapter } from "@/lib/core/adapters.ts";
import { ingestRecords } from "@/lib/core/ingest.ts";
import { validateRecord } from "@/lib/core/records.ts";
import { readSources, type SourceRow } from "@/lib/read/sources.ts";
import { renderSourcesBody, renderSourcesPage } from "@/lib/render/sources.ts";
import { buildReport, renderStaticRoute, STATIC_VIEWS } from "@/lib/views.ts";
import { slow } from "./helpers/timeout";

process.env.TZ = "UTC";

const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "bin", "watchtower");
const NOW = 1790000000;

const stub = (
  id: string, type: WatchtowerAdapter["type"], authority: WatchtowerAdapter["authority"],
): WatchtowerAdapter => ({
  id, type, label: id === "claude" ? "Claude Code" : id, version: id === "claude" ? 1 : 3,
  capabilities: ["requests"], authority,
  async detect() { return { detected: true }; },
  async health() { return { state: "ok" }; },
  async *ingest() { /* nothing */ },
});

/**
 * A synced database with three shapes of source:
 *  claude  registered, one clean run, owns the request token metrics
 *  atlas   registered, one run that sent a metric claude owns (rejected) and a
 *          record that could not be written (malformed)
 *  codex   named in config, disabled, never registered and never run
 */
function syncedDb(): string {
  // Its own directory: the wt schema marker lives beside the database.
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wt-sources-")), "t.sqlite");
  applyWtSchema(db);
  registerSource(db, stub("claude", "agent", [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }]));
  registerSource(db, stub("atlas", "provenance", []));
  ingestRecords(db, "claude", [validateRecord({
    source: "claude", sourceRecordId: "req-1", kind: "request",
    timestamp: "2026-09-14T12:00:00Z", metrics: { tokens_in: 10, tokens_out: 20 },
  })]);
  ingestRecords(db, "atlas", [
    validateRecord({
      source: "atlas", sourceRecordId: "a-1", kind: "request",
      timestamp: "2026-09-14T12:00:00Z", metrics: { tokens_out: 999999 },
    }),
    validateRecord({ // no tool_name: wt_tools.tool_name is NOT NULL
      source: "atlas", sourceRecordId: "a-bad", kind: "tool", timestamp: "2026-09-14T12:00:00Z",
    }),
  ]);
  return db;
}

const CONFIGURED = { claude: { enabled: true }, codex: { enabled: false } };

describe("readSources", () => {
  it("reads each source's registration, ingest state and holdings from wt_*", () => {
    const d = readSources(syncedDb(), { now: NOW, configured: CONFIGURED });
    expect(d.synced).toBe(true);
    expect(d.sources.map((s) => s.source)).toEqual(["atlas", "claude", "codex"]);

    const [atlas, claude] = d.sources;
    expect(claude).toMatchObject({
      enabled: true, registered: true, type: "agent", label: "Claude Code", adapterVersion: 1,
      inActivityTotals: true,
      authority: [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }],
    });
    expect(claude.ingest).toMatchObject({
      cursor: null, recordsWritten: 1, metricsRejected: 0, malformed: 0, health: "ok", lastError: null,
    });
    expect(claude.held.requests).toBe(1);

    // atlas is registered but not in config: null, not false.
    expect(atlas.enabled).toBeNull();
    expect(atlas.inActivityTotals).toBe(false);
    expect(atlas.ingest).toMatchObject({ metricsRejected: 1, malformed: 1, health: "degraded" });
    expect(atlas.ingest!.lastOkAt).toBeNull();
    expect(atlas.ingest!.lastError).toContain("a-bad");
  });

  // Killing mutation: default a missing wt_ingest_state row to zero counters.
  // A source that has never run is not a source that ran cleanly and wrote 0.
  it("keeps a never-run source's ingest state null rather than zero", () => {
    const codex = readSources(syncedDb(), { now: NOW, configured: CONFIGURED }).sources[2];
    expect(codex).toMatchObject({ source: "codex", enabled: false, registered: false, type: null });
    expect(codex.ingest).toBeNull();
  });

  it("reports a database sync has never touched as unsynced, not as an error", () => {
    const d = readSources(buildAndRoll("live"), { now: NOW, configured: { claude: { enabled: true } } });
    expect(d.synced).toBe(false);
    expect(d.sources).toHaveLength(1);
    expect(d.sources[0]).toMatchObject({ source: "claude", enabled: true, registered: false });
  });
});

describe("renderSourcesPage", () => {
  const html = renderSourcesPage(readSources(syncedDb(), { now: NOW, configured: CONFIGURED }));

  it("puts rejected metrics and malformed records on the page, highlighted", () => {
    expect(html).toContain('<h2>atlas · atlas</h2>');
    expect(html.match(/<span class="warn">1<\/span>/g)).toHaveLength(2);
    expect(html).toContain('<span class="health-degraded">degraded</span>');
    expect(html).toContain("none: every run so far had a malformed record");
  });

  // Built by hand rather than read, so this guards the RENDERER alone: the
  // reader's own null-not-zero rule has its test above.
  it("renders a never-run source as never run, with no zeroes", () => {
    const neverRun: SourceRow = {
      source: "codex", enabled: false, registered: false, type: null, label: null,
      adapterVersion: null, inActivityTotals: null, capabilities: [], authority: [],
      firstSeen: null, ingest: null,
      held: { requests: 0, events: 0, tools: 0, usage: 0, sessions: 0, fingerprints: 0 },
    };
    const page = renderSourcesBody({ generatedAt: NOW, synced: true, sources: [neverRun] });
    const row = page.match(/<tr><td>codex<\/td>.*?<\/tr>/)![0];
    expect(row).toContain("never run");
    expect(row).toContain("disabled");
    expect(row).toContain("not detected");
    expect(row).not.toMatch(/>0</);
  });

  it("names the cursor's absence instead of printing an empty cell", () => {
    expect(html).toContain("sync compares record fingerprints");
  });

  it("says so when the database has never been synced", () => {
    const body = renderSourcesBody(readSources(buildAndRoll("live"), { now: NOW }));
    expect(body).toContain("has never run against it");
    expect(body).toContain("no sources configured or registered");
  });

  it("marks itself as the current nav entry", () => {
    expect(html).toContain('<a href="/sources" aria-current="page">Sources</a>');
  });
});

describe("watchtower report", () => {
  const db = buildAndRoll("dashboard");
  // `range` is the served view's: the report builds every range itself, and
  // the default one is the block it shows first.
  // An empty home: Codex and Hermes are "not installed" here, whatever this machine has.
  const home = mkdtempSync(path.join(tmpdir(), "wt-report-home-"));
  const ctx = { db, now: NOW, configured: CONFIGURED, range: "30d" as const, home };
  const report = buildReport(ctx);

  // The "one renderer" rule, as a test: every static view's body is what the
  // server renders for that view's route, and every piece of it appears in the
  // report byte for byte. (A ranged view's report copy carries each piece that
  // is the same in every range once, so the body as one string no longer
  // appears whole -- its pieces do, in order.)
  it("carries every static view exactly as the server renders it", () => {
    expect(STATIC_VIEWS.map((v) => v.href)).toEqual(["/overview", "/character", "/quests", "/history", "/projects", "/sessions", "/skills", "/profile", "/performance", "/codex", "/hermes", "/sources"]);
    for (const v of STATIC_VIEWS) {
      const view = v.build(ctx);
      const body = view.body;
      expect(body.length).toBeGreaterThan(100);
      if (view.sections !== undefined) expect(view.sections.join("")).toBe(body);
      expect(renderStaticRoute(v.href, ctx)).toContain(body);
      if (!v.ranged) {
        expect(report).toContain(body);
        continue;
      }
      const at = report.indexOf(`<article class="view" id="${v.href.slice(1)}">`);
      const article = report.slice(at, report.indexOf("</article>", at));
      let from = 0;
      for (const piece of view.sections ?? [body]) {
        const found = article.indexOf(piece, from);
        expect(found, `${v.href}: ${piece.slice(0, 80)}`).toBeGreaterThanOrEqual(0);
        from = found + piece.length;
      }
    }
  });

  // Spec §4.5: a file has no server to ask for another range, so a ranged view
  // carries every range and the pills toggle between them in the page.
  it("carries History once per range, the default shown and the rest hidden", () => {
    const at = report.indexOf('<article class="view" id="history">');
    const history = report.slice(at, report.indexOf("</article>", at));
    const blocks = [...history.matchAll(/<div data-range="(7d|30d|90d|all)"( hidden)?>/g)];
    // Complete sets of four, in order, the default the only one shown in each.
    expect(blocks.length % 4).toBe(0);
    expect(blocks.length).toBeGreaterThan(0);
    for (let i = 0; i < blocks.length; i += 4) {
      expect(blocks.slice(i, i + 4).map((m) => m[1])).toEqual(["7d", "30d", "90d", "all"]);
      expect(blocks.slice(i, i + 4).filter((m) => m[2] === undefined).map((m) => m[1])).toEqual(["30d"]);
    }
    expect(history).toContain('<div class="ranged" data-ranges><div class="ranges" role="group" aria-label="Range">');
    expect(history).toContain('data-range-to="30d" aria-pressed="true"');
    // Each block is that range's own render: the headings name the span.
    for (const r of ["last 7 days", "last 30 days", "last 90 days", "all time"]) {
      expect(history).toContain(`<h2>Active vs idle · ${r}</h2>`);
    }
    // A view that is not ranged is carried once, with no pills.
    const from = report.indexOf('<article class="view" id="sources">');
    const sources = report.slice(from, report.indexOf("</article>", from));
    expect(sources).not.toContain("data-range");
  });

  // Task 4: every ranged view -- Models & Skills now among them -- has its
  // range blocks, one row of pills, and nothing else toggling it.
  it("gives every ranged view its range blocks in sets of four under one row of pills", () => {
    expect(STATIC_VIEWS.filter((v) => v.ranged).map((v) => v.href)).toEqual(["/overview", "/history", "/projects", "/sessions", "/skills", "/profile", "/performance", "/codex", "/hermes"]);
    // Codex and Hermes, not installed here, say the same in every range, so the report carries each once.
    const alone = new Set(["/codex", "/hermes"]);
    for (const v of STATIC_VIEWS.filter((x) => x.ranged && !alone.has(x.href))) {
      const at = report.indexOf(`<article class="view" id="${v.href.slice(1)}">`);
      const article = report.slice(at, report.indexOf("</article>", at));
      const blocks = [...article.matchAll(/<div data-range="(7d|30d|90d|all)"( hidden)?>/g)].map((m) => m[1]);
      expect(blocks.length, v.href).toBeGreaterThanOrEqual(4);
      expect(blocks.length % 4, v.href).toBe(0);
      for (const r of ["7d", "30d", "90d", "all"]) expect(blocks.filter((b) => b === r).length).toBe(blocks.length / 4);
      expect(article.match(/data-ranges/g), v.href).toHaveLength(1);
      expect(article.match(/data-range-to="/g), v.href).toHaveLength(4);
    }
  });

  // The fix to Task 2's "whole body per range": a card that is the same in
  // every range is carried once, not four times.
  it("carries a lifetime card once, not once per range", () => {
    for (const heading of ["<h2>Level</h2>", "<h2>Coverage · lifetime</h2>", "<h2>What drove it · last 14 days</h2>",
      "<h2>Skills · all time</h2>", "<h2>MCP servers · all time</h2>", "<h2>API errors · all time</h2>"]) {
      expect(report.split(heading).length - 1, heading).toBe(1);
    }
    // ...while a ranged card is carried once per range.
    expect(report.split("<h2>Effort mix · ").length - 1).toBe(4);
  });

  // Stage 6: Character is one article, reached from the tool row, not the page row.
  it("stacks Character into the report, linked from the tool row only", () => {
    const home = mkdtempSync(path.join(tmpdir(), "wt-char-rep-home-"));
    const html = buildReport({ db: buildAndRoll("resumed"), now: NOW, tz: "UTC", home });
    expect(html.split(`<article class="view" id="character">`)).toHaveLength(2);
    expect(html).toContain(`<a class="pill t-character" href="#character">Character</a>`);
    const pages = html.slice(html.indexOf(`<nav class="pages"`), html.indexOf("</nav>", html.indexOf(`<nav class="pages"`)));
    expect(pages).not.toContain(`href="#character"`);
  }, slow(30_000));

  // I6: the report prints local times, fixed at generation in the zone it was
  // generated in, and names that zone. Pinned, so the machine's zone is moot.
  //
  // Explicit 15s timeout, as for the size test below: it builds a whole report,
  // and went past 5s once under full-suite load after cli-open.test.ts added
  // process-spawning tests.
  it("embeds local times in the zone it was generated in, and names it", () => {
    const la = buildReport({ db, now: NOW, configured: CONFIGURED, tz: "America/Los_Angeles" });
    expect(la).toMatch(/static report generated \d{4}-\d\d-\d\d \d\d:\d\d:\d\d P[DS]T · every day and time is local to America\/Los_Angeles \(P[DS]T\)/);
    expect(la).not.toMatch(/\d\d:\d\d:\d\dZ/);
    expect(la).not.toContain("UTC");
  }, slow(15000));

  // Spec §4.5, measured on the fixture as a multiple. The baseline is the
  // Stage 3C report (2753c3f) on this `dashboard` fixture with its own clock --
  // BASE + 2 days + 1000 s, TZ=UTC, */skipme excluded -- where every range
  // holds data, so every range block is full: 64,863 bytes.
  //
  // Explicit 15s timeout (default is 5s), as for report-budget's growth test:
  // the test builds and rolls a fixture, then a report of seven views in four
  // ranges. Stage 4B's Performance view took it to ~3.6s under full-suite
  // worker contention, and once past 5s, on a run where the size assertion
  // itself passed. Isolated, it takes about 1.5s.
  //
  // Stage 5 Task 7: the Overview is a ranged view, so it adds one block per
  // range (264,592 B against the old 259,452 ceiling, +5,140), and the multiple
  // is 4.2x. The real budget, REPORT_BUDGET_BYTES, is guarded by report-budget.
  //
  // Stage 6 Task 4: Character is one more (unranged) article, 279,421 B against
  // the 272,425 ceiling, so the multiple is 4.4x (285,397 B).
  //
  // Stage 8: Quests is one more (unranged) article, 287,250 B against the
  // 285,397 ceiling, so the multiple is 4.5x (291,884 B).
  it("stays within 4.5x the Stage 3C report on the fixture", () => {
    const REPORT_3C_BYTES = 64_863;
    const fixtureNow = 1750000000 + 2 * 86400 + 1000;
    const busy = buildReport({ db: buildAndRoll("dashboard", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" }), now: fixtureNow, configured: CONFIGURED });
    expect(Buffer.byteLength(busy, "utf8")).toBeLessThanOrEqual(4.5 * REPORT_3C_BYTES);
    expect(Buffer.byteLength(report, "utf8")).toBeLessThanOrEqual(4.5 * REPORT_3C_BYTES);
  }, slow(15000));

  // The report is interactive with no server: the settings popover (theme and
  // navigation) and the range and metric toggles all ship in it.
  it("ships the settings popover and the range and metric toggles", () => {
    expect(report).toContain('id="wt-settings"');
    for (const t of ["amber", "claude", "giants", "raptors", "bills"]) expect(report).toContain(`data-set-theme="${t}"`);
    expect(report).toContain('data-set-nav="sidebar"');
    expect(report).toContain('data-metric-to="cost"');
    expect(report).toContain("data-range-to=");
  });

  // The report carries the inline client script (settings, tooltips,
  // toggles) but no poller: the script has no fetch at all, and no script
  // is loaded from anywhere.
  it("omits Live and has no poller, so nothing polls and nothing is fetched", () => {
    expect(report).not.toContain("<h2>Rate limits</h2>");
    expect((report.match(/fetch\(/g) ?? []).length).toBe(0);
    expect(report).not.toMatch(/(src|href)\s*=\s*["']?https?:\/\//i);
    expect(report).not.toMatch(/<script[^>]*\ssrc=/);
    expect(report).not.toContain("/api/");
    // An in-page anchor, or the favicon: an SVG inline as a data URI fetches nothing.
    expect(report).not.toMatch(/(src|href|action)="(?!#|data:image\/svg\+xml,)/);
    expect(report).not.toMatch(/https?:\/\/|url\(|@import/);
  });

  it("the tool row's Codex and Hermes anchors resolve to their articles", () => {
    for (const id of ["overview", "codex", "hermes"]) {
      expect(report).toContain(`href="#${id}"`);
      expect(report).toContain(`<article class="view" id="${id}">`);
    }
  });

  it("navigates by in-page anchors", () => {
    expect(report).toContain(
      '<nav class="pages" aria-label="Pages"><a href="#history">History</a><a href="#projects">Projects</a>' +
      '<a href="#sessions">Sessions</a><a href="#skills">Models &amp; Skills</a>' +
      '<a href="#profile">Usage Profile</a><a href="#performance">Performance</a>' +
      '<a href="#sources">Sources</a></nav>');
    for (const id of ["history", "projects", "sessions", "skills", "profile", "performance", "sources"]) {
      expect(report).toContain(`<article class="view" id="${id}">`);
    }
  });

  function cli(args: string[], dbPath: string, env: Record<string, string> = {}) {
    const cwd = mkdtempSync(path.join(tmpdir(), "wt-report-"));
    const r = spawnSync("node", [BIN, "report", ...args], {
      cwd, encoding: "utf8",
      env: { ...process.env, WATCHTOWER_DB_PATH: dbPath, THEONE_DB_PATH: dbPath, TZ: "UTC", ...env },
    });
    return { ...r, cwd };
  }

  it("writes the file through the CLI, defaulting to ./watchtower-report.html", () => {
    const r = cli([], db);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const out = path.join(r.cwd, "watchtower-report.html");
    expect(existsSync(out)).toBe(true);
    const html = readFileSync(out, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<article class="view" id="sources">');
    expect(r.stdout).toContain("wrote watchtower-report.html");
  });

  // M12: regenerating replaces the file, but says so rather than silently.
  it("says so when it replaces an existing report", () => {
    const target = path.join(mkdtempSync(path.join(tmpdir(), "wt-old-")), "r.html");
    writeFileSync(target, "old");
    const r = cli(["--out", target], db);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`overwrote ${target}`);
    expect(readFileSync(target, "utf8").startsWith("<!doctype html>")).toBe(true);
  });

  // I4: over budget, the report is still written, and stderr says so.
  it("warns on stderr, and still writes, when the report is over its budget", () => {
    const r = cli([], db, { WATCHTOWER_REPORT_BUDGET_BYTES: "1000" });
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^watchtower: warning: the report is \d+ bytes, over its 1000-byte budget/);
    expect(existsSync(path.join(r.cwd, "watchtower-report.html"))).toBe(true);
    const piped = cli(["--out", "-"], db, { WATCHTOWER_REPORT_BUDGET_BYTES: "1000" });
    expect(piped.stderr).toContain("over its 1000-byte budget");
    expect(piped.stdout.startsWith("<!doctype html>")).toBe(true);
  });

  it("writes to stdout with --out -", () => {
    const r = cli(["--out", "-"], db);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith("<!doctype html>")).toBe(true);
  });

  it("refuses a missing database in one line, without creating it", () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), "wt-none-")), "absent.sqlite");
    const r = cli([], missing);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(`report: no database at ${missing}`);
    expect(existsSync(missing)).toBe(false);
  });
});
