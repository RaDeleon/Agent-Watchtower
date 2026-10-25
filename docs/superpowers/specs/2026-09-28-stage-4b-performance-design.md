# Stage 4B — Performance: cost at API prices, latency and turns, honest readings

**Status:** approved. The chat design was approved 2026-09-28 (§1–§3), and this written spec,
§2.1 a–d included, on 2026-09-29. §2.1 lists where it departs from the chat design, and why.
**Plan:** `docs/superpowers/plans/2026-09-29-stage-4b-performance.md`.
**Branch:** `stage-4b-performance`, cut from `main` @ `e77af29`.
**Research:** `2026-09-24-stage-4-brainstorm.md` (latency and pricing). **Prices:** Anthropic's
pricing page, <https://platform.claude.com/docs/en/about-claude/pricing>, read 2026-09-28.

## 1. Purpose and success

Watchtower learns what its traffic costs at API prices, per model, and how long each request
and each turn takes. It also stops showing three readings it doesn't have: `$0.00` for a
project with no cost reading, a peak context of 0% on a day with no snapshot, and compaction
and security scores over profile windows that start before hook data.

Success means:

1. After one `--backfill` on the live copy, every request with a transcript has ms timestamps
   and the cache-write split. Every main-thread request has `speed`, and every turn boundary
   is recorded.
2. Every price row's cost matches a hand computation. An unknown model shows "not priced",
   never `$0.00`. Per-project rows still sum to the daily rows on every reconcilable column
   (13 → 17).
3. The rollup's response times for 20 requests, and waits for 5 turns, match hand
   calculations from the raw transcript lines exactly.
4. Every day with a peak-context reading keeps a byte-identical hygiene score. The no-snapshot
   days change as §4.4 says. TheOneOS makes the matching change, proven numerically (§7).
5. The new Performance page and the additions to existing pages render under all five themes
   and in `watchtower report`, inside the 1 MB-per-year budget.
6. The rollup's write lock grows by less than 100 ms on the live copy. Every new guard has had
   its defect planted, and each plant turned exactly one test red.

## 2. Decisions (do not re-ask)

