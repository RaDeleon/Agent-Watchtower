# Stage 2 — Per-request token tracking: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Watchtower's token figures — currently wrong by 63–201× — with exact per-request usage ingested from Claude Code's own transcripts into a durable `claude_requests` table.

**Architecture:** A new `capture/ingest.sh` scans `~/.claude/projects/**/*.jsonl` incrementally, extracts one row per `requestId` via `jq`, and upserts with `MAX` per token field — order-independent, commutative and idempotent, which makes the file cursor a speed optimization and never a correctness dependency. `rollup.sh` then aggregates tokens by `day(ts)` and `(project_key, day(ts))` **straight off `claude_requests`, never through `claude_sessions`**, because 22.7% of output tokens belong to pre-install sessions that have no session row.

**Tech Stack:** bash 3.2, sqlite3, jq, awk. TypeScript + vitest for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-11-stage-2-per-request-tokens.md` (merged, PR #3). Read it alongside this plan; every "§" reference below points into it.

## Global Constraints

- **bash 3.2 compatible.** `/usr/bin/env bash` resolves to 3.2 on stock macOS. No `${v//"x"/"y"}` double-quoted replacements, no associative arrays, no `mapfile`, no `${x^^}`.
- **Dependencies are frozen at `git`, `sqlite3`, `jq`, `awk`, `bc`.** Adding `python3` is out of scope and was rejected on the record (§4.3). `python3` may appear in *test* helpers only.
- **Never test against the live DB.** Copy with `sqlite3 .backup` (never `cp` — it is WAL), point `THEONE_DB_PATH` at the copy, and give **each copy its own directory**: the `.schema-vN` marker lives in the database's *directory*, so two DBs in one directory share a marker and the second silently gets no schema. This bit three times during session 4.
- **Never run `install.sh` without `CLAUDE_DIR`** pointed at a temp dir. It defaults to `$HOME/.claude`, which is the live install.
- **No model constants outside `rollup.sh`.** `tests/capture-scripts.test.ts` fails the build when one appears in any other `carriers` file. `ingest.sh` must contain no activity-model or rank numbers.
- **The hook-invoked path must stay silent and never abort the caller.** `cc_sql`/`cc_sql_val` swallow errors by design. `rollup.sh`'s three `exit 1` paths are the documented exception and are not on the hook path.
- **`CC_SCHEMA_VERSION` must be bumped when adding a table** (`lib.sh:244`). Stage 1.5 added two tables under an unchanged version and the rollup aborted silently from a `--quiet` hook.
- **Tests pin `TZ: "UTC"`.** The rollup buckets by *local* day; `tests/helpers/fixture-db.ts` already sets it.
- **`_pk` is the only place reserved project keys are minted** (`rollup.sh:230`). Never duplicate its `CASE`.

---

## File Structure

| File | Responsibility |
|---|---|
| `capture/lib.sh` | **Modify.** `CC_SCHEMA_VERSION` 3→4; two new tables in `cc_schema_sql`. Still the single source of truth for schema and encoders. |
| `capture/ingest.sh` | **Create.** The only file that knows the transcript format. Discovery, cursor, `jq` extraction, upsert. No model math. |
| `capture/rollup.sh` | **Modify.** `_pk` gains request cwds; `_dtok`/`_ptok` day-grouped token aggregates; daily and project inserts driven from a UNION'd key space; hygiene guard. |
| `capture/install.sh` | **Modify.** Install `ingest.sh`; rewrite the `SessionEnd` chain; retire the old chain string explicitly. |
| `tests/fixtures/make-transcripts.sh` | **Create.** Builds synthetic transcript trees, one function per scenario. Mirrors `make-fixture.sh`'s `fx_sql` discipline. |
| `tests/fixtures/make-fixture.sh` | **Modify.** New scenarios carrying request rows, including an orphan. |
| `tests/ingest.test.ts` | **Create.** Parsing, dedup, idempotence, cursor, robustness. |
| `tests/capture-scripts.test.ts` | **Modify.** `ingest.sh` into `SCRIPTS`; schema-version assertions. |
| `tests/install.test.ts` | **Modify.** New chain registered, old spelling retired, near-miss preserved. |
| `tests/project-rollup.test.ts` | **Modify.** Identity across the orphan case. |
| `tests/activity-model.test.ts` | **Modify.** Hours unmoved; hygiene zeroed on session-less days. |

---

## Task 1: Schema v4 — the two new tables

**Files:**
- Modify: `capture/lib.sh:18` (version), `capture/lib.sh:196-213` (append tables inside `cc_schema_sql`)
- Test: `tests/capture-scripts.test.ts`

**Interfaces:**
- Consumes: `cc_init_db`, `cc_schema_sql`, `cc_db_dir` (existing).
- Produces: tables `claude_requests` and `claude_ingest_cursor`; `CC_SCHEMA_VERSION=4`; marker file `.schema-v4`.

- [ ] **Step 1: Write the failing test**

In `tests/capture-scripts.test.ts`:

```ts
describe("schema v4", () => {
  it("creates claude_requests and claude_ingest_cursor, and stamps .schema-v4", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-v4-"));
    const db = path.join(dir, "fixture.sqlite");
    execFileSync("bash", ["-c", `. "${LIB}"; cc_init_db`], {
      env: { ...process.env, THEONE_DB_PATH: db }, encoding: "utf8",
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
    execFileSync("bash", ["-c", `. "${LIB}"; CC_SCHEMA_VERSION=3; cc_init_db`], {
      env: { ...process.env, THEONE_DB_PATH: db }, encoding: "utf8",
    });
    execFileSync("sqlite3", [db,
      "INSERT INTO claude_sessions(session_id, started_at) VALUES('s1', 1750000000);"]);
    execFileSync("bash", ["-c", `. "${LIB}"; cc_init_db`], {
      env: { ...process.env, THEONE_DB_PATH: db }, encoding: "utf8",
    });
    expect(execFileSync("sqlite3", [db, "SELECT count(*) FROM claude_sessions;"],
      { encoding: "utf8" }).trim()).toBe("1");
    expect(execFileSync("sqlite3", [db, "SELECT count(*) FROM claude_requests;"],
      { encoding: "utf8" }).trim()).toBe("0");
  });

  it("declares schema version 4", () => {
    const lib = readFileSync(path.join(CAPTURE, "lib.sh"), "utf8");
    expect(lib).toMatch(/^CC_SCHEMA_VERSION=4$/m);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/capture-scripts.test.ts -t "schema v4"`
Expected: FAIL — `claude_requests` absent, and `CC_SCHEMA_VERSION=3`.

- [ ] **Step 3: Bump the version**

`capture/lib.sh:18`:

```bash
CC_SCHEMA_VERSION=4
```

- [ ] **Step 4: Add the tables inside `cc_schema_sql`**

Append **before** the closing `SQL` heredoc terminator in `cc_schema_sql`:

```sql
-- One row per Claude API request, ingested from ~/.claude/projects transcripts
-- by ingest.sh. DURABLE, unlike the rollup tables: it is never DELETEd and
-- rebuilt, because transcripts are deleted after cleanupPeriodDays and a
-- rebuild-from-filesystem design would zero the token history the day cleanup
-- ran. Same reasoning as claude_project_paths -- a cached answer must outlive
-- the thing it was derived from.
--
-- request_id is the idempotency key. 47% of transcript usage rows are
-- duplicates of one already seen (49,774 rows -> 26,270 requests measured
-- 2026-09-11), and 2,115 requestIds carry monotonically GROWING output_tokens
-- across copies because streaming writes partials. So the upsert takes MAX per
-- token field, never first-seen: see ingest.sh.
--
-- Deliberately NO project_path column. Stage 1.5 shipped
-- claude_events.project_path, which nothing reads; cwd resolves through
-- claude_project_paths at rollup time instead.
CREATE TABLE IF NOT EXISTS claude_requests (
  request_id             TEXT PRIMARY KEY,
  message_id             TEXT,
  session_id             TEXT,    -- joins claude_sessions, but MAY NOT MATCH ONE:
                                  -- 22.4% of requests predate the tracker
  ts                     INTEGER, -- unix seconds, from the ISO timestamp
  cwd                    TEXT,
  git_branch             TEXT,
  model                  TEXT,
  effort                 TEXT,
  service_tier           TEXT,
  is_sidechain           INTEGER DEFAULT 0,
  entrypoint             TEXT,
  cc_version             TEXT,
  tokens_in              INTEGER DEFAULT 0,
  tokens_out             INTEGER DEFAULT 0,
  tokens_cache_read      INTEGER DEFAULT 0,
  tokens_cache_creation  INTEGER DEFAULT 0,
  attribution_skill      TEXT,
  attribution_mcp_server TEXT,
  attribution_mcp_tool   TEXT,
  attribution_plugin     TEXT,
  api_error_status       TEXT,
  ingested_at            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_requests_ts      ON claude_requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_session ON claude_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_requests_skill   ON claude_requests(attribution_skill);
CREATE INDEX IF NOT EXISTS idx_requests_cwd     ON claude_requests(cwd);

-- Per-file ingest progress. ADVISORY ONLY: correctness comes from
-- claude_requests.request_id being a primary key, so deleting this table costs
-- a slower run and nothing else. Never treat a cursor as proof a file was read.
CREATE TABLE IF NOT EXISTS claude_ingest_cursor (
  file_path  TEXT PRIMARY KEY,
  bytes_read INTEGER,
  mtime      INTEGER,
  updated_at INTEGER
);
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run tests/capture-scripts.test.ts`
Expected: PASS, all pre-existing tests included.

- [ ] **Step 6: Commit**

```bash
git add capture/lib.sh tests/capture-scripts.test.ts
git commit -m "feat(stage-2): schema v4 — claude_requests and claude_ingest_cursor

New tables need the CC_SCHEMA_VERSION bump or an existing install's marker
short-circuits cc_init_db's fast path and they never arrive (lib.sh:244).
claude_requests is durable, not rebuilt: transcripts are deleted after
cleanupPeriodDays, so a rebuild-from-filesystem design would zero the history."
```

---

## Task 2: Transcript fixtures and `ingest.sh` extraction

**Files:**
- Create: `capture/ingest.sh`, `tests/fixtures/make-transcripts.sh`, `tests/ingest.test.ts`
- Modify: `tests/capture-scripts.test.ts:14` (`SCRIPTS` array)

**Interfaces:**
- Consumes: `cc_db_path`, `cc_init_db`, `cc_have_deps` from `lib.sh`; `CC_LIB_PATH` test seam exactly as `hook.sh` and `rollup.sh` use it.
- Produces: `bash capture/ingest.sh [--quiet] [--backfill]`, reading `WATCHTOWER_TRANSCRIPTS_DIR` (default `$HOME/.claude/projects`), writing `claude_requests` and `claude_ingest_cursor`. Exit 0 always on the hook path.
- Produces: `bash tests/fixtures/make-transcripts.sh <scenario> <dir>`.

- [ ] **Step 1: Write the transcript fixture builder**

`tests/fixtures/make-transcripts.sh`:

```bash
#!/usr/bin/env bash
# make-transcripts.sh <scenario> <dir>
#
# Builds a synthetic ~/.claude/projects tree so ingest.sh can be asserted
# against a known request stream. Fails LOUDLY (set -e), for the same reason
# make-fixture.sh does: a silent fixture failure means assertions run against
# a tree that was never built.
set -euo pipefail

scenario="${1:?scenario required}"
root="${2:?dir required}"

# 2026-06-13T01:28:57.263Z == 1781314137, deliberately BEFORE the tracker's
# first day so the orphan case is reachable.
mkfile() { mkdir -p "$(dirname "$1")"; : > "$1"; }

# rec <file> <requestId> <sessionId> <iso-ts> <cwd> <out-tokens> [extra-json]
rec() {
  local f="$1" rid="$2" sid="$3" ts="$4" cwd="$5" out="$6" extra="${7:-}"
  local base
  base=$(printf '{"requestId":"%s","sessionId":"%s","timestamp":"%s","cwd":"%s","gitBranch":"main","version":"2.0.0","entrypoint":"cli","effort":"high","isSidechain":false,"message":{"id":"msg_%s","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":%s,"cache_read_input_tokens":1000,"cache_creation_input_tokens":100,"service_tier":"standard"}}}' \
    "$rid" "$sid" "$ts" "$cwd" "$rid" "$out")
  if [ -n "$extra" ]; then
    printf '%s\n' "$base" | jq -c ". + $extra" >> "$f"
  else
    printf '%s\n' "$base" >> "$f"
  fi
}

P="$root/-tmp-fx"
case "$scenario" in
  single)
    mkfile "$P/s1.jsonl"
    rec "$P/s1.jsonl" req_a s1 "2026-07-10T10:00:00.000Z" /tmp/fx 100
    rec "$P/s1.jsonl" req_b s1 "2026-07-10T10:05:00.000Z" /tmp/fx 200
    ;;
  streaming-partials)
    # Same requestId three times with GROWING output_tokens. first-seen-wins
    # would record 5; MAX records 900.
    mkfile "$P/s1.jsonl"
    rec "$P/s1.jsonl" req_g s1 "2026-07-10T10:00:00.000Z" /tmp/fx 5
    rec "$P/s1.jsonl" req_g s1 "2026-07-10T10:00:01.000Z" /tmp/fx 400
    rec "$P/s1.jsonl" req_g s1 "2026-07-10T10:00:02.000Z" /tmp/fx 900
    ;;
  cross-file-duplicate)
    # One request in a parent AND a subagent transcript, partial + sidechain in
    # the subagent copy. Must count ONCE, at 900, is_sidechain 0.
    mkfile "$P/s1.jsonl"; mkfile "$P/s1/subagents/agent-x.jsonl"
    rec "$P/s1.jsonl" req_d s1 "2026-07-10T10:00:00.000Z" /tmp/fx 900
    rec "$P/s1/subagents/agent-x.jsonl" req_d s1 "2026-07-10T10:00:00.000Z" /tmp/fx 3 \
      '{"isSidechain":true}'
    ;;
  attributed)
    mkfile "$P/s1.jsonl"
    rec "$P/s1.jsonl" req_s s1 "2026-07-10T10:00:00.000Z" /tmp/fx 100 \
      '{"attributionSkill":"superpowers:brainstorming"}'
    rec "$P/s1.jsonl" req_m s1 "2026-07-10T10:01:00.000Z" /tmp/fx 100 \
      '{"attributionMcpServer":"claude-in-chrome","attributionMcpTool":"computer","attributionPlugin":"cic"}'
    ;;
  malformed)
    mkfile "$P/s1.jsonl"
    rec "$P/s1.jsonl" req_ok1 s1 "2026-07-10T10:00:00.000Z" /tmp/fx 100
    printf '%s\n' 'THIS IS NOT JSON {{{' >> "$P/s1.jsonl"
    printf '%s\n' '{"type":"user","message":{"role":"user","content":"hi"}}' >> "$P/s1.jsonl"
    rec "$P/s1.jsonl" req_ok2 s1 "2026-07-10T10:02:00.000Z" /tmp/fx 100
    ;;
  orphan)
    # A request whose session has no claude_sessions row, dated BEFORE the
    # tracker's first day. This is the 22.7%-of-tokens case.
    mkfile "$P/pre.jsonl"
    rec "$P/pre.jsonl" req_o1 s_ghost "2026-06-13T01:28:57.263Z" /tmp/fx 700
    ;;
  *) echo "unknown scenario: $scenario" >&2; exit 1 ;;
esac
```

- [ ] **Step 2: Write the failing extraction test**

`tests/ingest.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "capture", "lib.sh");
const INGEST = path.join(ROOT, "capture", "ingest.sh");
const MAKE_TX = path.join(ROOT, "tests", "fixtures", "make-transcripts.sh");

/** Build a transcript tree, ingest it, return the db path. Each DB in its OWN
 *  directory: the .schema-vN marker is per-directory. */
export function ingestScenario(scenario: string, args: string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), `wt-ing-${scenario}-`));
  const tx = path.join(dir, "projects");
  const dbDir = path.join(dir, "db");
  execFileSync("mkdir", ["-p", tx, dbDir]);
  execFileSync("bash", [MAKE_TX, scenario, tx], { encoding: "utf8" });
  const db = path.join(dbDir, "fixture.sqlite");
  execFileSync("bash", [INGEST, "--quiet", ...args], {
    env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB,
           WATCHTOWER_TRANSCRIPTS_DIR: tx, TZ: "UTC" },
    encoding: "utf8",
  });
  return db;
}
export function q(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

describe("ingest extracts one row per request", () => {
  it("records both requests with their token fields and metadata", () => {
    const db = ingestScenario("single");
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("2");
    expect(q(db, "SELECT tokens_out FROM claude_requests WHERE request_id='req_a';")).toBe("100");
    expect(q(db, "SELECT tokens_in, tokens_cache_read, tokens_cache_creation FROM claude_requests WHERE request_id='req_a';"))
      .toBe("10|1000|100");
    expect(q(db, "SELECT model, effort, service_tier, git_branch, cc_version, entrypoint FROM claude_requests WHERE request_id='req_a';"))
      .toBe("claude-opus-5|high|standard|main|2.0.0|cli");
    expect(q(db, "SELECT session_id, cwd FROM claude_requests WHERE request_id='req_a';"))
      .toBe("s1|/tmp/fx");
  });

  it("converts the millisecond ISO timestamp to unix seconds", () => {
    const db = ingestScenario("single");
    // 2026-07-10T10:00:00.000Z
    expect(q(db, "SELECT ts FROM claude_requests WHERE request_id='req_a';")).toBe("1783677600");
  });

  it("captures skill, MCP and plugin attribution", () => {
    const db = ingestScenario("attributed");
    expect(q(db, "SELECT attribution_skill FROM claude_requests WHERE request_id='req_s';"))
      .toBe("superpowers:brainstorming");
    expect(q(db, "SELECT attribution_mcp_server, attribution_mcp_tool, attribution_plugin FROM claude_requests WHERE request_id='req_m';"))
      .toBe("claude-in-chrome|computer|cic");
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run tests/ingest.test.ts`
Expected: FAIL — `capture/ingest.sh` does not exist.

- [ ] **Step 4: Write `capture/ingest.sh`**

```bash
#!/usr/bin/env bash
# ingest.sh — per-request token usage from Claude Code transcripts.
#
# Installed as ~/.claude/watchtower-ingest.sh and chained on SessionEnd BEFORE
# the rollup, so the rollup sees this session's requests in the same run that
# records its end.
#
# WHY THIS EXISTS: snapshot.sh can only see .context_window.current_usage --
# context-window OCCUPANCY, not cumulative usage -- so every token figure
# derived from snapshots is wrong by 63-201x. The transcripts carry the real
# per-request usage, plus cwd, branch, effort and skill/MCP attribution, and
# they are historical. No proxy required.
#
# THE ONE RULE THAT MUST NOT MOVE: the upsert takes MAX per token field.
# 47% of transcript usage rows repeat a requestId already seen, and 2,115 of
# them carry monotonically GROWING output_tokens because streaming writes
# partials -- so first-seen-wins UNDERCOUNTS. MAX is order-independent,
# commutative and idempotent, which is what makes the cursor advisory: drop
# claude_ingest_cursor and the next run converges on identical numbers.
set -uo pipefail

CC_LIB_PATH="${CC_LIB_PATH:-$HOME/.claude/cc-track-lib.sh}"
# shellcheck source=/dev/null
[ -r "$CC_LIB_PATH" ] && . "$CC_LIB_PATH" || exit 0

QUIET=0
BACKFILL=0
for a in "$@"; do
  case "$a" in
    --quiet)    QUIET=1 ;;
    --backfill) BACKFILL=1 ;;
  esac
done
say() { [ "$QUIET" = 1 ] || printf 'ingest: %s\n' "$*"; }

cc_have_deps || exit 0
cc_init_db

TX_DIR="${WATCHTOWER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}"
[ -d "$TX_DIR" ] || { say "no transcripts at $TX_DIR"; exit 0; }

db="$(cc_db_path)"
work="$(mktemp -d)" || exit 0
trap 'rm -rf "$work"' EXIT
tsv="$work/rows.tsv"
: > "$tsv"
: > "$work/cursors.sql"

# Free-text fields are gsub'd of tabs/newlines/CRs before @tsv, because
# sqlite3's .import in tabs mode does NOT unescape jq's \t and \n. These are
# paths, branch names and identifiers, so collapsing whitespace is lossless in
# practice and deliberate.
#
# -R with `fromjson? // empty` is what makes a corrupt transcript harmless: a
# line that will not parse is dropped and the rest of the file still lands.
# Without it one bad byte aborts jq and the whole file is skipped.
JQ_ROW='
  fromjson? // empty
  | select(.message.usage != null and (.requestId // "") != "")
  | def clean: (. // "") | tostring | gsub("[\t\n\r]"; " ");
  [ .requestId,
    (.message.id | clean),
    ((.sessionId // .session_id) | clean),
    (((.timestamp // "") | if . == "" then 0
       else (sub("\\.[0-9]+"; "") | fromdateiso8601) end)),
    (.cwd | clean),
    (.gitBranch | clean),
    (.message.model | clean),
    (.effort | clean),
    (.message.usage.service_tier | clean),
    (if .isSidechain then 1 else 0 end),
    (.entrypoint | clean),
    (.version | clean),
    (.message.usage.input_tokens // 0),
    (.message.usage.output_tokens // 0),
    (.message.usage.cache_read_input_tokens // 0),
    (.message.usage.cache_creation_input_tokens // 0),
    (.attributionSkill | clean),
    (.attributionMcpServer | clean),
    (.attributionMcpTool | clean),
    (.attributionPlugin | clean),
    (.apiErrorStatus | clean)
  ] | @tsv'

now="$(cc_now)"
files=0
scanned=0

# `find -print0 | while read -d ""` keeps paths with spaces intact. The loop
# body runs in a subshell under a pipe, so counters are accumulated in files
# rather than variables.
while IFS= read -r -d '' f; do
  files=$((files + 1))
  size=$(wc -c < "$f" 2>/dev/null | tr -d ' ') || continue
  mtime=$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)

  offset=0
  if [ "$BACKFILL" = 0 ]; then
    row="$(cc_sql_val "SELECT bytes_read || '|' || mtime FROM claude_ingest_cursor
                       WHERE file_path = $(cc_sqlstr "$f");")"
    if [ -n "$row" ]; then
      prev_bytes="${row%%|*}"
      prev_mtime="${row##*|}"
      # Unchanged: skip entirely. Grown: resume. Shrunk or mtime moved
      # BACKWARDS: the file was rewritten, so re-read it whole.
      if [ "$size" = "$prev_bytes" ] && [ "$mtime" = "$prev_mtime" ]; then
        continue
      elif [ "$size" -gt "$prev_bytes" ] && [ "$mtime" -ge "$prev_mtime" ]; then
        offset="$prev_bytes"
      fi
    fi
  fi

  if [ "$offset" -gt 0 ]; then
    tail -c +$((offset + 1)) "$f" 2>/dev/null
  else
    cat "$f" 2>/dev/null
  fi | grep '"usage"' 2>/dev/null | jq -Rrc "$JQ_ROW" 2>/dev/null >> "$tsv" || true

  scanned=$((scanned + 1))
  printf 'INSERT INTO claude_ingest_cursor(file_path,bytes_read,mtime,updated_at)
           VALUES(%s,%s,%s,%s)
           ON CONFLICT(file_path) DO UPDATE SET
             bytes_read=excluded.bytes_read, mtime=excluded.mtime,
             updated_at=excluded.updated_at;\n' \
    "$(cc_sqlstr "$f")" "$(cc_sqlnum "$size")" "$(cc_sqlnum "$mtime")" "$now" \
    >> "$work/cursors.sql"
done < <(find "$TX_DIR" -type f -name '*.jsonl' -print0 2>/dev/null)

rows=$(wc -l < "$tsv" | tr -d ' ')
if [ "${rows:-0}" -eq 0 ]; then
  say "scanned $files file(s), no new requests"
  # Cursors still advance: a file with no usable rows has still been read.
  [ -s "$work/cursors.sql" ] && sqlite3 -cmd ".timeout 4000" "$db" < "$work/cursors.sql" >/dev/null 2>&1
  exit 0
fi

# One transaction: the temp table, the upsert, then the cursors. A failure
# anywhere rolls the whole thing back and the next run redoes it -- which is
# safe precisely because the upsert is idempotent.
sqlite3 -cmd ".timeout 4000" "$db" <<SQL >/dev/null 2>&1
.bail on
BEGIN IMMEDIATE;
CREATE TEMP TABLE _incoming (
  request_id TEXT, message_id TEXT, session_id TEXT, ts INTEGER,
  cwd TEXT, git_branch TEXT, model TEXT, effort TEXT, service_tier TEXT,
  is_sidechain INTEGER, entrypoint TEXT, cc_version TEXT,
  tokens_in INTEGER, tokens_out INTEGER,
  tokens_cache_read INTEGER, tokens_cache_creation INTEGER,
  attribution_skill TEXT, attribution_mcp_server TEXT,
  attribution_mcp_tool TEXT, attribution_plugin TEXT, api_error_status TEXT
);
.mode tabs
.import "$tsv" _incoming

INSERT INTO claude_requests (
  request_id, message_id, session_id, ts, cwd, git_branch, model, effort,
  service_tier, is_sidechain, entrypoint, cc_version,
  tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation,
  attribution_skill, attribution_mcp_server, attribution_mcp_tool,
  attribution_plugin, api_error_status, ingested_at)
SELECT
  request_id,
  NULLIF(message_id,''), NULLIF(session_id,''), ts,
  NULLIF(cwd,''), NULLIF(git_branch,''), NULLIF(model,''), NULLIF(effort,''),
  NULLIF(service_tier,''), COALESCE(is_sidechain,0),
  NULLIF(entrypoint,''), NULLIF(cc_version,''),
  MAX(COALESCE(tokens_in,0)), MAX(COALESCE(tokens_out,0)),
  MAX(COALESCE(tokens_cache_read,0)), MAX(COALESCE(tokens_cache_creation,0)),
  NULLIF(attribution_skill,''), NULLIF(attribution_mcp_server,''),
  NULLIF(attribution_mcp_tool,''), NULLIF(attribution_plugin,''),
  NULLIF(api_error_status,''), $now
FROM _incoming
WHERE COALESCE(request_id,'') <> ''
-- Collapse duplicates WITHIN this batch before they reach the upsert, by the
-- same MAX rule. Without this, which copy wins depends on insertion order.
GROUP BY request_id
ON CONFLICT(request_id) DO UPDATE SET
  tokens_in             = MAX(tokens_in,             excluded.tokens_in),
  tokens_out            = MAX(tokens_out,            excluded.tokens_out),
  tokens_cache_read     = MAX(tokens_cache_read,     excluded.tokens_cache_read),
  tokens_cache_creation = MAX(tokens_cache_creation, excluded.tokens_cache_creation),
  is_sidechain          = MIN(is_sidechain,          excluded.is_sidechain),
  attribution_skill      = COALESCE(attribution_skill,      excluded.attribution_skill),
  attribution_mcp_server = COALESCE(attribution_mcp_server, excluded.attribution_mcp_server),
  attribution_mcp_tool   = COALESCE(attribution_mcp_tool,   excluded.attribution_mcp_tool),
  attribution_plugin     = COALESCE(attribution_plugin,     excluded.attribution_plugin),
  api_error_status       = COALESCE(api_error_status,        excluded.api_error_status);

COMMIT;
SQL

sqlite3 -cmd ".timeout 4000" "$db" < "$work/cursors.sql" >/dev/null 2>&1
say "scanned $scanned of $files file(s), $rows row(s) offered"
exit 0
```

> **Note on the identity fields.** `ts`, `cwd`, `git_branch`, `model`, `effort`, `service_tier`, `session_id`, `message_id`, `entrypoint`, `cc_version` are **absent from the `DO UPDATE` list on purpose** — they describe the request, which does not change as it streams, so rewriting them is churn with no information gain (spec §4.2). `isSidechain` is the one field where copies genuinely disagree, which is why it is the one with a rule.

- [ ] **Step 5: Make `ingest.sh` executable and add it to the bash-syntax guard**

```bash
chmod +x capture/ingest.sh
```

`tests/capture-scripts.test.ts:14`:

```ts
const SCRIPTS = ["lib.sh", "hook.sh", "rollup.sh", "snapshot.sh", "install.sh", "ingest.sh"];
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `npx vitest run tests/ingest.test.ts tests/capture-scripts.test.ts`
Expected: PASS. The `SCRIPTS` addition also gives `ingest.sh` the `bash -n` check and the model-constant guard.

- [ ] **Step 7: Commit**

```bash
git add capture/ingest.sh tests/fixtures/make-transcripts.sh tests/ingest.test.ts tests/capture-scripts.test.ts
git commit -m "feat(stage-2): ingest.sh extracts per-request usage from transcripts

jq -R with 'fromjson? // empty' so one corrupt line drops that line rather
than the whole file. Free-text fields are gsub'd of tabs before @tsv because
sqlite3's .import does not unescape them."
```

---

## Task 3: Dedup, idempotence and robustness

**Files:**
- Modify: `capture/ingest.sh` (only if a test exposes a defect), `tests/ingest.test.ts`

**Interfaces:**
- Consumes: `ingestScenario`, `q` from Task 2's test file.
- Produces: nothing new. This task proves the guarantees the whole design rests on.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ingest.test.ts`:

```ts
describe("the MAX rule", () => {
  it("streaming partials converge to the LARGEST output_tokens, not the first", () => {
    const db = ingestScenario("streaming-partials");
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("1");
    // first-seen-wins would record 5. This is the 2,115-request case.
    expect(q(db, "SELECT tokens_out FROM claude_requests WHERE request_id='req_g';")).toBe("900");
  });

  it("counts a request appearing in two files once, main-chain winning", () => {
    const db = ingestScenario("cross-file-duplicate");
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("1");
    expect(q(db, "SELECT tokens_out, is_sidechain FROM claude_requests WHERE request_id='req_d';"))
      .toBe("900|0");
  });
});

describe("idempotence", () => {
  function reingest(db: string, tx: string, args: string[] = []): void {
    execFileSync("bash", [INGEST, "--quiet", ...args], {
      env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB,
             WATCHTOWER_TRANSCRIPTS_DIR: tx, TZ: "UTC" }, encoding: "utf8" });
  }
  const txOf = (db: string) => path.join(path.dirname(path.dirname(db)), "projects");

  it("re-ingesting the same tree changes nothing", () => {
    const db = ingestScenario("single");
    const before = q(db, "SELECT count(*), SUM(tokens_out) FROM claude_requests;");
    reingest(db, txOf(db));
    reingest(db, txOf(db));
    expect(q(db, "SELECT count(*), SUM(tokens_out) FROM claude_requests;")).toBe(before);
  });

  it("produces identical numbers after the cursor is deleted", () => {
    const db = ingestScenario("single");
    const before = q(db, "SELECT count(*), SUM(tokens_out), SUM(tokens_in) FROM claude_requests;");
    execFileSync("sqlite3", [db, "DELETE FROM claude_ingest_cursor;"]);
    reingest(db, txOf(db));
    expect(q(db, "SELECT count(*), SUM(tokens_out), SUM(tokens_in) FROM claude_requests;")).toBe(before);
  });

  it("--backfill over an already-ingested tree changes nothing", () => {
    const db = ingestScenario("streaming-partials");
    const before = q(db, "SELECT count(*), SUM(tokens_out) FROM claude_requests;");
    reingest(db, txOf(db), ["--backfill"]);
    expect(q(db, "SELECT count(*), SUM(tokens_out) FROM claude_requests;")).toBe(before);
  });

  it("picks up rows appended after the first ingest", () => {
    const db = ingestScenario("single");
    const tx = txOf(db);
    const f = path.join(tx, "-tmp-fx", "s1.jsonl");
    appendFileSync(f, JSON.stringify({
      requestId: "req_c", sessionId: "s1", timestamp: "2026-07-10T11:00:00.000Z",
      cwd: "/tmp/fx", isSidechain: false,
      message: { id: "msg_c", model: "claude-opus-5",
                 usage: { input_tokens: 1, output_tokens: 42,
                          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n");
    reingest(db, tx);
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("3");
    expect(q(db, "SELECT tokens_out FROM claude_requests WHERE request_id='req_c';")).toBe("42");
  });

  it("re-reads a rewritten (shrunk) file instead of resuming past its end", () => {
    const db = ingestScenario("single");
    const tx = txOf(db);
    const f = path.join(tx, "-tmp-fx", "s1.jsonl");
    writeFileSync(f, JSON.stringify({
      requestId: "req_z", sessionId: "s1", timestamp: "2026-07-10T12:00:00.000Z",
      cwd: "/tmp/fx", isSidechain: false,
      message: { id: "msg_z", model: "claude-opus-5",
                 usage: { input_tokens: 1, output_tokens: 7,
                          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n");
    reingest(db, tx);
    expect(q(db, "SELECT tokens_out FROM claude_requests WHERE request_id='req_z';")).toBe("7");
  });
});

describe("robustness", () => {
  it("skips a malformed line and still lands the good rows, exit 0", () => {
    const db = ingestScenario("malformed");
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("2");
    expect(q(db, "SELECT group_concat(request_id) FROM (SELECT request_id FROM claude_requests ORDER BY request_id);"))
      .toBe("req_ok1,req_ok2");
  });

  it("exits 0 and writes nothing when the transcript dir is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-noTx-"));
    const db = path.join(dir, "fixture.sqlite");
    const out = execFileSync("bash", [INGEST, "--quiet"], {
      env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB,
             WATCHTOWER_TRANSCRIPTS_DIR: path.join(dir, "nope"), TZ: "UTC" },
      encoding: "utf8",
    });
    expect(out).toBe("");
  });
});
```

Add to the imports at the top of `tests/ingest.test.ts`:

```ts
import { mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
```

- [ ] **Step 2: Run them and watch which fail**

Run: `npx vitest run tests/ingest.test.ts`
Expected: the MAX, idempotence and robustness blocks pass if Task 2 was implemented faithfully. **Any failure here is a real defect in `ingest.sh`, not a test to relax.**

- [ ] **Step 3: Mutation-check the two tests that carry the design**

Prove each catches the defect it claims. For each mutation: apply, run, confirm **that** test goes red and ideally only it, then revert.

```bash
# Mutation A: MAX -> first-seen. "streaming partials" MUST fail.
#   In ingest.sh, change  tokens_out = MAX(tokens_out, excluded.tokens_out)
#                    to   tokens_out = tokens_out
npx vitest run tests/ingest.test.ts -t "streaming partials"   # expect FAIL

# Mutation B: drop the in-batch GROUP BY. "streaming partials" MUST fail,
# because which copy reaches the upsert first becomes arbitrary.
#   Remove the `GROUP BY request_id` line and the MAX() wrappers in the SELECT.
npx vitest run tests/ingest.test.ts -t "streaming partials"   # expect FAIL

# Mutation C: MIN -> MAX on is_sidechain. "two files once" MUST fail.
npx vitest run tests/ingest.test.ts -t "two files once"       # expect FAIL

# Mutation D: drop `fromjson? // empty`, use plain `jq -rc`. "malformed" MUST fail.
npx vitest run tests/ingest.test.ts -t "malformed"            # expect FAIL
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/ingest.test.ts tests/fixtures/make-transcripts.sh capture/ingest.sh
git commit -m "test(stage-2): pin the MAX rule, idempotence and corrupt-line tolerance

Each test mutation-checked: MAX->first-seen, dropping the in-batch GROUP BY,
MIN->MAX on is_sidechain, and removing 'fromjson? // empty' each turn exactly
the intended test red. The cursor-deletion test pins 'advisory, not
correctness' as behaviour rather than a comment."
```

---

## Task 4: `install.sh` — wire `ingest.sh`, retire the old chain

**Files:**
- Modify: `capture/install.sh:28` (`for f in` list), `:59` (install block), `:66-70` (`SESSION_END_CMD`), `:107-133` (jq filter)
- Test: `tests/install.test.ts`

**Interfaces:**
- Consumes: the existing `ensure($event; $cmd)` jq filter and `install_script`.
- Produces: `$CLAUDE_DIR/watchtower-ingest.sh`; a `SessionEnd` command string of `"$HOOK; $INGEST --quiet …; $ROLLUP --quiet …"`; a new `retire($event; $cmd)` filter.

> **Why a retire step is required.** `ensure` dedupes by **exact string equality**. Changing `SESSION_END_CMD` means the previous two-step string is no longer recognised as ours, so it would be left registered *alongside* the new three-step one and the hook would run twice. `SESSION.md` flags aggressive matching as the cause of a prior hook-deletion bug, so `retire` matches an **explicit list of exact historical strings** — never a substring.

- [ ] **Step 1: Write the failing test**

`tests/install.test.ts` already defines everything needed at the top of the file:
`run(claudeDir)`, `settings(d)` and `commands(d, event)`. Add one seeding helper
beside them, because these cases need a pre-existing `settings.json`:

```ts
/** Fresh CLAUDE_DIR with a pre-seeded settings.json, then install into it. */
function runSeeded(seed: unknown): string {
  const d = mkdtempSync(path.join(tmpdir(), "wt-install-seed-"));
  writeFileSync(path.join(d, "settings.json"), JSON.stringify(seed, null, 2));
  run(d);
  return d;
}
```

Then append this block:

```ts
describe("SessionEnd chain migration", () => {
  /** The exact two-step chain install.sh wrote before Stage 2. */
  const oldChain = (d: string) =>
    `${d}/hooks/cc-track-hook.sh; ${d}/claude-usage-rollup.sh --quiet >/dev/null 2>&1 || true`;

  it("installs watchtower-ingest.sh", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-ing-"));
    run(d);
    expect(existsSync(path.join(d, "watchtower-ingest.sh"))).toBe(true);
  });

  it("runs ingest before the rollup on SessionEnd", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-order-"));
    run(d);
    const cmds = commands(d, "SessionEnd");
    expect(cmds).toHaveLength(1);
    const cmd = cmds[0];
    expect(cmd).toContain("watchtower-ingest.sh --quiet");
    expect(cmd.indexOf("cc-track-hook.sh"))
      .toBeLessThan(cmd.indexOf("watchtower-ingest.sh"));
    expect(cmd.indexOf("watchtower-ingest.sh"))
      .toBeLessThan(cmd.indexOf("claude-usage-rollup.sh"));
  });

  // ensure() dedupes by EXACT string equality, so the pre-Stage-2 chain is no
  // longer recognised as ours. Without retire() it stays registered alongside
  // the new one and SessionEnd runs the hook and rollup twice.
  it("retires the exact previous chain rather than leaving it alongside", () => {
    // The seeded path must match what install.sh will compute, so seed with a
    // placeholder and rewrite it to the real dir after mkdtemp.
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-retire-"));
    writeFileSync(path.join(d, "settings.json"), JSON.stringify({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: oldChain(d) }] }] },
    }, null, 2));
    run(d);
    const cmds = commands(d, "SessionEnd");
    expect(cmds.some((c) => c === oldChain(d))).toBe(false);
    expect(cmds.filter((c) => c.includes("claude-usage-rollup.sh"))).toHaveLength(1);
  });

  // The guard SESSION.md has demanded since Stage 1: a near-miss spelling is
  // the USER's hook, not ours, and deleting it is the bug that shipped once.
  it("does NOT delete a near-miss SessionEnd command it does not own", () => {
    const mine = "/opt/me/claude-usage-rollup.sh --quiet";
    const d = runSeeded({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: mine }] }] },
    });
    expect(commands(d, "SessionEnd")).toContain(mine);
  });

  it("leaves a sibling hook in a shared group untouched", () => {
    const sibling = "/opt/me/obsidian-bg-agent.sh";
    const d = runSeeded({
      hooks: { PostCompact: [{ hooks: [{ type: "command", command: sibling }] }] },
    });
    expect(commands(d, "PostCompact")).toContain(sibling);
  });

  it("is idempotent: a second run changes settings.json not at all", () => {
    const d = mkdtempSync(path.join(tmpdir(), "wt-install-idem-"));
    run(d);
    const first = readFileSync(path.join(d, "settings.json"), "utf8");
    run(d);
    expect(readFileSync(path.join(d, "settings.json"), "utf8")).toBe(first);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/install.test.ts -t "SessionEnd chain migration"`
Expected: FAIL — `watchtower-ingest.sh` is not installed and the chain has no ingest step.

- [ ] **Step 3: Install the script**

`capture/install.sh:28`:

```bash
for f in lib.sh hook.sh rollup.sh snapshot.sh ingest.sh; do
```

Beside the existing `install_script snapshot.sh …` line:

```bash
install_script ingest.sh "$CLAUDE_DIR/watchtower-ingest.sh"
```

- [ ] **Step 4: Rewrite the chain and add `retire`**

Replace the `SESSION_END_CMD` definition:

```bash
INGEST="$CLAUDE_DIR/watchtower-ingest.sh"
# Order matters: ingest BEFORE the rollup, so the rollup aggregates this
# session's requests in the same run that records its end. Both are
# `|| true` -- a tracker must never fail SessionEnd.
SESSION_END_CMD="$HOOK; $INGEST --quiet >/dev/null 2>&1 || true; $ROLLUP --quiet >/dev/null 2>&1 || true"

# Exact historical spellings of OUR SessionEnd command, newest first. `ensure`
# dedupes by exact string equality, so a command whose text we changed is no
# longer recognised as ours and would be left registered alongside the new one.
# This list is EXACT strings only, never substrings: matching on
# `contains("cc-track-hook.sh")` would make the delete step aggressive inside
# the very function that already shipped one hook-deletion bug.
RETIRED_SESSION_END="$HOOK; $ROLLUP --quiet >/dev/null 2>&1 || true"
```

In the `jq` invocation, add the argument and the filter:

```bash
jq --arg hook "$HOOK" --arg sessionEnd "$SESSION_END_CMD" \
   --arg retiredSessionEnd "$RETIRED_SESSION_END" '
  def retire($event; $cmd):
    .hooks[$event] = (
      ((.hooks[$event] // [])
        | map(.hooks = ((.hooks // []) | map(select(.command != $cmd))))
        | map(select(((.hooks // []) | length) > 0)))
    );
  def ensure($event; $cmd):
    ... unchanged ...
  .hooks = (.hooks // {})
  | ensure("SessionStart";     $hook)
  | ensure("UserPromptSubmit"; $hook)
  | ensure("Stop";             $hook)
  | ensure("SubagentStart";    $hook)
  | ensure("SubagentStop";     $hook)
  | ensure("PreCompact";       $hook)
  | ensure("PostCompact";      $hook)
  | retire("SessionEnd";       $retiredSessionEnd)
  | ensure("SessionEnd";       $sessionEnd)
' "$SETTINGS" > "$tmp"
```

> `retire` runs **before** `ensure` so the new command is appended after the stale one is gone. It drops only groups it has emptied, exactly as `ensure` does, and touches no sibling commands.

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run tests/install.test.ts`
Expected: PASS, including every pre-existing install test.

- [ ] **Step 6: Dry-run against a copy of the real `~/.claude` and diff**

This is the procedure that correctly predicted zero `settings.json` change in both prior installs. **Do not skip it.**

```bash
TMPC="$(mktemp -d)"
cp -R ~/.claude/. "$TMPC/" 2>/dev/null || true
# Rewrite absolute paths so the comparison is faithful.
sed -i.bak "s|$HOME/.claude|$TMPC|g" "$TMPC/settings.json"
cp "$TMPC/settings.json" "$TMPC/settings.before.json"
CLAUDE_DIR="$TMPC" bash capture/install.sh
diff <(jq -S . "$TMPC/settings.before.json") <(jq -S . "$TMPC/settings.json")
```

Expected: the **only** difference is the `SessionEnd` command string gaining the ingest step. Every other hook group, matcher and sibling command unchanged. If anything else moves, stop and fix `retire`.

- [ ] **Step 7: Commit**

```bash
git add capture/install.sh tests/install.test.ts
git commit -m "feat(stage-2): install ingest.sh and migrate the SessionEnd chain

ensure() dedupes by exact string equality, so changing SESSION_END_CMD would
leave the old two-step chain registered alongside the new three-step one.
retire() removes an explicit list of exact historical strings -- never a
substring, because aggressive matching in this function is what shipped the
sibling-hook deletion bug."
```

---

## Task 5: `rollup.sh` — day-grouped tokens that never touch `claude_sessions`

**Files:**
- Modify: `capture/rollup.sh:230-238` (`_pk` source), `:371-374` (remove token columns from `_sx`), `:388-407` (daily insert), `:409-414` (json updates), `:416-426` (hygiene), `:430-478` (project insert)
- Modify: `tests/fixtures/make-fixture.sh` (new scenarios), `tests/project-rollup.test.ts`, `tests/activity-model.test.ts`

**Interfaces:**
- Consumes: `claude_requests` (Task 1), `_pk`, `_sx`, `_act` (existing).
- Produces: temp tables `_dtok` (day, tin, tout, tcr, tcw), `_ptok` (project_key, day, tin, tout, tcr, tcw), `_days`, `_pkeys`.

- [ ] **Step 1: Add fixture scenarios carrying requests**

In `tests/fixtures/make-fixture.sh`, add a helper beside `snap()`:

```bash
req() { # req <request-id> <session> <offset-seconds> <cwd> <out-tokens> [sidechain]
  fx_sql "INSERT INTO claude_requests
            (request_id, session_id, ts, cwd, model, tokens_in, tokens_out,
             tokens_cache_read, tokens_cache_creation, is_sidechain, ingested_at)
          VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$2"), $((BASE + $3)),
                  $(cc_sqlstr "$4"), $(cc_sqlstr fx-model),
                  7, $(cc_sqlnum "$5"), 900, 100, ${6:-0}, $BASE);"
}
```

And two scenarios:

```bash
  orphan-request-tokens)
    # One real session with requests, plus a request whose session_id has NO
    # claude_sessions row -- the 22.7%-of-tokens case. Routing tokens through
    # _sx drops the orphan while the identity still passes.
    sess s1 0
    ev   s1 0    SessionStart
    ev   s1 600  Stop
    ev   s1 900  SessionEnd
    snap s1 300  50 60 0.5
    req  r_live s1      600 /tmp/fx 1000
    req  r_ghost s_gone 700 /tmp/fx 500
    ;;
  tokens-only-day)
    # A day with requests and NO sessions at all. Must produce a daily row with
    # active_ms 0, sessions_count 0, non-zero tokens, and hygiene_score 0.
    sess s1 0
    ev   s1 0   SessionStart
    ev   s1 300 SessionEnd
    req  r_future s_gone $((DAY * 3)) /tmp/fx 4242
    ;;
```

- [ ] **Step 2: Write the failing tests**

In `tests/project-rollup.test.ts`, inside the reconciliation `describe`:

```ts
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
```

In `tests/activity-model.test.ts`:

```ts
describe("token correction does not move the activity model", () => {
  it("leaves active, window and idle untouched when requests are added", () => {
    const withReq = buildAndRoll("orphan-request-tokens");
    const t = rows<{ a: number; w: number; i: number }>(withReq,
      "SELECT SUM(active_ms) a, SUM(total_session_ms) w, SUM(idle_ms) i FROM claude_daily_rollups;");
    // MEASURED against the real rollup on 2026-09-11, not derived on paper.
    // Timeline points are 0 (SessionStart), 300 (snapshot), 600 (Stop),
    // 900 (SessionEnd), so three gaps of 300s each: the first counts active,
    // the one ending at Stop counts toward window only, and the one ending at
    // SessionEnd counts zero toward BOTH per the standing decision.
    // If these numbers move, the activity model moved -- which this stage
    // must not do. Do not "fix" them to match new output; find what changed.
    expect(Number(t[0].a)).toBe(300_000);
    expect(Number(t[0].w)).toBe(600_000);
    expect(Number(t[0].i)).toBe(300_000);
  });

  it("excludes session-less days from the lifetime hygiene average", () => {
    const db = buildAndRoll("tokens-only-day");
    const lifetime = rows<{ h: number }>(db, "SELECT hygiene_score h FROM claude_rank_progress;");
    const withSessions = rows<{ h: number }>(db,
      "SELECT AVG(NULLIF(hygiene_score,0)) h FROM claude_daily_rollups WHERE sessions_count > 0;");
    expect(Number(lifetime[0].h)).toBeCloseTo(Number(withSessions[0].h), 6);
  });
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `npx vitest run tests/project-rollup.test.ts tests/activity-model.test.ts`
Expected: FAIL — the orphan's 500 tokens are missing (daily sums 1000, not 1500), and `tokens-only-day` produces no row for that day at all.

- [ ] **Step 4: Widen `_pk` to cover request cwds**

`capture/rollup.sh:236` — replace the `FROM (SELECT DISTINCT cwd FROM claude_events …)` subquery:

```sql
FROM (SELECT DISTINCT cwd FROM claude_events
      WHERE cwd IS NOT NULL AND cwd <> ''
      UNION
      SELECT DISTINCT cwd FROM claude_requests
      WHERE cwd IS NOT NULL AND cwd <> '') e
LEFT JOIN claude_project_paths p ON p.cwd = e.cwd;
```

> This also closes the Stage 1.5 deferral (§4.5): transcripts surface cwds the event stream never saw, notably from the pre-install days. `_pk` remains the single minting site for `(unfiled)` / `(excluded)`.

Apply the same `UNION` to whatever query feeds the **resolution step**'s list of unresolved cwds (the loop above `_pk`, `rollup.sh:120-160`), so those cwds actually get resolved rather than staying `(unfiled)` forever.

- [ ] **Step 5: Build the token aggregates and the key spaces**

Insert **after** `_pk` is created and **before** `_sx`:

```sql
-- Day-grouped request tokens. DELIBERATELY independent of claude_sessions:
-- 22.4% of requests (5,878 / 26,270 measured 2026-09-11) carry a session_id
-- with no claude_sessions row, all from the pre-install days the transcripts
-- uniquely cover. Joining through sessions drops 22.7% of output tokens while
-- the reconciliation identity keeps passing, because both sides omit it
-- equally.
--
-- DECLARED DIVERGENCE: a session crossing midnight books its HOURS entirely to
-- its start day, but a request books to ITS OWN day. A request has a true
-- timestamp; forcing it onto a session's start day would launder model math
-- through an attribution rule, and does not work for orphans at all.
DROP TABLE IF EXISTS _dtok;
CREATE TEMP TABLE _dtok AS
SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day,
       CAST(SUM(tokens_in)              AS INTEGER) AS tin,
       CAST(SUM(tokens_out)             AS INTEGER) AS tout,
       CAST(SUM(tokens_cache_read)      AS INTEGER) AS tcr,
       CAST(SUM(tokens_cache_creation)  AS INTEGER) AS tcw
FROM claude_requests WHERE ts IS NOT NULL GROUP BY day;

-- Per-project request tokens. Every request carries its own cwd, so tokens
-- attribute DIRECTLY -- no is_dom dominance rule and no time-splitting. The
-- identity then holds by construction: _dtok and _ptok are the same SUM over
-- the same table differing by one GROUP BY key.
DROP TABLE IF EXISTS _ptok;
CREATE TEMP TABLE _ptok AS
SELECT COALESCE(k.project_key, '(unfiled)') AS project_key,
       strftime('%Y-%m-%d', r.ts, 'unixepoch', 'localtime') AS day,
       CAST(SUM(r.tokens_in)             AS INTEGER) AS tin,
       CAST(SUM(r.tokens_out)            AS INTEGER) AS tout,
       CAST(SUM(r.tokens_cache_read)     AS INTEGER) AS tcr,
       CAST(SUM(r.tokens_cache_creation) AS INTEGER) AS tcw
FROM claude_requests r
LEFT JOIN _pk k ON k.cwd = r.cwd
WHERE r.ts IS NOT NULL
GROUP BY project_key, day;
```

- [ ] **Step 6: Remove the token columns from `_sx`**

Delete these four lines at `rollup.sh:371-374`:

```sql
  COALESCE(sn.input_tokens,0)          AS tin,
  COALESCE(sn.output_tokens,0)         AS tout,
  COALESCE(sn.cache_read_tokens,0)     AS tcr,
  COALESCE(sn.cache_creation_tokens,0) AS tcw,
```

Keep the `LEFT JOIN _snap sn` and its `effort` / `thinking` columns — `_snap` is still the only source for those.

- [ ] **Step 7: Drive the daily insert from a UNION'd day space**

Replace the `DELETE FROM claude_daily_rollups; INSERT … FROM _sx GROUP BY day;` block:

```sql
-- Key space is the UNION of days with sessions and days with requests, so a
-- pre-install day that has tokens and no sessions still gets a row. UNION +
-- LEFT JOIN rather than FULL OUTER JOIN: portable to any sqlite3 the installed
-- copy might meet, including older Linux builds.
DROP TABLE IF EXISTS _days;
CREATE TEMP TABLE _days AS
  SELECT day FROM _sx UNION SELECT day FROM _dtok;

DELETE FROM claude_daily_rollups;
INSERT INTO claude_daily_rollups (
  day, total_session_ms, active_ms, idle_ms, sessions_count,
  tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, cache_hit_percentage,
  cost_usd, compacts, clears, subagents, prompts, avg_context_pct, peak_context_pct, updated_at)
SELECT
  d.day,
  CAST(COALESCE(s.dur_s, 0)    * 1000 AS INTEGER),
  CAST(COALESCE(s.active_s, 0) * 1000 AS INTEGER),
  CAST(MAX(0, COALESCE(s.dur_s, 0) - COALESCE(s.active_s, 0)) * 1000 AS INTEGER),
  COALESCE(s.n, 0),
  COALESCE(t.tin, 0), COALESCE(t.tout, 0), COALESCE(t.tcr, 0), COALESCE(t.tcw, 0),
  COALESCE(100.0 * COALESCE(t.tcr, 0)
           / NULLIF(COALESCE(t.tcr, 0) + COALESCE(t.tcw, 0), 0), 0),
  COALESCE(s.cost, 0), COALESCE(s.compacts, 0), COALESCE(s.clears, 0),
  COALESCE(s.subagents, 0), COALESCE(s.prompts, 0),
  s.avgctx, s.peakctx,
  strftime('%s', 'now')
FROM _days d
LEFT JOIN (SELECT day,
                  SUM(dur_s)    AS dur_s,
                  SUM(active_s) AS active_s,
                  COUNT(*)      AS n,
                  SUM(cost)     AS cost,
                  SUM(compacts) AS compacts,
                  SUM(CASE WHEN source='clear' THEN 1 ELSE 0 END) AS clears,
                  SUM(subagents) AS subagents,
                  SUM(prompts)   AS prompts,
                  AVG(avgctx)    AS avgctx,
                  MAX(peakctx)   AS peakctx
           FROM _sx GROUP BY day) s ON s.day = d.day
LEFT JOIN _dtok t ON t.day = d.day;
```

- [ ] **Step 8: Keep the JSON columns valid on session-less days**

`json_group_object` over zero rows yields NULL, which would write a NULL into a column every prior day has as an object. Wrap both:

```sql
UPDATE claude_daily_rollups AS r SET
  repos_json = COALESCE((SELECT json_group_object(repo, secs) FROM
                 (SELECT repo, CAST(SUM(active_s) AS INTEGER) AS secs FROM _sx WHERE day=r.day GROUP BY repo)), '{}'),
  models_json = COALESCE((SELECT json_group_object(model, cnt) FROM
                 (SELECT model, COUNT(*) AS cnt FROM _sx WHERE day=r.day GROUP BY model)), '{}');
```

- [ ] **Step 9: Zero hygiene on session-less days**

Immediately **after** the existing `UPDATE claude_daily_rollups SET hygiene_score = …` statement:

```sql
-- hygiene_score is a BEHAVIOURAL score: three of its four terms (context
-- discipline, compact-vs-clear, idle ratio) are meaningless without a session.
-- Left alone, a token-only pre-install day would score on cache efficiency
-- alone and pollute claude_rank_progress.hygiene_score, which is
-- AVG(NULLIF(hygiene_score,0)) across days -- so zeroing here excludes them
-- from the lifetime average with no new logic downstream.
UPDATE claude_daily_rollups SET hygiene_score = 0 WHERE sessions_count = 0;
```

- [ ] **Step 10: Drive the project insert from a UNION'd (project, day) space**

In the project-rollup `INSERT`, replace the four token expressions:

```sql
  SUM(t.is_dom * t.tin), SUM(t.is_dom * t.tout),
  SUM(t.is_dom * t.tcr), SUM(t.is_dom * t.tcw),
```

with values taken from `_ptok` rather than from the session-derived rows. Build the key space first:

```sql
DROP TABLE IF EXISTS _pkeys;
CREATE TEMP TABLE _pkeys AS
  SELECT project_key, day FROM (<the existing t subquery>) UNION
  SELECT project_key, day FROM _ptok;
```

Then the insert selects `FROM _pkeys` and `LEFT JOIN`s both the existing session-derived aggregate and `_ptok`:

```sql
  COALESCE(pt.tin, 0), COALESCE(pt.tout, 0),
  COALESCE(pt.tcr, 0), COALESCE(pt.tcw, 0),
...
FROM _pkeys pk
LEFT JOIN (SELECT project_key, day,
                  SUM(active_s) AS active_s, SUM(window_s) AS window_s,
                  SUM(is_dom) AS n,
                  SUM(is_dom * COALESCE(prompts,0))   AS prompts,
                  SUM(is_dom * COALESCE(compacts,0))  AS compacts,
                  SUM(is_dom * CASE WHEN source='clear' THEN 1 ELSE 0 END) AS clears,
                  SUM(is_dom * COALESCE(subagents,0)) AS subagents,
                  SUM(is_dom * cost) AS cost,
                  MAX(CASE WHEN is_dom = 1 THEN peakctx END) AS peakctx,
                  AVG(CASE WHEN is_dom = 1 THEN avgctx  END) AS avgctx
           FROM (<the existing t subquery>) GROUP BY project_key, day) sp
  ON sp.project_key = pk.project_key AND sp.day = pk.day
LEFT JOIN _ptok pt
  ON pt.project_key = pk.project_key AND pt.day = pk.day;
```

Keep the existing `display_name` `CASE` and the `MAX(0, …)` idle clamp verbatim — both encode decisions with comments explaining why.

- [ ] **Step 11: Run the tests and make sure they pass**

Run: `npm test`
Expected: PASS — all 105 pre-existing tests plus the new ones. The identity test now runs across the orphan case.

- [ ] **Step 12: Mutation-check the orphan guard**

```bash
# Route _dtok through sessions, as the rejected design did:
#   FROM claude_requests r JOIN claude_sessions s ON s.session_id = r.session_id
# "counts a request whose session has no claude_sessions row" MUST fail,
# and assertReconciles MUST still pass -- which is the whole point.
npx vitest run tests/project-rollup.test.ts -t "no claude_sessions row"   # expect FAIL

# Remove the hygiene zeroing. "excludes session-less days" MUST fail.
npx vitest run tests/activity-model.test.ts -t "session-less days"        # expect FAIL
```

- [ ] **Step 13: Commit**

```bash
git add capture/rollup.sh tests/fixtures/make-fixture.sh tests/project-rollup.test.ts tests/activity-model.test.ts
git commit -m "feat(stage-2): tokens come from claude_requests, grouped by day

Not routed through claude_sessions: 22.4% of requests have a session_id with no
session row (the pre-install days), and joining through sessions drops 22.7% of
output tokens WHILE THE RECONCILIATION IDENTITY STILL PASSES, because both
sides omit them equally. Day and (project, day) key spaces are UNIONs, so a
token-only day gets a row; hygiene_score is zeroed there because three of its
four terms are meaningless without a session."
```

---

## Task 6: Verify against a copy of the real database

**Files:** none modified. The deliverable is a written verification result.

**Interfaces:**
- Consumes: everything from Tasks 1-5, plus the live DB **read-only, via `.backup`**.
- Produces: a pass/fail report against the §6.4 blast-radius table, to be pasted into `SESSION.md`.

- [ ] **Step 1: Take two independent copies, each in its own directory**

```bash
W="$(mktemp -d)"; mkdir -p "$W/before" "$W/after"
sqlite3 ~/.theone/claude-code-usage.sqlite ".backup '$W/before/db.sqlite'"
sqlite3 ~/.theone/claude-code-usage.sqlite ".backup '$W/after/db.sqlite'"
```

> `.backup`, never `cp` — the live DB is WAL. **Separate directories** because the `.schema-vN` marker is per-directory and two DBs sharing one would leave the second with no schema.

- [ ] **Step 2: Record the before-state**

```bash
sqlite3 -header "$W/before/db.sqlite" "
  SELECT (SELECT COUNT(*) FROM claude_daily_rollups) days,
         (SELECT MIN(day) FROM claude_daily_rollups) first_day,
         ROUND(SUM(active_ms)/3600000.0,4) active_h,
         ROUND(SUM(total_session_ms)/3600000.0,4) window_h,
         SUM(sessions_count) sessions, SUM(prompts) prompts,
         SUM(tokens_in) tin, SUM(tokens_out) tout,
         ROUND(SUM(cost_usd),6) cost
  FROM claude_daily_rollups;"
sqlite3 -header "$W/before/db.sqlite" "SELECT * FROM claude_rank_progress;"
```

- [ ] **Step 3: Ingest and roll the after-copy**

```bash
THEONE_DB_PATH="$W/after/db.sqlite" CC_LIB_PATH=capture/lib.sh \
  bash capture/ingest.sh --backfill
THEONE_DB_PATH="$W/after/db.sqlite" CC_LIB_PATH=capture/lib.sh \
  bash capture/rollup.sh --resolve
```

- [ ] **Step 4: Assert the blast radius, column by column**

```bash
sqlite3 "$W/after/db.sqlite" "ATTACH '$W/before/db.sqlite' AS b;
-- MUST be zero rows: hours, sessions, prompts and cost may not move on any day
-- that existed before.
SELECT 'MOVED', a.day, a.active_ms, b.active_ms
FROM claude_daily_rollups a JOIN b.claude_daily_rollups b USING(day)
WHERE a.active_ms <> b.active_ms
   OR a.total_session_ms <> b.total_session_ms
   OR a.sessions_count <> b.sessions_count
   OR a.prompts <> b.prompts
   OR ABS(a.cost_usd - b.cost_usd) > 1e-9;"
```

Expected: **no rows.** Then confirm the intended movements:

```bash
sqlite3 -header "$W/after/db.sqlite" "
  SELECT COUNT(*) days, MIN(day) first_day,
         ROUND(SUM(active_ms)/3600000.0,4) active_h,
         SUM(tokens_in) tin, SUM(tokens_out) tout,
         ROUND(AVG(cache_hit_percentage),2) avg_cache_hit
  FROM claude_daily_rollups;"
sqlite3 -header "$W/after/db.sqlite" "SELECT rank_name, ROUND(active_hours,4) ah,
  ROUND(hygiene_score,3) hyg, ROUND(xp,1) xp FROM claude_rank_progress;"
```

| Assertion | Expected |
|---|---|
| `active_h`, `rank_name`, `sessions`, `prompts`, `cost` | **identical** to before |
| `days` | 69 → **77** |
| `first_day` | 2026-07-04 → **2026-06-13** |
| `tin` / `tout` | ~68,756 → ~**4.3M** / ~128,410 → ~**25.8M** |
| `avg_cache_hit` | 79.40 → ~**98** |
| `hygiene_score` | +≈4.69 |
| `xp` | +≈23.4 |

- [ ] **Step 5: Re-prove the three-place lockstep numerically**

```bash
sed -n '/^const PER_SESSION_SQL = `/,/^`;/p' \
  ~/Developer/Coding/personal/TheOneOS/lib/claude-hours/hours.ts \
  | sed '1d;$d' > "$W/per_session.sql"
sqlite3 "$W/after/db.sqlite" < "$W/per_session.sql" > "$W/ts_hours.txt"
```

Compare the per-day bucketed hours against `claude_daily_rollups` **numerically, not textually** — Stage 1.5 renamed a column alias that `hours.ts` still spells the old way, and an alias is not part of the model. Require **0 differing days**.

- [ ] **Step 6: Record the result in `SESSION.md`**

Write the measured before/after table into the session log under a "Stage 2 verified" heading, including any figure that came out differently from the prediction. **A prediction that missed is the finding, not an embarrassment to round away.**

- [ ] **Step 7: Commit**

```bash
git add SESSION.md
git commit -m "docs(stage-2): live-shaped verification against a .backup copy

Hours, rank, sessions, prompts and cost unmoved on every pre-existing day;
tokens corrected; row count and earliest day moved as predicted. Lockstep
re-proved numerically against PER_SESSION_SQL."
```

---

## Task 7: TheOneOS — read the corrected tokens

> **Different repository.** This runs in `~/Developer/Coding/personal/TheOneOS`, on its own branch, with its own PR. Do not start it until Task 6 passes.

**Files:**
- Modify: `lib/claude-hours/hours.ts:66-97`, `lib/claude-hours/types.ts:26,98`
- Test: `tests/claude-hours.test.ts`

**Interfaces:**
- Consumes: `claude_requests` via the existing read-only `openUsageDb()` handle.
- Produces: `TokenStat` populated from request sums; `RawSessionRow.tin` and friends removed.

- [ ] **Step 1: Write the failing test**

```ts
it("reads tokens from claude_requests, not the last snapshot", async () => {
  const db = seedUsageDb({
    requests: [
      { request_id: "r1", session_id: "s1", ts: 1783677600, tokens_in: 10, tokens_out: 100 },
      { request_id: "r2", session_id: "s_ghost", ts: 1781314137, tokens_in: 5, tokens_out: 50 },
    ],
    snapshots: [{ session_id: "s1", ts: 1783677900, input_tokens: 99999, output_tokens: 99999 }],
  });
  const hours = await getClaudeHours(db);
  // The snapshot's 99999 is context occupancy and must not appear.
  expect(hours.tokens.input).toBe(15);
  expect(hours.tokens.output).toBe(150);
});

it("returns zeros rather than throwing when claude_requests is absent", async () => {
  const db = seedUsageDb({ omitTables: ["claude_requests"] });
  const hours = await getClaudeHours(db);
  expect(hours.tokens.output).toBe(0);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm test -- claude-hours`
Expected: FAIL — `hours.tokens.input` reads 99999 from the snapshot.

- [ ] **Step 3: Add a day-grouped token query**

`PER_SESSION_SQL` is per-session by construction and **cannot carry the token half** — an orphan request has no session to belong to. Add a second, independent query:

```ts
/** Request tokens, grouped by local day. SUMs stored columns only -- it does
 *  NOT recompute the activity model. hours.ts is the third place the model
 *  lives; adding token arithmetic here would make a fourth. */
const REQUEST_TOKENS_SQL = `
  SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day,
         CAST(SUM(tokens_in)             AS INTEGER) AS tokensIn,
         CAST(SUM(tokens_out)            AS INTEGER) AS tokensOut,
         CAST(SUM(tokens_cache_read)     AS INTEGER) AS cacheRead,
         CAST(SUM(tokens_cache_creation) AS INTEGER) AS cacheCreation
  FROM claude_requests WHERE ts IS NOT NULL GROUP BY day;
`;
```

Guard it the way `projects.ts` guards its table, so a machine without v4 degrades to zeros instead of throwing.

- [ ] **Step 4: Remove the snapshot token path**

Delete the `input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens` columns from the `hours.ts:66-97` snapshot subquery and the `tin`/`tout`/`tcr`/`tcw` fields from `RawSessionRow` in `types.ts:26`. Delete the now-false comment at `types.ts:98`:

```ts
  /** recent 30-day token composition (context-snapshot figures, not API throughput) */
```

replacing it with:

```ts
  /** recent 30-day token composition, from claude_requests (exact per-request usage) */
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npm test && npm run typecheck`
Expected: PASS. Fix any consumer the removed `RepoStat`-style fields break — the compiler names them.

- [ ] **Step 6: Commit and open a PR**

```bash
git add lib/claude-hours/hours.ts lib/claude-hours/types.ts tests/claude-hours.test.ts
git commit -m "fix(claude-hours): read tokens from claude_requests

hours.ts:66-97 independently recomputed tokens from the last snapshot per
session -- context-window occupancy, not usage -- so it served figures 63-201x
low from its own query. types.ts:98 already documented the flaw in words.
Tokens are grouped by day, not by session: 22.4% of requests predate the
tracker and have no session row."
```

> **Coordinate with the pending panel work.** `SESSION.md` carries an unapproved proposal that rewires the project donut in these same files. Do both on one branch, or the second pass rewrites the first.

---

## Self-Review

**Spec coverage.** §1 → Tasks 1-7. §2 (the defect) → Task 5 + Task 6's assertions. §3.1 (fields) → Task 2 Step 4. §3.2 (attribution) → Task 2 Step 2's `attributed` test. §3.3 (durability) → Task 1's table comment; step zero already done. §4.1 → Task 1. §4.2 (`MAX`, advisory cursor, identity fields) → Tasks 2-3. §4.3 (`ingest.sh`, jq-not-python) → Task 2. §4.4 (hook chain) → Task 4. §4.5 (`_pk` seeding) → Task 5 Step 4. §5 (schema, version bump) → Task 1. §6.1-6.2 → Task 5 Steps 5-10. §6.3 (cost untouched) → Task 5 leaves `_cost` alone; Task 6 asserts cost unmoved. §6.4 → Task 6 Step 4. §7 (lockstep) → Task 6 Step 5 + Task 7. §8 (testing) → every task. §9 (install, dry-run, backfill) → Task 4 Step 6, Task 6 Step 3. §10 → task order. §11-12 → out of scope, untouched.

**Placeholder scan.** The one intentional ellipsis is `<the existing t subquery>` in Task 5 Step 10, which names a block already in the file rather than inventing one; `... unchanged ...` in Task 4 Step 4 marks the `ensure` body that must not be edited. Both point at existing code the implementer reads in place. No TBDs, no "add error handling", no test described without its code.

**Type consistency.** `_dtok`/`_ptok` expose `tin`/`tout`/`tcr`/`tcw` — the same names `_sx` used, so the daily insert's column order is unchanged. `req()` in `make-fixture.sh` and the `rec()` JSON in `make-transcripts.sh` both write the same four token fields. `ingestScenario` / `q` are defined in Task 2 and exported for Task 3. `REQUEST_TOKENS_SQL` returns `tokensIn`/`tokensOut`/`cacheRead`/`cacheCreation`, matching the existing `TokenStat` camelCase.

**One risk flagged for the implementer.** Task 5 Step 10 is the largest single edit — restructuring an `INSERT` whose comments encode several hard-won decisions. Keep `display_name`, the `MAX(0, …)` idle clamp and the `CASE WHEN is_dom = 1 THEN peakctx END` gating **verbatim**; each has a comment explaining a bug it already fixed.
