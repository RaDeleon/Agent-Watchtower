import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rows } from "./helpers/fixture-db";

const ROOT = path.resolve(__dirname, "..");
const MAKE = path.join(ROOT, "tests", "fixtures", "make-fixture.sh");
const ROLLUP = path.join(ROOT, "capture", "rollup.sh");
const LIB = path.join(ROOT, "capture", "lib.sh");

/** Build a fixture DB for a scenario, run the rollup over it, return the DB path. */
function buildAndRoll(scenario: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `wt-${scenario}-`));
  const db = path.join(dir, "fixture.sqlite");
  execFileSync("bash", [MAKE, scenario, db], { encoding: "utf8" });
  execFileSync("bash", [ROLLUP, "--quiet"], {
    // TZ is pinned because the rollup buckets sessions by LOCAL day. Without it
    // the two-sessions-one-day scenario would split across two rows in any zone
    // where the fixture's fixed epoch straddles midnight, and the test would
    // pass or fail depending on where it ran.
    env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB, TZ: "UTC" },
    encoding: "utf8",
  });
  return db;
}

/**
 * Sum a column across EVERY claude_daily_rollups row, in seconds.
 *
 * Deliberately unscoped, which is correct only for a fixture whose rows all
 * belong to one day — true of every scenario that uses it. A fixture spanning
 * days must assert with perDay() instead: summed, a rule about WHICH day gets
 * the seconds cannot fail here, because both answers total the same.
 */
function seconds(db: string, column: "active_ms" | "total_session_ms"): number {
  return sumOf(db, column) / 1000;
}

interface DayRow { day: string; active_s: number; window_s: number; sessions: number }

/** Every day row the rebuild produced, oldest first, in seconds. */
function perDay(db: string): DayRow[] {
  const out = execFileSync(
    "sqlite3",
    ["-json", db, `SELECT day,
        active_ms / 1000.0        AS active_s,
        total_session_ms / 1000.0 AS window_s,
        sessions_count            AS sessions
      FROM claude_daily_rollups ORDER BY day;`],
    { encoding: "utf8" },
  );
  return out.trim() === "" ? [] : (JSON.parse(out) as DayRow[]);
}

/** Sum any numeric column across every claude_daily_rollups row. */
function sumOf(db: string, column: string): number {
  const out = execFileSync(
    "sqlite3",
    [db, `SELECT COALESCE(SUM(${column}),0) FROM claude_daily_rollups;`],
    { encoding: "utf8" },
  );
  return Number(out.trim());
}

/** How many day rows the rebuild produced. */
function days(db: string): number {
  const out = execFileSync("sqlite3", [db, "SELECT COUNT(*) FROM claude_daily_rollups;"], {
    encoding: "utf8",
  });
  return Number(out.trim());
}

