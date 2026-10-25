import { describe, expect, it } from "vitest";
import type { Attribute, AttributesData } from "@/lib/read/attributes";
import type { Level } from "@/lib/read/level";
import { attributesCard } from "@/lib/render/attributes";

const lv = (level: number): Level => ({ source: "claude", activeS: 1, xp: 1, level, tier: "Advanced",
  xpIntoLevel: 1, xpToNext: 1, sToNext: 1, stars: 0, cap: 99 });
const at = (over: Partial<Attribute> = {}): Attribute => ({ id: "int", ord: 4, form30: 58, form7: 63, boost: 1,
  base: 77, now: 78, level: lv(77), evidence: { "context-hygiene": 60, "cost-discipline": 0 }, ...over });
const data = (attributes: Attribute[], over: Partial<AttributesData> = {}): AttributesData =>
  ({ pending: false, asOfDay: "2026-09-30", attributes, lowest: null, ...over });

describe("attributesCard", () => {
  it("titles the card with the cap and draws Now/Base with a green boost", () => {
    const h = attributesCard(data([at()]), 99, true);
    expect(h).toContain("Attributes · level cap 99");
    expect(h).toContain("INT Intelligence");
    expect(h).toContain(`78<span class="muted">/77</span> <span class="boost">▲1</span>`);
  });
  it("draws a drain in red, and Base alone with no boost", () => {
    expect(attributesCard(data([at({ boost: -3, now: 66, base: 69 })]), 99, true)).toContain(`66<span class="muted">/69</span> <span class="drain">▼3</span>`);
    for (const boost of [0, null]) {
      const h = attributesCard(data([at({ boost, now: 77 })]), 99, true);
      expect(h).not.toContain("▲");
      expect(h).not.toContain("▼");
      expect(h).toContain(`<div class="big lv">77</div>`);
    }
  });
  // Guard 13.
  it("an unmeasured form reads no reading", () => {
    const h = attributesCard(data([at({ form7: null, boost: null })]), 99, true);
    expect(h).toContain("form no reading · 58 (7d · 30d)");
  });
  it("a measured zero form reads 0", () => {
    expect(attributesCard(data([at({ form7: 0, form30: 0, boost: 0, now: 77 })]), 99, true)).toContain("form 0 · 0 (7d · 30d)");
  });
  it("a drained tile never reads below 1", () => {
    expect(attributesCard(data([at({ base: 3, now: 1, boost: -10 })]), 99, true)).toContain(`1<span class="muted">/3</span>`);
  });
  it("an attribute with no XP says so, never Lv 1", () => {
    const h = attributesCard(data([at({ base: null, now: null, level: null, form30: null, form7: null, boost: null })]), 99, true);
    expect(h).toContain("No attribute XP yet.");
    expect(h).not.toContain("Lv 1");
  });
  it("links sources to /profile when served, with their 30-day scores, and STR says what it measures", () => {
    const h = attributesCard(data([at(), at({ id: "str", ord: 1, evidence: { per_hour_30: 85000, per_hour_7: 92000 } })]), 99, true);
    expect(h).toContain(`<a href="/profile">Context hygiene</a> 60`);
    expect(h).toContain(`<a href="/profile">Cost discipline</a> 0`);
    expect(h).toContain("output per active hour, every tool · 85,000");
    expect(attributesCard(data([at()]), 99, false)).not.toContain(`href="/profile"`);
  });
  it("is pending before the v11 rollup", () => {
    const h = attributesCard(data([], { pending: true, asOfDay: null }), null, true);
    expect(h).toContain("Attributes are pending until the v11 rollup");
  });
  it("names the lowest-Form attribute and this week's matching quests", () => {
    const h = attributesCard(data([at()], { lowest: { id: "int", quests: [{ discipline: "cost-discipline", name: "Lean cache" }] } }), 99, true);
    expect(h).toContain("Lowest form: Intelligence");
    expect(h).toContain(`<a href="/quests">Lean cache</a>`);
  });
});
