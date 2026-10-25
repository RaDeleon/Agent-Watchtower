# Stage 3A — Source-agnostic foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Watchtower a source-agnostic ingestion core — record envelope, adapter contract, `wt_*` schema, authority-enforced ingest, exact identity linking, discovery and an NDJSON boundary — without changing a single byte of the proven Claude capture path.

**Architecture:** A new `lib/core/` owns the normalized layer and its own schema namespace (`wt_*`, `WT_SCHEMA_VERSION`, marker `.wt-schema-v1`), entirely separate from `capture/lib.sh`'s `claude_*` namespace at `CC_SCHEMA_VERSION = 4`. Nothing under `~/.claude` is touched and no reinstall is required. All DB access goes through `execFileSync("sqlite3", …)`, the pattern `lib/projects.ts` already uses.

**Tech Stack:** TypeScript (ESM, `strict`), Node built-ins only, `sqlite3` CLI, vitest.

**Resolved before execution — how the CLI runs TypeScript with no build step.**
Node v24.11.0 (measured on this machine) strips types natively, so
`bin/watchtower` imports `.ts` directly. Native ESM requires **explicit file
extensions** on relative imports, which extensionless `moduleResolution:
"bundler"` does not supply. Therefore:

- `tsconfig.json` gains `"allowImportingTsExtensions": true` (legal only because
  `noEmit: true` is already set).
- **Every relative import inside `lib/core/` and `lib/adapters/` writes the
  `.ts` extension** — `import { execSql } from "./sql.ts"`.
- No build step, no `dist/`, no runtime dependency. `npm test` and
  `node bin/watchtower` both work from the same sources.

Type stripping does not support `enum`, `namespace`, or constructor parameter
properties. This plan uses none of them; do not introduce them.

**Spec:** `docs/superpowers/specs/2026-09-14-stage-3-spec.md` (§2, §3A, §4, §5, §6)
**Architecture:** `docs/superpowers/specs/2026-09-14-stage-3-source-agnostic-architecture.md`

## Global Constraints

- **Zero runtime dependencies.** `package.json` gains no `dependencies` block. Node built-ins and the `sqlite3` CLI only.
- **Nothing under `~/.claude` changes.** No edits to `capture/*.sh`, no `install.sh` changes, no reinstall. (Decision 8.)
- **`CC_SCHEMA_VERSION` stays `4`; `lib/config.ts`'s `schemaVersion` stays `4`.** Stage 3A introduces `WT_SCHEMA_VERSION = 1` as a separate constant. (Spec §2.)
- **No model math in TypeScript.** No `MIN(gap,` anywhere in `lib/`. Grouping, labelling and copying only.
- **A metric the source does not expose is absent, not `0`.** `undefined` and `0` are different facts.
- **Every `wt_*` write is an upsert on its primary key**, making ingest idempotent and cursors advisory.
- **Only `confidence = 'exact'` links are ever written.** (Decision 13.)
- **Tests pin `TZ=UTC`** where any date bucketing is involved.
- Target file size: keep each `lib/core/*.ts` under ~200 lines. Split by responsibility.
- **If `git` is broken, every fixture-backed test fails loudly.**
  `tests/fixtures/make-fixture.sh` shells out to `git`; when `/usr/bin/git` fails
  (e.g. an unaccepted Xcode licence, exit 69) the script aborts under
  `set -euo pipefail`, leaving a database with **zero rows**, and
  `fixture-db.ts`'s `execFileSync` **throws** rather than returning it. So the
  suite goes red — it does not pass vacuously. Prefix commands with
  `DEVELOPER_DIR=/Library/Developer/CommandLineTools` if this happens, and never
  "fix" it by editing `make-fixture.sh` or `fixture-db.ts`.
  *(An earlier revision of this note claimed the failure was silent. It is not;
  verified by running `tests/projects.test.ts` with git broken and watching it
  fail. The non-vacuity guard in Task 1 is kept anyway, as cheap insurance
  against a future fixture path that is more lenient than this one.)*

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/core/sql.ts` | SQL string escaping + `exec`/`query` helpers over the `sqlite3` CLI. The only place that shells out. |
| `lib/core/schema.ts` | `WT_SCHEMA_VERSION`, the `wt_*` DDL, marker name, `applyWtSchema()`. |
| `lib/core/records.ts` | `WatchtowerRecord` type, `validateRecord()`, RFC3339 → epoch. |
| `lib/core/adapters.ts` | `WatchtowerAdapter` interface, source registration, authority lookup. |
| `lib/core/identity.ts` | Canonical id minting, exact link creation and resolution. |
| `lib/core/ingest.ts` | The authority rule; writes `wt_requests` / `wt_usage` / `wt_events` / `wt_tools`; counts rejections. |
| `lib/core/discovery.ts` | `detect()` for each known source. Never throws. |
| `lib/adapters/external/ndjson.ts` | stdin NDJSON → records. |
| `bin/watchtower` | CLI entry: `watchtower ingest --stdin --source <id>`. |
| `tests/regression/baseline.ts` | Baseline generator + comparator. |
| `tests/regression/claude-baseline.json` | **Committed** frozen baseline. |

---

## Task 1: Freeze the Claude regression baseline

Decision 7: the baseline is captured **before any code moves**. This task must land first.

**Files:**
- Create: `tests/regression/baseline.ts`
- Create: `tests/regression/claude-baseline.json` (generated, committed)
- Create: `tests/regression.test.ts`

**Interfaces:**
- Consumes: `tests/helpers/fixture-db.ts` → `buildAndRoll(scenario, extraEnv?) => string`, `rows<T>(db, sql) => T[]`
- Produces: `captureBaseline(db: string): ScenarioBaseline`, `SCENARIOS: string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/regression.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { buildAndRoll } from "./helpers/fixture-db";
import { captureBaseline, SCENARIOS } from "./regression/baseline";

const BASELINE = path.resolve(__dirname, "regression", "claude-baseline.json");

