import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { slow } from "./helpers/timeout";

// Stage 4B spec 4.4. A session with no status-line snapshot has no context
// reading, so its peak is NULL -- not the 0 rollup.sh used to COALESCE it to,
// which scored "an empty context all day" as full marks. On a day with an
// unmeasured term, hygiene is
//   (the measured terms) x 100 / (the most those terms could reach that day)
// with cache 25 if measured, context 30 if measured, compact-vs-clear 25 and
// focus 20 (a flat 10 when the window is 0):
//
//   cache     context   denominator   written?
//   measured  measured  --            not rewritten: byte-identical
//   NULL      measured  75 / 65       today's rescale: byte-identical
//   measured  NULL      70 / 60       new
//   NULL      NULL      45 / 35       new
//
// hygiene-cases has one day per row; the arithmetic is written out in
// make-fixture.sh. Every expected value below is computed in the SAME
// operation order as the SQL that produces it (floating-point addition is not
// associative), so each is compared with toBe, not toBeCloseTo.

/** Focus on days 1-3: idle 600 s of a 1810 s window, as rollup.sh writes it. */
const FOCUS = Math.max(0, Math.min(20, 20 * (1 - 600000 / 1810000)));

/** The first hygiene UPDATE, unchanged since before 4B: every term measured. */
const main = (cachePct: number | null, ctx: number, cc: number, focus: number) =>
  Math.max(0, Math.min(100, (cachePct ?? 0) * 0.25 + ctx + cc + focus));

// Row 1: cache and context measured -> the first UPDATE alone.
const DAY1 = main(90, 30 - (88 - 85) * 2, 18, FOCUS);
// Row 2: no request, a context reading -> the first UPDATE, then today's
// cache rescale against 75 (the window is not zero).
const DAY2 = Math.min(100, main(null, 30, 25, FOCUS) * (100 / 75));
// Row 3: cache measured, no snapshot -> (cache + compact-vs-clear + focus) x 100 / 70.
const DAY3 = Math.max(0, Math.min(100, (80 * 0.25 + 18 + FOCUS) * 100 / (25 + 25 + 20)));
// Row 4: neither, zero window -> (compact-vs-clear + a flat 10) x 100 / 35.
const DAY4 = Math.max(0, Math.min(100, (0 + 12.5 + 10) * 100 / (25 + 10)));

interface Daily {
  day: string;
  cache_hit_percentage: number | null;
  peak_context_pct: number | null;
  total_session_ms: number;
  hygiene_score: number;
}

const daily = (db: string) => rows<Daily>(db,
  `SELECT day, cache_hit_percentage, peak_context_pct, total_session_ms, hygiene_score
   FROM claude_daily_rollups ORDER BY day;`);

describe("hygiene: the generalised rescale (spec 4B §4.4)", () => {
  const db = buildAndRoll("hygiene-cases");

  // THE COALESCE PLANT'S TARGET. Restore `COALESCE(c.peakctx,0)` in _sx and
  // days 3 and 4 read peak 0, scored as full context marks (81.37 and 80.77).
  it("stores no peak where no session was read, and scores that day out of 70 or 35", () => {
    const d = daily(db);
    expect(d.map((x) => x.day)).toEqual(["2025-06-15", "2025-06-16", "2025-06-17", "2025-06-18"]);
    expect(d[2]).toEqual({
      day: "2025-06-17", cache_hit_percentage: 80, peak_context_pct: null, total_session_ms: 1810000, hygiene_score: DAY3,
    });
    expect(d[3]).toEqual({
      day: "2025-06-18", cache_hit_percentage: null, peak_context_pct: null, total_session_ms: 0, hygiene_score: DAY4,
    });
    // The project half: day 3's one (unfiled) row carries no peak either.
    expect(rows(db, "SELECT sessions_count, peak_context_pct FROM claude_project_rollups WHERE day = '2025-06-17';"))
      .toEqual([{ sessions_count: 1, peak_context_pct: null }]);

    // Moved here from project-rollup.test.ts ("leaves the context percentages
    // NULL") and read-history.test.ts (M14), which asserted the stored 0 this
    // task removes: a session day with no snapshot of its own stores NULL.
    const tokensOnly = buildAndRoll("tokens-only-day");
    expect(rows(tokensOnly, "SELECT peak_context_pct FROM claude_daily_rollups WHERE sessions_count > 0;"))
      .toEqual([{ peak_context_pct: null }]);
    const history = buildAndRoll("history");
    expect(rows(history, "SELECT peak_context_pct AS p FROM claude_daily_rollups WHERE day = '2025-06-16';"))
      .toEqual([{ p: null }]);
  }, slow(30_000));

  // A day WITH a peak is never rewritten by the new statement: rows 1 and 2
  // are exactly what main's arithmetic gives, bit for bit.
  it("leaves a day with a context reading exactly as main scored it", () => {
    const d = daily(db);
    expect(d[0]).toEqual({
      day: "2025-06-15", cache_hit_percentage: 90, peak_context_pct: 88, total_session_ms: 1810000, hygiene_score: DAY1,
    });
    expect(d[1]).toEqual({
      day: "2025-06-16", cache_hit_percentage: null, peak_context_pct: 50, total_session_ms: 1810000, hygiene_score: DAY2,
    });
  });

  // Lifetime hygiene is AVG(NULLIF(hygiene_score, 0)) over days, so it
  // follows the rescaled days; none of the four is a zero day.
  it("averages the four rescaled days into claude_rank_progress", () => {
    const [{ avg, n }] = rows<{ avg: number; n: number }>(db,
      "SELECT AVG(NULLIF(hygiene_score, 0)) AS avg, COUNT(NULLIF(hygiene_score, 0)) AS n FROM claude_daily_rollups;");
    expect(n).toBe(4);
    const [rank] = rows<{ h: number }>(db, "SELECT hygiene_score AS h FROM claude_rank_progress;");
    expect(rank.h).toBeCloseTo(avg, 10);
  });
});
