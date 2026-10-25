/**
 * The Quests page (Stage 8, spec §5): this week's quests, the quest log,
 * achievements by tier and the two point totals, as rollup.sh stored them in
 * claude_quests, achievement_tiers and character_points. This module reads,
 * groups, sorts and labels. It computes no target, status, threshold or date.
 */
import { querySql } from "../core/sql.ts";
import { AGENT_LABEL, hasTable, type AgentSource } from "./level.ts";

export type QuestStatus = "open" | "done" | "missed" | "no data";
/** How a quest's numbers read: a share as a percent, a ratio, tokens in thousands, a count. */
export type QuestUnit = "share" | "ratio" | "tokens" | "count";

/** Each discipline's quest (spec 4.2): its name, its unit and what it measures. */
export const QUESTS: Record<string, { name: string; unit: QuestUnit; measure: string }> = {
  "verification": { name: "Look before you leap", unit: "share", measure: "Read, Grep and Glob share of tool calls" },
  "cost-discipline": { name: "Lean cache", unit: "ratio", measure: "cache re-read ÷ fresh tokens" },
  "context-hygiene": { name: "Travel light", unit: "tokens", measure: "median context per session" },
  "session-hygiene": { name: "Fresh start", unit: "share", measure: "long sessions with a reset" },
  "model-routing": { name: "Right tool", unit: "share", measure: "requests off your top model" },
  "security": { name: "Ask first", unit: "share", measure: "prompts that bypass permissions" },
  "output-quality": { name: "Clean run", unit: "share", measure: "tool error rate" },
  "prompt-hygiene": { name: "Variety pack", unit: "count", measure: "distinct slash commands" },
  "reuse": { name: "Signature move", unit: "count", measure: "uses of your most-used slash command" },
  "automation": { name: "Delegate", unit: "count", measure: "subagent launches and headless sessions" },
};

export type AchievementGroup = "tools" | "skills" | "habits";
export type AchievementUnit = "level" | "days" | "sessions" | "tokens" | "projects" | "skills" | "disciplines" | "points" | "weeks";

/** The catalogue (spec 4.5), in display order. Thresholds are stored, never here. */
export const ACHIEVEMENTS: ReadonlyArray<{ key: string; name: string; group: AchievementGroup; unit: AchievementUnit }> = [
  { key: "seasoned", name: "Seasoned", group: "tools", unit: "level" },
  { key: "daily-habit", name: "Daily habit", group: "tools", unit: "days" },
  { key: "regular", name: "Regular", group: "tools", unit: "sessions" },
  { key: "wordsmith", name: "Wordsmith", group: "tools", unit: "tokens" },
  { key: "explorer", name: "Explorer", group: "tools", unit: "projects" },
  { key: "skill-collector", name: "Skill collector", group: "skills", unit: "skills" },
  { key: "skill-master", name: "Skill master", group: "skills", unit: "level" },
  { key: "pack-master", name: "Pack master", group: "skills", unit: "level" },
  { key: "skill-user", name: "Skill user", group: "skills", unit: "level" },
  { key: "all-rounder", name: "All-rounder", group: "habits", unit: "disciplines" },
  { key: "quester", name: "Quester", group: "habits", unit: "points" },
  { key: "perfect-week", name: "Perfect week", group: "habits", unit: "weeks" },
];

export const TIER_NAMES = ["bronze", "silver", "gold", "platinum"] as const;
/** The Recent unlocks list's length (spec §5). */
export const RECENT_UNLOCKS = 10;

export interface Quest {
  discipline: string;
  name: string;
  unit: QuestUnit;
  measure: string;
  slot: number;
  /** The 30-day score on the Sunday before the week, which chose this quest. */
  score: number;
  direction: "at-least" | "at-most";
  baseline: number;
  target: number;
  /** The baseline was already at full marks: the quest is to hold it. */
  hold: boolean;
  /** Null: not measured (under 20 requests, or nothing to divide). */
  value: number | null;
  requests: number;
  status: QuestStatus;
}

export interface QuestWeek {
  /** The Monday and the Sunday, YYYY-MM-DD, as stored. */
  week: string;
  weekEnd: string;
  /** Slot order. */
  quests: Quest[];
  /** Quest Points earned: the week's done quests. */
  qp: number;
}

export interface Tier {
  tier: number;
  name: string;
  threshold: number;
  /** Null while locked. */
  unlockedDay: string | null;
}

export interface Achievement {
  key: string;
  name: string;
  group: AchievementGroup;
  unit: AchievementUnit;
  source: AgentSource;
  tool: string;
  /** Null: nothing measured (a tool or skill with no level). */
  value: number | null;
  /** Bronze to platinum. */
  tiers: Tier[];
}

export interface Unlock {
  day: string;
  key: string;
  name: string;
  source: AgentSource;
  tool: string;
  tier: number;
  tierName: string;
}

