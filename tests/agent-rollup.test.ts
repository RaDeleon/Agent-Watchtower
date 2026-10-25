import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexAdapter } from "@/lib/adapters/codex";
import { createHermesAdapter } from "@/lib/adapters/hermes";
import { entryLists } from "@/lib/config";
import { applyWtSchema } from "@/lib/core/schema";
import { runSync } from "@/lib/core/sync";
import { roll, seedAgents, type AgentEvent } from "./helpers/agent-seed";
import { buildAndRoll, rerollup, rows, ROLLUP } from "./helpers/fixture-db";

// Stage 5, Task 5: capture/rollup.sh's agent section. Codex and Hermes hours,
// Codex cost at API prices and every tool's OSRS level, all derived in the
// rollup from wt_*. R21: each guard's literal values live in ONE test here; the
// rollup tests seed wt_* directly (tests/helpers/agent-seed.ts) and the
// end-to-end tests assert identities, so one planted defect reds one test.

const MAKE_CODEX = path.resolve(__dirname, "fixtures", "make-codex-logs.sh");
const MAKE_HERMES = path.resolve(__dirname, "fixtures", "make-hermes-db.sh");

const T = 1789466400; // 2026-09-15T10:00:00Z
const base = () => buildAndRoll("resumed");

type Row = Record<string, unknown>;
const progress = (db: string) => rows<Row>(db, "SELECT * FROM agent_progress ORDER BY source");
/** One tool's agent_progress row, without its key and its clock. */
function levelOf(db: string, source: string): Row {
  const r = progress(db).find((p) => p.source === source);
  if (r === undefined) throw new Error(`no agent_progress row for ${source}`);
  const { source: _s, updated_at: _u, ...rest } = r;
  return rest;
}

function codexHome(scenario: string, cwd?: string): string {
  const home = mkdtempSync(path.join(tmpdir(), "wt-ag-codex-home-"));
  const env = cwd === undefined ? process.env : { ...process.env, WT_CODEX_CWD: cwd };
  execFileSync("bash", [MAKE_CODEX, scenario, home], { env });
  return home;
}
function hermesHome(scenario: string): string {
  const home = mkdtempSync(path.join(tmpdir(), "wt-ag-hermes-home-"));
  execFileSync("bash", [MAKE_HERMES, scenario, path.join(home, ".hermes", "state.db")]);
  return home;
}
async function syncCodex(db: string, home: string): Promise<void> {
  applyWtSchema(db);
  await runSync({ db, adapters: [createCodexAdapter({ db, home, lists: entryLists("codex", undefined) })] });
  roll(db);
}
async function syncHermes(db: string, home: string): Promise<void> {
  applyWtSchema(db);
  await runSync({ db, adapters: [createHermesAdapter({ db, home, lists: entryLists("hermes", undefined) })] });
  roll(db);
}

/** sqlite3 with TZ=UTC, as the rollup ran: a localtime grouping must bucket the same way. */
function rowsUtc<T>(db: string, sql: string): T[] {
  const out = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
  return out.trim() === "" ? [] : (JSON.parse(out) as T[]);
}

