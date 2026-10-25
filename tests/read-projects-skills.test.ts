import { describe, expect, it } from "vitest";
import { buildAndRoll, rows } from "./helpers/fixture-db.ts";
import { projectLabel, readProjects } from "@/lib/read/projects";
import { readSkills } from "@/lib/read/skills";

// The rollup buckets by LOCAL day under TZ=UTC; the reader's sqlite3 child
// inherits this, so both agree on which day a timestamp belongs to.
process.env.TZ = "UTC";

const BASE = 1750000000; // Sunday 2025-06-15, 15:06:40 UTC
const DAY = 86400;
/** Tuesday 2025-06-17, the `dashboard` scenario's last day. */
const NOW = BASE + 2 * DAY + 1000;

const db = buildAndRoll("dashboard", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });

describe("readProjects", () => {
  const p = readProjects(db, { now: NOW });
  const byLabel = (l: string) => p.projects.find((x) => x.label === l)!;

  it("hides (excluded) everywhere, at read time", () => {
    // It IS in the table -- the reconciliation identity needs it there.
    expect(rows<{ n: number }>(db, `SELECT COUNT(*) AS n FROM claude_project_rollups WHERE project_key='(excluded)'`)[0].n).toBe(1);
    expect(p.projects.map((x) => x.key)).not.toContain("(excluded)");
    expect(p.branches.map((b) => b.branch)).not.toContain("secret");
    expect(p.recentShare.map((x) => x.key)).not.toContain("(excluded)");
    expect(p.projects.every((x) => (x.linesAdded ?? 0) < 999)).toBe(true);
  });

  it("ranks by active hours, with every figure the rollup attributed", () => {
    expect(p.projects.map((x) => x.label)).toEqual(["proj-beta", "proj-alpha", "(unfiled)"]);
    expect(byLabel("proj-alpha").activeHours).toBeCloseTo(610 / 3600, 9);
    expect(byLabel("proj-alpha").sessions).toBe(1);
    expect(byLabel("proj-alpha").costUsd).toBeCloseTo(1.5, 9);
  });

  it("prices an active hour, and has no price where there was no active time", () => {
    expect(byLabel("proj-alpha").costPerActiveHour).toBeCloseTo(1.5 / (610 / 3600), 9);
    expect(byLabel("(unfiled)").costPerActiveHour).toBeNull();
  });

  // THE GUARD (the snapshot trap). S_A's counters are cumulative across three
  // snapshots, 10/2 -> 40/5 -> 100/20. MAX per session is 100 / 20; a SUM
  // across rows is 150 / 27, the same bug that read 80,885,856 lines against a
  // true 287,125 on the real database -- a 281.7x overcount.
  it("takes lines as MAX per session, never a SUM across snapshots", () => {
    expect(byLabel("proj-alpha").linesAdded).toBe(100);
    expect(byLabel("proj-alpha").linesRemoved).toBe(20);
    expect(byLabel("proj-beta").linesAdded).toBe(30);
    expect(byLabel("proj-beta").linesRemoved).toBe(3);
  });

  it("reads no line count where no session reported one, rather than 0", () => {
    expect(byLabel("(unfiled)").linesAdded).toBeNull();
    expect(p.sessionsWithLines).toBe(2);
  });

  // The cwd -> project_key lookup here must agree with the one the rollup
  // minted. Per-branch rows summed per project are the rollup's own per-project
  // tokens, in all four columns, or the lookup has drifted.
  it("attributes branch tokens so they sum to the rollup's per-project tokens", () => {
    const stored = rows<{ project_key: string; tin: number; tout: number; tcr: number; tcw: number }>(
      db,
      `SELECT project_key, SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
              SUM(tokens_cache_read) AS tcr, SUM(tokens_cache_creation) AS tcw
       FROM claude_project_rollups WHERE project_key <> '(excluded)' GROUP BY project_key`,
    );
    expect(stored.length).toBe(3);
    for (const s of stored) {
      const bs = p.branches.filter((b) => b.projectKey === s.project_key);
      const sum = (f: (b: (typeof bs)[number]) => number) => bs.reduce((a, b) => a + f(b), 0);
      expect([sum((b) => b.tokensIn), sum((b) => b.tokensOut), sum((b) => b.tokensCacheRead), sum((b) => b.tokensCacheCreation)])
        .toEqual([s.tin, s.tout, s.tcr, s.tcw]);
    }
  });

  it("splits a project by branch, keeping requests with no session row and no branch", () => {
    const beta = p.branches.filter((b) => b.projectLabel === "proj-beta").map((b) => [b.branch, b.tokensOut]);
    expect(beta).toEqual([["dev", 2903], ["main", 2111]]); // dev is R_G, whose session has no row
    const alpha = p.branches.filter((b) => b.projectLabel === "proj-alpha").map((b) => [b.branch, b.requests]);
    expect(alpha).toEqual([["main", 2], ["feature/x", 1]]);
    expect(p.branches.find((b) => b.projectKey === "(unfiled)")?.branch).toBe("(no branch)");
  });

  it("gives each project a 30-day active-hours series ending today", () => {
    expect(p.recentFrom).toBe("2025-05-19");
    expect(byLabel("proj-alpha").recent).toHaveLength(30);
    expect(byLabel("proj-alpha").recent[27]).toBeCloseTo(610 / 3600, 9); // 2025-06-15
    expect(byLabel("proj-beta").recent[28]).toBeCloseTo(610 / 3600, 9); // 2025-06-16
    expect(p.recentShare.map((x) => x.label)).toEqual(["proj-beta", "proj-alpha"]);
  });

  it("labels a project by its basename and a reserved key as itself", () => {
    expect(projectLabel("/a/b/repo")).toBe("repo");
    expect(projectLabel("(unfiled)")).toBe("(unfiled)");
  });
});

