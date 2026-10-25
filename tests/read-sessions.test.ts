import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAtlasAdapter } from "@/lib/adapters/atlas";
import { createClaudeAdapter } from "@/lib/adapters/claude";
import { runSync } from "@/lib/core/sync";
import { buildAndRoll, rows } from "./helpers/fixture-db.ts";
import { readProjects } from "@/lib/read/projects";
import { RANGES } from "@/lib/read/range";
import { SESSION_CAP, contextPerTurn, readSessions, type SessionRow } from "@/lib/read/sessions";

// The rollup buckets by LOCAL day under TZ=UTC; the reader's sqlite3 child
// inherits this, so both agree on which day a timestamp belongs to.
process.env.TZ = "UTC";

const BASE = 1750000000; // Sunday 2025-06-15, 15:06:40 UTC
const DAY = 86400;
/** Tuesday 2025-06-17, the `dashboard` scenario's last day. */
const NOW = BASE + 2 * DAY + 1000;

const dash = buildAndRoll("dashboard", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });

describe("readSessions, on the `dashboard` fixture", () => {
  const s = readSessions(dash, { now: NOW });
  const one = (sid: string, project?: string): SessionRow => {
    const hit = s.rows.filter((r) => r.sessionId === sid && (project === undefined || r.project.endsWith(project)));
    expect(hit, `${sid} ${project ?? ""}`).toHaveLength(1);
    return hit[0];
  };

  // GUARD 2. S_GHOST's requests carry a session_id with no claude_sessions
  // row -- 22.4% of real requests. Aggregated through claude_sessions, it and
  // its tokens vanish while every other row still looks right. It ran in two
  // projects, so it has a row in each, each with only that project's tokens.
  it("aggregates from claude_requests alone, keeping a session with no claude_sessions row", () => {
    const beta = one("S_GHOST", "/proj-beta");
    expect([beta.requests, beta.freshTokens, beta.cacheRead]).toEqual([1, 31 + 2903, 510]);
    expect(beta.contextPerTurn).toBe(31 + 510 + 37);
    const unfiled = one("S_GHOST", "(unfiled)");
    expect([unfiled.requests, unfiled.freshTokens, unfiled.cacheRead]).toEqual([1, 47 + 601, 0]);
    expect(beta.terminal).toBeNull();
    expect(beta.costUsd).toBeNull();
  });

  it("sums a session's requests, with context per turn over all its requests", () => {
    const a = one("S_A");
    expect(a.project.endsWith("/proj-alpha")).toBe(true);
    expect(a.requests).toBe(3);
    expect(a.freshTokens).toBe(11 + 13 + 17 + 1301 + 907 + 503);
    expect(a.cacheRead).toBe(130 + 190);
    expect(a.contextPerTurn).toBeCloseTo((11 + 13 + 17 + 130 + 190 + 0 + 17 + 19 + 0) / 3, 9);
    expect([a.firstTs, a.lastTs]).toEqual([BASE + 200, BASE + 400]);
    expect(a.terminal).toBe("ghostty");
  });

  // Snapshot cost is a running total: S_A's readings are 0.5, 1.0, 1.5.
  // MAX is 1.5; a SUM would be 3.0.
  it("takes cost as MAX per session over its snapshots, never a SUM", () => {
    expect(one("S_A").costUsd).toBeCloseTo(1.5, 9);
    expect(one("S_B").costUsd).toBeCloseTo(0.8, 9);
  });

  it("hides (excluded) sessions and projects, at read time", () => {
    expect(s.rows.map((r) => r.sessionId)).not.toContain("S_EX");
    expect(s.projects.some((p) => p.endsWith("skipme") || p === "(excluded)")).toBe(false);
    expect(s.projects.map((p) => p.replace(/.*\//, ""))).toEqual(["(unfiled)", "proj-alpha", "proj-beta"]);
  });

  it("filters to one project on record", () => {
    const alpha = s.projects.find((p) => p.endsWith("/proj-alpha"))!;
    const f = readSessions(dash, { now: NOW, project: alpha });
    expect(f.project).toBe(alpha);
    expect(f.rows.map((r) => r.sessionId)).toEqual(["S_A"]);
  });

  // An unknown project -- hostile or just stale -- matches nothing, and never
  // reaches SQL: a NUL byte could not even ride in sqlite3's argv.
  it("matches nothing for a project not on record, without erroring", () => {
    for (const p of ["../../x", "x".repeat(10 * 1024), "'; DROP TABLE claude_requests; --", "a\u0000b"]) {
      const f = readSessions(dash, { now: NOW, project: p });
      expect(f.rows).toEqual([]);
      expect(f.capped).toBe(false);
      expect(f.project).toBe(p);
    }
  });

  it("reads an empty window as no rows", () => {
    const later = readSessions(dash, { now: NOW + 100 * DAY, range: "7d" });
    expect(later.rows).toEqual([]);
    expect(later.capped).toBe(false);
    expect(readSessions(dash, { now: NOW + 100 * DAY, range: "all" }).rows).toHaveLength(s.rows.length);
  });
});

describe("contextPerTurn", () => {
  it("has no reading with no request to divide by", () => {
    expect(contextPerTurn(10, 20, 30, 0)).toBeNull();
    expect(contextPerTurn(10, 20, 30, 2)).toBe(30);
  });
});

describe("readSessions: the cap, order and cost on 501 sessions", () => {
  const db = buildAndRoll("sessions-cap");
  const s = readSessions(db, { now: BASE + DAY });

  it("lists the 500 most recent, newest first, and says it capped", () => {
    expect(SESSION_CAP).toBe(500);
    expect(s.rows).toHaveLength(500);
    expect(s.capped).toBe(true);
    expect(s.rows[0].sessionId).toBe("S500");
    expect(s.rows[499].sessionId).toBe("S001");
    expect(s.rows.map((r) => r.sessionId)).not.toContain("S000");
    for (let i = 1; i < s.rows.length; i++) expect(s.rows[i].lastTs).toBeLessThan(s.rows[i - 1].lastTs);
  });

  it("is not capped at exactly the cap", () => {
    const exact = buildAndRoll("sessions-cap");
    rows(exact, "DELETE FROM claude_requests WHERE request_id = 'R000';");
    const e = readSessions(exact, { now: BASE + DAY });
    expect(e.rows).toHaveLength(500);
    expect(e.capped).toBe(false);
  });

  it("gives a session with no snapshot no cost, and MAXes a cumulative one", () => {
    const by = (sid: string) => s.rows.find((r) => r.sessionId === sid)!;
    expect(by("S499").costUsd).toBeNull();
    expect(by("S001").costUsd).toBeNull();
    expect(by("S500").costUsd).toBeCloseTo(10, 9); // readings 5.00 then 10.00
    expect(by("S002").costUsd).toBeCloseTo(0.04, 9);
  });

  it("labels the terminal from claude_sessions, null where none was recorded", () => {
    const by = (sid: string) => s.rows.find((r) => r.sessionId === sid)!;
    expect([by("S498").terminal, by("S499").terminal, by("S500").terminal]).toEqual(["ghostty", null, "warp"]);
  });
});

// The per-project sum of session fresh tokens is the Projects page's tokens
// for the same range, in every range: one lookup (projectKeySql), one day
// bound. These scenarios have no orphan requests, so this owns attribution,
// and guard 2's plant (joining claude_sessions) cannot turn it red.
describe("readSessions reconciles with readProjects", () => {
  for (const [scenario, env, now] of [
    ["session-spans-two-projects", {}, BASE + 3000],
    ["mixed-projects-one-day", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" }, BASE + 20000],
  ] as const) {
    const db = buildAndRoll(scenario, env);
    for (const range of RANGES) {
      it(`${scenario}, ${range}: session tokens sum per project to the Projects tokens`, () => {
        const s = readSessions(db, { now, range });
        const p = readProjects(db, { now, range });
        const byProject = new Map<string, number>();
        for (const r of s.rows) byProject.set(r.project, (byProject.get(r.project) ?? 0) + r.freshTokens);
        const want = new Map(p.projects.filter((x) => x.tokensIn + x.tokensOut > 0).map((x) => [x.key, x.tokensIn + x.tokensOut]));
        expect(want.size).toBeGreaterThanOrEqual(2);
        expect(byProject).toEqual(want);
      });
    }
  }

  it("gives a session that ran in two projects a row in each, with that project's tokens", () => {
    const db = buildAndRoll("session-spans-two-projects");
    const rows = readSessions(db, { now: BASE + 3000 }).rows.filter((r) => r.sessionId === "S_SPAN");
    expect(rows.map((r) => [r.project.replace(/.*\//, ""), r.freshTokens])).toEqual([
      ["proj-two", 23 + 2903],
      ["proj-one", 11 + 1301],
    ]);
    // Cost is the session's, whole, on each row: it cannot be split by project.
    expect(rows.map((r) => r.costUsd)).toEqual([1.5, 1.5]);
    expect(rows.map((r) => r.projectsInRange)).toEqual([2, 2]);
  });

  // M7: the span is counted over every request of the session, BEFORE the
  // project filter -- filtered to one project, the one row left still knows
  // the session also ran in another.
  it("counts a session's projects over all its requests, whatever the filter", () => {
    const db = buildAndRoll("session-spans-two-projects");
    const all = readSessions(db, { now: BASE + 3000 });
    const one = all.rows.find((r) => r.sessionId === "S_SPAN")!.project;
    const filtered = readSessions(db, { now: BASE + 3000, project: one }).rows;
    expect(filtered.map((r) => [r.sessionId, r.projectsInRange])).toEqual([["S_SPAN", 2]]);
  });
});

describe("readSessions, the Atlas line", () => {
  it("takes the MAX over Atlas's duplicate rows, and null for a session it does not know", async () => {
    const db = buildAndRoll("dashboard");
    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    const all = readSessions(db, { now: NOW, range: "all" }).rows;
    const sids = [...new Set(all.map((r) => r.sessionId))];
    const known = rows<{ s: string }>(db, "SELECT session_id AS s FROM claude_sessions ORDER BY session_id LIMIT 1")[0].s;
    expect(sids).toContain(known);
    const T = "'2026-09-14T18:18:48.012389+00:00'";
    const root = mkdtempSync(path.join(tmpdir(), "wt-atlas-sess-"));
    const file = path.join(root, "repo", ".atlas", "sessions.db");
    mkdirSync(path.dirname(file), { recursive: true });
    execFileSync("sqlite3", ["-cmd", ".bail on", file, `
      CREATE TABLE agent_session (id TEXT PRIMARY KEY, workspace_id TEXT, source TEXT,
        native_session_id TEXT NOT NULL, token_totals TEXT, started_at TEXT, updated_at TEXT);
      CREATE TABLE checkpoint (id TEXT PRIMARY KEY, session_id TEXT);
      CREATE TABLE file_touch (id TEXT PRIMARY KEY, session_id TEXT, deleted INTEGER);
      INSERT INTO agent_session VALUES ('as-1','w','external_jsonl','${known}',NULL,${T},${T});
      INSERT INTO agent_session VALUES ('as-2','w','acp','${known}',NULL,${T},${T});
      INSERT INTO checkpoint VALUES ('c1','as-1'),('c2','as-1'),('c3','as-2'),('c4','as-2'),('c5','as-2');
      INSERT INTO file_touch VALUES ('f1','as-1',0),('f2','as-1',1),('f3','as-2',0),('f4','as-2',0);`]);
    await runSync({ db, adapters: [createAtlasAdapter({ db, roots: [root] })] });
    const rs = readSessions(db, { now: NOW, range: "all" }).rows;
    const mine = rs.filter((r) => r.sessionId === known);
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) expect(r.atlas).toEqual({ checkpoints: 3, files: 2 });
    const others = rs.filter((r) => r.sessionId !== known);
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) expect(r.atlas).toBeNull();
  });
});
