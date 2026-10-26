import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const HOOK = path.join(ROOT, "capture", "hook.sh");
const ROLLUP = path.join(ROOT, "capture", "rollup.sh");
const LIB = path.join(ROOT, "capture", "lib.sh");

/**
 * Every other activity-model test writes claude_events with raw SQL, so hook.sh
 * — the only thing that writes those rows in production — is never exercised
 * end-to-end into the rollup. If it renamed an event, or started writing ts in
 * milliseconds, all of those tests would stay green while every number the
 * project reports collapsed. This is not hypothetical: the live DB holds 16
 * legacy rows named sessionEnd / sessionStart / stop / beforeSubmitPrompt that
 * match no branch of the model and fall through to think time unnoticed.
 *
 * hook.sh stamps its own clock (cc_now -> `date +%s`), so to replay a scenario
 * with real gaps we put a stub `date` first on PATH that answers `+%s` from
 * FAKE_NOW and delegates everything else. That controls the producer's clock
 * without touching the producer.
 */

const BASE = 1750000000; // same fixed epoch the SQL fixtures use

interface Env {
  dir: string;
  db: string;
  env: Record<string, string>;
}

function makeEnv(withFakeClock: boolean): Env {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-hook-"));
  const home = path.join(dir, "home");
  const claudeDir = path.join(home, ".claude");
  const bin = path.join(dir, "bin");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(bin, { recursive: true });

  if (withFakeClock) {
    const stub = path.join(bin, "date");
    writeFileSync(
      stub,
      '#!/bin/sh\nif [ "$1" = "+%s" ]; then printf \'%s\\n\' "$FAKE_NOW"; else exec /bin/date "$@"; fi\n',
    );
    chmodSync(stub, 0o755);
  }

  return {
    dir,
    db: path.join(dir, "hook.sqlite"),
    env: {
      // HOME and CLAUDE_DIR both point at throwaway dirs: lib.sh defaults the DB
      // to $HOME/.watchtower and the library to $HOME/.claude, and this test must
      // never be able to reach the real ones even if an override is dropped.
      HOME: home,
      CLAUDE_DIR: claudeDir,
      CC_LIB_PATH: LIB,
      WATCHTOWER_DB_PATH: path.join(dir, "hook.sqlite"),
      PATH: withFakeClock ? `${bin}:${process.env.PATH}` : (process.env.PATH ?? ""),
    },
  };
}

/**
 * Feed one hook payload to hook.sh, stamped at BASE + offset seconds. cwd
 * defaults to a non-repo throwaway path (as every existing scenario in this
 * file assumes); pass an explicit cwd to exercise project_path resolution.
 */
function fireHook(e: Env, event: string, offset: number, cwd?: string): string {
  return execFileSync("bash", [HOOK], {
    env: { ...process.env, ...e.env, FAKE_NOW: String(BASE + offset) },
    input: JSON.stringify({
      session_id: "S_HOOK",
      hook_event_name: event,
      cwd: cwd ?? path.join(e.dir, "project"),
      model: "claude-test",
      source: event === "SessionStart" ? "startup" : undefined,
    }),
    encoding: "utf8",
  });
}

function rollup(e: Env): void {
  execFileSync("bash", [ROLLUP, "--quiet"], {
    env: { ...process.env, ...e.env, TZ: "UTC" },
    encoding: "utf8",
  });
}

