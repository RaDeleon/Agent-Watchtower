import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWtSchema } from "@/lib/core/schema.ts";
import { registerSource } from "@/lib/core/adapters.ts";
import type { WatchtowerAdapter } from "@/lib/core/adapters.ts";
import { ingestRecords, readIngestState } from "@/lib/core/ingest.ts";
import { execSql, querySql } from "@/lib/core/sql.ts";
import { validateRecord } from "@/lib/core/records.ts";
import { linkExact, mintCanonicalId, upsertSession } from "@/lib/core/identity.ts";

function tmpDb(): string {
  // Every database gets its OWN directory: the schema marker lives in the
  // database's directory, so two databases sharing one would leave the second
  // with no schema at all.
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wting-")), "t.sqlite");
  applyWtSchema(db);
  return db;
}

const stub = (
  id: string,
  authority: WatchtowerAdapter["authority"],
): WatchtowerAdapter => ({
  id, type: "agent", label: id, version: 1,
  capabilities: ["requests"],
  authority,
  async detect() {
    return { detected: true };
  },
  async health() {
    return { state: "ok" };
  },
  async *ingest() {
    /* nothing */
  },
});

const claudeReq = validateRecord({
  source: "claude",
  sourceRecordId: "req-1",
  kind: "request",
  timestamp: "2026-09-14T12:00:00Z",
  model: "claude-opus-5",
  metrics: { tokens_in: 10, tokens_out: 20 },
  authority: "authoritative",
});

const atlasReq = validateRecord({
  source: "atlas",
  sourceRecordId: "atlas-1",
  kind: "request",
  timestamp: "2026-09-14T12:00:00Z",
  metrics: { tokens_out: 999999 }, // the double-count hazard
  dimensions: { branch: "main" },
  authority: "authoritative", // claims it, must still be refused
});

interface RequestRow {
  source: string;
  source_record_id: string;
  canonical_id: string | null;
  ts: number;
  model: string | null;
  branch: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
}

const requestRows = (db: string) =>
  querySql<RequestRow>(db, `SELECT * FROM wt_requests ORDER BY source, source_record_id;`);

