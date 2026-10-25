import { describe, expect, it } from "vitest";
import type { Level } from "@/lib/read/level";
import {
  AUTOMATED_ONLY, MEMORY_CAPTION, NOT_SYNCED, NO_DRIVEN_HOURS, NO_OPENVIKING, NO_REQUESTS,
  dataAsOf, unreachableAt,
} from "@/lib/render/empty";
import { formatXp, levelBlock } from "@/lib/render/level";

const LV77: Level = { source: "claude", activeS: 1051920, xp: 1523464, level: 77, tier: "Advanced",
  xpIntoLevel: 47883, xpToNext: 105736, sToNext: 73009, stars: 0 };
const LV99: Level = { source: "hermes", activeS: 11699999, xp: 16944758, level: 99, tier: "Master",
  xpIntoLevel: 3910327, xpToNext: null, sToNext: null, stars: 2 };

describe("formatXp", () => {
  it("is OSRS-style and floored", () => {
    expect(formatXp(1523464)).toBe("1.52M");
    expect(formatXp(16944758)).toBe("16.94M");
    expect(formatXp(23722)).toBe("23.7K");
    expect(formatXp(9999)).toBe("9,999");
    expect(formatXp(477)).toBe("477");
    expect(formatXp(1999999)).toBe("1.99M");
  });
});

describe("levelBlock", () => {
  it("shows level, tier, XP, the meter and the hours to the next level", () => {
    const h = levelBlock({ state: "level", level: LV77 });
    expect(h).toContain(">Lv 77<");
    expect(h).toContain("Advanced");
    expect(h).toContain("1.52M XP");
    expect(h).toContain("20.3h to Lv 78");
    expect(h).toContain('aria-valuenow="31"');
    expect(h).toContain('<i style="width:31.2%"></i>');
  });

  it("shows stars and a full meter past the top level", () => {
    const h = levelBlock({ state: "level", level: LV99 });
    expect(h).toContain('aria-label="2 stars past 200"');
    expect(h).toContain("★★");
    expect(h).not.toContain("to Lv");
    expect(h).toContain('<i style="width:100.0%"></i>');
  });

  it("shows the cap beside the level, and nothing without one", () => {
    const base = { source: "claude" as const, activeS: 1, xp: 1, level: 57, tier: "Intermediate", xpIntoLevel: 1, xpToNext: 1, sToNext: 1, stars: 0 };
    expect(levelBlock({ state: "level", level: { ...base, cap: 120 } })).toContain(`Lv 57<span class="muted">/120</span>`);
    expect(levelBlock({ state: "level", level: base })).toContain(`<div class="big lv">Lv 57</div>`);
  });

  it("says no driven hours rather than Lv 1", () => {
    const h = levelBlock({ state: "none", activeS: 0 });
    expect(h).toContain("No driven hours yet.");
    expect(h).not.toContain("Lv ");
  });

  // Final-review I2: Claude is never synced; its row comes from the installed rollup.
  it("names the right cause of a pending level: Claude's install, the agents' sync", () => {
    expect(levelBlock({ state: "pending" }, "claude")).toContain("Watchtower&#39;s rollup has not run since its v7 install");
    expect(levelBlock({ state: "pending" }, "claude")).not.toContain("synced");
    expect(levelBlock({ state: "pending" }, "codex")).toContain("the rollup has not run since this tool was synced");
    expect(levelBlock({ state: "pending" }, "hermes")).toContain("the rollup has not run since this tool was synced");
  });

  it("says level pending when there is no row", () => {
    const h = levelBlock({ state: "pending" });
    expect(h).toContain("level pending");
    expect(h).not.toContain("Lv ");
  });
});

describe("empty-state strings", () => {
  it("are spec section 5's, verbatim", () => {
    expect(NOT_SYNCED).toBe("Not synced yet — open the dashboard or run `watchtower sync`.");
    expect(NO_DRIVEN_HOURS).toBe("No driven hours yet.");
    expect(AUTOMATED_ONLY).toBe("automated only");
    expect(NO_REQUESTS).toBe("no requests");
    expect(NO_OPENVIKING).toBe("no OpenViking on this machine");
    expect(MEMORY_CAPTION).toBe("memory — not counted in totals");
    expect(unreachableAt("14:02")).toBe("Unreachable at last sync (14:02)");
    expect(dataAsOf("2026-10-03 14:02")).toBe("data as of 2026-10-03 14:02");
  });
});
