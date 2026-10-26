import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "@/lib/config";

const ROOT = path.resolve(__dirname, "..");
const CAPTURE = path.join(ROOT, "capture");
// install.sh is in this list deliberately: it is the most-edited shell file in
// capture/ and the only one that mutates the user's config, yet it was the one
// script `bash -n` never saw.
const SCRIPTS = ["lib.sh", "hook.sh", "rollup.sh", "snapshot.sh", "install.sh", "ingest.sh"];
const LIB_PATH = path.join(CAPTURE, "lib.sh");
const SNAPSHOT_PATH = path.join(CAPTURE, "snapshot.sh");

/** Every .ts file under dir, recursively. [] if the directory does not exist. */
function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walkTs(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/**
 * Runs a capture script with `input` on stdin from a file, not a pipe. A script
 * that exits before reading stdin closes the pipe under Node's write, and
 * spawnSync then throws EPIPE although the script exited 0 with nothing on
 * stdout; a file has no reader to lose.
 */
function runFromFile(script: string, input: string, env: Record<string, string>): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "wt-stdin-")), "stdin.json");
  writeFileSync(file, input);
  const fd = openSync(file, "r");
  try {
    return execFileSync("bash", [script], {
      env: { ...process.env, ...env },
      stdio: [fd, "pipe", "pipe"],
      encoding: "utf8",
    });
  } finally {
    closeSync(fd);
  }
}

