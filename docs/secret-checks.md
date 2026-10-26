# Checking commits for secrets

`script/check-secrets.ts` runs Gitleaks 8.30.1 locally and fully redacts its findings.
- **First run:** it downloads the official scanner archive and checks it against a pinned SHA-256.
- **Later runs:** they check the cached copy in the ignored `.tools/` directory and reuse it.
- **Every run:** it extracts the binary afresh from the checked archive and deletes it afterwards.

Neither source nor credentials are uploaded to a scanning service. It supports macOS and Linux on arm64 and x86-64.

```sh
node script/check-secrets.ts --staged    # what a commit would add
node script/check-secrets.ts --history   # every locally available ref
```

**Staged mode** first rejects files that must never be committed, by name and before reading any content. It applies even to files force-added past `.gitignore`:
- usage databases (`*.sqlite`, `*.db` and their WAL files) and the `.schema-v*` markers;
- transcripts and other `*.jsonl` or `*.ndjson`, and logs;
- live configuration (`settings.json`, `settings.local.json`, Codex's `auth.json`, `ovcli.conf`, `watchtower.config.json`, and `.env` files other than `.env.example`);
- key files;
- local agent state directories (`.claude/`, `.codex/`, `.hermes/`, `.watchtower/`, `.openviking/`, `.atlas/`).

The rules are in `script/artifact-policy.ts`. `watchtower.config.example.json` and `.env.example` remain allowed as templates. Watchtower's real data lives outside the repository, in `~/.watchtower/watchtower.sqlite` and `~/.claude/projects/`. These rules stop a copy of it from being committed by accident.

**History mode** scans the patches of every local ref. Run `git fetch --all` first so that every branch is covered. To include the pull-request heads GitHub keeps (they stay reachable after a branch is deleted), run `git fetch origin '+refs/pull/*/head:refs/pr-audit/*'` and delete those refs afterwards.

Private notes are refused by name too: `SESSION.md`, anything under `.private/` and the build logs under `.superpowers/`.

## Personal details

`script/check-privacy.ts` covers what a secret scanner does not. It flags:

- paths inside a real home directory, such as `/Users/<name>`, `/home/<name>` or Claude Code's `-Users-<name>-` folder form. Placeholder users such as `you` are allowed;
- the committer's own email address, unless it is a GitHub noreply address (staged mode only);
- any term listed in the local file `.git/info/private-terms`, one per line and case-insensitive. The file lives inside `.git` and is never committed.

```sh
node script/check-privacy.ts --staged   # the lines a commit adds
node script/check-privacy.ts --tree     # every tracked text file
```

Findings name the file, the line and the rule, never the matched text.

## The pre-commit hook

`.githooks/pre-commit` runs the staged secret check, then the staged privacy check. A fresh clone does not use hooks automatically. Enable them once per checkout:

```sh
git config core.hooksPath .githooks
```

If you already use another hook manager, call both staged checks from it rather than replacing it. A scanner, download or check failure blocks the commit, and findings are redacted. Never bypass the check to commit a credential.

## The full-history scan

No workflow runs it: the repository does not use GitHub Actions. Run it by hand, from a full clone, before a release or a visibility change:

```sh
npm run check:secrets                 # node script/check-secrets.ts --history
node script/check-privacy.ts --tree
```

It catches a secret after it has been committed; it cannot undo a push.

If a real credential is found, keep its value out of issues, pull requests and logs, and rotate or revoke it. Then review the affected history and release archives. Deleting a file or adding an ignore rule does not remove it from older commits. Rewriting history and changing the repository's visibility are explicit decisions, never done automatically.

A scanner finding nothing is not proof. Review identity metadata (commit author emails), pull request text and documents for private details too.
