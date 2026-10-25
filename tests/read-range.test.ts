import { describe, expect, it } from "vitest";
import { DEFAULT_RANGE, RANGES, parseRange, rangeLabel, rangeStartDay } from "@/lib/read/range";

describe("parseRange", () => {
  it("accepts each known range as itself", () => {
    expect(parseRange("7d")).toBe("7d");
    for (const r of RANGES) expect(parseRange(r)).toBe(r);
  });

  // Review Focus 3: a hostile or absent ?range= falls back to the default. It
  // is never reflected, so nothing downstream can render it.
  it("falls back to 30d for anything else", () => {
    expect(DEFAULT_RANGE).toBe("30d");
    expect(parseRange("<script>")).toBe("30d");
    expect(parseRange("")).toBe("30d");
    expect(parseRange(undefined)).toBe("30d");
    expect(parseRange(null)).toBe("30d");
    expect(parseRange("x".repeat(10 * 1024))).toBe("30d");
    expect(parseRange("7D")).toBe("30d");
    expect(parseRange(" 7d")).toBe("30d");
    expect(parseRange("toString")).toBe("30d");
  });
});

describe("rangeStartDay", () => {
  it("is the first day of an n-day window ending today, inclusive", () => {
    expect(rangeStartDay("2026-09-23", "7d")).toBe("2026-09-17");
    expect(rangeStartDay("2026-09-23", "30d")).toBe("2026-08-25");
    expect(rangeStartDay("2026-09-23", "90d")).toBe("2026-06-26");
  });

  it("crosses a year boundary by calendar", () => {
    expect(rangeStartDay("2026-01-03", "7d")).toBe("2025-12-28");
  });

  it("has no start for all", () => {
    expect(rangeStartDay("2026-09-23", "all")).toBeNull();
  });
});

describe("rangeLabel", () => {
  it("names each range in words", () => {
    expect(RANGES.map(rangeLabel)).toEqual(["last 7 days", "last 30 days", "last 90 days", "all time"]);
  });
});