describe("capture scripts", () => {
  it.each(SCRIPTS)("%s is syntactically valid bash", (name) => {
    expect(() => execFileSync("bash", ["-n", path.join(CAPTURE, name)])).not.toThrow();
  });
  // GNU stat reads `-f %m` as a file-system query: it prints a block for the
  // file, then fails, so a BSD-first fallback captures that block plus the
  // number and the arithmetic on it breaks. That silently disabled snapshot
  // throttling on Linux. The GNU form must come first.
  it.each(SCRIPTS)("%s tries GNU stat before BSD stat", (name) => {
    expect(readFileSync(path.join(CAPTURE, name), "utf8")).not.toMatch(/stat -f %m[^\n]*\|\|[^\n]*stat -c/);
  });

  // This asserted `src.includes("cc_sqlstr(")` — a substring match that a
  // mention in a COMMENT satisfies, and that stays green over a hollowed-out or
  // syntactically broken function body. Source the library and ask bash what is
  // actually defined instead.
  it("lib.sh actually defines every helper the other scripts rely on", () => {
    const names = [
      "cc_db_path", "cc_db_dir", "cc_have_deps", "cc_init_db", "cc_sql", "cc_sql_val",
      "cc_sqlstr", "cc_sqlnum", "cc_sqlbool", "cc_now", "cc_repo", "cc_terminal_app",
    ];
    const out = execFileSync(
      "bash",
      ["-c", `. "${LIB_PATH}"; for f in ${names.join(" ")}; do declare -F "$f" >/dev/null || echo "$f"; done`],
      { encoding: "utf8" },
    );
    expect(out.trim()).toBe("");
  });

  // The SQL encoders are the whole reason arbitrary session ids and cwds can be
  // interpolated into the INSERTs at all, so pin what they return, not that
  // their names appear. A body replaced by `:` passes the substring check.
  it("lib.sh's SQL encoders encode, rather than merely existing", () => {
    const evalIn = (expr: string): string =>
      execFileSync("bash", ["-c", `. "${LIB_PATH}"; ${expr}`], { encoding: "utf8" });

    expect(evalIn(`cc_sqlstr "o'brien"`)).toBe("'o''brien'");   // the injection case
    expect(evalIn('cc_sqlstr ""')).toBe("NULL");
    expect(evalIn('cc_sqlnum "42"')).toBe("42");
    expect(evalIn('cc_sqlnum "-1.5"')).toBe("-1.5");
    expect(evalIn('cc_sqlnum "1; DROP TABLE claude_events"')).toBe("NULL");
    expect(evalIn('cc_sqlbool "true"')).toBe("1");
    expect(evalIn('cc_sqlbool "false"')).toBe("0");
    expect(evalIn('cc_sqlbool "maybe"')).toBe("NULL");
    // cc_now is `date +%s`, so it carries date's trailing newline (unlike the
    // printf-based encoders above, whose exact bytes are the point).
    expect(evalIn("cc_now").trim()).toMatch(/^\d{10}$/);
  });

  it("lib.sh declares a schema version", () => {
    const src = readFileSync(path.join(CAPTURE, "lib.sh"), "utf8");
    expect(src).toMatch(/CC_SCHEMA_VERSION=\d+/);
  });

  // Named "exactly once" but only asserted presence, so it never enforced the
  // count in its own name. The counts are 2 and 2, not 1: the 300s think cap
  // appears in the UserPromptSubmit branch and again in the THINK fallback, and
  // the 14400s work cap in the WORK branch and again in window_s. Pin the real
  // numbers — a third copy means a branch was duplicated rather than edited.
  // The agent section's copy of the rule (Stage 5) adds the prompt and think
  // caps and the work cap; it has no window_s. Hence 4 and 3.
  it("carries each rev-3 activity model constant exactly as many times as the model needs", () => {
    const src = readFileSync(path.join(CAPTURE, "rollup.sh"), "utf8");
    const count = (needle: string) => src.split(needle).length - 1;
    expect(count("MIN(gap, 300)")).toBe(4);
    expect(count("MIN(gap, 14400)")).toBe(3);
    expect(src).toContain("window_s");
  });

  // The Global Constraint the plan calls non-negotiable: the activity model
  // lives in capture/rollup.sh and nowhere else. A TypeScript (or second shell)
  // reimplementation of the caps is exactly what this forbids, and nothing else
  // in the suite would notice one appearing.
  it("defines the activity model constants in rollup.sh and nowhere else", () => {
    // Stage 3A: the normalized layer is exactly where "just compute the gap
    // here, it's only for display" would land next.
    const normalized = [
      ...walkTs(path.join(ROOT, "lib", "core")),
      ...walkTs(path.join(ROOT, "lib", "adapters")),
    ];
    // NON-VACUITY. walkTs returns [] for a directory that does not exist, so a
    // rename or a move would silently reduce this guard to covering nothing
    // while it stayed green. Assert the sweep actually found the layer before
    // trusting what it says about it.
    expect(`lib/core+lib/adapters .ts files found: ${normalized.length > 0}`)
      .toBe("lib/core+lib/adapters .ts files found: true");
    expect(normalized.some((f) => f.includes(`${path.sep}core${path.sep}`))).toBe(true);
    expect(normalized.some((f) => f.includes(`${path.sep}adapters${path.sep}`))).toBe(true);

    // Stage 3C: the dashboard's read and render layers, where "the rollup has
    // not run yet, so recompute the window here" would land. Same non-vacuity
    // rule: a moved directory must fail this, not shrink it to nothing.
    const dashboard = [
      ...walkTs(path.join(ROOT, "lib", "read")),
      ...walkTs(path.join(ROOT, "lib", "render")),
    ];
    for (const layer of ["read", "render"]) {
      const found = dashboard.some((f) => f.includes(`${path.sep}lib${path.sep}${layer}${path.sep}`));
      expect(`lib/${layer} .ts files found: ${found}`).toBe(`lib/${layer} .ts files found: true`);
    }
    // Stage 3D's new files are inside that walk, named, so a file moved out of
    // lib/read or lib/render drops out of this list loudly rather than quietly.
    for (const rel of ["render/theme.ts", "render/client.ts", "render/level.ts", "render/sessions.ts", "read/level.ts", "read/range.ts", "read/sessions.ts"]) {
      const file = path.join(ROOT, "lib", ...rel.split("/"));
      expect(`${rel} swept: ${dashboard.includes(file)}`).toBe(`${rel} swept: true`);
    }

    const carriers = [
      ...SCRIPTS.filter((n) => n !== "rollup.sh").map((n) => path.join(CAPTURE, n)),
      path.join(ROOT, "lib", "config.ts"),
      path.join(ROOT, "lib", "projects.ts"),
      path.join(ROOT, "lib", "serve.ts"),
      path.join(ROOT, "lib", "views.ts"),
      path.join(ROOT, "bin", "watchtower"),
      ...normalized,
      ...dashboard,
    ];
    for (const file of carriers) {
      expect(`${file}: ${readFileSync(file, "utf8").includes("MIN(gap,")}`).toBe(`${file}: false`);
    }
  });

  // Stage 4A (spec 4, 6): every Usage Profile threshold lives in rollup.sh and
  // nowhere else. lib/ reads and labels; a threshold copied there -- "just to
  // colour the bar" -- is a second copy of the model that drifts. A LITERAL
  // substring check (String.includes, not a RegExp whose "." matches any
  // character): 0.35 must not match "0x35" or "0,35", and it does not have to.
  //
  // Stage 6 (spec 6.1, "Also pinned"; final review M1): no level thresholds,
  // pace or streak math under lib/ either. The XP rule's constants (13,034,431
  // and 9,000,000, whose substring 900000 is also the 250 h a star) and the
  // tier boundaries live in rollup.sh's _ag_xp and _ag_tier. A copy of the tier
  // CASE must name Apprentice, Builder, Intermediate and Advanced, which the
  // page never needs (it prints the stored tier). The other three tier names
  // are not pinned: "Noobie" and "Master" are also the Usage Profile ladder's
  // labels in lib/render/profile.ts, and "Pro" is a
  // substring of Profile, Projects and Progress. Pace is XP over 28 calendar
  // days, so a "/ 28" or "* 28" in lib/ is the pace or ETA formula copied; the
  // page's "28 days" captions do not match. Streak math has no literal to pin.
  // Stage 10: STR's full marks (120,000 output tokens an active hour) and the
  // tiers past Master (Grandmaster, Legend, Mythic, Eternal) live in rollup.sh
  // too; the page prints the stored Form and tier.
  it("keeps the Usage Profile thresholds and the level, pace and tier constants out of lib/", () => {
    const walkAll = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walkAll(p) : [p];
      });
    const files = walkAll(path.join(ROOT, "lib"));
    // Non-vacuity: a moved lib/ must fail this, not shrink it to nothing.
    expect(files.length).toBeGreaterThan(20);
    const tokens = [
      "350000", "350_000", "80000", "80_000", "2700", "0.35",
      "13034431", "13_034_431", "9000000", "9_000_000", "900000", "900_000",
      "Apprentice", "Builder", "Intermediate", "Advanced",
      "120000", "120_000", "Grandmaster", "Legend", "Mythic", "Eternal",
    ];
    const paceMath = /[*/]\s*28\b/;
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const token of tokens) {
        if (src.includes(token)) offenders.push(`${path.relative(ROOT, file)}: ${token}`);
      }
      if (paceMath.test(src)) offenders.push(`${path.relative(ROOT, file)}: ${paceMath.source}`);
    }
    expect(offenders).toEqual([]);
    // ...and the thresholds DO live in rollup.sh, so this is not guarding
    // tokens that exist nowhere.
    const rollup = readFileSync(path.join(CAPTURE, "rollup.sh"), "utf8");
    for (const token of ["350000", "80000", "2700", "0.35", "13034431", "9000000", "900000", "Apprentice", "Builder", "Intermediate", "Advanced",
                         "120000", "Grandmaster"]) {
      expect(`rollup.sh has ${token}: ${rollup.includes(token)}`).toBe(`rollup.sh has ${token}: true`);
    }
    expect(`rollup.sh has the pace divisor: ${paceMath.test(rollup)}`).toBe("rollup.sh has the pace divisor: true");
  });

  // Design §3: "package.json gains no dependencies block. A test asserts this."
  // The dashboard is node:http, hand-written SVG and the sqlite3 binary; a
  // charting library or a web framework would be the first runtime dependency.
  it("declares zero runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;
    const runtime = ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies"]
      .filter((k) => pkg[k] !== undefined && Object.keys(pkg[k] as object).length > 0);
    expect(runtime).toEqual([]);
  });

  // The manifest can be clean while the code imports a package anyway (one
  // installed as a devDependency resolves fine in this checkout and nowhere
  // else). Everything that ships must import only node: builtins and relative
  // paths.
  it("imports nothing but node: builtins and relative paths in shipped code", () => {
    const shipped = [...walkTs(path.join(ROOT, "lib")), path.join(ROOT, "bin", "watchtower")];
    expect(shipped.length).toBeGreaterThan(20);
    const spec = /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gm;
    const offenders: string[] = [];
    for (const file of shipped) {
      for (const m of readFileSync(file, "utf8").matchAll(spec)) {
        const target = m[1] ?? m[2];
        if (!target.startsWith("node:") && !target.startsWith("./") && !target.startsWith("../")) {
          offenders.push(`${path.relative(ROOT, file)} -> ${target}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The schema version is declared TWICE and independently: CC_SCHEMA_VERSION in
  // lib.sh (which names the .schema-v<N> marker guarding cc_init_db's fast path)
  // and schemaVersion in lib/config.ts. Nothing else ties them, so bumping one
  // alone would leave the TypeScript side claiming a schema the shell side never
  // applies. Pin them together.
  it("declares the same schema version in lib.sh and lib/config.ts", () => {
    const src = readFileSync(path.join(CAPTURE, "lib.sh"), "utf8");
    const m = /^CC_SCHEMA_VERSION=(\d+)$/m.exec(src);
    expect(m).not.toBeNull();
    const fromShell = Number(m![1]);
    const fromConfig = loadConfig({
      configPath: "/nonexistent/watchtower.config.json",
      env: {},
    }).schemaVersion;
    expect(fromShell).toBe(fromConfig);
  });

  it("cc_project_path returns the git toplevel, empty outside a repo", () => {
    const evalIn = (expr: string): string =>
      execFileSync("bash", ["-c", `. "${LIB_PATH}"; ${expr}`], { encoding: "utf8" }).trim();

    // ROOT is this repo, so it is its own toplevel.
    expect(evalIn(`cc_project_path "${ROOT}"`)).toBe(ROOT);
    // A subdirectory must resolve UP to the toplevel, not to itself. This is the
    // 15-of-75 case: cwd alone is not the project key.
    expect(evalIn(`cc_project_path "${path.join(ROOT, "capture")}"`)).toBe(ROOT);
    // Outside a repo: empty, not an error, not the basename.
    expect(evalIn(`cc_project_path "/tmp"`)).toBe("");
    expect(evalIn(`cc_project_path ""`)).toBe("");
  });

  // cc_repo was the last unpinned copy of "toplevel basename, else cwd basename,
  // else empty". Nothing asserted its behaviour -- only that the symbol exists --
  // and after hook.sh and snapshot.sh switched to ${x##*/} it became the
  // DIVERGENT one: on a "-"-prefixed cwd its basename call printed
  // "basename: illegal option" to stderr and returned nothing, where its own
  // inlined replacements returned the label correctly. A helper that is wrong
  // in a way its replacements are right about is a trap for the next caller.
  it("cc_repo labels a cwd: toplevel basename, else cwd basename, else empty", () => {
    // cc_repo writes with printf and no trailing newline, so stdout is compared
    // verbatim. Not an observable change for callers: every caller reads it
    // through command substitution, which strips trailing newlines anyway.
    const repo = (arg: string) =>
      spawnSync("bash", ["-c", `. "${LIB_PATH}"; cc_repo ${arg}`], { encoding: "utf8" });
    const ok = (r: ReturnType<typeof repo>, what: string) =>
      expect(`${what}: status ${r.status}, stderr ${JSON.stringify(r.stderr)}`)
        .toBe(`${what}: status 0, stderr ""`);

    // empty cwd -> empty label, no git call at all
    expect(repo('""').stdout).toBe("");
    // a repo root -> its own basename
    expect(repo(`"${ROOT}"`).stdout).toBe(path.basename(ROOT));
    // a SUBDIRECTORY resolves UP to the toplevel, so still the repo's basename
    expect(repo(`"${path.join(ROOT, "capture")}"`).stdout).toBe(path.basename(ROOT));
    // a real directory that is not a repo -> the cwd's own basename
    expect(repo(`"/tmp"`).stdout).toBe("tmp");
    // a directory that does not exist -> still the cwd's basename, silently
    const gone = repo(`"/no/such/dir-xyz"`);
    expect(gone.stdout).toBe("dir-xyz");
    ok(gone, "nonexistent dir");
    // a cwd beginning with "-": basename parses it as an OPTION
    const dash = repo(`"-dash-dir"`);
    expect(dash.stdout).toBe("-dash-dir");
    ok(dash, "dash-prefixed cwd");
  });

  // The version itself is pinned once, as a literal, by tests/config.test.ts
  // (schemaVersion), and tied to lib.sh by "declares the same schema version in
  // lib.sh and lib/config.ts" above -- so a bump is still a conscious edit
  // without a third copy of the number here. v3 added claude_project_paths and
  // claude_project_rollups; v4 claude_requests and claude_ingest_cursor; v5
  // (Stage 4A) claude_tool_calls, claude_slash_commands, claude_profile_daily
  // and claude_discipline_scores; v6 (Stage 4B) claude_prompts, claude_prices,
  // claude_request_metrics, claude_turns and the columns in V6_COLUMNS below.
  it("declares project_path on all three capture tables", () => {
    const schema = execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_schema_sql`], { encoding: "utf8" });
    for (const table of ["claude_events", "claude_sessions", "claude_status_snapshots"]) {
      const block = schema.slice(schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
      expect(block.slice(0, block.indexOf(");"))).toContain("project_path");
    }
  });

  it("lets the library path be overridden for testing", () => {
    for (const name of ["hook.sh", "rollup.sh", "snapshot.sh"]) {
      const src = readFileSync(path.join(CAPTURE, name), "utf8");
      expect(src).toContain("${CC_LIB_PATH:-");
    }
  });

  it("never writes to stdout on a missing library", () => {
    const out = runFromFile(path.join(CAPTURE, "hook.sh"), "{}", { CC_LIB_PATH: "/nonexistent/lib.sh" });
    expect(out).toBe("");
  });
});

// The reader once got a WATCHTOWER_DB_PATH override the writer did not read.
// Nothing failed: the reader pointed at the new file, the hooks kept writing to
// the old one, and every write on that path swallows its own error by design --
// so the symptom was a dashboard of zeros over a database that was still being
// filled correctly somewhere else. These pin the two halves to one resolution.
describe("cc_db_path: the writer must resolve where the reader reads", () => {
  /** cc_db_path under a controlled HOME, with the override cleared first. */
  const dbPath = (home: string, over: Record<string, string> = {}): string =>
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_db_path`], {
      encoding: "utf8",
      env: {
        ...process.env,
        WATCHTOWER_DB_PATH: "",
        HOME: home,
        ...over,
      },
    }).trim();

  const emptyHome = (): string => mkdtempSync(path.join(tmpdir(), "wt-home-"));

  it("honours WATCHTOWER_DB_PATH, the variable the reader reads", () => {
    const got = dbPath(emptyHome(), { WATCHTOWER_DB_PATH: "/new.sqlite" });
    expect(got).toBe("/new.sqlite");
    expect(got).toBe(
      loadConfig({
        configPath: "/nonexistent/watchtower.config.json",
        env: { WATCHTOWER_DB_PATH: "/new.sqlite" },
      }).database.path,
    );
  });

  it("defaults to ~/.watchtower/watchtower.sqlite", () => {
    const home = emptyHome();
    expect(dbPath(home)).toBe(path.join(home, ".watchtower", "watchtower.sqlite"));
  });

  // The agreement that actually matters, asserted against the real machine
  // rather than a fixture: whatever this install resolves to, both halves say it.
  it("agrees with lib/config.ts on this machine's real database", () => {
    const reader = loadConfig({
      configPath: "/nonexistent/watchtower.config.json",
      env: {},
    }).database.path;
    expect(dbPath(os.homedir())).toBe(reader);
  });
});

// Regression test for the v1 -> v2 migration ordering. cc_schema_sql now
// contains `CREATE INDEX idx_events_projpath ON claude_events(project_path)`,
// and CREATE TABLE IF NOT EXISTS silently skips a table that already exists
// -- so on a genuinely pre-existing v1 database (not a fresh one, which the
// rest of this file only ever exercises), that CREATE INDEX statement needs
// the ALTER-added project_path column to already be there. Get the ordering
// backwards and the whole piped schema-apply exits non-zero: no marker, no
// index, and (per manual reproduction) the failure only shows up on the
// FIRST cc_init_db call against such a database -- a second call succeeds
// because the ALTERs already ran, so a test that calls cc_init_db twice would
// pass against the broken ordering and prove nothing. This asserts state
// after exactly one call.
/** The version cc_init_db is currently applying, read from lib.sh. */
function schemaVersion(): string {
  const m = /^CC_SCHEMA_VERSION=(\d+)$/m.exec(readFileSync(LIB_PATH, "utf8"));
  if (m === null) throw new Error("CC_SCHEMA_VERSION not found in capture/lib.sh");
  return m[1];
}

describe("cc_init_db: schema migrations", () => {
  // The lib.sh from the commit immediately before this task's schema-v2 change
  // landed, vendored -- a genuine, populated-looking v1 schema (no
  // project_path column, no idx_events_projpath index).
  const LIB_V1_PATH = path.join(ROOT, "tests", "fixtures", "lib-v1.sh");
  // The lib.sh from the Stage 1.5 commit where schema v2 existed WITHOUT
  // claude_project_paths or claude_project_rollups, vendored -- the exact shape a
  // v2 install is in before this task's tables arrive.
  const LIB_V2_PATH = path.join(ROOT, "tests", "fixtures", "lib-v2.sh");

  it("migrates a real, populated v1 database to v2 in exactly one cc_init_db call", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-migrate-"));
    const dbPath = path.join(dir, "claude-code-usage.sqlite");

    // Build a genuine v1 database using the pre-task lib.sh, not the current
    // one -- this is the actual shape a real user's database is in before
    // upgrading.
    expect(readFileSync(LIB_V1_PATH, "utf8")).toMatch(/^CC_SCHEMA_VERSION=1$/m);
    execFileSync("bash", ["-c", `. "${LIB_V1_PATH}"; cc_schema_sql | sqlite3 "${dbPath}"`]);

    // Prove the table is genuinely populated, not just structurally v1.
    execFileSync("sqlite3", [
      dbPath,
      "INSERT INTO claude_events (ts, session_id, hook_event_name) VALUES (1700000000, 'pre-existing-row', 'SessionStart');",
    ]);
    expect(
      execFileSync("sqlite3", [dbPath, "SELECT COUNT(*) FROM claude_events;"], { encoding: "utf8" }).trim(),
    ).toBe("1");

    // Run the CURRENT cc_init_db exactly once against this v1 database.
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: dbPath },
      encoding: "utf8",
    });

    // The marker must exist after exactly one call -- named for whatever version
    // lib.sh currently declares, NOT a hardcoded literal. Hardcoding it is what
    // let Stage 1.5 add two tables under an unchanged CC_SCHEMA_VERSION and stay
    // green: the marker this asserts and the marker cc_init_db writes have to be
    // the same string by construction, or the test stops watching the thing it
    // is named after.
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);

    // project_path must be present on all three capture tables.
    for (const table of ["claude_events", "claude_sessions", "claude_status_snapshots"]) {
      const cols = execFileSync("sqlite3", [dbPath, `PRAGMA table_info(${table});`], { encoding: "utf8" });
      expect(cols).toContain("project_path");
    }

    // idx_events_projpath must exist.
    expect(
      execFileSync(
        "sqlite3",
        [dbPath, "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_events_projpath';"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("idx_events_projpath");

    // The pre-existing row must have survived the migration.
    expect(
      execFileSync(
        "sqlite3",
        [dbPath, "SELECT COUNT(*) FROM claude_events WHERE session_id='pre-existing-row';"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("1");
  });

  // The gap the v1 case above could not see. cc_init_db's fast path returns
  // early when .schema-v<CC_SCHEMA_VERSION> exists, so a table ADDED to
  // cc_schema_sql without bumping the version never reaches an install that
  // already has that version's marker. Stage 1.5 added claude_project_paths and
  // claude_project_rollups under an unchanged version 2, and the consequence was
  // not "the tables are missing": rollup.sh's _pk selects from
  // claude_project_paths inside BEGIN IMMEDIATE under .bail on, so the whole
  // rebuild transaction aborted before its DELETE. claude_daily_rollups went
  // STALE rather than empty, and rollup.sh runs --quiet from the SessionEnd
  // hook, so daily usage tracking stopped with nothing on stdout or stderr.
  // Reproduced against a real v2 database: exit 1, daily rows frozen.
  it("brings a real v2 database up to the current schema in exactly one cc_init_db call", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-migrate-v2-"));
    const dbPath = path.join(dir, "claude-code-usage.sqlite");

    // A GENUINE v2 database: built from the commit where version 2 existed
    // without either Stage 1.5 table, not from the current lib.sh.
    const v2LibSrc = readFileSync(LIB_V2_PATH, "utf8");
    expect(v2LibSrc).toMatch(/^CC_SCHEMA_VERSION=2$/m);
    expect(v2LibSrc).not.toContain("claude_project_paths");
    expect(v2LibSrc).not.toContain("claude_project_rollups");
    execFileSync("bash", ["-c", `. "${LIB_V2_PATH}"; cc_schema_sql | sqlite3 "${dbPath}"`]);
    // The marker a real v2 install leaves beside the database. Without it there
    // is nothing to short-circuit and the test proves nothing.
    writeFileSync(path.join(dir, ".schema-v2"), "");

    execFileSync("sqlite3", [
      dbPath,
      "INSERT INTO claude_events (ts, session_id, hook_event_name) VALUES (1700000000, 'pre-existing-row', 'SessionStart');",
    ]);

    // Exactly ONE call, for the same reason as the v1 case: a second call papers
    // over the failure, because by then the first has already done the work.
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: dbPath },
      encoding: "utf8",
    });

    const tables = execFileSync(
      "sqlite3",
      [dbPath, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"],
      { encoding: "utf8" },
    );
    expect(tables).toContain("claude_project_paths");
    expect(tables).toContain("claude_project_rollups");

    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);

    // And the v2 data is still there.
    expect(
      execFileSync(
        "sqlite3",
        [dbPath, "SELECT COUNT(*) FROM claude_events WHERE session_id='pre-existing-row';"],
        { encoding: "utf8" },
      ).trim(),
    ).toBe("1");
  });
});

describe("schema v4", () => {
  it("creates claude_requests and claude_ingest_cursor, and stamps .schema-v4", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v4-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; CC_SCHEMA_VERSION=4; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    const tables = execFileSync("sqlite3", [db,
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"],
      { encoding: "utf8" });
    expect(tables).toContain("claude_requests");
    expect(tables).toContain("claude_ingest_cursor");
    expect(existsSync(path.join(dir, ".schema-v4"))).toBe(true);
  });

  it("upgrades a v3 database in place without losing rows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v3up-"));
    const db = path.join(dir, "fixture.sqlite");
    // Build at v3 by stamping the old marker, then re-init at v4.
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; CC_SCHEMA_VERSION=3; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    execFileSync("sqlite3", [db,
      "INSERT INTO claude_sessions(session_id, started_at) VALUES('s1', 1750000000);"]);
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; CC_SCHEMA_VERSION=4; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    expect(execFileSync("sqlite3", [db, "SELECT count(*) FROM claude_sessions;"],
      { encoding: "utf8" }).trim()).toBe("1");
    expect(execFileSync("sqlite3", [db, "SELECT count(*) FROM claude_requests;"],
      { encoding: "utf8" }).trim()).toBe("0");
  });
});

// Stage 4B (schema v6): every column cc_init_db's v6 ALTER loop adds to an
// EXISTING table, and the four tables it creates. One list for both the fresh
// and the upgrade case, so neither can drift from the other.
const V6_COLUMNS: Array<[string, string]> = [
  ["claude_requests", "first_ms"], ["claude_requests", "last_ms"],
  ["claude_requests", "sent_ms"], ["claude_requests", "cache_write_5m"],
  ["claude_requests", "cache_write_1h"], ["claude_requests", "speed"],
  ["claude_ingest_cursor", "last_user_ms"],
  ["claude_daily_rollups", "cost_table_usd"], ["claude_daily_rollups", "priced_requests"],
  ["claude_daily_rollups", "unpriced_requests"], ["claude_daily_rollups", "sessions_with_cost"],
  ["claude_project_rollups", "cost_table_usd"], ["claude_project_rollups", "priced_requests"],
  ["claude_project_rollups", "unpriced_requests"], ["claude_project_rollups", "sessions_with_cost"],
  ["claude_profile_daily", "event_covered"],
];
const V6_TABLES = ["claude_prompts", "claude_prices", "claude_request_metrics", "claude_turns"];

/** Column names of one table, via PRAGMA table_info. */
function columnsOf(db: string, table: string): string[] {
  return execFileSync("sqlite3", [db, `SELECT name FROM pragma_table_info('${table}');`],
    { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}
function tablesOf(db: string): string[] {
  return execFileSync("sqlite3", [db, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"],
    { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}
/** A genuine v5 database and its .schema-v5 marker, from main's v5 lib.sh. */
const LIB_V5_PATH = path.join(ROOT, "tests", "fixtures", "lib-v5.sh");
function buildV5(db: string): void {
  expect(readFileSync(LIB_V5_PATH, "utf8")).toMatch(/^CC_SCHEMA_VERSION=5$/m);
  execFileSync("bash", ["-c", `. "${LIB_V5_PATH}"; cc_init_db`], {
    env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
  });
}

describe("schema v6", () => {
  it("creates every Stage 4A and 4B table and column, and stamps the current marker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v6-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    const tables = tablesOf(db);
    for (const table of [
      "claude_tool_calls", "claude_slash_commands",
      "claude_profile_daily", "claude_discipline_scores", ...V6_TABLES,
    ]) {
      expect(tables).toContain(table);
    }
    for (const [table, col] of V6_COLUMNS) {
      expect(`${table}.${col}: ${columnsOf(db, table).includes(col)}`).toBe(`${table}.${col}: true`);
    }
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);
  });

  // Review Focus 5 of Stage 4A: a directory holding a v4 DB and its .schema-v4
  // marker must gain all four Stage 4A tables, and the current marker, on the
  // next cc_init_db -- with none of the pre-existing v4 data disturbed.
  //
  // `cc_schema_sql` is a single unconditional script: running cc_init_db with
  // CC_SCHEMA_VERSION=4 forced ALSO applies every later CREATE TABLE, because
  // the version only names the marker file, not which statements run. So a
  // v4 init leaves the four new tables already present, and a test that
  // merely checks they exist AFTER the "upgrade" step passes whether or not
  // upgrading did anything -- it would pass identically against a lib.sh
  // whose upgrade path stamps the marker without creating any of the four
  // tables. Ruling this out means observing them ABSENT before the upgrade:
  // drop all four (simulating the true pre-Stage-4A shape of a real v4
  // database, where they never existed) and only then assert cc_init_db
  // (run at the CURRENT, un-forced version) creates them, their three
  // indexes, and the current marker -- without touching the pre-existing
  // claude_requests row.
  it("upgrades a v4 database in place, adding all four tables and their indexes without losing rows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v4up-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; CC_SCHEMA_VERSION=4; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    expect(existsSync(path.join(dir, ".schema-v4"))).toBe(true);
    execFileSync("sqlite3", [db,
      `INSERT INTO claude_requests(request_id, ts) VALUES('req_v4', 1750000000);`]);

    // Simulate a genuine v4 database: the four Stage 4A tables never existed.
    const newTables = [
      "claude_tool_calls", "claude_slash_commands",
      "claude_profile_daily", "claude_discipline_scores",
    ];
    for (const table of newTables) {
      execFileSync("sqlite3", [db, `DROP TABLE ${table};`]);
    }
    // tablesOf, an array, not the raw listing: a substring test would take
    // claude_discipline_scores_7d (schema v11) for claude_discipline_scores.
    const beforeTables = tablesOf(db);
    for (const table of newTables) {
      expect(beforeTables).not.toContain(table);
    }

    // The real upgrade: cc_init_db at the CURRENT version, no override.
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });

    const tables = tablesOf(db);
    for (const table of newTables) {
      expect(tables).toContain(table);
    }
    const indexes = execFileSync("sqlite3", [db,
      "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;"],
      { encoding: "utf8" });
    for (const idx of ["idx_tool_calls_ts", "idx_tool_calls_session", "idx_slash_ts"]) {
      expect(indexes).toContain(idx);
    }
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);
    expect(execFileSync("sqlite3", [db, "SELECT count(*) FROM claude_requests;"],
      { encoding: "utf8" }).trim()).toBe("1");
  });

  // Stage 4B: a GENUINE v5 database -- built by main's v5 lib.sh (vendored as
  // tests/fixtures/lib-v5.sh), which also stamps its own .schema-v5 marker --
  // gains every v6 column and table after exactly ONE current cc_init_db.
  // Forcing CC_SCHEMA_VERSION=5 on the current lib.sh would already create the
  // v6 columns (the version names only the marker), so this builds from the
  // real v5 lib instead and observes every column and table ABSENT first.
  // Without the ALTER loop the CREATE TABLE IF NOT EXISTS apply leaves existing
  // tables as they are, and the columns never arrive.
  it("upgrades a real v5 database in one call: every v6 column and table, rows untouched", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v5up-"));
    const db = path.join(dir, "fixture.sqlite");
    buildV5(db);
    expect(existsSync(path.join(dir, ".schema-v5"))).toBe(true);
    for (const [table, col] of V6_COLUMNS) expect(columnsOf(db, table)).not.toContain(col);
    for (const table of V6_TABLES) expect(tablesOf(db)).not.toContain(table);

    execFileSync("sqlite3", [db, `
      INSERT INTO claude_requests(request_id, ts, tokens_out, tokens_cache_creation) VALUES('req_v5', 1750000000, 42, 100);
      INSERT INTO claude_ingest_cursor(file_path, bytes_read, mtime, updated_at) VALUES('/f.jsonl', 10, 20, 30);
      INSERT INTO claude_daily_rollups(day, cost_usd, tokens_out) VALUES('2026-09-10', 1.5, 42);
      INSERT INTO claude_project_rollups(project_key, day, cost_usd) VALUES('/p', '2026-09-10', 1.5);
      INSERT INTO claude_profile_daily(day, window_requests, tool_covered, total) VALUES('2026-09-10', 5, 1, 70);`]);
    const OLD = `
      SELECT request_id, ts, tokens_out, tokens_cache_creation FROM claude_requests;
      SELECT file_path, bytes_read, mtime, updated_at FROM claude_ingest_cursor;
      SELECT day, cost_usd, tokens_out FROM claude_daily_rollups;
      SELECT project_key, day, cost_usd FROM claude_project_rollups;
      SELECT day, window_requests, tool_covered, total FROM claude_profile_daily;`;
    const before = execFileSync("sqlite3", [db, OLD], { encoding: "utf8" });

    // Exactly ONE call at the current version: a second would paper over a
    // failed first, as in the v1 and v2 cases above.
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });

    for (const [table, col] of V6_COLUMNS) {
      expect(`${table}.${col}: ${columnsOf(db, table).includes(col)}`).toBe(`${table}.${col}: true`);
    }
    for (const table of V6_TABLES) expect(tablesOf(db)).toContain(table);
    const indexes = execFileSync("sqlite3", [db,
      "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;"], { encoding: "utf8" });
    for (const idx of ["idx_prompts_session", "idx_request_metrics_day", "idx_turns_day"]) {
      expect(indexes).toContain(idx);
    }
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);
    expect(execFileSync("sqlite3", [db, OLD], { encoding: "utf8" })).toBe(before);
    // New columns on old rows: NULL where NULL means "not recorded", the
    // declared 0 on the regenerable rollups.
    expect(execFileSync("sqlite3", [db, `
      SELECT first_ms IS NULL, last_ms IS NULL, sent_ms IS NULL, cache_write_5m IS NULL,
             cache_write_1h IS NULL, speed IS NULL FROM claude_requests;
      SELECT last_user_ms IS NULL FROM claude_ingest_cursor;
      SELECT cost_table_usd, priced_requests, unpriced_requests, sessions_with_cost FROM claude_daily_rollups;
      SELECT cost_table_usd, priced_requests, unpriced_requests, sessions_with_cost FROM claude_project_rollups;
      SELECT event_covered FROM claude_profile_daily;`], { encoding: "utf8" }).trim())
      .toBe("1|1|1|1|1|1\n1\n0.0|0|0|0\n0.0|0|0|0\n0");
  });

  // Review round 1, Important 1. cc_init_db runs from every hook, the status
  // line, ingest and the rollup, so at upgrade several processes race it, and
  // one ALTER can lose to another writer's lock. The marker used to depend
  // only on the schema apply, which succeeds without the column (CREATE TABLE
  // IF NOT EXISTS leaves an existing table alone): .schema-v6 was stamped, the
  // fast path skipped every later ALTER, and each ingest's upsert failed for
  // good -- silently, under --quiet. A PATH shim fails exactly one ALTER here.
  it("stamps no marker when an ALTER is missed, so the next init adds the column", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v6-probe-"));
    const db = path.join(dir, "fixture.sqlite");
    const shim = path.join(dir, "shim");
    mkdirSync(shim);
    buildV5(db);
    const realSqlite = execFileSync("sh", ["-c", "command -v sqlite3"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(shim, "sqlite3"),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in *"ADD COLUMN sent_ms"*) exit 5 ;; esac; done\nexec "${realSqlite}" "$@"\n`,
      { mode: 0o755 });

    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    expect(columnsOf(db, "claude_requests")).not.toContain("sent_ms");
    expect(columnsOf(db, "claude_requests")).toContain("first_ms");
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(false);

    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    expect(columnsOf(db, "claude_requests")).toContain("sent_ms");
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);
  });
});

