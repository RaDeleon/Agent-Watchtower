import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db.ts";
import { eachDay, hygieneScale, lastNDays, readHistory, streaks } from "@/lib/read/history";

// The rollup buckets by LOCAL day under TZ=UTC; the reader's sqlite3 child
// inherits this, so both agree on which day a timestamp belongs to.
process.env.TZ = "UTC";

const BASE = 1750000000; // Sunday 2025-06-15, 15:06:40 UTC
const DAY = 86400;
/** Friday 2025-06-20, the `history` scenario's last day. */
const NOW = BASE + 5 * DAY + 1000;

describe("streaks", () => {
  const d = (day: string, sessions = 1) => ({ day, sessions });

  it("finds the longest run and where it ended", () => {
    const s = streaks([d("2025-06-01"), d("2025-06-02"), d("2025-06-03"), d("2025-06-05")], "2025-06-05");
    expect(s.longest).toBe(3);
    expect(s.longestEndsOn).toBe("2025-06-03");
    expect(s.current).toBe(1);
  });

  it("counts the current run back from yesterday while today is still empty", () => {
    expect(streaks([d("2025-06-01"), d("2025-06-02")], "2025-06-03").current).toBe(2);
    expect(streaks([d("2025-06-01"), d("2025-06-02")], "2025-06-04").current).toBe(0);
  });

  it("breaks a run on a tokens-only day and on a date with no row", () => {
    const s = streaks([d("2025-06-01"), d("2025-06-02", 0), d("2025-06-03"), d("2025-06-05")], "2025-06-05");
    expect(s.longest).toBe(1);
  });

  it("crosses a month boundary by calendar, not by string", () => {
    expect(streaks([d("2025-06-30"), d("2025-07-01")], "2025-07-01").current).toBe(2);
  });

  it("is zero with no session days at all", () => {
    expect(streaks([], "2025-06-01")).toEqual({ current: 0, longest: 0, longestEndsOn: null });
  });
});

describe("hygieneScale", () => {
  // Spec 4B §4.4: cache 25 if measured, context 30 if measured,
  // compact-vs-clear 25, focus 20 (a flat 10 when the window is zero).
  it("labels which maximum rollup.sh rescaled a day against", () => {
    expect(hygieneScale(90, 40, 610_000)).toBe(100);
    expect(hygieneScale(90, 40, 0)).toBe(100);
    expect(hygieneScale(null, 40, 610_000)).toBe(75);
    expect(hygieneScale(null, 40, 0)).toBe(65);
    expect(hygieneScale(90, null, 610_000)).toBe(70);
    expect(hygieneScale(90, null, 0)).toBe(60);
    expect(hygieneScale(null, null, 610_000)).toBe(45);
    expect(hygieneScale(null, null, 0)).toBe(35);
    // A measured 0 is a reading, not a missing one.
    expect(hygieneScale(0, 0, 610_000)).toBe(100);
  });
});

describe("lastNDays", () => {
  it("returns the n calendar dates ending on the given day", () => {
    expect(lastNDays("2025-07-01", 3)).toEqual(["2025-06-29", "2025-06-30", "2025-07-01"]);
    expect(lastNDays("2025-07-01", 30)).toHaveLength(30);
  });
});

describe("eachDay", () => {
  it("walks the calendar inclusively, across a month end", () => {
    expect(eachDay("2025-06-29", "2025-07-02")).toEqual(["2025-06-29", "2025-06-30", "2025-07-01", "2025-07-02"]);
  });
});