describe("ingestRecords", () => {
  it("writes an authoritative metric", () => {
    const db = tmpDb();
    registerSource(
      db,
      stub("claude", [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }]),
    );
    const r = ingestRecords(db, "claude", [claudeReq]);
    expect(r.ingested).toBe(1);
    expect(r.metricsRejected).toBe(0);

    const rows = requestRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokens_in).toBe(10);
    expect(rows[0].tokens_out).toBe(20);
    expect(rows[0].model).toBe("claude-opus-5");
    // 1789387200: date -u -j -f "%Y-%m-%dT%H:%M:%S" "2026-09-14T12:00:00" +%s
    expect(rows[0].ts).toBe(1789387200);
  });

  // THE LOAD-BEARING TEST. Atlas's token_totals must never reach wt_requests.
  //
  // The plan asserted only `SELECT * FROM wt_requests WHERE tokens_out = 999999`
  // is empty -- which is equally true of a database where ingest wrote nothing
  // at all, or crashed, or never ran. So the row's EXISTENCE is asserted first,
  // and the metric is then pinned to NULL. An assertion that passes on absent
  // data proves nothing.
  it("rejects a non-authoritative metric and counts the rejection", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_out"] }]));
    registerSource(db, stub("atlas", [{ kind: "checkpoint", metrics: ["insertions"] }]));

    const r = ingestRecords(db, "atlas", [atlasReq]);
    expect(r.metricsRejected).toBe(1);
    expect(r.ingested).toBe(1);

    const rows = requestRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe("atlas");
    expect(rows[0].tokens_out).toBeNull();

    expect(querySql(db, `SELECT * FROM wt_requests WHERE tokens_out = 999999;`)).toHaveLength(0);
    // ...and it must not have slipped into the tall overflow table either.
    expect(querySql(db, `SELECT * FROM wt_usage;`)).toHaveLength(0);

    expect(readIngestState(db, "atlas").metrics_rejected).toBe(1);
  });

  // A rejected metric that has no typed column must not be "preserved" into
  // wt_usage. The overflow table is for ACCEPTED metrics only; routing
  // rejections there would reintroduce the number by another door.
  it("does not route a rejected unknown metric into wt_usage", () => {
    const db = tmpDb();
    registerSource(db, stub("atlas", [{ kind: "checkpoint", metrics: ["insertions"] }]));
    const r = ingestRecords(db, "atlas", [
      validateRecord({
        source: "atlas",
        sourceRecordId: "atlas-2",
        kind: "request",
        timestamp: "2026-09-14T12:00:00Z",
        metrics: { token_totals: 123456 },
        authority: "authoritative",
      }),
    ]);
    expect(r.metricsRejected).toBe(1);
    expect(requestRows(db)).toHaveLength(1); // the record itself was still written
    expect(querySql(db, `SELECT * FROM wt_usage;`)).toEqual([]);
  });

  it("still accepts dimensions from a non-authoritative source", () => {
    const db = tmpDb();
    registerSource(db, stub("atlas", [{ kind: "checkpoint", metrics: ["insertions"] }]));
    ingestRecords(db, "atlas", [atlasReq]);
    const row = querySql<{ branch: string | null }>(
      db,
      `SELECT branch FROM wt_requests WHERE source='atlas';`,
    );
    expect(row).toHaveLength(1);
    expect(row[0].branch).toBe("main");
  });

  // Upsert on the primary key is what makes cursors advisory.
  it("is idempotent -- re-ingesting the same record changes nothing", () => {
    const db = tmpDb();
    registerSource(
      db,
      stub("claude", [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }]),
    );
    ingestRecords(db, "claude", [claudeReq]);
    const first = requestRows(db);
    ingestRecords(db, "claude", [claudeReq]);
    const second = requestRows(db);
    expect(second).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it("is idempotent for wt_usage rows too", () => {
    const db = tmpDb();
    registerSource(db, stub("codex", [{ kind: "request", metrics: ["reasoning_tokens"] }]));
    const rec = validateRecord({
      source: "codex",
      sourceRecordId: "c1",
      kind: "request",
      timestamp: "2026-09-14T12:00:00Z",
      metrics: { reasoning_tokens: 42 },
      authority: "authoritative",
    });
    ingestRecords(db, "codex", [rec]);
    ingestRecords(db, "codex", [rec]);
    expect(querySql(db, `SELECT * FROM wt_usage;`)).toHaveLength(1);
  });

  it("leaves an absent metric NULL rather than writing 0", () => {
    const db = tmpDb();
    registerSource(
      db,
      stub("claude", [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }]),
    );
    ingestRecords(db, "claude", [claudeReq]);
    const rows = requestRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].cost_usd).toBeNull();
  });

  // ...and a metric the source measured as ZERO must survive as 0, not NULL.
  // "not exposed" and "measured zero" are different facts, in both directions.
  it("writes a measured zero as 0, not NULL", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_out"] }]));
    ingestRecords(db, "claude", [
      validateRecord({
        source: "claude",
        sourceRecordId: "zero-1",
        kind: "request",
        timestamp: "2026-09-14T12:00:00Z",
        metrics: { tokens_out: 0 },
        authority: "authoritative",
      }),
    ]);
    expect(requestRows(db)[0].tokens_out).toBe(0);
  });

  it("routes an unknown metric to wt_usage rather than dropping it", () => {
    const db = tmpDb();
    registerSource(db, stub("codex", [{ kind: "request", metrics: ["reasoning_tokens"] }]));
    ingestRecords(db, "codex", [
      validateRecord({
        source: "codex",
        sourceRecordId: "c1",
        kind: "request",
        timestamp: "2026-09-14T12:00:00Z",
        metrics: { reasoning_tokens: 42 },
        authority: "authoritative",
      }),
    ]);
    expect(
      querySql<{ metric: string; value: number }>(db, `SELECT metric, value FROM wt_usage;`),
    ).toEqual([{ metric: "reasoning_tokens", value: 42 }]);
  });

  // A typed metric must go to its COLUMN and not also to the overflow table:
  // two homes for one number is how a double count starts.
  it("does not duplicate a typed metric into wt_usage", () => {
    const db = tmpDb();
    registerSource(
      db,
      stub("claude", [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }]),
    );
    ingestRecords(db, "claude", [claudeReq]);
    expect(querySql(db, `SELECT * FROM wt_usage;`)).toEqual([]);
  });

  // The typed columns belong to wt_requests. On any OTHER kind the same metric
  // name has no typed home, so it must land in wt_usage instead of vanishing.
  it("routes a typed metric name to wt_usage when the kind is not request", () => {
    const db = tmpDb();
    registerSource(db, stub("atlas", [{ kind: "checkpoint", metrics: ["tokens_out"] }]));
    ingestRecords(db, "atlas", [
      validateRecord({
        source: "atlas",
        sourceRecordId: "cp-1",
        kind: "checkpoint",
        timestamp: "2026-09-14T12:00:00Z",
        metrics: { tokens_out: 7 },
        authority: "authoritative",
      }),
    ]);
    expect(querySql(db, `SELECT * FROM wt_requests;`)).toEqual([]);
    expect(
      querySql<{ metric: string; value: number }>(db, `SELECT metric, value FROM wt_usage;`),
    ).toEqual([{ metric: "tokens_out", value: 7 }]);
  });

  it("writes a non-request kind to wt_events with its dimensions and metadata", () => {
    const db = tmpDb();
    registerSource(db, stub("atlas", [{ kind: "checkpoint", metrics: ["insertions"] }]));
    ingestRecords(db, "atlas", [
      validateRecord({
        source: "atlas",
        sourceRecordId: "ev-1",
        kind: "git",
        timestamp: "2026-09-14T12:00:00Z",
        repo: "/tmp/repo",
        branch: "main",
        dimensions: { commit: "abc123" },
        metadata: { message: "it's fine" },
      }),
    ]);
    const rows = querySql<{
      kind: string;
      repo: string | null;
      branch: string | null;
      dimensions: string | null;
      metadata: string | null;
    }>(db, `SELECT kind, repo, branch, dimensions, metadata FROM wt_events;`);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("git");
    expect(rows[0].repo).toBe("/tmp/repo");
    expect(rows[0].branch).toBe("main");
    expect(JSON.parse(rows[0].dimensions!)).toEqual({ commit: "abc123" });
    // Apostrophe round-trip: cc_sqlstr's real data-loss bug, guarded here too.
    expect(JSON.parse(rows[0].metadata!)).toEqual({ message: "it's fine" });
  });

  // Absent is not "{}" any more than it is 0.
  it("leaves absent dimensions and metadata NULL rather than writing empty objects", () => {
    const db = tmpDb();
    ingestRecords(db, "atlas", [
      validateRecord({
        source: "atlas",
        sourceRecordId: "ev-2",
        kind: "git",
        timestamp: "2026-09-14T12:00:00Z",
      }),
    ]);
    const rows = querySql<{ dimensions: string | null; metadata: string | null }>(
      db,
      `SELECT dimensions, metadata FROM wt_events;`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].dimensions).toBeNull();
    expect(rows[0].metadata).toBeNull();
  });

  // The plan's implementation never wrote wt_tools at all, despite the task
  // naming it as an output table. A tool record landing in wt_events would be
  // a silent reclassification.
  it("writes a tool record to wt_tools", () => {
    const db = tmpDb();
    ingestRecords(db, "claude", [
      validateRecord({
        source: "claude",
        sourceRecordId: "t-1",
        kind: "tool",
        timestamp: "2026-09-14T12:00:00Z",
        dimensions: {
          tool_name: "search_files",
          tool_kind: "mcp",
          server: "drive",
          status: "ok",
        },
      }),
    ]);
    expect(querySql(db, `SELECT * FROM wt_events;`)).toEqual([]);
    expect(
      querySql<{ tool_name: string; tool_kind: string; server: string; status: string }>(
        db,
        `SELECT tool_name, tool_kind, server, status FROM wt_tools;`,
      ),
    ).toEqual([
      { tool_name: "search_files", tool_kind: "mcp", server: "drive", status: "ok" },
    ]);
  });

  // Never silently dropped: a record that cannot be written is COUNTED.
  it("counts a record it cannot write instead of aborting the batch", () => {
    const db = tmpDb();
    const good = validateRecord({
      source: "claude",
      sourceRecordId: "t-ok",
      kind: "tool",
      timestamp: "2026-09-14T12:00:00Z",
      dimensions: { tool_name: "Read" },
    });
    const bad = validateRecord({
      source: "claude",
      sourceRecordId: "t-bad",
      kind: "tool",
      timestamp: "2026-09-14T12:00:00Z", // no tool_name: wt_tools.tool_name is NOT NULL
    });
    const r = ingestRecords(db, "claude", [bad, good]);
    expect(r.malformed).toBe(1);
    expect(r.ingested).toBe(1); // the good record after it still landed
    expect(querySql(db, `SELECT tool_name FROM wt_tools;`)).toEqual([{ tool_name: "Read" }]);

    const st = readIngestState(db, "claude");
    expect(st.records_malformed).toBe(1);
    expect(st.health).toBe("degraded");
    expect(st.last_error).not.toBeNull();
  });

  it("attaches the canonical id when the session is already linked", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_out"] }]));
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    linkExact(db, {
      source: "claude",
      sourceLocalId: "sess-1",
      linkKind: "same_session",
      canonicalId: cid,
      evidence: "native_session_id == claude_sessions.session_id",
    });
    ingestRecords(db, "claude", [
      validateRecord({
        source: "claude",
        sourceRecordId: "req-linked",
        kind: "request",
        timestamp: "2026-09-14T12:00:00Z",
        sessionId: "sess-1",
        metrics: { tokens_out: 5 },
        authority: "authoritative",
      }),
    ]);
    expect(requestRows(db)[0].canonical_id).toBe(cid);
  });

  it("leaves canonical_id NULL when no link exists rather than inventing one", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_out"] }]));
    ingestRecords(db, "claude", [
      validateRecord({
        source: "claude",
        sourceRecordId: "req-unlinked",
        kind: "request",
        timestamp: "2026-09-14T12:00:00Z",
        sessionId: "sess-unknown",
        metrics: { tokens_out: 5 },
        authority: "authoritative",
      }),
    ]);
    expect(requestRows(db)[0].canonical_id).toBeNull();
  });

  it("updates ingest state counters", () => {
    const db = tmpDb();
    registerSource(
      db,
      stub("claude", [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }]),
    );
    ingestRecords(db, "claude", [claudeReq]);
    const st = readIngestState(db, "claude");
    expect(st.records_ingested).toBe(1);
    expect(st.records_malformed).toBe(0);
    expect(st.metrics_rejected).toBe(0);
    expect(st.health).toBe("ok");
    expect(st.last_run_at).not.toBeNull();
  });

  // Counters ACCUMULATE across runs. Overwriting them would make a rejection
  // burst invisible the moment a clean run followed it.
  it("accumulates rejection counts across runs rather than overwriting them", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_out"] }]));
    registerSource(db, stub("atlas", [{ kind: "checkpoint", metrics: ["insertions"] }]));
    ingestRecords(db, "atlas", [atlasReq]);
    // A CHANGED record: an identical one is skipped and counts nothing.
    ingestRecords(db, "atlas", [{ ...atlasReq, metrics: { tokens_out: 1000000 } }]);
    expect(readIngestState(db, "atlas").metrics_rejected).toBe(2);
    expect(readIngestState(db, "atlas").records_ingested).toBe(2);
  });

  it("records ingest state even for an empty batch", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_out"] }]));
    const r = ingestRecords(db, "claude", []);
    expect(r).toEqual({ ingested: 0, unchanged: 0, metricsRejected: 0, malformed: 0 });
    expect(readIngestState(db, "claude").records_ingested).toBe(0);
  });
});

