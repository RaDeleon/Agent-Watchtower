import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClaudeAdapter } from "@/lib/adapters/claude";
import { createHermesAdapter, hermesCost } from "@/lib/adapters/hermes";
import { entryLists } from "@/lib/config";
import { applyWtSchema } from "@/lib/core/schema";
import { runSync } from "@/lib/core/sync";
import { querySql } from "@/lib/core/sql";
import { buildAndRoll } from "./helpers/fixture-db";

const MAKE_HERMES = path.resolve(__dirname, "fixtures", "make-hermes-db.sh");

function hermesHome(scenario: string): string {
  const home = mkdtempSync(path.join(tmpdir(), "wt-hermes-home-"));
  execFileSync("bash", [MAKE_HERMES, scenario, path.join(home, ".hermes", "state.db")]);
  return home;
}
/** Its own directory: the schema markers live in the database's directory. */
function freshDb(): string {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wt-hermes-db-")), "wt.sqlite");
  applyWtSchema(db);
  return db;
}
const q = <T>(db: string, sql: string) => querySql<T>(db, sql);
const sync = (db: string, home: string, lists = entryLists("hermes", undefined)) =>
  runSync({ db, adapters: [createHermesAdapter({ db, home, lists })] });

async function syncedCore(): Promise<{ db: string; home: string }> {
  const home = hermesHome("core");
  const db = freshDb();
  await sync(db, home);
  return { db, home };
}

