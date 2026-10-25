import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db.ts";
import { collapseEvents, readLive, TICKER_LIMIT } from "@/lib/read/live";
import { readLevel } from "@/lib/read/level";
import { renderLivePanel } from "@/lib/render/live";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The fixture's rollup runs with TZ=UTC, and `today` buckets by LOCAL day, so
// the reader's sqlite3 child has to agree with it. Set on the worker's env,
// which is what child processes inherit.
process.env.TZ = "UTC";

/** make-fixture.sh's fixed epoch, and the instant the `live` scenario is built around. */
const BASE = 1750000000;
const NOW = BASE + 400;

describe("readLive", () => {
  const db = buildAndRoll("live");

  describe("rate limits", () => {
    // 74.6% of real snapshots carry a 5h reading, so the newest snapshot is
    // often not the newest READING. The fixture's last snapshot is NULL and the
    // one before it is 108%.
    it("takes the most recent non-NULL reading, not the most recent snapshot", () => {
      const d = readLive(db, { now: NOW });
      expect(d.rateLimits.fiveHour.pct).toBe(108);
      expect(d.rateLimits.fiveHour.ts).toBe(BASE + 60);
    });

    // Killing mutation: `MIN(pct, 100)` anywhere on this path. 108% is real
    // data — the measured all-time peak — and clamping hides exactly the moment
    // the gauge exists to show.
    it("does not clamp a reading above 100%", () => {
      expect(readLive(db, { now: NOW }).rateLimits.fiveHour.pct).toBeGreaterThan(100);
    });

    // Killing mutation: COALESCE(pct, 0). A 0% gauge is a lie that reads as
    // good news; an absent reading has to stay absent.
    it("reports a column with no readings at all as null, never 0", () => {
      const d = readLive(db, { now: NOW });
      expect(d.rateLimits.sevenDay.pct).toBeNull();
      expect(d.rateLimits.sevenDay.ts).toBeNull();
    });
  });

  describe("current session", () => {
    it("reads cost as MAX per session, not SUM across snapshots", () => {
      // The three snapshots carry a GROWING cumulative cost: 1.0, 2.0, 3.0.
      // SUM gives 6.0 — the 281.7x bug class in miniature.
      expect(rows<{ s: number }>(db, "SELECT SUM(total_cost_usd) AS s FROM claude_status_snapshots;")[0].s)
        .toBe(6);
      expect(readLive(db, { now: NOW }).session?.costUsd).toBe(3);
    });

    // A session_id survives --resume, so claude_sessions.started_at spans every
    // dormant gap. The current launch is the latest SessionStart EVENT.
    it("dates the session from the latest SessionStart event", () => {
      const s = readLive(db, { now: NOW }).session;
      expect(s?.sessionId).toBe("S_LIVE");
      expect(s?.startedAt).toBe(BASE);
      expect(s?.elapsedSeconds).toBe(400);
      expect(s?.active).toBe(true);
    });

    it("carries the newest context reading", () => {
      expect(readLive(db, { now: NOW }).session?.contextPct).toBe(42.5);
    });
  });

  describe("burn rate", () => {
    // Requests sit at +50 (outside), +200 and +350 (inside the 300s window
    // ending at +400): 1200 + 800 = 2000 output tokens over 5 minutes.
    it("counts only requests inside the five-minute window", () => {
      const b = readLive(db, { now: NOW }).burnRate;
      expect(b.requests).toBe(2);
      expect(b.tokensOut).toBe(2000);
      expect(b.tokensPerMin).toBe(400);
      expect(b.windowSeconds).toBe(300);
      // The sparkline's slices partition the same window: +200 lands in the
      // 4th 30s slice after +100, +350 in the 9th.
      expect(b.buckets).toEqual([0, 0, 0, 1200, 0, 0, 0, 0, 800, 0]);
    });

    // Idle is not zero throughput, and 0 tok/min would read as a measurement.
    it("reports null, not 0, when nothing landed in the window", () => {
      const b = readLive(db, { now: BASE + 100_000 }).burnRate;
      expect(b.requests).toBe(0);
      expect(b.tokensPerMin).toBeNull();
    });
  });

  // Spec §6: a date with no rollup row is a gap, not 0 -- the same rule as
  // History's M1. The `history` fixture has rows for 06-15..18 and 06-20, so
  // 06-19 is a gap inside the week and 06-14 predates the data.
  // Killing mutation: COALESCE the missing day to 0.
  describe("this week", () => {
    const hist = buildAndRoll("history");
    const FRI = BASE + 5 * 86400 + 1000; // Friday 2025-06-20
    const w = readLive(hist, { now: FRI }).week;

    it("is exactly the last 7 calendar days, oldest first, ending today", () => {
      expect(w.map((d) => d.day)).toEqual([
        "2025-06-14", "2025-06-15", "2025-06-16", "2025-06-17", "2025-06-18", "2025-06-19", "2025-06-20",
      ]);
    });

    it("reports a day with no rollup row as null, never 0", () => {
      expect(w.find((d) => d.day === "2025-06-19")!.activeHours).toBeNull();
      expect(w.find((d) => d.day === "2025-06-14")!.activeHours).toBeNull();
      expect(w.find((d) => d.day === "2025-06-15")!.activeHours).toBeCloseTo(610 / 3600, 9);
    });

    // Reconciliation: the week's hours are the rollup's own, day for day.
    it("sums to the rollup over the same seven days", () => {
      const sum = w.reduce((a, d) => a + (d.activeHours ?? 0), 0);
      const db = rows<{ s: number }>(hist,
        "SELECT SUM(active_ms) / 3600000.0 AS s FROM claude_daily_rollups WHERE day BETWEEN '2025-06-14' AND '2025-06-20';")[0].s;
      expect(sum).toBeCloseTo(db, 9);
    });

    it("carries Claude Code's level and the current streak", () => {
      const d = readLive(hist, { now: FRI });
      expect(d.level).toEqual(readLevel(hist, "claude"));
      expect(d.level.state).not.toBe("pending");
      expect(d.streak).toBe(1);
    });
  });

  it("reads today's row, newest events first", () => {
    const d = readLive(db, { now: NOW });
    expect(d.today.sessions).toBe(1);
    expect(d.today.activeHours).toBeGreaterThan(0);
    expect(d.today.costUsd).not.toBeNull();
    expect(d.events.map((e) => e.name)).toEqual(["Stop", "UserPromptSubmit", "SessionStart"]);
  });

  // rollup.sh forces hygiene_score to 0 when sessions_count is 0, and
  // claude_rank_progress excludes those days rather than averaging the zero in.
  // Reporting that 0 as a score asserts a measurement nobody took.
  it("reports hygiene as null on a day with no sessions", () => {
    const quiet = buildAndRoll("tokens-only-day");
    const day = rows<{ day: string; sessions_count: number; hygiene_score: number }>(
      quiet,
      "SELECT day, sessions_count, hygiene_score FROM claude_daily_rollups WHERE sessions_count = 0 LIMIT 1;",
    )[0];
    expect(day.hygiene_score).toBe(0);
    // sqlite3 -json renders strftime's result as a STRING; sqlNum rightly
    // refuses one, so convert at the boundary.
    const at = Number(rows<{ t: string }>(quiet, `SELECT strftime('%s', '${day.day} 12:00:00') AS t;`)[0].t);
    const d = readLive(quiet, { now: at });
    expect(d.today.sessions).toBe(0);
    expect(d.today.hygiene).toBeNull();
  });

  // GUARD (I1). tokens-only-day's day 0 has a rollup row and a session, but
  // the session has no status-line snapshot, so no cost reading: rollup.sh
  // stores cost_usd 0.0. Live must not say "Spend $0.00" for it. Planted:
  // drop the snapshotDays condition in todayRow and this reads 0.
  it("reports today's spend as null, not $0.00, when no session today has a cost reading", () => {
    const quiet = buildAndRoll("tokens-only-day");
    expect(rows<{ c: number; n: number }>(quiet,
      "SELECT cost_usd AS c, sessions_count AS n FROM claude_daily_rollups WHERE day = '2025-06-15';")[0]).toEqual({ c: 0, n: 1 });
    const d = readLive(quiet, { now: BASE + 400 });
    expect(d.today.sessions).toBe(1);
    expect(d.today.costUsd).toBeNull();
    const html = renderLivePanel(d);
    expect(html).toContain('<span>spend · Claude Code&#39;s figure</span><b class="absent">no reading</b>');
    expect(html).not.toContain("$0.00");
  });

  it("returns an empty-but-valid shape against a database with no rows", () => {
    const empty = buildAndRoll("live");
    for (const t of ["claude_status_snapshots", "claude_events", "claude_requests", "claude_daily_rollups"]) {
      rows(empty, `DELETE FROM ${t};`);
    }
    const d = readLive(empty, { now: NOW });
    expect(d.session).toBeNull();
    expect(d.events).toEqual([]);
    expect(d.today.hygiene).toBeNull();
    expect(d.rateLimits.fiveHour.pct).toBeNull();
  });

  // Spec §3C: pending usage is "usage pending, session in progress", never a
  // zero. Every day, from the first session until its SessionEnd runs the
  // rollup, there is no row for today while a session is plainly running.
  // Killing mutation: return 0 hours / 0 sessions when the row is missing.
  it("reports today as pending, not 0h, while a session runs before any rollup", () => {
    const db = buildAndRoll("live");
    rows(db, "DELETE FROM claude_daily_rollups;");
    const d = readLive(db, { now: NOW, transcriptsDir: mkdtempSync(path.join(tmpdir(), "wt-none-")) });
    expect(d.session?.active).toBe(true);
    expect(d.today.activeHours).toBeNull();
    expect(d.today.sessions).toBeNull();
    expect(d.today.costUsd).toBeNull();
    const html = renderLivePanel(d);
    expect(html).toContain("usage pending");
    expect(html).toContain("session in progress");
    expect(html).not.toContain("0.00<span");
    expect(html).not.toMatch(/>0<div class="label">sessions today/);
  });
});