function query(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

describe("hook.sh -> rollup contract", () => {
  describe("a scenario driven through hook.sh, not raw SQL", () => {
    let e: Env;
    beforeAll(() => {
      e = makeEnv(true);
      // The long-run scenario, event for event: 10s of think, a 20-minute
      // autonomous turn, then the window closing.
      fireHook(e, "SessionStart", 0);
      fireHook(e, "UserPromptSubmit", 10);
      fireHook(e, "Stop", 1210);
      fireHook(e, "SessionEnd", 1220);
      rollup(e);
    });

    it("writes the event names the model actually branches on", () => {
      // A rename or a case change on any of these silently reroutes time into
      // the wrong branch. Ordered by ts so the sequence is pinned too.
      expect(query(e.db, "SELECT group_concat(hook_event_name) FROM (SELECT hook_event_name FROM claude_events ORDER BY id);"))
        .toBe("SessionStart,UserPromptSubmit,Stop,SessionEnd");
    });

    it("creates the session row the rollup joins against", () => {
      expect(query(e.db, "SELECT COUNT(*) FROM claude_sessions WHERE session_id='S_HOOK';")).toBe("1");
      expect(query(e.db, "SELECT started_at FROM claude_sessions WHERE session_id='S_HOOK';"))
        .toBe(String(BASE));
    });

    it("produces the same active and window seconds as the SQL-built fixture", () => {
      // Identical to the `long-run` fixture: 10s think + 1200s work = 1210
      // active, 1210 window. If hook.sh and the model ever disagree about an
      // event name or a time unit, these two numbers are where it shows.
      expect(Number(query(e.db, "SELECT SUM(active_ms)/1000.0 FROM claude_daily_rollups;"))).toBe(1210);
      expect(Number(query(e.db, "SELECT SUM(total_session_ms)/1000.0 FROM claude_daily_rollups;"))).toBe(1210);
      expect(Number(query(e.db, "SELECT SUM(sessions_count) FROM claude_daily_rollups;"))).toBe(1);
    });
  });

  it("stamps ts in epoch SECONDS, not milliseconds", () => {
    // Run against the REAL clock — no stub — so this pins the unit the model
    // assumes. A switch to milliseconds would make every gap ~1000x too large
    // and every cap fire, while the fixture tests above stayed green.
    const e = makeEnv(false);
    const before = Math.floor(Date.now() / 1000);
    fireHook(e, "SessionStart", 0);
    const after = Math.ceil(Date.now() / 1000);

    const ts = Number(query(e.db, "SELECT ts FROM claude_events LIMIT 1;"));
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// snapshot.sh's project_path write got an executed end-to-end test (Task 1,
// Step 9); hook.sh's did not. A column/value misalignment in a hand-written
// multi-column INSERT (or upsert) is exactly the defect class the snapshot
// alignment test exists to catch, and hook.sh writes project_path into TWO
// statements (the claude_events INSERT and the claude_sessions upsert), not
// one. Uses a cwd that is a SUBDIRECTORY of this actual repo (not a throwaway
// non-repo path like the scenario above) so the assertion pins the resolved
// git toplevel, not the cwd itself.
describe("hook.sh writes project_path", () => {
  it("records the git toplevel, not the cwd, on both claude_events and claude_sessions", () => {
    const e = makeEnv(false);
    const subdir = path.join(ROOT, "capture"); // a real subdirectory of this repo

    const out = fireHook(e, "SessionStart", 0, subdir);
    expect(out).toBe("");

    expect(query(e.db, "SELECT cwd FROM claude_events LIMIT 1;")).toBe(subdir);
    expect(query(e.db, "SELECT project_path FROM claude_events LIMIT 1;")).toBe(ROOT);
    expect(query(e.db, "SELECT cwd FROM claude_sessions WHERE session_id='S_HOOK';")).toBe(subdir);
    expect(query(e.db, "SELECT project_path FROM claude_sessions WHERE session_id='S_HOOK';")).toBe(ROOT);
  });
});

// hook.sh and snapshot.sh both derive the repo label from the toplevel they
// have ALREADY fetched, so `basename` there is a subprocess fork per event
// where ${proj##*/} is exact -- and on a cwd beginning with "-" it is also
// wrong: basename parses the argument as an option, writes "basename: illegal
// option" to stderr and returns nothing. hook.sh's contract is exit 0 with
// NOTHING on stdout on every path, and a hook writing to stderr is just as
// visible in a terminal.
describe("hook.sh derives the repo label without forking basename", () => {
  it("stays silent and still labels a cwd that begins with a dash", () => {
    const e = makeEnv(false);
    const r = spawnSync("bash", [HOOK], {
      env: { ...process.env, ...e.env, FAKE_NOW: String(BASE) },
      input: JSON.stringify({
        session_id: "S_DASH",
        hook_event_name: "SessionStart",
        cwd: "-dash-dir",          // not a repo, and not a path basename accepts
        model: "claude-test",
        source: "startup",
      }),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(query(e.db, "SELECT repo FROM claude_events LIMIT 1;")).toBe("-dash-dir");
  });
});
