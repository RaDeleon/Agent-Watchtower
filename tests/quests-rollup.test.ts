import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DISCIPLINE_ORDER } from "@/lib/read/profile";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { slow } from "./helpers/timeout";

// Stage 8 (spec 4.2-4.4, 6.1): claude_quests, built by rollup.sh's profile
// section. Guards 1-6 each own one test below, and R21 keeps each guard's
// literal values in that test alone. Every other test asserts identities, and
// no test but guard 2's names a week by its date: guard 2's plant re-keys
// every week to a Sunday, which must red only its own test.

interface QuestRow {
  week: string; week_end: string; slot: number; discipline: string; score: number; direction: string;
  baseline: number; target: number; hold: number; value: number | null; requests: number; status: string;
}
const quests = (db: string) =>
  rows<QuestRow>(db, "SELECT * FROM claude_quests ORDER BY week, slot;");
/** Weeks with quests, oldest first, each its rows in slot order. */
function weeks(db: string): QuestRow[][] {
  const out = new Map<string, QuestRow[]>();
  for (const r of quests(db)) out.set(r.week, [...(out.get(r.week) ?? []), r]);
  return [...out.values()];
}

// The scenarios and their as-of days (tests/fixtures/make-fixture.sh).
const WEEKS = { WATCHTOWER_ROLLUP_TODAY: "2026-09-09" };
const SUNDAY = { WATCHTOWER_ROLLUP_TODAY: "2026-08-19" };
const ASK_FIRST = { WATCHTOWER_ROLLUP_TODAY: "2026-08-12" };

let qw: string; // quest-weeks: weeks A-F, as of Wed 2026-09-09 (week F)
let qs: string; // quest-sunday: week B's 20th request on its Sunday
let qa: string; // quest-ask-first: Ask first measured, as of Wed 2026-08-12

// Each test only reads, so each scenario is built and rolled once.
beforeAll(() => {
  qw = buildAndRoll("quest-weeks", WEEKS);
  qs = buildAndRoll("quest-sunday", SUNDAY);
  qa = buildAndRoll("quest-ask-first", ASK_FIRST);
}, slow(60000));

describe("Stage 8: weekly quests", () => {
  // Guard 1. Week C's own days lift model-routing from 0 to 28, so its own
  // last day would rank cost-discipline first; the Sunday before it ranks them
  // 0 and 0, by display order.
  it("a week's quests come from the scores before it starts", () => {
    const c = weeks(qw)[1];
    expect(c.map((q) => [q.discipline, q.score])).toEqual([
      ["model-routing", 0], ["cost-discipline", 0], ["context-hygiene", 31],
    ]);
  });

  // Guard 2. Week B's 20th request is on its Sunday: only a Monday-to-Sunday
  // week measures it.
  it("a week runs Monday to Sunday", () => {
    const b = quests(qs).filter((q) => q.week === "2026-08-10");
    expect(b.map((q) => [q.week_end, q.requests, q.value === null])).toEqual([
      ["2026-08-16", 20, false], ["2026-08-16", 20, false], ["2026-08-16", 20, false],
    ]);
  });

  // Guard 3. Week C ends at 50% off the top model and a 10,000-token median
  // context, both past full marks, so week D's quests on them are holds.
  it("a target stops at full marks and holds there", () => {
    const held = quests(qw).filter((q) => q.hold === 1);
    expect(held.map((q) => [q.discipline, q.baseline, q.target])).toEqual([
      ["model-routing", 0.5, 0.35], ["context-hygiene", 10000, 60000],
    ]);
  });

  // Guard 4. Lean cache steps down by 10% and Ask first by one point.
  it("an at-most quest steps down", () => {
    const atMost = [...quests(qw), ...quests(qa)].filter((q) => q.direction === "at-most" && q.hold === 0);
    const pairs = new Map(atMost.map((q) => [`${q.discipline} ${q.baseline}`, q.target]));
    expect(Object.fromEntries(pairs)).toEqual({
      "cost-discipline 2000": 1800, "context-hygiene 200000": 180000,
      "cost-discipline 100": 90, "security 1": 0.99,
    });
  });

  // Guard 5. Week D has 5 requests.
  it("a quiet week is no data, never missed", () => {
    const d = weeks(qw)[2];
    expect(d.map((q) => [q.requests, q.value, q.status])).toEqual([
      [5, null, "no data"], [5, null, "no data"], [5, null, "no data"],
    ]);
  });

  // Guard 6. The as-of day is in week F.
  it("the current week stays open", () => {
    const all = weeks(qw);
    const f = all[all.length - 1];
    expect(f.map((q) => [q.status, q.value])).toEqual([["open", 100], ["open", 0.5], ["open", 10000]]);
    expect(all.slice(0, -1).flat().filter((q) => q.status === "open")).toEqual([]);
  });
});

