import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { loadConfig } from "@/lib/config";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { slow } from "./helpers/timeout";

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "capture", "lib.sh");
const ROLLUP = path.join(ROOT, "capture", "rollup.sh");
const MAKE = path.join(ROOT, "tests", "fixtures", "make-fixture.sh");

/** Run the rollup again over an existing fixture DB, with explicit argv/env. */
function runRollup(db: string, args: string[], extraEnv: Record<string, string> = {}): void {
  execFileSync("bash", [ROLLUP, ...args], {
    env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB, TZ: "UTC", ...extraEnv },
    encoding: "utf8",
  });
}

/** Build a fixture DB WITHOUT running the rollup, so the caller controls the first run's argv/env. */
function build(scenario: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `wt-${scenario}-`));
  const db = path.join(dir, "fixture.sqlite");
  execFileSync("bash", [MAKE, scenario, db], { encoding: "utf8" });
  return db;
}

function countPaths(db: string): number {
  return rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_project_paths;")[0]?.n ?? 0;
}

describe("cwd -> project resolution", () => {
  const evalIn = (expr: string): string =>
    execFileSync("bash", ["-c", `. "${LIB}"; ${expr}`], { encoding: "utf8" }).trim();

  it("cc_is_excluded matches a prefix and a glob, and rejects a near miss", () => {
    // Prefix: everything under the directory is excluded.
    expect(evalIn(`cc_is_excluded "/a/b/c" "/a/b" && echo YES || echo NO`)).toBe("YES");
    // Glob: Claude mints a new scratchpad per session, so the pattern must match
    // paths that do not exist yet.
    expect(evalIn(`cc_is_excluded "/private/tmp/claude-501/xyz" "/private/tmp/claude-*" && echo YES || echo NO`)).toBe("YES");
    // A near miss must NOT be excluded: /a/bc is not under /a/b.
    expect(evalIn(`cc_is_excluded "/a/bc" "/a/b" && echo YES || echo NO`)).toBe("NO");
    // No patterns at all: nothing is excluded.
    expect(evalIn(`cc_is_excluded "/a/b" && echo YES || echo NO`)).toBe("NO");
  });
});

describe("the resolution step", () => {
  interface PathRow { cwd: string; project_path: string | null; source: string }

  it("records the four outcomes and never re-resolves a cached cwd", () => {
    const db = buildAndRoll("four-projects");
    const got = rows<PathRow>(db, "SELECT cwd, project_path, source FROM claude_project_paths ORDER BY cwd;");

    const bySuffix = (s: string) => got.find((r) => r.cwd.endsWith(s));

    // a real repo -> resolved to its toplevel
    expect(bySuffix("/repo-a")?.source).toBe("git");
    expect(bySuffix("/repo-a")?.project_path).toContain("/repo-a");
    // a SUBDIRECTORY of that repo -> same toplevel, its own cache row
    expect(bySuffix("/repo-a/sub")?.project_path).toBe(bySuffix("/repo-a")?.project_path);
    // a real directory that is not a repo -> resolved, but NULL path
    expect(bySuffix("/plain-dir")?.source).toBe("git");
    expect(bySuffix("/plain-dir")?.project_path).toBeNull();
    // a directory that does not exist -> gone, and never resolvable
    expect(bySuffix("/vanished")?.source).toBe("gone");
    expect(bySuffix("/vanished")?.project_path).toBeNull();
  });

  it("keeps a cached answer after the directory is deleted", () => {
    // The whole reason the cache exists. Resolve while the directory is there,
    // delete it, rebuild, and the attribution must survive.
    const db = buildAndRoll("four-projects");
    const before = rows<PathRow>(db, "SELECT project_path FROM claude_project_paths WHERE cwd LIKE '%/repo-a';");
    execFileSync("rm", ["-rf", String(rows<{ cwd: string }>(db, "SELECT cwd FROM claude_project_paths WHERE cwd LIKE '%/repo-a';")[0].cwd)]);
    execFileSync("bash", [ROLLUP, "--quiet"], {
      env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB, TZ: "UTC" },
      encoding: "utf8",
    });
    const after = rows<PathRow>(db, "SELECT project_path, source FROM claude_project_paths WHERE cwd LIKE '%/repo-a';");
    expect(after[0].project_path).toBe(before[0].project_path);
    expect(after[0].source).toBe("git");   // NOT downgraded to 'gone'
  });

  // The resolution SELECT UNIONs claude_requests.cwd with claude_events.cwd,
  // because the transcripts surface cwds the event stream never saw -- every
  // session that ran before the tracker was installed. Deleting that arm left
  // the whole suite green: no other fixture has a cwd that appears in
  // claude_requests and in no event, so such a cwd would silently stay
  // unresolved, key to (unfiled) forever, and take its tokens with it.
  it("resolves a cwd that appears only in claude_requests, never in an event", () => {
    const db = buildAndRoll("request-only-projects", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });
    // The premise, asserted rather than assumed: neither cwd is in the events.
    const eventCwds = rows<{ n: number }>(db,
      `SELECT COUNT(*) AS n FROM claude_events
       WHERE cwd LIKE '%/proj-beta' OR cwd LIKE '%/skipme';`)[0].n;
    expect(`proj-beta/skipme event rows: ${eventCwds}`).toBe("proj-beta/skipme event rows: 0");

    const got = rows<PathRow>(db, "SELECT cwd, project_path, source FROM claude_project_paths ORDER BY cwd;");
    const bySuffix = (s: string) => got.find((r) => r.cwd.endsWith(s));
    // A requests-only repo resolves to its real toplevel, not to nothing.
    expect(bySuffix("/proj-beta")?.source).toBe("git");
    expect(bySuffix("/proj-beta")?.project_path).toContain("/proj-beta");
    // ...and a requests-only cwd is still subject to the exclusion verdict.
    expect(bySuffix("/skipme")?.source).toBe("excluded");
  });

  it("marks an excluded cwd as excluded rather than resolving it", () => {
    const db = buildAndRoll("four-projects", {
      WATCHTOWER_EXCLUDE_PATHS: "*/repo-a",   // exclude the one real repo
    });
    const got = rows<{ cwd: string; source: string }>(
      db, "SELECT cwd, source FROM claude_project_paths WHERE cwd LIKE '%/repo-a';");
    expect(got[0].source).toBe("excluded");
  });

  // Pins the space-splitting regression: an unquoted `$WATCHTOWER_EXCLUDE_PATHS`
  // expansion word-splits on IFS, which includes space by default. Three of the
  // five real default patterns contain a space (Library/Application Support/...),
  // so an unquoted expansion silently produces patterns that match nothing and
  // the excluded cwd gets resolved as a normal project instead.
  it("excludes a cwd whose exclude pattern contains a space", () => {
    const db = buildAndRoll("four-projects", {
      WATCHTOWER_EXCLUDE_PATHS: "*/space dir/repo-a",
    });
    const got = rows<{ cwd: string; source: string }>(
      db, "SELECT cwd, source FROM claude_project_paths WHERE cwd LIKE '%/repo-a';");
    expect(got[0].source).toBe("excluded");
  });
});

