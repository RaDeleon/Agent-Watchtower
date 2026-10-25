/**
 * Every tool's level, as `agent_progress` stores it (Stage 5, spec 4.4). The
 * rollup computes XP, level, tier, the distance to the next level and stars;
 * this module reads, sums and counts them and computes nothing else.
 */
import { querySql, sqlStr } from "../core/sql.ts";

export type AgentSource = "claude" | "codex" | "hermes";
export const AGENT_SOURCES: readonly AgentSource[] = ["claude", "codex", "hermes"];
export const AGENT_LABEL: Record<AgentSource, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes" };

export interface Level {
  /** A tool, or 'character' for an attribute (Stage 10), as LevelUp.source. */
  source: AgentSource | "character";
  /** Lifetime driven seconds. */
  activeS: number;
  xp: number;
  level: number;
  tier: string;
  xpIntoLevel: number;
  /** Null at the top level. */
  xpToNext: number | null;
  sToNext: number | null;
  /** One per 250 h past the top level; 0 below it. */
  stars: number;
  /** Stage 10: the current level cap from level_caps; absent or null before the v11 rollup. */
  cap?: number | null;
}

/** Stage 10: a cap the rollup opened, and the stat that opened it. */
export interface CapRaise { cap: number; reachedLevel: number; day: string; source: string; kind: string; key: string }
export interface LevelCaps {
  /** MAX(cap): what "Lv X/cap" shows. */
  current: number;
  /** MIN(cap): Max Cape's threshold (spec 4.7). */
  first: number;
  /** Newest first. */
  raises: CapRaise[];
}

/**
 * What a level card can say. `pending`: no row, because the installed rollup
 * predates schema v7 or has not run since this tool was synced. `none`: a row
 * with no driven seconds, so there is no level ("No driven hours yet.") --
 * never Lv 1 for nothing.
 */
export type LevelState =
  | { state: "pending" }
  | { state: "none"; activeS: number }
  | { state: "level"; level: Level };

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

/** Whether `name` is a table in `db`: a reader of a v7 or wt table on an older database says "pending", never errors. */
export function hasTable(db: string, name: string): boolean {
  return read<{ n: number }>(db,
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${sqlStr(name)};`)[0].n > 0;
}

interface Row {
  source: string; active_s: number; xp: number; level: number | null; tier: string | null;
  xp_into_level: number | null; xp_to_next: number | null; s_to_next: number | null; stars: number | null;
}

/** Null before the first v11 rollup: no level_caps table, or no rows in it yet. */
export function readLevelCaps(db: string): LevelCaps | null {
  if (!hasTable(db, "level_caps")) return null;
  const [m] = read<{ current: number | null; first: number | null }>(db,
    "SELECT MAX(cap) AS current, MIN(cap) AS first FROM level_caps;");
  if (m.current === null || m.first === null) return null;
  const raises = read<{ cap: number; reached_level: number; opened_day: string; source: string; kind: string; key: string }>(db,
    `SELECT cap, reached_level, opened_day, source, kind, key FROM level_caps
     WHERE opened_day IS NOT NULL ORDER BY opened_day DESC, cap DESC;`)
    .map((r) => ({ cap: r.cap, reachedLevel: r.reached_level, day: r.opened_day, source: r.source, kind: r.kind, key: r.key }));
  return { current: m.current, first: m.first, raises };
}

function toState(r: Row | undefined, cap: number | null = null): LevelState {
  if (r === undefined) return { state: "pending" };
  if (r.level === null || r.tier === null) return { state: "none", activeS: r.active_s };
  return {
    state: "level",
    level: {
      source: r.source as AgentSource, activeS: r.active_s, xp: r.xp, level: r.level, tier: r.tier,
      xpIntoLevel: r.xp_into_level ?? 0, xpToNext: r.xp_to_next, sToNext: r.s_to_next, stars: r.stars ?? 0, cap,
    },
  };
}

/** A page that reads the caps itself passes them in (null included), so they are read once per page. */
export function readLevels(db: string, caps: LevelCaps | null = readLevelCaps(db)): Record<AgentSource, LevelState> {
  const rows = hasTable(db, "agent_progress")
    ? read<Row>(db, `SELECT source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars
                     FROM agent_progress;`)
    : [];
  const by = new Map(rows.map((r) => [r.source, r]));
  const cap = caps?.current ?? null;
  return { claude: toState(by.get("claude"), cap), codex: toState(by.get("codex"), cap), hermes: toState(by.get("hermes"), cap) };
}

export function readLevel(db: string, source: AgentSource): LevelState {
  return readLevels(db)[source];
}

/** Total level (spec 4.4): the sum over the tools that have one; null when none does. */
export function totalLevel(states: readonly LevelState[]): number | null {
  const levels = states.flatMap((s) => (s.state === "level" ? [s.level.level] : []));
  return levels.length === 0 ? null : levels.reduce((a, b) => a + b, 0);
}

/**
 * Max Cape over the detected tools (spec §5): how many have reached the first
 * cap, MIN(cap) from level_caps, of how many. Null before the v11 rollup,
 * which the page shows as pending. No level number lives here.
 */
export function maxCape(states: readonly LevelState[], at: number | null): { at: number; reached: number; of: number } | null {
  if (at === null) return null;
  return { at, reached: states.filter((s) => s.state === "level" && s.level.level >= at).length, of: states.length };
}
