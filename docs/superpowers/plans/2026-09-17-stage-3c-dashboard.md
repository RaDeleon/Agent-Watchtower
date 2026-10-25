# Stage 3C — the dashboard (plan)

Binding spec: `docs/superpowers/specs/2026-09-14-stage-3-spec.md` §3C, which adopts
`2026-09-12-stage-3-dashboard-design.md` §§5–7 unchanged. Brainstorm decisions 1–9 are
closed; do not re-ask them.

Branch: `stage-3c-dashboard`, cut from `stage-3b-claude-adapter` @ `b8c5869` because
PR #9 is still open. Rebase onto `main` once it merges.

## Open items, now closed

| Item | Ruling | Why |
|---|---|---|
| Burn-rate window (spec §7.2) | **Rolling 5 minutes**: `SUM(tokens_out)` over `claude_requests` in the last 300s, ÷ 5. No requests in the window renders **"idle"**, never `0`. | Reacts within a minute at a 5s poll. A session average flattens to a constant; a last-N-requests window silently stretches to hours when you step away, so a stale figure reads as current. The idle state follows CLAUDE.md: do not assert a measurement where there is none. |
| `report` and Live (spec §7.3) | **Omit the Live view.** `report` emits History, Projects, Skills, Sources. | A frozen gauge reads as current. Rate limits and burn rate have no meaning once written to a file. |
| Streak (design §12.4) | **(a)** — derive in `lib/read/history.ts`, in one named function `streaks(days)`, pure, over already-derived day rows. | Sequencing existing day rows is grouping, not activity-model math. Isolated so Stage 4 can lift it into `rollup.sh` with the disciplines. No schema bump, which §1 and §11 forbid here. |
| Live tokens (found during task 1) | **Tail the active transcript.** The dashboard reads the current session's `.jsonl` read-only, incrementally, folding by ingest's `MAX`-per-`requestId` rule, and falls back to `claude_requests` when there is no transcript. The page names which source produced the figure. | `claude_requests` is only filled by ingest at SessionEnd. Measured 2026-09-17: the transcript had been written 1s earlier while the newest stored row was 11 minutes old — so a database-only burn rate reads "idle" during exactly the session someone is watching. User's call, 2026-09-17. |
| Scope | **Core views + Sources.** Extras (per-session table, model performance table, terminal breakdown, effort distribution, Matrix ladder) wait until the page has been used. | User's call, 2026-09-17. |

## Verified on the live DB before planning (2026-09-17)

Every read below returns real data today, including the cases the honesty rules exist for:

- Live 5h gauge, most recent non-NULL: `1.0%`. All-time peak **108.0%** — never clamp.
- Burn rate, last 5 min: 28 requests, 21,957 output tokens → **4,391 tok/min**.
- **7 zero-session days** (hygiene forced to 0 — the trend line must break, not dive) and
  **21 days with NULL `cache_hit_percentage`** (rescaled denominator, 65 or 75).
- Day rows are contiguous back from today, so `streaks()` has a real sequence to walk.

## Tasks

Four larger tasks, per the user's lighter process. **Each one ends by running against a
`.backup` copy of the live DB, not only fixtures.** One whole-branch review at the end,
at most one fix round.

### 1. Walking skeleton + the whole Live view
`dashboard` config stanza (port 4317, `host` loopback-only and loud, `pollSeconds`,
`WATCHTOWER_DASHBOARD_PORT`) · `lib/read/live.ts` · `lib/render/` layout + `progressRing`
· `bin/watchtower serve` on `node:http` · `GET /`, `/api/live`, `/api/health`, plain-text
404 · rate-limit gauges, current session, today's totals, burn rate, ticker.

Guards, each planted and watched turn exactly one test red: NULL rate limit rendered as
`0`; a rate limit clamped to 100; the server bound to `0.0.0.0`. E2e boots on port `:0`.

Ruling recorded in the fix wave (final review, M5):
- **"Read-only" is `-readonly`, with one fallback, and the fallback is not literally
  read-only on disk.** A WAL database whose `-shm` is absent (the normal state whenever
  no hook is running) cannot be opened with `-readonly`: building the WAL index is a
  write. `querySql` (`lib/core/sql.ts`) then reopens normally with `PRAGMA
  query_only=1`. Data writes are still refused by sqlite3, but the reopen creates
  `-wal`/`-shm` beside the database and may checkpoint on close. It is gated on the file
  existing, so it can never create a database. Accepted: the alternative is a dashboard
  that fails whenever you are not working.

### 2. The seven remaining primitives + History
`areaChart`, `stackedBar`, `donut`, `calendarHeatmap`, `hourWeekdayHeatmap`, `sparkline`,
`dayBars` — pure `data → string`, snapshot-tested, **empty input is a named case**.
`/history`: calendar heatmap, hour×weekday, rank ring, `streaks()`, hygiene trend with its
four components (cache 25 · context 30 · compact-vs-clear 25 · focus/idle 20), active-vs-idle
bars, cumulative cost, coverage, XP to next rank.

Guards: the trend line **breaks** on a zero-session day rather than plotting 0; a day with
NULL `cache_hit_percentage` shows which denominator applied.

**Done 2026-09-22.** Rulings made while building it:
- **Hygiene components are shown as their stored inputs, not as recomputed sub-scores.**
  Only the total is stored; rebuilding the four terms in TypeScript would be model math.
  The table shows cache hit %, peak context %, compacts/clears and idle share beside
  each term's weight, which is what makes a dip explainable.
- The denominator label (`hygieneScale`) mirrors rollup.sh's rescale rule. The reader
  test pins it to the real rollup's scores (68/75, 58/65), so a drift goes red.
- Streak day = `sessions > 0` (9 real days have 100+ sessions and a zero window).
  Today still empty counts back from yesterday.
