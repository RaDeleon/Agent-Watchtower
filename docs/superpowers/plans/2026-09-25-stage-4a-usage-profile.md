# Stage 4A — the Usage Profile (plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture tool calls and slash commands from transcripts, score TheOne's ten
disciplines, the 6-tier ladder and the Matrix tier per day in `rollup.sh`, and show them on
a new Usage Profile page.

**Architecture:** `ingest.sh` gains two durable tables, filled in its existing single pass.
`rollup.sh` gains a second, separate transaction that rebuilds two regenerable tables:
per-day profile and per-day discipline scores, each over a rolling 30-day window.
TypeScript reads those tables and formats them; it computes nothing.

**Tech stack:** bash, `jq`, the `sqlite3` CLI (window functions), Node ≥ 22 with native type
stripping, vitest. **Zero runtime dependencies.**

**Spec (binding):** `docs/superpowers/specs/2026-09-25-stage-4a-usage-profile-design.md`.
Every formula, threshold, table and column is there. **Copy them from the spec; do not
re-derive.** TheOne's source, for the lockstep proof only:
`/Users/you/Developer/Coding/personal/TheOneOS/lib/ccflare/{usage-profile,profile}.ts`.

**Branch:** `stage-4-usage-profile` @ `36d2693`, cut from `main` @ `78f6c63`.

## Global Constraints

- A tracker must never break Claude Code: every DB write on the hook path swallows its error; `ingest.sh` still exits 0 on any failure.
- Tool-call and slash-command upserts are commutative and idempotent. Re-ingesting, reordering runs or deleting the cursor converges on identical tables.
- `claude_tool_calls` and `claude_slash_commands` are **durable**: never deleted or rebuilt from the filesystem. `claude_profile_daily` and `claude_discipline_scores` are **regenerable**.
- All scoring math lives in `capture/rollup.sh`. `lib/` reads and labels only; no threshold from spec §4 appears under `lib/`.
- `CC_SCHEMA_VERSION` (`capture/lib.sh`) and `schemaVersion` (`lib/config.ts`) are both **5**.
- Existing tables and numbers do not change: `tests/regression/claude-baseline.json` still passes untouched, and the reconciliation identity holds.
- NULL means "not measured" and never renders as 0. A gated day (< 20 requests) has NULL scores; the history line breaks there.
- Tests drive the real bash scripts with `TZ=UTC`. Fixtures fail loudly and encode values through `lib.sh`'s own encoders.
- Every new guard gets its defect planted until **exactly one** test turns red. Record the plant in the task report.
- Never touch the live DB or `~/.claude`. Live-data checks run on a `sqlite3 .backup` copy in a **fresh directory**, because the `.schema-vN` marker is per directory.
- `package.json` gains no `dependencies`. There is no build step.

## Review Focus

1. **A tool call whose result never arrives** (session killed mid-tool). It counts as a call and not as an error, matching TheOne's `errors / toolUses`, and its row keeps `is_error` NULL. Test: Task 1 (row shape) and Task 3 (rate).
2. **Slash text that isn't a typed command**: a user entry whose `content` is an **array** with a text block containing `<command-name>`, or an attachment or prompt snapshot quoting it. Neither is counted. Test: Task 1.
3. **Local-day boundaries.** A request at 03:00Z on day X belongs to day X−1's window under `TZ=America/Los_Angeles`. Test: Task 2 runs one scenario under that TZ and asserts the membership shift.
4. **Idle days.** A day with no requests of its own still gets a profile row while its 30-day window has ≥ 20 requests. The history line does not break there, only on gated days. Test: Task 2 (row exists) and Task 4 (no break).
5. **Upgrade before backfill**: a v4 database, install, then the rollup runs before `--backfill`. The tables exist, `tool_covered = 0`, the tool-derived disciplines are needs-data, and nothing errors. Test: Task 1 (v4 → v5 init) and Task 3 (no tool rows → needs-data).

---

## Tasks

Four tasks, the Stage 3D shape. Each task ends with a check against a `.backup` copy of the
live DB, recorded in its report (`.superpowers/sdd/2026-09-25-stage-4a-usage-profile/task-N-report.md`).
There is a scoped review after Task 1 only, because durable data is the one thing a later
fix cannot repair. After that come one whole-branch review and at most one fix round.

### Task 1: Capture — schema v5, tool calls and slash commands

