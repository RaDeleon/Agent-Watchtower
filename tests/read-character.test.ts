import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyWtSchema } from "@/lib/core/schema";
import { LEVEL_UP_CAP, readCharacter } from "@/lib/read/character";
import { roll, seedAgents, type SeedSession } from "./helpers/agent-seed";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { skillsHome } from "./helpers/skills-home";

// Stage 6, Task 3. The reader parses, filters (excluded) and labels the skill_*
// tables; every number it returns is a stored one. R21: the rollup's literal
// values live in tests/skill-rollup.test.ts, so these assert identities.

const T = 1789466400;
const D = 1790762400;
const DAY = 86400;
const NOW = D + 3600;
const TODAY = { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" };
const home = () => mkdtempSync(path.join(tmpdir(), "wt-char-home-")); // no ~/.codex, no ~/.hermes
const codexDay = (id: string, t: number, secs: number, cwd = "/tmp/wt-ch-one"): SeedSession => ({
  source: "codex", id, entry: "Codex Desktop", driven: 1, startedAt: t, cwd,
  events: [[t, "session_start"], [t + 10, "prompt"], [t + secs, "stop"]],
});
function synced(db: string, source: string): void {
  applyWtSchema(db);
  execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO wt_ingest_state (source, last_run_at, last_ok_at, health)
    VALUES ('${source}', ${NOW}, ${NOW}, 'ok');`]);
}

describe("readCharacter", () => {
  it("is pending on a database the v8 rollup has not run on", () => {
    const db = buildAndRoll("resumed");
    execFileSync("sqlite3", [db, "DROP TABLE skill_progress"]);
    const c = readCharacter(db, { now: NOW, home: home() });
    expect(c.pending).toBe(true);
    expect(c.tools).toEqual([]);
    expect(c.levelUps).toEqual([]);
  });

  it("lists Claude always, and an agent only once it is installed or synced", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [codexDay("c", T, 120)]);
    roll(db);
    expect(readCharacter(db, { now: NOW, home: home() }).tools.map((t) => t.source)).toEqual(["claude"]);
    synced(db, "codex");
    expect(readCharacter(db, { now: NOW, home: home() }).tools.map((t) => t.source)).toEqual(["claude", "codex"]);
  });

  it("reads each tool's skills from the stored rows, hiding (excluded)", () => {
    const excl = { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" };
    const db = buildAndRoll("mixed-projects-one-day", excl);
    const c = readCharacter(db, { now: NOW, home: home() });
    const claude = c.tools.find((t) => t.source === "claude")!;
    expect(claude.excludedHidden).toBe(true);
    expect(claude.projects.map((s) => [s.key, s.level.level, s.level.xp, s.firstDay, s.lastDay])).toEqual(
      rows<{ key: string; level: number; xp: number; first_day: string; last_day: string }>(db, `
        SELECT key, level, xp, first_day, last_day FROM skill_progress
        WHERE source = 'claude' AND kind = 'project' AND key <> '(excluded)'
        ORDER BY level DESC, xp DESC, key`).map((r) => [r.key, r.level, r.xp, r.first_day, r.last_day]));
    expect(claude.projects.every((s) => !s.label.includes("/"))).toBe(true);
    expect(claude.models.map((s) => s.key)).toEqual(
      rows<{ key: string }>(db, `SELECT key FROM skill_progress WHERE source = 'claude' AND kind = 'model'
        ORDER BY level DESC, xp DESC, key`).map((r) => r.key));
    expect(claude.state.state).toBe("level");
    expect(c.totalLevel).toBe(claude.state.state === "level" ? claude.state.level.level : null);
  });

  it("turns the stored pace into a date, and nothing else", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [codexDay("p0", D, 100), codexDay("p10", D - 10 * DAY, 200)]);
    synced(db, "codex");
    roll(db, TODAY);
    const codex = readCharacter(db, { now: NOW, home: home() }).tools.find((t) => t.source === "codex")!;
    const r = rows<{ as_of_day: string; pace_xp_per_day: number; eta_next_days: number; eta_99_days: number;
      streak_current: number; streak_best: number }>(db, "SELECT * FROM skill_pace WHERE source = 'codex'")[0];
    const date99 = new Date(Date.parse(`${r.as_of_day}T00:00:00Z`) + r.eta_99_days * 86400000).toISOString().slice(0, 10);
    expect(codex.pace).toMatchObject({
      asOfDay: r.as_of_day, perDay: r.pace_xp_per_day, etaNextDays: r.eta_next_days, eta99Days: r.eta_99_days,
      date99, streakCurrent: r.streak_current, streakBest: r.streak_best,
    });
  });

  it("lists level-ups newest first, without (excluded), capped", () => {
    const excl = { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" };
    const db = buildAndRoll("mixed-projects-one-day", excl);
    const c = readCharacter(db, { now: NOW, home: home() });
    expect(c.levelUps.length).toBeGreaterThan(0);
    expect(c.levelUps.some((u) => u.key === "(excluded)")).toBe(false);
    const days = c.levelUps.map((u) => u.day);
    expect(days).toEqual([...days].sort().reverse());
    expect(c.levelUpCount).toBe(rows<{ n: number }>(db,
      "SELECT COUNT(*) AS n FROM skill_level_ups WHERE NOT (kind = 'project' AND key = '(excluded)')")[0].n);
    // Readers only read: rows written straight into the table exercise the cap.
    const values = Array.from({ length: LEVEL_UP_CAP + 10 }, (_, i) =>
      `('codex','model','m${i}',2,'2026-09-${String(1 + (i % 28)).padStart(2, "0")}','Noobie',0)`).join(",");
    execFileSync("sqlite3", [db, `INSERT INTO skill_level_ups (source, kind, key, level, day, tier, tier_changed) VALUES ${values};`]);
    const capped = readCharacter(db, { now: NOW, home: home() });
    expect(capped.levelUps).toHaveLength(LEVEL_UP_CAP);
    expect(capped.levelUpCount).toBe(c.levelUpCount + LEVEL_UP_CAP + 10);
  });

  // Stage 8, guard 10: a tier unlock is an achievement, not a level-up.
  it("achievement unlocks stay out of the level-up log", () => {
    const db = buildAndRoll("mixed-projects-one-day");
    const before = readCharacter(db, { now: NOW, home: home() });
    execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO achievement_tiers (achievement, source, tier, threshold, value, unlocked_day, points, updated_at)
      VALUES ('regular', 'claude', 1, 10, 12, '2026-09-30', 1, 0), ('regular', 'claude', 2, 100, 12, '2026-09-30', 2, 0);`]);
    const after = readCharacter(db, { now: NOW, home: home() });
    expect(after.levelUps).toEqual(before.levelUps);
    expect(after.levelUpCount).toBe(before.levelUpCount);
  });

  it("reads Quest and Achievement Points, and none before the v10 rollup", () => {
    const db = buildAndRoll("mixed-projects-one-day");
    expect(readCharacter(db, { now: NOW, home: home() }).points)
      .toEqual(rows<{ qp: number; ap: number }>(db, "SELECT qp, ap FROM character_points;")[0]);
    execFileSync("sqlite3", [db, "DROP TABLE character_points;"]);
    expect(readCharacter(db, { now: NOW, home: home() }).points).toBeNull();
  });

  // Review Focus 5.
  it("Skill use is pending on a database the v9 rollup has not run on", () => {
    const db = buildAndRoll("skill-mix");
    execFileSync("sqlite3", [db, "DROP TABLE claude_skill_packs"]);
    expect(readCharacter(db, { now: NOW, home: home() }).skillUse)
      .toEqual({ pending: true, level: null, packs: [], skills: [] });
  });

  it("reads Skill use, its packs and its skills, each skill with its pack", () => {
    const db = buildAndRoll("skill-mix", { CLAUDE_DIR: skillsHome() });
    // An unresolved skill (plan R9) reads as (no pack), as the rollup counts it.
    execFileSync("sqlite3", [db, "DELETE FROM claude_skill_packs WHERE skill = 'fx-unresolved'"]);
    const c = readCharacter(db, { now: NOW, home: home() });
    const u = c.skillUse;
    expect(u.pending).toBe(false);
    const use = rows<{ level: number; xp: number; active_s: number }>(db,
      "SELECT level, xp, active_s FROM skill_progress WHERE source = 'claude' AND kind = 'skill-use'")[0];
    expect(u.level).toMatchObject({ level: use.level, xp: use.xp, activeS: use.active_s });
    expect(u.packs.map((s) => s.key)).toEqual(rows<{ key: string }>(db, `SELECT key FROM skill_progress
      WHERE source = 'claude' AND kind = 'pack' ORDER BY level DESC, xp DESC, key`).map((r) => r.key));
    expect(u.skills.map((s) => [s.key, s.pack])).toEqual(rows<{ key: string; pack: string }>(db, `
      SELECT s.key, COALESCE(p.pack, '(no pack)') AS pack FROM skill_progress s
      LEFT JOIN claude_skill_packs p ON p.skill = s.key
      WHERE s.source = 'claude' AND s.kind = 'skill' ORDER BY s.level DESC, s.xp DESC, s.key`).map((r) => [r.key, r.pack]));
    expect(u.skills.find((s) => s.key === "fx-unresolved")?.pack).toBe("(no pack)");
    // Claude's own sub-skills hold none of the new kinds.
    const claude = c.tools.find((t) => t.source === "claude")!;
    expect(claude.models.map((s) => s.key)).toEqual(rows<{ key: string }>(db, `SELECT key FROM skill_progress
      WHERE source = 'claude' AND kind = 'model' ORDER BY level DESC, xp DESC, key`).map((r) => r.key));
  });

  it("labels Skill use's level-ups", () => {
    const db = buildAndRoll("skill-mix");
    const ups = readCharacter(db, { now: NOW, home: home() }).levelUps;
    const use = ups.filter((u) => u.kind === "skill-use");
    expect(use.length).toBeGreaterThan(0);
    expect(new Set(use.map((u) => u.label))).toEqual(new Set(["Skill use"]));
    expect(ups.some((u) => u.kind === "skill" && u.label === "superpowers:brainstorming")).toBe(true);
  });

  it("a database with no driven hours reads as none, never Lv 1", () => {
    const db = buildAndRoll("tokens-only-day");
    const c = readCharacter(db, { now: NOW, home: home() });
    expect(c.pending).toBe(false);
    const claude = c.tools[0];
    expect(claude.source).toBe("claude");
    expect(claude.state.state).toBe("none");
    expect(claude.projects).toEqual([]);
    expect(claude.models).toEqual([]);
    expect(c.skillUse).toEqual({ pending: false, level: null, packs: [], skills: [] });
    expect(c.totalLevel).toBeNull();
    expect(c.levelUps).toEqual([]);
    expect(c.all).toMatchObject({ xpToday: 0, xp7d: 0, xp28d: 0, perDay: 0, etaNextDays: null, date99: null });
  });
  it("labels attribute level-ups by name and reads the cap, its raises and the attributes", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    const c = readCharacter(db, { now: NOW, home: home() });
    expect(c.cap).toBe(99);
    expect(c.capRaises).toEqual([]);
    expect(c.attributes.pending).toBe(false);
    const ups = c.levelUps.filter((u) => u.kind === "attribute");
    expect(ups.length).toBeGreaterThan(0);
    expect(new Set(ups.map((u) => u.label))).toEqual(new Set(ups.map((u) =>
      ({ str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" })[u.key as "str"])));
    for (const t of c.tools) for (const s of [...t.projects, ...t.models]) expect(s.level.source).not.toBe("character");
  });
});
