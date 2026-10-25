import { describe, expect, it } from "vitest";
import { applyGroups, readProjectRows, type ProjectRow } from "@/lib/projects";
import { buildAndRoll, rows } from "./helpers/fixture-db";

const row = (label: string, activeHours: number, sessions = 1): ProjectRow => ({
  key: `/repos/${label}`, label, activeHours, windowHours: activeHours,
  sessions, prompts: 0, costUsd: 0, peakContextPct: 0,
});

describe("applyGroups", () => {
  it("sums members into one labelled row and drops the members", () => {
    const out = applyGroups(
      [row("vps-a", 1), row("vps-b", 2), row("other", 5)],
      { VPS: ["vps-a", "vps-b"] },
    );
    expect(out.map((r) => r.label).sort()).toEqual(["VPS", "other"]);
    expect(out.find((r) => r.label === "VPS")?.activeHours).toBe(3);
    expect(out.find((r) => r.label === "VPS")?.sessions).toBe(2);
  });

  it("leaves rows untouched when no group matches", () => {
    // "Untouched" means the row CONTENTS are unchanged, not their order --
    // applyGroups sorts its output by activeHours descending (callers want the
    // table ordered), so a fixture with ascending hours comes back reversed
    // even when no group applies. Compare both sides sorted by label so this
    // still fails if applyGroups alters a row's numbers.
    const rows = [row("a", 1), row("b", 2)];
    const byLabel = (r: ProjectRow[]) => [...r].sort((x, y) => x.label.localeCompare(y.label));
    expect(byLabel(applyGroups(rows, { VPS: ["nothing-here"] }))).toEqual(byLabel(rows));
  });

  it("does not mutate the input rows", () => {
    // Grouping is labelling. If it edits the underlying rows, a second call
    // double-counts and the bug only shows on a re-render.
    const rows = [row("vps-a", 1), row("vps-b", 2)];
    const copy = structuredClone(rows);
    applyGroups(rows, { VPS: ["vps-a", "vps-b"] });
    expect(rows).toEqual(copy);
  });

  // Stage 4B: a project with no context reading has a NULL peak. The group's
  // peak is the max over the members that HAVE one, as SQL's MAX is -- a null
  // member neither wins nor turns into 0.
  it("takes the group's peak context over the members with a reading", () => {
    const peak = (label: string, p: number | null): ProjectRow => ({ ...row(label, 1), peakContextPct: p });
    const mixed = applyGroups([peak("a", null), peak("b", 42), peak("c", null)], { G: ["a", "b", "c"] });
    expect(mixed[0].peakContextPct).toBe(42);
    const none = applyGroups([peak("a", null), peak("b", null)], { G: ["a", "b"] });
    expect(none[0].peakContextPct).toBeNull();
  });

  it("puts a project named in two groups in the FIRST group only", () => {
    const out = applyGroups([row("x", 1)], { A: ["x"], B: ["x"] });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("A");
    expect(out[0].activeHours).toBe(1);   // not 2
  });
});

describe("readProjectRows", () => {
  const HOUR_MS = 3_600_000;
  // Every fixture session is 10s of think + 600s of work.
  const SESSION_HOURS = 610_000 / HOUR_MS;

  it("reads real rows and hides (excluded)", () => {
    const db = buildAndRoll("mixed-projects-one-day", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });
    const got = readProjectRows(db, "all")
      // the two real keys are absolute paths under a per-run temp dir
      .map((r) => ({ ...r, key: r.key.startsWith("/") ? "<abs>" : r.key }))
      .sort((a, b) => a.label.localeCompare(b.label));

    // The WHOLE table, asserted by value. The predicate this replaced --
    // rows.every(r => r.activeHours >= 0) -- passes on any non-negative data
    // and on an empty array, so it would have gone on passing if the reader
    // stopped reading altogether.
    expect(got).toEqual([
      // the non-repo cwd, plus the fifth session that has no events at all
      { key: "(unfiled)", label: "(unfiled)", activeHours: SESSION_HOURS, windowHours: SESSION_HOURS,
        sessions: 2, prompts: 2, costUsd: 1.5, peakContextPct: 10 },
      { key: "<abs>", label: "proj-one", activeHours: SESSION_HOURS, windowHours: SESSION_HOURS,
        sessions: 1, prompts: 1, costUsd: 1.5, peakContextPct: 10 },
      { key: "<abs>", label: "proj-two", activeHours: SESSION_HOURS, windowHours: SESSION_HOURS,
        sessions: 1, prompts: 1, costUsd: 1.5, peakContextPct: 10 },
    ]);
    // (excluded) is hidden by the READER, not missing from the table: it has to
    // be stored, or the reconciliation identity stops being unconditional.
    expect(rows<{ n: number }>(
      db, "SELECT COUNT(*) AS n FROM claude_project_rollups WHERE project_key = '(excluded)';",
    )[0].n).toBe(1);
  });

  // The titular feature of the final commit, and it had never executed: every
  // fixture is pinned at BASE = 2025-06-15, permanently outside the window, so
  // the `WHERE day >= date('now','localtime','-29 days')` branch returned 0
  // rows against the entire suite.
  it('"30d" keeps rows inside the window and drops rows outside it', () => {
    const db = buildAndRoll("recent-and-old-projects");
    // "all" sees both: 3 days ago and 120 days ago.
    expect(readProjectRows(db, "all").map((r) => r.label).sort()).toEqual(["proj-old", "proj-recent"]);
    // "30d" sees only the recent one.
    expect(readProjectRows(db, "30d").map((r) => r.label)).toEqual(["proj-recent"]);
    // ...and it is a real row, not an empty result that happens to match.
    expect(readProjectRows(db, "30d")[0].activeHours).toBe(SESSION_HOURS);
  });
});
