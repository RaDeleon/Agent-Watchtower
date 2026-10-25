import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAtlasAdapter } from "@/lib/adapters/atlas";
import { createClaudeAdapter } from "@/lib/adapters/claude";
import { findAtlasDbs } from "@/lib/core/discovery";
import { runSync } from "@/lib/core/sync";
import { buildAndRoll, rows } from "./helpers/fixture-db";

const DDL = `CREATE TABLE agent_session (id TEXT PRIMARY KEY, workspace_id TEXT, source TEXT,
  native_session_id TEXT NOT NULL, token_totals TEXT, started_at TEXT, updated_at TEXT);
CREATE TABLE checkpoint (id TEXT PRIMARY KEY, session_id TEXT);
CREATE TABLE file_touch (id TEXT PRIMARY KEY, session_id TEXT, deleted INTEGER);`;
const T = "'2026-09-14T18:18:48.012389+00:00'";

function atlasDb(file: string, sql: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync("sqlite3", ["-cmd", ".bail on", file, DDL + sql]);
}

async function setup() {
  const db = buildAndRoll("resumed");
  const sid = rows<{ s: string }>(db, "SELECT session_id AS s FROM claude_sessions LIMIT 1")[0].s;
  await runSync({ db, adapters: [createClaudeAdapter({ db })] });
  const root = mkdtempSync(path.join(tmpdir(), "wt-atlas-"));
  const a = path.join(root, "repo-a", ".atlas", "sessions.db");
  const b = path.join(root, "x", "repo-b", ".atlas", "sessions.db");
  const hidden = path.join(root, ".hidden", ".atlas", "sessions.db");
  atlasDb(a, `
    INSERT INTO agent_session VALUES ('as-1','w','external_jsonl','${sid}','{"input":987654321}',${T},${T});
    INSERT INTO agent_session VALUES ('as-2','w','acp','${sid}',NULL,${T},${T});
    INSERT INTO agent_session VALUES ('as-9','w','acp','not-a-claude-session',NULL,${T},${T});
    INSERT INTO checkpoint VALUES ('c1','as-1'),('c2','as-1'),('c3','as-2'),('c4','as-2'),('c5','as-2');
    INSERT INTO file_touch VALUES ('f1','as-1',0),('f2','as-1',1),('f3','as-2',0),('f4','as-2',0);`);
  atlasDb(b, `INSERT INTO agent_session VALUES ('as-5','w','acp','${sid}',NULL,${T},${T});`);
  atlasDb(hidden, `INSERT INTO agent_session VALUES ('as-h','w','acp','${sid}',NULL,${T},${T});`);
  return { db, sid, root, a, b };
}

describe("Atlas adapter", () => {
  it("finds every Atlas db under the roots, skipping dot dirs", async () => {
    const { root, a, b } = await setup();
    expect(findAtlasDbs([root], 3)).toEqual([a, b].sort());
  });

  it("links to Claude's session and counts", async () => {
    const { db, sid, root } = await setup();
    await runSync({ db, adapters: [createAtlasAdapter({ db, roots: [root] })] });
    const claude = rows<{ c: string }>(db,
      `SELECT canonical_id AS c FROM wt_links WHERE source = 'claude' AND source_local_id = '${sid}' AND link_kind = 'same_session'`)[0].c;
    expect(rows(db, `SELECT canonical_id AS c FROM wt_links
      WHERE source = 'atlas' AND source_local_id = 'as-1' AND link_kind = 'same_session'`)).toEqual([{ c: claude }]);
    const m = (id: string) => Object.fromEntries(rows<{ metric: string; value: number }>(db,
      `SELECT metric, value FROM wt_usage WHERE source = 'atlas' AND source_record_id = '${id}'`).map((r) => [r.metric, r.value]));
    expect(m("as-1")).toEqual({ atlas_checkpoints: 2, atlas_files_touched: 1 });
    expect(m("as-2")).toEqual({ atlas_checkpoints: 3, atlas_files_touched: 2 });
    expect(rows(db, `SELECT 1 FROM wt_usage WHERE source_record_id = 'as-9'`)).toEqual([]);
    expect(rows(db, `SELECT 1 FROM wt_links WHERE source_local_id = 'as-9'`)).toEqual([]);
    expect(rows(db, `SELECT 1 FROM wt_events WHERE source_record_id = 'as-9'`)).toEqual([]);
  });

  it("never reads token_totals", async () => {
    const { db, root } = await setup();
    await runSync({ db, adapters: [createAtlasAdapter({ db, roots: [root] })] });
    const tables = rows<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wt_%'");
    const dump = tables.map((t) => JSON.stringify(rows(db, `SELECT * FROM ${t.name}`))).join("\n");
    expect(dump.includes("987654321")).toBe(false);
  });

  it("contributes no tokens", async () => {
    const { db, root } = await setup();
    await runSync({ db, adapters: [createAtlasAdapter({ db, roots: [root] })] });
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests WHERE source = 'atlas'")[0].n).toBe(0);
  });
});
