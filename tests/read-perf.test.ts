import { beforeAll, describe, expect, it } from "vitest";
import { buildAndRoll, ingestAndRoll, rows } from "./helpers/fixture-db.ts";
import { readHistory } from "@/lib/read/history";
import { readLive } from "@/lib/read/live";
import { readPerformance } from "@/lib/read/perf";
import { readProjects } from "@/lib/read/projects";
import { weekOf } from "@/lib/read/range";
import { readSessions } from "@/lib/read/sessions";
import { readSkills } from "@/lib/read/skills";

// Stage 4B Task 5: the readers' cost and latency figures. Every number below
// is one the rollup stored (tests/cost-rollup.test.ts, tests/turns-rollup.test.ts
// pin them against the raw lines); these tests pin what the readers group,
// sum and pick from it. The reader computes nothing else.
process.env.TZ = "UTC";

const noon = (day: string) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);
/** The day after every 4B fixture's 2026-09-10. */
const NEXT = noon("2026-09-11");

let turns: string; // turns-mixed: every request no-split (not priced), five turns
let notes: string; // price-notes: every price_note, no ms columns and no turns
let mixed: string; // priced-mixed: two priced models, one unpriced, three projects
let two: string; // turns-mixed + xrun-a/-b + sent-midstream: measured turns on 2026-07-10 and 2026-09-10

beforeAll(() => {
  turns = ingestAndRoll(["turns-mixed"]);
  notes = buildAndRoll("price-notes");
  mixed = buildAndRoll("priced-mixed");
  // Scenarios with distinct boundary uuids only: claude_prompts keys on entry_uuid
  // (ms-split reuses turns-mixed's u_p1, and the two cannot share a DB).
  two = ingestAndRoll(["turns-mixed", "xrun-a", "xrun-b", "sent-midstream"]);
});

