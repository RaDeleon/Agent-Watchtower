import { describe, expect, it } from "vitest";
import { median, orderStats, p90 } from "@/lib/read/perf";

// Spec 4.3's one definition of the order statistics the Performance page
// shows. lib/ sorts and picks; every value it is handed was derived in
// capture/rollup.sh.

describe("median", () => {
  it("is the middle value, or the mean of the two middle values, of the non-NULL values", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    // NULL means "not measured": dropped, never read as 0.
    expect(median([null, 5])).toBe(5);
  });

  it("is null when nothing was measured", () => {
    expect(median([])).toBeNull();
    expect(median([null])).toBeNull();
  });

  it("does not reorder its input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("p90", () => {
  it("is the nearest rank: the value at 1-based position ceil(0.9 * n), never interpolated", () => {
    // Position ceil(9) = 9 of 1..10 is 9; linear interpolation would give 9.1.
    expect(p90([10, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toBe(9);
    expect(p90([1, 2])).toBe(2);
    expect(p90([5])).toBe(5);
    // ceil(9.9) = 10.
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toBe(10);
  });

  it("is null when nothing was measured", () => {
    expect(p90([])).toBeNull();
    expect(p90([null, null])).toBeNull();
  });
});

describe("orderStats", () => {
  it("counts only measured values and takes both statistics over them", () => {
    expect(orderStats([null, 2, 1])).toEqual({ n: 2, median: 1.5, p90: 2 });
    expect(orderStats([])).toEqual({ n: 0, median: null, p90: null });
  });
});