// Stage 5 (schema v7): four regenerable agent_* tables and one index. Tables
// only, so no cc_added_columns line -- but the version bump is what lets an
// existing install's init miss the fast path and create them.
const V7_TABLES = ["agent_prices", "agent_request_metrics", "agent_daily_rollups", "agent_progress"];
function indexesOf(db: string): string[] {
  return execFileSync("sqlite3", [db, "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;"],
    { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}

describe("schema v7", () => {
  it("creates the four agent tables and their index on a fresh DB, and stamps the current marker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v7-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V7_TABLES) expect(tablesOf(db)).toContain(table);
    expect(indexesOf(db)).toContain("idx_agent_request_metrics_day");
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);
  });

  it("adds them to a real v5 database in one cc_init_db call", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v7up-"));
    const db = path.join(dir, "fixture.sqlite");
    buildV5(db);
    for (const table of V7_TABLES) expect(tablesOf(db)).not.toContain(table);
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V7_TABLES) expect(tablesOf(db)).toContain(table);
    expect(indexesOf(db)).toContain("idx_agent_request_metrics_day");
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);
  });
});

// Stage 6 (schema v8): five regenerable Character tables. Tables only, so no
// cc_added_columns line; the version bump is what lets an existing install's
// init miss the fast path and create them.
const V8_TABLES = ["claude_model_rollups", "skill_daily", "skill_progress", "skill_level_ups", "skill_pace"];

