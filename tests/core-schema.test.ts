import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WT_SCHEMA_VERSION, wtMarkerName, applyWtSchema } from "@/lib/core/schema";
import { querySql, execSql } from "@/lib/core/sql";

const ROOT = path.resolve(__dirname, "..");

function tmpDb(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "wtschema-")), "t.sqlite");
}

function tables(db: string): string[] {
  return querySql<{ name: string }>(
    db, `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`
  ).map((r) => r.name);
}

describe("wt schema", () => {
  it("creates every wt_ table", () => {
    const db = tmpDb();
    applyWtSchema(db);
    const t = tables(db);
    for (const name of [
      "wt_sources", "wt_ingest_state", "wt_sessions", "wt_session_state",
      "wt_links", "wt_requests", "wt_usage", "wt_events", "wt_tools", "wt_metrics",
    ]) {
      expect(`${name}: ${t.includes(name)}`).toBe(`${name}: true`);
    }
  });

  it("is idempotent via the marker fast path", () => {
    const db = tmpDb();
    applyWtSchema(db);
    applyWtSchema(db);
    expect(tables(db).filter((n) => n === "wt_sources")).toHaveLength(1);
  });

  // The test above asserts LESS than "idempotent" sounds: the second call
  // short-circuits on the marker and never re-runs the DDL, so it proves the
  // fast path works, not that the DDL is re-runnable. Deleting the marker is
  // what actually exercises CREATE TABLE IF NOT EXISTS re-entrancy -- and that
  // is a real case: the marker lives in the database's DIRECTORY, so anything
  // that cleans that directory, or a fresh checkout pointed at an existing DB,
  // lands here.
  it("re-applies cleanly against an existing database when the marker is gone", () => {
    const db = tmpDb();
    applyWtSchema(db);
    execSql(db, `INSERT INTO wt_sources
      (source, adapter_version, enabled, capabilities, authority, updated_at)
      VALUES ('claude', 1, 1, '[]', '[]', 0);`);
    rmSync(path.join(path.dirname(db), wtMarkerName()));

    expect(() => applyWtSchema(db)).not.toThrow();
    expect(tables(db).filter((n) => n === "wt_sources")).toHaveLength(1);
    // CREATE TABLE IF NOT EXISTS must not have dropped or recreated the table.
    expect(querySql<{ n: number }>(db, `SELECT COUNT(*) AS n FROM wt_sources;`)[0].n)
      .toBe(1);
  });

  it("writes a marker in the database's directory", () => {
    const db = tmpDb();
    applyWtSchema(db);
    expect(existsSync(path.join(path.dirname(db), wtMarkerName()))).toBe(true);
  });

  // THE TRAP: two markers in one directory are safe ONLY because the names
  // differ. capture/lib.sh uses .schema-v<CC_SCHEMA_VERSION>.
  it("uses a marker name that cannot collide with the capture layer's", () => {
    const lib = readFileSync(path.join(ROOT, "capture", "lib.sh"), "utf8");
    const m = /^CC_SCHEMA_VERSION=(\d+)$/m.exec(lib);
    expect(m).not.toBeNull();
    expect(wtMarkerName()).not.toBe(`.schema-v${m![1]}`);
    expect(wtMarkerName().startsWith(".wt-schema-v")).toBe(true);
  });

  it("pins WT_SCHEMA_VERSION to the marker name it generates", () => {
    expect(wtMarkerName()).toBe(`.wt-schema-v${WT_SCHEMA_VERSION}`);
  });

  it("coexists with claude_ tables in one database", () => {
    const db = tmpDb();
    execSql(db, `CREATE TABLE claude_requests (request_id TEXT PRIMARY KEY);`);
    applyWtSchema(db);
    const t = tables(db);
    expect(t.includes("claude_requests")).toBe(true);
    expect(t.includes("wt_requests")).toBe(true);
  });
});

describe("wt schema v3", () => {
  const cols = (db: string, t: string) => querySql<{ name: string }>(
    db, `SELECT name FROM pragma_table_info('${t}');`).map((r) => r.name);

  it("a fresh database has the v3 columns, cursor table, indexes and marker", () => {
    const db = tmpDb();
    applyWtSchema(db);
    expect(cols(db, "wt_sessions")).toEqual(expect.arrayContaining(["cwd", "entry", "driven"]));
    expect(cols(db, "wt_file_cursor")).toEqual(["source", "path", "size", "mtime_ns"]);
    const idx = querySql<{ name: string }>(db, `SELECT name FROM sqlite_master WHERE type='index';`)
      .map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["idx_wt_events_canonical", "idx_wt_requests_canonical"]));
    expect(existsSync(path.join(path.dirname(db), ".wt-schema-v3"))).toBe(true);
  });

  it("a v2 database upgrades in place, keeping its rows", () => {
    const db = tmpDb();
    execSql(db, `CREATE TABLE wt_sessions (
      canonical_id TEXT PRIMARY KEY, first_source TEXT NOT NULL, started_at INTEGER,
      ended_at INTEGER, project TEXT, repo TEXT, branch TEXT, agent TEXT, model TEXT,
      updated_at INTEGER NOT NULL);
      INSERT INTO wt_sessions (canonical_id, first_source, updated_at) VALUES ('c1', 'claude', 1);`);
    applyWtSchema(db);
    expect(querySql<{ canonical_id: string }>(db, "SELECT canonical_id FROM wt_sessions;"))
      .toEqual([{ canonical_id: "c1" }]);
    expect(cols(db, "wt_sessions")).toEqual(expect.arrayContaining(["cwd", "entry", "driven"]));
    expect(existsSync(path.join(path.dirname(db), ".wt-schema-v3"))).toBe(true);
  });

  it("re-applying without the marker does not throw: the ALTERs are guarded", () => {
    const db = tmpDb();
    applyWtSchema(db);
    rmSync(path.join(path.dirname(db), ".wt-schema-v3"));
    expect(() => applyWtSchema(db)).not.toThrow();
  });
});
