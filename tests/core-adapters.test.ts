import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWtSchema } from "@/lib/core/schema";
import {
  registerSource,
  isAuthoritative,
  authorityOwner,
  writeAuthority,
  listSources,
  safeDetect,
  safeHealth,
  contributesToActivityTotals,
} from "@/lib/core/adapters.ts";
import type { WatchtowerAdapter } from "@/lib/core/adapters";
import { execSql, querySql, sqlStr, sqlNum } from "@/lib/core/sql";

function tmpDb(): string {
  // Every database gets its OWN directory: the .wt-schema-vN marker lives in the
  // database's directory, so two databases sharing one would leave the second
  // silently schema-less.
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wtad-")), "t.sqlite");
  applyWtSchema(db);
  return db;
}

const claudeAdapter: WatchtowerAdapter = {
  id: "claude", type: "agent", label: "claude", version: 1,
  capabilities: ["sessions", "requests", "usage", "tools"],
  authority: [{ kind: "request", metrics: ["tokens_in", "tokens_out", "cost_usd"] }],
  async detect() { return { detected: true }; },
  async health() { return { state: "ok" }; },
  async *ingest() { /* nothing */ },
};

const atlasAdapter: WatchtowerAdapter = {
  id: "atlas", type: "agent", label: "atlas", version: 1,
  capabilities: ["sessions", "git", "checkpoints"],
  authority: [{ kind: "checkpoint", metrics: ["insertions", "deletions"] }],
  async detect() { return { detected: true }; },
  async health() { return { state: "ok" }; },
  async *ingest() { /* nothing */ },
};

/** Atlas as it would be if it (wrongly) declared ownership of Claude's tokens. */
const greedyAtlas: WatchtowerAdapter = {
  ...atlasAdapter,
  authority: [
    { kind: "checkpoint", metrics: ["insertions", "deletions"] },
    { kind: "request", metrics: ["tokens_out"] },
  ],
};

/** Insert a wt_sources row directly, bypassing registerSource's conflict check. */
function forceRow(db: string, source: string, firstSeen: number, authority: unknown): void {
  execSql(db, `INSERT INTO wt_sources
      (source, adapter_version, enabled, capabilities, authority, first_seen, updated_at)
    VALUES (${sqlStr(source)}, 1, 1, '[]', ${sqlStr(JSON.stringify(authority))},
            ${sqlNum(firstSeen)}, ${sqlNum(firstSeen)});`);
}

describe("source registry", () => {
  it("registers a source and lists it", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    expect(listSources(db).map((s) => s.source)).toEqual(["claude"]);
  });

  it("round-trips capabilities and authority as JSON", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    const row = listSources(db)[0];
    expect(JSON.parse(row.capabilities)).toEqual(["sessions", "requests", "usage", "tools"]);
    expect(JSON.parse(row.authority)).toEqual([
      { kind: "request", metrics: ["tokens_in", "tokens_out", "cost_usd"] },
    ]);
  });

  it("is idempotent and updates the adapter version in place", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    registerSource(db, { ...claudeAdapter, version: 2 });
    const all = listSources(db);
    expect(all).toHaveLength(1);
    expect(all[0].adapter_version).toBe(2);
  });

  // first_seen is the tie-break that decides ownership when a database ends up
  // with two claimants. Re-registration must never reset it, or a later restart
  // could silently hand a metric to the wrong source.
  it("preserves first_seen across re-registration", () => {
    const db = tmpDb();
    forceRow(db, "claude", 1000, claudeAdapter.authority);
    registerSource(db, { ...claudeAdapter, version: 3 });
    const rows = querySql<{ first_seen: number; adapter_version: number }>(
      db, `SELECT first_seen, adapter_version FROM wt_sources WHERE source='claude';`);
    expect(rows[0].first_seen).toBe(1000);
    expect(rows[0].adapter_version).toBe(3);
  });

  it("lets a source re-register its own authority claims without conflict", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    expect(() => registerSource(db, { ...claudeAdapter, version: 2 })).not.toThrow();
    expect(isAuthoritative(db, "claude", "request", "tokens_out")).toBe(true);
  });
});