describe("Claude regression baseline", () => {
  it("has a committed baseline file", () => {
    expect(existsSync(BASELINE)).toBe(true);
  });

  it("matches the committed baseline exactly on every scenario", () => {
    const expected = JSON.parse(readFileSync(BASELINE, "utf8"));
    for (const scenario of SCENARIOS) {
      const db = buildAndRoll(scenario);
      expect(`${scenario}: ${JSON.stringify(captureBaseline(db))}`)
        .toBe(`${scenario}: ${JSON.stringify(expected[scenario])}`);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/regression.test.ts`
Expected: FAIL — cannot resolve `./regression/baseline`.

- [ ] **Step 3: Write the baseline generator**

Create `tests/regression/baseline.ts`:

```ts
import { rows } from "../helpers/fixture-db";

/** Every scenario in tests/fixtures/make-fixture.sh. */
export const SCENARIOS = [
  "resumed", "missing-stop", "long-run", "work-cap", "dup-snapshot",
  "two-sessions-day", "crosses-midnight", "four-projects",
  "mixed-projects-one-day", "session-spans-two-projects",
  "recent-and-old-projects", "orphan-request-tokens", "request-only-projects",
  "partial-transcript-coverage", "zero-window-no-coverage", "null-cwd-request",
  "tokens-only-day",
];

export interface ScenarioBaseline {
  daily: unknown[];
  projects: unknown[];
  rank: unknown[];
}

/**
 * The frozen shape of "what Claude numbers are today". Read-only.
 *
 * Column list is explicit rather than SELECT *: a new column added later must
 * not silently widen the baseline and quietly invalidate the comparison.
 */
export function captureBaseline(db: string): ScenarioBaseline {
  return {
    daily: rows(db, `SELECT day, total_session_ms, active_ms, idle_ms,
        sessions_count, tokens_in, tokens_out, tokens_cache_read,
        tokens_cache_creation, cache_hit_percentage, cost_usd, compacts,
        clears, subagents, prompts, avg_context_pct, peak_context_pct,
        hygiene_score
      FROM claude_daily_rollups ORDER BY day;`),
    projects: rows(db, `SELECT project_key, day, display_name, active_ms,
        window_ms, idle_ms, sessions_count, prompts, compacts, clears,
        subagents, tokens_in, tokens_out, tokens_cache_read,
        tokens_cache_creation, cost_usd, peak_context_pct, avg_context_pct
      FROM claude_project_rollups ORDER BY project_key, day;`),
    rank: rows(db, `SELECT total_hours, active_hours, lifetime_cost_usd,
        lifetime_tokens_in, lifetime_tokens_out, sessions_count, rank_index,
        rank_name, hours_into_rank, hours_to_next, next_rank_name, xp,
        hygiene_score
      FROM claude_rank_progress ORDER BY id;`),
  };
}
```

- [ ] **Step 4: Generate and commit the baseline**

Run:

```bash
cd /Users/you/Developer/Coding/personal/Claude-Watchtower
cat > /tmp/gen-baseline.ts <<'EOF'
import { writeFileSync } from "node:fs";
import { buildAndRoll } from "./tests/helpers/fixture-db";
import { captureBaseline, SCENARIOS } from "./tests/regression/baseline";
const out: Record<string, unknown> = {};
for (const s of SCENARIOS) out[s] = captureBaseline(buildAndRoll(s));
writeFileSync("tests/regression/claude-baseline.json", JSON.stringify(out, null, 2) + "\n");
EOF
npx vitest run --no-coverage /dev/null 2>/dev/null || true
npx tsx /tmp/gen-baseline.ts 2>/dev/null || node --experimental-strip-types /tmp/gen-baseline.ts
```

If neither `tsx` nor `--experimental-strip-types` is available (no new deps
allowed), generate it from a throwaway vitest test instead:

```ts
// tests/regression/__generate.test.ts  -- DELETE after running once
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { buildAndRoll } from "../helpers/fixture-db";
import { captureBaseline, SCENARIOS } from "./baseline";
it("generate", () => {
  const out: Record<string, unknown> = {};
  for (const s of SCENARIOS) out[s] = captureBaseline(buildAndRoll(s));
  writeFileSync("tests/regression/claude-baseline.json", JSON.stringify(out, null, 2) + "\n");
});
```

Run `npx vitest run tests/regression/__generate.test.ts`, then **delete that file**.

- [ ] **Step 5: Run the real test to verify it passes**

Run: `npx vitest run tests/regression.test.ts`
Expected: PASS, both tests.

- [ ] **Step 6: Plant the mutation and watch exactly one test go red**

Edit `tests/regression/claude-baseline.json` and change one `active_ms` value by 1.
Run: `npx vitest run tests/regression.test.ts`
Expected: FAIL on "matches the committed baseline exactly", and **only** that test.
**Revert the edit.** Re-run: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/regression/ tests/regression.test.ts
git commit -m "test(stage-3a): freeze the Claude regression baseline before any refactor

17 fixture scenarios x daily + per-project + rank rows, generated by the
CURRENT implementation and committed. Every later stage asserts exact
equality against this file.

Captured first, per decision 7: a baseline recorded during a refactor can
silently encode the bug it exists to catch. Column lists are explicit
rather than SELECT * so a later column cannot widen the baseline and
quietly invalidate the comparison.

Mutation-checked: perturbing one active_ms turns exactly one test red."
```

---

## Task 2: SQL helpers

**Files:**
- Create: `lib/core/sql.ts`
- Test: `tests/core-sql.test.ts`

**Interfaces:**
- Produces: `sqlStr(v: string | null): string`, `sqlNum(v: number | null | undefined): string`, `execSql(db: string, sql: string): void`, `querySql<T>(db: string, sql: string): T[]`

- [ ] **Step 1: Write the failing test**

Create `tests/core-sql.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sqlStr, sqlNum, execSql, querySql } from "@/lib/core/sql";

function tmpDb(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "wtsql-")), "t.sqlite");
}

describe("sqlStr", () => {
  // capture/lib.sh's cc_sqlstr had a REAL data-loss bug on apostrophes that a
  // fixture with its own quoting could not see. This escaper gets its own test.
  it("doubles embedded apostrophes", () => {
    expect(sqlStr("it's")).toBe("'it''s'");
  });

  it("round-trips an apostrophe through the database", () => {
    const db = tmpDb();
    execSql(db, `CREATE TABLE t (v TEXT);`);
    execSql(db, `INSERT INTO t (v) VALUES (${sqlStr("O'Brien \"x\" \\ y")});`);
    expect(querySql<{ v: string }>(db, `SELECT v FROM t;`)[0].v)
      .toBe(`O'Brien "x" \\ y`);
  });

  it("renders null as SQL NULL, not the string 'null'", () => {
    expect(sqlStr(null)).toBe("NULL");
  });
});

describe("sqlNum", () => {
  // undefined and 0 are DIFFERENT FACTS. A metric the source does not expose
  // must not become a zero.
  it("renders undefined and null as NULL but 0 as 0", () => {
    expect(sqlNum(undefined)).toBe("NULL");
    expect(sqlNum(null)).toBe("NULL");
    expect(sqlNum(0)).toBe("0");
  });

  it("refuses a non-finite number rather than emitting broken SQL", () => {
    expect(() => sqlNum(NaN)).toThrow(/finite/);
    expect(() => sqlNum(Infinity)).toThrow(/finite/);
  });
});

describe("querySql", () => {
  it("returns [] for an empty result rather than throwing", () => {
    const db = tmpDb();
    execSql(db, `CREATE TABLE t (v TEXT);`);
    expect(querySql(db, `SELECT * FROM t;`)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core-sql.test.ts`
Expected: FAIL — cannot resolve `@/lib/core/sql`.

- [ ] **Step 3: Write the implementation**

Create `lib/core/sql.ts`:

```ts
import { execFileSync } from "node:child_process";

/**
 * Quote a string as a SQL literal. Doubling the apostrophe is the whole job.
 *
 * capture/lib.sh's cc_sqlstr carried a real data-loss bug here that stayed
 * invisible because the fixtures did their own quoting. This one is tested
 * directly and round-tripped through sqlite3.
 */
export function sqlStr(v: string | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

/** Numbers only. undefined/null -> NULL, because absent is not zero. */
export function sqlNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  if (!Number.isFinite(v)) throw new Error(`sqlNum: value must be finite, got ${v}`);
  return String(v);
}

/** Run statements that return nothing. Errors are LOUD -- this is not the hook path. */
export function execSql(db: string, sql: string): void {
  execFileSync("sqlite3", ["-cmd", ".timeout 8000", "-cmd", ".bail on", db, sql], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** Run a SELECT and parse -json output. */
export function querySql<T>(db: string, sql: string): T[] {
  const out = execFileSync("sqlite3", ["-cmd", ".timeout 8000", "-json", db, sql], {
    encoding: "utf8",
  });
  return out.trim() === "" ? [] : (JSON.parse(out) as T[]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core-sql.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add lib/core/sql.ts tests/core-sql.test.ts
git commit -m "feat(stage-3a): SQL helpers with a directly-tested escaper

sqlStr/sqlNum/execSql/querySql -- the only place lib/core shells out.

The escaper gets its own round-trip test through sqlite3 because
capture/lib.sh's cc_sqlstr had a real apostrophe data-loss bug that
stayed invisible while fixtures did their own quoting.

sqlNum renders undefined and null as NULL but 0 as 0: a metric a source
does not expose must never become a zero. Non-finite input throws rather
than emitting broken SQL.

execSql uses .bail on and lets errors escape -- lib/core is not the hook
path, so unlike cc_sql it must fail loudly."
```

---

## Task 3: `wt_*` schema and its own version namespace

**Files:**
- Create: `lib/core/schema.ts`
- Test: `tests/core-schema.test.ts`

**Interfaces:**
- Consumes: `@/lib/core/sql` → `execSql`, `querySql`
- Produces: `WT_SCHEMA_VERSION: number`, `wtMarkerName(): string`, `wtSchemaSql(): string`, `applyWtSchema(dbPath: string): void`

- [ ] **Step 1: Write the failing test**

Create `tests/core-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WT_SCHEMA_VERSION, wtMarkerName, applyWtSchema } from "@/lib/core/schema";
import { querySql, execSql } from "@/lib/core/sql";

const ROOT = path.resolve(__dirname, "..");

function tmpDb(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "wtschema-")), "t.sqlite");
}

function tables(db: string): string[] {
  return querySql<{ name: string }>(
    db, `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;`
  ).map((r) => r.name);
}

describe("wt schema", () => {
  it("creates every wt_ table", () => {
    const db = tmpDb();
    applyWtSchema(db);
    const t = tables(db);
    for (const name of [
      "wt_sources", "wt_ingest_state", "wt_sessions", "wt_session_state",
      "wt_links", "wt_requests", "wt_usage", "wt_events", "wt_tools", "wt_metrics",
    ]) {
      expect(`${name}: ${t.includes(name)}`).toBe(`${name}: true`);
    }
  });

  it("is idempotent via the marker fast path", () => {
    const db = tmpDb();
    applyWtSchema(db);
    applyWtSchema(db);
    expect(tables(db).filter((n) => n === "wt_sources")).toHaveLength(1);
  });

  // The test above asserts LESS than "idempotent" sounds: the second call
  // short-circuits on the marker and never re-runs the DDL. Deleting the
  // marker is what exercises CREATE TABLE IF NOT EXISTS re-entrancy -- a real
  // case, since the marker lives in the database's DIRECTORY.
  it("re-applies cleanly against an existing database when the marker is gone", () => {
    const db = tmpDb();
    applyWtSchema(db);
    execSql(db, `INSERT INTO wt_sources
      (source, adapter_version, enabled, capabilities, authority, updated_at)
      VALUES ('claude', 1, 1, '[]', '[]', 0);`);
    rmSync(path.join(path.dirname(db), wtMarkerName()));

    expect(() => applyWtSchema(db)).not.toThrow();
    expect(tables(db).filter((n) => n === "wt_sources")).toHaveLength(1);
    expect(querySql<{ n: number }>(db, `SELECT COUNT(*) AS n FROM wt_sources;`)[0].n)
      .toBe(1);
  });

  it("writes a marker in the database's directory", () => {
    const db = tmpDb();
    applyWtSchema(db);
    expect(existsSync(path.join(path.dirname(db), wtMarkerName()))).toBe(true);
  });

  // THE TRAP: two markers in one directory are safe ONLY because the names
  // differ. capture/lib.sh uses .schema-v<CC_SCHEMA_VERSION>.
  it("uses a marker name that cannot collide with the capture layer's", () => {
    const lib = readFileSync(path.join(ROOT, "capture", "lib.sh"), "utf8");
    const m = /^CC_SCHEMA_VERSION=(\d+)$/m.exec(lib);
    expect(m).not.toBeNull();
    expect(wtMarkerName()).not.toBe(`.schema-v${m![1]}`);
    expect(wtMarkerName().startsWith(".wt-schema-v")).toBe(true);
  });

  // Decision 8 / spec §2: Stage 3A must NOT bump the capture layer.
  it("leaves CC_SCHEMA_VERSION and config schemaVersion at 4", () => {
    const lib = readFileSync(path.join(ROOT, "capture", "lib.sh"), "utf8");
    expect(/^CC_SCHEMA_VERSION=4$/m.test(lib)).toBe(true);
    const cfg = readFileSync(path.join(ROOT, "lib", "config.ts"), "utf8");
    expect(/schemaVersion:\s*4/.test(cfg)).toBe(true);
  });

  it("pins WT_SCHEMA_VERSION to the marker name it generates", () => {
    expect(wtMarkerName()).toBe(`.wt-schema-v${WT_SCHEMA_VERSION}`);
  });

  it("coexists with claude_ tables in one database", () => {
    const db = tmpDb();
    execSql(db, `CREATE TABLE claude_requests (request_id TEXT PRIMARY KEY);`);
    applyWtSchema(db);
    const t = tables(db);
    expect(t.includes("claude_requests")).toBe(true);
    expect(t.includes("wt_requests")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core-schema.test.ts`
Expected: FAIL — cannot resolve `@/lib/core/schema`.

- [ ] **Step 3: Write the implementation**

Create `lib/core/schema.ts`. Use the DDL from spec §3A.3 **verbatim** — all ten
tables. Then:

```ts
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execSql } from "./sql.ts";

/**
 * The wt_* namespace's OWN version, separate from CC_SCHEMA_VERSION.
 *
 * capture/lib.sh installs as ~/.claude/cc-track-lib.sh, so bumping
 * CC_SCHEMA_VERSION would mean editing an installed file and requiring a
 * reinstall -- and Stage 3 touches nothing under ~/.claude. Splitting the
 * namespaces lets the capture layer stay at 4, untouched.
 *
 * Declared twice, here and in the marker name, for the same reason
 * CC_SCHEMA_VERSION is. A test pins them together.
 */
export const WT_SCHEMA_VERSION = 1;

export function wtMarkerName(): string {
  return `.wt-schema-v${WT_SCHEMA_VERSION}`;
}

export function wtSchemaSql(): string {
  return `-- spec §3A.3 DDL, all ten tables, verbatim --`;  // <-- paste it here
}

/**
 * Apply the wt_* schema. Idempotent via CREATE TABLE IF NOT EXISTS.
 *
 * Unlike cc_init_db this is NOT on the hook path, so it fails loudly.
 */
export function applyWtSchema(dbPath: string): void {
  const dir = path.dirname(dbPath);
  mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, wtMarkerName());
  if (existsSync(marker) && existsSync(dbPath)) return;
  execSql(dbPath, wtSchemaSql());
  writeFileSync(marker, "");
}
```

> **Implementer note:** paste the full DDL from spec §3A.3 into `wtSchemaSql()`.
> Do not abbreviate it and do not reorder columns — the spec's column order is
> what the ingest task writes against.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core-schema.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Plant the marker-collision mutation**

Temporarily change `wtMarkerName()` to return `.schema-v4`.
Run: `npx vitest run tests/core-schema.test.ts`
Expected: FAIL on **two** tests — "uses a marker name that cannot collide" AND
"pins WT_SCHEMA_VERSION to the marker name it generates".

That is structural, not a weak guard: any name colliding with `.schema-vN`
necessarily also differs from `.wt-schema-v${WT_SCHEMA_VERSION}`, so the
collision guard cannot be isolated from this mutation site. To prove the two
guards are independent rather than redundant, plant a second, narrower
mutation — return `.wt-schema-v2` — which turns **exactly one** test red (the
version pin) and leaves the collision guard green.

**Revert both.**

- [ ] **Step 6: Commit**

```bash
git add lib/core/schema.ts tests/core-schema.test.ts
git commit -m "feat(stage-3a): wt_* schema under its own version namespace

Ten normalized tables (wt_sources, wt_ingest_state, wt_sessions,
wt_session_state, wt_links, wt_requests, wt_usage, wt_events, wt_tools,
wt_metrics) under WT_SCHEMA_VERSION 1, marker .wt-schema-v1.

Deliberately NOT added to capture/lib.sh's cc_schema_sql. That file
installs as ~/.claude/cc-track-lib.sh, so adding tables there would need
CC_SCHEMA_VERSION bumped AND a reinstall -- and if the bump were missed,
the marker short-circuits cc_init_db's fast path and the tables never
arrive. capture/lib.sh:298 records that exact failure from Stage 1.5,
where rollup.sh then aborted its transaction on every install and, since
it runs --quiet from SessionEnd, daily tracking went stale in silence.

Splitting the namespace means Stage 3 touches nothing under ~/.claude.

Two markers in one directory are safe only because the names differ, so
a test asserts .wt-schema-vN can never equal .schema-vN. Another asserts
CC_SCHEMA_VERSION and config schemaVersion both stay 4."
```

---

## Task 4: Record envelope and validation

**Files:**
- Create: `lib/core/records.ts`
- Test: `tests/core-records.test.ts`

**Interfaces:**
- Produces: `RecordKind`, `WatchtowerRecord`, `RECORD_ENVELOPE_VERSION: number`, `validateRecord(v: unknown): WatchtowerRecord`, `toEpochSeconds(ts: string): number`

- [ ] **Step 1: Write the failing test**

Create `tests/core-records.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateRecord, toEpochSeconds } from "@/lib/core/records.ts";

const ok = {
  source: "claude", sourceRecordId: "r1", kind: "request",
  timestamp: "2026-09-14T18:37:55.016862+00:00", schemaVersion: 1,
};

describe("toEpochSeconds", () => {
  it("parses an RFC3339 timestamp with an explicit offset", () => {
    // 1789344000 verified three ways, none of them JS-based, so the assertion
    // is not a mirror of the implementation:
    //   date -u -j -f "%Y-%m-%dT%H:%M:%S" "2026-09-14T00:00:00" +%s
    //   python3 -c "import datetime;print(int(datetime.datetime(2026,9,14,tzinfo=datetime.timezone.utc).timestamp()))"
    expect(toEpochSeconds("2026-09-14T00:00:00+00:00")).toBe(1789344000);
  });

  it("parses a non-UTC offset correctly", () => {
    expect(toEpochSeconds("2026-09-14T02:00:00+02:00"))
      .toBe(toEpochSeconds("2026-09-14T00:00:00Z"));
  });

  // A naked local time is ambiguous, and the rollup buckets by LOCAL day.
  // Accepting one silently would corrupt day buckets for every source.
  it("rejects a timestamp with no offset", () => {
    expect(() => toEpochSeconds("2026-09-14T00:00:00")).toThrow(/offset/);
  });

  it("rejects an unparseable timestamp", () => {
    expect(() => toEpochSeconds("yesterday")).toThrow();
  });
});

describe("validateRecord", () => {
  it("accepts a minimal valid record", () => {
    expect(validateRecord(ok).sourceRecordId).toBe("r1");
  });

  it("rejects an unknown kind", () => {
    expect(() => validateRecord({ ...ok, kind: "nonsense" })).toThrow(/kind/);
  });

  it.each(["source", "sourceRecordId", "kind", "timestamp"])(
    "rejects a record missing %s", (field) => {
      const bad: Record<string, unknown> = { ...ok };
      delete bad[field];
      expect(() => validateRecord(bad)).toThrow(new RegExp(field));
    });

  // THE INVARIANT: absent is not zero.
  it("keeps an absent metric absent and a zero metric zero", () => {
    const withZero = validateRecord({ ...ok, metrics: { tokens_out: 0 } });
    expect(withZero.metrics?.tokens_out).toBe(0);
    expect(validateRecord(ok).metrics).toBeUndefined();
  });

  it("rejects a non-numeric metric rather than coercing it", () => {
    expect(() => validateRecord({ ...ok, metrics: { tokens_out: "12" } }))
      .toThrow(/metric/);
  });

  it("rejects a non-finite metric", () => {
    expect(() => validateRecord({ ...ok, metrics: { x: Infinity } })).toThrow(/finite/);
  });

  it("defaults authority to enrichment", () => {
    expect(validateRecord(ok).authority).toBe("enrichment");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core-records.test.ts`
Expected: FAIL — cannot resolve `@/lib/core/records`.

- [ ] **Step 3: Write the implementation**

Create `lib/core/records.ts`:

```ts
export const RECORD_ENVELOPE_VERSION = 1;

export const RECORD_KINDS = [
  "session", "request", "usage", "tool", "memory",
  "git", "checkpoint", "health", "event", "custom",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface WatchtowerRecord {
  source: string;
  sourceRecordId: string;
  kind: RecordKind;
  timestamp: string;
  observedAt?: string;
  sessionId?: string;          // SOURCE-LOCAL. Canonical ids come from wt_sessions.
  project?: string; repo?: string; branch?: string;
  agent?: string; model?: string;
  metrics?: Record<string, number>;
  dimensions?: Record<string, string | number | boolean>;
  metadata?: Record<string, unknown>;
  authority: "authoritative" | "enrichment";
  schemaVersion: number;
}

const RFC3339_WITH_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/**
 * RFC3339 -> epoch seconds. An explicit offset is REQUIRED.
 *
 * rollup.sh buckets by LOCAL day, so a naked local time is ambiguous and
 * accepting one silently would corrupt day buckets for every source.
 */
export function toEpochSeconds(ts: string): number {
  if (!RFC3339_WITH_OFFSET.test(ts)) {
    throw new Error(`timestamp must carry an explicit UTC offset: ${ts}`);
  }
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new Error(`unparseable timestamp: ${ts}`);
  return Math.floor(ms / 1000);
}

function req(o: Record<string, unknown>, field: string): string {
  const v = o[field];
  if (typeof v !== "string" || v === "") {
    throw new Error(`record is missing required field ${field}`);
  }
  return v;
}

export function validateRecord(v: unknown): WatchtowerRecord {
  if (typeof v !== "object" || v === null) throw new Error("record must be an object");
  const o = v as Record<string, unknown>;

  const kind = req(o, "kind");
  if (!(RECORD_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown record kind: ${kind}`);
  }

  const timestamp = req(o, "timestamp");
  toEpochSeconds(timestamp);                       // validate now, fail at the boundary
  if (o.observedAt !== undefined) toEpochSeconds(String(o.observedAt));

  // Absent stays absent. Only validate what is actually present.
  let metrics: Record<string, number> | undefined;
  if (o.metrics !== undefined) {
    if (typeof o.metrics !== "object" || o.metrics === null) {
      throw new Error("metrics must be an object");
    }
    metrics = {};
    for (const [k, mv] of Object.entries(o.metrics as Record<string, unknown>)) {
      if (typeof mv !== "number") throw new Error(`metric ${k} must be a number, got ${typeof mv}`);
      if (!Number.isFinite(mv)) throw new Error(`metric ${k} must be finite`);
      metrics[k] = mv;
    }
  }

  const authority = o.authority === "authoritative" ? "authoritative" : "enrichment";

  return {
    source: req(o, "source"),
    sourceRecordId: req(o, "sourceRecordId"),
    kind: kind as RecordKind,
    timestamp,
    observedAt: o.observedAt as string | undefined,
    sessionId: o.sessionId as string | undefined,
    project: o.project as string | undefined,
    repo: o.repo as string | undefined,
    branch: o.branch as string | undefined,
    agent: o.agent as string | undefined,
    model: o.model as string | undefined,
    metrics,
    dimensions: o.dimensions as WatchtowerRecord["dimensions"],
    metadata: o.metadata as Record<string, unknown> | undefined,
    authority,
    schemaVersion: typeof o.schemaVersion === "number" ? o.schemaVersion : RECORD_ENVELOPE_VERSION,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core-records.test.ts`
Expected: PASS.

- [ ] **Step 5: Plant the absent-is-zero mutation**

**The mutation must sit OUTSIDE the `if (o.metrics !== undefined)` check.** Placing
it inside that branch does not exercise the absent case at all — it leaves all 14
tests green and would sign the guard off on a mutation that proves nothing.

Temporarily initialise `metrics` unconditionally, before the presence check:

```ts
let metrics: Record<string, number> | undefined = { tokens_out: 0 };  // MUTATION
if (o.metrics !== undefined) {
```

Run: `npx vitest run tests/core-records.test.ts`
Expected: FAIL, **exactly one test** — "keeps an absent metric absent and a zero
metric zero", with `expected { tokens_out: +0 } to be undefined`. **Revert** and
confirm 14 pass.

- [ ] **Step 6: Commit**

```bash
git add lib/core/records.ts tests/core-records.test.ts
git commit -m "feat(stage-3a): the canonical record envelope and its validator

WatchtowerRecord plus validateRecord/toEpochSeconds. Validation is loud
and happens at the boundary, so a malformed record never reaches SQL.

An explicit UTC offset is REQUIRED on every timestamp. rollup.sh buckets
by local day, so a naked local time is ambiguous and accepting one
silently would corrupt day buckets for every source.

Absent metrics stay absent -- metrics is a sparse map and undefined is
never filled with 0, because 'the source does not expose this' and 'the
source measured zero' are different facts. Mutation-checked.

authority defaults to enrichment, so a record must ASK to own a metric
rather than owning one by omission."
```

---

## Task 5: Adapter contract and source registry

**Files:**
- Create: `lib/core/adapters.ts`
- Test: `tests/core-adapters.test.ts`

**Interfaces:**
- Consumes: `@/lib/core/sql` → `execSql`, `querySql`, `sqlStr`, `sqlNum`; `@/lib/core/records` → `RecordKind`, `WatchtowerRecord`
- Produces: `Capability`, `MetricAuthority`, `DetectionResult`, `AdapterHealth`, `WatchtowerAdapter`, `registerSource(db, adapter)`, `isAuthoritative(db, source, kind, metric)`, `listSources(db)`

- [ ] **Step 1: Write the failing test**

Create `tests/core-adapters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWtSchema } from "@/lib/core/schema";
import { registerSource, isAuthoritative, listSources } from "@/lib/core/adapters";
import type { WatchtowerAdapter } from "@/lib/core/adapters";

function tmpDb(): string {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wtad-")), "t.sqlite");
  applyWtSchema(db);
  return db;
}

const claudeAdapter: WatchtowerAdapter = {
  id: "claude", version: 1,
  capabilities: ["sessions", "requests", "usage", "tools"],
  authority: [{ kind: "request", metrics: ["tokens_in", "tokens_out", "cost_usd"] }],
  async detect() { return { detected: true }; },
  async health() { return { state: "ok" }; },
  async *ingest() { /* nothing */ },
};

const atlasAdapter: WatchtowerAdapter = {
  id: "atlas", version: 1,
  capabilities: ["sessions", "git", "checkpoints"],
  authority: [{ kind: "checkpoint", metrics: ["insertions", "deletions"] }],
  async detect() { return { detected: true }; },
  async health() { return { state: "ok" }; },
  async *ingest() { /* nothing */ },
};

describe("source registry", () => {
  it("registers a source and lists it", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    expect(listSources(db).map((s) => s.source)).toEqual(["claude"]);
  });

  it("is idempotent and updates the adapter version in place", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    registerSource(db, { ...claudeAdapter, version: 2 });
    const all = listSources(db);
    expect(all).toHaveLength(1);
    expect(all[0].adapter_version).toBe(2);
  });
});

describe("isAuthoritative", () => {
  it("is true for a metric the source declared", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    expect(isAuthoritative(db, "claude", "request", "tokens_out")).toBe(true);
  });

  // THE LOAD-BEARING RULE. Atlas's token_totals disagree with Watchtower by
  // 2.03x on one session and 0.42x on another; it may never own a token metric.
  it("is false for a metric another source owns", () => {
    const db = tmpDb();
    registerSource(db, claudeAdapter);
    registerSource(db, atlasAdapter);
    expect(isAuthoritative(db, "atlas", "request", "tokens_out")).toBe(false);
  });

  it("is false for an unregistered source", () => {
    const db = tmpDb();
    expect(isAuthoritative(db, "ghost", "request", "tokens_out")).toBe(false);
  });

  it("is scoped by kind, not just metric name", () => {
    const db = tmpDb();
    registerSource(db, atlasAdapter);
    expect(isAuthoritative(db, "atlas", "checkpoint", "insertions")).toBe(true);
    expect(isAuthoritative(db, "atlas", "request", "insertions")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core-adapters.test.ts`
Expected: FAIL — cannot resolve `@/lib/core/adapters`.

- [ ] **Step 3: Write the implementation**

Create `lib/core/adapters.ts`:

```ts
import { execSql, querySql, sqlStr, sqlNum } from "./sql.ts";
import type { RecordKind, WatchtowerRecord } from "./records.ts";

export type Capability =
  | "sessions" | "requests" | "usage" | "tools"
  | "git" | "checkpoints" | "memory" | "health";

export interface MetricAuthority { kind: RecordKind; metrics: string[] }
export interface DetectionResult { detected: boolean; detail?: string }
export interface AdapterHealth { state: "ok" | "degraded" | "unavailable"; detail?: string }

export interface WatchtowerAdapter {
  readonly id: string;
  readonly version: number;
  readonly capabilities: Capability[];
  readonly authority: MetricAuthority[];
  detect(): Promise<DetectionResult>;
  health(): Promise<AdapterHealth>;
  ingest(cursor?: string): AsyncIterable<WatchtowerRecord>;
}

export interface SourceRow {
  source: string; adapter_version: number; enabled: number;
  capabilities: string; authority: string;
}

export function registerSource(db: string, a: WatchtowerAdapter): void {
  const now = Math.floor(Date.now() / 1000);
  execSql(db, `INSERT INTO wt_sources
      (source, adapter_version, enabled, capabilities, authority, first_seen, updated_at)
    VALUES (${sqlStr(a.id)}, ${sqlNum(a.version)}, 1,
            ${sqlStr(JSON.stringify(a.capabilities))},
            ${sqlStr(JSON.stringify(a.authority))},
            ${sqlNum(now)}, ${sqlNum(now)})
    ON CONFLICT(source) DO UPDATE SET
      adapter_version = excluded.adapter_version,
      capabilities    = excluded.capabilities,
      authority       = excluded.authority,
      updated_at      = excluded.updated_at;`);
}

export function listSources(db: string): SourceRow[] {
  return querySql<SourceRow>(db, `SELECT source, adapter_version, enabled,
    capabilities, authority FROM wt_sources ORDER BY source;`);
}

/**
 * The load-bearing rule: exactly one authoritative source per (kind, metric).
 *
 * Atlas carries token_totals that disagree with claude_requests by 2.03x on
 * one session and 0.42x on another -- high where it sums duplicate requestIds,
 * low where it cannot see subagent traffic. Two observers that disagree in
 * both directions cannot be reconciled into one metric, so ownership is
 * declared rather than negotiated.
 */
export function isAuthoritative(
  db: string, source: string, kind: RecordKind, metric: string,
): boolean {
  const rows = querySql<{ authority: string }>(
    db, `SELECT authority FROM wt_sources WHERE source = ${sqlStr(source)};`);
  if (rows.length === 0) return false;
  const claims = JSON.parse(rows[0].authority) as MetricAuthority[];
  return claims.some((c) => c.kind === kind && c.metrics.includes(metric));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core-adapters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/core/adapters.ts tests/core-adapters.test.ts
git commit -m "feat(stage-3a): adapter contract and the source authority registry

WatchtowerAdapter (detect/health/ingest, neither probe may throw) plus
wt_sources registration and isAuthoritative().

isAuthoritative is the load-bearing rule made queryable: exactly one
authoritative source per (kind, metric), scoped by kind so a name
collision across kinds cannot grant ownership by accident.

Measured justification, in the test: Atlas's token_totals run 2.03x high
on a zero-subagent session (it sums duplicate requestIds, the defect
Stage 2 fixed) and 0.42x low on one that is 68% subagent traffic it
cannot see. Two observers disagreeing in both directions cannot be
averaged, so ownership is declared, not negotiated."
```

---

## Task 6: Identity and exact links

**Files:**
- Create: `lib/core/identity.ts`
- Test: `tests/core-identity.test.ts`

**Interfaces:**
- Consumes: `@/lib/core/sql`
- Produces: `mintCanonicalId(): string`, `LinkKind`, `linkExact(db, args): void`, `resolveCanonicalId(db, source, sourceLocalId, linkKind): string | null`, `upsertSession(db, args): void`, `setSessionState(db, canonicalId, source, state): void`

- [ ] **Step 1: Write the failing test**

Create `tests/core-identity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWtSchema } from "@/lib/core/schema";
import { querySql } from "@/lib/core/sql";
import {
  mintCanonicalId, linkExact, resolveCanonicalId, upsertSession, setSessionState,
} from "@/lib/core/identity";

function tmpDb(): string {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wtid-")), "t.sqlite");
  applyWtSchema(db);
  return db;
}

describe("mintCanonicalId", () => {
  it("returns distinct ids", () => {
    expect(mintCanonicalId()).not.toBe(mintCanonicalId());
  });
});

describe("linkExact", () => {
  it("links a source-local id to a canonical id and resolves it back", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    linkExact(db, {
      source: "atlas", sourceLocalId: "sess-abc", linkKind: "same_session",
      canonicalId: cid, evidence: "native_session_id == claude_sessions.session_id",
    });
    expect(resolveCanonicalId(db, "atlas", "sess-abc", "same_session")).toBe(cid);
  });

  it("returns null for an unknown link", () => {
    expect(resolveCanonicalId(tmpDb(), "atlas", "nope", "same_session")).toBeNull();
  });

  it("is idempotent on re-link", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    const args = { source: "atlas", sourceLocalId: "s1", linkKind: "same_session" as const,
                   canonicalId: cid, evidence: "e" };
    linkExact(db, args);
    linkExact(db, args);
    expect(querySql(db, `SELECT * FROM wt_links;`)).toHaveLength(1);
  });

  // DECISION 13: exact only. Nothing writes 'inferred' in Stage 3.
  it("only ever writes confidence = exact", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    linkExact(db, { source: "atlas", sourceLocalId: "s1",
                    linkKind: "same_session", canonicalId: cid, evidence: "e" });
    const all = querySql<{ confidence: string }>(db, `SELECT confidence FROM wt_links;`);
    expect(all.every((r) => r.confidence === "exact")).toBe(true);
  });

  it("requires evidence, so a link is always auditable", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    expect(() => linkExact(db, {
      source: "atlas", sourceLocalId: "s1", linkKind: "same_session",
      canonicalId: cid, evidence: "",
    })).toThrow(/evidence/);
  });
});

describe("session completeness", () => {
  // Decision 5: a live session has provenance from one source and no usage yet
  // from another. That is NOT "zero usage".
  it("records pending and complete per source", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    setSessionState(db, cid, "claude", "pending");
    expect(querySql<{ state: string }>(db,
      `SELECT state FROM wt_session_state WHERE canonical_id='${cid}';`)[0].state)
      .toBe("pending");
    setSessionState(db, cid, "claude", "complete");
    expect(querySql<{ state: string }>(db,
      `SELECT state FROM wt_session_state WHERE canonical_id='${cid}';`)[0].state)
      .toBe("complete");
  });

  it("rejects a state outside pending|complete", () => {
    const db = tmpDb();
    const cid = mintCanonicalId();
    upsertSession(db, { canonicalId: cid, firstSource: "claude" });
    // @ts-expect-error -- deliberately invalid
    expect(() => setSessionState(db, cid, "claude", "maybe")).toThrow(/state/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core-identity.test.ts`
Expected: FAIL — cannot resolve `@/lib/core/identity`.

- [ ] **Step 3: Write the implementation**

Create `lib/core/identity.ts`:

```ts
import { randomUUID } from "node:crypto";
import { execSql, querySql, sqlStr, sqlNum } from "./sql.ts";

export type LinkKind = "same_session" | "produced_commit" | "touched_file";
export type SessionState = "pending" | "complete";

export function mintCanonicalId(): string {
  return `wt_${randomUUID()}`;
}

export function upsertSession(db: string, a: {
  canonicalId: string; firstSource: string;
  startedAt?: number; endedAt?: number;
  project?: string; repo?: string; branch?: string; agent?: string; model?: string;
}): void {
  const now = Math.floor(Date.now() / 1000);
  execSql(db, `INSERT INTO wt_sessions
      (canonical_id, first_source, started_at, ended_at, project, repo, branch,
       agent, model, updated_at)
    VALUES (${sqlStr(a.canonicalId)}, ${sqlStr(a.firstSource)},
            ${sqlNum(a.startedAt)}, ${sqlNum(a.endedAt)}, ${sqlStr(a.project)},
            ${sqlStr(a.repo)}, ${sqlStr(a.branch)}, ${sqlStr(a.agent)},
            ${sqlStr(a.model)}, ${sqlNum(now)})
    ON CONFLICT(canonical_id) DO UPDATE SET
      ended_at   = COALESCE(excluded.ended_at, wt_sessions.ended_at),
      project    = COALESCE(excluded.project, wt_sessions.project),
      repo       = COALESCE(excluded.repo, wt_sessions.repo),
      branch     = COALESCE(excluded.branch, wt_sessions.branch),
      updated_at = excluded.updated_at;`);
}

/**
 * Create an EXACT identity link.
 *
 * Exact means both sources obtained the identifier from the same upstream
 * system -- proven for Atlas, whose agent_session.native_session_id matched
 * claude_sessions.session_id on 5 of 5 sessions.
 *
 * There is deliberately no linkInferred(). The confidence column exists so the
 * schema need not change later, but nothing in Stage 3 writes 'inferred':
 * a wrong link merges two real sessions and the error is nearly invisible
 * once rolled up.
 */
export function linkExact(db: string, a: {
  source: string; sourceLocalId: string; linkKind: LinkKind;
  canonicalId: string; evidence: string;
}): void {
  if (!a.evidence) throw new Error("linkExact requires evidence -- a link must be auditable");
  execSql(db, `INSERT INTO wt_links
      (source, source_local_id, link_kind, canonical_id, confidence, evidence, created_at)
    VALUES (${sqlStr(a.source)}, ${sqlStr(a.sourceLocalId)}, ${sqlStr(a.linkKind)},
            ${sqlStr(a.canonicalId)}, 'exact', ${sqlStr(a.evidence)},
            ${sqlNum(Math.floor(Date.now() / 1000))})
    ON CONFLICT(source, source_local_id, link_kind) DO UPDATE SET
      canonical_id = excluded.canonical_id, evidence = excluded.evidence;`);
}

export function resolveCanonicalId(
  db: string, source: string, sourceLocalId: string, linkKind: LinkKind,
): string | null {
  const r = querySql<{ canonical_id: string }>(db,
    `SELECT canonical_id FROM wt_links
      WHERE source = ${sqlStr(source)}
        AND source_local_id = ${sqlStr(sourceLocalId)}
        AND link_kind = ${sqlStr(linkKind)};`);
  return r.length ? r[0].canonical_id : null;
}

export function setSessionState(
  db: string, canonicalId: string, source: string, state: SessionState,
): void {
  if (state !== "pending" && state !== "complete") {
    throw new Error(`invalid session state: ${state}`);
  }
  execSql(db, `INSERT INTO wt_session_state (canonical_id, source, state, updated_at)
    VALUES (${sqlStr(canonicalId)}, ${sqlStr(source)}, ${sqlStr(state)},
            ${sqlNum(Math.floor(Date.now() / 1000))})
    ON CONFLICT(canonical_id, source) DO UPDATE SET
      state = excluded.state, updated_at = excluded.updated_at;`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core-identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Plant the inferred-link mutation**

Temporarily add a `linkInferred()` that writes `'inferred'`, and call it once in
the "only ever writes confidence = exact" test's setup.
Run: `npx vitest run tests/core-identity.test.ts`
Expected: FAIL on that test. **Revert both edits.**

- [ ] **Step 6: Commit**

```bash
git add lib/core/identity.ts tests/core-identity.test.ts
git commit -m "feat(stage-3a): canonical identity, exact-only links, session completeness

mintCanonicalId/upsertSession/linkExact/resolveCanonicalId plus
setSessionState.

There is deliberately NO linkInferred(). The confidence column exists so
the schema need not change later, but nothing in Stage 3 writes
'inferred' -- a wrong link merges two real sessions and the error is
nearly invisible once rolled up. Exact means both sources got the
identifier from the same upstream system, proven for Atlas whose
native_session_id matched claude_sessions.session_id 5 of 5.

linkExact refuses an empty evidence string, so every link records the
join key that produced it and stays auditable.

wt_session_state carries pending/complete PER SOURCE because a live
session has provenance from one source and no usage yet from another --
which is not the same fact as zero usage."
```

---

## Task 7: Authority-enforced ingest

**Files:**
- Create: `lib/core/ingest.ts`
- Test: `tests/core-ingest.test.ts`

**Interfaces:**
- Consumes: `@/lib/core/sql`, `@/lib/core/adapters` → `isAuthoritative`, `@/lib/core/records` → `WatchtowerRecord`, `toEpochSeconds`, `@/lib/core/identity` → `resolveCanonicalId`
- Produces: `IngestResult`, `ingestRecords(db, source, records): IngestResult`, `readIngestState(db, source)`

- [ ] **Step 1: Write the failing test**

Create `tests/core-ingest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWtSchema } from "@/lib/core/schema";
import { registerSource } from "@/lib/core/adapters";
import type { WatchtowerAdapter } from "@/lib/core/adapters";
import { ingestRecords, readIngestState } from "@/lib/core/ingest";
import { querySql } from "@/lib/core/sql";
import { validateRecord } from "@/lib/core/records.ts";

function tmpDb(): string {
  const db = path.join(mkdtempSync(path.join(tmpdir(), "wting-")), "t.sqlite");
  applyWtSchema(db);
  return db;
}

const stub = (id: string, authority: WatchtowerAdapter["authority"]): WatchtowerAdapter => ({
  id, version: 1, capabilities: ["requests"], authority,
  async detect() { return { detected: true }; },
  async health() { return { state: "ok" }; },
  async *ingest() {},
});

const claudeReq = validateRecord({
  source: "claude", sourceRecordId: "req-1", kind: "request",
  timestamp: "2026-09-14T12:00:00Z", model: "claude-opus-5",
  metrics: { tokens_in: 10, tokens_out: 20 }, authority: "authoritative",
});

const atlasReq = validateRecord({
  source: "atlas", sourceRecordId: "atlas-1", kind: "request",
  timestamp: "2026-09-14T12:00:00Z",
  metrics: { tokens_out: 999999 },              // the double-count hazard
  dimensions: { branch: "main" },
  authority: "authoritative",                   // claims it, must still be refused
});

describe("ingestRecords", () => {
  it("writes an authoritative metric", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }]));
    const r = ingestRecords(db, "claude", [claudeReq]);
    expect(r.ingested).toBe(1);
    expect(querySql<{ tokens_out: number }>(db,
      `SELECT tokens_out FROM wt_requests;`)[0].tokens_out).toBe(20);
  });

  // THE LOAD-BEARING TEST. Atlas's token_totals must never reach wt_requests.
  it("rejects a non-authoritative metric and counts the rejection", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_out"] }]));
    registerSource(db, stub("atlas", [{ kind: "checkpoint", metrics: ["insertions"] }]));
    const r = ingestRecords(db, "atlas", [atlasReq]);
    expect(r.metricsRejected).toBe(1);
    expect(querySql(db, `SELECT * FROM wt_requests WHERE tokens_out = 999999;`))
      .toHaveLength(0);
    expect(readIngestState(db, "atlas").metrics_rejected).toBe(1);
  });

  it("still accepts dimensions from a non-authoritative source", () => {
    const db = tmpDb();
    registerSource(db, stub("atlas", [{ kind: "checkpoint", metrics: ["insertions"] }]));
    ingestRecords(db, "atlas", [atlasReq]);
    const row = querySql<{ branch: string | null }>(db,
      `SELECT branch FROM wt_requests WHERE source='atlas';`);
    expect(row[0].branch).toBe("main");
  });

  // Upsert on the primary key is what makes cursors advisory.
  it("is idempotent -- re-ingesting the same record changes nothing", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }]));
    ingestRecords(db, "claude", [claudeReq]);
    ingestRecords(db, "claude", [claudeReq]);
    expect(querySql(db, `SELECT * FROM wt_requests;`)).toHaveLength(1);
  });

  it("leaves an absent metric NULL rather than writing 0", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }]));
    ingestRecords(db, "claude", [claudeReq]);
    expect(querySql<{ cost_usd: number | null }>(db,
      `SELECT cost_usd FROM wt_requests;`)[0].cost_usd).toBeNull();
  });

  it("routes an unknown metric to wt_usage rather than dropping it", () => {
    const db = tmpDb();
    registerSource(db, stub("codex", [{ kind: "request", metrics: ["reasoning_tokens"] }]));
    ingestRecords(db, "codex", [validateRecord({
      source: "codex", sourceRecordId: "c1", kind: "request",
      timestamp: "2026-09-14T12:00:00Z",
      metrics: { reasoning_tokens: 42 }, authority: "authoritative",
    })]);
    expect(querySql<{ metric: string; value: number }>(db,
      `SELECT metric, value FROM wt_usage;`)).toEqual([
      { metric: "reasoning_tokens", value: 42 },
    ]);
  });

  it("updates ingest state counters", () => {
    const db = tmpDb();
    registerSource(db, stub("claude", [{ kind: "request", metrics: ["tokens_in", "tokens_out"] }]));
    ingestRecords(db, "claude", [claudeReq]);
    const st = readIngestState(db, "claude");
    expect(st.records_ingested).toBe(1);
    expect(st.health).toBe("ok");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core-ingest.test.ts`
Expected: FAIL — cannot resolve `@/lib/core/ingest`.

- [ ] **Step 3: Write the implementation**

Create `lib/core/ingest.ts`:

```ts
import { execSql, querySql, sqlStr, sqlNum } from "./sql.ts";
import { isAuthoritative } from "./adapters.ts";
import { toEpochSeconds, type WatchtowerRecord } from "./records.ts";
import { resolveCanonicalId } from "./identity.ts";

export interface IngestResult {
  ingested: number; metricsRejected: number; malformed: number;
}

export interface IngestStateRow {
  source: string; cursor: string | null; last_run_at: number | null;
  records_ingested: number; metrics_rejected: number;
  records_malformed: number; health: string; last_error: string | null;
}

/** Typed columns on wt_requests. Anything else goes to wt_usage. */
const TYPED_REQUEST_METRICS = new Set([
  "tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_creation", "cost_usd",
]);

export function ingestRecords(
  db: string, source: string, records: Iterable<WatchtowerRecord>,
): IngestResult {
  const res: IngestResult = { ingested: 0, metricsRejected: 0, malformed: 0 };

  for (const r of records) {
    const ts = toEpochSeconds(r.timestamp);
    const observed = r.observedAt ? toEpochSeconds(r.observedAt) : undefined;
    const canonical = r.sessionId
      ? resolveCanonicalId(db, source, r.sessionId, "same_session")
      : null;

    // THE AUTHORITY RULE. Split the record's metrics into accepted and
    // rejected BEFORE any write. A rejection is not an error -- Atlas
    // legitimately carries token_totals and being refused is the system
    // working -- but it is counted so the volume stays visible. Silent drops
    // are how a 2x error hides.
    const accepted: Record<string, number> = {};
    for (const [metric, value] of Object.entries(r.metrics ?? {})) {
      if (isAuthoritative(db, source, r.kind, metric)) accepted[metric] = value;
      else res.metricsRejected++;
    }

    if (r.kind === "request") {
      const dim = r.dimensions ?? {};
      execSql(db, `INSERT INTO wt_requests
          (source, source_record_id, canonical_id, ts, observed_at, model, agent,
           project, repo, branch, is_subagent, tokens_in, tokens_out,
           tokens_cache_read, tokens_cache_creation, cost_usd, error_status)
        VALUES (${sqlStr(source)}, ${sqlStr(r.sourceRecordId)}, ${sqlStr(canonical)},
          ${sqlNum(ts)}, ${sqlNum(observed)}, ${sqlStr(r.model)}, ${sqlStr(r.agent)},
          ${sqlStr(r.project)}, ${sqlStr(r.repo)},
          ${sqlStr(r.branch ?? (dim.branch as string | undefined))},
          ${sqlNum(dim.is_subagent === undefined ? undefined : Number(dim.is_subagent))},
          ${sqlNum(accepted.tokens_in)}, ${sqlNum(accepted.tokens_out)},
          ${sqlNum(accepted.tokens_cache_read)}, ${sqlNum(accepted.tokens_cache_creation)},
          ${sqlNum(accepted.cost_usd)}, ${sqlStr(dim.error_status as string | undefined)})
        ON CONFLICT(source, source_record_id) DO UPDATE SET
          canonical_id = COALESCE(excluded.canonical_id, wt_requests.canonical_id),
          tokens_in    = COALESCE(excluded.tokens_in, wt_requests.tokens_in),
          tokens_out   = COALESCE(excluded.tokens_out, wt_requests.tokens_out),
          tokens_cache_read = COALESCE(excluded.tokens_cache_read, wt_requests.tokens_cache_read),
          tokens_cache_creation = COALESCE(excluded.tokens_cache_creation, wt_requests.tokens_cache_creation),
          cost_usd     = COALESCE(excluded.cost_usd, wt_requests.cost_usd),
          branch       = COALESCE(excluded.branch, wt_requests.branch);`);
    } else {
      execSql(db, `INSERT INTO wt_events
          (source, source_record_id, canonical_id, ts, kind, project, repo, branch,
           dimensions, metadata)
        VALUES (${sqlStr(source)}, ${sqlStr(r.sourceRecordId)}, ${sqlStr(canonical)},
          ${sqlNum(ts)}, ${sqlStr(r.kind)}, ${sqlStr(r.project)}, ${sqlStr(r.repo)},
          ${sqlStr(r.branch)}, ${sqlStr(JSON.stringify(r.dimensions ?? {}))},
          ${sqlStr(JSON.stringify(r.metadata ?? {}))})
        ON CONFLICT(source, source_record_id) DO UPDATE SET
          canonical_id = COALESCE(excluded.canonical_id, wt_events.canonical_id),
          dimensions = excluded.dimensions, metadata = excluded.metadata;`);
    }

    // Accepted metrics with no typed home are preserved, never dropped.
    for (const [metric, value] of Object.entries(accepted)) {
      if (r.kind === "request" && TYPED_REQUEST_METRICS.has(metric)) continue;
      execSql(db, `INSERT INTO wt_usage
          (source, source_record_id, canonical_id, ts, metric, value)
        VALUES (${sqlStr(source)}, ${sqlStr(r.sourceRecordId)}, ${sqlStr(canonical)},
                ${sqlNum(ts)}, ${sqlStr(metric)}, ${sqlNum(value)})
        ON CONFLICT(source, source_record_id, metric) DO UPDATE SET
          value = excluded.value;`);
    }

    res.ingested++;
  }

  const now = Math.floor(Date.now() / 1000);
  execSql(db, `INSERT INTO wt_ingest_state
      (source, last_run_at, last_ok_at, records_ingested, metrics_rejected,
       records_malformed, health)
    VALUES (${sqlStr(source)}, ${sqlNum(now)}, ${sqlNum(now)},
            ${sqlNum(res.ingested)}, ${sqlNum(res.metricsRejected)},
            ${sqlNum(res.malformed)}, 'ok')
    ON CONFLICT(source) DO UPDATE SET
      last_run_at       = excluded.last_run_at,
      last_ok_at        = excluded.last_ok_at,
      records_ingested  = wt_ingest_state.records_ingested + excluded.records_ingested,
      metrics_rejected  = wt_ingest_state.metrics_rejected + excluded.metrics_rejected,
      records_malformed = wt_ingest_state.records_malformed + excluded.records_malformed,
      health            = 'ok';`);

  return res;
}

export function readIngestState(db: string, source: string): IngestStateRow {
  const r = querySql<IngestStateRow>(db,
    `SELECT source, cursor, last_run_at, records_ingested, metrics_rejected,
            records_malformed, health, last_error
       FROM wt_ingest_state WHERE source = ${sqlStr(source)};`);
  if (r.length === 0) throw new Error(`no ingest state for source ${source}`);
  return r[0];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core-ingest.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Plant the authority mutation**

Temporarily change the authority split to `accepted[metric] = value;` for every
metric, ignoring `isAuthoritative`.
Run: `npx vitest run tests/core-ingest.test.ts`
Expected: FAIL on "rejects a non-authoritative metric and counts the rejection".
**Revert.**

- [ ] **Step 6: Commit**

```bash
git add lib/core/ingest.ts tests/core-ingest.test.ts
git commit -m "feat(stage-3a): authority-enforced, idempotent ingest

ingestRecords splits each record's metrics into accepted and rejected
BEFORE any write, so a non-authoritative metric never reaches the
database even transiently. Rejections are counted into
wt_ingest_state.metrics_rejected and surfaced later in the Sources view.

A rejection is not an error. Atlas legitimately carries token_totals;
being refused is the system working. The counter exists so the volume
is visible -- silent drops are how a 2x error hides.

Every write is an upsert on the primary key, which is what makes ingest
idempotent and cursors advisory, generalizing the argument that already
makes claude_ingest_cursor advisory.

Absent metrics stay NULL rather than becoming 0, and an accepted metric
with no typed column goes to wt_usage rather than being dropped."
```

---

## Task 8: Discovery, NDJSON boundary and the CLI

**Files:**
- Create: `lib/core/discovery.ts`
- Create: `lib/adapters/external/ndjson.ts`
- Create: `bin/watchtower`
- Modify: `package.json` (add `bin`, no dependencies)
- Modify: `tsconfig.json` (add `allowImportingTsExtensions`)
- Modify: `tests/capture-scripts.test.ts` (extend the carriers guard)
- Test: `tests/core-discovery.test.ts`, `tests/external-ndjson.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: `detectSource(id, opts): Promise<DetectionResult>`, `parseNdjson(input: string): { records: WatchtowerRecord[]; malformed: number }`

- [ ] **Step 1: Write the failing tests**

Create `tests/core-discovery.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectSource } from "@/lib/core/discovery";

describe("detectSource", () => {
  it("detects claude when the config dir exists", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "wtd-"));
    mkdirSync(path.join(home, ".claude"));
    expect((await detectSource("claude", { home })).detected).toBe(true);
  });

  // Missing is NORMAL, never an error.
  it("reports not-detected rather than throwing when a source is absent", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "wtd-"));
    await expect(detectSource("codex", { home })).resolves.toMatchObject({ detected: false });
  });

  it("never throws on an unknown source id", async () => {
    await expect(detectSource("nonesuch", { home: "/nope" }))
      .resolves.toMatchObject({ detected: false });
  });

  // Atlas state is PER-REPO. An unbounded home scan is not acceptable.
  it("finds atlas only under configured roots", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "wtd-"));
    const repo = path.join(home, "code", "proj");
    mkdirSync(path.join(repo, ".atlas"), { recursive: true });
    writeFileSync(path.join(repo, ".atlas", "sessions.db"), "");
    expect((await detectSource("atlas", { home, projectRoots: [path.join(home, "code")] })).detected).toBe(true);
    expect((await detectSource("atlas", { home, projectRoots: [] })).detected).toBe(false);
  });
});
```

Create `tests/external-ndjson.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseNdjson } from "@/lib/adapters/external/ndjson";

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const base = {
  source: "my-agent", sourceRecordId: "1", kind: "session",
  timestamp: "2026-09-14T20:00:00Z",
};

