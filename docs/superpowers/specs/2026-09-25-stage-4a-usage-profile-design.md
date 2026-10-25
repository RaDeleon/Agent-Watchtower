# Stage 4A — the Usage Profile: ten disciplines, two ladders, week over week

**Status:** design approved in chat 2026-09-25; this written spec awaits user review.
**Branch:** `stage-4-usage-profile`, cut from `main` @ `78f6c63`.
**Brainstorm and research:** `2026-09-24-stage-4-brainstorm.md` (decisions 1–3 and the
TheOneOS source map with line numbers). This spec does not repeat the research; it fixes
what gets built.

## 1. Purpose and success

Watchtower gains TheOne's AI Usage Profile: ten discipline scores (0–60 each, 600 total),
the 6-tier ladder, TheOne's 3-tier Matrix tier, and week-over-week movement. It serves three
purposes at once (decision 1): it is a **port** of TheOne's formulas wherever Watchtower has
the same input, a **coaching** view that never shows a score without the measurement behind
it, and a **tier** tracker.

Success means:

1. For every day with enough data, `rollup.sh` stores all ten discipline scores, the total,
   the tier, the Matrix score and tier, and both week-over-week deltas.
2. On a live DB copy, the eight ported disciplines and the Matrix score match TheOne's own
   pure functions fed the same inputs (the lockstep proof, §7).
3. The Usage Profile page renders under all five themes and in `watchtower report`, with
   every score showing its evidence.
4. Every existing guard still holds, and every new guard has had its defect planted and
   turned exactly one test red.

## 2. Decisions (do not re-ask)

| # | Decision |
|---|---|
| 1 | All three of port / coaching / tiers (see §1). |
| 2 | Automation and security use **Watchtower definitions** (§4.4), labelled as such on the page. All ten are measured; 600 is reachable. |
| 3 | Stage 4 splits in two. **4A (this spec):** capture of tool calls and slash commands, the scores, the page. **4B (later):** latency, tok/s, pricing, cost by model, the `$0.00` Projects fix and `peakctx`. |
| 4 | Capture goes in the existing ingest pass under the same cursor; two new durable tables; one backfill. (Approved design §1.) |
| 5 | Scores are a rolling 30-day window computed for every day, in `rollup.sh`; week over week is a difference of stored days. (Approved design §2.) |
| 6 | A new Usage Profile page replaces the "Stage 4" placeholder pill. (Approved design §3.) |

## 3. Capture — `capture/ingest.sh`, `capture/lib.sh`, schema v5

### 3.1 What ingest reads now

Today one `grep '"usage"'` keeps only assistant lines with token usage. It widens to also
keep lines containing `"tool_result"` or `<command-name>`. There is still **one** read of
each file per run, from the same cursor offset, so the cursor stays advisory and nothing is
read twice.

One `jq` program emits tagged rows (`R` request, `T` tool use, `E` tool result, `S` slash
command); the rows are split by tag into three TSVs and loaded in the **same transaction** as
the request upsert and the cursor writes, so a failed load loses nothing (the Stage 3B cursor
fix holds for the new tables too).

Parsing rules:

- **Tool use** — assistant entries, each `message.content[]` block with `type == "tool_use"`:
  `id`, `name`, the entry's `requestId`, `sessionId`, `timestamp` (seconds), `isSidechain`.
- **Tool result** — user entries, each content block with `type == "tool_result"`:
  `tool_use_id`, `is_error == true` → 1, else 0.