describe("readPerformance", () => {
  it("takes each model's response time and tok/s through orderStats, over the stored values", () => {
    const p = readPerformance(turns, { now: NEXT, range: "7d" });
    // r1..r6 and r_h have a response; r7, r_m and r_side have none (turns-rollup).
    // Sorted: 1000 1000 1250 2000 2000 2000 3000 -> median 2000, p90 = x[ceil(6.3)] = 3000.
    // tok/s sorted: 5 25 40 50 80 200 200 -> median 50.
    expect(p.models).toEqual([
      {
        model: "claude-opus-5",
        cost: { usd: 0, priced: 0, unpriced: 10 },
        share: null,
        response: { n: 7, median: 2000, p90: 3000 },
        tokPerSMedian: 50,
      },
    ]);
  });

  it("counts turns by status and takes the wait over measured turns only", () => {
    const p = readPerformance(turns, { now: NEXT, range: "7d" });
    // measured waits {5250, 1000, 0}; the human (31000) and headless (2000) ones are counted, not measured.
    expect(p.turns).toEqual({ n: 3, median: 1000, p90: 5250, measured: 3, human: 1, headless: 1 });
  });

  it("lists what is not priced by note and model, and counts speed-absent requests priced at standard", () => {
    const p = readPerformance(notes, { now: NEXT, range: "7d" });
    expect(p.unpriced).toEqual([
      { note: "fast", model: "claude-opus-5", n: 1 },
      { note: "no-split", model: "claude-opus-5", n: 1 },
      { note: "unknown-model", model: "claude-mystery-9", n: 1 },
    ]);
    expect(p.speedAbsentPriced).toBe(1);
    expect(readPerformance(turns, { now: NEXT, range: "7d" }).unpriced).toEqual([{ note: "no-split", model: "claude-opus-5", n: 10 }]);
  });

  it("sums each model's priced cost, orders by cost then requests, and shares the priced total", () => {
    const p = readPerformance(notes, { now: NEXT, range: "7d" });
    expect(p.models.map((m) => [m.model, m.cost])).toEqual([
      ["claude-opus-5", { usd: 0.055, priced: 1, unpriced: 2 }],
      ["claude-haiku-4-5", { usd: 0.006, priced: 1, unpriced: 0 }],
      ["claude-mystery-9", { usd: 0, priced: 0, unpriced: 1 }],
    ]);
    // <synthetic> made no API call: in neither count, and not a model row.
    expect(p.models.map((m) => m.model)).not.toContain("<synthetic>");
    expect(p.models[0].share).toBeCloseTo(0.055 / 0.061, 12);
    expect(p.models[1].share).toBeCloseTo(0.006 / 0.061, 12);
    expect(p.models[2].share).toBeNull();
  });

  it("reads the 11 price rows it was priced with, from claude_prices", () => {
    const p = readPerformance(notes, { now: NEXT });
    expect(p.prices).toHaveLength(11);
    const stored = rows<{ model: string; input: number; output: number; cache_write_5m: number; source: string; verified_on: string }>(
      notes, "SELECT model, input, output, cache_write_5m, source, verified_on FROM claude_prices ORDER BY model;");
    expect(p.prices.map((x) => x.model)).toEqual(stored.map((x) => x.model));
    const opus = p.prices.find((x) => x.model === "claude-opus-5")!;
    const row = stored.find((x) => x.model === "claude-opus-5")!;
    expect(opus).toMatchObject({
      speed: "standard", effectiveFrom: "2026-01-01", input: row.input, output: row.output,
      cacheWrite5m: row.cache_write_5m, verifiedOn: row.verified_on, source: row.source,
    });
  });

  it("sums the cache-write mix's tokens off claude_requests and its costs off the priced rows", () => {
    const priced = buildAndRoll("price-rows");
    const [want] = rows<{ t5: number; t1: number; c5: number; c1: number }>(priced,
      `SELECT SUM(r.cache_write_5m) AS t5, SUM(r.cache_write_1h) AS t1,
              SUM(m.cost_write_5m_usd) AS c5, SUM(m.cost_write_1h_usd) AS c1
       FROM claude_requests r JOIN claude_request_metrics m USING (request_id);`);
    const mix = readPerformance(priced, { now: NEXT, range: "7d" }).cacheMix;
    expect(mix.tokens5m).toBe(want.t5);
    expect(mix.tokens1h).toBe(want.t1);
    expect(mix.cost5m).toBeCloseTo(want.c5, 12);
    expect(mix.cost1h).toBeCloseTo(want.c1, 12);
    expect(want.t5).toBeGreaterThan(0);
    // Nothing priced: no cost to show, and no split tokens either.
    expect(readPerformance(turns, { now: NEXT, range: "7d" }).cacheMix).toEqual({ tokens5m: 0, tokens1h: 0, cost5m: null, cost1h: null });
  });

  it("bounds every ranged figure by the range's local days", () => {
    // 2026-09-10 is outside the 7 days ending 2026-10-01.
    const p = readPerformance(turns, { now: noon("2026-10-01"), range: "7d" });
    expect(p.models).toEqual([]);
    expect(p.turns).toEqual({ n: 0, median: null, p90: null, measured: 0, human: 0, headless: 0 });
    expect(p.unpriced).toEqual([]);
    expect(p.cacheMix).toEqual({ tokens5m: 0, tokens1h: 0, cost5m: null, cost1h: null });
    expect(p.prices).toHaveLength(11); // not ranged
    expect(readPerformance(turns, { now: noon("2026-10-01"), range: "all" }).models).toHaveLength(1);
  });

  // Review Focus 4: an upgrade whose rollup ran before --backfill. The v6
  // columns exist, but no request has ms timestamps and there are no turns.
  it("reads a v6 DB with no ms columns and no turns as no reading, without throwing", () => {
    expect(rows<{ n: number }>(notes, "SELECT COUNT(*) AS n FROM claude_requests WHERE first_ms IS NOT NULL OR sent_ms IS NOT NULL;")[0].n).toBe(0);
    expect(rows<{ n: number }>(notes, "SELECT COUNT(*) AS n FROM claude_turns;")[0].n).toBe(0);
    const p = readPerformance(notes, { now: NEXT, range: "30d" });
    for (const m of p.models) {
      expect(m.response).toEqual({ n: 0, median: null, p90: null });
      expect(m.tokPerSMedian).toBeNull();
    }
    expect(p.turns).toEqual({ n: 0, median: null, p90: null, measured: 0, human: 0, headless: 0 });
  });
});