describe("schema v8", () => {
  it("creates the five Character tables on a fresh DB, and stamps the current marker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v8-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V8_TABLES) expect(tablesOf(db)).toContain(table);
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);
  });

  it("adds them to an older database in one cc_init_db call", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v8up-"));
    const db = path.join(dir, "fixture.sqlite");
    buildV5(db);
    for (const table of V8_TABLES) expect(tablesOf(db)).not.toContain(table);
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V8_TABLES) expect(tablesOf(db)).toContain(table);
  });
});

// Stage 7 (schema v9): Claude's hours by Claude Code skill (regenerable) and each
// skill's pack (durable). Tables only, so no cc_added_columns line.
const V9_TABLES = ["claude_skill_rollups", "claude_skill_packs"];

describe("schema v9", () => {
  it("creates the two skill tables on a fresh DB, and stamps the current schema marker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v9-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V9_TABLES) expect(tablesOf(db)).toContain(table);
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);
  });

  it("adds them to an older database in one cc_init_db call, its rows untouched", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v9up-"));
    const db = path.join(dir, "fixture.sqlite");
    buildV5(db);
    for (const table of V9_TABLES) expect(tablesOf(db)).not.toContain(table);
    execFileSync("sqlite3", [db, "INSERT INTO claude_requests(request_id, ts, tokens_out) VALUES('req_v5', 1750000000, 42);"]);
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V9_TABLES) expect(tablesOf(db)).toContain(table);
    expect(execFileSync("sqlite3", [db, "SELECT request_id, ts, tokens_out FROM claude_requests;"], { encoding: "utf8" }).trim())
      .toBe("req_v5|1750000000|42");
  });
});

