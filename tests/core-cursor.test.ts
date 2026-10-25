import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWtSchema } from "@/lib/core/schema";
import { execSql } from "@/lib/core/sql";
import { fileCursorSql, readFileCursor, unchanged } from "@/lib/core/cursor";

describe("file cursor", () => {
  it("round-trips a stamp, keeping a 19-digit mtime exact", () => {
    const db = path.join(mkdtempSync(path.join(tmpdir(), "wtcur-")), "t.sqlite");
    applyWtSchema(db);
    const s = { size: 10, mtimeNs: "1789466400123456789" };
    execSql(db, fileCursorSql("codex", "/x/y.jsonl", s));
    expect(readFileCursor(db, "codex").get("/x/y.jsonl")).toEqual(s);
    expect(readFileCursor(db, "hermes").size).toBe(0);
  });

  it("unchanged needs a previous stamp and both fields equal", () => {
    const s = { size: 10, mtimeNs: "5" };
    expect(unchanged(undefined, s)).toBe(false);
    expect(unchanged(s, { ...s })).toBe(true);
    expect(unchanged(s, { ...s, size: 11 })).toBe(false);
    expect(unchanged(s, { ...s, mtimeNs: "6" })).toBe(false);
  });
});
