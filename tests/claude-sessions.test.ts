import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { applyWtSchema } from "@/lib/core/schema";
import { projectClaudeSessions } from "@/lib/adapters/claude/sessions";

/** A fixture DB with the wt_* schema applied over it. */
function projected(scenario: string): string {
  const db = buildAndRoll(scenario);
  applyWtSchema(db);
  projectClaudeSessions(db);
  return db;
}

describe("projectClaudeSessions", () => {
  it("mints one canonical session per claude_sessions row", () => {
    const db = projected("two-sessions-day");
    const src = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_sessions;")[0].n;
    const out = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_sessions;")[0].n;
    expect(out).toBe(src);
    expect(out).toBeGreaterThan(0);
  });

  it("writes an EXACT link whose evidence is the session id it joined on", () => {
    const db = projected("two-sessions-day");
    const links = rows<{ source: string; source_local_id: string; link_kind: string;
                        confidence: string; evidence: string }>(
      db, "SELECT * FROM wt_links ORDER BY source_local_id;");
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.source).toBe("claude");
      expect(l.link_kind).toBe("same_session");
      expect(l.confidence).toBe("exact");
      // The audit trail must name the key actually used, not a restatement.
      expect(l.evidence).toBe(`claude_sessions.session_id=${l.source_local_id}`);
    }
  });

  it("is idempotent: a second run mints no new canonical ids", () => {
    const db = projected("two-sessions-day");
    const first = rows<{ id: string }>(db,
      "SELECT canonical_id AS id FROM wt_sessions ORDER BY canonical_id;");
    projectClaudeSessions(db);
    const second = rows<{ id: string }>(db,
      "SELECT canonical_id AS id FROM wt_sessions ORDER BY canonical_id;");
    expect(second).toEqual(first);
  });

  it("marks a session with no ingested requests 'pending', not complete", () => {
    // partial-transcript-coverage has sessions on both sides of this line.
    const db = projected("partial-transcript-coverage");
    const states = rows<{ session_id: string; state: string; reqs: number }>(db, `
      SELECT l.source_local_id AS session_id, st.state AS state,
             (SELECT COUNT(*) FROM claude_requests r
               WHERE r.session_id = l.source_local_id) AS reqs
        FROM wt_links l
        JOIN wt_session_state st ON st.canonical_id = l.canonical_id
       WHERE st.source = 'claude';`);
    expect(states.length).toBeGreaterThan(0);
    for (const s of states) {
      expect(`${s.session_id}: ${s.state}`)
        .toBe(`${s.session_id}: ${s.reqs > 0 ? "complete" : "pending"}`);
    }
  });

  it("never reads duration_ms", () => {
    const src = readFileSync(
      path.resolve(__dirname, "..", "lib", "adapters", "claude", "sessions.ts"), "utf8");
    expect(src).not.toContain("duration_ms");
  });
});