describe("activity model rev 3 — regressions of real bugs", () => {
  describe("a resumed session must not book its dormant weeks", () => {
    let db: string;
    beforeAll(() => { db = buildAndRoll("resumed"); });

    it("books minutes, not 30 days", () => {
      // Naive ended_at - started_at would be 2,592,600s. Real span is 120s:
      // 2s to the first prompt + 118s of work. The second sitting contributes
      // nothing -- its gap ends at SessionEnd, which counts 0 since 2026-09-08.
      // Floor too: a broken window_s join returning 0 must not look like a pass.
      expect(seconds(db, "total_session_ms")).toBeGreaterThanOrEqual(120);
      expect(seconds(db, "total_session_ms")).toBeLessThan(200);
    });

    it("counts the real turn as active", () => {
      // UserPromptSubmit(+2) -> Stop(+120) = 118s of work.
      expect(seconds(db, "active_ms")).toBeGreaterThanOrEqual(118);
      expect(seconds(db, "active_ms")).toBeLessThan(600);
    });
  });

  describe("a missing Stop must not turn a walk-away into task time", () => {
    let db: string;
    beforeAll(() => { db = buildAndRoll("missing-stop"); });

    it("caps the 3-hour gap at the 5-minute think cap", () => {
      // The gap ENDS at UserPromptSubmit, so it is think time: 300s, not 10800s.
      // Total is 370: 10s (SessionStart->UserPromptSubmit) + 300 (the capped
      // walk-away) + 60 (UserPromptSubmit->Stop). Pinned to a 30s band, not a
      // loose "< 700": at 700 the cap could be doubled to 600 on this very
      // branch and the whole suite would stay green, which is how the rule the
      // spec calls load-bearing became invisible.
      expect(seconds(db, "active_ms")).toBeGreaterThanOrEqual(370);
      expect(seconds(db, "active_ms")).toBeLessThan(400);
    });
  });

  describe("a long autonomous run must be counted in full", () => {
    let db: string;
    beforeAll(() => { db = buildAndRoll("long-run"); });

    it("counts all 20 minutes, not zero", () => {
      // The old gap<=600 rule scored this 0. Work time is 1200s.
      // Ceiling too: a model that wildly overcounts must not look like a pass.
      expect(seconds(db, "active_ms")).toBeGreaterThanOrEqual(1200);
      expect(seconds(db, "active_ms")).toBeLessThan(1300);
    });
  });

  // Regression: _snap joined claude_status_snapshots to MAX(ts) GROUP BY
  // session_id, so two snapshots sharing (session_id, max ts) yielded two _snap
  // rows; _sx fans out on them and the session was counted TWICE in every daily
  // aggregate. Nothing in the schema forbids the duplicate — only snapshot.sh's
  // 60s throttle does, and that throttle stops working the moment its marker
  // file cannot be written.
  describe("a duplicate status snapshot must not double the session", () => {
    let db: string;
    beforeAll(() => { db = buildAndRoll("dup-snapshot"); });

    it("counts the session exactly once", () => {
      expect(sumOf(db, "sessions_count")).toBe(1);
    });

    it("does not double active or window seconds", () => {
      // The fanned-out shape scored 2420 / 2440 here.
      expect(seconds(db, "active_ms")).toBe(1210);
      expect(seconds(db, "total_session_ms")).toBe(1210);
    });

    it("takes cost from the latest snapshot, not the sum of both", () => {
      // The two rows hold 1/2/0.5 and 100/200/1.5 at the SAME ts. Summing them
      // gives 3.0; picking the earlier one gives 0.5.
      expect(sumOf(db, "cost_usd")).toBeCloseTo(1.5, 6);
    });

    it("takes tokens from claude_requests, not from either snapshot", () => {
      // Since Stage 2 the token columns come from claude_requests, whose counts
      // are exact; the status line reports a CONTEXT WINDOW snapshot, wrong by
      // 63x on input and 201x on output. The fixture's one request holds 7/333,
      // matching neither snapshot (2, 200) nor their sum (202).
      expect(sumOf(db, "tokens_in")).toBe(7);
      expect(sumOf(db, "tokens_out")).toBe(333);
    });
  });

  // Structural gap this closes: every other fixture has exactly one session, so
  // a doubled session row and a correct one are indistinguishable in a SUM.
  describe("two sessions on one day must sum, not double", () => {
    let db: string;
    beforeAll(() => { db = buildAndRoll("two-sessions-day"); });

    it("puts both sessions on a single day row", () => {
      expect(days(db)).toBe(1);
      expect(sumOf(db, "sessions_count")).toBe(2);
    });

    it("sums the two sessions' seconds", () => {
      expect(seconds(db, "active_ms")).toBe(1210 + 610);
      expect(seconds(db, "total_session_ms")).toBe(1210 + 610);
    });

    it("sums tokens and cost across both sessions", () => {
      // Tokens come from claude_requests (one per session, 1000 and 2000 out),
      // cost still from the status snapshots. Snapshot tokens are 100+50 /
      // 200+60 and must NOT appear.
      expect(sumOf(db, "tokens_in")).toBe(7 + 7);
      expect(sumOf(db, "tokens_out")).toBe(1000 + 2000);
      expect(sumOf(db, "cost_usd")).toBeCloseTo(2.0, 6);
    });
  });

  // rollup.sh has attributed a session to its (local) START day since rev 3 and
  // says so in a comment, but nothing held the rule in place. 100 sessions in
  // the live DB start before midnight and end after it, and every daily chart
  // inherits the answer, so a silent change here would quietly move real hours
  // between days. The fixture runs 23:50 -> 00:20 with 1200 of its 1210 seconds
  // elapsing AFTER midnight, so start-day and end-day attribution differ by the
  // whole session — summed totals alone could not tell them apart.
  describe("a session crossing midnight books entirely to its start day", () => {
    let db: string;
    beforeAll(() => { db = buildAndRoll("crosses-midnight"); });

    it("produces a single day row, dated the start day", () => {
      expect(perDay(db).map((r) => r.day)).toEqual(["2025-06-15"]);
    });

    it("books the post-midnight seconds to the start day, not the end day", () => {
      const [row] = perDay(db);
      expect(row.active_s).toBe(1210);
      expect(row.window_s).toBe(1210);
      expect(row.sessions).toBe(1);
    });
  });

  describe("a runaway WORK gap must hit the sanity cap", () => {
    let db: string;
    beforeAll(() => { db = buildAndRoll("work-cap"); });

    it("caps at 14400s instead of booking the full 20000s", () => {
      // UserPromptSubmit(+10) think-capped to 10, then a 20000s WORK gap
      // capped to 14400. Uncapped this would be 20010.
      expect(seconds(db, "active_ms")).toBeGreaterThanOrEqual(14400);
      expect(seconds(db, "active_ms")).toBeLessThan(15000);
    });
  });
});