// Stage 8 (schema v10): weekly quests, achievement tiers and the two point
// totals, all regenerable. Tables only, so no cc_added_columns line.
const V10_TABLES = ["claude_quests", "achievement_tiers", "character_points"];

describe("schema v10", () => {
  it("creates the three Stage 8 tables on a fresh DB, and stamps the current marker", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v10-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V10_TABLES) expect(tablesOf(db)).toContain(table);
    expect(existsSync(path.join(dir, `.schema-v${schemaVersion()}`))).toBe(true);
  });

  it("adds them to an older database in one cc_init_db call, its rows untouched", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v10up-"));
    const db = path.join(dir, "fixture.sqlite");
    buildV5(db);
    for (const table of V10_TABLES) expect(tablesOf(db)).not.toContain(table);
    execFileSync("sqlite3", [db, "INSERT INTO claude_requests(request_id, ts, tokens_out) VALUES('req_v5', 1750000000, 42);"]);
    execFileSync("bash", ["-c", `. "${LIB_PATH}"; cc_init_db`], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db }, encoding: "utf8",
    });
    for (const table of V10_TABLES) expect(tablesOf(db)).toContain(table);
    expect(execFileSync("sqlite3", [db, "SELECT request_id, ts, tokens_out FROM claude_requests;"], { encoding: "utf8" }).trim())
      .toBe("req_v5|1750000000|42");
  });
});