| # | Decision |
|---|---|
| 1 | Both cost figures side by side: **"at API prices"** and **"Claude Code's figure"** (the status line's `total_cost_usd`). Neither replaces the other. *(Q1 C)* |
| 2 | `peakctx` is NULL when there is no snapshot, in both repos, with the TheOneOS lockstep proof. *(Q2 A)* |
| 3 | An unknown model is "not priced" and counted, never priced at $0. *(Q3 A)* |
| 4 | Latency both per request and per turn. *(Q4 C)* |
| 5 | Existing pages gain the new figures; a new ranged **Performance** page holds the detail. *(Q5 C)* |
| 6 | A profile window scores compactions and security only when hook data covers it (`event_covered`). *(Q6 A)* |
| 7 | Capture goes in the existing ingest pass under the same cursor, schema v6, one backfill. *(chat §1)* |
| 8 | All derivations live in `rollup.sh`, built in the read phase. *(chat §2)* |
| 9 | Pages, tests, the five-task shape, and one scoped review after Task 1 only. *(chat §3)* |

### 2.1 Found while writing this spec — review these

Data checks made while writing the spec changed four details of the chat design:

- **a. What starts a turn.** "A string-content user entry that is not `isMeta`" wrongly
  includes 178 task notifications and about 176 local-command and `!` shell outputs from the
  last 20 days. It also misses 35 prompts that arrive as text arrays (hook-injected context,
  pasted images). §3.3 classifies entries by what they contain instead.
- **b. Percentiles are taken at read time, not stored per day.** Pages view 7d, 30d, 90d or
  all, and "all" is drawn per week. A median over a range can't be built from daily medians.
  So the rollup stores per-request and per-turn values, and `lib/read` takes order statistics
  over them with one shared definition (§4.3). `claude_model_daily` and `claude_turn_daily`
  are dropped. The rollup still decides every value, and what is included or excluded.
- **c. A missing `speed` is priced as standard.** 10,886 usage rows have no `speed` field,
  and every one is a subagent (sidechain) row. No row anywhere is `fast`. Those requests are
  priced at standard rates and counted on the page (§4.1). Treating them as "not priced"
  would leave about 17% of all usage rows unpriced, including most subagent traffic.
- **d. Projects need a reading count.** Telling `$0.00` from "no reading" per project takes a
  `sessions_with_cost` column. The reconciliation identity therefore grows by four columns
  (13 → 17), not one.

Also: `claude-sonnet-5-5` (first seen 2026-09-28, 7 requests) joins the price table. The 24
`<synthetic>` rows have zero tokens and made no API call, so they are neither priced nor
unpriced.

## 3. Capture — `capture/ingest.sh`, `capture/lib.sh`, schema v6

### 3.1 What ingest reads now

- **Filter.** The line filter keeps `"usage"`, `"tool_result"` or `<command-name>` lines
  today. It widens to also keep `"type":"user"` lines. Each file is still read once per run,
  from the cursor offset.
- **Carried state.** The `jq` pass becomes stateful within a file. It walks lines in file
  order and carries the ms timestamp of the most recent `type == "user"` entry: prompt, tool
  result or meta. Each file is one thread, because subagents write their own files. A corrupt
  line still drops only itself.
- **Cursor.** At EOF the carried value goes into the file's cursor row
  (`claude_ingest_cursor.last_user_ms`), and a resumed read starts from it. The cursor stays
  advisory: delete it and a full re-read reaches the same values.
- **Timestamps.** An ISO `timestamp` becomes integer ms. `…T06:55:36.123Z` → `…123`, and a
  timestamp with no fraction gets `.000`.

Per request partial (assistant entries with `message.usage`), in addition to today's fields:

- `first_ms` and `last_ms`: the partial's ms timestamp. The merge takes the MIN for `first_ms`
  and the MAX for `last_ms`.
- `sent_ms`: the carried user-entry ms at this partial, merged by MIN. NULL when no user entry
  comes before it in the file.
- `cache_write_5m` and `cache_write_1h`: `usage.cache_creation.ephemeral_5m_input_tokens` and
  `ephemeral_1h_input_tokens`. NULL when the object is absent. On the live data the split is
  present on every row and always sums to `cache_creation_input_tokens`.
- `speed`: `usage.speed`, or NULL when absent.

Each turn boundary (§3.3) emits a `P` row alongside the `R`, `T`, `E` and `S` rows.

`sent_ms` is right under MIN even when a request's partials span two runs. The earliest
partial always sees the user entry that actually preceded the request. A later partial can
only see that entry or a later one (a tool result written mid-stream, or the cursor's value).

### 3.2 Schema v6

```sql
-- Durable. Existing installs get the columns from cc_init_db's ALTER loop, run
-- before any index that names them. Fresh installs get them in CREATE TABLE.
ALTER TABLE claude_requests ADD COLUMN first_ms       INTEGER;  -- ms, first partial
ALTER TABLE claude_requests ADD COLUMN last_ms        INTEGER;  -- ms, last partial
ALTER TABLE claude_requests ADD COLUMN sent_ms        INTEGER;  -- ms, preceding user entry
ALTER TABLE claude_requests ADD COLUMN cache_write_5m INTEGER;  -- NULL = not recorded
ALTER TABLE claude_requests ADD COLUMN cache_write_1h INTEGER;
ALTER TABLE claude_requests ADD COLUMN speed          TEXT;     -- 'standard' | 'fast' | NULL
ALTER TABLE claude_ingest_cursor ADD COLUMN last_user_ms INTEGER;

CREATE TABLE IF NOT EXISTS claude_prompts (    -- durable: turn boundaries (§3.3)
  entry_uuid TEXT PRIMARY KEY,
  session_id TEXT,
  ts_ms      INTEGER NOT NULL,
  kind       TEXT NOT NULL                     -- prompt | command | notification | local | interrupt
);

-- Regenerable, existing tables gain columns (DEFAULT 0):
--   claude_daily_rollups, claude_project_rollups:
--     cost_table_usd REAL, priced_requests INTEGER, unpriced_requests INTEGER,
--     sessions_with_cost INTEGER
--   claude_profile_daily: event_covered INTEGER NOT NULL DEFAULT 0
-- Regenerable, new tables: claude_prices (§4.1), claude_request_metrics (§4.2),
--   claude_turns (§4.3).
```

`CC_SCHEMA_VERSION` (`capture/lib.sh`) and `schemaVersion` (`lib/config.ts`) both go from 5
to 6. Adding a column needs both the ALTER and the version bump (the `lib.sh` note).

**Merge rules.** All are order-independent and idempotent, like the token `MAX`.

- `first_ms` and `sent_ms` take the NULL-aware min; `last_ms` takes the NULL-aware max.
- `cache_write_5m` and `cache_write_1h` take the NULL-aware max. NULL means "not recorded",
  not 0, so the two must not be merged with the tokens' `DEFAULT 0` `MAX`.
- `speed` takes the NULL-aware max as text. Partials never disagree, and max makes the merge
  order-independent regardless.
- `claude_prompts` uses `INSERT OR IGNORE` on `entry_uuid`.

All of it runs in the same transaction as today's upserts and the cursor writes.

### 3.3 Turn boundaries (`claude_prompts`)

A boundary is a `type == "user"` entry that is main thread (`isSidechain` not true), is not
`isMeta`, and has no `tool_result` block. Its text is the string content, or the first `text`
block of array content. The start of that text decides `kind`:

| `kind` | text starts with | starts a measured turn | last 20 days |
|---|---|---|---|
| `command` | `<command-name>` or `<command-message>` | yes | 296 |
| `notification` | `<task-notification>` | no | 178 |
| `local` | `<local-command-stdout>`, `<local-command-stderr>`, `<bash-input>`, `<bash-stdout>`, `<bash-stderr>` | no | ~176 |
| `interrupt` | `[Request interrupted` | no | 4 |
| `prompt` | anything else | yes | ~1,124 |

Every boundary ends the turn before it. Only `prompt` and `command` start a turn whose wait is
measured. A notification's automatic follow-up therefore never inflates the previous prompt's
wait.

### 3.4 Backfill

Files already read to EOF will never show a normal run their ms timestamps, split, speed or
boundaries. **Rollout needs one `watchtower-ingest.sh --backfill`**, as in 4A. Every merge is
MIN, MAX or IGNORE, so re-reading is harmless. Rows with no transcript keep NULL. The runtime
on the live copy is measured and recorded.

## 4. Derivations — `capture/rollup.sh`

Every derivation lives in `rollup.sh`, in temp tables built in the **read phase**. The write
transaction only does `DELETE` + `INSERT` (4A's C1 rule, §4.6).

### 4.1 Prices and cost

The rollup writes `claude_prices` from rows held in `rollup.sh`. The table is regenerable, and
it exists so the page can show the rates it used. No rate appears under `lib/`.

```sql
CREATE TABLE IF NOT EXISTS claude_prices (
  model TEXT NOT NULL, speed TEXT NOT NULL, effective_from TEXT NOT NULL,  -- local day
  input REAL NOT NULL, output REAL NOT NULL, cache_read REAL NOT NULL,
  cache_write_5m REAL NOT NULL, cache_write_1h REAL NOT NULL,            -- USD per MTok
  verified_on TEXT NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (model, speed, effective_from)
);
```

Rows: `speed = 'standard'`, `effective_from = '2026-01-01'`, `verified_on = '2026-09-28'`,
and `source` = the pricing URL above. There is one row per model id:

| model id(s) | input | output | cache read | 5m write | 1h write |
|---|---|---|---|---|---|
| `claude-fable-5-1` | 10 | 50 | 0.25 | 12.50 | 20 |
| `claude-fable-5` | 10 | 50 | 1.00 | 12.50 | 20 |
| `claude-opus-5-5` | 4 | 20 | 0.20 | 5.00 | 8 |
| `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7` | 5 | 25 | 0.50 | 6.25 | 10 |
| `claude-sonnet-5-5`, `claude-sonnet-5` | 2 | 10 | 0.20 | 2.50 | 4 |
| `claude-sonnet-4-6` | 3 | 15 | 0.30 | 3.75 | 6 |
| `claude-haiku-4-5`, `claude-haiku-4-5-20251001` | 1 | 5 | 0.10 | 1.25 | 2 |

A later price change adds a row with a new `effective_from`. A request uses the row with the
latest `effective_from` on or before its local day, so history is never repriced.

**Per request.** This covers every row, sidechain included, because every row is an API call.
The one exception is `<synthetic>`.

| case | `priced` | `price_note` | `cost_table_usd` |
|---|---|---|---|
| model is `<synthetic>` | NULL | `synthetic` | NULL |
| the model has price rows, but none on or before the request's day *(2026-09-29, fix-round ruling M1)* | 0 | `no-price-yet` | NULL |
| no price row for the model | 0 | `unknown-model` | NULL |
| `speed` present and not `standard` | 0 | `fast` | NULL |
| `tokens_cache_creation > 0`, both split columns NULL | 0 | `no-split` | NULL |
| `speed` NULL, otherwise priceable | 1 | `speed-absent` | priced as standard |
| otherwise | 1 | NULL | priced |

The cost formula is `cost = (tokens_in·input + tokens_out·output + tokens_cache_read·cache_read
+ cache_write_5m·w5m + cache_write_1h·w1h) / 1e6`. A NULL split column counts as 0 when
`tokens_cache_creation = 0`. *(2026-09-29, fix-round ruling M2, the case table's reading:)* a
request with exactly one NULL cache-write side is priced, the present side at its rate and the
NULL side as 0; it is not `no-split`, which is both sides NULL.

**Rollup columns.** The daily and project rollups gain four columns. The first three are
grouped exactly like the token columns (the request's local day and project), so they
reconcile for the same reason tokens do:

- `cost_table_usd`: the sum of priced costs, 0 when nothing is priced.
- `priced_requests` and `unpriced_requests`. A `<synthetic>` row counts in neither.
- `sessions_with_cost`: sessions with at least one status-line cost reading. It is grouped
  like `sessions_count` (session start day, dominant project).

`cost_usd` stays as it is: Claude Code's figure.

### 4.2 Response time and output rate

```sql
CREATE TABLE IF NOT EXISTS claude_request_metrics (
  request_id TEXT PRIMARY KEY, day TEXT NOT NULL, session_id TEXT, model TEXT,
  is_sidechain INTEGER,
  priced INTEGER, price_note TEXT, cost_table_usd REAL,
  response_ms INTEGER, tok_per_s REAL
);
```

- `day` is the request's local day, the same bucket the token columns use.
- `response_ms = last_ms − sent_ms` when both exist and the result is positive; otherwise
  NULL.
- `tok_per_s = tokens_out × 1000.0 / response_ms` when `response_ms` is not NULL and
  `tokens_out > 0`; otherwise NULL.
- Both are **end to end**. They include time to first token (transcripts can't separate it
  out) and any hook time before the send. The page says so.

### 4.3 Turns and order statistics

For each main-thread boundary B whose kind is `prompt` or `command`, the turn is the set of
main-thread requests (`is_sidechain = 0`) in the same session with `first_ms` ≥ B's `ts_ms`
and < the `ts_ms` of the session's next boundary of any kind. The session's last turn has no
upper bound. A turn with no requests (`/clear`, `/model`) is not stored.

- `wait_ms` = the turn's `MAX(last_ms)` − B's `ts_ms`.
- `status` is one of three values:
  - `headless` when every request's `entrypoint` starts `sdk-`.
  - Otherwise `human` when any main-thread tool call from the turn's requests is
    `AskUserQuestion` or `ExitPlanMode`, because the wait includes a person answering.
  - Otherwise `measured`.
- Only `measured` turns enter wait statistics. The other two are counted and shown.

```sql
CREATE TABLE IF NOT EXISTS claude_turns (
  entry_uuid TEXT PRIMARY KEY, session_id TEXT, day TEXT NOT NULL, kind TEXT NOT NULL,
  requests INTEGER NOT NULL, wait_ms INTEGER, status TEXT NOT NULL
);
```

**Order statistics** live in `lib/read/perf.ts` and are used by every page. There is one
definition:

- **median**: the middle value, or the mean of the two middle values when the count is even.
- **p90**: nearest rank, the value at position ⌈0.9·n⌉ in ascending order.
- NULLs are left out. When n = 0 there is no reading.

They sort and pick stored values and nothing else. Which values exist, and which are
excluded, is decided in `rollup.sh`.

### 4.4 `peakctx` and hygiene

- **Peak.** `_sx.peakctx` loses its `COALESCE(…, 0)`, so a session with no snapshot has no
  peak. Daily and project `peak_context_pct` become NULL when none of their sessions has one;
  `MAX` skips NULLs.
- **Hygiene.** On such a day the context term is unmeasured. Today's rescale handles a NULL
  cache term; it generalises to: on a day with an unmeasured term,
  **score = (sum of the measured terms) × 100 / (the most those terms could reach that day)**.
  The most each term can reach: cache 25 if measured, context 30 if measured,
  compact-vs-clear 25, and focus 20 (10 when `total_session_ms = 0`).

  | cache | context | denominator | written? |
  |---|---|---|---|
  | measured | measured | — | not rewritten: byte-identical |
  | NULL | measured | 75 / 65 | today's arithmetic: byte-identical |
  | measured | NULL | 70 / 60 | new |
  | NULL | NULL | 45 / 35 | new |

- **What changes.** 16 of 93 live days have no snapshot. Their scores change, and so does
  `claude_rank_progress.hygiene_score`, which is a mean over days. The hygiene regression
  baseline is updated for exactly those days, in its own commit, with the before-and-after
  list in the ledger.
- **Readers.** They already turn a no-snapshot peak into "no reading" through `snapshotDays`.
  Now they read NULL directly, and their types become `number | null`.

### 4.5 Event coverage (`event_covered`)

`event_start` is the local day of `MIN(ts)` over `claude_events` (live: 2026-07-04). A
window W(D) is event-covered when its first day, D−29, is on or after `event_start`. When it
isn't:

- session hygiene's third part (compactions from `PreCompact`) is undefined, and its other two
  parts still score;
- security is needs-data;
- the evidence carries `event_covered: 0`.

On live data, days before 2026-08-02 change. Today's window is covered, so today's scores
don't move.

### 4.6 Lock discipline

Every new temp table is built in the read phase. The write transaction adds `DELETE` +
`INSERT` for `claude_prices`, `claude_request_metrics` and `claude_turns`, and the new rollup
columns ride in the existing `INSERT`s. On the live copy the added lock hold must stay under
100 ms, and it is recorded. The C1 structural guard is extended to cover the read phase
(4A's parked N1).

## 5. Pages

**Labels.** Every page labels the two figures "at API prices" and "Claude Code's figure".
With no reading it says "no reading". A cost with nothing priced says "not priced". A partial
one shows the priced sum and "N not priced". None of these ever renders `$0.00`.

| Page | Adds |
|---|---|
| Live | Today's cost both ways; today's median turn wait (measured turns). |
| History | Daily cost at API prices by model (`stackedBar`, weekly for "all"); median turn wait over time (`areaChart`, broken on days with no measured turn); both cost figures in the day table. |
| Projects | Both cost columns; "no reading" when `sessions_with_cost = 0`, which fixes the `$0.00`. |
| Sessions | Cost at API prices beside Claude Code's figure, both over the whole session. |
| Models & Skills | Per model: cost at API prices, response median and p90, median output tok/s. One line says Claude Code's figure is per session and can't be split by model. |
| Usage Profile | "hook data starts <date>" on the needs-data security card, and in session hygiene's evidence, when the window isn't event-covered. |
| **Performance** (new, ranged, after Usage Profile in the nav) | 1 cost by model: table and share. 2 response time by model: n, median, p90, tok/s. 3 wait per turn: median, p90, and the measured, human and headless counts. 4 cache-write mix: 5m vs 1h tokens and their cost (`donut`). 5 not priced: counts by note and model, plus the `speed-absent` count priced at standard. 6 prices used: `claude_prices` with its verified date and source link. |

Existing primitives only (`stackedBar`, `areaChart`, `donut`, `sortableTable`) and all five
themes. `watchtower report` includes the Performance page, and the 1 MB-per-year budget test
is extended to cover it.

## 6. Tests and guards

The convention holds: real scripts against fixture DBs and transcripts, `TZ=UTC`, and every
guard's defect planted until exactly one test turns red.

- **Ingest fixtures:**
  - ms timestamps across partials;
  - a request whose partials span two runs, so `sent_ms` comes from the cursor;
  - the cache-write split;
  - a row with no `speed`, a `fast` row, and an unknown model;
  - every boundary kind, including an array-content prompt and an interrupt;
  - replay and reverse order, which give identical tables;
  - deleting the cursor and re-reading, which gives identical values.
- **Plants (each turns exactly one test red):**
  - `sent_ms` merged by MAX;
  - `last_user_ms` not carried over;
  - missing speed treated as unpriced;
  - the split priced as all 5m;
  - a notification counted as a prompt;
  - a sidechain request counted in a turn;
  - an `AskUserQuestion` turn measured;
  - p90 by interpolation;
  - `peakctx`'s COALESCE restored;
  - `event_covered` ignored for security.
- **Cost:**
  - hand-computed cost for every price row;
  - an unknown model gives a NULL cost and is counted;
  - `effective_from` picks the right row across a change date, using a fixture-only second
    row.
- **Reconciliation:** all 17 columns, with `cost_table_usd` compared within 1e-9, as
  `cost_usd` is.
- **Hygiene:** byte-identical scores on days with a reading, compared against the pre-change
  rollup on the same fixture, plus all four denominator cases.
- **Guards:**
  - the schema pin at 6;
  - `claude_prompts` in the durable-table lists;
  - the durable `DELETE` guard without the `WHERE 1` bypass (4A R1);
  - the same-transaction test covering `claude_prompts` (4A M5);
  - the read-phase C1 guard (4A N1);
  - no price literal under `lib/`.
- **Render:** all five themes, including "no reading", "not priced", partial pricing and the
  Performance page.

## 7. Lockstep and rollout

**TheOneOS** (`lib/claude-hours/`): its own branch and PR, merged by the user.

- `hours.ts`: `c.peakctx AS peakctx`, with no COALESCE.
- `types.ts`: `peakctx: number | null`, and `contextTrend[].peakCtx: number | null`.
- `build.ts`: `peakCtx` starts at null and takes a NULL-aware max. When `peakCtx` is null,
  `hygieneForDay` drops the context term and rescales its remaining terms over what they
  could reach: 25 + 25 + 20, or 25 + 25 + 10 when `totalS = 0`. TheOneOS's cache term stays
  as it is. It has no NULL-cache rescale, and adding one is out of scope.
- The panel draws a null peak as a gap, never 0.
- **Proof on the same DB copy, recorded in the ledger:**
  - (a) per-day peak equals Watchtower's `peak_context_pct` on every day both have, and NULL
    where Watchtower's is NULL;
  - (b) TheOneOS's hygiene is identical before and after on every day with a peak;
  - (c) hours are unchanged.
- TheOneOS's hygiene already differs from Watchtower's: it takes the cache term from
  snapshots and has no NULL-cache rescale. This stage doesn't claim the two match.

**Live-copy measurements**, all recorded:

- the backfill time;
- the rollup time and the write-lock hold;
- 20 response times and 5 turn waits checked against raw transcript lines;
- unpriced counts by note (expected: 0 `unknown-model`, 0 `fast`, 0 `no-split`, and
  `speed-absent` on subagent rows only);
- cost at API prices against Claude Code's figure over the same sessions.

**Rollout, by the user:**

1. Dry-run `install.sh` into a temp `CLAUDE_DIR`.
2. Run the live install.
3. Run `~/.claude/watchtower-ingest.sh --backfill`, then `~/.claude/claude-usage-rollup.sh`.
4. Merge the TheOneOS PR.

## 8. Task shape

1. **Capture v6.** All of the v6 schema (every table and column, both version pins); ingest
   (ms, `sent_ms` and the cursor, the split, speed, `claude_prompts`); fixtures and plants.
   Carries 4A's M4 (merge-comment wording), M5, the M8 nits, R1 and R2. **Scoped review after
   this task only.**
2. **Pricing and cost.** `claude_prices`, the cost fields of `claude_request_metrics`, the
   four rollup columns, and the 17-column reconciliation.
3. **Latency and turns.** `response_ms`, tok/s, `claude_turns`, `lib/read/perf.ts`, the lock
   measurement, and the N1 guard.
4. **`peakctx`, the hygiene rescale and `event_covered`,** plus the TheOneOS change and its
   proof.
5. **Pages.** The five existing pages, the Performance page and the report.

Then one whole-branch review and at most one fix round.

## 9. Not in 4B

- Fast-mode, batch, data-residency (1.1×) and long-context pricing. None applies to today's
  traffic; a `fast` row shows as "not priced".
- Time to first token, which transcripts don't carry.
- `wt_requests.cost_usd`, which stays unset.
- A NULL-cache rescale in TheOneOS.
- 4A items that stay parked: final M8 (fixtures depend on the wall clock), N2 and N3.
- The `coach` stanza stays unimplemented.
