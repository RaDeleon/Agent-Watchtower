import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { applyWtSchema } from "@/lib/core/schema";
import { registerSource, isAuthoritative, safeDetect, safeHealth } from "@/lib/core/adapters";
import { createClaudeAdapter } from "@/lib/adapters/claude";

describe("createClaudeAdapter", () => {
  it("declares itself an agent, which is what may enter cross-tool totals", () => {
    const a = createClaudeAdapter({ db: "/nonexistent.sqlite" });
    expect(a.id).toBe("claude");
    expect(a.type).toBe("agent");
    expect(a.label).toBe("Claude Code");
  });

  it("claims token authority per request and cost per SESSION, not per request", () => {
    const db = buildAndRoll("orphan-request-tokens");
    applyWtSchema(db);
    const a = createClaudeAdapter({ db });
    registerSource(db, a);

    expect(isAuthoritative(db, "claude", "request", "tokens_in")).toBe(true);
    expect(isAuthoritative(db, "claude", "session", "cost_usd")).toBe(true);
    // The mapping corrected in Task 1: no Claude record can carry this.
    expect(isAuthoritative(db, "claude", "request", "cost_usd")).toBe(false);
  });

  it("detect() is true where the claude_* tables exist, false on an empty file", async () => {
    const real = buildAndRoll("two-sessions-day");
    expect((await safeDetect(createClaudeAdapter({ db: real }))).detected).toBe(true);
    expect((await safeDetect(createClaudeAdapter({ db: "/nonexistent.sqlite" })))
      .detected).toBe(false);
  });

  it("health() reports ok when requests exist and unavailable when the db is absent", async () => {
    const real = buildAndRoll("two-sessions-day");
    const okHealth = await safeHealth(createClaudeAdapter({ db: real }));
    expect(okHealth.state).toBe("ok");

    const missingHealth = await safeHealth(createClaudeAdapter({ db: "/nonexistent.sqlite" }));
    expect(missingHealth.state).toBe("unavailable");
  });

  /**
   * THE PROBE CONTRACT, ON THE METHOD ITSELF.
   *
   * detect() and health() are called here DIRECTLY, not through safeDetect and
   * safeHealth: the wrappers would catch a throw and hide exactly the defect
   * this asserts. WatchtowerAdapter documents "must not throw -- absence is a
   * state, not an error", and existsSync does not deliver that. A path can
   * exist and not be a SQLite database, and querySql's execFileSync threw
   * straight through the existsSync guard when it was not.
   */
  it("detect() and health() report a file that is not a SQLite database", async () => {
    const db = path.join(mkdtempSync(path.join(tmpdir(), "wt-corrupt-")), "bad.sqlite");
    writeFileSync(db, "this is not a database, it is a sentence\n");
    const a = createClaudeAdapter({ db });

    const d = await a.detect();
    expect(d.detected).toBe(false);
    expect(String(d.detail)).toContain("not a database");

    const h = await a.health();
    expect(h.state).toBe("unavailable");
    expect(String(h.detail)).toContain("not a database");
  });

  /**
   * health()'s OTHER failure mode: readable enough to detect, not readable
   * enough to count. Every other probe test in this file fails at detect() and
   * returns before the count is ever attempted, so health()'s catch was
   * unreachable -- planting a defect in it turned nothing red, which by this
   * repo's standard means the guard was not done.
   *
   * Zeroing every page BUT the first leaves the schema, which lives on page 1
   * of a database this small, while destroying the b-tree pages the rows sit
   * on. That is exactly the split health() describes: sqlite_master still
   * answers, claude_requests no longer does. Built by hand rather than from a
   * fixture because the real schema spills past page 1 and would take
   * sqlite_master down with it -- and because this asserts nothing about
   * values, only that an unreadable table is reported rather than thrown.
   */
  it("health() reports a database that detects but cannot be counted", async () => {
    const db = path.join(mkdtempSync(path.join(tmpdir(), "wt-halfdead-")), "half.sqlite");
    execFileSync("sqlite3", [db,
      "CREATE TABLE claude_requests(request_id TEXT PRIMARY KEY);" +
      "INSERT INTO claude_requests SELECT hex(randomblob(8)) FROM generate_series(1,200);"]);

    const buf = readFileSync(db);
    const pageSize = buf.readUInt16BE(16) || 65536;  // header offset 16; 1 means 65536
    expect(buf.length).toBeGreaterThan(pageSize);    // else there is nothing to destroy
    for (let p = 1; p < Math.floor(buf.length / pageSize); p++) {
      buf.fill(0, p * pageSize, (p + 1) * pageSize);
    }
    writeFileSync(db, buf);

    const a = createClaudeAdapter({ db });
    // Called directly, not through safeHealth: the wrapper would catch a throw
    // and hide the defect this exists to catch.
    expect((await a.detect()).detected).toBe(true);
    const h = await a.health();
    expect(h.state).toBe("unavailable");
    expect(String(h.detail)).toMatch(/malformed/i);
  });

  it("ingest() establishes identity before yielding the FIRST record, not eventually", async () => {
    const db = buildAndRoll("two-sessions-day");
    applyWtSchema(db);
    const a = createClaudeAdapter({ db });

    // Pull exactly one record out and check wt_links right then -- not after
    // draining the whole generator. ingestRecords resolves canonical_id out of
    // wt_links, so a record yielded before its link exists is written with a
    // NULL canonical id and never revisited. Checking only after full
    // consumption would pass even if identity were established last.
    const iter = a.ingest()[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_links;")[0].n)
      .toBeGreaterThan(0);

    const seen: string[] = first.value ? [first.value.kind] : [];
    for (let step = await iter.next(); !step.done; step = await iter.next()) {
      seen.push(step.value.kind);
    }
    expect(seen).toContain("request");
    expect(seen).toContain("event");
  });
});

describe("claude claims are own-scope (R1)", () => {
  it("every claim carries scope own", () => {
    const a = createClaudeAdapter({ db: "/nonexistent.sqlite" });
    expect(a.authority.length).toBeGreaterThan(0);
    expect(a.authority.every((c) => c.scope === "own")).toBe(true);
  });
});
