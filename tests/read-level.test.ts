import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { maxCape, readLevel, readLevelCaps, readLevels, totalLevel, type LevelState } from "@/lib/read/level";
import { roll, seedAgents } from "./helpers/agent-seed";
import { buildAndRoll } from "./helpers/fixture-db";

const T = 1789466400;
const L = (n: number): LevelState => ({
  state: "level",
  level: { source: "codex", activeS: 1, xp: 1, level: n, tier: "x", xpIntoLevel: 0, xpToNext: n === 99 ? null : 1, sToNext: n === 99 ? null : 1, stars: 0 },
});

describe("readLevels", () => {
  it("reads every tool's stored level", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [{ source: "codex", id: "c", entry: "Codex Desktop", driven: 1, startedAt: T,
      events: [[T, "session_start"], [T + 30, "prompt"], [T + 330, "stop"]] }]);
    roll(db);
    const s = readLevels(db);
    expect(s.codex).toEqual({ state: "level", level: { source: "codex", activeS: 330, xp: 477, level: 5, tier: "Noobie",
      xpIntoLevel: 89, xpToNext: 35, sToNext: 24, stars: 0, cap: 99 } });
    expect(s.claude.state).toBe("level");
    expect(s.hermes).toEqual({ state: "pending" });
  });

  it("no driven seconds is none, not Lv 1", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [{ source: "codex", id: "a", entry: "codex_exec", driven: 0, startedAt: T,
      events: [[T, "session_start"], [T + 30, "prompt"], [T + 330, "stop"]] }]);
    roll(db);
    expect(readLevel(db, "codex")).toEqual({ state: "none", activeS: 0 });
  });

  it("takes the caps a page already read, and reads them itself when given none", () => {
    const db = buildAndRoll("resumed");
    const cap = (s: LevelState) => (s.state === "level" ? s.level.cap : undefined);
    expect(cap(readLevels(db).claude)).toBe(readLevelCaps(db)!.current);
    expect(cap(readLevels(db, { current: 120, first: 99, raises: [] }).claude)).toBe(120);
    expect(cap(readLevels(db, null).claude)).toBeNull();
  });

  it("no agent_progress table is pending for everyone", () => {
    const db = buildAndRoll("resumed");
    execFileSync("sqlite3", [db, "DROP TABLE agent_progress"]);
    expect(readLevels(db)).toEqual({ claude: { state: "pending" }, codex: { state: "pending" }, hermes: { state: "pending" } });
  });
});

describe("totals", () => {
  it("totalLevel sums the tools that have a level", () => {
    expect(totalLevel([L(77), L(5), { state: "none", activeS: 0 }])).toBe(82);
    expect(totalLevel([{ state: "pending" }])).toBeNull();
  });
  it("maxCape counts tools at or past the first cap, and is pending without one", () => {
    expect(maxCape([L(99), L(120), L(5), { state: "none", activeS: 0 }], 99)).toEqual({ at: 99, reached: 2, of: 4 });
    expect(maxCape([L(99)], null)).toBeNull();
  });
  it("readLevelCaps is null before the v11 rollup and reads the stored caps after it", () => {
    const db = buildAndRoll("resumed");
    expect(readLevelCaps(db)).toEqual({ current: 99, first: 99, raises: [] });
    execFileSync("sqlite3", [db, "INSERT INTO level_caps VALUES (120, 99, '2026-09-30', 'claude', 'tool', 'claude');"]);
    expect(readLevelCaps(db)).toEqual({ current: 120, first: 99,
      raises: [{ cap: 120, reachedLevel: 99, day: "2026-09-30", source: "claude", kind: "tool", key: "claude" }] });
    execFileSync("sqlite3", [db, "DELETE FROM level_caps;"]);
    expect(readLevelCaps(db)).toBeNull();
    execFileSync("sqlite3", [db, "DROP TABLE level_caps;"]);
    expect(readLevelCaps(db)).toBeNull();
    expect(readLevels(db).claude.state).not.toBe("pending"); // agent_progress still reads
  });
});