// Spec 4.5: "It also keeps the choice reversible: dropping an entry from
// excludePaths and rebuilding brings the history back, because nothing was
// destroyed." The cache was write-once (INSERT OR IGNORE over cwds NOT IN the
// cache), so an excluded cwd stayed (excluded) forever and a newly added
// exclusion never reached already-cached history. No existing test changed an
// exclusion BETWEEN runs, which is exactly why this was invisible.
describe("exclusion decisions are re-evaluated on every run", () => {
  interface PathRow { cwd: string; project_path: string | null; source: string }
  const repoA = (db: string): PathRow =>
    rows<PathRow>(db, "SELECT cwd, project_path, source FROM claude_project_paths WHERE cwd LIKE '%/repo-a';")[0];
  const keys = (db: string): string[] =>
    rows<{ project_key: string }>(db, "SELECT DISTINCT project_key FROM claude_project_rollups ORDER BY project_key;")
      .map((r) => r.project_key);

  it("brings history back when an exclusion is dropped, and takes it away when one is added", () => {
    const db = build("four-projects");
    // Two patterns, because the fixture holds the repo AND a subdirectory of it
    // as separate cwds resolving to the same key, and cc_is_excluded matches a
    // GLOB against the cwd itself (its prefix rule is for literal paths only).
    // Excluding the repo cwd alone would leave the subdirectory keyed to the
    // toplevel, and the key would not disappear.
    const EXCLUDE = "*/repo-a\n*/repo-a/*";

    // Run 1 — the one real repo is excluded.
    runRollup(db, ["--quiet"], { WATCHTOWER_EXCLUDE_PATHS: EXCLUDE });
    expect(repoA(db).source).toBe("excluded");
    expect(repoA(db).project_path).toBeNull();
    expect(keys(db)).toContain("(excluded)");

    // Run 2 — exclusion dropped. The cwd must be re-resolved to its real
    // project, and its hours must reappear under that key.
    runRollup(db, ["--quiet"], { WATCHTOWER_EXCLUDE_PATHS: "" });
    expect(repoA(db).source).toBe("git");
    expect(repoA(db).project_path).toContain("/repo-a");
    expect(keys(db).some((k) => k.endsWith("/repo-a"))).toBe(true);

    // Run 3 — exclusion added back. Already-cached history must follow it,
    // which means deleting a real resolved project_path: correct here, because
    // the user has just asked for that path to be excluded.
    runRollup(db, ["--quiet"], { WATCHTOWER_EXCLUDE_PATHS: EXCLUDE });
    expect(repoA(db).source).toBe("excluded");
    expect(repoA(db).project_path).toBeNull();
    expect(keys(db)).toContain("(excluded)");
    expect(keys(db).some((k) => k.endsWith("/repo-a"))).toBe(false);
  });

  // The DELETEs share the per-run resolve budget. Uncapped, a run could delete
  // more rows than it could re-resolve in the same pass, and a deleted row is
  // unresolved until re-resolved -- which keys it to (unfiled), a bucket the
  // reader DISPLAYS. Work the user has just asked to hide would sit in the most
  // visible place for a run or more. Measured before the cap, at budget 1 with
  // three flipped verdicts: (excluded) 1 / (unfiled) 4, then 2/3, then 3/2.
  it("never deletes more flipped cwds in a run than it can re-resolve in the same pass", () => {
    const db = buildAndRoll("four-projects");   // all four cached, none excluded
    expect(countPaths(db)).toBe(4);
    const bySource = (src: string): number => rows<{ n: number }>(
      db, `SELECT COUNT(*) AS n FROM claude_project_paths WHERE source ${src};`)[0].n;
    expect(bySource("= 'excluded'")).toBe(0);

    // Flip THREE verdicts at once against a budget of one.
    const EXCLUDE = "*/repo-a\n*/repo-a/*\n*/plain-dir";
    for (const expected of [1, 2, 3]) {
      runRollup(db, ["--quiet"], { WATCHTOWER_EXCLUDE_PATHS: EXCLUDE, WATCHTOWER_RESOLVE_PER_RUN: "1" });
      // The cache never shrinks: everything deleted this run was re-resolved in
      // it, so nothing is parked in (unfiled) waiting for a later run.
      expect(`cached ${countPaths(db)}, excluded ${bySource("= 'excluded'")}`)
        .toBe(`cached 4, excluded ${expected}`);
    }

    // And with flips on BOTH sides in the same run -- one exclusion dropped,
    // one added -- the budget is still ONE budget. Bounding each direction
    // separately would let such a run delete twice what it can re-resolve.
    const BOTH = "*/repo-a\n*/repo-a/*\n*/vanished";   // un-excludes plain-dir, excludes vanished
    for (let run = 0; run < 2; run++) {
      runRollup(db, ["--quiet"], { WATCHTOWER_EXCLUDE_PATHS: BOTH, WATCHTOWER_RESOLVE_PER_RUN: "1" });
      expect(`run ${run}: cached ${countPaths(db)}`).toBe(`run ${run}: cached 4`);
    }
    expect(bySource("= 'excluded'")).toBe(3);   // repo-a, repo-a/sub, vanished
  });

  it("keeps a resolved project cached after its directory is deleted, across a re-evaluating run", () => {
    // The property the cache exists for, re-asserted now that rows can be
    // deleted: re-evaluation must only ever touch the exclusion decision.
    const db = buildAndRoll("four-projects");
    const before = repoA(db);
    execFileSync("rm", ["-rf", before.cwd]);
    runRollup(db, ["--quiet"]);
    expect(repoA(db).project_path).toBe(before.project_path);
    expect(repoA(db).source).toBe("git");
  });

  it("skips resolution entirely when git is not on PATH, rather than poisoning the cache", () => {
    // Without git, cc_project_path returns empty and the cwd would be cached as
    // source='git', project_path=NULL -- permanently indistinguishable from "a
    // real directory that is not a repo", and this table is never rebuilt.
    const bin = mkdtempSync(path.join(tmpdir(), "wt-nogit-"));
    for (const tool of ["bash", "sh", "sqlite3", "jq", "date", "awk", "dirname",
                        "basename", "mkdir", "rm", "cat", "sed", "grep", "env"]) {
      let p = "";
      try { p = execFileSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(); } catch { /* absent */ }
      if (p) symlinkSync(p, path.join(bin, tool));
    }
    // The shim PATH really has no git, or this test proves nothing.
    let gitFound = "yes";
    try { execFileSync(path.join(bin, "bash"), ["-c", "command -v git"], { env: { PATH: bin }, encoding: "utf8" }); }
    catch { gitFound = "no"; }
    expect(`git on shim PATH: ${gitFound}`).toBe("git on shim PATH: no");

    const db = build("four-projects");
    runRollup(db, ["--quiet"], { PATH: bin });
    expect(countPaths(db)).toBe(0);

    // ...and the next run, with git present, does it.
    runRollup(db, ["--quiet"]);
    expect(countPaths(db)).toBe(4);
  });
});

