# Stage 4B — Performance (plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Price every request at API rates, time every request and every turn, stop showing
three readings Watchtower doesn't have, and show all of it on the existing pages and a new
ranged Performance page.

**Architecture:**
- `ingest.sh` reads each transcript as one stateful `jq` pass. It carries the last user
  entry's ms timestamp down the file and across runs through the cursor. From that it lands
  ms timestamps, the cache-write split and `speed` on `claude_requests`, and turn boundaries
  in a new durable `claude_prompts`.
- `rollup.sh` derives cost, response time and turns in temp tables built inside a **read**
  transaction. Its write transaction only swaps rows in.
- `lib/read` sorts and picks (median and p90). It computes nothing else.

**Tech stack:** bash, `jq` 1.8, the `sqlite3` CLI (window functions), Node ≥ 22 with native
type stripping, vitest. **Zero runtime dependencies.**

**Spec (binding):** `docs/superpowers/specs/2026-09-28-stage-4b-performance-design.md`,
approved 2026-09-29 including §2.1 a–d. Copy every table, column, price, case table and
formula from the spec; do not re-derive them. The spec's §2 decisions are settled and must
not be re-asked.

**Branch:** `stage-4b-performance` @ `f96948e`, cut from `main` @ `e77af29` (main merged in at
`4b0d1c8`). TheOneOS work (Task 4) goes on its own branch in a worktree off TheOneOS `main`.

**Ledger:** `.superpowers/sdd/2026-09-29-stage-4b-performance/`, with `progress.md` plus
`task-N-report.md` per task.

## Plan decisions (read at review; the spec doesn't settle these)

- **P1.** `claude_request_metrics` gains `cost_write_5m_usd REAL` and `cost_write_1h_usd REAL`.
  - Spec §5 item 4 shows the cost of 5m and 1h cache writes, and §4 keeps all pricing math in
    `rollup.sh`. Without these two columns the reader would have to multiply tokens by rates.
  - Both are NULL unless `priced = 1`.
- **P2.** Section 1 of `rollup.sh` (the daily and project rebuild) gains a read phase.
  - Today it runs entirely under `BEGIN IMMEDIATE`, and the lock hold is 0.146 s on the live
    copy (4A fix wave).
  - Every new 4B temp table is built in the new read phase. `_pk` moves there verbatim
    because the cost aggregates need project keys.
  - The existing temp tables (`_dtok`, `_ptok`, `_act`, `_sx`, …) stay where they are. Moving
    them is out of scope.
- **P3.** Boundaries that share one ms in a session are ordered by `ts_ms`, then kinds that
  don't start a measured turn first, then `entry_uuid`.
  - So a `prompt` or `command` owns the requests after a same-ms `local` or `notification`
    line.
  - The spec's "< the next boundary's `ts_ms`" still holds: whichever boundary sorts first
    gets an empty range.
- **P4.** A turn's `day` is its boundary's local day.
- **P5.** A user entry whose `message.content` is null or absent is not a boundary. Real
  prompts always carry content; this keeps 4A's synthetic attachment-only fixture out.
- **P6.** The `effective_from` test splices a fixture-only price row into a temp copy of
  `rollup.sh`, at a marker comment. Production gets no override knob.

## Global Constraints

- A tracker must never break Claude Code. Every DB write on the hook path swallows its error, and `ingest.sh` still exits 0 on any failure.
- Every capture merge is order-independent and idempotent:
  - `first_ms` and `sent_ms` take the NULL-aware MIN;
  - `last_ms`, `cache_write_5m`, `cache_write_1h` and `speed` take the NULL-aware MAX;
  - `claude_prompts` is `INSERT OR IGNORE`.

  Re-ingesting, reordering files, `--backfill` or deleting the cursor all converge on identical tables.
- `claude_prompts` and the new `claude_requests` columns are **durable**. `claude_prices`, `claude_request_metrics` and `claude_turns` are **regenerable**.
- Every derivation lives in `capture/rollup.sh`: price, cost, response time, tok/s, turn membership, status and the hygiene rescale.
  - `lib/` reads and labels. It may also sort and pick (median and p90 in `lib/read/perf.ts`).
  - **No price rate and no pricing URL appears under `lib/`.**
- `CC_SCHEMA_VERSION` (`capture/lib.sh`) and `schemaVersion` (`lib/config.ts`) are both **6**.
- The reconciliation identity holds on **17** columns, with `cost_table_usd` compared within 1e-9, as `cost_usd` is.
- Every day with a peak-context reading keeps a **byte-identical** `hygiene_score`. The regression baseline changes only for no-snapshot days, in its own commit.
- The rollup's write lock grows by **< 100 ms** on the live copy.
- NULL means "not measured". Pages say "no reading", "not priced" or "N not priced", and none of these states ever renders `$0.00`. Charts break on a NULL; they never draw it as 0.
- Tests drive the real bash scripts with `TZ=UTC`. Fixtures fail loudly and encode values through `lib.sh`'s encoders.
- Every new guard has its defect planted until **exactly one** test turns red. Record every plant in the task report.
- Never touch the live DB or `~/.claude`. Live checks run on a `sqlite3 .backup` copy in a **fresh directory**, because the `.schema-vN` marker is per directory.
  - Always pass `CC_LIB_PATH="$PWD/capture/lib.sh"`. Without it, the scripts source the live v5 lib from `~/.claude`.
- `package.json` gains no `dependencies`, and there is no build step.
- Commit messages and PR bodies carry **no** `Co-Authored-By` trailer or any other AI attribution.
- After any SDD script call, restore `.superpowers/sdd/.gitignore`. Commit the ledger; never delete it.

## Review Focus

1. **A transcript that starts mid-turn** (its first line is an assistant partial, as in a
   resumed or rotated file). `sent_ms` is NULL, so `response_ms` and `tok_per_s` are NULL.
   Never measure from another file's prompt or from 0. Tests: Task 1 (`sent_ms` NULL) and
   Task 3 (response NULL, left out of `n`).
2. **A non-positive response.** `last_ms` equal to or earlier than `sent_ms`, from clock skew
   or a partial written in the prompt's millisecond. The response is NULL, never 0 or
   negative, and is left out of median and p90. Test: Task 3.
3. **Two boundaries in one millisecond** (a command and its local output). Each request lands
   in at most one turn, deterministically, and the `command` owns it (P3). Test: Task 3.