export interface QuestsData {
  generatedAt: number;
  /** No claude_quests table, or no character_points row: the v10 rollup has not run. */
  pending: boolean;
  /** The open week; null when this week has no quests. */
  thisWeek: QuestWeek | null;
  /** Closed weeks with quests, newest first. */
  log: QuestWeek[];
  /** Whether claude_quests holds any row. */
  anyQuests: boolean;
  qp: number;
  ap: number;
  /** Catalogue order, then Claude, Codex, Hermes. */
  achievements: Achievement[];
  /** Newest first, at most RECENT_UNLOCKS. */
  recent: Unlock[];
}

interface QuestRow {
  week: string; week_end: string; slot: number; discipline: string; score: number; direction: string;
  baseline: number; target: number; hold: number; value: number | null; requests: number; status: string;
}
interface TierRow {
  achievement: string; source: string; tier: number; threshold: number; value: number | null; unlocked_day: string | null;
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });
const SOURCE_ORDER: AgentSource[] = ["claude", "codex", "hermes"];

const EMPTY = (generatedAt: number, pending: boolean): QuestsData =>
  ({ generatedAt, pending, thisWeek: null, log: [], anyQuests: false, qp: 0, ap: 0, achievements: [], recent: [] });

function toQuest(r: QuestRow): Quest {
  const q = QUESTS[r.discipline] ?? { name: r.discipline, unit: "count" as const, measure: "" };
  return {
    discipline: r.discipline, name: q.name, unit: q.unit, measure: q.measure, slot: r.slot, score: r.score,
    direction: r.direction === "at-most" ? "at-most" : "at-least", baseline: r.baseline, target: r.target,
    hold: r.hold === 1, value: r.value, requests: r.requests, status: r.status as QuestStatus,
  };
}

/** Rows in (week, slot) order, grouped into weeks. */
function weeksOf(rows: QuestRow[]): QuestWeek[] {
  const out: QuestWeek[] = [];
  for (const r of rows) {
    let w = out[out.length - 1];
    if (w === undefined || w.week !== r.week) {
      w = { week: r.week, weekEnd: r.week_end, quests: [], qp: 0 };
      out.push(w);
    }
    const q = toQuest(r);
    w.quests.push(q);
    if (q.status === "done") w.qp += 1;
  }
  return out;
}

export function readQuests(db: string, opts: { now?: number } = {}): QuestsData {
  const generatedAt = opts.now ?? Math.floor(Date.now() / 1000);
  if (!hasTable(db, "claude_quests") || !hasTable(db, "character_points")) return EMPTY(generatedAt, true);
  const points = read<{ qp: number; ap: number }>(db, "SELECT qp, ap FROM character_points;")[0];
  if (points === undefined) return EMPTY(generatedAt, true);

  const weeks = weeksOf(read<QuestRow>(db, `SELECT week, week_end, slot, discipline, score, direction, baseline, target,
      hold, value, requests, status FROM claude_quests ORDER BY week, slot;`));
  const open = weeks.filter((w) => w.quests.some((q) => q.status === "open"));
  const closed = weeks.filter((w) => !open.includes(w)).reverse();

  const tiers = read<TierRow>(db, `SELECT achievement, source, tier, threshold, value, unlocked_day
      FROM achievement_tiers ORDER BY achievement, source, tier;`);
  const achievements: Achievement[] = [];
  for (const a of ACHIEVEMENTS) {
    for (const source of SOURCE_ORDER) {
      const mine = tiers.filter((t) => t.achievement === a.key && t.source === source);
      if (mine.length === 0) continue;
      achievements.push({
        key: a.key, name: a.name, group: a.group, unit: a.unit, source, tool: AGENT_LABEL[source], value: mine[0].value,
        tiers: mine.map((t) => ({
          tier: t.tier, name: TIER_NAMES[t.tier - 1], threshold: t.threshold, unlockedDay: t.unlocked_day,
        })),
      });
    }
  }
  const order = (key: string) => ACHIEVEMENTS.findIndex((a) => a.key === key);
  const recent = achievements
    .flatMap((a) => a.tiers.filter((t) => t.unlockedDay !== null).map((t): Unlock => ({
      day: t.unlockedDay as string, key: a.key, name: a.name, source: a.source, tool: a.tool, tier: t.tier, tierName: t.name,
    })))
    .sort((x, y) => (x.day === y.day ? (y.tier - x.tier) || (order(x.key) - order(y.key)) : x.day < y.day ? 1 : -1))
    .slice(0, RECENT_UNLOCKS);

  return {
    generatedAt, pending: false, thisWeek: open[open.length - 1] ?? null, log: closed, anyQuests: weeks.length > 0,
    qp: points.qp, ap: points.ap, achievements, recent,
  };
}
