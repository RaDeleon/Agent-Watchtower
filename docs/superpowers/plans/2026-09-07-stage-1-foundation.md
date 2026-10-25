# Claude-Watchtower Stage 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the capture layer under version control, with config-driven
paths, an idempotent installer, and regression tests that lock in the activity
model's three hard-won rules.

**Architecture:** The shell scripts in `capture/` are the single source of truth
for the activity model and own every database write. TypeScript never
recomputes activity — it will only read derived tables (Stage 2). Stage 1 ships
no UI; its deliverable is a trustworthy, tested, installable capture layer.

**Tech Stack:** Node 22, TypeScript 5, vitest 4, bash, sqlite3 3.51, jq 1.8.

**Spec:** `docs/superpowers/specs/2026-09-07-claude-watchtower-design.md`

## Global Constraints

- **Capture scripts must never break Claude Code.** Scoped to the paths Claude
  Code itself invokes: `hook.sh` and `snapshot.sh` exit 0 silently on any
  missing dependency or DB error, writing nothing to stdout, always. The
  constraint is about not breaking the caller, not about the exit code as such.
  `rollup.sh` is ALSO run by hand (`claude-usage-rollup.sh`), where a silent
  exit 0 on a failed rebuild would be a misfeature — an operator needs to know
  the rebuild did not happen. It therefore keeps three `exit 1` paths (missing
  library, missing `sqlite3`/`jq`, failed rebuild). The first always reports on
  stderr; the other two go quiet under `--quiet` but still exit 1, which is why
  the installer's fail-safe suffix is load-bearing rather than decoration.
  Claude Code is protected there by the `; ... >/dev/null 2>&1 || true` suffix
  the installer writes into `SESSION_END_CMD`, which is asserted by
  `tests/install.test.ts` precisely because it is what makes this safe.
- **The activity model exists in exactly one place:** `capture/rollup.sh`, in
  the `_act` CTE. No TypeScript reimplementation, ever. `capture/lib.sh` holds
  the schema and SQL helpers only — no part of the model lives there.
- **Activity model constants:** think cap `300` seconds, work sanity cap
  `14400` seconds. Defined once in `capture/rollup.sh`, and guarded there by
  `tests/capture-scripts.test.ts`.
- **Session duration is `window_s`**, never `ended_at - started_at`.
- **A gap ending at `UserPromptSubmit` is think-capped regardless of state.**
- **Rank ladder (engaged hours):** 0 / 20 / 100 / 300 / 800 / 2000 / 5000 →
  Noobie / Apprentice / Builder / Intermediate / Advanced / Pro / Master.
- **Default database path:** `~/.theone/claude-code-usage.sqlite`, overridable
  via config and the `THEONE_DB_PATH` environment variable.
- **Install paths are the existing ones** — `~/.claude/cc-track-lib.sh`,
  `~/.claude/hooks/cc-track-hook.sh`, `~/.claude/claude-usage-rollup.sh`. A
  second set of hooks would double-count every session.
- **Never overwrite `~/.claude/statusline.sh`.** It is the user's own display.
- `shellcheck` is **not** installed on this machine. Use `bash -n` for shell
  syntax checks.
- Every destructive install step backs up to `~/.claude/backups/` first.

---

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | deps + scripts (`test`, `typecheck`) |
| `tsconfig.json` | TS config, `@/*` path alias |
| `vitest.config.ts` | test runner config |
| `.gitignore` | node_modules, .next, local config |
| `watchtower.config.example.json` | documented default config |
| `lib/config.ts` | resolve config + paths; the only place defaults live |
| `capture/lib.sh` | schema, SQL helpers (no part of the activity model) |
| `capture/hook.sh` | 8-event writer |
| `capture/rollup.sh` | **the activity model**, derived rollups + rank |
| `capture/snapshot.sh` | token/cost snapshot writer (stdin JSON) |
| `capture/install.sh` | idempotent installer |
| `tests/fixtures/make-fixture.sh` | builds a DB from a named event scenario |
| `tests/config.test.ts` | config resolution |
| `tests/capture-scripts.test.ts` | shell syntax + required functions |
| `tests/activity-model.test.ts` | **the three regression tests** |
| `tests/install.test.ts` | installer into a temp HOME |

---