describe("agent hours", () => {
  // GUARD 4 (R21): the only test that seeds automated and unclassified sessions
  // WITH gaps. Planted: drop `AND s.driven = 1` from _ag_ev.
  it("automated and unclassified sessions earn no hours", () => {
    const db = base();
    const cwd = "/tmp/wt-ag-one";
    seedAgents(db, [
      { source: "codex", id: "d", entry: "Codex Desktop", driven: 1, startedAt: T, cwd,
        events: [[T, "session_start"], [T + 40, "prompt"], [T + 100, "stop"]] },
      { source: "codex", id: "a", entry: "codex_exec", driven: 0, startedAt: T, cwd,
        events: [[T, "session_start"], [T + 50, "prompt"], [T + 250, "stop"]] },
      { source: "codex", id: "u", entry: "mystery", driven: null, startedAt: T, cwd,
        events: [[T, "session_start"], [T + 60, "prompt"], [T + 360, "stop"]] },
      { source: "codex", id: "a2", entry: "codex_exec", driven: 0, startedAt: T + 172800, cwd,
        events: [[T + 172800, "session_start"], [T + 172900, "stop"]],
        requests: [{ id: "a2-r", ts: T + 172850, model: "gpt-5.5", tin: 10 }] },
    ]);
    roll(db);
    expect(rows(db, `SELECT day, active_s, sessions_driven, sessions_automated, sessions_unclassified, requests
      FROM agent_daily_rollups WHERE source = 'codex' ORDER BY day`)).toEqual([
      { day: "2026-09-15", active_s: 100, sessions_driven: 1, sessions_automated: 1, sessions_unclassified: 1, requests: 0 },
      { day: "2026-09-17", active_s: null, sessions_driven: 0, sessions_automated: 1, sessions_unclassified: 0, requests: 1 },
    ]);
  });

  // GUARD 11 (R21). Claude's rule and the agent copy over ONE event stream:
  // make-fixture.sh agent-drift writes it to claude_events; this seeds the
  // same offsets, in the same order, into wt_events. Planted: `>=` for `>` in
  // the agent section's working test.
  it("the agent gap rule equals Claude's", () => {
    const db = buildAndRoll("agent-drift");
    const B = 1750000000;
    const drift: Array<[number, string]> = [
      [0, "SessionStart"], [4, "UserPromptSubmit"], [20, "PreToolUse"], [900, "PostToolUse"], [960, "Stop"],
      [1500, "Notification"], [2100, "UserPromptSubmit"], [2100, "Stop"], [2700, "Notification"],
      [2710, "UserPromptSubmit"], [20000, "PostToolUse"], [20010, "Stop"], [20010, "SessionEnd"],
      [25000, "SessionStart"], [25010, "UserPromptSubmit"], [25100, "Stop"],
    ];
    const map: Record<string, AgentEvent> = {
      SessionStart: "session_start", UserPromptSubmit: "prompt", Stop: "stop", SessionEnd: "session_end",
    };
    seedAgents(db, [{
      source: "codex", id: "drift", entry: "Codex Desktop", driven: 1, startedAt: B,
      events: drift.map(([off, name]) => [B + off, map[name] ?? "activity"]),
    }]);
    roll(db);
    expect(rows<{ active_ms: number }>(db, "SELECT active_ms FROM claude_daily_rollups").map((r) => r.active_ms))
      .toEqual([16380000]);
    expect(progress(db).filter((p) => p.source === "claude" || p.source === "codex")
      .map((p) => [p.source, p.active_s])).toEqual([["claude", 16380], ["codex", 16380]]);
  });

  // Review Focus 1: the resume is a second file with the same session id.
  it("a resumed Codex session books only real activity", async () => {
    const db = base();
    await syncCodex(db, codexHome("resume"));
    expect(rows(db, `SELECT day, active_s FROM agent_daily_rollups WHERE source = 'codex' ORDER BY day`))
      .toEqual([{ day: "2026-09-15", active_s: 12 }, { day: "2026-09-18", active_s: 25 }]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM wt_sessions WHERE first_source = 'codex'")).toEqual([{ n: 1 }]);
  });

  // Review Focus 3: Codex hours and tokens split by local day; Hermes hours
  // split while its tokens land on the start day.
  it("a session across local midnight splits by day", async () => {
    const db = base();
    await syncCodex(db, codexHome("midnight"));
    await syncHermes(db, hermesHome("midnight"));
    expect(rows(db, `SELECT day, SUM(active_s) AS active_s, SUM(tokens_in) AS tokens_in FROM agent_daily_rollups
      WHERE source = 'codex' GROUP BY day ORDER BY day`)).toEqual([
      { day: "2026-09-20", active_s: 60, tokens_in: 100 },
      { day: "2026-09-21", active_s: 130, tokens_in: 200 },
    ]);
    expect(rows(db, `SELECT day, SUM(active_s) AS active_s, SUM(requests) AS requests FROM agent_daily_rollups
      WHERE source = 'hermes' GROUP BY day ORDER BY day`)).toEqual([
      { day: "2026-09-20", active_s: 300, requests: 1 },
      { day: "2026-09-21", active_s: 400, requests: 0 },
    ]);
  });
});

describe("Codex cost at API prices", () => {
  // GUARD 5 (R21): the only test with cost literals and price notes. Planted:
  // the unknown-model branch of _ag_rm's priced CASE yields 1.
  it("a model with no rate is not priced", () => {
    const db = base();
    seedAgents(db, [
      { source: "codex", id: "p", entry: "Codex Desktop", driven: 1, startedAt: T, cwd: "/tmp/wt-ag-one",
        requests: [
          { id: "r1", ts: T + 10, model: "gpt-5.5", tin: 600, tcr: 400, tcw: 0, tout: 200 },
          { id: "r2", ts: T + 20, model: "gpt-5.5", tin: 500, tcr: 1500, tcw: 0, tout: 300 },
          { id: "r3", ts: T + 30, model: "gpt-9-imaginary", tin: 50, tcr: 0, tcw: 0, tout: 5 },
          { id: "r4", ts: T + 40, model: "codex-auto-review", tin: 200, tcr: 100, tcw: 0, tout: 50 },
          { id: "r6", ts: T + 50, model: null, tin: 10, tcr: 0, tcw: 0, tout: 1 },
          { id: "r7", ts: T + 60, model: "gpt-5.2", tin: 100, tcr: 0, tcw: 100, tout: 0 },
          { id: "r5", ts: 1704067200, model: "gpt-5.5", tin: 100, tcr: 0, tcw: 0, tout: 10 },
          // Controller ruling: OpenAI's pricing page lists gpt-5.2, not
          // gpt-5.2-codex. Never a sibling's rate. A day of its own, so the
          // 09-15 row keeps the plan's counts.
          { id: "r8", ts: T + 86400, model: "gpt-5.2-codex", tin: 100, tcr: 0, tcw: 0, tout: 10 },
        ] },
      { source: "hermes", id: "hx", entry: "cli", driven: 1, startedAt: T,
        requests: [{ id: "hx-r", ts: T, model: "gpt-oss-120b", tin: 10, cost: 0.5 }] },
    ]);
    roll(db);
    expect(rows(db, "SELECT source_record_id AS id, priced, price_note FROM agent_request_metrics ORDER BY 1"))
      .toEqual([
        { id: "hx-r", priced: null, price_note: null },
        { id: "r1", priced: 1, price_note: null },
        { id: "r2", priced: 1, price_note: null },
        { id: "r3", priced: 0, price_note: "unknown-model" },
        { id: "r4", priced: 0, price_note: "no-public-rate" },
        { id: "r5", priced: 0, price_note: "no-price-yet" },
        { id: "r6", priced: 0, price_note: "unknown-model" },
        { id: "r7", priced: 1, price_note: null },
        { id: "r8", priced: 0, price_note: "no-public-rate" },
      ]);
    const m = Object.fromEntries(rows<{ id: string; c: number | null; own: number | null }>(db,
      "SELECT source_record_id AS id, cost_table_usd AS c, own_cost_usd AS own FROM agent_request_metrics")
      .map((r) => [r.id, r]));
    expect(m.r1.c).toBeCloseTo(0.0092, 12);
    expect(m.r2.c).toBeCloseTo(0.01225, 12);
    // A cache write is billed at the input rate: (100 + 100) x 1.75 / 1e6.
    expect(m.r7.c).toBeCloseTo(0.00035, 12);
    for (const id of ["r3", "r4", "r5", "r6", "r8", "hx-r"]) expect({ id, c: m[id].c }).toEqual({ id, c: null });
    expect(m["hx-r"].own).toBe(0.5);
    for (const id of ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]) expect({ id, own: m[id].own }).toEqual({ id, own: null });

    const [codex] = rows<Row>(db, `SELECT priced_requests, unpriced_requests, cost_table_usd FROM agent_daily_rollups
      WHERE source = 'codex' AND day = '2026-09-15'`);
    expect([codex.priced_requests, codex.unpriced_requests]).toEqual([3, 3]);
    expect(codex.cost_table_usd as number).toBeCloseTo(0.0218, 12);
    expect(rows(db, `SELECT own_cost_usd, own_priced_requests, own_unpriced_requests, priced_requests, unpriced_requests
      FROM agent_daily_rollups WHERE source = 'hermes' AND day = '2026-09-15'`)).toEqual([
      { own_cost_usd: 0.5, own_priced_requests: 1, own_unpriced_requests: 0, priced_requests: 0, unpriced_requests: 0 },
    ]);
  });

  it("agent_prices carries the rates it used", () => {
    const db = base();
    seedAgents(db, [{ source: "codex", id: "any", entry: "Codex Desktop", driven: 1, startedAt: T,
      events: [[T, "session_start"]] }]);
    roll(db);
    expect(rows(db, `SELECT COUNT(*) AS n, COUNT(DISTINCT source) AS sources, MIN(source) AS source,
      MIN(verified_on) AS verified FROM agent_prices`)).toEqual([{
      n: 7, sources: 1, source: "https://developers.openai.com/api/docs/pricing", verified: "2026-10-03",
    }]);
    expect(rows<{ model: string }>(db, "SELECT model FROM agent_prices ORDER BY model").map((r) => r.model))
      .toEqual(["gpt-5", "gpt-5.2", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6-sol", "gpt-6-astra", "gpt-6.1-sol"]);
  });
});

describe("levels", () => {
  // GUARD 7 (R21). The rollup's XP table, recomputed from the OSRS formula.
  it("XP thresholds equal the OSRS formula", () => {
    const src = readFileSync(ROLLUP, "utf8");
    const list = src.slice(src.indexOf("INSERT INTO _ag_xp (level, xp) VALUES"));
    const pairs = [...list.slice(0, list.indexOf(";")).matchAll(/\((\d+),(\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    let sum = 0;
    const expected: number[][] = [];
    for (let L = 1; L <= 99; L++) {
      if (L > 1) sum += Math.floor(L - 1 + 300 * 2 ** ((L - 1) / 7));
      expected.push([L, Math.floor(sum / 4)]);
    }
    expect(pairs.slice(0, 99)).toEqual(expected);
    expect([pairs[9][1], pairs[49][1], pairs[91][1], pairs[98][1]]).toEqual([1154, 101333, 6517253, 13034431]);
  });

  // GUARD 6 (Stage 10, spec 4.6). Past 99 each level is 250 hours: level 99+n
  // at exactly 9,000,000 + 900,000n seconds, through 200.
  it("past 99 each level is 250 hours", () => {
    const src = readFileSync(ROLLUP, "utf8");
    const list = src.slice(src.indexOf("INSERT INTO _ag_xp (level, xp) VALUES"));
    const pairs = [...list.slice(0, list.indexOf(";")).matchAll(/\((\d+),(\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const past = pairs.slice(99);
    expect(past.map(([L]) => L)).toEqual(Array.from({ length: 101 }, (_, i) => 100 + i));
    const k = 13034431n, d = 9000000n;
    for (const [L, xp] of past) {
      const s = 9000000n + 900000n * BigInt(L - 99);
      expect([L, (s * k) / d]).toEqual([L, BigInt(xp)]);
      expect([L, ((s - 1n) * k) / d < BigInt(xp)]).toEqual([L, true]);
    }
  });

  // Seeded and driven-only: the only lifetime literals besides the legend
  // (Stage 10, R9: tests/attributes-rollup.test.ts, "stars start past 200").
  it("every tool levels by the OSRS formula", () => {
    const db = base();
    seedAgents(db, [
      { source: "codex", id: "c", entry: "Codex Desktop", driven: 1, startedAt: T,
        events: [[T, "session_start"], [T + 30, "prompt"], [T + 330, "stop"]] },
      { source: "hermes", id: "h", entry: "cli", driven: 1, startedAt: T,
        events: [[T, "session_start"], [T + 180, "prompt"], [T + 480, "stop"]] },
    ]);
    roll(db);
    expect(levelOf(db, "codex")).toEqual({
      active_s: 330, xp: 477, level: 5, tier: "Noobie", xp_into_level: 89, xp_to_next: 35, s_to_next: 24, stars: 0,
    });
    expect(levelOf(db, "hermes")).toEqual({
      active_s: 480, xp: 695, level: 7, tier: "Noobie", xp_into_level: 45, xp_to_next: 106, s_to_next: 74, stars: 0,
    });
    const claude = levelOf(db, "claude");
    expect(claude.active_s).toBe(rows<{ s: number }>(db, "SELECT SUM(active_ms) / 1000 AS s FROM claude_daily_rollups")[0].s);
    expect(claude.level).not.toBeNull();
  });

  // One event, no gap: guard 4's plant cannot give this session hours.
  it("a synced tool with no driven hours has no level", () => {
    const db = base();
    seedAgents(db, [{ source: "codex", id: "a", entry: "codex_exec", driven: 0, startedAt: T,
      events: [[T, "session_start"]], requests: [{ id: "a-r", ts: T + 10, model: "gpt-5.5", tin: 10 }] }]);
    roll(db);
    expect(levelOf(db, "codex")).toEqual({
      active_s: 0, xp: 0, level: null, tier: null, xp_into_level: null, xp_to_next: null, s_to_next: null, stars: null,
    });
  });

  // Spec 4.1: with nothing synced, Claude's level and nothing else.
  it("without Codex or Hermes, only Claude's progress row", () => {
    const db = base();
    const check = () => {
      expect(rows(db, "SELECT source FROM agent_progress")).toEqual([{ source: "claude" }]);
      for (const t of ["agent_prices", "agent_request_metrics", "agent_daily_rollups"]) {
        expect({ t, n: rows<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t}`)[0].n }).toEqual({ t, n: 0 });
      }
    };
    expect(rows(db, "SELECT name FROM sqlite_master WHERE name LIKE 'wt_%'")).toEqual([]);
    roll(db);
    check();
    applyWtSchema(db);
    roll(db);
    check();
  });
});

describe("end to end through the adapters", () => {
  it("Codex end to end: hours, counts and identities", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "wt-codex-repo-"));
    execFileSync("git", ["init", "-q"], { cwd });
    const db = base();
    await syncCodex(db, codexHome("core", cwd));
    const key = rows<{ p: string | null }>(db,
      `SELECT project_path AS p FROM claude_project_paths WHERE cwd = '${cwd.replace(/'/g, "''")}'`)[0].p;
    expect(key).not.toBeNull();
    expect(rows(db, `SELECT day, active_s FROM agent_daily_rollups WHERE source = 'codex'
      AND project_key = '${(key as string).replace(/'/g, "''")}' ORDER BY day`)).toEqual([
      { day: "2026-09-14", active_s: 15 },
      { day: "2026-09-15", active_s: 220 },
      { day: "2026-09-16", active_s: 95 },
    ]);
    expect(rows(db, `SELECT day, SUM(requests) AS r, SUM(sessions_driven) AS d, SUM(sessions_automated) AS a,
      SUM(sessions_unclassified) AS u FROM agent_daily_rollups WHERE source = 'codex' GROUP BY day ORDER BY day`))
      .toEqual([
        { day: "2026-09-14", r: 1, d: 1, a: 0, u: 0 },
        { day: "2026-09-15", r: 6, d: 1, a: 2, u: 1 },
        { day: "2026-09-16", r: 2, d: 1, a: 0, u: 0 },
      ]);

    // Identities: each query returns the rows that break it.
    const daily = (cols: string) => `SELECT day, ${cols} FROM agent_daily_rollups WHERE source = 'codex' GROUP BY day`;
    const metrics = (cols: string) => `SELECT day, ${cols} FROM agent_request_metrics WHERE source = 'codex' GROUP BY day`;
    expect(rows(db, `SELECT * FROM (${daily("SUM(requests) AS n")}) d
      FULL JOIN (${metrics("COUNT(*) AS n")}) m ON m.day = d.day
      WHERE d.n IS NULL OR m.n IS NULL OR d.n <> m.n`)).toEqual([]);
    expect(rows(db, `SELECT * FROM agent_daily_rollups
      WHERE source = 'codex' AND priced_requests + unpriced_requests <> requests`)).toEqual([]);
    expect(rows(db, `SELECT * FROM (${daily("TOTAL(cost_table_usd) AS c")}) d
      FULL JOIN (${metrics("TOTAL(cost_table_usd) AS c")}) m ON m.day = d.day
      WHERE d.c IS NULL OR m.c IS NULL OR ABS(d.c - m.c) >= 1e-12`)).toEqual([]);
    const tok = "SUM(tokens_in) AS i, SUM(tokens_out) AS o, SUM(tokens_cache_read) AS r, SUM(tokens_cache_creation) AS w";
    expect(rowsUtc(db, `SELECT * FROM (${daily(tok)}) d
      FULL JOIN (SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day, ${tok}
                 FROM wt_requests WHERE source = 'codex'
                 GROUP BY strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime')) q ON q.day = d.day
      WHERE d.day IS NULL OR q.day IS NULL OR d.i <> q.i OR d.o <> q.o OR d.r <> q.r OR d.w <> q.w`)).toEqual([]);
  });

  it("Hermes end to end", async () => {
    const db = base();
    await syncHermes(db, hermesHome("core"));
    // 2026-09-29 is h2, automated: guard 4's own test owns that row (R21).
    expect(rows(db, `SELECT day, SUM(active_s) AS active_s FROM agent_daily_rollups
      WHERE source = 'hermes' AND day <> '2026-09-29' GROUP BY day ORDER BY day`)).toEqual([
      { day: "2026-09-28", active_s: 460 },
      { day: "2026-10-01", active_s: 20 },
    ]);
    expect(rows(db, `SELECT day FROM agent_daily_rollups WHERE source = 'hermes'
      GROUP BY day HAVING SUM(own_priced_requests + own_unpriced_requests) <> SUM(requests)`)).toEqual([]);
    expect(rows<{ n: number }>(db, "SELECT SUM(requests) AS n FROM agent_daily_rollups WHERE source = 'hermes'")[0].n)
      .toBeGreaterThan(0);
    expect(rows(db, `SELECT source_record_id FROM agent_request_metrics
      WHERE source = 'hermes' AND priced IS NOT NULL`)).toEqual([]);
  });
});

describe("Claude is untouched", () => {
  it("Claude's rollups are untouched by the agent section", () => {
    const db = buildAndRoll("dashboard");
    const dump = () => ["claude_daily_rollups", "claude_project_rollups", "claude_rank_progress"].map((t) =>
      rows<Row>(db, `SELECT * FROM ${t} ORDER BY 1, 2`).map(({ updated_at: _u, ...r }) => r));
    const before = dump();
    expect(before[0].length).toBeGreaterThan(0);
    // One Codex session in a Claude project's own directory, one in a new cwd.
    const alpha = path.join(path.dirname(db), "tree", "proj-alpha");
    seedAgents(db, [
      { source: "codex", id: "c1", entry: "Codex Desktop", driven: 1, startedAt: 1750000000, cwd: alpha,
        events: [[1750000000, "session_start"], [1750000030, "prompt"], [1750000330, "stop"]],
        requests: [{ id: "c1-r", ts: 1750000100, model: "gpt-5.5", tin: 100, tout: 10 }] },
      { source: "codex", id: "c2", entry: "Codex Desktop", driven: 1, startedAt: T, cwd: "/tmp/wt-ag-claude-untouched",
        events: [[T, "session_start"], [T + 30, "prompt"], [T + 330, "stop"]] },
    ]);
    roll(db);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM agent_daily_rollups WHERE source = 'codex'")[0].n)
      .toBeGreaterThan(0);
    expect(dump()).toEqual(before);
  });

  it("a Codex cwd never delays a Claude cwd's resolution", () => {
    const db = buildAndRoll("resumed");
    execFileSync("sqlite3", [db, "DELETE FROM claude_project_paths;"]);
    seedAgents(db, [{ source: "codex", id: "first", entry: "Codex Desktop", driven: 1, startedAt: T,
      cwd: "/0-sorts-first", events: [[T, "session_start"]] }]);
    const cwds = () => rows<{ cwd: string }>(db, "SELECT cwd FROM claude_project_paths ORDER BY cwd").map((r) => r.cwd);
    expect(rerollup(db, ["--quiet"], { WATCHTOWER_RESOLVE_PER_RUN: "1" }).status).toBe(0);
    expect(cwds()).toEqual(["/tmp/fx"]);
    expect(rerollup(db, ["--quiet"], { WATCHTOWER_RESOLVE_PER_RUN: "1" }).status).toBe(0);
    expect(cwds()).toEqual(["/0-sorts-first", "/tmp/fx"]);
  });
});