describe("schema v11", () => {
  // Stage 10 (spec 6.1, R10): a v10 database gains the v11 tables and column in
  // one cc_init_db call, rows untouched. A v10 shape is made from v11 by
  // removing exactly what v11 added, so no old lib.sh is read from git history.
  it("upgrades a v10 database in one call: the v11 tables and column, rows untouched", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v10-"));
    const db = path.join(dir, "claude-code-usage.sqlite");
    const env = { ...process.env, WATCHTOWER_DB_PATH: db, CC_LIB_PATH: LIB_PATH };
    const init = () => execFileSync("bash", ["-c", '. "$CC_LIB_PATH" && cc_init_db'], { env, encoding: "utf8" });
    init();
    // ALTER TABLE ... DROP COLUMN needs sqlite3 3.35 or later (2021); only this fixture uses it, never lib.sh.
    execFileSync("sqlite3", [db, `DROP TABLE claude_discipline_scores_7d; DROP TABLE character_attributes;
      DROP TABLE level_caps; ALTER TABLE skill_pace DROP COLUMN eta_cap_days;
      INSERT INTO skill_pace (source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_day, eta_next_days,
        eta_99_days, streak_current, streak_best) VALUES ('claude', '2026-09-30', 1, 2, 3, 0.1, 4, 5, 6, 7);`]);
    rmSync(path.join(dir, `.schema-v${schemaVersion()}`));
    writeFileSync(path.join(dir, ".schema-v10"), "");
    const tables = () => execFileSync("sqlite3", [db, `SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('claude_discipline_scores_7d', 'character_attributes', 'level_caps') ORDER BY name;`],
      { encoding: "utf8" }).trim();
    expect(tables()).toBe("");
    init();
    expect(tables().split("\n")).toEqual(["character_attributes", "claude_discipline_scores_7d", "level_caps"]);
    expect(execFileSync("sqlite3", [db, "SELECT source, xp_28d, streak_best, eta_cap_days FROM skill_pace;"],
      { encoding: "utf8" }).trim()).toBe("claude|3|7|");
  });
});