### Task 1: Project scaffold and config resolution

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `lib/config.ts`, `watchtower.config.example.json`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing (first task)
- Produces:
  - `interface WatchtowerConfig { schemaVersion: number; database: { path: string }; capture: { installDir: string }; proxy: { baseUrl: string }; coach: { mode: "cli" | "api"; apiKey: string | null } }`
  - `function expandHome(p: string): string`
  - `function loadConfig(opts?: { configPath?: string; env?: NodeJS.ProcessEnv }): WatchtowerConfig`

- [ ] **Step 1: Create the project files**

`package.json`:

```json
{
  "name": "claude-watchtower",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.8"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "baseUrl": ".",
    "paths": { "@/*": ["./*"] }
  },
  "include": ["lib/**/*.ts", "tests/**/*.ts", "*.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
  test: { environment: "node" },
});
```

`.gitignore`:

```
node_modules/
.next/
watchtower.config.json
*.log
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Write the failing test**

`tests/config.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expandHome, loadConfig } from "@/lib/config";

describe("expandHome", () => {
  it("expands a leading ~ to the home directory", () => {
    const out = expandHome("~/.theone/db.sqlite");
    expect(out.startsWith("~")).toBe(false);
    expect(out.endsWith("/.theone/db.sqlite")).toBe(true);
  });

  it("leaves absolute paths untouched", () => {
    expect(expandHome("/tmp/x.sqlite")).toBe("/tmp/x.sqlite");
  });
});