**Files:**
- Modify: `capture/lib.sh` (version 5; two `CREATE TABLE IF NOT EXISTS` + indexes in `cc_schema_sql`), `lib/config.ts` (`schemaVersion: 5`), `capture/ingest.sh`, `tests/fixtures/make-transcripts.sh` (new scenarios), `tests/ingest.test.ts`, `tests/capture-scripts.test.ts` and `tests/install.test.ts` (version pin, durable-table lists), `CLAUDE.md` (durable list, schema version)
- Create: nothing else

**Interfaces:**
- Produces all four new tables in one schema step: spec §3.2's durable pair and §4.6's regenerable pair, verbatim. Task 2 fills the regenerable ones. All four ship under one version bump, so a v5 marker never predates a table. Plus `CREATE INDEX idx_tool_calls_ts ON claude_tool_calls(ts)`, `idx_tool_calls_session ON claude_tool_calls(session_id)` and `idx_slash_ts ON claude_slash_commands(ts)`.
- `make-transcripts.sh` scenarios `tools-split-a` / `tools-split-b` (the tool_use in A, its result in B), `tools-sidechain`, `slash-mixed`, `tools-unresolved`.

- [ ] **Step 1: Schema.** Add the four tables to `cc_schema_sql` after `claude_ingest_cursor`, bump both versions to 5, and update the version pin test. Test: `cc_init_db` on a directory holding a v4 DB and a `.schema-v4` marker creates all four tables and writes `.schema-v5` (Review Focus 5).
- [ ] **Step 2: Fixtures.** Extend `make-transcripts.sh`, reusing `rec` for the assistant lines. Add:
  - `tuse <file> <requestId> <sessionId> <iso-ts> <tool_use_id> <name> [sidechain]`: an assistant line with usage whose `message.content` is `[{"type":"tool_use","id":…,"name":…,"input":{}}]`.
  - `tres <file> <sessionId> <iso-ts> <tool_use_id> <true|false>`: a `type:"user"` line, `message.content` = `[{"type":"tool_result","tool_use_id":…,"is_error":…,"content":"x"}]`.
  - `slash <file> <uuid> <sessionId> <iso-ts> <content-json>`: a `type:"user"` line with that `message.content`.

  `slash-mixed` holds:
  - `/compact` as a string (counted);
  - `/model opus` as a string, where only `/model` is recorded;
  - an array content `[{"type":"text","text":"<command-name>/foo</command-name>"}]` (not counted);
  - `{"type":"attachment","attachment":{"type":"prompt_snapshot","text":"<command-name>/bar</command-name>"}}` (not counted);
  - a sidechain string `/baz` (not counted).
- [ ] **Step 3: Failing tests** in a new `describe("tool calls and slash commands")` in `tests/ingest.test.ts`:
  1. Split across runs: ingest `tools-split-a`, then add the B file and ingest again. There is one row with a name and `is_error = 1`.
  2. The same two files in the opposite order give an identical `SELECT * … ORDER BY 1`.
  3. Re-ingest and `--backfill` both change nothing.
  4. `tools-sidechain` gives `is_sidechain = 1`.
  5. `mcp__plugin_x-mcp_y__navigate_page` gives `mcp_server = 'plugin_x-mcp_y'`.
  6. `slash-mixed` gives exactly `/compact` and `/model`.
  7. `tools-unresolved` gives a row with a name and `is_error IS NULL` (Review Focus 1).
  8. A corrupt line between a tool_use and its result loses only itself.
  9. A request row and its tool call land in the same run, so the existing `claude_requests` assertions still hold.

  Run `npx vitest run tests/ingest.test.ts` and expect the new cases to FAIL.
- [ ] **Step 4: Implement ingest.**
  - Widen the line filter to `grep -E '"usage"|"tool_result"|<command-name>'`.
  - Replace `JQ_ROW` with one program that emits tagged TSV rows, keeping the `fromjson? // empty` and `clean` idioms:
    - `R` + today's request columns, only for lines matching today's `select`;
    - `T tool_use_id request_id session_id ts name mcp_server is_sidechain` for each `tool_use` block;
    - `E tool_use_id is_error(0|1)` for each `tool_result` block in a `type=="user"` entry;
    - `S uuid session_id ts command` for a `type=="user"` entry with a string `content` matching `<command-name>\s*(/[^<\s]+)` and `isSidechain` not true.
  - Compute `mcp_server` in jq: `if startswith("mcp__") then (.[5:] | split("__")[0]) else "" end`.
  - Split with `awk -F'\t'` into `rows.tsv` (tag stripped), `tools.tsv` and `slash.tsv`. Merge `T` and `E` into one tools TSV with `tool_name` empty on `E` rows and `is_error` empty on `T` rows.
  - The early `rows == 0` exit counts all three files.
  - In the existing transaction, before `.read cursors.sql`, import into `_tools_in` / `_slash_in` and upsert. Use the same explicit-aggregate `GROUP BY tool_use_id` pattern the request upsert documents, with no bare columns:

```sql
INSERT INTO claude_tool_calls (tool_use_id, request_id, session_id, ts, tool_name,
                               mcp_server, is_error, is_sidechain)
SELECT tool_use_id, MAX(NULLIF(request_id,'')), MAX(NULLIF(session_id,'')),
       MIN(NULLIF(ts,'')), MAX(NULLIF(tool_name,'')), MAX(NULLIF(mcp_server,'')),
       MAX(CAST(NULLIF(is_error,'') AS INTEGER)), MIN(CAST(NULLIF(is_sidechain,'') AS INTEGER))
FROM _tools_in WHERE COALESCE(tool_use_id,'') <> '' GROUP BY tool_use_id
ON CONFLICT(tool_use_id) DO UPDATE SET
  request_id   = COALESCE(request_id,   excluded.request_id),
  session_id   = COALESCE(session_id,   excluded.session_id),
  tool_name    = COALESCE(tool_name,    excluded.tool_name),
  mcp_server   = COALESCE(mcp_server,   excluded.mcp_server),
  ts           = CASE WHEN ts IS NULL THEN excluded.ts
                      WHEN excluded.ts IS NULL THEN ts ELSE MIN(ts, excluded.ts) END,
  is_sidechain = CASE WHEN is_sidechain IS NULL THEN excluded.is_sidechain
                      WHEN excluded.is_sidechain IS NULL THEN is_sidechain
                      ELSE MIN(is_sidechain, excluded.is_sidechain) END,
  is_error     = CASE WHEN is_error IS NULL THEN excluded.is_error
                      WHEN excluded.is_error IS NULL THEN is_error
                      ELSE MAX(is_error, excluded.is_error) END;
INSERT OR IGNORE INTO claude_slash_commands (entry_uuid, session_id, ts, command)
SELECT entry_uuid, session_id, CAST(ts AS INTEGER), command FROM _slash_in
WHERE COALESCE(entry_uuid,'') <> '' AND COALESCE(command,'') <> '';
```

  - Update the header comment: the new tables, why they are durable, and why the merge is order-independent.
- [ ] **Step 5: Run** `npx vitest run tests/ingest.test.ts tests/capture-scripts.test.ts tests/install.test.ts`, then `npm test` and `npm run typecheck`. Expect everything to PASS.
- [ ] **Step 6: Plant, and watch exactly one test go red each time:**
  - `is_error` merged by overwrite instead of NULL-aware max (reorder test);
  - the slash `select` without the string check (`slash-mixed`);
  - `mcp_server` split on the last `__`.
- [ ] **Step 7: Live copy.** Make a `.backup` into a new directory. Run `WATCHTOWER_DB_PATH=<copy> WATCHTOWER_TRANSCRIPTS_DIR=$HOME/.claude/projects bash capture/ingest.sh --backfill` (read-only on transcripts). Record the backfill time, the row counts for both tables, the sidechain share, the top 10 tools, the top slash commands, the unresolved-result count and `MIN(ts)`. Then run a normal ingest on the copy and record the steady-state time against today's 6.3 s.
- [ ] **Step 8: Commit** `feat(stage-4a): capture tool calls and slash commands (schema v5)`.

### Task 2: Scoring framework — windows, session stats, the Matrix score

