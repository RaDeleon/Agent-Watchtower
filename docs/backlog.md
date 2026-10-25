# Backlog

Work that is decided but not yet scheduled. Each item says what is already settled, so it can be picked up without re-deciding it.

## install.sh and an empty settings.json

`capture/install.sh` merges a 0-byte `settings.json` to an empty file and reports done with no hooks installed. This is pre-existing on `main`, and `--dry-run` predicts it. **Settled:** treat an empty file as `{}`, with a test. Not scheduled.

## Background sync and a TUI launcher

Stage 9's pieces 2 (opt-in launchd sync) and 3 (a TUI launcher) were dropped from the 1.0 path on 2026-10-21 ([Stage 9 spec](superpowers/specs/2026-10-21-stage-9-onboarding-design.md), §9). **Settled:** before background sync is reconsidered, re-measure steady-state sync, since its gate was measured before sync learned to skip unchanged records. Not scheduled.
