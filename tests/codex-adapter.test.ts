import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexAdapter } from "@/lib/adapters/codex";
import { CODEX_AUTOMATED, CODEX_DRIVEN, entryLists } from "@/lib/config";
import { applyWtSchema } from "@/lib/core/schema";
import { runSync } from "@/lib/core/sync";
import { querySql } from "@/lib/core/sql";

const MAKE_CODEX = path.resolve(__dirname, "fixtures", "make-codex-logs.sh");
const CWD = mkdtempSync(path.join(tmpdir(), "wt-codex-cwd-"));
const S = (home: string, rel: string) => path.join(home, ".codex", rel);

function codexHome(...scenarios: string[]): string {
  const home = mkdtempSync(path.join(tmpdir(), "wt-codex-home-"));
  addScenario(home, ...scenarios);
  return home;
}
function addScenario(home: string, ...scenarios: string[]): void {
  for (const s of scenarios) {
    execFileSync("bash", [MAKE_CODEX, s, home], { env: { ...process.env, WT_CODEX_CWD: CWD } });
  }
}
/** Its own directory: the schema markers live in the database's directory. */
function freshDb(): string {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wt-codex-db-")), "wt.sqlite");
  applyWtSchema(db);
  return db;
}
const q = <T>(db: string, sql: string) => querySql<T>(db, sql);
const sync = (db: string, home: string, lists = entryLists("codex", undefined)) =>
  runSync({ db, adapters: [createCodexAdapter({ db, home, lists })] });

async function syncedCore(): Promise<{ db: string; home: string }> {
  const home = codexHome("core");
  const db = freshDb();
  await sync(db, home);
  return { db, home };
}

describe("Codex adapter: tokens", () => {
  it("S1 normalised tokens", async () => {
    const { db, home } = await syncedCore();
    expect(q<Record<string, unknown>>(db, `SELECT source_record_id AS id, tokens_in, tokens_cache_read
      FROM wt_requests WHERE source_record_id IN ('resp_s1_a','resp_s1_b') ORDER BY 1`)
      .map((r) => [r.id, r.tokens_in, r.tokens_cache_read]))
      .toEqual([["resp_s1_a", 600, 400], ["resp_s1_b", 500, 1500]]);

    // Usage whose caches exceed its input is counted malformed and makes no row.
    const f = S(home, "sessions/2026/09/15/rollout-bad.jsonl");
    const t = new Date(1789466400_000).toISOString();
    appendFileSync(f, [
      { timestamp: t, type: "session_meta", payload: { id: "codex-bad", originator: "codex_exec" } },
      { timestamp: t, type: "token_usage_record", payload: { response_id: "resp_bad", usage: { input_tokens: 10, cached_input_tokens: 20, output_tokens: 1 } } },
    ].map((o) => JSON.stringify(o)).join("\n") + "\n");
    const [s] = await sync(db, home);
    expect(s.malformed).toBe(1);
    expect(q(db, "SELECT 1 FROM wt_requests WHERE source_record_id = 'resp_bad'")).toEqual([]);
  });

  it("reasoning stays out of tokens_out", async () => {
    const { db } = await syncedCore();
    const ids = "('resp_s1_a','resp_s1_b')";
    expect(q<{ v: number }>(db, `SELECT tokens_out AS v FROM wt_requests
      WHERE source_record_id IN ${ids} ORDER BY source_record_id`).map((r) => r.v)).toEqual([200, 300]);
    expect(q<{ v: number }>(db, `SELECT value AS v FROM wt_usage WHERE metric = 'reasoning_tokens'
      AND source_record_id IN ${ids} ORDER BY source_record_id`).map((r) => r.v)).toEqual([20, 30]);
  });

  it("S4 token_count deltas", async () => {
    const { db } = await syncedCore();
    const r = q<{ id: string; c: number }>(db, `SELECT source_record_id AS id, tokens_cache_read AS c
      FROM wt_requests WHERE source_record_id LIKE 'codex-s4:%' ORDER BY 1`);
    expect(r).toEqual([{ id: "codex-s4:1100", c: 600 }, { id: "codex-s4:2750", c: 600 }]);
  });

  it("requests carry the model in effect", async () => {
    const { db } = await syncedCore();
    const m = (id: string) => q<{ model: string }>(db,
      `SELECT model FROM wt_requests WHERE source_record_id = '${id}'`)[0].model;
    expect(m("resp_s2_a")).toBe("gpt-5.5");
    expect(m("resp_s2_b")).toBe("gpt-9-imaginary");
  });
});