- **Slash command** — `type == "user"` entries whose `message.content` is a **string**
  matching `<command-name>\s*(/[^<\s]+)` (TheOne's `SLASH_RE`, `transcript.ts:40`). Only the
  first match per entry. Attachment and system lines that merely contain the text
  `<command-name>` (e.g. a prompt snapshot) are ignored — they are not `user` string entries.
- **MCP server** — for a tool name starting `mcp__`, the text between `mcp__` and the next
  `__` (TheOne's rule, `transcript.ts:24-34`).

### 3.2 New durable tables

Durable like `claude_requests`: never rebuilt from the filesystem, because transcripts can be
deleted.

```sql
CREATE TABLE IF NOT EXISTS claude_tool_calls (
  tool_use_id  TEXT PRIMARY KEY,
  request_id   TEXT,              -- NULL until the tool_use side is seen
  session_id   TEXT,
  ts           INTEGER,           -- unix seconds of the tool_use entry
  tool_name    TEXT,              -- NULL until the tool_use side is seen
  mcp_server   TEXT,              -- NULL unless tool_name is mcp__*
  is_error     INTEGER,           -- NULL until the tool_result is seen; then 0/1
  is_sidechain INTEGER
);
CREATE TABLE IF NOT EXISTS claude_slash_commands (
  entry_uuid   TEXT PRIMARY KEY,
  session_id   TEXT,
  ts           INTEGER,
  command      TEXT NOT NULL      -- e.g. "/compact"
);
```

A tool use and its result can land in different ingest runs (the result is written after the
tool finishes). Both sides upsert into the same row, and the merge is **commutative and
idempotent**, like the token `MAX`:

- `tool_name`, `request_id`, `session_id`, `mcp_server`: `COALESCE(existing, excluded)`.
- `ts`: the smaller non-NULL value. `is_sidechain`: the smaller non-NULL value.
- `is_error`: NULL-aware max — NULL if both NULL, else the max of the non-NULL values.

`claude_slash_commands` uses `INSERT OR IGNORE` on `entry_uuid`.

### 3.3 Schema version and backfill

- `CC_SCHEMA_VERSION` (`capture/lib.sh`) and `schemaVersion` (`lib/config.ts`) both go 4 → 5.
  The pinning test covers them. The new `CREATE TABLE IF NOT EXISTS` statements go in the
  existing schema block; no `ALTER` is needed.
- Files already read to the end have a cursor at EOF, so their tool calls and slash commands
  are never seen by a normal run. **Rollout requires one `watchtower-ingest.sh --backfill`**.
  It re-reads every transcript; the request upsert is `MAX`-based, so re-reading is harmless.
  Its runtime on the live copy is measured in the plan and recorded.
- **Coverage.** Transcripts on disk start 2026-08-12, so tool and slash data do too.
  `coverage_start` = the local day of `MIN(ts)` over `claude_tool_calls` rows with
  `is_sidechain = 0`. A 30-day window is *tool-covered* only if its first day is on or after
  `coverage_start` (first covered day on current data: 2026-09-10).

## 4. Scoring — `capture/rollup.sh`

All scoring lives in `rollup.sh`. TypeScript reads and formats only; a guard test (§6) fails
the build if the scoring thresholds appear under `lib/`.

### 4.1 The window and the gate

For each local day `D` from the first request day through today, the window `W(D)` is every
`claude_requests` row whose local day is in `[D−29, D]` (30 calendar days, matching TheOne's
`now − 30 days`).

- **Gate:** fewer than 20 requests in `W(D)` → the day's profile row is stored with every
  score NULL ("collecting"). This is TheOne's `MIN_PROFILE_RECORDS = 20`.
- **Which rows:** request-based inputs use **all** requests in the window, sidechain
  included, because TheOne's proxy saw every API call. Tool and slash inputs use
  **main-thread rows only** (`is_sidechain = 0`), because TheOne reads only top-level
  transcript files (`store.ts`, non-recursive `readdirSync`).
- **Sessions:** requests are grouped by `session_id`; rows with an empty `session_id` are
  left out of session statistics (TheOne's "unattributed" bucket), but still count in the
  token totals, model mix and success rate.

### 4.2 Helpers (TheOne's, exactly)

- `H(v, lo, hi)` — higher is better: `v ≤ lo → 0`, `v ≥ hi → 100`, else
  `round(100·(v−lo)/(hi−lo))`.
- `L(v, good, bad)` — lower is better: `v ≤ good → 100`, `v ≥ bad → 0`, else
  `round(100·(1 − (v−good)/(bad−good)))`.
- `clamp(v)` to `[0, 100]`. `avg(parts)` = unrounded mean of the **defined** parts.
- A discipline's 0–60 score = `clamp(round(score100/100·60), 0, 60)`. A discipline with no
  defined part is **needs-data**: it scores 0, and its status says so.
- SQLite `round()` and JavaScript `Math.round` agree on non-negative values, which is all
  this needs.

### 4.3 The Matrix score (TheOne's 4-factor hygiene) and tier

Per session `s` in `W(D)`: `n` requests, `span` = last `ts` − first `ts`,
`ctx = Σ cache_read / n`, and `reset` = there is a request (ordered by `ts`, then
`request_id`) with `cache_read > 0` whose running maximum of **earlier** `cache_read` values
in that session is above 80,000 and more than twice its `cache_read`. That is exactly
"at least one" of TheOne's `detectContextResets`, because the peak equals the running max
until the first reset.

| Factor | Formula |
|---|---|
| context | `L(median ctx, 60000, 350000)` |
| compaction | long sessions = `n ≥ 30` or `span ≥ 2700 s`; none → 90, else `round(100 · long_with_reset / long)` |
| sessionLength | `L(median n, 40, 250)` |
| efficiency | `L(Σ cache_read / Σ(input + output), 10, 45)`; the ratio is 0 when the denominator is 0 |

`matrix_score = round(0.30·context + 0.25·compaction + 0.20·sessionLength + 0.25·efficiency)`.
Tier: `≥ 75` The One (2), `≥ 45` Operator (1), else Coppertop (0). Points to next tier:
`45 − score` or `75 − score`, NULL at The One.

### 4.4 The ten disciplines

"Tool-covered" inputs (†) are undefined when `W(D)` is not tool-covered (§3.3).

| # | Discipline | Parts (each 0–100; the discipline is their mean) | Source |
|---|---|---|---|
| 1 | Prompt hygiene | `clamp(slash_kinds × 20)` † | distinct `command` in `claude_slash_commands`, window, main thread |
| 2 | Context hygiene | Matrix `context` factor | `claude_requests` |
| 3 | Session hygiene | Matrix `sessionLength`; Matrix `compaction`; `clamp(compactions × 20)` | `claude_requests`; `PreCompact` rows in `claude_events` in the window |
| 4 | Model routing | `clamp((models − 1) × 45)`; `H(1 − top_pct/100, 0, 0.35)` | distinct `model` in the window excluding `<synthetic>` and empty; `top_pct` = the top model's share of requests as a **rounded integer percent** (TheOne's `modelMix[0].pct`) |
| 5 | Cost discipline | Matrix `efficiency` factor | `claude_requests`. Evidence also shows cost/session from `MAX(total_cost_usd)` per session, sessions with a reading only |
| 6 | Verification | `H(inspect_share, 0.1, 0.5)` †, defined when tool calls > 0; `L(tool_error_rate, 0.05, 0.4)` †, defined when tool calls > 0 | `claude_tool_calls`, main thread, `tool_name` not NULL; inspect = `Read`, `Grep`, `Glob`; errors = `is_error = 1` |
| 7 | Automation — **Watchtower definition** | `clamp(runs × 20)`; `mcp_calls > 0 ? clamp(20 + 2 × mcp_calls) : 0` † | runs = distinct sessions in the window with `entrypoint` starting `sdk-` (headless; live data has `sdk-cli` and `sdk-ts`) **plus** main-thread tool calls named `Task` or `Agent` (subagent launches) †; `mcp_calls` = main-thread tool calls named `mcp__*` |
| 8 | Reuse | `H(slash_max_repeat, 1, 8)` †; `clamp(mcp_servers × 33)` † | `claude_slash_commands`; distinct `mcp_server` over main-thread tool calls. TheOne's third part (saved audits) is a TheOne coach feature and is not applicable; TheOne itself averages only the parts it has |
| 9 | Security — **Watchtower definition** | `L(bypass_share, 0.02, 0.25)` | `UserPromptSubmit` rows in `claude_events` in the window whose payload has `permission_mode`; `bypass_share` = the share with `bypassPermissions`. Undefined when no such row |
| 10 | Output quality | `H(success, 0.9, 1)`; `L(tool_error_rate, 0.05, 0.4)` † as in #6 | success = 1 − share of requests with a non-empty `api_error_status` |

Deliberate departures from TheOne, all in the honest direction:

- **No-tool-calls rate.** TheOne sets the tool-error rate to 0 when there were no tool calls,
  which scores 100. Here it is undefined. Only affects a window with zero tool calls.
- **Inspection share over all tools**, not TheOne's top-8 list. Read, Grep and Glob are always
  in the top 8 in practice, so the number is the same.
- **Real compactions** come from `PreCompact` hook events rather than transcript
  `compact_boundary` lines. Both fire once per manual or auto compaction.
- **Automation's runs and security** are new definitions (decision 2); the page badges them.
  The thresholds for security (`0.02` good, `0.25` bad) are Watchtower's own and are open to
  change at spec review.

Status per discipline (TheOne's `statusFor`): needs-data, else `≥ 45` strong, `≥ 30` ok,
else needs-work.

### 4.5 Total, ladder, week over week

- `total = Σ` the ten 0–60 scores (needs-data counts 0, as in TheOne). `measured` = how many
  of the ten are not needs-data; the page shows "8 of 10 measured" whenever it is below 10.
- Tier index = `min(5, floor(total / 100))`: Noobie, Explorer, Practitioner, Operator,
  Architect, Master. Points to next = `(index + 1) × 100 − total`, NULL at Master.
- **Total week over week** (new, not in TheOne): `total(D) − total(D−7)`, NULL if either is
  NULL.
- **Matrix week over week** (TheOne's `buildTrend`): the Matrix score computed over the 7 days
  ending `D`, minus the same over the 7 days before that. NULL when either week has no
  requests — TheOne's `weekSnapshot` returns null only on zero rows (`profile.ts:453-454`);
  it applies no 20-request gate to a week, and neither does this.

### 4.6 Regenerable output tables

Rebuilt with `DELETE` + `INSERT` in the rollup's existing `BEGIN IMMEDIATE … COMMIT`.

```sql
CREATE TABLE IF NOT EXISTS claude_profile_daily (
  day TEXT PRIMARY KEY,
  window_requests INTEGER NOT NULL,
  tool_covered INTEGER NOT NULL,          -- 0/1
  total INTEGER, measured INTEGER, tier_index INTEGER, tier_points_to_next INTEGER,
  total_wow INTEGER,
  matrix_score INTEGER, matrix_tier INTEGER, matrix_points_to_next INTEGER,
  f_context INTEGER, f_compaction INTEGER, f_session_length INTEGER, f_efficiency INTEGER,
  median_ctx REAL, median_requests REAL, long_sessions INTEGER, long_with_reset INTEGER,
  cache_fresh_ratio REAL,
  matrix_7d INTEGER, matrix_wow INTEGER
);
CREATE TABLE IF NOT EXISTS claude_discipline_scores (
  day TEXT NOT NULL,
  discipline TEXT NOT NULL,               -- 'prompt-hygiene', … TheOne's ids
  score INTEGER NOT NULL,                 -- 0–60; 0 when needs-data
  status TEXT NOT NULL,                   -- needs-data | needs-work | ok | strong
  definition TEXT NOT NULL,               -- 'theone' | 'watchtower'
  evidence_json TEXT NOT NULL,            -- raw numbers only, e.g. {"slash_kinds":4}
  PRIMARY KEY (day, discipline)
);
```

Evidence is **numbers, not sentences**. TypeScript turns `{"inspect_share":0.34}` into
"34% of tool calls inspect code". Wording is labelling; the number is the model's.

A gated day (`< 20` requests) has a `claude_profile_daily` row with NULL scores and no
`claude_discipline_scores` rows.

## 5. The page — `/profile`

- `lib/read/profile.ts` reads the two tables (latest day plus history). `lib/render/profile.ts`
  renders. The "Stage 4" placeholder pill becomes "Usage Profile", linked.
- **Content, top to bottom:**
  1. The ladder card: tier name and description, total `/600`, points to the next tier, total
     week over week, and "N of 10 measured" when N < 10.
  2. The Matrix card: Coppertop / Operator / The One, score `/100`, points to next, the four
     factors with their raw inputs, and its week over week.
  3. Ten discipline cards: a 0–60 bar, status, evidence lines, and a "Watchtower definition"
     badge on automation and security. A needs-data card says what is missing (for example
     "tool data starts 2026-08-12").
  4. The total over time, using the existing area-chart primitive. The line breaks on gated
     days, never plotting 0.
- Tier descriptions and discipline blurbs are TheOne's copy, held in `lib/render/profile.ts`
  as labels.
- Included in `watchtower report`. The 1 MB-per-year report budget test is extended to cover
  it.
- All five themes; existing primitives only; no new chart types.

## 6. Tests and guards

The convention holds: real bash scripts against fixture DBs and fixture transcripts, and every
guard's defect planted until exactly one test turns red.

- **Ingest:** a tool use and its result in separate runs merge into one row; running the two
  fixtures in the opposite order gives an identical table; replaying a file changes nothing; a
  sidechain tool call is flagged; a prompt-snapshot attachment containing `<command-name>`
  adds no slash command (plant: match attachments → red); a corrupt line still drops only
  itself.
- **Rollup, per discipline:** a fixture with hand-computed expected values for every part, the
  gate (19 vs 20 requests), tool-coverage gating, needs-data scoring 0, the reset rule
  (a drop below half of a peak above 80k counts; one below half of a 70k peak does not), and
  both week-over-week rules.
- **Reconciliation:** each discipline's evidence numbers recompute from raw tables in the test
  (no shared helper with the rollup).
- **Guards:** no scoring threshold (`350000`, `0.35`, `2700`, …) appears under `lib/`; the
  schema-version pin at 5; the new durable tables appear in the durable list of the install
  and schema tests.
- **Render:** every theme, the needs-data card, the Watchtower badge, the broken line on a
  gated day.

## 7. Lockstep and rollout

- **TheOneOS lockstep:** TheOneOS's `claude-hours` reads raw tables and ignores rollups; this
  stage adds tables and changes none it reads. No change there.
- **Numeric proof against TheOne:** on a live DB copy, compute TheOne's inputs from the same
  window and run TheOne's own pure `computeHygieneScore` and `calculateUsageProfile` on them.
  The Matrix score and disciplines 1–6, 8 and 10 must match the rollup exactly. Recorded in the
  ledger.
- **Performance:** the rollup's added runtime and the backfill's runtime are measured on the
  live copy and recorded. The rollup runs in the background at `SessionEnd`, so the limit is
  "seconds, not minutes".
- **Rollout, by the user:** dry-run `install.sh` into a temp `CLAUDE_DIR`, then the live
  install, then `~/.claude/watchtower-ingest.sh --backfill`, then `~/.claude/claude-usage-rollup.sh`.

## 8. Not in 4A

Latency and tok/s; pricing and cost by model; the 5m/1h cache-write split; the `$0.00`
Projects fix; `peakctx` (all 4B). TheOne's thinking-ratio part (TheOne never fills it either).
Permission prompts (no `Notification` hook is registered). Any change to TheOneOS. The
`coach` stanza stays unimplemented.
