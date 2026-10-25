# Stage 9 — Onboarding: `watchtower setup`, one guided command from checkout to dashboard

**Status:** written 2026-10-21 from piece 1 of `2026-09-15-sync-trigger-and-surfaces-design.md`
§6, without a chat brainstorm (the user's call). It awaits review.
**Branch:** `stage-9-onboarding`, cut from `main` @ `d405f08` (#31). #33 and #34 are open; merge
`main` into the branch before its PR.
**Scope:** piece 1, installer onboarding, only (decided 2026-10-21). Piece 2 (opt-in launchd
sync) and piece 3 (the TUI launcher) are not in this stage (§9).
**Version:** 0.10.0. No schema change: `CC_SCHEMA_VERSION` stays 11, `WT_SCHEMA_VERSION` 3.

## 1. Purpose and success

Today a new user follows four README steps by hand. Read against `capture/install.sh` and the
README, the first run trips on six things:

1. **A silent no-op install.** `install.sh` checks for `jq` but not `sqlite3`. Without
   `sqlite3`, every capture script exits 0 silently, so the install reports done and records
   nothing.
2. **An unseen edit to `settings.json`.** The README's preview installs into an empty temp
   directory, so it shows the hooks against `{}`, not against the user's own settings.
3. **No status line, no snapshots.** Status-line capture is one line of advice ("wire … into
   your status line"). A user who never follows it gets no "Claude Code's figure" and no
   rate-limit readings.
4. **An empty first dashboard.** History appears only after README step 3 (backfill, resolve,
   sync), which a new user may never reach.
5. **A manual `ln -s`** to put `watchtower` on PATH.
6. **Sources with no explanation.** Every source is on by default, and nothing says what each
   one reads. Opting out means writing `watchtower.config.json` by hand, under replace semantics:
   leave out Atlas's `projectRoots` and Atlas silently searches nowhere
   (`lib/adapters/index.ts:22`). The file is also read from the current directory only, so a
   config in the checkout is ignored whenever `watchtower` runs from anywhere else.

This stage adds **`watchtower setup`**: one command that checks requirements, says what it
found, asks a few questions, shows the exact `settings.json` change and, once confirmed,
installs capture, wires the status line, backfills history, links the CLI and opens the
dashboard.

Success:
- From a fresh checkout, `./bin/watchtower setup` with Enter to every question ends at an open
  dashboard holding the user's history, and says what that history can and cannot show (§3).
- **An existing user who presses Enter through every question gets exactly today's install:**
  the same files, the same `settings.json` byte for byte, and nothing else written. A
  non-interactive run with no flags does the same, fresh or existing.
- The `settings.json` that setup previews is the file it writes, byte for byte. Setup checks
  this after writing and stops if it differs.
- `install.sh` stays non-interactive. Run with no flags, it writes exactly what it writes
  today. No existing install test changes its expectations.
- Capture, the rollup and every stored number are untouched.

## 2. Decisions

Written without a brainstorm, so these are proposals to defend at review, not the user's
rulings. Each is cheap to reverse before the plan.

| # | Decision | Why |
|---|---|---|
| 1 | **The questions live in a new Node command, `watchtower setup`, not in `install.sh`.** This amends §6, which put them in `install.sh`. | Detection (each adapter's `detect()`), config (`loadConfig`) and the database path already live in TypeScript. Re-implementing them in bash would duplicate them and drift. `install.sh` holds the `settings.json` merge that shipped two hook-deletion bugs, and keeping it prompt-free leaves its tests and the dry-run gate exactly as they are. Sync and the dashboard already need Node. |
| 2 | **Every write under the Claude dir stays in `install.sh`.** Setup passes it flags. | One writer of `settings.json`, with one backup and one atomic rename. |
| 3 | **Defaults depend on whether capture is already installed** (`<claude dir>/cc-track-lib.sh` exists). On an existing install, every new step defaults to No. On a fresh one, the recommended steps default to Yes. | This meets §6's "every default equals today's behaviour" for every existing user, without making a new user type `y` five times. |
| 4 | **A non-interactive run with no flags runs the install only**, fresh or existing. `--yes` takes the defaults shown. | §6: non-TTY falls through. Scripts and the suite get today's install unless they ask for more. |
| 5 | **The status line is wired only when Claude Code has no `statusLine` at all.** An existing status line is never edited or wrapped; setup prints the line to add. | The display is the user's, and a wrapper in its path could blank it. "A tracker must never break Claude Code" covers the UI too. With no status line there is no display to break: `watchtower-snapshot.sh` prints nothing. |
| 6 | **A source question is asked only for a detected source, and only when no `watchtower.config.json` exists.** Declining one writes a config holding the full default source map, with that source `enabled: false`. Yes to all writes no file. | A supplied map replaces the defaults, so a partial map would silently disable sources. An existing config belongs to the user: setup says where it is and leaves it alone. |
| 7 | **`loadConfig` falls back to the checkout's `watchtower.config.json`** when the current directory has none. The current directory still wins. | Setup writes into the checkout. Without the fallback, its answers are ignored whenever `watchtower` runs from another directory, which is the linked CLI's normal case. |
| 8 | **Backfill runs the README's three commands, in its order:** `ingest.sh --backfill`, `rollup.sh --resolve`, `watchtower sync`. | The sequence is already proven. It runs the rollup twice, which costs seconds, once. Reordering it to save one run would need its own proof. |
| 9 | **The PATH link never overwrites.** An existing `~/.local/bin/watchtower` that points elsewhere is reported and left alone. Setup never edits a shell profile: if `~/.local/bin` is not on PATH, it prints the line to add. | Files outside Watchtower's own belong to the user. |
| 10 | **`install.sh` requires `sqlite3`**, as it already requires `jq`. | Otherwise the install reports done and records nothing (§1, item 1). |

## 3. Measured on 2026-10-21 (live transcripts, read-only, into an empty scratch database)

- **Backfill:** `ingest.sh --backfill` read 1,743 transcript files (1.7 GB) in **52 s**, giving
  45,419 requests. `rollup.sh --resolve` then took **8 s** and cached 140 project paths.
  Setup therefore runs each command in the foreground, names it before it starts and passes
  its output through. No spinner and no time estimate: the time scales with the user's
  history, not ours.
- **What a backfilled database shows.** It held 95 days of `claude_daily_rollups`, all with
  tokens, plus 263 project rows, 45,419 request metrics (45,174 priced), 2,534 turns and 132
  profile days. It also held **0 events and 0 sessions**, so it had no active hours, no
  skills and no levels, and the rollup printed "Rank: Noobie (0.0h active)". This is the
  README's existing caveat: archived transcripts do not recreate hook events. Setup's closing
  message says so in one line: tokens, cost and the Usage Profile cover past history, while
  hours, levels and quests start with the first session after install.

## 4. `install.sh`

### 4.1 Flags

- **No flags:** unchanged.
- **`--status-line`:** if `settings.json` has no `statusLine` key and no snapshot writer is
  detected (§4.3), the same `jq` pass that registers the hooks also sets
  `"statusLine": {"type": "command", "command": "<CLAUDE_DIR>/watchtower-snapshot.sh"}`.
  In every other case the flag changes nothing, and the message says why.
- **`--dry-run`:** runs the pre-flight, prints to stdout the `settings.json` the install would
  write (with `--status-line`, the result with it), and exits 0. It creates no directory,
  backup, temp file or script. Messages go to stderr in this mode, so stdout is exactly the
  file. A missing `settings.json` is read as `{}`, as the real run does.
- **Any other argument:** exit 2 with a usage line, before anything is touched. Today extra
  arguments are ignored.

### 4.2 Pre-flight

`command -v sqlite3` beside the existing `jq` check: `install: sqlite3 is required`, exit 1,
before anything is written.

### 4.3 Snapshot detection and messages

Detection today greps `<CLAUDE_DIR>/statusline.sh`. It also checks whether `settings.json`'s
`.statusLine.command` contains `watchtower-snapshot.sh`. Without that check, a re-run after
`--status-line` would report "no snapshot capture found".

Today's lines are kept verbatim, and new lines are added after them:
- **A writer was found:** today's line.
- **No `statusLine`:** today's line. With `--status-line`, it is followed by
  `install: status line set to <path> (records snapshots, displays nothing)`.
- **A `statusLine` command with no writer:** today's line, followed by what to add, naming
  the command: pass its stdin JSON to `<CLAUDE_DIR>/watchtower-snapshot.sh`, for example at
  the top of a shell script, `input=$(cat); printf '%s' "$input" | <path>`, then read
  `$input` instead of stdin.

## 5. `watchtower setup`

### 5.1 Shape

`lib/setup/`, split the way `lib/read` and `lib/render` are:

- **`facts.ts` reads and writes nothing.** It gathers:
  - fresh or existing (decision 3);
  - the Claude dir (`CLAUDE_DIR`, else `capture.installDir`);
  - the database path and whether it exists;
  - which config file `loadConfig` would read, if any;
  - for each enabled source, its `detect()` result, from `adaptersFor(cfg)`;
  - which installed scripts differ from the checkout's, compared byte for byte;
  - the state of `~/.local/bin/watchtower` (absent, this checkout's, or another), and
    whether `~/.local/bin` is on PATH.

  The status-line state comes from `install.sh` itself, not from a second detector:
  `--dry-run --status-line` against `--dry-run`. If the first adds a `statusLine`, the
  question applies.
- **`plan.ts` is pure:** facts plus answers in, ordered steps out. Every default in §5.2's
  table lives here, and it is tested without running anything.
- **`run.ts`** asks the questions (`node:readline`), shows the preview, runs the steps and
  prints the closing summary. Its process runner is injected, so a test can make
  `install.sh` misbehave.

```
watchtower setup [--yes] [--status-line|--no-status-line] [--backfill|--no-backfill]
                 [--link|--no-link] [--open|--no-open] [--disable <id>[,<id>…]]
```

A flag answers its question, and that question is not asked.

### 5.2 The flow

1. **Facts.** Setup prints what it found: the Claude dir, the database (new or existing), each
   source (found where, or not found), the status line, and the scripts that will be replaced.
2. **Questions, all asked before anything is written,** so Ctrl-C leaves nothing changed. Each
   shows its default, and Enter takes it:

   | Question | Asked when | Fresh | Existing |
   |---|---|---|---|
   | Use Watchtower's capture as your status line? (records snapshots, displays nothing) | no `statusLine` (§5.1) | Y | N |
   | Track `<source>`? (one line on what it reads; for OpenViking, its `/health` request) | detected, and no config file | Y | Y |
   | Read your existing history now? | always | Y | N |
   | Put `watchtower` on your PATH (`~/.local/bin`)? | no link there | Y | N |
   | Open the dashboard when done? | always | Y | N |

3. **Preview.** Setup runs `install.sh --dry-run` with the chosen flags and shows a
   `diff -u` of the user's `settings.json` against that output, labelled with the real path,
   or `settings.json: no change`. Then it asks `Apply? [Y/n]`. A non-interactive run applies
   without asking, which is today's behaviour.
4. **Apply, in order:**
   1. `install.sh` with the chosen flags. Setup then compares `settings.json` with the
      preview; if they differ, it says so with the backup path and exits 1 before any other
      step.
   2. The config, if a source was declined (decision 6). It is written to a temp file in the
      checkout, then renamed.
   3. Backfill (decision 8). Each command is named before it runs.
   4. The link (decision 9).
   5. `watchtower open`, which honours `WATCHTOWER_BROWSER`.
5. **Closing.** One line per step done. For each step declined, the exact command to run
   later. Then §3's one line on what history the database can show yet.

A step that exits non-zero stops setup. Setup names the step and its exit code, and lists
what already happened. Every step is idempotent, so running setup again is the recovery.

### 5.3 Interactive or not

A run is interactive when stdin and stdout are both terminals and `--yes` is absent.
`WATCHTOWER_SETUP_INTERACTIVE=1` forces interactive mode, with answers read line by line from
stdin. It is the suite's seam, as `WATCHTOWER_ROLLUP_TODAY` is. A non-interactive run takes
its answers from flags; under `--yes`, any unflagged step takes §5.2's default, and without
`--yes` it is No.

### 5.4 Config fallback (`lib/config.ts`)

The default `configPath` is `./watchtower.config.json` if that file exists, else
`<checkout>/watchtower.config.json`, where the checkout is `path.resolve(import.meta.dirname,
"..")`. `opts.configPath` still wins over both, and a new `opts.checkoutDir` lets tests move
the checkout. Error messages already name the full path, so the user can tell which file was
read. The live checkout has no `watchtower.config.json` today, so nothing live changes.

## 6. Tests and proof

### 6.1 Guards

Each guard below protects a user's file or today's install. Each is planted once and must turn
exactly one test red. The remaining tests assert identities.

`install.sh`:
1. **`--dry-run` predicts the real run.** Across the existing fixture shapes (empty,
   shared group, scoped matcher, old chain, an existing `statusLine`), with and without
   `--status-line`, its stdout equals the `settings.json` a real run then writes, byte for
   byte.
2. **`--dry-run` writes nothing.** The Claude dir's file list and hashes are identical before
   and after.
3. **An existing status line is kept.** With `--status-line` and an existing `statusLine`,
   that `statusLine` is unchanged byte for byte.
4. **`--status-line` is idempotent.** A second run changes nothing and reports "existing
   snapshot capture detected".
5. **Missing `sqlite3`.** The install exits 1 with nothing written. Its PATH links every
   tool except `sqlite3`.

`watchtower setup` (each run under a temp `HOME`, `CLAUDE_DIR` and `WATCHTOWER_DB_PATH`, with a
stub `WATCHTOWER_BROWSER`):
6. **No flags, non-interactive, fresh and existing.** The Claude dir equals a direct
   `install.sh` run into a twin directory. No database file, link or config is created, and
   the browser stub is not called.
7. **Existing install, interactive, Enter to everything.** Same as 6.
8. **`--yes` on a fresh `HOME` with fixture transcripts.** `statusLine` is set, the database
   holds the fixture's requests, the link resolves to the checkout's `bin/watchtower`, and the
   stub received the dashboard URL.
9. **Declining one source.** `loadConfig` on the written file deep-equals the default source
   map except that source's `enabled`, Atlas's `projectRoots` included.
10. **An existing config.** No source question is asked, and the file is unchanged byte for
    byte.
11. **An existing link elsewhere.** It keeps its target.
12. **Preview mismatch.** With an injected runner whose `install.sh` writes something other
    than its dry run, setup exits 1 and runs no later step.
13. **Config fallback.** The current directory's file wins, and the checkout's file is read
    only when the current directory has none.

`plan.ts` gets one table-driven test over fresh/existing × interactive/`--yes`/none: §5.2's
defaults as identities, with no literals repeated elsewhere (R21).

### 6.2 Live proof (by hand)

1. **The dry-run gate** (Task 1). Seed a temp Claude dir with copies of the live
   `settings.json` and `statusline.sh`. `install.sh` from `main` and from the branch, both
   without flags, write byte-equal `settings.json`. The branch's `--dry-run` equals its real
   run.
2. **An existing user** (Task 2). `setup` against that seeded dir, with a `.backup` copy of
   the live database, once non-interactive and once with Enter to everything, gives exactly 1.
3. **A new user** (Task 2). Under an empty temp `HOME`, with `WATCHTOWER_TRANSCRIPTS_DIR`
   pointing at the live `~/.claude/projects` (ingest only reads it), run `setup --yes`. Under a
   twin temp `HOME`, run the README's manual commands. Then compare `claude_requests`, `claude_daily_rollups`, `claude_project_rollups`,
   `claude_request_metrics` and `claude_turns` with `EXCEPT` both ways, `updated_at` aside,
   and expect `0|0`, with `WATCHTOWER_ROLLUP_TODAY` pinned on both sides. Time setup from
   start to finish.

## 7. Rollout

- **0.10.0:** `package.json`, `docs/release-notes/0.10.0.md`, the history row in
  `docs/releases.md`, and README's What's new.
- **README:**
  - Quick start steps 2–4 become `./bin/watchtower setup`.
  - The manual steps stay, under "Install by hand", as the route for capture without Node.
  - Configuration says where the config is read from (§5.4).
  - Supported sources says that setup asks about each detected source.
- **CLAUDE.md:** the commands list gains `watchtower setup`. The install bullets name
  `--dry-run` as a user-facing preview. The developer's dry-run gate is unchanged.
- **Live:** the user runs `./bin/watchtower setup`. It is an existing install, so the
  defaults give today's install, and the preview should read `settings.json: no change`. Hand
  over the `!` command.

## 8. Task shape

Three tasks, then one whole-branch review with at most one fix round.

1. **`install.sh` and the config fallback:** §4, §5.4, guards 1–5 and 13, and proof 6.2.1
   on the seeded live config, all in this task.
2. **`watchtower setup`:** §5, the CLI wiring and usage line, guards 6–12 and the plan
   table, then proofs 6.2.2 and 6.2.3.
3. **Docs and 0.10.0:** §7, plus the README and release-tooling tests that pin them.

## 9. Not in this stage

- **Piece 2, opt-in launchd sync**, out by the 2026-10-21 scope decision. Its gate (§5's
  steady-state sync measurement) was taken before sync learned to skip unchanged records,
  so it should be re-measured before that piece is reconsidered.
- **Piece 3, the TUI launcher.**
- Wrapping or editing an existing status line, editing shell profiles, an uninstall command,
  systemd units and Windows.
- The personal defaults in `lib/config.ts` (`excludePaths` and the like). Backlog
  before-launch step 3 decides those.

## 10. Review focus

- **Decision 1** moves the questions out of `install.sh`, against §6's text.
- **Decision 3** keys the defaults on fresh versus existing. Is "capture's lib is installed"
  the right test?
- **Decision 7** changes which config file a run outside the checkout reads. Today it reads
  none.
- **§3:** is one closing line enough warning that a new user's first dashboard has no hours?
