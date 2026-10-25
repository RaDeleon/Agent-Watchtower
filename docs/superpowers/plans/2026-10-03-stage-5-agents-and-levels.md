# Stage 5 — Codex and Hermes beside Claude, and every tool levels like an OSRS skill (plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `watchtower sync` projects Codex and Hermes (and a light touch of OpenViking and
Atlas) into `wt_*`. `rollup.sh` derives their hours, Codex's API-price cost and an OSRS
level for every tool. The dashboard gains an Overview, a Codex page and a Hermes page, and
the Claude rank ladder retires here and in TheOneOS.

**Architecture:**
- Four new TypeScript adapters under `lib/adapters/` are read-only projections into `wt_*`.
  They copy no content and own only their own rows: a new `scope: "own"` on metric
  authority.
- `watchtower sync` then runs the **installed** `claude-usage-rollup.sh`. Its new last
  section reads `wt_*` and writes four regenerable `agent_*` tables (prices, per-request
  cost, daily rollups, progress). It uses Claude's gap rule, applied to driven sessions
  only.
- `lib/read` parses, groups, sums and labels those tables. `lib/render` draws one level
  card and two new page pairs.
- TheOneOS's Hours panel reads `agent_progress` and stops doing rank math.

**Tech stack:** bash, `jq` 1.8, the `sqlite3` CLI (window functions, JSON1), Node ≥ 22 with
native type stripping, vitest. **Zero runtime dependencies.**

**Spec (binding):** `docs/superpowers/specs/2026-10-03-stage-5-agents-and-levels-design.md`,
approved 2026-10-03. Copy every table, column, price, tier name, formula and empty-state
string from the spec or from this plan; do not re-derive them. The spec's §2 decisions are
settled and must not be re-asked.

**Branch:** `stage-5-agents-and-levels`, cut from `main` @ `6b30358`. The spec is commit
`945694d`. The TheOneOS work (Task 10) goes on its own branch, in a worktree off TheOneOS
`main`.

**Ledger:** `.superpowers/sdd/2026-10-03-stage-5-agents-and-levels/`, with `progress.md` and a
`task-N-report.md` per task.

**Review shape (the user's standing preference):**
- No per-task review gates.
- Every task ends with its tests green, `npm run typecheck` clean, its guard plants recorded
  in its report, and a commit.
- After Task 10: **one** whole-branch review on the most capable model, then **at most one**
  fix wave.

---

## Rulings (the spec does not settle these; read at review)

**R1 — Own-scope authority.** Today exactly one source may own `(request, tokens_in)`, so
registering Codex would throw "already owned by claude".
- `MetricAuthority` gains `scope?: "own"`. An own claim covers only the records the source
  emits itself, which land on that source's `(source, source_record_id)` rows.
- Two claims **contend** unless both are own. An unscoped claim is exclusive, exactly as in
  Stage 3, and contends with every claim. That is what keeps Atlas's `token_totals` out.
- `registerSource` throws on any contending claim held by another source. The wording stays
  `already owned by "<source>"`.
- A new `writeAuthority(db)` answers "may this source write this metric": the source
  declares it, and no earlier source in ownership order holds a contending claim.
  - `isAuthoritative` and ingest both use it.
  - `authorityLookup` is deleted.
  - `authorityOwner` now returns the first **exclusive** claimant, or null.
- Claude's two claims become own. So does every claim of Codex, Hermes, OpenViking and
  Atlas.

**R2 — Codex sessions.** A rollout file's **first** `session_meta` is the file's own session.
- A later `session_meta` with the same id is a resume re-append, so it is `session_start`.
- One with a different id is a copy of a parent's meta that a subagent file carries, so it
  is `activity`.
- A subagent's `entry` is `subagent:<kind>`. `<kind>` is the first key of
  `payload.source.subagent`, or that key's string value when the key is `other` (e.g.
  `subagent:guardian`).
- A subagent session is **always automated**: `driven = 0`, whatever config says.
- Requests are keyed by `response_id`. Their session is the file's own session.

**R3 (revised in planning) — `thread_settings_applied` is `activity`, not `session_start`.**
It precedes most turns:
- Codex Desktop: 50 of them against 78 `task_started` (37 directly before one);
- codex-tui: 39 against 42 (32);
- the chrome side panel: 50 against 59 (45).

Mapped to `session_start` it drops driven hours from 41.54 h to 30.26 h, a 27% undercount.
As activity, a dormant gap that ends at it is credited at most 300 s, the same as Claude's
credit for a long gap ending at a prompt.

**R4 — Originators** (two more than the spec lists, both seen on the live machine):
- Codex driven: `Codex Desktop`, `codex_work_desktop`, `codex-tui`, `codex_vscode`,
  `codex-chrome-extension-sidepanel`, `codex_cli_rs`.
- Codex automated: `codex_exec`, `buzz-acp`, `codex_sdk_ts`.
- Hermes driven: `cli`, `tui`, `telegram`. Hermes automated: `api_server`.
- Anything else is unclassified (`driven` NULL). It earns nothing and is listed on its page.

**R5 — Agent hours are booked to the local day of the event that ends each gap.** This is
what lets a session span midnight (Review Focus 3). Claude's hours are untouched: Claude
keeps booking to the session's start day.

**R6 — Codex event volume.** Within one file, emit an `activity` event only when its whole
second differs from the last emitted event's. `session_start`, `prompt` and `stop` are
always emitted. Hours are unchanged, because a same-second gap is 0. Hermes emits every
message.

**R7 — Event encoding.** Every activity event is a record of kind `"event"` with
`dimensions: { event, seq }`:
- `event` is one of `session_start | session_end | prompt | stop | activity`.
- `seq` orders ties within a session.

Ids:
- Codex: `<fileStem>:<lineNo>`, with seq = the 1-based line number. `fileStem` is the
  basename without `.jsonl`, so it is stable when a file moves to `archived_sessions` and
  distinct per file.
- Hermes: `start:<id>` with seq 0, `msg:<messages.id>` with seq = the message id, and
  `end:<id>` with seq `9007199254740991`.

**R8 — Hermes cost.** `cost_usd` is:
1. `actual_cost_usd` when it is > 0 (and metric `cost_actual = 1`);
2. otherwise `estimated_cost_usd` when `cost_status = 'estimated'` (`cost_actual = 0`). A
   genuine 0 here is a reading: Hermes priced a free model at $0;
3. otherwise no cost metric at all, which renders "Hermes didn't price this".

`wt_requests.cost_usd` holds Hermes's figure. It is never an input to "at API prices".
`cost_status` and `cost_source` are strings, and `wt_usage.value` is REAL, so they are not
stored. `cost_actual` carries the one distinction a page needs. (Refines spec §3.3.)

**R9 — Hermes tokens are copied verbatim from `session_model_usage`.** The live proof
compares against that table. The `sessions` table's own token columns disagree with it
(input 15,118,298 vs 15,237,503; output 249,615 vs 274,530). Task 9 records this in
`SESSION.md`.

**R10 — OpenViking and Atlas are records, not `wt_metrics`.** They land in `wt_events` +
`wt_usage` through the ordinary ingest path, so they get fingerprints, authority and
`wt_ingest_state` for free.
- **OpenViking** (`type: "memory"`): kind `"health"`.
  - Ids: `reachable:<syncTs>`, `recall:<ts>`, `capture:<ts>`. Dimensions `{ probe }`.
  - Metrics: `reachable`, `recall_count`, `recall_latency_ms`, `recall_tokens`,
    `capture_turns`, `capture_committed`.
  - Never copy `cc_session_id`, `server_url` or `ov_session_id`. Never open
    `~/.openviking/ovcli.conf`.
- **Atlas** (`type: "provenance"`): kind `"checkpoint"`.
  - id = `sessionId` = `agent_session.id`; timestamp = `updated_at`.
  - Metrics: `atlas_checkpoints` and `atlas_files_touched` (`deleted = 0`).
  - Linked to Claude's canonical through `native_session_id`.
  - Every `.atlas/sessions.db` under the roots is read (`findAtlasDbs`). The reader takes
    MAX across the duplicate rows one native id can have (`acp` and `external_jsonl`).

**R11 — Config.**
- Default `sources`:
  - `claude`;
  - `codex` and `hermes`, each with its own `driven` and `automated` lists;
  - `openviking` with `baseUrl: "http://127.0.0.1:1933"`;
  - `atlas` with `projectRoots: ["~/Developer"]`.
- `SourceConfig` gains `driven?: string[]` and `automated?: string[]`, validated as string
  arrays. `entryLists(id, sc)` falls back to the exported constants `CODEX_DRIVEN`,
  `CODEX_AUTOMATED`, `HERMES_DRIVEN` and `HERMES_AUTOMATED`.
- A config file's `sources` still replaces the defaults, except that `claude` is added back
  unless the file names it.
- `dashboard.syncSeconds`: default 300; 0 turns it off; any other value must be
  ≥ `MIN_SYNC_SECONDS = 60`. Env `WATCHTOWER_SYNC_SECONDS` overrides it, validated the same
  way.

**R12 — `watchtower sync` runs the installed rollup after projecting**, through
`lib/rollup-run.ts` `runRollup`.
- Script: `<capture.installDir>/claude-usage-rollup.sh`, with
  `CC_LIB_PATH=<installDir>/cc-track-lib.sh`.
- Env: `WATCHTOWER_DB_PATH`, `THEONE_DB_PATH` and `WATCHTOWER_EXCLUDE_PATHS` (the config's
  list joined by `\n`).
- `WATCHTOWER_ROLLUP_PATH` and `CC_LIB_PATH` override the paths (tests use them).
  `--no-rollup` skips the step.
- Outcomes:
  - a missing script prints `rollup: {ran:false}` and exits 0;
  - a failed rollup exits 1;
  - any source error exits 1, after the JSON is printed.
- Until the user installs v7, the installed rollup is v6. Every page then says "rollup
  pending" instead of erroring.

**R13 — Background sync while the dashboard is open.** `lib/background-sync.ts`
`startBackgroundSync` spawns `process.execPath <bin> sync --quiet` right away, then every
`syncSeconds`.
- Never two at once.
- The timer is `unref`'d.
- `bin/watchtower serve` starts it when `syncSeconds > 0`. `lib/serve.ts` stays read-only.
- Every test that spawns `bin/watchtower` sets `HOME` to a temp dir, and every `serve`/`open`
  test also sets `WATCHTOWER_SYNC_SECONDS=0`.

**R14 — Codex prices.** Source: `https://developers.openai.com/api/docs/pricing`, read
2026-10-03, standard tier, USD per 1M tokens, `effective_from '2025-01-01'`.

| model | input | cached input | output |
|---|---|---|---|
| `gpt-6-astra` | 10 | 1.00 | 50 |
| `gpt-6.1-sol` | 2 | 0.10 | 10 |
| `gpt-5.6-sol` | 4 | 0.40 | 20 |
| `gpt-5.5` | 5 | 0.50 | 30 |
| `gpt-5.4-mini` | 0.75 | 0.075 | 4.50 |
| `gpt-5.2` | 1.75 | 0.175 | 14 |
| `gpt-5` | 1.25 | 0.125 | 10 |

`codex-auto-review` is `no-public-rate`. Any other model is `unknown-model`. A request
before its model's first `effective_from` is `no-price-yet`.

**R15 — `agent_daily_rollups` is keyed `(source, day, project_key)`.**
- `active_s` is NULL on a row with no driven gap. It is never 0 for "nothing measured".
- Cost columns sum with `TOTAL()`, beside their counts. A reader decides "not priced" from
  the counts, never from a $0.

**R16 — Codex tokens.**
- `token_count` deltas are used only **before the file's first `token_usage_record` line**.
  Measured: in 56 of 57 files `token_usage_record` precedes its own `token_count`. The 57th
  switched format mid-file, on a resume: 9 old-format lines on 2026-09-01, then new-format
  lines on 2026-09-11.
- Each distinct `total_token_usage.total_tokens` within the file is one request, keyed
  `<sessionId>:<total>`:
  - a repeated total is skipped;
  - a decreasing total starts a new baseline from 0;
  - a line with `info: null` is skipped.
- Normalisation, per record:
  - `tokens_in = input − cached − cache_write`. A negative result throws, and the record is
    counted malformed.
  - `tokens_cache_read = cached`, `tokens_cache_creation = cache_write`,
    `tokens_out = output`.
  - `reasoning_tokens` is its own `wt_usage` metric and is never added to `tokens_out`.

**R17 — Cursor and partial lines.** A new table, `wt_file_cursor(source, path, size,
mtime_ns TEXT)`, lets sync skip unchanged files. It is advisory.
- The adapter's optional `finish({ clean })` runs after its stream is drained. It writes
  cursor rows only when the ingest run had no malformed record, and only for files that had
  no partial tail. It returns `{ malformed, detail? }`, which `runSync` adds with
  `addMalformed`.
- `runSync` wraps each adapter in its own try/catch. A throw:
  - becomes `recordRunFailure`: health `degraded`, `last_error` set, `last_ok_at` kept;
  - puts `error` on that source's `SourceSummary`;
  - leaves the other sources untouched.
- A partial tail is a final line with no trailing newline that does not parse. It is
  skipped and **not** counted.
- A complete line that is not JSON is malformed. A line with no parseable `timestamp` is
  skipped.

**R18 — Reclassification.** Every Codex and Hermes `finish()` runs
`reclassifySql(source, lists)`. It recomputes `driven` from the stored `entry` on **all** of
that source's sessions, so changing config takes effect for files the cursor skips.
- `entry LIKE 'subagent:%'` gives 0.
- An empty list renders as `IN (NULL)`.

**R19 — First arrival wins a `response_id` (Review Focus 5).**
- Within a run, a `Set` of seen ids, with files sorted by basename and then by path.
- Across runs, `takenElsewhere` lists this file's ids already held by a **different**
  canonical in `wt_requests`, and those are skipped.

This mirrors `claude_requests.session_id`'s first-arrival rule.

**R20 — The rank on History and Live becomes the level.**
- History's hero card is retitled **Level**. It shows the level block, keeps the
  active-hours figure, lifetime hygiene and both streaks, and drops the `xp` and "next tier"
  facts and the ladder.
- Live's `rank` region becomes `level`.
- `HistoryData.rank` stays, for hygiene and the lifetime session count, both still written
  to `claude_rank_progress`. `LiveData.rank` is replaced by `LiveData.level`.
- `lib/render/ladder.ts` and its test are deleted.

**R21 — One literal per guard.** Each planted defect must turn **exactly one** test red. So
each guard's literal values live in one test (the guard map below). Every other test over
the same data asserts identities or rows the plant does not touch:
- rollup tests seed `wt_*` directly through `tests/helpers/agent-seed.ts`, never through
  an adapter;
- end-to-end tests assert reconciliation identities, not token or cost literals.

If a plant reds two tests, restructure the second test. Never loosen the first.

### Measured on the live machine (planning, 2026-10-03)

- Two Codex files have no `session_meta`; they are skipped, not malformed.
- 41 lines have no timestamp. There are 0 invalid JSON lines.
- There are 0 duplicate `response_id`s.
- `cached ≤ input` and `cache_write = 0` in all 1,621 `token_usage_record`s.
- Every main rollout file has exactly one own `session_meta`.
- The spec's "a resumed session under a later date folder" (§3.1) was really a subagent
  spawn: a rollout file under `2026/10/02/` carries its own thread-spawn meta plus a copy of
  its parent's meta, stamped 2026-09-30.
- Dormancy gaps over 1 h: 46. Of these, 23 end at activity while idle (1.92 h credited) and
  21 at a prompt (1.75 h). The other 2 end at activity while working (4.01 h); both are
  genuine long tool runs, e.g. a 2 h 10 m `exec`.
- The largest file is 174.6 MB and reads in 0.31 s. The September warm sync took 1.4 s.
- Claude's lifetime is 1,051,920 s, giving XP 1,523,464, **Lv 77 Advanced**, 73,009 s to
  Lv 78.

## Global Constraints

- **A tracker must never break Claude Code.** Nothing in this stage runs on the hook path.
  The new rollup section fails the way the others do (`exit 1` with
  `cc-rollup: agent rebuild failed`). It runs **after** every Claude section has committed,
  so it can never cost Claude a number.
- **Read-only sources.** Codex logs are read with `readFileSync`. `state.db` and every
  `.atlas/sessions.db` are opened with `querySql(…, { readonly: true })`. OpenViking gets
  one `GET /health` plus two JSON files.
- **No content leaves a source:**
  - no Codex message, reasoning, `base_instructions` or `last_agent_message`;
  - no Hermes `content`, `reasoning*`, `system_prompt`, `title`, `tool_calls` or
    `api_content`;
  - no OpenViking `cc_session_id`, `server_url` or `ov_session_id`;
  - `~/.openviking/ovcli.conf` is never opened.
- **Every derivation lives in `capture/rollup.sh`:** hours, the gap rule, prices, cost and
  every level number.
  - `lib/` parses, groups, sums stored values and labels.
  - Display arithmetic on two stored columns (a meter's percent, seconds shown as hours) is
    allowed, as `rankBody` does today.
  - `MIN(gap,` appears only in `rollup.sh`.
  - **No rate and no pricing URL appears under `lib/`.**
- `CC_SCHEMA_VERSION` (`capture/lib.sh`) and `schemaVersion` (`lib/config.ts`) become **7**.
  `WT_SCHEMA_VERSION` (`lib/core/schema.ts`) becomes **3**.
- `claude_rank_progress` keeps being written exactly as today. It is marked deprecated in a
  comment and is not removed.
- **Claude's numbers do not move.** Per-day `active_ms` is byte-identical to `main`'s on the
  same DB copy (Task 9).
- **A missing measurement is never zero.** No page shows `$0.00`, `0 h` or a level for
  something unmeasured. The empty-state strings are spec §5's table, verbatim.
- **Durable `wt_*` rows.** Codex and Hermes rows are only ever upserted, never deleted. A
  deleted log keeps its history.
- Tests drive the real bash scripts with `TZ=UTC`. Fixtures fail loudly (`.bail on`, `set -e`)
  and encode SQL values through `lib.sh`'s encoders.
- Every guard has its defect planted until **exactly one** test turns red, and every plant is
  recorded in the task report (R21).
- **Never touch the live DB, `~/.claude`, `~/.codex` or `~/.hermes` for writing.**
  - Live checks run on a `sqlite3 .backup` copy, in a **fresh directory** per copy (the
    `.schema-vN` and `.wt-schema-vN` markers are per directory).
  - Always pass `CC_LIB_PATH="$PWD/capture/lib.sh"` and
    `WATCHTOWER_ROLLUP_PATH="$PWD/capture/rollup.sh"`.
- `package.json` gains no `dependencies`, and there is no build step.
- Commit messages and PR bodies carry **no** `Co-Authored-By` trailer and no other AI
  attribution.
- Never commit the untracked `.claude/` directory. Restore `.superpowers/sdd/.gitignore`
  after any SDD script call. Commit the ledger; never delete it.

## Review Focus

1. **A Codex session resumed days later.**
   - Case A: the resume is a second file with the same session id, whose first line is a
     `session_meta`.
   - Case B: the resume is appended to the same file, in the old format, with a new
     baseline.
   - Either way: one `wt_sessions` row, the dormant gap counts 0, and hours come only from
     real activity, on the right days.
   - Test: Task 2 (`resume` scenario, one session) and Task 5 (12 s on 09-15 and 25 s on
     09-18).
2. **A rollout file being written during sync.**
   - The partial last line is skipped and not counted as malformed.
   - The file gets no cursor row, so the next sync reads the completed line.
   - A complete non-JSON line, by contrast, counts once.
   - Test: Task 2 (`partial` scenario, two syncs).
3. **A session spanning local midnight.**
   - Codex hours and tokens split by local day.
   - Hermes hours split by day while its tokens land on the start day.
   - Test: Task 5 (`midnight` scenarios: Codex 60/130 s and 100/200 tokens; Hermes 300/400 s,
     tokens on 09-20).
4. **Hermes's `state.db` unreadable mid-sync** (WAL busy, or not a database).
   - Hermes is marked degraded with `last_error`, and its `SourceSummary` carries `error`.
   - Claude and Codex in the same run are untouched, and the CLI exits 1 after printing the
     JSON.
   - Test: Task 3 (a non-database `state.db`) and Task 4 (CLI exit code).
5. **The same `response_id` in two files.**
   - One row, owned by the first arrival, both within a run (sorted basenames) and across
     runs (`takenElsewhere`).
   - Test: Task 2 (`dup` scenario, both orders).

## Guard map (R21)

| # | Plant (in the code under test) | The one test that turns red | Task |
|---|---|---|---|
| 1 | Codex token_count: sum `total_token_usage` instead of distinct deltas | `codex-adapter.test.ts` "S4 token_count deltas" (asserts **only** ids and `tokens_cache_read` 600 + 600) | 2 |
| 2 | `tokens_in = input` (cached left inside) | `codex-adapter.test.ts` "S1 normalised tokens" (asserts **only** `tokens_in` 600 + 500 and `tokens_cache_read` 400 + 1500) | 2 |
| 3 | `tokens_out = output + reasoning` | `codex-adapter.test.ts` "reasoning stays out of tokens_out" (asserts **only** S1 `tokens_out` 200 + 300 and `reasoning_tokens` 20 + 30) | 2 |
| 4 | Drop `AND s.driven = 1` from `_ag_ev` | `agent-rollup.test.ts` "automated and unclassified sessions earn no hours" | 5 |
| 5 | Unknown model priced: its branch yields `priced = 1`, cost 0 | `agent-rollup.test.ts` "a model with no rate is not priced" | 5 |
| 6 | Hermes's `own_cost_usd` added into the Overview's API sum | `read-overview.test.ts` "Hermes's figure never enters at API prices" | 7 |
| 7 | `(92,6517254)` in the XP `VALUES` list | `agent-rollup.test.ts` "XP thresholds equal the OSRS formula" | 5 |
| 8 | Stars by `ROUND((active_s − 9000000) / 900000.0)` instead of integer division | `agent-rollup.test.ts` "a veteran past 99 earns floor stars" (2, not 3) | 5 |
| 9 | Codex `finish()` deletes `wt_*` rows of files no longer on disk | `codex-adapter.test.ts` "a deleted log keeps its rows" | 2 |
| 10 | An adapter copies content (`metadata: { content }`) | `codex-adapter.test.ts` / `hermes-adapter.test.ts` "copies no content" (one per adapter; plant each separately) | 2, 3 |
| 11 | `>=` instead of `>` in the agent copy's working test | `agent-rollup.test.ts` "the agent gap rule equals Claude's" (16,380 s, not 16,680) | 5 |

Guards 1–3 each get their own test, and each asserts **only** the fields named above:
- guard 2's plant also changes S4's `tokens_in`, and guard 3's changes S4's `tokens_out`;
- that is why guard 1's test asserts S4's `tokens_cache_read`, which neither of those
  plants touches.

The same reasoning sets what each later test may assert:
- the Codex end-to-end test (Task 5) asserts S1's project row's hours, the session and
  request counts, and token and cost **identities**;
- token literals live only in Task 2's three tests;
- cost literals and price notes live only in guard 5's seeded test;
- lifetime levels live only in a seeded, driven-only test.

The existing guards stay green and keep their single tests:
- `MIN(gap,` appears only in `rollup.sh`, with the count pins moving to 4 and 3;
- no rate under `lib/`, with the needle list extended;
- the schema version is pinned in both places;
- the report's per-week budget, with new rows.

## Fixture reference (all tasks use these exact values; `TZ=UTC`)

Times:
- `T0 = 1789466400` (2026-09-15T10:00:00Z).
- Offsets below are seconds from each session's own base.
- The model is `gpt-5.5` unless stated.
- `usage` is written as `{in, cached, write, out, reasoning, total}`. These map to
  `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
  `reasoning_output_tokens` and `total_tokens`.

**`make-codex-logs.sh core`** writes six files under `$CODEX_HOME`:

| Session | File | Originator / entry | Base |
|---|---|---|---|
| `codex-s1` | `sessions/2026/09/15/rollout-2026-09-15T10-00-00-codex-s1.jsonl` | `Codex Desktop` (driven); cwd `$WT_CODEX_CWD` | T0 |
| `codex-s8` | `sessions/2026/09/15/rollout-2026-09-15T10-05-00-codex-s8.jsonl` | subagent `thread_spawn` → `subagent:thread_spawn` (automated) | T0+300 |
| `codex-s2` | `sessions/2026/09/15/rollout-2026-09-15T10-16-40-codex-s2.jsonl` | `codex_exec` (automated); cwd `/tmp/wt-codex-exec` | T0+1000 |
| `codex-s3` | `sessions/2026/09/15/rollout-2026-09-15T10-33-20-codex-s3.jsonl` | `mystery-client` (unclassified); cwd `/tmp/wt-codex-mystery` | T0+2000 |
| `codex-s4` | `sessions/2026/09/16/rollout-2026-09-16T09-00-00-codex-s4.jsonl` | `codex-tui` (driven), **token_count only**, model `gpt-5.2`; cwd `$WT_CODEX_CWD` | T4 = 1789549200 |
| `codex-s6` | `archived_sessions/rollout-2026-09-14T08-00-00-codex-s6.jsonl` | `codex_vscode` (driven); cwd `$WT_CODEX_CWD` | T6 = 1789372800 |

The S1 lines. **Every** line carries a top-level `timestamp`.

| line | +s | type / payload.type | content | event |
|---|---|---|---|---|
| 1 | 0 | `session_meta` | id `codex-s1`, originator `Codex Desktop`, cwd, `source:"vscode"`, `git:{branch:"main",repository_url:"https://example.invalid/r.git"}`, `base_instructions:{text:"SECRET-BASE"}` | session_start |
| 2 | 0 | `turn_context` | model `gpt-5.5` | (same second: none) |
| 3 | 20 | `event_msg/thread_settings_applied` | | activity (20) |
| 4 | 22 | `event_msg/task_started` | | prompt (2) |
| 5 | 30 | `response_item` | `{type:"message",role:"user",content:[{type:"input_text",text:"SECRET-PROMPT"}]}` | activity (8) |
| 6 | 60 | `response_item` | `{type:"reasoning",encrypted_content:"SECRET-REASONING"}` | activity (30) |
| 7 | 70 | `token_usage_record` | `response_id:"resp_s1_a"`, usage `{1000,400,0,200,20,1200}` | activity (10) |
| 8 | 70 | `event_msg/token_count` | info.total = the same | none |
| 9 | 90 | `event_msg/task_complete` | `last_agent_message:"SECRET-ANSWER"` | stop (20) |
| 10 | 190 | `event_msg/thread_settings_applied` | | activity (100) |
| 11 | 195 | `event_msg/task_started` | | prompt (5) |
| 12 | 215 | `token_usage_record` | `resp_s1_b`, usage `{2000,1500,0,300,30,2300}` | activity (20) |
| 13 | 215 | `event_msg/token_count` | | none |
| 14 | 220 | `response_item` | assistant message `"SECRET-ANSWER"` | activity (5) |
| 15 | 220 | `event_msg/task_complete` | | stop (0) |

S1 driven hours = **220 s**. With R3 reversed (`thread_settings_applied` as `session_start`)
it would be 100 s, so a test pins 220. S1 has 12 events. Its tokens: `tokens_in` 1,100,
`tokens_cache_read` 1,900, `tokens_cache_creation` 0, `tokens_out` 500, `reasoning_tokens` 50.
Cost: `resp_s1_a` **$0.0092**, `resp_s1_b` **$0.01225**.

The other sessions:
- **S8 lines:**
  1. +0 own `session_meta`: id `codex-s8`, `source:{subagent:{thread_spawn:{parent_thread_id:"codex-s1",depth:1,agent_role:"worker"}}}`, originator `Codex Desktop`.
  2. +0 a copy of S1's meta, id `codex-s1` (activity; same second, so none).
  3. +0 `turn_context`.
  4. +1 `task_started`.
  5. +20 `token_usage_record` `resp_s8_a` `{400,0,0,40,0,440}`.
  6. +30 `task_complete`.

  Automated, so 0 hours. Cost $0.0032.
- **S2:**
  - +0 meta, +0 `turn_context`, +1 `task_started`.
  - +10 `resp_s2_a` `{500,0,0,100,0,600}` ($0.0055).
  - +11 `turn_context` model `gpt-9-imaginary`.
  - +20 `resp_s2_b` `{50,0,0,5,0,55}` (`unknown-model`).
  - +30 `task_complete`.
- **S3:**
  - +0 meta, +0 `turn_context` model `codex-auto-review`, +1 `task_started`.
  - +10 `resp_s3_a` `{300,100,0,50,0,350}` (`no-public-rate`; tin 200, tcr 100, tout 50).
  - +20 `task_complete`.
- **S4** (old format; no `token_usage_record` anywhere):
  - +0 meta, +0 `turn_context` `gpt-5.2`, +5 `task_started`.
  - +30 `token_count` with total `{1000,600,0,100,10,1100}`.
  - +30 the same `token_count` again.
  - +60 `token_count` with total `{2500,1200,0,250,30,2750}`.
  - +95 `task_complete`.

  One `token_count` line with `info:null` at +40 is skipped. Requests `codex-s4:1100` (tin
  400, tcr 600, tout 100, reasoning 10) and `codex-s4:2750` (tin 900, tcr 600, tout 150,
  reasoning 20). Totals: tin **1300**, tcr 1200, tout 250, reasoning 30. Hours **95** s.
  Cost $0.005985.
- **S6** (archived):
  - +0 meta, +0 `turn_context`, +5 `task_started`.
  - +10 `resp_s6_a` `{100,0,0,10,0,110}`.
  - +15 `task_complete`.

  Hours **15** s. Cost $0.0008.

Expected `agent_daily_rollups` for Codex. S1, S4 and S6 share `$WT_CODEX_CWD`'s project. S2,
S3 and S8 key by their own cwd (S8 has no cwd, so `(unfiled)`):

| day | requests | active_s (all rows) | tin | tcr | tout | priced | unpriced | cost_table_usd | driven | automated | unclassified |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-14 | 1 | 15 | 100 | 0 | 10 | 1 | 0 | 0.0008 | 1 | 0 | 0 |
| 2026-09-15 | 6 | 220 | 2250 | 2000 | 695 | 4 | 2 | 0.03015 | 1 | 2 | 1 |
| 2026-09-16 | 2 | 95 | 1300 | 1200 | 250 | 2 | 0 | 0.005985 | 1 | 0 | 0 |

Codex lifetime: 330 s. That gives XP 477, **Lv 5 Noobie**, `xp_into_level` 89,
`xp_to_next` 35 and `s_to_next` 24.

**`make-codex-logs.sh resume`** (S5, `T5 = 1789480800`, 2026-09-15T14:00Z):
- File A, `sessions/2026/09/15/rollout-2026-09-15T14-00-00-codex-s5.jsonl`:
  - meta (`Codex Desktop`), `turn_context`;
  - +2 `task_started`;
  - +10 `resp_s5_a` `{100,0,0,10,0,110}`;
  - +12 `task_complete`;
  - giving **12 s** on 09-15.
- File B, `sessions/2026/09/18/rollout-2026-09-18T09-00-00-codex-s5b.jsonl`, at 1789722000:
  - **first line** a `session_meta` with the same id `codex-s5`;
  - +5 `task_started`;
  - +15 `resp_s5_b` `{100,0,0,10,0,110}`;
  - +25 `task_complete`;
  - giving **25 s** on 09-18.
- One session in total. Lifetime 37 s, Lv 1.

**`make-codex-logs.sh partial`** writes two files:
- **S10** (`codex-s10`, `Codex Desktop`, at T0+5000), at
  `sessions/2026/09/15/rollout-2026-09-15T11-23-20-codex-s10.jsonl`:
  - meta, then `task_started` (+1);
  - `resp_s10_a` `{100,0,0,10,0,110}` (+5);
  - then the **first 40 characters** of a `token_usage_record` line for `resp_s10_b`
    `{100,0,0,10,0,110}` (+9), with **no trailing newline**.
- **S11** (`codex-s11`, `Codex Desktop`, at T0+6000), at
  `sessions/2026/09/15/rollout-2026-09-15T11-40-00-codex-s11.jsonl`:
  - meta, then one complete line `not json at all`, then `task_complete` (+3).

`make-codex-logs.sh partial-complete` appends the rest of S10's last line plus `\n`, then a
`task_complete` (+12).

**`make-codex-logs.sh midnight`** (S9 at 1789948680, 2026-09-20T23:58:00Z, driven):

| +s | line | gap credited |
|---|---|---|
| 0 | meta | — |
| 10 | `task_started` | 10 |
| 60 | `resp_s9_a` `{100,0,0,10,0,110}` (09-20) | 50 |
| 150 | `response_item` (00:00:30 on 09-21) | 90 |
| 170 | `resp_s9_b` `{200,0,0,10,0,210}` (09-21) | 20 |
| 190 | `task_complete` | 20 |

That gives **60** s on 09-20 and **130** s on 09-21. Tokens: tin 100 on 09-20, 200 on 09-21.

**`make-codex-logs.sh dup`** writes two files that share `resp_dup` `{100,0,0,10,0,110}`:
- `rollout-2026-09-15T15-00-00-codex-da.jsonl`, session `codex-da` at T0+18000;
- `rollout-2026-09-15T16-00-00-codex-db.jsonl`, session `codex-db` at T0+21600.

`dup-b-only` writes only the second file.

**`make-codex-logs.sh early`** (S7 at 1704067200, 2024-01-01T00:00Z): `resp_s7_a` on
`gpt-5.5` is `no-price-yet`.

**`make-hermes-db.sh <scenario> <path>`** builds `state.db` with Hermes's real DDL (Task 3)
in WAL mode:

| session | source | started_at | messages (+s: role, finish_reason) | ended_at | usage rows |
|---|---|---|---|---|---|
| `h1` | `cli` | 1790596800 (2026-09-28T12:00Z) | +10 user · +40 assistant `tool_calls` · +100 tool · +160 assistant `stop` · +400 user · +460 assistant `stop` | +500 | `qwen3-coder`/`local`: in 1000, out 200, cost_status `estimated`, estimated 0 → **$0 priced**. `gpt-oss-120b`/`openrouter`: in 3000, out 500, cache_read 2000, cache_write 100, reasoning 50, estimated 0.02, actual **0.5**, status `actual` |
| `h2` | `api_server` | 1790672400 (2026-09-29T09:00Z) | +5 user · +30 assistant `stop` | +40 | `gpt-oss-120b`: in 400, out 40, estimated **0.0123**, status `estimated` |
| `h3` | `telegram` | 1790841600 (2026-10-01T08:00Z) | +5 user · +20 assistant `stop` | NULL | `mystery-model`: in 50, out 5, status `unknown`, estimated 0, actual 0 → **not priced** |

- Every message's `content` is `'SECRET-CONTENT'` and `reasoning` is `'SECRET-REASONING'`.
  `sessions.system_prompt` is `'SECRET-SYSTEM'`, and `title` is `'SECRET-TITLE-<id>'` (titles
  are UNIQUE in the real DDL).
- cwd: h1 and h3 have `/tmp/wt-hermes-cli`, and h2 has NULL. Neither directory exists, so
  both key to `(unfiled)`. h1, h2 and h3 fall on different days, so each day's row holds one
  session.
- Hours: h1 **460** s (10 + 30 + 60 + 60 + 240 + 60; the gap ending at `ended_at` counts 0),
  h3 **20** s, h2 0 (automated).
- Lifetime 480 s gives XP 695, **Lv 7**, `xp_into_level` 45, `xp_to_next` 106 and
  `s_to_next` 74.
- Hermes's figure: $0.5123 over 3 priced rows, with 1 unpriced row.

`midnight` (h5, `cli`, started 1789948200 = 2026-09-20T23:50:00Z):
- messages: +10 user, +300 assistant `tool_calls`, +700 assistant `stop`;
- `ended_at` NULL;
- one usage row, in 100 and out 10, `estimated` 0.001;
- result: **300** s on 09-20 and **400** s on 09-21, with tokens on 09-20.

`veteran` (h9, `cli`, started 1700000000):
- messages: one user at +1, then 812 assistant `tool_calls` messages spaced 14,400 s apart,
  then one assistant `stop` 7,198 s after the last;
- `ended_at` NULL;
- result: 1 + 812 × 14,400 + 7,198 = **11,699,999** s, which is **Lv 99 Master**, stars **2**,
  XP 16,944,758, with `xp_to_next` and `s_to_next` NULL.

**`make-fixture.sh agent-drift`** (Claude, `BASE = 1750000000`, session `S_DRIFT`): `ev` lines
at these offsets:

| offset | event |
|---|---|
| 0 | SessionStart |
| 4 | UserPromptSubmit |
| 20 | PreToolUse |
| 900 | PostToolUse |
| 960 | Stop |
| 1500 | Notification |
| 2100 | UserPromptSubmit |
| 2100 | Stop |
| 2700 | Notification |
| 2710 | UserPromptSubmit |
| 20000 | PostToolUse |
| 20010 | Stop |
| 20010 | SessionEnd |
| 25000 | SessionStart |
| 25010 | UserPromptSubmit |
| 25100 | Stop |

Claude's rule gives **16,380** s. A `>=` in the working test gives 16,680, because of the
2700 Notification after the tied prompt and stop at 2100. That is Lv 35 Builder.

The full XP table, rollup and test alike:

```
(1,0),(2,83),(3,174),(4,276),(5,388),(6,512),(7,650),(8,801),(9,969),(10,1154),
(11,1358),(12,1584),(13,1833),(14,2107),(15,2411),(16,2746),(17,3115),(18,3523),(19,3973),(20,4470),
(21,5018),(22,5624),(23,6291),(24,7028),(25,7842),(26,8740),(27,9730),(28,10824),(29,12031),(30,13363),
(31,14833),(32,16456),(33,18247),(34,20224),(35,22406),(36,24815),(37,27473),(38,30408),(39,33648),(40,37224),
(41,41171),(42,45529),(43,50339),(44,55649),(45,61512),(46,67983),(47,75127),(48,83014),(49,91721),(50,101333),
(51,111945),(52,123660),(53,136594),(54,150872),(55,166636),(56,184040),(57,203254),(58,224466),(59,247886),(60,273742),
(61,302288),(62,333804),(63,368599),(64,407015),(65,449428),(66,496254),(67,547953),(68,605032),(69,668051),(70,737627),
(71,814445),(72,899257),(73,992895),(74,1096278),(75,1210421),(76,1336443),(77,1475581),(78,1629200),(79,1798808),(80,1986068),
(81,2192818),(82,2421087),(83,2673114),(84,2951373),(85,3258594),(86,3597792),(87,3972294),(88,4385776),(89,4842295),(90,5346332),
(91,5902831),(92,6517253),(93,7195629),(94,7944614),(95,8771558),(96,9684577),(97,10692629),(98,11805606),(99,13034431)
```

## File map

| File | Task | Responsibility |
|---|---|---|
| `lib/core/adapters.ts` | 1 | own-scope authority, `writeAuthority`, optional `finish` |
| `lib/core/schema.ts` | 1 | WT v3: `wt_sessions.cwd/entry/driven`, `wt_file_cursor`, two indexes, tolerant ALTERs |
| `lib/core/identity.ts` | 1 | `agentSessionSql` |
| `lib/core/ingest.ts` | 1 | `may` via `writeAuthority`; `addMalformed`, `recordRunFailure` |
| `lib/core/sync.ts` | 1 | per-adapter isolation, `finish`, `SourceSummary.error` |
| `lib/core/sql.ts` | 1 | `pagedRows(…, { readonly })` |
| `lib/core/records.ts` | 1 | `epochToRfc3339` moves here (re-exported from claude/records.ts) |
| `lib/core/cursor.ts` (new) | 1 | `readFileCursor`, `fileCursorSql` |
| `lib/adapters/entry.ts` (new) | 1 | `EntryLists`, `classifyEntry`, `reclassifySql` |
| `lib/adapters/claude/index.ts` | 1 | claims become `scope: "own"` |
| `lib/adapters/codex/parse.ts` (new) | 2 | one rollout file → session + records; pure |
| `lib/adapters/codex/index.ts` (new) | 2 | `createCodexAdapter` |
| `lib/adapters/index.ts` (new) | 2 | `adaptersFor(cfg, { home })` |
| `lib/config.ts` | 2 | R11 (sources, lists, `syncSeconds`), schemaVersion 7 in Task 5 |
| `tests/fixtures/make-codex-logs.sh` (new) | 2 | Codex rollouts |
| `lib/adapters/hermes/index.ts` (new) | 3 | `createHermesAdapter` |
| `tests/fixtures/make-hermes-db.sh` (new) | 3 | Hermes `state.db` |
| `lib/adapters/openviking/index.ts` (new) | 4 | `createOpenVikingAdapter` |
| `lib/adapters/atlas/index.ts` (new) | 4 | `createAtlasAdapter` |
| `lib/core/discovery.ts` | 4 | `findAtlasDbs`, `lookedAt` |
| `lib/rollup-run.ts` (new) | 4 | `runRollup` |
| `lib/background-sync.ts` (new) | 4 | `startBackgroundSync` |
| `bin/watchtower` | 2, 4 | sync uses `adaptersFor`, runs the rollup; serve starts background sync |
| `capture/lib.sh` | 5 | v7: four `agent_*` tables |
| `capture/rollup.sh` | 5 | resolver arm; the agent section |
| `tests/helpers/agent-seed.ts` (new) | 5 | seed `wt_*` for rollup tests |
| `lib/read/level.ts`, `lib/render/level.ts` (new) | 6 | level reader and card |
| `lib/render/ladder.ts`, `tests/render-ladder.test.ts` | 6 | **deleted** |
| `lib/read/tools.ts`, `lib/read/overview.ts`, `lib/render/overview.ts` (new) | 7 | Overview |
| `lib/render/layout.ts`, `lib/render/report.ts`, `lib/views.ts` | 7 | tool row links, routes |
| `lib/read/agent.ts`, `lib/render/agent.ts` (new) | 8 | Codex and Hermes pages |
| `lib/render/cost.ts` | 8 | Hermes's figure labels |
| `lib/read/sessions.ts`, `lib/render/sessions.ts` | 8 | the Atlas line |
| `SESSION.md`, `CLAUDE.md` | 9 | proofs, docs |
| `tests/fixtures/theone-level-proof.mjs` (new) | 10 | TheOneOS lockstep proof |
| TheOneOS `lib/claude-hours/*`, the panel | 10 | level from `agent_progress` |

---

## Tasks

Live-copy setup (fresh directory, every time it is used):

```bash
L="${SCRATCH:?export SCRATCH as your session scratchpad directory}/live-5-$(date +%s)"; mkdir -p "$L"
sqlite3 ~/.theone/claude-code-usage.sqlite ".backup $L/db.sqlite"
export CC_LIB_PATH="$PWD/capture/lib.sh" WATCHTOWER_ROLLUP_PATH="$PWD/capture/rollup.sh" WATCHTOWER_DB_PATH="$L/db.sqlite"
```

Run the setup block and everything that uses `$L` in a subshell, `( … )`, or `unset CC_LIB_PATH WATCHTOWER_ROLLUP_PATH WATCHTOWER_DB_PATH` before
`npm test`. `buildAndRoll` passes only `THEONE_DB_PATH`, and an inherited `WATCHTOWER_DB_PATH`
wins in `lib.sh`, so every fixture rollup would write into the live copy.

### Task 1: Core — own-scope authority, WT schema v3, per-adapter isolation

**Files:**
- Modify:
  - `lib/core/adapters.ts`;
  - `lib/core/schema.ts`;
  - `lib/core/identity.ts`;
  - `lib/core/ingest.ts`;
  - `lib/core/sync.ts`;
  - `lib/core/sql.ts`;
  - `lib/core/records.ts`;
  - `lib/adapters/claude/records.ts`: `epochToRfc3339` becomes a re-export;
  - `lib/adapters/claude/index.ts`: the claims become own.
- Create: `lib/core/cursor.ts`, `lib/adapters/entry.ts`.
- Test:
  - `tests/core-adapters.test.ts`, `tests/core-schema.test.ts`, `tests/core-identity.test.ts`,
    `tests/core-sync.test.ts`, `tests/core-sql.test.ts`, `tests/claude-adapter.test.ts`;
  - new: `tests/core-cursor.test.ts`, `tests/adapter-entry.test.ts`.

**Interfaces:**
- Produces, for every later task:
  - `MetricAuthority.scope?: "own"`;
  - `writeAuthority(db): (source, kind, metric) => boolean`;
  - `WatchtowerAdapter.finish?({ clean }): { malformed: number; detail?: string }`;
  - `SourceSummary.error?: string`;
  - `addMalformed(db, source, n, detail?)` and `recordRunFailure(db, source, error)`;
  - `errorLine(e): string` (`lib/core/sql.ts`);
  - `pagedRows(db, sql, pageSize?, { readonly? })`;
  - `epochToRfc3339` from `lib/core/records.ts`;
  - `AgentSessionUpsert` and `agentSessionSql(a)`;
  - `FileStamp`, `readFileCursor`, `fileCursorSql`, `stampOf` and `unchanged` from
    `lib/core/cursor.ts`;
  - `EntryLists`, `classifyEntry` and `reclassifySql` from `lib/adapters/entry.ts`;
  - `WT_SCHEMA_VERSION = 3`, with `wt_sessions.cwd`, `entry`, `driven` and `wt_file_cursor`.

- [ ] **Step 1: Write the failing tests.**

  `tests/core-adapters.test.ts` adds `describe("own-scope authority (R1)")`, using the
  file's existing fake-adapter helper and `freshDb`:
  1. Claude `{kind:"request",metrics:["tokens_in"],scope:"own"}` and Codex with the same
     own claim both register. `writeAuthority(db)` is true for `("claude","request","tokens_in")`
     and for `("codex","request","tokens_in")`.
  2. After that own Claude claim, an Atlas registering an **unscoped**
     `{kind:"request",metrics:["tokens_in"]}` throws a message containing
     `already owned by "claude"`.
  3. After an unscoped Atlas claim on `(checkpoint, insertions)`, a later source with an own
     claim on it throws `already owned by "atlas"`.
  4. `writeAuthority(db)("ghost","request","tokens_in")` is false: the source is not
     registered. `writeAuthority(db)("claude","request","tokens_out")` is false: the metric is
     not declared.
  5. `authorityOwner(db,"request","tokens_in")` is `null` when every claim on it is own.
  6. Re-registering the first owner after a hand-inserted later contending row does not
     throw. Insert the row straight into `wt_sources` with a later `first_seen`.

  `tests/claude-adapter.test.ts`: assert
  `createClaudeAdapter({db}).authority.every((c) => c.scope === "own")`.

  `tests/core-schema.test.ts`:
  1. A fresh `applyWtSchema` gives:
     - `pragma_table_info('wt_sessions')` containing `cwd`, `entry` and `driven`;
     - a table `wt_file_cursor` with columns `source, path, size, mtime_ns`;
     - indexes `idx_wt_events_canonical` and `idx_wt_requests_canonical`;
     - the marker `.wt-schema-v3`.
  2. **A v2 database upgrades.** In a fresh dir:
     - create `wt_sessions` with the **v2** DDL (the columns `canonical_id … updated_at`
       only) and insert one row;
     - `applyWtSchema`;
     - the row survives, the three columns exist, and `.wt-schema-v3` is written.
  3. Delete the marker and call `applyWtSchema` again. It does not throw: the ALTERs are
     guarded.
  4. Any existing pin on `.wt-schema-v2` moves to v3.

  `tests/core-identity.test.ts` adds `describe("agentSessionSql")`:
  1. Write a session with start 100 and end 200, then upsert it with start 50 and end 150.
     The result is `started_at` 50 and `ended_at` 200.
  2. An upsert without `startedAt` keeps 50.
  3. `cwd` and `entry` take the newest non-null value. `driven` takes the new value
     verbatim: 1 then `null` gives `null`.
  4. `model` is fill-if-missing: `"a"` then `"b"` gives `"a"`.
  5. `first_source` is the given source.

  `tests/core-sync.test.ts` adds `describe("per-adapter isolation (R17)")`:
  1. A fake adapter whose `ingest()` throws `new Error("boom\nsecond line")` after one record.
     A fake Claude-like adapter beside it still ingests.
     - The thrower's summary has `detected: true` and `error: "boom"`.
     - `wt_ingest_state` for it has `health = 'degraded'` and `last_error = 'boom'`.
     - The other source's summary has no `error`.
  2. A fake adapter with `finish: () => ({ malformed: 2, detail: "2 bad" })`:
     - its summary has `malformed: 2`;
     - `wt_ingest_state.records_malformed = 2`, `health = 'degraded'`;
     - `last_ok_at` is **not** NULL (all records written).
  3. `finish` receives `{ clean: false }` when a record failed to write. Use a request
     record whose `timestamp` has no offset: `plan()` throws, so the record is malformed.

  `tests/core-sql.test.ts`: `[...pagedRows(db, "SELECT 1 AS i UNION ALL SELECT 2 ORDER BY i",
  1, { readonly: true })]` equals `[{i:1},{i:2}]`.

  `tests/core-cursor.test.ts`:
  - `fileCursorSql` then `readFileCursor` round-trips `{ size: 10, mtimeNs:
    "1789466400123456789" }`. A 19-digit string survives because the column is TEXT.
  - `unchanged(undefined, s)` is false. `unchanged(s, {...s})` is true. Either field
    differing is false.

  `tests/adapter-entry.test.ts`:
  - `classifyEntry` over `{driven:["cli"], automated:["api_server"]}` gives:

    | entry | result |
    |---|---|
    | `"cli"` | 1 |
    | `"api_server"` | 0 |
    | `"other"` | null |
    | `undefined` | null |
    | `"subagent:x"` | 0 |
    | `"subagent:x"` even when `"subagent:x"` is in `driven` | 0 |

  - `reclassifySql("codex", {driven:[],automated:[]})` contains `IN (NULL)` twice.
  - Run on a DB with sessions of two sources, it updates only `first_source = 'codex'`.

- [ ] **Step 2: Run them and watch them fail.**

  Run: `npx vitest run tests/core-adapters.test.ts tests/core-schema.test.ts tests/core-identity.test.ts tests/core-sync.test.ts tests/core-sql.test.ts tests/core-cursor.test.ts tests/adapter-entry.test.ts tests/claude-adapter.test.ts`

  Expected: FAIL. `scope`, `writeAuthority`, `agentSessionSql`, `cursor.ts` and `entry.ts`
  do not exist yet, and the schema is still v2.

- [ ] **Step 3: `lib/core/adapters.ts`.**

  Replace `MetricAuthority`, add `finish` to `WatchtowerAdapter`, and replace
  `authorityOwner`, `authorityLookup`, `registerSource`'s check and `isAuthoritative` with:

```ts
export interface MetricAuthority {
  kind: RecordKind;
  metrics: string[];
  /**
   * "own": the claim covers only records this source emits itself, which land on
   * its own (source, source_record_id) rows -- Codex's tokens on Codex requests,
   * Claude's on Claude requests. Two own claims never contend: when each source
   * writes only its own rows, no number can be counted twice.
   *
   * Absent: EXCLUSIVE, the Stage 3 rule. One source in the registry owns
   * (kind, metric) and every other claim on it is refused -- which is what keeps
   * Atlas's re-reported token_totals out (see isAuthoritative).
   */
  scope?: "own";
}
```

```ts
  /**
   * Optional. Called by runSync once ingest() is drained. `clean` is true when
   * every record of the run was written. An adapter with an advisory cursor
   * commits it here, and only when clean. Returns source-side malformed lines
   * (ones that never became records) for runSync to add to the run.
   */
  finish?(opts: { clean: boolean }): { malformed: number; detail?: string };