4. **Upgrade before backfill.** A v5 DB, a live install, then the rollup runs before
   `--backfill`. Every cache-writing request is `no-split` (not priced), there are no turns,
   and every page says "not priced" or "no reading" without erroring. Tests: Task 2 (no-split
   counted, the rollup's cost 0) and Task 5 (pages on a DB with no ms columns and no turns).
5. **A range with no measured turn or no priced request** (a quiet week, or one with only
   `sdk-` runs). Performance and History say "no reading" or "not priced", and the wait chart
   breaks there instead of dropping to 0. Test: Task 5.

---

## Tasks

Five tasks, the spec §8 shape. Each ends with a check on a `.backup` copy of the live DB,
recorded in its report. Inside a task, "(3.2)" means Step 3, test 2. One scoped review follows **Task 1 only**, because durable capture is
the one thing a later fix can't repair. Then one whole-branch review and at most one fix
round.

Live-copy setup (fresh directory, every task):

```bash
L=/private/tmp/claude-501/-Users-you-Developer-Coding-personal-Claude-Watchtower/<session>/scratchpad/live-4b
mkdir -p "$L" && sqlite3 ~/.theone/claude-code-usage.sqlite ".backup $L/db.sqlite"
export CC_LIB_PATH="$PWD/capture/lib.sh" WATCHTOWER_DB_PATH="$L/db.sqlite"
```

### Task 1: Capture v6 — schema, ms timestamps, `sent_ms`, split, speed, `claude_prompts`

**Files:**
- Modify:
  - `capture/lib.sh`: version 6, the ALTER list, the new tables, the M4 wording at the `claude_tool_calls` comment (~line 296–306);
  - `lib/config.ts`: `schemaVersion: 6`;
  - `capture/ingest.sh`;
  - `tests/fixtures/make-transcripts.sh`;
  - `tests/ingest.test.ts`;
  - `tests/capture-scripts.test.ts`: the v5 describe becomes v6, `DURABLE_TABLES`, R1;
  - `tests/config.test.ts:26`;
  - `tests/core-schema.test.ts`: delete the literal pin at 84–88 (M8);
  - `CLAUDE.md`: durable list, schema v6, M4 wording at 99–106, and the plan task numbers at ~90 (M8).

**Interfaces:**
- Produces, for Tasks 2–5:
  - `claude_requests.{first_ms, last_ms, sent_ms, cache_write_5m, cache_write_1h, speed}`;
  - `claude_ingest_cursor.last_user_ms`;
  - `claude_prompts(entry_uuid PK, session_id, ts_ms, kind)`;
  - the empty regenerable tables `claude_prices`, `claude_request_metrics` (spec §4.2 + P1) and `claude_turns`;
  - four columns on each rollup table, plus `claude_profile_daily.event_covered`.

  All of it ships under **one** version bump, so a v6 marker never predates a table or column.
- `make-transcripts.sh` gains:
  - `uent <file> <uuid> <sessionId> <iso-ts> <content-json> [extra-json]`: a `type:"user"` line with `message.content` = the JSON value, shallow-merged with extra (for `isMeta`, `isSidechain` or `entrypoint`);
  - `patch_last <file> <jq-filter>`: rewrites the file's last line through a jq path assignment. This is `tuse`'s trick, generalised; refactor `tuse` onto it.

- [ ] **Step 1: Schema.**
  - In `cc_schema_sql`, add the spec §3.2 columns to the `CREATE TABLE`s of `claude_requests`, `claude_ingest_cursor`, both rollups and `claude_profile_daily`.
  - After `claude_slash_commands`, add:

```sql
-- Stage 4B (schema v6). Turn boundaries (spec 3.3): one row per main-thread,
-- non-meta user entry with no tool_result. DURABLE, like claude_slash_commands,
-- for the same reason, and a fact about one line: INSERT OR IGNORE on entry_uuid.
CREATE TABLE IF NOT EXISTS claude_prompts (
  entry_uuid TEXT PRIMARY KEY,
  session_id TEXT,
  ts_ms      INTEGER NOT NULL,
  kind       TEXT NOT NULL      -- prompt | command | notification | local | interrupt
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON claude_prompts(session_id, ts_ms);

-- REGENERABLE: rollup.sh rebuilds all three every run (DELETE + INSERT from temp).
CREATE TABLE IF NOT EXISTS claude_prices (
  model TEXT NOT NULL, speed TEXT NOT NULL, effective_from TEXT NOT NULL,
  input REAL NOT NULL, output REAL NOT NULL, cache_read REAL NOT NULL,
  cache_write_5m REAL NOT NULL, cache_write_1h REAL NOT NULL,
  verified_on TEXT NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (model, speed, effective_from)
);
CREATE TABLE IF NOT EXISTS claude_request_metrics (
  request_id TEXT PRIMARY KEY, day TEXT NOT NULL, session_id TEXT, model TEXT,
  is_sidechain INTEGER,
  priced INTEGER, price_note TEXT, cost_table_usd REAL,
  cost_write_5m_usd REAL, cost_write_1h_usd REAL,     -- plan P1
  response_ms INTEGER, tok_per_s REAL
);
CREATE INDEX IF NOT EXISTS idx_request_metrics_day ON claude_request_metrics(day);
CREATE TABLE IF NOT EXISTS claude_turns (
  entry_uuid TEXT PRIMARY KEY, session_id TEXT, day TEXT NOT NULL, kind TEXT NOT NULL,
  requests INTEGER NOT NULL, wait_ms INTEGER, status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_day ON claude_turns(day);
```

  - In `cc_init_db`, right after the `project_path` ALTER loop and **before** the schema apply, add the v6 column loop. Extend the "NOTE FOR THE NEXT SCHEMA CHANGE" comment to name it:

```bash
  # Stage 4B (schema v6): columns on EXISTING tables. One sqlite3 call per ALTER,
  # error swallowed, for the same reasons as the loop above. A fresh install gets
  # them from CREATE TABLE instead, and every ALTER here fails harmlessly.
  while IFS='|' read -r _t _c; do
    sqlite3 "$db" "ALTER TABLE $_t ADD COLUMN $_c;" >/dev/null 2>&1 || true
  done <<'COLS'
claude_requests|first_ms INTEGER
claude_requests|last_ms INTEGER
claude_requests|sent_ms INTEGER
claude_requests|cache_write_5m INTEGER
claude_requests|cache_write_1h INTEGER
claude_requests|speed TEXT
claude_ingest_cursor|last_user_ms INTEGER
claude_daily_rollups|cost_table_usd REAL DEFAULT 0
claude_daily_rollups|priced_requests INTEGER DEFAULT 0
claude_daily_rollups|unpriced_requests INTEGER DEFAULT 0
claude_daily_rollups|sessions_with_cost INTEGER DEFAULT 0
claude_project_rollups|cost_table_usd REAL DEFAULT 0
claude_project_rollups|priced_requests INTEGER DEFAULT 0
claude_project_rollups|unpriced_requests INTEGER DEFAULT 0
claude_project_rollups|sessions_with_cost INTEGER DEFAULT 0
claude_profile_daily|event_covered INTEGER NOT NULL DEFAULT 0
COLS
```

  - Bump `CC_SCHEMA_VERSION=6` and `schemaVersion: 6`.
  - Tests in `capture-scripts.test.ts` (rename `describe("schema v5")` to `"schema v6"` and keep the v5 upgrade case):
    1. A fresh `cc_init_db` gives every column above (`PRAGMA table_info`) and all four new tables, and stamps `.schema-v6`.
    2. A real **v5** DB (built with `CC_SCHEMA_VERSION=5` forced, as the v4→v5 test does) plus a `.schema-v5` marker gains every column and table after **one** `cc_init_db`. Its pre-existing rows are untouched and `.schema-v6` is written.
    3. `DURABLE_TABLES` gains `"claude_prompts"`.
- [ ] **Step 2: Fixtures.** Add `uent` and `patch_last`, and move `tuse` onto `patch_last`. Scenarios:
  - **`ms-split`** (`$P/s1.jsonl`):
    - `uent u_p1 s1 2026-07-10T10:00:00.120Z '"hello"'`;
    - `rec req_m … 10:00:01.5Z … 5`, then `rec req_m … 10:00:03Z … 900`. Each is patched with `.message.usage.cache_creation = {"ephemeral_5m_input_tokens":60,"ephemeral_1h_input_tokens":40} | .message.usage.speed = "standard"`;
    - `rec req_n … 10:00:04.000Z … 7`, unpatched (no split, no speed);
    - `rec req_f … 10:00:05.000Z … 7`, patched `.message.usage.speed = "fast" | .message.model = "claude-mystery-9"`.
  - **`sent-cursor-a`**: `uent u_c s2 2026-07-10T11:00:00.250Z '"go"'` only.
  - **`sent-cursor-b`**: **appends** to the same `$P/s2.jsonl` (no `mkfile`): `rec req_c s2 2026-07-10T11:00:02.000Z /tmp/fx 50`.
  - **`sent-midstream`**:
    - `uent u_s s3 …12:00:00.000Z '"x"'`;
    - `rec req_s … 12:00:01.000Z … 5`;
    - `tres … 12:00:02.000Z tu_x false`;
    - `rec req_s … 12:00:03.000Z … 90`.
  - **`mid-turn`**: `$P/s4.jsonl` whose first line is `rec req_mt s4 …13:00:01.000Z … 10`, with no user entry anywhere in the file (Review Focus 1).
  - **`turn-kinds`**, session `s_k`, one user entry per line, 1 s apart from `2026-09-10T09:00:00.000Z`:

    | uuid | content | expected kind |
    |---|---|---|
    | `u_prompt` | `"fix it"` | prompt |
    | `u_array` | `[{"type":"image","source":{}},{"type":"text","text":"look"}]` | prompt |
    | `u_cmd` | `"<command-name>/review</command-name>"` | command |
    | `u_cmsg` | `"<command-message>review</command-message>"` | command |
    | `u_note` | `"<task-notification>x</task-notification>"` | notification |
    | `u_lstd` | `"<local-command-stdout>ok</local-command-stdout>"` | local |
    | `u_bash` | `"<bash-input>ls</bash-input>"` | local |
    | `u_int` | `[{"type":"text","text":"[Request interrupted by user]"}]` | interrupt |
    | `u_meta` | `"ctx"` with `{"isMeta":true}` | — not a boundary |
    | `u_tr` | `[{"type":"tool_result","tool_use_id":"t1","content":"x"}]` | — not a boundary |
    | `u_side` | `"sub"` with `{"isSidechain":true}` | — not a boundary |

  - **R2**: in `slash-mixed`, add the real top-level line `{"type":"attachment","uuid":"u6","sessionId":"s_slash","timestamp":"2026-09-10T10:05:00.000Z","attachment":{"type":"prompt_snapshot","text":"<command-name>/qux</command-name>"}}` beside the synthetic u4 case. Neither is counted.
- [ ] **Step 3: Failing tests** in a new `describe("Stage 4B capture")` in `tests/ingest.test.ts`, using the file's existing `ingestScenario` / `reingest` / `q` helpers. Compute each expected ms with `Date.parse(...)` in the test.
  1. `ms-split`:
     - `req_m`: `first_ms` = `Date.parse("2026-07-10T10:00:01.500Z")`, `last_ms` = `Date.parse("2026-07-10T10:00:03.000Z")`, `sent_ms` = `Date.parse("2026-07-10T10:00:00.120Z")`, split 60/40, speed `standard`;
     - `req_n`: split NULL/NULL and speed NULL, `tokens_cache_creation` still 100;
     - `req_f`: speed `fast`, model `claude-mystery-9`.
  2. `sent-cursor-a`, ingest, `sent-cursor-b`, reingest: `req_c.sent_ms` = `Date.parse("2026-07-10T11:00:00.250Z")`, and the cursor row's `last_user_ms` is that value. (Plant: "`last_user_ms` not carried over".)
  3. `sent-midstream`: `sent_ms` = the 12:00:00.000 prompt, not the 12:00:02 tool result. (Plant: "`sent_ms` merged by MAX".)
  4. `mid-turn`: `req_mt.sent_ms IS NULL`, with `first_ms` and `last_ms` set.
  5. `turn-kinds`: `SELECT entry_uuid, kind FROM claude_prompts ORDER BY ts_ms` equals exactly the eight rows above, with `ts_ms` from `Date.parse`. (Plant: "a notification counted as a prompt".)
  6. Replay and reverse: ingest `ms-split` and then `turn-kinds` into DB A, and `turn-kinds` and then `ms-split` into DB B.
     - `SELECT * EXCEPT ingested_at` (list the columns explicitly) from `claude_requests ORDER BY request_id` is identical, and so is `claude_prompts ORDER BY entry_uuid`.
     - Reingest A, then `--backfill` A: nothing changes.
  7. Cursor deletion: after test 2's two runs, `DELETE FROM claude_ingest_cursor`, reingest, and every new column is identical.
  8. **M5, same transaction.** Plant a `BEFORE INSERT ON claude_prompts … RAISE(ABORT)` trigger, then ingest `turn-kinds` plus `single`:
     - `claude_requests`, `claude_prompts` and `claude_ingest_cursor` are all empty;
     - drop the trigger and reingest, and the rows land.

     This mirrors "does not advance the cursor when the upsert fails".

  Run `npx vitest run tests/ingest.test.ts tests/capture-scripts.test.ts` and expect the new cases to FAIL.
- [ ] **Step 4: Implement ingest.**
  - Widen the filter to `grep -E '"usage"|"tool_result"|<command-name>|"type":"user"'`.
  - Rename `JQ_ROW` to `JQ_PROG` and make it one stateful program, run as `jq -nRr --argjson carry "$carry" "$JQ_PROG"`. Keep `clean`, `ts2unix` and the R/T/E/S branches exactly, except:
    - R gains five trailing fields;
    - T gains `select($e.type == "assistant")` (M8), and `mcp_server` is computed from the **cleaned** name (M8).

```jq
def clean: (. // "") | tostring | gsub("[\t\n\r]"; " ");
def ts2unix: if . == "" then 0 else (sub("\\.[0-9]+"; "") | fromdateiso8601) end;
# ISO -> integer ms: ".123Z" -> 123, ".5Z" -> 500, no fraction -> 000.
def ts2ms: if . == "" then null
  else (sub("\\.[0-9]+"; "") | fromdateiso8601) * 1000
     + ((capture("\\.(?<f>[0-9]+)") | (.f + "00")[0:3] | tonumber) // 0) end;
def opt: if . == null then "" else tostring end;        # NULL -> "" -> NULLIF'd in SQL
def btext: (if (.message.content | type) == "string" then .message.content
            elif (.message.content | type) == "array"
            then ([.message.content[] | select(type == "object" and .type == "text") | .text][0] // "")
            else "" end) | tostring;
def bkind:
  if startswith("<command-name>") or startswith("<command-message>") then "command"
  elif startswith("<task-notification>") then "notification"
  elif startswith("<local-command-stdout>") or startswith("<local-command-stderr>")
    or startswith("<bash-input>") or startswith("<bash-stdout>") or startswith("<bash-stderr>")
  then "local"
  elif startswith("[Request interrupted") then "interrupt"
  else "prompt" end;
def rows($prev):
  . as $e
  | ( select($e.message.usage != null and ($e.requestId // "") != "")
      | [ "R", …today's 21 fields, unchanged…,
          (($e.timestamp // "") | tostring | ts2ms | opt),        # ms
          ($prev | opt),                                           # sent_ms
          ($e.message.usage.cache_creation.ephemeral_5m_input_tokens | opt),
          ($e.message.usage.cache_creation.ephemeral_1h_input_tokens | opt),
          ($e.message.usage.speed | clean) ] | @tsv ),
    ( …T branch, with select($e.type == "assistant") and mcp_server from (.name | clean)… ),
    ( …E branch, unchanged… ),
    ( …S branch, unchanged… ),
    ( select($e.type == "user" and $e.isSidechain != true and $e.isMeta != true
             and $e.message.content != null
             and ((($e.message.content | type) == "array"
                   and any($e.message.content[]; type == "object" and .type == "tool_result")) | not)
             and ($e.uuid // "") != "" and ($e.timestamp // "") != "")
      | [ "P", ($e.uuid | clean), (($e.sessionId // $e.session_id) | clean),
          ($e.timestamp | tostring | ts2ms | opt), ($e | btext | bkind) ] | @tsv );
# Walk the file in order, carrying the ms of the latest type=="user" entry
# (prompt, tool result or meta). null is the EOF sentinel: the C row hands the
# carry to the cursor. try/catch keeps "a corrupt line drops only itself" now
# that one error would otherwise end the whole foreach.
foreach ((inputs | fromjson? // empty | objects), null) as $e
  ( {u: $carry, prev: $carry, e: null};
    .prev = .u | .e = $e
    | if $e != null and $e.type == "user"
      then .u = ((try (($e.timestamp // "") | tostring | ts2ms) catch null) // .u)
      else . end;
    if .e == null then (["C", (.u | opt)] | @tsv)
    else (.prev as $p | .e | try rows($p) catch empty) end )
```

  - This skeleton was smoke-tested on jq 1.8.2 while the plan was written:
    - `.12Z` becomes 120;
    - a corrupt line, a bare JSON string and a line whose `message` is a string each drop alone;
    - a tool result moves the carry but emits no P row;
    - a resumed `--argjson carry` flows into `sent_ms`;
    - ms values print as integers, never in exponent form.
  - Per file:
    - The cursor lookup becomes `SELECT bytes_read || '|' || mtime || '|' || COALESCE(last_user_ms,'')`.
    - Parse it as `prev_bytes="${row%%|*}"; rest="${row#*|}"; prev_mtime="${rest%%|*}"; prev_user="${rest#*|}"`. The old `${row##*|}` would now read `last_user_ms`.
    - `carry=null`. Only on a **resumed** read (`offset > 0`), and only when `[[ "$prev_user" =~ ^[0-9]+$ ]]`, set `carry="$prev_user"`.
    - jq writes to `$work/one.tsv`. Then `awk -F'\t' -v cf="$work/carry" '$1=="C"{printf "%s",$2 > cf; next} {print}' "$work/one.tsv" >> "$all_tsv" || true`, followed by `last_user=""; IFS= read -r last_user < "$work/carry" || true`.
    - The cursor `printf` gains `last_user_ms` (`$(cc_sqlnum "$last_user")`, so empty becomes NULL) in both `VALUES` and `DO UPDATE SET`.
  - The awk split gains `$1=="P"`, which writes to `prompts.tsv` with the tag stripped.
  - `_incoming` gains `ms TEXT, sent_ms TEXT, cw5 TEXT, cw1 TEXT, speed TEXT`, 26 columns in all, matching R. The request upsert gains:

```sql
-- SELECT list additions (GROUP BY request_id; explicit aggregates, never bare):
  MIN(CAST(NULLIF(ms,'') AS INTEGER)), MAX(CAST(NULLIF(ms,'') AS INTEGER)),
  MIN(CAST(NULLIF(sent_ms,'') AS INTEGER)),
  MAX(CAST(NULLIF(cw5,'') AS INTEGER)), MAX(CAST(NULLIF(cw1,'') AS INTEGER)),
  MAX(NULLIF(speed,''))
-- ON CONFLICT additions. Scalar MIN/MAX return NULL if either side is NULL, so
-- NULL-aware CASEs, exactly like claude_tool_calls.ts. NULL means "not recorded"
-- here, never 0, so these must not ride the tokens' DEFAULT 0 MAX.
  first_ms = CASE WHEN first_ms IS NULL THEN excluded.first_ms
                  WHEN excluded.first_ms IS NULL THEN first_ms ELSE MIN(first_ms, excluded.first_ms) END,
  last_ms  = CASE WHEN last_ms IS NULL THEN excluded.last_ms
                  WHEN excluded.last_ms IS NULL THEN last_ms ELSE MAX(last_ms, excluded.last_ms) END,
  sent_ms  = CASE WHEN sent_ms IS NULL THEN excluded.sent_ms
                  WHEN excluded.sent_ms IS NULL THEN sent_ms ELSE MIN(sent_ms, excluded.sent_ms) END,
  cache_write_5m = CASE WHEN cache_write_5m IS NULL THEN excluded.cache_write_5m
                        WHEN excluded.cache_write_5m IS NULL THEN cache_write_5m
                        ELSE MAX(cache_write_5m, excluded.cache_write_5m) END,
  cache_write_1h = CASE WHEN cache_write_1h IS NULL THEN excluded.cache_write_1h
                        WHEN excluded.cache_write_1h IS NULL THEN cache_write_1h
                        ELSE MAX(cache_write_1h, excluded.cache_write_1h) END,
  speed    = CASE WHEN speed IS NULL THEN excluded.speed
                  WHEN excluded.speed IS NULL THEN speed ELSE MAX(speed, excluded.speed) END
```

  - In the same transaction, after the slash insert and before `.read cursors.sql`:

```sql
CREATE TEMP TABLE _prompts_in (entry_uuid TEXT, session_id TEXT, ts_ms TEXT, kind TEXT);
.import "$prompts_tsv" _prompts_in
INSERT OR IGNORE INTO claude_prompts (entry_uuid, session_id, ts_ms, kind)
SELECT entry_uuid, NULLIF(session_id,''), CAST(ts_ms AS INTEGER), kind FROM _prompts_in
WHERE COALESCE(entry_uuid,'') <> '' AND COALESCE(ts_ms,'') <> '' AND COALESCE(kind,'') <> '';
```

  - Update the header comment:
    - the carried state;
    - why `sent_ms` is right under MIN across runs (spec §3.1's last paragraph);
    - why `claude_prompts` is durable;
    - the **M4** correction. The tool-call merge is order-independent for `ts`, `is_sidechain`, `is_error` and `tool_name`, but COALESCE fields keep the first non-NULL arrival: 157 live ids have `sessionId`s that differ across files, and no number reads those fields.

    Make the same M4 correction at `lib.sh`'s `claude_tool_calls` comment, at `ingest.sh`'s upsert comment, and in `CLAUDE.md`.
- [ ] **Step 5: R1.** In `capture-scripts.test.ts`'s unscoped-DELETE guard, a statement that passes `/WHERE/i` must also fail `/\bWHERE\s+(?:1(?:\s*=\s*1)?|true|'1')\s*;$/i`.
- [ ] **Step 6: Run** `npx vitest run tests/ingest.test.ts tests/capture-scripts.test.ts tests/config.test.ts tests/core-schema.test.ts tests/install.test.ts`, then `npm test` and `npm run typecheck`. Expect PASS.
- [ ] **Step 7: Plant, and watch exactly one test go red each time:**
  - `sent_ms` merged by MAX, in `ON CONFLICT` **and** in the SELECT (Step 3.3);
  - `last_user_ms` not carried over, with `carry` always `null` (3.2);
  - the `<task-notification>` branch returning `"prompt"` (3.5);
  - the `claude_prompts` insert moved after `COMMIT;` (3.8);
  - `DELETE FROM claude_prompts WHERE 1;` added to `rollup.sh` (R1);
  - `claude_prompts` removed from `DURABLE_TABLES` while that same DELETE is planted, to confirm the list is what catches it.
- [ ] **Step 8: Live copy.**
  - Check that `grep -rc '"type": "user"' ~/.claude/projects | grep -v ':0$'` is empty. The filter assumes compact JSON.
  - Time `bash capture/ingest.sh --backfill` (`WATCHTOWER_TRANSCRIPTS_DIR=$HOME/.claude/projects`, read-only on transcripts), then one normal run. Record both times.
  - Record:
    - the share of requests with `first_ms`;
    - the split present, and `cache_write_5m + cache_write_1h = tokens_cache_creation` on every row with both;
    - `speed` counts by `is_sidechain`;
    - `claude_prompts` counts by `kind` for the last 20 days, against spec §3.3's table;
    - the `sent_ms IS NULL` count among main-thread requests.
- [ ] **Step 9: Commit** `feat(stage-4b): capture v6 — ms timestamps, sent_ms, cache-write split, speed, turn boundaries`. Then run the **scoped review** of this task, followed by at most one fix round.

### Task 2: Pricing and cost

**Files:**
- Modify:
  - `capture/rollup.sh`, section 1 (`# ---- rebuild daily rollups`, lines ~230–726);
  - `tests/fixtures/make-fixture.sh`: the `reqp` helper and scenarios;
  - `tests/project-rollup.test.ts`: `COLUMNS` and a new scenario `it`;
  - `CLAUDE.md`: regenerable list, 17 columns.
- Create: `tests/cost-rollup.test.ts`.

**Interfaces:**
- Consumes: Task 1's columns and tables.
- Produces:
  - `claude_prices` (11 rows);
  - `claude_request_metrics`, every row with `priced`, `price_note`, `cost_table_usd`, `cost_write_5m_usd` and `cost_write_1h_usd`. `response_ms` and `tok_per_s` stay NULL until Task 3;
  - the four rollup columns;
  - read-phase temp tables that Task 3 extends: `_pk`, `_prices`, `_pwin` and `_rm`. `_rm` has one row per request with `ts IS NOT NULL`, carrying `request_id, day, project_key, session_id, model, is_sidechain, priced, price_note, cost_table_usd, cost_write_5m_usd, cost_write_1h_usd, response_ms, tok_per_s`.

- [ ] **Step 1: Fixtures.** In `make-fixture.sh`:

```bash
# reqp <request-id> <session> <abs-ts> <cwd> <model> <in> <out> <cache-read> <cw5m|-> <cw1h|-> [speed|-] [sidechain]
# A claude_requests row with the v6 pricing inputs; "-" writes NULL. Absolute ts,
# because every BASE-relative row is dated 2025-06-15 -- before any price row's
# effective_from (2026-01-01) -- and would be unknown-model.
# tokens_cache_creation = cw5m + cw1h, with "-" counted as 0.
```

  Scenarios, all at `$(epoch 2026-09-10T12:00:00Z)` plus small offsets unless stated:
  - **`price-rows`**: one request per model id in spec §4.1 (11 ids). Each has in 1000, out 2000, cache-read 3000, cw5m 400 and cw1h 600, with speed `standard`.
  - **`price-notes`**, on one day. The priced rows carry **no** cache creation, so the split plant below reaches only `price-rows`:

    | request | inputs | expected |
    |---|---|---|
    | `n_syn` | model `<synthetic>`, all tokens 0 | `NULL/synthetic`, in neither count |
    | `n_unk` | model `claude-mystery-9` | `0/unknown-model`, NULL cost |
    | `n_fast` | `claude-opus-5`, speed `fast` | `0/fast` |
    | `n_nosplit` | `claude-opus-5`, speed `standard`, cw5m `-`, cw1h `-`, then `fx_sql "UPDATE claude_requests SET tokens_cache_creation = 100 WHERE request_id = 'n_nosplit';"`: the pre-backfill shape (Review Focus 4) | `0/no-split` |
    | `n_absent` | `claude-opus-5`, speed `-`, in 1000, out 2000, cache-read 0, no cache creation | `1/speed-absent`, cost = (1000·5 + 2000·25)/1e6 = **0.055** |
    | `n_ok` | `claude-haiku-4-5`, speed `standard`, in 1000, out 1000 | `1/NULL`, cost = (1000·1 + 1000·5)/1e6 = **0.006** |

  - **`price-change`**: `claude-opus-5` rows at `2025-12-31T12:00:00Z`, `2026-02-28T12:00:00Z` and `2026-03-01T12:00:00Z`, each with in 1000, out 0 and no cache.
  - **`priced-mixed`**: `mixed-projects-one-day`'s setup (its two repos, the unresolvable cwd and the excluded cwd), plus on each of those four cwds a `reqp` at 2026-09-10 of a priced `claude-opus-5`, a priced `claude-sonnet-5`, one `n_absent`-shaped row and one unknown model. Add two sessions via `sess`/`snap`, one with a cost snapshot and one without, so `sessions_with_cost` is non-trivial.
- [ ] **Step 2: Failing tests** in `tests/cost-rollup.test.ts`, using `buildAndRoll`:
  1. `price-rows`: `cost_table_usd` per model equals the test's **own literal table** within 1e-12, with the arithmetic in comments. `claude_prices` has 11 rows with `verified_on = '2026-09-28'` and the spec's source URL.

     | model id(s) | cost |
     |---|---|
     | fable-5-1 | 10000 + 100000 + 750 + 5000 + 12000 = 127750 → **0.12775** |
     | fable-5 | 10000 + 100000 + 3000 + 5000 + 12000 → **0.13** |
     | opus-5-5 | 4000 + 40000 + 600 + 2000 + 4800 → **0.0514** |
     | opus-5 / opus-4-8 / opus-4-7 | 5000 + 50000 + 1500 + 2500 + 6000 → **0.065** |
     | sonnet-5-5 / sonnet-5 | 2000 + 20000 + 600 + 1000 + 2400 → **0.026** |
     | sonnet-4-6 | 3000 + 30000 + 900 + 1500 + 3600 → **0.039** |
     | haiku-4-5 / haiku-4-5-20251001 | 1000 + 10000 + 300 + 500 + 1200 → **0.013** |

     `cost_write_5m_usd` and `cost_write_1h_usd` are the last two terms / 1e6, e.g. opus-5 0.0025 / 0.006.
  2. `price-notes`, as its own `it`: every row's `priced`, `price_note` and cost exactly as tabled. The daily row has `priced_requests` 2, `unpriced_requests` 3 and `cost_table_usd` 0.061, and `n_syn` is in neither count.
  3. `speed-absent`, as its own `it` (the plant target): `n_absent` is `1/speed-absent/0.055`.
  4. `price-change`: run a temp copy of `rollup.sh` with this line spliced in before the marker `-- 4B: end of the price table`:

     ```sql
     INSERT INTO _prices VALUES ('claude-opus-5','standard','2026-03-01',1,1,1,1,1,'2026-09-28','fixture');
     ```

     Run it with `buildAndRoll`'s env (`THEONE_DB_PATH`, `CC_LIB_PATH`, `TZ=UTC`). Then:
     - 2025-12-31 is `0/unknown-model` (before every row);
     - 2026-02-28 is 1000·5/1e6 = **0.005**;
     - 2026-03-01 is 1000·1/1e6 = **0.001**.
  5. Guard: no file under `lib/` contains `6.25`, `3.75`, `12.5` or `about-claude/pricing`. Grep first; there are no hits today.
- [ ] **Step 3: The read phase.** Section 1's heredoc now opens with `BEGIN DEFERRED;`:
  - `DROP TABLE IF EXISTS _pk; CREATE TEMP TABLE _pk …; CREATE INDEX …`, moved verbatim from under `BEGIN IMMEDIATE`;
  - then the tables below;
  - then `COMMIT; BEGIN IMMEDIATE;` followed by today's statements unchanged, minus `_pk`.

  Add a comment block that says why (the C1 rule; `_pk` moved; the existing temp tables stay put, P2).

```sql
DROP TABLE IF EXISTS _prices;
CREATE TEMP TABLE _prices (model TEXT, speed TEXT, effective_from TEXT, input REAL, output REAL,
  cache_read REAL, cache_write_5m REAL, cache_write_1h REAL, verified_on TEXT, source TEXT);
-- Spec 4.1, verified 2026-09-28. USD per MTok. One INSERT per model id, so a
-- price change is one new line with a later effective_from, and history is
-- never repriced. No rate may appear under lib/ (a test greps for these).
INSERT INTO _prices VALUES ('claude-fable-5-1','standard','2026-01-01',10,50,0.25,12.50,20,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-fable-5','standard','2026-01-01',10,50,1.00,12.50,20,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-opus-5-5','standard','2026-01-01',4,20,0.20,5.00,8,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-opus-5','standard','2026-01-01',5,25,0.50,6.25,10,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-opus-4-8','standard','2026-01-01',5,25,0.50,6.25,10,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-opus-4-7','standard','2026-01-01',5,25,0.50,6.25,10,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-sonnet-5-5','standard','2026-01-01',2,10,0.20,2.50,4,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-sonnet-5','standard','2026-01-01',2,10,0.20,2.50,4,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-sonnet-4-6','standard','2026-01-01',3,15,0.30,3.75,6,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-haiku-4-5','standard','2026-01-01',1,5,0.10,1.25,2,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-haiku-4-5-20251001','standard','2026-01-01',1,5,0.10,1.25,2,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
-- 4B: end of the price table
DROP TABLE IF EXISTS _pwin;
CREATE TEMP TABLE _pwin AS
SELECT *, LEAD(effective_from) OVER (PARTITION BY model, speed ORDER BY effective_from) AS effective_to
FROM _prices;

DROP TABLE IF EXISTS _rm;
CREATE TEMP TABLE _rm AS
SELECT request_id, day, project_key, session_id, model, is_sidechain, priced, price_note,
       CASE WHEN priced = 1 THEN (tin * p_in + tout * p_out + tcr * p_cr
                                  + COALESCE(w5, 0) * p_w5 + COALESCE(w1, 0) * p_w1) / 1e6 END AS cost_table_usd,
       CASE WHEN priced = 1 THEN COALESCE(w5, 0) * p_w5 / 1e6 END AS cost_write_5m_usd,
       CASE WHEN priced = 1 THEN COALESCE(w1, 0) * p_w1 / 1e6 END AS cost_write_1h_usd,
       NULL AS response_ms, NULL AS tok_per_s                 -- Task 3 replaces these two
FROM (
  SELECT r.request_id, r.day, COALESCE(k.project_key, '(unfiled)') AS project_key,
         r.session_id, r.model, r.is_sidechain, r.last_ms, r.sent_ms,
         r.tokens_in AS tin, r.tokens_out AS tout, r.tokens_cache_read AS tcr,
         r.cache_write_5m AS w5, r.cache_write_1h AS w1,
         p.input AS p_in, p.output AS p_out, p.cache_read AS p_cr,
         p.cache_write_5m AS p_w5, p.cache_write_1h AS p_w1,
         -- Spec 4.1's case table, in its order.
         CASE WHEN r.model = '<synthetic>' THEN NULL
              WHEN p.model IS NULL THEN 0
              WHEN r.speed IS NOT NULL AND r.speed <> 'standard' THEN 0
              WHEN r.tokens_cache_creation > 0 AND r.cache_write_5m IS NULL AND r.cache_write_1h IS NULL THEN 0
              ELSE 1 END AS priced,
         CASE WHEN r.model = '<synthetic>' THEN 'synthetic'
              WHEN p.model IS NULL THEN 'unknown-model'
              WHEN r.speed IS NOT NULL AND r.speed <> 'standard' THEN 'fast'
              WHEN r.tokens_cache_creation > 0 AND r.cache_write_5m IS NULL AND r.cache_write_1h IS NULL THEN 'no-split'
              WHEN r.speed IS NULL THEN 'speed-absent'
         END AS price_note
  -- day is EXACTLY _dtok's expression, so cost buckets with tokens (spec 4.1).
  -- claude_requests has no `day` column, so the alias cannot shadow one.
  FROM (SELECT *, strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day
        FROM claude_requests WHERE ts IS NOT NULL) r
  LEFT JOIN _pk k ON k.cwd = r.cwd
  LEFT JOIN _pwin p ON p.model = r.model AND p.speed = 'standard'
        AND p.effective_from <= r.day AND (p.effective_to IS NULL OR r.day < p.effective_to)
);
```

```sql
DROP TABLE IF EXISTS _cost_d;
CREATE TEMP TABLE _cost_d AS
SELECT day, TOTAL(CASE WHEN priced = 1 THEN cost_table_usd END) AS cost_t,
       SUM(CASE WHEN priced = 1 THEN 1 ELSE 0 END) AS priced_n,
       SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced_n
FROM _rm GROUP BY day;
DROP TABLE IF EXISTS _cost_p;
CREATE TEMP TABLE _cost_p AS
SELECT project_key, day, TOTAL(CASE WHEN priced = 1 THEN cost_table_usd END) AS cost_t,
       SUM(CASE WHEN priced = 1 THEN 1 ELSE 0 END) AS priced_n,
       SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced_n
FROM _rm GROUP BY project_key, day;
```

- [ ] **Step 4: The write phase.**
  - `_sx` gains `CASE WHEN c.cost IS NOT NULL THEN 1 ELSE 0 END AS has_cost`. The daily subquery gains `SUM(has_cost) AS with_cost`, and `_psess` gains `SUM(is_dom * has_cost) AS with_cost`.
  - `_days` gains `UNION SELECT day FROM _cost_d`, and `_pkeys` gains `UNION SELECT project_key, day FROM _cost_p`. Both are subsets by construction; the UNIONs make the identity unconditional.
  - Both INSERTs gain `cost_table_usd, priced_requests, unpriced_requests, sessions_with_cost`:
    - daily: `COALESCE(c.cost_t, 0), COALESCE(c.priced_n, 0), COALESCE(c.unpriced_n, 0), COALESCE(s.with_cost, 0)` with `LEFT JOIN _cost_d c ON c.day = d.day`;
    - project: `COALESCE(c.cost_t, 0), COALESCE(c.priced_n, 0), COALESCE(c.unpriced_n, 0), COALESCE(sp.with_cost, 0)` with `LEFT JOIN _cost_p c ON c.project_key = pk.project_key AND c.day = pk.day`.
  - Before `COMMIT`:

```sql
DELETE FROM claude_prices;
INSERT INTO claude_prices (model, speed, effective_from, input, output, cache_read, cache_write_5m, cache_write_1h, verified_on, source)
SELECT model, speed, effective_from, input, output, cache_read, cache_write_5m, cache_write_1h, verified_on, source FROM _prices ORDER BY rowid;
DELETE FROM claude_request_metrics;
INSERT INTO claude_request_metrics (request_id, day, session_id, model, is_sidechain, priced, price_note, cost_table_usd, cost_write_5m_usd, cost_write_1h_usd, response_ms, tok_per_s)
SELECT request_id, day, session_id, model, is_sidechain, priced, price_note, cost_table_usd, cost_write_5m_usd, cost_write_1h_usd, response_ms, tok_per_s FROM _rm ORDER BY rowid;
```

- [ ] **Step 5: Reconciliation.**
  - `project-rollup.test.ts` `COLUMNS` gains `{ proj: "cost_table_usd", daily: "cost_table_usd", epsilon: 1e-9 }`, `priced_requests`, `unpriced_requests` and `sessions_with_cost`. Update the comment's "thirteen" to seventeen.
  - Add `it("matches on priced-mixed", …)` over `priced-mixed` with `WATCHTOWER_EXCLUDE_PATHS: "*/skipme"`.
  - Every existing reconciliation scenario keeps passing on all 17. Their `fx-model` rows are `unknown-model`, so `unpriced_requests` is exercised there.
- [ ] **Step 6: Run** `npx vitest run tests/cost-rollup.test.ts tests/project-rollup.test.ts tests/regression.test.ts`, then `npm test` and `npm run typecheck`. Expect PASS. The regression baseline stays untouched: its column list is explicit.
- [ ] **Step 7: Plant, and watch exactly one test go red each time:**
  - a missing speed treated as unpriced (`WHEN r.speed IS NULL THEN 0` inserted before `ELSE 1`), which reds 2.3;
  - the split priced as all 5m (`r.tokens_cache_creation * p_w5` in place of the two split terms), which reds 2.1;
  - `_cost_p` grouped by `day` only, which reds reconciliation;
  - a `6.25` comment added to `lib/render/html.ts` (guard).
- [ ] **Step 8: Live copy** (continue on Task 1's copy, which has had its backfill). Run `bash capture/rollup.sh` and record:
  - the runtime;
  - unpriced counts by `price_note` and model. Expected: 0 `unknown-model`, 0 `fast`, 0 `no-split`, and `speed-absent` only where `is_sidechain = 1`. Investigate any other count before continuing.
  - lifetime `SUM(cost_table_usd)` against `SUM(cost_usd)` over the same sessions, per month;
  - the 17-column identity on the copy (`sqlite3` the same `SELECT`s the test uses).
- [ ] **Step 9: Commit** `feat(stage-4b): cost at API prices in the rollup`.

### Task 3: Latency, turns, order statistics, and the lock guards

**Files:**
- Modify: `capture/rollup.sh` (section 1's read and write phases), `tests/helpers/fixture-db.ts` (`ingestAndRoll`), `tests/fixtures/make-transcripts.sh` (`turns-mixed`), `tests/profile-rollup.test.ts` (N1)
- Create: `lib/read/perf.ts`, `tests/perf-stats.test.ts`, `tests/turns-rollup.test.ts`, `tests/rollup-lock.test.ts`

**Interfaces:**
- Consumes: `_rm`, `claude_prompts`, and `claude_requests.{first_ms, last_ms, sent_ms, entrypoint}`.
- Produces:
  - `claude_request_metrics.response_ms` and `tok_per_s`;
  - `claude_turns`;
  - from `lib/read/perf.ts`:

```ts
/** Spec 4.3's one definition. NULLs are dropped; n = 0 gives null. Sorts and picks only. */
export function median(values: readonly (number | null)[]): number | null;
/** Nearest rank: the value at 1-based position ceil(0.9 * n) in ascending order. */
export function p90(values: readonly (number | null)[]): number | null;
export interface OrderStats { n: number; median: number | null; p90: number | null }
export function orderStats(values: readonly (number | null)[]): OrderStats;
```

  - `ingestAndRoll(scenarios: string[], extraEnv?: Record<string, string>): string` in `tests/helpers/fixture-db.ts`. It makes the transcripts into a temp `projects/`, runs `cc_init_db`, `ingest.sh --quiet` and `rollup.sh --quiet` (`TZ=UTC`), and returns the DB path.

- [ ] **Step 1: Order statistics, test first.** `tests/perf-stats.test.ts`:
  - `median([3,1,2]) === 2`, `median([4,1,3,2]) === 2.5` and `median([null, 5]) === 5`;
  - `median([]) === null` and `median([null]) === null`;
  - `p90([10,1,2,3,4,5,6,7,8,9]) === 9` (position ⌈9⌉; interpolation would give 9.1), `p90([1,2]) === 2`, `p90([5]) === 5`, and 11 values 1..11 give 10;
  - `orderStats([null, 2, 1]) = { n: 2, median: 1.5, p90: 2 }`.

  Implement `perf.ts` with a copy-sort (`[...].sort((a, b) => a - b)`), not an in-place sort.
- [ ] **Step 2: Fixture `turns-mixed`.** Session `s_t` in `$P/s_t.jsonl`, in file order, all on `2026-09-10`:

  | # | line | ts |
  |---|---|---|
  | 1 | `uent u_p1 '"fix the bug"'` | 10:00:00.000 |
  | 2 | `rec r1 … 5` | 10:00:01.500 |
  | 3 | `rec r1 … 600` | 10:00:03.000 |
  | 4 | `tres … tu_a false` | 10:00:04.000 |
  | 5 | `rec r2 … 250` | 10:00:05.250 |
  | 6 | `uent u_i1 '[{"type":"text","text":"[Request interrupted by user]"}]'` | 10:00:06.000 |
  | 7 | `uent u_n1 '"<task-notification>done</task-notification>"'` | 10:01:00.000 |
  | 8 | `rec r3 … 100` | 10:01:02.000 |
  | 9 | `uent u_c1 '"<command-name>/review</command-name>"'` | 10:02:00.000 |
  | 10 | `tuse r4 … tu_q AskUserQuestion` (out 50) | 10:02:02.000 |
  | 11 | `tres … tu_q false` | 10:02:30.000 |
  | 12 | `rec r5 … 80` | 10:02:31.000 |
  | 13 | `uent u_l1 '"<local-command-stdout>ok</local-command-stdout>"'` | 10:03:00.000 |
  | 14 | `uent u_c2 '"<command-name>/model</command-name>"'` | 10:03:00.000 (same ms, Review Focus 3) |
  | 15 | `rec r6 … 40` | 10:03:01.000 |
  | 16 | `uent u_p2 '"hi"'` | 10:04:00.000 |
  | 17 | `rec r7 … 30` | 10:04:00.000 (same ms: response NULL, Review Focus 2) |

  Plus:
  - `$P/s_t/subagents/agent-a.jsonl`: `rec r_side s_t 10:00:04.500 … 999 '{"isSidechain":true}'`;
  - `$P/s_h.jsonl`: `uent u_h s_h '"run"'` at 11:00:00.000, then `rec r_h s_h … 10` at 11:00:02.000, patched `.entrypoint = "sdk-ts"`;
  - `$P/s_m.jsonl`: `rec r_m s_m … 10` at 12:00:01.000, with no user entry (Review Focus 1).
- [ ] **Step 3: Failing tests** in `tests/turns-rollup.test.ts` over `ingestAndRoll(["turns-mixed"])`:
  1. `claude_request_metrics` (response_ms / tok_per_s):

     | request | sent → last | response_ms | tok_per_s |
     |---|---|---|---|
     | r1 | u_p1 → 10:00:03.000 | 3000 | 600·1000/3000 = 200 |
     | r2 | tool result 10:00:04.000 → 10:00:05.250 | 1250 | 200 |
     | r3 | u_n1 → 10:01:02.000 | 2000 | 50 |
     | r4 | u_c1 → 10:02:02.000 | 2000 | 25 |
     | r5 | tool result 10:02:30 → 10:02:31 | 1000 | 80 |
     | r6 | u_c2 → 10:03:01.000 | 1000 | 40 |
     | r7 | u_p2 → 10:04:00.000 | NULL (0 is not positive) | NULL |
     | r_h | u_h → 11:00:02.000 | 2000 | 5 |
     | r_side, r_m | no user entry before them in their own file | NULL | NULL |

  2. `claude_turns`, exactly these five rows (`ORDER BY entry_uuid`):

     | uuid | kind | requests | wait_ms | status |
     |---|---|---|---|---|
     | `u_c1` | command | 2 | 31000 | human |
     | `u_c2` | command | 1 | 1000 | measured |
     | `u_h` | prompt | 1 | 2000 | headless |
     | `u_p1` | prompt | 2 | 5250 | measured |
     | `u_p2` | prompt | 1 | 0 | measured |

     There is no row for `u_i1`, `u_n1` or `u_l1`, and `r3` belongs to no turn. `day` is `2026-09-10` on every row.
  3. The sidechain case, its own `it`: `u_p1.requests = 2`, and `r_side` is not counted.
  4. The human case, its own `it`: `u_c1.status = 'human'`.
  5. The Review Focus 3 case, its own `it`: `u_c2` owns `r6`. The result is identical when `claude_prompts` rows are inserted in reverse order: rebuild with `DELETE` and re-`INSERT … ORDER BY entry_uuid DESC`, then re-run the rollup.
- [ ] **Step 4: Implement** in section 1's read phase:
  - `_rm`'s placeholders become:

```sql
-- last_ms, sent_ms and tout are the inner SELECT's columns (Task 2 carries them).
CASE WHEN last_ms IS NOT NULL AND sent_ms IS NOT NULL AND last_ms - sent_ms > 0
     THEN last_ms - sent_ms END AS response_ms,
CASE WHEN last_ms IS NOT NULL AND sent_ms IS NOT NULL AND last_ms - sent_ms > 0 AND tout > 0
     THEN tout * 1000.0 / (last_ms - sent_ms) END AS tok_per_s
```
  - Then, after `_rm`:

```sql
-- Turn boundaries in session order. Ties within one ms: kinds that do not start
-- a measured turn first, so a prompt/command owns the requests after a same-ms
-- local/notification line (plan P3); entry_uuid last, for determinism.
DROP TABLE IF EXISTS _bnd;
CREATE TEMP TABLE _bnd AS
SELECT entry_uuid, session_id, ts_ms, kind,
       LEAD(ts_ms) OVER (PARTITION BY session_id
                         ORDER BY ts_ms, (kind IN ('prompt','command')), entry_uuid) AS next_ms
FROM claude_prompts WHERE COALESCE(session_id, '') <> '';
DROP TABLE IF EXISTS _human;
CREATE TEMP TABLE _human AS
SELECT DISTINCT request_id FROM claude_tool_calls
WHERE tool_name IN ('AskUserQuestion', 'ExitPlanMode') AND COALESCE(is_sidechain, 0) = 0
  AND request_id IS NOT NULL;
-- Spec 4.3: main-thread requests of the same session, first_ms in [B, next B).
DROP TABLE IF EXISTS _trq;
CREATE TEMP TABLE _trq AS
SELECT b.entry_uuid, r.request_id, r.last_ms,
       CASE WHEN substr(COALESCE(r.entrypoint, ''), 1, 4) = 'sdk-' THEN 1 ELSE 0 END AS sdk,
       CASE WHEN h.request_id IS NOT NULL THEN 1 ELSE 0 END AS human
FROM _bnd b
JOIN claude_requests r ON r.session_id = b.session_id AND r.is_sidechain = 0
                      AND r.first_ms >= b.ts_ms AND (b.next_ms IS NULL OR r.first_ms < b.next_ms)
LEFT JOIN _human h ON h.request_id = r.request_id
WHERE b.kind IN ('prompt', 'command');
DROP TABLE IF EXISTS _turns;
CREATE TEMP TABLE _turns AS
SELECT b.entry_uuid, b.session_id,
       strftime('%Y-%m-%d', b.ts_ms / 1000, 'unixepoch', 'localtime') AS day,   -- plan P4
       b.kind, COUNT(*) AS requests, MAX(t.last_ms) - b.ts_ms AS wait_ms,
       CASE WHEN MIN(t.sdk) = 1 THEN 'headless'
            WHEN MAX(t.human) = 1 THEN 'human'
            ELSE 'measured' END AS status
FROM _bnd b JOIN _trq t ON t.entry_uuid = b.entry_uuid
GROUP BY b.entry_uuid, b.session_id, b.ts_ms, b.kind;
```

  - In the write phase, next to the metrics swap:

```sql
DELETE FROM claude_turns;
INSERT INTO claude_turns (entry_uuid, session_id, day, kind, requests, wait_ms, status)
SELECT entry_uuid, session_id, day, kind, requests, wait_ms, status FROM _turns ORDER BY rowid;
```

- [ ] **Step 5: Lock guards** in `tests/rollup-lock.test.ts`, plus the N1 extension in `profile-rollup.test.ts`.
  - **Section 1.** Take the statements of the heredoc after `# ---- rebuild daily rollups`, split the same way `profileStatements()` does.
    - `st[0] === "BEGIN DEFERRED"`.
    - The first `COMMIT` is followed by `BEGIN IMMEDIATE`.
    - Every write-shaped statement (`/^(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i`) before that `COMMIT` matches one of:
      - `CREATE TEMP TABLE _\w+`;
      - `CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?\w+ ON _\w+`;
      - `DROP TABLE IF EXISTS _\w+`;
      - `INSERT INTO _\w+`.
    - Each of `_pk`, `_prices`, `_pwin`, `_rm`, `_cost_d`, `_cost_p`, `_bnd`, `_human`, `_trq` and `_turns` is created **before** that `COMMIT`.
    - The write phase contains `DELETE FROM claude_prices`, `claude_request_metrics` and `claude_turns`, each followed by an `INSERT INTO <it> (…) SELECT … FROM _\w+ ORDER BY rowid`.
  - **N1** (4A re-review). In the profile test, every write-shaped statement in `st.slice(1, readCommit)` matches one of:
    - `CREATE TEMP TABLE _pf_`;
    - `CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?\w+ ON _pf_`;
    - `DROP TABLE IF EXISTS _pf_`;
    - `INSERT INTO _pf_`;
    - `UPDATE _pf_`.
- [ ] **Step 6: Run** `npx vitest run tests/perf-stats.test.ts tests/turns-rollup.test.ts tests/rollup-lock.test.ts tests/profile-rollup.test.ts`, then `npm test` and `npm run typecheck`. Expect PASS.
- [ ] **Step 7: Plant, and watch exactly one test go red each time:**
  - `r.is_sidechain = 0` dropped from `_trq` (3.3);
  - the `human` branch removed (3.4);
  - p90 by linear interpolation (`perf-stats`);
  - `(kind IN ('prompt','command'))` dropped from the `LEAD` order (3.5);
  - `_turns`' `CREATE` moved after `BEGIN IMMEDIATE` (section 1 guard);
  - `CREATE TABLE _pf_plant AS SELECT 1 AS x;` (TEMP forgotten) before `_pf_win` (N1).
- [ ] **Step 8: Live copy.**
  - **Lock hold.** Run a probe on a second connection: busy timeout 0, `BEGIN IMMEDIATE; ROLLBACK;` about once a millisecond, logging each interval in which it fails (4A's `measure.py probe`; rewrite it in the scratchpad, about 30 lines of Python with `sqlite3`).
    - Probe one run of `main`'s `rollup.sh` (`git show main:capture/rollup.sh`) and one of this branch's, on **separate** copies of the same backup, each in its own directory.
    - Record section 1's hold for both (4A measured 0.146 s). The **added** hold must be < 100 ms. If it isn't, stop and report.
  - **Hand checks.** Draw 20 random `request_id`s with a `response_ms` (`ORDER BY random() LIMIT 20`) and 5 random measured turns.
    - For each, find its transcript (`grep -l`), then recompute from the raw lines with a throwaway `jq` script that shares no code with `ingest.sh`: the preceding `type=="user"` line's ms, the last partial's ms, and the boundary and next boundary.
    - All must match exactly. Paste the table into the report.
  - Record the turn counts by status and kind, and the median and p90 response by model, for the report.
- [ ] **Step 9: Commit** `feat(stage-4b): response time, turns and order statistics; guard both read phases`.

### Task 4: `peakctx`, the hygiene rescale, `event_covered` — and TheOneOS

**Files:**
- Modify:
  - `capture/rollup.sh`: `_sx` (~line 451), the hygiene UPDATEs (~548–591), and the profile section's `_pf_profile`, `_pf_dw`, `_pf_in`, parts and evidence;
  - `lib/read/history.ts`: `hygieneScale`, drop the M14 peak workaround at ~413–418;
  - `lib/render/history.ts`: scale labels and the rescaled-day note;
  - `lib/projects.ts`: `peakContextPct: number | null` and a NULL-aware max;
  - `lib/read/profile.ts`: `eventCovered` and `eventStart`;
  - `tests/project-rollup.test.ts:477-479` and `tests/read-history.test.ts:209`, folded (see Step 5);
  - `tests/profile-rollup.test.ts`;
  - `tests/regression/claude-baseline.json`, in its own commit.
- Create: `tests/hygiene-rescale.test.ts`, `tests/fixtures/theone-peak-proof.mjs` (run by hand, not in `npm test`).
- TheOneOS, worktree `../TheOneOS-4b` on a new branch `watchtower-4b-null-peak` off `main`:
  - `lib/claude-hours/hours.ts:93`;
  - `types.ts:25,111`;
  - `build.ts:57,65,69-81,205,236`;
  - `components/personal/ai-spend/claude-hours-panel.tsx`;
  - `tests/claude-hours.test.ts`.

**Interfaces:**
- Produces:
  - `claude_daily_rollups.peak_context_pct` and `claude_project_rollups.peak_context_pct` are NULL when no session that day has a reading;
  - `claude_profile_daily.event_covered`;
  - discipline evidence JSON gains `event_covered` for `session-hygiene` and `security`;
  - `HygieneScale = 100 | 75 | 70 | 65 | 60 | 45 | 35`;
  - `hygieneScale(cacheHitPct: number | null, peakPct: number | null, windowMs: number): HygieneScale`;
  - `ProfileData` gains `eventCovered: boolean` (for the latest day) and `eventStart: string | null` (local day of `MIN(ts)` over `claude_events`).

- [ ] **Step 1: Fixture `hygiene-cases`.** Four BASE-relative days, each with one session, events and known idle. They cover spec §4.4's four rows:
  - day 1: cache measured (`req` rows) and a snapshot with a context reading;
  - day 2: no requests and a context reading;
  - day 3: cache measured and **no snapshot**;
  - day 4: neither.

  Give day 4 `total_session_ms = 0` so it exercises the 35 denominator. Give day 3 a non-zero window so it exercises 70. Put the hand arithmetic in comments. For example, day 3:

  (cache% · 0.25 + compact-vs-clear + focus) × 100 / 70.
- [ ] **Step 2: Failing tests** in `tests/hygiene-rescale.test.ts`:
  1. One `it` (the COALESCE plant's single target). Days 3 and 4 have `peak_context_pct IS NULL` and exactly the hand-computed scores, and day 3's project row has a NULL peak.
  2. Days 1 and 2 have exactly the hand-computed scores, byte-identical to what `main`'s arithmetic gives.
  3. `claude_rank_progress.hygiene_score` equals `AVG(NULLIF(hygiene_score, 0))` over the four days.

  In `profile-rollup.test.ts`, add a fixture `profile-event-edge`: requests from 2026-08-01, and `claude_events` starting 2026-08-20.
  - A day whose window starts before 2026-08-20 has `event_covered = 0`:
    - security is `needs-data` with score 0;
    - session-hygiene averages only its two non-event parts;
    - both evidence objects carry `"event_covered":0`.
  - The first covered day has `event_covered = 1` and today's arithmetic.
- [ ] **Step 3: Implement.**
  - **Peak.** `_sx`: `c.peakctx AS peakctx`, with no COALESCE. Rewrite the comment above it to say that both repos now read NULL.
  - **Hygiene.**
    - The first hygiene UPDATE stays byte-for-byte.
    - The cache rescale gains `AND peak_context_pct IS NOT NULL`.
    - A new statement follows it, and then `hygiene_score = 0 WHERE sessions_count = 0` runs as today:

```sql
-- A day with sessions but no context reading (no snapshot) has no context
-- term. Spec 4.4: score = measured terms x 100 / what they could reach that day:
-- cache 25 if measured, compact-vs-clear 25, focus 20 (10 when the window is 0).
-- 70 / 60 with a cache reading, 45 / 35 without. A separate statement gated on
-- IS NULL, like the cache rescale above, so a day WITH a peak is never rewritten.
UPDATE claude_daily_rollups SET hygiene_score = max(0.0, min(100.0,
    ( COALESCE(cache_hit_percentage * 0.25, 0.0)
    + (CASE WHEN (compacts+clears) = 0 THEN 18.0 ELSE 25.0*compacts/(compacts+clears) END)
    + (CASE WHEN total_session_ms = 0 THEN 10.0
            ELSE max(0.0, min(20.0, 20.0*(1.0 - CAST(idle_ms AS REAL)/total_session_ms))) END) )
  * 100.0 / ( (CASE WHEN cache_hit_percentage IS NULL THEN 0.0 ELSE 25.0 END) + 25.0
            + (CASE WHEN total_session_ms = 0 THEN 10.0 ELSE 20.0 END) )))
 WHERE peak_context_pct IS NULL;
```

  - **Event coverage** (profile section, read phase):

```sql
DROP TABLE IF EXISTS _pf_evcov;
CREATE TEMP TABLE _pf_evcov AS
SELECT strftime('%Y-%m-%d', MIN(ts), 'unixepoch', 'localtime') AS event_start FROM claude_events;
```

    - `_pf_profile`'s insert gains `event_covered = CASE WHEN ev.event_start IS NOT NULL AND date(d.day, '-29 day') >= ev.event_start THEN 1 ELSE 0 END`, beside `tool_covered`.
    - `_pf_dw` carries it.
    - In `_pf_in`:
      - `compactions` = `CASE WHEN dw.event_covered = 1 THEN COALESCE(ev.compactions, 0) END`;
      - `prompts_with_mode` and `bypass_prompts` are gated the same way;
      - `bypass_share` = `CASE WHEN dw.event_covered = 1 AND ev.prompts_with_mode > 0 THEN … END`.

      The session-hygiene part `MIN(100, MAX(0, compactions * 20))` then yields NULL, and `AVG` skips it.
    - The session-hygiene and security `json_object`s gain `'event_covered', event_covered`.
    - The write-phase `INSERT INTO claude_profile_daily` and the `SELECT` list gain `event_covered`. The C1 regex still matches.
- [ ] **Step 4: Readers.**
  - `hygieneScale` returns:
    - 100 when both cache and peak are measured;
    - 75 or 65 when cache is NULL and peak is measured;
    - 70 or 60 when cache is measured and peak is NULL;
    - 45 or 35 when both are NULL.

    Update its doc comment; it still only labels.
  - `readHistory` passes `r.peak_context_pct` and deletes the M14 `snapshotDays` peak override. The condition is equivalent: NULL exactly when no session that day has a context reading.
  - `render/history.ts`:
    - `scaleLabel` names each denominator, for example "rescaled from 70 — no context reading" or "from 45 — no cache or context reading";
    - the rescaled-days note counts every non-100 scale.
  - `lib/projects.ts`: `peakContextPct: number | null`, and the accumulation takes a NULL-aware max.
  - Grep `peak_context_pct|peakContextPct` under `lib/` and fix every reader to `number | null`.
  - `readProfile` gains `eventCovered` and `eventStart`. No render change yet; that is Task 5.
- [ ] **Step 5: Fold and baseline.**
  - `project-rollup.test.ts:477-479` asserts the stored 0 that this task removes. `read-history.test.ts:209` asserts the same fact. Move both assertions into `hygiene-rescale.test.ts` 2.1 as `IS NULL`, and delete them at their old sites, so the COALESCE plant reds exactly one test. The reader test keeps asserting that the page shows null.
  - Run `npm test`. Only `regression.test.ts` should fail.
  - Regenerate `tests/regression/claude-baseline.json` with a throwaway `tests/regen.tmp.test.ts`. It calls `captureBaseline(buildAndRoll(s))` per `SCENARIOS` entry and writes the JSON with the same key order and 2-space indent as the committed file. Run it once, then delete it.
  - Diff old against new with a scratch script. **Every changed row must have `sessions_count > 0` and a NULL `peak_context_pct` in the new file**, or be a `rank` row whose `hygiene_score` is a mean over such days. Any other changed row is a bug; stop.
  - Paste the per-scenario before and after list into the ledger.
  - Commit that file alone: `test(stage-4b): regenerate the regression baseline for no-snapshot days`.
- [ ] **Step 6: Plant, and watch exactly one test go red each time:**
  - `peakctx`'s `COALESCE(…, 0)` restored (2.1);
  - `event_covered` ignored for security, i.e. `bypass_share`'s gate dropped (the event-edge test);
  - *(No plant for the cache rescale's `AND peak_context_pct IS NOT NULL`. The NULL-peak statement after it recomputes those days from scratch, so dropping the gate changes no number. It stays to state that each day is written by exactly one rescale. Ledger ruling, pre-flight.)*
- [ ] **Step 7: TheOneOS.**
  - `git -C ../TheOneOS worktree add ../TheOneOS-4b -b watchtower-4b-null-peak main`. TheOneOS's main checkout is on `feature`; leave it alone.
  - `hours.ts:93`: `c.peakctx AS peakctx`.
  - `types.ts`: `peakctx: number | null` and `contextTrend[].peakCtx: number | null`.
  - `build.ts`:
    - `DayAgg.peakCtx: number | null`, which `emptyDay` sets to `null`;
    - line 205: `if (r.peakctx !== null) a.peakCtx = a.peakCtx === null ? r.peakctx : Math.max(a.peakCtx, r.peakctx);`;
    - line 236: `peakCtx: a ? a.peakCtx : null`;
    - `hygieneForDay`: when `a.peakCtx === null`, return `clamp((cacheComp + compClear + focus) * 100 / (25 + 25 + (a.totalS === 0 ? 10 : 20)))`. The peak path stays byte-identical, and the cache term is unchanged (spec §7: no NULL-cache rescale).
  - The panel draws a null `peakCtx` as a gap, never 0.
  - `tests/claude-hours.test.ts` gains a no-snapshot day, with a null peak and its rescaled hygiene.
  - Run `npm run typecheck`, `npm test` and `npm run lint` in the worktree.
  - Commit with no attribution. Push the branch, and open the PR with `gh pr create`. **The user merges it.**
- [ ] **Step 8: The proof**, `tests/fixtures/theone-peak-proof.mjs`, run by hand on the live copy after this branch's rollup.
  - It reuses `theone-lockstep.mjs`'s loader: the `node:module` hook maps `@/` and stubs server modules.
  - For **before** (a `main` worktree of TheOneOS) and **after** (`../TheOneOS-4b`), it extracts `PER_SESSION_SQL` from that checkout's `hours.ts` source text, runs it with `sqlite3 -json -readonly` on the copy, and feeds the rows to that checkout's `buildClaudeHours(rows, now)`.
  - It checks:
    - **(a)** after's `contextTrend[].peakCtx` equals Watchtower's `peak_context_pct` on every day both have, and is null exactly where Watchtower's is NULL;
    - **(b)** before and after `daily[].hygiene` are identical on every day with a peak;
    - **(c)** `daily[].totalMs` and `activeMs` are identical before and after.
  - Paste the output into the report, and name the days in TheOneOS's 30-day span.
- [ ] **Step 9: Live copy.**
  - Record every day whose `hygiene_score` changed against Task 3's copy. Expected: exactly the no-snapshot days, 16 of 93 in the spec, with each old → new value.
  - Show that every day with a peak is equal under SQL `=`.
  - Record `claude_rank_progress.hygiene_score` old → new, and the days where `event_covered = 0` (expected: before 2026-08-02).
- [ ] **Step 10: Commit** `feat(stage-4b): no fabricated peak, the generalised hygiene rescale, and event coverage` (the baseline was committed in Step 5).

### Task 5: Pages

**Files:**
- Create:
  - `lib/render/cost.ts`: the shared cost labels;
  - `lib/render/perf.ts`: `performanceView`;
  - `tests/read-perf.test.ts`, `tests/render-perf.test.ts`.
- Modify:
  - `lib/read/perf.ts`: `readPerformance`;
  - `lib/read/live.ts`, `history.ts`, `projects.ts`, `sessions.ts`, `skills.ts` and `profile.ts`, with their `lib/render/*` pages;
  - `lib/render/layout.ts`: `NAV` gains `{ href: "/performance", label: "Performance" }` after Usage Profile;
  - `lib/views.ts`: a `STATIC_VIEWS` entry with `ranged: true`;
  - each page's existing read and render tests, `tests/report-budget.test.ts` and `tests/serve.test.ts`;
  - `CLAUDE.md` and `SESSION.md`.

**Interfaces:**

```ts
// lib/render/cost.ts -- the ONLY place these words and states are decided.
export const API_PRICES = "at API prices";
export const CC_FIGURE = "Claude Code's figure";
export interface ApiCost { usd: number; priced: number; unpriced: number }
/** priced+unpriced = 0 -> "no reading"; priced = 0 -> "not priced";
 *  unpriced > 0 -> "$1.23 · 4 not priced"; 0 < usd < 0.005 -> "<$0.01". Never "$0.00" for the first two. */
export function apiCostLabel(c: ApiCost | null): string;
/** null -> "no reading". */
export function claudeCodeCostLabel(usd: number | null): string;

// lib/read/perf.ts
export interface ModelPerf {
  model: string; cost: ApiCost; share: number | null;          // share of priced cost in range
  response: OrderStats; tokPerSMedian: number | null;
}
export interface PerformanceData {
  range: Range;
  models: ModelPerf[];                                          // by cost desc, then requests desc
  turns: OrderStats & { measured: number; human: number; headless: number };
  cacheMix: { tokens5m: number; tokens1h: number; cost5m: number | null; cost1h: number | null };
  unpriced: { note: string; model: string; n: number }[];
  speedAbsentPriced: number;
  prices: { model: string; speed: string; effectiveFrom: string; input: number; output: number;
            cacheRead: number; cacheWrite5m: number; cacheWrite1h: number;
            verifiedOn: string; source: string }[];
}
export function readPerformance(db: string, opts?: { now?: number; range?: Range }): PerformanceData;
export function performanceView(d: PerformanceData, opts: { tz?: string }): View;   // lib/render/perf.ts
```

- [ ] **Step 1: Failing read tests.**
  - `read-perf.test.ts`, over `ingestAndRoll(["turns-mixed"])` plus `buildAndRoll("price-notes")`:
    - the per-model n, median and p90 (`orderStats` over `response_ms`);
    - turn counts of 3 measured, 1 human and 1 headless, with a median wait of 1000 over {5250, 1000, 0};
    - unpriced by note and model, and `speedAbsentPriced`;
    - `prices` is 11 rows from `claude_prices`.
  - On a **v6 DB with no ms columns and no turns** (Review Focus 4): n = 0, every order statistic is `null`, `turns.measured` is 0, and nothing throws.
  - Each existing page's reader gains its figures and has a test:
    - Live: today's `ApiCost`, Claude Code's figure (the existing `snapshotDays` gating) and today's median measured wait;
    - History: per-day (weekly for `all`) cost by model, the median wait per bucket (`null` with no measured turn), and both costs in the day rows;
    - Projects: `ApiCost`, and Claude Code's figure as `null` when `sessions_with_cost = 0`;
    - Sessions: the whole-session `ApiCost` from `claude_request_metrics` by `session_id`;
    - Models & Skills: per model, its `ApiCost`, response `OrderStats` and median tok/s;
    - Usage Profile: `eventCovered` and `eventStart`.
- [ ] **Step 2: Implement the readers** with `lib/core/sql.ts` (`readonly: true`), following `lib/read/history.ts`'s range handling and its existing weekly bucketing for `all`.
  - SQL groups, sums stored values and filters on stored columns (`status = 'measured'`, `priced = 1`).
  - The reader never multiplies by a rate. Order statistics go through `perf.ts` only.
- [ ] **Step 3: Failing render tests.** Loop every theme in `THEMES` (all five).
  - Every page shows both labels, `API_PRICES` and `CC_FIGURE`, wherever a cost appears.
  - A "no reading" day, an all-unpriced day ("not priced") and a partial one ("$x · N not priced") each render their words. **No page's HTML contains `$0.00`** for any of the three states.
  - History's wait `areaChart` has a `null` point (a break) on a day with no measured turn (Review Focus 5). Its cost `stackedBar` has one series per model.
  - Projects shows "no reading" in Claude Code's column when `sessions_with_cost = 0`.
  - Models & Skills carries one line saying Claude Code's figure is per session and can't be split by model.
  - Usage Profile: when `!eventCovered`, the security needs-data card and the session-hygiene evidence say "hook data starts <eventStart>".
  - Performance renders its six sections in spec §5's order:
    1. a cost-by-model table with shares;
    2. response time by model: n, median, p90, tok/s, and the "end to end, includes time to first token" note (spec §4.2);
    3. wait per turn: median, p90, and the measured, human and headless counts;
    4. the cache-write `donut` of 5m vs 1h tokens, with their costs;
    5. not priced, by note and model, plus "N priced at standard with no speed recorded";
    6. the prices table, with `verified_on` and a link to its `source`, read from data.

    On the empty-range DB, every section says "no reading" and no chart draws a 0 series.
- [ ] **Step 4: Implement the renders.** Use existing primitives only: `card`, `sortableTable`, `stackedBar`, `areaChart` and `donut`. Every cost string goes through `cost.ts`.
- [ ] **Step 5: Wire it up.**
  - Add the `NAV` entry and the `STATIC_VIEWS` entry: `{ href: "/performance", ranged: true, build: (c) => performanceView(readPerformance(c.db, { now: c.now, range: c.range }), { tz: c.tz }) }`.
  - `report-budget.test.ts` asserts the report contains `id="performance"` and that a year still fits in `REPORT_BUDGET_BYTES`.
  - `serve.test.ts`: `/performance` returns 200, and `?range=<script>` falls back and is escaped.
- [ ] **Step 6: Plant, and watch exactly one test go red each time:**
  - `apiCostLabel` returning `"$0.00"` for `priced = 0` (the render `$0.00` test);
  - a `0` pushed in place of `null` for a day with no measured turn (the History break test);
  - the Performance entry removed from `STATIC_VIEWS` (the report test).
- [ ] **Step 7: Live copy.**
  - Render every page and the report from the copy. Record the timings and the report size against the 1 MB-per-year budget.
  - Take screenshots of amber and one team theme for Performance, History and Projects, into `shots/` (git-ignored).
- [ ] **Step 8: Docs.**
  - In `CLAUDE.md`:
    - schema v6;
    - `claude_prompts` in the durable list, and the three new regenerable tables;
    - the reconciliation identity at 17 columns;
    - section 1's read phase, in the Durable-vs-regenerable paragraph;
    - the Performance page;
    - the new test count.
  - Add a `SESSION.md` entry: state, the live-copy numbers from every task, and the rollout below.
- [ ] **Step 9: Run** `npm test` and `npm run typecheck` and expect PASS. Commit `feat(stage-4b): cost and latency on every page, and the Performance page`.

---

## After the tasks

1. One whole-branch review against the spec and this plan: Global Constraints, Plan decisions,
   Review Focus, and every plant recorded. Then at most one fix round.
2. Open the Watchtower PR to `main` with `gh pr create`, with no AI attribution. The TheOneOS PR is
   already open from Task 4.
3. **Rollout, by the user** (hand over these exact commands):

```bash
# 1. Dry-run the installer into a temp CLAUDE_DIR seeded from the live config, then diff settings.json
! D=$(mktemp -d) && cp -R ~/.claude/settings.json "$D/" && CLAUDE_DIR="$D" bash capture/install.sh && diff ~/.claude/settings.json "$D/settings.json"
# 2. The live install
! bash capture/install.sh
# 3. Backfill, then rebuild
! ~/.claude/watchtower-ingest.sh --backfill && ~/.claude/claude-usage-rollup.sh
# 4. Merge both PRs (Watchtower, then TheOneOS)
```
