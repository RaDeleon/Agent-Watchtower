import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { buildAndRoll } from "./helpers/fixture-db";
import { captureBaseline, SCENARIOS, type ScenarioBaseline } from "./regression/baseline";
import { slow } from "./helpers/timeout";

const BASELINE = path.resolve(__dirname, "regression", "claude-baseline.json");

function rowCount(b: ScenarioBaseline): number {
  return b.daily.length + b.projects.length + b.rank.length;
}

describe("Claude regression baseline", () => {
  it("has a committed baseline file", () => {
    expect(existsSync(BASELINE)).toBe(true);
  });

  /**
   * make-fixture.sh shells out to git. When git is broken -- on this machine
   * /usr/bin/git is the Xcode shim and exited 69 on every command until
   * DEVELOPER_DIR was pointed at CommandLineTools -- `set -e` aborts the
   * fixture and leaves a database with no sessions and no project paths.
   * A baseline frozen in that state asserts nothing while still going green,
   * which is precisely the failure this task exists to prevent. So the file's
   * non-vacuity is itself a test.
   */
  it("is not vacuous: every scenario present, every one carrying rows", () => {
    const expected = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, ScenarioBaseline>;
    expect(Object.keys(expected).sort()).toEqual([...SCENARIOS].sort());
    for (const scenario of SCENARIOS) {
      expect(`${scenario}: ${rowCount(expected[scenario]) > 0}`).toBe(`${scenario}: true`);
    }
    const total = SCENARIOS.reduce((n, s) => n + rowCount(expected[s]), 0);
    expect(total).toBeGreaterThan(SCENARIOS.length * 2);
  });

  /**
   * Every non-integer is compared at 12 significant digits. The rank row's
   * reals pass through bash as sqlite3's text, and the CLI prints 15
   * significant digits before 3.54 and the shortest round-trip form from then
   * on (0.0333333333333333 against 0.03333333333333333). That is a formatting
   * difference, not a model one; any real change moves a figure far above it.
   */
  const fp12 = (v: unknown): unknown =>
    typeof v === "number" && !Number.isInteger(v) ? Number(v.toPrecision(12))
      : Array.isArray(v) ? v.map(fp12)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fp12(x)]))
      : v;

  it("matches the committed baseline exactly on every scenario", () => {
    const expected = JSON.parse(readFileSync(BASELINE, "utf8"));
    for (const scenario of SCENARIOS) {
      const db = buildAndRoll(scenario);
      expect(`${scenario}: ${JSON.stringify(fp12(captureBaseline(db)))}`)
        .toBe(`${scenario}: ${JSON.stringify(fp12(expected[scenario]))}`);
    }
  }, slow(300_000));
});