describe("readSkills", () => {
  const s = readSkills(db, { now: NOW });

  // THE GUARD. R_G and R_U carry session_ids with no claude_sessions row --
  // 22.4% of real requests have that shape. Join through claude_sessions and
  // they vanish while every other figure on the page still looks plausible.
  // The totals must be exactly the rollup's daily totals, which never join.
  it("aggregates every request, including those whose session has no row", () => {
    const daily = rows<{ tin: number; tout: number; tcr: number; tcw: number }>(
      db,
      `SELECT SUM(tokens_in) AS tin, SUM(tokens_out) AS tout,
              SUM(tokens_cache_read) AS tcr, SUM(tokens_cache_creation) AS tcw FROM claude_daily_rollups`,
    )[0];
    expect(s.allTime.requests).toBe(7);
    expect([s.allTime.fresh, s.allTime.output, s.allTime.cacheRead, s.allTime.cacheWrite])
      .toEqual([daily.tin, daily.tout, daily.tcr, daily.tcw]);
    expect(s.allTime.total).toBe(daily.tin + daily.tout + daily.tcr + daily.tcw);
  });

  it("uses the rollup's cache-hit formula, and has no reading without cache traffic", () => {
    expect(s.recent.cacheHitPct).toBeCloseTo((100 * 1930) / (1930 + 145), 9);
    const day = (d: string) => s.cacheTrend.find((c) => c.day === d)!.pct;
    expect(day("2025-06-15")).toBeCloseTo((100 * 320) / (320 + 36), 9);
    expect(day("2025-06-17")).toBeNull(); // a day with requests but no cache traffic
    expect(day("2025-06-14")).toBeNull(); // a day with no row at all
  });

  it("splits main thread from subagents", () => {
    expect(s.mainThread.requests).toBe(6);
    expect(s.subagents.requests).toBe(1);
    expect(s.subagents.output).toBe(907);
    expect(s.mainThread.output).toBe(1301 + 503 + 2111 + 2903 + 4507 + 601);
  });

  it("builds skill, MCP and plugin leaderboards from the attribution columns", () => {
    expect(s.skills.rows).toEqual([{ name: "fx-skill", requests: 2, output: 1301 + 2903, total: 1301 + 11 + 130 + 17 + 2903 + 31 + 510 + 37 }]);
    expect(s.mcpServers.rows[0]).toMatchObject({ name: "fx-mcp", detail: "search", requests: 1 });
    expect(s.plugins.rows[0]).toMatchObject({ name: "fx-plugin", requests: 1 });
    expect(s.skills.more).toBe(0);
  });

  it("mixes models by request over the last 30 days", () => {
    expect(s.models.map((m) => [m.model, m.requests])).toEqual([
      ["claude-opus-5", 4], ["claude-sonnet-5", 2], ["claude-haiku-4-5", 1],
    ]);
    expect(s.modelMix).toHaveLength(30);
    expect(s.modelMix.find((x) => x.day === "2025-06-15")!.requests).toEqual([2, 0, 1]);
    expect(s.modelMix.find((x) => x.day === "2025-06-10")!.requests).toEqual([0, 0, 0]);
  });

  it("counts API errors by status", () => {
    expect(s.apiErrors.total).toBe(1);
    expect(s.apiErrors.byStatus).toEqual([{ status: "529", requests: 1 }]);
    expect(s.apiErrors.firstTs).toBe(BASE + 400);
  });

  it("reads nothing after `now`", () => {
    const early = readSkills(db, { now: BASE + 220 });
    expect(early.allTime.requests).toBe(1);
    expect(early.apiErrors.total).toBe(0);
  });
});

