import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOpenVikingAdapter } from "@/lib/adapters/openviking";
import { applyWtSchema } from "@/lib/core/schema";
import { runSync } from "@/lib/core/sync";
import { querySql } from "@/lib/core/sql";
import { buildAndRoll } from "./helpers/fixture-db";
import { readOverview } from "@/lib/read/overview";

const ROOT = path.resolve(__dirname, "..");

function ovHome(withState = true): string {
  const home = mkdtempSync(path.join(tmpdir(), "wt-ov-home-"));
  if (!withState) return home;
  const dir = path.join(home, ".openviking", "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "last-recall.json"), JSON.stringify({
    server_url: "SECRET-URL", latency_ms: 42, count: 3, content_items: 2, hint_items: 1,
    tokens_used: 512, tokens_budget: 2000, cc_session_id: "SECRET-CC", reason: "x", ts: 1790600000123,
  }));
  writeFileSync(path.join(dir, "last-capture.json"), JSON.stringify({
    turns_captured: 4, turns_queued: 0, turns_failed: 0, pending_tokens: 0, commit_threshold: 10,
    committed: true, commit_count: 2, total_message_count: 9, ov_session_id: "SECRET-OV",
    cc_session_id: "SECRET-CC", ts: 1790600100456,
  }));
  writeFileSync(path.join(home, ".openviking", "ovcli.conf"), "api_key = SECRET-KEY\n");
  return home;
}
function freshDb(): string {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wt-ov-db-")), "wt.sqlite");
  applyWtSchema(db);
  return db;
}
/** /health answers 200, everything else 401. */
async function serve(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => { res.statusCode = req.url === "/health" ? 200 : 401; res.end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));
const q = <T>(db: string, sql: string) => querySql<T>(db, sql);
const NOW = 1790600200000;

describe("OpenViking adapter", () => {
  it("reachable when /health answers 200", async () => {
    const { server, url } = await serve();
    const home = ovHome();
    const db = freshDb();
    await runSync({ db, adapters: [createOpenVikingAdapter({ db, home, baseUrl: url, now: () => NOW })] });
    await close(server);

    const m = (id: string) => Object.fromEntries(q<{ metric: string; value: number }>(db,
      `SELECT metric, value FROM wt_usage WHERE source = 'openviking' AND source_record_id = '${id}'`)
      .map((r) => [r.metric, r.value]));
    expect(m("reachable:latest")).toEqual({ reachable: 1 });
    expect(m("recall:1790600000")).toEqual({ recall_count: 3, recall_latency_ms: 42, recall_tokens: 512 });
    expect(m("capture:1790600100")).toEqual({ capture_turns: 4, capture_committed: 1 });
    expect(q<{ kind: string }>(db, "SELECT DISTINCT kind FROM wt_events WHERE source = 'openviking'"))
      .toEqual([{ kind: "health" }]);
  });

  it("unreachable is 0, never an error", async () => {
    const { server, url } = await serve();
    await close(server);
    const home = ovHome();
    const db = freshDb();
    const s = await runSync({ db, adapters: [createOpenVikingAdapter({ db, home, baseUrl: url, now: () => NOW })] });
    expect(s[0].error).toBeUndefined();
    expect(q(db, "SELECT value FROM wt_usage WHERE source_record_id = 'reachable:latest' AND metric = 'reachable'"))
      .toEqual([{ value: 0 }]);
  });

  it("no session ids, no URL, no key", async () => {
    const { server, url } = await serve();
    const home = ovHome();
    const db = freshDb();
    await runSync({ db, adapters: [createOpenVikingAdapter({ db, home, baseUrl: url, now: () => NOW })] });
    await close(server);
    const tables = q<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wt_%'");
    const dump = tables.map((t) => JSON.stringify(q(db, `SELECT * FROM ${t.name}`))).join("\n");
    for (const secret of ["SECRET-URL", "SECRET-CC", "SECRET-OV", "SECRET-KEY"]) {
      expect(`${secret}: ${dump.includes(secret)}`).toBe(`${secret}: false`);
    }
    expect(readFileSync(path.join(ROOT, "lib", "adapters", "openviking", "index.ts"), "utf8")).not.toContain("ovcli");
  });

  // Final-review M2: one probe row, overwritten, not ~105k rows a year of them.
  it("a second sync leaves one reachable row holding the newer reading and its time", async () => {
    const { server, url } = await serve();
    const home = ovHome();
    const db = buildAndRoll("priced-mixed"); // the Overview also reads Claude's tables
    applyWtSchema(db);
    const run = (now: number) => runSync({ db, adapters: [createOpenVikingAdapter({ db, home, baseUrl: url, now: () => now })] });
    await run(NOW);
    await close(server); // the second probe finds it down
    await run(1790600260000);
    expect(q(db, "SELECT source_record_id, ts FROM wt_events WHERE source = 'openviking' AND json_extract(dimensions, '$.probe') = 'health'"))
      .toEqual([{ source_record_id: "reachable:latest", ts: 1790600260 }]);
    expect(q(db, "SELECT metric, value, ts FROM wt_usage WHERE source = 'openviking' AND source_record_id = 'reachable:latest'"))
      .toEqual([{ metric: "reachable", value: 0, ts: 1790600260 }]);
    const o = readOverview(db, { now: 1790600300, range: "all", home }).openviking;
    expect(o).toMatchObject({ state: "seen", checkedAt: 1790600260, reachable: false });
  });

  it("unchanged state adds only a new reachable reading", async () => {
    const { server, url } = await serve();
    const home = ovHome();
    const db = freshDb();
    const run = (now: number) => runSync({ db, adapters: [createOpenVikingAdapter({ db, home, baseUrl: url, now: () => now })] });
    await run(NOW);
    const second = await run(1790600260000);
    await close(server);
    expect(second[0].ingested).toBe(1);
    expect(second[0].unchanged).toBe(2);
  });

  it("not detected without state", async () => {
    const db = freshDb();
    const s = await runSync({ db, adapters: [createOpenVikingAdapter({ db, home: ovHome(false), baseUrl: "http://127.0.0.1:1" })] });
    expect(s[0].detected).toBe(false);
  });
});
