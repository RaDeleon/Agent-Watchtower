import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { roll } from "./helpers/agent-seed";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { skillsHome } from "./helpers/skills-home";

// Stage 7: Claude Code skills, their packs, and all skill time as sub-skills
// (spec §4). R21: each guard's literal values live in ONE test here; every
// other test over the same data asserts identities, so one planted defect reds
// one test. The plants, and every test each reddened, are in the stage's build
// logs, which stay local.

type Row = Record<string, unknown>;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const packOf = (db: string, skill: string) =>
  rows<{ pack: string; via: string }>(db, `SELECT pack, via FROM claude_skill_packs WHERE skill = ${q(skill)}`);
const NONE = [{ pack: "(no pack)", via: "none" }];

describe("a skill's pack", () => {
  let db: string;
  beforeAll(() => {
    const home = skillsHome();
    db = buildAndRoll("skill-mix", { CLAUDE_DIR: home });
    // Tag two untagged requests with the absolute-link skill and the pack's
    // router, in this describe's own copy so no other guard's literals move.
    execFileSync("sqlite3", [db, `
      UPDATE claude_requests SET attribution_skill = 'fx-abs' WHERE request_id =
        (SELECT MIN(request_id) FROM claude_requests WHERE attribution_skill IS NULL);
      UPDATE claude_requests SET attribution_skill = 'fxpack' WHERE request_id =
        (SELECT MIN(request_id) FROM claude_requests WHERE attribution_skill IS NULL);`]);
    roll(db, { CLAUDE_DIR: home });
  });

  // GUARD 3 (R21). gstack installs each skill as skills/<name>/SKILL.md, a link
  // into skills/gstack/<name>/. Planted: skip rule 2 (`if false &&`).
  it("a linked skill resolves to its pack", () => {
    expect(packOf(db, "fx-linked")).toEqual([{ pack: "fxpack", via: "link" }]);
    expect(packOf(db, "fx-abs")).toEqual([{ pack: "fxpack", via: "link" }]);
  });

  // GUARD 9 (R21). gstack's own /gstack is a plain file at the pack root while
  // other skills link into its sub-folders. Planted: the helper always fails;
  // and (9b) any nested SKILL.md makes a pack root, which fx-plain refutes.
  it("a pack's own router skill resolves to its pack", () => {
    expect(packOf(db, "fxpack")).toEqual([{ pack: "fxpack", via: "link" }]);
    expect(packOf(db, "fx-plain")).toEqual(NONE);
  });

  // GUARD 4 (R21). Every live "pack:name" has prefix = attribution_plugin.
  // Planted: take the text after the colon.
  it("a plugin skill resolves to its plugin", () => {
    expect(packOf(db, "fxplug:fx-tool")).toEqual([{ pack: "fxplug", via: "plugin" }]);
    expect(packOf(db, "superpowers:brainstorming")).toEqual([{ pack: "superpowers", via: "plugin" }]);
  });

  // GUARD 8 (R21), and Review Focus 1: a name is a path segment or it never
  // reaches the filesystem. "fxpack/fx-linked" would resolve through a real
  // SKILL.md to fxpack without the check. Planted: drop the segment check.
  it("an unsafe skill name resolves to (no pack)", () => {
    for (const name of ["fxpack/fx-linked", "../fxpack/fx-linked", "fx it's"]) {
      expect({ name, row: packOf(db, name) }).toEqual({ name, row: NONE });
    }
  });

  it("a skill on no disk path and a subagent-only skill resolve to (no pack)", () => {
    for (const name of ["fx-builtin", "fx-unresolved", "fx-sub-only"]) {
      expect({ name, row: packOf(db, name) }).toEqual({ name, row: NONE });
    }
  });

  // Review Focus 2. buildAndRoll's CLAUDE_DIR never exists (plan R2), and it
  // throws on a non-zero exit.
  it("resolves every bare name to (no pack) with no skills directory, and the rollup still exits 0", () => {
    const bare = buildAndRoll("skill-mix");
    for (const name of ["fx-linked", "fx-plain", "fx-builtin"]) {
      expect({ name, row: packOf(bare, name) }).toEqual({ name, row: NONE });
    }
  });

  // GUARD 5 (R21, plan R4): a resolved pack is kept forever, like a project
  // path. Equality, not a literal: guard 3's test owns fx-linked -> fxpack.
  // Planted: re-resolve every name each run (no NOT IN, INSERT OR REPLACE).
  it("an uninstalled pack keeps its history", () => {
    const home = skillsHome();
    const d = buildAndRoll("skill-mix", { CLAUDE_DIR: home });
    const all = "SELECT skill, pack, via, resolved_at FROM claude_skill_packs ORDER BY skill";
    const before = rows<Row>(d, all);
    rmSync(path.join(home, "skills"), { recursive: true, force: true });
    expect(existsSync(path.join(home, "skills"))).toBe(false);
    roll(d, { CLAUDE_DIR: home });
    expect(rows<Row>(d, all)).toEqual(before);
  });
});