describe("Codex adapter: sessions", () => {
  it("classifies entry points", async () => {
    const { db } = await syncedCore();
    const r = q<{ entry: string; driven: number | null }>(db,
      "SELECT entry, driven FROM wt_sessions ORDER BY entry");
    expect(r.map((x) => [x.entry, x.driven])).toEqual([
      ["Codex Desktop", 1], ["codex-tui", 1], ["codex_exec", 0], ["codex_vscode", 1],
      ["mystery-client", null], ["subagent:thread_spawn", 0],
    ]);
    expect(r).toHaveLength(6);
  });

  it("reclassification reaches skipped files (R18)", async () => {
    const { db, home } = await syncedCore();
    const driven = (e: string) => q<{ driven: number | null }>(db,
      `SELECT driven FROM wt_sessions WHERE entry = '${e}'`)[0].driven;
    expect(driven("mystery-client")).toBeNull();
    const [s] = await sync(db, home, {
      driven: [...CODEX_DRIVEN, "mystery-client", "subagent:thread_spawn"],
      automated: [...CODEX_AUTOMATED],
    });
    expect(s.ingested).toBe(0);
    expect(driven("mystery-client")).toBe(1);
    expect(driven("subagent:thread_spawn")).toBe(0);
  });

  it("the cursor skips unchanged files and is advisory", async () => {
    const { db, home } = await syncedCore();
    const [second] = await sync(db, home);
    expect([second.ingested, second.unchanged]).toEqual([0, 0]);
    expect(q<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_file_cursor")[0].n).toBe(6);
    q(db, "DELETE FROM wt_file_cursor");
    const [third] = await sync(db, home);
    expect(third.ingested).toBe(0);
    expect(third.unchanged).toBeGreaterThan(0);
  });

  it("RF1: a resume in a later folder is one session", async () => {
    const home = codexHome("resume");
    const db = freshDb();
    await sync(db, home);
    const s = q<{ canonical_id: string; started_at: number; ended_at: number }>(db,
      "SELECT canonical_id, started_at, ended_at FROM wt_sessions");
    expect(s).toHaveLength(1);
    expect([s[0].started_at, s[0].ended_at]).toEqual([1789480800, 1789722025]);
    expect(q<{ c: string }>(db, "SELECT DISTINCT canonical_id AS c FROM wt_events")).toEqual([{ c: s[0].canonical_id }]);
    expect(q<{ e: string }>(db, `SELECT json_extract(dimensions, '$.event') AS e FROM wt_events
      WHERE source_record_id = 'rollout-2026-09-18T09-00-00-codex-s5b:1'`)[0].e).toBe("session_start");
  });

  it("RF2: a line being written is read next time", async () => {
    const home = codexHome("partial");
    const db = freshDb();
    const [first] = await sync(db, home);
    expect(first.malformed).toBe(1);
    const has = (id: string) => q(db, `SELECT 1 FROM wt_requests WHERE source_record_id = '${id}'`).length === 1;
    expect(has("resp_s10_a")).toBe(true);
    expect(has("resp_s10_b")).toBe(false);
    const cur = () => q<{ path: string }>(db, "SELECT path FROM wt_file_cursor").map((r) => path.basename(r.path));
    expect(cur().some((p) => p.endsWith("codex-s11.jsonl"))).toBe(true);
    expect(cur().some((p) => p.endsWith("codex-s10.jsonl"))).toBe(false);

    addScenario(home, "partial-complete");
    const [second] = await sync(db, home);
    expect(second.malformed).toBe(0);
    expect(has("resp_s10_b")).toBe(true);
    expect(cur().some((p) => p.endsWith("codex-s10.jsonl"))).toBe(true);
    const st = q<{ health: string; records_malformed: number }>(db,
      "SELECT health, records_malformed FROM wt_ingest_state WHERE source = 'codex'")[0];
    expect([st.health, st.records_malformed]).toEqual(["ok", 1]);
  });

  it("RF5: first arrival wins a response_id", async () => {
    const owner = (db: string) => q<{ c: string; l: string }>(db, `SELECT r.canonical_id AS c, l.source_local_id AS l
      FROM wt_requests r JOIN wt_links l ON l.canonical_id = r.canonical_id AND l.source = 'codex'
      WHERE r.source_record_id = 'resp_dup'`);
    const home = codexHome("dup");
    const db = freshDb();
    await sync(db, home);
    expect(q(db, "SELECT 1 FROM wt_requests WHERE source_record_id = 'resp_dup'")).toHaveLength(1);
    expect(owner(db).map((r) => r.l)).toEqual(["codex-da"]);

    const home2 = codexHome("dup-b-only");
    const db2 = freshDb();
    await sync(db2, home2);
    addScenario(home2, "dup");
    await sync(db2, home2);
    expect(owner(db2).map((r) => r.l)).toEqual(["codex-db"]);
  });

  it("a deleted log keeps its rows", async () => {
    const { db, home } = await syncedCore();
    rmSync(S(home, "archived_sessions/rollout-2026-09-14T08-00-00-codex-s6.jsonl"));
    await sync(db, home);
    expect(q(db, "SELECT 1 FROM wt_requests WHERE source_record_id = 'resp_s6_a'")).toHaveLength(1);
    expect(q(db, "SELECT 1 FROM wt_links WHERE source = 'codex' AND source_local_id = 'codex-s6'")).toHaveLength(1);
    expect(q<{ n: number }>(db, `SELECT COUNT(*) AS n FROM wt_events
      WHERE source_record_id LIKE 'rollout-2026-09-14T08-00-00-codex-s6:%'`)[0].n).toBe(4);
  });

  it("copies no content", async () => {
    const { db } = await syncedCore();
    const tables = q<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'wt_%'");
    expect(tables.length).toBeGreaterThan(5);
    const all = tables.map((t) => q(db, `SELECT * FROM ${t.name}`));
    expect(JSON.stringify(all)).not.toContain("SECRET");
  });

  it("is not detected without logs", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "wt-codex-empty-"));
    mkdirSync(path.join(empty, ".codex"));
    const db = freshDb();
    const lists = entryLists("codex", undefined);
    expect((await createCodexAdapter({ db, home: empty, lists }).detect()).detected).toBe(false);
    const [s] = await sync(db, empty);
    expect(s.detected).toBe(false);
    expect(q(db, "SELECT 1 FROM wt_sources WHERE source = 'codex'")).toEqual([]);
  });
});
