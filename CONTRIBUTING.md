# Contributing to Agent Watchtower

Watchtower is a passive observer of Claude Code usage. Read [CLAUDE.md](CLAUDE.md) before changing anything under `capture/` or `lib/`: it lists the invariants that silently corrupt data when broken. The most important are that the activity model and every price live in `capture/rollup.sh` alone, and that nothing slow runs in the foreground of a hook.

## Set up

You need macOS or Linux, Node 22.18 or later, `sqlite3` and `jq`.

```sh
git clone https://github.com/RaDeleon/Agent-Watchtower.git
cd Agent-Watchtower
npm ci
git config core.hooksPath .githooks   # once per checkout: the secret and privacy checks
```

## Test

```sh
npm test -- --exclude '.claude/**'
npm run typecheck
npm run lint                          # pinned ShellCheck
npx vitest run tests/ingest.test.ts   # one file
```

The suite runs the real shell scripts against fixture databases. Run one whole suite at a time, because two at once time out.

- **Never test against your live database.** Copy it with `sqlite3 ~/.watchtower/watchtower.sqlite ".backup /tmp/wt/copy.sqlite"` (it uses WAL, so do not `cp` it) and point `WATCHTOWER_DB_PATH` at the copy. Give each copy its own directory, because the schema marker lives beside the database.
- **Preview an install** with `bash capture/install.sh --dry-run`, or with `CLAUDE_DIR` set to a temporary directory before running `capture/install.sh` for real.
- **A new guard is not done until you have planted its defect** and watched exactly one test fail.

## Pull requests

1. Branch from `main`, for example `stage-10-attributes`, `fix/<topic>` or `chore/<topic>`.
2. If the change adds a feature, update the README in the same pull request: its feature list, the Dashboard table, the table list and, with a version bump, What's new. `tests/readme.test.ts` fails when a page, a table or the current version is missing.
3. Open a pull request. Nothing runs on GitHub, so run the typecheck, the tests and the lint locally before you ask for a merge.
4. Merges are squash-only. The pull request's title and body become the commit on `main`, so write them as the commit message.

Do not add AI attribution, such as `Co-Authored-By` trailers or "Generated with" lines, to commits or pull request text.

## Keep personal details out

This is a public repository about one person's usage, so it is easy to leak details by accident. The pre-commit hook enforces these rules:

- **Paths:** write `~/.claude`, `$HOME/.theone` or a path relative to the repository. Where an absolute path is needed, use a placeholder user such as `/Users/you`.
- **Names:** do not name clients, employers or private projects, and do not quote hours or costs tied to them. Refer to them generically.
- **Ids and email:** do not paste real request ids, session ids or email addresses. Commit with your GitHub noreply address.
- **Private notes:** keep them in `SESSION.md`, under `.private/`, or, for agent build logs, under `.superpowers/`. All three are gitignored and refused by name.
- **Your own terms:** list names that must never appear in `.git/info/private-terms`, one per line. The file lives inside `.git`, so it is never committed, and the staged check refuses any line that contains one.

```sh
node script/check-privacy.ts --staged   # what the hook runs
node script/check-privacy.ts --tree     # every tracked file
```

The checks report the file, line and rule, never the matched text. [Secret checks](docs/secret-checks.md) covers credentials and data files.

## Releases

Each stage that ships bumps the minor version and is released from a `v*` tag on `main`. [Releasing](docs/releases.md) has the steps.
