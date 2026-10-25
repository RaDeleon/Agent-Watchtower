# Stage 2 — Per-request token tracking

**Date:** 2026-09-11
**Status:** Approved in brainstorming (2026-09-11), specified here, pending implementation plan
**Spec it extends:** `docs/superpowers/specs/2026-09-10-stage-1.5-per-project.md`
**Stage it follows:** Stage 1.5 (merged PR #2, installed and backfilled 2026-09-10)
**Stages deliberately deferred behind it:** dashboard (Stage 3), proxy (Stage 4)

Stage 1 answered "how many hours?" Stage 1.5 answered "into what?" Stage 2
answers **"at what cost, and to which request?"** — one durable row per Claude
API request, with exact token counts, and per-request attribution to the skill,
MCP server, MCP tool or plugin that caused it.

Every figure here was measured against the live transcript corpus and capture DB
on 2026-09-11 (517 transcript files, 724 MB, ~26,270 distinct requests; DB at
2,506 sessions, 9,506 events). Both keep growing — **re-measure rather than
quoting these back.**

---

## 1. Purpose and scope

### What it is

A `claude_requests` table holding one row per Claude API request, ingested from
the transcripts Claude Code already writes to `~/.claude/projects/**/*.jsonl`.
Per request: exact input / output / cache-read / cache-creation tokens, model,
effort, service tier, cwd, git branch, subagent flag, entrypoint, API error
status, and attribution to skill / MCP server / MCP tool / plugin.

It also **corrects** `claude_daily_rollups.tokens_*` and
`cache_hit_percentage`, which are currently wrong by 63–201× (§2).

### What it is not

- **Not a proxy.** Nothing enters the request path. See §11 for what that costs
  us and why it is a separate stage.
- **Not a cost model.** `cost_usd` keeps coming from the status line's
  cumulative figure. Deriving cost from tokens needs a per-model price table
  that goes stale and would trip the guard test in
  `tests/capture-scripts.test.ts` that fails the build when a model constant
  appears outside `rollup.sh`. See §6.3.
- **Not latency tracking.** Transcripts carry `timestamp` and no duration of any
  kind. Per-request latency and TTFT are measurable only in the request path,
  which is Stage 4's whole justification.
- **Not a dashboard.** Stage 3.
- **Not the pre-install activity backfill.** `~/.claude/history.jsonl` reaches
  back to 2025-10-07 (3,909 prompts, 110 active days) but carries no tokens.
  That is an activity-hours job with a different source and its own spec.

---

## 2. The problem: the token columns are wrong by 63–201×

### 2.1 Where the wrong number comes from

`capture/snapshot.sh:64` reads:

```
.context_window.current_usage.input_tokens // .usage.input_tokens
```

That is **current context-window occupancy**, not cumulative usage. `rollup.sh`
then takes the *last* snapshot per session (`_snap`, `ROW_NUMBER() … ORDER BY ts
DESC` at `rollup.sh:335-345`) and sums those across sessions. So
`tokens_in` is "how full the context was when the session ended, added up" — a
quantity with no useful interpretation.

`TheOneOS/lib/claude-hours/hours.ts:66-97` independently recomputes the same
broken figure from the same table, and `types.ts:98` already documents the flaw
in words: *"context-snapshot figures, not API throughput."*

### 2.2 What the right number is

| | Watchtower DB today | Transcript truth | Ratio |
|---|---|---|---|
| `tokens_in` | 68,756 | **4,301,735** | 63× |
| `tokens_out` | 128,410 | **25,838,336** | 201× |
| `tokens_cache_read` | 32,103,993 | **5,647,583,914** | 176× |
| `tokens_cache_creation` | 1,297,912 | **105,492,461** | 81× |
| `cache_hit_percentage` | **79.40%** avg, with **12 of 69 days at exactly 0.0** | **98.17%** | — |

The twelve zero-days are the proof that this is a defect and not a difference of
definition.

### 2.3 The duplication that makes the dedup rule load-bearing

The corpus holds **49,774 usage-bearing rows but only ~26,270 distinct
`requestId`s.** Summing rows rather than requests inflates output tokens from
25.8M to 52.4M — a 103% overcount.

Of the 16,100 `requestId`s appearing more than once:

- **13,981 carry identical usage** in every copy. Harmless; any dedup rule works.
- **2,119 differ**, and in **2,115 of those `output_tokens` grows monotonically**
  across copies. These are streaming partials.
- **168 appear in more than one file** — the same request recorded in both a
  parent transcript and a subagent transcript, sometimes with a different
  `isSidechain` value and a partial token count.

**Therefore first-seen-wins undercounts and must not be used.** The rule is
`MAX` per field per `requestId` (§4.2). A worked example, six of nine copies of
one request:

```
in=2 out=3597 cr=96527 cc=1974 sidechain=False   <- five copies like this
in=2 out=   3 cr=96527 cc=1974 sidechain=True    <- one partial, subagent file
```

`MAX` yields 3,597. First-seen yields whichever the filesystem happened to hand
us first.

---

## 3. The source: what transcripts actually carry

### 3.1 Fields

Per assistant message with a `usage` block:

```
requestId  messageId(message.id)  sessionId  timestamp
cwd  gitBranch  model  effort  entrypoint  version  isSidechain
usage: input_tokens  output_tokens  cache_read_input_tokens
       cache_creation_input_tokens  cache_creation{…}  service_tier
       server_tool_use  iterations  output_tokens_details
attributionSkill  attributionMcpServer  attributionMcpTool  attributionPlugin
apiErrorStatus  isApiErrorMessage  quotaLimits
```

`sessionId` joins `claude_sessions`. `cwd` resolves through the Stage 1.5
`claude_project_paths` cache. This is strictly **richer than a proxy would see**
— a proxy has no `cwd`, no `gitBranch`, and no way to know which requests were
subagents.

### 3.2 The attribution finding — this reverses a recorded decision

The 2026-09-08 decisions in `SESSION.md` state:

> **Tool/skill/MCP tracking: declined for now.** Nothing captures it — zero event
> payloads mention tools, skills or MCP. It needs a `PreToolUse` hook firing on
> every tool call (est. 3–7× the current 8,448 events, plus a process spawn per
> call) and **cannot be backfilled.**

**That is false, and this spec reverses it on the record.** The attribution is
already in the transcripts, is already historical, and needs no new hook and no
process spawn per tool call. Measured on the deduplicated request set:

| Signal | Requests | Share |
|---|---|---|
| `attributionSkill` | 3,283 | 12.5% |
| `attributionMcpServer` / `attributionMcpTool` | 3,473 | 13.2% |
| `attributionPlugin` | 2,098 | 8.0% |
| `isSidechain` (subagent) | 3,103 | 11.8% |
| `apiErrorStatus` | 24 | — |
| `quotaLimits` (rate-limit rejections) | 21 | — |

With tokens attached, so the join is immediately useful:

```
superpowers:executing-plans     659 req    588,173 output tokens
superpowers:brainstorming       623 req    662,352 output tokens
claude-in-chrome (MCP)        2,186 req  1,636,172 output tokens
browseros-neo (MCP)             753 req    566,065 output tokens
```

To be fair to the original ruling: its cost estimate — "3–7× the current
8,448 events, plus a process spawn per call" — was a *correct* estimate for the
approach it considered, a `PreToolUse` hook. The error was narrower and entirely
forgivable: concluding that because no *event payload* carried the signal,
nothing captured it. The transcripts were never examined. There is no new
capture path to build, and therefore no cost to weigh.

### 3.3 Transcripts decay, so the table must be durable

Claude Code deletes transcripts after `cleanupPeriodDays`, default 30. The
setting was **unset** on this machine until 2026-09-11.

Coverage today: **2026-06-13 → 2026-09-11, 58 distinct days, 8 of them before
the tracker existed** (the DB starts 2026-07-04).

Two protective actions were taken on 2026-09-11, before this spec was written:

- `cleanupPeriodDays: 3650` written to `~/.claude/settings.json` (backup:
  `~/.claude/backups/settings.json.20260911-161942`; a semantic diff proved only
  that key changed, with all 11 hook groups and the status line intact).
- `~/.theone/transcripts-archive-20260911.tar.gz` — 287 MB, 517/517 `.jsonl`
  files verified present, with a README recording provenance.

**This is the same reasoning Stage 1.5 used for `claude_project_paths`:** a
cached answer must survive the thing it was derived from. `claude_requests` is
the durable store; transcripts are a disposable input. Once a request is
recorded, cleanup cannot touch it.

---

## 4. Design

### 4.1 `claude_requests` — the durable request log

One row per `requestId`. Never rebuilt, never `DELETE`d wholesale — unlike
`claude_daily_rollups` and `claude_project_rollups`, which `rollup.sh`
reconstructs from scratch on every run. **This asymmetry is the point.** A
rebuild-from-filesystem design would zero the token history the day cleanup ran.

**No `project_path` column.** Stage 1.5's own deferred-items list records
`claude_events.project_path` as *"written by nothing that reads it"* — a dead
column produced by a spec omission. This spec does not mint a second one. Store
`cwd`; resolve through `claude_project_paths` at rollup time.

### 4.2 The `MAX` upsert, and why the cursor is advisory

```sql
INSERT INTO claude_requests (request_id, …) SELECT … FROM _incoming
ON CONFLICT(request_id) DO UPDATE SET
  tokens_in             = MAX(tokens_in,             excluded.tokens_in),
  tokens_out            = MAX(tokens_out,            excluded.tokens_out),
  tokens_cache_read     = MAX(tokens_cache_read,     excluded.tokens_cache_read),
  tokens_cache_creation = MAX(tokens_cache_creation, excluded.tokens_cache_creation),
  is_sidechain          = MIN(is_sidechain,          excluded.is_sidechain),
  attribution_skill     = COALESCE(attribution_skill,     excluded.attribution_skill),
  attribution_mcp_server= COALESCE(attribution_mcp_server, excluded.attribution_mcp_server),
  attribution_mcp_tool  = COALESCE(attribution_mcp_tool,  excluded.attribution_mcp_tool),
  attribution_plugin    = COALESCE(attribution_plugin,    excluded.attribution_plugin),
  api_error_status      = COALESCE(api_error_status,      excluded.api_error_status);
```

`MAX` on token fields is **order-independent, commutative and idempotent.** Three
properties follow, and they are the reason this design is safe on a hook path:

1. Re-ingesting any file, in any order, any number of times, converges on the
   same numbers.
2. **The cursor is a speed optimization, never a correctness dependency.** Delete
   `claude_ingest_cursor` and the next run re-reads the corpus and produces
   identical results, more slowly.
3. A partially-written row is corrected upward by the next run rather than
   being wrong forever.

`is_sidechain` takes `MIN` — main-chain wins — because of the 168 requests
recorded in both a parent and a subagent transcript (§2.3). Attribution fields
take `COALESCE`: a copy that knows the skill beats a copy that does not, and the
first non-null answer is kept.

The identity fields not listed in the upsert — `ts`, `cwd`, `git_branch`,
`model`, `effort`, `service_tier`, `session_id`, `message_id`, `entrypoint`,
`cc_version` — **keep their first-seen value deliberately.** They describe the
request itself, which does not change as it streams, so re-writing them would
be churn with no information gain. The one case where copies genuinely disagree
is `isSidechain`, which is why it is the one that gets a rule.

### 4.3 `capture/ingest.sh`

New script, installed by `capture/install.sh` alongside the existing four.

1. Walk `$CLAUDE_DIR/projects/**/*.jsonl`, **including `subagents/`** — subagent
   requests are real token spend.
2. Per file, compare `(size, mtime)` against `claude_ingest_cursor`. Unchanged →
   skip. Grown → read from `bytes_read`. Shrunk or `mtime` moved backwards →
   re-read whole (a rewritten file).
3. `grep '"usage"'` prefilter. This is what makes it fast: it discards the large
   majority of lines before `jq` parses anything.
4. `jq` emits one TSV row per usage-bearing line.
5. Bulk load: TSV → temp file → `sqlite3 .mode tabs` + `.import` into
   `_incoming` → the single upsert in §4.2. **Not** per-row `INSERT`s; the
   backfill is ~26k rows.
6. Advance the cursor per file, after that file's rows commit.

**`jq`, not `python3`.** Measured on the full corpus: `jq` 3.5s, `python3` 1.4s.
`python3` is 2.5× faster and would be a **new dependency** in a project whose
entire external surface is `git`, `sqlite3`, `jq`, `awk`, `bc`. The 3.5s figure
is the one-time backfill; steady state is one changed file, where the difference
is unmeasurable. Dependency discipline wins.

Modes: default incremental, `--backfill` (ignore cursors, sweep everything),
`--quiet` (hook path, say nothing).

### 4.4 Where it runs in the hook chain

Chained on `SessionEnd`, **after `hook.sh` and before `rollup.sh`** — the rollup
must see the session's fresh rows in the same run that records its end.

`install.sh`'s `$sessionEnd` command becomes a three-step chain. Note the
existing hazard this inherits: `install.sh` dedupes hook commands **by exact
string equality**, so changing the `SessionEnd` command string means the old
two-step chain will not be recognised as ours and would be left in place
alongside the new one. The installer must remove the prior spelling explicitly.
This is the deferred `install.sh` item in `SESSION.md` becoming load-bearing, and
it needs the test that item always demanded: a near-miss spelling that must NOT
be deleted.

### 4.5 Seeding `claude_project_paths` — closes a Stage 1.5 deferral

`SESSION.md` records:

> `claude_events.project_path` is written by nothing that reads it. […] Seeding
> it is the first Stage 2 item; it also fixes the one concrete harm, a cwd that
> vanishes before its turn under the per-run cap being cached `gone` even though
> its correct toplevel already sits on its events.

`ingest.sh` surfaces cwds the event stream never saw — notably from the 8
pre-install days. The resolver's input becomes the **union** of distinct cwds in
`claude_events` and `claude_requests`. The per-run cap (`WATCHTOWER_RESOLVE_PER_RUN`,
default 20) still applies on the hook path; `--backfill` resolves without it, the
way `rollup.sh --resolve` already does.

---

## 5. Schema v4

```sql
CREATE TABLE IF NOT EXISTS claude_requests (
  request_id             TEXT PRIMARY KEY,
  message_id             TEXT,
  session_id             TEXT,
  ts                     INTEGER,          -- unix seconds, from ISO timestamp
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

CREATE TABLE IF NOT EXISTS claude_ingest_cursor (
  file_path  TEXT PRIMARY KEY,
  bytes_read INTEGER,
  mtime      INTEGER,
  updated_at INTEGER
);
```

**`CC_SCHEMA_VERSION` 3 → 4 is mandatory, not cosmetic.** `capture/lib.sh:244`
carries the warning in full: Stage 1.5 added two tables under an unchanged
version 2, the marker short-circuited `cc_init_db`'s fast path, the tables never
arrived, and `rollup.sh` then aborted its whole transaction under `.bail on` —
`--quiet`, from a hook, at exit 1, with daily tracking going stale in silence.
New tables need no `ALTER` (the `CREATE TABLE IF NOT EXISTS` covers them) but
they do need the version bump.

Sizing: ~26k rows today, ~500/day, well under 25 MB at present growth. No
retention rule — the table is the durable record, and pruning it would recreate
exactly the decay problem §3.3 exists to prevent.

---

## 6. What changes in `rollup.sh`

### 6.1 Tokens are grouped by day, NOT routed through sessions

The obvious design — aggregate `claude_requests` per session and join into `_sx`
— is wrong, and wrong in a way that would have passed every test.

`_sx` is built `FROM claude_sessions`. **22.4% of requests (5,878) and 22.7% of
output tokens (5,870,459) belong to session ids with no row in
`claude_sessions`** — every day from 2026-06-13 to 2026-07-04, which is the
pre-install period the transcripts uniquely cover (§3.3). Joining through
sessions drops all of it. Worse, **the reconciliation identity would still
pass**, because the daily and per-project sides would omit it equally. A green
suite would have certified a 22.7% shortfall.

So tokens stop being a session-level scalar:

- `claude_daily_rollups.tokens_*` ← `SUM` over `claude_requests`
  **`GROUP BY day(ts)`**, joined onto the daily row by day.
- `claude_project_rollups.tokens_*` ← `SUM` over `claude_requests`
  **`GROUP BY project_key, day(ts)`**, where `project_key` resolves from the
  request's own `cwd`.

Neither path touches `claude_sessions`, so an orphan request is attributed
normally — it has its own `ts` and its own `cwd`, which is everything needed.
The four `COALESCE(sn.…)` token columns at `rollup.sh:371-374` are **removed
from `_sx` entirely** rather than repointed. `_snap` stays, for `effort` and
`thinking_enabled` only.

**Declared divergence in the day rule.** Sessions crossing midnight book
entirely to their start day — a deliberate Stage 1 decision with a
`crosses-midnight` fixture pinning it. Requests book to **their own** day.
Therefore on a midnight-crossing day, hours and tokens use different calendars.
This is accepted deliberately: a request has a true timestamp, and forcing it
onto its session's start day would be laundering model math through an
attribution rule — and would not work for orphans anyway. It must be stated
wherever both figures appear together.

**New rows appear.** `claude_daily_rollups` currently starts at 2026-07-04 (69
rows) because days come from sessions. Day-grouped tokens add the 8 pre-install
days (2026-06-13, 06-27 … 07-03), taking it to **77 rows**, each with
`sessions_count = 0`, `active_ms = 0` and non-zero tokens. Lifetime hours and
rank are untouched by construction.

**Consequent guard: hygiene must be zero on session-less days.** `hygiene_score`
is a behavioural score built from cache efficiency, context discipline,
compact-vs-clear and idle ratio — three of its four terms are meaningless
without a session. Left alone, those 8 new days would each score on the
cache-efficiency term alone and pollute
`claude_rank_progress.hygiene_score`, which is
`AVG(NULLIF(hygiene_score,0))` across days (`rollup.sh:532`). Set
`hygiene_score = 0` where `sessions_count = 0`; the existing `NULLIF` then
excludes them from the lifetime average with no new logic.

### 6.2 Per-project tokens attribute directly

Today, session-level scalars go whole to the dominant project via the `is_dom`
flag, because a session's token count could not be split. **Every request
carries its own `cwd`, so tokens now attribute directly** — per request, per
project, no dominance rule and no time-splitting.

The reconciliation identity still holds unconditionally, and now for a stronger
reason: the daily and per-project token figures are the same `SUM` over the same
table differing by one `GROUP BY` key, so they are equal by construction rather
than by careful arithmetic.

But **the identity test's token columns change meaning and must be rewritten,
not merely re-run.** `SESSION.md` records that the previous version of this test
was named "across every key" while checking 4 of 13 columns, and was then
*vacuous* on 9 of them because every fixture had zeros on both sides. Stage 2
fixtures must carry non-zero, non-equal token values across at least two
projects **and at least one orphan request**, or the test proves nothing again.

### 6.3 Cost stays on the status line

`_cost` is unchanged. `.cost.total_cost_usd` is genuinely cumulative per session,
`MAX` per session is its final value, and lifetime cost is already
correct. Per-request cost needs a per-model price table which (a) goes stale
every time pricing changes, (b) must handle cache-read and cache-write tiers
separately, and (c) would trip the guard test that fails the build when a model
constant appears outside `rollup.sh`. Deferred to Stage 3 as a **read-time**
concern if wanted, where a stale table is a display bug rather than corrupted
history.

### 6.4 Declared blast radius

Stage 1.5's hard requirement was "lifetime hours and rank did not move." The
Stage 2 equivalent must be stated up front rather than discovered:

| Quantity | Expected change |
|---|---|
| `active_ms`, `window_ms`, `idle_ms`, lifetime hours | **exactly zero** |
| `rank_index`, `rank_name`, `hours_into_rank` | **exactly zero** |
| `sessions_count`, `prompts`, `compacts`, `clears`, `subagents` | **exactly zero** |
| `cost_usd` | **exactly zero** |
| `tokens_*` | corrected, 63–201× larger |
| `cache_hit_percentage` | 79.40% → 98.17% |
| `hygiene_score`, days with sessions | **+4.69** (`cache_hit_percentage × 0.25`) |
| `hygiene_score`, the 8 new session-less days | **forced to 0** (§6.1) |
| `xp` | **+23.4** (`hygiene × 5`) |
| `claude_daily_rollups` row count | **69 → 77** (8 pre-install days gain token-only rows) |
| earliest tracked day | **2026-07-04 → 2026-06-13** |

`xp = active_h×100 + total_h×20 + hygiene×5 + sessions×2` (`rollup.sh:556`), so
hygiene is the only path from tokens to XP. The rank ladder is hours-based and
cannot move. **Tests assert the predicted movement, not the absence of
movement** — asserting "unchanged" here would fail correctly and teach nothing.

---

## 7. The three-place lockstep

The model lives in three places and must move together. For Stage 2:

1. **`capture/rollup.sh`** — source of truth. Changed per §6.
2. **`~/.claude/claude-usage-rollup.sh`** — the installed copy. Changed by
   `install.sh`.
3. **`TheOneOS/lib/claude-hours/hours.ts`** — **must change.** Lines 66-97
   independently recompute tokens from the last snapshot per session. Leaving it
   alone means TheOneOS keeps serving the wrong figure from its own query while
   Watchtower serves the right one.

`hours.ts` should **`SUM` `claude_requests`, not recompute** — the same asymmetry
the Stage 1.5 spec argued for `projects.ts`: recomputing would create a fourth
copy of the model. A machine without v4 has no such table, so a missing table
returns zeros rather than throwing.

**It must also group by day rather than by session (§6.1).** `PER_SESSION_SQL` is
per-session by construction, so the token half cannot live inside it — an orphan
request has no session to belong to. Tokens become a second, independent query
in `hours.ts`, and the lockstep proof below continues to cover hours only,
because hours are all `PER_SESSION_SQL` still computes.

`types.ts:98`'s comment — *"context-snapshot figures, not API throughput"* — must
be deleted along with the limitation it documents. `TokenStat` gains nothing;
its numbers simply become true.

**Re-prove the lockstep numerically, per the standing hard constraint.** Extract
`PER_SESSION_SQL` from `hours.ts` with `sed` between its backticks, run it
against the same `.backup` copy the shell rollup just processed, bucket by the
same `strftime(…,'localtime')` expression, and require an exact match on hours.
The check must be numeric, not textual. Hours are untouched by this stage, which
is exactly why the proof is cheap and must not be skipped.

---

## 8. Testing

TDD. Each test written and watched failing before the code exists. Fixtures are
synthetic `.jsonl` files under `tests/fixtures/transcripts/`, built through
`fx_sql` and `cc_sqlstr` per the session-3 finding that hand-rolled quoting in
fixtures is what let the encoder bug hide.

**Never against the live DB.** `sqlite3 .backup` to a copy, `THEONE_DB_PATH` at
the copy, and **each copy in its own directory** — the `.schema-vN` marker lives
in the database's *directory*, and this bit three separate times during session 4.

The tests that carry weight:

| Test | Why it exists |
|---|---|
| Re-ingesting one file twice → identical rows and identical sums | Idempotence is the core claim |
| Same `requestId` in two files → counted once | The 168-request case |
| **Streaming partials converge to `MAX`, not first-seen** | The 2,115-request case; this is the defect that would silently undercount, so plant it and watch the test go red |
| Cursor deleted → identical numbers, more slowly | Pins "cursor is advisory" as behaviour, not a comment |
| File truncated / rewritten → re-read, no stale rows | `mtime` moving backwards |
| Malformed JSON line → skipped, ingest still exits 0, other rows land | A corrupt transcript must not stall the hook |
| Line with no `usage` → no row | Prefilter correctness |
| Subagent request → row present, `is_sidechain=1` | Subagent spend is real spend |
| Attribution captured and survives a second ingest | `COALESCE` direction |
| **A request whose `session_id` has no `claude_sessions` row still lands in both daily and per-project tokens** | §6.1 — 22.7% of output tokens; the bug a green suite would have certified |
| A day with tokens but zero sessions gets a row, `active_ms = 0`, `hygiene_score = 0` | §6.1 — and is excluded from the lifetime hygiene average |
| Reconciliation identity, per day, **non-zero and non-equal** token fixtures, including an orphan | §6.2 — the vacuous-test trap |
| Hours + rank byte-identical vs merge-base on a real `.backup` | §6.4 |
| Hygiene and XP move by the **predicted** amount | §6.4 — assert the movement |
| `bash -n` on `ingest.sh` | It must be added to the `SCRIPTS` array in `tests/capture-scripts.test.ts`; `install.sh` was once missing from it |
| Near-miss `SessionEnd` spelling is NOT deleted by the installer | §4.4 |

---

## 9. Install and migration

`install.sh` gains `ingest.sh` → `$CLAUDE_DIR/watchtower-ingest.sh` and rewrites
the `SessionEnd` chain (§4.4). Everything the existing installer guarantees still
holds: back up before writing, refuse a partial install, never touch
`statusline.sh`, leave sibling user hooks alone.

**Dry-run into a temp dir first**, seeded from the live `~/.claude` with paths
rewritten, and diff `settings.json` before and after — the procedure that
correctly predicted zero change in both prior installs. `CLAUDE_DIR` must never
be left unset during testing; it defaults to `$HOME/.claude`.

Migration: `cc_init_db` creates both tables on the first run after the version
bump. Then `ingest.sh --backfill` once. Expected cost ~3.5s against an
already-backed-up database — and per the session-5 lesson, **run the backfill
rather than trusting the throttle to catch up.** The per-run cap is sized for the
hook path, and a one-time backfill is not the hook path.

---

## 10. Implementation order

1. Schema v4 + `CC_SCHEMA_VERSION` bump, with the migration test.
2. `ingest.sh`: discovery, cursor, prefilter, `jq` → TSV.
3. The `MAX` upsert and its idempotence tests.
4. `install.sh` wiring, including the near-miss deletion test.
5. `rollup.sh`: remove the four token columns from `_sx`; add the day-grouped
   and `(project, day)`-grouped token aggregates; per-project direct
   attribution; the `hygiene_score = 0` guard for session-less days; identity
   test rewrite. **The orphan-request test (§8) is written before this step, not
   after** — it is the one that distinguishes this design from the one that
   passes while dropping 22.7% of tokens.
6. Verify against a `.backup` of the real DB: hours and rank unmoved; hygiene,
   XP, row count and earliest day moved exactly as §6.4 predicts.
7. `TheOneOS/lib/claude-hours/hours.ts` + `types.ts`, then re-prove the lockstep
   numerically.
8. Live install, dry-run first. Then `--backfill`.

Steps 1-6 are Watchtower. Step 7 is TheOneOS and needs its own branch and PR.

---

## 11. Out of scope, and what that costs us

Measured, so Stage 4 can be scoped by what is actually missing rather than by
what ccflare happens to do. After Stage 2, a proxy would add **only**:

1. **Per-request latency and TTFT.** Transcripts have no duration field.
2. **Multi-account load balancing and rate-limit failover.** There is real pain
   here: 21 requests carry `quotaLimits` with `rateLimitType: five_hour`,
   `overageStatus: rejected`, `overageDisabledReason: org_level_disabled_until`.
3. **Interception** — budget caps, model routing, blocking a request before it
   spends.
4. Raw response headers.

It would add **nothing** for tokens, cost inputs, model, effort, service tier,
cache breakdown, cwd, branch, skill/MCP/plugin attribution, subagent flag,
entrypoint, API errors or quota state at rejection. All of that is in §3.1.

What a proxy costs permanently, for the record: it becomes a single point of
failure for every machine pointed at it; it holds OAuth credentials; it must
relay streaming SSE byte-faithfully or corrupt live sessions; it owes maintenance
against every upstream API change; multi-account balancing carries ToS exposure;
and it adds a permanent "is this Claude or my proxy?" tax to every future bug.

The conclusion that follows: **Stage 4 should be a thin rate-limit-failover and
latency probe, not an analytics proxy.** Its analytics half is already obsolete.

---

## 12. Open items

- **Per-request cost** needs a price table. Deferred to Stage 3 as a read-time
  concern (§6.3). Decide there whether a stale display number is acceptable.
- **`output_tokens_details`** appears on ~12% of requests and is not captured.
  Likely reasoning-token detail. Cheap to add later; no column reserved, because
  Stage 1.5 already shipped one column nothing reads.
- **`server_tool_use` and `iterations`** are in the usage block and not captured.
  Same reasoning.
- **Multi-machine.** A second (Ubuntu) machine would produce a second, independent
  database. `ingest.sh` runs there unmodified (the only BSD-ism in the capture
  scripts, `stat -f` at `snapshot.sh:39`, already falls back to `stat -c`), but
  nothing merges two databases, so hours and rank would split. `claude_requests`
  is unusually well-suited to a merge — `requestId` is globally unique and the
  upsert is commutative — which makes Stage 2 a good foundation for that work and
  no part of it.
- **`WatchtowerConfig.schemaVersion`** is user-overridable, read by nothing, and
  now goes stale at 3 while the code says 4. Drop it from the example config or
  from the config surface. Deliberate change, not a fix-round afterthought —
  carried over from Stage 1.5's deferred list and now actively misleading.