```

```ts
interface Owner { source: string; claims: MetricAuthority[] }

/** The registry in ownership order, with each source's claims parsed. */
function ownersInOrder(db: string): Owner[] {
  // Malformed JSON here is a corrupt registry, not a routine condition: this is
  // not the hook path, so it fails loudly rather than silently reassigning a metric.
  return claimsInOwnershipOrder(db).map((row) => ({
    source: row.source, claims: JSON.parse(row.authority) as MetricAuthority[],
  }));
}

function claimOf(claims: MetricAuthority[], kind: RecordKind, metric: string): MetricAuthority | undefined {
  return claims.find((c) => c.kind === kind && c.metrics.includes(metric));
}

/** Two claims on one (kind, metric) contend unless both are scoped to their own records. */
function contend(a: MetricAuthority, b: MetricAuthority): boolean {
  return !(a.scope === "own" && b.scope === "own");
}

/**
 * The single source that EXCLUSIVELY owns (kind, metric), or null. Own-scope
 * claims are not ownership of the metric everywhere, so they never answer here.
 * If a database somehow holds two exclusive claimants, the FIRST keeps it.
 */
export function authorityOwner(db: string, kind: RecordKind, metric: string): string | null {
  for (const o of ownersInOrder(db)) {
    const c = claimOf(o.claims, kind, metric);
    if (c !== undefined && c.scope !== "own") return o.source;
  }
  return null;
}

/**
 * May `source` write `metric` on its records of `kind`? Yes when it declares the
 * metric and no EARLIER source in ownership order holds a contending claim.
 *
 * The registry is read ONCE: ingest asks this for every metric of every record,
 * and a sqlite3 spawn per question was most of why a sync once took ~14 minutes.
 * It does not change during a run -- registerSource happens before ingest starts.
 */
export function writeAuthority(db: string): (source: string, kind: RecordKind, metric: string) => boolean {
  const owners = ownersInOrder(db);
  return (source, kind, metric) => {
    const i = owners.findIndex((o) => o.source === source);
    if (i === -1) return false;
    const mine = claimOf(owners[i].claims, kind, metric);
    if (mine === undefined) return false;
    return !owners.slice(0, i).some((o) => {
      const theirs = claimOf(o.claims, kind, metric);
      return theirs !== undefined && contend(mine, theirs);
    });
  };
}
```

  In `registerSource`, replace the loop with this. Only sources **earlier** in ownership
  order can block, so re-registering the first owner never throws (test 6):

```ts
  const owners = ownersInOrder(db);
  const at = owners.findIndex((o) => o.source === a.id);
  const earlier = at === -1 ? owners : owners.slice(0, at);
  for (const claim of a.authority) {
    for (const metric of claim.metrics) {
      for (const o of earlier) {
        const theirs = claimOf(o.claims, claim.kind, metric);
        if (theirs !== undefined && contend(claim, theirs)) {
          throw new Error(
            `source "${a.id}" claims authority over (${claim.kind}, ${metric}), ` +
            `already owned by "${o.source}"; exactly one source may own a metric`);
        }
      }
    }
  }
```

  `isAuthoritative(db, source, kind, metric)` becomes
  `return writeAuthority(db)(source, kind, metric);`. Keep its doc comment, and add one
  sentence: "Own-scope claims coexist (R1); an exclusive claim still excludes everyone
  else." Delete `authorityLookup` and `declares`.

- [ ] **Step 4: `lib/adapters/claude/index.ts`.** Add `scope: "own"` to both claims. Add one
  line to the comment above them: "Own-scope (Stage 5 R1): Claude owns these metrics on its
  own rows, so Codex and Hermes may own theirs."

- [ ] **Step 5: `lib/core/ingest.ts`.**
  - Import `writeAuthority` instead of `authorityLookup`.
  - `RunTotals.owner` becomes `may: (source: string, kind: RecordKind, metric: string) => boolean`,
    built as `may: writeAuthority(db)`.
  - In `ingestChunk`, the check becomes `if (run.may(source, r.kind, metric)) accepted[metric] = value; else rejected++;`.

  Append:

```ts
/**
 * Add source-side malformed lines -- ones that never became records, such as a
 * complete Codex line that is not JSON -- to the state the run just wrote. The
 * run is degraded. last_ok_at is left alone: every record that did parse was
 * written, so "data as of" stays true.
 */
export function addMalformed(db: string, source: string, n: number, detail?: string): void {
  if (n <= 0) return;
  execSql(db, `UPDATE wt_ingest_state SET
      records_malformed = records_malformed + ${sqlNum(n)},
      health = 'degraded',
      last_error = COALESCE(${sqlStr(detail ?? null)}, last_error)
    WHERE source = ${sqlStr(source)};`);
}

/**
 * A run that threw before it finished. It is degraded, with the reason, and
 * nothing else changes: a run that never completed has no counters to add, and
 * last_ok_at keeps the last run that did.
 */
export function recordRunFailure(db: string, source: string, error: string): void {
  execSql(db, `INSERT INTO wt_ingest_state (source, last_run_at, health, last_error)
    VALUES (${sqlStr(source)}, ${sqlNum(Math.floor(Date.now() / 1000))}, 'degraded',
            ${sqlStr(error.slice(0, 2000))})
    ON CONFLICT(source) DO UPDATE SET
      last_run_at = excluded.last_run_at,
      health      = 'degraded',
      last_error  = excluded.last_error;`);
}
```

- [ ] **Step 6: `lib/core/sql.ts`.**
  - `pagedRows` gains a fourth parameter `opts: { readonly?: boolean } = {}`, passed through
    to `querySql`.
  - Append:

```ts
/**
 * One legible line from a failed call: sqlite3's own complaint when there is one
 * (the child's stderr), else the first line of the message. Rendered next to a
 * source name, so it has to fit on a line.
 */
export function errorLine(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | null;
  const stderr = String(err?.stderr ?? "").trim();
  if (stderr !== "") return stderr.split("\n").filter((l) => l.trim() !== "").pop() ?? stderr;
  return String(err?.message ?? e).split("\n")[0];
}
```

- [ ] **Step 7: `lib/core/sync.ts`.**
  - Add `error?: string` to `SourceSummary`, with the doc comment "Set when the source was
    detected and its run threw. The other sources are unaffected (R17)."
  - Import `addMalformed` and `recordRunFailure` from `./ingest.ts`, and `errorLine` from
    `./sql.ts`.
  - Replace the loop body after `if (!detected) …` with:

```ts
    // ISOLATED. One source failing -- Hermes's state.db mid-write, a corrupt
    // registry row -- is recorded against that source and the sweep goes on.
    // The destination is still loud: applyWtSchema above throws on a bad DB.
    try {
      registerSource(opts.db, adapter);
      const res = await ingestRecordsStream(
        opts.db, adapter.id, adapter.ingest(), opts.chunkSize);
      const extra = adapter.finish?.({ clean: res.malformed === 0 }) ?? { malformed: 0 };
      addMalformed(opts.db, adapter.id, extra.malformed, extra.detail);
      out.push({
        source: adapter.id, detected: true, detail,
        ingested: res.ingested, unchanged: res.unchanged,
        metricsRejected: res.metricsRejected, malformed: res.malformed + extra.malformed,
      });
    } catch (e) {
      const error = errorLine(e);
      recordRunFailure(opts.db, adapter.id, error);
      out.push({ ...skipped(adapter.id, detail), detected: true, error });
    }
```

  Keep the long doc comment. Add one paragraph: "Each adapter runs in its own try/catch
  (Stage 5 R17): a source that throws is marked degraded and reported with `error`, and the
  others still run."

- [ ] **Step 8: `lib/core/records.ts`.**
  - Move `epochToRfc3339`, with its doc comment, here from
    `lib/adapters/claude/records.ts`.
  - In the Claude file, replace it with
    `export { epochToRfc3339 } from "../../core/records.ts";` and add `epochToRfc3339` to
    that file's existing import from `../../core/records.ts`.

- [ ] **Step 9: `lib/core/schema.ts`.**
  - `WT_SCHEMA_VERSION = 3`.
  - In the `wt_sessions` DDL, after `agent TEXT, model TEXT,`, add the line
    `cwd TEXT, entry TEXT, driven INTEGER,   -- Stage 5: raw cwd, entry point, 1|0|NULL (unclassified)`.
  - Append to the DDL:

```sql
-- ADVISORY, like claude_ingest_cursor: a file whose size and mtime are unchanged
-- is skipped. Correctness comes from the primary keys; deleting these rows costs
-- one slow sync and nothing else. mtime_ns is TEXT: nanoseconds overflow a double.
CREATE TABLE IF NOT EXISTS wt_file_cursor (
  source   TEXT NOT NULL,
  path     TEXT NOT NULL,
  size     INTEGER NOT NULL,
  mtime_ns TEXT NOT NULL,
  PRIMARY KEY (source, path)
);

-- The rollup's agent section walks events and requests per canonical session.
CREATE INDEX IF NOT EXISTS idx_wt_events_canonical ON wt_events(canonical_id, ts);
CREATE INDEX IF NOT EXISTS idx_wt_requests_canonical ON wt_requests(canonical_id);
```

  - Add the exported list and the guarded ALTER loop in `applyWtSchema`, after
    `execSql(dbPath, wtSchemaSql())` and before the marker is written:

```ts
/**
 * Columns added to an EXISTING wt_* table after it first shipped. CREATE TABLE
 * IF NOT EXISTS never alters a table, so a v2 database needs these ALTERed in;
 * each is guarded by pragma_table_info, so a fresh v3 database skips them all.
 */
