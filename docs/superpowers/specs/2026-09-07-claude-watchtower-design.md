# Claude-Watchtower — Design

**Date:** 2026-09-07
**Status:** PARTLY SUPERSEDED — historical. Stages 1, 1.5 and 2 shipped from this
document and remain accurate. **Every ccflare / proxy section below is dead** and
is kept only as a record of what was considered: §"ccflare", the `proxy/`
directory in the tree, the `ccflare :8080` arm of the data-flow diagram, the
"proxy tab" behaviour, and build phase 3. Watchtower has no request-path
component and will not grow one — see the reasoning in
`2026-09-12-stage-3-dashboard-brainstorm.md` §"Section 2". The `proxy` config
stanza was deleted in 2026-09.

A standalone dashboard for Claude Code usage. It owns the capture scripts,
reads the local hook database, and includes an AI coach
for usage hygiene. It replaces what TheOne's `/ai-spend` page shows for Claude,
without depending on TheOne.

---

## 1. Purpose and scope

### What it is

Three things in one app:

1. **Capture** — the shell hook scripts that record Claude Code activity, moved
   under version control instead of living as loose files in `~/.claude`.
2. **Dashboard** — the local hook data (hours, rank, context hygiene, tokens,
   cost) plus ccflare proxy analytics (real per-request API accounting).
3. **Coach** — an AI review of usage habits, grounded strictly in real figures.

### Audience

**Personal now, distributable later.** Built for one machine, but with the
boundaries that make distribution a later project rather than a rewrite:

- No hardcoded paths — everything resolves through a config file with defaults.
- The capture schema carries a version number from day one.

Explicitly **deferred** (each its own future project): an `init` installer UX,
first-run setup, uninstall, schema migrations, packaging, and a Linux autostart
implementation.

### Non-goals for v1

- Writing a proxy. ccflare is an external dependency, never vendored.
- Codex Watch, Hermes Watch, and subscription tracking from TheOne's page.
  Watchtower is Claude-only.
- Replacing or modifying the TheOne app. Its code is untouched and its
  `/ai-spend` page keeps working. Note this does **not** extend to the shell
  scripts in `~/.claude`: those are shared infrastructure that TheOne happened
  to install first, and Watchtower takes ownership of them (§5).

---

## 2. Architecture

```
Claude-Watchtower/
├── capture/                    THE WRITER — vendored, in git
│   ├── lib.sh                  schema + SQL helpers (NOT the model)
│   ├── hook.sh                 8-event writer
│   ├── rollup.sh               THE ACTIVITY MODEL + derived rollups + rank
│   ├── snapshot.sh             throttled token/cost snapshot writer
│   └── install.sh              writes into ~/.claude, backs up first
├── lib/
│   ├── config.ts               path + settings resolution
│   ├── hooks/                  READ side of the capture DB
│   │   ├── db.ts               read-only sqlite connection
│   │   ├── read.ts             queries over DERIVED tables only
│   │   ├── ranks.ts            rank ladder (pure)
│   │   └── types.ts
│   ├── proxy/                  ccflare integration
│   │   ├── client.ts           GET-only API calls
│   │   ├── manage.ts           start / stop / status
│   │   ├── autostart.ts        launchd (macOS); systemd deferred
│   │   └── types.ts
│   └── coach/
│       ├── digest.ts           grounded snapshot from real figures
│       ├── prompt.ts           guardrails
│       └── provider.ts         CLI default, API optional
├── app/                        Next routes + API handlers
├── components/                 panels + charts
├── tests/                      vitest
└── watchtower.config.json
```

### The central decision: the model lives in ONE place

TheOne implements the activity model **twice** — in `claude-usage-rollup.sh`
and again in `lib/claude-hours/hours.ts` — and requires them to stay in lockstep
by hand. On 2026-09-07 they diverged, and its own `AGENTS.md` had to carry a
warning about it.

**Watchtower implements it once, in `capture/rollup.sh`.** The app never recomputes
activity. It shells out to `rollup.sh --quiet` (a full idempotent rebuild,
~0.18s) and then reads the derived tables.

Consequences, accepted knowingly:

| Gain | Cost |
|---|---|
| The model cannot drift | Dashboard requires capture scripts installed + executable |
| One edit rewrites all history | Cannot render from raw tables alone (TheOne can) |
| `lib/hooks/` is a thin reader, not a 322-line aggregator | Adds a subprocess call to page load |

