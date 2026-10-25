import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db.ts";
import { DISCIPLINE_ORDER, readProfile } from "@/lib/read/profile.ts";

process.env.TZ = "UTC";

/** Noon UTC on `day`: safely inside the local day under the pinned TZ. */
const noon = (day: string) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);

interface RawProfileRow {
  day: string;
  window_requests: number;
  tool_covered: number;
  total: number | null;
  measured: number | null;
  tier_index: number | null;
  tier_points_to_next: number | null;
  total_wow: number | null;
  matrix_score: number | null;
  matrix_tier: number | null;
  matrix_points_to_next: number | null;
  f_context: number | null;
  f_compaction: number | null;
  f_session_length: number | null;
  f_efficiency: number | null;
  median_ctx: number | null;
  median_requests: number | null;
  long_sessions: number | null;
  long_with_reset: number | null;
  cache_fresh_ratio: number | null;
  matrix_7d: number | null;
  matrix_wow: number | null;
}

interface RawDisciplineRow {
  discipline: string;
  score: number;
  status: string;
  definition: string;
  evidence_json: string;
}

describe("readProfile: latest day and disciplines", () => {
  it("latest equals the last day, and disciplines come in id order with parsed evidence", () => {
    const db = buildAndRoll("profile-basic");
    const raw = rows<RawProfileRow>(db, `SELECT * FROM claude_profile_daily WHERE day = '2026-09-10';`)[0];
    expect(raw).toBeTruthy();
    const rawDisc = rows<RawDisciplineRow>(db, `SELECT * FROM claude_discipline_scores WHERE day = '2026-09-10';`);
    expect(rawDisc.length).toBe(10); // profile-basic measures every discipline

    const data = readProfile(db, { now: noon("2026-09-10") });

    expect(data.latest?.day).toBe("2026-09-10");
    expect(data.latest?.windowRequests).toBe(raw.window_requests);
    expect(data.latest?.toolCovered).toBe(raw.tool_covered === 1);
    expect(data.latest?.total).toBe(raw.total);
    expect(data.latest?.measured).toBe(raw.measured);
    expect(data.latest?.tierIndex).toBe(raw.tier_index);
    expect(data.latest?.tierPointsToNext).toBe(raw.tier_points_to_next);
    expect(data.latest?.totalWow).toBe(raw.total_wow);
    expect(data.latest?.matrixScore).toBe(raw.matrix_score);
    expect(data.latest?.matrixTier).toBe(raw.matrix_tier);
    expect(data.latest?.matrixPointsToNext).toBe(raw.matrix_points_to_next);
    expect(data.latest?.factors).toEqual({
      context: raw.f_context,
      compaction: raw.f_compaction,
      sessionLength: raw.f_session_length,
      efficiency: raw.f_efficiency,
    });
    expect(data.latest?.inputs).toEqual({
      medianCtx: raw.median_ctx,
      medianRequests: raw.median_requests,
      longSessions: raw.long_sessions,
      longWithReset: raw.long_with_reset,
      cacheFreshRatio: raw.cache_fresh_ratio,
    });
    expect(data.latest?.matrixWow).toBe(raw.matrix_wow);
    // Read, never computed: the Matrix card labels its week over week with it.
    expect(raw.matrix_7d).toBe(67);
    expect(data.latest?.matrix7d).toBe(raw.matrix_7d);

    expect(data.disciplines.map((d) => d.id)).toEqual(DISCIPLINE_ORDER);
    for (const d of data.disciplines) {
      const r = rawDisc.find((x) => x.discipline === d.id);
      expect(r).toBeTruthy();
      expect(d.score).toBe(r!.score);
      expect(d.status).toBe(r!.status);
      expect(d.definition).toBe(r!.definition);
      expect(d.evidence).toEqual(JSON.parse(r!.evidence_json));
    }
    // A concrete evidence check, not just a round trip: the exact numbers Task
    // 3's hand arithmetic pins for verification (spec's own worked example).
    const verification = data.disciplines.find((d) => d.id === "verification")!;
    expect(verification.evidence).toEqual({ tool_calls: 20, inspect_share: 0.4, tool_error_rate: 0.15 });
  });

  it("on a gated latest day, disciplines is [] and every ProfileDay score is null", () => {
    const db = buildAndRoll("profile-gate");
    const raw = rows<RawProfileRow>(db, `SELECT * FROM claude_profile_daily WHERE day = '2026-09-10';`)[0];
    expect(raw.window_requests).toBe(19);
    expect(rows(db, "SELECT * FROM claude_discipline_scores;")).toEqual([]);

    const data = readProfile(db, { now: noon("2026-09-10") });

    expect(data.latest?.day).toBe("2026-09-10");
    expect(data.latest?.windowRequests).toBe(19);
    expect(data.latest?.total).toBeNull();
    expect(data.latest?.measured).toBeNull();
    expect(data.latest?.tierIndex).toBeNull();
    expect(data.latest?.tierPointsToNext).toBeNull();
    expect(data.latest?.totalWow).toBeNull();
    expect(data.latest?.matrixScore).toBeNull();
    expect(data.latest?.matrixTier).toBeNull();
    expect(data.latest?.matrixPointsToNext).toBeNull();
    expect(data.latest?.factors).toEqual({ context: null, compaction: null, sessionLength: null, efficiency: null });
    expect(data.disciplines).toEqual([]);
  });

  it("with no claude_profile_daily row at all, latest is null and disciplines is []", () => {
    const db = buildAndRoll("profile-basic");
    // A day before the tracker's first row.
    const data = readProfile(db, { now: noon("2026-09-05") });
    expect(data.latest).toBeNull();
    expect(data.disciplines).toEqual([]);
  });
});

