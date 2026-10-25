# Stage 3D — dashboard UX, themes and TheOne parity (plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Stage 3C dashboard into the approved bold "TheOne glass" look with five
switchable themes and two navigation modes. Add every TheOne Claude stat that needs no
schema change: this-week bars, weekday habits, average context trend, rank ladder,
terminal breakdown, a Sessions page, model share donuts, a model table, effort mix and an
interactive time series.

**Architecture:** Rendering stays on the server as pure `data → string` functions. Colors
become CSS custom properties, one variable block per theme. A single hand-written inline
client script adds tooltips, count-up, sorting, settings, range toggles and the existing
Live poll. Readers gain an optional `range`. The report embeds every range and toggles
between them in the page.

**Tech stack:** Node ≥ 22 with native type stripping (no build), `node:http`, the `sqlite3`
CLI through `lib/core/sql.ts`, vitest. **Zero runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-09-23-stage-3d-dashboard-ux-design.md`, which is
binding. Exact values (hex codes, thresholds, budgets, token names) live there. Copy them
from the spec and do not re-derive them. Mockups: `.superpowers/brainstorm/51075-1790208482/content/live-page-v2.html`
(the reference look) and `palettes.html` (the four alternate themes).

**Branch:** `stage-3d-dashboard-ux` @ `f860674`, cut from `stage-3c-dashboard` (PR #10 open).

## Global Constraints

- DB is read-only. The dashboard never writes, never runs `rollup.sh` or `sync`, and has no Sync button.
- Loopback bind only. The `Host` check (421) and `X-Content-Type-Options: nosniff` stay on every response.
- `package.json` has no `dependencies`. There is no chart library, CSS framework or font download; use system font stacks only.
- No activity-model math in TypeScript. `MIN(gap,` must not appear in `lib/**`. TypeScript groups and labels only.
- Tokens come from `claude_requests` or transcripts, never `claude_status_snapshots`. Never aggregate requests through `claude_sessions`. Snapshot counters are `MAX` per session, never `SUM`.
- NULL or missing data renders as "no data", "pending" or a gap. It is never `0`, never `$0.00`, never counted up from 0, and never sorted as 0 (nulls sort last).
- `(excluded)` is hidden on project-named surfaces, and totals still reconcile with `claude_daily_rollups`.
- `report` uses the same read and render functions as `serve`, omits Live, and makes no external requests.
- Themes: `amber` (default), `claude`, `giants`, `raptors`, `bills`, with token values verbatim from spec §4.1. Team themes are colors only: no logos, images, URLs or team names except the theme's label in Settings.
- Motion: entrance animations run once per load (gated by `html.settled`), and **all** motion is off under `prefers-reduced-motion: reduce`.
- Settings persist in `localStorage` keys `wt.theme` and `wt.nav`, only inside `try/catch`. Without storage the page falls back to amber + pills.
- Ranges are `7d | 30d | 90d | all`, default `30d`. An unknown `?range=` falls back to `30d`.
- Client script is ≤ 12 KB unminified. Its only `fetch` is `/api/live`.
- Report is ≤ 1 MB on the live DB copy.
- No schema change: `CC_SCHEMA_VERSION` stays 4, and nothing under `~/.claude` changes.

## Review Focus

1. **A browser with storage blocked** (Safari private mode, or `file://` for the report). The page must render in amber + pills with no console error. Test: Task 1, `client` storage wrapper returns defaults when `localStorage` throws.
2. **A range with no data** (e.g. `?range=7d` after a week away). Every chart shows its named empty state, and the hero card never shows `0` as a measurement. Test: Task 2 renders History and Task 3 renders Projects/Sessions over a fixture window with zero rows.
3. **Hostile `?range=` / `?project=` values** (`?range=<script>`, `?project=../../x`, a very long string). The server falls back or escapes, never errors or reflects raw input. Test: Task 3 serve test with those query strings, asserting a 200, the fallback range and escaped output.
4. **Live poll after first paint.** Replacing section HTML must not replay entrance animations or reset the theme. Test: Task 1 asserts the poller swaps content inside `html.settled` and every entrance rule is scoped `html:not(.settled)`.
5. **A theme that makes status unreadable** (e.g. Raptors, where `--ok` is silver). Limit-ring states must stay distinguishable via the shared `--warn`/`--over` plus the text label. Test: Task 1 asserts every ring state renders a text label, not color alone.

---

## Tasks

Four larger tasks, per the user's lighter process. **Each task ends by rendering its pages
against a `.backup` copy of the live DB** (in its own new directory; the `.schema-vN`
marker lives in the DB's directory) and recording timings, sizes and one reconciliation in
its report. One whole-branch review at the end, with at most one fix round.

### Task 1: Theme system, shell, client script, and the Live page

**Files:**
- Create: `lib/render/theme.ts`, `lib/render/client.ts`, `tests/render-theme.test.ts`, `tests/render-client.test.ts`
- Modify: `lib/render/layout.ts` (replace `STYLES` colors with tokens; new header, pill rows, sidebar, settings popover; `poller` moves into `client.ts`), `lib/render/live.ts`, `lib/read/live.ts` (this-week rows), `tests/render-live.test.ts`, `tests/read-live.test.ts`, `tests/serve.test.ts`

**Interfaces:**
- Produces:
  - `THEMES: readonly ThemeId[]` where `type ThemeId = "amber" | "claude" | "giants" | "raptors" | "bills"`. Also `THEME_LABELS: Record<ThemeId, string>` (`"TheOne amber" | "Claude" | "SF Giants" | "Toronto Raptors" | "Buffalo Bills"`) and `TOKENS: Record<ThemeId, Record<TokenName, string>>`.
  - `themeCss(): string` emits `:root,[data-theme=amber]{…}` plus one block per theme, the shared effects CSS, and the reduced-motion block.
  - `headScript(): string`: the tiny blocking script that applies stored `wt.theme` / `wt.nav` before first paint.
  - `clientScript(opts: { pollSeconds?: number }): string`: tooltips, count-up, sortable, settings, range toggles, poll.
  - `layout.ts`:
    - `NAV` gains `{ href: "/sessions", label: "Sessions" }` between Projects and Skills.
    - Label change: `"Skills & Models"` becomes `"Models & Skills"`.
    - `INERT_NAV: { label: string; stage: string }[]` = Overview, Codex, Hermes (Stage 5) and Profile (Stage 4).
    - `View` gains an optional `hero?: boolean`, and the render helper `card(opts: { title: string; body: string; hero?: boolean; wide?: boolean }): string` is exported.
  - `LiveData.week: { day: string; activeHours: number | null }[]`: exactly the last 7 calendar days, oldest first. `null` means no rollup row.

- [x] **Step 1: Theme tests first.** In `tests/render-theme.test.ts`, assert that:
  - every `ThemeId` defines every token name in spec §4.1;
  - `TOKENS.amber` matches the spec's amber column verbatim;
  - WCAG contrast (write a 10-line `relativeLuminance`/`contrast` helper in the test) is ≥ 4.5 for `--ink` on `--bg` and ≥ 3 for `--dim` on `--bg` in every theme;
  - `themeCss()` contains no `url(`, `<img`, `http`, or the strings `Giants`/`Raptors`/`Bills` outside `THEME_LABELS`;
  - `themeCss()` contains `@media (prefers-reduced-motion: reduce)` and every `@keyframes` name it defines is referenced only inside selectors starting with `html:not(.settled)`, except the continuous effects (aurora drift, conic spin, live-dot ping, bar flow, burn dash).

  Run `npx vitest run tests/render-theme.test.ts` and expect it to FAIL (module missing).
- [x] **Step 2: Implement `lib/render/theme.ts`** with values verbatim from spec §4.1 and the effects from `live-page-v2.html`. If a mockup value fails the contrast test, adjust only that value and note it in the report. Re-run and expect PASS.
- [x] **Step 3: Client tests.** In `tests/render-client.test.ts`, run `clientScript({pollSeconds:5})` inside `node:vm` with a minimal fake `document`/`window` (a hand-rolled stub, no jsdom dependency). Assert that:
  - (a) the script length is ≤ 12 × 1024;
  - (b) the source contains exactly one `fetch(`, and its argument is `"/api/live"`;
  - (c) when `localStorage.getItem` throws, the settings reader returns `{theme:"amber", nav:"pills"}` and nothing throws (**Review Focus 1**);
  - (d) count-up skips an element whose `data-count` is `""` or `"null"` (**guard 5**; plant it by removing the finite check, watch exactly this test go red, then restore);
  - (e) after init, `document.documentElement.classList` contains `settled`.

  Expect FAIL, then implement `lib/render/client.ts` and expect PASS. Keep the poller's existing behaviour: same endpoint, same interval source, same DOM targets.
- [x] **Step 4: Rebuild `layout.ts`.** The document gets:
  - `<html data-theme="amber" data-nav="pills">`, with `headScript()` in `<head>`;
  - `themeCss()` plus the layout CSS, all colors as `var(--…)`, with a test grepping `layout.ts` for any hex color outside `theme.ts`;
  - the header with the shining wordmark, the tool pill row (Claude Code active, the others inert with `aria-disabled="true"` and `title="Stage 5"`), the page pill row from `NAV` + `INERT_NAV` (Profile inert, `title="Stage 4"`), and ⚙ settings;
  - the sidebar variant driven by `html[data-nav=sidebar]` CSS (same DOM, restyled; below 900px it falls back to pills);
  - the settings popover with the 5 theme swatches from `THEME_LABELS` and Pills/Sidebar;
  - `clientScript` at the end of `<body>`.

  Assert in `tests/serve.test.ts` that `/` contains `data-theme="amber"` and the Sessions nav entry, and that the inert entries are not `<a href>`.
- [x] **Step 5: `LiveData.week`.** Read `claude_daily_rollups.active_ms` for `lastNDays(today, 7)` (reuse `lib/read/history.ts`). A missing day is `null`, not 0. Test in `tests/read-live.test.ts` with a fixture that has a gap day, and assert `null`. Plant it (coalesce to 0) and watch exactly that test go red.
- [x] **Step 6: Restyle `lib/render/live.ts`** to the `live-page-v2.html` layout:
  - limit rings get a class by state: ok < 70 ≤ warn < 90 ≤ over. Every state prints a text label (`"ok" | "high" | "near limit" | "over limit"`) under the percent (**Review Focus 5**, tested);
  - the current-session hero card uses `card({hero:true})`;
  - the today card;
  - the this-week `dayBars` with today highlighted, null days drawn as a dashed gap marker with the tip "no data";
  - rank + progress bar;
  - the ticker, newest row highlighted.

  Headline numbers get `data-count` only when finite. Keep every existing Live test green, and update snapshot fixtures only where markup legitimately changed; the report lists which ones.
- [x] **Step 7: Guard 6.** Add a test that parses `themeCss() + layout CSS` and fails if any entrance animation (`rise`, `sweep`, `grow`, `bar`) is applied by a selector not prefixed `html:not(.settled)`. Plant it (drop the prefix on `.c`), watch exactly this test go red, then restore. Also assert the poller only replaces `[data-live]` regions (**Review Focus 4**).
- [x] **Step 8: Full check.** Run `npm test` and `npm run typecheck`. Both must be clean.
- [x] **Step 9: Live copy + screenshots.** Serve against a `.backup` copy with `THEONE_DB_PATH`. Using BrowserOS Neo (the `browseros-neo` MCP; fall back to `chrome-devtools` only if it is unavailable), screenshot `/` in all 5 themes and in sidebar mode into `.superpowers/sdd/2026-09-23-stage-3d-dashboard-ux/shots/task-1/`. Record `/` render time and size.
- [x] **Step 10: Commit.** `feat(stage-3d): theme system, bold shell, settings, and the Live page`. Add a short "**Done.** Rulings:" list under this task in the plan.

**Done.** Rulings:
- `--warn`/`--over` are the shared `#f59e0b`/`#ef4444` in every theme (spec §4.1), not the per-theme `--warn` in `palettes.html`. No mockup value failed contrast; nothing adjusted.
- Three derived custom properties beyond the spec tokens (`--pill-a`, `--num-tint`, `--bar`) carry the Bills lifts (`#1a4fbf` pill start, `#8FB3FF` number tint, `#3D7BFF` bars). They equal an accent in the other themes. Swatch colours are emitted by `themeCss()`, so no hex leaves `theme.ts`.
- Continuous effects are drift, spin, ping, flow, dash **plus `shine` (wordmark) and `pulse` (over-limit ring)**, both loops rather than entrances. Entrances: rise, sweep, grow, bar. The card `rise` is applied in `layout.ts` (structure), the rest in `theme.ts`, so guard 6's plant on `.c` turns exactly one test red.
- `html.settled` is added 1.8 s after init (0 under reduced motion) and again before any poll swap, so a 1 s poll cannot replay an entrance.
- Limit rings: `progressRing` gains `tone: "limit"` and `limitState()`. Four words over three states: `ok` (< 70), `high` (70–90), `near limit` (90–100), `over limit` (≥ 100), the last two both `ring-over`. The default `severity` bands are unchanged for their existing tests.
- Rate limits stay one card, `<h2>Rate limits</h2>` with both rings, so the report test that asserts Live is absent keeps its anchor.
- The poll payload is unchanged (`html`). The client parses it in a `<template>` and replaces the inner HTML of each `[data-live]` region only. Each Live card's body is one region, so the hero card and its running conic border survive every poll.
- Nav links keep the exact `<a href aria-current="page">` shape; pills are styled via `.pages a`. The Claude Code tool pill is a current `<span>`, never a link. `/sessions` is in `NAV` and 404s until Task 3 registers it.
- Every page, the report included, now carries the head script and client script. The report's has no poller (no `fetch(`, no `/api/`). Tests that read "no `<script>`" as "never polls" now assert no `fetch(` and no `/api/live` instead.
- `View.hero` is declared and descriptive only; the shell does not restyle on it. `card()` escapes its title and takes body HTML. For Live's data-live regions, the region `<div>` goes inside the body, and `card()` needs no extra option.
- `LiveData` also gains `rank`, `streak`, `today.costUsd`, `session.repo` and `burnRate.buckets` (10 × 30 s, for the 5-minute sparkline the spec lists). All are reads or grouping only: rank via the now-exported `readRank`, the streak via History's `streaks()`.
- The Skills view title follows the nav rename: "Models & Skills".
- Toggle protocol for Tasks 2 and 4: a `[data-range-to=k]` button shows `[data-range=k]` blocks inside its nearest `[data-ranges]` (else the whole document); `data-metric-to` / `data-metric` / `data-metrics` work the same way. Sorting: `table.sortable th` clicks sort by `data-sort`, and an empty value sorts last both ways. `window.wt` exposes `settings`, `countUp`, `sort`, `flip` and `swap` for tests.
- `tests/helpers/dom-stub.ts` is the shared `node:vm` DOM for client tests, and `tests/helpers/css.ts` is the rule walker for motion guards. Task 3 extends the stub for sorting.

### Task 2: Primitives restyle, ladder, ranges, and History

**Files:**
- Create: `lib/render/ladder.ts`, `lib/read/range.ts`, `tests/render-ladder.test.ts`, `tests/read-range.test.ts`
- Modify: `lib/render/charts.ts`, `lib/render/history.ts`, `lib/read/history.ts`, `lib/views.ts`, `lib/serve.ts`, `lib/render/report.ts`, `tests/render-history.test.ts`, `tests/read-history.test.ts`, `tests/serve.test.ts`

**Interfaces:**
- Consumes: `card()`, `THEMES`, `clientScript` range toggles (Task 1).
- Produces:
  - `lib/read/range.ts`:
    - `type Range = "7d" | "30d" | "90d" | "all"`
    - `RANGES: readonly Range[]`
    - `DEFAULT_RANGE: Range = "30d"`
    - `parseRange(s: string | null | undefined): Range` (unknown values give the default)
    - `rangeStartDay(today: string, r: Range): string | null` (null for `all`)
  - `ViewContext` gains `range: Range` and `project?: string`. `StaticView` gains `ranged: boolean`.
  - `rangePills(active: Range, mode: "link" | "toggle", href: (r: Range) => string): string` in `charts.ts`.
  - `RANK_TIERS: readonly { name: string; minHours: number }[]` and `rankLadder(tiers: typeof RANK_TIERS, current: { rankName: string; activeHours: number; hoursToNext: number | null } | null): string` in `lib/render/ladder.ts`.
  - `HistoryData` gains `weekday: { dow: 0|1|2|3|4|5|6; avgActiveHours: number | null; days: number }[]` and `contextTrend: { day: string; avgContextPct: number | null }[]`.
  - Every existing reader signature gains `opts.range?: Range` (the default preserves today's behaviour where a reader had a fixed 30-day window).

- [x] **Step 1: Ranges.** Write `tests/read-range.test.ts`:
  - `parseRange("7d")` gives `"7d"`;
  - `parseRange("<script>")`, `parseRange("")`, `parseRange(undefined)` and a 10 KB string all give `"30d"`;
  - `rangeStartDay("2026-09-23","7d")` is `"2026-09-17"`;
  - `"all"` gives `null`.

  Expect FAIL, implement, expect PASS.
- [x] **Step 2: Serve plumbing.** `serve.ts` parses `?range=` with `parseRange` and passes it through `ViewContext`. Rendered pages escape nothing from the raw query (the `Range` type guarantees this). In `tests/serve.test.ts`, assert that `/history?range=<script>` returns 200 and the 30d pill is active, and that the response body does not contain `<script>alert` (**Review Focus 3**, part 1).
- [x] **Step 3: Restyle `charts.ts`.** All 8 primitives use `var(--…)` classes only; a test greps `charts.ts` for hex colors. Every mark gets `data-tip="<escaped label>: <value>"` alongside its existing `<title>`. The headline number, where a primitive has one, gets `data-count` only when finite. Existing primitive tests stay green, including the named empty cases. Add `rangePills`, with tests for both modes.
- [x] **Step 4: The ladder.**
  - `tests/render-ladder.test.ts` reads `capture/rollup.sh`, extracts `names=(…)` and `mins=(…)` with a regex, and asserts they deep-equal `RANK_TIERS` (**guard 4**; plant it by changing `Pro` to 2500, watch exactly this test go red, restore).
  - `rankLadder` snapshot cases: the real position (Builder, 250h); `null` hours (the empty state, with no tier highlighted); and past Master.
  - TypeScript never computes the user's tier. The highlighted tier is the one whose `name === claude_rank_progress.rank_name`, passed in by the caller. (The signature in the Interfaces block already takes `current` from `claude_rank_progress`.)
- [x] **Step 5: History reads.**
  - `weekday`: mean `active_ms` per weekday over days **with a row** in range. `days` counts those rows, and a weekday with 0 rows is `null`.
  - `contextTrend`: `avg_context_pct` per day, **only where at least one `claude_status_snapshots` row has that local day**, otherwise `null`.

  Test both on the fixture. **Guard 1:** add a fixture day with a rollup row but no snapshots, assert `null`, plant it (drop the snapshot-existence condition so it returns 0), and watch exactly that test go red.
- [x] **Step 6: Restyle `history.ts`.** Cards, with the ladder as hero. Add the weekday habit bars (caption "average of days you used it"), the context trend as an `areaChart` with gaps, and the range pills (linking in serve mode). The calendar heatmap always shows a year and the ladder ignores range; the trends and bars honour it. Existing hygiene-gap and denominator tests stay green. Add **Review Focus 2**: a render over a window with zero rows shows named empty states and no hero `0`.
- [x] **Step 7: Report ranges.** For each `STATIC_VIEWS` entry with `ranged: true`, `buildReport` builds the view once per `RANGES` value. It emits the four bodies wrapped in `<div data-range="…" hidden>`, with the default one unhidden, and `rangePills(…, "toggle", …)` above them. Test: the report contains 4 `data-range` blocks for History and exactly one unhidden. **Ruling:** the whole view body is duplicated per range rather than only range-dependent blocks. That is simpler, and the ≤ 1 MB budget covers it. It costs report size, which Task 4 measures.
- [x] **Step 8: Full check.** Run `npm test` and `npm run typecheck`. Both must be clean.
- [x] **Step 9: Live copy.** Render `/history` for every range. Reconcile: the sum of this week's `activeHours` equals the rollup SUM over the same 7 days. Screenshot `/history` in amber + one other theme into `shots/task-2/`.
- [x] **Step 10: Commit.** `feat(stage-3d): restyled primitives, ranges, rank ladder, and History`. Add the "**Done.** Rulings:" list.

**Done.** Rulings:
- `ViewContext.range` is required; `buildReport` takes `Omit<ViewContext, "range">` (a file has no query) and builds each ranged view once per `RANGES` value. `bin/watchtower` is unchanged. `ViewContext.project` is declared only; Task 3 parses `?project=`.
- The pills are not part of `View.body`. `renderStaticRoute` prepends link pills to a ranged view, and the report wraps the four bodies in `rangeBlocks()` (`report.ts`: a `<div class="ranged" data-ranges>` holding toggle pills and `<div data-range=…>` blocks). This keeps the "every view's body appears byte for byte in the report" test true, and no `href="/…"` enters the report.
- Range pills are styled by `aria-current` (links) or `aria-pressed` (toggles), never a static class, so a flipped toggle restyles itself. Labels are `7d · 30d · 90d · All`.
- History under a range: the calendar (the last 365 days of `calendar`), the ladder, the streaks, coverage and the 14-row drivers table are lifetime. Weekday bars, when-you-work (prompts), hygiene, context, active vs idle and cumulative cost honour the range. Cumulative cost draws the lifetime running total over the window, so "to date" stays true; the caption gives both the in-range and to-date figures.
- `HistoryData` also gains `range`, `rangeFrom` and `span` (every calendar day in the window; for `all`, from the first rollup row). `days` stays every row, because streaks and coverage need them.
- **Context trend condition, tighter than the spec's wording:** a day is plotted only when a snapshot with a context reading falls on that local day AND comes from a session the rollup buckets on that day (its start day). The live copy's 2026-09-20 has 20 snapshots, all from sessions started on other days, while its own two sessions have none. The rollup stored 0 for that day, and the literal day-only rule would have plotted that 0. It is one SQL condition, so guard 1's plant removes it whole. The fixture carries this case: d1 has one snapshot from d0's session.
- Guard 1's render test builds its trend by hand, so only the reader test owns the snapshot condition (exactly one red).
- The ladder tests are structural (tier states, the lit tier, progress and empty text), not byte snapshots. The repo has no `.snap` files, and a byte snapshot would pass while asserting nothing about which tier is lit.
- `rankLadder` lights `tiers[i].name === rankName` and nothing else. An unknown stored name lights nothing and says so. Progress is display arithmetic: `(activeHours − tier.min) / (that + hoursToNext)`.
- `progressRing` gets `data-count` only with an opt-in `count: true` (and finite, and no `valueText`). Always-on would have broken Live's "no data-count when nothing is finite" guard, because the rings stay finite. It is the only primitive with a headline number.
- `data-tip` equals the `<title>` text on every mark. `areaChart` gains an invisible `rect.hit` column per non-null point (for Task 4's per-bucket tooltip), and nulls get none. The sparkline's tip is its label. The hour×weekday title changed from `Sun 15:00 · 1 prompts` to `Sun 15:00: 1 prompts` (label: value).
- `readProjects` and `readSkills` take `opts.range` for their fixed 30-day window only, and default to identical output (tested). `all` starts at the first project row or first request. Their views stay `ranged: false`; which blocks honour a range is Tasks 3 and 4's call.
- The hero's streak says "no current streak" rather than `0 days`. Tier thresholds (`Noobie 0h`) are labels, and RF2's no-hero-0 check sets them aside.
- History layout: rank hero | calendar; weekday | when; hygiene | context; drivers table (wide); active/idle | cost; coverage. A wide card stretched the 720-px chart viewBox into huge text, so charts sit in half-width cards.

### Task 3: Sessions page, sortable tables, and Projects

**Files:**
- Create: `lib/read/sessions.ts`, `lib/render/sessions.ts`, `tests/read-sessions.test.ts`, `tests/render-sessions.test.ts`
- Modify: `lib/read/projects.ts` (export the project-key lookup SQL for reuse; add terminal breakdown), `lib/render/projects.ts`, `lib/render/charts.ts` (`sortableTable`), `lib/views.ts`, `lib/serve.ts`, `tests/read-projects-skills.test.ts`, `tests/render-projects-skills.test.ts`, `tests/serve.test.ts`

**Interfaces:**
- Consumes: `Range`, `rangeStartDay`, `rangePills`, `card`, and `ViewContext.project` (Task 2).
- Produces:
  - `sortableTable(cols: { key: string; label: string; num?: boolean }[], rows: { cells: Record<string, { html: string; sort: number | string | null }> }[], opts?: { empty: string }): string`. It emits `<table class="sortable">` and sets `data-sort` on each cell; a null sort writes `data-sort=""`, which the client sorts last.
  - `SessionRow = { sessionId: string; project: string; terminal: string | null; firstTs: number; lastTs: number; requests: number; freshTokens: number; cacheRead: number; contextPerTurn: number | null; costUsd: number | null }`
  - `SessionsData = { range: Range; project: string | null; rows: SessionRow[]; capped: boolean; projects: string[] }`
  - `readSessions(db: string, opts: { now?: number; range?: Range; project?: string }): SessionsData`
  - `projectKeySql(cwdExpr: string): string` (extracted from `lib/read/projects.ts`, now used by both readers)
  - `ProjectsData.terminals: { terminal: string; sessions: number }[]` (NULL shows as `"unknown"`)

- [x] **Step 1: Sessions reader tests.** Against the fixture, assert that:
  - totals per session come from `claude_requests` **only**. Include a request whose `session_id` has no `claude_sessions` row and assert it is present with its tokens (**guard 2**; plant it by adding `JOIN claude_sessions` to the aggregate, watch exactly this test go red, restore);
  - `costUsd` is `MAX(total_cost_usd)` from snapshots, and a session with no snapshot has `costUsd === null`;
  - `contextPerTurn = (in + cache_read + cache_creation) / requests`, and is `null` when requests is 0 (it cannot be, but guard it);
  - rows are newest first and capped at 500 with `capped: true`, tested by building 501 sessions in a scratch fixture;
  - `project` filtering works;
  - project attribution matches `readProjects` for every session (reconciliation: the per-project sum of `freshTokens` equals the Projects page's tokens for the same range).
- [x] **Step 2: Extract `projectKeySql`** from `lib/read/projects.ts`. `readProjects` must produce identical output (the existing tests are the proof), and `readSessions` uses the same function, so there is no copy.
- [x] **Step 3: Implement `readSessions`.** It uses one aggregate over `claude_requests`, then a `LEFT JOIN` for labels (terminal from `claude_sessions`) and a `LEFT JOIN` to `(SELECT session_id, MAX(total_cost_usd) … GROUP BY session_id)`. Tests go green.
- [x] **Step 4: `sortableTable` plus the client sort.** Snapshot-test the empty case and the null-cost case. Extend `tests/render-client.test.ts`: sorting a column with `data-sort=""` puts those rows last both ascending and descending. **Guard 3:** render a session with `costUsd: null` and assert the cell shows `—`, never `$0.00`, and `data-sort=""`. Plant it (render `?? 0`) and watch exactly this test go red.
- [x] **Step 5: Sessions view.**
  - Hero card: the most expensive session in range. If no session has a cost, it shows "no cost data", never `$0.00`.
  - The sortable table, with each project cell linking to `/sessions?project=<encoded>` in serve mode and plain text in the report.
  - Range pills and the cap note.
  - Register `/sessions` in `STATIC_VIEWS` with `ranged: true`.
  - `serve.ts` passes `?project=` through; an unknown project renders an empty table with a "no sessions for this project" state.
  - Test `?project=../../x` and a 10 KB value: 200, escaped, empty state (**Review Focus 3**, part 2).
- [x] **Step 6: Projects.**
  - Add `terminals` (a `COUNT(*)` of `claude_sessions` per `terminal_app` in range, NULL shown as `"unknown"`).
  - Restyle into cards, with the hero being the top project by active hours.
  - The ranked table becomes `sortableTable`.
  - Add the terminal breakdown donut and range pills.
  - Existing Projects guards (the `claude_sessions` drop and SUM vs MAX) stay green.
- [x] **Step 7: Full check.** Run `npm test` and `npm run typecheck`. Both must be clean.
- [x] **Step 8: Live copy.** Render `/sessions` and `/projects` for every range. Record the session count, whether it hit the cap, and the reconciliation from Step 1 on real data. Screenshot both pages into `shots/task-3/`.
- [x] **Step 9: Commit.** `feat(stage-3d): the Sessions page, sortable tables, and restyled Projects`. Add the "**Done.** Rulings:" list.

**Done.** Rulings:
- `projectKeySql(cwdExpr)` is a correlated lookup (`COALESCE((SELECT … FROM claude_project_paths _pp WHERE _pp.cwd = <expr>), '(unfiled)')`), not a join the caller spells, so both readers share one definition. Proof it changed nothing: the extraction alone kept every existing Projects/serve/report test green, and `readProjects` output was byte-identical to HEAD on the live copy in all four ranges (pinned clock).
- **A session that ran in two projects gets one row per project**, each holding only that project's requests; cost (session-level) repeats on both rows, and the session cell carries a `+N` marker with a tooltip saying so. This is what makes the per-project sum of fresh tokens equal the Projects tokens exactly (11 such sessions on the live copy). The project comes from each request's own cwd, not `claude_sessions.cwd` (which 22.4% of requests have no row for).
- Ranges are whole local days, bounded exactly as the rollup buckets a request (`strftime(… 'localtime')` between the range start and today); `now` only sets today. A session straddling the range start contributes only its in-range requests. Cost is the session's `MAX(total_cost_usd)` over snapshots up to `now`, whatever the range.
- Rows are newest first by **last** request; the cap is `SESSION_CAP = 500` (a `LIMIT 501` detects `capped`).
- `SessionsData.projects` is every project key with a request on record (all time, `(excluded)` dropped). **A `?project=` filter reaches SQL only if it is in that list**; anything else returns no rows without running the aggregate. So a hostile, NUL-bearing or 10 KB value never becomes part of a statement (a NUL could not even ride in sqlite3's argv), and the renderer never echoes one it did not match ("No sessions on record for that project.").
- `View.pillQuery` (new, optional): the view supplies extra query for its served range pills (`&project=…`), built only from a matched filter. `ViewContext.served` (new, optional): serve sets it; it enables route links (Sessions project filter, and the Projects project name → its sessions). The report leaves it unset, so the "every view's body appears byte for byte in the report" test holds unchanged in spirit.
- **Projects is `ranged: true` and every block honours the range**: ranked totals, sparklines ("by day"), branches (by request day), lines (a session's highest reading booked whole to the range its *last* reading falls in — cumulative counters cannot be split by day), terminals (sessions by `started_at` local day). `ProjectsData` gains `range` and `terminals`; the default range stays 30d, so `readProjects(db, {now})` now reports 30-day totals where it used to report all-time ones.
- Terminal breakdown merges NULL, `''` and the stored literal `"unknown"` into one `"unknown"` slice.
- **Report rows:** the report (not served) lists the `REPORT_ROWS = 100` most recent sessions per range, with a note; served pages list up to 500. With all four ranges embedded, the uncapped Sessions view alone was 843 KB and the report 1.58 MB. Now it is 976 KB. The hero still ranks all listed rows (≤ 500).
- Sort values are rounded (context per turn to an integer, cost to 4 dp) and the session column sorts by its 8-char prefix, to keep rows small; display text is unchanged.
- The hero on Sessions is the highest cost among the listed rows; none priced says "no cost data"; no rows says "no sessions … in the last N days". The Projects hero is `projects[0]` when its active hours are > 0, else "no active time …".
- Fixed a Task 1/2 CSS bug the first donut page exposed: `.seg.sN { fill }` (0,2,0) painted the donut's whole disc; `.donut circle.seg { fill: none; }` restores the ring.
- Time display is unchanged (UTC `stamp()`), per the brief; the live copy shows sessions dated 09-24 UTC on 09-23 local.

### Task 4: Models & Skills, Sources, report, and the finish

**Files:**
- Modify: `lib/read/skills.ts`, `lib/render/skills.ts`, `lib/render/sources.ts`, `lib/render/report.ts`, `lib/views.ts`, `tests/read-projects-skills.test.ts`, `tests/render-projects-skills.test.ts`, `tests/sources-report.test.ts` (Sources, report, and the `MIN(gap,` carriers sweep), `tests/capture-scripts.test.ts` (the original `MIN(gap,` guard)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `SkillsData` gains:
    - `modelShare: { model: string; requests: number; tokensOut: number }[]`
    - `modelTable: { model: string; requests: number; freshTokens: number; tokensOut: number; cacheHitPct: number | null; errorRate: number }[]`
    - `effort: { effort: string | null; requests: number }[]`
    - `series: { day: string; requests: number | null; tokensOut: number | null; costUsd: number | null }[]`: one entry per calendar day in range, with `null` on days with no data.

- [x] **Step 1: Reads, tests first.**
  - `modelTable.cacheHitPct` is `cache_read / (in + cache_read + cache_creation)` and `null` when the denominator is 0. Test a model with zero cache traffic and assert `null`.
  - `errorRate` = rows with `api_error_status IS NOT NULL` / requests.
  - `effort` keeps NULL as its own row.
  - `series` has requests and `tokens_out` per local day from `claude_requests`, and `costUsd` from `claude_daily_rollups.cost_usd`. A day with no row is `null` in each column. Reconcile: the sum of `series.costUsd` over the range equals the SUM of `claude_daily_rollups.cost_usd` over the same days, and the sum of `series.requests` equals `COUNT(*)` of `claude_requests` in range.

  Implement and go green.
- [x] **Step 2: Restyle Models & Skills.**
  - The hero is the time series: an `areaChart` with a metric toggle (Requests / Tokens / Cost) implemented as three pre-rendered charts toggled by the client, like the range blocks, with a tooltip per bucket.
  - Request-share and output-token-share `donut`s.
  - The model table as a `sortableTable`. There are **no** cost, latency or tok/s columns; the caption says "latency and cost by model arrive in Stage 4".
  - Effort mix as a `donut`, with NULL labelled "not recorded".
  - Existing leaderboards, subagent/main, cache hit, API errors and the fresh/cache/total framing, all restyled into cards.
  - Range pills.
- [x] **Step 3: Restyle Sources** into cards. No content change. Existing Sources tests stay green.
- [x] **Step 4: Report.**
  - The report includes the settings popover (theme + nav, persisted via the same `try`-wrapped storage, which may be unavailable on `file://`; the fallback is amber) and the range and metric toggles.
  - It still omits Live and has no poller.
  - Tests: the report has no `http://`/`https://` in `src=`/`href=`, the `fetch(` count in the report is 0, and every `STATIC_VIEWS` entry with `ranged: true` has 4 range blocks.
  - Size: the fixture report is ≤ 4× the 3C fixture report size (record the baseline first); measure the live copy against the ≤ 1 MB budget.
- [x] **Step 5: Guard sweep.**
  - Extend the `MIN(gap,` carriers test to `lib/render/theme.ts`, `lib/render/client.ts`, `lib/render/ladder.ts`, `lib/read/range.ts` and `lib/read/sessions.ts` (if it globs `lib/**` already, assert that the new files are inside the glob).
  - The zero-dependency test stays.
  - Add one test asserting no file under `lib/render/` contains a hex color except `theme.ts`.
- [x] **Step 6: Full check.** Run `npm test` and `npm run typecheck`. Both must be clean.
- [x] **Step 7: Live copy + the visual review set.**
  - Serve against a `.backup` copy.
  - With BrowserOS Neo, screenshot **every page × every theme**, plus every page in sidebar mode (amber), plus one page with reduced motion emulated if the browser allows it. Save them to `.superpowers/sdd/2026-09-23-stage-3d-dashboard-ux/shots/final/`.
  - Record every route's render time and size, and the report's size against the 1 MB budget.
- [x] **Step 8: Commit.** `feat(stage-3d): Models & Skills parity, restyled Sources, and the interactive report`. Add the "**Done.** Rulings:" list.

**Done.** Rulings:
- **Report dedupe, fixing Task 2's "whole body per range" ruling.** Ranged views now expose `View.sections`: a flat list of pieces (whole cards, or bare grid open/close tags). `rangeBlocks` emits a piece once when it is byte-identical in all four ranges, and wraps each run of differing pieces in four `<div data-range>` blocks. `.ranged, [data-range] { display: contents; }` keeps the grid layout and gaps, so a lifetime card sits beside a ranged one unchanged. If the ranges disagree on piece count, it falls back to one block per range. Measured on the live copy: **976,991 B at HEAD, 933,964 B now** (budget 1 MB, 1.9 s to build). By view: History 265 KB, Projects 227 KB, Sessions 154 KB, Skills 252 KB, Sources 2 KB. The fixture report baseline (3C, `2753c3f`) is **64,863 B**. Now it is 224,376 B at the fixture's own clock and 233,435 B at the test clock, both under 4× the baseline (259,452 B).
- Coarse sections (whole grid rows) did not dedupe on the fixture, because every row held at least one ranged card. That is why the pieces are flat.
- **The stackedBar hover is per column.** Each column gets one transparent `<rect class="hit">` carrying `data-tip` and a `<title>` that list only its non-zero parts (all zero gives `format(0)`). A column with no parts has no mark. Zero-height segments are no longer drawn. This took the 90d Skills model mix from 187 KB to about 20 KB.
- **Heatmap zero cells are merged into one `<path class="cell l0">`** with a single "0 prompts" tip. Non-zero cells stay individual rects. This saves about 25 KB per range.
- **`REPORT_ROWS` is 60, down from 100.** Served pages still list up to 500. With Skills ranged, 100 rows would have left the live report with no headroom.
- The Skills `all` range starts at MIN(first request day, first rollup day).
- `modelTable.freshTokens` = input + output, the same "fresh" as Projects and Sessions.
- `cacheHitPct` is `null` when the model has no cache traffic (`cache_read + cache_creation = 0`), not only when the spec's denominator is 0. A model with input but no caching has no cache-hit reading, and 0% would claim one. Otherwise it uses the spec formula `cache_read / (in + cache_read + cache_creation)`. On the live copy the one null model is `<synthetic>` (30d/90d/all). The cell shows "no reading" and sorts last.
- `errorRate` counts `NULLIF(api_error_status,'') IS NOT NULL`, matching the existing API-errors card, so `''` is not an error.
- `effort` treats `''` as NULL. Both render as "not recorded", drawn in the neutral remainder colour.
- **Range scope on Models & Skills.** The leaderboards (skills, plugins, MCP), main-vs-subagent and API errors stay lifetime, and their titles say "· all time". The series, share donuts, model table, effort, cache hit, model mix and token framing honour the range. The token card shows an all-time row plus a range row (no range row for `all`), with a composition bar.
- The output-token share donut is ranked by output, not by requests. In both donuts the top 5 are named and the rest merge into "N other models".
- **Categorical palette.** `SERIES` in `theme.ts` gives each theme 6 colours, emitted as `--c0`..`--c5`. A test checks that they are pairwise distinct, never `--warn`/`--over`/`--dim`, and ≥ 3:1 against the theme background. Amber's first slice is `#fbbf24`, because amber's `--a1` equals `--warn`. "Others", "not recorded", "(unknown)" and the Projects terminal "unknown" use `s-other` (`--dim` at .45 opacity), never an alarm colour.
- The hex sweep covers every `lib/render/*.ts` except `theme.ts`. The `MIN(gap,` carriers test now asserts that `lib/render/{theme,client,ladder,sessions}.ts` and `lib/read/{range,sessions}.ts` are inside its sweep.
- The fixture's dashboard scenario gains `effort` values (high, medium, and `''`) through `cc_sqlstr`.
- Visual fixes from the review set: the ring glow was clipped to a square (`.ring svg { overflow: visible }`), and a note at the end of a card left a trailing margin.
- **Reduced motion:** chrome-devtools `emulate` cannot set `prefers-reduced-motion`. The shots override `window.matchMedia` for reduced-motion queries, so the client settles immediately and skips the count-up. The CSS `@media (prefers-reduced-motion)` branch was not emulated.
- Screenshots were taken with chrome-devtools, as the controller directed. Sessions pages were taken at DPR 1, because at DPR 2 they exceed Chrome's ~16k px capture limit, which repeats the header at the bottom of the image. Time display is unchanged (UTC `stamp()`), per the brief.

## After the tasks

One whole-branch review on the most capable model, then one fix wave, then a scoped
re-review. Then **the user reviews the `shots/final/` set before merge**, as spec §9
requires.
