# Releasing Agent Watchtower

Watchtower ships as source. A release is a tagged commit on `main` with a GitHub release that carries its notes, a source archive, the archive's SHA-256 and the commit it was built from. A release does not update an existing install. Run `bash capture/install.sh` from the new source to do that.

## Branches and pull requests

Work happens on one branch per stage or fix, such as `stage-10-attributes` or `chore/<topic>`. Each change reaches `main` through a pull request, merged with **squash**, and `main` is never pushed to directly.

Nothing runs on GitHub: the repository has no workflows and does not use GitHub Actions. The pre-commit hook runs the staged secret and privacy checks on every commit (see [secret checks](secret-checks.md)). The rest run on your machine when you choose:

```sh
npm run typecheck
npm test -- --exclude '.claude/**'
npm run lint                          # a pinned ShellCheck over every tracked shell script and hook
npm run check:secrets                 # a pinned Gitleaks over the full history
node script/check-privacy.ts --tree   # personal paths and terms in every tracked file
```

ShellCheck and Gitleaks download once, are verified by SHA-256 and are cached in `.tools/`.

### Protecting `main`

The committed ruleset protects the default branch. It was applied once, when the repository was created:

```sh
gh api --method POST repos/RaDeleon/Agent-Watchtower/rulesets --input .github/rulesets/main.json
```

The ruleset applies to the default branch. It:

- requires a pull request with no approvals needed, merged with squash;
- blocks force-pushes and deletion;
- lets repository admins bypass it.

It requires no status check, because no workflow would ever report one, and a required check that never reports blocks every merge.

## Versions

Versions are `MAJOR.MINOR.PATCH`. 1.0.0 is the first public release:

- **Major:** a change that breaks an existing install's data or a documented command.
- **Minor:** new features. Before 1.0.0, each stage that shipped bumped it: 0.8.0 covers Stages 1–8.
- **Patch:** a fix between features.
- **Schema:** a version that changes the database schema says so in its notes. The installer migrates in place.

`package.json`'s `version` is the source of truth. A test checks that it has notes and a history row, so the suite fails on a version bump that lacks them.

## Making a release

1. In the stage's pull request, or a release pull request of its own:
   - set `version` in `package.json`;
   - add `docs/release-notes/<version>.md`, which becomes the release body;
   - add a row to the history below;
   - add the same version to the README's **What's new** table, and bring the README's features, Dashboard table and table list up to date with what the release ships. `tests/readme.test.ts` checks the version, the pages and the tables.
2. Merge it.
3. Tag the merge commit on `main`, push the tag, then publish the release from your machine. `gh` must be signed in as the account that owns `origin`, or `GH_TOKEN` must hold a token with write access to the repository. The script runs `gh` with the owner's stored token (`gh auth token --user <owner>`) whatever account is active, because another account cannot see a private repository. A `GH_TOKEN` or `GITHUB_TOKEN` you set wins.

   ```sh
   git switch main && git pull --ff-only
   git tag -a v1.1.0 -m "Agent Watchtower 1.1.0"
   git push origin v1.1.0
   npm run release -- v1.1.0
   ```

`script/release.ts` builds everything from the tag, never from the working tree, so uncommitted work cannot ship:

1. `git archive` builds `dist/agent-watchtower-<version>.tar.gz` from the tagged commit.
2. The archive is unpacked and checked. `script/release-metadata.ts` checks the tag against the archive's own `package.json`, release notes and history row. Then it checks that the CLI is executable and that every script in `capture/` is valid bash.
3. It writes the archive's `.sha256`, `RELEASE-NOTES.md` and `SOURCE-COMMIT.txt` beside it in `dist/`.
4. It creates a **draft** release titled "Agent Watchtower <version>", uploads the archive, the checksum and `SOURCE-COMMIT.txt`, then publishes. It finds the draft with `gh release view`, because GitHub's get-a-release-by-tag endpoint never returns a draft. That lookup is what stopped the first v0.8.0 run at a draft. It publishes with `prerelease=false` and `make_latest=legacy`, so GitHub's Latest badge follows the newest version.

`npm run release -- <tag> --dry-run` runs steps 1 to 3 and publishes nothing. Under the old name, `claude-watchtower`, its archive was byte-identical to the one the retired Actions workflow published for v0.9.0.

A published release is never overwritten. Running the release again on a published tag fails, so a changed build needs a new version. If publishing stopped while the release was still a draft, running it again replaces the draft's assets.

## Release history

Releases before 1.0.0 were published as Claude Watchtower, with archives named `claude-watchtower-<version>.tar.gz`, from the private repository where Watchtower began, now archived. Their notes are kept here.

| Version | Date | Contents |
| --- | --- | --- |
| [1.0.0](release-notes/1.0.0.md) | 2026-10-25 | First public release, as Agent Watchtower, under the Apache License 2.0, from a new repository. The features of 0.10.0. No schema change (v11). |
| [0.10.0](release-notes/0.10.0.md) | 2026-10-22 | Stage 9: `watchtower setup`, a guided install from checkout to dashboard. `install.sh` gains `--dry-run` and `--status-line` and requires `sqlite3`. Config falls back to the checkout. No schema change (v11). |
| [0.9.0](release-notes/0.9.0.md) | 2026-10-15 | Stage 10: six character attributes (Form over 30 and 7 days, Base and Now levels), levels to 200 with tiers past Master, global level caps. Schema v11. |
| [0.8.0](release-notes/0.8.0.md) | 2026-10-12 | First tagged release: Stages 1–8. Capture, accounting, the dashboard, Codex and Hermes, levels, skills, quests and achievements. Schema v10. |
