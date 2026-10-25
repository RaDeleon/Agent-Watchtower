import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ROLLUP } from "./helpers/fixture-db";

// Stage 4B (plan P2): section 1 of rollup.sh -- the daily and project rebuild
// -- builds everything 4B derives inside a READ transaction (BEGIN DEFERRED,
// no write lock) and takes the write lock only after its first COMMIT. A temp
// table built under BEGIN IMMEDIATE instead holds the lock every hook write
// waits on for as long as the build takes, which grows with history; the
// failure is silent (hook writes time out and are dropped). These tests read
// the heredoc's statements the same way profile-rollup.test.ts reads the
// profile section's.

/** One section's heredoc, comments stripped, one entry per statement, whitespace collapsed. */
function sectionStatements(from: string, to: string): string[] {
  const src = readFileSync(ROLLUP, "utf8");
  const start = src.indexOf(from);
  const end = src.indexOf(to);
  // Non-vacuity: a renamed header must fail here, not slice an empty section.
  expect({ from, start: start >= 0 }).toEqual({ from, start: true });
  expect({ to, end: end > start }).toEqual({ to, end: true });
  const section = src.slice(start, end);
  const body = section.slice(section.indexOf("<<'SQL'"), section.lastIndexOf("\nSQL\n"));
  const sql = body.slice(body.indexOf("\n") + 1).replace(/--[^\n]*/g, "");
  return sql.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s !== "");
}

