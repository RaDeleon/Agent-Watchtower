import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWtSchema } from "@/lib/core/schema";
import { execSql, querySql, sqlStr } from "@/lib/core/sql";
import { classifyEntry, reclassifySql } from "@/lib/adapters/entry";

const lists = { driven: ["cli"], automated: ["api_server"] };

describe("classifyEntry", () => {
  it.each([
    ["cli", 1], ["api_server", 0], ["other", null], [undefined, null], ["subagent:x", 0],
  ] as const)("%s -> %s", (entry, want) => {
    expect(classifyEntry(entry, lists)).toBe(want);
  });

  it("a subagent is automated even when listed as driven", () => {
    expect(classifyEntry("subagent:x", { driven: ["subagent:x"], automated: [] })).toBe(0);
  });
});

describe("reclassifySql", () => {
  it("renders an empty list as IN (NULL)", () => {
    const sql = reclassifySql("codex", { driven: [], automated: [] });
    expect(sql.split("IN (NULL)").length - 1).toBe(2);
  });

  it("updates only the named source, and agrees with classifyEntry", () => {
    const db = path.join(mkdtempSync(path.join(tmpdir(), "wtent-")), "t.sqlite");
    applyWtSchema(db);
    const entries: (string | null)[] = ["cli", "api_server", "other", "subagent:x", null];
    entries.forEach((e, i) => execSql(db, `INSERT INTO wt_sessions
      (canonical_id, first_source, entry, driven, updated_at)
      VALUES ('c${i}', 'codex', ${sqlStr(e)}, 1, 1), ('h${i}', 'hermes', ${sqlStr(e)}, 1, 1);`));
    execSql(db, reclassifySql("codex", lists));
    const got = querySql<{ canonical_id: string; entry: string | null; driven: number | null }>(
      db, "SELECT canonical_id, entry, driven FROM wt_sessions;");
    for (const r of got) {
      if (r.canonical_id.startsWith("c")) expect(r.driven).toBe(classifyEntry(r.entry, lists));
      else expect(r.driven).toBe(1);
    }
    expect(got.length).toBe(10);
  });
});
