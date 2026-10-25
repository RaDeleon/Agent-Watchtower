# Stage 4 brainstorm — Usage Profile, Matrix tier, latency, cost by model

**Status: closed 2026-09-25.** 4A spec: `2026-09-25-stage-4a-usage-profile-design.md`. Decision 3: Stage 4 splits into 4A (capture, scores, page) and 4B (latency, pricing, cost by model, `$0.00` Projects, `peakctx`).
This file records the decisions and the research; it is not a spec.

Scope as fixed by the Stage 3D spec (§1): the ten disciplines, the 6-tier Usage Profile
and TheOne's Matrix tier, all computed in `rollup.sh` (schema v5), plus per-request latency
(response time, tok/s) and a pricing table in the rollup (cost by model). Also folded in:
the `$0.00` Projects cost for projects with no reading, and `peakctx`'s `COALESCE(…,0)`
(needs TheOneOS lockstep — it feeds hygiene there too).

## Decisions (do not re-ask)

| # | Question | Decision |
|---|---|---|
| 1 | What is the score for? (A port / B coaching / C tiers) | **All three.** TheOne's formulas and thresholds wherever Watchtower has the same input (A); every discipline shows its evidence, never a score without a measurement (B); 6-tier ladder + 3-tier Matrix tier + week-over-week on both TheOne's hygiene score and the 600 total (C). *(2026-09-24)* |
| 2 | Automation and security, whose TheOne inputs do not exist outside TheOne | **Watchtower definitions**, same 0-60 scale, labelled "Watchtower definition" on the page. Automation: headless/SDK runs (`claude_requests.entrypoint`), SubagentStart events, MCP tool calls. Security: permission mode from hook payloads (share not in `bypassPermissions`). All ten are measured; 600 is reachable. *(2026-09-25)* |

Checked for decision 2: `claude_events.payload_json.permission_mode` is present — auto 5,174,
acceptEdits 406, default 120, bypassPermissions 79, plan 62 (6,043 older rows have none).
Permission *prompts* are not captured (no `Notification` hook is registered), so they are
not an input.

## Research (2026-09-24, read-only, TheOneOS @ current checkout)

Sources: `TheOneOS/lib/ccflare/usage-profile.ts` (UP), `lib/ccflare/profile.ts` (P).
Each discipline is a 0–100 sub-score scaled `round(s/100*60)` (UP:564-570); tier =
`min(5, floor(total/100))`. A discipline with no inputs scores 0, flagged needs-data.

Four ccflare "hygiene factors" (P:381-436), 30-day window, ≥20 records (P:63):
context = `lower(median cacheRead/request per session, 60k, 350k)`; compaction = share of
long sessions (≥30 req or ≥45 min) with an *inferred* reset (cache-read < 50% of a >80k
peak), 90 if none; sessionLength = `lower(median req/session, 40, 250)`; efficiency =
`lower(Σ cacheRead / Σ(in+out), 10, 45)`. All four are rebuildable from `claude_requests`.

| # | Discipline | TheOne inputs | Watchtower |
|---|---|---|---|
| 1 | Prompt hygiene (UP:341) | thinking ratio (never populated) + distinct slash commands ×20 | **New ingest**: slash commands from transcript `<command-name>` tags |
| 2 | Context hygiene (UP:361) | context factor | **Now** — `claude_requests.tokens_cache_read` by session |
| 3 | Session hygiene (UP:370) | sessionLength, compaction, real compactions ×20 | **Now** — and better: real PreCompact/PostCompact events (66) instead of inferred resets |
| 4 | Model routing (UP:398) | distinct models, non-top-model share | **Now** — `claude_requests.model`, excluding `<synthetic>` |
| 5 | Cost discipline (UP:417) | efficiency factor | **Now** |
| 6 | Verification (UP:428) | Read+Grep+Glob share of tool calls, tool error rate | **New ingest**: transcript `tool_use` names, `tool_result.is_error` |
| 7 | Automation (UP:447) | TheOne headless + agency runs, MCP calls | **Not portable** — runs are TheOne-internal. Candidates: `claude_requests.entrypoint` (sdk-cli/sdk-ts), SubagentStart events; MCP calls via new ingest |
| 8 | Reuse (UP:468) | slash-command max repeat, MCP servers, saved audits | Slash repeat: new ingest. MCP servers: now (approx., `attribution_mcp_server`). Saved audits: TheOne coach feature — drop |
| 9 | Security (UP:496) | ccflare routing flag, write-back approval share | **Not portable** — proxy/TheOne concepts. Needs a new definition (e.g. `permission_mode`) or "not measured" |
| 10 | Output quality (UP:516) | proxy success rate, tool error rate | Success: **now** (`api_error_status`, 24 of 31,004). Tool errors: new ingest |

TheOne's week-over-week (P:473-494) compares the 4-factor hygiene score, spend,
sessions/day and context/turn — **not** the 600 total. A total-based WoW would be new.

**Matrix tier** — nothing is literally named "Matrix". It is the 3-tier Coppertop /
Operator / The One ladder (P:314-369): thresholds 45 and 75 on the 0–100 ccflare hygiene
score `round(0.30·context + 0.25·compaction + 0.20·sessionLength + 0.25·efficiency)`.
Computable now. It is **not** Watchtower's `hygiene_score` (different terms,
rollup.sh:539-591) and not claude-hours' 7-rank hours ladder.

**Latency** — TheOne reads it from ccflare's proxy analytics; Watchtower has no proxy and
will not get one. Transcripts suffice: each assistant partial carries a ms ISO timestamp,
so response time = last partial − preceding `user` entry (prompt or tool_result). TTFT is
**not** recoverable. `claude_requests.ts` is integer seconds (MIN over partials), so ingest
needs ms `first/last/prev` timestamps per request (subagent files separately). Sample, one
real session: 48 requests, median 5.8 s, p90 26.8 s, median ~99 tok/s. Caveat: the gap
includes hook/queue time and interruptions. `system/turn_duration` gives per-turn ms.
Observation: `output_tokens` was identical across partials in 1,668 sampled requests, but
keep `MAX` (the ingest fixture models growing partials, and the invariant costs nothing).

**Pricing** — TheOne `lib/ai/pricing.ts:53-74` covers opus-4-8, sonnet-4-6, haiku-4-5 and
maps other opus/sonnet names onto those; **no entries** for opus-5, opus-5-5, sonnet-5 or
fable, which carry most of this traffic. Watchtower needs its own table. Today cost is only
the statusline's `total_cost_usd`, `MAX` per session; `wt_requests.cost_usd` is never set.
Pricing 1h vs 5m cache writes needs a new ingest column (transcripts carry
`cache_creation.ephemeral_5m/1h_input_tokens`; ingest stores only the total).

## Implied shape (not yet proposed to the user)

The work splits along the ingest boundary: (1) ingest additions — tool calls, tool errors,
slash commands, ms timestamps, cache-write split — with schema v5; (2) rollup derivations
— disciplines, Usage Profile, Matrix tier, latency, cost by model; (3) the views.