The cost is acceptable because Watchtower **owns** the installer, so it can
guarantee the scripts exist.

---

## 3. Data flow

```
Claude Code ──8 hooks──▶ capture/hook.sh ──▶ SQLite ──▶ rollup.sh ──▶ derived tables
                                                                            │
ccflare :8080 ──GET /api/analytics────────────────────────────┐             │
                                                              ▼             ▼
                                                        Watchtower dashboard
                                                              │
                                                              ▼
                                                        coach digest ──▶ AI
```

### The database

Watchtower uses the **existing** capture store, preserving all history:

- Default path `~/.theone/claude-code-usage.sqlite`, overridable in config and
  by `THEONE_DB_PATH`.
- At time of writing it holds 2,449 sessions and ~172 engaged hours since July.
- TheOne continues reading the same file. Both are readers; only the shell
  scripts write.

Tables (written by `capture/`, never by the app):

| Table | Contents |
|---|---|
| `claude_sessions` | one row per session_id — lifecycle, repo, model, counters |
| `claude_events` | append-only hook event stream |
| `claude_status_snapshots` | throttled context/token/cost snapshots |
| `claude_daily_rollups` | **derived** daily history |
| `claude_rank_progress` | **derived** lifetime totals + rank |

The app reads **only the derived tables**, per §2.

### The activity model (rev 3)

Time is attributed per gap between consecutive events, classified by what the
session was doing during that gap. Rules are evaluated in order:

| Gap ends at | State | Counted |
|---|---|---|
| `SessionStart` | between sittings (a resumed id) | 0 |
| `SessionEnd` | window being closed | 0 |
| `UserPromptSubmit` | reading / typing | `MIN(gap, 300)` |
| system event while a turn is open | task running | `MIN(gap, 14400)` |
| anything else | think | `MIN(gap, 300)` |

`window_s` is the same span without the think cap, still excluding
between-sitting gaps. **`active_s <= window_s` always holds.**

Two rules exist for reasons that must not be lost:

1. **Session duration is `window_s`, never `ended_at - started_at`.** A
   `session_id` survives `--resume`, so the row spans the dormant calendar gap
   between sittings. In real data, 41 resumed sessions (1.7%) accounted for
   86.5% of all recorded hours under the naive rule.
2. **A gap ending at `UserPromptSubmit` is think-capped regardless of state.**
   `Stop` is unreliable — one real session logged 4 `Stop` events for 23
   prompts — so a WORK stretch can stay open indefinitely and would otherwise
   bill a walk-away as 4h of task time.

Tuning constants live only in `capture/rollup.sh`, inside the `_act` CTE:
`300` (think cap) and `14400` (work sanity cap). `capture/lib.sh` holds the
schema and SQL helpers and no part of the model — an agent sent there for the
caps finds nothing, which is how a second implementation gets written.

### Rank ladder

Resolved from **engaged (active) hours**, never wall clock:

```
Noobie 0h · Apprentice 20h · Builder 100h · Intermediate 300h
Advanced 800h · Pro 2000h · Master 5000h
```

### ccflare

Read **strictly via GET** on the management API: `/health`, `/api/stats`,
`/api/accounts`, `/api/analytics?range=1h|6h|24h|7d|30d`,
`/api/requests?limit=100`. Mutating endpoints are never called.

Watchtower additionally **manages the proxy lifecycle**: start, stop, status,
and autostart installation (launchd on macOS; a systemd unit is deferred with
the rest of the Linux work).

**Token honesty.** ccflare's `totalTokens` follows API accounting — input +
output + cache reads + cache writes — and cache reads dominate at ~90%+. The UI
must always split fresh tokens (input + output) from cache traffic and never
headline the raw total as fresh usage.

**What ccflare cannot see stays unshown.** MCP, tool, slash-command and
compaction counts are not exposed by its API. The UI declares them "not tracked
by ccflare" rather than estimating.

**No backfill.** ccflare only observes traffic that flows through it while
running. Any window where it was down is permanently invisible; the UI must
show coverage gaps honestly rather than implying completeness.

---

## 4. The coach

Builds a digest from **real figures only** — token composition, per-session
context sizes, spikes against the median, model mix, engaged-time ratios — and
asks an AI for usage recommendations. The prompt forbids inventing metrics and
declares untracked surfaces out of scope.

