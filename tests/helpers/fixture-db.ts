import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const LIB = path.join(ROOT, "capture", "lib.sh");
export const ROLLUP = path.join(ROOT, "capture", "rollup.sh");
const MAKE = path.join(ROOT, "tests", "fixtures", "make-fixture.sh");

/**
 * Stage 7 (plan R2): rollup.sh reads `${CLAUDE_DIR:-$HOME/.claude}/skills` to
 * find each skill's pack. Every helper points it at a directory that is never
 * created, so no test reads the live install; a test that needs skills passes
 * its own CLAUDE_DIR (tests/helpers/skills-home.ts) in extraEnv.
 */
export const NO_CLAUDE_DIR = path.join(tmpdir(), "wt-no-claude-dir-never-created");


/**
 * Re-run rollup.sh over an existing fixture DB WITHOUT throwing on a non-zero
 * exit, so a test can assert the exit code and stderr of a failing run. Same
 * env as buildAndRoll (TZ pinned: the rollup buckets by LOCAL day).
 */
export function rerollup(db: string, args: string[] = [], extraEnv: Record<string, string> = {}): SpawnSyncReturns<string> {
  return spawnSync("bash", [ROLLUP, ...args], {
    env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB, TZ: "UTC", CLAUDE_DIR: NO_CLAUDE_DIR, ...extraEnv },
    encoding: "utf8",
  });
}

/** Build a fixture DB and run the rollup over it. TZ pinned: the rollup buckets by LOCAL day. */
export function buildAndRoll(scenario: string, extraEnv: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), `wt-${scenario}-`));
  const db = path.join(dir, "fixture.sqlite");
  execFileSync("bash", [MAKE, scenario, db], { encoding: "utf8" });
  execFileSync("bash", [ROLLUP, "--quiet"], {
    env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB, TZ: "UTC", CLAUDE_DIR: NO_CLAUDE_DIR, ...extraEnv },
    encoding: "utf8",
  });
  return db;
}

const INGEST = path.join(ROOT, "capture", "ingest.sh");
const MAKE_TX = path.join(ROOT, "tests", "fixtures", "make-transcripts.sh");

/**
 * Build every scenario's transcripts into ONE temp `projects/` tree, then run
 * the real pipeline over it: cc_init_db, `ingest.sh --quiet`, `rollup.sh
 * --quiet`, with TZ pinned (the rollup buckets by LOCAL day). The DB sits in
 * its own directory, because the .schema-vN marker is per directory. Returns
 * the DB path; the tree is `<dir>/projects` beside the DB's `<dir>/db`.
 */
export function ingestAndRoll(scenarios: string[], extraEnv: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), `wt-ingroll-${scenarios.join("-")}-`));
  const tx = path.join(dir, "projects");
  const dbDir = path.join(dir, "db");
  execFileSync("mkdir", ["-p", tx, dbDir]);
  for (const s of scenarios) execFileSync("bash", [MAKE_TX, s, tx], { encoding: "utf8" });
  const db = path.join(dbDir, "fixture.sqlite");
  // WATCHTOWER_DB_PATH as well as the deprecated alias: it wins in lib.sh, so a
  // value inherited from the caller's shell can never redirect the run.
  const env = { ...process.env, THEONE_DB_PATH: db, WATCHTOWER_DB_PATH: db, CC_LIB_PATH: LIB,
                WATCHTOWER_TRANSCRIPTS_DIR: tx, TZ: "UTC", CLAUDE_DIR: NO_CLAUDE_DIR, ...extraEnv };
  execFileSync("bash", ["-c", '. "$CC_LIB_PATH" && cc_init_db'], { env, encoding: "utf8" });
  execFileSync("bash", [INGEST, "--quiet"], { env, encoding: "utf8" });
  execFileSync("bash", [ROLLUP, "--quiet"], { env, encoding: "utf8" });
  return db;
}

export function rows<T>(db: string, sql: string): T[] {
  const out = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf8" });
  return out.trim() === "" ? [] : (JSON.parse(out) as T[]);
}
