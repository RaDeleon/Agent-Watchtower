import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { ingestAndRoll, rerollup, rows } from "./helpers/fixture-db";

// Stage 4B Task 3: response time, tok/s and turns, derived in rollup.sh
// section 1's read phase from the durable capture (claude_requests' ms columns
// and claude_prompts). The fixture is turns-mixed in
// tests/fixtures/make-transcripts.sh; every expected value below is worked out
// from its lines by hand.

interface Metric { request_id: string; response_ms: number | null; tok_per_s: number | null }
interface Turn {
  entry_uuid: string; session_id: string; day: string; kind: string;
  requests: number; wait_ms: number | null; status: string;
}

const TURNS = "SELECT entry_uuid, session_id, day, kind, requests, wait_ms, status FROM claude_turns ORDER BY entry_uuid;";

let db: string;
beforeAll(() => { db = ingestAndRoll(["turns-mixed"]); });

describe("Stage 4B: response time and tok/s per request", () => {
  it("measures last partial minus the user entry before the request, and only when positive", () => {
    // The fixture really does carry the two NULL cases, so the NULLs below are
    // not vacuous: r7's last partial shares the prompt's ms (Review Focus 2),
    // and r_side / r_m have no user entry before them in their own file
    // (Review Focus 1).
    expect(rows(db, `SELECT request_id, sent_ms, last_ms FROM claude_requests
                     WHERE request_id IN ('r7','r_side','r_m') ORDER BY request_id;`)).toEqual([
      { request_id: "r7", sent_ms: Date.UTC(2026, 8, 10, 10, 4, 0), last_ms: Date.UTC(2026, 8, 10, 10, 4, 0) },
      { request_id: "r_m", sent_ms: null, last_ms: Date.UTC(2026, 8, 10, 12, 0, 1) },
      { request_id: "r_side", sent_ms: null, last_ms: Date.UTC(2026, 8, 10, 10, 0, 4, 500) },
    ]);

    expect(rows<Metric>(db, "SELECT request_id, response_ms, tok_per_s FROM claude_request_metrics ORDER BY request_id;"))
      .toEqual([
        { request_id: "r1", response_ms: 3000, tok_per_s: 200 },     // u_p1 -> 10:00:03.000, 600 out
        { request_id: "r2", response_ms: 1250, tok_per_s: 200 },     // tool result 10:00:04 -> 10:00:05.250
        { request_id: "r3", response_ms: 2000, tok_per_s: 50 },      // u_n1 -> 10:01:02
        { request_id: "r4", response_ms: 2000, tok_per_s: 25 },      // u_c1 -> 10:02:02, 50 out
        { request_id: "r5", response_ms: 1000, tok_per_s: 80 },      // tool result 10:02:30 -> 10:02:31
        { request_id: "r6", response_ms: 1000, tok_per_s: 40 },      // u_c2 -> 10:03:01
        { request_id: "r7", response_ms: null, tok_per_s: null },    // 0 is not positive
        { request_id: "r_h", response_ms: 2000, tok_per_s: 5 },      // u_h -> 11:00:02
        { request_id: "r_m", response_ms: null, tok_per_s: null },   // no user entry before it
        { request_id: "r_side", response_ms: null, tok_per_s: null }, // none in its own file
      ]);
  });
});

describe("Stage 4B: turns", () => {
  it("builds exactly one row per prompt/command boundary that owns a request", () => {
    // No row for u_i1 (interrupt), u_n1 (notification) or u_l1 (local), and
    // r3 -- after the notification -- belongs to no turn.
    expect(rows<Turn>(db, TURNS)).toEqual([
      { entry_uuid: "u_c1", session_id: "s_t", day: "2026-09-10", kind: "command", requests: 2, wait_ms: 31000, status: "human" },
      { entry_uuid: "u_c2", session_id: "s_t", day: "2026-09-10", kind: "command", requests: 1, wait_ms: 1000, status: "measured" },
      { entry_uuid: "u_h", session_id: "s_h", day: "2026-09-10", kind: "prompt", requests: 1, wait_ms: 2000, status: "headless" },
      { entry_uuid: "u_p1", session_id: "s_t", day: "2026-09-10", kind: "prompt", requests: 2, wait_ms: 5250, status: "measured" },
      { entry_uuid: "u_p2", session_id: "s_t", day: "2026-09-10", kind: "prompt", requests: 1, wait_ms: 0, status: "measured" },
    ]);
  });

  it("never counts a sidechain request, even one inside the turn's range in the same session", () => {
    // r_side is otherwise eligible: same session, first_ms inside u_p1's
    // range [10:00:00, 10:00:06).
    expect(rows(db, `SELECT session_id, is_sidechain, first_ms FROM claude_requests WHERE request_id = 'r_side';`))
      .toEqual([{ session_id: "s_t", is_sidechain: 1, first_ms: Date.UTC(2026, 8, 10, 10, 0, 4, 500) }]);
    expect(rows(db, "SELECT requests FROM claude_turns WHERE entry_uuid = 'u_p1';")).toEqual([{ requests: 2 }]);
  });

  it("marks a turn whose main thread asked the user a question as human, not measured", () => {
    expect(rows(db, `SELECT request_id, is_sidechain FROM claude_tool_calls WHERE tool_name = 'AskUserQuestion';`))
      .toEqual([{ request_id: "r4", is_sidechain: 0 }]);
    expect(rows(db, "SELECT status FROM claude_turns WHERE entry_uuid = 'u_c1';")).toEqual([{ status: "human" }]);
  });

  it("gives a command the requests after a local output in the same millisecond, whatever the row order (Review Focus 3)", () => {
    const own = ingestAndRoll(["turns-mixed"]);
    expect(rows(own, "SELECT entry_uuid, ts_ms, kind FROM claude_prompts WHERE entry_uuid IN ('u_c2','u_l1') ORDER BY entry_uuid;"))
      .toEqual([
        { entry_uuid: "u_c2", ts_ms: Date.UTC(2026, 8, 10, 10, 3, 0), kind: "command" },
        { entry_uuid: "u_l1", ts_ms: Date.UTC(2026, 8, 10, 10, 3, 0), kind: "local" },
      ]);
    // u_c2 owns r6 (first_ms 10:03:01): one request, a 1 s wait.
    const u_c2 = { entry_uuid: "u_c2", session_id: "s_t", day: "2026-09-10", kind: "command", requests: 1, wait_ms: 1000, status: "measured" };
    const before = rows<Turn>(own, TURNS);
    expect(before.filter((t) => t.entry_uuid === "u_c2")).toEqual([u_c2]);

    // Rebuild claude_prompts in the reverse physical order, and roll again.
    execFileSync("sqlite3", ["-bail", own, `
      CREATE TEMP TABLE saved AS SELECT * FROM claude_prompts;
      DELETE FROM claude_prompts;
      INSERT INTO claude_prompts SELECT * FROM saved ORDER BY entry_uuid DESC;`]);
    const physical = rows<{ entry_uuid: string }>(own, "SELECT entry_uuid FROM claude_prompts ORDER BY rowid;")
      .map((r) => r.entry_uuid);
    expect(physical).toEqual([...physical].sort().reverse());
    const r = rerollup(own, ["--quiet"]);
    expect(r.status).toBe(0);

    expect(rows<Turn>(own, TURNS)).toEqual(before);
  });
});
