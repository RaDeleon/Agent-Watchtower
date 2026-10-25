import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { errorLine } from "./core/sql.ts";

export interface RollupOutcome { ran: boolean; ok: boolean; script: string; detail?: string }

/**
 * Run the INSTALLED rollup over the database sync just wrote (R12) -- the same
 * script the SessionEnd hook runs, so one version rolls the database. Not
 * installed here is a state, not an error. WATCHTOWER_ROLLUP_PATH and
 * CC_LIB_PATH override the paths, for tests and for proving a branch on a copy.
 */
export function runRollup(opts: {
  db: string; installDir: string; excludePaths: readonly string[];
  env?: NodeJS.ProcessEnv; timeoutMs?: number;
}): RollupOutcome {
  const env = opts.env ?? process.env;
  const script = env.WATCHTOWER_ROLLUP_PATH || path.join(opts.installDir, "claude-usage-rollup.sh");
  const lib = env.CC_LIB_PATH || path.join(opts.installDir, "cc-track-lib.sh");
  if (!existsSync(script) || !existsSync(lib)) {
    return { ran: false, ok: true, script, detail: `no rollup at ${script}` };
  }
  try {
    execFileSync("bash", [script, "--quiet"], {
      env: {
        ...env, CC_LIB_PATH: lib, WATCHTOWER_DB_PATH: opts.db, THEONE_DB_PATH: opts.db,
        WATCHTOWER_EXCLUDE_PATHS: opts.excludePaths.join("\n"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? 300_000,
    });
    return { ran: true, ok: true, script };
  } catch (e) {
    return { ran: true, ok: false, script, detail: errorLine(e) };
  }
}