// `${VAR:-default}` substitutes the default when VAR is empty AS WELL AS when it
// is unset, so an explicitly empty list silently resurrected all five shipped
// defaults -- contradicting the comment above it, lib/config.ts (where
// excludePaths: [] excludes exactly nothing) and the parity test pinning the two
// together. `${VAR-default}` substitutes only when unset.
describe("an explicitly empty WATCHTOWER_EXCLUDE_PATHS", () => {
  // A cwd matching a SHIPPED default pattern (/private/tmp/claude-*) and which
  // does not exist, so with the defaults off it resolves down the normal path
  // to 'gone' rather than 'excluded'. A pattern-free fixture path could not
  // tell the two readings of the expansion apart.
  const DEFAULT_MATCH = "/private/tmp/claude-wt-empty-exclude-fixture";
  const seed = (): string => {
    const db = build("four-projects");
    execFileSync("sqlite3", [db, `UPDATE claude_events SET cwd = '${DEFAULT_MATCH}' WHERE session_id = 'S_GONE';`]);
    return db;
  };
  const sourceOf = (db: string): string | undefined =>
    rows<{ source: string }>(db, `SELECT source FROM claude_project_paths WHERE cwd = '${DEFAULT_MATCH}';`)[0]?.source;

  it("excludes nothing", () => {
    const db = seed();
    runRollup(db, ["--quiet"], { WATCHTOWER_EXCLUDE_PATHS: "" });
    expect(sourceOf(db)).toBe("gone");
  });

  it("still applies the shipped defaults when the variable is UNSET", () => {
    const db = seed();
    runRollup(db, ["--quiet"]);
    expect(sourceOf(db)).toBe("excluded");
  });
});

