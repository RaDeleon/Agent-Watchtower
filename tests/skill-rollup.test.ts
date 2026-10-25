import { describe, expect, it } from "vitest";
import { roll, seedAgents, type SeedSession } from "./helpers/agent-seed";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { slow } from "./helpers/timeout";

// Stage 6: the Character page's data. Every tool's projects and models are
// sub-skills, levelled from the hours rollup.sh already measures (spec §4).
// R21: each guard's literal values live in ONE test here. Every other test over
// the same data asserts identities, so one planted defect reds one test. The
// plants, and the test each reddened, are in the stage's build logs, which
// stay local.

type Row = Record<string, unknown>;

const T = 1789466400;       // 2026-09-15T10:00:00Z
const D = 1790762400;       // 2026-09-30T10:00:00Z
const DAY = 86400;
const TODAY = { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" };

/** A driven Codex session of exactly `secs` (> 10) active seconds: a 10 s think, then work to a stop. */
const codexDay = (id: string, t: number, secs: number, cwd = "/tmp/wt-sk-one"): SeedSession => ({
  source: "codex", id, entry: "Codex Desktop", driven: 1, startedAt: t, cwd,
  events: [[t, "session_start"], [t + 10, "prompt"], [t + secs, "stop"]],
});

/** (source, day) where the model rows do not sum to the source's rollup, Claude's or the agents'. */
const modelDrift = (db: string) => rows<Row>(db, `
  WITH r AS (
    SELECT 'claude' AS source, day, active_ms AS ms FROM claude_daily_rollups WHERE active_ms > 0
    UNION ALL
    SELECT source, day, SUM(active_s) * 1000 FROM agent_daily_rollups GROUP BY source, day HAVING SUM(active_s) > 0
  ), m AS (
    SELECT source, day, SUM(active_ms) AS ms FROM skill_daily WHERE kind = 'model' GROUP BY source, day
  )
  SELECT r.source, r.day, r.ms AS rollup, m.ms AS models FROM r LEFT JOIN m USING (source, day) WHERE m.ms IS NOT r.ms
  UNION ALL
  SELECT m.source, m.day, NULL, m.ms FROM m LEFT JOIN r USING (source, day) WHERE r.ms IS NULL`);

describe("hours by driving model", () => {
  // GUARD 1 (R21). Planted: (a) `AND g.model <> '(no model)'` in
  // claude_model_rollups's HAVING; (b) book _sk_daily's agent model rows to the
  // session's start day (JOIN _ag_sess) instead of the gap's day.
  it("every skill's model rows sum to its tool's hours, every day", () => {
    const mix = buildAndRoll("model-mix");
    const Tm = T + 49800; // 2026-09-15T23:50:00Z
    seedAgents(mix, [
      { source: "codex", id: "mid", entry: "Codex Desktop", driven: 1, startedAt: Tm, cwd: "/tmp/wt-sk-one",
        events: [[Tm, "session_start"], [Tm + 60, "prompt"], [Tm + 1200, "stop"]],
        requests: [{ id: "mid-1", ts: Tm + 100, model: "gpt-5.5" }] },
      codexDay("bare", T + 2 * DAY, 90),
      { source: "hermes", id: "one", entry: "cli", driven: 1, startedAt: T, cwd: "/tmp/wt-sk-one",
        events: [[T, "session_start"], [T + 10, "prompt"], [T + 50, "stop"]],
        requests: [{ id: "one-1", ts: T, model: "hermes-x" }] },
      { source: "hermes", id: "two", entry: "cli", driven: 1, startedAt: T + DAY, cwd: "/tmp/wt-sk-one",
        events: [[T + DAY, "session_start"], [T + DAY + 10, "prompt"], [T + DAY + 70, "stop"]],
        requests: [{ id: "two-a", ts: T + DAY, model: "model-a" }, { id: "two-b", ts: T + DAY, model: "model-b" }] },
    ]);
    roll(mix);
    const excl = { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" };
    const dbs = [mix, buildAndRoll("four-projects"), buildAndRoll("crosses-midnight"),
                 buildAndRoll("mixed-projects-one-day", excl)];
    for (const db of dbs) {
      expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE kind = 'model'")[0].n).toBeGreaterThan(0);
      expect(modelDrift(db)).toEqual([]);
    }
    expect(rows(mix, "SELECT DISTINCT source FROM skill_daily WHERE kind = 'model' ORDER BY source"))
      .toEqual([{ source: "claude" }, { source: "codex" }, { source: "hermes" }]);
    expect(rows(mix, "SELECT key, active_ms FROM skill_daily WHERE source = 'claude' AND kind = 'model' AND day = '2025-06-19'"))
      .toEqual([{ key: "(no model)", active_ms: 70000 }]);
    // Four fixture builds and five rollups: ~2 s alone, measured 5.6 s under
    // the full suite's load, against vitest's 5 s default.
  }, slow(30_000));

  // GUARD 2 (R21), and spec §10's review focus 1, 2 and 4: the gap before the
  // first reply goes to the first model that answered; a request in the same
  // second as the Stop counts before it; a model that only ran as a subagent
  // has no row; of two requests in one second the greater request_id drives;
  // a <synthetic> request never drives. Planted: (a) let sidechain requests
  // drive; (b) drop the first-request fallback; and (final review M3, M4)
  // (c) the lesser request_id wins a same-second tie, (d) let <synthetic> in.
  it("credits each gap to the model you were driving", () => {
    const db = buildAndRoll("model-mix");
    expect(rows(db, "SELECT model, active_ms FROM claude_model_rollups WHERE day = '2025-06-15' ORDER BY model"))
      .toEqual([{ model: "claude-opus-5", active_ms: 150000 }, { model: "claude-sonnet-5", active_ms: 250000 }]);
  });

  // GUARD 3 (R21). 2,433 live sessions have no ingested request; their recorded
  // model names all but 2.4 h of 46.3 h. Planted: keep the "[1m]" suffix.
  it("books a session with no transcript to the model it recorded", () => {
    const db = buildAndRoll("model-mix");
    expect(rows(db, "SELECT model, active_ms FROM claude_model_rollups WHERE day = '2025-06-17'"))
      .toEqual([{ model: "claude-opus-5", active_ms: 100000 }]);
  });
});

describe("the agent skills", () => {
  // GUARD 4 (R21), and Review Focus 1: a session whose only requests are
  // reviews (34 live) books to (no model), never to the reviewer. Planted:
  // remove the codex-auto-review exclusion from _ag_evm and _ag_sfm.
  it("codex-auto-review never earns time", () => {
    const db = buildAndRoll("resumed");
    const t2 = T + 2 * DAY;
    seedAgents(db, [
      { source: "codex", id: "rv", entry: "Codex Desktop", driven: 1, startedAt: T, cwd: "/tmp/wt-sk-one",
        events: [[T, "session_start"], [T + 10, "prompt"], [T + 60, "stop"], [T + 100, "prompt"], [T + 150, "stop"]],
        requests: [{ id: "rv-1", ts: T + 30, model: "gpt-5.5" }, { id: "rv-2", ts: T + 120, model: "codex-auto-review" }] },
      { source: "codex", id: "ro", entry: "Codex Desktop", driven: 1, startedAt: t2, cwd: "/tmp/wt-sk-one",
        events: [[t2, "session_start"], [t2 + 20, "prompt"], [t2 + 80, "stop"]],
        requests: [{ id: "ro-1", ts: t2 + 40, model: "codex-auto-review" }] },
    ]);
    roll(db);
    expect(rows(db, "SELECT day, key, active_ms FROM skill_daily WHERE source = 'codex' AND kind = 'model' ORDER BY day"))
      .toEqual([
        { day: "2026-09-15", key: "gpt-5.5", active_ms: 150000 },
        { day: "2026-09-17", key: "(no model)", active_ms: 80000 },
      ]);
  });

  // GUARD I1 (R21, final review). Spec 4.3, "Codex: the same rule": each gap
  // goes to the latest non-reviewer request at or before the event that ends
  // it, and a request in the Stop's second counts as before it. The session
  // switches gpt-5.5 -> gpt-5.6-sol. Its first prompt shares session_start's
  // second, so the first-request fallback carries no time here (guard 4 holds
  // that). gpt-5.5: 60 + 40 = 100 s; gpt-5.6-sol: the 50 s that end at +150.
  // Planted: _ag_gap ignores _ag_evm, so every gap takes the first request's model.
  it("credits each Codex gap to the model you were driving", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [
      { source: "codex", id: "sw", entry: "Codex Desktop", driven: 1, startedAt: T, cwd: "/tmp/wt-sk-one",
        events: [[T, "session_start"], [T, "prompt"], [T + 60, "stop"], [T + 100, "prompt"], [T + 150, "stop"]],
        requests: [{ id: "sw-a", ts: T + 30, model: "gpt-5.5" }, { id: "sw-b", ts: T + 150, model: "gpt-5.6-sol" }] },
    ]);
    roll(db);
    expect(rows(db, "SELECT day, key, active_ms FROM skill_daily WHERE source = 'codex' AND kind = 'model' ORDER BY key"))
      .toEqual([
        { day: "2026-09-15", key: "gpt-5.5", active_ms: 100000 },
        { day: "2026-09-15", key: "gpt-5.6-sol", active_ms: 50000 },
      ]);
  });

  // GUARD 5 (R21). Hermes stores no per-call times, so a session that used two
  // models is not split by a guess. Planted: MIN(model) for the CASE.
  it("a Hermes session with several models goes to (several models)", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [
      { source: "hermes", id: "multi", entry: "cli", driven: 1, startedAt: T, cwd: "/tmp/wt-sk-one",
        events: [[T, "session_start"], [T + 10, "prompt"], [T + 70, "stop"]],
        requests: [{ id: "m-a", ts: T, model: "model-a" }, { id: "m-b", ts: T, model: "model-b" }] },
      { source: "hermes", id: "single", entry: "cli", driven: 1, startedAt: T + DAY, cwd: "/tmp/wt-sk-one",
        events: [[T + DAY, "session_start"], [T + DAY + 10, "prompt"], [T + DAY + 40, "stop"]],
        requests: [{ id: "s-a", ts: T + DAY, model: "model-a" }] },
    ]);
    roll(db);
    expect(rows(db, "SELECT day, key, active_ms FROM skill_daily WHERE source = 'hermes' AND kind = 'model' ORDER BY day"))
      .toEqual([
        { day: "2026-09-15", key: "(several models)", active_ms: 70000 },
        { day: "2026-09-16", key: "model-a", active_ms: 40000 },
      ]);
  });

  // GUARD 6 (R21). Planted: window_ms for Claude's project rows. Every project
  // row of mixed-projects-one-day has window_ms = active_ms, so the plant is
  // invisible there; session-spans-two-projects has a row where they differ.
  it("project rows equal the project rollups", () => {
    const projectDrift = (db: string) => rows<Row>(db, `
      WITH r AS (
        SELECT 'claude' AS source, project_key AS key, day, active_ms AS ms FROM claude_project_rollups WHERE active_ms > 0
        UNION ALL
        SELECT source, project_key, day, active_s * 1000 FROM agent_daily_rollups WHERE active_s > 0
      ), p AS (SELECT source, key, day, active_ms AS ms FROM skill_daily WHERE kind = 'project')
      SELECT r.*, p.ms AS skill FROM r LEFT JOIN p USING (source, key, day) WHERE p.ms IS NOT r.ms
      UNION ALL
      SELECT p.source, p.key, p.day, NULL, p.ms FROM p LEFT JOIN r USING (source, key, day) WHERE r.ms IS NULL`);
    const excl = { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" };
    const db = buildAndRoll("mixed-projects-one-day", excl);
    seedAgents(db, [codexDay("pa", T, 120, "/tmp/wt-sk-a"), codexDay("pb", T + DAY, 60, "/tmp/wt-sk-b")]);
    roll(db, excl);
    expect(projectDrift(db)).toEqual([]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE source = 'claude' AND kind = 'project' AND key = '(excluded)'"))
      .toEqual([{ n: 1 }]);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM skill_daily WHERE source = 'codex' AND kind = 'project'")[0].n)
      .toBeGreaterThan(0);
    const spans = buildAndRoll("session-spans-two-projects");
    expect(rows<{ n: number }>(spans, "SELECT COUNT(*) AS n FROM claude_project_rollups WHERE window_ms <> active_ms")[0].n)
      .toBeGreaterThan(0);
    expect(projectDrift(spans)).toEqual([]);
    // Two fixture builds and three rollups: 3.1 s under the full suite.
  }, slow(30_000));

  // GUARD 7 (R21). The tool rows are what pace, streaks and the level-up log
  // read, so they must equal the rollups per day, and their lifetime must equal
  // the level. Planted: Claude's tool rows from the project rows without
  // (excluded) -- hiding excluded time at write time.
  it("tool rows equal the rollups, and their lifetime equals agent_progress", () => {
    const excl = { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" };
    const db = buildAndRoll("mixed-projects-one-day", excl);
    seedAgents(db, [codexDay("tl", T, 200)]);
    roll(db, excl);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_project_rollups WHERE project_key = '(excluded)' AND active_ms > 0")[0].n)
      .toBeGreaterThan(0);
    const daily = rows<Row>(db, `
      WITH r AS (
        SELECT 'claude' AS source, day, active_ms AS ms FROM claude_daily_rollups WHERE active_ms > 0
        UNION ALL
        SELECT source, day, SUM(active_s) * 1000 FROM agent_daily_rollups GROUP BY source, day HAVING SUM(active_s) > 0
      ), t AS (SELECT source, day, active_ms AS ms FROM skill_daily WHERE kind = 'tool')
      SELECT r.*, t.ms AS tool FROM r LEFT JOIN t USING (source, day) WHERE t.ms IS NOT r.ms
      UNION ALL
      SELECT t.source, t.day, NULL, t.ms FROM t LEFT JOIN r USING (source, day) WHERE r.ms IS NULL`);
    expect(daily).toEqual([]);
    const cols = "source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars";
    const prog = rows(db, `SELECT ${cols} FROM skill_progress WHERE kind = 'tool' ORDER BY source`);
    expect(prog).toEqual(rows(db, `SELECT ${cols} FROM agent_progress WHERE active_s > 0 ORDER BY source`));
    expect(prog.map((p) => (p as Row).source)).toEqual(["claude", "codex"]);
    expect(rows(db, "SELECT source, SUM(active_ms) / 1000 AS active_s FROM skill_daily WHERE kind = 'tool' GROUP BY source ORDER BY source"))
      .toEqual(rows(db, "SELECT source, active_s FROM skill_progress WHERE kind = 'tool' ORDER BY source"));
    // A git-initialised fixture and two rollups: 2.1 s under the full suite.
  }, slow(30_000));

  // GUARD 8 (R21). 58 s is exactly xp(2) = 83; 268 s is exactly xp(5) = 388;
  // 797 s is exactly xp(10) = 1154, Apprentice. Planted: strict comparisons in
  // _sk_ups's band.
  it("logs the day each level was reached", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [codexDay("l1", T, 58), codexDay("l2", T + DAY, 210), codexDay("l3", T + 2 * DAY, 529)]);
    roll(db);
    expect(rows(db, `SELECT level, day, tier, tier_changed FROM skill_level_ups
                     WHERE source = 'codex' AND kind = 'tool' ORDER BY level`)).toEqual([
      { level: 2, day: "2026-09-15", tier: "Noobie", tier_changed: 0 },
      { level: 3, day: "2026-09-16", tier: "Noobie", tier_changed: 0 },
      { level: 4, day: "2026-09-16", tier: "Noobie", tier_changed: 0 },
      { level: 5, day: "2026-09-16", tier: "Noobie", tier_changed: 0 },
      { level: 6, day: "2026-09-17", tier: "Noobie", tier_changed: 0 },
      { level: 7, day: "2026-09-17", tier: "Noobie", tier_changed: 0 },
      { level: 8, day: "2026-09-17", tier: "Noobie", tier_changed: 0 },
      { level: 9, day: "2026-09-17", tier: "Noobie", tier_changed: 0 },
      { level: 10, day: "2026-09-17", tier: "Apprentice", tier_changed: 1 },
    ]);
    expect(rows(db, "SELECT level FROM skill_progress WHERE source = 'codex' AND kind = 'tool'")).toEqual([{ level: 10 }]);
    expect(rows(db, "SELECT COUNT(*) AS n FROM skill_level_ups WHERE level < 2")).toEqual([{ n: 0 }]);
  });

  // GUARD 9 (R21). Codex: 100 s today (D); 30 s at D-6 and 50 s at D-7, either
  // side of the 7-day window's edge; 200 s at D-10; 60 s at D-27 and 20 s at
  // D-28, either side of the 28-day window's edge; 1000 s at D-40. 7-day XP is
  // 130 s = 188; 28-day XP is 440 s = 637, 22.75 a calendar day; 1460 s
  // lifetime is Lv 14 (2,114 XP) with 297 XP to go: ceil(297 / 22.75) = 14
  // days, and 99 in ceil(13,032,317 / 22.75) = 572,850. Hermes: only forty days
  // ago, so no pace and no ETAs. Planted: divide by active days; and (final
  // review M2) the 7-day window from D-3 or from D-7, the 28-day window from
  // D-26 or from D-28.
  it("paces XP per calendar day", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [
      codexDay("p0", D, 100), codexDay("p6", D - 6 * DAY, 30), codexDay("p7", D - 7 * DAY, 50),
      codexDay("p10", D - 10 * DAY, 200), codexDay("p27", D - 27 * DAY, 60), codexDay("p28", D - 28 * DAY, 20),
      codexDay("p40", D - 40 * DAY, 1000),
      { source: "hermes", id: "h40", entry: "cli", driven: 1, startedAt: D - 40 * DAY, cwd: "/tmp/wt-sk-one",
        events: [[D - 40 * DAY, "session_start"], [D - 40 * DAY + 10, "prompt"], [D - 40 * DAY + 300, "stop"]] },
    ]);
    roll(db, TODAY);
    const cols = "source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_day, eta_next_days, eta_99_days";
    expect(rows(db, `SELECT ${cols} FROM skill_pace WHERE source <> 'claude' ORDER BY source`)).toEqual([
      { source: "all", as_of_day: "2026-09-30", xp_today: 144, xp_7d: 188, xp_28d: 637, pace_xp_per_day: 22.75, eta_next_days: null, eta_99_days: null },
      { source: "codex", as_of_day: "2026-09-30", xp_today: 144, xp_7d: 188, xp_28d: 637, pace_xp_per_day: 22.75, eta_next_days: 14, eta_99_days: 572850 },
      { source: "hermes", as_of_day: "2026-09-30", xp_today: 0, xp_7d: 0, xp_28d: 0, pace_xp_per_day: 0, eta_next_days: null, eta_99_days: null },
    ]);
  });

  // GUARD 10 (R21). Codex active the three days before today and two more
  // before that: its run ends yesterday and survives a today with no activity
  // yet. Hermes today, after an idle yesterday broke its two-day run, so it is
  // at 1 with a best of 2; 'all' runs from today back to D-3. Claude one day in
  // 2025 (the resumed fixture), a best run that is long over. Then, as of two
  // days later, every run ends the day before yesterday, so every streak is 0.
  // Planted: drop the yesterday fallback; and (final review I2) drop the
  // as-of-day branch.
  it("a streak runs to today, or survives a today with no activity yet", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [
      ...[1, 2, 3, 6, 7].map((n) => codexDay(`s${n}`, D - n * DAY, 60)),
      ...[0, 2, 3].map((n): SeedSession => ({ source: "hermes", id: `h${n}`, entry: "cli", driven: 1, startedAt: D - n * DAY,
        cwd: "/tmp/wt-sk-one", events: [[D - n * DAY, "session_start"], [D - n * DAY + 10, "prompt"], [D - n * DAY + 60, "stop"]] })),
    ]);
    const streaks = "SELECT source, streak_current, streak_best FROM skill_pace ORDER BY source";
    roll(db, TODAY);
    expect(rows(db, streaks)).toEqual([
      { source: "all", streak_current: 4, streak_best: 4 },
      { source: "claude", streak_current: 0, streak_best: 1 },
      { source: "codex", streak_current: 3, streak_best: 3 },
      { source: "hermes", streak_current: 1, streak_best: 2 },
    ]);
    roll(db, { WATCHTOWER_ROLLUP_TODAY: "2026-10-02" });
    expect(rows(db, streaks)).toEqual([
      { source: "all", streak_current: 0, streak_best: 4 },
      { source: "claude", streak_current: 0, streak_best: 1 },
      { source: "codex", streak_current: 0, streak_best: 3 },
      { source: "hermes", streak_current: 0, streak_best: 2 },
    ]);
  });

  // Review Focus 2. Days after the as-of day count in no window and no run.
  // Asserts neither streak_current (guard 10's) nor the pace (guard 9's).
  it("ignores activity dated after the as-of day", () => {
    const db = buildAndRoll("resumed");
    seedAgents(db, [codexDay("y", D - DAY, 60), codexDay("f1", D + DAY, 60), codexDay("f2", D + 2 * DAY, 60)]);
    roll(db, TODAY);
    expect(rows(db, "SELECT xp_today, xp_7d, xp_28d, streak_best FROM skill_pace WHERE source = 'codex'"))
      .toEqual([{ xp_today: 0, xp_7d: 86, xp_28d: 86, streak_best: 1 }]);
  });
});