describe("the existing pages' readers: cost at API prices and latency", () => {
  it("Live: today's cost at API prices, Claude Code's figure and today's median measured wait", () => {
    const t = readLive(turns, { now: noon("2026-09-10") }).today;
    expect(t.apiCost).toEqual({ usd: 0, priced: 0, unpriced: 10 });
    expect(t.costUsd).toBeNull(); // no status-line reading: snapshotDays gating
    expect(t.wait).toEqual({ n: 3, median: 1000, p90: 5250 });
    const partial = readLive(notes, { now: noon("2026-09-10") }).today;
    expect(partial.apiCost?.priced).toBe(2);
    expect(partial.apiCost?.unpriced).toBe(3);
    expect(partial.apiCost?.usd).toBeCloseTo(0.061, 12);
    expect(partial.wait).toEqual({ n: 0, median: null, p90: null });
    // No rollup row today: no reading of either, and no wait.
    const none = readLive(turns, { now: NEXT }).today;
    expect(none.apiCost).toBeNull();
    expect(none.wait).toEqual({ n: 0, median: null, p90: null });
  });

  it("History: both costs in the day rows", () => {
    const h = readHistory(mixed, { now: NEXT, range: "7d" });
    const day = (d: string) => h.days.find((x) => x.day === d)!;
    expect(day("2026-09-10").apiCost.priced).toBe(12);
    expect(day("2026-09-10").apiCost.unpriced).toBe(4);
    expect(day("2026-09-10").apiCost.usd).toBeCloseTo(0.51692, 12);
    // No session that day has a status-line cost reading: no reading, not $0.
    expect(day("2026-09-10").costUsd).toBeNull();
    expect(day("2025-06-15").costUsd).toBe(8.5);
    expect(day("2025-06-15").apiCost).toEqual({ usd: 0, priced: 0, unpriced: 4 });
  });

  it("History: priced cost per model per bucket, one series per model, largest first", () => {
    const h = readHistory(mixed, { now: NEXT, range: "7d" });
    expect(h.perf.weekly).toBe(false);
    expect(h.perf.models).toEqual(["claude-opus-5", "claude-sonnet-5"]);
    expect(h.perf.buckets.map((b) => b.label)).toEqual(h.span);
    const b = h.perf.buckets.find((x) => x.label === "2026-09-10")!;
    expect(b.costByModel[0]).toBeCloseTo(4 * 0.055 + 4 * 0.065, 12);
    expect(b.costByModel[1]).toBeCloseTo(4 * 0.00923, 12);
    expect(b.apiCost).toMatchObject({ priced: 12, unpriced: 4 });
    // A day with no rollup row has no cost reading at all.
    expect(h.perf.buckets.find((x) => x.label === "2026-09-09")!.apiCost).toBeNull();
  });

  it("History: the median measured wait per bucket, null with no measured turn", () => {
    const h = readHistory(two, { now: NEXT, range: "90d" });
    const at = (d: string) => h.perf.buckets.find((x) => x.label === d)!.wait;
    expect(at("2026-09-10")).toEqual({ n: 3, median: 1000, p90: 5250 });
    // 07-10's two measured turns: u_s (12:00:00 -> req_s' last partial 12:00:03)
    // and u_x5 (14:00:00 -> req_x's last partial 14:00:03).
    expect(rows(two, "SELECT entry_uuid, wait_ms, status FROM claude_turns WHERE day = '2026-07-10' ORDER BY entry_uuid;")).toEqual([
      { entry_uuid: "u_s", wait_ms: 3000, status: "measured" },
      { entry_uuid: "u_x5", wait_ms: 3000, status: "measured" },
    ]);
    expect(at("2026-07-10")).toEqual({ n: 2, median: 3000, p90: 3000 });
    expect(at("2026-08-01")).toEqual({ n: 0, median: null, p90: null });
  });

  it("History: past 90 days the wait is one order statistic per week, over the week's turns", () => {
    const h = readHistory(two, { now: noon("2026-10-15"), range: "all" });
    expect(h.perf.weekly).toBe(true);
    const week = h.perf.buckets.find((b) => b.days.includes("2026-09-10"))!;
    expect(week.week).toBe(true);
    expect(week.label).toBe(weekOf("2026-09-10"));
    expect(week.wait).toEqual({ n: 3, median: 1000, p90: 5250 });
    expect(h.perf.buckets.flatMap((b) => b.days)).toEqual(h.span);
  });

  it("Projects: cost at API prices, and Claude Code's figure as null where no session had a reading", () => {
    const week = readProjects(mixed, { now: NEXT, range: "7d" });
    const one = week.projects.find((p) => p.label === "proj-one")!;
    expect(one.apiCost.priced).toBe(3);
    expect(one.apiCost.unpriced).toBe(1);
    expect(one.apiCost.usd).toBeCloseTo(0.12923, 12);
    expect(one.costUsd).toBeNull();
    expect(one.costPerActiveHour).toBeNull();
    const all = readProjects(mixed, { now: NEXT, range: "all" }).projects.find((p) => p.label === "proj-one")!;
    expect(all.costUsd).toBeCloseTo(1.5, 12);
    expect(all.apiCost.unpriced).toBe(2);
  });

  it("Sessions: the whole session's cost at API prices, from claude_request_metrics by session", () => {
    const s = readSessions(mixed, { now: NEXT, range: "7d" });
    const pm = s.rows.filter((r) => r.sessionId === "S_PM");
    expect(pm.length).toBeGreaterThan(1); // one row per project it ran in
    for (const r of pm) {
      expect(r.apiCost.priced).toBe(12);
      expect(r.apiCost.unpriced).toBe(4);
      expect(r.apiCost.usd).toBeCloseTo(0.51692, 12);
    }
  });

  it("Models & Skills: each model's cost at API prices, response order statistics and median tok/s", () => {
    const k = readSkills(mixed, { now: NEXT, range: "7d" });
    const m = (name: string) => k.modelTable.find((x) => x.model === name)!;
    expect(m("claude-opus-5").apiCost.priced).toBe(8);
    expect(m("claude-opus-5").apiCost.usd).toBeCloseTo(0.48, 12);
    expect(m("claude-mystery-9").apiCost).toEqual({ usd: 0, priced: 0, unpriced: 4 });
    expect(m("claude-opus-5").response).toEqual({ n: 0, median: null, p90: null });
    const t = readSkills(turns, { now: NEXT, range: "7d" }).modelTable.find((x) => x.model === "claude-opus-5")!;
    expect(t.response).toEqual({ n: 7, median: 2000, p90: 3000 });
    expect(t.tokPerSMedian).toBe(50);
  });
});