const WRITE_SHAPED = /^(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i;
const READ_PHASE_ALLOWED = [
  /^CREATE TEMP TABLE _\w+/,
  /^CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?\w+ ON _\w+/,
  /^DROP TABLE IF EXISTS _\w+/,
  /^INSERT INTO _\w+/,
];
const READ_PHASE_TABLES = ["_pk", "_prices", "_pwin", "_rm", "_cost_d", "_cost_p", "_bnd", "_human", "_trq", "_turns", "_evm", "_sfm"];
const SWAPPED = ["claude_prices", "claude_request_metrics", "claude_turns"];

describe("Stage 4B: rollup section 1's transactions", () => {
  const st = sectionStatements("# ---- rebuild daily rollups", "# ---- lifetime aggregates");
  const readCommit = st.indexOf("COMMIT");

  it("opens a read transaction and hands over to the write lock at its first COMMIT", () => {
    expect(st[0]).toBe("BEGIN DEFERRED");
    expect(readCommit).toBeGreaterThan(0);
    expect(st[readCommit + 1]).toBe("BEGIN IMMEDIATE");
    // One write transaction, closed by the heredoc's last statement.
    expect(st.filter((s) => s === "BEGIN IMMEDIATE")).toHaveLength(1);
    expect(st.lastIndexOf("COMMIT")).toBe(st.length - 1);
  });

  it("writes nothing but temp tables before the write lock", () => {
    const writes = st.slice(1, readCommit).filter((s) => WRITE_SHAPED.test(s));
    expect(writes.length).toBeGreaterThan(0);
    for (const s of writes) {
      expect({ s, allowed: READ_PHASE_ALLOWED.some((re) => re.test(s)) }).toEqual({ s, allowed: true });
    }
  });

  it("builds every 4B temp table in the read phase", () => {
    for (const t of READ_PHASE_TABLES) {
      const created = st.findIndex((s) => new RegExp(`^CREATE TEMP TABLE ${t}\\b`).test(s));
      expect({ t, created, beforeCommit: created > 0 && created < readCommit }).toEqual({ t, created, beforeCommit: true });
    }
  });

  it("swaps claude_prices, claude_request_metrics and claude_turns in the write phase, each straight from a staged temp table", () => {
    const write = st.slice(readCommit + 2, st.length - 1);
    for (const t of SWAPPED) {
      const del = write.indexOf(`DELETE FROM ${t}`);
      expect({ t, del: del >= 0 }).toEqual({ t, del: true });
      expect(write[del + 1]).toMatch(new RegExp(`^INSERT INTO ${t} \\([\\w, ]+\\) SELECT [\\w, ]+ FROM _\\w+ ORDER BY rowid$`));
    }
  });
});

// Stage 5: the agent section (Codex and Hermes hours, Codex cost, every tool's
// level) runs last, with the same two phases. Its write statements differ in
// shape from 4B's -- agent_prices is gated on a synced agent source, and two
// INSERTs stamp updated_at -- so the swap regex below spells out exactly the
// two extras it allows and nothing else: no join, no other table, no
// computation beyond the clock.
const AG_READ_PHASE_TABLES = ["_ag_prices", "_ag_no_rate", "_ag_pwin", "_ag_sess", "_ag_rm", "_ag_ev", "_ag_gap",
  "_ag_g", "_ag_s", "_ag_r", "_ag_keys", "_ag_daily", "_ag_xp", "_ag_life", "_ag_prog",
  "_ag_evm", "_ag_sfm", "_ag_tier", "_sk_daily", "_sk_life", "_sk_prog", "_sk_progress", "_sk_ups", "_sk_d",
  "_sk_win", "_sk_runs", "_sk_pace", "_ac_def", "_ac_cum", "_ac_first", "_ac_strong", "_ac_val", "_ac_reach",
  "_ac_tiers", "_ac_points", "_at_attr", "_at_def", "_at_day", "_at_str", "_at_form", "_lc_def", "_lc", "_at_sheet"];
const AG_SWAPPED: Array<[string, string]> = [
  ["agent_prices", "_ag_prices"], ["agent_request_metrics", "_ag_rm"],
  ["agent_daily_rollups", "_ag_daily"], ["agent_progress", "_ag_prog"],
  ["skill_daily", "_sk_daily"], ["skill_progress", "_sk_progress"],
  ["skill_level_ups", "_sk_ups"], ["skill_pace", "_sk_pace"],
  ["achievement_tiers", "_ac_tiers"], ["character_points", "_ac_points"],
  ["character_attributes", "_at_sheet"], ["level_caps", "_lc"],
];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NOW = esc("CAST(strftime('%s','now') AS INTEGER)");
const ONLY_IF_SYNCED = esc("WHERE EXISTS (SELECT 1 FROM wt_sources WHERE source IN ('codex','hermes'))");
const agentInsert = (t: string, src: string) =>
  new RegExp(`^INSERT INTO ${t} \\([\\w, ]+\\) SELECT (?:[\\w, *]|${NOW})+ FROM ${src}(?: ${ONLY_IF_SYNCED})? ORDER BY rowid$`);

describe("Stage 5: the agent section's transactions", () => {
  const st = sectionStatements("# ---- rebuild the agent rollups (Stage 5)", "# ---- summary");
  const readCommit = st.indexOf("COMMIT");

  it("opens a read transaction and hands over to the write lock at its first COMMIT", () => {
    expect(st[0]).toBe("BEGIN DEFERRED");
    expect(readCommit).toBeGreaterThan(0);
    expect(st[readCommit + 1]).toBe("BEGIN IMMEDIATE");
    expect(st.filter((s) => s === "BEGIN IMMEDIATE")).toHaveLength(1);
    expect(st.lastIndexOf("COMMIT")).toBe(st.length - 1);
  });

  it("writes nothing but temp tables before the write lock", () => {
    const writes = st.slice(1, readCommit).filter((s) => WRITE_SHAPED.test(s));
    expect(writes.length).toBeGreaterThan(0);
    for (const s of writes) {
      expect({ s, allowed: READ_PHASE_ALLOWED.some((re) => re.test(s)) }).toEqual({ s, allowed: true });
    }
  });

  it("builds every agent temp table in the read phase", () => {
    for (const t of AG_READ_PHASE_TABLES) {
      const created = st.findIndex((s) => new RegExp(`^CREATE TEMP TABLE ${t}\\b`).test(s));
      expect({ t, created, beforeCommit: created > 0 && created < readCommit }).toEqual({ t, created, beforeCommit: true });
    }
  });

  it("swaps the agent and skill tables in the write phase, each straight from its staged temp table", () => {
    const write = st.slice(readCommit + 2, st.length - 1);
    expect(write).toHaveLength(AG_SWAPPED.length * 2);
    AG_SWAPPED.forEach(([t, src], i) => {
      expect(write[2 * i]).toBe(`DELETE FROM ${t}`);
      expect(write[2 * i + 1]).toMatch(agentInsert(t, src));
    });
  });
});