/**
 * Sync reads the whole source every run and writes only what changed. These pin
 * both halves: an unchanged record costs no write, and ANY change -- to the
 * record, or to the session link it resolves through -- still gets written.
 */
describe("ingestRecords skips what has not changed", () => {
  const claudeDb = () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [
      { kind: "request", metrics: ["tokens_in", "tokens_out"] },
    ]));
    return db;
  };

  it("writes nothing for a record identical to the last one written", () => {
    const db = claudeDb();
    ingestRecords(db, "claude", [claudeReq]);
    const r = ingestRecords(db, "claude", [claudeReq]);
    expect(r).toEqual({ ingested: 0, unchanged: 1, metricsRejected: 0, malformed: 0 });
    expect(readIngestState(db, "claude").records_ingested).toBe(1);
  });

  it("rewrites a record whose content changed", () => {
    const db = claudeDb();
    ingestRecords(db, "claude", [claudeReq]);
    const r = ingestRecords(db, "claude", [{ ...claudeReq, metrics: { tokens_in: 10, tokens_out: 25 } }]);
    expect(r.ingested).toBe(1);
    expect(requestRows(db)[0].tokens_out).toBe(25);
  });

  it("rewrites a record whose session was linked after it was first written", () => {
    const db = claudeDb();
    const rec = { ...claudeReq, sessionId: "sess-late" };
    ingestRecords(db, "claude", [rec]);
    expect(requestRows(db)[0].canonical_id).toBeNull();

    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    linkExact(db, {
      source: "claude", sourceLocalId: "sess-late", linkKind: "same_session",
      canonicalId: cid, evidence: "test",
    });
    // The record itself is byte-identical. Only its link changed.
    const r = ingestRecords(db, "claude", [rec]);
    expect(r.ingested).toBe(1);
    expect(requestRows(db)[0].canonical_id).toBe(cid);
  });

  it("lands every good record when the batch fails in sqlite, and retries the bad one", () => {
    const db = tmpDb();
    const tool = (id: string) => validateRecord({
      source: "claude", sourceRecordId: id, kind: "tool",
      timestamp: "2026-09-14T12:00:00Z", dimensions: { tool_name: "Read" },
    });
    // Fails INSIDE sqlite, where the record looked valid in JS -- the case
    // that aborts the whole batch and has to fall back to one at a time.
    execSql(db, `CREATE TRIGGER boom BEFORE INSERT ON wt_tools
      WHEN NEW.source_record_id = 't-bad' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);

    const r = ingestRecords(db, "claude", [tool("t-1"), tool("t-bad"), tool("t-2")]);
    expect(r).toEqual({ ingested: 2, unchanged: 0, metricsRejected: 0, malformed: 1 });
    expect(querySql(db, `SELECT source_record_id FROM wt_tools ORDER BY 1;`))
      .toEqual([{ source_record_id: "t-1" }, { source_record_id: "t-2" }]);

    // No fingerprint was stored for the failure, so the next run tries it again.
    execSql(db, `DROP TRIGGER boom;`);
    const again = ingestRecords(db, "claude", [tool("t-1"), tool("t-bad"), tool("t-2")]);
    expect(again).toEqual({ ingested: 1, unchanged: 2, metricsRejected: 0, malformed: 0 });
  });
});

describe("readIngestState", () => {
  it("throws for a source that has never run rather than reporting zeroes", () => {
    const db = tmpDb();
    expect(() => readIngestState(db, "ghost")).toThrow(/ghost/);
  });
});