describe("parseNdjson", () => {
  it("parses one record per line", () => {
    const out = parseNdjson([line(base), line({ ...base, sourceRecordId: "2" })].join("\n"));
    expect(out.records).toHaveLength(2);
    expect(out.malformed).toBe(0);
  });

  // A bad line must NOT abort the stream.
  it("counts a malformed line and continues", () => {
    const out = parseNdjson([line(base), "{ not json", line({ ...base, sourceRecordId: "3" })].join("\n"));
    expect(out.records).toHaveLength(2);
    expect(out.malformed).toBe(1);
  });

  it("ignores blank lines without counting them as malformed", () => {
    const out = parseNdjson(`${line(base)}\n\n  \n`);
    expect(out.records).toHaveLength(1);
    expect(out.malformed).toBe(0);
  });

  it("maps an unknown kind to custom rather than dropping the record", () => {
    const out = parseNdjson(line({ ...base, kind: "weird-thing" }));
    expect(out.records).toHaveLength(1);
    expect(out.records[0].kind).toBe("custom");
  });

  // Decision 12: external records are enrichment unless config grants authority.
  it("forces authority to enrichment even if the payload claims otherwise", () => {
    const out = parseNdjson(line({ ...base, authority: "authoritative" }));
    expect(out.records[0].authority).toBe("enrichment");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/core-discovery.test.ts tests/external-ndjson.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `lib/core/discovery.ts`**

```ts
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DetectionResult } from "./adapters.ts";

export interface DetectOptions {
  home?: string;
  projectRoots?: string[];
  /** Bounded: Atlas state is per-repo, so this never walks the whole home dir. */
  maxDepth?: number;
}

/**
 * Probe for a source. NEVER throws -- a missing source is a state, not an error.
 */
export async function detectSource(id: string, opts: DetectOptions = {}): Promise<DetectionResult> {
  const home = opts.home ?? os.homedir();
  try {
    switch (id) {
      case "claude":
        return { detected: existsSync(path.join(home, ".claude")) };
      case "codex": {
        const p = path.join(home, ".codex", "sessions");
        return { detected: existsSync(p) && readdirSync(p).length > 0 };
      }
      case "hermes":
        return { detected: existsSync(path.join(home, ".hermes", "state.db")) };
      case "atlas": {
        for (const root of opts.projectRoots ?? []) {
          const hit = findAtlas(root, opts.maxDepth ?? 3);
          if (hit) return { detected: true, detail: hit };
        }
        return { detected: false };
      }
      default:
        return { detected: false, detail: `unknown source: ${id}` };
    }
  } catch (e) {
    return { detected: false, detail: String(e) };
  }
}

function findAtlas(root: string, depth: number): string | null {
  if (depth < 0 || !existsSync(root)) return null;
  const direct = path.join(root, ".atlas", "sessions.db");
  if (existsSync(direct)) return direct;
  let entries: string[];
  try { entries = readdirSync(root); } catch { return null; }
  for (const e of entries) {
    if (e.startsWith(".")) continue;
    const child = path.join(root, e);
    try { if (!statSync(child).isDirectory()) continue; } catch { continue; }
    const hit = findAtlas(child, depth - 1);
    if (hit) return hit;
  }
  return null;
}
```

- [ ] **Step 4: Write `lib/adapters/external/ndjson.ts`**

```ts
import { validateRecord, RECORD_KINDS, type WatchtowerRecord } from "@/lib/core/records.ts";

export interface NdjsonResult { records: WatchtowerRecord[]; malformed: number }

/**
 * Parse NDJSON into records.
 *
 * A malformed line is counted and SKIPPED; the stream continues. One bad line
 * from a third-party adapter must not abort an otherwise good ingest.
 *
 * Authority is forced to "enrichment" regardless of what the payload claims.
 * An external producer must not be able to seize ownership of Claude's token
 * counts by asserting it in its own JSON; that grant lives in config only.
 */
export function parseNdjson(input: string): NdjsonResult {
  const records: WatchtowerRecord[] = [];
  let malformed = 0;

  for (const raw of input.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (!(RECORD_KINDS as readonly string[]).includes(String(parsed.kind))) {
        parsed.kind = "custom";
      }
      parsed.authority = "enrichment";
      records.push(validateRecord(parsed));
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}
```

- [ ] **Step 5: Write `bin/watchtower`**

```js
#!/usr/bin/env node
// Watchtower CLI. Zero dependencies.
//
// Usage:
//   watchtower ingest --stdin --source <id>
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (argv[i + 1]?.startsWith("--") ? true : argv[i + 1]);
}

if (cmd !== "ingest") {
  console.error("usage: watchtower ingest --stdin --source <id>");
  process.exit(2);
}

const source = flag("source");
if (!source) {
  console.error("--source is required and must be registered in config");
  process.exit(2);
}

const { parseNdjson } = await import("../lib/adapters/external/ndjson.ts");
const input = readFileSync(0, "utf8");
const { records, malformed } = parseNdjson(input);
console.log(JSON.stringify({ source, parsed: records.length, malformed }));
```

> **Resolved:** Node v24.11.0 strips types natively, so this import works as
> written provided the `.ts` extension is present and `allowImportingTsExtensions`
> is set. Verify with `echo "" | node bin/watchtower ingest --stdin --source x`.

- [ ] **Step 6: Extend the carriers guard**

Modify `tests/capture-scripts.test.ts`. Find the `carriers` array (~line 83) and
add the new directories, walking them recursively:

```ts
    const carriers = [
      ...SCRIPTS.filter((n) => n !== "rollup.sh").map((n) => path.join(CAPTURE, n)),
      path.join(ROOT, "lib", "config.ts"),
      path.join(ROOT, "lib", "projects.ts"),
      // Stage 3A: the normalized layer is exactly where "just compute the gap
      // here, it's only for display" would land next.
      ...walkTs(path.join(ROOT, "lib", "core")),
      ...walkTs(path.join(ROOT, "lib", "adapters")),
    ];
```

Add the helper near the top of the file:

```ts
function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walkTs(p) : p.endsWith(".ts") ? [p] : [];
  });
}
```

Ensure `existsSync` and `readdirSync` are imported from `node:fs`.

- [ ] **Step 7: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: PASS. The regression baseline from Task 1 must still match **exactly**.

- [ ] **Step 8: Plant the carriers-guard mutation**

Add `const x = "MIN(gap, 1)";` to `lib/core/ingest.ts`.
Run: `npx vitest run tests/capture-scripts.test.ts`
Expected: FAIL naming `lib/core/ingest.ts`. **Revert.**

- [ ] **Step 9: Commit**

```bash
git add lib/core/discovery.ts lib/adapters/ bin/watchtower package.json \
        tests/core-discovery.test.ts tests/external-ndjson.test.ts \
        tests/capture-scripts.test.ts
git commit -m "feat(stage-3a): discovery, NDJSON boundary, CLI, carriers guard

detectSource never throws -- a missing source is a state, not an error.
Atlas discovery is bounded to configured project roots at fixed depth,
because Atlas state is per-repository and an unbounded home-directory
scan is not acceptable.

parseNdjson counts a malformed line and continues rather than aborting
the stream, maps an unknown kind to 'custom' rather than dropping the
record, and FORCES authority to enrichment regardless of what the
payload claims -- an external producer must not seize ownership of
Claude's token counts by asserting it in its own JSON.

The carriers guard now walks lib/core and lib/adapters recursively. The
normalized layer is exactly where 'just compute the gap here, it is only
for display' would land next. Mutation-checked."
```

---

## Self-review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2 schema split, `CC_SCHEMA_VERSION` stays 4 | 3 |
| §3A.1 record envelope | 4 |
| §3A.2 adapter contract | 5 |
| §3A.3 `wt_*` DDL | 3 |
| §3A.4 authority enforcement | 7 |
| §3A.5 discovery | 8 |
| §3A.6 NDJSON boundary | 8 |
| §3A.7 regression baseline | 1 |
| §5 mutation checks 4, 5, 8, 10, 11 | 7, 6, 8, 1, 3 |
| §6 no capture changes | Global Constraints; no task touches `capture/` |

**Gaps deliberately left:** mutation checks 1, 2, 3 (snapshot `SUM`, snapshot
tokens, `claude_sessions` join) belong to **Stage 3B**, where the Claude adapter
that could commit them is written. Checks 6, 7, 9 (rate-limit NULL, clamping,
loopback bind) belong to **Stage 3C**. Check 12 (Atlas allowlist) belongs to
**Stage 4**. None is dropped; each lands with the code it guards.

**Type consistency:** `DetectionResult` and `AdapterHealth` are defined in
`adapters.ts` and imported by `discovery.ts`. `WatchtowerRecord` flows
`records.ts` → `ingest.ts` → `ndjson.ts`. `LinkKind` is used identically in
`identity.ts` and `ingest.ts` (`"same_session"`). `applyWtSchema` is the single
entry point for schema creation in every test helper.

**Known follow-up: none.** The one open implementation question — running
TypeScript from `bin/watchtower` with no build step — was resolved before
execution by measuring Node v24.11.0's native type stripping. See Tech Stack.
