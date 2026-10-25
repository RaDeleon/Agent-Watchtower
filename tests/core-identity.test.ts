import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWtSchema } from "@/lib/core/schema";
import { querySql, execSql } from "@/lib/core/sql";
import {
  mintCanonicalId, linkExact, resolveCanonicalId, upsertSession, setSessionState,
} from "@/lib/core/identity";
import * as identity from "@/lib/core/identity";

const ROOT = path.resolve(__dirname, "..");

function tmpDb(): string {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wtid-")), "t.sqlite");
  applyWtSchema(db);
  return db;
}

describe("mintCanonicalId", () => {
  it("returns distinct ids", () => {
    expect(mintCanonicalId()).not.toBe(mintCanonicalId());
  });

  it("namespaces the id so it can never be mistaken for a source-local one", () => {
    expect(mintCanonicalId()).toMatch(
      /^wt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("linkExact", () => {
  it("links a source-local id to a canonical id and resolves it back", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    linkExact(db, {
      source: "atlas", sourceLocalId: "sess-abc", linkKind: "same_session",
      canonicalId: cid, evidence: "native_session_id == claude_sessions.session_id",
    });
    expect(resolveCanonicalId(db, "atlas", "sess-abc", "same_session")).toBe(cid);
  });

  it("returns null for an unknown link", () => {
    expect(resolveCanonicalId(tmpDb(), "atlas", "nope", "same_session")).toBeNull();
  });

  // The primary key is (source, source_local_id, link_kind). A lookup that
  // ignored any leg of it would hand back another source's session.
  it("resolves scoped by source AND link kind, not by local id alone", () => {
    const db = tmpDb();
    const a = mintCanonicalId();
    const b = mintCanonicalId();
    upsertSession(db, { canonicalId: a, firstSource: "claude" });
    upsertSession(db, { canonicalId: b, firstSource: "claude" });
    linkExact(db, { source: "atlas", sourceLocalId: "s1", linkKind: "same_session",
                    canonicalId: a, evidence: "e" });
    linkExact(db, { source: "atlas", sourceLocalId: "s1", linkKind: "produced_commit",
                    canonicalId: b, evidence: "e" });
    expect(resolveCanonicalId(db, "atlas", "s1", "same_session")).toBe(a);
    expect(resolveCanonicalId(db, "atlas", "s1", "produced_commit")).toBe(b);
    expect(resolveCanonicalId(db, "codex", "s1", "same_session")).toBeNull();
  });

  it("is idempotent on re-link", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    const args = { source: "atlas", sourceLocalId: "s1", linkKind: "same_session" as const,
                   canonicalId: cid, evidence: "e" };
    linkExact(db, args);
    linkExact(db, args);
    expect(querySql(db, `SELECT * FROM wt_links;`)).toHaveLength(1);
  });

  // DECISION 13: exact only. Nothing writes 'inferred' in Stage 3.
  it("only ever writes confidence = exact", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    linkExact(db, { source: "atlas", sourceLocalId: "s1",
                    linkKind: "same_session", canonicalId: cid, evidence: "e" });
    const all = querySql<{ confidence: string }>(db, `SELECT confidence FROM wt_links;`);
    // NOT all.every(): every() on an empty table is vacuously true, so a
    // linkExact that wrote nothing at all would have passed that form.
    expect(all.map((r) => r.confidence)).toEqual(["exact"]);
  });

  // DECISION 13, enforced against the MODULE and not just against one row.
  // The row-level assertion above can only go red if a test is also edited to
  // call the offending function; this one goes red the moment the capability
  // exists at all, which is what "there is no linkInferred()" actually means.
  it("exposes no way to write a non-exact link", () => {
    expect(Object.keys(identity).filter((k) => /inferred/i.test(k))).toEqual([]);
    const src = readFileSync(path.join(ROOT, "lib", "core", "identity.ts"), "utf8");
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments explain the rule; they may name it
      .replace(/\/\/.*$/gm, "");
    expect(code.includes("inferred")).toBe(false);
  });

  it("requires evidence, so a link is always auditable", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    expect(() => linkExact(db, {
      source: "atlas", sourceLocalId: "s1", linkKind: "same_session",
      canonicalId: cid, evidence: "",
    })).toThrow(/evidence/);
  });

  // Whitespace is not an audit trail.
  it("rejects blank evidence, not merely the empty string", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    expect(() => linkExact(db, {
      source: "atlas", sourceLocalId: "s1", linkKind: "same_session",
      canonicalId: cid, evidence: "   ",
    })).toThrow(/evidence/);
    expect(querySql(db, `SELECT * FROM wt_links;`)).toHaveLength(0);
  });
});