- Hour × weekday counts `UserPromptSubmit` events: splitting active seconds by hour
  would be model math. Covers 2026-07-04 onward and says so.
- The hygiene trend is positioned by calendar date, so a date with no row is a gap too.
  On live data all 7 zero-session days precede the hooks' install, so the visible
  breaks are the pre-install stretch and one missing date (2026-09-05).
- Live copy: read 57ms, render 2ms, 58 KB. Planted: renderer plots 0, reader passes
  the stored 0, chart maps null→0, rescaled day labelled "of 100", fixed-75 denominator.
  All red. The first, second and fourth turn exactly one test red. The other two break
  shared layers, so every test built on those layers goes red too.

### 3. Projects + Skills & Models
`/projects`: ranked table with $/active hour, per-project sparklines, per-branch token
attribution, lines added/removed, repos donut. `(excluded)` stays hidden at read time.
`/skills`: skill/MCP/plugin leaderboards, subagent vs main thread, model mix, model donut,
cache hit rate, API errors, fresh-vs-cache-vs-total framing.

Guards: joining requests through `claude_sessions` drops ~22.4% and goes red; `SUM`ing a
snapshot counter instead of `MAX` per session goes red (the 281.7× overcount).

**Done 2026-09-23.** Rulings made while building it:
- `lib/read/projects.ts` re-exports `lib/projects.ts` untouched but does not call
  `readProjectRows`: it opens the DB without `readonly` and bounds 30d by sqlite's wall
  clock. The dashboard needs both a read-only handle and an injected `now`.
- Per-branch tokens resolve cwd → project through `claude_project_paths` with the rollup's
  own `_pk` rule. A reader test pins branch sums to the rollup's per-project tokens in all
  four columns, so the two lookups cannot drift.
- Lines: `MAX` per session, then summed; a session is booked to the project of its
  **latest** snapshot's cwd. A cumulative counter cannot be split across directories
  without differencing readings.
- A project with sessions and zero tokens shows "—", not 0: its transcripts were gone.
  Duplicate basenames get their parent directory. `compact()` gained `B`.
- Skills aggregates every request, excluded directory included, because no project is
  named there and its totals then equal `claude_daily_rollups` exactly. Model mix and donut
  count requests; the cache trend is the stored daily column, NULL as a gap.
- Live copy: projects read 145ms warm, skills 125ms, render 1ms each; 46 KB and 57 KB.
  Branch sums = rollup per-project tokens (35 projects, 0 mismatches); main + subagent =
  total; lines SUM would be 297.9× today. Planted: `JOIN claude_sessions` in the totals
  (19.8% of requests dropped on today's data) and `SUM` for `MAX` on lines. Each turned
  exactly one test red.

### 4. Sources + `report` + the guard sweep
`/sources` from `wt_*`: detected/enabled, adapter version, last ingest, cursor, records
ingested, **metrics rejected**, malformed lines, health, last error. `bin/watchtower report`
writes one self-contained HTML file through the **same** read and render functions, with
Live omitted and the poller stripped.

Guard sweep last, deliberately, so it runs against the finished surface: add `lib/read/**`
and `lib/render/**` to the `MIN(gap,` carriers test, and assert zero runtime dependencies.

**Done 2026-09-23.** Rulings made while building it:
- **One table, two entry points.** `lib/views.ts` lists History, Projects, Skills and
  Sources as `{href, build}`; the server answers each `href` with `viewPage(view)` and
  `report` stacks the same `View`s. A test asserts each view's body appears byte for byte
  in both. Live is not in the table, so `report` cannot emit it.
- `watchtower report [--out <file>|-]`, default `./watchtower-report.html`, `-` for
  stdout. Nav becomes in-page anchors; `page()` emits the poller only when given a poll
  interval and `report` never passes one, so the file has no `<script>` at all. A
  missing database is refused in one line before sqlite3 could create it.
- **"Detected" means a sync registered it.** The page runs no probe: `detect()` opens the
  source without `-readonly`. Sync registers a source only on a run that detected it.
  Config supplies the enabled column; a registered source config does not name shows
  "not in config", not "disabled".
- A never-run source has `ingest: null` and renders "never run", never a row of zeroes.
  A NULL cursor renders "none" with the reason (sync compares fingerprints).
  `records_ingested` is labelled "records written" (lifetime work, not inventory), with
  what is actually held per wt_* table beside it.
- A database with no wt_* tables is a state, not an error: the page says sync has never
  run. **That is the live database today** — `watchtower sync` has not been run on it.
- Guard sweep: the carriers test now covers `lib/read`, `lib/render`, `lib/serve.ts`,
  `lib/views.ts` and `bin/watchtower`, with non-vacuity checks. Zero runtime deps is
  asserted on `package.json` and on the code (shipped files import only `node:` and
  relative paths). The older `pkg.dependencies` line in the bin test was folded into it.
- Live copy: `/sources` read 21ms (4ms unsynced), render 1ms, 8 KB; served 90ms cold,
  19ms warm. `report` 0.36–0.49s wall, 158 KB; opened in a browser with 0 resource
  requests and 0 scripts. Planted: `MIN(gap,` in lib/read and lib/render, a
  `dependencies` block, a package import in bin, zero-filled never-run state in the
  reader and in the renderer, the poller in the report. Each turned exactly one test red.

## Out of scope, restated

No writes — the dashboard opens the DB read-only and never runs `rollup.sh`. No schema
change; `CC_SCHEMA_VERSION` stays 4. Nothing under `~/.claude` and no `install.sh` change,
so the hook path is untouched. No auth, no TLS, no non-loopback bind. The ten disciplines
and the rank ladder are Stage 4; Codex is Stage 5.