/** (day, skill seconds, Claude seconds) where a day's skill time passes Claude's own. */
const overClaude = (db: string) => rows<Row>(db, `
  SELECT s.day, s.ms, r.active_ms FROM (SELECT day, SUM(active_ms) AS ms FROM claude_skill_rollups GROUP BY day) s
  LEFT JOIN claude_daily_rollups r USING (day) WHERE r.active_ms IS NULL OR s.ms > r.active_ms`);

describe("hours by skill", () => {
  // GUARD 1 (R21), and Review Focus 4. The tag lasts until the next prompt
  // (spec §3): the turn that loaded the skill, and the think gap ending at the
  // next prompt, are the skill's; the next turn is not; the 10 s before the
  // session's first request is no skill's. fx-sub-only ran only in a subagent
  // and has no row, but this fixture cannot show the sidechain filter: a
  // main-thread request follows the subagent's before any event (plan R10), so
  // fx-sub-only would get no row either way. Stage 6's guard 2 pins the filter.
  // Planted: carry the last non-NULL skill forward in _evm.
  it("a turn after the skill's turn earns it nothing", () => {
    const db = buildAndRoll("skill-mix");
    expect(rows(db, "SELECT skill, active_ms FROM claude_skill_rollups WHERE day = '2025-06-15'"))
      .toEqual([{ skill: "superpowers:brainstorming", active_ms: 240000 }]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM claude_skill_rollups WHERE skill = 'fx-sub-only'")).toEqual([{ n: 0 }]);
  });

  // GUARD 2 (R21, plan R6): booked to the session's START day through _sx, as
  // claude_model_rollups and claude_daily_rollups are, so a day's skill time
  // never exceeds Claude's. Planted: book to the gap's end day.
  it("skill time books to the session's start day, never past Claude's", () => {
    const db = buildAndRoll("skill-mix");
    expect(rows(db, "SELECT day, skill, active_ms FROM claude_skill_rollups WHERE day >= '2025-06-20' ORDER BY day, skill"))
      .toEqual([{ day: "2025-06-21", skill: "superpowers:brainstorming", active_ms: 1140000 }]);
    for (const d of [db, buildAndRoll("density-14")]) {
      expect(rows<{ n: number }>(d, "SELECT COUNT(*) AS n FROM claude_skill_rollups")[0].n).toBeGreaterThan(0);
      expect(overClaude(d)).toEqual([]);
    }
  });

  // Review Focus 3.
  it("a second rollup changes nothing", () => {
    const db = buildAndRoll("skill-mix");
    const read = () => [
      rows<Row>(db, "SELECT day, skill, active_ms FROM claude_skill_rollups ORDER BY day, skill"),
      rows<Row>(db, "SELECT skill, pack, via, resolved_at FROM claude_skill_packs ORDER BY skill"),
    ];
    const before = read();
    roll(db);
    expect(read()).toEqual(before);
  });
});

/** (kind, day) where the skill rows or the pack rows do not sum to the skill-use row. */
const useDrift = (db: string) => rows<Row>(db, `
  WITH u AS (SELECT day, active_ms AS ms FROM skill_daily WHERE source = 'claude' AND kind = 'skill-use'),
       k AS (SELECT kind, day, SUM(active_ms) AS ms FROM skill_daily
             WHERE source = 'claude' AND kind IN ('skill', 'pack') GROUP BY kind, day),
       want AS (SELECT 'skill' AS kind, day, ms FROM u UNION ALL SELECT 'pack', day, ms FROM u)
  SELECT w.kind, w.day, w.ms AS use_ms, k.ms AS sum_ms FROM want w LEFT JOIN k USING (kind, day) WHERE k.ms IS NOT w.ms
  UNION ALL
  SELECT k.kind, k.day, NULL, k.ms FROM k LEFT JOIN u USING (day) WHERE u.ms IS NULL`);

describe("skills, packs and Skill use as sub-skills", () => {
  // GUARD 6 (R21, plan R5): one skill resolved to (no pack) and one never
  // resolved at all; both count under (no pack). Planted: inner-join the pack
  // rows to claude_skill_packs.
  it("packs and skills each sum to Skill use, every day", () => {
    const home = skillsHome();
    const db = buildAndRoll("skill-mix", { CLAUDE_DIR: home });
    execFileSync("sqlite3", [db, `DELETE FROM claude_skill_packs WHERE skill = 'fx-unresolved';
      CREATE TRIGGER fx_unresolved BEFORE INSERT ON claude_skill_packs WHEN NEW.skill = 'fx-unresolved'
      BEGIN SELECT RAISE(IGNORE); END;`]);
    roll(db, { CLAUDE_DIR: home });
    expect(packOf(db, "fx-unresolved")).toEqual([]);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE kind = 'skill-use'")[0].n).toBeGreaterThan(0);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE kind = 'pack' AND key = '(no pack)'")[0].n)
      .toBeGreaterThan(0);
    expect(useDrift(db)).toEqual([]);
  });

  // GUARD 7 (R21). Skill time is a slice of Claude's (decision 2): taking every
  // tag away moves no tool row, no agent_progress column and so no Total.
  // Planted: add claude_skill_rollups' time to _ag_life's Claude row.
  it("skill time never moves agent_progress or Total", () => {
    const db = buildAndRoll("skill-mix");
    const AP = `SELECT source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars
                FROM agent_progress ORDER BY source`;
    const TOOLS = "SELECT source, key, day, active_ms FROM skill_daily WHERE kind = 'tool' ORDER BY source, day";
    const uses = () => rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE kind = 'skill-use'")[0].n;
    const before = [rows<Row>(db, AP), rows<Row>(db, TOOLS)];
    expect(uses()).toBeGreaterThan(0);
    execFileSync("sqlite3", [db, "UPDATE claude_requests SET attribution_skill = NULL"]);
    roll(db);
    expect(uses()).toBe(0);
    expect([rows<Row>(db, AP), rows<Row>(db, TOOLS)]).toEqual(before);
  });

  it("levels every new kind, logs its level-ups, and gives none of them a pace", () => {
    const db = buildAndRoll("skill-mix", { CLAUDE_DIR: skillsHome() });
    expect(rows(db, "SELECT DISTINCT kind FROM skill_progress WHERE source = 'claude' ORDER BY kind"))
      .toEqual(["model", "pack", "project", "skill", "skill-use", "tool"].map((kind) => ({ kind })));
    expect(rows(db, "SELECT key FROM skill_progress WHERE kind = 'skill-use'")).toEqual([{ key: "all" }]);
    expect(rows(db, `SELECT p.active_s = d.ms / 1000 AS ok FROM skill_progress p
      JOIN (SELECT SUM(active_ms) AS ms FROM skill_daily WHERE kind = 'skill-use') d WHERE p.kind = 'skill-use'`))
      .toEqual([{ ok: 1 }]);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_level_ups WHERE kind IN ('skill', 'pack', 'skill-use')")[0].n)
      .toBeGreaterThan(0);
    expect(rows(db, "SELECT source FROM skill_pace ORDER BY source")).toEqual([{ source: "all" }, { source: "claude" }]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM skill_progress WHERE kind = 'skill' AND key = 'fx-sub-only'")).toEqual([{ n: 0 }]);
  });
});