describe("readProfile: history and coverage", () => {
  it("history covers the range: a defined total on an idle-but-ungated day, null before the first row", () => {
    const db = buildAndRoll("profile-basic");
    // "today" = 2026-09-12 makes the 7d range 2026-09-06..2026-09-12: two days
    // after the 2026-09-10 burst (idle, but the window still holds 20
    // requests -- ungated) and four days with no row at all (before the
    // tracker's first day).
    const data = readProfile(db, { now: noon("2026-09-12"), range: "7d" });
    expect(data.history.map((h) => h.day)).toEqual([
      "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12",
    ]);
    for (const day of ["2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"]) {
      expect(data.history.find((h) => h.day === day)!.total).toBeNull();
    }
    // 09-10 (the burst) and 09-11/09-12 (idle, window still >= 20) all score.
    const burstTotal = rows<{ total: number }>(db, `SELECT total FROM claude_profile_daily WHERE day = '2026-09-10';`)[0].total;
    for (const day of ["2026-09-10", "2026-09-11", "2026-09-12"]) {
      const total = data.history.find((h) => h.day === day)!.total;
      expect(total).not.toBeNull();
      expect(total).toBe(burstTotal); // no new requests after 09-10: the window is unchanged
    }
  });

  it("history covers the range with null on a permanently gated day", () => {
    const db = buildAndRoll("profile-gate");
    const data = readProfile(db, { now: noon("2026-09-15"), range: "7d" });
    expect(data.history).toHaveLength(7);
    expect(data.history.every((h) => h.total === null)).toBe(true);
  });

  it("coverageStart is the local day of MIN(ts) over main-thread tool calls", () => {
    const db = buildAndRoll("profile-basic");
    const data = readProfile(db, { now: noon("2026-09-10") });
    // profile-basic's coverage anchor tool call is on 2026-08-01.
    expect(data.coverageStart).toBe("2026-08-01");
  });

  it("coverageStart is null with no tool rows at all", () => {
    const db = buildAndRoll("profile-ladder");
    expect(rows(db, "SELECT * FROM claude_tool_calls;")).toEqual([]);
    const data = readProfile(db, { now: noon("2026-09-08") });
    expect(data.coverageStart).toBeNull();
  });

  // Stage 4B spec 4.5. Hook data starts 2026-08-20; W(09-17) starts 08-19
  // (not covered), W(09-18) starts 08-20 (covered). The reader passes the
  // rollup's flag through for the latest day and labels when hooks began.
  it("eventCovered is the latest day's stored flag, eventStart the local day of the first hook event", () => {
    const db = buildAndRoll("profile-event-edge");
    const before = readProfile(db, { now: noon("2026-09-17") });
    expect(before.latest?.day).toBe("2026-09-17");
    expect(before.eventCovered).toBe(false);
    expect(before.eventStart).toBe("2026-08-20");
    const after = readProfile(db, { now: noon("2026-09-18") });
    expect(after.eventCovered).toBe(true);
    expect(after.eventStart).toBe("2026-08-20");
  });

  it("eventStart is null and nothing is event-covered with no hook events at all", () => {
    const db = buildAndRoll("profile-gate");
    expect(rows(db, "SELECT * FROM claude_events;")).toEqual([]);
    const data = readProfile(db, { now: noon("2026-09-10") });
    expect(data.eventStart).toBeNull();
    expect(data.eventCovered).toBe(false);
  });
});