describe("loadConfig", () => {
  it("returns documented defaults when no config file exists", () => {
    const c = loadConfig({ configPath: "/nonexistent/watchtower.config.json", env: {} });
    expect(c.schemaVersion).toBe(1);
    expect(c.database.path.endsWith("/.theone/claude-code-usage.sqlite")).toBe(true);
    expect(c.capture.installDir.endsWith("/.claude")).toBe(true);
    expect(c.proxy.baseUrl).toBe("http://localhost:8080");
    expect(c.coach.mode).toBe("cli");
    expect(c.coach.apiKey).toBeNull();
  });

  it("merges a partial config file over the defaults", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "watchtower.config.json");
    writeFileSync(p, JSON.stringify({ proxy: { baseUrl: "http://localhost:9999" } }));
    const c = loadConfig({ configPath: p, env: {} });
    expect(c.proxy.baseUrl).toBe("http://localhost:9999");
    expect(c.coach.mode).toBe("cli");
  });

  it("lets THEONE_DB_PATH override the config file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "watchtower.config.json");
    writeFileSync(p, JSON.stringify({ database: { path: "/from/file.sqlite" } }));
    const c = loadConfig({ configPath: p, env: { THEONE_DB_PATH: "/from/env.sqlite" } });
    expect(c.database.path).toBe("/from/env.sqlite");
  });

  it("throws a clear error on malformed JSON", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-"));
    const p = path.join(dir, "watchtower.config.json");
    writeFileSync(p, "{ not json");
    expect(() => loadConfig({ configPath: p, env: {} })).toThrow(/watchtower\.config\.json/);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — cannot resolve `@/lib/config`.

- [ ] **Step 5: Write the implementation**

`lib/config.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface WatchtowerConfig {
  schemaVersion: number;
  database: { path: string };
  capture: { installDir: string };
  proxy: { baseUrl: string };
  coach: { mode: "cli" | "api"; apiKey: string | null };
}

/** Expand a leading `~` to the current user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function defaults(): WatchtowerConfig {
  return {
    schemaVersion: 1,
    database: { path: path.join(os.homedir(), ".theone", "claude-code-usage.sqlite") },
    capture: { installDir: path.join(os.homedir(), ".claude") },
    proxy: { baseUrl: "http://localhost:8080" },
    coach: { mode: "cli", apiKey: null },
  };
}

/**
 * Resolve configuration. Precedence, lowest to highest:
 *   built-in defaults  <  config file  <  environment variables
 *
 * Config errors are LOUD (they throw) — unlike the capture scripts, which must
 * fail silently so they can never break Claude Code.
 */
export function loadConfig(
  opts: { configPath?: string; env?: NodeJS.ProcessEnv } = {}
): WatchtowerConfig {
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? path.join(process.cwd(), "watchtower.config.json");
  const cfg = defaults();

  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      throw new Error(`Invalid JSON in watchtower.config.json at ${configPath}: ${String(e)}`);
    }
    const f = parsed as Partial<WatchtowerConfig>;
    if (typeof f.schemaVersion === "number") cfg.schemaVersion = f.schemaVersion;
    if (f.database?.path) cfg.database.path = expandHome(f.database.path);
    if (f.capture?.installDir) cfg.capture.installDir = expandHome(f.capture.installDir);
    if (f.proxy?.baseUrl) cfg.proxy.baseUrl = f.proxy.baseUrl;
    if (f.coach?.mode) cfg.coach.mode = f.coach.mode;
    if (f.coach?.apiKey !== undefined) cfg.coach.apiKey = f.coach.apiKey;
  }

  if (env.THEONE_DB_PATH) cfg.database.path = expandHome(env.THEONE_DB_PATH);
  if (env.WATCHTOWER_PROXY_URL) cfg.proxy.baseUrl = env.WATCHTOWER_PROXY_URL;

  return cfg;
}
```

`watchtower.config.example.json`:

```json
{
  "schemaVersion": 1,
  "database": { "path": "~/.theone/claude-code-usage.sqlite" },
  "capture": { "installDir": "~/.claude" },
  "proxy": { "baseUrl": "http://localhost:8080" },
  "coach": { "mode": "cli", "apiKey": null }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: 6 tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore lib/config.ts watchtower.config.example.json tests/config.test.ts
git commit -m "feat(config): project scaffold and config resolution

Defaults < config file < environment. Config errors throw loudly, unlike the
capture scripts which must fail silently so they never break Claude Code."
```

---

### Task 2: Vendor the capture scripts

**Files:**
- Create: `capture/lib.sh`, `capture/hook.sh`, `capture/rollup.sh`, `capture/snapshot.sh`
- Test: `tests/capture-scripts.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (shell side is independent)
- Produces: shell functions used by Tasks 3 and 4 —
  `cc_db_path()`, `cc_have_deps()`, `cc_init_db()`, `cc_sql(sql)`,
  `cc_sqlstr(v)`, `cc_sqlnum(v)`, `cc_now()`, `cc_repo(dir)`,
  `cc_terminal_app()`, and `CC_SCHEMA_VERSION`.
  Scripts honour `THEONE_DB_PATH` and source their library via
  `${CC_LIB_PATH:-$HOME/.claude/cc-track-lib.sh}`.

- [ ] **Step 1: Copy the live scripts into the repo**

These four are the current, working rev-3 implementations. Copy them verbatim
first; adjust only what Step 2 specifies.

```bash
mkdir -p capture
cp ~/.claude/cc-track-lib.sh          capture/lib.sh
cp ~/.claude/hooks/cc-track-hook.sh   capture/hook.sh
cp ~/.claude/claude-usage-rollup.sh   capture/rollup.sh
chmod +x capture/*.sh
```

- [ ] **Step 2: Make the library path overridable**

In `capture/hook.sh` and `capture/rollup.sh`, replace the hardcoded library
lookup so tests can point at the repo copy instead of the installed one.

Find in `capture/hook.sh`:

```bash
LIB="$HOME/.claude/cc-track-lib.sh"
```

Replace with:

```bash
LIB="${CC_LIB_PATH:-$HOME/.claude/cc-track-lib.sh}"
```

Apply the same substitution in `capture/rollup.sh` (it sources the library the
same way).

- [ ] **Step 3: Write `capture/snapshot.sh`**

This is the snapshot writer extracted from `~/.claude/statusline.sh` into a
standalone script. It reads the Claude Code status-line JSON on **stdin** and
writes one throttled row. It is deliberately silent and always exits 0.

```bash
#!/usr/bin/env bash
# snapshot.sh — write one throttled status-line snapshot row.
#
# Reads the Claude Code status-line JSON on stdin. Throttled to at most one row
# per session per 60s via a marker file, matching the inline writer it replaces.
#
# Silent and exit-0 always: a snapshot failure must never affect the status line.

LIB="${CC_LIB_PATH:-$HOME/.claude/cc-track-lib.sh}"
[ -f "$LIB" ] || exit 0
# shellcheck source=/dev/null
. "$LIB"
cc_have_deps || exit 0

input="$(cat 2>/dev/null)"
[ -z "$input" ] && exit 0
jqget() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

session="$(jqget '.session_id')"
[ -z "$session" ] && exit 0

# ---- throttle: one row per session per 60s -------------------------------
marker_dir="${TMPDIR:-/tmp}/cc-snap"
marker="$marker_dir/$session"
mkdir -p "$marker_dir" 2>/dev/null
if [ -f "$marker" ]; then
  mt=$(stat -f %m "$marker" 2>/dev/null || stat -c %Y "$marker" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - mt )) -lt 60 ] && exit 0
fi
: > "$marker" 2>/dev/null   # claim the slot before doing work

dir="$(jqget '.cwd')"
model="$(jqget '.model.display_name // .model.id // .model')"
effort="$(jqget '.effort.level')"
thinking="$(jqget '.thinking.enabled')"
think=0; [ "$thinking" = "true" ] && think=1
repo=""; [ -n "$dir" ] && repo="$(cc_repo "$dir")"

ctx_pct="$(jqget '.context_window.used_percentage')"
ctx_size="$(jqget '.context_window.context_window_size // .context_window.size')"
tok_in="$(jqget '.context_window.current_usage.input_tokens // .usage.input_tokens')"
tok_out="$(jqget '.context_window.current_usage.output_tokens // .usage.output_tokens')"
tok_cr="$(jqget '.context_window.current_usage.cache_read_input_tokens // .usage.cache_read_input_tokens')"
tok_cw="$(jqget '.context_window.current_usage.cache_creation_input_tokens // .usage.cache_creation_input_tokens')"
cost="$(jqget '.cost.total_cost_usd')"
dur_ms="$(jqget '.cost.total_duration_ms')"
api_ms="$(jqget '.cost.total_api_duration_ms')"
added="$(jqget '.cost.total_lines_added')"
removed="$(jqget '.cost.total_lines_removed')"
r5="$(jqget '.rate_limits.five_hour.used_percentage')"
r7="$(jqget '.rate_limits.seven_day.used_percentage')"

cache_hit=""
if [ -n "$tok_cr" ] && [ -n "$tok_cw" ]; then
  cache_hit=$(awk -v r="$tok_cr" -v w="$tok_cw" 'BEGIN{t=r+w; if(t>0) printf "%.4f", 100.0*r/t; else printf ""}')
fi

cc_init_db
cc_sql "INSERT INTO claude_status_snapshots (
  session_id, ts, cwd, repo, model, effort, thinking_enabled,
  context_used_percentage, context_window_size,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_hit_percentage,
  total_cost_usd, total_duration_ms, total_api_duration_ms, total_lines_added, total_lines_removed,
  five_hour_rate_limit_used_percentage, seven_day_rate_limit_used_percentage)
  VALUES (
  $(cc_sqlstr "$session"), $(cc_now), $(cc_sqlstr "$dir"), $(cc_sqlstr "$repo"), $(cc_sqlstr "$model"),
  $(cc_sqlstr "$effort"), $think,
  $(cc_sqlnum "$ctx_pct"), $(cc_sqlnum "$ctx_size"),
  $(cc_sqlnum "$tok_in"), $(cc_sqlnum "$tok_out"), $(cc_sqlnum "$tok_cr"), $(cc_sqlnum "$tok_cw"), $(cc_sqlnum "$cache_hit"),
  $(cc_sqlnum "$cost"), $(cc_sqlnum "$dur_ms"), $(cc_sqlnum "$api_ms"), $(cc_sqlnum "$added"), $(cc_sqlnum "$removed"),
  $(cc_sqlnum "$r5"), $(cc_sqlnum "$r7"));"
exit 0
```

Then: `chmod +x capture/snapshot.sh`

- [ ] **Step 4: Write the failing test**

`tests/capture-scripts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const CAPTURE = path.resolve(__dirname, "..", "capture");
const SCRIPTS = ["lib.sh", "hook.sh", "rollup.sh", "snapshot.sh"];

describe("capture scripts", () => {
  it.each(SCRIPTS)("%s is syntactically valid bash", (name) => {
    expect(() => execFileSync("bash", ["-n", path.join(CAPTURE, name)])).not.toThrow();
  });

  it("lib.sh defines every helper the other scripts rely on", () => {
    const src = readFileSync(path.join(CAPTURE, "lib.sh"), "utf8");
    for (const fn of [
      "cc_db_path", "cc_have_deps", "cc_init_db", "cc_sql",
      "cc_sqlstr", "cc_sqlnum", "cc_now", "cc_repo", "cc_terminal_app",
    ]) {
      expect(src).toContain(`${fn}(`);
    }
    expect(src).toMatch(/CC_SCHEMA_VERSION=\d+/);
  });

  it("carries the rev-3 activity model constants exactly once", () => {
    const src = readFileSync(path.join(CAPTURE, "rollup.sh"), "utf8");
    expect(src).toContain("MIN(gap, 300)");
    expect(src).toContain("MIN(gap, 14400)");
    expect(src).toContain("window_s");
  });

  it("lets the library path be overridden for testing", () => {
    for (const name of ["hook.sh", "rollup.sh", "snapshot.sh"]) {
      const src = readFileSync(path.join(CAPTURE, name), "utf8");
      expect(src).toContain("${CC_LIB_PATH:-");
    }
  });

  it("never writes to stdout on a missing library", () => {
    const out = execFileSync("bash", [path.join(CAPTURE, "hook.sh")], {
      env: { ...process.env, CC_LIB_PATH: "/nonexistent/lib.sh" },
      input: "{}",
      encoding: "utf8",
    });
    expect(out).toBe("");
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test tests/capture-scripts.test.ts`
Expected: all PASS. If "lets the library path be overridden" fails, Step 2 was
not applied to every script.

- [ ] **Step 6: Commit**

```bash
git add capture tests/capture-scripts.test.ts
git commit -m "feat(capture): vendor the tracker scripts under version control

The rev-3 scripts move out of loose files in ~/.claude and into git, where the
activity model can be reviewed and tested. Library path is overridable via
CC_LIB_PATH so tests run against the repo copy.

snapshot.sh is new: the writer extracted from statusline.sh so Watchtower never
has to own the user's status line display."
```

---

### Task 3: Fixture database and the three regression tests

**Files:**
- Create: `tests/fixtures/make-fixture.sh`
- Test: `tests/activity-model.test.ts`

**Interfaces:**
- Consumes: `capture/lib.sh` (schema via `cc_init_db`), `capture/rollup.sh`
- Produces: `tests/fixtures/make-fixture.sh <scenario> <db-path>` where
  `<scenario>` is one of `resumed`, `missing-stop`, `long-run`.

**Why these three:** each is a regression of a real bug found on 2026-09-07.
They must never be deleted.

- [ ] **Step 1: Write the fixture builder**

`tests/fixtures/make-fixture.sh`:

```bash
#!/usr/bin/env bash
# make-fixture.sh <scenario> <db-path>
#
# Builds a capture DB containing one synthetic session, so the activity model
# can be asserted against a known event stream.
set -euo pipefail

scenario="${1:?scenario required}"
db="${2:?db path required}"
lib="$(cd "$(dirname "$0")/../../capture" && pwd)/lib.sh"

export THEONE_DB_PATH="$db"
# shellcheck source=/dev/null
. "$lib"
cc_init_db

BASE=1750000000   # fixed epoch so tests are deterministic
DAY=86400

ev() {  # ev <session> <offset-seconds> <event-name>
  cc_sql "INSERT INTO claude_events (ts, session_id, hook_event_name, cwd, repo)
          VALUES ($((BASE + $2)), '$1', '$3', '/tmp/fx', 'fx');"
}
sess() { # sess <session> <start-offset>
  cc_sql "INSERT INTO claude_sessions (session_id, started_at, updated_at, cwd, repo, prompts)
          VALUES ('$1', $((BASE + $2)), $((BASE + $2)), '/tmp/fx', 'fx', 1);"
}

case "$scenario" in
  resumed)
    # Two minutes of real work, then the SAME session_id resumed 30 days later.
    # Naive (ended_at - started_at) would book 30 days.
    sess S_RESUMED 0
    ev S_RESUMED 0    SessionStart
    ev S_RESUMED 2    UserPromptSubmit
    ev S_RESUMED 120  Stop
    ev S_RESUMED 120  SessionEnd
    ev S_RESUMED $((30 * DAY))        SessionStart
    ev S_RESUMED $((30 * DAY + 600))  SessionEnd
    cc_sql "UPDATE claude_sessions SET ended_at = $((BASE + 30 * DAY + 600)) WHERE session_id='S_RESUMED';"
    ;;
  missing-stop)
    # A turn with NO Stop event, then a 3-hour walk-away before the next prompt.
    # Without the UserPromptSubmit override this bills 3h of "task time".
    sess S_NOSTOP 0
    ev S_NOSTOP 0      SessionStart
    ev S_NOSTOP 10     UserPromptSubmit
    ev S_NOSTOP 10820  UserPromptSubmit   # +3h
    ev S_NOSTOP 10880  Stop
    ev S_NOSTOP 10880  SessionEnd
    cc_sql "UPDATE claude_sessions SET ended_at = $((BASE + 10880)) WHERE session_id='S_NOSTOP';"
    ;;
  long-run)
    # A 20-minute autonomous run. The old gap<=600 rule discarded this entirely.
    sess S_LONG 0
    ev S_LONG 0     SessionStart
    ev S_LONG 10    UserPromptSubmit
    ev S_LONG 1210  Stop               # +20 min of task
    ev S_LONG 1220  SessionEnd
    cc_sql "UPDATE claude_sessions SET ended_at = $((BASE + 1220)) WHERE session_id='S_LONG';"
    ;;
  *)
    echo "unknown scenario: $scenario" >&2; exit 1 ;;
esac
```

Then: `chmod +x tests/fixtures/make-fixture.sh`

- [ ] **Step 2: Write the failing test**

`tests/activity-model.test.ts`:

```ts
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const MAKE = path.join(ROOT, "tests", "fixtures", "make-fixture.sh");
const ROLLUP = path.join(ROOT, "capture", "rollup.sh");
const LIB = path.join(ROOT, "capture", "lib.sh");

/** Build a fixture DB for a scenario, run the rollup over it, return the DB path. */
function buildAndRoll(scenario: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `wt-${scenario}-`));
  const db = path.join(dir, "fixture.sqlite");
  execFileSync("bash", [MAKE, scenario, db], { encoding: "utf8" });
  execFileSync("bash", [ROLLUP, "--quiet"], {
    env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB },
    encoding: "utf8",
  });
  return db;
}