describe("isAuthoritative", () => {
  it("is true for a metric the source declared", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    expect(isAuthoritative(db, "claude", "request", "tokens_out")).toBe(true);
  });

  it("is false for a metric the source never declared", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    registerSource(db, atlasAdapter);
    expect(isAuthoritative(db, "atlas", "request", "tokens_out")).toBe(false);
  });

  it("is false for an unregistered source", () => {
    const db = tmpDb();
    expect(isAuthoritative(db, "ghost", "request", "tokens_out")).toBe(false);
  });

  it("is false for an unregistered source even when another source owns the metric", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    expect(isAuthoritative(db, "ghost", "request", "tokens_out")).toBe(false);
  });

  it("is scoped by kind, not just metric name", () => {
    const db = tmpDb();
    registerSource(db, atlasAdapter);
    expect(isAuthoritative(db, "atlas", "checkpoint", "insertions")).toBe(true);
    expect(isAuthoritative(db, "atlas", "request", "insertions")).toBe(false);
  });

  it("is false for a metric name no source declared at all", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    expect(isAuthoritative(db, "claude", "request", "reasoning_tokens")).toBe(false);
  });
});

// THE LOAD-BEARING RULE: exactly one authoritative source per (kind, metric).
//
// Atlas's token_totals disagree with claude_requests by 2.03x on one session
// (it sums duplicate requestIds) and 0.42x on another (it cannot see subagent
// traffic). Two observers that disagree in BOTH directions cannot be averaged,
// so ownership is declared, not negotiated -- and a second declaration of an
// already-owned metric must be refused rather than silently honoured.
describe("exclusive ownership per (kind, metric)", () => {
  it("refuses to register a source claiming a metric another source already owns", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    expect(() => registerSource(db, greedyAtlas)).toThrow(/tokens_out/);
  });

  it("leaves the incumbent owner intact after a refused registration", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    expect(() => registerSource(db, greedyAtlas)).toThrow();
    expect(isAuthoritative(db, "claude", "request", "tokens_out")).toBe(true);
    expect(isAuthoritative(db, "atlas", "request", "tokens_out")).toBe(false);
    // The refused registration must not have half-written the row either.
    expect(listSources(db).map((s) => s.source)).toEqual(["claude"]);
  });

  it("never lets two sources both be authoritative for one (kind, metric)", () => {
    const db = tmpDb();
    // Bypass registerSource: a hand-edited or migrated database can reach this
    // state, and the query-time rule must hold anyway.
    forceRow(db, "claude", 1000, claudeAdapter.authority);
    forceRow(db, "atlas", 2000, greedyAtlas.authority);

    const owners = ["claude", "atlas"].filter(
      (s) => isAuthoritative(db, s, "request", "tokens_out"));
    expect(owners).toEqual(["claude"]);          // first claimant wins, exactly one
    expect(authorityOwner(db, "request", "tokens_out")).toBe("claude");

    // Atlas keeps what only it claims.
    expect(isAuthoritative(db, "atlas", "checkpoint", "insertions")).toBe(true);
  });

  it("breaks a first_seen tie deterministically rather than granting both", () => {
    const db = tmpDb();
    forceRow(db, "zeta", 5000, [{ kind: "request", metrics: ["tokens_out"] }]);
    forceRow(db, "alpha", 5000, [{ kind: "request", metrics: ["tokens_out"] }]);
    const owners = ["alpha", "zeta"].filter(
      (s) => isAuthoritative(db, s, "request", "tokens_out"));
    expect(owners).toHaveLength(1);
    expect(owners).toEqual(["alpha"]);
  });

  it("returns null for a metric nobody owns", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    expect(authorityOwner(db, "checkpoint", "insertions")).toBe(null);
  });
});

// detect() and health() are PROBES. A source that is absent, half-installed or
// broken is a state to report, not an exception to propagate: a throwing probe
// would abort discovery for every other source.
describe("probes never throw", () => {
  const exploding: WatchtowerAdapter = {
    ...atlasAdapter,
    id: "boom",
    async detect(): Promise<never> { throw new Error("detect exploded"); },
    async health(): Promise<never> { throw new Error("health exploded"); },
  };

  const explodingSync: WatchtowerAdapter = {
    ...atlasAdapter,
    id: "boom-sync",
    detect(): Promise<{ detected: boolean }> { throw new Error("sync detect exploded"); },
    health(): Promise<{ state: "ok" }> { throw new Error("sync health exploded"); },
  };

  it("converts a rejected detect() into a not-detected result", async () => {
    await expect(safeDetect(exploding)).resolves.toMatchObject({ detected: false });
    expect((await safeDetect(exploding)).detail).toMatch(/detect exploded/);
  });

  it("converts a rejected health() into unavailable", async () => {
    await expect(safeHealth(exploding)).resolves.toMatchObject({ state: "unavailable" });
    expect((await safeHealth(exploding)).detail).toMatch(/health exploded/);
  });

  it("catches a probe that throws synchronously, not just one that rejects", async () => {
    await expect(safeDetect(explodingSync)).resolves.toMatchObject({ detected: false });
    await expect(safeHealth(explodingSync)).resolves.toMatchObject({ state: "unavailable" });
  });

  it("passes a healthy probe's result through unchanged", async () => {
    expect(await safeDetect(claudeAdapter)).toEqual({ detected: true });
    expect(await safeHealth(claudeAdapter)).toEqual({ state: "ok" });
  });
});