describe("Stage 8: quest identities", () => {
  const all = () => [...quests(qw), ...quests(qs), ...quests(qa)];

  it("each week's baseline is the week before's value", () => {
    const pairs = rows<{ n: number; bad: number }>(qw, `
      SELECT COUNT(*) AS n, SUM(q.baseline IS NOT p.value) AS bad
      FROM claude_quests q JOIN claude_quests p
        ON p.discipline = q.discipline AND p.week = date(q.week, '-7 days');`)[0];
    expect(pairs.n).toBeGreaterThan(0);
    expect(pairs.bad).toBe(0);
  });

  it("a week has at most three quests, slotted by score, then display order", () => {
    const ord = new Map(DISCIPLINE_ORDER.map((d, i) => [d as string, i]));
    for (const w of weeks(qw)) {
      expect(w.length).toBeLessThanOrEqual(3);
      expect(w.map((q) => q.slot)).toEqual(w.map((_, i) => i + 1));
      const sorted = [...w].sort((a, b) => a.score - b.score || ord.get(a.discipline)! - ord.get(b.discipline)!);
      expect(w.map((q) => q.discipline)).toEqual(sorted.map((q) => q.discipline));
    }
  });

  it("a closed week's status follows its stored value and target", () => {
    for (const q of all().filter((r) => r.status !== "open" && r.value !== null)) {
      const met = q.direction === "at-least" ? q.value! >= q.target : q.value! <= q.target;
      expect({ q, status: q.status }).toEqual({ q, status: met ? "done" : "missed" });
    }
  });

  // Spec 10.3: quest-weeks records no tool call and no hook event, so no week
  // is tool- or event-covered. Only the request-based disciplines are measured.
  it("a week before tool and hook coverage gets no tool or event quest", () => {
    expect([...new Set(quests(qw).map((q) => q.discipline))].sort())
      .toEqual(["context-hygiene", "cost-discipline", "model-routing"]);
  });

  it("a week ends on the Sunday after it starts, and no week starts after the as-of day", () => {
    expect(rows<{ n: number }>(qw, `SELECT COUNT(*) AS n FROM claude_quests
      WHERE week_end <> date(week, '+6 days') OR week > '${WEEKS.WATCHTOWER_ROLLUP_TODAY}';`)[0].n).toBe(0);
  });
});

describe("Stage 8: the profile section's quest swap", () => {
  const ROLLUP = path.resolve(__dirname, "..", "capture", "rollup.sh");
  it("stages claude_quests in _pf_quests and swaps it in the write phase", () => {
    const src = readFileSync(ROLLUP, "utf8");
    const section = src.slice(src.indexOf("# ---- rebuild the Usage Profile"), src.indexOf("# ---- rebuild the agent rollups (Stage 5)"));
    const write = section.slice(section.lastIndexOf("BEGIN IMMEDIATE"));
    expect(write).toContain("DELETE FROM claude_quests;");
    expect(write).toMatch(/INSERT INTO claude_quests \([\w, ]+\)\s+SELECT [\w, ]+\s+FROM _pf_quests ORDER BY rowid;/);
  });
});

// Stage 10 (R3), an identity, not a guard: on a Sunday as-of day each week
// still gets each discipline once, beside the as-of day's 7-day scores. Today a
// pick day (the Sunday before a week) is never the as-of day, because no week
// starts after it, so _pf_qpick's e.win = '30' is defensive and dropping it
// reds nothing. This test catches a future change that extends weeks past the
// as-of day, which would put the 7-day rows on a pick day.
it("an as-of Sunday picks each week's quests once", () => {
  const db = buildAndRoll("quest-weeks", { WATCHTOWER_ROLLUP_TODAY: "2026-08-23" });
  const weeks = rows<{ week: string; n: number; d: number }>(db,
    "SELECT week, COUNT(*) AS n, COUNT(DISTINCT discipline) AS d FROM claude_quests GROUP BY week;");
  expect(weeks.length).toBeGreaterThan(0);
  for (const w of weeks) expect(w.d).toBe(w.n);
  expect(rows(db, "SELECT COUNT(*) AS n FROM claude_discipline_scores_7d;")).toEqual([{ n: 10 }]);
});