// Task 2's contract: every reader with a fixed 30-day window takes an optional
// range, and leaving it out changes nothing. Which blocks a range drives on
// these pages is Tasks 3 and 4's decision; only the window is plumbed here.
describe("readers take an optional range", () => {
  it("reads exactly as before when the range is left out or is the default", () => {
    expect(readProjects(db, { now: NOW, range: "30d" })).toEqual(readProjects(db, { now: NOW }));
    expect(readSkills(db, { now: NOW, range: "30d" })).toEqual(readSkills(db, { now: NOW }));
  });

  it("sizes the recent window by the range, and starts all at the first row", () => {
    const p = readProjects(db, { now: NOW, range: "7d" });
    expect(p.recentFrom).toBe("2025-06-11");
    expect(p.projects[0].recent).toHaveLength(7);
    expect(readProjects(db, { now: NOW, range: "all" }).recentFrom).toBe("2025-06-15");
    expect(readSkills(db, { now: NOW, range: "7d" }).cacheTrend).toHaveLength(7);
    expect(readSkills(db, { now: NOW, range: "all" }).cacheTrend[0].day).toBe("2025-06-15");
  });
});

// Task 3: the Projects page is ranged, so every figure on it honours the range,
// and it gains the terminal breakdown.
describe("readProjects under a range", () => {
  it("counts sessions per terminal, NULL as unknown, never dropped", () => {
    expect(readProjects(db, { now: NOW }).terminals).toEqual([
      { terminal: "unknown", sessions: 2 },
      { terminal: "ghostty", sessions: 1 },
    ]);
  });

  // 7d ending 2025-06-23 holds only 2025-06-17 of the fixture: R_U's request,
  // under (unfiled), and no session start, no line reading and no other token.
  it("bounds every figure by the range's days", () => {
    const p = readProjects(db, { now: BASE + 8 * DAY, range: "7d" });
    expect(p.range).toBe("7d");
    expect(p.recentFrom).toBe("2025-06-17");
    expect(p.projects.map((x) => [x.key, x.tokensIn, x.tokensOut, x.activeHours, x.linesAdded])).toEqual([
      ["(unfiled)", 47, 601, 0, null],
    ]);
    expect(p.branches.map((b) => [b.projectKey, b.branch, b.tokensOut])).toEqual([["(unfiled)", "(no branch)", 601]]);
    expect(p.terminals).toEqual([]);
    expect(p.sessionsWithLines).toBe(0);
  });

  it("reads an empty window as empty, not as zeros", () => {
    const p = readProjects(db, { now: NOW + 100 * DAY, range: "7d" });
    expect([p.projects, p.branches, p.recentShare, p.terminals]).toEqual([[], [], [], []]);
  });
});

