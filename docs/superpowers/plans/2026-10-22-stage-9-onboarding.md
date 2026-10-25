# Stage 9 — Onboarding (`watchtower setup`): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command, `./bin/watchtower setup`, takes a user from a checkout to an open dashboard. It checks requirements, asks a few questions, previews the exact `settings.json` change, then installs capture, optionally wires the status line, backfills history, links the CLI and opens the dashboard. An existing user who presses Enter throughout gets exactly today's install.

**Architecture:** `install.sh` stays the only writer under the Claude dir. It gains `--status-line`, `--dry-run`, a `sqlite3` pre-flight and better snapshot detection, and with no flags it behaves exactly as today. A new `lib/setup/` (facts → plan → run, split the way `lib/read` and `lib/render` are) asks the questions in Node, drives `install.sh` and the existing backfill commands, and writes the only other files: an optional `watchtower.config.json` in the checkout and the `~/.local/bin` link. `loadConfig` falls back to the checkout's config when the current directory has none.

**Tech Stack:** bash + jq (`capture/install.sh`), TypeScript run natively by Node 22.18+ (`lib/`, `bin/watchtower`, no build, no runtime deps), vitest.

**Spec:** `docs/superpowers/specs/2026-10-21-stage-9-onboarding-design.md`. Read it before your task. This plan argues from it, and every § below refers to it.

## Global Constraints

- No schema or model change: `CC_SCHEMA_VERSION` stays **11**, `WT_SCHEMA_VERSION` stays **3**. `capture/rollup.sh`, `lib.sh`, `hook.sh`, `ingest.sh` and `snapshot.sh` are not edited.
- `install.sh` with no arguments writes exactly what it writes on `main`. **No existing test in `tests/install.test.ts` has its expectations edited.** New tests are added in new `describe` blocks.
- Every write under the Claude dir goes through `install.sh`. `lib/setup/` writes only `<checkout>/watchtower.config.json`, the `~/.local/bin/watchtower` symlink and its own temp preview file under `os.tmpdir()`.
- A non-interactive `setup` with no flags runs the install only, fresh or existing (spec decision 4).
- Tests never touch `~/.claude`, `~/.theone`, `~/.local/bin` or the real checkout's `watchtower.config.json`. Every `setup` test runs a **temp copy of the checkout** (`bin/`, `lib/`, `capture/`, `package.json`) under a temp `HOME`, with `CLAUDE_DIR=$HOME/.claude`, `WATCHTOWER_DB_PATH` under `$HOME`, `WATCHTOWER_BROWSER` set to a stub script that appends its argument to a file, and `WATCHTOWER_DASHBOARD_PORT` set to a free port.
- Zero runtime dependencies: `node:` built-ins only, plus the system `diff`. `lib/setup/*.ts` import with relative `.ts` paths, never the `@/` alias, because `bin/watchtower` imports them.
- Exact copy, as the spec fixes it:
  - `install: sqlite3 is required`
  - `install: status line set to <path> (records snapshots, displays nothing)`
  - `settings.json: no change`
  - the closing line (P8): `Tokens, cost and the Usage Profile cover your past history. Active hours, levels and quests start with your next Claude Code session.`
- R21: each guard's literal values live in exactly one test. A guard is done only when its plant turns **exactly one** test red. Record each plant and the test it reddened in `.superpowers/sdd/2026-10-22-stage-9-onboarding/progress.md`. Plant only the guards §6.1 lists, since they protect a user's file or today's install. Keep ledger entries short.
- Suite: `CI=1 npx vitest run --exclude '.claude/**'`. Never run two whole suites at once. Also `npm run typecheck`, `npm run lint`, `node script/check-privacy.ts --tree`.
- Public-repo hygiene (CLAUDE.md): nothing committed may contain a home path, a real name, a real id or a live cost figure. Commits carry no AI attribution.
- The SDD scripts overwrite `.superpowers/sdd/.gitignore`: restore it after each script call, and commit the ledger.

## Rulings made while planning (do not re-ask)

