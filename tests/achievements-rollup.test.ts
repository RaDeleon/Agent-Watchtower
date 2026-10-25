import { beforeAll, describe, expect, it } from "vitest";
import { roll, seedAgents, type SeedSession } from "./helpers/agent-seed";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { slow } from "./helpers/timeout";

// Stage 8 (spec 4.5-4.6): achievement_tiers and character_points, built by
// rollup.sh's agent section. Guards 7-9 each own one test below (R21: their
// literal values live there alone); the rest assert identities.

interface TierRow {
  achievement: string; source: string; tier: number; threshold: number;
  value: number | null; unlocked_day: string | null; points: number;
}
const tiers = (db: string) =>
  rows<TierRow>(db, "SELECT achievement, source, tier, threshold, value, unlocked_day, points FROM achievement_tiers ORDER BY rowid;");
const points = (db: string) => rows<{ qp: number; ap: number }>(db, "SELECT qp, ap FROM character_points;");

const T = 1789466400; // 2026-09-15T10:00:00Z
const DAY = 86400;
const TODAY = { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" };

/**
 * 100 driven Codex sessions on 2026-09-15, 60 s apart, with no events (so no
 * driven hours and no level), and three requests of 600,000 output tokens on
 * days 0, 2 and 4: 1.8M in all, crossing 1M on day 2.
 */
function codexDb(): string {
  const db = buildAndRoll("agent-drift");
  const out = [0, 2, 4];
  const sessions: SeedSession[] = Array.from({ length: 100 }, (_, i) => ({
    source: "codex", id: `s${i}`, entry: "Codex Desktop", driven: 1, startedAt: T + i * 60, cwd: "/tmp/wt-ac",
    requests: i < out.length ? [{ id: `w${i}`, ts: T + out[i] * DAY, model: "gpt-5.5", tout: 600000 }] : [],
  }));
  seedAgents(db, sessions);
  roll(db, TODAY);
  return db;
}
const WEEKS = { WATCHTOWER_ROLLUP_TODAY: "2026-09-09" };

let cx: string; // codexDb()
let qw: string; // quest-weeks, as of Wed 2026-09-09: one perfect week (C)

// Each test only reads, so each database is built and rolled once.
beforeAll(() => {
  cx = codexDb();
  qw = buildAndRoll("quest-weeks", WEEKS);
}, slow(60000));

describe("Stage 8: achievements", () => {
  // Guard 7. Regular reaches 10 and 100 on its only day; Wordsmith's running
  // sum reaches 1M on day 2, not on day 4.
  it("each tier is dated the first day it was reached", () => {
    const codex = tiers(cx).filter((t) => t.source === "codex" && t.unlocked_day !== null);
    expect(codex.map((t) => [t.achievement, t.tier, t.value, t.unlocked_day])).toEqual([
      ["regular", 1, 100, "2026-09-15"], ["regular", 2, 100, "2026-09-15"], ["wordsmith", 1, 1800000, "2026-09-17"],
    ]);
  });

  // Guard 8. Regular bronze and silver, and Wordsmith bronze: 1 + 2 + 1.
  it("achievement points weight each tier", () => {
    expect(tiers(cx).filter((t) => t.points > 0).map((t) => [t.achievement, t.source, t.tier, t.points])).toEqual([
      ["regular", "codex", 1, 1], ["regular", "codex", 2, 2], ["wordsmith", "codex", 1, 1],
    ]);
    expect(points(cx).map((p) => p.ap)).toEqual([4]);
  });

  // Guard 9. Perfect week counts the weeks whose every quest is done, each
  // dated by its own Sunday. (A later date is guard 7's defect, not this one.)
  it("quest achievements date from their week", () => {
    const perfect = rows<{ week_end: string }>(qw, `SELECT week_end FROM claude_quests GROUP BY week
      HAVING SUM(status = 'done') = COUNT(*) ORDER BY week;`).map((r) => r.week_end);
    const sundays = rows<{ week_end: string }>(qw, "SELECT DISTINCT week_end FROM claude_quests;").map((r) => r.week_end);
    expect(perfect.length).toBeGreaterThan(0);
    const bronze = tiers(qw).find((t) => t.achievement === "perfect-week" && t.tier === 1)!;
    expect(bronze.value).toBe(perfect.length);
    expect(sundays).toContain(bronze.unlocked_day);
    expect(bronze.unlocked_day! >= perfect[0]).toBe(true);
  });
});

describe("Stage 8: achievement identities", () => {
  const dbs = () => [cx, qw];

  it("QP counts done quests and AP sums the unlocked tiers' points", () => {
    for (const db of dbs()) {
      const done = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_quests WHERE status = 'done';")[0].n;
      const sum = tiers(db).reduce((a, t) => a + t.points, 0);
      expect(points(db)).toEqual([{ qp: done, ap: sum }]);
      for (const t of tiers(db)) expect({ t, unlocked: t.points > 0 }).toEqual({ t, unlocked: t.unlocked_day !== null });
    }
  });

  it("covers every registered tool, and Claude alone for the Claude Code achievements", () => {
    const tools = rows<{ source: string }>(cx, "SELECT source FROM agent_progress ORDER BY source;").map((r) => r.source);
    const by = (a: string) => [...new Set(tiers(cx).filter((t) => t.achievement === a).map((t) => t.source))].sort();
    for (const a of ["seasoned", "daily-habit", "regular", "wordsmith", "explorer"]) expect(by(a)).toEqual(tools);
    for (const a of ["skill-collector", "skill-master", "pack-master", "skill-user", "all-rounder", "quester", "perfect-week"]) {
      expect(by(a)).toEqual(["claude"]);
    }
    for (const a of new Set(tiers(cx).map((t) => t.achievement))) {
      for (const s of by(a)) {
        expect(tiers(cx).filter((t) => t.achievement === a && t.source === s).map((t) => t.tier)).toEqual([1, 2, 3, 4]);
      }
    }
  });

  it("a tool with no level has no Seasoned value and nothing unlocked, never Lv 0", () => {
    expect(rows<{ level: number | null }>(cx, "SELECT level FROM agent_progress WHERE source = 'codex';")).toEqual([{ level: null }]);
    expect(tiers(cx).filter((t) => t.achievement === "seasoned" && t.source === "codex").map((t) => [t.value, t.unlocked_day]))
      .toEqual([[null, null], [null, null], [null, null], [null, null]]);
  });

  it("a tier unlocks no earlier than the tier below it", () => {
    for (const db of dbs()) {
      const all = tiers(db);
      for (const t of all.filter((r) => r.unlocked_day !== null)) {
        const lower = all.find((r) => r.achievement === t.achievement && r.source === t.source && r.tier === t.tier - 1);
        if (lower !== undefined) {
          expect(lower.unlocked_day).not.toBeNull();
          expect(lower.unlocked_day! <= t.unlocked_day!).toBe(true);
        }
      }
    }
  });
});