describe("readHistory", () => {
  const db = buildAndRoll("history");
  const h = readHistory(db, { now: NOW });
  const day = (s: string) => h.days.find((x) => x.day === s)!;

  it("reads today in the rollup's local zone", () => {
    expect(h.today).toBe("2025-06-20");
  });

  it("returns every rollup row, oldest first, with no row invented for the gap", () => {
    expect(h.days.map((x) => x.day)).toEqual(["2025-06-15", "2025-06-16", "2025-06-17", "2025-06-18", "2025-06-20"]);
  });

  // Killing mutation: pass hygiene_score through unconditionally. rollup.sh
  // stores 0 on a zero-session day; as a score, that 0 is the cliff the trend
  // line must not draw.
  it("reads a zero-session day's stored 0 as no score at all", () => {
    expect(day("2025-06-18").sessions).toBe(0);
    expect(day("2025-06-18").hygiene).toBeNull();
    expect(day("2025-06-18").hygieneScale).toBeNull();
  });

  // The labels have to agree with the scores the real rollup produced, or the
  // page would print "of 35" beside a figure that was divided by 45.
  // 06-16 and 06-17 have neither a request nor a snapshot of their own, so
  // both the cache and the context term are dropped (spec 4B §4.4):
  //   06-16  compact-vs-clear 18 + focus 20 = 38 of 45
  //   06-17  compact-vs-clear 18 + focus 10 (zero window) = 28 of 35
  it("labels each day's denominator consistently with the rollup's own rescale", () => {
    expect(day("2025-06-15").hygieneScale).toBe(100);
    expect(day("2025-06-15").hygiene).toBeCloseTo(90.5, 6);
    expect(day("2025-06-16").hygieneScale).toBe(45);
    expect(day("2025-06-16").hygiene).toBeCloseTo((38 / 45) * 100, 6);
    expect(day("2025-06-17").hygieneScale).toBe(35);
    expect(day("2025-06-17").hygiene).toBeCloseTo((28 / 35) * 100, 6);
  });

  it("keeps an absent cache reading absent", () => {
    expect(day("2025-06-16").cacheHitPct).toBeNull();
    expect(day("2025-06-17").idleShare).toBeNull();
  });

  it("fills the calendar from the first row to today, a missing date as 0 hours", () => {
    expect(h.calendar.map((c) => c.day)).toEqual(eachDay("2025-06-15", "2025-06-20"));
    expect(h.calendar.find((c) => c.day === "2025-06-19")!.activeHours).toBe(0);
    expect(h.calendar[0].activeHours).toBeCloseTo(610 / 3600, 9);
  });

  // M1: a date after the day the rollup last ran was never measured. The
  // 2026-09-12..16 freeze would otherwise have drawn four quiet days. A date
  // with a row keeps it; a missing date up to the last rollup is still 0.
  it("leaves dates after the last rollup as no reading, not 0 hours", () => {
    const stale = buildAndRoll("history");
    // The rollup last ran on 2025-06-18 (local, TZ=UTC).
    rows(stale, `UPDATE claude_daily_rollups SET updated_at = ${BASE + 3 * DAY};`);
    const s = readHistory(stale, { now: NOW });
    const cal = (x: string) => s.calendar.find((c) => c.day === x)!.activeHours;
    expect(cal("2025-06-18")).toBe(0);
    expect(cal("2025-06-19")).toBeNull();
    expect(cal("2025-06-20")).toBeGreaterThan(0); // has a row: measured
  });

  it("walks streaks over the real rows", () => {
    expect(h.streaks).toEqual({ current: 1, longest: 3, longestEndsOn: "2025-06-17" });
  });

  it("buckets prompts by local weekday and hour", () => {
    // Sunday 15:06 once, Monday 15:06 once, Friday 15:06 twice.
    expect(h.promptsCounted).toBe(4);
    expect(h.promptGrid[0][15]).toBe(1);
    expect(h.promptGrid[1][15]).toBe(1);
    expect(h.promptGrid[5][15]).toBe(2);
    expect(h.promptsSince).toBe("2025-06-15");
  });

  it("counts coverage, including session days with no transcript", () => {
    expect(h.coverage).toEqual({
      firstDay: "2025-06-15", lastDay: "2025-06-20",
      daysTracked: 5, daysWithSessions: 4, daysWithoutTranscripts: 2,
    });
  });

  it("reads the rank the rollup persisted", () => {
    expect(h.rank?.name).toBe("Noobie");
    expect(h.rank?.nextName).toBe("Apprentice");
    expect(h.rank?.hoursToNext).toBeGreaterThan(0);
  });

  it("defaults to the last 30 days, and spans a range by calendar", () => {
    expect(h.range).toBe("30d");
    expect(h.rangeFrom).toBe("2025-05-22");
    expect(h.span).toHaveLength(30);
    const w = readHistory(db, { now: NOW, range: "7d" });
    expect(w.span).toEqual(eachDay("2025-06-14", "2025-06-20"));
    // All starts at the first rollup row, not at the epoch.
    expect(readHistory(db, { now: NOW, range: "all" }).span).toEqual(eachDay("2025-06-15", "2025-06-20"));
  });

  // Lifetime figures ignore the range: the calendar is always the whole
  // tracked span, and rank and streaks never move with the pills.
  it("keeps the calendar, rank and streaks lifetime under every range", () => {
    for (const range of ["7d", "90d", "all"] as const) {
      const r = readHistory(db, { now: NOW, range });
      expect(r.calendar).toEqual(h.calendar);
      expect(r.rank).toEqual(h.rank);
      expect(r.streaks).toEqual(h.streaks);
      expect(r.days).toEqual(h.days);
    }
  });

  describe("weekday habits", () => {
    const wd = (dow: number) => h.weekday.find((x) => x.dow === dow)!;

    it("has seven weekdays, Sunday first", () => {
      expect(h.weekday.map((x) => x.dow)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    // The mean is over days WITH A SESSION, "the days you used it" (M4): Wed
    // 06-18 is a tokens-only row -- no session, no active-time measurement --
    // so it is not averaged in as 0h, and Wednesday is null. Thu 06-19 has no
    // row at all. Planted: drop `sessions_count > 0` and Wednesday reads 0 over 1 day.
    it("averages the days with a session, and leaves a weekday with none null", () => {
      expect(wd(0)).toEqual({ dow: 0, avgActiveHours: 610 / 3600, days: 1 });
      expect(wd(2).avgActiveHours).toBe(0); // Tue: a zero-window session day is a real 0
      expect(wd(3)).toEqual({ dow: 3, avgActiveHours: null, days: 0 });
      expect(wd(4)).toEqual({ dow: 4, avgActiveHours: null, days: 0 });
      expect(wd(6)).toEqual({ dow: 6, avgActiveHours: null, days: 0 });
    });

    it("sums back to the rollup: mean x days is the range's active hours", () => {
      const total = h.weekday.reduce((a, x) => a + (x.avgActiveHours ?? 0) * x.days, 0);
      const db2 = rows<{ s: number }>(db, "SELECT SUM(active_ms) / 3600000.0 AS s FROM claude_daily_rollups WHERE day BETWEEN '2025-05-22' AND '2025-06-20';")[0].s;
      expect(total).toBeCloseTo(db2, 9);
      expect(h.weekday.reduce((a, x) => a + x.days, 0)).toBe(4); // the four session days
    });

    it("honours the range", () => {
      // 7d ending Sun 06-22 starts Mon 06-16, so Sun 06-15's row falls out.
      const later = readHistory(db, { now: NOW + 2 * DAY, range: "7d" });
      expect(later.weekday.find((x) => x.dow === 0)).toEqual({ dow: 0, avgActiveHours: null, days: 0 });
      expect(later.weekday.find((x) => x.dow === 5)!.days).toBe(1);
    });
  });

  // M14. 06-16 and 06-17 have sessions with no snapshot of their own, so
  // there is no peak to show. Since Stage 4B the rollup stores NULL there
  // itself (hygiene-rescale.test.ts pins the stored value), and the reader
  // passes it through: the page shows no value, never 0.
  it("gives peak context no value on a session day with no status-line reading", () => {
    expect(day("2025-06-15").peakContextPct).toBe(30);
    expect(day("2025-06-16").peakContextPct).toBeNull();
    expect(day("2025-06-17").peakContextPct).toBeNull();
    expect(day("2025-06-20").peakContextPct).toBe(40);
  });

  describe("average context trend", () => {
    const ctx = (day: string) => h.contextTrend.find((c) => c.day === day)!.avgContextPct;

    it("has one entry per calendar day in range", () => {
      expect(h.contextTrend.map((c) => c.day)).toEqual(h.span);
    });

    it("reads the stored average on days with a status-line snapshot", () => {
      expect(ctx("2025-06-15")).toBeCloseTo(20, 9);
      expect(ctx("2025-06-20")).toBeCloseTo(40, 9);
      expect(ctx("2025-06-18")).toBeNull(); // tokens only: no session, stored NULL
      expect(ctx("2025-06-19")).toBeNull(); // no row at all
      expect(ctx("2025-05-30")).toBeNull(); // before the first row
    });

    // GUARD 1. 06-16 and 06-17 have a rollup row and a session, but no
    // snapshot from that session. Before the Stage 3D fix wave (I5) rollup.sh
    // stored avg_context_pct = 0 there; it now stores NULL, so the rollup and
    // this reader's snapshot condition both keep the day a gap. 06-16 even has
    // a snapshot row -- from a session started the day before, the live copy's
    // 2026-09-20 case. The rollup half of the rule is planted in
    // project-rollup.test.ts ("never an unread session as 0").
    it("leaves a day with a rollup row but no snapshot of its own null, never a 0", () => {
      const stored = rows<{ day: string; c: number | null }>(db,
        "SELECT day, avg_context_pct AS c FROM claude_daily_rollups WHERE day IN ('2025-06-16', '2025-06-17') ORDER BY day;");
      expect(stored).toEqual([{ day: "2025-06-16", c: null }, { day: "2025-06-17", c: null }]);
      expect(rows<{ n: number }>(db,
        `SELECT COUNT(*) AS n FROM claude_status_snapshots WHERE date(ts, 'unixepoch', 'localtime') = '2025-06-16';`)[0].n).toBe(1);
      expect(ctx("2025-06-16")).toBeNull();
      expect(ctx("2025-06-17")).toBeNull();
    });
  });

  it("buckets prompts over the range only", () => {
    expect(readHistory(db, { now: NOW, range: "7d" }).promptsCounted).toBe(4);
    const far = readHistory(db, { now: NOW + 30 * DAY, range: "7d" });
    expect(far.promptsCounted).toBe(0);
    expect(far.promptsSince).toBe("2025-06-15"); // the hooks' install stays lifetime
    expect(readHistory(db, { now: NOW + 30 * DAY, range: "all" }).promptsCounted).toBe(4);
  });

  // Review Focus 2, the read half: a window with no rows is empty, not zero.
  it("reads a window with no rows as empty everywhere", () => {
    const far = readHistory(db, { now: NOW + 30 * DAY, range: "7d" });
    expect(far.weekday.every((x) => x.avgActiveHours === null && x.days === 0)).toBe(true);
    expect(far.contextTrend.every((c) => c.avgContextPct === null)).toBe(true);
    expect(far.days.filter((x) => x.day >= far.rangeFrom)).toEqual([]);
  });

  it("does not read a day after `now`", () => {
    const early = readHistory(db, { now: BASE + 1000 });
    expect(early.days.map((x) => x.day)).toEqual(["2025-06-15"]);
  });
});