// Spec §6: the durable tables -- never rebuilt from the filesystem, unlike
// the regenerable rollup tables rollup.sh legitimately DELETE+re-INSERTs on
// every run -- must never be wiped wholesale by any capture script. A DROP
// TABLE or an unscoped DELETE FROM (no WHERE) on one of these would silently
// destroy history that transcripts can no longer supply once cleanupPeriodDays
// has passed.
describe("durable tables are never wiped by a capture script", () => {
  const DURABLE_TABLES = [
    "claude_requests", "claude_project_paths", "claude_tool_calls", "claude_slash_commands",
    "claude_prompts", "claude_skill_packs",
  ];

  it("no capture/*.sh DROPs a durable table", () => {
    for (const name of SCRIPTS) {
      const src = readFileSync(path.join(CAPTURE, name), "utf8");
      for (const table of DURABLE_TABLES) {
        const found = new RegExp(`DROP\\s+TABLE[^;]*\\b${table}\\b`, "i").test(src);
        expect(`${name}: DROP TABLE ... ${table} present: ${found}`)
          .toBe(`${name}: DROP TABLE ... ${table} present: false`);
      }
    }
  });

  // A scoped delete is fine and already exists in production: rollup.sh's
  // claude_project_paths re-resolution prune carries a WHERE cwd IN (...)
  // clause and touches a handful of "flipped verdict" rows, not the table.
  // What must never appear is DELETE FROM <table> with nothing (or nothing
  // but whitespace) between the table name and the statement's semicolon --
  // the DELETE + re-INSERT idiom rollup.sh uses on the REGENERABLE tables
  // (claude_daily_rollups, claude_project_rollups) applied by mistake to one
  // of these. A WHERE that is always true (WHERE 1, WHERE 1=1, WHERE true,
  // WHERE '1') is the same wipe with the word WHERE in it, so it fails too.
  it("no capture/*.sh runs an unscoped DELETE FROM a durable table", () => {
    for (const name of SCRIPTS) {
      const src = readFileSync(path.join(CAPTURE, name), "utf8");
      for (const table of DURABLE_TABLES) {
        const stmtRe = new RegExp(`DELETE\\s+FROM\\s+${table}\\b([^;]*);`, "gi");
        let m: RegExpExecArray | null;
        while ((m = stmtRe.exec(src)) !== null) {
          const stmt = m[0].replace(/\s+/g, " ").trim();
          expect(`${name}: ${stmt}`).toMatch(/WHERE/i);
          expect(`${name}: ${stmt}`).not.toMatch(/\bWHERE\s+(?:1(?:\s*=\s*1)?|true|'1')\s*;$/i);
        }
      }
    }
  });
});