describe("token correction does not move the activity model", () => {
  it("leaves active, window and idle untouched when requests are added", () => {
    const withReq = buildAndRoll("orphan-request-tokens");
    const t = rows<{ a: number; w: number; i: number }>(withReq,
      "SELECT SUM(active_ms) a, SUM(total_session_ms) w, SUM(idle_ms) i FROM claude_daily_rollups;");
    // MEASURED against the real rollup on 2026-09-11, not derived on paper.
    // The EVENT stream is 0 (SessionStart), 600 (Stop), 900 (SessionEnd) -- the
    // snapshot at 300 and the two requests at 600/700 are not events and move
    // nothing. Two gaps of 300s and 600s: the 600s gap ends at Stop with no turn
    // in flight, so it is think time, capped at 300 active against 600 of
    // window; the gap ending at SessionEnd counts zero toward BOTH per the
    // standing decision. Idle is the 300s difference.
    // If these numbers move, the activity model moved -- which this stage
    // must not do. Do not "fix" them to match new output; find what changed.
    expect(Number(t[0].a)).toBe(300_000);
    expect(Number(t[0].w)).toBe(600_000);
    expect(Number(t[0].i)).toBe(300_000);
  });

  // A day with sessions and events but NO transcript left to ingest reports 0
  // tokens, correctly -- "no data" beats "wrong data". What must not follow is
  // hygiene punishing it for that. 21 of 68 real days have this shape (338
  // sessions, 41.0 active hours, 2026-07-17..2026-09-01): they averaged 57.76
  // against 80.9 on covered days, a 23-point penalty for ABSENT DATA rather
  // than bad practice, and AVG(NULLIF(hygiene_score,0)) -- which excludes only
  // days scoring EXACTLY 0 -- then dragged lifetime hygiene 80.9 -> 73.855.
  //
  // Both fixture days are identical in every event-derived respect: 10s think +
  // 600s work, no idle, 10% peak context, no compacts or clears. So the three
  // EVENT-derived terms are 30 + 18 + 20 = 68 on both days, and the ONLY
  // difference is whether a request exists to measure a cache hit rate from.
  describe("a day with sessions but no transcript coverage", () => {
    const TERMS3 = 30 + 18 + 20;           // context + compact-vs-clear + focus/idle
    const COVERED = 90.5;                  // 22.5 cache (90% hit rate) + 68
    const BARE = (TERMS3 * 100) / 75;      // 90.666… — the same 68, rescaled
    let db: string;
    beforeAll(() => { db = buildAndRoll("partial-transcript-coverage"); });

    const day = (d: string) => rows<{ cache_hit_percentage: number | null; hygiene_score: number }>(
      db, `SELECT cache_hit_percentage, hygiene_score FROM claude_daily_rollups WHERE day = '${d}';`)[0];

    it("reports NULL cache_hit_percentage rather than a fabricated 0%", () => {
      // Same error class as the NULL context percentages: a hit RATE over zero
      // cache traffic is not 0%, it is unmeasured.
      expect(day("2025-06-16").cache_hit_percentage).toBeNull();
      // ...and a day that does have traffic still reports the real rate, so
      // this is not passing because the column stopped being written.
      expect(day("2025-06-15").cache_hit_percentage).toBe(90);
    });

    it("scores it from the three event-derived terms, rescaled to 100", () => {
      // The other three terms come from EVENTS, which this day has, so they are
      // genuinely measured and must not be discarded -- only the cache term is
      // missing. 68 of a possible 75, rescaled, is 90.67; the fabricated-zero
      // form scored the identical behaviour 68.
      expect(Number(day("2025-06-16").hygiene_score)).toBeCloseTo(BARE, 10);
      expect(Number(day("2025-06-16").hygiene_score)).toBeGreaterThan(90);
    });

    it("leaves a day WITH cache traffic scoring exactly what it always did", () => {
      // Measured before the change: 90.5.
      //
      // NOTE on what this does and does not prove. It pins the VALUE, and that
      // is all. It is not evidence for the separate-gated-UPDATE structure:
      // 22.5 + 30 + 18 + 20 are all exactly representable in binary and sum
      // identically under any association, so this fixture would pass against a
      // folded-in factor too. The structure is justified on its own terms --
      // floating-point addition is not associative, and re-associating the main
      // expression can move a normal day's score by an ULP for term values that
      // are not exactly representable. Don't cite this assertion for it.
      expect(Number(day("2025-06-15").hygiene_score)).toBe(COVERED);
    });

    it("no longer drags the lifetime hygiene average", () => {
      const rank = rows<{ h: number }>(db, "SELECT hygiene_score h FROM claude_rank_progress;");
      expect(Number(rank[0].h)).toBeCloseTo((COVERED + BARE) / 2, 6);
      // Before the fix the coverage-less day scored 68 and this read 79.25.
      expect(Number(rank[0].h)).toBeGreaterThan(90);
    });
  });

  // The rescale divides by the maximum the day COULD ATTAIN, which is not always
  // 75. The focus/idle term is a FLAT 10.0 when total_session_ms = 0 rather than
  // a 0-20 range, so such a day tops out at 30 + 25 + 10 = 65; dividing it by 75
  // normalises against a maximum it cannot reach -- the same error the rescale
  // exists to remove, one level down. 9 of 69 real days are that shape
  // (2026-07-11 with 135 sessions, 2026-07-17 with 201, and seven more).
  //
  // Both fixture days are UNCOVERED and differ ONLY in whether the window
  // collapsed, and they are rolled up in the SAME run -- so this also pins that
  // the denominator is computed PER DAY rather than once for the rebuild.
  //
  // Both days carry a real context reading (10%, the flat 30): this is the
  // cache rescale, spec 4B §4.4's second row. Without a snapshot the context
  // term is dropped as well (45 / 35: zero-window-no-coverage, and
  // hygiene-rescale.test.ts) -- this fixture used to lean on the fabricated 0
  // peak that Stage 4B removed.
  describe("the rescale denominator is the maximum the day could attain", () => {
    const WINDOWED = ((30 + 18 + 20) * 100) / 75;   // 68 of 75 -> 90.666…
    const COLLAPSED = ((30 + 18 + 10) * 100) / 65;  // 58 of 65 -> 89.230…
    let db: string;
    beforeAll(() => { db = buildAndRoll("zero-window-context-read"); });

    const day = (d: string) => rows<{ total_session_ms: number; peak_context_pct: number | null; hygiene_score: number }>(
      db, `SELECT total_session_ms, peak_context_pct, hygiene_score FROM claude_daily_rollups WHERE day = '${d}';`)[0];

    it("uses 65 on a day whose window collapsed to zero", () => {
      // The premises, asserted rather than assumed: a zero window, and a context reading.
      expect(Number(day("2025-06-16").total_session_ms)).toBe(0);
      expect(day("2025-06-16").peak_context_pct).toBe(10);
      expect(Number(day("2025-06-16").hygiene_score)).toBeCloseTo(COLLAPSED, 10);
      // Against a fixed 75 this day scored 77.333333333333329 -- the exact
      // figure the 9 real days carried. Pinned explicitly so a regression to a
      // constant denominator cannot pass by being merely close.
      expect(Number(day("2025-06-16").hygiene_score)).not.toBeCloseTo(((30 + 18 + 10) * 100) / 75, 6);
    });

    it("still uses 75 on a day with a real window", () => {
      expect(Number(day("2025-06-15").total_session_ms)).toBeGreaterThan(0);
      expect(day("2025-06-15").peak_context_pct).toBe(10);
      expect(Number(day("2025-06-15").hygiene_score)).toBeCloseTo(WINDOWED, 10);
    });
  });

  it("excludes session-less days from the lifetime hygiene average", () => {
    const db = buildAndRoll("tokens-only-day");
    const lifetime = rows<{ h: number }>(db, "SELECT hygiene_score h FROM claude_rank_progress;");
    const withSessions = rows<{ h: number }>(db,
      "SELECT AVG(NULLIF(hygiene_score,0)) h FROM claude_daily_rollups WHERE sessions_count > 0;");
    expect(Number(lifetime[0].h)).toBeCloseTo(Number(withSessions[0].h), 6);
  });
});