/** Sum a column across claude_daily_rollups, in seconds. */
function seconds(db: string, column: "active_ms" | "total_session_ms"): number {
  const out = execFileSync("sqlite3", [db, `SELECT COALESCE(SUM(${column}),0)/1000.0 FROM claude_daily_rollups;`], {
    encoding: "utf8",
  });
  return Number(out.trim());
}

describe("activity model rev 3 — regressions of real bugs", () => {
  describe("a resumed session must not book its dormant weeks", () => {
    let db: string;
    beforeAll(() => { db = buildAndRoll("resumed"); });

    it("books minutes, not 30 days", () => {
      // Naive ended_at - started_at would be 2,592,600s. Real work is ~2 min.
      expect(seconds(db, "total_session_ms")).toBeLessThan(3600);
    });

    it("counts the real turn as active", () => {
      // UserPromptSubmit(+2) -> Stop(+120) = 118s of work.
      expect(seconds(db, "active_ms")).toBeGreaterThanOrEqual(118);
      expect(seconds(db, "active_ms")).toBeLessThan(600);
    });
  });

  describe("a missing Stop must not turn a walk-away into task time", () => {
    let db: string;
    beforeAll(() => { db = buildAndRoll("missing-stop"); });

    it("caps the 3-hour gap at the 5-minute think cap", () => {
      // The gap ENDS at UserPromptSubmit, so it is think time: 300s, not 10800s.
      expect(seconds(db, "active_ms")).toBeLessThan(700);
    });
  });

  describe("a long autonomous run must be counted in full", () => {
    let db: string;
    beforeAll(() => { db = buildAndRoll("long-run"); });

    it("counts all 20 minutes, not zero", () => {
      // The old gap<=600 rule scored this 0. Work time is 1200s.
      expect(seconds(db, "active_ms")).toBeGreaterThanOrEqual(1200);
    });
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `npm test tests/activity-model.test.ts`
Expected: 4 tests PASS.

If "counts all 20 minutes" fails with ~0, `capture/rollup.sh` still carries the
old `gap <= 600` rule — re-check Task 2 Step 1 copied the current file.

- [ ] **Step 4: Verify the tests actually detect the bugs**

Temporarily break the model to confirm the tests are real, then restore.

In `capture/rollup.sh`, change `MIN(gap, 300)` to `MIN(gap, 14400)` on the
`UserPromptSubmit` line only. Run: `npm test tests/activity-model.test.ts`
Expected: the "missing Stop" test FAILS.

Restore the line. Run again. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures tests/activity-model.test.ts
git commit -m "test(capture): lock in the three activity-model regressions

Each is a real bug from 2026-09-07:
- a resumed session_id booking 1,308 hours of dormant calendar time
- a missing Stop event billing a walk-away as task time
- the gap<=600 rule discarding long autonomous runs entirely

Verified the tests fail when the model is broken, not just pass when it works."
```

---

### Task 4: The installer

**Files:**
- Create: `capture/install.sh`
- Test: `tests/install.test.ts`

**Interfaces:**
- Consumes: `capture/lib.sh`, `capture/hook.sh`, `capture/rollup.sh`, `capture/snapshot.sh`
- Produces: `capture/install.sh`, honouring `CLAUDE_DIR` (default `$HOME/.claude`)
  so it can be tested against a temporary directory.

- [ ] **Step 1: Write the installer**

`capture/install.sh`:

```bash
#!/usr/bin/env bash
# install.sh — install the Watchtower capture layer into a Claude Code config dir.
#
# Idempotent: safe to run repeatedly. Backs up anything it replaces into
# <CLAUDE_DIR>/backups/ before writing.
#
# Deliberately installs to the EXISTING tracker paths. A second set of hooks
# under new names would fire alongside the old ones and double-count every
# session.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
HOOKS_DIR="$CLAUDE_DIR/hooks"
BACKUP_DIR="$CLAUDE_DIR/backups"
SETTINGS="$CLAUDE_DIR/settings.json"
STAMP="$(date +%Y%m%d-%H%M%S)"

command -v jq >/dev/null 2>&1 || { echo "install: jq is required" >&2; exit 1; }

mkdir -p "$HOOKS_DIR" "$BACKUP_DIR"

backup() { [ -f "$1" ] && cp "$1" "$BACKUP_DIR/$(basename "$1").$STAMP" || true; }

# ---- 1. scripts ------------------------------------------------------------
install_script() { # install_script <src-name> <dest-path>
  backup "$2"
  cp "$SRC/$1" "$2"
  chmod +x "$2"
}
install_script lib.sh      "$CLAUDE_DIR/cc-track-lib.sh"
install_script hook.sh     "$HOOKS_DIR/cc-track-hook.sh"
install_script rollup.sh   "$CLAUDE_DIR/claude-usage-rollup.sh"
install_script snapshot.sh "$CLAUDE_DIR/watchtower-snapshot.sh"

# ---- 2. hooks in settings.json --------------------------------------------
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
backup "$SETTINGS"

HOOK="$HOOKS_DIR/cc-track-hook.sh"
ROLLUP="$CLAUDE_DIR/claude-usage-rollup.sh"
# SessionEnd chains the rollup AFTER the hook so the session's ended_at is
# written before the rebuild reads it. Without this the rollup only ever ran
# from the cc launcher's exit trap, and derived tables silently froze.
SESSION_END_CMD="$HOOK; $ROLLUP --quiet >/dev/null 2>&1 || true"

tmp="$(mktemp)"
jq --arg hook "$HOOK" --arg sessionEnd "$SESSION_END_CMD" '
  def ensure($event; $cmd):
    .hooks[$event] = (
      ((.hooks[$event] // []) | map(select(
        [.hooks[]?.command] | index($cmd) | not
      ))) + [{ hooks: [{ type: "command", command: $cmd }] }]
    );
  .hooks = (.hooks // {})
  | ensure("SessionStart";     $hook)
  | ensure("UserPromptSubmit"; $hook)
  | ensure("Stop";             $hook)
  | ensure("SubagentStart";    $hook)
  | ensure("SubagentStop";     $hook)
  | ensure("PreCompact";       $hook)
  | ensure("PostCompact";      $hook)
  | ensure("SessionEnd";       $sessionEnd)
' "$SETTINGS" > "$tmp"

jq empty "$tmp" 2>/dev/null || { echo "install: refusing to write invalid settings.json" >&2; rm -f "$tmp"; exit 1; }
mv "$tmp" "$SETTINGS"

# ---- 3. snapshot wiring ----------------------------------------------------
# The user's statusline.sh may ALREADY contain an inline snapshot writer. Adding
# a second one would insert every snapshot row twice, so only wire it up when no
# writer is present. The display itself is never modified.
STATUSLINE="$CLAUDE_DIR/statusline.sh"
if [ -f "$STATUSLINE" ] && grep -q "claude_status_snapshots" "$STATUSLINE"; then
  echo "install: existing snapshot capture detected in statusline.sh — leaving it alone"
else
  echo "install: no snapshot capture found; wire $CLAUDE_DIR/watchtower-snapshot.sh into your status line"
fi

echo "install: done (backups in $BACKUP_DIR)"
```

Then: `chmod +x capture/install.sh`

- [ ] **Step 2: Write the failing test**

`tests/install.test.ts`:

```ts
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const INSTALL = path.resolve(__dirname, "..", "capture", "install.sh");

function run(claudeDir: string): string {
  return execFileSync("bash", [INSTALL], {
    env: { ...process.env, CLAUDE_DIR: claudeDir },
    encoding: "utf8",
  });
}
const settings = (d: string) => JSON.parse(readFileSync(path.join(d, "settings.json"), "utf8"));
const commands = (d: string, event: string): string[] =>
  (settings(d).hooks[event] ?? []).flatMap((e: { hooks?: { command: string }[] }) =>
    (e.hooks ?? []).map((h) => h.command)
  );

describe("install.sh", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "wt-install-"));
    run(dir);
  });

  it("installs the scripts to the existing tracker paths", () => {
    expect(existsSync(path.join(dir, "cc-track-lib.sh"))).toBe(true);
    expect(existsSync(path.join(dir, "hooks", "cc-track-hook.sh"))).toBe(true);
    expect(existsSync(path.join(dir, "claude-usage-rollup.sh"))).toBe(true);
    expect(existsSync(path.join(dir, "watchtower-snapshot.sh"))).toBe(true);
  });

  it("registers the hook on all eight events", () => {
    for (const ev of ["SessionStart", "UserPromptSubmit", "Stop", "SubagentStart",
                      "SubagentStop", "PreCompact", "PostCompact", "SessionEnd"]) {
      expect(commands(dir, ev).length).toBeGreaterThan(0);
    }
  });

  it("chains the rollup after the hook on SessionEnd", () => {
    const cmd = commands(dir, "SessionEnd")[0];
    expect(cmd).toContain("cc-track-hook.sh");
    expect(cmd).toContain("claude-usage-rollup.sh --quiet");
    expect(cmd.indexOf("cc-track-hook.sh")).toBeLessThan(cmd.indexOf("claude-usage-rollup.sh"));
  });

  it("is idempotent — a second run adds no duplicate hooks", () => {
    const before = commands(dir, "SessionStart").length;
    run(dir);
    expect(commands(dir, "SessionStart").length).toBe(before);
    expect(commands(dir, "SessionEnd").length).toBe(1);
  });

  it("preserves unrelated settings and existing hooks", () => {
    const d2 = mkdtempSync(path.join(tmpdir(), "wt-install2-"));
    writeFileSync(path.join(d2, "settings.json"), JSON.stringify({
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
    }));
    run(d2);
    expect(settings(d2).model).toBe("opus");
    expect(commands(d2, "Stop")).toContain("echo mine");
    expect(commands(d2, "Stop").some((c) => c.includes("cc-track-hook.sh"))).toBe(true);
  });

  it("backs up a settings.json it modifies", () => {
    const d3 = mkdtempSync(path.join(tmpdir(), "wt-install3-"));
    writeFileSync(path.join(d3, "settings.json"), JSON.stringify({ model: "sonnet" }));
    run(d3);
    const backups = readdirSync(path.join(d3, "backups"));
    expect(backups.some((f) => f.startsWith("settings.json."))).toBe(true);
  });

  it("does not add a second snapshot writer when one already exists", () => {
    const d4 = mkdtempSync(path.join(tmpdir(), "wt-install4-"));
    writeFileSync(path.join(d4, "statusline.sh"), "# INSERT INTO claude_status_snapshots ...");
    const out = run(d4);
    expect(out).toContain("leaving it alone");
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `npm test tests/install.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 4: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests PASS (config 6, capture 8, activity 4, install 7), typecheck clean.

- [ ] **Step 5: Verify against the real machine — READ ONLY**

Do **not** run `install.sh` against the live `~/.claude` yet. Instead confirm
the repo scripts still agree with the installed ones:

```bash
diff ~/.claude/cc-track-lib.sh        capture/lib.sh      && echo "lib: identical"
diff ~/.claude/claude-usage-rollup.sh capture/rollup.sh   || echo "rollup: differs only by CC_LIB_PATH — expected"
```

Expected: `lib.sh` identical; `rollup.sh` differs only in the `LIB=` line.

- [ ] **Step 6: Commit**

```bash
git add capture/install.sh tests/install.test.ts
git commit -m "feat(capture): idempotent installer

Installs to the existing tracker paths on purpose — a second set of hooks under
new names would fire alongside the old ones and double-count every session.

Backs up anything it replaces, refuses to write invalid settings.json, and
detects an existing snapshot writer rather than adding a duplicate."
```

---

## Stage 1 Done When

- [ ] `npm test` — 25 tests pass across 4 files
- [ ] `npm run typecheck` — clean
- [ ] `capture/` holds the four scripts plus the installer, all in git
- [ ] The three regression tests demonstrably fail when the model is broken
- [ ] `install.sh` is idempotent and backs up before writing
- [ ] The live `~/.claude` is untouched by this stage

**Next:** Stage 2 (hooks dashboard) gets its own plan, written against the code
this stage produces.