describe("snapshot.sh execution", () => {
  interface SnapshotRow {
    session_id: string;
    cwd: string;
    project_path: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cache_hit_percentage: number;
    total_cost_usd: number;
  }

  function makeTestEnv() {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-snap-"));
    const dbPath = path.join(dir, "snap.sqlite");
    return {
      dbPath,
      env: {
        CC_LIB_PATH: LIB_PATH,
        WATCHTOWER_DB_PATH: dbPath,
        // Isolate the throttle marker dir (${TMPDIR:-/tmp}/cc-snap/<session>)
        // per test so runs can never collide with each other or real sessions.
        TMPDIR: path.join(dir, "tmp"),
      },
    };
  }

  function runSnapshot(input: string, env: Record<string, string>): string {
    return execFileSync("bash", [SNAPSHOT_PATH], {
      env: { ...process.env, ...env },
      input,
      encoding: "utf8",
    });
  }

  function readSnapshots(dbPath: string): SnapshotRow[] {
    const out = execFileSync(
      "sqlite3",
      ["-json", dbPath, "SELECT * FROM claude_status_snapshots;"],
      { encoding: "utf8" },
    );
    return out.trim() === "" ? [] : (JSON.parse(out) as SnapshotRow[]);
  }

  it("writes a row with correctly aligned columns", () => {
    const { dbPath, env } = makeTestEnv();
    const sessionId = `test-snapshot-row-${randomUUID()}`;
    const input = JSON.stringify({
      session_id: sessionId,
      cwd: "/tmp/some/project",
      model: { display_name: "Claude Sonnet 5" },
      effort: { level: "high" },
      thinking: { enabled: true },
      context_window: {
        used_percentage: 42.5,
        context_window_size: 200000,
        current_usage: {
          input_tokens: 1234,
          output_tokens: 567,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      },
      cost: {
        total_cost_usd: 0.1234,
        total_duration_ms: 60000,
        total_api_duration_ms: 5000,
        total_lines_added: 12,
        total_lines_removed: 3,
      },
      rate_limits: {
        five_hour: { used_percentage: 10.5 },
        seven_day: { used_percentage: 20.5 },
      },
    });

    const out = runSnapshot(input, env);
    expect(out).toBe("");

    const rows = readSnapshots(dbPath);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.session_id).toBe(sessionId);
    expect(row.cwd).toBe("/tmp/some/project");
    expect(row.model).toBe("Claude Sonnet 5");
    expect(row.input_tokens).toBe(1234);
    expect(row.output_tokens).toBe(567);
    expect(row.cache_read_tokens).toBe(10);
    expect(row.cache_creation_tokens).toBe(5);
    // 100 * 10/(10+5) = 66.6667 — this single assertion catches any shift in
    // the 21-column INSERT's VALUES alignment.
    expect(row.cache_hit_percentage).toBeCloseTo(66.6667, 3);
    expect(row.total_cost_usd).toBeCloseTo(0.1234, 4);
  });

  it("throttles: a second invocation within 60s for the same session inserts no additional row", () => {
    const { dbPath, env } = makeTestEnv();
    const sessionId = `test-snapshot-throttle-${randomUUID()}`;
    const input = JSON.stringify({ session_id: sessionId, cwd: "/tmp/proj", model: "m" });

    runSnapshot(input, env);
    runSnapshot(input, env);

    expect(readSnapshots(dbPath)).toHaveLength(1);
  });

  // Regression: the session id is a PATH COMPONENT in the throttle marker. With
  // it interpolated raw, an id containing '/' made the marker write fail, so the
  // 60s throttle stopped working for that session and EVERY status-line render
  // inserted another row — which is precisely the duplicate-snapshot shape that
  // used to fan out in the rollup and double the session's daily numbers.
  it("still throttles a session id containing a slash", () => {
    const { dbPath, env } = makeTestEnv();
    const input = JSON.stringify({
      session_id: `a/b/../c-${randomUUID()}`,
      cwd: "/tmp/proj",
      model: "m",
    });

    expect(runSnapshot(input, env)).toBe("");
    expect(runSnapshot(input, env)).toBe("");

    expect(readSnapshots(dbPath)).toHaveLength(1);
  });

  // Not theoretical: cc_sqlstr emitted LITERAL backslashes ('o\\'\\'brien'),
  // sqlite3 rejected the whole statement as a parse error, and cc_sql swallows
  // errors by design — so every snapshot from a path containing an apostrophe
  // was silently dropped, with nothing on stdout or stderr to say so. Assert the
  // row lands AND round-trips, not just that the script exited 0.
  it("writes a row for a cwd containing an apostrophe", () => {
    const { dbPath, env } = makeTestEnv();
    const sessionId = `test-quote-${randomUUID()}`;
    const cwd = "/Users/x/O'Brien's project";
    const input = JSON.stringify({ session_id: sessionId, cwd, model: { display_name: "m" } });

    expect(runSnapshot(input, env)).toBe("");

    const rows = readSnapshots(dbPath);
    expect(rows).toHaveLength(1);
    expect(rows[0].cwd).toBe(cwd);
    expect(rows[0].session_id).toBe(sessionId);
  });

  it("records the git toplevel, not the cwd, for a subdirectory of a repo", () => {
    const { dbPath, env } = makeTestEnv();
    const sessionId = `test-projpath-${randomUUID()}`;
    const input = JSON.stringify({
      session_id: sessionId,
      cwd: path.join(ROOT, "capture"),   // a SUBDIRECTORY of the repo
      model: { display_name: "m" },
    });

    expect(runSnapshot(input, env)).toBe("");

    const out = execFileSync(
      "sqlite3", ["-json", dbPath, "SELECT project_path, cwd FROM claude_status_snapshots;"],
      { encoding: "utf8" },
    );
    const rows = JSON.parse(out) as { project_path: string; cwd: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].cwd).toBe(path.join(ROOT, "capture"));
    expect(rows[0].project_path).toBe(ROOT);   // resolved UP to the toplevel
  });

  // Same defect as hook.sh's: `basename` on the already-fetched toplevel forks a
  // subprocess per snapshot where ${proj##*/} is exact, and a cwd beginning with
  // "-" makes it write "basename: illegal option" to stderr and return nothing.
  // snapshot.sh runs from the status line, where stderr is just as visible.
  it("labels a cwd that begins with a dash, silently on stdout and stderr", () => {
    const { dbPath, env } = makeTestEnv();
    const sessionId = `test-dash-${randomUUID()}`;
    const r = spawnSync("bash", [SNAPSHOT_PATH], {
      env: { ...process.env, ...env },
      input: JSON.stringify({ session_id: sessionId, cwd: "-dash-dir", model: { display_name: "m" } }),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    const got = execFileSync("sqlite3", ["-json", dbPath, "SELECT repo FROM claude_status_snapshots;"],
      { encoding: "utf8" });
    expect((JSON.parse(got) as { repo: string }[])[0].repo).toBe("-dash-dir");
  });

  it("fails silently (exit 0, empty stdout) when CC_LIB_PATH is missing", () => {
    const { env } = makeTestEnv();
    const out = runFromFile(SNAPSHOT_PATH, '{"session_id":"test-snapshot-nolib"}', {
      ...env,
      CC_LIB_PATH: "/nonexistent/lib.sh",
    });
    expect(out).toBe("");
  });

  it("fails silently (exit 0, empty stdout) on empty stdin", () => {
    const { env } = makeTestEnv();
    const out = runSnapshot("", env);
    expect(out).toBe("");
  });

  it("fails silently (exit 0, empty stdout) on malformed JSON", () => {
    const { env } = makeTestEnv();
    const out = runSnapshot("{not json", env);
    expect(out).toBe("");
  });

  // Same failure mode as the slash case, one step further in. Flattening '/' to
  // '_' is not enough on its own: an id of "." or ".." survives the substitution
  // unchanged and names a DIRECTORY that already exists (the marker dir itself,
  // or its parent). `: > "$marker"` then fails silently, the 60s throttle never
  // engages for that session, and every status-line render inserts another row —
  // the duplicate-snapshot shape the rollup's _snap fan-out used to double.
  it.each([".", ".."])("still throttles a session id of %j", (sessionId) => {
    const { dbPath, env } = makeTestEnv();
    const input = JSON.stringify({ session_id: sessionId, cwd: "/tmp/proj", model: "m" });

    expect(runSnapshot(input, env)).toBe("");
    expect(runSnapshot(input, env)).toBe("");

    expect(readSnapshots(dbPath)).toHaveLength(1);
  });
});
