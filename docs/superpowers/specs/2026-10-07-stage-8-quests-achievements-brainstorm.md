# Stage 8 — Achievements and quests: brainstorm state (closed)

**Status:** closed 2026-10-08. All five design sections approved (decisions 9–12, section 5);
the spec is `2026-10-08-stage-8-quests-achievements-design.md`, awaiting user review. Stage 7 shipped first (PR #21, live 2026-10-08).
Piece 2 of the "MMORPG stats" request (Stage 6 spec §9).

## Decisions already made (do not re-ask)

| # | Decision |
|---|---|
| 1 | **Purpose: both recognise and nudge.** Achievements mark milestones; quests push habits, not just hours. |
| 2 | **Quests aim at your weak spots.** Each week's quests come from the previous week's data: the three lowest Usage Profile disciplines. Deterministic, so every past week also gets its quests and results. |
| 3 | **Achievements are tiered milestones:** bronze → silver → gold → platinum on one measured thing each, unlocked from history with the real date. |
| 4 | **Rewards are separate points:** Quest Points and Achievement Points, apart from XP, shown on the Character card. Levels stay measured hours only. |
| 5 | **Approach A, weekly behaviour quests:** each discipline has one quest measuring its key behaviour over the quest week only. Not score deltas (B), not weekly discipline scores (C). |
| 6 | **Targets step up from last week:** last week's measured value moved one fixed step, never past the value that earns full marks; at full marks the quest is to hold it. |
| 7 | **A new Quests page** (`/quests`), unranged, in the tool row after Character: this week's quests, the weekly quest log, achievements by tier. The Character card gains QP and AP. |
| 8 | Quests are Claude-only (only Claude has disciplines); achievements cover every tool. (Stated as assumptions, not contradicted.) |
| 9 | **Section 1 (quests) approved as presented** (2026-10-08). A discipline that is always lowest (cost-discipline, 0 on every scored day) keeps its quest every week — no resting rule. Live week of 2026-10-05: Lean cache, Look before you leap, Signature move. |
| 10 | **Section 2 (achievements) approved: a fixed catalogue** (2026-10-08) — 20 achievements × 4 tiers, thresholds in `rollup.sh`, AP 1/2/3/4 per tier summed over unlocked tiers, each tier dated the first day history reached it. Per tool (Claude, Codex, Hermes): Seasoned (Lv 50/70/90/99), Daily habit (best streak 7/30/100/365), Regular (driven sessions 10/100/1k/5k), Wordsmith (output tokens 1M/10M/100M/1B), Explorer (projects with time 3/10/25/50). Claude: Skill collector (skills with time 5/15/30/50), Skill master / Pack master / Skill user (Lv 50/70/90/99), All-rounder (disciplines strong on one day 4/6/8/10), Quester (QP 10/50/150/300), Perfect week (1/5/20/52). Not per-key achievements; no hours, model-count or cost rows. |
| 11 | **Section 3 (data) approved** (2026-10-08) — schema v10, three regenerable tables: `claude_quests` (profile section, after the scores; per week × slot: discipline, baseline, target, value, requests, status), `achievement_tiers` and `character_points` (agent section, read phase, reusing `_sk_ups`, `_sk_runs`, `skill_daily`; swapped in its write phase). `_pf_wk` measures each (week, discipline) once, serving as value and next week's baseline. Quest dates = the week's Sunday. No second copy of any streak or level rule. |
| 12 | **Section 4 (the page) approved as presented** (2026-10-08). Tier unlocks stay on `/quests` only, out of Character's level-up log. |

## Findings that shape it (live DB, 2026-10-07)

- The ten discipline scores (`claude_discipline_scores`, 0–60 each) are **30-day rolling windows**, computed only on ungated days (`window_requests >= 20`). A week moves them ~¼ at most.
- `cost-discipline` is 0 on all 103 scored days: cache re-read ÷ fresh tokens is ~219 against a full-marks bar of ≤ 10 (L(ratio, 10, 45)).
- The profile section's Matrix pipeline is generic over `(win, day)` via `_pf_win` ('30', '7', '7p'); downstream picks each window explicitly (`win = '30'` etc.), so a calendar-week `'wk'` window is additive.
- Weekly values vary a lot: inspect share 2.1–5.5%, cache re-read ratio 127–554, models 1–4, slash kinds 2–9 (weeks of 2026-08-17 → 2026-10-05).

## Design section 1 (quests), approved 2026-10-08

- Week = Monday–Sunday local. Selection: the 30-day scores of the last scored day on or before the Sunday before the week; three lowest, ties by display order; eligible only if not `needs-data` and the quest was measurable the week before (that is the baseline). Fewer eligible → fewer quests; no scores → none.
- Measured over the week via a `'wk'` window in `_pf_win` plus the per-day `_pf_*day` aggregates.
- Status: `open` (current week, value so far), `done` / `missed` after the week ends, `no data` (under 20 requests, or a share with nothing to divide) — never shown as missed.
- 1 Quest Point per quest done.

| Discipline | Quest | Measured this week | Step | Full marks |
|---|---|---|---|---|
| verification | Look before you leap | Read/Grep/Glob share of tool calls | +2 pts | 50% |
| cost-discipline | Lean cache | cache re-read ÷ fresh tokens | −10% | 10 |
| context-hygiene | Travel light | median context per session | −10% | 60k |
| session-hygiene | Fresh start | long sessions with a reset | +10 pts | 100% |
| model-routing | Right tool | requests off your top model | +5 pts | 35% |
| security | Ask first | permission-bypass share of prompts | −1 pt | 2% |
| output-quality | Clean run | tool error rate | −0.5 pt | 5% |
| prompt-hygiene | Variety pack | distinct slash commands | +1 | 5 |
| reuse | Signature move | uses of your most-repeated command | +1 | 8 |
| automation | Delegate | subagent launches + headless sessions | +2 | 5 |

## Design section 4 (the page), as presented 2026-10-08, awaiting approval

`/quests`, unranged, in the nav right after Character; in both `watchtower serve` and
`watchtower report`. It reads, parses and labels only (quest names, units, tier badges in TS;
every threshold, step, target and status in SQL).

1. **This week** (Mon–Sun dates in the heading): up to three quest cards — the quest's name and
   discipline; the target with last week's baseline ("≥ 6.1% (last week 4.1%)", or "hold
   ≥ 50%" at full marks); the week's value so far; a status pill (`open`, `done`, `missed`,
   `no data`).
