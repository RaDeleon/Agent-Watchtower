import { realpathSync } from "node:fs";
import path from "node:path";
import { rows } from "../helpers/fixture-db";

/**
 * Every scenario in tests/fixtures/make-fixture.sh, in that file's own order.
 * Verified against its `case` statement: 17 scenarios, no more, no fewer.
 */
export const SCENARIOS = [
  "resumed", "missing-stop", "long-run", "work-cap", "dup-snapshot",
  "two-sessions-day", "crosses-midnight", "four-projects",
  "mixed-projects-one-day", "session-spans-two-projects",
  "recent-and-old-projects", "orphan-request-tokens", "request-only-projects",
  "partial-transcript-coverage", "zero-window-no-coverage", "null-cwd-request",
  "tokens-only-day",
];

export interface ScenarioBaseline {
  daily: unknown[];
  projects: unknown[];
  rank: unknown[];
}

/** A day bucket this far from today is pinned to a literal epoch, not derived from now. */
const NOW_RELATIVE_HORIZON_DAYS = 370;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Two things in the fixtures are volatile, and both would make a frozen
 * baseline unusable. Neither is a number the activity model produces -- they
 * are addresses, not measurements -- so both are rewritten to stable tokens
 * and everything else is compared byte for byte.
 *
 * 1. `project_key` is an absolute path. Five scenarios (four-projects,
 *    mixed-projects-one-day, session-spans-two-projects,
 *    recent-and-old-projects, request-only-projects) build their repo tree
 *    under `dirname(db)`, which buildAndRoll mints with mkdtempSync, so the
 *    key carries a fresh random directory on every run. The real path is
 *    also resolved through git, which returns the /private-prefixed realpath
 *    on macOS, so both spellings have to be rewritten.
 *
 * 2. `day` is normally a fixed calendar date -- every fixture is pinned at
 *    BASE = 1750000000 (2025-06-15). recent-and-old-projects is the one
 *    exception: it computes its offsets from `date +%s` on purpose, so that
 *    it stays inside the reader's 30-day window as the calendar moves. Its
 *    buckets therefore change every single day, and a literal date frozen
 *    here would go red tomorrow morning. Those two buckets, and only those,
 *    are rewritten relative to today.
 */
function stabilize(db: string, value: ScenarioBaseline): ScenarioBaseline {
  const dir = path.dirname(db);
  const roots = [dir];
  try {
    const real = realpathSync(dir);
    if (real !== dir) roots.push(real);
  } catch {
    /* the fixture tree may not exist for path-free scenarios */
  }
  roots.sort((a, b) => b.length - a.length);

  const todayUtc = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (ISO_DAY.test(v)) {
        const delta = Math.round((todayUtc - Date.parse(`${v}T00:00:00Z`)) / MS_PER_DAY);
        return delta >= 0 && delta <= NOW_RELATIVE_HORIZON_DAYS ? `<TODAY-${delta}>` : v;
      }
      let s = v;
      for (const root of roots) s = s.split(root).join("<FXDIR>");
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };

  return walk(value) as ScenarioBaseline;
}

/**
 * The frozen shape of "what Claude numbers are today". Read-only.
 *
 * Column list is explicit rather than SELECT *: a new column added later must
 * not silently widen the baseline and quietly invalidate the comparison.
 */
export function captureBaseline(db: string): ScenarioBaseline {
  return stabilize(db, {
    daily: rows(db, `SELECT day, total_session_ms, active_ms, idle_ms,
        sessions_count, tokens_in, tokens_out, tokens_cache_read,
        tokens_cache_creation, cache_hit_percentage, cost_usd, compacts,
        clears, subagents, prompts, avg_context_pct, peak_context_pct,
        hygiene_score
      FROM claude_daily_rollups ORDER BY day;`),
    projects: rows(db, `SELECT project_key, day, display_name, active_ms,
        window_ms, idle_ms, sessions_count, prompts, compacts, clears,
        subagents, tokens_in, tokens_out, tokens_cache_read,
        tokens_cache_creation, cost_usd, peak_context_pct, avg_context_pct
      FROM claude_project_rollups ORDER BY project_key, day;`),
    rank: rows(db, `SELECT total_hours, active_hours, lifetime_cost_usd,
        lifetime_tokens_in, lifetime_tokens_out, sessions_count, rank_index,
        rank_name, hours_into_rank, hours_to_next, next_rank_name, xp,
        hygiene_score
      FROM claude_rank_progress ORDER BY id;`),
  });
}