export const WT_ADDED_COLUMNS: readonly (readonly [table: string, column: string, type: string])[] = [
  ["wt_sessions", "cwd", "TEXT"],
  ["wt_sessions", "entry", "TEXT"],
  ["wt_sessions", "driven", "INTEGER"],
];
```

```ts
  for (const [table, column, type] of WT_ADDED_COLUMNS) {
    const has = querySql<{ n: number }>(dbPath,
      `SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = '${column}';`)[0].n;
    if (has === 0) execSql(dbPath, `ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
```

  Import `querySql` from `./sql.ts`. Update the version comment: v3 adds `wt_sessions.cwd`,
  `entry` and `driven`, plus `wt_file_cursor`.

- [ ] **Step 10: `lib/core/identity.ts`.** Append:

```ts
/**
 * An AGENT source's session (Codex, Hermes). Unlike upsertSessionSql:
 *
 *  - started_at is the MIN and ended_at the MAX of every observation, because a
 *    resumed Codex session arrives as a second file that may be read first;
 *  - cwd and entry take the newest value present;
 *  - driven is written as given, NULL included: it is a classification from
 *    config, and finish() re-derives it from entry for every session (R18);
 *  - model is fill-if-missing, like upsertSessionSql.
 */
export interface AgentSessionUpsert {
  canonicalId: string;
  source: string;
  startedAt?: number;
  endedAt?: number;
  cwd?: string;
  entry?: string;
  driven: 0 | 1 | null;
  repo?: string;
  branch?: string;
  model?: string;
}

export function agentSessionSql(a: AgentSessionUpsert): string {
  return `INSERT INTO wt_sessions
      (canonical_id, first_source, started_at, ended_at, repo, branch, model,
       cwd, entry, driven, updated_at)
    VALUES (${sqlStr(a.canonicalId)}, ${sqlStr(a.source)}, ${sqlNum(a.startedAt)},
            ${sqlNum(a.endedAt)}, ${sqlStr(a.repo)}, ${sqlStr(a.branch)},
            ${sqlStr(a.model)}, ${sqlStr(a.cwd)}, ${sqlStr(a.entry)},
            ${a.driven === null ? "NULL" : sqlNum(a.driven)},
            ${sqlNum(Math.floor(Date.now() / 1000))})
    ON CONFLICT(canonical_id) DO UPDATE SET
      started_at = MIN(COALESCE(wt_sessions.started_at, excluded.started_at),
                       COALESCE(excluded.started_at, wt_sessions.started_at)),
      ended_at   = MAX(COALESCE(wt_sessions.ended_at, excluded.ended_at),
                       COALESCE(excluded.ended_at, wt_sessions.ended_at)),
      repo       = COALESCE(excluded.repo, wt_sessions.repo),
      branch     = COALESCE(excluded.branch, wt_sessions.branch),
      model      = COALESCE(wt_sessions.model, excluded.model),
      cwd        = COALESCE(excluded.cwd, wt_sessions.cwd),
      entry      = COALESCE(excluded.entry, wt_sessions.entry),
      driven     = excluded.driven,
      updated_at = excluded.updated_at;`;
}
```

- [ ] **Step 11: `lib/core/cursor.ts`.**

```ts
import { statSync } from "node:fs";
import { querySql, sqlNum, sqlStr } from "./sql.ts";

/**
 * A file's size and mtime, as wt_file_cursor stores them. ADVISORY: a match
 * lets sync skip the file, and correctness never depends on it.
 */
export interface FileStamp { size: number; mtimeNs: string }

export function stampOf(p: string): FileStamp {
  const st = statSync(p, { bigint: true });
  return { size: Number(st.size), mtimeNs: st.mtimeNs.toString() };
}

export function unchanged(prev: FileStamp | undefined, now: FileStamp): boolean {
  return prev !== undefined && prev.size === now.size && prev.mtimeNs === now.mtimeNs;
}

export function readFileCursor(db: string, source: string): Map<string, FileStamp> {
  const rows = querySql<{ path: string; size: number; mtime_ns: string }>(db,
    `SELECT path, size, mtime_ns FROM wt_file_cursor WHERE source = ${sqlStr(source)};`);
  return new Map(rows.map((r) => [r.path, { size: r.size, mtimeNs: String(r.mtime_ns) }]));
}

export function fileCursorSql(source: string, path: string, s: FileStamp): string {
  return `INSERT INTO wt_file_cursor (source, path, size, mtime_ns)
    VALUES (${sqlStr(source)}, ${sqlStr(path)}, ${sqlNum(s.size)}, ${sqlStr(s.mtimeNs)})
    ON CONFLICT(source, path) DO UPDATE SET
      size = excluded.size, mtime_ns = excluded.mtime_ns;`;
}
```

- [ ] **Step 12: `lib/adapters/entry.ts`.**

```ts
import { sqlStr } from "../core/sql.ts";

/**
 * Which entry points count as a person driving the tool (spec decision 7).
 * Lists come from lib/config.ts; nothing here knows a tool's defaults.
 */
export interface EntryLists { driven: readonly string[]; automated: readonly string[] }

/** 1 driven, 0 automated, null unclassified. A spawned subagent is always automated (R2). */
export function classifyEntry(entry: string | null | undefined, lists: EntryLists): 0 | 1 | null {
  if (entry === null || entry === undefined) return null;
  if (entry.startsWith("subagent:")) return 0;
  if (lists.driven.includes(entry)) return 1;
  if (lists.automated.includes(entry)) return 0;
  return null;
}

const inList = (xs: readonly string[]) => (xs.length === 0 ? "(NULL)" : `(${xs.map(sqlStr).join(", ")})`);

/**
 * classifyEntry for EVERY stored session of a source, as one UPDATE (R18), so a
 * config change reaches sessions in files the cursor skips. It must agree with
 * classifyEntry exactly; tests/adapter-entry.test.ts runs both over one table.
 */
export function reclassifySql(source: string, lists: EntryLists): string {
  return `UPDATE wt_sessions SET driven = CASE
      WHEN entry IS NULL               THEN NULL
      WHEN entry LIKE 'subagent:%'     THEN 0
      WHEN entry IN ${inList(lists.driven)}    THEN 1
      WHEN entry IN ${inList(lists.automated)} THEN 0
      ELSE NULL END
    WHERE first_source = ${sqlStr(source)};`;
}
```

  Add one more test to `adapter-entry.test.ts`:
  - Insert sessions with entries `cli`, `api_server`, `other`, `subagent:x` and NULL.
  - Run `reclassifySql`.
  - Assert each stored `driven` equals `classifyEntry` of its entry.

- [ ] **Step 13: Run the tests, then the suite.**

  Run: `npx vitest run tests/core-adapters.test.ts tests/core-schema.test.ts tests/core-identity.test.ts tests/core-sync.test.ts tests/core-sql.test.ts tests/core-cursor.test.ts tests/adapter-entry.test.ts tests/claude-adapter.test.ts && npm test && npm run typecheck`

  Expected: PASS, and the whole suite green. A test that pins `wt_sessions`' exact column
  list or `.wt-schema-v2` gets the new columns or v3.

- [ ] **Step 14: Commit.**

```bash
git add lib/core lib/adapters/entry.ts lib/adapters/claude tests
git commit -m "feat(core): own-scope authority, wt schema v3, per-adapter sync isolation"
```

---

### Task 2: Codex adapter, config, `adaptersFor`

**Files:**
- Create:
  - `lib/adapters/codex/parse.ts`;
  - `lib/adapters/codex/index.ts`;
  - `lib/adapters/index.ts`;
  - `tests/fixtures/make-codex-logs.sh` (mode 755);
  - `tests/codex-adapter.test.ts`;
  - `tests/codex-parse.test.ts`.
- Modify:
  - `lib/config.ts`;
  - `bin/watchtower`: the sync block;
  - `tests/config.test.ts`;
  - `tests/core-sync.test.ts`: the CLI tests get a temp `HOME`.

**Interfaces:**
- Consumes everything Task 1 produces.
- Produces:
  - `parseRollout(text, fileStem): ParsedRollout`, with `RolloutSession`, `normalise` and
    `subagentOf`;
  - `CODEX_SOURCE = "codex"`;
  - `listRollouts(home): string[]`;
  - `createCodexAdapter({ db, home?, lists }): WatchtowerAdapter`;
  - `adaptersFor(cfg, { home? }): WatchtowerAdapter[]`;
  - from config: `CODEX_DRIVEN`, `CODEX_AUTOMATED`, `HERMES_DRIVEN`, `HERMES_AUTOMATED`,
    `MIN_SYNC_SECONDS`, `entryLists(id, sc)`, `SourceConfig.driven/automated` and
    `DashboardConfig.syncSeconds`.

- [ ] **Step 1: The fixture script** `tests/fixtures/make-codex-logs.sh`. Build every line with
  `jq -nc`, so the quoting is jq's. Times use `($t|tonumber|todate)`; never pass a bare
  number to `--argjson`, because that broke in planning.

```bash
#!/usr/bin/env bash
# Codex rollout logs for the adapter and rollup tests.
#   make-codex-logs.sh <scenario> <codex_home>
# Scenarios and every expected number: docs/superpowers/plans/2026-10-03-stage-5-agents-and-levels.md,
# "Fixture reference". WT_CODEX_CWD sets the driven sessions' cwd (default /tmp/wt-codex-repo).
set -euo pipefail
SCEN="$1"; H="$2"
T0=1789466400
CWD="${WT_CODEX_CWD:-/tmp/wt-codex-repo}"

# line <file> <epoch> <type> <payload-json>
line() {
  mkdir -p "$(dirname "$1")"
  jq -nc --arg t "$2" --arg ty "$3" --argjson p "$4" \
    '{timestamp: ($t|tonumber|todate), type: $ty, payload: $p}' >> "$1"
}
# meta <file> <epoch> <id> <originator> <cwd-or-empty> [extra-json merged into payload]
meta() {
  local extra="${6:-}"; [ -n "$extra" ] || extra='{}'
  line "$1" "$2" session_meta "$(jq -nc --arg id "$3" --arg o "$4" --arg cwd "$5" --arg t "$2" --argjson x "$extra" \
    '{id:$id, timestamp:($t|tonumber|todate), originator:$o, cli_version:"0.99.0", source:"vscode"}
     + (if $cwd == "" then {} else {cwd:$cwd} end) + $x')"
}
ctx()  { line "$1" "$2" turn_context "$(jq -nc --arg m "$3" '{model:$m}')"; }
ev()   { line "$1" "$2" event_msg "$(jq -nc --arg ty "$3" '{type:$ty}')"; }
# usage <in> <cached> <write> <out> <reasoning> -> usage object, total = in + out
usage() {
  jq -nc --arg i "$1" --arg c "$2" --arg w "$3" --arg o "$4" --arg r "$5" \
    '{input_tokens:($i|tonumber), cached_input_tokens:($c|tonumber),
      cache_write_input_tokens:($w|tonumber), output_tokens:($o|tonumber),
      reasoning_output_tokens:($r|tonumber), total_tokens:(($i|tonumber)+($o|tonumber))}'
}
# tur_json <epoch> <response_id> <in> <cached> <write> <out> <reasoning> -> one whole line
tur_json() {
  local u; u="$(usage "$3" "$4" "$5" "$6" "$7")"
  jq -nc --arg t "$1" --arg r "$2" --argjson u "$u" \
    '{timestamp: ($t|tonumber|todate), type: "token_usage_record",
      payload: {response_id:$r, usage:$u, thread_id:"t", turn_id:"u"}}'
}
tur()    { mkdir -p "$(dirname "$1")"; tur_json "$2" "$3" "$4" "$5" "$6" "$7" "$8" >> "$1"; }
# tcount <file> <epoch> <in> <cached> <write> <out> <reasoning>: a CUMULATIVE total
tcount() {
  local u; u="$(usage "$3" "$4" "$5" "$6" "$7")"
  line "$1" "$2" event_msg "$(jq -nc --argjson u "$u" \
    '{type:"token_count", info:{total_token_usage:$u, last_token_usage:$u, model_context_window:258400}}')"
}
user_msg() { line "$1" "$2" response_item '{"type":"message","role":"user","content":[{"type":"input_text","text":"SECRET-PROMPT"}]}'; }
asst_msg() { line "$1" "$2" response_item '{"type":"message","role":"assistant","content":[{"type":"output_text","text":"SECRET-ANSWER"}]}'; }
reasoning() { line "$1" "$2" response_item '{"type":"reasoning","encrypted_content":"SECRET-REASONING"}'; }
done_msg() { line "$1" "$2" event_msg '{"type":"task_complete","last_agent_message":"SECRET-ANSWER"}'; }

S="$H/.codex/sessions"; A="$H/.codex/archived_sessions"
case "$SCEN" in
  core)
    f="$S/2026/09/15/rollout-2026-09-15T10-00-00-codex-s1.jsonl"
    meta "$f" $T0 codex-s1 "Codex Desktop" "$CWD" \
      '{"git":{"branch":"main","repository_url":"https://example.invalid/r.git"},"base_instructions":{"text":"SECRET-BASE"}}'
    ctx "$f" $T0 gpt-5.5
    ev "$f" $((T0+20)) thread_settings_applied
    ev "$f" $((T0+22)) task_started
    user_msg "$f" $((T0+30))
    reasoning "$f" $((T0+60))
    tur "$f" $((T0+70)) resp_s1_a 1000 400 0 200 20
    tcount "$f" $((T0+70)) 1000 400 0 200 20
    done_msg "$f" $((T0+90))
    ev "$f" $((T0+190)) thread_settings_applied
    ev "$f" $((T0+195)) task_started
    tur "$f" $((T0+215)) resp_s1_b 2000 1500 0 300 30
    tcount "$f" $((T0+215)) 3000 1900 0 500 50
    asst_msg "$f" $((T0+220))
    ev "$f" $((T0+220)) task_complete

    f="$S/2026/09/15/rollout-2026-09-15T10-05-00-codex-s8.jsonl"; t=$((T0+300))
    meta "$f" $t codex-s8 "Codex Desktop" "" \
      '{"source":{"subagent":{"thread_spawn":{"parent_thread_id":"codex-s1","depth":1,"agent_role":"worker"}}}}'
    meta "$f" $t codex-s1 "Codex Desktop" "$CWD"
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+1)) task_started
    tur "$f" $((t+20)) resp_s8_a 400 0 0 40 0
    ev "$f" $((t+30)) task_complete

    f="$S/2026/09/15/rollout-2026-09-15T10-16-40-codex-s2.jsonl"; t=$((T0+1000))
    meta "$f" $t codex-s2 codex_exec /tmp/wt-codex-exec
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+1)) task_started
    tur "$f" $((t+10)) resp_s2_a 500 0 0 100 0
    ctx "$f" $((t+11)) gpt-9-imaginary
    tur "$f" $((t+20)) resp_s2_b 50 0 0 5 0
    ev "$f" $((t+30)) task_complete

    f="$S/2026/09/15/rollout-2026-09-15T10-33-20-codex-s3.jsonl"; t=$((T0+2000))
    meta "$f" $t codex-s3 mystery-client /tmp/wt-codex-mystery
    ctx "$f" $t codex-auto-review
    ev "$f" $((t+1)) task_started
    tur "$f" $((t+10)) resp_s3_a 300 100 0 50 0
    ev "$f" $((t+20)) task_complete

    f="$S/2026/09/16/rollout-2026-09-16T09-00-00-codex-s4.jsonl"; t=1789549200
    meta "$f" $t codex-s4 codex-tui "$CWD"
    ctx "$f" $t gpt-5.2
    ev "$f" $((t+5)) task_started
    tcount "$f" $((t+30)) 1000 600 0 100 10
    tcount "$f" $((t+30)) 1000 600 0 100 10
    line "$f" $((t+40)) event_msg '{"type":"token_count","info":null}'
    tcount "$f" $((t+60)) 2500 1200 0 250 30
    ev "$f" $((t+95)) task_complete

    f="$A/rollout-2026-09-14T08-00-00-codex-s6.jsonl"; t=1789372800
    meta "$f" $t codex-s6 codex_vscode "$CWD"
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+5)) task_started
    tur "$f" $((t+10)) resp_s6_a 100 0 0 10 0
    ev "$f" $((t+15)) task_complete
    ;;
  resume)
    f="$S/2026/09/15/rollout-2026-09-15T14-00-00-codex-s5.jsonl"; t=1789480800
    meta "$f" $t codex-s5 "Codex Desktop" "$CWD"
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+2)) task_started
    tur "$f" $((t+10)) resp_s5_a 100 0 0 10 0
    ev "$f" $((t+12)) task_complete
    f="$S/2026/09/18/rollout-2026-09-18T09-00-00-codex-s5b.jsonl"; t=1789722000
    meta "$f" $t codex-s5 "Codex Desktop" "$CWD"
    ev "$f" $((t+5)) task_started
    tur "$f" $((t+15)) resp_s5_b 100 0 0 10 0
    ev "$f" $((t+25)) task_complete
    ;;
  partial|partial-complete)
    f="$S/2026/09/15/rollout-2026-09-15T11-23-20-codex-s10.jsonl"; t=$((T0+5000))
    full="$(tur_json $((t+9)) resp_s10_b 100 0 0 10 0)"
    if [ "$SCEN" = partial ]; then
      meta "$f" $t codex-s10 "Codex Desktop" "$CWD"
      ev "$f" $((t+1)) task_started
      tur "$f" $((t+5)) resp_s10_a 100 0 0 10 0
      printf '%s' "${full:0:40}" >> "$f"
      g="$S/2026/09/15/rollout-2026-09-15T11-40-00-codex-s11.jsonl"; u=$((T0+6000))
      meta "$g" $u codex-s11 "Codex Desktop" "$CWD"
      printf 'not json at all\n' >> "$g"
      ev "$g" $((u+3)) task_complete
    else
      printf '%s\n' "${full:40}" >> "$f"
      ev "$f" $((t+12)) task_complete
    fi
    ;;
  midnight)
    f="$S/2026/09/20/rollout-2026-09-20T23-58-00-codex-s9.jsonl"; t=1789948680
    meta "$f" $t codex-s9 "Codex Desktop" "$CWD"
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+10)) task_started
    tur "$f" $((t+60)) resp_s9_a 100 0 0 10 0
    asst_msg "$f" $((t+150))
    tur "$f" $((t+170)) resp_s9_b 200 0 0 10 0
    ev "$f" $((t+190)) task_complete
    ;;
  dup|dup-b-only)
    if [ "$SCEN" = dup ]; then
      f="$S/2026/09/15/rollout-2026-09-15T15-00-00-codex-da.jsonl"; t=$((T0+18000))
      meta "$f" $t codex-da "Codex Desktop" "$CWD"; ev "$f" $((t+1)) task_started
      tur "$f" $((t+5)) resp_dup 100 0 0 10 0; ev "$f" $((t+9)) task_complete
    fi
    f="$S/2026/09/15/rollout-2026-09-15T16-00-00-codex-db.jsonl"
    if [ ! -f "$f" ]; then
      t=$((T0+21600))
      meta "$f" $t codex-db "Codex Desktop" "$CWD"; ev "$f" $((t+1)) task_started
      tur "$f" $((t+5)) resp_dup 100 0 0 10 0; ev "$f" $((t+9)) task_complete
    fi
    ;;
  early)
    f="$S/2024/01/01/rollout-2024-01-01T00-00-00-codex-s7.jsonl"; t=1704067200
    meta "$f" $t codex-s7 "Codex Desktop" "$CWD"
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+1)) task_started
    tur "$f" $((t+5)) resp_s7_a 100 0 0 10 0
    ev "$f" $((t+9)) task_complete
    ;;
  *) echo "make-codex-logs.sh: unknown scenario $SCEN" >&2; exit 2 ;;
esac
```

  Check: `bash -n tests/fixtures/make-codex-logs.sh`. Running `core` into a temp dir and then
  `wc -l` on the S1 file gives 15.

- [ ] **Step 2: Write the failing tests.**

  `tests/codex-parse.test.ts` (pure, no DB):
  1. **S1 events.** Use `parseRollout(readFileSync(S1), "rollout-2026-09-15T10-00-00-codex-s1")`
     on a `core` home.
     - `[seq, event]` of the event records equals
       `[[1,"session_start"],[3,"activity"],[4,"prompt"],[5,"activity"],[6,"activity"],[7,"activity"],[9,"stop"],[10,"activity"],[11,"prompt"],[12,"activity"],[14,"activity"],[15,"stop"]]`.
       This pins R3 (lines 3 and 10 are activity) and R6.
     - The session is `{ id:"codex-s1", entry:"Codex Desktop", cwd, branch:"main",
       repo:"https://example.invalid/r.git", model:"gpt-5.5", startedAt:T0,
       endedAt:T0+220, subagent:false }`.
     - `malformed: 0`, `partialTail: false`.
  2. **A later meta** (inline text):
     - a meta for `x` at t;
     - a meta for `y` at t+5, which is `activity`;
     - a meta for `x` at t+10, which is `session_start`;
     - the session id is `x`.
  3. **`subagentOf`:**

     | input | result |
     |---|---|
     | `{subagent:{thread_spawn:{}}}` | `"subagent:thread_spawn"` |
     | `{subagent:{other:"guardian"}}` | `"subagent:guardian"` |
     | `"vscode"` | `undefined` |
     | `{subagent:"review"}` | `"subagent:review"` |

  4. **`normalise`:**
     - `{input_tokens:1000,cached_input_tokens:400,output_tokens:200,reasoning_output_tokens:20}`
       gives `{tokens_in:600,tokens_cache_read:400,tokens_cache_creation:0,tokens_out:200,reasoning_tokens:20}`.
     - `{input_tokens:10,cached_input_tokens:20}` throws `cache counts exceed input_tokens`.
  5. **No session_meta:** `parseRollout('{"timestamp":"2026-09-15T10:00:00Z","type":"event_msg","payload":{"type":"task_started"}}\n', "x")`
     gives `{ session:null, records:[], malformed:0, partialTail:false }`.
  6. **Partial vs malformed:**
     - text `META\nnot json\n{"timest` gives `malformed 1`, `partialTail true`;
     - text `META\n{"timest\n` gives `malformed 1`, `partialTail false`: a complete line
       that does not parse.

  `tests/codex-adapter.test.ts`:
  - Helpers:
    - `codexHome(...scenarios)`: `mkdtempSync`, then `execFileSync("bash",
      [MAKE_CODEX, s, home], { env: {...process.env, WT_CODEX_CWD: CWD} })` per scenario;
    - `freshDb()`: its own `mkdtemp` dir, then `applyWtSchema`;
    - `sync(db, home, lists = entryLists("codex", undefined))`, which returns
      `runSync({ db, adapters: [createCodexAdapter({ db, home, lists })] })`.
  - `CWD` is a `mkdtemp` dir, so it exists. `TZ` does not matter here.

  Tests:
  1. **"S1 normalised tokens"** (guard 2) asserts **only**
     `SELECT source_record_id, tokens_in, tokens_cache_read FROM wt_requests WHERE source_record_id IN ('resp_s1_a','resp_s1_b') ORDER BY 1`
     equals `[["resp_s1_a",600,400],["resp_s1_b",500,1500]]`.
  2. **"reasoning stays out of tokens_out"** (guard 3) asserts **only** that `tokens_out` is
     200 and 300, and that `wt_usage` `reasoning_tokens` is 20 and 30 for the same ids.
  3. **"S4 token_count deltas"** (guard 1) asserts **only** that the S4 rows are exactly
     `codex-s4:1100` and `codex-s4:2750`, with `tokens_cache_read` 600 and 600. Neither the
     repeated total nor the `info:null` line makes a row.
  4. **"requests carry the model in effect":** `resp_s2_a` is `gpt-5.5` and `resp_s2_b` is
     `gpt-9-imaginary`.
  5. **"classifies entry points":** `SELECT entry, driven FROM wt_sessions … ORDER BY entry`
     gives:

     | entry | driven |
     |---|---|
     | `Codex Desktop` (s1) | 1 |
     | `codex-tui` | 1 |
     | `codex_exec` | 0 |
     | `codex_vscode` | 1 |
     | `mystery-client` | null |
     | `subagent:thread_spawn` | 0 |

     There are 6 sessions, and S8 is one session (its parent copy made none).
  6. **"reclassification reaches skipped files"** (R18):
     - sync;
     - sync again with `{driven:[...CODEX_DRIVEN,"mystery-client","subagent:thread_spawn"], automated:[...CODEX_AUTOMATED]}`;
     - S3 is now 1 and S8 is still 0;
     - the second run's summary is `ingested 0`, so every file was skipped.
  7. **"the cursor skips unchanged files and is advisory":**
     - The second sync reports `ingested 0, unchanged 0`, and `wt_file_cursor` holds 6 rows.
     - Then `DELETE FROM wt_file_cursor`.
     - The third sync reports `ingested 0` and `unchanged > 0`: fingerprints catch it.
  8. **RF1 "a resume in a later folder is one session":** on the `resume` home:
     - one `wt_sessions` row with `started_at 1789480800` and `ended_at 1789722025`;
     - every `wt_events` row shares its canonical;
     - the event at `rollout-2026-09-18T09-00-00-codex-s5b:1` is `session_start`.
  9. **RF2 "a line being written is read next time":** on the `partial` home:
     - First sync:
       - `malformed 1` (S11's non-JSON line);
       - `resp_s10_a` present and `resp_s10_b` absent;
       - `wt_file_cursor` has S11 and not S10.
     - Run `partial-complete` into the same home, then sync again:
       - `malformed 0`, `resp_s10_b` present, S10 now in the cursor;
       - `wt_ingest_state.health = 'ok'`, `records_malformed = 1` (cumulative, counted once).
  10. **RF5 "first arrival wins a response_id":**
      - On a `dup` home: one sync gives one `resp_dup` row, whose `canonical_id` is the one
        `wt_links` maps `codex-da` to.
      - On a fresh DB: sync `dup-b-only`, run `dup` into the same home, and sync again. The
        row's canonical is `codex-db`'s.
  11. **"a deleted log keeps its rows"** (guard 9):
      - sync `core`;
      - `rmSync` the S6 file;
      - sync;
      - `resp_s6_a`, the `codex-s6` session and its 4 events are still present.
  12. **"copies no content"** (guard 10):
      - sync `core`;
      - for every table `LIKE 'wt_%'` in `sqlite_master`, `SELECT *`;
      - `JSON.stringify` of all rows does not contain `SECRET`.
  13. **"not detected without logs":** `createCodexAdapter({db, home: emptyTmp, lists}).detect()`
      gives `detected:false`. `runSync` reports it skipped and writes no `wt_sources` row.

  `tests/config.test.ts`:
  - The defaults test becomes "defaults to all five sources, Claude enabled". Assert
    `Object.keys(cfg.sources)` equals `["claude","codex","hermes","openviking","atlas"]`,
    `cfg.sources.codex.driven` equals `CODEX_DRIVEN`, and `cfg.dashboard.syncSeconds` is 300.
  - A config file with `sources: {codex: {enabled:true}}` yields `claude` (added back) and
    `codex`, and no `hermes`.
  - `sources.codex.driven: "x"` throws `Invalid sources.codex.driven`.
  - `dashboard.syncSeconds: 30` throws `expected 0 (off) or an integer number of seconds >= 60`.
    The value `0` is accepted.
  - `WATCHTOWER_SYNC_SECONDS=0` overrides, and `=abc` throws `Invalid WATCHTOWER_SYNC_SECONDS`.
  - `entryLists("hermes", undefined)` gives the Hermes defaults.
    `entryLists("codex", {enabled:true,type:"codex",driven:["a"]})` gives `driven ["a"]` and
    the default `automated`.

  `tests/core-sync.test.ts` (CLI block): every `execFileSync(… "bin/watchtower" …)` env gains
  `HOME: <mkdtemp>`. The brand-new-DB test asserts on
  `parsed.sources.find((s) => s.source === "claude")` instead of `sources.length === 1`.

- [ ] **Step 3: Run them and watch them fail.**

  Run: `npx vitest run tests/codex-parse.test.ts tests/codex-adapter.test.ts tests/config.test.ts`

  Expected: FAIL on missing modules and exports.

- [ ] **Step 4: `lib/adapters/codex/parse.ts`.**

```ts
/**
 * One Codex rollout file -> its session and its records. PURE: text in, values
 * out, no I/O, so every rule is testable without a filesystem.
 *
 * Read: timestamps, line and payload types, the session's id, cwd, originator,
 * source and git branch/url, turn_context.model, and token usage. NEVER copied
 * into a record: message text, reasoning, base_instructions, last_agent_message
 * (spec §3: a passive observer copies no content).
 */
import { epochToRfc3339, type WatchtowerRecord } from "../../core/records.ts";

export const CODEX_SOURCE = "codex";

export interface RolloutSession {
  id: string;
  startedAt: number;
  endedAt: number;
  cwd?: string;
  /** The originator, or `subagent:<kind>` for a spawned agent (R2). */
  entry?: string;
  subagent: boolean;
  branch?: string;
  repo?: string;
  model?: string;
}

export interface ParsedRollout {
  /** Null when the file has no session_meta: skipped, not malformed. */
  session: RolloutSession | null;
  records: WatchtowerRecord[];
  /** Complete lines that are not JSON objects, and usage that normalises negative. */
  malformed: number;
  /** The last line has no newline and does not parse: it is being written now (R17). */
  partialTail: boolean;
}

type Usage = Record<string, unknown>;
export interface CodexTokens {
  tokens_in: number; tokens_cache_read: number; tokens_cache_creation: number;
  tokens_out: number; reasoning_tokens: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Codex's input_tokens INCLUDES both cache counts; Claude's tokens_in does not.
 * output_tokens already includes reasoning, which is kept as its own metric and
 * never added again (spec §3.2, R16).
 */
export function normalise(u: Usage): CodexTokens {
  const input = n(u.input_tokens), cached = n(u.cached_input_tokens), write = n(u.cache_write_input_tokens);
  const tokensIn = input - cached - write;
  if (tokensIn < 0) throw new Error(`cache counts exceed input_tokens (${cached} + ${write} > ${input})`);
  return {
    tokens_in: tokensIn, tokens_cache_read: cached, tokens_cache_creation: write,
    tokens_out: n(u.output_tokens), reasoning_tokens: n(u.reasoning_output_tokens),
  };
}

const FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens",
  "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;

/** a − b per field: one response's usage out of two running totals (b null = from zero). */
function minus(a: Usage, b: Usage | null): Usage {
  const out: Usage = {};
  for (const f of FIELDS) out[f] = n(a[f]) - (b === null ? 0 : n(b[f]));
  return out;
}

/** R2: a spawned agent's entry point, or undefined when the source is not a subagent. */
export function subagentOf(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null || !("subagent" in source)) return undefined;
  const s = (source as { subagent: unknown }).subagent;
  if (typeof s === "string") return `subagent:${s}`;
  if (typeof s !== "object" || s === null) return "subagent:unknown";
  const key = Object.keys(s)[0];
  if (key === undefined) return "subagent:unknown";
  const v = (s as Record<string, unknown>)[key];
  return key === "other" && typeof v === "string" ? `subagent:${v}` : `subagent:${key}`;
}

type Ev = "session_start" | "prompt" | "stop" | "activity";
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export function parseRollout(text: string, fileStem: string): ParsedRollout {
  const raw = text.split("\n");
  const open = !text.endsWith("\n");
  const lines: { no: number; o: Record<string, unknown> }[] = [];
  let malformed = 0;
  let partialTail = false;
  raw.forEach((s, i) => {
    if (s.trim() === "") return;
    try {
      const o: unknown = JSON.parse(s);
      if (typeof o === "object" && o !== null && !Array.isArray(o)) lines.push({ no: i + 1, o: o as Record<string, unknown> });
      else malformed++;
    } catch {
      if (open && i === raw.length - 1) partialTail = true;
      else malformed++;
    }
  });

  const first = lines.find((l) => l.o.type === "session_meta");
  const meta = (first?.o.payload ?? null) as Record<string, unknown> | null;
  if (first === undefined || meta === null || typeof meta.id !== "string") {
    return { session: null, records: [], malformed, partialTail };
  }
  const sid = meta.id;
  const sub = subagentOf(meta.source);
  const git = (meta.git ?? null) as Record<string, unknown> | null;
  const session: RolloutSession = {
    id: sid, startedAt: 0, endedAt: 0, subagent: sub !== undefined,
    entry: sub ?? str(meta.originator), cwd: str(meta.cwd),
    branch: str(git?.branch), repo: str(git?.repository_url),
  };

  const records: WatchtowerRecord[] = [];
  let lastSec: number | null = null;
  let model: string | undefined;
  let sawUsageRecord = false;
  let prevTotal: Usage | null = null;
  const request = (id: string, sec: number, t: CodexTokens): WatchtowerRecord => ({
    source: CODEX_SOURCE, sourceRecordId: id, kind: "request",
    timestamp: epochToRfc3339(sec), sessionId: sid, model, metrics: { ...t },
  });

  for (const { no, o } of lines) {
    if (no < first.no) continue;
    const ms = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (!Number.isFinite(ms)) continue;            // R17: no timestamp, no event
    const sec = Math.floor(ms / 1000);
    const p = (o.payload ?? {}) as Record<string, unknown>;
    let event: Ev = "activity";

    if (o.type === "session_meta") {
      // The file's own id again is a resume re-append; another id is a parent's
      // meta copied into a subagent's file, which is just a timestamped line (R2).
      if (p.id === sid) event = "session_start";
    } else if (o.type === "turn_context") {
      if (typeof p.model === "string") { model = p.model; session.model ??= p.model; }
    } else if (o.type === "event_msg") {
      if (p.type === "task_started") event = "prompt";
      else if (p.type === "task_complete" || p.type === "turn_aborted") event = "stop";
      else if (p.type === "token_count" && !sawUsageRecord) {
        // OLD FORMAT ONLY (R16). total_token_usage is a RUNNING TOTAL: one request
        // per distinct total, worth the delta from the previous one. Summing the
        // totals is the snapshot-counter bug (CLAUDE.md, 63x to 281x).
        const info = (p.info ?? null) as Record<string, unknown> | null;
        const total = (info?.total_token_usage ?? null) as Usage | null;
        if (total !== null) {
          const t = n(total.total_tokens);
          if (prevTotal === null || t !== n(prevTotal.total_tokens)) {
            const base = prevTotal !== null && t < n(prevTotal.total_tokens) ? null : prevTotal;
            prevTotal = total;
            try { records.push(request(`${sid}:${t}`, sec, normalise(minus(total, base)))); }
            catch { malformed++; }
          }
        }
      }
    } else if (o.type === "token_usage_record") {
      sawUsageRecord = true;
      const id = str(p.response_id);
      if (id === undefined) malformed++;
      else {
        try { records.push(request(id, sec, normalise((p.usage ?? {}) as Usage))); }
        catch { malformed++; }
      }
    }

    if (no === first.no) session.startedAt = sec;
    session.endedAt = Math.max(session.endedAt, sec);
    // R6: a same-second activity line adds no time; markers are always kept.
    if (event !== "activity" || sec !== lastSec) {
      records.push({
        source: CODEX_SOURCE, sourceRecordId: `${fileStem}:${no}`, kind: "event",
        timestamp: epochToRfc3339(sec), sessionId: sid, dimensions: { event, seq: no },
      });
      lastSec = sec;
    }
  }
  return { session, records, malformed, partialTail };
}
```

- [ ] **Step 5: `lib/adapters/codex/index.ts`.**

```ts
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterHealth, DetectionResult, WatchtowerAdapter } from "../../core/adapters.ts";
import { fileCursorSql, readFileCursor, stampOf, unchanged, type FileStamp } from "../../core/cursor.ts";
import { detectSource } from "../../core/discovery.ts";
import {
  agentSessionSql, linkExactSql, mintCanonicalId, resolveCanonicalIds, setSessionStateSql,
} from "../../core/identity.ts";
import type { WatchtowerRecord } from "../../core/records.ts";
import { execSql, execSqlBatch, querySql, sqlStr } from "../../core/sql.ts";
import { classifyEntry, reclassifySql, type EntryLists } from "../entry.ts";
import { CODEX_SOURCE, parseRollout, type RolloutSession } from "./parse.ts";

export const CODEX_ADAPTER_VERSION = 1;

const byName = (a: string, b: string): number => {
  const ka = path.basename(a), kb = path.basename(b);
  return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** Every rollout under sessions/ and archived_sessions/, sorted by basename then path (R19). */
export function listRollouts(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(path.join(home, ".codex", "sessions"));
  walk(path.join(home, ".codex", "archived_sessions"));
  return out.sort(byName);
}

/** Resolve or mint the session's canonical id and write it, BEFORE any of its records. */
function ensureSession(db: string, s: RolloutSession, lists: EntryLists, pending: boolean): string {
  const canonical = resolveCanonicalIds(db, CODEX_SOURCE, [s.id], "same_session").get(s.id)
    ?? mintCanonicalId();
  execSqlBatch(db, [
    agentSessionSql({
      canonicalId: canonical, source: CODEX_SOURCE, startedAt: s.startedAt, endedAt: s.endedAt,
      cwd: s.cwd, entry: s.entry, driven: classifyEntry(s.entry, lists),
      repo: s.repo, branch: s.branch, model: s.model,
    }),
    linkExactSql({
      source: CODEX_SOURCE, sourceLocalId: s.id, linkKind: "same_session",
      canonicalId: canonical, evidence: `session_meta.id=${s.id}`,
    }),
    setSessionStateSql(canonical, CODEX_SOURCE, pending ? "pending" : "complete"),
  ]);
  return canonical;
}

/**
 * This file's response ids already held by ANOTHER session (R19): first arrival
 * wins, as claude_requests.session_id does. A forked or copied rollout repeats
 * ids, and re-owning them would move tokens between sessions on every sync.
 */
function takenElsewhere(db: string, canonical: string, ids: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = querySql<{ id: string }>(db, `SELECT source_record_id AS id FROM wt_requests
      WHERE source = ${sqlStr(CODEX_SOURCE)} AND canonical_id <> ${sqlStr(canonical)}
        AND source_record_id IN (${chunk.map(sqlStr).join(", ")});`);
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/**
 * Codex, from its rollout logs. Read-only: files are read whole with
 * readFileSync, never opened for writing. A file whose size and mtime match
 * wt_file_cursor is skipped (R17); the cursor is committed in finish(), and
 * only after a clean run.
 */
export function createCodexAdapter(opts: { db: string; home?: string; lists: EntryLists }): WatchtowerAdapter {
  const { db, lists } = opts;
  const home = opts.home ?? os.homedir();
  let done: { path: string; stamp: FileStamp }[] = [];
  let malformed = 0;

  return {
    id: CODEX_SOURCE,
    type: "agent",
    label: "Codex",
    version: CODEX_ADAPTER_VERSION,
    capabilities: ["sessions", "requests", "usage"],
    authority: [{
      kind: "request", scope: "own",
      metrics: ["tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_creation", "reasoning_tokens"],
    }],

    async detect(): Promise<DetectionResult> {
      return detectSource("codex", { home });
    },

    async health(): Promise<AdapterHealth> {
      const d = await this.detect();
      if (!d.detected) return { state: "unavailable", detail: d.detail };
      return { state: "ok", detail: `${listRollouts(home).length} rollout files` };
    },

    async *ingest(): AsyncIterable<WatchtowerRecord> {
      done = [];
      malformed = 0;
      const cursor = readFileCursor(db, CODEX_SOURCE);
      const seen = new Set<string>();
      for (const file of listRollouts(home)) {
        const stamp = stampOf(file);
        if (unchanged(cursor.get(file), stamp)) continue;
        const parsed = parseRollout(readFileSync(file, "utf8"), path.basename(file, ".jsonl"));
        malformed += parsed.malformed;
        if (parsed.session !== null) {
          const canonical = ensureSession(db, parsed.session, lists, parsed.partialTail);
          const ids = parsed.records.filter((r) => r.kind === "request").map((r) => r.sourceRecordId);
          const taken = takenElsewhere(db, canonical, ids);
          for (const r of parsed.records) {
            if (r.kind === "request") {
              if (seen.has(r.sourceRecordId) || taken.has(r.sourceRecordId)) continue;
              seen.add(r.sourceRecordId);
            }
            yield r;
          }
        }
        // A file still being written is read again next sync, whole (R17).
        if (!parsed.partialTail) done.push({ path: file, stamp });
      }
    },

    finish({ clean }) {
      // Never prunes: a deleted or archived log keeps its rows (spec §5, guard 9).
      if (clean && done.length > 0) {
        execSqlBatch(db, done.map((d) => fileCursorSql(CODEX_SOURCE, d.path, d.stamp)));
      }
      execSql(db, reclassifySql(CODEX_SOURCE, lists));
      return { malformed, detail: malformed > 0 ? `${malformed} malformed lines in Codex logs` : undefined };
    },
  };
}
```

- [ ] **Step 6: `lib/config.ts`** (R11).
  - Add the exported constants:
    - `CODEX_DRIVEN = ["Codex Desktop", "codex_work_desktop", "codex-tui", "codex_vscode", "codex-chrome-extension-sidepanel", "codex_cli_rs"]`;
    - `CODEX_AUTOMATED = ["codex_exec", "buzz-acp", "codex_sdk_ts"]`;
    - `HERMES_DRIVEN = ["cli", "tui", "telegram"]`;
    - `HERMES_AUTOMATED = ["api_server"]`;
    - `MIN_SYNC_SECONDS = 60`.

    Declare them `as const` and give each a one-line comment naming its source:
    "measured on the live machine 2026-10-03; spec §3.2/§3.3 and plan R4".
  - `SourceConfig` gains `driven?: string[]` and `automated?: string[]`, with the comment
    "Codex and Hermes: entry points that count as driven or automated (decision 7)".
  - `DashboardConfig` gains `syncSeconds: number`, with the comment "Background sync while
    the dashboard is open (R13). 0 is off."
  - In `defaults()`:

```ts
    sources: {
      claude: { enabled: true, type: "claude" },
      codex: { enabled: true, type: "codex", driven: [...CODEX_DRIVEN], automated: [...CODEX_AUTOMATED] },
      hermes: { enabled: true, type: "hermes", driven: [...HERMES_DRIVEN], automated: [...HERMES_AUTOMATED] },
      openviking: { enabled: true, type: "openviking", baseUrl: "http://127.0.0.1:1933" },
      atlas: { enabled: true, type: "atlas", projectRoots: [expandHome("~/Developer")] },
    },
    dashboard: { port: 4317, host: "127.0.0.1", pollSeconds: 5, syncSeconds: 300 },
```

  - In the `sources` loop, validate `driven` and `automated` exactly as `projectRoots` is
    validated (an array of strings, error `Invalid sources.<id>.driven …`), and carry them
    into `out[id]`.
  - After `cfg.sources = out;`, add:

```ts
      // Claude is the source Watchtower exists for: a file that lists only other
      // sources still gets it. Disabling it takes naming it with enabled:false.
      if (!("claude" in out)) out.claude = { enabled: true, type: "claude" };
```

  - Add:

```ts
function syncSecondsOf(v: unknown, raw: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || (v !== 0 && v < MIN_SYNC_SECONDS)) {
    throw new Error(`Invalid ${where}: expected 0 (off) or an integer number of seconds >= ${MIN_SYNC_SECONDS}, got ${JSON.stringify(raw)}`);
  }
  return v;
}

/** A source's driven/automated lists, falling back to the shipped defaults. */
export function entryLists(id: "codex" | "hermes", sc: SourceConfig | undefined): { driven: string[]; automated: string[] } {
  const d = id === "codex" ? CODEX_DRIVEN : HERMES_DRIVEN;
  const a = id === "codex" ? CODEX_AUTOMATED : HERMES_AUTOMATED;
  return { driven: sc?.driven ?? [...d], automated: sc?.automated ?? [...a] };
}
```

  - In the `dashboard` block: if `d.syncSeconds !== undefined`, set
    `cfg.dashboard.syncSeconds = syncSecondsOf(d.syncSeconds, d.syncSeconds, \`dashboard.syncSeconds in ${path.basename(configPath)} at ${configPath}\`)`.
  - After the env DB overrides: if `env.WATCHTOWER_SYNC_SECONDS` is a non-empty string, set
    `cfg.dashboard.syncSeconds = syncSecondsOf(Number(env.WATCHTOWER_SYNC_SECONDS), env.WATCHTOWER_SYNC_SECONDS, "WATCHTOWER_SYNC_SECONDS")`.

- [ ] **Step 7: `lib/adapters/index.ts`.**

```ts
import { entryLists, type WatchtowerConfig } from "../config.ts";
import type { WatchtowerAdapter } from "../core/adapters.ts";
import { createClaudeAdapter } from "./claude/index.ts";
import { createCodexAdapter } from "./codex/index.ts";

/**
 * Every enabled source's adapter, in a fixed order. `home` is injected so tests
 * never read the real ~/.codex or ~/.hermes. Absent sources are not filtered
 * here: runSync probes each, and "not detected" is a state, not an error.
 */
export function adaptersFor(cfg: WatchtowerConfig, opts: { home?: string } = {}): WatchtowerAdapter[] {
  const db = cfg.database.path;
  const on = (id: string): boolean => cfg.sources[id] !== undefined && cfg.sources[id].enabled !== false;
  const out: WatchtowerAdapter[] = [];
  if (on("claude")) out.push(createClaudeAdapter({ db }));
  if (on("codex")) out.push(createCodexAdapter({ db, home: opts.home, lists: entryLists("codex", cfg.sources.codex) }));
  return out;
}
```

  Add one `tests/config.test.ts` case:
  - `adaptersFor(loadConfig({ configPath: missing, env: {WATCHTOWER_DB_PATH: x} })).map((a) => a.id)`
    equals `["claude","codex"]`.
  - With `{sources:{claude:{enabled:false}}}` in a config file it equals `[]`.

- [ ] **Step 8: `bin/watchtower` sync.** Replace the `createClaudeAdapter` import and the
  `adapters` block with:

```js
  const { adaptersFor } = await import("../lib/adapters/index.ts");
  …
  // Every enabled source. A source that is absent is reported by runSync as
  // detected:false and is not an error.
  const adapters = adaptersFor(cfg);
```

  Update the usage comment at the top: `watchtower sync [--quiet]` now syncs every enabled
  source.

- [ ] **Step 9: Run the tests, then the suite.**

  Run: `npx vitest run tests/codex-parse.test.ts tests/codex-adapter.test.ts tests/config.test.ts tests/core-sync.test.ts && npm test && npm run typecheck`

  Expected: PASS.

- [ ] **Step 10: Plant guards 1, 2, 3, 9 and 10 (Codex)**, one at a time. Revert each with
  `git checkout -- <file>` or by reverse edit. After each, run `npx vitest run` and record in
  the report which test went red. Each must be exactly the one in the guard map.
  - **1:** in `parseRollout`, `normalise(minus(total, base))` becomes `normalise(total)`.
  - **2:** in `normalise`, `const tokensIn = input - cached - write` becomes
    `const tokensIn = input`.
  - **3:** in `normalise`, `tokens_out: n(u.output_tokens)` becomes
    `tokens_out: n(u.output_tokens) + n(u.reasoning_output_tokens)`.
  - **9:** at the top of `finish`, prune the events of logs that are gone:

    ```ts
    const stems = listRollouts(home).map((p) => path.basename(p, ".jsonl"));
    execSql(db, `DELETE FROM wt_events WHERE source = 'codex'
      AND substr(source_record_id, 1, instr(source_record_id, ':') - 1)
          NOT IN (${stems.map(sqlStr).join(", ")});`);
    ```

    Only test 11 deletes a file, so only test 11 may go red.
  - **10:** in the event record, add `metadata: { text: JSON.stringify(o) }`.

- [ ] **Step 11: Measure on the live machine** (spec §6.2 step 1; it gates the cursor
  design). Use a live copy (setup above). `HOME` stays real, so `~/.codex` is read in place,
  read-only.

```bash
time node bin/watchtower sync --quiet     # cold: every Codex file, Claude projection warm or cold
time node bin/watchtower sync --quiet     # warm: no log changed
sqlite3 "$L/db.sqlite" "SELECT source, records_ingested, records_malformed, health, last_error FROM wt_ingest_state;"
find ~/.codex/sessions ~/.codex/archived_sessions -name '*.jsonl' -exec jq -r 'select(.type=="session_meta") | .payload.originator // "∅"' {} + 2>/dev/null | sort | uniq -c | sort -rn
```

  Record cold and warm times and every originator with its count in the task report.
  - If the warm run is **over 2 s**, profile it (`node --cpu-prof`) and fix the cause before
    Task 3.
  - If any originator is neither in R4's lists nor obviously automated, list it in the
    report for the user. Do not add it.

- [ ] **Step 12: Commit.**

```bash
git add lib/adapters lib/config.ts bin/watchtower tests
git commit -m "feat(codex): Codex adapter — rollouts to wt_*, driven/automated, file cursor"
```

---
### Task 3: Hermes adapter

**Files:**
- Create:
  - `lib/adapters/hermes/index.ts`;
  - `tests/fixtures/make-hermes-db.sh` (mode 755);
  - `tests/hermes-adapter.test.ts`.
- Modify:
  - `lib/adapters/index.ts`, to append Hermes;
  - `lib/core/discovery.ts`, adding `lookedAt`.

**Interfaces:**
- Consumes:
  - from Task 1: `agentSessionSql`, `classifyEntry`, `reclassifySql`, `pagedRows(…,{readonly})`,
    `epochToRfc3339`, `finish`;
  - from Task 2: `entryLists`, `adaptersFor`.
- Produces:
  - `HERMES_SOURCE = "hermes"`;
  - `createHermesAdapter({ db, home?, lists, stateDb? })`;
  - `hermesCost(row): { cost_usd: number; cost_actual: 0 | 1 } | null`;
  - `lookedAt(id: "codex" | "hermes", home?): string`, used by Task 7.

- [ ] **Step 1: The fixture** `tests/fixtures/make-hermes-db.sh <scenario> <path>`.
  - The DDL is Hermes's own, read from the live `state.db` on 2026-10-03 (read-only). The
    script keeps the three tables' full column sets and the UNIQUE title index. It drops
    the FTS triggers, which need tables we do not copy.
  - Values are encoded through `lib.sh`'s `cc_sqlstr` and `cc_sqlnum`.

```bash
#!/usr/bin/env bash
# A Hermes state.db for the adapter tests, with Hermes's REAL column set
# (sqlite3 -readonly ~/.hermes/state.db .schema, 2026-10-03; FTS triggers dropped).
#   make-hermes-db.sh <scenario> <path>     scenarios: core | midnight | veteran
# Expected numbers: plan "Fixture reference".
set -euo pipefail
SCEN="$1"; DB="$2"
# shellcheck source=/dev/null
. "$(cd "$(dirname "$0")/../../capture" && pwd)/lib.sh"     # encoders only; no cc_init_db
mkdir -p "$(dirname "$DB")"
fx() { sqlite3 -cmd ".bail on" "$DB" "$1" >/dev/null; }

if [ ! -f "$DB" ]; then
sqlite3 -cmd ".bail on" "$DB" >/dev/null <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
    system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
    end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0, billing_provider TEXT, billing_base_url TEXT,
    billing_mode TEXT, estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT,
    cost_source TEXT, pricing_version TEXT, title TEXT, api_call_count INTEGER DEFAULT 0,
    handoff_state TEXT, handoff_platform TEXT, handoff_error TEXT, "cwd" TEXT,
    "rewind_count" INTEGER NOT NULL DEFAULT 0, "archived" INTEGER NOT NULL DEFAULT 0,
    "git_branch" TEXT, "git_repo_root" TEXT, "session_key" TEXT, "chat_id" TEXT,
    "chat_type" TEXT, "thread_id" TEXT, "compression_failure_cooldown_until" REAL,
    "compression_failure_error" TEXT, "display_name" TEXT, "origin_json" TEXT,
    "expiry_finalized" INTEGER DEFAULT 0, "compression_fallback_streak" INTEGER NOT NULL DEFAULT 0,
    "profile_name" TEXT, "compression_ineffective_count" INTEGER NOT NULL DEFAULT 0,
    "pinned" INTEGER NOT NULL DEFAULT 0, "system_prompt_hash" TEXT, "last_activity_at" REAL,
    "last_activity_description" TEXT, "last_activity_provenance" TEXT, "last_read_at" REAL,
    "title_source" TEXT, "git_metadata_generation" INTEGER NOT NULL DEFAULT 0,
    "hidden" INTEGER NOT NULL DEFAULT 0, "compression_recovery_deadline" REAL, "tool_names" TEXT,
    "transport_profile" TEXT, "created_source" TEXT,
    "compression_overload_streak" INTEGER NOT NULL DEFAULT 0, "auto_archived" INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);
CREATE UNIQUE INDEX idx_sessions_title_unique ON sessions(title) WHERE title IS NOT NULL;
CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '',
    billing_base_url TEXT NOT NULL DEFAULT '', billing_mode TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0, cost_status TEXT, cost_source TEXT,
    first_seen REAL, last_seen REAL,
    PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
    timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT, reasoning TEXT,
    reasoning_content TEXT, reasoning_details TEXT, codex_reasoning_items TEXT,
    codex_message_items TEXT, platform_message_id TEXT, observed INTEGER DEFAULT 0,
    "active" INTEGER NOT NULL DEFAULT 1, "compacted" INTEGER NOT NULL DEFAULT 0,
    "effect_disposition" TEXT, "api_content" TEXT, "display_kind" TEXT, "display_metadata" TEXT,
    "_compressed_summary" INTEGER NOT NULL DEFAULT 0, "display_identity" BLOB,
    "display_order" INTEGER, "message_uid" TEXT, "absorbed_message_uids" TEXT,
    "tool_call_uids" TEXT, "tool_call_uid" TEXT
);
SQL
fi

# hs <id> <source> <started_at> <ended_at-or-empty> <cwd-or-empty>
hs() {
  fx "INSERT INTO sessions (id, source, model, system_prompt, started_at, ended_at, title, cwd)
      VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$2"), $(cc_sqlstr fx-model), $(cc_sqlstr SECRET-SYSTEM),
              $(cc_sqlnum "$3"), $(cc_sqlnum "$4"), $(cc_sqlstr "SECRET-TITLE-$1"), $(cc_sqlstr "$5"));"
}
# hm <session> <timestamp> <role> <finish_reason-or-empty>
hm() {
  fx "INSERT INTO messages (session_id, role, content, timestamp, finish_reason, reasoning)
      VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$3"), $(cc_sqlstr SECRET-CONTENT), $(cc_sqlnum "$2"),
              $(cc_sqlstr "$4"), $(cc_sqlstr SECRET-REASONING));"
}
# hu <session> <model> <provider> <in> <out> <cache_read> <cache_write> <reasoning> <estimated> <actual> <status>
hu() {
  fx "INSERT INTO session_model_usage (session_id, model, billing_provider, input_tokens,
        output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        estimated_cost_usd, actual_cost_usd, cost_status)
      VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$2"), $(cc_sqlstr "$3"), $(cc_sqlnum "$4"),
              $(cc_sqlnum "$5"), $(cc_sqlnum "$6"), $(cc_sqlnum "$7"), $(cc_sqlnum "$8"),
              $(cc_sqlnum "$9"), $(cc_sqlnum "${10}"), $(cc_sqlstr "${11}"));"
}

case "$SCEN" in
  core)
    t=1790596800; hs h1 cli $t $((t+500)) /tmp/wt-hermes-cli
    hm h1 $((t+10)) user ""; hm h1 $((t+40)) assistant tool_calls; hm h1 $((t+100)) tool ""
    hm h1 $((t+160)) assistant stop; hm h1 $((t+400)) user ""; hm h1 $((t+460)) assistant stop
    hu h1 qwen3-coder local 1000 200 0 0 0 0 0 estimated
    hu h1 gpt-oss-120b openrouter 3000 500 2000 100 50 0.02 0.5 actual
    t=1790672400; hs h2 api_server $t $((t+40)) ""
    hm h2 $((t+5)) user ""; hm h2 $((t+30)) assistant stop
    hu h2 gpt-oss-120b openrouter 400 40 0 0 0 0.0123 0 estimated
    t=1790841600; hs h3 telegram $t "" /tmp/wt-hermes-cli
    hm h3 $((t+5)) user ""; hm h3 $((t+20)) assistant stop
    hu h3 mystery-model unknown 50 5 0 0 0 0 0 unknown
    ;;
  midnight)
    t=1789948200; hs h5 cli $t "" /tmp/wt-hermes-cli
    hm h5 $((t+10)) user ""; hm h5 $((t+300)) assistant tool_calls; hm h5 $((t+700)) assistant stop
    hu h5 gpt-oss-120b openrouter 100 10 0 0 0 0.001 0 estimated
    ;;
  veteran)
    t=1700000000; hs h9 cli $t "" /tmp/wt-hermes-cli
    hm h9 $((t+1)) user ""
    fx "WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 812)
        INSERT INTO messages (session_id, role, content, timestamp, finish_reason)
        SELECT 'h9', 'assistant', 'SECRET-CONTENT', $((t+1)) + i * 14400, 'tool_calls' FROM k;"
    hm h9 $((t + 1 + 812*14400 + 7198)) assistant stop
    ;;
  *) echo "make-hermes-db.sh: unknown scenario $SCEN" >&2; exit 2 ;;
esac
```

- [ ] **Step 2: Write the failing tests** in `tests/hermes-adapter.test.ts`.
  - Helpers:
    - `hermesHome(scenario)`: a `mkdtemp` home, then `make-hermes-db.sh <s> <home>/.hermes/state.db`;
    - `freshDb()`;
    - `sync(db, home, lists = entryLists("hermes", undefined))`, which runs `runSync` with
      `createHermesAdapter`.

  Tests:
  1. **"projects sessions with their entry point":**
     - `SELECT entry, driven, started_at, ended_at, cwd FROM wt_sessions WHERE first_source='hermes' ORDER BY started_at`
       gives:

       | entry | driven | started_at | ended_at | cwd |
       |---|---|---|---|---|
       | `cli` | 1 | 1790596800 | 1790597300 | `/tmp/wt-hermes-cli` |
       | `api_server` | 0 | 1790672400 | 1790672440 | null |
       | `telegram` | 1 | 1790841600 | null | `/tmp/wt-hermes-cli` |

     - `wt_links` holds `('hermes','h1','same_session')` with evidence `sessions.id=h1`.
  2. **"events from timestamps and roles only":** h1's events, ordered by `ts` and then
     `json_extract(dimensions,'$.seq')`, give `[source_record_id, event]` =
     `[["start:h1","session_start"],["msg:1","prompt"],["msg:2","activity"],["msg:3","activity"],["msg:4","stop"],["msg:5","prompt"],["msg:6","stop"],["end:h1","session_end"]]`.
     h3 has no `end:` event.
  3. **"tokens are copied verbatim from session_model_usage"** (R9):
     - The four request rows' `tokens_in`, `tokens_out`, `tokens_cache_read` and
       `tokens_cache_creation` equal the fixture's `input`, `output`, `cache_read` and
       `cache_write`.
     - `wt_usage` `reasoning_tokens` is 50 for `gpt-oss-120b` on h1.
     - Every request's `ts` is its session's `started_at`.
     - `source_record_id` for h1's qwen row is `["h1","qwen3-coder","local","","",""]`
       (`JSON.stringify` of the PK).
  4. **"Hermes's figure follows R8":** `cost_usd` and `wt_usage` `cost_actual` per row:

     | row | `cost_usd` | `cost_actual` |
     |---|---|---|
     | qwen | 0 | 0 |
     | gpt-oss on h1 | 0.5 | 1 |
     | h2 | 0.0123 | 0 |
     | h3 | NULL | (no row) |

     Unit-test `hermesCost` on the same four inputs, plus `{actual 0, estimated 0.3, status "unknown"}`,
     which gives `null`.
  5. **"copies no content"** (guard 10, the Hermes half): dump every `wt_%` table. The JSON
     contains no `SECRET`.
  6. **"never writes the source":** the sha1 of `state.db` is the same before and after sync.
     So is the existence of `-wal`/`-shm`; record whatever is there before, and compare.
  7. **RF4 "an unreadable state.db degrades Hermes only":**
     - Write `<home>/.hermes/state.db` as the text `not a database\n`.
     - Call `runSync({ db, adapters: [createClaudeAdapter({db}), createHermesAdapter({db, home, lists})] })`
       on `buildAndRoll("orphan-request-tokens")`'s DB.
     - Claude's summary has `ingested > 0` and no `error`.
     - Hermes's summary has `detected: true` and an `error` containing `not a database`.
     - `wt_ingest_state` for hermes has `health = 'degraded'`.
  8. **"reclassification follows config":**
     - sync;
     - sync with `{driven:["cli","tui","telegram","api_server"], automated:[]}`;
     - h2's `driven` is 1.

- [ ] **Step 3: Run and watch it fail.**

  Run: `npx vitest run tests/hermes-adapter.test.ts`

  Expected: FAIL (module missing).

- [ ] **Step 4: `lib/core/discovery.ts`.** Add, and use it in `detectSource`'s codex and
  hermes cases:

```ts
/** Where Watchtower looks for a tool: one definition for discovery and for the pages. */
export function lookedAt(id: "codex" | "hermes", home: string = os.homedir()): string {
  return id === "codex"
    ? path.join(home, ".codex", "sessions")
    : path.join(home, ".hermes", "state.db");
}
```

- [ ] **Step 5: `lib/adapters/hermes/index.ts`.**

```ts
import os from "node:os";
import path from "node:path";
import type { AdapterHealth, DetectionResult, WatchtowerAdapter } from "../../core/adapters.ts";
import { detectSource, lookedAt } from "../../core/discovery.ts";
import {
  agentSessionSql, linkExactSql, mintCanonicalId, resolveCanonicalIds, setSessionStateSql,
} from "../../core/identity.ts";
import { epochToRfc3339, type WatchtowerRecord } from "../../core/records.ts";
import { errorLine, execSql, execSqlBatch, pagedRows, querySql, SQL_PAGE_SIZE } from "../../core/sql.ts";
import { classifyEntry, reclassifySql, type EntryLists } from "../entry.ts";

export const HERMES_SOURCE = "hermes";
export const HERMES_ADAPTER_VERSION = 1;
const STOPS = new Set(["stop", "length", "error"]);

interface SessionRow {
  id: string; source: string; model: string | null; started_at: number; ended_at: number | null;
  cwd: string | null; git_branch: string | null; git_repo_root: string | null;
}
interface MessageRow { id: number; session_id: string; role: string; timestamp: number; finish_reason: string | null }
interface UsageRow {
  session_id: string; model: string; billing_provider: string; billing_base_url: string;
  billing_mode: string; task: string; started_at: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number;
  cache_write_tokens: number; reasoning_tokens: number;
  estimated_cost_usd: number | null; actual_cost_usd: number | null; cost_status: string | null;
}

/**
 * Hermes's own figure for one usage row (R8): the actual cost when there is one,
 * else the estimate when Hermes says it estimated, else nothing -- "Hermes didn't
 * price this", never $0. Never an input to "at API prices" (decision 4).
 */
export function hermesCost(u: Pick<UsageRow, "actual_cost_usd" | "estimated_cost_usd" | "cost_status">):
    { cost_usd: number; cost_actual: 0 | 1 } | null {
  if (u.actual_cost_usd !== null && u.actual_cost_usd > 0) return { cost_usd: u.actual_cost_usd, cost_actual: 1 };
  if (u.cost_status === "estimated" && u.estimated_cost_usd !== null) return { cost_usd: u.estimated_cost_usd, cost_actual: 0 };
  return null;
}

const ev = (id: string, sec: number, sessionId: string, event: string, seq: number): WatchtowerRecord => ({
  source: HERMES_SOURCE, sourceRecordId: id, kind: "event",
  timestamp: epochToRfc3339(sec), sessionId, dimensions: { event, seq },
});

/**
 * Hermes, from ~/.hermes/state.db, opened READ-ONLY (sqlite3 -readonly with a
 * busy timeout; the WAL fallback in querySql). Only timestamps, roles, finish
 * reasons, models, token counts and costs are selected: never content,
 * reasoning, system_prompt, title or tool calls.
 */
export function createHermesAdapter(opts: {
  db: string; home?: string; lists: EntryLists; stateDb?: string;
}): WatchtowerAdapter {
  const { db, lists } = opts;
  const home = opts.home ?? os.homedir();
  const src = opts.stateDb ?? lookedAt("hermes", home);
  const read = <T>(sql: string) => pagedRows<T>(src, sql, SQL_PAGE_SIZE, { readonly: true });

  return {
    id: HERMES_SOURCE,
    type: "agent",
    label: "Hermes",
    version: HERMES_ADAPTER_VERSION,
    capabilities: ["sessions", "requests", "usage"],
    authority: [{
      kind: "request", scope: "own",
      metrics: ["tokens_in", "tokens_out", "tokens_cache_read", "tokens_cache_creation",
        "reasoning_tokens", "cost_usd", "cost_actual"],
    }],

    async detect(): Promise<DetectionResult> {
      return detectSource("hermes", { home });
    },

    async health(): Promise<AdapterHealth> {
      const d = await this.detect();
      if (!d.detected) return { state: "unavailable", detail: d.detail };
      try {
        const n = querySql<{ n: number }>(src, "SELECT COUNT(*) AS n FROM sessions;", { readonly: true })[0].n;
        return { state: "ok", detail: `${n} sessions` };
      } catch (e) {
        return { state: "unavailable", detail: errorLine(e) };
      }
    },

    async *ingest(): AsyncIterable<WatchtowerRecord> {
      // Identity FIRST: every session and its link before any record that names it.
      const sessions = [...read<SessionRow>(
        "SELECT id, source, model, started_at, ended_at, cwd, git_branch, git_repo_root FROM sessions ORDER BY id")];
      for (let i = 0; i < sessions.length; i += 500) {
        const chunk = sessions.slice(i, i + 500);
        const known = resolveCanonicalIds(db, HERMES_SOURCE, chunk.map((s) => s.id), "same_session");
        execSqlBatch(db, chunk.flatMap((s) => {
          const canonical = known.get(s.id) ?? mintCanonicalId();
          return [
            agentSessionSql({
              canonicalId: canonical, source: HERMES_SOURCE,
              startedAt: Math.floor(s.started_at),
              endedAt: s.ended_at === null ? undefined : Math.floor(s.ended_at),
              cwd: s.cwd ?? undefined, entry: s.source, driven: classifyEntry(s.source, lists),
              repo: s.git_repo_root ?? undefined, branch: s.git_branch ?? undefined,
              model: s.model ?? undefined,
            }),
            linkExactSql({
              source: HERMES_SOURCE, sourceLocalId: s.id, linkKind: "same_session",
              canonicalId: canonical, evidence: `sessions.id=${s.id}`,
            }),
            setSessionStateSql(canonical, HERMES_SOURCE, s.ended_at === null ? "pending" : "complete"),
          ];
        }));
      }

      for (const s of sessions) {
        yield ev(`start:${s.id}`, Math.floor(s.started_at), s.id, "session_start", 0);
        if (s.ended_at !== null) {
          yield ev(`end:${s.id}`, Math.floor(s.ended_at), s.id, "session_end", Number.MAX_SAFE_INTEGER);
        }
      }

      for (const m of read<MessageRow>(
        "SELECT id, session_id, role, timestamp, finish_reason FROM messages ORDER BY id")) {
        const event = m.role === "user" ? "prompt"
          : m.role === "assistant" && STOPS.has(m.finish_reason ?? "") ? "stop" : "activity";
        yield ev(`msg:${m.id}`, Math.floor(m.timestamp), m.session_id, event, m.id);
      }

      // ts is the session's start: Hermes stores no per-call time (spec §3.3).
      for (const u of read<UsageRow>(
        `SELECT u.session_id, u.model, u.billing_provider, u.billing_base_url, u.billing_mode, u.task,
                s.started_at, u.input_tokens, u.output_tokens, u.cache_read_tokens,
                u.cache_write_tokens, u.reasoning_tokens, u.estimated_cost_usd,
                u.actual_cost_usd, u.cost_status
           FROM session_model_usage u JOIN sessions s ON s.id = u.session_id
          ORDER BY u.session_id, u.model, u.billing_provider, u.billing_base_url, u.billing_mode, u.task`)) {
        const cost = hermesCost(u);
        yield {
          source: HERMES_SOURCE,
          sourceRecordId: JSON.stringify([u.session_id, u.model, u.billing_provider,
            u.billing_base_url, u.billing_mode, u.task]),
          kind: "request",
          timestamp: epochToRfc3339(Math.floor(u.started_at)),
          sessionId: u.session_id,
          model: u.model === "" ? undefined : u.model,
          metrics: {
            tokens_in: u.input_tokens, tokens_out: u.output_tokens,
            tokens_cache_read: u.cache_read_tokens, tokens_cache_creation: u.cache_write_tokens,
            reasoning_tokens: u.reasoning_tokens,
            ...(cost === null ? {} : cost),
          },
        };
      }
    },

    finish() {
      execSql(db, reclassifySql(HERMES_SOURCE, lists));
      return { malformed: 0 };
    },
  };
}
```

  Append to `adaptersFor`:

```ts
  if (on("hermes")) out.push(createHermesAdapter({ db, home: opts.home, lists: entryLists("hermes", cfg.sources.hermes) }));
```

  Extend the `adaptersFor` config test so the defaults give `["claude","codex","hermes"]`.

- [ ] **Step 6: Run the tests, then the suite.**

  Run: `npx vitest run tests/hermes-adapter.test.ts tests/config.test.ts && npm test && npm run typecheck`

  Expected: PASS.

- [ ] **Step 7: Plant guard 10 (Hermes).** In the messages loop, add
  `metadata: { content: "SECRET-CONTENT" }` to the event, as if `content` had been
  selected. Exactly "copies no content" in `hermes-adapter.test.ts` turns red. Revert, and
  record it.

- [ ] **Step 8: Live check** on a live copy, with `HOME` real. `~/.hermes/state.db` is read in
  place, read-only.

  Run `node bin/watchtower sync --quiet`, then:

```bash
sqlite3 "$L/db.sqlite" "SELECT COUNT(*) FROM wt_sessions WHERE first_source='hermes'; SELECT entry, driven, COUNT(*) FROM wt_sessions WHERE first_source='hermes' GROUP BY 1,2;"
sqlite3 -readonly ~/.hermes/state.db "SELECT COUNT(*) FROM sessions; SELECT source, COUNT(*) FROM sessions GROUP BY 1;"
```

  The counts must match (71 sessions on 2026-10-02). Record both outputs in the report.

- [ ] **Step 9: Commit.**

```bash
git add lib/adapters lib/core/discovery.ts tests
git commit -m "feat(hermes): Hermes adapter — state.db read-only into wt_*, Hermes's own cost"
```

---

### Task 4: OpenViking and Atlas (light touch), sync runs the rollup, background sync

**Files:**
- Create:
  - `lib/adapters/openviking/index.ts`;
  - `lib/adapters/atlas/index.ts`;
  - `lib/rollup-run.ts`;
  - `lib/background-sync.ts`;
  - tests `tests/openviking-adapter.test.ts`, `tests/atlas-adapter.test.ts`,
    `tests/rollup-run.test.ts`, `tests/background-sync.test.ts`.
- Modify:
  - `lib/core/discovery.ts`, adding `findAtlasDbs`;
  - `lib/adapters/index.ts`;
  - `bin/watchtower`: the sync and serve blocks;
  - `tests/core-sync.test.ts`;
  - every test that spawns `bin/watchtower`. Find them with
    `grep -ln '"bin", "watchtower"\|bin/watchtower' tests/*.ts`.

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `createOpenVikingAdapter({ db, home?, baseUrl, now?, fetchImpl? })`;
  - `createAtlasAdapter({ db, roots, maxDepth? })`;
  - `findAtlasDbs(roots, depth?)`;
  - `runRollup({ db, installDir, excludePaths, env?, timeoutMs? }): RollupOutcome`, where
    `RollupOutcome` is `{ ran, ok, script, detail? }`;
  - `startBackgroundSync({ script, everySeconds, env?, spawnImpl?, onExit? }): { stop(): void }`.
  - The sync CLI's JSON becomes `{ db, sources, rollup }`.

- [ ] **Step 1: Write the failing tests.**

  `tests/openviking-adapter.test.ts`. The home has `.openviking/state/` holding:
  - `last-recall.json` = `{"server_url":"SECRET-URL","latency_ms":42,"count":3,"content_items":2,"hint_items":1,"tokens_used":512,"tokens_budget":2000,"cc_session_id":"SECRET-CC","reason":"x","ts":1790600000123}`;
  - `last-capture.json` = `{"turns_captured":4,"turns_queued":0,"turns_failed":0,"pending_tokens":0,"commit_threshold":10,"committed":true,"commit_count":2,"total_message_count":9,"ov_session_id":"SECRET-OV","cc_session_id":"SECRET-CC","ts":1790600100456}`.

  The home's `.openviking/ovcli.conf` holds `api_key = SECRET-KEY`.

  Tests:
  1. **"reachable when /health answers 200":**
     - A `node:http` server on port 0 answers `/health` with 200 and everything else 401.
     - The adapter, with `baseUrl` pointing at it and `now: () => 1790600200000`, writes
       `wt_usage` `reachable` = 1 on `reachable:1790600200`.
     - `recall:1790600000` carries `recall_count 3`, `recall_latency_ms 42` and
       `recall_tokens 512`.
     - `capture:1790600100` carries `capture_turns 4` and `capture_committed 1`.
     - `wt_events.kind` is `health`.
  2. **"unreachable is 0, never an error":** start a server, read its port, close it, and
     point at it. `reachable` = 0, and the summary has no `error`.
  3. **"no session ids, no URL, no key":**
     - The dump of every `wt_%` table contains none of `SECRET-URL`, `SECRET-CC`,
       `SECRET-OV` or `SECRET-KEY`.
     - `readFileSync("lib/adapters/openviking/index.ts","utf8")` does not contain `ovcli`.
  4. **"unchanged state adds only a new reachable reading":** a second sync with
     `now: () => 1790600260000` gives `ingested 1` and `unchanged 2`.
  5. **"not detected without state":** a home without `.openviking/state` gives
     `detected:false`.

  `tests/atlas-adapter.test.ts`. Setup:
  - `const db = buildAndRoll("resumed")`. The scenario's own session id is
    `const sid = rows<{s:string}>(db,"SELECT session_id AS s FROM claude_sessions LIMIT 1")[0].s`.
  - Sync Claude first: `runSync({db, adapters:[createClaudeAdapter({db})]})`.
  - Build `<root>/repo-a/.atlas/sessions.db` and `<root>/x/repo-b/.atlas/sessions.db` with
    `sqlite3 -cmd ".bail on"`:

```sql
CREATE TABLE agent_session (id TEXT PRIMARY KEY, workspace_id TEXT, source TEXT,
  native_session_id TEXT NOT NULL, token_totals TEXT, started_at TEXT, updated_at TEXT);
CREATE TABLE checkpoint (id TEXT PRIMARY KEY, session_id TEXT);
CREATE TABLE file_touch (id TEXT PRIMARY KEY, session_id TEXT, deleted INTEGER);
```

  - repo-a holds:
    - `('as-1','w','external_jsonl',<sid>,'{"input":987654321}','2026-09-14T18:18:48.012389+00:00','2026-09-14T18:18:48.012389+00:00')`;
    - `('as-2','w','acp',<sid>,NULL,…same…)`;
    - `('as-9','w','acp','not-a-claude-session',NULL,…)`.
  - Checkpoints: as-1 has 2, as-2 has 3.
  - `file_touch`: as-1 has `(f1,0)`, `(f2,1)`; as-2 has `(f3,0)`, `(f4,0)`.
  - repo-b holds one more row `('as-5','w','acp',<sid>,…)` with no checkpoints.
  - `<root>/.hidden/.atlas/sessions.db` exists too and must be skipped.

  Tests:
  1. **"finds every Atlas db under the roots, skipping dot dirs":** `findAtlasDbs([root], 3)`
     equals the sorted two paths.
  2. **"links to Claude's session and counts":**
     - `wt_links` has `('atlas','as-1','same_session')` whose `canonical_id` equals Claude's
       link for `<sid>`.
     - `wt_usage` for `as-1` has `atlas_checkpoints 2` and `atlas_files_touched 1`. `as-2`
       has 3 and 2.
     - There are no rows at all for `as-9`.
  3. **"never reads token_totals":** the dump of every `wt_%` table does not contain
     `987654321`.
  4. **"contributes no tokens":** `SELECT COUNT(*) FROM wt_requests WHERE source='atlas'` is 0.

  `tests/rollup-run.test.ts`:
  1. `runRollup({ db, installDir: emptyTmp, excludePaths: [], env: {} })` gives
     `{ ran:false, ok:true }`.
  2. Take `buildAndRoll("resumed")`'s DB and `DELETE FROM claude_daily_rollups`. Then
     `runRollup({ db, installDir: emptyTmp, excludePaths: [], env: {...process.env, TZ:"UTC", WATCHTOWER_ROLLUP_PATH: ROLLUP, CC_LIB_PATH: LIB} })`
     gives `{ ran:true, ok:true }`, and `claude_daily_rollups` has rows again.
  3. A temp script that runs `exit 1` gives `{ ran:true, ok:false }` with a non-empty
     `detail`.

  `tests/background-sync.test.ts`. Use `vi.useFakeTimers()`. The fake `spawnImpl` records
  its calls and returns an `EventEmitter`.
  1. `startBackgroundSync({ script:"/x/watchtower", everySeconds: 300, spawnImpl })` spawns
     once immediately with `(process.execPath, ["/x/watchtower","sync","--quiet"], …)`.
  2. Advancing 300 s while the child has not exited spawns nothing more: never two at once.
  3. After `child.emit("exit", 0)`, advancing 300 s spawns again, and `onExit` got 0.
  4. After `stop()`, advancing 600 s spawns nothing.

  `tests/core-sync.test.ts`, the CLI block. Every spawn env has `HOME: <mkdtemp>`.
  1. `sync` prints `rollup: { ran:false, ok:true, … }` when there is no install.
  2. With `WATCHTOWER_ROLLUP_PATH`/`CC_LIB_PATH` pointing at the repo's `capture/`, `TZ=UTC`,
     the JSON has `rollup.ran === true` and `rollup.ok === true`.
  3. `--no-rollup` prints no `rollup` key.
  4. RF4 at the CLI:
     - a temp `HOME` with `.hermes/state.db` = `not a database\n`;
     - the exit status is **1**, and stdout still parses;
     - the hermes entry has `error`, and the claude entry has `ingested > 0`.

  Every test that spawns `bin/watchtower serve` or `open` adds `WATCHTOWER_SYNC_SECONDS: "0"`
  and a temp `HOME` to the env.

- [ ] **Step 2: Run them and watch them fail.**

  Run: `npx vitest run tests/openviking-adapter.test.ts tests/atlas-adapter.test.ts tests/rollup-run.test.ts tests/background-sync.test.ts tests/core-sync.test.ts`

  Expected: FAIL.

- [ ] **Step 3: `lib/core/discovery.ts` — `findAtlasDbs`.** Every hit, not the first:

```ts
/**
 * Every <dir>/.atlas/sessions.db under the roots, to a fixed depth, sorted.
 * Bounded and dot-dir-skipping exactly as findAtlas is: a passive observer
 * never walks the whole home directory.
 */
export function findAtlasDbs(roots: readonly string[], depth: number = DEFAULT_MAX_DEPTH): string[] {
  const out = new Set<string>();
  const walk = (dir: string, d: number): void => {
    if (d < 0 || !existsSync(dir)) return;
    const direct = path.join(dir, ".atlas", "sessions.db");
    if (existsSync(direct)) out.add(direct);
    if (d === 0) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const child = path.join(dir, e);
      try { if (!statSync(child).isDirectory()) continue; } catch { continue; }
      walk(child, d - 1);
    }
  };
  for (const r of roots) walk(r, depth);
  return [...out].sort();
}
```

- [ ] **Step 4: `lib/adapters/openviking/index.ts`.**

```ts
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdapterHealth, DetectionResult, WatchtowerAdapter } from "../../core/adapters.ts";
import { epochToRfc3339, type WatchtowerRecord } from "../../core/records.ts";

export const OPENVIKING_SOURCE = "openviking";

/**
 * OpenViking, the light touch (spec §3.4): one unauthenticated GET /health per
 * sync, plus the plugin's own last-recall and last-capture files. Never reads
 * the CLI's config (it holds an API key), and copies no memory content, no URL
 * and no session id -- only counts, latency and a reachable flag.
 */
export function createOpenVikingAdapter(opts: {
  db: string; home?: string; baseUrl: string;
  now?: () => number; fetchImpl?: typeof fetch;
}): WatchtowerAdapter {
  const home = opts.home ?? os.homedir();
  const state = path.join(home, ".openviking", "state");
  const now = opts.now ?? Date.now;
  const get = opts.fetchImpl ?? fetch;

  const readJson = (name: string): Record<string, unknown> | null => {
    try { return JSON.parse(readFileSync(path.join(state, name), "utf8")) as Record<string, unknown>; }
    catch { return null; }
  };
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const pick = (o: Record<string, unknown>, map: Record<string, string>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [metric, field] of Object.entries(map)) {
      const v = field === "committed" ? (typeof o.committed === "boolean" ? (o.committed ? 1 : 0) : undefined) : num(o[field]);
      if (v !== undefined) out[metric] = v;
    }
    return out;
  };
  const reading = (id: string, sec: number, probe: string, metrics: Record<string, number>): WatchtowerRecord => ({
    source: OPENVIKING_SOURCE, sourceRecordId: id, kind: "health",
    timestamp: epochToRfc3339(sec), dimensions: { probe }, metrics,
  });

  return {
    id: OPENVIKING_SOURCE,
    type: "memory",
    label: "OpenViking",
    version: 1,
    capabilities: ["memory", "health"],
    authority: [{
      kind: "health", scope: "own",
      metrics: ["reachable", "recall_count", "recall_latency_ms", "recall_tokens", "capture_turns", "capture_committed"],
    }],

    async detect(): Promise<DetectionResult> {
      return existsSync(state) ? { detected: true, detail: state } : { detected: false, detail: `no ${state}` };
    },

    async health(): Promise<AdapterHealth> {
      return (await this.detect()).detected ? { state: "ok" } : { state: "unavailable" };
    },

    async *ingest(): AsyncIterable<WatchtowerRecord> {
      const syncSec = Math.floor(now() / 1000);
      let reachable = 0;
      try {
        const r = await get(new URL("/health", opts.baseUrl), { signal: AbortSignal.timeout(2000) });
        reachable = r.ok ? 1 : 0;
      } catch {
        reachable = 0;
      }
      yield reading(`reachable:${syncSec}`, syncSec, "health", { reachable });

      const recall = readJson("last-recall.json");
      const rts = num(recall?.ts);
      if (recall !== null && rts !== undefined) {
        const sec = Math.floor(rts / 1000);
        yield reading(`recall:${sec}`, sec, "recall",
          pick(recall, { recall_count: "count", recall_latency_ms: "latency_ms", recall_tokens: "tokens_used" }));
      }
      const capture = readJson("last-capture.json");
      const cts = num(capture?.ts);
      if (capture !== null && cts !== undefined) {
        const sec = Math.floor(cts / 1000);
        yield reading(`capture:${sec}`, sec, "capture",
          pick(capture, { capture_turns: "turns_captured", capture_committed: "committed" }));
      }
    },
  };
}
```

- [ ] **Step 5: `lib/adapters/atlas/index.ts`.**

```ts
import type { AdapterHealth, DetectionResult, WatchtowerAdapter } from "../../core/adapters.ts";
import { detectSource, findAtlasDbs } from "../../core/discovery.ts";
import { linkExactSql, resolveCanonicalIds } from "../../core/identity.ts";
import { epochToRfc3339, type WatchtowerRecord } from "../../core/records.ts";
import { execSqlBatch, querySql } from "../../core/sql.ts";

export const ATLAS_SOURCE = "atlas";

interface AtlasRow { id: string; native_session_id: string; updated_at: string; checkpoints: number; files: number }

/**
 * Atlas, the light touch (spec §3.4): for each agent_session whose
 * native_session_id is a Claude session, an exact link to Claude's canonical
 * session and two counts. token_totals is never selected: Atlas's tokens
 * disagree with claude_requests by up to 2.03x. Atlas contributes no tokens and
 * no hours.
 */
export function createAtlasAdapter(opts: { db: string; roots: string[]; maxDepth?: number }): WatchtowerAdapter {
  const depth = opts.maxDepth ?? 3;
  return {
    id: ATLAS_SOURCE,
    type: "provenance",
    label: "Atlas",
    version: 1,
    capabilities: ["checkpoints"],
    authority: [{ kind: "checkpoint", scope: "own", metrics: ["atlas_checkpoints", "atlas_files_touched"] }],

    async detect(): Promise<DetectionResult> {
      return detectSource("atlas", { projectRoots: opts.roots, maxDepth: depth });
    },

    async health(): Promise<AdapterHealth> {
      const n = findAtlasDbs(opts.roots, depth).length;
      return n > 0 ? { state: "ok", detail: `${n} Atlas databases` } : { state: "unavailable" };
    },

    async *ingest(): AsyncIterable<WatchtowerRecord> {
      for (const file of findAtlasDbs(opts.roots, depth)) {
        const rows = querySql<AtlasRow>(file, `SELECT s.id, s.native_session_id, s.updated_at,
            (SELECT COUNT(*) FROM checkpoint c WHERE c.session_id = s.id) AS checkpoints,
            (SELECT COUNT(*) FROM file_touch f WHERE f.session_id = s.id AND f.deleted = 0) AS files
          FROM agent_session s ORDER BY s.id;`, { readonly: true });
        for (let i = 0; i < rows.length; i += 500) {
          const chunk = rows.slice(i, i + 500);
          const claude = resolveCanonicalIds(opts.db, "claude", chunk.map((r) => r.native_session_id), "same_session");
          const linked = chunk.filter((r) => claude.has(r.native_session_id));
          if (linked.length === 0) continue;
          // Identity first: the link must exist before the record resolves through it.
          execSqlBatch(opts.db, linked.map((r) => linkExactSql({
            source: ATLAS_SOURCE, sourceLocalId: r.id, linkKind: "same_session",
            canonicalId: claude.get(r.native_session_id) as string,
            evidence: `agent_session.native_session_id=${r.native_session_id}`,
          })));
          for (const r of linked) {
            const ms = Date.parse(r.updated_at);
            if (!Number.isFinite(ms)) continue;
            yield {
              source: ATLAS_SOURCE, sourceRecordId: r.id, kind: "checkpoint",
              timestamp: epochToRfc3339(Math.floor(ms / 1000)), sessionId: r.id,
              metrics: { atlas_checkpoints: r.checkpoints, atlas_files_touched: r.files },
            };
          }
        }
      }
    },
  };
}
```

  Append to `adaptersFor`:

```ts
  if (on("openviking")) out.push(createOpenVikingAdapter({ db, home: opts.home, baseUrl: cfg.sources.openviking.baseUrl ?? "http://127.0.0.1:1933" }));
  if (on("atlas")) out.push(createAtlasAdapter({ db, roots: cfg.sources.atlas.projectRoots ?? [] }));
```

  The `adaptersFor` default test now expects all five ids, in this order.

- [ ] **Step 6: `lib/rollup-run.ts`.**

```ts
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { errorLine } from "./core/sql.ts";

export interface RollupOutcome { ran: boolean; ok: boolean; script: string; detail?: string }

/**
 * Run the INSTALLED rollup over the database sync just wrote (R12) -- the same
 * script the SessionEnd hook runs, so one version rolls the database. Not
 * installed here is a state, not an error. WATCHTOWER_ROLLUP_PATH and
 * CC_LIB_PATH override the paths, for tests and for proving a branch on a copy.
 */
export function runRollup(opts: {
  db: string; installDir: string; excludePaths: readonly string[];
  env?: NodeJS.ProcessEnv; timeoutMs?: number;
}): RollupOutcome {
  const env = opts.env ?? process.env;
  const script = env.WATCHTOWER_ROLLUP_PATH || path.join(opts.installDir, "claude-usage-rollup.sh");
  const lib = env.CC_LIB_PATH || path.join(opts.installDir, "cc-track-lib.sh");
  if (!existsSync(script) || !existsSync(lib)) {
    return { ran: false, ok: true, script, detail: `no rollup at ${script}` };
  }
  try {
    execFileSync("bash", [script, "--quiet"], {
      env: {
        ...env, CC_LIB_PATH: lib, WATCHTOWER_DB_PATH: opts.db, THEONE_DB_PATH: opts.db,
        WATCHTOWER_EXCLUDE_PATHS: opts.excludePaths.join("\n"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? 300_000,
    });
    return { ran: true, ok: true, script };
  } catch (e) {
    return { ran: true, ok: false, script, detail: errorLine(e) };
  }
}
```

- [ ] **Step 7: `lib/background-sync.ts`.**

```ts
import { spawn, type ChildProcess } from "node:child_process";

/**
 * While the dashboard is open, run `watchtower sync --quiet` now and every
 * `everySeconds` (R13) -- as a CHILD process, so the server itself stays
 * read-only (lib/serve.ts never writes). Never two at once: a tick that finds
 * the last sync still running is skipped. The timer is unref'd, so it never
 * keeps a process alive on its own.
 */
export function startBackgroundSync(opts: {
  script: string; everySeconds: number; env?: NodeJS.ProcessEnv;
  spawnImpl?: (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; stdio: "ignore" }) => ChildProcess;
  onExit?: (code: number | null) => void;
}): { stop(): void } {
  const run = opts.spawnImpl ?? ((cmd, args, o) => spawn(cmd, args, o));
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    const child = run(process.execPath, [opts.script, "sync", "--quiet"], { env: opts.env ?? process.env, stdio: "ignore" });
    const done = (code: number | null): void => { running = false; opts.onExit?.(code); };
    child.once("exit", (code) => done(code));
    child.once("error", () => done(null));
  };
  tick();
  const timer = setInterval(tick, opts.everySeconds * 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
```

  The test's fake child must emit `exit` once. Cast the `EventEmitter` to `ChildProcess`.

- [ ] **Step 8: `bin/watchtower`.**

  In `sync`, after `runSync`:

```js
  let rollup;
  if (flag("no-rollup") !== true) {
    const { runRollup } = await import("../lib/rollup-run.ts");
    rollup = runRollup({ db, installDir: cfg.capture.installDir, excludePaths: cfg.excludePaths });
  }
  if (flag("quiet") !== true) console.log(JSON.stringify(rollup === undefined ? { db, sources } : { db, sources, rollup }));
  // A source that failed, or a rollup that failed, is a failed sync: exit 1,
  // after the summary, so a script can see both what worked and what did not.
  const failed = sources.some((s) => s.error !== undefined) || (rollup !== undefined && rollup.ran && !rollup.ok);
  process.exit(failed ? 1 : 0);
```

  In `serve`, after the `console.log(\`watchtower: serving …\`)` line:

```js
  if (cfg.dashboard.syncSeconds > 0) {
    const { startBackgroundSync } = await import("../lib/background-sync.ts");
    // process.argv[1] is this script, however it was invoked (a symlink on PATH included).
    startBackgroundSync({ script: process.argv[1], everySeconds: cfg.dashboard.syncSeconds });
  }
```

  Update the usage lines:
  - `watchtower sync [--quiet] [--no-rollup]`: projects every enabled source, then runs the
    installed rollup;
  - `serve`: also syncs every `dashboard.syncSeconds`.

- [ ] **Step 9: Run the tests, then the suite.**

  Run: `npx vitest run tests/openviking-adapter.test.ts tests/atlas-adapter.test.ts tests/rollup-run.test.ts tests/background-sync.test.ts tests/core-sync.test.ts && npm test && npm run typecheck`

  Expected: PASS.

- [ ] **Step 10: Live check.** On a live copy, with `HOME` real, run
  `node bin/watchtower sync` once. The env from the setup block points the rollup at the
  repo's `capture/`.
  - Record the JSON: every source's `detected`, `ingested` and `error`, plus `rollup`.
  - Check `sqlite3 "$L/db.sqlite" "SELECT source, health, last_error FROM wt_ingest_state;"`.
  - OpenViking must be `detected:true`. The tunnel may be up or down; record which.
  - Atlas: record the number of Atlas DBs found under `~/Developer`.

- [ ] **Step 11: Commit.**

```bash
git add lib bin tests
git commit -m "feat(sync): OpenViking and Atlas light touch; sync runs the installed rollup; background sync"
```

---
### Task 5: The rollup — schema v7, agent hours, Codex cost, levels

**Files:**
- Modify:
  - `capture/lib.sh`: `CC_SCHEMA_VERSION=7`, the four `agent_*` tables, and a deprecation
    comment on `claude_rank_progress`;
  - `lib/config.ts`: `schemaVersion: 7`;
  - `capture/rollup.sh`: the resolver's `wt_sessions` arm, plus the new last section;
  - `tests/fixtures/make-fixture.sh`: the `agent-drift` scenario;
  - `tests/capture-scripts.test.ts`, `tests/cost-rollup.test.ts`, `tests/rollup-lock.test.ts`,
    `tests/config.test.ts`.
- Create:
  - `tests/helpers/agent-seed.ts`;
  - `tests/agent-rollup.test.ts`.

**Interfaces:**
- Consumes:
  - Task 1's `wt_sessions.cwd/entry/driven` and `applyWtSchema`;
  - the record shapes of Tasks 2–3: kind `event`, `dimensions {event, seq}`, and requests
    keyed by `(source, source_record_id)`;
  - `createCodexAdapter`, `createHermesAdapter`, `entryLists` and `runSync`, for the
    end-to-end tests only.
- Produces the four tables every later task reads. Their column names are exactly:
  - `agent_prices(model, effective_from, input, cached_input, output, verified_on, source)`;
  - `agent_request_metrics(source, source_record_id, canonical_id, day, project_key, model, priced, price_note, cost_table_usd, own_cost_usd)`;
  - `agent_daily_rollups(source, day, project_key, active_s, sessions_driven, sessions_automated, sessions_unclassified, requests, tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, cost_table_usd, priced_requests, unpriced_requests, own_cost_usd, own_priced_requests, own_unpriced_requests, updated_at)`;
  - `agent_progress(source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars, updated_at)`.
- `agent_request_metrics` carries Hermes rows too (refines spec §4.1, which says "Codex
  request"):
  - a Hermes row has `priced`, `price_note` and `cost_table_usd` all NULL, and its
    `own_cost_usd` = `wt_requests.cost_usd`;
  - a Codex row has `own_cost_usd` NULL.

  That keeps one per-request table under both cost bases. "At API prices" still reads only
  `priced`.

- [ ] **Step 1: `tests/helpers/agent-seed.ts`** (rollup tests seed `wt_*` directly, R21):

```ts
import { execFileSync } from "node:child_process";
import { applyWtSchema } from "@/lib/core/schema";
import { sqlNum, sqlStr } from "@/lib/core/sql";
import { rerollup } from "./fixture-db";

export type AgentEvent = "session_start" | "session_end" | "prompt" | "stop" | "activity";
export interface SeedRequest {
  id: string; ts: number; model?: string | null;
  tin?: number; tout?: number; tcr?: number; tcw?: number; cost?: number | null;
}
export interface SeedSession {
  source: "codex" | "hermes"; id: string; entry: string; driven: 0 | 1 | null;
  startedAt: number; cwd?: string;
  /** [epoch seconds, event]; seq is the array index, so ties keep this order. */
  events?: Array<[number, AgentEvent]>;
  requests?: SeedRequest[];
}

/**
 * Write Codex/Hermes sessions, events and requests straight into wt_*, the way
 * the adapters would, so a rollup test's numbers depend on rollup.sh alone.
 * canonical_id is "<source>:<id>". Registers each source in wt_sources.
 */
export function seedAgents(db: string, sessions: SeedSession[]): void {
  applyWtSchema(db);
  const now = 1790000000;
  const sql: string[] = [".bail on", "BEGIN;"];
  for (const src of new Set(sessions.map((s) => s.source))) {
    sql.push(`INSERT OR IGNORE INTO wt_sources (source, source_type, label, adapter_version, updated_at)
              VALUES (${sqlStr(src)}, 'agent', ${sqlStr(src)}, 1, ${now});`);
  }
  for (const s of sessions) {
    const cid = `${s.source}:${s.id}`;
    sql.push(`INSERT INTO wt_sessions (canonical_id, first_source, started_at, cwd, entry, driven, updated_at)
              VALUES (${sqlStr(cid)}, ${sqlStr(s.source)}, ${sqlNum(s.startedAt)}, ${sqlStr(s.cwd)},
                      ${sqlStr(s.entry)}, ${s.driven === null ? "NULL" : s.driven}, ${now});`);
    (s.events ?? []).forEach(([ts, event], seq) => {
      sql.push(`INSERT INTO wt_events (source, source_record_id, canonical_id, ts, kind, dimensions)
                VALUES (${sqlStr(s.source)}, ${sqlStr(`${s.id}:${seq}`)}, ${sqlStr(cid)}, ${ts}, 'event',
                        ${sqlStr(JSON.stringify({ event, seq }))});`);
    });
    for (const r of s.requests ?? []) {
      sql.push(`INSERT INTO wt_requests (source, source_record_id, canonical_id, ts, model,
                  tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, cost_usd)
                VALUES (${sqlStr(s.source)}, ${sqlStr(r.id)}, ${sqlStr(cid)}, ${r.ts}, ${sqlStr(r.model ?? null)},
                        ${r.tin ?? 0}, ${r.tout ?? 0}, ${r.tcr ?? 0}, ${r.tcw ?? 0}, ${sqlNum(r.cost ?? null)});`);
    }
  }
  sql.push("COMMIT;");
  execFileSync("sqlite3", [db], { input: sql.join("\n"), encoding: "utf8" });
}

/** Re-run rollup.sh (TZ=UTC) and fail loudly, with its stderr, on a non-zero exit. */
export function roll(db: string): void {
  const r = rerollup(db, ["--quiet"]);
  if (r.status !== 0) throw new Error(`rollup.sh exited ${r.status}: ${r.stderr}`);
}
```

  If `sqlStr(undefined)` does not already render `NULL`, check `lib/core/sql.ts:11`. It
  does: `sqlStr` takes `string | null | undefined`.

- [ ] **Step 2: the `agent-drift` scenario.** Add it to `tests/fixtures/make-fixture.sh`,
  before the `*)` arm:

```bash
  agent-drift)
    # Stage 5, guard 11: one event stream through Claude's rule here and through
    # the agent copy in tests/agent-rollup.test.ts, which seeds these same
    # offsets into wt_events. The ties at 2100 and 20010 resolve by insert order
    # in both. Claude's rule gives 16380 s; a >= in the working test gives 16680.
    sess S_DRIFT 0
    for pair in 0:SessionStart 4:UserPromptSubmit 20:PreToolUse 900:PostToolUse 960:Stop \
                1500:Notification 2100:UserPromptSubmit 2100:Stop 2700:Notification \
                2710:UserPromptSubmit 20000:PostToolUse 20010:Stop 20010:SessionEnd \
                25000:SessionStart 25010:UserPromptSubmit 25100:Stop; do
      ev S_DRIFT "${pair%%:*}" "${pair#*:}"
    done
    ;;
```

- [ ] **Step 3: Write the failing tests** in `tests/agent-rollup.test.ts`. Shared setup:
  - `base()` = `buildAndRoll("resumed")`, a Claude DB at v7 with Claude rows.
  - `T = 1789466400` (2026-09-15T10:00Z).
  - `progress(db)` = `rows(db, "SELECT * FROM agent_progress ORDER BY source")`.
  - Imports: `seedAgents` and `roll` from the helper; `rows`, `buildAndRoll` and `ROLLUP`
    from `./helpers/fixture-db`; `runSync`; `createCodexAdapter`; `createHermesAdapter`;
    `entryLists`.
  - Helpers `codexHome(scenario, cwd)` and `hermesHome(scenario)` run the Task 2/3 fixture
    scripts into a `mkdtemp` home, exactly as in `codex-adapter.test.ts` and
    `hermes-adapter.test.ts`.
  - Every test that syncs through an adapter calls `applyWtSchema(db)` before `runSync`, and
    `roll(db)` after it.

  Tests:

  1. **"automated and unclassified sessions earn no hours"** (guard 4). Seed three Codex
     sessions, all on 2026-09-15 with cwd `/tmp/wt-ag-one`:
     - `d` (`Codex Desktop`, driven 1): events `[T,session_start],[T+40,prompt],[T+100,stop]`,
       so 40 + 60 = 100;
     - `a` (`codex_exec`, driven 0): events `[T,session_start],[T+50,prompt],[T+250,stop]`;
     - `u` (`mystery`, driven null): events `[T,session_start],[T+60,prompt],[T+360,stop]`.

     Seed a fourth, `a2` (`codex_exec`, driven 0), on 2026-09-17: events
     `[T+172800,session_start],[T+172900,stop]`, and one request
     `{id:"a2-r", ts:T+172850, model:"gpt-5.5", tin:10}`.

     `roll`. Then:

     | day | `active_s` | `sessions_driven` | `sessions_automated` | `sessions_unclassified` | `requests` |
     |---|---|---|---|---|---|
     | 2026-09-15 | 100 | 1 | 1 | 1 | 0 |
     | 2026-09-17 | **null** | 0 | 1 | 0 | 1 |

  2. **"a model with no rate is not priced"** (guard 5; the only test with cost literals).
     Seed one driven Codex session `p` at `T`, cwd `/tmp/wt-ag-one`, with these requests:

     | id | ts | model | tin | tcr | tcw | tout |
     |---|---|---|---|---|---|---|
     | `r1` | T+10 | `gpt-5.5` | 600 | 400 | 0 | 200 |
     | `r2` | T+20 | `gpt-5.5` | 500 | 1500 | 0 | 300 |
     | `r3` | T+30 | `gpt-9-imaginary` | 50 | 0 | 0 | 5 |
     | `r4` | T+40 | `codex-auto-review` | 200 | 100 | 0 | 50 |
     | `r6` | T+50 | null | 10 | 0 | 0 | 1 |
     | `r7` | T+60 | `gpt-5.2` | 100 | 0 | 100 | 0 |
     | `r5` | 1704067200 | `gpt-5.5` | 100 | 0 | 0 | 10 |

     Also seed one Hermes session `hx` (`cli`, driven 1) at `T`, with request
     `{id:"hx-r", ts:T, model:"gpt-oss-120b", tin:10, cost:0.5}`. `roll`. Then:
     - `SELECT source_record_id, priced, price_note FROM agent_request_metrics ORDER BY 1`
       equals:
       - `hx-r` null null;
       - `r1` 1 null;
       - `r2` 1 null;
       - `r3` 0 `unknown-model`;
       - `r4` 0 `no-public-rate`;
       - `r5` 0 `no-price-yet`;
       - `r6` 0 `unknown-model`;
       - `r7` 1 null.
     - `cost_table_usd`:
       - `r1` toBeCloseTo(0.0092, 12);
       - `r2` toBeCloseTo(0.01225, 12);
       - `r7` toBeCloseTo(0.00035, 12). A cache write is billed at the input rate:
         (100 + 100) × 1.75 / 1e6.
       - It is null on `r3`, `r4`, `r5`, `r6` and `hx-r`.
     - `own_cost_usd` is 0.5 on `hx-r` and null on every Codex row.
     - The Codex daily row for 2026-09-15:
       - `priced_requests` 3 and `unpriced_requests` 3;
       - `cost_table_usd` toBeCloseTo(0.0218, 12).
     - The Hermes daily row for 2026-09-15:
       - `own_cost_usd` 0.5, `own_priced_requests` 1 and `own_unpriced_requests` 0;
       - `priced_requests` 0 and `unpriced_requests` 0.
  3. **"agent_prices carries the rates it used":**
     - Seed any Codex session, then `roll`.
     - `SELECT COUNT(*), COUNT(DISTINCT source), MIN(source), MIN(verified_on) FROM agent_prices`
       gives `7, 1, "https://developers.openai.com/api/docs/pricing", "2026-10-03"`.
     - The models are exactly the seven in R14.
  4. **"XP thresholds equal the OSRS formula"** (guard 7):

```ts
const src = readFileSync(ROLLUP, "utf8");
const list = src.slice(src.indexOf("INSERT INTO _ag_xp (level, xp) VALUES"));
const pairs = [...list.slice(0, list.indexOf(";")).matchAll(/\((\d+),(\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
let sum = 0;
const expected: number[][] = [];
for (let L = 1; L <= 99; L++) {
  if (L > 1) sum += Math.floor(L - 1 + 300 * 2 ** ((L - 1) / 7));
  expected.push([L, Math.floor(sum / 4)]);
}
expect(pairs).toEqual(expected);
expect([pairs[9][1], pairs[49][1], pairs[91][1], pairs[98][1]]).toEqual([1154, 101333, 6517253, 13034431]);
```

  5. **"a veteran past 99 earns floor stars"** (guard 8):
     - `base()`, then `runSync` with `createHermesAdapter({ db, home: hermesHome("veteran"), lists: entryLists("hermes", undefined) })`, then `roll`.
     - The Hermes row is `{ active_s: 11699999, xp: 16944758, level: 99, tier: "Master", xp_into_level: 3910327, xp_to_next: null, s_to_next: null, stars: 2 }`.
  6. **"the agent gap rule equals Claude's"** (guard 11):
     - `db = buildAndRoll("agent-drift")`.
     - Seed Codex session `drift` (`Codex Desktop`, driven 1) at `B = 1750000000`. Its events
       are the scenario's 16 offsets, in the same order, mapped as follows: `SessionStart`
       → `session_start`, `UserPromptSubmit` → `prompt`, `Stop` → `stop`, `SessionEnd` →
       `session_end`, anything else → `activity`. `roll`.
     - `SELECT active_ms FROM claude_daily_rollups` is `[16380000]`.
     - The `active_s` of both the `claude` and `codex` `agent_progress` rows is 16380.
  7. **"every tool levels by the OSRS formula"** (seeded, driven-only; the only lifetime
     literals besides the veteran):
     - `base()`. Seed Codex `c` (driven 1) with events `[T,session_start],[T+30,prompt],[T+330,stop]`,
       and Hermes `h` (`cli`, driven 1) with events
       `[T,session_start],[T+180,prompt],[T+480,stop]`. `roll`.
     - codex is `{active_s:330, xp:477, level:5, tier:"Noobie", xp_into_level:89, xp_to_next:35, s_to_next:24, stars:0}`.
     - hermes is `{active_s:480, xp:695, level:7, tier:"Noobie", xp_into_level:45, xp_to_next:106, s_to_next:74, stars:0}`.
     - Claude's `active_s` equals
       `SELECT SUM(active_ms) / 1000 FROM claude_daily_rollups`, and its `level` is not null.
  8. **"a synced tool with no driven hours has no level":**
     - Seed only an automated Codex session `a` (driven 0) with events and a request. `roll`.
     - The codex row is `{ active_s: 0, xp: 0, level: null, tier: null, xp_into_level: null, xp_to_next: null, s_to_next: null, stars: null }`.
  9. **"without Codex or Hermes, only Claude's progress row"** (spec §4.1):
     - `base()` with no seeding (no `wt_*` tables at all), `roll` again.
     - `SELECT source FROM agent_progress` is `["claude"]`.
     - `agent_prices`, `agent_request_metrics` and `agent_daily_rollups` hold 0 rows.
     - Then `applyWtSchema(db)` (tables exist, no Codex) and `roll`: the same four results.
  10. **"a resumed Codex session books only real activity"** (Review Focus 1):
      - `base()`, Codex `resume` through the adapter, then `roll`.
      - The Codex `agent_daily_rollups` rows `(day, active_s)` are `2026-09-15` 12 and
        `2026-09-18` 25.
      - `SELECT COUNT(*) FROM wt_sessions WHERE first_source='codex'` is 1.
  11. **"a session across local midnight splits by day"** (Review Focus 3):
      - `base()`, Codex `midnight` and Hermes `midnight` through the adapters, then `roll`.
      - Codex `(day, active_s, tokens_in)`:
        - `2026-09-20` 60 100;
        - `2026-09-21` 130 200.
      - Hermes `(day, active_s, requests)`:
        - `2026-09-20` 300 1;
        - `2026-09-21` 400 0.
  12. **"Codex end to end: hours, counts and identities"**:
      - `cwd` = a `mkdtemp` dir under `tmpdir()` with prefix `wt-codex-repo-`, after
        `git init -q`.
      - `base()`, Codex `core` with `WT_CODEX_CWD = cwd`, `runSync`, `roll`.
      - `key = rows(db, "SELECT project_path AS p FROM claude_project_paths WHERE cwd = '<cwd>'")[0].p`,
        and `key` is not null.
      - That project's Codex rows give `(day, active_s)`:
        - `2026-09-14` 15;
        - `2026-09-15` 220;
        - `2026-09-16` 95.
      - Per day, summed over all Codex rows, `(requests, sessions_driven, sessions_automated, sessions_unclassified)`
        is:
        - 09-14: 1, 1, 0, 0;
        - 09-15: 6, 1, 2, 1;
        - 09-16: 2, 1, 0, 0.
      - Identities, each as one SQL query returning zero mismatching rows:
        - per day, `SUM(requests)` = `COUNT(*)` of Codex `agent_request_metrics`;
        - per row, `priced_requests + unpriced_requests = requests`;
        - per day, `cost_table_usd` = `TOTAL(cost_table_usd)` of that day's metrics
          (`ABS(a - b) < 1e-12`);
        - per day, each token column = `SUM` over `wt_requests` for Codex, grouped by
          `strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime')`.
  13. **"Hermes end to end"**:
      - `base()`, Hermes `core`, `roll`.
      - Hermes `(day, active_s)`:
        - `2026-09-28` 460;
        - `2026-09-29` null;
        - `2026-10-01` 20.
      - Per day, `own_priced_requests + own_unpriced_requests = requests`, and every
        Hermes `agent_request_metrics.priced` is null.
  14. **"Claude's rollups are untouched by the agent section"**:
      - `db = buildAndRoll("dashboard")`. Dump `claude_daily_rollups`,
        `claude_project_rollups` and `claude_rank_progress`, without `updated_at`.
      - Seed a driven Codex session and `roll`. The three dumps are identical.

  15. **"a Codex cwd never delays a Claude cwd's resolution"**:
      - Use `buildAndRoll("resumed")`, then `DELETE FROM claude_project_paths`.
      - Seed a Codex session with cwd `/0-sorts-first` (seedAgents).
      - `rerollup(db, ["--quiet"], { WATCHTOWER_RESOLVE_PER_RUN: "1" })`.
      - `claude_project_paths` holds the fixture's Claude cwd and not `/0-sorts-first`.
      - A second run with the same cap resolves `/0-sorts-first` too.

  Also, in `tests/rollup-lock.test.ts`, add a describe block "Stage 5: the agent section's
  transactions". It applies the same four checks as the 4B block to the heredoc between
  `# ---- rebuild the agent rollups (Stage 5)` and `# ---- summary`:
  - the first statement is `BEGIN DEFERRED`;
  - `BEGIN IMMEDIATE` follows the first `COMMIT`;
  - before it, only `_`-prefixed temp writes;
  - these temp tables are created in the read phase:
    `["_ag_prices","_ag_no_rate","_ag_pwin","_ag_sess","_ag_rm","_ag_ev","_ag_gap","_ag_g","_ag_s","_ag_r","_ag_keys","_ag_daily","_ag_xp","_ag_life","_ag_prog"]`;
  - the write phase is exactly `DELETE FROM agent_prices`, its `INSERT … SELECT … FROM _ag_prices …`,
    and likewise for `agent_request_metrics` (`_ag_rm`), `agent_daily_rollups` (`_ag_daily`)
    and `agent_progress` (`_ag_prog`), then `COMMIT`.

  Generalise the existing `sectionOneStatements()` into `sectionStatements(from, to)`, and
  keep the 4B block's calls the same.

- [ ] **Step 4: Run them and watch them fail.**

  Run: `npx vitest run tests/agent-rollup.test.ts tests/rollup-lock.test.ts`

  Expected: FAIL. There are no `agent_*` tables yet, and the scenario is unknown until
  Step 2.

- [ ] **Step 5: `capture/lib.sh` v7.**
  - Set `CC_SCHEMA_VERSION=7`.
  - Above the `claude_rank_progress` DDL add:
    `-- DEPRECATED (Stage 5): the 5,000 h ladder. Still written exactly as before, for TheOneOS until its lockstep PR merges; agent_progress replaces it. Not removed in Stage 5.`
  - Append to the schema SQL, after the v6 tables:

```sql
-- Stage 5 (schema v7): the agent rollups. All four are REGENERABLE -- rollup.sh's
-- agent section DELETEs and re-INSERTs them on every run, from wt_* (written by
-- `watchtower sync`, never by a hook) and claude_daily_rollups.
CREATE TABLE IF NOT EXISTS agent_prices (
  model          TEXT NOT NULL,
  effective_from TEXT NOT NULL,           -- YYYY-MM-DD, UTC midnight
  input          REAL NOT NULL,           -- USD per 1M tokens
  cached_input   REAL NOT NULL,
  output         REAL NOT NULL,
  verified_on    TEXT NOT NULL,
  source         TEXT NOT NULL,           -- the pricing page the row was read from
  PRIMARY KEY (model, effective_from)
);

CREATE TABLE IF NOT EXISTS agent_request_metrics (
  source           TEXT NOT NULL,         -- 'codex' | 'hermes'
  source_record_id TEXT NOT NULL,
  canonical_id     TEXT,
  day              TEXT NOT NULL,         -- local day of the request
  project_key      TEXT NOT NULL,         -- its session's, as claude_project_paths resolves the cwd
  model            TEXT,
  priced           INTEGER,               -- NULL for Hermes; 0 with a price_note; 1
  price_note       TEXT,                  -- 'no-price-yet' | 'unknown-model' | 'no-public-rate'
  cost_table_usd   REAL,                  -- at API prices; NULL unless priced = 1
  own_cost_usd     REAL,                  -- Hermes's figure; NULL when Hermes did not price it
  PRIMARY KEY (source, source_record_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_request_metrics_day ON agent_request_metrics(source, day);

CREATE TABLE IF NOT EXISTS agent_daily_rollups (
  source                TEXT NOT NULL,
  day                   TEXT NOT NULL,    -- local day
  project_key           TEXT NOT NULL,
  active_s              INTEGER,          -- NULL: no driven gap on this row. Never 0 for "not measured".
  sessions_driven       INTEGER NOT NULL DEFAULT 0,   -- by start day
  sessions_automated    INTEGER NOT NULL DEFAULT 0,
  sessions_unclassified INTEGER NOT NULL DEFAULT 0,
  requests              INTEGER NOT NULL DEFAULT 0,
  tokens_in             INTEGER NOT NULL DEFAULT 0,
  tokens_out            INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read     INTEGER NOT NULL DEFAULT 0,
  tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
  -- Sums beside their counts: a reader decides "not priced" from the counts, never from a $0.
  cost_table_usd        REAL    NOT NULL DEFAULT 0,
  priced_requests       INTEGER NOT NULL DEFAULT 0,
  unpriced_requests     INTEGER NOT NULL DEFAULT 0,
  own_cost_usd          REAL    NOT NULL DEFAULT 0,
  own_priced_requests   INTEGER NOT NULL DEFAULT 0,
  own_unpriced_requests INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (source, day, project_key)
);

CREATE TABLE IF NOT EXISTS agent_progress (
  source        TEXT PRIMARY KEY,         -- 'claude' | 'codex' | 'hermes'
  active_s      INTEGER NOT NULL,         -- lifetime driven seconds
  xp            INTEGER NOT NULL,
  level         INTEGER,                  -- NULL when active_s = 0: no level, never Lv 1 for nothing
  tier          TEXT,
  xp_into_level INTEGER,
  xp_to_next    INTEGER,                  -- NULL at 99
  s_to_next     INTEGER,                  -- NULL at 99
  stars         INTEGER,                  -- one per 900,000 s past 9,000,000; NULL with no level
  updated_at    INTEGER NOT NULL
);
```

  `lib/config.ts`: set `schemaVersion: 7`. In `tests/config.test.ts:26`, 6 becomes 7. No
  `cc_added_columns` line is needed: v7 adds tables only.

- [ ] **Step 6: The resolver's `wt_sessions` arm** (`capture/rollup.sh`, `_resolve_new_cwds`).
  Replace the `unresolved=` assignment with the block below. It does two things:
  - Codex and Hermes cwds resolve by Claude's exact rules.
  - **Claude's cwds always come first** under the per-run cap
    (`WATCHTOWER_RESOLVE_PER_RUN`, default 20). Otherwise a first sync's hundreds of Codex
    cwds, sorted ahead of a new Claude cwd, would leave that Claude cwd `(unfiled)` for
    extra runs, and Claude's project rows would move.

```bash
  # Stage 5: Codex and Hermes sessions carry a cwd too, and resolve by the same
  # rules. Only when wt_sessions has the column: cc_sql_val swallows errors, so a
  # missing column would silently resolve NOTHING, Claude's cwds included. Claude's
  # cwds sort first (k = 0) so the per-run cap never delays one behind an agent's.
  local wt_arm=""
  [ "$(cc_sql_val "SELECT COUNT(*) FROM pragma_table_info('wt_sessions') WHERE name = 'cwd';")" = "1" ] &&
    wt_arm="UNION ALL SELECT DISTINCT cwd, 1 AS k FROM wt_sessions WHERE cwd IS NOT NULL AND cwd <> ''"
  unresolved="$(cc_sql_val "SELECT cwd FROM (
                              SELECT cwd, MIN(k) AS k FROM (
                                SELECT DISTINCT cwd, 0 AS k FROM claude_events
                                WHERE cwd IS NOT NULL AND cwd <> ''
                                UNION ALL
                                SELECT DISTINCT cwd, 0 AS k FROM claude_requests
                                WHERE cwd IS NOT NULL AND cwd <> ''
                                ${wt_arm}
                              ) GROUP BY cwd
                            )
                            WHERE cwd NOT IN (SELECT cwd FROM claude_project_paths)
                            ORDER BY k, cwd${limit_sql};")"
```

  Without the `wt_sessions` arm, the set and its order are the same as before: every
  Claude cwd has `k = 0`, so the order is `cwd` alone. `tests/project-rollup.test.ts` pins
  that and must stay green unchanged.

- [ ] **Step 7: The agent section.** Insert it after the profile section's closing `SQL` and
  before `# ---- summary`:

```bash
# ---- rebuild the agent rollups (Stage 5) -------------------------------------
# Codex and Hermes (from wt_*, written by `watchtower sync`) and every tool's
# level. Runs LAST, after every Claude section has committed, so a failure here
# can never cost Claude a number. Same two phases as the sections above: every
# intermediate under BEGIN DEFERRED (no write lock), and only the swap under
# BEGIN IMMEDIATE.
#
# A database that has never been synced at v3 has no wt_sessions.cwd/entry/
# driven. TEMP stand-ins shadow the main tables then (an unqualified name
# resolves to temp first), so the same SQL runs and writes only Claude's
# agent_progress row (spec 4.1).
_ag_ready="$(cc_sql_val "SELECT COUNT(*) FROM pragma_table_info('wt_sessions') WHERE name IN ('cwd','entry','driven');")"
_ag_prelude=""
[ "$_ag_ready" = "3" ] || _ag_prelude="
CREATE TEMP TABLE wt_sources (source TEXT PRIMARY KEY);
CREATE TEMP TABLE wt_sessions (canonical_id TEXT PRIMARY KEY, first_source TEXT, started_at INTEGER,
  cwd TEXT, entry TEXT, driven INTEGER);
CREATE TEMP TABLE wt_events (source TEXT, source_record_id TEXT, canonical_id TEXT, ts INTEGER,
  kind TEXT, dimensions TEXT);
CREATE TEMP TABLE wt_requests (source TEXT, source_record_id TEXT, canonical_id TEXT, ts INTEGER,
  model TEXT, tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER,
  tokens_cache_creation INTEGER, cost_usd REAL);"

{ printf '%s\n' "$_ag_prelude"; cat <<'SQL'
BEGIN DEFERRED;

DROP TABLE IF EXISTS _ag_prices;
CREATE TEMP TABLE _ag_prices (model TEXT, effective_from TEXT, input REAL, cached_input REAL,
  output REAL, verified_on TEXT, source TEXT);
-- Spec 4.3 / plan R14: OpenAI's published API rates, standard tier, USD per 1M
-- tokens, read 2026-10-03. One INSERT per model, so a price change is one new
-- line with a later effective_from and history is never repriced. No rate may
-- appear under lib/ (tests/cost-rollup.test.ts greps for them).
INSERT INTO _ag_prices VALUES ('gpt-6-astra','2025-01-01',10,1.00,50,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-6.1-sol','2025-01-01',2,0.10,10,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-5.6-sol','2025-01-01',4,0.40,20,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-5.5','2025-01-01',5,0.50,30,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-5.4-mini','2025-01-01',0.75,0.075,4.50,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-5.2','2025-01-01',1.75,0.175,14,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-5','2025-01-01',1.25,0.125,10,'2026-10-03','https://developers.openai.com/api/docs/pricing');

-- Models OpenAI does not sell on the API: 'no-public-rate', not 'unknown-model'.
DROP TABLE IF EXISTS _ag_no_rate;
CREATE TEMP TABLE _ag_no_rate (model TEXT PRIMARY KEY);
INSERT INTO _ag_no_rate VALUES ('codex-auto-review');

-- Each rate's window: from its effective_from to the next row's, as epoch seconds.
DROP TABLE IF EXISTS _ag_pwin;
CREATE TEMP TABLE _ag_pwin AS
SELECT model, input, cached_input, output,
       CAST(strftime('%s', effective_from) AS INTEGER) AS from_s,
       CAST(strftime('%s', LEAD(effective_from) OVER (PARTITION BY model ORDER BY effective_from)) AS INTEGER) AS until_s
FROM _ag_prices;

-- Codex and Hermes sessions with their project, keyed exactly as Claude's _pk
-- keys a cwd: excluded, unresolved and non-repo cwds are real rows.
DROP TABLE IF EXISTS _ag_sess;
CREATE TEMP TABLE _ag_sess AS
SELECT s.canonical_id, s.first_source, s.started_at, s.driven,
       CASE WHEN p.source = 'excluded'  THEN '(excluded)'
            WHEN p.project_path IS NULL THEN '(unfiled)'
            ELSE p.project_path
       END AS project_key
FROM wt_sessions s
LEFT JOIN claude_project_paths p ON p.cwd = s.cwd
WHERE s.first_source IN ('codex','hermes');
CREATE INDEX IF NOT EXISTS _ag_sess_id ON _ag_sess(canonical_id);

-- One row per request. Hermes rows carry Hermes's own figure and are never
-- priced here (decision 4: Hermes's figure never enters "at API prices").
-- The priced CASE has one branch per note, so each "not priced" is explicit.
DROP TABLE IF EXISTS _ag_rm;
CREATE TEMP TABLE _ag_rm AS
SELECT q.source, q.source_record_id, q.canonical_id, q.day, q.project_key, q.model,
       q.tokens_in, q.tokens_out, q.tokens_cache_read, q.tokens_cache_creation,
       q.priced,
       CASE WHEN q.priced = 0 THEN q.note END AS price_note,
       CASE WHEN q.priced = 1 THEN
         ((COALESCE(q.tokens_in, 0) + COALESCE(q.tokens_cache_creation, 0)) * q.input
          + COALESCE(q.tokens_cache_read, 0) * q.cached_input
          + COALESCE(q.tokens_out, 0) * q.output) / 1000000.0
       END AS cost_table_usd,
       CASE WHEN q.source = 'hermes' THEN q.cost_usd END AS own_cost_usd
FROM (
  SELECT r.source, r.source_record_id, r.canonical_id, r.model,
         strftime('%Y-%m-%d', r.ts, 'unixepoch', 'localtime') AS day,
         COALESCE(s.project_key, '(unfiled)') AS project_key,
         r.tokens_in, r.tokens_out, r.tokens_cache_read, r.tokens_cache_creation, r.cost_usd,
         w.input, w.cached_input, w.output,
         CASE WHEN r.source = 'hermes'                                         THEN NULL
              WHEN r.model IN (SELECT model FROM _ag_no_rate)                  THEN 0
              WHEN NOT EXISTS (SELECT 1 FROM _ag_prices p WHERE p.model = r.model) THEN 0
              WHEN w.model IS NULL                                             THEN 0
              ELSE                                                                  1
         END AS priced,
         CASE WHEN r.model IN (SELECT model FROM _ag_no_rate)                  THEN 'no-public-rate'
              WHEN NOT EXISTS (SELECT 1 FROM _ag_prices p WHERE p.model = r.model) THEN 'unknown-model'
              WHEN w.model IS NULL                                             THEN 'no-price-yet'
         END AS note
  FROM wt_requests r
  LEFT JOIN _ag_sess s ON s.canonical_id = r.canonical_id
  LEFT JOIN _ag_pwin w ON w.model = r.model AND r.ts >= w.from_s AND (w.until_s IS NULL OR r.ts < w.until_s)
  WHERE r.source IN ('codex','hermes')
) q;

-- Activity events of DRIVEN sessions only (decision 3): an automated or
-- unclassified session earns no hours.
DROP TABLE IF EXISTS _ag_ev;
CREATE TEMP TABLE _ag_ev AS
SELECT e.source, e.canonical_id, e.source_record_id, e.ts,
       json_extract(e.dimensions, '$.event') AS evt,
       json_extract(e.dimensions, '$.seq')   AS seq,
       s.project_key
FROM wt_events e
JOIN _ag_sess s ON s.canonical_id = e.canonical_id AND s.first_source = e.source AND s.driven = 1
WHERE e.source IN ('codex','hermes') AND e.kind = 'event';

-- Claude's gap rule (section 1's _act), unchanged in meaning: the gap ENDS at
-- the current event, a gap ending at session_start/session_end counts 0, one
-- ending at a prompt is think time, and while working (the last prompt later
-- than the last stop or session_start) a gap counts up to 4 h. Ties order by
-- the event's ordinal in its file or table. tests/agent-rollup.test.ts runs one
-- stream through both copies; they must agree to the second.
-- Booked to the local day of the event that ENDS the gap (plan R5), so a session
-- across midnight splits by day. Claude keeps booking to its start day.
DROP TABLE IF EXISTS _ag_gap;
CREATE TEMP TABLE _ag_gap AS
WITH ev AS (
  SELECT e.source, e.canonical_id, e.project_key, e.ts, e.evt,
         e.ts - LAG(e.ts) OVER (PARTITION BY e.canonical_id ORDER BY e.ts, e.seq, e.source_record_id) AS gap,
         MAX(CASE WHEN e.evt = 'prompt' THEN e.ts ELSE 0 END)
           OVER (PARTITION BY e.canonical_id ORDER BY e.ts, e.seq, e.source_record_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS last_work,
         MAX(CASE WHEN e.evt IN ('stop','session_start') THEN e.ts ELSE 0 END)
           OVER (PARTITION BY e.canonical_id ORDER BY e.ts, e.seq, e.source_record_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS last_idle
  FROM _ag_ev e
)
SELECT source, canonical_id, project_key,
       strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day,
       CASE WHEN gap IS NULL                              THEN 0
            WHEN evt IN ('session_start','session_end')   THEN 0
            WHEN evt = 'prompt'                           THEN MIN(gap, 300)
            WHEN last_work > last_idle                    THEN MIN(gap, 14400)
            ELSE                                               MIN(gap, 300)
       END AS active_s
FROM ev;

DROP TABLE IF EXISTS _ag_g;
CREATE TEMP TABLE _ag_g AS
SELECT source, day, project_key, SUM(active_s) AS active_s
FROM _ag_gap GROUP BY source, day, project_key;

-- Sessions count on their START day, by class.
DROP TABLE IF EXISTS _ag_s;
CREATE TEMP TABLE _ag_s AS
SELECT first_source AS source,
       strftime('%Y-%m-%d', started_at, 'unixepoch', 'localtime') AS day,
       project_key,
       SUM(CASE WHEN driven = 1 THEN 1 ELSE 0 END)     AS driven,
       SUM(CASE WHEN driven = 0 THEN 1 ELSE 0 END)     AS automated,
       SUM(CASE WHEN driven IS NULL THEN 1 ELSE 0 END) AS unclassified
FROM _ag_sess WHERE started_at IS NOT NULL
GROUP BY 1, 2, 3;

DROP TABLE IF EXISTS _ag_r;
CREATE TEMP TABLE _ag_r AS
SELECT source, day, project_key, COUNT(*) AS requests,
       COALESCE(SUM(tokens_in), 0)             AS tokens_in,
       COALESCE(SUM(tokens_out), 0)            AS tokens_out,
       COALESCE(SUM(tokens_cache_read), 0)     AS tokens_cache_read,
       COALESCE(SUM(tokens_cache_creation), 0) AS tokens_cache_creation,
       TOTAL(cost_table_usd)                   AS cost_table_usd,
       SUM(CASE WHEN priced = 1 THEN 1 ELSE 0 END) AS priced_requests,
       SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced_requests,
       TOTAL(own_cost_usd)                     AS own_cost_usd,
       SUM(CASE WHEN source = 'hermes' AND own_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS own_priced_requests,
       SUM(CASE WHEN source = 'hermes' AND own_cost_usd IS NULL     THEN 1 ELSE 0 END) AS own_unpriced_requests
FROM _ag_rm GROUP BY source, day, project_key;

DROP TABLE IF EXISTS _ag_keys;
CREATE TEMP TABLE _ag_keys AS
  SELECT source, day, project_key FROM _ag_g
  UNION SELECT source, day, project_key FROM _ag_s
  UNION SELECT source, day, project_key FROM _ag_r;

DROP TABLE IF EXISTS _ag_daily;
CREATE TEMP TABLE _ag_daily AS
SELECT k.source, k.day, k.project_key,
       g.active_s,
       COALESCE(s.driven, 0), COALESCE(s.automated, 0), COALESCE(s.unclassified, 0),
       COALESCE(r.requests, 0),
       COALESCE(r.tokens_in, 0), COALESCE(r.tokens_out, 0),
       COALESCE(r.tokens_cache_read, 0), COALESCE(r.tokens_cache_creation, 0),
       COALESCE(r.cost_table_usd, 0), COALESCE(r.priced_requests, 0), COALESCE(r.unpriced_requests, 0),
       COALESCE(r.own_cost_usd, 0), COALESCE(r.own_priced_requests, 0), COALESCE(r.own_unpriced_requests, 0)
FROM _ag_keys k
LEFT JOIN _ag_g g ON g.source = k.source AND g.day = k.day AND g.project_key = k.project_key
LEFT JOIN _ag_s s ON s.source = k.source AND s.day = k.day AND s.project_key = k.project_key
LEFT JOIN _ag_r r ON r.source = k.source AND r.day = k.day AND r.project_key = k.project_key
ORDER BY k.source, k.day, k.project_key;

-- OSRS: the XP needed for each level, xp(L) = floor(1/4 * sum_{l=1}^{L-1}
-- floor(l + 300 * 2^(l/7))). tests/agent-rollup.test.ts recomputes all 99.
DROP TABLE IF EXISTS _ag_xp;
CREATE TEMP TABLE _ag_xp (level INTEGER PRIMARY KEY, xp INTEGER NOT NULL);
INSERT INTO _ag_xp (level, xp) VALUES
(1,0),(2,83),(3,174),(4,276),(5,388),(6,512),(7,650),(8,801),(9,969),(10,1154),
(11,1358),(12,1584),(13,1833),(14,2107),(15,2411),(16,2746),(17,3115),(18,3523),(19,3973),(20,4470),
(21,5018),(22,5624),(23,6291),(24,7028),(25,7842),(26,8740),(27,9730),(28,10824),(29,12031),(30,13363),
(31,14833),(32,16456),(33,18247),(34,20224),(35,22406),(36,24815),(37,27473),(38,30408),(39,33648),(40,37224),
(41,41171),(42,45529),(43,50339),(44,55649),(45,61512),(46,67983),(47,75127),(48,83014),(49,91721),(50,101333),
(51,111945),(52,123660),(53,136594),(54,150872),(55,166636),(56,184040),(57,203254),(58,224466),(59,247886),(60,273742),
(61,302288),(62,333804),(63,368599),(64,407015),(65,449428),(66,496254),(67,547953),(68,605032),(69,668051),(70,737627),
(71,814445),(72,899257),(73,992895),(74,1096278),(75,1210421),(76,1336443),(77,1475581),(78,1629200),(79,1798808),(80,1986068),
(81,2192818),(82,2421087),(83,2673114),(84,2951373),(85,3258594),(86,3597792),(87,3972294),(88,4385776),(89,4842295),(90,5346332),
(91,5902831),(92,6517253),(93,7195629),(94,7944614),(95,8771558),(96,9684577),(97,10692629),(98,11805606),(99,13034431);

-- Lifetime driven seconds per tool. Claude's are its own hours, from the
-- daily rollup section 1 just committed (decision 8: unchanged). Codex and
-- Hermes appear only once sync has registered them.
DROP TABLE IF EXISTS _ag_life;
CREATE TEMP TABLE _ag_life AS
SELECT 'claude' AS source, COALESCE(SUM(active_ms), 0) / 1000 AS active_s FROM claude_daily_rollups
UNION ALL
SELECT w.source, COALESCE((SELECT SUM(g.active_s) FROM _ag_gap g WHERE g.source = w.source), 0)
FROM wt_sources w WHERE w.source IN ('codex','hermes');

-- Spec 4.4. XP = active_s * 13,034,431 / 9,000,000 (integer division: 2,500 h
-- is exactly 99). Level is the highest L with xp(L) <= XP, and NULL with no
-- driven seconds. s_to_next is the integer ceiling of the seconds that reach
-- xp(L+1). Stars: one per 900,000 s (250 h) past 9,000,000 s, floored.
DROP TABLE IF EXISTS _ag_prog;
CREATE TEMP TABLE _ag_prog AS
WITH x AS (
  SELECT source, active_s, active_s * 13034431 / 9000000 AS xp FROM _ag_life
), l AS (
  SELECT x.source, x.active_s, x.xp,
         CASE WHEN x.active_s > 0 THEN (SELECT MAX(t.level) FROM _ag_xp t WHERE t.xp <= x.xp) END AS level
  FROM x
)
SELECT l.source, l.active_s, l.xp, l.level,
       CASE WHEN l.level IS NULL THEN NULL
            WHEN l.level >= 99   THEN 'Master'
            WHEN l.level >= 85   THEN 'Pro'
            WHEN l.level >= 70   THEN 'Advanced'
            WHEN l.level >= 50   THEN 'Intermediate'
            WHEN l.level >= 25   THEN 'Builder'
            WHEN l.level >= 10   THEN 'Apprentice'
            ELSE                      'Noobie'
       END AS tier,
       l.xp - cur.xp AS xp_into_level,
       nxt.xp - l.xp AS xp_to_next,
       (nxt.xp * 9000000 + 13034430) / 13034431 - l.active_s AS s_to_next,
       CASE WHEN l.level IS NULL          THEN NULL
            WHEN l.active_s >= 9000000    THEN (l.active_s - 9000000) / 900000
            ELSE                               0
       END AS stars
FROM l
LEFT JOIN _ag_xp cur ON cur.level = l.level
LEFT JOIN _ag_xp nxt ON nxt.level = l.level + 1
ORDER BY l.source;

COMMIT;

BEGIN IMMEDIATE;
DELETE FROM agent_prices;
INSERT INTO agent_prices (model, effective_from, input, cached_input, output, verified_on, source)
SELECT model, effective_from, input, cached_input, output, verified_on, source FROM _ag_prices
WHERE EXISTS (SELECT 1 FROM wt_sources WHERE source IN ('codex','hermes'))
ORDER BY rowid;
DELETE FROM agent_request_metrics;
INSERT INTO agent_request_metrics (source, source_record_id, canonical_id, day, project_key, model,
  priced, price_note, cost_table_usd, own_cost_usd)
SELECT source, source_record_id, canonical_id, day, project_key, model,
       priced, price_note, cost_table_usd, own_cost_usd FROM _ag_rm ORDER BY rowid;
DELETE FROM agent_daily_rollups;
INSERT INTO agent_daily_rollups (source, day, project_key, active_s,
  sessions_driven, sessions_automated, sessions_unclassified, requests,
  tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation,
  cost_table_usd, priced_requests, unpriced_requests,
  own_cost_usd, own_priced_requests, own_unpriced_requests, updated_at)
SELECT *, CAST(strftime('%s','now') AS INTEGER) FROM _ag_daily ORDER BY rowid;
DELETE FROM agent_progress;
INSERT INTO agent_progress (source, active_s, xp, level, tier, xp_into_level, xp_to_next,
  s_to_next, stars, updated_at)
SELECT source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars,
       CAST(strftime('%s','now') AS INTEGER) FROM _ag_prog ORDER BY rowid;
COMMIT;
SQL
} | sqlite3 -cmd ".bail on" -cmd ".timeout 8000" "$DB" 2>/dev/null || { [ "$QUIET" -eq 1 ] || echo "cc-rollup: agent rebuild failed" >&2; exit 1; }
```

  Notes for the implementer:
  - **`MIN(gap,` count.** The agent copy adds two `MIN(gap, 300)` and one
    `MIN(gap, 14400)`. Change the two pins in `tests/capture-scripts.test.ts:82-83` to
    **4** and **3**. Extend the comment: "the agent section's copy of the rule (Stage 5)
    adds the prompt and think caps and the work cap; it has no window_s".
  - **Scope of the `priced` CASE.** The `WHERE EXISTS` in `agent_prices` makes spec §4.1's
    "only Claude's `agent_progress` row and nothing else" literal when no agent source has
    synced.
  - **The read-phase guard.** `_ag_daily`'s `SELECT *` relies on the column order above.
    `tests/rollup-lock.test.ts` checks the shape, not the order. Test 12's identities would
    catch a swapped column.

- [ ] **Step 8: Run the agent tests.**

  Run: `npx vitest run tests/agent-rollup.test.ts tests/rollup-lock.test.ts`

  Expected: PASS.

- [ ] **Step 9: Update the guards that this stage extends.**
  - `tests/capture-scripts.test.ts`:
    - the count pins become 4 and 3, as in Step 7;
    - in the "schema v6" describe, replace the four `.schema-v6` literals (lines 611, 723,
      760, 766) with `` `.schema-v${schemaVersion()}` ``;
    - add `describe("schema v7")` with one test. `cc_init_db` on a fresh DB in its own
      `mkdtemp` dir creates `agent_prices`, `agent_request_metrics`, `agent_daily_rollups`,
      `agent_progress` and `idx_agent_request_metrics_day`, and stamps `.schema-v7`.
      A second test: a DB built by `buildV5` gains them too after one `cc_init_db`.
  - `tests/cost-rollup.test.ts:222`: the needle list becomes
    `["6.25", "3.75", "12.5", "about-claude/pricing", "developers.openai.com/api/docs/pricing", "0.175", "0.075"]`.
    Run it before adding the needles and confirm `lib/` holds none of them (it held none
    in planning).
  - `tests/project-rollup.test.ts`: no change. Run it to confirm the resolver arm leaves
    every Claude project row identical.

- [ ] **Step 10: The suite.**

  Run: `npm test && npm run typecheck && bash -n capture/rollup.sh && bash -n capture/lib.sh && bash -n tests/fixtures/make-fixture.sh`

  Expected: PASS. Every pre-existing rollup test stays green, which shows Claude's numbers
  did not move.

- [ ] **Step 11: Plant guards 4, 5, 7, 8 and 11, one at a time.**

  | # | Plant | Exactly this test turns red |
  |---|---|---|
  | 4 | delete `AND s.driven = 1` from `_ag_ev` | "automated and unclassified sessions earn no hours" |
  | 5 | in `_ag_rm`'s `priced` CASE, the `NOT EXISTS … THEN 0` branch becomes `THEN 1` | "a model with no rate is not priced" |
  | 7 | `(92,6517253)` → `(92,6517254)` | "XP thresholds equal the OSRS formula" |
  | 8 | `(l.active_s - 9000000) / 900000` → `ROUND((l.active_s - 9000000) / 900000.0)` | "a veteran past 99 earns floor stars" |
  | 11 | `last_work > last_idle` → `last_work >= last_idle`, **in the agent section only** | "the agent gap rule equals Claude's" |

  For each plant:
  - run `npx vitest run tests/agent-rollup.test.ts tests/rollup-lock.test.ts tests/capture-scripts.test.ts`;
  - record the red test names in the report;
  - revert.

  If a plant reds a second test, restructure that second test (R21). Do not loosen the
  first.

- [ ] **Step 12: Live check** on a fresh live copy, running the setup block in a subshell.
  - Run `node bin/watchtower sync` with `HOME` real.
  - Then run
    `sqlite3 "$L/db.sqlite" "SELECT * FROM agent_progress; SELECT source, COUNT(*), SUM(active_s), SUM(requests) FROM agent_daily_rollups GROUP BY 1; SELECT price_note, COUNT(*) FROM agent_request_metrics WHERE source='codex' GROUP BY 1;"`.
  - Record the output.
  - Claude must be **Lv 77 Advanced**, give or take what new usage since 2026-10-03
    added. The rollup's stderr must be empty.

- [ ] **Step 13: Commit.**

```bash
git add capture lib/config.ts tests
git commit -m "feat(rollup): schema v7 — agent hours, Codex cost at API prices, OSRS levels for every tool"
```

---
### Task 6: The level card on History and Live; the ladder retires

**Files:**
- Create:
  - `lib/read/level.ts`;
  - `lib/render/level.ts`;
  - `lib/render/empty.ts` (spec §5's strings, verbatim);
  - `tests/read-level.test.ts`;
  - `tests/render-level.test.ts`.
- Modify:
  - `lib/read/history.ts`: `HistoryData.level`;
  - `lib/render/history.ts`: the hero;
  - `lib/read/live.ts` and `lib/render/live.ts`: `LiveData.level` replaces `rank`;
  - `lib/render/layout.ts` and `lib/render/client.ts`: drop the `.ladder`/`.rung` styles and
    the `.ladder ol` tab stop;
  - tests: `render-history.test.ts` (lines ~259, 305, 352), `render-live.test.ts` (31, 255,
    291), `read-live.test.ts` (122), `render-theme.test.ts` (252) and
    `capture-scripts.test.ts`, whose swept list names `render/ladder.ts`.
- Delete: `lib/render/ladder.ts` and `tests/render-ladder.test.ts`.

**Interfaces:**
- Consumes: `agent_progress` (Task 5).
- Produces, used by Tasks 7, 8 and 10:
  - `AgentSource = "claude" | "codex" | "hermes"`, `AGENT_SOURCES`, `AGENT_LABEL`;
  - `Level`, `LevelState`;
  - `hasTable(db, name)`;
  - `readLevels(db)` and `readLevel(db, source)`;
  - `totalLevel(states)` and `maxCape(states)`;
  - `formatXp(xp)`, `levelBlock(state)` and `levelCard({ title, state, hero? })`;
  - from `lib/render/empty.ts`: `NOT_SYNCED`, `NO_DRIVEN_HOURS`, `AUTOMATED_ONLY`,
    `NO_REQUESTS`, `ROLLUP_PENDING`, `LEVEL_PENDING`, `NO_OPENVIKING`, `MEMORY_CAPTION`,
    `dataAsOf(when)`, `unreachableAt(when)` and `lookedFor(label, where)`.

- [ ] **Step 1: Write the failing tests.**

  `tests/render-level.test.ts`. The fixtures are hand-built `Level` objects:
  - `LV77 = { source:"claude", activeS:1051920, xp:1523464, level:77, tier:"Advanced", xpIntoLevel:47883, xpToNext:105736, sToNext:73009, stars:0 }`;
  - `LV99 = { source:"hermes", activeS:11699999, xp:16944758, level:99, tier:"Master", xpIntoLevel:3910327, xpToNext:null, sToNext:null, stars:2 }`.

  Tests:
  1. `formatXp`:
     - 1523464 gives `"1.52M"`;
     - 16944758 gives `"16.94M"`;
     - 23722 gives `"23.7K"`;
     - 9999 gives `"9,999"`;
     - 477 gives `"477"`;
     - 1999999 gives `"1.99M"` (floored, never rounded up).
  2. `levelBlock({state:"level", level: LV77})` contains:
     - `>Lv 77<`, `Advanced` and `1.52M XP`;
     - `20.3h to Lv 78`;
     - `aria-valuenow="31"` and `<i style="width:31.2%"></i>`.
  3. `levelBlock({state:"level", level: LV99})`:
     - contains `aria-label="2 stars past 99"` and `★★`;
     - does not contain `to Lv`;
     - contains `<i style="width:100.0%"></i>`.
  4. `levelBlock({state:"none", activeS:0})` contains `No driven hours yet.` and no `Lv `.
  5. `levelBlock({state:"pending"})` contains `level pending` and no `Lv `.
  6. **The strings are spec §5's, verbatim:**
     - `NOT_SYNCED === "Not synced yet — open the dashboard or run \`watchtower sync\`."`;
     - `NO_DRIVEN_HOURS === "No driven hours yet."`;
     - `AUTOMATED_ONLY === "automated only"`;
     - `NO_REQUESTS === "no requests"`;
     - `NO_OPENVIKING === "no OpenViking on this machine"`;
     - `MEMORY_CAPTION === "memory — not counted in totals"`;
     - `unreachableAt("14:02") === "Unreachable at last sync (14:02)"`;
     - `dataAsOf("2026-10-03 14:02") === "data as of 2026-10-03 14:02"`.

  `tests/read-level.test.ts`. It uses `buildAndRoll`, and `seedAgents`/`roll` from Task 5.
  1. **"reads every tool's stored level":**
     - Take `buildAndRoll("resumed")`, seed Codex `c` (driven, 330 s, as in Task 5 test 7), then `roll`.
     - `readLevels(db)`:
       - `.codex` is `{state:"level", level:{source:"codex", activeS:330, xp:477, level:5, tier:"Noobie", xpIntoLevel:89, xpToNext:35, sToNext:24, stars:0}}`;
       - `.claude.state` is `"level"`;
       - `.hermes` is `{state:"pending"}`, because it has no row.
  2. **"no driven seconds is none, not Lv 1":** seed only an automated Codex session and
     `roll`. `readLevel(db,"codex")` gives `{state:"none", activeS:0}`.
  3. **"no agent_progress table is pending for everyone":**
     `sqlite3 db "DROP TABLE agent_progress"` on a `buildAndRoll` copy. All three states are
     `{state:"pending"}`.
  4. `totalLevel`:
     - `[L(77), L(5), {state:"none",activeS:0}]` gives 82;
     - `[{state:"pending"}]` gives null.
  5. `maxCape([L(99 with xpToNext null), L(5), {state:"none",activeS:0}])` gives
     `{at99:1, of:3}`.

  Here `L(n)` is a `{state:"level"}` with that level. Its `xpToNext` is null exactly when
  `n` is 99.

- [ ] **Step 2: Run them and watch them fail.**

  Run: `npx vitest run tests/read-level.test.ts tests/render-level.test.ts`

  Expected: FAIL (modules missing).

- [ ] **Step 3: `lib/read/level.ts`.**

```ts
/**
 * Every tool's level, as `agent_progress` stores it (Stage 5, spec 4.4). The
 * rollup computes XP, level, tier, the distance to the next level and stars;
 * this module reads, sums and counts them and computes nothing else.
 */
import { querySql, sqlStr } from "../core/sql.ts";

export type AgentSource = "claude" | "codex" | "hermes";
export const AGENT_SOURCES: readonly AgentSource[] = ["claude", "codex", "hermes"];
export const AGENT_LABEL: Record<AgentSource, string> = { claude: "Claude Code", codex: "Codex", hermes: "Hermes" };

export interface Level {
  source: AgentSource;
  /** Lifetime driven seconds. */
  activeS: number;
  xp: number;
  level: number;
  tier: string;
  xpIntoLevel: number;
  /** Null at the top level. */
  xpToNext: number | null;
  sToNext: number | null;
  /** One per 250 h past the top level; 0 below it. */
  stars: number;
}

/**
 * What a level card can say. `pending`: no row, because the installed rollup
 * predates schema v7 or has not run since this tool was synced. `none`: a row
 * with no driven seconds, so there is no level ("No driven hours yet.") --
 * never Lv 1 for nothing.
 */
export type LevelState =
  | { state: "pending" }
  | { state: "none"; activeS: number }
  | { state: "level"; level: Level };

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

/** Whether `name` is a table in `db`: a reader of a v7 or wt table on an older database says "pending", never errors. */
export function hasTable(db: string, name: string): boolean {
  return read<{ n: number }>(db,
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${sqlStr(name)};`)[0].n > 0;
}

interface Row {
  source: string; active_s: number; xp: number; level: number | null; tier: string | null;
  xp_into_level: number | null; xp_to_next: number | null; s_to_next: number | null; stars: number | null;
}

function toState(r: Row | undefined): LevelState {
  if (r === undefined) return { state: "pending" };
  if (r.level === null || r.tier === null) return { state: "none", activeS: r.active_s };
  return {
    state: "level",
    level: {
      source: r.source as AgentSource, activeS: r.active_s, xp: r.xp, level: r.level, tier: r.tier,
      xpIntoLevel: r.xp_into_level ?? 0, xpToNext: r.xp_to_next, sToNext: r.s_to_next, stars: r.stars ?? 0,
    },
  };
}

export function readLevels(db: string): Record<AgentSource, LevelState> {
  const rows = hasTable(db, "agent_progress")
    ? read<Row>(db, `SELECT source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars
                     FROM agent_progress;`)
    : [];
  const by = new Map(rows.map((r) => [r.source, r]));
  return { claude: toState(by.get("claude")), codex: toState(by.get("codex")), hermes: toState(by.get("hermes")) };
}

export function readLevel(db: string, source: AgentSource): LevelState {
  return readLevels(db)[source];
}

/** Total level (spec 4.4): the sum over the tools that have one; null when none does. */
export function totalLevel(states: readonly LevelState[]): number | null {
  const levels = states.flatMap((s) => (s.state === "level" ? [s.level.level] : []));
  return levels.length === 0 ? null : levels.reduce((a, b) => a + b, 0);
}

/**
 * Max Cape progress over the detected tools: how many are at the top level, of
 * how many. "At the top" is the rollup's own NULL xp_to_next, so no level
 * number lives here.
 */
export function maxCape(states: readonly LevelState[]): { at99: number; of: number } {
  return {
    at99: states.filter((s) => s.state === "level" && s.level.xpToNext === null).length,
    of: states.length,
  };
}
```

- [ ] **Step 4: `lib/render/empty.ts`.**

```ts
/**
 * Spec §5's "when there is nothing to measure" strings, verbatim, in one
 * place. A missing measurement is never shown as zero.
 */
export const NOT_SYNCED = "Not synced yet — open the dashboard or run `watchtower sync`.";
export const NO_DRIVEN_HOURS = "No driven hours yet.";
export const AUTOMATED_ONLY = "automated only";
export const NO_REQUESTS = "no requests";
export const ROLLUP_PENDING = "rollup pending";
export const LEVEL_PENDING = "level pending";
export const NO_OPENVIKING = "no OpenViking on this machine";
export const MEMORY_CAPTION = "memory — not counted in totals";
export const dataAsOf = (when: string): string => `data as of ${when}`;
export const unreachableAt = (when: string): string => `Unreachable at last sync (${when})`;
export const lookedFor = (label: string, where: string): string =>
  `Watchtower looked for ${label} at ${where} and found nothing.`;
```

- [ ] **Step 5: `lib/render/level.ts`.**

```ts
/**
 * The level card (spec §5): one component for Claude Code, Codex and Hermes,
 * on History, Live, the Overview and the agent pages. Shows the stored level,
 * tier, XP in OSRS style, a meter to the next level and the hours left, or
 * stars past the top. Display arithmetic only: a meter's percent from two
 * stored columns, and stored seconds shown as hours.
 */
import type { Level, LevelState } from "../read/level.ts";
import { LEVEL_PENDING, NO_DRIVEN_HOURS } from "./empty.ts";
import { esc, grouped, num } from "./html.ts";
import { card } from "./layout.ts";

/** OSRS-style XP: "1.52M", "23.7K", "477". Floored, so a figure never rounds up past what was earned. */
export function formatXp(xp: number): string {
  if (xp >= 1e6) return `${(Math.floor(xp / 1e4) / 100).toFixed(2)}M`;
  if (xp >= 1e4) return `${(Math.floor(xp / 100) / 10).toFixed(1)}K`;
  return grouped(xp);
}

function meter(l: Level): string {
  const span = l.xpToNext === null ? null : l.xpIntoLevel + l.xpToNext;
  const pct = span === null ? 100 : span > 0 ? (100 * l.xpIntoLevel) / span : 0;
  return `<div class="meter" role="progressbar" aria-label="XP through this level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${num(pct, 0)}"><i style="width:${num(pct, 1)}%"></i></div>`;
}

function next(l: Level): string {
  if (l.xpToNext !== null && l.sToNext !== null) {
    return `<div class="muted block">${esc(formatXp(l.xp))} XP · ${num(l.sToNext / 3600, 1)}h to Lv ${l.level + 1}</div>`;
  }
  const stars = l.stars > 0
    ? ` · <span class="stars" aria-label="${l.stars} ${l.stars === 1 ? "star" : "stars"} past 99">${"★".repeat(Math.min(l.stars, 10))}${l.stars > 10 ? ` ×${l.stars}` : ""}</span>`
    : "";
  return `<div class="muted block">${esc(formatXp(l.xp))} XP${stars}</div>`;
}

/** The level, or the reason there is none -- never "Lv 1" or "0 XP" for nothing. */
export function levelBlock(s: LevelState): string {
  if (s.state === "pending") {
    return `<div class="state absent">${esc(LEVEL_PENDING)}</div><div class="muted">the rollup has not run since this tool was synced</div>`;
  }
  if (s.state === "none") return `<div class="state absent">${esc(NO_DRIVEN_HOURS)}</div>`;
  const l = s.level;
  return `<div class="big lv">Lv ${l.level}</div><div class="muted label">${esc(l.tier)}</div>` + meter(l) + next(l);
}

export function levelCard(opts: { title: string; state: LevelState; hero?: boolean }): string {
  return card({ title: opts.title, body: levelBlock(opts.state), hero: opts.hero });
}
```

  Add one rule to `LAYOUT_CSS`: `.stars { letter-spacing: .08em; color: var(--ink); }`.

- [ ] **Step 6: History.**
  - `lib/read/history.ts`:
    - add `import { readLevel, type LevelState } from "./level.ts";`;
    - add the field `/** Claude Code's level (agent_progress); the hero shows it. */ level: LevelState;`
      to `HistoryData`;
    - in `readHistory`'s return, add `level: readLevel(db, "claude")`.
  - `HistoryData.rank` stays. It still carries lifetime hygiene and active hours from
    `claude_rank_progress` (R20).
  - `lib/render/history.ts`:
    - replace the `./ladder.ts` import with `import { levelBlock } from "./level.ts";`;
    - replace `rankCard` with the function below, and rename its call site.

```ts
/**
 * The hero: Claude Code's level (Stage 5; the 5,000 h ladder retired), the
 * lifetime active hours it is earned from, lifetime hygiene and the streaks.
 * A lifetime card -- the range never moves it. With nothing computed there is
 * no number at all, and a current streak of none is said in words.
 */
function levelHero(d: HistoryData): string {
  const r = d.rank;
  const s = d.streaks;
  const hrs = r === null ? null : num(r.activeHours, 1);
  const hours =
    r === null
      ? `<div class="muted label">no active hours computed yet</div>`
      : `<div class="big"${Number.isFinite(r.activeHours) ? ` data-count="${hrs}"` : ""}>${hrs}<span class="unit">h</span></div>` +
        `<div class="muted label">active hours, lifetime</div>`;
  const facts = [
    r === null ? kv("lifetime hygiene", dash) : kv("lifetime hygiene", `<b>${num(r.hygiene, 1)}</b>`),
    kv("current streak", s.current === 0 ? `<b class="absent">no current streak</b>` : `<b>${s.current} ${s.current === 1 ? "day" : "days"}</b>`),
    s.longest === 0
      ? kv("longest streak", dash)
      : kv(`longest · ended ${s.longestEndsOn}`, `<b>${s.longest} days</b>`),
  ].join("");
  return card({
    title: "Level",
    hero: true,
    body: `<div class="rank-hero"><div class="rank-side">${levelBlock(d.level)}<div class="block">${hours}</div><div class="block">${facts}</div></div></div>`,
  });
}
```

  Update the header comment at the top of `lib/render/history.ts` ("the rank ladder (the
  hero)") to "Claude Code's level (the hero)".

- [ ] **Step 7: Live.**
  - `lib/read/live.ts`:
    - import `readLevel` and `LevelState` from `./level.ts`;
    - replace the field `rank: Rank | null` with
      `/** Claude Code's level (agent_progress). */ level: LevelState;`;
    - replace `rank: readRank(db)` with `level: readLevel(db, "claude")`;
    - drop `readRank` and `Rank` from the import if nothing else uses them.
  - `lib/render/live.ts`:
    - delete `rankBody`;
    - import `levelBlock`;
    - the region line becomes `region("level", "Level", levelBlock(d.level)),`;
    - the header comment's "rank" becomes "level".

- [ ] **Step 8: Delete the ladder.**
  - `git rm lib/render/ladder.ts tests/render-ladder.test.ts`.
  - In `lib/render/layout.ts`, remove every CSS rule whose selector names `.ladder` or
    `.rung`, and remove `, .ladder ol:focus-visible` from the focus-visible selector list
    (line ~215).
  - In `lib/render/client.ts`, `GROUPS` becomes `"figure.chart svg, svg.spark, .comp"`, and
    the comment at line 12 drops "and ladder".
  - Then `grep -rn "ladder\|rung" lib tests`. What remains should be only the Usage
    Profile's own "Usage ladder" card (`lib/render/profile.ts`), which is a different
    component and stays.

- [ ] **Step 9: Update the tests that pinned the rank.**
  - `tests/render-live.test.ts`:
    - line ~31: the `rank:` fixture becomes `level: { state: "level", level: LV77 }`, using
      the same LV77 as above, declared in the file;
    - line ~255: `"rank"` becomes `"level"` in the region list;
    - line ~291: the test becomes "shows the level with a meter to the next level". It
      expects `>Lv 77<`, `<i style="width:31.2%"></i>` and `20.3h to Lv 78`, and checks that
      `renderLivePanel(data({ level: { state: "pending" } }))` contains `level pending`.
  - `tests/read-live.test.ts:122`: the test becomes "carries Claude Code's level". It
    expects `d.level` to equal `readLevel(db, "claude")` and `d.level.state` not to be
    `"pending"`.
  - `tests/render-history.test.ts`:
    - ~305: the test becomes "makes the level the one hero card". It expects
      `<section class="c hero"><h2>Level</h2>`, matches `/<div class="big lv">Lv \d+<\/div>/`,
      keeps the `data-count="0.5"` assertion and drops the rung assertion;
    - ~352: `"<h2>Rank</h2>"` becomes `"<h2>Level</h2>"`;
    - ~259 "shows the streaks and the rank": drop the `xp` and next-tier expectations, and
      keep the streak ones;
    - where a test builds `HistoryData` by hand, add `level: { state: "pending" }`.
  - `tests/render-theme.test.ts:252`: `"ladder.ts"` becomes `"level.ts"`.
  - `tests/capture-scripts.test.ts`: the swept list's `"render/ladder.ts"` becomes
    `"render/level.ts"`, and add `"read/level.ts"`. That list proves the `MIN(gap,` sweep
    covers the dashboard files.

- [ ] **Step 10: Run everything.**

  Run: `npm test && npm run typecheck`

  Expected: PASS. In particular `report-budget.test.ts` stays green: the level block is
  smaller than the ladder it replaces.

- [ ] **Step 11: Commit.**

```bash
git add -A lib tests
git commit -m "feat(level): one OSRS level card on History and Live; the rank ladder retires"
```

---

### Task 7: Overview, and the tool row becomes real links

**Files:**
- Create:
  - `lib/read/tools.ts`;
  - `lib/read/overview.ts`;
  - `lib/render/overview.ts`;
  - tests `tests/read-overview.test.ts` and `tests/render-overview.test.ts`.
- Modify:
  - `lib/render/layout.ts`: `TOOLS` and `toolRow(active, tools)`; `INERT_NAV` and
    `inertPill` are removed;
  - `lib/render/report.ts`: the tool row's anchors;
  - `lib/views.ts`: `ViewContext.home` and the `/overview` view;
  - `lib/render/cost.ts`: Hermes's figure labels. Task 8 uses them too; they land here
    because the Overview shows the figure first;
  - `tests/serve.test.ts:40-60` and `tests/report-budget.test.ts`.

**Interfaces:**
- Consumes:
  - Task 6's `hasTable`, `readLevels`, `totalLevel`, `maxCape`, `levelBlock` and the empty
    strings;
  - Task 3's `lookedAt`;
  - `API_COST_SQL`, `apiCostOf` and `sumApiCosts` from `lib/read/perf.ts`.
- Produces, used by Task 8:
  - `ToolStatus` and `toolStatus(db, source, home?)`;
  - `agentTotals(db, source, from, today): AgentTotals`;
  - `dayRange(db, range, now)`;
  - `HERMES_FIGURE`, `HERMES_UNPRICED`, `hermesCostLabel`, `hermesCostHtml`,
    `hermesCostBold` and `hermesCostCell`;
  - `TOOLS` and `ToolLink`.
  - The type of Hermes's own figure is `ApiCost`, the same `{usd, priced, unpriced}` shape.
    It is labelled only by the `hermesCost*` functions and is never passed to
    `sumApiCosts` together with an API-price cost.

- [ ] **Step 1: Write the failing tests.**

  `tests/read-overview.test.ts`. `NOW = Math.floor(Date.parse("2026-10-03T12:00:00Z")/1000)`.
  `HOME` is an empty `mkdtemp` dir unless stated.

  Tests:
  1. **"Hermes's figure never enters at API prices"** (guard 6; the only test with the
     Overview's cost literals):
     - `db = buildAndRoll("priced-mixed")`.
     - Seed (Task 5 helper) Codex `c` (`Codex Desktop`, driven) with request
       `{id:"c1", ts:1789466410, model:"gpt-5.5", tin:600, tcr:400, tout:200}`.
     - Seed Hermes `h` (`cli`, driven) with `{id:"h1", ts:1789466400, model:"x", tin:10, cost:0.5}`.
     - Insert `wt_ingest_state` rows `('codex', …, last_ok_at = NOW, health 'ok')` and the
       same for hermes. Then `roll`.
     - `const d = readOverview(db, { now: NOW, range: "all", home: HOME })`.
     - `claudeApi = apiCostOf(rows(db, "SELECT " + API_COST_SQL + " FROM claude_request_metrics")[0])`.
     - Expect:
       - `d.apiCost.usd` toBeCloseTo(`claudeApi.usd + 0.0092`, 12);
       - `d.apiCost.priced` = `claudeApi.priced + 1`;
       - `d.hermesCost` = `{usd:0.5, priced:1, unpriced:0}`.
  2. **"shows a card per detected tool, and none for a missing one":**
     - On the same kind of DB with no Hermes seeded and no `.hermes` in `HOME`, the
       `d.tools.map(t => t.source)` is `["claude","codex"]`.
     - With `mkdir -p HOME/.hermes && touch HOME/.hermes/state.db`, it is
       `["claude","codex","hermes"]`, and Hermes's `status.state` is `"not-synced"`.
  3. **"a synced tool whose last sync failed says so":** set
     `wt_ingest_state.health='degraded'` for codex. Codex's `status` is
     `{state:"synced", degraded:true, lastOkAt: NOW, …}`.
  4. **"Total level and Max Cape count the detected tools":** in the guard-6 setup,
     - `d.totalLevel` equals the sum of the three `readLevels` levels that are `"level"`;
     - `d.maxCape.of` is 3.
  5. **"no agent rollup yet is pending, not zero":**
     - `DROP TABLE agent_daily_rollups; DROP TABLE agent_progress` on a copy.
     - `d.rollupPending` is true.
     - The Codex card's `activeS`, `requests` and `apiCost` are null.
     - Its `level` is `{state:"pending"}`.
  6. **"OpenViking: unreachable, with the last recall and capture":**
     - Seed `wt_events` and `wt_usage` for source `openviking` directly:
       - `reachable:1790600200` with probe `health`, `reachable` 0;
       - `recall:1790600000` with probe `recall`: `recall_count` 3, `recall_latency_ms` 42,
         `recall_tokens` 512;
       - `capture:1790600100` with probe `capture`: `capture_turns` 4, `capture_committed` 1.
     - `d.openviking` equals
       `{state:"seen", checkedAt:1790600200, reachable:false, recall:{at:1790600000, count:3, latencyMs:42, tokens:512}, capture:{at:1790600100, turns:4, committed:true}}`.
     - Without any OpenViking rows, it is `{state:"absent"}`.
  7. **"days are stacked by tool":** in the guard-6 setup with `range: "all"`, `d.daily`
     has one entry per day from the first day of data to today. For 2026-09-15, Codex's
     `codexS` is null: `c` has no events, so it earned no hours.

  `tests/render-overview.test.ts`, on hand-built `OverviewData`:
  1. It renders one card per tool, titled with `AGENT_LABEL`.
  2. The cost card shows `at API prices` with `apiCostBold`'s text. `Hermes's figure` is a
     separate key-value, never inside the API figure.
  3. Not-synced Hermes renders `NOT_SYNCED` verbatim, with no level and no zero.
  4. OpenViking:
     - unreachable renders `unreachableAt(minute(1790600200, "UTC"))`, and recall and
       capture each with their age (`duration(now - at)`);
     - absent renders `no OpenViking on this machine`;
     - the card always carries `memory — not counted in totals`.
  5. Total level shows the number, and Max Cape shows `1 of 3 tools at 99`. With
     `totalLevel: null` it shows `—` in the absent style.

  `tests/serve.test.ts`. Replace the inert-entry assertions at lines 51–53 with these.
  - On `/`:
    - `<a class="pill t-overview" href="/overview">Overview</a>`;
    - `<span class="pill on tool-cc" aria-current="true">Claude Code</span>`;
    - `<a class="pill t-agent" href="/codex">Codex</a>`;
    - `<a class="pill t-agent" href="/hermes">Hermes</a>`;
    - and no `pill soon` anywhere.
  - `GET /overview` is 200 and contains `<span class="pill on t-overview" aria-current="true">Overview</span>`
    and `<a class="pill tool-cc" href="/">Claude Code</a>`.
  - The server under test is started with `home` → a temp dir, through `ViewContext.home`;
    see Step 6.

- [ ] **Step 2: Run them and watch them fail.**

  Run: `npx vitest run tests/read-overview.test.ts tests/render-overview.test.ts tests/serve.test.ts`

  Expected: FAIL.

- [ ] **Step 3: `lib/read/tools.ts`.**

```ts
/**
 * Whether a tool is installed, and whether sync has read it -- the states spec
 * §5 names before any number: not installed (no card), installed but never
 * synced, synced, and synced with the last attempt failed ("data as of").
 */
import { existsSync } from "node:fs";
import os from "node:os";
import { lookedAt } from "../core/discovery.ts";
import { querySql, sqlStr } from "../core/sql.ts";
import { hasTable } from "./level.ts";

export type ToolStatus =
  | { state: "not-installed"; lookedAt: string }
  | { state: "not-synced"; lookedAt: string }
  | { state: "synced"; lookedAt: string; lastOkAt: number; degraded: boolean; lastError: string | null };

/**
 * Synced history wins over the filesystem: a tool uninstalled after a sync
 * keeps its page, because its wt_* rows are durable (spec §5, last row).
 */
export function toolStatus(db: string, source: "codex" | "hermes", home: string = os.homedir()): ToolStatus {
  const where = lookedAt(source, home);
  const r = hasTable(db, "wt_ingest_state")
    ? querySql<{ ok: number | null; health: string; err: string | null }>(db,
        `SELECT last_ok_at AS ok, health, last_error AS err FROM wt_ingest_state WHERE source = ${sqlStr(source)};`,
        { readonly: true })[0]
    : undefined;
  if (r !== undefined && r.ok !== null) {
    return { state: "synced", lookedAt: where, lastOkAt: r.ok, degraded: r.health === "degraded", lastError: r.err };
  }
  return existsSync(where) ? { state: "not-synced", lookedAt: where } : { state: "not-installed", lookedAt: where };
}
```

- [ ] **Step 4: `lib/render/cost.ts`.** Add after `claudeCodeCostCell`:

```ts
/** Hermes's own cost figure (spec decision 4): beside "at API prices", never inside it. */
export const HERMES_FIGURE = "Hermes's figure";
/** Hermes recorded no cost for these requests: neither an actual nor an estimate. */
export const HERMES_UNPRICED = "Hermes didn't price this";

/**
 * Hermes's figure in words, over `ApiCost`'s shape: `usd` is the sum of what
 * Hermes priced, `priced`/`unpriced` count the rows it did and did not price.
 * A genuine $0.00 is a reading here -- Hermes priced a free model at $0 -- but
 * "nothing priced" is never $0.
 */
export function hermesCostLabel(c: ApiCost | null): string {
  if (c === null || c.priced + c.unpriced === 0) return NO_READING;
  if (c.priced === 0) return HERMES_UNPRICED;
  return c.unpriced > 0 ? `${usd(c.usd)} · ${c.unpriced} unpriced by Hermes` : usd(c.usd);
}

export function hermesCostHtml(c: ApiCost | null): string {
  const text = esc(hermesCostLabel(c));
  return hasApiCost(c) ? text : `<span class="absent">${text}</span>`;
}

export function hermesCostBold(c: ApiCost | null): string {
  return `<b${hasApiCost(c) ? "" : ` class="absent"`}>${esc(hermesCostLabel(c))}</b>`;
}

export function hermesCostCell(c: ApiCost | null): SortCell {
  return { html: hermesCostHtml(c), sort: hasApiCost(c) ? Math.round(c.usd * 1e4) / 1e4 : null };
}
```

  Add a `tests/cost-labels` case to the existing cost-label tests (`grep -ln apiCostLabel tests`):
  - `hermesCostLabel(null)` gives `"no reading"`;
  - `{usd:0, priced:0, unpriced:1}` gives `"Hermes didn't price this"`;
  - `{usd:0, priced:1, unpriced:0}` gives `"$0.00"`;
  - `{usd:0.5123, priced:3, unpriced:1}` gives `"$0.51 · 1 unpriced by Hermes"`.

- [ ] **Step 5: `lib/read/overview.ts`.**

```ts
/**
 * The Overview (spec §5): a card per detected tool, active hours stacked by
 * tool, Total level and Max Cape, the two cost bases kept apart, and the
 * OpenViking card. Every number is a stored rollup value, summed or counted;
 * nothing here derives an hour, a price or a level.
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { eachDay } from "./history.ts";
import { AGENT_LABEL, hasTable, maxCape, readLevels, totalLevel, type AgentSource, type LevelState } from "./level.ts";
import { API_COST_SQL, apiCostOf, sumApiCosts, type ApiCost } from "./perf.ts";
import { DEFAULT_RANGE, rangeStartDay, type Range } from "./range.ts";
import { toolStatus, type ToolStatus } from "./tools.ts";

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });

/** A Codex or Hermes tool's figures over a span of days, from agent_daily_rollups. Null fields are "not measured". */
export interface AgentTotals {
  /** Null when no row in the span has a driven gap. */
  activeS: number | null;
  sessions: { driven: number; automated: number; unclassified: number };
  requests: number;
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number };
  /** Codex: at API prices. Null for Hermes. */
  apiCost: ApiCost | null;
  /** Hermes: its own figure. Null for Codex. */
  hermesCost: ApiCost | null;
}

/** The span a range covers, as local days: `from` is null for "all". */
export function dayRange(db: string, range: Range, now: number): { from: string | null; today: string } {
  const today = read<{ d: string }>(db, `SELECT date(${sqlNum(now)}, 'unixepoch', 'localtime') AS d;`)[0].d;
  return { from: rangeStartDay(today, range), today };
}

const inSpan = (col: string, from: string | null, today: string): string =>
  `${col} <= ${sqlStr(today)}${from === null ? "" : ` AND ${col} >= ${sqlStr(from)}`}`;

export function agentTotals(db: string, source: "codex" | "hermes", from: string | null, today: string): AgentTotals {
  const r = read<{
    active_s: number | null; driven: number | null; automated: number | null; unclassified: number | null;
    requests: number | null; tin: number | null; tout: number | null; tcr: number | null; tcw: number | null;
    usd: number; priced: number | null; unpriced: number | null;
    own_usd: number; own_priced: number | null; own_unpriced: number | null;
  }>(db,
    `SELECT SUM(active_s) AS active_s, SUM(sessions_driven) AS driven, SUM(sessions_automated) AS automated,
            SUM(sessions_unclassified) AS unclassified, SUM(requests) AS requests,
            SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(tokens_cache_read) AS tcr,
            SUM(tokens_cache_creation) AS tcw,
            TOTAL(cost_table_usd) AS usd, SUM(priced_requests) AS priced, SUM(unpriced_requests) AS unpriced,
            TOTAL(own_cost_usd) AS own_usd, SUM(own_priced_requests) AS own_priced,
            SUM(own_unpriced_requests) AS own_unpriced
     FROM agent_daily_rollups WHERE source = ${sqlStr(source)} AND ${inSpan("day", from, today)};`)[0];
  return {
    activeS: r.active_s,
    sessions: { driven: r.driven ?? 0, automated: r.automated ?? 0, unclassified: r.unclassified ?? 0 },
    requests: r.requests ?? 0,
    tokens: { in: r.tin ?? 0, out: r.tout ?? 0, cacheRead: r.tcr ?? 0, cacheWrite: r.tcw ?? 0 },
    apiCost: source === "codex" ? apiCostOf({ usd: r.usd, priced: r.priced, unpriced: r.unpriced }) : null,
    hermesCost: source === "hermes" ? apiCostOf({ usd: r.own_usd, priced: r.own_priced, unpriced: r.own_unpriced }) : null,
  };
}

export interface ToolSummary {
  source: AgentSource;
  label: string;
  /** Claude Code is always present: its data comes from the hooks, not from sync. */
  status: ToolStatus | { state: "core" };
  level: LevelState;
  /** In range. Null: nothing measured -- not synced, rollup pending, or no driven hours. */
  activeS: number | null;
  /** Claude: its session count, with no driven split (decision 8). */
  sessions: { total: number; driven: number | null; automated: number | null } | null;
  requests: number | null;
  tokens: { in: number; out: number } | null;
  apiCost: ApiCost | null;
  hermesCost: ApiCost | null;
}

export type OpenVikingState =
  | { state: "absent" }
  | {
      state: "seen"; checkedAt: number; reachable: boolean;
      recall: { at: number; count: number | null; latencyMs: number | null; tokens: number | null } | null;
      capture: { at: number; turns: number | null; committed: boolean | null } | null;
    };

export interface OverviewDay { day: string; claudeS: number | null; codexS: number | null; hermesS: number | null }

export interface OverviewData {
  range: Range;
  today: string;
  generatedAt: number;
  /** The installed rollup has not written agent_daily_rollups yet (v6 or never run since sync). */
  rollupPending: boolean;
  tools: ToolSummary[];
  daily: OverviewDay[];
  totalLevel: number | null;
  maxCape: { at99: number; of: number };
  /** Claude Code + Codex, at API prices. Hermes's figure is NEVER summed in here (decision 4). */
  apiCost: ApiCost | null;
  hermesCost: ApiCost | null;
  openviking: OpenVikingState;
}

function claudeSummary(db: string, from: string | null, today: string, level: LevelState): ToolSummary {
  const d = read<{ rows: number; active_ms: number | null; sessions: number | null; tin: number | null; tout: number | null }>(db,
    `SELECT COUNT(*) AS rows, SUM(active_ms) AS active_ms, SUM(sessions_count) AS sessions,
            SUM(tokens_in) AS tin, SUM(tokens_out) AS tout
     FROM claude_daily_rollups WHERE ${inSpan("day", from, today)};`)[0];
  const m = hasTable(db, "claude_request_metrics")
    ? read<{ n: number; usd: number; priced: number | null; unpriced: number | null }>(db,
        `SELECT COUNT(*) AS n, ${API_COST_SQL} FROM claude_request_metrics WHERE ${inSpan("day", from, today)};`)[0]
    : undefined;
  return {
    source: "claude", label: AGENT_LABEL.claude, status: { state: "core" }, level,
    activeS: d.rows === 0 || d.active_ms === null ? null : Math.floor(d.active_ms / 1000),
    sessions: { total: d.sessions ?? 0, driven: null, automated: null },
    requests: m?.n ?? null,
    tokens: { in: d.tin ?? 0, out: d.tout ?? 0 },
    apiCost: m === undefined ? null : apiCostOf(m),
    hermesCost: null,
  };
}

function agentSummary(db: string, source: "codex" | "hermes", status: ToolStatus, level: LevelState,
                      pending: boolean, from: string | null, today: string): ToolSummary {
  const base = { source, label: AGENT_LABEL[source], status, level };
  if (status.state !== "synced" || pending) {
    return { ...base, activeS: null, sessions: null, requests: null, tokens: null, apiCost: null, hermesCost: null };
  }
  const t = agentTotals(db, source, from, today);
  return {
    ...base, activeS: t.activeS,
    sessions: { total: t.sessions.driven + t.sessions.automated + t.sessions.unclassified, driven: t.sessions.driven, automated: t.sessions.automated },
    requests: t.requests, tokens: { in: t.tokens.in, out: t.tokens.out },
    apiCost: t.apiCost, hermesCost: t.hermesCost,
  };
}

function readOpenViking(db: string): OpenVikingState {
  if (!hasTable(db, "wt_events") || !hasTable(db, "wt_usage")) return { state: "absent" };
  const latest = (probe: string): { ts: number; m: Map<string, number> } | null => {
    const rows = read<{ ts: number; metric: string; value: number }>(db,
      `SELECT e.ts, u.metric, u.value
       FROM wt_events e JOIN wt_usage u ON u.source = e.source AND u.source_record_id = e.source_record_id
       WHERE e.source = 'openviking' AND e.source_record_id = (
         SELECT source_record_id FROM wt_events
         WHERE source = 'openviking' AND json_extract(dimensions, '$.probe') = ${sqlStr(probe)}
         ORDER BY ts DESC, source_record_id DESC LIMIT 1);`);
    return rows.length === 0 ? null : { ts: rows[0].ts, m: new Map(rows.map((r) => [r.metric, r.value])) };
  };
  const h = latest("health");
  if (h === null) return { state: "absent" };
  const rc = latest("recall");
  const cp = latest("capture");
  return {
    state: "seen", checkedAt: h.ts, reachable: h.m.get("reachable") === 1,
    recall: rc === null ? null : {
      at: rc.ts, count: rc.m.get("recall_count") ?? null,
      latencyMs: rc.m.get("recall_latency_ms") ?? null, tokens: rc.m.get("recall_tokens") ?? null,
    },
    capture: cp === null ? null : {
      at: cp.ts, turns: cp.m.get("capture_turns") ?? null,
      committed: cp.m.has("capture_committed") ? cp.m.get("capture_committed") === 1 : null,
    },
  };
}

function daily(db: string, from: string | null, today: string, sources: readonly AgentSource[], pending: boolean): OverviewDay[] {
  const claude = new Map(read<{ day: string; s: number | null }>(db,
    `SELECT day, active_ms / 1000 AS s FROM claude_daily_rollups WHERE ${inSpan("day", from, today)};`).map((r) => [r.day, r.s]));
  const agent = new Map<string, number | null>();
  if (!pending && sources.some((s) => s !== "claude")) {
    for (const r of read<{ source: string; day: string; s: number | null }>(db,
      `SELECT source, day, SUM(active_s) AS s FROM agent_daily_rollups
       WHERE ${inSpan("day", from, today)} GROUP BY source, day;`)) agent.set(`${r.source}|${r.day}`, r.s);
  }
  const first = from ?? [...claude.keys(), ...[...agent.keys()].map((k) => k.split("|")[1])].sort()[0];
  if (first === undefined) return [];
  return eachDay(first, today).map((day) => ({
    day,
    claudeS: claude.get(day) ?? null,
    codexS: sources.includes("codex") ? agent.get(`codex|${day}`) ?? null : null,
    hermesS: sources.includes("hermes") ? agent.get(`hermes|${day}`) ?? null : null,
  }));
}

export function readOverview(db: string, opts: { now?: number; range?: Range; home?: string } = {}): OverviewData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const range = opts.range ?? DEFAULT_RANGE;
  const { from, today } = dayRange(db, range, now);
  const pending = !hasTable(db, "agent_daily_rollups");
  const levels = readLevels(db);
  const tools: ToolSummary[] = [claudeSummary(db, from, today, levels.claude)];
  for (const source of ["codex", "hermes"] as const) {
    const status = toolStatus(db, source, opts.home);
    if (status.state === "not-installed") continue;
    tools.push(agentSummary(db, source, status, levels[source], pending, from, today));
  }
  const detected = tools.map((t) => t.level);
  const hermes = tools.find((t) => t.source === "hermes");
  return {
    range, today, generatedAt: now, rollupPending: pending, tools,
    daily: daily(db, from, today, tools.map((t) => t.source), pending),
    totalLevel: totalLevel(detected),
    maxCape: maxCape(detected),
    apiCost: sumApiCosts(tools.map((t) => t.apiCost)),
    hermesCost: hermes?.hermesCost ?? null,
    openviking: readOpenViking(db),
  };
}
```

- [ ] **Step 6: The tool row, `ViewContext.home` and the view.**

  `lib/render/layout.ts`:
  - Delete `INERT_NAV` and `inertPill`.
  - Add the following, and give `PageOpts` a field
    `/** The tool row's links. Defaults to the served routes; \`report\` passes in-page anchors. */ tools?: ToolLink[];`.
    `page()` calls `toolRow(opts.active, opts.tools ?? TOOLS)`.
  - In the sidebar CSS, `.grp-later` becomes `.grp-agents` and `.t-later` becomes `.t-agent`.

```ts
export interface ToolLink { label: string; href: string; cls: string }

/** Every tool, and the Overview: real links since Stage 5 (spec §5 Nav). */
export const TOOLS: ToolLink[] = [
  { label: "Overview", href: "/overview", cls: "t-overview" },
  { label: "Claude Code", href: "/", cls: "tool-cc" },
  { label: "Codex", href: "/codex", cls: "t-agent" },
  { label: "Hermes", href: "/hermes", cls: "t-agent" },
];

/**
 * The tool row. The current tool is a span, the rest are links. Claude Code is
 * current on every page of the page row (its pages); the report, whose active
 * is "", has no current tool, and every entry is an in-page anchor.
 */
function toolRow(active: string, tools: ToolLink[]): string {
  const own = tools.find((t) => t.href === active && t.cls !== "tool-cc");
  const current = own ?? (NAV.some((n) => n.href === active) ? tools.find((t) => t.cls === "tool-cc") : undefined);
  const pill = (t: ToolLink): string =>
    t === current
      ? `<span class="pill on ${t.cls}" aria-current="true">${esc(t.label)}</span>`
      : `<a class="pill ${t.cls}" href="${esc(t.href)}">${esc(t.label)}</a>`;
  return (
    `<nav class="tools" aria-label="Tools">` +
    `<span class="grp grp-all">All tools</span>` + pill(tools[0]) + pill(tools[1]) +
    `<span class="grp grp-agents">Agents</span>` + pill(tools[2]) + pill(tools[3]) +
    `</nav>`
  );
}
```

  `lib/render/report.ts` `renderReport`: pass
  `tools: [{ label: "Overview", href: "#overview", cls: "t-overview" }, { label: "Claude Code", href: "#history", cls: "tool-cc" }, { label: "Codex", href: "#codex", cls: "t-agent" }, { label: "Hermes", href: "#hermes", cls: "t-agent" }]`
  to `page()`.

  `lib/views.ts`:
  - Add the field `/** The home directory tools are looked for under. Tests inject one; default os.homedir(). */ home?: string;`
    to `ViewContext`.
  - In `buildReport`, the reassignment keeps it: `ctx = { db: ctx.db, now: ctx.now, configured: ctx.configured, tz: ctx.tz ?? localZone(), home: ctx.home };`.
  - Insert the overview **first** in `STATIC_VIEWS`:
    `{ href: "/overview", ranged: true, build: (c) => overviewView(readOverview(c.db, { now: c.now, range: c.range, home: c.home }), { tz: c.tz }) },`.
  - `lib/serve.ts` passes `home: opts.home` into `renderStaticRoute`'s context. Add
    `home?: string` to `ServeOptions` (`lib/serve.ts:19`), which `bin/watchtower` leaves unset. In
    `serve.test.ts` the server is started with `home: <mkdtemp>`.

- [ ] **Step 7: `lib/render/overview.ts`.**

```ts
/**
 * The Overview view (spec §5). Two cost bases, kept apart: "at API prices"
 * (Claude Code + Codex) and Hermes's figure beside it. OpenViking is memory:
 * shown, never counted in a total.
 */
import { AGENT_LABEL } from "../read/level.ts";
import type { OverviewData, OverviewDay, ToolSummary } from "../read/overview.ts";
import { buckets, bucketName, rangeLabel } from "../read/range.ts";
import { stackedBar } from "./charts.ts";
import { API_PRICES, apiCostBold, HERMES_FIGURE, hermesCostBold } from "./cost.ts";
import {
  AUTOMATED_ONLY, dataAsOf, MEMORY_CAPTION, NO_DRIVEN_HOURS, NO_OPENVIKING, NO_REQUESTS, NOT_SYNCED,
  ROLLUP_PENDING, unreachableAt,
} from "./empty.ts";
import { compact, duration, esc, grouped, localZone, minute, num, stamp, zoneNote } from "./html.ts";
import { card, type View } from "./layout.ts";
import { levelBlock } from "./level.ts";

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const absent = (s: string) => `<b class="absent">${esc(s)}</b>`;

function hoursFigure(t: ToolSummary): string {
  if (t.activeS !== null) return `<b>${num(t.activeS / 3600, 1)}h</b>`;
  if (t.requests !== null && t.requests > 0 && (t.sessions?.driven ?? 0) === 0) return absent(AUTOMATED_ONLY);
  return absent(NO_DRIVEN_HOURS);
}

function toolCard(t: ToolSummary, tz: string): string {
  if (t.status.state === "not-synced") {
    return card({ title: t.label, body: `<div class="state absent">${esc(NOT_SYNCED)}</div>` });
  }
  const pending = t.requests === null && t.status.state === "synced";
  const asOf = t.status.state === "synced" && t.status.degraded
    ? `<p class="note">${esc(dataAsOf(stamp(t.status.lastOkAt, tz)))}</p>` : "";
  if (pending) {
    return card({ title: t.label, body: levelBlock(t.level) + `<div class="state absent">${esc(ROLLUP_PENDING)}</div>` + asOf });
  }
  const sessions = t.sessions === null ? absent("—")
    : t.sessions.driven === null ? `<b>${grouped(t.sessions.total)}</b>`
    : `<b>${grouped(t.sessions.driven)} driven · ${grouped(t.sessions.automated ?? 0)} automated</b>`;
  const cost = t.source === "hermes" ? kv(HERMES_FIGURE, hermesCostBold(t.hermesCost)) : kv(API_PRICES, apiCostBold(t.apiCost));
  const facts = [
    kv("active hours", hoursFigure(t)),
    kv("sessions", sessions),
    kv("requests", t.requests === null || t.requests === 0 ? absent(NO_REQUESTS) : `<b>${grouped(t.requests)}</b>`),
    kv("tokens in + out", t.tokens === null ? absent("—") : `<b>${compact(t.tokens.in + t.tokens.out)}</b>`),
    cost,
  ].join("");
  return card({ title: t.label, body: levelBlock(t.level) + `<div class="block">${facts}</div>` + asOf });
}

function totalsCard(d: OverviewData): string {
  const total = d.totalLevel === null ? `<div class="big absent">—</div>` : `<div class="big">${d.totalLevel}</div>`;
  return card({
    title: "Total level",
    body: total + `<div class="muted label">summed over the tools with a level</div>` +
      `<div class="block">${kv("Max Cape", `<b>${d.maxCape.at99} of ${d.maxCape.of} tools at 99</b>`)}</div>`,
  });
}

function costCard(d: OverviewData): string {
  const hermes = d.tools.some((t) => t.source === "hermes")
    ? kv(HERMES_FIGURE, hermesCostBold(d.hermesCost)) : "";
  return card({
    title: "Cost",
    body: kv(`${API_PRICES} · Claude Code + Codex`, apiCostBold(d.apiCost)) + hermes +
      `<p class="note">Hermes's figure is Hermes's own record of what it spent. It is shown beside the API-price figure, never added into it.</p>`,
  });
}

function dailyCard(d: OverviewData): string {
  const shown = d.tools.map((t) => t.source);
  const series = shown.map((s) => AGENT_LABEL[s]);
  const pick = (x: OverviewDay, s: string): number =>
    (s === "claude" ? x.claudeS : s === "codex" ? x.codexS : x.hermesS) ?? 0;
  const byDay = new Map(d.daily.map((x) => [x.day, x]));
  const { buckets: bs } = buckets(d.daily.map((x) => x.day));
  const columns = bs.map((b) => {
    const parts = shown.map((s) => b.days.reduce((a, day) => a + pick(byDay.get(day) as OverviewDay, s), 0) / 3600);
    return { label: b.label, parts, title: `${bucketName(b)}: ${parts.map((p, i) => `${series[i]} ${num(p, 1)}h`).join(" · ")}` };
  });
  return card({
    title: `Active hours by tool · ${rangeLabel(d.range)}`, wide: true,
    body: stackedBar({ columns, series, label: "active hours by tool", format: (v) => `${num(v, 1)}h`, emptyText: "no active hours in this range" }),
  });
}

function openVikingCard(d: OverviewData, tz: string): string {
  const o = d.openviking;
  const caption = `<div class="muted label">${esc(MEMORY_CAPTION)}</div>`;
  if (o.state === "absent") return card({ title: "OpenViking", body: caption + `<div class="state absent">${esc(NO_OPENVIKING)}</div>` });
  const head = o.reachable
    ? `<div class="state">Reachable at last sync (${esc(minute(o.checkedAt, tz))})</div>`
    : `<div class="state absent">${esc(unreachableAt(minute(o.checkedAt, tz)))}</div>`;
  const ago = (at: number) => `${duration(d.generatedAt - at)} ago`;
  const recall = o.recall === null ? kv("last recall", absent("none recorded"))
    : kv("last recall", `<b>${o.recall.count === null ? "—" : grouped(o.recall.count)} items · ${o.recall.latencyMs === null ? "—" : `${grouped(o.recall.latencyMs)} ms`} · ${o.recall.tokens === null ? "—" : compact(o.recall.tokens)} tokens, ${esc(ago(o.recall.at))}</b>`);
  const capture = o.capture === null ? kv("last capture", absent("none recorded"))
    : kv("last capture", `<b>${o.capture.turns === null ? "—" : grouped(o.capture.turns)} turns${o.capture.committed === true ? ", committed" : ""}, ${esc(ago(o.capture.at))}</b>`);
  return card({ title: "OpenViking", body: caption + head + `<div class="block">${recall}${capture}</div>` });
}

export function overviewSections(d: OverviewData, tz: string): string[] {
  return [
    `<div class="g g-2">`, ...d.tools.map((t) => toolCard(t, tz)), `</div>`,
    `<div class="g g-2">`, totalsCard(d), costCard(d), `</div>`,
    dailyCard(d),
    openVikingCard(d, tz),
  ];
}

export function overviewView(d: OverviewData, opts: { tz?: string } = {}): View {
  const tz = opts.tz ?? localZone();
  const sections = overviewSections(d, tz);
  return {
    href: "/overview",
    title: "Overview",
    body: sections.join(""),
    sections,
    footer:
      `generated ${stamp(d.generatedAt, tz)} · days are local, ${zoneNote(tz, d.generatedAt)} · ` +
      `from claude_daily_rollups, agent_daily_rollups, agent_progress and wt_* · hours count driven sessions only`,
  };
}
```

  If `minute`, `stamp` or `zoneNote` are not exported under those names, check
  `lib/render/html.ts:96-122`: all three are.

- [ ] **Step 8: The budget.** Add `overview` to `PER_WEEK_LIMIT` in
  `tests/report-budget.test.ts`.
  - Run the test once with a deliberately low limit, e.g. 1, and read the measured figure
    from the failure message.
  - Pin `overview` at the measured figure plus 15%, rounded up to the next 10, and update
    the comment's table.
  - The density fixtures hold only Claude data, so the Overview's growth is its weekly
    bucketed stack: `buckets()` turns weekly past 90 days.
  - If `total` now exceeds its limit, raise it by exactly the Overview's measured growth,
    and say so in the report.

- [ ] **Step 9: Run everything.**

  Run: `npm test && npm run typecheck`

  Expected: PASS.

- [ ] **Step 10: Plant guard 6.**
  - In `readOverview`, change `apiCost: sumApiCosts(tools.map((t) => t.apiCost))` to
    `sumApiCosts([...tools.map((t) => t.apiCost), hermes?.hermesCost])`.
  - Exactly "Hermes's figure never enters at API prices" turns red. Revert, and record it.

- [ ] **Step 11: Commit.**

```bash
git add -A lib tests
git commit -m "feat(overview): Overview page — every tool's level, hours by tool, two cost bases apart; the tool row is real"
```

---

### Task 8: The Codex and Hermes pages, and the Atlas line on Sessions

**Files:**
- Create:
  - `lib/read/agent.ts`;
  - `lib/render/agent.ts`;
  - tests `tests/read-agent.test.ts` and `tests/render-agent.test.ts`.
- Modify:
  - `lib/views.ts`: `/codex` and `/hermes`;
  - `lib/read/sessions.ts`: `SessionRow.atlas`;
  - `lib/render/sessions.ts`: the Atlas line;
  - `tests/read-sessions.test.ts` and `tests/render-sessions.test.ts`;
  - `tests/report-budget.test.ts`.

**Interfaces:**
- Consumes:
  - Task 7's `agentTotals`, `dayRange`, `toolStatus`, `hermesCost*` and `TOOLS`;
  - Task 6's `readLevel`, `hasTable`, `levelCard` and the empty strings.
- Produces:
  - `readAgent(db, source, { now, range, home })`, giving `AgentData`;
  - `agentView(d, { tz })`.

- [ ] **Step 1: Write the failing tests.**

  `tests/read-agent.test.ts`. The Codex DB is Task 5 test 12's setup (Codex `core` through
  the adapter, a git cwd, `roll`), with `HOME` = the codex home. `NOW` = 2026-10-03T12:00Z,
  and `range: "all"`.
  1. `readAgent(db, "codex", …)`:
     - `.status.state` is `"synced"`;
     - `.level.state` is `"level"`;
     - `.unclassified` is `[{ entry: "mystery-client", sessions: 1 }]`;
     - `.configKey` is `"sources.codex.driven"`.
  2. `.models.map(m => [m.model, m.requests])` is
     `[["gpt-5.5",6],["gpt-5.2",2],["codex-auto-review",1],["gpt-9-imaginary",1]]`.
     That is ordered by requests, then name.
  3. `.sessionRows`:
     - six rows, newest first;
     - the S1 row has `id: "codex-s1"`, `entry: "Codex Desktop"`, `driven: 1` and
       `requests: 2`;
     - the S8 row has `entry: "subagent:thread_spawn"` and `driven: 0`.
  4. **Not installed:** an empty `HOME` with a DB that never synced Codex gives
     `.status.state` `"not-installed"`, `.status.lookedAt` ending `/.codex/sessions`, and
     `.models` empty.
  5. **Hermes:** for the Hermes `core` DB,
     - `readAgent(db, "hermes", …).sessionRows` grouped by entry gives `cli` 1,
       `api_server` 1 and `telegram` 1;
     - h3's `hermesCost` is `{usd:0, priced:0, unpriced:1}`;
     - every row's `apiCost` is null.

  `tests/render-agent.test.ts`, on hand-built `AgentData`:
  1. Not installed: the body is exactly one card containing
     `lookedFor("Codex", "/home/x/.codex/sessions")`, and no `Lv`.
  2. Not synced: it contains `Not synced yet — open the dashboard or run \`watchtower sync\`.`
     and no `0h`, `$0.00` or `Lv`.
  3. Synced and degraded: it contains `data as of`.
  4. Rollup pending: it contains `rollup pending` and `level pending`.
  5. Automated only (requests 3, `activeS` null, `sessions.driven` 0): it contains
     `automated only`.
  6. No requests in range: it contains `no requests`.
  7. Codex models table: its header has `at API prices`, and a model with only unpriced
     requests reads `not priced`.
  8. Hermes:
     - the sessions cost column header is `Hermes's figure`;
     - an unpriced session reads `Hermes didn't price this`;
     - there is one sessions card per entry point, titled `Sessions · cli` and so on.
  9. Codex unclassified card: it names `mystery-client` and the key `sources.codex.driven`.

  `tests/read-sessions.test.ts` + `tests/render-sessions.test.ts`, the Atlas line:
  - In `read-sessions.test.ts`:
    - take `buildAndRoll("resumed")`, `runSync` with Claude, and Atlas over the
      `tests/atlas-adapter.test.ts` layout (`as-1`, `as-2` for the same session);
    - `readSessions(db, { now, range: "all" })`'s row for that session has
      `atlas: { checkpoints: 3, files: 2 }`, the MAX over the two Atlas rows;
    - a session Atlas does not know has `atlas: null`.
  - In `render-sessions.test.ts`:
    - a row with `atlas: {checkpoints: 1, files: 2}` renders
      `Atlas: 1 checkpoint · 2 files touched`;
    - `{3, 1}` renders `Atlas: 3 checkpoints · 1 file touched`;
    - `null` renders no `Atlas:`.

- [ ] **Step 2: Run them and watch them fail.**

  Run: `npx vitest run tests/read-agent.test.ts tests/render-agent.test.ts tests/read-sessions.test.ts tests/render-sessions.test.ts`

  Expected: FAIL.

- [ ] **Step 3: `lib/read/agent.ts`.**

```ts
/**
 * The Codex and Hermes pages (spec §5): one reader for both. Stored rollup
 * values and wt_* rows, grouped, summed and counted; no hour, price or level
 * is derived here.
 */
import { querySql, sqlNum, sqlStr } from "../core/sql.ts";
import { eachDay } from "./history.ts";
import { AGENT_LABEL, hasTable, readLevel, type LevelState } from "./level.ts";
import { agentTotals, dayRange, type AgentTotals } from "./overview.ts";
import { apiCostOf, type ApiCost } from "./perf.ts";
import { DEFAULT_RANGE, type Range } from "./range.ts";
import { toolStatus, type ToolStatus } from "./tools.ts";

export const AGENT_SESSION_CAP = 300;

export interface AgentModel { model: string; requests: number; tokens: number; apiCost: ApiCost | null; hermesCost: ApiCost | null }
export interface AgentProject { project: string; activeS: number | null; requests: number; tokens: number }
export interface AgentSessionRow {
  /** The tool's own session id (wt_links), else the canonical id. */
  id: string;
  entry: string | null;
  driven: 0 | 1 | null;
  startedAt: number;
  endedAt: number | null;
  requests: number;
  tokens: number;
  apiCost: ApiCost | null;
  hermesCost: ApiCost | null;
}

export interface AgentData {
  source: "codex" | "hermes";
  label: string;
  range: Range;
  today: string;
  generatedAt: number;
  status: ToolStatus;
  rollupPending: boolean;
  level: LevelState;
  totals: AgentTotals | null;
  days: { day: string; activeS: number | null; tokens: number | null }[];
  models: AgentModel[];
  projects: AgentProject[];
  sessionRows: AgentSessionRow[];
  capped: boolean;
  /** Entry points with no class (driven NULL), lifetime: config decides, so every session they hold counts. */
  unclassified: { entry: string; sessions: number }[];
  /** The config key that classifies an entry point as driven. */
  configKey: string;
}

const read = <T>(db: string, sql: string): T[] => querySql<T>(db, sql, { readonly: true });
const span = (col: string, from: string | null, today: string): string =>
  `${col} <= ${sqlStr(today)}${from === null ? "" : ` AND ${col} >= ${sqlStr(from)}`}`;

function costs(source: "codex" | "hermes", r: {
  usd: number; priced: number | null; unpriced: number | null;
  own_usd: number; own_priced: number | null; own_unpriced: number | null;
}): { apiCost: ApiCost | null; hermesCost: ApiCost | null } {
  return source === "codex"
    ? { apiCost: apiCostOf(r), hermesCost: null }
    : { apiCost: null, hermesCost: apiCostOf({ usd: r.own_usd, priced: r.own_priced, unpriced: r.own_unpriced }) };
}

const COST_COLS =
  `TOTAL(CASE WHEN m.priced = 1 THEN m.cost_table_usd END) AS usd,
   SUM(CASE WHEN m.priced = 1 THEN 1 ELSE 0 END) AS priced,
   SUM(CASE WHEN m.priced = 0 THEN 1 ELSE 0 END) AS unpriced,
   TOTAL(m.own_cost_usd) AS own_usd,
   SUM(CASE WHEN m.source = 'hermes' AND m.own_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS own_priced,
   SUM(CASE WHEN m.source = 'hermes' AND m.own_cost_usd IS NULL AND m.source_record_id IS NOT NULL THEN 1 ELSE 0 END) AS own_unpriced`;

export function readAgent(db: string, source: "codex" | "hermes", opts: { now?: number; range?: Range; home?: string } = {}): AgentData {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const range = opts.range ?? DEFAULT_RANGE;
  const { from, today } = dayRange(db, range, now);
  const status = toolStatus(db, source, opts.home);
  const pending = !hasTable(db, "agent_daily_rollups") || !hasTable(db, "agent_request_metrics");
  const base: AgentData = {
    source, label: AGENT_LABEL[source], range, today, generatedAt: now, status, rollupPending: pending,
    level: readLevel(db, source), totals: null, days: [], models: [], projects: [], sessionRows: [], capped: false,
    unclassified: [], configKey: `sources.${source}.driven`,
  };
  if (status.state !== "synced") return base;

  const unclassified = read<{ entry: string; n: number }>(db,
    `SELECT COALESCE(entry, '(none)') AS entry, COUNT(*) AS n FROM wt_sessions
     WHERE first_source = ${sqlStr(source)} AND driven IS NULL GROUP BY 1 ORDER BY n DESC, 1;`)
    .map((r) => ({ entry: r.entry, sessions: r.n }));
  if (pending) return { ...base, unclassified };

  const byDay = new Map(read<{ day: string; s: number | null; tok: number }>(db,
    `SELECT day, SUM(active_s) AS s, SUM(tokens_in + tokens_out) AS tok FROM agent_daily_rollups
     WHERE source = ${sqlStr(source)} AND ${span("day", from, today)} GROUP BY day;`).map((r) => [r.day, r]));
  const first = from ?? [...byDay.keys()].sort()[0];
  const days = first === undefined ? [] : eachDay(first, today).map((day) => {
    const r = byDay.get(day);
    return { day, activeS: r?.s ?? null, tokens: r === undefined ? null : r.tok };
  });

  const models = read<{ model: string; n: number; tok: number; usd: number; priced: number | null; unpriced: number | null; own_usd: number; own_priced: number | null; own_unpriced: number | null }>(db,
    `SELECT COALESCE(NULLIF(m.model, ''), '(unknown)') AS model, COUNT(*) AS n,
            COALESCE(SUM(r.tokens_in + r.tokens_out), 0) AS tok, ${COST_COLS}
     FROM agent_request_metrics m
     LEFT JOIN wt_requests r ON r.source = m.source AND r.source_record_id = m.source_record_id
     WHERE m.source = ${sqlStr(source)} AND ${span("m.day", from, today)}
     GROUP BY 1 ORDER BY n DESC, 1;`)
    .map((r) => ({ model: r.model, requests: r.n, tokens: r.tok, ...costs(source, r) }));

  const projects = read<{ p: string; s: number | null; n: number; tok: number }>(db,
    `SELECT project_key AS p, SUM(active_s) AS s, SUM(requests) AS n, SUM(tokens_in + tokens_out) AS tok
     FROM agent_daily_rollups
     WHERE source = ${sqlStr(source)} AND ${span("day", from, today)} AND project_key <> '(excluded)'
     GROUP BY 1 ORDER BY COALESCE(SUM(active_s), 0) DESC, n DESC, 1;`)
    .map((r) => ({ project: r.p, activeS: r.s, requests: r.n, tokens: r.tok }));

  const raw = read<{ id: string; entry: string | null; driven: number | null; started_at: number; ended_at: number | null; n: number; tok: number; usd: number; priced: number | null; unpriced: number | null; own_usd: number; own_priced: number | null; own_unpriced: number | null }>(db,
    `SELECT COALESCE((SELECT MIN(l.source_local_id) FROM wt_links l
                      WHERE l.canonical_id = s.canonical_id AND l.source = s.first_source
                        AND l.link_kind = 'same_session'), s.canonical_id) AS id,
            s.entry, s.driven, s.started_at, s.ended_at,
            COUNT(m.source_record_id) AS n,
            COALESCE(SUM(r.tokens_in + r.tokens_out), 0) AS tok, ${COST_COLS}
     FROM wt_sessions s
     LEFT JOIN agent_request_metrics m ON m.canonical_id = s.canonical_id AND m.source = s.first_source
     LEFT JOIN wt_requests r ON r.source = m.source AND r.source_record_id = m.source_record_id
     WHERE s.first_source = ${sqlStr(source)} AND s.started_at IS NOT NULL
       AND ${span("date(s.started_at, 'unixepoch', 'localtime')", from, today)}
     GROUP BY s.canonical_id
     ORDER BY s.started_at DESC, s.canonical_id
     LIMIT ${sqlNum(AGENT_SESSION_CAP + 1)};`);
  const sessionRows = raw.slice(0, AGENT_SESSION_CAP).map((r) => ({
    id: r.id, entry: r.entry, driven: r.driven === null ? null : (r.driven === 1 ? 1 : 0) as 0 | 1,
    startedAt: r.started_at, endedAt: r.ended_at, requests: r.n, tokens: r.tok, ...costs(source, r),
  }));

  return {
    ...base, unclassified, totals: agentTotals(db, source, from, today),
    days, models, projects, sessionRows, capped: raw.length > AGENT_SESSION_CAP,
  };
}
```

- [ ] **Step 4: `lib/render/agent.ts`.**

```ts
/**
 * The Codex and Hermes pages (spec §5). On Hermes the cost column is Hermes's
 * own figure and sessions group by entry point; on Codex it is "at API
 * prices", and unclassified originators are listed with the config key that
 * classifies them. Every empty state is spec §5's string.
 */
import type { AgentData, AgentSessionRow } from "../read/agent.ts";
import { rangeLabel } from "../read/range.ts";
import { dayBars, sortableTable, type SortCell } from "./charts.ts";
import { API_PRICES, apiCostBold, apiCostCell, HERMES_FIGURE, hermesCostBold, hermesCostCell } from "./cost.ts";
import {
  AUTOMATED_ONLY, dataAsOf, lookedFor, NO_DRIVEN_HOURS, NO_REQUESTS, NOT_SYNCED, ROLLUP_PENDING,
} from "./empty.ts";
import { compact, esc, grouped, localZone, minute, num, stamp, zoneNote } from "./html.ts";
import { card, type View } from "./layout.ts";
import { levelCard } from "./level.ts";

const kv = (k: string, v: string) => `<div class="kv"><span>${esc(k)}</span>${v}</div>`;
const absent = (s: string) => `<b class="absent">${esc(s)}</b>`;
const DASH = `<span class="absent">—</span>`;

function costHead(d: AgentData): string {
  return d.source === "hermes" ? HERMES_FIGURE : API_PRICES;
}

function costCellOf(d: AgentData, c: { apiCost: AgentData["models"][number]["apiCost"]; hermesCost: AgentData["models"][number]["hermesCost"] }): SortCell {
  return d.source === "hermes" ? hermesCostCell(c.hermesCost) : apiCostCell(c.apiCost);
}

function summaryCard(d: AgentData, tz: string): string {
  const t = d.totals;
  if (t === null) return card({ title: `${d.label} · ${rangeLabel(d.range)}`, body: `<div class="state absent">${esc(ROLLUP_PENDING)}</div>` });
  const hours = t.activeS !== null ? `<b>${num(t.activeS / 3600, 1)}h</b>`
    : t.requests > 0 && t.sessions.driven === 0 ? absent(AUTOMATED_ONLY) : absent(NO_DRIVEN_HOURS);
  const cost = d.source === "hermes" ? hermesCostBold(t.hermesCost) : apiCostBold(t.apiCost);
  const asOf = d.status.state === "synced" && d.status.degraded
    ? `<p class="note">${esc(dataAsOf(stamp(d.status.lastOkAt, tz)))}</p>` : "";
  return card({
    title: `${d.label} · ${rangeLabel(d.range)}`,
    body: [
      kv("active hours", hours),
      kv("sessions", `<b>${grouped(t.sessions.driven)} driven · ${grouped(t.sessions.automated)} automated · ${grouped(t.sessions.unclassified)} unclassified</b>`),
      kv("requests", t.requests === 0 ? absent(NO_REQUESTS) : `<b>${grouped(t.requests)}</b>`),
      kv("tokens in + out", `<b>${compact(t.tokens.in + t.tokens.out)}</b>`),
      kv(costHead(d), cost),
    ].join("") + asOf,
  });
}

function dailyCards(d: AgentData): string {
  const hours = dayBars({
    bars: d.days.map((x) => ({ label: x.day, value: x.activeS === null ? null : x.activeS / 3600 })),
    label: "driven active hours by day · a dashed stub is a day with no driven hours",
    format: (v) => `${num(v, 1)}h`, emptyText: NO_REQUESTS,
  });
  const tokens = dayBars({
    bars: d.days.map((x) => ({ label: x.day, value: x.tokens })),
    label: "tokens in + out by day", format: compact, emptyText: NO_REQUESTS,
  });
  return `<div class="g g-2">${card({ title: "Hours", body: hours })}${card({ title: "Tokens", body: tokens })}</div>`;
}

function modelsCard(d: AgentData): string {
  const total = d.models.reduce((a, m) => a + m.requests, 0);
  const rows = d.models.map((m) => ({ cells: {
    model: { html: esc(m.model), sort: m.model },
    requests: { html: grouped(m.requests), sort: m.requests },
    share: { html: total > 0 ? `${num((100 * m.requests) / total, 1)}%` : DASH, sort: total > 0 ? m.requests / total : null },
    tokens: { html: compact(m.tokens), sort: m.tokens },
    cost: costCellOf(d, m),
  } }));
  return card({ title: "Models", wide: true, body: sortableTable(
    [{ key: "model", label: "model" }, { key: "requests", label: "requests", num: true },
     { key: "share", label: "share of requests", num: true }, { key: "tokens", label: "in + out", num: true },
     { key: "cost", label: costHead(d), num: true }],
    rows, { empty: NO_REQUESTS }) });
}

function projectsCard(d: AgentData): string {
  const rows = d.projects.map((p) => ({ cells: {
    project: { html: `<span title="${esc(p.project)}">${esc(p.project.startsWith("(") ? p.project : p.project.split("/").pop() ?? p.project)}</span>`, sort: p.project },
    hours: p.activeS === null ? { html: DASH, sort: null } : { html: `${num(p.activeS / 3600, 1)}h`, sort: p.activeS },
    requests: { html: grouped(p.requests), sort: p.requests },
    tokens: { html: compact(p.tokens), sort: p.tokens },
  } }));
  return card({ title: "Projects", wide: true, body: sortableTable(
    [{ key: "project", label: "project" }, { key: "hours", label: "driven hours", num: true },
     { key: "requests", label: "requests", num: true }, { key: "tokens", label: "in + out", num: true }],
    rows, { empty: NO_REQUESTS }) });
}

const CLASS = (v: 0 | 1 | null) => (v === 1 ? "driven" : v === 0 ? "automated" : "unclassified");

function sessionsTable(d: AgentData, rows: AgentSessionRow[], tz: string): string {
  return sortableTable(
    [{ key: "start", label: "start" }, { key: "end", label: "end" }, { key: "entry", label: "entry point" },
     { key: "class", label: "class" }, { key: "requests", label: "requests", num: true },
     { key: "tokens", label: "in + out", num: true }, { key: "cost", label: costHead(d), num: true },
     { key: "id", label: "session" }],
    rows.map((s) => ({ cells: {
      start: { html: minute(s.startedAt, tz), sort: s.startedAt },
      end: s.endedAt === null ? { html: DASH, sort: null } : { html: minute(s.endedAt, tz), sort: s.endedAt },
      entry: { html: esc(s.entry ?? "—"), sort: s.entry },
      class: { html: CLASS(s.driven), sort: CLASS(s.driven) },
      requests: { html: grouped(s.requests), sort: s.requests },
      tokens: { html: compact(s.tokens), sort: s.tokens },
      cost: costCellOf(d, s),
      id: { html: `<span class="sid" title="${esc(s.id)}">${esc(s.id.slice(0, 8))}</span>`, sort: s.id },
    } })),
    { empty: `no sessions ${rangeLabel(d.range) === "all time" ? "on record" : `in the ${rangeLabel(d.range)}`}` },
  );
}

function sessionsCards(d: AgentData, tz: string): string {
  const cap = d.capped ? `<p class="note">Showing the ${grouped(d.sessionRows.length)} most recent sessions.</p>` : "";
  if (d.source !== "hermes") return card({ title: "Sessions", wide: true, body: sessionsTable(d, d.sessionRows, tz) + cap });
  const entries = [...new Set(d.sessionRows.map((s) => s.entry ?? "—"))].sort();
  if (entries.length === 0) return card({ title: "Sessions", wide: true, body: sessionsTable(d, [], tz) });
  return entries.map((e) => card({
    title: `Sessions · ${e}`, wide: true,
    body: sessionsTable(d, d.sessionRows.filter((s) => (s.entry ?? "—") === e), tz),
  })).join("") + cap;
}

function unclassifiedCard(d: AgentData): string {
  if (d.unclassified.length === 0) return "";
  const list = d.unclassified.map((u) => `<li><code>${esc(u.entry)}</code> · ${grouped(u.sessions)} ${u.sessions === 1 ? "session" : "sessions"}</li>`).join("");
  return card({
    title: "Unclassified entry points",
    body: `<p class="note">These earn no hours until classified. Add one to <code>${esc(d.configKey)}</code> (or the matching <code>automated</code> list) in watchtower.config.json; the next sync reclassifies every session.</p><ul>${list}</ul>`,
  });
}

export function agentSections(d: AgentData, tz: string): string[] {
  if (d.status.state === "not-installed") {
    return [card({ title: d.label, body: `<div class="state absent">${esc(lookedFor(d.label, d.status.lookedAt))}</div>` })];
  }
  if (d.status.state === "not-synced") {
    return [card({ title: d.label, body: `<div class="state absent">${esc(NOT_SYNCED)}</div>` })];
  }
  const top = `<div class="g g-2">${levelCard({ title: "Level", state: d.level, hero: true })}${summaryCard(d, tz)}</div>`;
  if (d.rollupPending) return [top, unclassifiedCard(d)];
  return [top, dailyCards(d), modelsCard(d), projectsCard(d), sessionsCards(d, tz), unclassifiedCard(d)];
}

export function agentView(d: AgentData, opts: { tz?: string } = {}): View {
  const tz = opts.tz ?? localZone();
  const sections = agentSections(d, tz);
  return {
    href: `/${d.source}`,
    title: d.label,
    body: sections.join(""),
    sections,
    footer:
      `generated ${stamp(d.generatedAt, tz)} · days are local, ${zoneNote(tz, d.generatedAt)} · ` +
      `from agent_daily_rollups, agent_request_metrics, agent_progress and wt_* · hours count driven sessions only` +
      (d.source === "hermes" ? ` · cost is ${HERMES_FIGURE}, never at API prices` : ""),
  };
}
```

  `lib/views.ts`. Insert these into `STATIC_VIEWS` after `/performance` and before
  `/sources`:

```ts
  { href: "/codex", ranged: true, build: (c) => agentView(readAgent(c.db, "codex", { now: c.now, range: c.range, home: c.home }), { tz: c.tz }) },
  { href: "/hermes", ranged: true, build: (c) => agentView(readAgent(c.db, "hermes", { now: c.now, range: c.range, home: c.home }), { tz: c.tz }) },
```

  Add `codex: 50` and `hermes: 50` to `PER_WEEK_LIMIT` in the budget test. The density
  fixtures have no Codex or Hermes, so both pages are their not-installed card.

- [ ] **Step 5: The Atlas line.**
  - `lib/read/sessions.ts`: give `SessionRow` the field
    `/** Atlas's counts for this session (wt_usage, MAX over Atlas's duplicate rows); null when Atlas does not know it. */ atlas: { checkpoints: number; files: number } | null;`.
  - After `rows` is built, and before the return:

```ts
  // Spec §5: one line on the sessions Atlas knows. Atlas links its own rows to
  // Claude's canonical session; one native id can have two Atlas rows (acp and
  // external_jsonl), so MAX, never SUM.
  const atlas = new Map<string, { checkpoints: number; files: number }>();
  if (rows.length > 0 && hasTable(db, "wt_links") && hasTable(db, "wt_usage")) {
    for (const a of read<{ sid: string; c: number | null; f: number | null }>(db,
      `SELECT l.source_local_id AS sid,
              MAX(CASE WHEN u.metric = 'atlas_checkpoints' THEN u.value END) AS c,
              MAX(CASE WHEN u.metric = 'atlas_files_touched' THEN u.value END) AS f
       FROM wt_links l JOIN wt_usage u ON u.canonical_id = l.canonical_id AND u.source = 'atlas'
       WHERE l.source = 'claude' AND l.link_kind = 'same_session'
         AND l.source_local_id IN (${rows.map((r) => sqlStr(r.sessionId)).join(",")})
       GROUP BY l.source_local_id;`)) {
      atlas.set(a.sid, { checkpoints: a.c ?? 0, files: a.f ?? 0 });
    }
  }
```

  - Map each row with `atlas: atlas.get(r.sessionId) ?? null`. Import `hasTable` from
    `./level.ts`.
  - If the file names its query helper something other than `read`, use that name.
  - `lib/render/sessions.ts` `rowCells`: the `session` cell's html gains the line below.
    Add `.atlas { display: block; font-size: 11px; }` to `LAYOUT_CSS`.

```ts
const atlasLine = (a: SessionRow["atlas"]): string =>
  a === null ? "" : `<span class="atlas muted">Atlas: ${grouped(a.checkpoints)} ${a.checkpoints === 1 ? "checkpoint" : "checkpoints"} · ${grouped(a.files)} ${a.files === 1 ? "file" : "files"} touched</span>`;
```

  Append `${atlasLine(r.atlas)}` after `${also}` in the `session` cell. Every hand-built
  `SessionRow` in the tests gains `atlas: null`.

- [ ] **Step 6: Run everything.**

  Run: `npm test && npm run typecheck`

  Expected: PASS, the budget test included.

- [ ] **Step 7: Look at it.**
  - Run `node bin/watchtower report --out "$S/stage5-report.html"` against a live copy that
    has been synced and rolled (Task 5 Step 12's copy), in a subshell with the setup
    exports.
  - Open it in a browser (the user's preference is the browseros-neo MCP; if it is not
    connected, say so and skip).
  - Check that the Overview, Codex and Hermes pages render, with no `$0.00`, no `0h` for
    unmeasured and no "Lv 1" for nothing. Record what you saw in the report.

- [ ] **Step 8: Commit.**

```bash
git add -A lib tests
git commit -m "feat(pages): Codex and Hermes pages, Hermes's own figure, the Atlas line on Sessions"
```

---
### Task 9: Live proofs, `SESSION.md`, `CLAUDE.md`

**Files:**
- Modify: `SESSION.md` (a Session 18 entry) and `CLAUDE.md`.
- Create: nothing in the repo. The proof outputs go to the scratchpad, and their figures
  go into `SESSION.md`.

**Interfaces:** consumes the whole branch. Produces the measured figures that the PR body
and Task 10 cite.

All of this runs by hand, in a subshell, on `.backup` copies, each in its **own** directory.
`~/.codex` and `~/.hermes` are read in place and are never written.

- [ ] **Step 1: Two copies of one snapshot.**

```bash
(
P="${SCRATCH:?export SCRATCH as your session scratchpad directory}/proof-$(date +%s)"
mkdir -p "$P/snap" "$P/a" "$P/b" "$P/main"
sqlite3 ~/.theone/claude-code-usage.sqlite ".backup $P/snap/db.sqlite"
sqlite3 "$P/snap/db.sqlite" ".backup $P/a/db.sqlite"
sqlite3 "$P/snap/db.sqlite" ".backup $P/b/db.sqlite"
git show main:capture/lib.sh > "$P/main/lib.sh"; git show main:capture/rollup.sh > "$P/main/rollup.sh"
echo "$P"
)
```

  Each later step runs in a fresh shell: start it with `P=<the path this step printed>`.

- [ ] **Step 2: Measure sync, then roll copy A with the branch.**
  - With `WATCHTOWER_DB_PATH="$P/a/db.sqlite"` and `HOME` real, run
    `time node bin/watchtower sync --quiet --no-rollup` twice: cold, then warm.
  - Then run
    `time env CC_LIB_PATH="$PWD/capture/lib.sh" WATCHTOWER_DB_PATH="$P/a/db.sqlite" THEONE_DB_PATH="$P/a/db.sqlite" bash capture/rollup.sh --resolve --quiet`.
  - Record all three times. If the warm sync is over 2 s, stop, fix the cursor and record
    the fix (spec §6.2.1).
  - Record every originator: `sqlite3 "$P/a/db.sqlite" "SELECT first_source, entry, driven, COUNT(*) FROM wt_sessions GROUP BY 1,2,3 ORDER BY 1,4 DESC;"`.

- [ ] **Step 3: Roll copy B with `main`.**

```bash
env CC_LIB_PATH="$P/main/lib.sh" WATCHTOWER_DB_PATH="$P/b/db.sqlite" THEONE_DB_PATH="$P/b/db.sqlite" bash "$P/main/rollup.sh" --resolve --quiet
```

- [ ] **Step 4: Claude did not move** (spec §6.2.3). Each of these must print nothing:

```bash
for q in \
  "SELECT day, active_ms, window_ms, idle_ms, total_session_ms, sessions_count, tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, cost_table_usd, priced_requests, unpriced_requests, hygiene_score FROM claude_daily_rollups ORDER BY day" \
  "SELECT project_key, day, active_ms, window_ms, sessions_count, tokens_in, tokens_out, cost_table_usd FROM claude_project_rollups ORDER BY project_key, day" \
  "SELECT total_hours, active_hours, sessions_count, rank_name, xp, hygiene_score FROM claude_rank_progress"; do
  diff <(sqlite3 "$P/a/db.sqlite" "$q;") <(sqlite3 "$P/b/db.sqlite" "$q;") || echo "MOVED: $q"
done
```

  Then Claude's level equals the formula on those hours:
  - `sqlite3 "$P/a/db.sqlite" "SELECT active_s, xp, level, tier, s_to_next FROM agent_progress WHERE source='claude'; SELECT SUM(active_ms)/1000 FROM claude_daily_rollups;"`.
  - `active_s` must equal the sum.
  - `xp` must equal `node -e "console.log(Math.floor(<active_s>*13034431/9000000))"`.
  - It was Lv 77 Advanced on 2026-10-03.

- [ ] **Step 5: Codex tokens, independently** (spec §6.2.2). A `jq` pass over the logs gives
  per-day totals of normalised `token_usage_record` tokens. Old-format `token_count` files
  are covered by the second identity.

```bash
find ~/.codex/sessions ~/.codex/archived_sessions -name '*.jsonl' -print0 2>/dev/null \
 | xargs -0 -n 50 jq -rc 'select(.type == "token_usage_record")
     | [ .payload.response_id,
         (.timestamp | sub("\\.[0-9]+"; "") | fromdateiso8601 | strflocaltime("%Y-%m-%d")),
         (.payload.usage.input_tokens - .payload.usage.cached_input_tokens - (.payload.usage.cache_write_input_tokens // 0)),
         .payload.usage.cached_input_tokens, .payload.usage.output_tokens ] | @tsv' 2>/dev/null \
 | sort -t "$(printf '\t')" -u -k1,1 \
 | awk -F'\t' '{a[$2]+=$3; c[$2]+=$4; o[$2]+=$5} END {for (d in a) print d "|" a[d] "|" c[d] "|" o[d]}' | sort > "$P/codex-jq.txt"
sqlite3 "$P/a/db.sqlite" "SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS d, SUM(tokens_in), SUM(tokens_cache_read), SUM(tokens_out)
  FROM wt_requests WHERE source = 'codex' AND source_record_id NOT GLOB '*:*' GROUP BY d ORDER BY d;" > "$P/codex-db.txt"
diff "$P/codex-jq.txt" "$P/codex-db.txt" && echo "codex tokens: equal"
sqlite3 "$P/a/db.sqlite" "SELECT COUNT(*) FROM (SELECT a.day FROM agent_daily_rollups a WHERE a.source='codex' GROUP BY a.day
  HAVING SUM(a.tokens_in) <> (SELECT COALESCE(SUM(r.tokens_in),0) FROM wt_requests r WHERE r.source='codex' AND strftime('%Y-%m-%d', r.ts, 'unixepoch', 'localtime') = a.day));"
```

  The last query must print 0. A file Codex is writing at that moment can differ by its
  last line; if the diff shows only today, rerun it once Codex is idle.

- [ ] **Step 6: Hermes tokens equal `session_model_usage`** (R9):

```bash
sqlite3 -readonly ~/.hermes/state.db "SELECT session_id, SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens) FROM session_model_usage GROUP BY 1 ORDER BY 1;" > "$P/hermes-src.txt"
sqlite3 "$P/a/db.sqlite" "SELECT l.source_local_id, SUM(r.tokens_in), SUM(r.tokens_out), SUM(r.tokens_cache_read), SUM(r.tokens_cache_creation)
  FROM wt_requests r JOIN wt_links l ON l.source = 'hermes' AND l.link_kind = 'same_session' AND l.canonical_id = r.canonical_id
  WHERE r.source = 'hermes' GROUP BY 1 ORDER BY 1;" > "$P/hermes-db.txt"
diff "$P/hermes-src.txt" "$P/hermes-db.txt" && echo "hermes tokens: equal"
sqlite3 -readonly ~/.hermes/state.db "SELECT SUM(input_tokens), SUM(output_tokens) FROM sessions; SELECT SUM(input_tokens), SUM(output_tokens) FROM session_model_usage;"
```

  The last line records R9's discrepancy between Hermes's two tables.

- [ ] **Step 7: Five Codex requests priced by hand** (spec §6.2.4).
  - Pick one request per model from
    `SELECT m.source_record_id, m.model, r.tokens_in, r.tokens_cache_read, r.tokens_cache_creation, r.tokens_out, m.cost_table_usd FROM agent_request_metrics m JOIN wt_requests r USING (source, source_record_id) WHERE m.source='codex' AND m.priced = 1 GROUP BY m.model LIMIT 5;`.
  - Price each by hand from R14's table:
    `((tin + tcw) × input + tcr × cached + tout × output) / 1e6`.
  - Write the arithmetic into `SESSION.md`. Each must agree to 1e-9.
  - Also record `SELECT price_note, COUNT(*) FROM agent_request_metrics WHERE source='codex' GROUP BY 1`.

- [ ] **Step 8: `SESSION.md`.** Add a "Session 18 — Stage 5" entry at the top, in the
  file's existing style. It records:
  - the branch and its commits;
  - Steps 2–7's figures: the sync times, originators, the Claude-unmoved diff, Claude's
    level, the Codex and Hermes token proofs, R9's discrepancy and the five hand prices;
  - every guard plant and the one test it reddened, from the task reports;
  - the rulings R1–R21 by number with one line each;
  - the open items: the user's live `install.sh` and the merge order (§7).

- [ ] **Step 9: `CLAUDE.md`.** Update it in place, keeping its voice:
  - Commands: the test count from `npm test`'s summary line; `watchtower sync [--no-rollup]`.
  - "What this repo is": Codex and Hermes are first-class; OpenViking and Atlas are a light
    touch; the dashboard now has Overview, Codex and Hermes. Drop "ships no UI today".
  - Architecture: a row each for `lib/adapters/{codex,hermes,openviking,atlas}/` and
    `lib/rollup-run.ts`/`lib/background-sync.ts`. `watchtower sync` runs the installed rollup.
  - Durable vs regenerable: the four `agent_*` tables are regenerable (schema v7); Codex and
    Hermes `wt_*` rows are durable; `wt_file_cursor` is advisory.
  - Invariants:
    - the agent gap rule is Claude's, in `rollup.sh` only, driven sessions only, booked to
      the gap-ending event's local day;
    - Hermes's figure never enters "at API prices";
    - levels are stored, never computed in TypeScript;
    - `claude_rank_progress` is deprecated but still written;
    - `WT_SCHEMA_VERSION` is 3 and `CC_SCHEMA_VERSION` is 7.
  - Testing conventions: `tests/helpers/agent-seed.ts`, and rule R21 in one sentence.

- [ ] **Step 10: Commit.**

```bash
git add SESSION.md CLAUDE.md
git commit -m "docs(stage-5): live proofs and session 18 handoff; CLAUDE.md for agents and levels"
```

---

### Task 10: TheOneOS lockstep — the Hours panel reads the level

**Repo:** `/Users/you/Developer/Coding/personal/TheOneOS`. Work in a new worktree off
TheOneOS `main` (`84c34c7` or later), on branch `claude-hours-level`.

**Files:**
- In TheOneOS:
  - Modify:
    - `lib/claude-hours/types.ts`;
    - `lib/claude-hours/build.ts:19,326-347`;
    - `lib/claude-hours/hours.ts:124-150`;
    - `components/personal/ai-spend/claude-hours-panel.tsx:25,277-356`;
    - `tests/claude-hours.test.ts:8,31-57,115-118`;
    - `lib/claude-hours/runbook.ts:36,43,73,95`, where the copy names the rank;
    - `lib/claude-hours/AGENTS.md`.
  - Delete: `lib/claude-hours/ranks.ts`.
- In Watchtower: create `tests/fixtures/theone-level-proof.mjs`.

**Interfaces:** consumes Watchtower's `agent_progress`. Produces `ClaudeHours.level`, which
replaces `rank` and `xp`.

- [ ] **Step 1: The worktree.** Per the memory note, Turbopack rejects a symlinked
  `node_modules`, so run `npm ci`:

```bash
cd /Users/you/Developer/Coding/personal/TheOneOS
git fetch && git worktree add ../.worktrees/theoneos-claude-hours-level -b claude-hours-level origin/main
cd ../.worktrees/theoneos-claude-hours-level && npm ci
```

- [ ] **Step 2: Write the failing tests** in `tests/claude-hours.test.ts`.
  - Delete the `rankForHours` describe (lines 31–57) and its import (line 8).
  - Replace the test at 115–118 with:

```ts
  it("carries the stored level through unchanged and computes none", () => {
    const level = { state: "level" as const, level: 77, tier: "Advanced", xp: 1523464, xpIntoLevel: 47883,
      xpToNext: 105736, sToNext: 73009, stars: 0, activeS: 1051920 };
    const h = buildClaudeHours(rows, NOW, [], level);
    expect(h.level).toEqual(level);
    expect("rank" in h).toBe(false);
    expect("xp" in h).toBe(false);
  });

  it("says pending, never a level, without agent_progress", () => {
    expect(buildClaudeHours(rows, NOW, []).level).toEqual({ state: "pending" });
  });
```

  - Add a `getClaudeCodeHours` case against a temp DB. The file already builds temp DBs
    with `better-sqlite3`.
    - Create an `agent_progress` table holding a `claude` row `(1051920, 1523464, 77, 'Advanced', 47883, 105736, 73009, 0)`.
      `result.hours.level` must equal the object above.
    - With a row whose `level` is NULL, it must be `{ state: "none", activeS: 0 }`.

  Run `npx vitest run tests/claude-hours.test.ts` in the worktree. It must FAIL.

- [ ] **Step 3: `lib/claude-hours/types.ts`.**
  - Drop the `RankProgress` import.
  - Replace `rank: RankProgress; xp: number;` with `level: ClaudeLevel;`.
  - Add:

```ts
/**
 * Claude Code's level, exactly as Watchtower's rollup stores it in
 * `agent_progress` (Stage 5: OSRS levels from lifetime active hours). TheOneOS
 * computes no level: `pending` until the rollup has written one, `none` with no
 * active hours.
 */
export type ClaudeLevel =
  | { state: "pending" }
  | { state: "none"; activeS: number }
  | {
      state: "level"; level: number; tier: string; xp: number; xpIntoLevel: number;
      /** null at 99 */ xpToNext: number | null; sToNext: number | null; stars: number; activeS: number;
    };
```

- [ ] **Step 4: `lib/claude-hours/hours.ts`.** Add the reader, then pass its result as the
  fourth argument to `buildClaudeHours`:

```ts
/** Watchtower's stored level for Claude Code (agent_progress, schema v7). No table yet: pending. */
function readClaudeLevel(db: NonNullable<ReturnType<typeof openUsageDb>>): ClaudeLevel {
  const has = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='agent_progress'")
    .get() as { n: number } | undefined;
  if ((has?.n ?? 0) === 0) return { state: "pending" };
  const r = db.prepare(`SELECT active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars
                        FROM agent_progress WHERE source = 'claude'`).get() as
    | { active_s: number; xp: number; level: number | null; tier: string | null; xp_into_level: number | null;
        xp_to_next: number | null; s_to_next: number | null; stars: number | null }
    | undefined;
  if (r === undefined) return { state: "pending" };
  if (r.level === null || r.tier === null) return { state: "none", activeS: r.active_s };
  return { state: "level", level: r.level, tier: r.tier, xp: r.xp, xpIntoLevel: r.xp_into_level ?? 0,
    xpToNext: r.xp_to_next, sToNext: r.s_to_next, stars: r.stars ?? 0, activeS: r.active_s };
}
```

  The call becomes `buildClaudeHours(rows, now, tokenDays, readClaudeLevel(db))`. Read the
  level inside the same `try` as the other queries.

- [ ] **Step 5: `lib/claude-hours/build.ts`.**
  - Remove the `rankForHours` import (line 19) and the `rank`/`xp` computation (326–329).
  - Add a parameter `level: ClaudeLevel = { state: "pending" }` after `tokenDays`.
  - Return `level` in place of `rank, xp`.
  - The header comment's "the hours rank" becomes "the stored level".
  - Then `git rm lib/claude-hours/ranks.ts`.

- [ ] **Step 6: The panel** (`components/personal/ai-spend/claude-hours-panel.tsx`).
  - Remove the `CLAUDE_RANKS` import, and with it the ladder list (lines ~328–340).
  - The hero (277–321) reads `h.level`:
    - **`level`:** `RankRing` with `pct` = `xpToNext === null ? 100 : 100 * xpIntoLevel / (xpIntoLevel + xpToNext)`
      and `center={\`Lv ${level}\`}`, `sub={tier}`, colour `TIER_COLOR[tier]`. Below it:
      the lifetime hours as today, `formatXp(xp) XP`, then `${fmtHours(sToNext / 3600)}h to Lv ${level + 1}`,
      or `${stars} ★ past 99` at the top.
    - **`none`:** "No driven hours yet."
    - **`pending`:** "Level pending — Watchtower's rollup has not run since its v7 install."
  - The `Stat` at line ~356 becomes `label="To next level"`. Its value is the hours to the
    next level, or "—" at the top / with no level, and its `sub` is `→ Lv ${level + 1}` or
    "max level".
  - Add, local to the component file (presentation only, no thresholds):

```ts
const TIER_COLOR: Record<string, string> = {
  Noobie: "#71717a", Apprentice: "#22d3ee", Builder: "#34d399", Intermediate: "#a78bfa",
  Advanced: "#fbbf24", Pro: "#fb923c", Master: "#f472b6",
};
/** OSRS-style XP, as Watchtower prints it: 1.52M, 23.7K, 477. Floored. */
function formatXp(xp: number): string {
  if (xp >= 1e6) return `${(Math.floor(xp / 1e4) / 100).toFixed(2)}M`;
  if (xp >= 1e4) return `${(Math.floor(xp / 100) / 10).toFixed(1)}K`;
  return xp.toLocaleString("en-US");
}
```

  - Update the empty-state copy at line 268 ("Your hours, rank, and …"): "rank" becomes
    "level".
  - In `runbook.ts`:
    - the `claude_rank_progress` row (line 36) becomes
      `` `agent_progress` | per-tool lifetime level (OSRS), Claude Code included ``;
    - lines 43, 73 and 95 say "level" for "rank".
  - `lib/claude-hours/AGENTS.md`: replace the ranks paragraph with one line. The level is
    Watchtower's `agent_progress`; never compute it here.

- [ ] **Step 7: Run TheOneOS's checks.**

  Run in the worktree:
  `npx vitest run tests/claude-hours.test.ts tests/claude-code-tab.test.tsx && npm run typecheck && npm run lint && npm run build`.

  Expected: PASS. If `npm run build` hits the symlinked-`node_modules` error, `npm ci` was
  skipped.

- [ ] **Step 8: The Watchtower lockstep proof** `tests/fixtures/theone-level-proof.mjs`. It
  is modelled on `theone-watch-proof.mjs`: the same header style, the same loader `HOOKS`
  block copied verbatim, `THEONE_BEFORE` (main) / `THEONE_AFTER` (this branch, default
  `../.worktrees/theoneos-claude-hours-level`), run by hand.

  Usage: `node tests/fixtures/theone-level-proof.mjs <db-copy>`. The copy must have been
  rolled by the branch's rollup.

  Checks:
  - **(a)** The branch's `getClaudeCodeHours` reads the copy. Point it at the copy with
    `THEONE_DB_PATH` (`lib/claude-hours/paths.ts:12`).
    `hours.level` must deep-equal the row
    `SELECT … FROM agent_progress WHERE source='claude'`, mapped as in Step 4.
  - **(b)** Apart from `level`, `rank` and `xp`, the branch's payload is deep-equal to
    main's on the same copy, at the same `now`. Main's `rank` and `xp` are dropped before
    comparing.
  - **(c)** No file under the branch's `lib/claude-hours/` or the panel contains
    `rankForHours`, `CLAUDE_RANKS`, `13034431` or `9000000`. That is a grep over source
    text: the level math lives only in `rollup.sh`.

  Exit 0 on success, 1 on any mismatch and 2 on bad usage, as the model script does. Run it
  on Task 9's copy A (`$P/a/db.sqlite`) and paste its output into the TheOneOS PR body.

- [ ] **Step 9: Commit, in both repos.**

```bash
# TheOneOS worktree
git add -A lib components tests
git commit -m "Claude Code tab: the Hours panel shows Watchtower's OSRS level; the rank ladder retires"
# Watchtower
git add tests/fixtures/theone-level-proof.mjs
git commit -m "test(lockstep): prove TheOne's Hours level equals agent_progress"
```

---

## After the tasks

1. **One whole-branch review** of Watchtower `main..stage-5-agents-and-levels` plus the
   TheOneOS branch, on the most capable model. Its brief is the spec, this plan's Rulings,
   Global Constraints and Review Focus, and every task report.
   - It checks first that each Review Focus line has its test and that each guard plant
     was recorded as reddening exactly one test.
   - Findings are adjudicated against the spec. **At most one** fix wave follows, one
     dispatch, then one scoped re-review of that diff. Any residual finding is ruled on in
     the ledger, not fixed in a second wave.
2. **The PRs**, with no AI attribution in titles, bodies or commits:
   - the Watchtower PR body carries Task 9's proof figures;
   - the TheOneOS PR body carries the lockstep proof output.
   Push the branches. Opening a PR is fine.
3. **Hand the user the commands**, which auto mode blocks:
   - merge Watchtower first: `! gh pr merge <n> --squash --delete-branch` in the Watchtower
     repo;
   - then the live install: `! bash capture/install.sh` from the merged Watchtower `main`,
     which brings `CC_SCHEMA_VERSION` 7 to `~/.claude`;
   - then `! node bin/watchtower sync` once, to see Codex and Hermes appear;
   - then merge TheOneOS.
   The order is spec §7's: `claude_rank_progress` is still written in between, so TheOneOS
   `main` never breaks.
4. Close the SDD ledger: append `Plan complete` with the two merge commits once the user
   reports them. Commit the ledger, and restore `.superpowers/sdd/.gitignore` if an SDD
   script touched it.

## Plan self-review (done while writing)

**Spec coverage:**

| Spec | Where |
|---|---|
| §1 success (Claude unmoved, levels, hours from driven sessions) | Task 5 (tests 6, 7, 14), Task 9 Step 4 |
| §2 decisions 1–9 | Rulings R1–R21 implement them; none re-asked |
| §3.1 measured facts | the "Measured on the live machine" section; Task 2 and Task 9 Step 2 re-measure |
| §3.2 Codex | Task 2 (R2, R3, R4, R6, R7, R16, R17, R19) |
| §3.3 Hermes | Task 3 (R8, R9) |
| §3.4 OpenViking, Atlas | Task 4 (R10); the Overview card (Task 7) and the Sessions line (Task 8) |
| §4.1 tables | Task 5 Step 5 |
| §4.2 hours | Task 5 Step 7 `_ag_gap`, test 6 (guard 11), test 1 (guard 4), R5 |
| §4.3 Codex cost | Task 5 `_ag_rm`, test 2 (guard 5), test 3; R14 |
| §4.4 levels | Task 5 `_ag_xp`/`_ag_prog`, tests 4, 5, 7, 8; Task 6 for totals and the cape |
| §5 pages, nav, empty states | Tasks 6–8; `lib/render/empty.ts` holds the strings verbatim |
| §6.1 guards 1–11 | the guard map; plants in Tasks 2, 3, 5 and 7 |
| §6.2 live proof | Task 2 (measurement), Task 9 Steps 2–7 |
| §7 TheOneOS and rollout | Task 10, "After the tasks" |
| §8 task shape | Tasks 1–10. The spike is Task 2's measurement step, plus Task 1's cursor groundwork |
| §9 not in Stage 5 | nothing here builds them. Background sync runs only while the dashboard is open (R13), which is not §9's always-on timer |
| §10 review focus | Review Focus 1–5, each with an owning test |

**Placeholders:** none. Every code step carries its code. Every number is either in the
fixture reference or computed in a test from stored values.

**Type consistency, checked across tasks:**
- `EntryLists`, `classifyEntry`, `reclassifySql` and `entryLists` (Tasks 1–3);
- `agentSessionSql`, `writeAuthority` and `finish({clean})` (Tasks 1–3);
- `pagedRows(…, {readonly})` (Tasks 1 and 3);
- `adaptersFor` (Tasks 2–4);
- `lookedAt` (Tasks 3 and 7);
- `hasTable`, `LevelState`, `readLevel(s)`, `totalLevel` and `maxCape` (Tasks 6–8);
- `toolStatus` and `ToolStatus` (Tasks 7–8);
- `agentTotals` and `dayRange` (Tasks 7–8);
- the `hermesCost*` labels (Tasks 7–8);
- `ApiCost`, reused for Hermes's figure but never summed with an API cost (guard 6);
- `ClaudeLevel` (Task 10), which mirrors `LevelState` with flattened fields.