describe("upsertSession", () => {
  it("is idempotent and fills a field that was unknown at first write", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    upsertSession(db, {
      canonicalId: cid, firstSource: "claude",
      startedAt: 1789344000, endedAt: 1789347600,
      project: "watchtower", agent: "claude-code", model: "claude-opus-5",
    });
    const rows = querySql<{
      started_at: number | null; ended_at: number | null;
      project: string | null; agent: string | null; model: string | null;
    }>(db, `SELECT started_at, ended_at, project, agent, model FROM wt_sessions;`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      started_at: 1789344000, ended_at: 1789347600,
      project: "watchtower", agent: "claude-code", model: "claude-opus-5",
    });
  });

  // An upsert whose excluded values are NULL must not erase what is already
  // known -- a later record that simply does not carry a field is not a
  // statement that the field is now absent.
  it("does not blank an established field with a later NULL", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, {
      canonicalId: cid, firstSource: "claude",
      startedAt: 1789344000, project: "watchtower", agent: "claude-code",
      model: "claude-opus-5", repo: "/r", branch: "main",
    });
    upsertSession(db, { canonicalId: cid, firstSource: "claude", endedAt: 1789347600 });
    const rows = querySql<{
      started_at: number | null; ended_at: number | null; project: string | null;
      repo: string | null; branch: string | null; agent: string | null; model: string | null;
    }>(db, `SELECT started_at, ended_at, project, repo, branch, agent, model FROM wt_sessions;`);
    expect(rows[0]).toEqual({
      started_at: 1789344000, ended_at: 1789347600, project: "watchtower",
      repo: "/r", branch: "main", agent: "claude-code", model: "claude-opus-5",
    });
  });
});

describe("session completeness", () => {
  // Decision 5: a live session has provenance from one source and no usage yet
  // from another. That is NOT "zero usage".
  it("records pending and complete per source", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    setSessionState(db, cid, "claude", "pending");
    expect(querySql<{ state: string }>(db,
      `SELECT state FROM wt_session_state WHERE canonical_id='${cid}';`)[0].state)
      .toBe("pending");
    setSessionState(db, cid, "claude", "complete");
    expect(querySql<{ state: string }>(db,
      `SELECT state FROM wt_session_state WHERE canonical_id='${cid}';`)[0].state)
      .toBe("complete");
  });

  // The whole point of the table: state is keyed PER SOURCE. One source going
  // complete must not speak for another that has reported nothing yet.
  it("keeps one source's state independent of another's", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    setSessionState(db, cid, "claude", "complete");
    setSessionState(db, cid, "atlas", "pending");
    expect(querySql<{ source: string; state: string }>(db,
      `SELECT source, state FROM wt_session_state ORDER BY source;`))
      .toEqual([{ source: "atlas", state: "pending" }, { source: "claude", state: "complete" }]);
  });

  it("rejects a state outside pending|complete", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    // @ts-expect-error -- deliberately invalid
    expect(() => setSessionState(db, cid, "claude", "maybe")).toThrow(/state/);
    expect(querySql(db, `SELECT * FROM wt_session_state;`)).toHaveLength(0);
  });
});

describe("agentSessionSql", () => {
  const row = (db: string) => querySql<Record<string, unknown>>(
    db, "SELECT * FROM wt_sessions WHERE canonical_id = 'c1';")[0];
  const run = (db: string, a: Partial<identity.AgentSessionUpsert>) => execSql(db,
    identity.agentSessionSql({ canonicalId: "c1", source: "codex", driven: null, ...a }));

  it("takes MIN started_at and MAX ended_at across observations", () => {
    const db = tmpDb();
    run(db, { startedAt: 100, endedAt: 200 });
    run(db, { startedAt: 50, endedAt: 150 });
    expect(row(db)).toMatchObject({ started_at: 50, ended_at: 200 });
    run(db, {});
    expect(row(db)).toMatchObject({ started_at: 50, ended_at: 200 });
  });

  it("cwd and entry take the newest non-null; driven is verbatim, NULL included", () => {
    const db = tmpDb();
    run(db, { cwd: "/a", entry: "cli", driven: 1 });
    run(db, { cwd: "/b", entry: "tui", driven: 1 });
    expect(row(db)).toMatchObject({ cwd: "/b", entry: "tui", driven: 1 });
    run(db, { driven: null });
    expect(row(db)).toMatchObject({ cwd: "/b", entry: "tui", driven: null });
  });

  it("model is fill-if-missing and first_source is the given source", () => {
    const db = tmpDb();
    run(db, { model: "a" });
    run(db, { model: "b" });
    expect(row(db)).toMatchObject({ model: "a", first_source: "codex" });
  });
});