- **P1 — answers in forced-interactive mode.** With `WATCHTOWER_SETUP_INTERACTIVE=1`, the asker reads stdin to its end once, then takes one line per question and echoes the question and the answer. `readline` loses piped lines that arrive before a question is asked, so it is used only on a real TTY. If stdin runs out mid-questions, setup exits 1 with nothing written.
- **P2 — each question carries two values,** `def` (shown, taken by Enter and by `--yes`) and `today` (taken by a non-interactive run without `--yes`). `today` is false for status line, backfill, link and open, and true for each source. On an existing install, `def === today` for every question: that is the spec's core guarantee, and the plan test pins it as an identity.
- **P3 — the Claude dir and child environments.** The Claude dir is `env.CLAUDE_DIR`, else `cfg.capture.installDir`. Every child gets `CLAUDE_DIR=<dir>` and `CC_LIB_PATH=<dir>/cc-track-lib.sh`. `watchtower sync` also gets `WATCHTOWER_ROLLUP_PATH=<dir>/claude-usage-rollup.sh`. Everything else in the environment passes through, so the proof's `WATCHTOWER_TRANSCRIPTS_DIR` reaches ingest. Fresh means `<dir>/cc-track-lib.sh` does not exist.
- **P4 — status-line applicability comes from `install.sh`.** Facts runs `install.sh --dry-run` and `install.sh --dry-run --status-line`. The question applies iff the two outputs differ, and the chosen output is the preview, so no third run is needed.
- **P5 — the written config.** When a source is declined, the file is `{"sources": {...}}` with all five ids, each `{ "enabled", "type" }`; openviking adds `"baseUrl": "http://127.0.0.1:1933"` and atlas `"projectRoots": ["~/Developer"]`. It has no `driven`/`automated` lists, so `entryLists` keeps falling back to the shipped defaults, and later default updates still reach the user. It is written as 2-space JSON plus a newline, to a temp file in the checkout, then renamed.
- **P6 — `loadConfig` gains `cwd?` and `checkoutDir?`.** A new `configFileFor(cwd, checkoutDir): string | null` returns the file `loadConfig` reads by default, and facts reuses it.
- **P7 — exit codes.** 0 success; 1 a step failed, the preview mismatched, stdin ended mid-questions, or `settings.json` is invalid; 2 a usage error (unknown flag; `--disable` with an unknown id, or with a config file already present).
- **P8 — the closing history line** is printed on a fresh install only, whether or not backfill ran. Existing users already have hours.
- **P9 — status-line states in `install.sh`.** `writer` (statusline.sh greps as today, or `.statusLine.command` contains `watchtower-snapshot.sh`) · `none` (no `.statusLine` key) · `other` (a `.statusLine` key, no writer). `--status-line` adds one only in `none`.
- **P10 — the missing-`sqlite3` test** builds a PATH directory of symlinks to every executable on the current PATH except `sqlite3` (first one wins), so `bash`, `jq` and the core utilities resolve and only `sqlite3` is gone.

## Review Focus

1. **No Claude dir yet** (a machine where `~/.claude` does not exist). `--dry-run` prints the hooks over `{}` and creates nothing, and the real run creates the directory. Test: Task 1, "--dry-run writes nothing, into a seeded or a missing directory".
2. **`settings.json` is not valid JSON.** `--dry-run` exits non-zero with nothing on stdout. Setup stops before any question, says which file, and writes nothing. Tests: Task 1, "dry-run refuses invalid JSON"; Task 2, "invalid settings.json stops setup before any question".
3. **Stdin ends mid-questions** (Ctrl-D, or a script that pipes too few answers). Setup exits 1 with nothing written. Test: Task 2, "stdin ending mid-questions writes nothing".
4. **Running setup twice.** The second run is "existing": the preview reads `settings.json: no change`, the link reads as this checkout's and is not asked about, and nothing new is written. Test: Task 2, "a second setup --yes changes nothing".
5. **Setup run from another directory, through the PATH link.** The config lands in the checkout, and a later `watchtower` run from `$HOME` reads it through the fallback. Test: Task 2, "a config written by setup is read from another directory".

