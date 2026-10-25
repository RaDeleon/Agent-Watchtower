import { execFileSync } from "node:child_process";

export interface ProjectRow {
  key: string;
  label: string;
  activeHours: number;
  windowHours: number;
  sessions: number;
  prompts: number;
  costUsd: number;
  /**
   * Null when no session in the range had a status-line context reading: the
   * rollup stores NULL for such a row (Stage 4B), and MAX skips it.
   */
  peakContextPct: number | null;
}

interface RawRow {
  project_key: string; display_name: string | null;
  active_ms: number; window_ms: number;
  sessions_count: number; prompts: number;
  cost_usd: number; peak_context_pct: number | null;
}

/**
 * Read per-project rows for a range.
 *
 * SUMs rows that capture/rollup.sh already computed. No gap logic, no caps, no
 * day bucketing -- the activity model lives in capture/rollup.sh and nowhere
 * else, and tests/capture-scripts.test.ts fails if a model constant appears here.
 *
 * (excluded) is filtered out for display. It exists in the table so that every
 * second the daily rollup counts is findable in some per-project row, which is
 * what makes the reconciliation test unconditional.
 */
export function readProjectRows(dbPath: string, range: "all" | "30d"): ProjectRow[] {
  const where =
    range === "30d" ? `WHERE day >= date('now','localtime','-29 days')` : "";
  const sql = `SELECT project_key, display_name,
      SUM(active_ms) AS active_ms, SUM(window_ms) AS window_ms,
      SUM(sessions_count) AS sessions_count, SUM(prompts) AS prompts,
      SUM(cost_usd) AS cost_usd, MAX(peak_context_pct) AS peak_context_pct
    FROM claude_project_rollups
    ${where}
    GROUP BY project_key ORDER BY active_ms DESC;`;
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], { encoding: "utf8" });
  const raw: RawRow[] = out.trim() === "" ? [] : JSON.parse(out);
  return raw
    .filter((r) => r.project_key !== "(excluded)")
    .map((r) => ({
      key: r.project_key,
      label: r.display_name ?? r.project_key,
      activeHours: r.active_ms / 3_600_000,
      windowHours: r.window_ms / 3_600_000,
      sessions: r.sessions_count,
      prompts: r.prompts,
      costUsd: r.cost_usd,
      peakContextPct: r.peak_context_pct,
    }));
}

/**
 * Collapse grouped projects into one labelled row. Pure labelling: it never
 * touches the stored rows, so a group can be edited without a rebuild.
 * A project named in two groups joins the FIRST only -- otherwise its hours
 * would appear twice in one table and the column would not sum to the total.
 */
export function applyGroups(
  rows: ProjectRow[],
  groups: Record<string, string[]>,
): ProjectRow[] {
  const labelOf = new Map<string, string>();
  for (const [label, members] of Object.entries(groups)) {
    for (const m of members) if (!labelOf.has(m)) labelOf.set(m, label);
  }
  const out: ProjectRow[] = [];
  const byLabel = new Map<string, ProjectRow>();
  for (const r of rows) {
    const label = labelOf.get(r.label);
    if (label === undefined) { out.push(r); continue; }
    const acc = byLabel.get(label);
    if (acc === undefined) {
      byLabel.set(label, { ...r, key: `(group)${label}`, label });
    } else {
      acc.activeHours += r.activeHours;
      acc.windowHours += r.windowHours;
      acc.sessions += r.sessions;
      acc.prompts += r.prompts;
      acc.costUsd += r.costUsd;
      // NULL-aware, as SQL's MAX is: a member with no reading adds nothing.
      acc.peakContextPct =
        r.peakContextPct === null ? acc.peakContextPct
          : acc.peakContextPct === null ? r.peakContextPct
            : Math.max(acc.peakContextPct, r.peakContextPct);
    }
  }
  return [...out, ...byLabel.values()].sort((a, b) => b.activeHours - a.activeHours);
}
