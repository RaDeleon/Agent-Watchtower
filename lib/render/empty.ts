/**
 * Spec §5's "when there is nothing to measure" strings, verbatim, in one
 * place. A missing measurement is never shown as zero.
 */
export const NOT_SYNCED = "Not synced yet — open the dashboard or run `watchtower sync`.";
export const NO_DRIVEN_HOURS = "No driven hours yet.";
export const AUTOMATED_ONLY = "automated only";
export const NO_REQUESTS = "no requests";
export const ROLLUP_PENDING = "rollup pending";
export const LEVEL_PENDING = "level pending";
/** Why a level is pending: Claude's row comes from the installed rollup, the agents' from a sync. */
export const LEVEL_PENDING_WHY_CLAUDE = "Watchtower's rollup has not run since its v7 install";
export const LEVEL_PENDING_WHY_AGENT = "the rollup has not run since this tool was synced";
export const NO_OPENVIKING = "no OpenViking on this machine";
export const MEMORY_CAPTION = "memory — not counted in totals";
/** The first sync of a tool threw; there is no data to show, only the reason. */
export const firstSyncFailed = (err: string | null): string =>
  `The first sync failed${err === null || err === "" ? "" : `: ${err.length > 240 ? `${err.slice(0, 240)}…` : err}`}. Fix the cause, then run \`watchtower sync\`.`;
export const dataAsOf = (when: string): string => `data as of ${when}`;
export const unreachableAt = (when: string): string => `Unreachable at last sync (${when})`;
export const lookedFor = (label: string, where: string): string =>
  `Watchtower looked for ${label} at ${where} and found nothing.`;

/** Stage 6, the Character page (spec §5). */
export const LEVEL_PENDING_WHY_V8 = "Watchtower's rollup has not run since its v8 install";
export const NO_PACE = "no pace in the last 28 days";
export const AT_PACE = "at your 28-day pace";
export const NO_LEVEL_UPS = "No level-ups yet.";
export const EXCLUDED_HIDDEN = "Excluded projects are hidden here; their time still counts toward the tool.";
export const noSubSkills = (what: "projects" | "models"): string => `No ${what} with driven hours yet.`;

/** Stage 7, Skill use (spec §5). */
export const LEVEL_PENDING_WHY_V9 = "Watchtower's rollup has not run since its v9 install";
export const NO_SKILL_TIME = "No skill time yet.";
export const SKILL_USE_COUNTED =
  "Time in the turns that loaded a skill. Your next prompt ends that turn, so a skill guiding a long conversation is credited for the turn that loaded it.";
export const SKILL_USE_NOT_IN_TOTAL = "Skill use is time already in Claude's level, so it is not in Total.";
export const noSkillRows = (what: "packs" | "skills"): string => `No ${what} with time yet.`;

/** Stage 8, the Quests page (spec §5). */
export const QUESTS_PENDING = "Quests pending until the v10 rollup";
export const ACHIEVEMENTS_PENDING = "Achievements pending until the v10 rollup";
export const NO_QUESTS_YET = "No quests yet: a quest needs a week with at least 20 requests before it.";
export const NO_QUESTS_THIS_WEEK = "No quests this week: nothing was measurable last week.";
export const UNDER_20_SO_FAR = "under 20 requests so far";
export const NO_READING = "no reading";
export const NO_UNLOCKS = "No tiers unlocked yet.";
export const NO_CLOSED_WEEKS = "No closed weeks with quests yet.";

/** Stage 10. */
export const ATTRIBUTES_PENDING = "Attributes are pending until the v11 rollup";
export const NO_ATTRIBUTE_XP = "No attribute XP yet.";
export const STR_SOURCE = "output per active hour, every tool";