**Files:**
- Modify: `capture/rollup.sh` (a new section after the rank block), `tests/fixtures/make-fixture.sh` (profile scenarios), `CLAUDE.md` (regenerable list; the rollup's `exit 1` paths now number four)
- Create: `tests/profile-rollup.test.ts`

**Interfaces:**
- Consumes: Task 1's tables.
- Produces: `claude_profile_daily` fully populated, except `total`, `measured`, `tier_index`, `tier_points_to_next` and `total_wow`, which are left NULL for Task 3.
- Temp tables Task 3 reuses, all prefixed `_pf_`:
  - `_pf_days(day)`;
  - `_pf_win(day, win, lo, hi)`, where `win` is `'30'`, `'7'` or `'7p'`;
  - `_pf_rq(win, day, request_id, session_id, ts, model, tin, tout, tcr, err, entrypoint)`, one row per request per window it falls in;
  - `_pf_sess(win, day, session_id, n, span, ctx, reset)`.

- [ ] **Step 1: The section's frame.** Add a second `sqlite3 -cmd ".bail on" -cmd ".timeout 8000"` heredoc, placed **after** the rank write so a failure cannot cost the rank. It runs `BEGIN IMMEDIATE; … COMMIT;`, then `DELETE FROM claude_profile_daily; DELETE FROM claude_discipline_scores;`, then re-insert. On failure: `echo "cc-rollup: profile rebuild failed" >&2` unless `--quiet`, then `exit 1`.
- [ ] **Step 2: Days and windows.**
  - `_pf_days` is a recursive CTE over local days, from `MIN(strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime'))` of `claude_requests` through `date('now','localtime')`.
  - `_pf_win` holds three rows per day:
    - `'30'`: `[D−29, D]`;
    - `'7'`: `[D−6, D]`;
    - `'7p'`: `[D−13, D−7]`.
  - `_pf_rq` is `claude_requests` joined on its local day `BETWEEN lo AND hi`, with `err = (NULLIF(api_error_status,'') IS NOT NULL)`. Index `_pf_rq(win, day, session_id, ts)`.
- [ ] **Step 3: Session stats and factors.** Sessions skip empty `session_id` (spec §4.1). The reset rule, the median idiom and the factors, from spec §4.3:

```sql
-- reset: running max of EARLIER cache_read in (win, day, session)
SELECT win, day, session_id,
       MAX(CASE WHEN tcr > 0 AND prior > 80000 AND tcr * 2 < prior THEN 1 ELSE 0 END) AS reset
FROM (SELECT *, MAX(tcr) OVER (PARTITION BY win, day, session_id ORDER BY ts, request_id
                               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior
      FROM _pf_rq WHERE COALESCE(session_id,'') <> '')
GROUP BY win, day, session_id;
-- median of v per (win, day): TheOne's median (mean of the two middles when even)
SELECT win, day, AVG(v) FROM (
  SELECT win, day, v, ROW_NUMBER() OVER (PARTITION BY win, day ORDER BY v) AS rn,
         COUNT(*) OVER (PARTITION BY win, day) AS c FROM …)
WHERE rn IN ((c + 1) / 2, (c + 2) / 2) GROUP BY win, day;
```

  Write `L` and `H` as `CASE` expressions with **TheOne's exact arithmetic order** (spec §4.2), because floating-point order decides the `.5` cases:
  - `L`: `CAST(round(100 * (1 - (v - good) * 1.0 / (bad - good))) AS INTEGER)`;
  - `H`: `CAST(round(100 * ((v - lo) * 1.0 / (hi - lo))) AS INTEGER)`.

  The Matrix score sums left to right: `round(((c*0.3 + k*0.25) + s*0.2) + e*0.25)`.
- [ ] **Step 4: Insert the profile rows.** Insert one row per day:
  - `window_requests` counts the `'30'` window;
  - `tool_covered` is 1 when the day's `'30'` window starts on or after the local day of `MIN(ts)` over main-thread `claude_tool_calls`, and 0 when that is NULL;
  - the Matrix columns and factor inputs come from `'30'`;
  - `matrix_7d` comes from `'7'`;
  - `matrix_wow` = `matrix_7d` − the same computed over `'7p'`, NULL when either window has zero requests.

  When `window_requests < 20`, every score column is NULL, `f_*` included. The `'7'`/`'7p'` windows get no gate (spec §4.5).
- [ ] **Step 5: Tests** in `tests/profile-rollup.test.ts`, with scenarios added to `make-fixture.sh` through `fx_sql`. Hand-computed values, with the arithmetic in comments:
  1. `profile-basic`, all on 2026-09-10:
     - session A: 12 requests, each with `cache_read` 205000, `in` 10, `out` 90;
     - session B: 8 requests, each with `cache_read` 20000, `in` 10, `out` 90.

     Expect median ctx 112500 → context **82**; median n 10 → sessionLength **100**; no long sessions → compaction **90**; ratio 2,620,000 / 2,000 = 1310 → efficiency **0**; matrix `round(24.6 + 22.5 + 20 + 0)` = **67**, tier 1 (Operator), 8 points to next.
  2. Gate: drop one request so there are 19; the row exists with NULL scores.
  3. Resets: a 30-request session with cache_read climbing to 90000, then one at 40000, counts as a reset (compaction 100). The same session with a 70000 peak and then 30000 does not (compaction 0).
  4. A 45-minute, 5-request session counts as long.
  5. Idle day: 2026-09-11 has no requests of its own, but its row has the same `'30'` inputs (Review Focus 4).
  6. Matrix WoW: a week with requests and a prior week without gives NULL; with both weeks present it gives the difference.
  7. `TZ=America/Los_Angeles`: a request at 2026-09-11T03:00Z lands in 2026-09-10's window (Review Focus 3).
  8. Unchanged numbers: `tests/regression.test.ts` passes untouched.
- [ ] **Step 6: Plant, and watch exactly one test go red each time:**
  - `ROWS … 1 PRECEDING` changed to `CURRENT ROW`;
  - the median taking the lower middle;
  - the gate set to `<= 20`;
  - the Matrix weights reordered in the sum;
  - `'localtime'` dropped from the window join.
- [ ] **Step 7: Live copy.** Run the rollup against the Task 1 copy. Record the added runtime (target ≤ 10 s), the number of rows, the latest day's Matrix score, factors and tier, and every gated day.
- [ ] **Step 8: Commit** `feat(stage-4a): profile windows and the Matrix score in the rollup`.

### Task 3: The ten disciplines, the total, the ladder, and the proof against TheOne

**Files:**
- Modify: `capture/rollup.sh` (inside Task 2's transaction), `tests/profile-rollup.test.ts`, `tests/capture-scripts.test.ts` (threshold guard)
- Create: `tests/fixtures/theone-lockstep.mjs` — a one-off script, run by hand, **not** part of `npm test` (it imports from the TheOneOS checkout)

**Interfaces:**
- Consumes: the `_pf_*` temp tables and Task 1's tables.
- Produces:
  - `claude_discipline_scores` rows for every ungated day, using TheOne's discipline ids in spec order: `prompt-hygiene, context-hygiene, session-hygiene, model-routing, cost-discipline, verification, automation, reuse, security, output-quality`;
  - `definition` is `'watchtower'` for automation and security and `'theone'` otherwise;
  - `claude_profile_daily.total`, `measured`, `tier_index`, `tier_points_to_next` and `total_wow`.
- `evidence_json` keys, exactly; an undefined input is JSON `null`:
  - prompt-hygiene `{slash_kinds}`
  - context-hygiene `{median_ctx, factor}`
  - session-hygiene `{median_requests, long_sessions, long_with_reset, compactions, f_session_length, f_compaction}`
  - model-routing `{models, top_model, top_pct}`
  - cost-discipline `{cache_fresh_ratio, factor, cost_per_session}`
  - verification `{tool_calls, inspect_share, tool_error_rate}`
  - automation `{headless_sessions, subagent_launches, mcp_calls}`
  - reuse `{slash_max_repeat, top_command, mcp_servers}`
  - security `{prompts_with_mode, bypass_prompts, bypass_share}`
  - output-quality `{requests, api_errors, success, tool_error_rate}`

- [ ] **Step 1: Window inputs.** Build one temp row per ungated day holding every input in spec §4.4:
  - main-thread `claude_tool_calls` (tool name not NULL) and `claude_slash_commands` in the `'30'` window, by local day of `ts`;
  - `PreCompact` and `UserPromptSubmit` rows from `claude_events` (with `json_extract(payload_json,'$.permission_mode')`);
  - model counts excluding `<synthetic>` and empty. `top_pct` = `CAST(round(top * 100.0 / n) AS INTEGER)` with `n` = the non-synthetic, non-empty rows;
  - `cost_per_session` = the mean of `MAX(total_cost_usd)` per session in the window with a reading, else NULL.

  A tool-covered (†) input is NULL when `tool_covered = 0`, or when there are zero tool calls where the spec says so.
- [ ] **Step 2: Parts and scores.** Each part is NULL when its input is NULL. Each discipline is `AVG` of its non-NULL parts (SQLite's `AVG` ignores NULLs, which is TheOne's "mean of the defined parts"). Then:
  - `score = CASE WHEN avg IS NULL THEN 0 ELSE MIN(60, MAX(0, CAST(round((avg / 100.0) * 60) AS INTEGER))) END`;
  - `status`: needs-data / `>= 45` strong / `>= 30` ok / needs-work.

  Evidence is built with `json_object(…)`.
- [ ] **Step 3: Total and ladder.**
  - `total` = SUM of the ten scores and `measured` = the count not needs-data.
  - `tier_index = MIN(5, total / 100)` (integer division), and `tier_points_to_next = (tier_index + 1) * 100 - total`, NULL at 5.
  - `total_wow = total(D) − total(D−7)`, NULL if either is NULL.
- [ ] **Step 4: Tests.** Extend `profile-basic` with tool calls, slash commands, events and snapshots chosen so every part is non-trivial. For each discipline, assert every part and the 0–60 score, with the arithmetic in comments, using at least one input per helper that lands strictly between the bounds. Also:
  1. The evidence numbers recompute from the raw tables with an independent SQL query in the test, not a helper shared with the rollup.
  2. With no tool rows, `tool_covered = 0`: prompt-hygiene is needs-data (0); verification is needs-data; automation is `clamp(runs × 20)` from headless sessions only; output-quality is from success only (Review Focus 5).
  3. Zero tool calls in a covered window leaves verification's error part undefined, not 100 (spec §4.4 departure).
  4. A `tools-unresolved`-shaped row counts in `tool_calls` but not in errors (Review Focus 1).
  5. Security is undefined without `permission_mode`; `bypass_share` 0.10 → `L` = `round(100 × (1 − 0.08/0.23))` = **65**.
  6. `total_wow` and the tier boundaries: 99 → 0, 100 → 1, 600 → 5 with NULL points to next.
  7. **Guard:** no file under `lib/` contains `350000`, `350_000`, `80000`, `80_000`, `2700` or `0.35`. Grep first, and replace any legitimate existing hit with a less generic token before writing the guard.
- [ ] **Step 5: Plant, and watch exactly one test go red each time:**
  - automation's runs from all sessions (not just `sdk-*`);
  - `AVG` replaced by `SUM/10`;
  - sidechain tool calls counted;
  - security's `good` set to 0;
  - `top_pct` left unrounded;
  - a threshold copied into `lib/render/profile.ts` (guard).
- [ ] **Step 6: Proof against TheOne**, on the Task 1–2 live copy, run by hand. `theone-lockstep.mjs`:
  - reads the copy's latest ungated day;
  - rebuilds TheOne's `CcflareUsageRecord[]` for its `'30'` window from `claude_requests` (session, ts in ms, cacheRead, input, output, model, `ok = !err`);
  - calls TheOne's own `computeHygieneScore` and `calculateUsageProfile(metricsFromSources({ window, factors, successRate, cc }))`, with a `cc` built from the same tool and slash rows;
  - prints a diff against `claude_profile_daily` and `claude_discipline_scores`.

  Run it with `node --experimental-strip-types`, importing the TheOneOS files by absolute path. The Matrix score, four factors and disciplines 1–6, 8 and 10 must match exactly. Paste the output into the task report. Where TheOne differs by design (spec §4.4 departures), name the difference.
- [ ] **Step 7: Live copy.** Re-run the rollup, then record the runtime, the latest day's ten scores with evidence, the total and tier, and `measured`.
- [ ] **Step 8: Commit** `feat(stage-4a): the ten disciplines, the 600 total and the ladder`.

### Task 4: The Usage Profile page

**Files:**
- Create: `lib/read/profile.ts`, `lib/render/profile.ts`, `tests/read-profile.test.ts`, `tests/render-profile.test.ts`
- Modify: `lib/render/layout.ts` (`NAV` gains `{ href: "/profile", label: "Usage Profile" }` after Models & Skills; remove `Profile` from `INERT_NAV`), `lib/views.ts` (`STATIC_VIEWS` entry, `ranged: true`), `tests/report-budget.test.ts`, `tests/serve.test.ts`, `CLAUDE.md` (the page, the test count), `SESSION.md`

**Interfaces:**
- Consumes: the tables from Tasks 2–3.
- Produces:

```ts
export type DisciplineId = "prompt-hygiene" | "context-hygiene" | "session-hygiene" | "model-routing"
  | "cost-discipline" | "verification" | "automation" | "reuse" | "security" | "output-quality";
export type DisciplineStatus = "needs-data" | "needs-work" | "ok" | "strong";
export interface DisciplineRow {
  id: DisciplineId; score: number; status: DisciplineStatus;
  definition: "theone" | "watchtower"; evidence: Record<string, number | string | null>;
}
export interface ProfileDay {
  day: string; windowRequests: number; toolCovered: boolean;
  total: number | null; measured: number | null; tierIndex: number | null;
  tierPointsToNext: number | null; totalWow: number | null;
  matrixScore: number | null; matrixTier: number | null; matrixPointsToNext: number | null;
  factors: { context: number | null; compaction: number | null; sessionLength: number | null; efficiency: number | null };
  inputs: { medianCtx: number | null; medianRequests: number | null; longSessions: number | null;
            longWithReset: number | null; cacheFreshRatio: number | null };
  matrixWow: number | null;
}
export interface ProfileData {
  latest: ProfileDay | null;            // the most recent day with a row
  disciplines: DisciplineRow[];         // latest day, in DisciplineId order; [] when gated
  history: { day: string; total: number | null }[];  // range days, oldest first
  coverageStart: string | null;         // local day of MIN(ts), main-thread tool calls
  range: Range;
}
export function readProfile(db: string, opts?: { now?: number; range?: Range }): ProfileData;
export function profileView(d: ProfileData, opts: { tz?: string }): View;
```

- [ ] **Step 1: Failing read tests.** Over the Task 3 fixture:
  - `latest` equals the last day;
  - disciplines come in id order with parsed evidence;
  - on a gated latest day, `disciplines` is `[]` and every score is `null`;
  - `history` covers the range, with `null` on gated days;
  - `coverageStart` is `null` with no tool rows.
- [ ] **Step 2: Implement `readProfile`** with `lib/core/sql.ts`, following `lib/read/history.ts`'s range handling. No arithmetic beyond parsing.
- [ ] **Step 3: Failing render tests.** For every theme:
  - the ladder card shows the tier label from `TIERS` (TheOne's six labels and descriptions, copied verbatim), `total / 600`, points to next, and a signed WoW;
  - "N of 10 measured" appears only when N < 10;
  - the Matrix card shows Coppertop / Operator / The One, its four factors with inputs, and its WoW;
  - there are ten cards with a 0–60 bar, the status word (text, not colour only), evidence sentences, and the "Watchtower definition" badge on automation and security only;
  - a needs-data card names what is missing, and a tool-derived one says "tool data starts <coverageStart>" or "no tool data yet";
  - the history uses `areaChart` with `null` on gated days, so the line breaks there and not on idle days (Review Focus 4);
  - a gated latest day renders "collecting — fewer than 20 requests in the last 30 days".
- [ ] **Step 4: Implement `lib/render/profile.ts`.** Discipline labels, blurbs and tier copy are TheOne's text (`usage-profile.ts` `AI_DISCIPLINES` / `AI_USAGE_TIERS`, `profile.ts` `TIER_META`), held as labels. Evidence formatters turn numbers into TheOne's sentences (for example `inspect_share` 0.34 → "34% of tool calls inspect code (Read/Grep/Glob)"). Use existing primitives only: `card`, `areaChart` and the bar markup used by History.
- [ ] **Step 5: Wire it up.** Add the route and nav. The report includes the page, and `report-budget.test.ts` still caps a year at 1 MB. `serve.test.ts`: `/profile` returns 200 and `?range=<script>` falls back and is escaped.
- [ ] **Step 6: Live copy.** Render `/profile` and the report from the copy. Record the timings, the report size, and screenshots of amber plus one team theme in `shots/`, which is git-ignored.
- [ ] **Step 7: Docs.** In `CLAUDE.md`:
  - the four new tables in the right lists;
  - schema v5;
  - the four `exit 1` paths;
  - the new test count.

  Add a `SESSION.md` entry: state, live-copy numbers, and the user's rollout commands (dry-run `install.sh`, live install, `~/.claude/watchtower-ingest.sh --backfill`, `~/.claude/claude-usage-rollup.sh`).
- [ ] **Step 8: Run** `npm test` and `npm run typecheck` and expect PASS. Commit `feat(stage-4a): the Usage Profile page`.

---

## After the tasks

One whole-branch review against the spec and this plan (Global Constraints, Review Focus,
every plant recorded), then at most one fix round, then a PR to `main`. The user merges it and
runs the rollout.