// Step 13 of the brief measured the first-run cost against a ~1s budget: on the
// real DB (75 distinct cwds) an ordinary rollup run resolving all of them took
// ~1.2s, over budget. Per the brief's own contingency, the bulk resolve is
// gated behind an explicit `--resolve` flag; an ordinary hook-invoked run
// resolves at most WATCHTOWER_RESOLVE_PER_RUN new cwds so no single SessionEnd
// hook invocation can be blown up by a burst of new projects.
describe("the resolve budget gate", () => {
  it("caps how many NEW cwds an ordinary run resolves, and catches up over repeated runs", () => {
    const db = build("four-projects");   // 4 distinct cwds, none resolved yet
    const env = { WATCHTOWER_RESOLVE_PER_RUN: "2" };

    runRollup(db, ["--quiet"], env);
    expect(countPaths(db)).toBe(2);

    runRollup(db, ["--quiet"], env);
    expect(countPaths(db)).toBe(4);
  });

  it("--resolve ignores the per-run cap and resolves everything in one pass", () => {
    const db = build("four-projects");
    runRollup(db, ["--quiet", "--resolve"], { WATCHTOWER_RESOLVE_PER_RUN: "2" });
    expect(countPaths(db)).toBe(4);
  });

  // WATCHTOWER_RESOLVE_PER_RUN is the one value in the capture layer that is
  // interpolated into SQL rather than encoded by cc_sqlstr/cc_sqlnum, so it is
  // validated in rollup.sh as a positive integer. Unvalidated, "abc" made the
  // SELECT a syntax error; cc_sql_val swallows errors by design, so the resolve
  // loop silently resolved NOTHING -- at rc=0, with the reconciliation identity
  // still passing, every project stuck at (unfiled) forever. And
  // "20; DROP TABLE claude_daily_rollups" ran as a second statement.
  // Six fixture builds and six rollups, run serially: 4.6 s of vitest's 5 s
  // default on main under the full suite's load, so the Stage 5 agent section
  // (one more sqlite3 run per rollup) tipped it over. Hence its own budget.
  it("falls back to the default cap when WATCHTOWER_RESOLVE_PER_RUN is not a positive integer", () => {
    const bad = ["abc", "-1", "0", "1.5", " 4", "20; DROP TABLE claude_daily_rollups"];
    for (const v of bad) {
      const db = build("four-projects");   // 4 distinct cwds, none resolved yet
      runRollup(db, ["--quiet"], { WATCHTOWER_RESOLVE_PER_RUN: v });
      // The default cap is 20, so all four resolve: a bad value must behave as
      // if it were absent, never as "resolve nothing".
      expect(`${JSON.stringify(v)} -> ${countPaths(db)} cached`).toBe(`${JSON.stringify(v)} -> 4 cached`);
      // and nothing it contained reached SQL as a statement.
      const tables = rows<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='claude_daily_rollups';`,
      )[0].n;
      expect(`${JSON.stringify(v)} -> daily table present: ${tables === 1}`).toBe(
        `${JSON.stringify(v)} -> daily table present: true`,
      );
    }
  }, slow(30_000));
});

describe("per-project rollups reconcile with the daily rollups", () => {
  // EVERY reconcilable column, mapped to its claude_daily_rollups counterpart
  // per the schema in capture/lib.sh. This test used to loop four of the
  // thirteen columns there were then -- and the nine it skipped (tokens
  // in/out/cache-read/cache-creation, cost, compacts, clears, subagents) are
  // precisely what the Stage 1 fan-out corrupted, which is the whole reason the
  // identity exists. Stage 4B added the last four (17).
  // Not listed, and deliberately: cache_hit_percentage, avg_context_pct,
  // peak_context_pct and hygiene_score are ratios/extrema, not additive, so
  // they have no per-day sum to reconcile; repos_json/models_json are shaped
  // differently on the two sides; display_name and updated_at are metadata.
  const COLUMNS: Array<{ proj: string; daily: string; epsilon?: number }> = [
    { proj: "active_ms",             daily: "active_ms" },
    { proj: "window_ms",             daily: "total_session_ms" },
    { proj: "idle_ms",               daily: "idle_ms" },
    { proj: "sessions_count",        daily: "sessions_count" },
    { proj: "prompts",               daily: "prompts" },
    { proj: "compacts",              daily: "compacts" },
    { proj: "clears",                daily: "clears" },
    { proj: "subagents",             daily: "subagents" },
    { proj: "tokens_in",             daily: "tokens_in" },
    { proj: "tokens_out",            daily: "tokens_out" },
    { proj: "tokens_cache_read",     daily: "tokens_cache_read" },
    { proj: "tokens_cache_creation", daily: "tokens_cache_creation" },
    // cost_usd is REAL on both sides and the two SUMs add the same values in a
    // different ORDER, so the last bits can differ legitimately. Compared
    // against a small epsilon rather than exactly: 1e-9 is a nano-dollar
    // against figures in the single dollars -- tight enough that any real
    // fan-out (which duplicates a whole session's cost) still fails loudly.
    { proj: "cost_usd",              daily: "cost_usd", epsilon: 1e-9 },
    // Stage 4B: cost at API prices, and the counts that say how much of the day it covers.
    { proj: "cost_table_usd",        daily: "cost_table_usd", epsilon: 1e-9 },
    { proj: "priced_requests",       daily: "priced_requests" },
    { proj: "unpriced_requests",     daily: "unpriced_requests" },
    { proj: "sessions_with_cost",    daily: "sessions_with_cost" },
  ];

  type Totals = Record<string, string | number>;

  function assertReconciles(db: string): void {
    const daily = rows<Totals>(db, `SELECT day,
        ${COLUMNS.map((c) => `${c.daily} AS ${c.proj}`).join(", ")}
      FROM claude_daily_rollups ORDER BY day;`);
    const proj = rows<Totals>(db, `SELECT day,
        ${COLUMNS.map((c) => `SUM(${c.proj}) AS ${c.proj}`).join(", ")}
      FROM claude_project_rollups GROUP BY day ORDER BY day;`);

    expect(daily.length, "fixture produced no daily rows to reconcile").toBeGreaterThan(0);
    expect(proj.map((r) => r.day)).toEqual(daily.map((r) => r.day));
    for (let i = 0; i < daily.length; i++) {
      for (const c of COLUMNS) {
        const d = Number(daily[i][c.proj]);
        const p = Number(proj[i][c.proj]);
        if (c.epsilon === undefined) {
          expect(`${daily[i].day} ${c.proj} = ${p}`).toBe(`${daily[i].day} ${c.proj} = ${d}`);
        } else {
          expect(
            Math.abs(p - d) <= c.epsilon,
            `${daily[i].day} ${c.proj}: per-project ${p} vs daily ${d} (epsilon ${c.epsilon})`,
          ).toBe(true);
        }
      }
    }
  }

  // A single day holding: two real projects, an unresolvable cwd and an excluded
  // cwd. Without all four the identity holds trivially and proves nothing.
  it("matches claude_daily_rollups exactly, per day, across every key", () => {
    assertReconciles(buildAndRoll("mixed-projects-one-day", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" }));
  });

  // The shape where the identity is actually at risk: one session whose TIME
  // splits across two keys while its scalars go whole to one of them. A scalar
  // that forgot its is_dom gate would be counted twice here and nowhere else.
  it("matches on priced-mixed", () => {
    assertReconciles(buildAndRoll("priced-mixed", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" }));
  });

  it("still matches when a session's time splits across two projects", () => {
    assertReconciles(buildAndRoll("session-spans-two-projects"));
  });

  // The defect this catches: aggregating tokens per session and joining into
  // _sx (built FROM claude_sessions) drops every request whose session has no
  // row -- 22.7% of real output tokens -- while BOTH sides omit it equally, so
  // the identity keeps passing. A green suite would certify the shortfall.
  it("counts a request whose session has no claude_sessions row", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const daily = rows<{ tokens_out: number }>(db,
      "SELECT SUM(tokens_out) AS tokens_out FROM claude_daily_rollups;");
    expect(Number(daily[0].tokens_out)).toBe(1500);   // 1000 live + 500 orphan
    const proj = rows<{ tokens_out: number }>(db,
      "SELECT SUM(tokens_out) AS tokens_out FROM claude_project_rollups;");
    expect(Number(proj[0].tokens_out)).toBe(1500);
    assertReconciles(db);
  });

  it("reconciles on a day that has tokens but no sessions", () => {
    const db = buildAndRoll("tokens-only-day");
    const row = rows<{ day: string; sessions_count: number; active_ms: number;
                       tokens_out: number; hygiene_score: number }>(db,
      `SELECT day, sessions_count, active_ms, tokens_out, hygiene_score
       FROM claude_daily_rollups WHERE tokens_out = 4242;`);
    expect(row).toHaveLength(1);
    expect(Number(row[0].sessions_count)).toBe(0);
    expect(Number(row[0].active_ms)).toBe(0);
    // Three of hygiene's four terms are meaningless without a session.
    expect(Number(row[0].hygiene_score)).toBe(0);
    assertReconciles(db);
  });

  // A token-only day has no _sx rows, and both columns are declared TEXT with
  // NO DEFAULT and are never named in the INSERT -- so they are NULL until the
  // UPDATE below them writes an object. Every other day holds an object here,
  // and a NULL is a new shape for any reader to trip on.
  //
  // NOTE on the mechanism: rollup.sh wraps both in COALESCE(..., '{}') per the
  // brief, on the premise that json_group_object over zero rows yields NULL.
  // That premise is FALSE on sqlite3 3.54.0, where it already returns '{}'
  // (verified directly), so the COALESCE is defensive for other builds rather
  // than load-bearing here -- which is why removing it changes nothing. This
  // test pins the OBSERVABLE contract instead of the mechanism: an UPDATE that
  // skips session-less days leaves the schema NULL and fails here.
  it("writes empty JSON objects, not NULL, on a day with no sessions", () => {
    const db = buildAndRoll("tokens-only-day");
    const got = rows<{ repos_json: string | null; models_json: string | null }>(db,
      "SELECT repos_json, models_json FROM claude_daily_rollups WHERE sessions_count = 0;");
    expect(got).toHaveLength(1);
    expect(got[0].repos_json).toBe("{}");
    expect(got[0].models_json).toBe("{}");
  });

  // DELIBERATE, and NOT to be "fixed" to 0.0. A context percentage is a reading
  // taken from a running session; with no session there is no reading, and 0.0
  // would assert "the context was empty all day" -- a fabricated measurement,
  // the same class of error as the 63x/201x status-line token figures this
  // stage exists to remove. NULL is also skipped by AVG(), where a fabricated
  // 0.0 would drag the average down. Both columns are nullable from here on and
  // TheOneOS must treat them as such; rollup.sh says so at the site.
  it("leaves the context percentages NULL, not 0.0, on a day with no sessions", () => {
    const db = buildAndRoll("tokens-only-day");
    const got = rows<{ avg_context_pct: number | null; peak_context_pct: number | null }>(db,
      "SELECT avg_context_pct, peak_context_pct FROM claude_daily_rollups WHERE sessions_count = 0;");
    expect(got).toHaveLength(1);
    expect(got[0].avg_context_pct).toBeNull();
    expect(got[0].peak_context_pct).toBeNull();
    // This fixture's one session has no snapshot either, so its day stores
    // NULL in both too (Stage 4B; pinned in hygiene-rescale.test.ts). That
    // the columns are still WRITTEN on a day with a reading is the guard just
    // below: 50 average, 60 peak.
  });

  // GUARD (Stage 3D fix wave, I5). A session with no status-line snapshot has
  // no context reading. rollup.sh used to COALESCE its average to 0, and
  // AVG(avgctx) then counted it as an empty window: on the live copy ~90% of
  // sessions have no snapshot, so every stored daily average was ~10x low.
  // Planted: restore `COALESCE(c.avgctx,0)` in _sx and this goes red (25, not 50).
  it("averages context over the sessions that were read, never an unread session as 0", () => {
    const db = buildAndRoll("context-unread-session");
    const daily = rows<{ sessions_count: number; avg_context_pct: number | null; peak_context_pct: number | null }>(db,
      "SELECT sessions_count, avg_context_pct, peak_context_pct FROM claude_daily_rollups;");
    expect(daily).toHaveLength(1);
    expect(daily[0].sessions_count).toBe(2);
    expect(daily[0].avg_context_pct).toBeCloseTo(50, 9);
    expect(daily[0].peak_context_pct).toBe(60);
    // The per-project row carries the same per-session class, gated on is_dom.
    const project = rows<{ sessions_count: number; avg_context_pct: number | null }>(db,
      "SELECT sessions_count, avg_context_pct FROM claude_project_rollups;");
    expect(project).toHaveLength(1);
    expect(project[0].sessions_count).toBe(2);
    expect(project[0].avg_context_pct).toBeCloseTo(50, 9);
  });

  // Per-project token attribution: the point of driving the project rollup from
  // _ptok, and previously untested. Every other request-bearing fixture uses
  // /tmp/fx, which keys to (unfiled) whether the cwd -> project_key map works or
  // not, so replacing the whole map with the literal '(unfiled)' left the suite
  // green. The day-level identity structurally cannot catch a mis-keying that
  // preserves the daily sum -- only this can.
  it("routes each request's tokens to the project its own cwd resolves to", () => {
    const db = buildAndRoll("request-only-projects", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });
    const got = rows<{
      project_key: string; tokens_in: number; tokens_out: number;
      tokens_cache_read: number; tokens_cache_creation: number;
    }>(db, `SELECT project_key, tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation
            FROM claude_project_rollups ORDER BY tokens_out;`);
    // The real keys are absolute paths under a per-run temp dir; compare by
    // basename, which is what identifies the project.
    const named = got.map((r) => ({
      ...r,
      project_key: r.project_key.startsWith("/")
        ? r.project_key.slice(r.project_key.lastIndexOf("/") + 1)
        : r.project_key,
    }));
    expect(named).toEqual([
      // proj-alpha's two requests, summed -- not one row copied through.
      { project_key: "proj-alpha", tokens_in: 24, tokens_out: 2208, tokens_cache_read: 320, tokens_cache_creation: 36 },
      { project_key: "proj-beta",  tokens_in: 23, tokens_out: 2903, tokens_cache_read: 370, tokens_cache_creation: 29 },
      { project_key: "(excluded)", tokens_in: 31, tokens_out: 4507, tokens_cache_read: 510, tokens_cache_creation: 37 },
    ]);
    assertReconciles(db);
  });

  // A bare `GROUP BY project_key` in _ptok binds to _pk.project_key, NOT to the
  // COALESCE'd output alias -- SQLite resolves GROUP BY names against the INPUT
  // columns first. A request whose cwd is NULL or empty has no _pk match, so its
  // k.project_key is NULL and it groups SEPARATELY from a resolved-but-unfiled
  // request on the same day, while the SELECT list labels BOTH '(unfiled)'. Two
  // _ptok rows under one key, the project INSERT fans out on them, and
  // UNIQUE(project_key, day) aborts the whole rebuild under .bail on.
  //
  // The damage is not corruption -- the transaction rolls back -- it is SILENCE:
  // the SessionEnd hook runs this as `--quiet >/dev/null 2>&1 || true`, so the
  // tracker would simply stop updating with nothing to see. 0 of 26,858 real
  // requests have a null or empty cwd, so only this fixture reaches it.
  it("folds cwd-less requests into the same (unfiled) row instead of aborting the rebuild", () => {
    // buildAndRoll THROWS if the rollup exits non-zero, so reaching the
    // assertions at all is the first half of this test. Before the fix the
    // rollup exited 1 and left claude_project_rollups empty.
    const db = buildAndRoll("null-cwd-request");
    const got = rows<{
      project_key: string; tokens_in: number; tokens_out: number;
      tokens_cache_read: number; tokens_cache_creation: number;
    }>(db, `SELECT project_key, tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation
            FROM claude_project_rollups;`);
    // ONE row, carrying all three requests: the /tmp/fx one plus the empty-cwd
    // and NULL-cwd ones, which all key to (unfiled).
    expect(got).toEqual([{
      project_key: "(unfiled)",
      tokens_in: 11 + 23 + 31,
      tokens_out: 1000 + 2000 + 4000,
      tokens_cache_read: 130 + 370 + 510,
      tokens_cache_creation: 17 + 29 + 37,
    }]);
    assertReconciles(db);
  });

  // The claude_requests arm of _pk. proj-beta and skipme appear in no
  // claude_events row at all -- the pre-install shape that arm exists for.
  // Deleting it left the whole suite green: both cwds fall out of _pk, the
  // LEFT JOIN in _ptok yields NULL, and every one of their tokens lands in
  // (unfiled) while the daily total is unchanged.
  it("keys a cwd that appears only in claude_requests, never in an event", () => {
    const db = buildAndRoll("request-only-projects", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });
    const keys = rows<{ project_key: string }>(
      db, "SELECT DISTINCT project_key FROM claude_project_rollups ORDER BY project_key;",
    ).map((r) => r.project_key);
    expect(keys.some((k) => k.endsWith("/proj-beta"))).toBe(true);
    expect(keys).toContain("(excluded)");
    // Nothing fell back to the catch-all. This is the assertion that fails the
    // moment either the _pk UNION arm or the resolution UNION arm is removed.
    expect(keys).not.toContain("(unfiled)");
  });

  it("keys excluded and unresolvable work to the reserved keys", () => {
    const db = buildAndRoll("mixed-projects-one-day", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });
    const keys = rows<{ project_key: string }>(
      db, "SELECT DISTINCT project_key FROM claude_project_rollups ORDER BY project_key;",
    ).map((r) => r.project_key);
    expect(keys).toContain("(excluded)");
    expect(keys).toContain("(unfiled)");
    // and two real absolute paths
    expect(keys.filter((k) => k.startsWith("/"))).toHaveLength(2);
  });

  it("records each project's models with their thinking and effort split", () => {
    const db = buildAndRoll("mixed-projects-one-day", { WATCHTOWER_EXCLUDE_PATHS: "*/skipme" });
    const got = rows<{ project_key: string; models_json: string }>(
      db, "SELECT project_key, models_json FROM claude_project_rollups WHERE project_key LIKE '/%';");
    expect(got.length).toBeGreaterThan(0);
    for (const r of got) {
      const parsed = JSON.parse(r.models_json) as Record<string, { sessions: number; thinking: number; effort: Record<string, number> }>;
      const entry = Object.values(parsed)[0];
      expect(entry.sessions).toBe(1);
      expect(typeof entry.thinking).toBe("number");
      // A nested OBJECT, not a JSON string. json_group_object's JSON subtype does
      // not survive the subquery that feeds json_object, so without json(...)
      // around it the value lands as "{\"(none)\":1}" -- and Object.keys of that
      // STRING still has length > 0, so the length assertion below passes
      // spuriously on its own. This line is what makes the shape assertion real.
      expect(typeof entry.effort).toBe("object");
      expect(Object.keys(entry.effort).length).toBeGreaterThan(0);
    }
  });

  it("splits a session's TIME across projects but its scalars to one", () => {
    const db = buildAndRoll("session-spans-two-projects");
    const got = rows<{
      project_key: string; active_ms: number; sessions_count: number; tokens_in: number;
      peak_context_pct: number | null; avg_context_pct: number | null;
    }>(
      db, `SELECT project_key, active_ms, sessions_count, tokens_in,
                  peak_context_pct, avg_context_pct
           FROM claude_project_rollups ORDER BY active_ms DESC;`);

    expect(got).toHaveLength(2);
    // time appears under BOTH projects
    expect(got[0].active_ms).toBeGreaterThan(0);
    expect(got[1].active_ms).toBeGreaterThan(0);
    // the session is counted exactly ONCE, under the dominant one
    expect(got[0].sessions_count + got[1].sessions_count).toBe(1);
    expect(got[0].sessions_count).toBe(1);          // dominant = more active_s
    // Tokens are NOT in the per-session scalar class any more, and this is the
    // one fixture that can tell. Since Stage 2 they come from claude_requests,
    // and a request carries its OWN cwd -- so the NON-dominant project receives
    // its own request's tokens (23) and none of the dominant project's (11).
    // A rollup that kept the is_dom gate would read 34 and 0 here; one that
    // fanned the session out would read 34 and 34.
    expect(got[0].tokens_in).toBe(11);
    expect(got[1].tokens_in).toBe(23);
    // ...and so are the two context columns. Spec 4.6 puts avg_context_pct and
    // peak_context_pct in the per-session class, which goes to the dominant
    // project and to NO other. Neither is in the reconciliation identity, so
    // nothing else would notice them escaping the rule: the non-dominant row
    // read sessions_count = 0 and tokens_in = 0 while still carrying the
    // session's full peak of 10.0%.
    expect(got[0].peak_context_pct).toBeGreaterThan(0);
    expect(got[0].avg_context_pct).toBeGreaterThan(0);
    expect(got[1].peak_context_pct ?? 0).toBe(0);
    expect(got[1].avg_context_pct ?? 0).toBe(0);
  });
});

// The reserved keys are MINTED in capture/rollup.sh and MATCHED by bare string
// equality in lib/projects.ts. Nothing asserted the two agreed: rename the key
// in the shell and the reader silently stops hiding excluded work, inflating
// every displayed session count by the ~74% of sessions exclusions exist to
// remove, while the reconciliation identity keeps passing because it sums all
// keys regardless of name.
describe("the reserved project keys: capture/rollup.sh vs lib/projects.ts", () => {
  it("mints exactly the reserved keys lib/projects.ts matches", () => {
    const shell = readFileSync(ROLLUP, "utf8");
    // The _pk CTE is the ONLY place the keys are minted; rollup.sh says so.
    const startAnchor = "CREATE TEMP TABLE _pk AS";
    const endAnchor = "CREATE INDEX IF NOT EXISTS _pk_cwd";
    const start = shell.indexOf(startAnchor);
    const end = shell.indexOf(endAnchor);
    expect(start, `start anchor not found in rollup.sh: ${JSON.stringify(startAnchor)}`).toBeGreaterThanOrEqual(0);
    expect(end, `end anchor not found in rollup.sh: ${JSON.stringify(endAnchor)}`).toBeGreaterThanOrEqual(0);
    const block = shell.slice(start, end);

    // Every parenthesised SQL string literal the minting CASE can produce.
    // Parenthesised so they cannot collide with a real toplevel, which is
    // always absolute -- so this shape is the definition, not a guess.
    const minted = [...new Set([...block.matchAll(/'(\([^')]*\))'/g)].map((m) => m[1]))].sort();
    expect(minted).toEqual(["(excluded)", "(unfiled)"]);

    const readerPath = path.join(ROOT, "lib", "projects.ts");
    const reader = readFileSync(readerPath, "utf8");
    const matched = [...reader.matchAll(/project_key\s*!==\s*"(\([^"]*\))"/g)].map((m) => m[1]);
    expect(matched.length, `lib/projects.ts matches no reserved key at all (${readerPath})`).toBe(1);

    // Direction 1: the key the reader hides must be one the shell actually
    // mints -- a rename on either side alone fails here.
    for (const k of matched) {
      expect(`${k} minted by rollup.sh: ${minted.includes(k)}`).toBe(`${k} minted by rollup.sh: true`);
    }
    // Direction 2: and it must be the EXCLUDED one. (unfiled) is minted too and
    // is deliberately kept: hiding it would drop real, unattributed work from
    // the table, which is the opposite failure and just as silent.
    expect(matched).toEqual(["(excluded)"]);
    expect(minted.filter((k) => !matched.includes(k))).toEqual(["(unfiled)"]);
  });
});

describe("rollup.sh's hardcoded exclude defaults vs lib/config.ts", () => {
  // rollup.sh runs from the SessionEnd hook where no Node is available to read
  // the JSON config, so it carries its own copy of the exclude defaults. Two
  // hand-maintained copies of the same list will drift silently unless
  // something asserts they match.
  it("keeps rollup.sh's exclude defaults in step with lib/config.ts", () => {
    const shell = readFileSync(path.join(ROOT, "capture", "rollup.sh"), "utf8");
    // ${VAR-...}, NOT ${VAR:-...}: the colon form substitutes on EMPTY as well
    // as unset, which resurrects all five defaults for an explicitly empty list.
    const startAnchor = "WATCHTOWER_EXCLUDE_PATHS=\"${WATCHTOWER_EXCLUDE_PATHS-";
    const endAnchor = "_resolve_new_cwds";
    const start = shell.indexOf(startAnchor);
    const end = shell.indexOf(endAnchor);
    expect(start, `start anchor not found in rollup.sh: ${JSON.stringify(startAnchor)}`).toBeGreaterThanOrEqual(0);
    expect(end, `end anchor not found in rollup.sh: ${JSON.stringify(endAnchor)}`).toBeGreaterThanOrEqual(0);
    const block = shell.slice(start, end);

    const excludePaths = loadConfig({ configPath: "/nonexistent", env: {} }).excludePaths;

    for (const p of excludePaths) {
      const tail = p.replace(homedir(), "");           // $HOME is written as $HOME in the shell
      expect(`${tail} present in rollup.sh: ${block.includes(tail)}`).toBe(`${tail} present in rollup.sh: true`);
    }

    // Direction 2: a pattern added to the shell list but never to lib/config.ts
    // (or removed from one side only) must also fail. Count the non-empty
    // pattern lines inside the heredoc that feeds WATCHTOWER_EXCLUDE_PATHS.
    const heredocStart = block.indexOf("<<EOF");
    const heredocEnd = block.indexOf("\nEOF", heredocStart);
    expect(heredocStart).toBeGreaterThanOrEqual(0);
    expect(heredocEnd).toBeGreaterThanOrEqual(0);
    const heredoc = block.slice(heredocStart + "<<EOF".length, heredocEnd);
    const lineCount = heredoc.split("\n").filter((l) => l.trim() !== "").length;
    expect(lineCount).toBe(excludePaths.length);
  });
});
