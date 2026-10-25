import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyWtSchema } from "@/lib/core/schema";
import { readLevels } from "@/lib/read/level";
import { readOverview } from "@/lib/read/overview";
import { API_COST_SQL, apiCostOf } from "@/lib/read/perf";
import { roll, seedAgents } from "./helpers/agent-seed";
import { buildAndRoll, rows } from "./helpers/fixture-db";

process.env.TZ = "UTC";

const NOW = Math.floor(Date.parse("2026-10-03T12:00:00Z") / 1000);
const sql = (db: string, s: string) => execFileSync("sqlite3", [db, s], { encoding: "utf8" });
const emptyHome = () => mkdtempSync(path.join(os.tmpdir(), "wt-home-"));

function synced(db: string, sources: string[]) {
  applyWtSchema(db);
  for (const s of sources) {
    sql(db, `INSERT OR REPLACE INTO wt_ingest_state (source, last_run_at, last_ok_at, health)
             VALUES ('${s}', ${NOW}, ${NOW}, 'ok');`);
  }
}

/** The guard-6 setup: Claude (priced-mixed), a Codex request and a Hermes request with its own cost. */
function setup(withHermes = true): string {
  const db = buildAndRoll("priced-mixed");
  seedAgents(db, [
    { source: "codex", id: "c", entry: "Codex Desktop", driven: 1, startedAt: 1789466400,
      requests: [{ id: "c1", ts: 1789466410, model: "gpt-5.5", tin: 600, tcr: 400, tout: 200 }] },
    ...(withHermes ? [{ source: "hermes" as const, id: "h", entry: "cli", driven: 1 as const, startedAt: 1789466400,
      requests: [{ id: "h1", ts: 1789466400, model: "x", tin: 10, cost: 0.5 }] }] : []),
  ]);
  synced(db, withHermes ? ["codex", "hermes"] : ["codex"]);
  roll(db);
  return db;
}

describe("readOverview", () => {
  it("Hermes's figure never enters at API prices", () => {
    const db = setup();
    const d = readOverview(db, { now: NOW, range: "all", home: emptyHome() });
    const claudeApi = apiCostOf(rows<{ usd: number; priced: number; unpriced: number }>(db,
      "SELECT " + API_COST_SQL + " FROM claude_request_metrics")[0]);
    expect(d.apiCost!.usd).toBeCloseTo(claudeApi.usd + 0.0092, 12);
    expect(d.apiCost!.priced).toBe(claudeApi.priced + 1);
    expect(d.hermesCost).toEqual({ usd: 0.5, priced: 1, unpriced: 0 });
  });

  it("shows a card per detected tool, and none for a missing one", () => {
    const db = setup(false);
    const home = emptyHome();
    expect(readOverview(db, { now: NOW, range: "all", home }).tools.map((t) => t.source)).toEqual(["claude", "codex"]);
    mkdirSync(path.join(home, ".hermes"));
    writeFileSync(path.join(home, ".hermes", "state.db"), "");
    const d = readOverview(db, { now: NOW, range: "all", home });
    expect(d.tools.map((t) => t.source)).toEqual(["claude", "codex", "hermes"]);
    expect(d.tools[2].status.state).toBe("not-synced");
    expect(d.tools[2].activeS).toBeNull();
  });

  it("a synced tool whose last sync failed says so", () => {
    const db = setup();
    sql(db, "UPDATE wt_ingest_state SET health = 'degraded' WHERE source = 'codex';");
    const codex = readOverview(db, { now: NOW, range: "all", home: emptyHome() }).tools.find((t) => t.source === "codex")!;
    expect(codex.status).toMatchObject({ state: "synced", degraded: true, lastOkAt: NOW });
  });

  // Final-review I3: a first sync that threw leaves last_run_at set and last_ok_at NULL.
  it("a source whose very first sync failed is failed, with its error, not not-synced", () => {
    const db = setup();
    sql(db, "UPDATE wt_ingest_state SET last_ok_at = NULL, health = 'degraded', last_error = 'state.db unreadable' WHERE source = 'codex';");
    const codex = readOverview(db, { now: NOW, range: "all", home: emptyHome() }).tools.find((t) => t.source === "codex")!;
    expect(codex.status).toMatchObject({ state: "failed", lastError: "state.db unreadable" });
    expect([codex.activeS, codex.requests, codex.apiCost]).toEqual([null, null, null]);
  });

  it("Total level and Max Cape count the detected tools", () => {
    const db = setup();
    const d = readOverview(db, { now: NOW, range: "all", home: emptyHome() });
    const lv = readLevels(db);
    const sum = Object.values(lv).flatMap((s) => (s.state === "level" ? [s.level.level] : [])).reduce((a, b) => a + b, 0);
    expect(d.totalLevel).toBe(sum);
    expect(d.maxCape!.of).toBe(3);
  });

  it("no agent rollup yet is pending, not zero", () => {
    const db = setup(false);
    sql(db, "DROP TABLE agent_daily_rollups; DROP TABLE agent_progress;");
    const d = readOverview(db, { now: NOW, range: "all", home: emptyHome() });
    expect(d.rollupPending).toBe(true);
    const codex = d.tools.find((t) => t.source === "codex")!;
    expect([codex.activeS, codex.requests, codex.apiCost]).toEqual([null, null, null]);
    expect(codex.level).toEqual({ state: "pending" });
  });

  it("OpenViking: unreachable, with the last recall and capture", () => {
    const db = buildAndRoll("priced-mixed");
    expect(readOverview(db, { now: NOW, range: "all", home: emptyHome() }).openviking).toEqual({ state: "absent" });
    applyWtSchema(db);
    const ev = (id: string, ts: number, probe: string, metrics: Record<string, number>) => {
      sql(db, `INSERT INTO wt_events (source, source_record_id, ts, kind, dimensions)
               VALUES ('openviking', '${id}', ${ts}, 'health', '{"probe":"${probe}"}');`);
      for (const [m, v] of Object.entries(metrics)) {
        sql(db, `INSERT INTO wt_usage (source, source_record_id, ts, metric, value)
                 VALUES ('openviking', '${id}', ${ts}, '${m}', ${v});`);
      }
    };
    ev("reachable:1790600200", 1790600200, "health", { reachable: 0 });
    ev("recall:1790600000", 1790600000, "recall", { recall_count: 3, recall_latency_ms: 42, recall_tokens: 512 });
    ev("capture:1790600100", 1790600100, "capture", { capture_turns: 4, capture_committed: 1 });
    expect(readOverview(db, { now: NOW, range: "all", home: emptyHome() }).openviking).toEqual({
      state: "seen", checkedAt: 1790600200, reachable: false,
      recall: { at: 1790600000, count: 3, latencyMs: 42, tokens: 512 },
      capture: { at: 1790600100, turns: 4, committed: true },
    });
  });

  it("days are stacked by tool", () => {
    const db = setup();
    const d = readOverview(db, { now: NOW, range: "all", home: emptyHome() });
    const days = d.daily.map((x) => x.day);
    expect(days.at(-1)).toBe("2026-10-03");
    expect(new Set(days).size).toBe(days.length);
    const first = Date.parse(`${days[0]}T00:00:00Z`);
    expect(days.length).toBe(Math.round((Date.parse("2026-10-03T00:00:00Z") - first) / 86400000) + 1);
    expect(d.daily.find((x) => x.day === "2026-09-15")!.codexS).toBeNull();
  });
});