// The source TYPE is not cosmetic: it decides what may enter cross-tool totals.
// Without it the Overview would add OpenViking's embedding tokens and Atlas's
// re-reported session tokens to Claude's and call the sum "AI spend" -- the same
// category error as double-counting, reached by a different route.
describe("source type taxonomy", () => {
  it("records the declared type and label", () => {
    const db = tmpDb();
    registerSource(db, {
      ...claudeAdapter, id: "atlas", type: "provenance", label: "Atlas",
      authority: [{ kind: "checkpoint", metrics: ["insertions"] }],
    });
    const row = listSources(db)[0];
    expect(row.source_type).toBe("provenance");
    expect(row.label).toBe("Atlas");
  });

  it("counts only agent sources toward activity and spend totals", () => {
    expect(contributesToActivityTotals("agent")).toBe(true);
    expect(contributesToActivityTotals("provenance")).toBe(false);
    expect(contributesToActivityTotals("memory")).toBe(false);
    expect(contributesToActivityTotals("health")).toBe(false);
  });

  it("defaults an existing row to agent rather than NULL", () => {
    const db = tmpDb();
    execSql(db, `INSERT INTO wt_sources
      (source, adapter_version, enabled, capabilities, authority, updated_at)
      VALUES ('legacy', 1, 1, '[]', '[]', 0);`);
    expect(listSources(db)[0].source_type).toBe("agent");
  });

  it("updates type and label in place on re-registration", () => {
    const db = tmpDb();
    registerSource(db, { ...claudeAdapter, label: "Claude Code" });
    registerSource(db, { ...claudeAdapter, label: "Claude Code (renamed)" });
    const all = listSources(db);
    expect(all).toHaveLength(1);
    expect(all[0].label).toBe("Claude Code (renamed)");
  });
});

describe("own-scope authority (R1)", () => {
  const own = (id: string): WatchtowerAdapter => ({
    ...claudeAdapter, id, label: id,
    authority: [{ kind: "request", metrics: ["tokens_in"], scope: "own" }],
  });

  it("two own claims register, and both may write", () => {
    const db = tmpDb();
    registerSource(db, own("claude"));
    registerSource(db, own("codex"));
    const may = writeAuthority(db);
    expect(may("claude", "request", "tokens_in")).toBe(true);
    expect(may("codex", "request", "tokens_in")).toBe(true);
  });

  it("an unscoped claim after an own claim is refused", () => {
    const db = tmpDb();
    registerSource(db, own("claude"));
    expect(() => registerSource(db, {
      ...atlasAdapter, authority: [{ kind: "request", metrics: ["tokens_in"] }],
    })).toThrow(/already owned by "claude"/);
  });

  it("an own claim after an unscoped claim is refused", () => {
    const db = tmpDb();
    registerSource(db, atlasAdapter);
    expect(() => registerSource(db, {
      ...own("later"), authority: [{ kind: "checkpoint", metrics: ["insertions"], scope: "own" }],
    })).toThrow(/already owned by "atlas"/);
  });

  it("an unregistered source and an undeclared metric both lack authority", () => {
    const db = tmpDb();
    registerSource(db, own("claude"));
    const may = writeAuthority(db);
    expect(may("ghost", "request", "tokens_in")).toBe(false);
    expect(may("claude", "request", "tokens_out")).toBe(false);
  });

  it("authorityOwner is null when every claim is own", () => {
    const db = tmpDb();
    registerSource(db, own("claude"));
    registerSource(db, own("codex"));
    expect(authorityOwner(db, "request", "tokens_in")).toBeNull();
  });

  it("re-registering the first owner after a later contending row does not throw", () => {
    const db = tmpDb();
    registerSource(db, own("claude"));
    forceRow(db, "later", 9_999_999_999, [{ kind: "request", metrics: ["tokens_in"] }]);
    expect(() => registerSource(db, own("claude"))).not.toThrow();
  });
});
