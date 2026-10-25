import { describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { runRollup } from "@/lib/rollup-run";
import { ROLLUP, buildAndRoll, rows } from "./helpers/fixture-db";

const LIB = path.resolve(__dirname, "..", "capture", "lib.sh");
const emptyTmp = () => mkdtempSync(path.join(tmpdir(), "wt-install-"));

describe("runRollup", () => {
  it("is not an error when no rollup is installed", () => {
    const r = runRollup({ db: "/nonexistent.sqlite", installDir: emptyTmp(), excludePaths: [], env: {} });
    expect(r).toMatchObject({ ran: false, ok: true });
  });

  it("runs the rollup over the database", () => {
    const db = buildAndRoll("resumed");
    execFileSync("sqlite3", [db, "DELETE FROM claude_daily_rollups;"]);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_daily_rollups")[0].n).toBe(0);
    const r = runRollup({
      db, installDir: emptyTmp(), excludePaths: [],
      env: { ...process.env, TZ: "UTC", WATCHTOWER_ROLLUP_PATH: ROLLUP, CC_LIB_PATH: LIB },
    });
    expect(r).toMatchObject({ ran: true, ok: true });
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_daily_rollups")[0].n).toBeGreaterThan(0);
  });

  it("a failing script is ran:true, ok:false, with a detail", () => {
    const dir = emptyTmp();
    const script = path.join(dir, "fail.sh");
    writeFileSync(script, "#!/bin/bash\necho boom >&2\nexit 1\n");
    chmodSync(script, 0o755);
    const r = runRollup({
      db: "/nonexistent.sqlite", installDir: dir, excludePaths: [],
      env: { ...process.env, WATCHTOWER_ROLLUP_PATH: script, CC_LIB_PATH: LIB },
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect((r.detail ?? "").length).toBeGreaterThan(0);
  });
});