Two providers, selected in config:

- **`cli` (default)** — shells out to the `claude` binary already installed. No
  API key, no separate bill, zero setup.
- **`api`** — Anthropic API with a key from config. More reliable structured
  output; the better path when distribution happens.

Both return structured results and never throw: a missing binary or key yields
a `no-key` state, and an empty database yields `no-data`.

---

## 5. Install safety

`capture/` is **seeded from the existing `~/.claude` scripts as they stand
today** (already rev 3), and `install.sh` writes back to those same paths.

**The status line is not vendored.** `~/.claude/statusline.sh` is 259 lines of
the user's own three-row display; the snapshot writer is a block appended to it.
Watchtower ships `capture/snapshot.sh` and leaves the display alone. Because the
existing inline block already writes snapshots (sourcing `cc-track-lib.sh`,
which Watchtower now owns), `install.sh` must **detect existing snapshot
capture and not add a second writer** — two writers would double-insert rows.
Only when no writer is present does it append the one-line call.

This is deliberate. If Watchtower installed additional hooks under new
filenames while the existing ones stayed registered, **both sets would fire and
every session would be counted twice.** One set of hooks, at the known paths, is
the only safe arrangement while the database is shared.

`install.sh` must be idempotent, must back up `~/.claude/settings.json` and any
script it replaces into `~/.claude/backups/` before writing, and must validate
that `settings.json` is still valid JSON afterwards.

---

## 6. Error handling

**The capture scripts must never break Claude Code.** On the paths Claude Code
invokes — `hook.sh` and `snapshot.sh` — any missing dependency (`sqlite3`, `jq`)
or DB error exits 0 silently, writes nothing to stdout, and lets Claude Code
continue. This posture is inherited from the current tracker and is
non-negotiable.

The rule is about the caller surviving, not about the exit code itself.
`rollup.sh` is also an operator-facing command, and there a silent exit 0 on a
failed rebuild would hide exactly what the operator needs to see, so it reports
on stderr and exits 1. It stays safe under Claude Code because the installer
invokes it as `...; rollup --quiet >/dev/null 2>&1 || true`.

**The dashboard degrades honestly, never throws.** Three states, mirroring
TheOne's discipline:

- `not-configured` — no DB, no schema, or capture scripts absent
- `no-data` — schema present but empty
- `ok` — real data

The proxy tab reports "ccflare not running" rather than rendering zeros that
look like real measurements.

---

## 7. Testing

Vitest, mirroring TheOne's setup.

- **Pure logic unit-tested directly:** rank ladder, formatters, digest builder,
  config resolution.
- **The activity model is tested against a fixture database** built from a known
  event stream. The fixture must include:
  - a resumed session (two sittings separated by weeks) — asserts duration comes
    from `window_s`, not `ended_at - started_at`
  - a turn with no `Stop` event followed by a long gap — asserts the walk-away
    is think-capped, not billed as work
  - a long autonomous run — asserts task time is counted in full, not discarded

These three cases are regressions of real bugs. They must never be removed.

---

## 8. Stack

| | |
|---|---|
| Framework | Next 16.3.4, React 19.2.7 |
| Styling | Tailwind 4 |
| Database | better-sqlite3 12 (read-only connections) |
| Icons | lucide-react |
| Validation | zod |
| Tests | vitest |

Charts are hand-rolled components ported from TheOne; there is no chart
dependency.

---

## 9. Implementation order

Four stages, each independently useful:

1. **Foundation** — config resolution, `capture/` seeded from `~/.claude`,
   `install.sh`, schema versioning, fixture-DB tests.
2. **Hooks dashboard** — read side over derived tables, rank, the stat panels
   and charts ported from TheOne.
3. **Proxy** — ccflare client, status, analytics panel, lifecycle management
   and macOS autostart.
4. **Coach** — digest builder, prompt guardrails, CLI provider, then API
   provider.

---

## 10. Open items (deferred, not forgotten)

- Linux autostart (systemd unit) — needed before any distribution claim.
- Schema migrations — the version number exists from day one, but no migration
  runner until distribution.
- Installer UX (`init`, first-run, uninstall) — its own project.
- Whether TheOne's `/ai-spend` Claude tabs should eventually be retired in
  favour of Watchtower, or left as-is.