---

### Task 1: `install.sh` flags and the config fallback

**Model:** opus. The `settings.json` merge has already shipped two hook-deletion bugs, and `--dry-run` must predict it byte for byte.

**Files:**
- Modify: `capture/install.sh`
- Modify: `lib/config.ts` (`loadConfig` options, new `configFileFor`)
- Test: `tests/install.test.ts` (new `describe("install.sh flags")`, existing blocks untouched), `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `install.sh [--status-line] [--dry-run]`. `--dry-run` prints the would-be `settings.json` on stdout, sends messages to stderr, and writes nothing. Any other argument exits 2 with `usage: install.sh [--status-line] [--dry-run]` on stderr.
  - `configFileFor(cwd: string, checkoutDir: string): string | null`, exported from `lib/config.ts`.
  - `loadConfig(opts: { configPath?; env?; fileExists?; cwd?: string; checkoutDir?: string })`. `cwd` defaults to `process.cwd()`. `checkoutDir` defaults to `path.resolve(import.meta.dirname, "..")`.

- [ ] **Step 1: Write the failing install tests** in a new `describe("install.sh flags")` with a helper `runArgs(dir, args, env?) → { status, stdout, stderr }` (stdio piped, never throwing):
  - `"--dry-run predicts the real run, byte for byte"` (guard 1): for each seed in `{}`, a shared PostCompact group, a scoped matcher, the previous SessionEnd chain, and `{ statusLine: { type: "command", command: "/x/line.sh", padding: 2 } }`, and for each of `[]` and `["--status-line"]`: seed a fresh dir, take `runArgs(d, ["--dry-run", ...flags]).stdout`, then real-run `runArgs(d, flags)`, and `expect(readFileSync(d/settings.json, "utf8")).toBe(dryStdout)`.
  - `"--dry-run writes nothing, into a seeded or a missing directory"` (guard 2, and Review Focus 1):
    - Seeded dir: status 0, and its entry list (files and directories) with each file's sha256 is equal before and after.
    - Missing dir: `CLAUDE_DIR` names a path that does not exist. Status 0, stdout parses to an object whose `hooks` has all eight events, and the path still does not exist afterwards.
  - `"dry-run refuses invalid JSON"` (Review Focus 2): with `settings.json` = `{not json`, status ≠ 0 and stdout `""`.
  - `"--status-line adds the snapshot script when there is no status line"`: on `{}`, `settings(d).statusLine` deep-equals `{ type: "command", command: \`${d}/watchtower-snapshot.sh\` }`, and stdout contains `install: status line set to ${d}/watchtower-snapshot.sh (records snapshots, displays nothing)`.
  - `"--status-line never edits an existing status line"` (guard 3): with the `/x/line.sh` seed, `JSON.stringify(settings(d).statusLine)` equals the seed's, and stdout contains `/x/line.sh` and `watchtower-snapshot.sh`.
  - `"--status-line is idempotent"` (guard 4): two runs on `{}`, `settings.json` text equal after each, and the second stdout contains `existing snapshot capture detected`.
  - `"refuses to install without sqlite3"` (guard 5): PATH built as P10. Expect status 1, stderr contains `install: sqlite3 is required`, and neither `settings.json` nor `cc-track-lib.sh` exists.
  - `"rejects an unknown argument before writing"`: `--frobnicate` gives status 2, stderr contains `usage: install.sh`, and nothing is created in the dir.

- [ ] **Step 2: Run them, expect red.** Run `npx vitest run tests/install.test.ts`. The new tests fail; the existing ones pass.

- [ ] **Step 3: Implement in `capture/install.sh`.**
  - Parse arguments first, then add `command -v sqlite3` beside the `jq` check.
  - Compute the snapshot state (P9) before section 1, from the current `settings.json` (or `{}`) and `statusline.sh`.
  - Extract the `jq` merge into a function that reads a settings file and prints the merged JSON. It gains `--argjson addStatusLine <true|false>` and `--arg snapshot "$CLAUDE_DIR/watchtower-snapshot.sh"`. When `$addStatusLine` is set and `.statusLine == null`, it sets `.statusLine = {type: "command", command: $snapshot}`. Pass `true` only for `--status-line` in state `none`.
  - Under `--dry-run`, after the pre-flight, print that function's output on `settings.json` (or on `{}`, without creating it) and `exit 0`, before `mkdir`, backups or copies. Send the section 3 messages to stderr.
  - Keep every existing `echo` line verbatim. Append the new lines (spec §4.3) after them.

- [ ] **Step 4: Run `tests/install.test.ts`, expect green,** including every pre-existing test.

- [ ] **Step 5: Write the failing config test** `"reads the current directory's config, else the checkout's"` (guard 13) in `tests/config.test.ts`, with temp `cwd` and `checkout` dirs and `env: {}`:
  - With neither file, `configFileFor` is `null` and `loadConfig({ cwd, checkoutDir })` deep-equals `loadConfig({ configPath: "/nonexistent", env: {} })`.
  - With only the checkout file (`{"dashboard":{"port":4400}}`), the port is 4400.
  - With both, the cwd file (`port 4500`) wins.
  - `configFileFor` returns the path each time.

- [ ] **Step 6: Implement `configFileFor` and the two options in `lib/config.ts`.** Update the `loadConfig` doc comment's precedence list.

- [ ] **Step 7: Run `tests/config.test.ts`, then typecheck.** Expect green.

- [ ] **Step 8: Plant guards 1–5 and 13, one at a time.** Each must turn exactly one test red; revert each plant. The plants:
  1. `--dry-run` prints the merge without the `addStatusLine` argument.
  2. `mkdir -p "$HOOKS_DIR" "$BACKUP_DIR"` moved above the `--dry-run` exit.
  3. Add the status line whenever the flag is given.
  4. Drop the `.statusLine.command` detection.
  5. Drop the `sqlite3` check.
  6. Check the checkout's file before the cwd's.

  Log each in the ledger.

- [ ] **Step 9: Proof 6.2.1, by hand, in a scratch dir.**
  1. Seed `gate/main/` and `gate/branch/` with copies of the live `~/.claude/settings.json` and `statusline.sh`.
  2. Run `main`'s `install.sh` (`git show main:capture/install.sh` into the scratch dir, beside copies of `main`'s other capture scripts) with `CLAUDE_DIR=gate/main`, and the branch's with `CLAUDE_DIR=gate/branch`.
  3. Expect `diff <(sed "s#$G/main#X#g" gate/main/settings.json) <(sed "s#$G/branch#X#g" gate/branch/settings.json)` to be empty.
  4. Expect the branch's `--dry-run` on a fresh seeded copy to equal its real run.

  Record the result in the ledger, without paths.

- [ ] **Step 10: Commit.**

```bash
git add capture/install.sh lib/config.ts tests/install.test.ts tests/config.test.ts .superpowers/sdd/2026-10-22-stage-9-onboarding/
git commit -m "feat(install): --dry-run, --status-line and a sqlite3 pre-flight; config falls back to the checkout"
```

---

### Task 2: `watchtower setup`

**Model:** opus. It spans several files, and its defaults decide whether an existing user's install changes.

**Files:**
- Create: `lib/setup/facts.ts`, `lib/setup/plan.ts`, `lib/setup/run.ts`
- Modify: `bin/watchtower` (the `setup` dispatch and a `USAGE` line)
- Test: `tests/setup-plan.test.ts` (pure), `tests/setup.test.ts` (subprocess, in temp checkouts), `tests/helpers/setup-sandbox.ts`

**Interfaces:**
- Consumes (Task 1): `install.sh --dry-run`, `--status-line`; `configFileFor`; `loadConfig({ cwd, checkoutDir, env })`.
- Produces:
  - `plan.ts`:
    - `type QuestionKey = "statusLine" | "backfill" | "link" | "open" | \`source:${string}\``
    - `interface Question { key: QuestionKey; text: string; def: boolean; today: boolean }`
    - `interface Flags { yes: boolean; statusLine?: boolean; backfill?: boolean; link?: boolean; open?: boolean; disable?: string[] }`
    - `interface Choices { statusLine: boolean; disable: string[]; backfill: boolean; link: boolean; open: boolean }`
    - `type Step = { kind: "install"; statusLine: boolean } | { kind: "config"; disable: string[] } | { kind: "backfill" } | { kind: "link" } | { kind: "open" }`
    - `parseFlags(argv: string[]): Flags | { error: string }`
    - `questionsFor(f: SetupFacts, flags: Flags): Question[]` (applicable and unflagged only, in §5.2's order)
    - `choose(f: SetupFacts, flags: Flags, mode: "interactive" | "yes" | "none", answers: Map<QuestionKey, boolean>): Choices`
    - `stepsFor(c: Choices): Step[]` (install first, then config, backfill, link, open, each only when chosen)
    - `sourcesConfig(disable: string[]): string` (P5)
  - `facts.ts`:
    - `interface SetupFacts { fresh: boolean; claudeDir: string; checkout: string; db: { path: string; exists: boolean }; configFile: string | null; sources: { id: string; label: string; detected: boolean; detail?: string }[]; statusLineOffered: boolean; settingsPath: string; settingsNow: string | null; preview: { plain: string; withStatusLine: string }; scripts: { src: string; dest: string; state: "new" | "changed" | "same" }[]; link: { path: string; state: "absent" | "ours" | "other"; target?: string; onPath: boolean } }`
    - `gatherFacts(o: { env: NodeJS.ProcessEnv; cwd: string; checkout: string; runner: Runner }): Promise<SetupFacts | { error: string }>`
    - `type Runner = (cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; capture: boolean }) => { status: number; stdout: string; stderr: string }` (`capture: false` inherits stdio)
  - `run.ts`:
    - `interface Asker { ask(q: Question): Promise<boolean | null> }` (`null` means input ended)
    - `runSetup(argv: string[], env: NodeJS.ProcessEnv, io?: { out?: (s: string) => void; asker?: Asker; runner?: Runner; cwd?: string; checkout?: string }): Promise<number>`. `checkout` defaults to `path.resolve(import.meta.dirname, "../..")`. In-process tests pass a sandbox checkout, so nothing can reach the real repo.

- [ ] **Step 1: Write `tests/setup-plan.test.ts`,** building facts with a local `facts(overrides)` helper:
  - `"every default on an existing install is today's behaviour"`: for every question from `questionsFor(existingFacts, noFlags)`, `q.def === q.today`. Also `choose(existing, {yes:true}, "yes", new Map())` deep-equals `choose(existing, {yes:false}, "none", new Map())`.
  - `"a fresh install defaults to the recommended steps"`: on fresh facts with no status line, an absent link and Codex detected, the `def` values are `statusLine true, source:codex true, backfill true, link true, open true` in that order. This is the one place these literals live.
  - `"non-interactive without --yes runs the install only"`: on fresh and existing facts, `stepsFor(choose(f, {yes:false}, "none", new Map()))` deep-equals `[{ kind: "install", statusLine: false }]`.
  - `"a flag answers its question"`: `parseFlags(["--no-backfill"])` removes the backfill question, and `choose(..., "yes", ...)` gives `backfill: false`.
  - `"questions apply only when they can"`: no status-line question when `statusLineOffered` is false; no link question when the link state is `ours` or `other`; no source questions when `configFile` is set or nothing is detected.
  - `"usage errors"`: `parseFlags(["--frobnicate"])` and `["--disable", "nope"]` return `{ error }`.
  - `"a declined source keeps every other default"`: write `sourcesConfig(["codex"])` to a temp file. For each id in `loadConfig({ configPath, env: {} })`, compare `enabled` (false only for codex), `type`, `baseUrl`, `projectRoots` and `entryLists(id, …)` (for codex and hermes) with `loadConfig({ configPath: "/nonexistent", env: {} })`. This is guard 9.

- [ ] **Step 2: Run it, expect red** (the module is missing).

- [ ] **Step 3: Implement `lib/setup/plan.ts`.** Question text is one line each:
  - status line: `Use Watchtower's capture as your status line? It records snapshots and displays nothing.`
  - source: `Track <label>? It <what it reads>.`, where codex reads `rollout files under ~/.codex, counts only`; hermes reads `~/.hermes/state.db, read-only`; openviking `local counters, and requests /health from <baseUrl>`; atlas `checkpoints under <roots>`.
  - backfill: `Read your existing history now?`
  - link: `Put watchtower on your PATH (~/.local/bin)?`
  - open: `Open the dashboard when done?`

- [ ] **Step 4: Run `tests/setup-plan.test.ts`, expect green.**

- [ ] **Step 5: Write `tests/helpers/setup-sandbox.ts` and `tests/setup.test.ts`.**
  - `sandbox()`:
    - copies `bin/`, `lib/`, `capture/` and `package.json` into a temp checkout once per file (`beforeAll`);
    - per test, makes a temp `HOME` with `.claude/` and a stub browser script;
    - returns `{ checkout, home, claudeDir, db, env, browserLog, port }`;
    - provides `setup(args, { input?, cwd? }) → { status, stdout, stderr }`, which runs `node <checkout>/bin/watchtower setup …` with stdin piped from `input` and `WATCHTOWER_SETUP_INTERACTIVE=1` whenever `input` is given.
  - `afterEach` runs `watchtower stop --port <port>` in each sandbox that opened.

  Tests:
  - `"non-interactive without flags is today's install"` (guard 6): fresh and existing (existing = `install.sh` already run into `claudeDir`). Compare against a twin dir where `install.sh` ran directly.
    - `settings.json` is byte-equal once each dir's own path is replaced with `X`, and the five installed scripts are byte-equal.
    - No DB file, no `$HOME/.local/bin/watchtower`, no `<checkout>/watchtower.config.json`, and `browserLog` is absent.
  - `"Enter through every question on an existing install is today's install"` (guard 7): `input` = `"\n".repeat(10)` (spare lines go unread), with the same assertions as guard 6.
  - `"--yes on a fresh home sets everything up"` (guard 8): transcripts come from `make-transcripts.sh single <home>/.claude/projects`.
    - `statusLine.command` is `${claudeDir}/watchtower-snapshot.sh`.
    - `SELECT COUNT(*) FROM claude_requests` on `db` is > 0.
    - `realpathSync(home/.local/bin/watchtower)` equals `realpathSync(<checkout>/bin/watchtower)`.
    - `browserLog` contains `http://127.0.0.1:${port}/`.
    - stdout contains the P8 closing line.
  - `"an existing config is left alone"` (guard 10): write `{"dashboard":{"port":4400}}` into the checkout. Interactive with Codex detected (a non-empty `$HOME/.codex/sessions`): no `Track` question appears in stdout, and the file is byte-unchanged.
  - `"an existing link elsewhere keeps its target"` (guard 11): `$HOME/.local/bin/watchtower` → `/bin/echo`. After `--yes`, `readlinkSync` is still `/bin/echo`, and stdout names it.
  - `"a preview mismatch stops setup"` (guard 12): in-process `runSetup(["--yes"], env, { checkout, runner, out })` with a `runner` that passes everything through except a real `install.sh` run. That run writes `{}` to `settings.json` and returns 0. Expect `1`, no ingest, link or open call recorded by the runner, and `out` names the backup dir.
  - `"a failing step stops setup and says which"`: the same harness, with a `runner` that returns status 3 for `watchtower-ingest.sh`. Expect `1`, and `out` names the backfill step and exit code 3 and lists the install as done. No link or open call is recorded.
  - `"invalid settings.json stops setup before any question"` (Review Focus 2): with `{not json`, the status is 1, stdout has no `?`, stderr names the settings path, and the file is unchanged.
  - `"stdin ending mid-questions writes nothing"` (Review Focus 3): fresh, with `input` `"\n"` (one answer). The status is 1, `settings.json` does not exist, and no scripts were installed.
  - `"a second setup --yes changes nothing"` (Review Focus 4): two `--yes` runs on a fresh home. The second stdout contains `settings.json: no change`. Across the second run, `settings.json`'s text, the five installed scripts and the link's target are unchanged, and no config file appears.
  - `"a config written by setup is read from another directory"` (Review Focus 5): run `--disable codex --no-backfill --no-link --no-open` with `cwd: home`. Then `node <checkout>/bin/watchtower sync --no-rollup` with `cwd: home` prints JSON whose `sources` has no `codex` entry.

- [ ] **Step 6: Run `tests/setup.test.ts`, expect red.**

- [ ] **Step 7: Implement `lib/setup/facts.ts`, `lib/setup/run.ts` and the dispatch.**
  - **Facts:**
    - `adaptersFor(loadConfig({ cwd, checkoutDir: checkout, env }), { home })` with each `detect()`, skipping `claude`.
    - The two dry runs (P4). A dry run that exits non-zero becomes `{ error: "<settingsPath> is not valid JSON: <stderr's last line>" }`.
    - The scripts: `lib.sh`, `hook.sh`, `rollup.sh`, `snapshot.sh` and `ingest.sh` map to `cc-track-lib.sh`, `hooks/cc-track-hook.sh`, `claude-usage-rollup.sh`, `watchtower-snapshot.sh` and `watchtower-ingest.sh`, compared byte for byte.
    - The link state via `lstat`/`realpath`, and `onPath` from `env.PATH`.
  - **Run:**
    - Print the facts, then the questions (P1/P2), then the preview: `diff -u --label <settingsPath> --label "<settingsPath> (after setup)"` against a temp file holding the chosen dry run, or `settings.json: no change`. Then `Apply? [Y/n]` when interactive.
    - The steps (P3), and the closing lines. For each declined step, its exact command:
      - backfill: `<claudeDir>/watchtower-ingest.sh --backfill && <claudeDir>/claude-usage-rollup.sh --resolve && <checkout>/bin/watchtower sync`
      - link: `mkdir -p ~/.local/bin && ln -s <checkout>/bin/watchtower ~/.local/bin/watchtower`
      - open: `<checkout>/bin/watchtower`
    - When the link exists but `onPath` is false, print `export PATH="$HOME/.local/bin:$PATH"`.
    - The open step runs `process.execPath [<checkout>/bin/watchtower, "open"]`.
  - **Dispatch:** in `bin/watchtower`, `if (cmd === "setup") { const { runSetup } = await import("../lib/setup/run.ts"); process.exit(await runSetup(argv.slice(1), process.env)); }`. Add the usage line `watchtower setup [--yes] [--[no-]status-line|backfill|link|open] [--disable <id,…>]   install capture and set up, asking first`.

- [ ] **Step 8: Run `tests/setup-plan.test.ts` and `tests/setup.test.ts`, then typecheck.** Expect green.

- [ ] **Step 9: Plant guards 6–12, one at a time.** Each must turn exactly one test red; revert each plant. The plants:
  1. `run.ts` maps a non-interactive run without `--yes` to mode `"yes"`.
  2. The asker maps an empty line to `true` instead of the question's `def`.
  3. `--yes` skips the link.
  4. `sourcesConfig` omits atlas's `projectRoots`.
  5. Facts sets `configFile` from `configFileFor(cwd, cwd)`, the wrong checkout.
  6. The link step unlinks an existing path, then symlinks.
  7. The post-install comparison is dropped.

  The plants sit in `run.ts` and `facts.ts` on purpose. A plant in `plan.ts`'s defaults would also turn the plan test's identities red. Log each in the ledger.

- [ ] **Step 10: Proofs 6.2.2 and 6.2.3, by hand, in the scratch dir.**
  - **6.2.2:** run `setup` against Task 1's seeded dir with a `.backup` copy of the live DB (its own directory), once with `</dev/null` and once with `WATCHTOWER_SETUP_INTERACTIVE=1` and only newlines. Each time, `settings.json` must equal the gate's branch result, and no link or config may be written.
  - **6.2.3:** take two empty temp `HOME`s with `WATCHTOWER_TRANSCRIPTS_DIR` pointing at the live `~/.claude/projects` and `WATCHTOWER_ROLLUP_TODAY` pinned. Run `setup --yes --no-open --no-link` in one, and the README's three commands in the other.
    - Compare `claude_requests`, `claude_daily_rollups`, `claude_project_rollups`, `claude_request_metrics` and `claude_turns` with `EXCEPT` both ways (`updated_at` aside), and expect `0|0` for each.
    - Time setup from start to finish.

  Record the counts and times in the ledger, with no paths.

- [ ] **Step 11: Run the whole suite once** (`CI=1 npx vitest run --exclude '.claude/**'`), then `npm run lint` and the privacy check. Commit.

```bash
git add lib/setup bin/watchtower tests/setup-plan.test.ts tests/setup.test.ts tests/helpers/setup-sandbox.ts .superpowers/sdd/2026-10-22-stage-9-onboarding/
git commit -m "feat(setup): watchtower setup, one guided command from checkout to dashboard"
```

---

### Task 3: Docs and 0.10.0

**Model:** sonnet. The work is prose and release files, pinned by existing tests.

**Files:**
- Modify: `README.md`, `CLAUDE.md`, `CONTRIBUTING.md` (if it quotes the install steps), `package.json`, `docs/releases.md`, `docs/backlog.md`
- Create: `docs/release-notes/0.10.0.md`

**Interfaces:**
- Consumes: the `setup` usage line and the flags from Task 2; the `install.sh` flags from Task 1.

- [ ] **Step 1: README.**
  - Quick start: steps 2–4 become one step, `./bin/watchtower setup`. It gets three lines on what it asks and that Enter keeps an existing install as it is.
  - The current steps 2–4 move, verbatim, under a `<details>` titled "Install by hand (also the route without Node)". Step 2's preview mentions `bash capture/install.sh --dry-run`.
  - Configuration: the file is read from the current directory, else from the checkout (§5.4).
  - Supported sources: setup asks about each detected source.
  - What's new: a 0.10.0 row.
  - Audit the words, not only the names that `tests/readme.test.ts` checks.
- [ ] **Step 2: CLAUDE.md.**
  - The commands block gains `watchtower setup [--yes]`.
  - The `install.sh` row in the architecture table mentions `--dry-run` and `--status-line`.
  - Update the suite count to the number Task 2's whole-suite run printed.
- [ ] **Step 3: Release files.** Bump `package.json` to `0.10.0`, write `docs/release-notes/0.10.0.md` (what setup does, the two `install.sh` flags, the `sqlite3` requirement, the config fallback, and §3's note on backfilled history), and add the history row in `docs/releases.md`, dated when tagged. Follow `docs/releases.md`'s checklist.
- [ ] **Step 4: Backlog.** In `docs/backlog.md`, under before-launch step 1, record that Stage 9 shipped as onboarding only, and that pieces 2 and 3 are dropped from the 1.0 path.
- [ ] **Step 5: Verify.** Run `npx vitest run tests/readme.test.ts tests/release-tooling.test.ts tests/brand.test.ts`, then typecheck and the privacy check. Expect green.
- [ ] **Step 6: Commit.**

```bash
git add README.md CLAUDE.md CONTRIBUTING.md package.json docs/
git commit -m "docs: watchtower setup in the README, and 0.10.0"
```

---

### After the tasks

- One whole-branch review (`git diff main...HEAD`) with at most one fix round, aimed at the spec's §10 and this plan's Review Focus.
- Merge `main` into the branch (#33 and #34 may have landed), then run the whole suite once.
- Open the PR. Hand over `! gh pr merge <n> --squash --delete-branch`, then the live run, `! ./bin/watchtower setup`. Expect `settings.json: no change` and Enter throughout.