// Task 4: Models & Skills parity. Every figure here is `claude_requests` in the
// range, aggregated on its own, except the time series' cost, which is the
// rollup's stored `cost_usd` per day.
describe("readSkills: model share, model table, effort mix and time series", () => {
  const s = readSkills(db, { now: NOW });

  it("shares requests and output tokens by model, most requests first", () => {
    expect(s.range).toBe("30d");
    expect(s.modelShare).toEqual([
      { model: "claude-opus-5", requests: 4, tokensOut: 1301 + 503 + 4507 + 601 },
      { model: "claude-sonnet-5", requests: 2, tokensOut: 2111 + 2903 },
      { model: "claude-haiku-4-5", requests: 1, tokensOut: 907 },
    ]);
  });

  // M6: one cache-hit formula per page -- the rollup's read / (read + write).
  // I2: no per-model error rate; the one recorded error (R_A3's 529) counts
  // in the API errors card, which is lifetime and model-free.
  it("tables each model: in + out, cache hit as read / (read + write), and no error rate", () => {
    const opus = s.modelTable[0];
    expect(opus.model).toBe("claude-opus-5");
    expect([opus.requests, opus.freshTokens, opus.tokensOut]).toEqual([4, 11 + 17 + 41 + 47 + 1301 + 503 + 4507 + 601, 6912]);
    // cache_read / (cache_read + cache_creation)
    expect(opus.cacheHitPct).toBeCloseTo((100 * 860) / (860 + 60), 9);
    expect(opus).not.toHaveProperty("errorRate");
    expect(s.modelTable[1]).toMatchObject({ model: "claude-sonnet-5", requests: 2 });
    expect(s.modelTable[1].cacheHitPct).toBeCloseTo((100 * (370 + 510)) / (370 + 510 + 29 + 37), 9);
    expect(s.apiErrors.total).toBe(1);
    expect(s.modelTable.map((m) => m.model)).toEqual(s.modelShare.map((m) => m.model));
  });

  // 7d ending 2025-06-23 holds only R_U: an opus request with no cache read and
  // no cache write. There is no cache reading to report -- null, never 0%.
  it("has no cache-hit reading for a model with zero cache traffic", () => {
    const late = readSkills(db, { now: BASE + 8 * DAY, range: "7d" });
    expect(late.modelTable).toEqual([
      {
        model: "claude-opus-5", requests: 1, freshTokens: 47 + 601, tokensOut: 601, cacheHitPct: null,
        // Stage 4B: dated before any price row's effective_from (2026-01-01), so
        // no-price-yet: counted, not priced. No ms columns: no response time.
        apiCost: { usd: 0, priced: 0, unpriced: 1 },
        response: { n: 0, median: null, p90: null },
        tokPerSMedian: null,
      },
    ]);
  });

  it("keeps effort not recorded -- NULL or empty -- as its own row", () => {
    expect(s.effort).toEqual([
      { effort: null, requests: 4 },
      { effort: "high", requests: 2 },
      { effort: "medium", requests: 1 },
    ]);
    expect(s.effort.reduce((a, e) => a + e.requests, 0)).toBe(s.recent.requests);
  });

  it("gives one series entry per calendar day, null where there is no row", () => {
    expect(s.series).toHaveLength(30);
    expect(s.series[0].day).toBe("2025-05-19");
    const day = (d: string) => s.series.find((x) => x.day === d)!;
    expect(day("2025-06-15")).toMatchObject({ requests: 3, tokensOut: 1301 + 907 + 503 });
    expect(day("2025-06-16")).toMatchObject({ requests: 3, tokensOut: 2111 + 2903 + 4507 });
    expect(day("2025-06-17")).toMatchObject({ requests: 1, tokensOut: 601 });
    expect(day("2025-06-14")).toEqual({ day: "2025-06-14", requests: null, tokensOut: null, costUsd: null });
    const stored = rows<{ day: string; cost: number }>(db, "SELECT day, cost_usd AS cost FROM claude_daily_rollups WHERE day <> '2025-06-17' ORDER BY day");
    expect(stored.map((r) => r.day)).toEqual(["2025-06-15", "2025-06-16"]);
    for (const r of stored) expect(day(r.day).costUsd).toBe(r.cost);
  });

  // GUARD (I1). 06-17 has a rollup row -- R_U's tokens -- and no session, so
  // no status-line cost reading: rollup.sh stores cost_usd 0.0 there. That is
  // not a measured $0.00; the series says null. Planted: drop the snapshotDays
  // condition in readSkills and this reads 0.
  it("gives a day with a rollup row but no cost reading a null cost, never the stored 0.0", () => {
    expect(rows<{ c: number }>(db, "SELECT cost_usd AS c FROM claude_daily_rollups WHERE day = '2025-06-17'")[0].c).toBe(0);
    expect(s.series.find((x) => x.day === "2025-06-17")).toEqual({ day: "2025-06-17", requests: 1, tokensOut: 601, costUsd: null });
  });

  // Spec §9: the time series totals equal the daily rollups over the same range.
  for (const range of ["7d", "30d", "90d", "all"] as const) {
    it(`reconciles the ${range} series with claude_daily_rollups and claude_requests`, () => {
      for (const now of [NOW, BASE + 5 * DAY]) {
        const r = readSkills(db, { now, range });
        const from = r.series[0].day;
        const to = r.series[r.series.length - 1].day;
        expect(to).toBe(r.today);
        const want = rows<{ cost: number | null; n: number }>(
          db,
          `SELECT (SELECT SUM(cost_usd) FROM claude_daily_rollups WHERE day BETWEEN '${from}' AND '${to}') AS cost,
                  (SELECT COUNT(*) FROM claude_requests
                    WHERE ts <= ${now} AND strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') BETWEEN '${from}' AND '${to}') AS n`,
        )[0];
        const cost = r.series.reduce((a, x) => a + (x.costUsd ?? 0), 0);
        expect(cost).toBeCloseTo(want.cost ?? 0, 9);
        expect(r.series.reduce((a, x) => a + (x.requests ?? 0), 0)).toBe(want.n);
        expect(r.series.reduce((a, x) => a + (x.requests ?? 0), 0)).toBe(r.recent.requests);
      }
    });
  }

  it("reads an empty window as nulls and empty lists, not zeros", () => {
    const e = readSkills(db, { now: NOW + 100 * DAY, range: "7d" });
    expect([e.modelShare, e.modelTable, e.effort]).toEqual([[], [], []]);
    expect(e.series.every((x) => x.requests === null && x.tokensOut === null && x.costUsd === null)).toBe(true);
  });
});
