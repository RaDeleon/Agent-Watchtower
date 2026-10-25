/**
 * The Character page (Stage 6, spec §5): every tool as a skill, its projects
 * and models as sub-skills, its pace and streaks, and the level-up log -- all
 * as rollup.sh stored them in the skill_* tables. This module reads, filters
 * (excluded) and labels. Its one piece of arithmetic is a stored day count
 * added to a stored date, for "99 by <date>".
 */
import os from "node:os";
import { querySql } from "../core/sql.ts";
import {
  AGENT_LABEL, hasTable, readLevelCaps, readLevels, totalLevel, type AgentSource, type CapRaise, type Level, type LevelState,
} from "./level.ts";
import { ATTRIBUTE_NAMES, readAttributes, type AttributeId, type AttributesData } from "./attributes.ts";
import { projectLabel } from "./projects.ts";
import { toolStatus } from "./tools.ts";

export type SkillKind = "tool" | "project" | "model" | "skill" | "pack" | "skill-use" | "attribute";

/** The served level-up log's length; the report shows fewer (render/character.ts). */
export const LEVEL_UP_CAP = 300;
/** Stage 7: the skill-use row's name -- its tile, its section and its level-up path. */
export const SKILL_USE_LABEL = "Skill use";
/** The pack rollup.sh gives a skill it could not place (spec 4.3), and an unresolved skill's. */
export const NO_PACK = "(no pack)";

export interface Skill {
  key: string;
  /** A project's basename, a model's name. */
  label: string;
  level: Level;
  firstDay: string;
  lastDay: string;
}

/** A Claude Code skill, with the pack claude_skill_packs gives it. */
export interface PackedSkill extends Skill {
  pack: string;
}

/** Stage 7: Claude Code skills, their packs and all skill time. Not in the Total level. */
export interface SkillUse {
  /** No claude_skill_packs table: the installed rollup predates schema v9. */
  pending: boolean;
  /** The skill-use row's level; null with no skill time. */
  level: Level | null;
  /** Highest level first. */
  packs: Skill[];
  /** Highest level first. */
  skills: PackedSkill[];
}

export interface Pace {
  asOfDay: string;
  xpToday: number;
  xp7d: number;
  xp28d: number;
  /** XP per calendar day over 28 days. */
  perDay: number;
  etaNextDays: number | null;
  eta99Days: number | null;
  /** asOfDay + eta99Days, YYYY-MM-DD; null with no ETA. */
  date99: string | null;
  /** Stage 10: days to the current level cap; null with no pace, no level or at the top. */
  etaCapDays: number | null;
  /** asOfDay + etaCapDays; null with no ETA. */
  dateCap: string | null;
  streakCurrent: number;
  streakBest: number;
}

export interface LevelUp {
  day: string;
  source: AgentSource | "character";
  kind: SkillKind;
  key: string;
  label: string;
  level: number;
  tier: string;
  tierChanged: boolean;
}

export interface ToolCharacter {
  source: AgentSource;
  label: string;
  /** From agent_progress, as on every other page: pending, none, or a level. */
  state: LevelState;
  pace: Pace | null;
  /** Highest level first; (excluded) is not here. */
  projects: Skill[];
  /** Whether an (excluded) project row was left out. */
  excludedHidden: boolean;
  models: Skill[];
}

export interface CharacterData {
  generatedAt: number;
  /** No skill_progress table: the installed rollup predates schema v8. */
  pending: boolean;
  tools: ToolCharacter[];
  totalLevel: number | null;
  /** The 'all' row: every tool together. */
  all: Pace | null;
  /** Newest first, at most LEVEL_UP_CAP. */
  levelUps: LevelUp[];
  /** Every level-up on record, (excluded) aside. */
  levelUpCount: number;
  skillUse: SkillUse;
  /** Stage 8: Quest and Achievement Points, or null before the v10 rollup. Neither is in the Total level. */
  points: { qp: number; ap: number } | null;
  /** Stage 10: the current level cap; null before the v11 rollup. */
  cap: number | null;
  /** Newest first. */
  capRaises: CapRaise[];
  attributes: AttributesData;
}

interface ProgRow {
  source: string; kind: string; key: string; active_s: number; xp: number; level: number; tier: string;
  xp_into_level: number; xp_to_next: number | null; s_to_next: number | null; stars: number;
  first_day: string; last_day: string;
}
interface PaceRow {
  source: string; as_of_day: string; xp_today: number; xp_7d: number; xp_28d: number; pace_xp_per_day: number;
  eta_next_days: number | null; eta_99_days: number | null; eta_cap_days?: number | null; streak_current: number; streak_best: number;
}
interface UpRow { source: string; kind: string; key: string; level: number; day: string; tier: string; tier_changed: number }

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });
const EXCLUDED = "(excluded)";

export const labelOf = (kind: string, key: string): string =>
  kind === "project" ? projectLabel(key)
    : kind === "skill-use" ? SKILL_USE_LABEL
      : kind === "attribute" ? ATTRIBUTE_NAMES[key as AttributeId]?.name ?? key
        : key;

/** A stored day count after a stored day, as a date. */
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