2. **Points:** Quest Points and Achievement Points as two big numbers. The Character page's
   Skills card also gets them as two rows beside Total level; neither is in Total.
3. **Achievements**, in three groups (every tool, Claude Code skills, habits): one row per
   achievement and tool — name, tool, current value, four tier badges (unlocked shows its
   date; locked is muted and shows its threshold, with "33 / 50 to platinum" for the next
   tier). **Recent unlocks** (last 10 tier unlocks with dates) at the top of the card.
   Achievement unlocks stay out of Character's level-up log (as skills did in Stage 7).
4. **Quest log:** one row per closed week, newest first: each quest with its status, and the
   Quest Points earned.

States: before the v10 rollup (no `claude_quests` table) "pending until the v10 rollup"; no
quests this week because nothing was measurable last week says so; `no data` is never shown
as `missed`, and a missing number is never shown as 0. The quest log grows a row a week, so
`/quests` gets its own bytes-per-week limit in `tests/report-budget.test.ts`.

Options offered with it: "Looks right (Recommended)"; "Unlocks in the level log" (tier unlocks
also appear in Character's level-up log); "Change something".

## Still to do

1. ~~Approve section 4~~ (decision 12) and ~~section 5~~ (tests, live proof, rollout, task
   shape; approved 2026-10-08 as presented, now §6–8 of the spec).
2. User review of the written spec, then the plan (writing-plans) and execution.