describe("Hermes adapter", () => {
  it("projects sessions with their entry point", async () => {
    const { db } = await syncedCore();
    expect(q(db, `SELECT entry, driven, started_at, ended_at, cwd FROM wt_sessions
      WHERE first_source = 'hermes' ORDER BY started_at`)).toEqual([
      { entry: "cli", driven: 1, started_at: 1790596800, ended_at: 1790597300, cwd: "/tmp/wt-hermes-cli" },
      { entry: "api_server", driven: 0, started_at: 1790672400, ended_at: 1790672440, cwd: null },
      { entry: "telegram", driven: 1, started_at: 1790841600, ended_at: null, cwd: "/tmp/wt-hermes-cli" },
    ]);
    expect(q(db, `SELECT source, source_local_id AS id, link_kind AS kind, evidence FROM wt_links
      WHERE source = 'hermes' AND source_local_id = 'h1'`))
      .toEqual([{ source: "hermes", id: "h1", kind: "same_session", evidence: "sessions.id=h1" }]);
  });

  it("events from timestamps and roles only", async () => {
    const { db } = await syncedCore();
    const events = (id: string) => q<{ r: string; e: string }>(db, `SELECT source_record_id AS r, json_extract(dimensions, '$.event') AS e
      FROM wt_events WHERE source = 'hermes' AND canonical_id =
        (SELECT canonical_id FROM wt_links WHERE source = 'hermes' AND source_local_id = '${id}')
      ORDER BY ts, json_extract(dimensions, '$.seq')`).map((x) => [x.r, x.e]);
    expect(events("h1")).toEqual([
      ["start:h1", "session_start"], ["msg:1", "prompt"], ["msg:2", "activity"], ["msg:3", "activity"],
      ["msg:4", "stop"], ["msg:5", "prompt"], ["msg:6", "stop"], ["end:h1", "session_end"],
    ]);
    expect(events("h3").some(([r]) => r.startsWith("end:"))).toBe(false);
  });

  it("tokens are copied verbatim from session_model_usage", async () => {
    const { db } = await syncedCore();
    const id = (sid: string, m: string, p: string) => JSON.stringify([sid, m, p, "", "", ""]);
    const want = [
      { id: id("h1", "gpt-oss-120b", "openrouter"), i: 3000, o: 500, cr: 2000, cw: 100 },
      { id: id("h1", "qwen3-coder", "local"), i: 1000, o: 200, cr: 0, cw: 0 },
      { id: id("h2", "gpt-oss-120b", "openrouter"), i: 400, o: 40, cr: 0, cw: 0 },
      { id: id("h3", "mystery-model", "unknown"), i: 50, o: 5, cr: 0, cw: 0 },
    ];
    expect(q(db, `SELECT source_record_id AS id, tokens_in AS i, tokens_out AS o,
        tokens_cache_read AS cr, tokens_cache_creation AS cw FROM wt_requests
        WHERE source = 'hermes' ORDER BY source_record_id`))
      .toEqual(want.sort((x, y) => (x.id < y.id ? -1 : 1)));
    expect(q<{ v: number }>(db, `SELECT value AS v FROM wt_usage WHERE metric = 'reasoning_tokens'
      AND source_record_id = '${JSON.stringify(["h1", "gpt-oss-120b", "openrouter", "", "", ""])}'`))
      .toEqual([{ v: 50 }]);
    // Hermes stores no per-call time: a request sits at its session's start.
    expect(q(db, `SELECT r.ts AS ts, s.started_at AS started FROM wt_requests r
      JOIN wt_sessions s ON s.canonical_id = r.canonical_id WHERE r.source = 'hermes'
      AND r.ts <> s.started_at`)).toEqual([]);
    expect(q<{ n: number }>(db, `SELECT COUNT(*) AS n FROM wt_requests r JOIN wt_sessions s
      ON s.canonical_id = r.canonical_id WHERE r.source = 'hermes'`)[0].n).toBe(4);
  });

  it("Hermes's figure follows R8", async () => {
    const { db } = await syncedCore();
    const id = (s: string, m: string, p: string) => JSON.stringify([s, m, p, "", "", ""]);
    const cost = (rid: string) => q<{ c: number | null }>(db,
      `SELECT cost_usd AS c FROM wt_requests WHERE source_record_id = '${rid}'`)[0]?.c;
    const actual = (rid: string) => q<{ v: number }>(db,
      `SELECT value AS v FROM wt_usage WHERE metric = 'cost_actual' AND source_record_id = '${rid}'`)[0]?.v;
    expect(cost(id("h1", "qwen3-coder", "local"))).toBe(0);
    expect(actual(id("h1", "qwen3-coder", "local"))).toBe(0);
    expect(cost(id("h1", "gpt-oss-120b", "openrouter"))).toBe(0.5);
    expect(actual(id("h1", "gpt-oss-120b", "openrouter"))).toBe(1);
    expect(cost(id("h2", "gpt-oss-120b", "openrouter"))).toBe(0.0123);
    expect(actual(id("h2", "gpt-oss-120b", "openrouter"))).toBe(0);
    expect(cost(id("h3", "mystery-model", "unknown"))).toBeNull();
    expect(actual(id("h3", "mystery-model", "unknown"))).toBeUndefined();
  });

  it("hermesCost applies R8", () => {
    expect(hermesCost({ actual_cost_usd: 0, estimated_cost_usd: 0, cost_status: "estimated" }))
      .toEqual({ cost_usd: 0, cost_actual: 0 });
    expect(hermesCost({ actual_cost_usd: 0.5, estimated_cost_usd: 0.02, cost_status: "actual" }))
      .toEqual({ cost_usd: 0.5, cost_actual: 1 });
    expect(hermesCost({ actual_cost_usd: 0, estimated_cost_usd: 0.0123, cost_status: "estimated" }))
      .toEqual({ cost_usd: 0.0123, cost_actual: 0 });
    expect(hermesCost({ actual_cost_usd: 0, estimated_cost_usd: 0, cost_status: "unknown" })).toBeNull();
    expect(hermesCost({ actual_cost_usd: 0, estimated_cost_usd: 0.3, cost_status: "unknown" })).toBeNull();
  });

  it("copies no content", async () => {
    const { db } = await syncedCore();
    const tables = q<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wt_%'");
    const dump = JSON.stringify(tables.map((t) => q(db, `SELECT * FROM ${t.name}`)));
    expect(tables.length).toBeGreaterThan(5);
    expect(dump).not.toContain("SECRET");
  });

  it("never writes the source", async () => {
    const home = hermesHome("core");
    const state = path.join(home, ".hermes", "state.db");
    // The database file is byte-identical and its WAL gains no frames. Whether
    // -wal and -shm exist afterwards is SQLite's, not ours: a WAL database with
    // no -shm cannot be opened read-only before SQLite 3.54, so querySql falls
    // back to a query_only open (lib/core/sql.ts), which builds the WAL index
    // and may leave an empty -wal. Apple's build keeps both after any open.
    const walBytes = () => (existsSync(`${state}-wal`) ? readFileSync(`${state}-wal`).length : 0);
    const snap = () => [createHash("sha1").update(readFileSync(state)).digest("hex"), walBytes()];
    const before = snap();
    await sync(freshDb(), home);
    expect(snap()).toEqual(before);
  });

  it("an unreadable state.db degrades Hermes only", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "wt-hermes-bad-"));
    mkdirSync(path.join(home, ".hermes"), { recursive: true });
    writeFileSync(path.join(home, ".hermes", "state.db"), "not a database\n");
    const db = buildAndRoll("orphan-request-tokens");
    const lists = entryLists("hermes", undefined);
    const [claude, hermes] = await runSync({
      db, adapters: [createClaudeAdapter({ db }), createHermesAdapter({ db, home, lists })],
    });
    expect(claude.ingested).toBeGreaterThan(0);
    expect(claude.error).toBeUndefined();
    expect(hermes.detected).toBe(true);
    expect(hermes.error).toContain("not a database");
    expect(q<{ health: string }>(db, "SELECT health FROM wt_ingest_state WHERE source = 'hermes'"))
      .toEqual([{ health: "degraded" }]);
  });

  it("reclassification follows config", async () => {
    const { db, home } = await syncedCore();
    const driven = () => q<{ driven: number | null }>(db, `SELECT driven FROM wt_sessions
      WHERE first_source = 'hermes' AND entry = 'api_server'`)[0].driven;
    expect(driven()).toBe(0);
    await sync(db, home, { driven: ["cli", "tui", "telegram", "api_server"], automated: [] });
    expect(driven()).toBe(1);
  });
});