function toSkill(r: ProgRow, cap: number | null = null): Skill {
  return {
    key: r.key,
    label: labelOf(r.kind, r.key),
    level: {
      source: r.source as AgentSource, activeS: r.active_s, xp: r.xp, level: r.level, tier: r.tier,
      xpIntoLevel: r.xp_into_level, xpToNext: r.xp_to_next, sToNext: r.s_to_next, stars: r.stars, cap,
    },
    firstDay: r.first_day,
    lastDay: r.last_day,
  };
}

function toPace(r: PaceRow | undefined): Pace | null {
  if (r === undefined) return null;
  return {
    asOfDay: r.as_of_day, xpToday: r.xp_today, xp7d: r.xp_7d, xp28d: r.xp_28d, perDay: r.pace_xp_per_day,
    etaNextDays: r.eta_next_days, eta99Days: r.eta_99_days,
    date99: r.eta_99_days === null ? null : addDays(r.as_of_day, r.eta_99_days),
    etaCapDays: r.eta_cap_days ?? null,
    dateCap: r.eta_cap_days == null ? null : addDays(r.as_of_day, r.eta_cap_days),
    streakCurrent: r.streak_current, streakBest: r.streak_best,
  };
}

const SKILL_USE_PENDING: SkillUse = { pending: true, level: null, packs: [], skills: [] };

/** Stage 7, plan R8 and R9: pending before the v9 rollup; a skill's pack is read here, not stored on its row. */
function readSkillUse(db: string, prog: ProgRow[], cap: number | null): SkillUse {
  if (!hasTable(db, "claude_skill_packs")) return SKILL_USE_PENDING;
  const packOf = new Map(
    read<{ skill: string; pack: string }>(db, "SELECT skill, pack FROM claude_skill_packs;").map((r) => [r.skill, r.pack]),
  );
  const mine = prog.filter((r) => r.source === "claude");
  const use = mine.find((r) => r.kind === "skill-use");
  return {
    pending: false,
    level: use === undefined ? null : toSkill(use, cap).level,
    packs: mine.filter((r) => r.kind === "pack").map((r) => toSkill(r, cap)),
    skills: mine.filter((r) => r.kind === "skill").map((r) => ({ ...toSkill(r, cap), pack: packOf.get(r.key) ?? NO_PACK })),
  };
}

export function readCharacter(db: string, opts: { now?: number; home?: string } = {}): CharacterData {
  const generatedAt = opts.now ?? Math.floor(Date.now() / 1000);
  if (!hasTable(db, "skill_progress")) {
    return { generatedAt, pending: true, tools: [], totalLevel: null, all: null, levelUps: [], levelUpCount: 0, skillUse: SKILL_USE_PENDING, points: null, cap: null, capRaises: [], attributes: { pending: true, asOfDay: null, attributes: [], lowest: null } };
  }
  const caps = readLevelCaps(db);
  const levels = readLevels(db, caps);
  const cap = caps?.current ?? null;
  const shown: AgentSource[] = ["claude"];
  for (const s of ["codex", "hermes"] as const) {
    if (toolStatus(db, s, opts.home ?? os.homedir()).state !== "not-installed") shown.push(s);
  }

  const prog = read<ProgRow>(db, `SELECT source, kind, key, active_s, xp, level, tier, xp_into_level, xp_to_next,
      s_to_next, stars, first_day, last_day FROM skill_progress WHERE kind <> 'tool' AND source <> 'character'
      ORDER BY level DESC, xp DESC, key;`);
  const pace = new Map(read<PaceRow>(db, `SELECT * FROM skill_pace;`).map((r) => [r.source, r]));

  const tools: ToolCharacter[] = shown.map((source) => {
    const mine = prog.filter((r) => r.source === source);
    const projects = mine.filter((r) => r.kind === "project");
    return {
      source,
      label: AGENT_LABEL[source],
      state: levels[source],
      pace: toPace(pace.get(source)),
      projects: projects.filter((r) => r.key !== EXCLUDED).map((r) => toSkill(r, cap)),
      excludedHidden: projects.some((r) => r.key === EXCLUDED),
      models: mine.filter((r) => r.kind === "model").map((r) => toSkill(r, cap)),
    };
  });

  const notExcluded = `NOT (kind = 'project' AND key = '${EXCLUDED}')`;
  const ups = read<UpRow>(db, `SELECT source, kind, key, level, day, tier, tier_changed FROM skill_level_ups
      WHERE ${notExcluded} ORDER BY day DESC, source, kind, key, level DESC LIMIT ${LEVEL_UP_CAP};`);
  const count = read<{ n: number }>(db, `SELECT COUNT(*) AS n FROM skill_level_ups WHERE ${notExcluded};`)[0].n;

  return {
    generatedAt,
    pending: false,
    tools,
    totalLevel: totalLevel(tools.map((t) => t.state)),
    all: toPace(pace.get("all")),
    levelUps: ups.map((u) => ({
      day: u.day, source: u.source as LevelUp["source"], kind: u.kind as SkillKind, key: u.key,
      label: u.kind === "tool" ? AGENT_LABEL[u.source as AgentSource] : labelOf(u.kind, u.key),
      level: u.level, tier: u.tier, tierChanged: u.tier_changed === 1,
    })),
    levelUpCount: count,
    skillUse: readSkillUse(db, prog, cap),
    points: hasTable(db, "character_points")
      ? read<{ qp: number; ap: number }>(db, "SELECT qp, ap FROM character_points;")[0] ?? null
      : null,
    cap,
    capRaises: caps?.raises ?? [],
    attributes: readAttributes(db, cap),
  };
}