// The ticker: a run of consecutive events with the same name and repo is one
// row with a count. Without it, one burst of subagents was the whole ticker.
describe("the event ticker", () => {
  it("folds a burst into one row, and splits a run where the repo changes", () => {
    const d = readLive(buildAndRoll("ticker-burst"), { now: BASE + 100 });
    expect(d.events.map((e) => [e.name, e.repo, e.count])).toEqual([
      ["SubagentStop", "fx", 1],
      ["SubagentStop", "other", 2],
      ["UserPromptSubmit", "fx", 1],
      ["Stop", "fx", 1],
      ["SubagentStop", "fx", 30],
      ["UserPromptSubmit", "fx", 1],
      ["SessionStart", "fx", 1],
    ]);
    const burst = d.events[4];
    expect([burst.since, burst.ts]).toEqual([BASE + 11, BASE + 40]);
  });

  it("keeps the limit in rows, after folding, and folds only neighbours", () => {
    const raw = [
      ...Array.from({ length: 50 }, (_, i) => ({ ts: 1000 - i, name: "SubagentStop", repo: "a" })),
      ...Array.from({ length: 30 }, (_, i) => ({ ts: 900 - i, name: i % 2 === 0 ? "Stop" : "UserPromptSubmit", repo: "a" })),
    ];
    const rows = collapseEvents(raw);
    expect(rows).toHaveLength(TICKER_LIMIT);
    expect(rows[0]).toEqual({ ts: 1000, name: "SubagentStop", repo: "a", count: 50, since: 951 });
    expect(rows.slice(1).every((r) => r.count === 1)).toBe(true); // alternating: nothing to fold
    expect(collapseEvents([{ ts: 3, name: "Stop", repo: null }, { ts: 2, name: "Stop", repo: null }])).toEqual([
      { ts: 3, name: "Stop", repo: null, count: 2, since: 2 },
    ]);
  });
});
