#!/usr/bin/env bash
# make-fixture.sh <scenario> <db-path>
#
# Builds a capture DB containing one synthetic session, so the activity model
# can be asserted against a known event stream.
set -euo pipefail

scenario="${1:?scenario required}"
db="${2:?db path required}"
lib="$(cd "$(dirname "$0")/../../capture" && pwd)/lib.sh"

export THEONE_DB_PATH="$db"
# shellcheck source=/dev/null
. "$lib"
cc_init_db

BASE=1750000000   # fixed epoch so tests are deterministic
DAY=86400

# Fixtures must fail LOUDLY. cc_sql swallows every error by design -- a broken
# tracker must never break Claude Code -- which is exactly the wrong posture
# here: a typo'd column name left the fixture DB EMPTY, make-fixture.sh still
# exited 0, and the assertions ran against a database that was never built.
# Verified before this changed: a bad column gave exit 0 and 0 events.
fx_sql() {
  sqlite3 -cmd ".bail on" "$db" "$1" >/dev/null
}

# Values go through lib.sh's own encoders rather than bare '$1' interpolation.
# Hand-rolled quoting in the fixture builder means the fixtures exercise a
# DIFFERENT quoting path than production does, so an encoder bug cannot show up
# here -- which is how cc_sqlstr's broken apostrophe escaping stayed invisible.
CWD_FX="$(cc_sqlstr /tmp/fx)"
REPO_FX="$(cc_sqlstr fx)"

ev() {  # ev <session> <offset-seconds> <event-name>
  fx_sql "INSERT INTO claude_events (ts, session_id, hook_event_name, cwd, repo)
          VALUES ($((BASE + $2)), $(cc_sqlstr "$1"), $(cc_sqlstr "$3"), $CWD_FX, $REPO_FX);"
}
sess() { # sess <session> <start-offset>
  fx_sql "INSERT INTO claude_sessions (session_id, started_at, updated_at, cwd, repo, prompts)
          VALUES ($(cc_sqlstr "$1"), $((BASE + $2)), $((BASE + $2)), $CWD_FX, $REPO_FX, 1);"
}
snap() { # snap <session> <offset-seconds> <tokens-in> <tokens-out> <cost-usd> [lines-added] [lines-removed]
  # lines-added/lines-removed are optional and default to NULL (cc_sqlnum of ""
  # is NULL) so every pre-existing call site, which never set them, keeps
  # producing exactly the rows it always has.
  fx_sql "INSERT INTO claude_status_snapshots
            (session_id, ts, cwd, repo, model, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens, total_cost_usd,
             total_lines_added, total_lines_removed, context_used_percentage)
          VALUES ($(cc_sqlstr "$1"), $((BASE + $2)), $CWD_FX, $REPO_FX, $(cc_sqlstr fx-model),
                  $(cc_sqlnum "$3"), $(cc_sqlnum "$4"), 0, 0, $(cc_sqlnum "$5"),
                  $(cc_sqlnum "${6:-}"), $(cc_sqlnum "${7:-}"), 10.0);"
}
# A row in claude_requests -- the EXACT per-request token counts ingest.sh reads
# out of the transcripts. session_id is deliberately free-form: a request whose
# session_id has no claude_sessions row is the common case (22.4% of real
# requests), not an edge case, so fixtures must be able to write one.
# The optional in / cache-read / cache-creation overrides exist so a fixture can
# give every project DISTINCT values in ALL FOUR token columns. Left at the
# defaults, every project carries 7 / 900 / 100 and three of the four columns
# reconcile by coincidence rather than by attribution.
req() { # req <request-id> <session> <offset-seconds> <cwd> <out-tokens> [sidechain] [in] [cache-read] [cache-creation]
  fx_sql "INSERT INTO claude_requests
            (request_id, session_id, ts, cwd, model, tokens_in, tokens_out,
             tokens_cache_read, tokens_cache_creation, is_sidechain, ingested_at)
          VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$2"), $((BASE + $3)),
                  $(cc_sqlstr "$4"), $(cc_sqlstr fx-model),
                  $(cc_sqlnum "${7:-7}"), $(cc_sqlnum "$5"),
                  $(cc_sqlnum "${8:-900}"), $(cc_sqlnum "${9:-100}"),
                  ${6:-0}, $BASE);"
}

# reqp <request-id> <session> <abs-ts> <cwd> <model> <in> <out> <cache-read> <cw5m|-> <cw1h|-> [speed|-] [sidechain]
# A claude_requests row with the v6 pricing inputs; "-" writes NULL. Absolute ts,
# because every BASE-relative row is dated 2025-06-15 -- before any price row's
# effective_from (2026-01-01) -- and would be unknown-model.
# tokens_cache_creation = cw5m + cw1h, with "-" counted as 0.
reqp() {
  local w5="$9" w1="${10}" sp="${11:--}" total=0
  [ "$w5" = "-" ] || total=$(( total + w5 ))
  [ "$w1" = "-" ] || total=$(( total + w1 ))
  [ "$w5" = "-" ] && w5=""
  [ "$w1" = "-" ] && w1=""
  [ "$sp" = "-" ] && sp=""
  fx_sql "INSERT INTO claude_requests
            (request_id, session_id, ts, cwd, model, tokens_in, tokens_out,
             tokens_cache_read, tokens_cache_creation, cache_write_5m, cache_write_1h,
             speed, is_sidechain, ingested_at)
          VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$2"), $3,
                  $(cc_sqlstr "$4"), $(cc_sqlstr "$5"),
                  $(cc_sqlnum "$6"), $(cc_sqlnum "$7"), $(cc_sqlnum "$8"), $total,
                  $(cc_sqlnum "$w5"), $(cc_sqlnum "$w1"), $(cc_sqlstr "$sp"),
                  ${12:-0}, $BASE);"
}

# Absolute-epoch UTC ISO-8601 -> unix seconds. The Stage 4A profile fixtures
# need REAL calendar dates close to "today" (the profile's day range runs from
# the first request through date('now','localtime')), unlike every other
# fixture here, which is pinned at the fixed, permanently-past BASE. GNU date
# (-d) is tried first, then BSD/macOS date (-j -f), so this runs on either.
epoch() { # epoch <YYYY-MM-DDTHH:MM:SSZ>
  date -u -d "$1" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$1" "+%s"
}

# A claude_requests row at an ABSOLUTE unix timestamp, for the Stage 4A profile
# scoring fixtures -- req() above is BASE-relative, and the profile's day range
# depends on the real calendar, so its fixtures need real recent dates instead.
# No claude_sessions row is created (nor needed): profile scoring reads
# claude_requests only, and a request's session_id is free-form (see req()).
req_at() { # req_at <request-id> <session> <abs-ts> <cwd> <out-tokens> [sidechain] [in] [cache-read] [cache-creation]
  fx_sql "INSERT INTO claude_requests
            (request_id, session_id, ts, cwd, model, tokens_in, tokens_out,
             tokens_cache_read, tokens_cache_creation, is_sidechain, ingested_at)
          VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$2"), $3,
                  $(cc_sqlstr "$4"), $(cc_sqlstr fx-model),
                  $(cc_sqlnum "${7:-7}"), $(cc_sqlnum "$5"),
                  $(cc_sqlnum "${8:-900}"), $(cc_sqlnum "${9:-100}"),
                  ${6:-0}, $BASE);"
}

# Stage 4A Task 3 -- the ten disciplines' non-request inputs, all at ABSOLUTE
# timestamps like req_at(), every value through lib.sh's encoders.
#
# req_meta: the per-request columns req_at() leaves at their defaults. An empty
# api-error-status writes NULL (a success), exactly as ingest stores one.
req_meta() { # req_meta <request-id> <model> <entrypoint> [api-error-status]
  fx_sql "UPDATE claude_requests
            SET model = $(cc_sqlstr "$2"), entrypoint = $(cc_sqlstr "$3"),
                api_error_status = $(cc_sqlstr "${4:-}")
          WHERE request_id = $(cc_sqlstr "$1");"
}
# Stage 7: the skill Claude Code tagged a request with (claude_requests.attribution_skill),
# through lib.sh's encoder like every other value here.
req_skill() { # req_skill <request-id> <skill>
  fx_sql "UPDATE claude_requests SET attribution_skill = $(cc_sqlstr "$2") WHERE request_id = $(cc_sqlstr "$1");"
}
# One claude_tool_calls row. is-error / is-sidechain are 0, 1, or '' for NULL:
# an UNRESOLVED call (its tool_result never arrived) keeps is_error NULL, and a
# result-only row has no name, no ts and no sidechain flag. mcp_server follows
# ingest.sh's rule (the text between "mcp__" and the next "__").
tc_at() { # tc_at <tool-use-id> <session> <abs-ts> <tool-name> <is-error> <is-sidechain>
  local server=""
  case "$4" in mcp__*) server="${4#mcp__}"; server="${server%%__*}" ;; esac
  fx_sql "INSERT INTO claude_tool_calls
            (tool_use_id, request_id, session_id, ts, tool_name, mcp_server, is_error, is_sidechain)
          VALUES ($(cc_sqlstr "$1"), NULL, $(cc_sqlstr "$2"), $(cc_sqlnum "$3"),
                  $(cc_sqlstr "$4"), $(cc_sqlstr "$server"), $(cc_sqlnum "$5"), $(cc_sqlnum "$6"));"
}
sl_at() { # sl_at <entry-uuid> <session> <abs-ts> <command>
  fx_sql "INSERT INTO claude_slash_commands (entry_uuid, session_id, ts, command)
          VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$2"), $(cc_sqlnum "$3"), $(cc_sqlstr "$4"));"
}
ev_at() { # ev_at <session> <abs-ts> <event-name> [payload-json]
  fx_sql "INSERT INTO claude_events (ts, session_id, hook_event_name, cwd, repo, payload_json)
          VALUES ($(cc_sqlnum "$2"), $(cc_sqlstr "$1"), $(cc_sqlstr "$3"), $CWD_FX, $REPO_FX,
                  $(cc_sqlstr "${4:-}"));"
}
# Stage 10: a claude_sessions row at an ABSOLUTE start time, beside ev_at(), so
# a fixture can give Claude hours on real recent days (sess() is BASE-relative).
sess_at() { # sess_at <session> <abs-ts>
  fx_sql "INSERT INTO claude_sessions (session_id, started_at, updated_at, cwd, repo, prompts)
          VALUES ($(cc_sqlstr "$1"), $2, $2, $CWD_FX, $REPO_FX, 1);"
}
snap_at() { # snap_at <session> <abs-ts> <total-cost-usd>
  fx_sql "INSERT INTO claude_status_snapshots (session_id, ts, cwd, repo, model, total_cost_usd)
          VALUES ($(cc_sqlstr "$1"), $(cc_sqlnum "$2"), $CWD_FX, $REPO_FX, $(cc_sqlstr fx-model),
                  $(cc_sqlnum "$3"));"
}

# A snapshot carrying RATE-LIMIT readings. Separate from snap() so every
# existing call site keeps writing exactly the rows it always has: the gauge
# columns are NULL almost everywhere in production too (only 74.6% of real
# snapshots carry a 5h reading), and that is the case the Live view must handle.
# An empty percentage argument writes NULL -- cc_sqlnum "" is NULL.
snaprl() { # snaprl <session> <offset-seconds> <five-hour-pct> <seven-day-pct>
  fx_sql "INSERT INTO claude_status_snapshots
            (session_id, ts, cwd, repo, model, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens, total_cost_usd,
             context_used_percentage,
             five_hour_rate_limit_used_percentage, seven_day_rate_limit_used_percentage)
          VALUES ($(cc_sqlstr "$1"), $((BASE + $2)), $CWD_FX, $REPO_FX, $(cc_sqlstr fx-model),
                  10, 20, 0, 0, $((${2} / 60 + 1)).0, 42.5,
                  $(cc_sqlnum "$3"), $(cc_sqlnum "$4"));"
}

case "$scenario" in
  resumed)
    # Two minutes of real work, then the SAME session_id resumed 30 days later.
    # Naive (ended_at - started_at) would book 30 days.
    sess S_RESUMED 0
    ev S_RESUMED 0    SessionStart
    ev S_RESUMED 2    UserPromptSubmit
    ev S_RESUMED 120  Stop
    ev S_RESUMED 120  SessionEnd
    ev S_RESUMED $((30 * DAY))        SessionStart
    ev S_RESUMED $((30 * DAY + 600))  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at = $((BASE + 30 * DAY + 600)) WHERE session_id='S_RESUMED';"
    ;;
  missing-stop)
    # A turn with NO Stop event, then a 3-hour walk-away before the next prompt.
    # Without the UserPromptSubmit override this bills 3h of "task time".
    sess S_NOSTOP 0
    ev S_NOSTOP 0      SessionStart
    ev S_NOSTOP 10     UserPromptSubmit
    ev S_NOSTOP 10820  UserPromptSubmit   # +3h
    ev S_NOSTOP 10880  Stop
    ev S_NOSTOP 10880  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at = $((BASE + 10880)) WHERE session_id='S_NOSTOP';"
    ;;
  long-run)
    # A 20-minute autonomous run. The old gap<=600 rule discarded this entirely.
    sess S_LONG 0
    ev S_LONG 0     SessionStart
    ev S_LONG 10    UserPromptSubmit
    ev S_LONG 1210  Stop               # +20 min of task
    ev S_LONG 1220  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at = $((BASE + 1220)) WHERE session_id='S_LONG';"
    ;;
  work-cap)
    # A WORK gap far past the 14400s sanity cap, NOT ending at UserPromptSubmit.
    # Without the cap this books 20,000s; with it, 14,400s.
    sess S_CAP 0
    ev S_CAP 0      SessionStart
    ev S_CAP 10     UserPromptSubmit
    ev S_CAP 20010  Stop
    ev S_CAP 20020  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at = $((BASE + 20020)) WHERE session_id='S_CAP';"
    ;;
  dup-snapshot)
    # The fan-out shape: TWO status snapshots sharing (session_id, max ts).
    # _snap must still yield exactly ONE row for this session — otherwise _sx
    # fans out on it and the session is counted twice in every daily aggregate
    # (sessions, active seconds, window seconds, tokens and cost alike).
    # Event stream is long-run's: 1210s active, 1220s window.
    sess S_DUP 0
    ev S_DUP 0     SessionStart
    ev S_DUP 10    UserPromptSubmit
    ev S_DUP 1210  Stop
    ev S_DUP 1220  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at = $((BASE + 1220)) WHERE session_id='S_DUP';"
    # Same ts, DIFFERENT values, so the assertions also pin WHICH row wins: the
    # later one (higher id). Summing both would give 101 / 202 / 3.0 for
    # tokens and cost alike; cost still comes from here, tokens no longer do.
    # lines-added/lines-removed mirror the token columns (1/100, 2/200) so the
    # 281.7x MAX-vs-SUM guard on total_lines_added has two distinct cumulative
    # values to tell apart: MAX is 100, SUM is 101.
    snap S_DUP 1210 1   2   0.5 1   2
    snap S_DUP 1210 100 200 1.5 100 200
    # ONE request, with token counts that match NEITHER snapshot and neither
    # their sum. Since Stage 2 the daily token columns come from
    # claude_requests, so this is what the rollup must report -- and a rollup
    # that fell back to the snapshots would show 2, 200 or 202, never 333.
    req  R_DUP S_DUP 1210 /tmp/fx 333
    ;;
  two-sessions-day)
    # Two DISTINCT sessions on one local day. No other fixture has more than one
    # session per day, which is structurally why the fan-out was invisible: with
    # a single session, a doubled row and a correct one look the same in a SUM.
    # S_ONE: 10s think + 1200s work = 1210 active, 1220 window.
    sess S_ONE 0
    ev S_ONE 0     SessionStart
    ev S_ONE 10    UserPromptSubmit
    ev S_ONE 1210  Stop
    ev S_ONE 1220  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at = $((BASE + 1220)) WHERE session_id='S_ONE';"
    snap S_ONE 1210 100 200 1.5
    # S_TWO: 10s think + 600s work = 610 active, 620 window.
    sess S_TWO 3600
    ev S_TWO 3600  SessionStart
    ev S_TWO 3610  UserPromptSubmit
    ev S_TWO 4210  Stop
    ev S_TWO 4220  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at = $((BASE + 4220)) WHERE session_id='S_TWO';"
    snap S_TWO 4210 50 60 0.5
    # One request per session, on the same local day. Token values match no
    # snapshot, so the daily token columns can only be right by summing
    # claude_requests across both sessions.
    req R_ONE S_ONE 1210 /tmp/fx 1000
    req R_TWO S_TWO 4210 /tmp/fx 2000
    ;;
  crosses-midnight)
    # A single sitting that starts before local midnight and finishes after it.
    # BASE is 2025-06-15 15:06:40 UTC, so +31400 is 23:50:00 and the session runs
    # to 00:20 the NEXT day. The rollup attributes a session to its (local) START
    # day, whole -- so all 1210s must land on 2025-06-15 and none on 2025-06-16,
    # even though 1200 of those seconds elapsed after midnight. 100 sessions in
    # the live DB have this shape. Documented in rollup.sh since rev 3; this is
    # the first fixture that actually holds the rule in place.
    # 10s think + 1200s work = 1210 active, 1210 window (same shape as long-run).
    sess S_MID 31400
    ev S_MID 31400  SessionStart      # 23:50:00
    ev S_MID 31410  UserPromptSubmit  # 23:50:10
    ev S_MID 32610  Stop              # 00:10:10, next day
    ev S_MID 32620  SessionEnd        # 00:10:20, next day
    fx_sql "UPDATE claude_sessions SET ended_at = $((BASE + 32620)) WHERE session_id='S_MID';"
    snap S_MID 32610 100 200 1.5
    ;;
  four-projects)
    # Four cwds covering every resolution outcome, in a scratch tree beside the
    # fixture DB so the test can delete one and rebuild.
    #
    # repo-a lives under a parent directory containing a SPACE ("space dir").
    # That is deliberate: WATCHTOWER_EXCLUDE_PATHS is newline-separated, and an
    # unquoted `$WATCHTOWER_EXCLUDE_PATHS` expansion word-splits on IFS (which
    # includes space), so a pattern containing a space silently becomes two
    # patterns that match nothing. A pattern with no space (e.g. "*/repo-a")
    # would pass against that broken form too, so it alone cannot pin the
    # regression -- the space in this path is what makes it a real test.
    fxroot="$(dirname "$db")/tree"
    mkdir -p "$fxroot/space dir/repo-a/sub" "$fxroot/plain-dir"
    git -C "$fxroot/space dir/repo-a" init -q 2>/dev/null
    # NOTE: no mkdir for vanished -- it must not exist.
    sess S_A 0
    ev S_A 0    SessionStart
    ev S_A 10   UserPromptSubmit
    ev S_A 1210 Stop
    ev S_A 1220 SessionEnd
    fx_sql "UPDATE claude_events SET cwd=$(cc_sqlstr "$fxroot/space dir/repo-a") WHERE session_id='S_A';"
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + 1220)), cwd=$(cc_sqlstr "$fxroot/space dir/repo-a") WHERE session_id='S_A';"

    for pair in "S_SUB:$fxroot/space dir/repo-a/sub" "S_PLAIN:$fxroot/plain-dir" "S_GONE:$fxroot/vanished"; do
      sid="${pair%%:*}"; dir="${pair#*:}"
      sess "$sid" 3600
      ev "$sid" 3600 SessionStart
      ev "$sid" 3610 UserPromptSubmit
      ev "$sid" 4210 Stop
      ev "$sid" 4220 SessionEnd
      fx_sql "UPDATE claude_events   SET cwd=$(cc_sqlstr "$dir") WHERE session_id='$sid';"
      fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + 4220)), cwd=$(cc_sqlstr "$dir") WHERE session_id='$sid';"
    done
    ;;
  mixed-projects-one-day|priced-mixed)
    # One local day, four cwds, one shape each: two real repos, a non-repo
    # directory (-> unfiled) and an excluded path. The reconciliation test needs
    # all four present or the identity holds for the wrong reason.
    fxroot="$(dirname "$db")/tree"
    mkdir -p "$fxroot/proj-one" "$fxroot/proj-two" "$fxroot/not-a-repo" "$fxroot/skipme"
    git -C "$fxroot/proj-one" init -q 2>/dev/null
    git -C "$fxroot/proj-two" init -q 2>/dev/null
    i=0
    for pair in "S_P1:$fxroot/proj-one" "S_P2:$fxroot/proj-two" \
                "S_UN:$fxroot/not-a-repo" "S_EX:$fxroot/skipme"; do
      sid="${pair%%:*}"; dir="${pair#*:}"
      off=$(( i * 3600 ))
      sess "$sid" "$off"
      ev "$sid" "$off"             SessionStart
      ev "$sid" $(( off + 10 ))    UserPromptSubmit
      ev "$sid" $(( off + 610 ))   Stop
      ev "$sid" $(( off + 620 ))   SessionEnd
      fx_sql "UPDATE claude_events   SET cwd=$(cc_sqlstr "$dir") WHERE session_id='$sid';"
      fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + off + 620)), cwd=$(cc_sqlstr "$dir")
              WHERE session_id='$sid';"
      snap "$sid" $(( off + 610 )) 100 200 1.5
      i=$(( i + 1 ))
    done
    # Non-zero compacts / clears / subagents / cache tokens, spread unevenly. The
    # reconciliation identity covers all thirteen columns, and a column whose
    # fixture value is 0 on both sides reconciles vacuously and pins nothing --
    # these are exactly the columns the Stage 1 fan-out corrupted.
    fx_sql "UPDATE claude_sessions SET compacts=2, subagents=3, source='clear' WHERE session_id='S_P1';"
    fx_sql "UPDATE claude_sessions SET compacts=1, subagents=5 WHERE session_id='S_P2';"
    fx_sql "UPDATE claude_status_snapshots SET cache_read_tokens=700, cache_creation_tokens=300
            WHERE session_id='S_UN';"
    fx_sql "UPDATE claude_status_snapshots SET cache_read_tokens=50, cache_creation_tokens=25
            WHERE session_id='S_P2';"
    # One request per cwd, with DISTINCT values in EVERY token column. Without
    # these, four of the identity's thirteen columns reconciled 0 = 0 on the
    # fixture that has the most keys -- so the identity was token-blind in
    # exactly the multi-key shape where attribution is at risk. Distinct per
    # column, and no value a multiple of another, so a row landing under the
    # wrong key cannot be mistaken for the right one by arithmetic coincidence.
    req M_P1 S_P1 300   "$fxroot/proj-one"   1301 0 11 130 17
    req M_P2 S_P2 3900  "$fxroot/proj-two"   2903 0 23 370 29
    req M_UN S_UN 7500  "$fxroot/not-a-repo" 4507 0 31 510 37
    req M_EX S_EX 11100 "$fxroot/skipme"     6101 0 41 730 43
    # A FIFTH session: a start time, and no claude_events rows at all. The daily
    # rollup counts it -- sessions_count is COUNT(*) over _sx, which is driven by
    # claude_sessions -- but it has no _act row, so a per-project INSERT driven
    # from _act through an INNER JOIN drops it from every project row and
    # SUM(sessions_count) falls short of the daily figure. Zero sessions have
    # this shape in the real DB today, which is precisely why the fixture must
    # hold it: nothing else would notice the join being wrong until the first
    # such row is written. It keys to (unfiled).
    sess S_NOEV 14400
    if [ "$scenario" = priced-mixed ]; then
      T="$(epoch 2026-09-10T12:00:00Z)"
      i=0
      for dir in "$fxroot/proj-one" "$fxroot/proj-two" "$fxroot/not-a-repo" "$fxroot/skipme"; do
        i=$(( i + 1 ))
        reqp "PM_O$i" S_PM "$((T + i))"        "$dir" claude-opus-5   1000 2000 3000 400 600 standard
        reqp "PM_S$i" S_PM "$((T + 10 + i))"   "$dir" claude-sonnet-5 500  700  900  100 200 standard
        reqp "PM_A$i" S_PM "$((T + 20 + i))"   "$dir" claude-opus-5   1000 2000 0    -   -   -
        reqp "PM_U$i" S_PM "$((T + 30 + i))"   "$dir" claude-mystery-9 10  20   30   -   -   standard
      done
      # Two sessions, one with a cost snapshot and one without.
      sess S_PM_COST 200
      snap S_PM_COST 300 100 200 2.5
      sess S_PM_NOCOST 400
    fi
    ;;
  session-spans-two-projects)
    # ONE session that changes directory mid-flight: 1200s of work in proj-one,
    # then a walk-away and 200s in proj-two. 20 of 2,478 real sessions have this
    # shape. Time must appear under BOTH; the session, its tokens and its cost
    # under proj-one only, which is dominant by active_s with no tie to break.
    #
    # The 1000s gap ending at the SECOND UserPromptSubmit is what gives this
    # fixture genuine IDLE time. Every other fixture in the suite is fully
    # active (window_s == active_s), so idle_ms reconciled 0 against 0 and the
    # identity pinned nothing there: hard-coding the per-project idle_ms to 0
    # left the whole suite green. A gap ENDING at UserPromptSubmit is think
    # time, capped at 300s, while window_s counts it in full, so 1000s of gap
    # books 300s active against 1000s window -- 700s of idle, under proj-two.
    #   proj-one: active 1210, window 1210, idle   0
    #   proj-two: active  500, window 1200, idle 700
    #   daily:    active 1710, window 2410, idle 700
    fxroot="$(dirname "$db")/tree"
    mkdir -p "$fxroot/proj-one" "$fxroot/proj-two"
    git -C "$fxroot/proj-one" init -q 2>/dev/null
    git -C "$fxroot/proj-two" init -q 2>/dev/null
    sess S_SPAN 0
    ev S_SPAN 0    SessionStart
    ev S_SPAN 10   UserPromptSubmit
    ev S_SPAN 1210 Stop               # 1200s of work, in proj-one
    ev S_SPAN 2210 UserPromptSubmit   # 1000s think-capped to 300 -> 700s idle
    ev S_SPAN 2410 Stop               # 200s of work, in proj-two
    ev S_SPAN 2420 SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + 2420)),
              cwd=$(cc_sqlstr "$fxroot/proj-one") WHERE session_id='S_SPAN';"
    # Events up to and including the first Stop belong to proj-one; the rest to
    # proj-two. Attribution is by the event that ENDS each gap, so the boundary
    # is set on the events themselves.
    fx_sql "UPDATE claude_events SET cwd=$(cc_sqlstr "$fxroot/proj-one")
            WHERE session_id='S_SPAN' AND ts <= $((BASE + 1210));"
    fx_sql "UPDATE claude_events SET cwd=$(cc_sqlstr "$fxroot/proj-two")
            WHERE session_id='S_SPAN' AND ts >  $((BASE + 1210));"
    snap S_SPAN 2410 100 200 1.5
    # The per-session scalars that must go WHOLE to the dominant project and to
    # no other. Left at 0 they reconcile vacuously, and dropping an is_dom gate
    # on compacts, clears, subagents or the cache token columns would go unseen
    # -- this is the only fixture where the gate can be wrong at all.
    fx_sql "UPDATE claude_sessions SET compacts=2, subagents=3, source='clear' WHERE session_id='S_SPAN';"
    fx_sql "UPDATE claude_status_snapshots SET cache_read_tokens=700, cache_creation_tokens=300
            WHERE session_id='S_SPAN';"
    # ONE session, TWO request cwds. Tokens are NOT a per-session scalar handed
    # whole to the dominant project: a request carries its own cwd, so the
    # non-dominant project must receive its own request's tokens and none of the
    # dominant project's. Distinct values in every column, and no value a
    # multiple of another, so a swap cannot pass for the right answer.
    req M_SPAN1 S_SPAN 600  "$fxroot/proj-one" 1301 0 11 130 17
    req M_SPAN2 S_SPAN 2300 "$fxroot/proj-two" 2903 0 23 370 29
    ;;
  recent-and-old-projects)
    # Two real repos, one session each: one INSIDE the reader's 30-day window
    # and one far outside it. Every other fixture is pinned at BASE
    # (2025-06-15), permanently outside that window, which is why
    # readProjectRows(db, "30d") had never once executed its WHERE branch --
    # it returned 0 rows against every fixture in the suite.
    #
    # Offsets are computed from NOW, not from BASE, so the fixture cannot rot:
    # a literal epoch would fall out of the window as the calendar moved.
    # 3 days and 120 days, not 29 and 31, so that the rollup bucketing by LOCAL
    # day under TZ=UTC and the reader's date('now','localtime') can differ by a
    # day without making the test flaky.
    fxroot="$(dirname "$db")/tree"
    mkdir -p "$fxroot/proj-recent" "$fxroot/proj-old"
    git -C "$fxroot/proj-recent" init -q 2>/dev/null
    git -C "$fxroot/proj-old" init -q 2>/dev/null
    NOW="$(date +%s)"
    for pair in "S_RECENT:$fxroot/proj-recent:3" "S_OLD:$fxroot/proj-old:120"; do
      sid="${pair%%:*}"; rest="${pair#*:}"; dir="${rest%:*}"; days="${rest##*:}"
      off=$(( NOW - days * DAY - BASE ))
      sess "$sid" "$off"
      ev "$sid" "$off"            SessionStart
      ev "$sid" $(( off + 10 ))   UserPromptSubmit
      ev "$sid" $(( off + 610 ))  Stop
      ev "$sid" $(( off + 620 ))  SessionEnd
      fx_sql "UPDATE claude_events   SET cwd=$(cc_sqlstr "$dir") WHERE session_id='$sid';"
      fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + off + 620)), cwd=$(cc_sqlstr "$dir")
              WHERE session_id='$sid';"
      snap "$sid" $(( off + 610 )) 100 200 1.5
    done
    ;;
  orphan-request-tokens)
    # One real session with requests, plus a request whose session_id has NO
    # claude_sessions row -- the 22.7%-of-tokens case. Routing tokens through
    # _sx drops the orphan while the identity still passes.
    sess s1 0
    ev   s1 0    SessionStart
    ev   s1 600  Stop
    ev   s1 900  SessionEnd
    snap s1 300  50 60 0.5
    req  r_live s1      600 /tmp/fx 1000
    req  r_ghost s_gone 700 /tmp/fx 500
    # r_live also names a tool via attribution_skill, so claudeToolRecords
    # tests (Task 4) have exactly one non-vacuous row to find. Neither req()
    # nor any reconciliation math above reads this column, so setting it here
    # cannot move the token/identity assertions already pinned to this fixture.
    fx_sql "UPDATE claude_requests SET attribution_skill='fx-skill' WHERE request_id='r_live';"
    ;;
  request-only-projects)
    # Per-project token attribution, which is the whole point of driving the
    # project rollup from _ptok. THREE request cwds resolving to THREE DIFFERENT
    # keys, and TWO of them appear in no claude_events row at all:
    #   proj-alpha  in events AND requests    -> its own git toplevel
    #   proj-beta   requests ONLY             -> its own git toplevel
    #   skipme      requests ONLY, excluded   -> (excluded)
    # Every other request-bearing fixture uses /tmp/fx, which keys to (unfiled)
    # whether the cwd -> project_key map works or not -- so replacing the whole
    # map with the literal '(unfiled)' left the suite green. proj-beta and
    # skipme are the pre-install shape that the claude_requests arms of _pk and
    # of the resolution step exist to cover; without either arm they fall back
    # to (unfiled) and the day-level identity cannot tell.
    #
    # Token values are distinct in every column and no value is a multiple of
    # another, so tokens landing under the wrong key cannot pass for the right
    # answer by arithmetic coincidence.
    fxroot="$(dirname "$db")/tree"
    mkdir -p "$fxroot/proj-alpha" "$fxroot/proj-beta" "$fxroot/skipme"
    git -C "$fxroot/proj-alpha" init -q 2>/dev/null
    git -C "$fxroot/proj-beta"  init -q 2>/dev/null
    # NOTE: no git init for skipme -- it must reach (excluded) on the exclusion
    # verdict alone, not because it failed to resolve.
    sess S_ALPHA 0
    ev S_ALPHA 0   SessionStart
    ev S_ALPHA 10  UserPromptSubmit
    ev S_ALPHA 610 Stop
    ev S_ALPHA 620 SessionEnd
    fx_sql "UPDATE claude_events   SET cwd=$(cc_sqlstr "$fxroot/proj-alpha") WHERE session_id='S_ALPHA';"
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + 620)), cwd=$(cc_sqlstr "$fxroot/proj-alpha")
            WHERE session_id='S_ALPHA';"
    snap S_ALPHA 610 100 200 1.5
    # Two requests under proj-alpha, so its per-project figure is a real SUM and
    # not a single row copied through.
    req R_ALPHA1 S_ALPHA 300 "$fxroot/proj-alpha" 1301 0 11 130 17
    req R_ALPHA2 S_ALPHA 400 "$fxroot/proj-alpha"  907 0 13 190 19
    # S_GHOST has no claude_sessions row either: a requests-only cwd in the
    # pre-install days has no session to hang off by construction.
    req R_BETA   S_GHOST 500 "$fxroot/proj-beta"  2903 0 23 370 29
    req R_EX     S_GHOST 600 "$fxroot/skipme"     4507 0 31 510 37
    ;;
  partial-transcript-coverage)
    # TWO structurally identical days that differ in ONE thing: whether the
    # transcripts covered them. 21 of 68 real days have sessions and events but
    # no transcript left to ingest (measured 2026-09-11: 338 sessions, 41.0
    # active hours, 2026-07-17..2026-09-01), so they correctly report 0 tokens --
    # "no data" beats "wrong data". What must NOT follow is a fabricated
    # cache_hit_percentage of 0 costing them 25 of hygiene's 100 points: measured
    # 80.9 on covered days against 57.76 on uncovered ones, a 23-point penalty
    # for ABSENT DATA rather than bad practice, which then dragged lifetime
    # hygiene from ~80.9 to 73.855 through AVG(NULLIF(hygiene_score,0)).
    #
    # Both days: 10s think + 600s work, no idle, peak context 10%, no compacts
    # or clears -- so the three EVENT-derived hygiene terms are 30 + 18 + 20 = 68
    # on both, and only the cache term differs.
    sess S_COV 0
    ev S_COV 0   SessionStart
    ev S_COV 10  UserPromptSubmit
    ev S_COV 610 Stop
    ev S_COV 620 SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + 620)) WHERE session_id='S_COV';"
    snap S_COV 610 100 200 1.5
    # 900 cache-read against 100 cache-creation = a 90% hit rate, so the cache
    # term is a clean 22.5 and the day scores 90.5.
    req R_COV S_COV 300 /tmp/fx 1000 0 11 900 100

    # The next day, same shape, NO request at all.
    sess S_BARE $DAY
    ev S_BARE $DAY            SessionStart
    ev S_BARE $((DAY + 10))   UserPromptSubmit
    ev S_BARE $((DAY + 610))  Stop
    ev S_BARE $((DAY + 620))  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + DAY + 620)) WHERE session_id='S_BARE';"
    snap S_BARE $((DAY + 610)) 100 200 1.5
    ;;
  zero-window-no-coverage)
    # TWO uncovered days in ONE rollup run whose attainable hygiene maxima
    # DIFFER, so the rescale denominator is provably computed per day rather
    # than fixed.
    #
    # The focus/idle term is `CASE WHEN total_session_ms = 0 THEN 10.0 ELSE
    # max(0, min(20, ...)) END` -- a FLAT 10.0 when the window collapsed, not a
    # 0-20 range. So a zero-window day can attain only 30 + 25 + 10 = 65, and
    # dividing it by 75 normalises against a maximum it cannot reach: the exact
    # error the rescale exists to remove. 9 of 69 real days have
    # sessions_count > 0 with total_session_ms = 0 (2026-07-11 with 135
    # sessions, 2026-07-17 with 201, and seven more).
    #
    # Neither day gets a snapshot or a request, so cache_hit_percentage is
    # NULL on both and, since Stage 4B, so is peak context: NO context reading
    # either, and that term is dropped too (spec 4B 4.4). The ONLY difference
    # between them is whether the window is zero.
    #
    #   day 1  S_WIN : 10s think + 600s work -> window 610s, idle 0
    #                  18 + 20 = 38 of an attainable 45 -> 84.444...
    #   day 2  S_ZERO: SessionStart then SessionEnd, nothing between. Gaps
    #                  ending at either count 0 toward BOTH figures, so the
    #                  window is 0 -- the real shape of those 9 days.
    #                  18 + 10 = 28 of an attainable 35 -> 80
    # (Before Stage 4B the missing peak was a fabricated 0 -> the flat 30, and
    # the days scored 68 of 75 and 58 of 65. zero-window-context-read below is
    # this scenario WITH a context reading, which is that 75 / 65 case.)
    sess S_WIN 0
    ev S_WIN 0   SessionStart
    ev S_WIN 10  UserPromptSubmit
    ev S_WIN 610 Stop
    ev S_WIN 620 SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + 620)) WHERE session_id='S_WIN';"

    sess S_ZERO $DAY
    ev S_ZERO $DAY           SessionStart
    ev S_ZERO $((DAY + 300)) SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + DAY + 300)) WHERE session_id='S_ZERO';"
    ;;
  zero-window-context-read)
    # zero-window-no-coverage's two days, event for event, plus ONE status-line
    # snapshot per session carrying a 10% context reading and no cost. The
    # cache term is still unmeasured on both (no request), but context now IS
    # measured (10% -> the flat 30), so this is spec 4B 4.4's second row:
    # the cache rescale, against the maximum each day could attain.
    #   day 1  S_WIN : 30 + 18 + 20 = 68 of an attainable 75 -> 90.666...
    #   day 2  S_ZERO: 30 + 18 + 10 = 58 of an attainable 65 -> 89.230...
    #                  Against a fixed 75 this scores 77.333.
    sess S_WIN 0
    ev S_WIN 0   SessionStart
    ev S_WIN 10  UserPromptSubmit
    ev S_WIN 610 Stop
    ev S_WIN 620 SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + 620)) WHERE session_id='S_WIN';"
    snap S_WIN 300 "" "" ""

    sess S_ZERO $DAY
    ev S_ZERO $DAY           SessionStart
    ev S_ZERO $((DAY + 300)) SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + DAY + 300)) WHERE session_id='S_ZERO';"
    snap S_ZERO $((DAY + 100)) "" "" ""
    ;;
  null-cwd-request)
    # A request with NO cwd, sharing a day with a request whose cwd is
    # unresolvable. Both key to (unfiled) in _ptok's SELECT list -- but a bare
    # `GROUP BY project_key` binds to _pk.project_key, which is NULL for the
    # cwd-less row and '(unfiled)' for the other, so they land in DIFFERENT
    # groups and emit TWO _ptok rows under ONE key. The project INSERT then fans
    # out on them and trips UNIQUE(project_key, day); .bail on rolls the whole
    # rebuild back, and the SessionEnd hook runs the rollup as
    # `--quiet >/dev/null 2>&1 || true`, so the tracker would just silently stop
    # updating with no visible error.
    #
    # 0 of 26,858 real requests have a null or empty cwd, so nothing but this
    # fixture reaches it -- which is exactly why it needs a fixture.
    sess s1 0
    ev   s1 0   SessionStart
    ev   s1 600 Stop
    ev   s1 900 SessionEnd
    req  r_unfiled s1 300 /tmp/fx 1000 0 11 130 17
    req  r_emptycwd s1 400 '' 2000 0 23 370 29
    req  r_nullcwd  s1 500 '' 4000 0 31 510 37
    fx_sql "UPDATE claude_requests SET cwd = NULL WHERE request_id = 'r_nullcwd';"
    ;;
  context-unread-session)
    # One local day, two sessions. S_READ has two status-line snapshots at 40%
    # and 60% (its own average: 50%); S_UNREAD has NO snapshot at all -- the
    # shape of ~90% of real sessions (pre-status-line, or `claude -p`). The
    # day's average context is 50%: an unread session has no reading, and
    # must not be averaged in as an empty window (which gave 25%, and ~10x
    # low on the live copy -- Stage 3D fix wave, I5).
    sess S_READ 0
    ev S_READ 0    SessionStart
    ev S_READ 10   UserPromptSubmit
    ev S_READ 610  Stop
    ev S_READ 620  SessionEnd
    snap S_READ 100 "" "" ""
    snap S_READ 400 "" "" ""
    fx_sql "UPDATE claude_status_snapshots SET context_used_percentage=40.0 WHERE session_id='S_READ' AND ts=$((BASE + 100));"
    fx_sql "UPDATE claude_status_snapshots SET context_used_percentage=60.0 WHERE session_id='S_READ' AND ts=$((BASE + 400));"
    sess S_UNREAD 1000
    ev S_UNREAD 1000  SessionStart
    ev S_UNREAD 1010  UserPromptSubmit
    ev S_UNREAD 1310  Stop
    ev S_UNREAD 1320  SessionEnd
    ;;
  tokens-only-day)
    # A day with requests and NO sessions at all. Must produce a daily row with
    # active_ms 0, sessions_count 0, non-zero tokens, and hygiene_score 0.
    sess s1 0
    ev   s1 0   SessionStart
    ev   s1 300 SessionEnd
    req  r_future s_gone $((DAY * 3)) /tmp/fx 4242
    ;;
  hygiene-cases)
    # Stage 4B spec 4.4's four rows, one local day each (2025-06-15 .. 06-18),
    # one session per day. score = the measured terms x 100 / the most those
    # terms could reach that day: cache 25 if measured, context 30 if measured,
    # compact-vs-clear 25, focus 20 (a flat 10 when the window is 0).
    #
    # Days 1-3 share one event stream with KNOWN idle, so the focus term is
    # not a round number and any re-association of a sum would show:
    #   SessionStart +0
    #   UserPromptSubmit +10    gap 10 ends at a prompt       active 10,  window 10
    #   Stop +610               gap 600, a turn is open       active 600, window 600
    #   UserPromptSubmit +1510  gap 900 ends at a prompt:
    #                           think-capped at 300           active 300, window 900
    #   Stop +1810              gap 300, a turn is open       active 300, window 300
    #   SessionEnd +1820        the walk-away counts 0
    #   -> active 1210 s, window 1810 s, idle 600 s
    #   focus = 20 x (1 - 600000/1810000) = 13.370165745856353
    #
    # day 1  cache measured + context reading (row 1: never rewritten)
    #   900 read / 100 written -> 90% -> 22.5; peak 88, no compacts
    #   -> 30 - (88-85) x 2 = 24; no compacts or clears -> 18
    #   (22.5 + 24 + 18 + focus) = 77.870165745856...    out of 100
    # day 2  no request + context reading (row 2: today's cache rescale)
    #   cache NULL; peak 50 -> 30; 1 compact, 0 clears -> 25
    #   (0 + 30 + 25 + focus) x 100/75 = 91.160220994475...
    # day 3  cache measured, NO snapshot (row 3: new, 70)
    #   800 / 200 -> 80% -> 20; context unmeasured; 18
    #   (20 + 18 + focus) x 100 / (25 + 25 + 20) = 73.385951065509...
    # day 4  neither, and a ZERO window (row 4: new, 35)
    #   SessionStart then SessionEnd: window 0 -> focus a flat 10;
    #   1 compact and the session is a /clear -> 25 x 1/2 = 12.5
    #   (0 + 12.5 + 10) x 100 / (25 + 10) = 64.285714285714...
    # Snapshots carry no cost (NULL), so no cost figure moves.
    for k in 1 2 3; do
      o=$(( (k - 1) * DAY ))
      sess "S_HC$k" "$o"
      ev "S_HC$k" "$o"                 SessionStart
      ev "S_HC$k" "$(( o + 10 ))"      UserPromptSubmit
      ev "S_HC$k" "$(( o + 610 ))"     Stop
      ev "S_HC$k" "$(( o + 1510 ))"    UserPromptSubmit
      ev "S_HC$k" "$(( o + 1810 ))"    Stop
      ev "S_HC$k" "$(( o + 1820 ))"    SessionEnd
      fx_sql "UPDATE claude_sessions SET ended_at=$(( BASE + o + 1820 )) WHERE session_id='S_HC$k';"
    done
    req  R_HC1 S_HC1 300 /tmp/fx 1000 0 11 900 100
    snap S_HC1 100 "" "" ""
    fx_sql "UPDATE claude_status_snapshots SET context_used_percentage=88.0 WHERE session_id='S_HC1';"
    snap S_HC2 $(( DAY + 100 )) "" "" ""
    fx_sql "UPDATE claude_status_snapshots SET context_used_percentage=50.0 WHERE session_id='S_HC2';"
    fx_sql "UPDATE claude_sessions SET compacts=1 WHERE session_id='S_HC2';"
    req  R_HC3 S_HC3 $(( 2 * DAY + 300 )) /tmp/fx 1000 0 11 800 200
    sess S_HC4 $(( 3 * DAY ))
    ev   S_HC4 $(( 3 * DAY ))        SessionStart
    ev   S_HC4 $(( 3 * DAY + 300 ))  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$(( BASE + 3 * DAY + 300 )), compacts=1, source='clear' WHERE session_id='S_HC4';"
    ;;
  live)
    # The Live view. Every honesty rule on that page has a case here:
    #   - the latest 5h reading is 108%, ABOVE 100 and not to be clamped
    #   - a LATER snapshot carries NULL, so "latest non-NULL" and "latest" differ
    #   - the 7d column is NULL throughout: an absent gauge, not a 0% one
    #   - the session is open (SessionStart, no SessionEnd) and its cost is
    #     cumulative across three snapshots, so MAX and SUM disagree
    #   - requests sit both inside and outside the 5-minute burn window that
    #     ends at BASE+400
    sess S_LIVE 0
    ev   S_LIVE 0   SessionStart
    ev   S_LIVE 10  UserPromptSubmit
    ev   S_LIVE 200 Stop
    snaprl S_LIVE 0   45.0  ''
    snaprl S_LIVE 60  108.0 ''
    snaprl S_LIVE 120 ''    ''
    req  r_old  S_LIVE 50  /tmp/fx 5000
    req  r_in1  S_LIVE 200 /tmp/fx 1200
    req  r_in2  S_LIVE 350 /tmp/fx 800
    ;;
  history)
    # The History view. Six consecutive local days (BASE is Sunday 2025-06-15,
    # 15:06 UTC), one honesty case each:
    #   d0 Sun  covered session: a cache reading, hygiene out of 100
    #   d1 Mon  session, NO request: cache NULL, window > 0 -> rescaled /75
    #   d2 Tue  session, zero window, no request -> rescaled /65
    #   d3 Wed  tokens only, no session: hygiene stored as 0, must read as NONE,
    #           and the trend line must BREAK here rather than dive to 0
    #   d4 Thu  no row at all: a calendar gap, and a second streak break
    #   d5 Fri  covered session again, so the line visibly resumes
    # Session days d0-d2 are the longest streak (3); d5 alone is the current one.
    #
    # Context readings (the average context trend, guard 1): only d0 and d5 have
    # status-line snapshots -- d0 averages 20% over two, d5 reads 40%. d1 and d2
    # have a rollup row and sessions but NO snapshot of their own, so rollup.sh
    # stores their avg_context_pct as NULL (it stored 0 before the Stage 3D fix
    # wave, I5). Either way it is not a measurement; the trend draws those days
    # as gaps.
    # d1 does carry ONE snapshot -- from S_H0, started on d0 (20%, so S_H0 still
    # averages 20) -- the live copy's 2026-09-20 case: a snapshot on the day is
    # not a reading of the day's own sessions. Snapshots carry
    # no cost (NULL) and a peak far under 85%, so no cost, hygiene or rank
    # figure of this scenario moves.
    sess S_H0 0
    ev S_H0 0    SessionStart
    ev S_H0 10   UserPromptSubmit
    ev S_H0 610  Stop
    ev S_H0 620  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + 620)) WHERE session_id='S_H0';"
    req R_H0 S_H0 300 /tmp/fx 1000 0 11 900 100
    snap S_H0 100 "" "" ""
    snap S_H0 400 "" "" ""
    fx_sql "UPDATE claude_status_snapshots SET context_used_percentage=30.0 WHERE session_id='S_H0' AND ts=$((BASE + 400));"
    snap S_H0 $((DAY + 100)) "" "" ""
    fx_sql "UPDATE claude_status_snapshots SET context_used_percentage=20.0 WHERE session_id='S_H0' AND ts=$((BASE + DAY + 100));"

    sess S_H1 $DAY
    ev S_H1 $DAY            SessionStart
    ev S_H1 $((DAY + 10))   UserPromptSubmit
    ev S_H1 $((DAY + 610))  Stop
    ev S_H1 $((DAY + 620))  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + DAY + 620)) WHERE session_id='S_H1';"

    sess S_H2 $((DAY * 2))
    ev S_H2 $((DAY * 2))        SessionStart
    ev S_H2 $((DAY * 2 + 300))  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + DAY * 2 + 300)) WHERE session_id='S_H2';"

    req R_H3 s_gone $((DAY * 3)) /tmp/fx 4242

    sess S_H5 $((DAY * 5))
    ev S_H5 $((DAY * 5))        SessionStart
    ev S_H5 $((DAY * 5 + 10))   UserPromptSubmit
    ev S_H5 $((DAY * 5 + 20))   UserPromptSubmit
    ev S_H5 $((DAY * 5 + 610))  Stop
    ev S_H5 $((DAY * 5 + 620))  SessionEnd
    fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + DAY * 5 + 620)) WHERE session_id='S_H5';"
    req R_H5 S_H5 $((DAY * 5 + 300)) /tmp/fx 2000 0 11 900 100
    snap S_H5 $((DAY * 5 + 100)) "" "" ""
    fx_sql "UPDATE claude_status_snapshots SET context_used_percentage=40.0 WHERE session_id='S_H5';"
    ;;
  dashboard)
    # The Projects and Skills views. Three local days from BASE (Sun 2025-06-15),
    # one honesty case per line:
    #   - S_A's lines are CUMULATIVE across three snapshots: MAX per session is
    #     100 / 20, a SUM across rows is 150 / 27
    #   - R_G's session_id has NO claude_sessions row (the 22.4% case): joining
    #     requests through claude_sessions drops it and its tokens
    #   - skipme is excluded (run with WATCHTOWER_EXCLUDE_PATHS=*/skipme): its
    #     session, lines and tokens must appear under no project
    #   - R_U has no cwd a project resolves from and no branch: (unfiled), and
    #     "(no branch)" rather than a blank
    #   - R_A2 is a subagent request; R_A3 carries an API error
    # Token values are distinct in every column so a row under the wrong key
    # cannot pass for the right one by arithmetic coincidence.
    fxroot="$(dirname "$db")/tree"
    mkdir -p "$fxroot/proj-alpha" "$fxroot/proj-beta" "$fxroot/skipme"
    git -C "$fxroot/proj-alpha" init -q 2>/dev/null
    git -C "$fxroot/proj-beta"  init -q 2>/dev/null
    for pair in "S_A:0:$fxroot/proj-alpha" "S_B:$DAY:$fxroot/proj-beta" "S_EX:$((DAY + 3600)):$fxroot/skipme"; do
      sid="${pair%%:*}"; rest="${pair#*:}"; off="${rest%%:*}"; dir="${rest#*:}"
      sess "$sid" "$off"
      ev "$sid" "$off"             SessionStart
      ev "$sid" $(( off + 10 ))    UserPromptSubmit
      ev "$sid" $(( off + 610 ))   Stop
      ev "$sid" $(( off + 620 ))   SessionEnd
      fx_sql "UPDATE claude_events   SET cwd=$(cc_sqlstr "$dir") WHERE session_id='$sid';"
      fx_sql "UPDATE claude_sessions SET ended_at=$((BASE + off + 620)), cwd=$(cc_sqlstr "$dir")
              WHERE session_id='$sid';"
    done
    snap S_A 100 0 0 0.5 10 2
    snap S_A 300 0 0 1.0 40 5
    snap S_A 610 0 0 1.5 100 20
    snap S_B $((DAY + 100)) 0 0 0.2 5 1
    snap S_B $((DAY + 610)) 0 0 0.8 30 3
    snap S_EX $((DAY + 3610)) 0 0 9.0 999 999
    fx_sql "UPDATE claude_status_snapshots SET cwd=$(cc_sqlstr "$fxroot/proj-alpha") WHERE session_id='S_A';"
    fx_sql "UPDATE claude_status_snapshots SET cwd=$(cc_sqlstr "$fxroot/proj-beta")  WHERE session_id='S_B';"
    fx_sql "UPDATE claude_status_snapshots SET cwd=$(cc_sqlstr "$fxroot/skipme")     WHERE session_id='S_EX';"

    req R_A1 S_A    200 "$fxroot/proj-alpha" 1301 0 11 130 17
    req R_A2 S_A    250 "$fxroot/proj-alpha"  907 1 13 190 19
    req R_A3 S_A    400 "$fxroot/proj-alpha"  503 0 17   0  0
    req R_B1 S_B    $((DAY + 200)) "$fxroot/proj-beta" 2111 0 23 370 29
    req R_G  S_GHOST $((DAY + 300)) "$fxroot/proj-beta" 2903 0 31 510 37
    req R_EX S_EX   $((DAY + 3700)) "$fxroot/skipme"   4507 0 41 730 43
    req R_U  S_GHOST $((DAY * 2 + 100)) /tmp/fx          601 0 47 0 0
    fx_sql "UPDATE claude_requests SET git_branch='main', model='claude-opus-5',
              attribution_skill='fx-skill' WHERE request_id='R_A1';"
    fx_sql "UPDATE claude_requests SET git_branch='feature/x', model='claude-haiku-4-5'
              WHERE request_id='R_A2';"
    fx_sql "UPDATE claude_requests SET git_branch='main', model='claude-opus-5',
              attribution_mcp_server='fx-mcp', attribution_mcp_tool='search',
              api_error_status='529' WHERE request_id='R_A3';"
    fx_sql "UPDATE claude_requests SET git_branch='main', model='claude-sonnet-5',
              attribution_plugin='fx-plugin' WHERE request_id='R_B1';"
    fx_sql "UPDATE claude_requests SET git_branch='dev', model='claude-sonnet-5',
              attribution_skill='fx-skill' WHERE request_id='R_G';"
    fx_sql "UPDATE claude_requests SET git_branch='secret', model='claude-opus-5'
              WHERE request_id='R_EX';"
    fx_sql "UPDATE claude_requests SET git_branch=NULL, model='claude-opus-5'
              WHERE request_id='R_U';"
    # S_A names its terminal; S_B and S_EX recorded none. The terminal
    # breakdown must show the NULLs as "unknown" rather than drop them.
    fx_sql "UPDATE claude_sessions SET terminal_app='ghostty' WHERE session_id='S_A';"
    # Effort, for the Models & Skills effort mix: two named levels, and four
    # requests that recorded none -- R_A3 as an empty string, R_A2, R_EX and
    # R_U as NULL. All four are one "not recorded" row, never dropped.
    fx_sql "UPDATE claude_requests SET effort=$(cc_sqlstr high)   WHERE request_id IN ('R_A1', 'R_G');"
    fx_sql "UPDATE claude_requests SET effort=$(cc_sqlstr medium) WHERE request_id='R_B1';"
    fx_sql "UPDATE claude_requests SET effort='' WHERE request_id='R_A3';"
    ;;
  sessions-cap)
    # The Sessions page's cap: 501 sessions, one request each, a minute apart,
    # so the newest 500 are shown and S000 is the one left out. Built in ONE
    # statement per table (a recursive CTE), not 1,500 sqlite3 spawns.
    #   - every session has a claude_sessions row; terminal cycles
    #     ghostty / NULL / warp
    #   - even sessions have TWO snapshots whose cost is cumulative (i/100, then
    #     i/50): MAX is i/50, a SUM is 3i/100. Odd sessions have none: no cost
    #     reading, which is null and never $0.00
    fx_sql "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
            INSERT INTO claude_sessions (session_id, started_at, updated_at, cwd, repo, prompts, terminal_app)
            SELECT printf('S%03d', i), $BASE + i * 60, $BASE + i * 60, $CWD_FX, $REPO_FX, 1,
                   CASE i % 3 WHEN 0 THEN 'ghostty' WHEN 1 THEN NULL ELSE 'warp' END FROM n;"
    fx_sql "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 500)
            INSERT INTO claude_requests (request_id, session_id, ts, cwd, model, tokens_in, tokens_out,
                                         tokens_cache_read, tokens_cache_creation, is_sidechain, ingested_at)
            SELECT printf('R%03d', i), printf('S%03d', i), $BASE + i * 60 + 5, $CWD_FX, 'fx-model',
                   10 + i, 100 + i, 1000, 50, 0, $BASE FROM n;"
    fx_sql "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 2 FROM n WHERE i < 499),
                 k(j) AS (SELECT 1 UNION ALL SELECT 2)
            INSERT INTO claude_status_snapshots (session_id, ts, cwd, repo, model, total_cost_usd)
            SELECT printf('S%03d', i), $BASE + i * 60 + 10 * j, $CWD_FX, $REPO_FX, 'fx-model', i * j / 100.0
            FROM n, k;"
    ;;
  long-history-*)
    # The report budget (Stage 3D fix wave, I4): N consecutive days of one
    # 30-minute session each, spread over four git projects and three models,
    # each with a cost and a context reading. Cache traffic is uneven across a
    # week (one day in seven is mostly writes), so a week's hit rate by the
    # rollup's formula differs from a mean of its daily rates.
    # `long-history-365` is a year;
    # comparing it with a shorter build measures what one more day costs the
    # report. One statement per table (recursive CTEs), not thousands of spawns.
    n="${scenario#long-history-}"
    [[ "$n" =~ ^[0-9]+$ ]] || { echo "long-history-<days>: not a day count: $n" >&2; exit 1; }
    fxroot="$(dirname "$db")/tree"
    for p in 0 1 2 3; do mkdir -p "$fxroot/lh-$p"; git -C "$fxroot/lh-$p" init -q 2>/dev/null; done
    ROOT_FX="$(cc_sqlstr "$fxroot/lh-")"
    fx_sql "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < $n - 1)
            INSERT INTO claude_sessions (session_id, started_at, updated_at, ended_at, cwd, repo, prompts)
            SELECT printf('L%04d', i), $BASE + i * $DAY + 3600, $BASE + i * $DAY + 5420, $BASE + i * $DAY + 5420,
                   $ROOT_FX || (i % 4), $REPO_FX, 1 FROM n;"
    fx_sql "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < $n - 1),
                 k(off, name) AS (VALUES (0, $(cc_sqlstr SessionStart)), (10, $(cc_sqlstr UserPromptSubmit)),
                                         (1810, $(cc_sqlstr Stop)), (1820, $(cc_sqlstr SessionEnd)))
            INSERT INTO claude_events (ts, session_id, hook_event_name, cwd, repo)
            SELECT $BASE + i * $DAY + 3600 + off, printf('L%04d', i), name, $ROOT_FX || (i % 4), $REPO_FX FROM n, k;"
    fx_sql "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < $n - 1),
                 k(j) AS (VALUES (0), (1), (2))
            INSERT INTO claude_requests (request_id, session_id, ts, cwd, model, tokens_in, tokens_out,
                                         tokens_cache_read, tokens_cache_creation, is_sidechain, ingested_at,
                                         git_branch, attribution_skill)
            SELECT printf('LR%04d-%d', i, j), printf('L%04d', i), $BASE + i * $DAY + 3700 + j * 60,
                   $ROOT_FX || (i % 4),
                   CASE (i + j) % 3 WHEN 0 THEN 'claude-opus-5' WHEN 1 THEN 'claude-sonnet-5' ELSE 'claude-haiku-4-5' END,
                   10 + i, 100 + 7 * i + j, 1000 * (1 + i % 7), CASE WHEN i % 7 = 0 THEN 4000 ELSE 50 END, 0, $BASE,
                   'main', CASE WHEN j = 0 THEN 'fx-skill' END FROM n, k;"
    fx_sql "WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < $n - 1),
                 k(j) AS (VALUES (1), (2))
            INSERT INTO claude_status_snapshots (session_id, ts, cwd, repo, model, total_cost_usd, context_used_percentage)
            SELECT printf('L%04d', i), $BASE + i * $DAY + 3600 + 900 * j, $ROOT_FX || (i % 4), $REPO_FX, 'fx-model',
                   (1 + i % 7) * j / 4.0, 20.0 * j FROM n, k;"
    ;;
  density-*)
    # The report's growth at live density (Stage 4B fix round, I3). long-history
    # above is one session, one project and three unpriced models a day: its
    # charts are thin, and the report stayed inside its budget on it while the
    # live-shaped projection crossed 1 MB at ~11.5 months. This is N days
    # ending Sunday 2026-09-27 -- inside 2026, so every request is priced --
    # with, each day, four sessions in four of twelve git projects, twelve
    # requests over six models with the cache-write split, four skills, a cost
    # and a context reading per session, and one measured turn per session.
    # Comparing two lengths measures what a week of history costs each page.
    n="${scenario#density-}"
    [[ "$n" =~ ^[0-9]+$ ]] || { echo "density-<days>: not a day count: $n" >&2; exit 1; }
    fxroot="$(dirname "$db")/tree"
    for p in $(seq 0 11); do mkdir -p "$fxroot/dn-$p"; git -C "$fxroot/dn-$p" init -q 2>/dev/null; done
    ROOT_FX="$(cc_sqlstr "$fxroot/dn-")"
    START=$(( $(epoch 2026-09-27T00:00:00Z) - (n - 1) * DAY ))
    # s(i, s): session s of day i, from 02:00 UTC three hours apart, in project (i + 3s) % 12.
    SESS="WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < $n - 1),
               s(s) AS (VALUES (0), (1), (2), (3)),
               x AS (SELECT i, s, printf('D%04d-%d', i, s) AS sid, $START + i * $DAY + 7200 + s * 10800 AS t0,
                            $ROOT_FX || ((i + 3 * s) % 12) AS cwd FROM n, s)"
    fx_sql "$SESS INSERT INTO claude_sessions (session_id, started_at, updated_at, ended_at, cwd, repo, prompts)
            SELECT sid, t0, t0 + 1820, t0 + 1820, cwd, $REPO_FX, 1 FROM x;"
    fx_sql "$SESS, k(off, name) AS (VALUES (0, $(cc_sqlstr SessionStart)), (10, $(cc_sqlstr UserPromptSubmit)),
                                      (1810, $(cc_sqlstr Stop)), (1820, $(cc_sqlstr SessionEnd)))
            INSERT INTO claude_events (ts, session_id, hook_event_name, cwd, repo)
            SELECT t0 + off, sid, name, cwd, $REPO_FX FROM x, k;"
    fx_sql "$SESS, k(j) AS (VALUES (1), (2))
            INSERT INTO claude_status_snapshots (session_id, ts, cwd, repo, model, total_cost_usd, context_used_percentage)
            SELECT sid, t0 + 600 * j, cwd, $REPO_FX, 'fx-model', (1 + (i + s) % 5) * j / 4.0, 15.0 * j + i % 10 FROM x, k;"
    fx_sql "$SESS INSERT INTO claude_prompts (entry_uuid, session_id, ts_ms, kind)
            SELECT printf('DP%04d-%d', i, s), sid, (t0 + 10) * 1000, 'prompt' FROM x;"
    # Stage 7 (plan R7): the skill tag sits on j = 2, the last main-thread
    # request before each session's Stop, so the Stop's gap is skill time and
    # /character's budget pin measures real Skill use rows.
    fx_sql "$SESS, k(j) AS (VALUES (0), (1), (2))
            INSERT INTO claude_requests (request_id, session_id, ts, cwd, model, tokens_in, tokens_out,
                                         tokens_cache_read, tokens_cache_creation, cache_write_5m, cache_write_1h,
                                         speed, is_sidechain, entrypoint, ingested_at, git_branch, attribution_skill,
                                         first_ms, last_ms, sent_ms)
            SELECT printf('DR%04d-%d-%d', i, s, j), sid, t0 + 60 + 300 * j, cwd,
                   CASE (i + s + j) % 6 WHEN 0 THEN 'claude-opus-5' WHEN 1 THEN 'claude-sonnet-5'
                        WHEN 2 THEN 'claude-haiku-4-5' WHEN 3 THEN 'claude-fable-5'
                        WHEN 4 THEN 'claude-opus-4-8' ELSE 'claude-sonnet-4-6' END,
                   10 + j, 200 + i % 50 + 30 * s, 5000 * (1 + i % 3), 500, 300, 200,
                   'standard', 0, 'cli', $BASE, 'main',
                   CASE WHEN j = 2 THEN 'fx-skill-' || ((i + s) % 4) END,
                   (t0 + 60 + 300 * j) * 1000, (t0 + 60 + 300 * j) * 1000 + 2000 + 500 * j + 37 * (i % 11),
                   (t0 + 60 + 300 * j) * 1000 - 1000 FROM x, k;"
    ;;
  ticker-burst)
    # The Live ticker: a burst of 30 SubagentStop events between a prompt and
    # its Stop, then two SubagentStops in ANOTHER repo and one back in fx.
    # Newest first, a run of the same name and repo is one row: the burst is
    # one "SubagentStop x30" row, and the repo change splits the last three.
    sess S_T 0
    ev S_T 0  SessionStart
    ev S_T 5  UserPromptSubmit
    fx_sql "WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k + 1 FROM n WHERE k < 30)
            INSERT INTO claude_events (ts, session_id, hook_event_name, cwd, repo)
            SELECT $BASE + 10 + k, $(cc_sqlstr S_T), $(cc_sqlstr SubagentStop), $CWD_FX, $REPO_FX FROM n;"
    ev S_T 50 Stop
    ev S_T 60 UserPromptSubmit
    ev S_T 61 SubagentStop
    ev S_T 62 SubagentStop
    fx_sql "UPDATE claude_events SET repo=$(cc_sqlstr other) WHERE ts IN ($((BASE + 61)), $((BASE + 62)));"
    ev S_T 63 SubagentStop
    ;;
  profile-basic)
    # Stage 4A scoring, hand-computed (spec 4.2/4.3):
    #   session A: 12 requests, cache_read 205000, in 10, out 90 each
    #   session B:  8 requests, cache_read  20000, in 10, out 90 each
    # Both on 2026-09-10, spaced 60s apart so neither session is "long" (n<30,
    # span<2700s): A spans 660s, B spans 420s.
    #   median ctx  = (205000+20000)/2                       = 112500
    #     context = L(112500,60000,350000)
    #             = round(100*(1-(112500-60000)/290000))     = 82
    #   median n    = (12+8)/2                                = 10
    #     sessionLength = L(10,40,250) = 100          (v <= good)
    #   no long sessions -> compaction = 90
    #   ratio = (205000*12+20000*8)/((10+90)*20) = 2,620,000/2,000 = 1310
    #     efficiency = L(1310,10,45) = 0              (v >= bad)
    #   matrix = round(0.3*82+0.25*90+0.2*100+0.25*0) = round(67.1) = 67
    #   tier: 45<=67<75 -> Operator(1), points to next = 75-67 = 8
    D0="$(epoch 2026-09-10T00:00:00Z)"
    for i in $(seq 0 11); do
      req_at "RPFA$i" S_PF_A "$((D0 + 3600 + i * 60))" /tmp/fx 90 0 10 205000 0
    done
    for i in $(seq 0 7); do
      req_at "RPFB$i" S_PF_B "$((D0 + 20000 + i * 60))" /tmp/fx 90 0 10 20000 0
    done
    # ---- Task 3: the ten disciplines (spec 4.4). Nothing below adds, removes
    # or re-tokens a request, so every Matrix number above is unchanged.
    # Window W(2026-09-10) = [2026-08-12, 2026-09-10]. Everything on
    # 2026-08-01 below is OUTSIDE it (and outside every later day's window).
    #
    # Requests: A is interactive ('cli'), B is headless ('sdk-ts'). A's 12 on
    # claude-opus-5; B's 8 = 2 opus-5, 3 sonnet-5, 2 haiku and ONE
    # '<synthetic>' row carrying a 429 (the live synthetic rows ARE the API
    # error rows).
    #   models (excl. <synthetic>) = 3; top = opus-5, 14 of 20 requests
    #   top_pct = round((14/20)*100) = 70
    for i in $(seq 0 11); do req_meta "RPFA$i" claude-opus-5 cli; done
    req_meta RPFB0 claude-opus-5 sdk-ts
    req_meta RPFB1 claude-opus-5 sdk-ts
    req_meta RPFB2 claude-sonnet-5 sdk-ts
    req_meta RPFB3 claude-sonnet-5 sdk-ts
    req_meta RPFB4 claude-sonnet-5 sdk-ts
    req_meta RPFB5 claude-haiku-4-5 sdk-ts
    req_meta RPFB6 claude-haiku-4-5 sdk-ts
    req_meta RPFB7 '<synthetic>' sdk-ts 429
    # Tool calls, main thread, on 2026-09-10 -- 20 counted:
    #   Read x5, Grep x2, Glob x1           inspect = 8   -> 8/20 = 0.4
    #   Bash x5 (2 errors), Edit x1 (error) errors  = 3   -> 3/20 = 0.15
    #   Task x1, Agent x1                   subagent launches = 2
    #   mcp__alpha__ x2, mcp__beta__ x1     mcp_calls = 3, mcp_servers = 2
    #   Write x1 whose result never came    UNRESOLVED: a call, not an error
    T=$((D0 + 30000))
    n=0
    for spec in Read:0 Read:0 Read:0 Read:0 Read:0 Grep:0 Grep:0 Glob:0 \
                Bash:1 Bash:1 Bash:0 Bash:0 Bash:0 Edit:1 Task:0 Agent:0 \
                mcp__alpha__search:0 mcp__alpha__fetch:0 mcp__beta__run:0 Write:; do
      tc_at "TPF$n" S_PF_A "$((T + n * 10))" "${spec%%:*}" "${spec#*:}" 0
      n=$((n + 1))
    done
    # NOT counted: four SIDECHAIN calls (TheOne reads top-level transcripts
    # only), a result-only row with no tool name, and the coverage anchor on
    # 2026-08-01 (main thread, so coverage_start = 2026-08-01 <= 2026-08-12:
    # the window is tool-covered).
    tc_at TPFS0 S_PF_A "$((T + 500))" Bash 1 1
    tc_at TPFS1 S_PF_A "$((T + 510))" Bash 1 1
    tc_at TPFS2 S_PF_A "$((T + 520))" Read 0 1
    tc_at TPFS3 S_PF_A "$((T + 530))" mcp__gamma__x 0 1
    tc_at TPFR0 '' '' '' 1 ''
    tc_at TPFC0 S_PF_OLD "$(epoch 2026-08-01T12:00:00Z)" Read 0 0
    # Slash commands on 2026-09-10: /compact x4, /clear, /model
    #   slash_kinds = 3, slash_max_repeat = 4 (/compact). /review on 2026-08-01
    #   is outside the window.
    n=0
    for c in /compact /compact /compact /compact /clear /model; do
      sl_at "SPF$n" S_PF_A "$((T + 1000 + n * 10))" "$c"
      n=$((n + 1))
    done
    sl_at SPFOLD S_PF_OLD "$(epoch 2026-08-01T12:00:00Z)" /review
    # Hook events on 2026-09-10: PreCompact x2 (compactions = 2); 10 prompts
    # carrying permission_mode, ONE of them bypassPermissions
    # (bypass_share = 1/10); 2 prompts with no permission_mode (not counted).
    # The 2026-08-01 PreCompact is outside the window.
    ev_at S_PF_A "$((T + 2000))" PreCompact '{"trigger":"auto"}'
    ev_at S_PF_A "$((T + 2010))" PreCompact '{"trigger":"manual"}'
    n=0
    for m in bypassPermissions auto auto auto auto auto default default default default; do
      ev_at S_PF_A "$((T + 3000 + n * 10))" UserPromptSubmit "{\"permission_mode\":\"$m\",\"prompt_len\":12}"
      n=$((n + 1))
    done
    ev_at S_PF_A "$((T + 3500))" UserPromptSubmit '{"prompt_len":7}'
    ev_at S_PF_A "$((T + 3510))" UserPromptSubmit '{"prompt_len":9}'
    ev_at S_PF_OLD "$(epoch 2026-08-01T12:00:00Z)" PreCompact '{"trigger":"auto"}'
    # Status-line snapshots (CUMULATIVE cost): A reads 0.50 then 1.25, B reads
    # 0.75 -> MAX per session = 1.25 and 0.75 -> cost_per_session = 1.00
    # (summing A's readings would give 1.25). S_PF_OLD's 9.00 is outside.
    snap_at S_PF_A "$((D0 + 7200))"  0.50
    snap_at S_PF_A "$((D0 + 10800))" 1.25
    snap_at S_PF_B "$((D0 + 21600))" 0.75
    snap_at S_PF_OLD "$(epoch 2026-08-01T12:00:00Z)" 9.00
    ;;
  profile-no-tools)
    # Review Focus 5, "upgrade before backfill": requests and hook events but
    # NOT ONE claude_tool_calls or claude_slash_commands row, so coverage_start
    # is NULL and tool_covered = 0 on every day.
    # 21 requests on 2026-09-10, both sessions HEADLESS (sdk-cli and sdk-ts),
    # cache_read 1000, in 10, out 90 each:
    #   S_NT_1: 11 requests, S_NT_2: 10.
    #   models: 14 opus-5, 4 sonnet-5, 2 haiku, 1 '<synthetic>' (a 429)
    #     top_pct = round((14/21)*100) = round(66.67) = 67 -- NOT a whole
    #     percent, so an unrounded top_pct shows here.
    # Events: 3 prompts with no permission_mode and one whose payload is not
    # JSON at all (json_extract would raise on it) -> security is undefined.
    # Hook data is NOT what is missing here: a SessionStart on 2026-07-01 is
    # the event-coverage anchor (Stage 4B spec 4.5), so W(2026-09-10) is
    # event-covered and compactions is a measured 0.
    D0="$(epoch 2026-09-10T00:00:00Z)"
    for i in $(seq 0 10); do
      req_at "RNT1_$i" S_NT_1 "$((D0 + 3600 + i * 60))" /tmp/fx 90 0 10 1000 0
      req_meta "RNT1_$i" claude-opus-5 sdk-cli
    done
    for i in $(seq 0 9); do
      req_at "RNT2_$i" S_NT_2 "$((D0 + 7200 + i * 60))" /tmp/fx 90 0 10 1000 0
    done
    for i in 0 1 2; do req_meta "RNT2_$i" claude-opus-5 sdk-ts; done
    for i in 3 4 5 6; do req_meta "RNT2_$i" claude-sonnet-5 sdk-ts; done
    for i in 7 8; do req_meta "RNT2_$i" claude-haiku-4-5 sdk-ts; done
    req_meta RNT2_9 '<synthetic>' sdk-ts 429
    ev_at S_NT_1 "$((D0 + 3500))" UserPromptSubmit '{"prompt_len":5}'
    ev_at S_NT_1 "$((D0 + 3510))" UserPromptSubmit '{}'
    ev_at S_NT_2 "$((D0 + 7100))" UserPromptSubmit
    ev_at S_NT_2 "$((D0 + 7110))" UserPromptSubmit 'not json {'
    ev_at S_NT_OLD "$(epoch 2026-07-01T12:00:00Z)" SessionStart
    ;;
  profile-zero-tools)
    # A tool-COVERED window with ZERO tool calls in it (spec 4.4's first
    # departure). The only tool call is the coverage anchor on 2026-07-01,
    # outside W(2026-09-10) = [2026-08-12, 2026-09-10], so tool_covered = 1
    # while tool_calls = 0. 20 requests in one session; the last carries a 529
    # -> success = 19/20.
    D0="$(epoch 2026-09-10T00:00:00Z)"
    for i in $(seq 0 19); do
      req_at "RZT$i" S_ZT "$((D0 + 3600 + i * 60))" /tmp/fx 90 0 10 1000 0
    done
    req_meta RZT19 claude-opus-5 cli 529
    tc_at TZTC0 S_ZT_OLD "$(epoch 2026-07-01T12:00:00Z)" Read 0 0
    ;;
  profile-ladder)
    # The tier boundary from both sides, and total week over week. No session
    # id, no tool row, no event, one model -- only five disciplines measure:
    #   session-hygiene: sessionLength undefined (no session), compaction 90,
    #                    compactions 0 -> mean(90, 0) = 45 -> 27
    #   model-routing:   1 model -> 0; top_pct 100 -> H(0, 0, .35) = 0 -> 0
    #   automation:      0 headless sessions -> 0
    #   output-quality:  success 1 -> 100 -> 60
    #   cost-discipline: L(ratio, 10, 45)
    # Day A (2026-09-01): 20 requests, cache_read 3800, in 10, out 90
    #   ratio 76000/2000 = 38 -> L = round(100*(1-28/35)) = 20 -> 12
    #   total = 27 + 0 + 0 + 60 + 12 = 99 -> Noobie (0), 1 point to next
    # Day A+7 (2026-09-08): 20 more requests, cache_read 3700; W holds both
    #   ratio (76000+74000)/4000 = 37.5 -> L = round(21.43) = 21 -> 13
    #   total = 100 -> Explorer (1), 100 points to next; total_wow = 100 - 99 = 1
    # "No event" above means no PreCompact and no prompt: ONE SessionStart on
    # 2026-07-01 is the event-coverage anchor (Stage 4B spec 4.5), so every
    # window here is event-covered and compactions is a MEASURED 0. Without it
    # the part is undefined and session-hygiene reads mean(90) = 90 -> 54.
    D0="$(epoch 2026-09-01T00:00:00Z)"
    for i in $(seq 0 19); do
      req_at "RLDA$i" '' "$((D0 + 3600 + i * 60))" /tmp/fx 90 0 10 3800 0
    done
    D1="$(epoch 2026-09-08T00:00:00Z)"
    for i in $(seq 0 19); do
      req_at "RLDB$i" '' "$((D1 + 3600 + i * 60))" /tmp/fx 90 0 10 3700 0
    done
    ev_at S_LD_ANCHOR "$(epoch 2026-07-01T12:00:00Z)" SessionStart
    ;;
  profile-ladder-top)
    # Every discipline at 60 -> 600, Master. One HEADLESS 30-request session
    # on 2026-09-10 (sdk-cli), in 100, out 300 each:
    #   cache_read 90000 on the first request, 1000 on the other 29: a reset
    #   (90000 > 80000 and 1000*2 < 90000) in a long (n = 30) session ->
    #   compaction 100; ctx = 119000/30 < 60000 -> context 100; median n 30
    #   -> sessionLength 100; ratio 119000/12000 < 10 -> efficiency 100.
    #   models: k % 4 over RTOP0..29 -> 8/8/7/7 of 4 models; top_pct 27.
    # 5 PreCompact; slash /compact x8 plus 4 other kinds; 3 prompts in
    # 'default' mode (no bypass). Tool calls: mcp x40 over 4 servers, Task x4,
    # Read x44 -> 88 calls, inspect 0.5, no error; runs = 1 + 4 = 5.
    # Coverage anchor on 2026-07-01, for tools and (Stage 4B spec 4.5) for hook
    # events: a SessionStart there makes W(2026-09-10) event-covered, so the
    # five PreCompacts and the three prompts score.
    D0="$(epoch 2026-09-10T00:00:00Z)"
    for i in $(seq 0 29); do
      cr=1000; [ "$i" -eq 0 ] && cr=90000
      req_at "RTOP$i" S_TOP "$((D0 + 3600 + i * 60))" /tmp/fx 300 0 100 "$cr" 0
    done
    fx_sql "UPDATE claude_requests
              SET entrypoint = $(cc_sqlstr sdk-cli),
                  model = CASE CAST(substr(request_id, 5) AS INTEGER) % 4
                            WHEN 0 THEN $(cc_sqlstr claude-opus-5)
                            WHEN 1 THEN $(cc_sqlstr claude-sonnet-5)
                            WHEN 2 THEN $(cc_sqlstr claude-haiku-4-5)
                            ELSE $(cc_sqlstr claude-fable-5) END
            WHERE session_id = $(cc_sqlstr S_TOP);"
    fx_sql "WITH RECURSIVE n(k) AS (SELECT 0 UNION ALL SELECT k + 1 FROM n WHERE k < 87)
            INSERT INTO claude_tool_calls
              (tool_use_id, session_id, ts, tool_name, mcp_server, is_error, is_sidechain)
            SELECT $(cc_sqlstr TTOP) || k, $(cc_sqlstr S_TOP), $((D0 + 40000)) + k,
                   CASE WHEN k < 40 THEN $(cc_sqlstr mcp__s) || (k % 4) || $(cc_sqlstr __call)
                        WHEN k < 44 THEN $(cc_sqlstr Task) ELSE $(cc_sqlstr Read) END,
                   CASE WHEN k < 40 THEN $(cc_sqlstr s) || (k % 4) END,
                   0, 0
            FROM n;"
    tc_at TTOPC0 S_TOP_OLD "$(epoch 2026-07-01T12:00:00Z)" Read 0 0
    ev_at S_TOP_OLD "$(epoch 2026-07-01T12:00:00Z)" SessionStart
    n=0
    for c in /compact /compact /compact /compact /compact /compact /compact /compact \
             /clear /model /review /init; do
      sl_at "STOP$n" S_TOP "$((D0 + 45000 + n * 10))" "$c"
      n=$((n + 1))
    done
    for i in 0 1 2 3 4; do ev_at S_TOP "$((D0 + 46000 + i * 10))" PreCompact '{"trigger":"auto"}'; done
    for i in 0 1 2; do
      ev_at S_TOP "$((D0 + 47000 + i * 10))" UserPromptSubmit '{"permission_mode":"default","prompt_len":3}'
    done
    ;;
  profile-gate)
    # Identical to profile-basic but 19 requests, not 20 (drop the last of B):
    # the row must still exist, with window_requests=19 and every score NULL.
    D0="$(epoch 2026-09-10T00:00:00Z)"
    for i in $(seq 0 11); do
      req_at "RGA$i" S_PF_A "$((D0 + 3600 + i * 60))" /tmp/fx 90 0 10 205000 0
    done
    for i in $(seq 0 6); do
      req_at "RGB$i" S_PF_B "$((D0 + 20000 + i * 60))" /tmp/fx 90 0 10 20000 0
    done
    ;;
  profile-reset-hit)
    # One 30-request session (n>=30 -> "long" on its own): cache_read climbs to
    # 90000 across the first 29 requests, then drops to 40000 on the 30th.
    # 90000 > 80000 and 40000*2 = 80000 < 90000 -> a reset. long_sessions=1,
    # long_with_reset=1 -> compaction = round(100*1/1) = 100.
    D0="$(epoch 2026-06-15T00:00:00Z)"
    for i in $(seq 0 28); do
      req_at "RRH$i" S_PF_R "$((D0 + i * 60))" /tmp/fx 90 0 10 90000 0
    done
    req_at RRH29 S_PF_R "$((D0 + 29 * 60))" /tmp/fx 90 0 10 40000 0
    ;;
  profile-reset-miss)
    # Same shape, but the peak (70000) never exceeds the 80000 floor a reset
    # requires: long_sessions=1, long_with_reset=0 -> compaction = 0.
    D0="$(epoch 2026-06-15T00:00:00Z)"
    for i in $(seq 0 28); do
      req_at "RRM$i" S_PF_R "$((D0 + i * 60))" /tmp/fx 90 0 10 70000 0
    done
    req_at RRM29 S_PF_R "$((D0 + 29 * 60))" /tmp/fx 90 0 10 30000 0
    ;;
  profile-long-span)
    # Session C: 5 requests spanning exactly 2700s (45 min, 4 gaps of 675s) --
    # "long" by SPAN even though n=5 is nowhere near the 30-request floor.
    # Session D: 20 filler requests, tightly spaced (not long), so the day's
    # window_requests is 5+20=25 -- comfortably clear of the 20-request gate on
    # EITHER side of it (unlike profile-basic, which sits exactly on the
    # boundary per the brief's own numbers), so this scenario cannot also flip
    # under the "<= 20" gate-boundary plant.
    D0="$(epoch 2026-09-10T00:00:00Z)"
    for i in $(seq 0 4); do
      req_at "RLSC$i" S_PF_LONG "$((D0 + 3600 + i * 675))" /tmp/fx 90 0 10 1000 0
    done
    for i in $(seq 0 19); do
      req_at "RLSD$i" S_PF_FILL "$((D0 + 40000 + i * 60))" /tmp/fx 90 0 10 1000 0
    done
    ;;
  profile-wow)
    # Deliberately ONE session per week (not profile-basic's two): a median
    # over a single value is the same number under EITHER median convention,
    # so this scenario cannot ALSO flip under a median-idiom defect planted
    # elsewhere. Both weeks also share the SAME cache_read/request (89000),
    # chosen so f_context == f_compaction == 90 for BOTH weeks -- so this
    # scenario's matrix_7d/matrix_wow numbers are unmoved by a defect that
    # swaps the context/compaction WEIGHTS (0.3 <-> 0.25), too: only the
    # session's fresh-token total differs between the weeks, moving the
    # (unweight-swapped) efficiency factor and nothing else.
    #
    # Day A (2026-09-10): one session, 20 requests, cache_read 89000, in 10,
    # out 90 each (fresh 100/req).
    #   f_context = L(89000,60000,350000) = round(100*(1-29000/290000)) = 90
    #   f_sessionLength = L(20,40,250) = 100 (v <= good)
    #   no long session -> f_compaction = 90
    #   ratio = (89000*20)/(100*20) = 890 -> f_efficiency = L(890,10,45) = 0 (v >= bad)
    #   matrix_7d(A) = round(0.3*90+0.25*90+0.2*100+0.25*0) = round(69.5) = 70
    # Its 7-days-PRIOR window ([8/28..9/3]) is empty -> matrix_wow(A) = NULL.
    #
    # Day B (2026-09-20): one session, 20 requests, cache_read 89000, in 1000,
    # out 8000 each (fresh 9000/req).
    #   f_context = 90, f_sessionLength = 100, f_compaction = 90 (as above)
    #   ratio = (89000*20)/(9000*20) = 89000/9000 = 9.888... -> f_efficiency
    #         = L(9.888,10,45) = 100 (v <= good)
    #   matrix_7d(B) = round(0.3*90+0.25*90+0.2*100+0.25*100) = round(94.5) = 95
    # B's 7-days-PRIOR window is [9/07..9/13], which contains ALL of day A's
    # requests (2026-09-10 falls inside it) and nothing else -> that week's
    # Matrix score is the same 70 as day A's own week.
    #   matrix_wow(B) = 95 - 70 = 25
    D0="$(epoch 2026-09-10T00:00:00Z)"
    for i in $(seq 0 19); do
      req_at "RWA$i" S_PF_WOW_A "$((D0 + 3600 + i * 60))" /tmp/fx 90 0 10 89000 0
    done
    D1="$(epoch 2026-09-20T00:00:00Z)"
    for i in $(seq 0 19); do
      req_at "RWB$i" S_PF_WOW_B "$((D1 + 3600 + i * 60))" /tmp/fx 8000 0 1000 89000 0
    done
    ;;
  profile-tz)
    # 19 filler requests at 2026-09-10T12:00:00Z (noon UTC -- unambiguously
    # 2026-09-10 in America/Los_Angeles too, UTC-7 in September) plus ONE
    # request at 2026-09-11T03:00:00Z, which is 2026-09-10T20:00 in
    # America/Los_Angeles but 2026-09-11 under UTC. Run with
    # TZ=America/Los_Angeles: window_requests for 2026-09-10 must be 20, not
    # 19 -- proof the day-bucketing is done in LOCAL time, not UTC (Review
    # Focus 3 / spec 4.1's local-day rule).
    # The boundary request gets its OWN session id: sharing the filler's would
    # give that session a ~15h span (noon 9/10 to 3am 9/11), incidentally
    # tripping the >=2700s "long session" rule and confusing this test's one
    # claim, which is about day-bucketing, not session length.
    D0="$(epoch 2026-09-10T12:00:00Z)"
    for i in $(seq 0 18); do
      req_at "RTZ$i" S_PF_TZ "$((D0 + i))" /tmp/fx 90 0 10 1000 0
    done
    req_at RTZ_BOUNDARY S_PF_TZ_B "$(epoch 2026-09-11T03:00:00Z)" /tmp/fx 90 0 10 1000 0
    # Final review M9: every OTHER per-day table must bucket locally too. At
    # the same 03:00Z instant (2026-09-10 in Los Angeles, 2026-09-11 in UTC):
    # one main-thread MCP tool call, one slash command, one PreCompact and one
    # status snapshot -- each counts in W(2026-09-10) = [08-12, 09-10] only if
    # its day is local. The coverage anchor, the earliest main-thread tool
    # call, is at 2026-08-13T03:00Z: local day 2026-08-12, EXACTLY W's first
    # day (covered), but UTC day 2026-08-13 (not covered). In Los Angeles:
    #   tool_covered = 1; tool_calls = 2 (the anchor and the MCP call);
    #   mcp_calls = 1, mcp_servers = 1; slash_kinds = 1; compactions = 1;
    #   cost_per_session = 2.5.
    # Stage 4B spec 4.5: event coverage has the same kind of anchor, a
    # SessionStart at the same 2026-08-13T03:00Z. event_start is local
    # 2026-08-12 = W's first day, so the window is event-covered and the
    # PreCompact scores (compactions = 1); bucketed in UTC it would be
    # 2026-08-13, the window uncovered and compactions undefined.
    TZB="$(epoch 2026-09-11T03:00:00Z)"
    tc_at TTZ_ANCHOR S_PF_TZ_B "$(epoch 2026-08-13T03:00:00Z)" Read 0 0
    ev_at S_PF_TZ_EV "$(epoch 2026-08-13T03:00:00Z)" SessionStart
    tc_at TTZ_MCP S_PF_TZ_B "$TZB" mcp__tzsrv__run 0 0
    sl_at STZ0 S_PF_TZ_B "$TZB" /compact
    ev_at S_PF_TZ_B "$TZB" PreCompact '{"trigger":"auto"}'
    snap_at S_PF_TZ_B "$TZB" 2.5
    ;;
  profile-window-edge)
    # Final review I1: both edges of the 30-day window, and the tool-coverage
    # boundary, each sat on exactly. D = 2026-09-10, W(D) = [2026-08-12, D].
    #   20 requests on D, one session -> ungated.
    #   2026-08-12 (D-29): 1 request + 1 PreCompact, INSIDE W(D) -- counted.
    #   2026-08-11 (D-30): 1 request + 1 PreCompact, OUTSIDE W(D) -- not.
    #   -> window_requests(D) = 21 (a 31-day window gives 22, a 29-day one
    #      20), compactions(D) = 1.
    # Tool coverage: the ONLY main-thread tool call is on 2026-08-12, so
    # coverage_start = 2026-08-12 = W(D)'s first day -> tool_covered(D) = 1 (a
    # window starting ON coverage_start is covered); W(D-1) starts 2026-08-11,
    # one day earlier -> tool_covered(D-1) = 0. The call is itself inside
    # W(D): tool_calls(D) = 1. Everything at noon UTC, clear of any day edge.
    D0="$(epoch 2026-09-10T00:00:00Z)"
    for i in $(seq 0 19); do
      req_at "RWE$i" S_WE "$((D0 + 3600 + i * 60))" /tmp/fx 90 0 10 1000 0
    done
    IN="$(epoch 2026-08-12T12:00:00Z)"
    OUT="$(epoch 2026-08-11T12:00:00Z)"
    req_at RWE_IN S_WE_IN "$IN" /tmp/fx 90 0 10 1000 0
    req_at RWE_OUT S_WE_OUT "$OUT" /tmp/fx 90 0 10 1000 0
    ev_at S_WE_IN "$IN" PreCompact '{"trigger":"auto"}'
    ev_at S_WE_OUT "$OUT" PreCompact '{"trigger":"auto"}'
    tc_at TWE_IN S_WE_IN "$IN" Read 0 0
    ;;
  profile-event-edge)
    # Stage 4B spec 4.5, event coverage. Requests from 2026-08-01, hook events
    # (claude_events) only from 2026-08-20 -> event_start = 2026-08-20.
    # W(D) is event-covered when D-29 >= event_start:
    #   W(2026-09-17) = [08-19, 09-17] starts a day early   -> event_covered 0
    #   W(2026-09-18) = [08-20, 09-18] starts ON event_start -> event_covered 1
    # Both windows hold exactly the same rows: the 20 requests of S_EE on
    # 2026-09-10 (ungated; the 08-01 request is outside both), the PreCompact
    # on 08-20 and the 09-10 events -- so the ONLY difference between the two
    # days is coverage.
    #   one session, 20 requests, cache_read 1000, in 10, out 90 each:
    #     sessionLength L(20, 40, 250) = 100; no long session -> compaction 90
    #   compactions = 2 (08-20 and 09-10) -> clamp(2 x 20) = 40
    #   10 prompts with a permission mode, 1 bypassPermissions -> 0.10
    #     -> L(0.10, 0.02, 0.25) = round(65.2) = 65
    # 09-18, covered (today's arithmetic):
    #   session-hygiene mean(100, 90, 40) = 76.67 -> round(46.0) = 46, strong
    #   security 65 -> round(39.0) = 39, ok
    # 09-17, NOT covered: the compactions part is undefined, security has no
    # input at all:
    #   session-hygiene mean(100, 90) = 95 -> round(57.0) = 57, strong
    #   security needs-data, 0
    D0="$(epoch 2026-09-10T00:00:00Z)"
    req_at Ree_OLD S_EE_OLD "$(epoch 2026-08-01T12:00:00Z)" /tmp/fx 90 0 10 1000 0
    for i in $(seq 0 19); do
      req_at "REE$i" S_EE "$((D0 + 3600 + i * 60))" /tmp/fx 90 0 10 1000 0
    done
    ev_at S_EE_START "$(epoch 2026-08-20T12:00:00Z)" PreCompact '{"trigger":"auto"}'
    ev_at S_EE "$((D0 + 5000))" PreCompact '{"trigger":"manual"}'
    n=0
    for m in bypassPermissions auto auto auto auto default default default default default; do
      ev_at S_EE "$((D0 + 6000 + n * 10))" UserPromptSubmit "{\"permission_mode\":\"$m\",\"prompt_len\":4}"
      n=$((n + 1))
    done
    ;;
  profile-no-session)
    # 25 requests with an EMPTY session_id (spec 4.1's "unattributed" bucket) --
    # clear of the 20-request gate boundary on either side of it, unlike
    # profile-basic, so the "<= 20" gate-boundary plant cannot also flip this
    # test. No session exists to measure, so median_ctx/median_requests/
    # f_context/f_session_length must all be NULL -- but the tokens still count
    # toward the window-wide efficiency ratio, which is ungated by session
    # attribution. ratio = (1000*25)/((10+90)*25) = 25000/2500 = 10.
    D0="$(epoch 2026-09-10T00:00:00Z)"
    for i in $(seq 0 24); do
      req_at "RNS$i" '' "$((D0 + 3600 + i * 60))" /tmp/fx 90 0 10 1000 0
    done
    ;;
  zero-cost)
    # Stage 4B fix round, I1: a status-line cost of exactly 0 is NOT a reading.
    # 786 live sessions carry MAX(total_cost_usd) = 0 (719 of them one snapshot
    # long); counted as readings they printed "$0.00" as Claude Code's figure
    # beside a real cost at API prices. Two local days, one session, one project
    # and one priced request each:
    #   2026-09-10  S_Z0 in zero-proj: ONE snapshot, total_cost_usd = 0. The
    #               day, the project and the session have no reading.
    #   2026-09-11  S_ZP in pos-proj: a 0 snapshot, then 1.25. A reading, $1.25:
    #               the 0 that came first does not make it "no reading".
    fxroot="$(dirname "$db")/tree"
    mkdir -p "$fxroot/zero-proj" "$fxroot/pos-proj"
    git -C "$fxroot/zero-proj" init -q 2>/dev/null
    git -C "$fxroot/pos-proj"  init -q 2>/dev/null
    for spec in "S_Z0:2026-09-10:zero-proj" "S_ZP:2026-09-11:pos-proj"; do
      sid="${spec%%:*}"; rest="${spec#*:}"; d="${rest%%:*}"; dir="$fxroot/${rest#*:}"
      T="$(epoch "${d}T10:00:00Z")"
      fx_sql "INSERT INTO claude_sessions (session_id, started_at, updated_at, ended_at, cwd, repo, prompts)
              VALUES ($(cc_sqlstr "$sid"), $T, $T, $((T + 620)), $(cc_sqlstr "$dir"), $REPO_FX, 1);"
      ev_at "$sid" "$T"           SessionStart
      ev_at "$sid" "$((T + 10))"  UserPromptSubmit
      ev_at "$sid" "$((T + 610))" Stop
      ev_at "$sid" "$((T + 620))" SessionEnd
      fx_sql "UPDATE claude_events SET cwd=$(cc_sqlstr "$dir") WHERE session_id=$(cc_sqlstr "$sid");"
    done
    T0="$(epoch 2026-09-10T10:00:00Z)"; T1="$(epoch 2026-09-11T10:00:00Z)"
    snap_at S_Z0 "$((T0 + 300))" 0
    snap_at S_ZP "$((T1 + 100))" 0
    snap_at S_ZP "$((T1 + 300))" 1.25
    # (1000*5 + 2000*25) / 1e6 = 0.055 and (1000*1 + 1000*5) / 1e6 = 0.006
    reqp Z_R0 S_Z0 "$((T0 + 200))" "$fxroot/zero-proj" claude-opus-5    1000 2000 0 - - standard
    reqp Z_R1 S_ZP "$((T1 + 200))" "$fxroot/pos-proj"  claude-haiku-4-5 1000 1000 0 - - standard
    ;;
  price-rows)
    # One request per spec 4.1 model id: in 1000, out 2000, cache-read 3000,
    # cw5m 400, cw1h 600, speed standard.
    T="$(epoch 2026-09-10T12:00:00Z)"; i=0
    for m in claude-fable-5-1 claude-fable-5 claude-opus-5-5 claude-opus-5 claude-opus-4-8 \
             claude-opus-4-7 claude-sonnet-5-5 claude-sonnet-5 claude-sonnet-4-6 \
             claude-haiku-4-5 claude-haiku-4-5-20251001; do
      i=$(( i + 1 ))
      reqp "P_$m" S_PR "$((T + i))" /tmp/fx "$m" 1000 2000 3000 400 600 standard
    done
    ;;
  price-notes)
    T="$(epoch 2026-09-10T12:00:00Z)"
    reqp n_syn      S_PN "$((T + 1))" /tmp/fx '<synthetic>'      0    0    0 - - -
    reqp n_unk      S_PN "$((T + 2))" /tmp/fx claude-mystery-9   1000 2000 0 - - standard
    reqp n_fast     S_PN "$((T + 3))" /tmp/fx claude-opus-5      1000 2000 0 - - fast
    reqp n_nosplit  S_PN "$((T + 4))" /tmp/fx claude-opus-5      1000 2000 0 - - standard
    # The pre-backfill shape: a total with no split.
    fx_sql "UPDATE claude_requests SET tokens_cache_creation = 100 WHERE request_id = 'n_nosplit';"
    reqp n_absent   S_PN "$((T + 5))" /tmp/fx claude-opus-5      1000 2000 0 - - -
    reqp n_ok       S_PN "$((T + 6))" /tmp/fx claude-haiku-4-5   1000 1000 0 - - standard
    # M2 (fix round): exactly ONE cache-write side recorded. Priced -- the 1h
    # side at its rate, the NULL 5m side as 0 -- not no-split, which needs both
    # sides NULL. On a day of its own, outside every 7-day range the other
    # price-notes readers take, so their 2026-09-10 figures stay as they are.
    reqp n_oneside  S_PN "$(epoch 2026-08-10T12:00:00Z)" /tmp/fx claude-opus-5 1000 1000 0 - 600 standard
    ;;
  price-change)
    for d in 2025-12-31 2026-02-28 2026-03-01; do
      reqp "C_$d" S_PC "$(epoch ${d}T12:00:00Z)" /tmp/fx claude-opus-5 1000 0 0 - - standard
    done
    ;;
  model-mix)
    # Stage 6 (spec 4.3): Claude's hours by driving model, one session per day so
    # each guard reads its own day.
    # Day 0, S_MS: a gap before the first reply, Opus, a Haiku SIDECHAIN call,
    # then /model to Sonnet. The Sonnet request at 200 shares its second with
    # the Stop and counts as before it. Opus 10+50+40+50 = 150 s, Sonnet
    # 50+100+100 = 250 s; Haiku, claude-sonnet-4-6 and <synthetic> nothing.
    sess S_MS 0
    ev S_MS 0   SessionStart
    # A SIDECHAIN request before the first reply: guards the first-request
    # fallback (_sfm) against crediting the gap at 10 to a subagent's model.
    req ms_r0 S_MS 5   /tmp/fx 10 1
    req_meta ms_r0 claude-haiku-4-5 cli
    # A <synthetic> main-thread request is no model (spec 4.3 step 1). It is the
    # session's earliest main-thread row, so if let in it would take the gap at
    # 10 through _evm or through the _sfm fallback, either one.
    req ms_syn S_MS 7  /tmp/fx 10 0
    req_meta ms_syn '<synthetic>' cli
    ev S_MS 10  UserPromptSubmit
    req ms_r1 S_MS 40  /tmp/fx 10 0
    req_meta ms_r1 claude-opus-5 cli
    ev S_MS 60  Stop
    ev S_MS 100 UserPromptSubmit
    req ms_r2 S_MS 130 /tmp/fx 10 1
    req_meta ms_r2 claude-haiku-4-5 cli
    ev S_MS 150 PreToolUse
    req ms_r3 S_MS 200 /tmp/fx 10 0
    req_meta ms_r3 claude-sonnet-5 cli
    # Two main-thread requests in one second (spec 4.3 step 2): ms_r2z sorts
    # below ms_r3, so the greater id, Sonnet, still answers the Stop at 200 and
    # claude-sonnet-4-6 earns nothing.
    req ms_r2z S_MS 200 /tmp/fx 10 0
    req_meta ms_r2z claude-sonnet-4-6 cli
    ev S_MS 200 Stop
    ev S_MS 300 UserPromptSubmit
    ev S_MS 400 Stop
    ev S_MS 400 SessionEnd
    # Day 2, S_NOTX: no transcript was ever ingested; the session recorded
    # claude-opus-5[1m]. 10 + 90 = 100 s to claude-opus-5.
    sess S_NOTX $((2 * DAY))
    fx_sql "UPDATE claude_sessions SET model = $(cc_sqlstr 'claude-opus-5[1m]') WHERE session_id = $(cc_sqlstr S_NOTX);"
    ev S_NOTX $((2 * DAY))       SessionStart
    ev S_NOTX $((2 * DAY + 10))  UserPromptSubmit
    ev S_NOTX $((2 * DAY + 100)) Stop
    # Day 4, S_NOMODEL: no request and no recorded model -> (no model), 20 + 50 = 70 s.
    sess S_NOMODEL $((4 * DAY))
    ev S_NOMODEL $((4 * DAY))      SessionStart
    ev S_NOMODEL $((4 * DAY + 20)) UserPromptSubmit
    ev S_NOMODEL $((4 * DAY + 70)) Stop
    # Day 6, S_MID: starts 23:50:00 UTC (2025-06-21) and runs to 00:10 the next
    # day. All 1,200 s book to the START day, as claude_daily_rollups books them.
    sess S_MID $((6 * DAY + 31400))
    ev S_MID $((6 * DAY + 31400)) SessionStart
    ev S_MID $((6 * DAY + 31460)) UserPromptSubmit
    req mid_r1 S_MID $((6 * DAY + 31500)) /tmp/fx 10 0
    req_meta mid_r1 claude-opus-4-8 cli
    ev S_MID $((6 * DAY + 32600)) Stop
    ;;
  skill-mix)
    # Stage 7 (spec 4.2-4.4): skill time, one session per day so each guard reads
    # its own day. Every request is main-thread fx-model unless marked sidechain.
    # Day 0, S_SK: prompt 1 loads superpowers:brainstorming -- sk_r0, the request
    # that loads it, is untagged -- and prompt 2's turn is untagged. Claude
    # 10 + 50 + 40 + 150 + 50 = 300 s. The skill 50 + 40 + 150 = 240 s: the think
    # gap ending at prompt 2 is still the skill's; the 10 s before any request
    # and the 50 s ending at prompt 2's Stop are not. sk_sc ran in a subagent at
    # 255, after the think gap's end and before sk_r3, so no gap could end on it
    # even if sidechain requests drove (plan R10).
    sess S_SK 0
    ev  S_SK 0   SessionStart
    ev  S_SK 10  UserPromptSubmit
    req sk_r0 S_SK 20  /tmp/fx 10 0
    req sk_r1 S_SK 40  /tmp/fx 10 0
    req_skill sk_r1 superpowers:brainstorming
    ev  S_SK 60  PreToolUse
    req sk_r2 S_SK 90  /tmp/fx 10 0
    req_skill sk_r2 superpowers:brainstorming
    ev  S_SK 100 Stop
    ev  S_SK 250 UserPromptSubmit
    req sk_sc S_SK 255 /tmp/fx 10 1
    req_skill sk_sc fx-sub-only
    req sk_r3 S_SK 260 /tmp/fx 10 0
    ev  S_SK 300 Stop
    ev  S_SK 300 SessionEnd
    # Day 2, S_SK2: five turns, one skill each, for the packs (spec 4.3). Each
    # turn's work gap and the think gap after it go to its skill. Claude
    # 10 + 190 + 200 + 200 + 200 + 100 = 900 s; skills 890 s. The three names in
    # subagents exist only to be resolved (guard 8, Review Focus 1).
    sess S_SK2 $((2 * DAY))
    ev  S_SK2 $((2 * DAY))       SessionStart
    ev  S_SK2 $((2 * DAY + 10))  UserPromptSubmit
    req k2_a S_SK2 $((2 * DAY + 50))  /tmp/fx 10 0
    req_skill k2_a fxplug:fx-tool
    ev  S_SK2 $((2 * DAY + 100)) Stop
    ev  S_SK2 $((2 * DAY + 200)) UserPromptSubmit
    req k2_b S_SK2 $((2 * DAY + 250)) /tmp/fx 10 0
    req_skill k2_b fx-linked
    ev  S_SK2 $((2 * DAY + 300)) Stop
    ev  S_SK2 $((2 * DAY + 400)) UserPromptSubmit
    req k2_c S_SK2 $((2 * DAY + 450)) /tmp/fx 10 0
    req_skill k2_c fx-plain
    ev  S_SK2 $((2 * DAY + 500)) Stop
    ev  S_SK2 $((2 * DAY + 600)) UserPromptSubmit
    req k2_d S_SK2 $((2 * DAY + 650)) /tmp/fx 10 0
    req_skill k2_d fx-unresolved
    ev  S_SK2 $((2 * DAY + 700)) Stop
    ev  S_SK2 $((2 * DAY + 800)) UserPromptSubmit
    req k2_u1 S_SK2 $((2 * DAY + 805)) /tmp/fx 10 1
    req_skill k2_u1 fxpack/fx-linked
    req k2_u2 S_SK2 $((2 * DAY + 806)) /tmp/fx 10 1
    req_skill k2_u2 ../fxpack/fx-linked
    req k2_u3 S_SK2 $((2 * DAY + 807)) /tmp/fx 10 1
    req_skill k2_u3 "fx it's"
    req k2_e S_SK2 $((2 * DAY + 850)) /tmp/fx 10 0
    req_skill k2_e fx-builtin
    ev  S_SK2 $((2 * DAY + 900)) Stop
    ev  S_SK2 $((2 * DAY + 900)) SessionEnd
    # Day 6, S_SKMID: starts 23:50:00 UTC (2025-06-21), Stop at 00:10 the next
    # day. Its 1,140 s of skill time book to the START day, as the session's
    # 1,200 s do in claude_daily_rollups.
    sess S_SKMID $((6 * DAY + 31400))
    ev  S_SKMID $((6 * DAY + 31400)) SessionStart
    ev  S_SKMID $((6 * DAY + 31460)) UserPromptSubmit
    req km_r1 S_SKMID $((6 * DAY + 31500)) /tmp/fx 10 0
    req_skill km_r1 superpowers:brainstorming
    ev  S_SKMID $((6 * DAY + 32600)) Stop
    ;;
  quest-weeks)
    # Stage 8 (spec 4.2-4.4): six calendar weeks of requests only -- no tool
    # call or hook event anywhere, so only cost-discipline, context-hygiene and
    # model-routing can be measured, and every week with quests has exactly
    # those three. No request falls on a Sunday, so moving a week's first day
    # re-keys the weeks without moving any request between them (guard 2's
    # plant reds only its own test).
    #   A  Mon 2026-08-03  20 requests, ctx 200,000, one model  -> the first baseline
    #   B  Mon 2026-08-10  the same as A                        -> quests, all missed
    #   C  Mon 2026-08-17  ctx 10,000, two models 10/10         -> quests, all done
    #   D  Mon 2026-08-24  5 requests                           -> quests, no data
    #   E  Mon 2026-08-31  the same as A                        -> no quests (D measured nothing)
    #   F  Mon 2026-09-07  the same as C, as of Wed 2026-09-09  -> quests, open
    qw_week() { # qw_week <session> <YYYY-MM-DD> <requests> <cache-read> <second-model-count>
      local t0; t0="$(epoch "$2T10:00:00Z")"
      for i in $(seq 0 $(($3 - 1))); do
        req_at "${1}_$i" "$1" "$((t0 + i * 60))" /tmp/fx 90 0 10 "$4" 0
        if [ "$i" -lt "$5" ]; then req_meta "${1}_$i" fx-model-2 cli; fi
      done
    }
    qw_week QW_A 2026-08-04 20 200000 0
    qw_week QW_B 2026-08-11 20 200000 0
    qw_week QW_C 2026-08-18 20 10000 10
    qw_week QW_D 2026-08-26 5 10000 0
    qw_week QW_E 2026-09-01 20 200000 0
    qw_week QW_F 2026-09-08 20 10000 10
    ;;
  quest-sunday)
    # Stage 8, guard 2: week B's 20th request is on its Sunday, 2026-08-16, so
    # B is measured only if a week runs Monday to Sunday. As of Wed 2026-08-19.
    for i in $(seq 0 19); do req_at "QS_A_$i" QS_A "$(( $(epoch 2026-08-04T10:00:00Z) + i * 60 ))" /tmp/fx 90 0 10 200000 0; done
    for i in $(seq 0 18); do req_at "QS_B_$i" QS_B "$(( $(epoch 2026-08-11T10:00:00Z) + i * 60 ))" /tmp/fx 90 0 10 200000 0; done
    req_at QS_B_SUN QS_B_SUN "$(epoch 2026-08-16T23:00:00Z)" /tmp/fx 90 0 10 200000 0
    ;;
  quest-ask-first)
    # Stage 8, guard 4's absolute step: two weeks of 20 one-model requests, each
    # with 10 prompts submitted under bypassPermissions. The SessionStart on
    # 2026-07-01 starts hook coverage early enough that both the weeks and the
    # 30-day window of Sunday 2026-08-09 are event-covered, so security is
    # measured: 0 on that Sunday, and a bypass share of 1.0 each week. The three
    # lowest are model-routing, cost-discipline and security (all 0, by display
    # order); context-hygiene (31) is left out. As of Wed 2026-08-12.
    ev_at QAF_OLD "$(epoch 2026-07-01T12:00:00Z)" SessionStart
    for w in 2026-08-04 2026-08-11; do
      t0="$(epoch "${w}T10:00:00Z")"
      for i in $(seq 0 19); do req_at "QAF_${w}_$i" "QAF_$w" "$((t0 + i * 60))" /tmp/fx 90 0 10 200000 0; done
      for i in $(seq 0 9); do
        ev_at "QAF_$w" "$((t0 + 30 + i * 60))" UserPromptSubmit '{"permission_mode":"bypassPermissions"}'
      done
    done
    ;;
  agent-drift)
    # Stage 5, guard 11: one event stream through Claude's rule here and through
    # the agent copy in tests/agent-rollup.test.ts, which seeds these same
    # offsets into wt_events. The ties at 2100 and 20010 resolve by insert order
    # in both. Claude's rule gives 16380 s; a >= in the working test gives 16680.
    sess S_DRIFT 0
    for pair in 0:SessionStart 4:UserPromptSubmit 20:PreToolUse 900:PostToolUse 960:Stop \
                1500:Notification 2100:UserPromptSubmit 2100:Stop 2700:Notification \
                2710:UserPromptSubmit 20000:PostToolUse 20010:Stop 20010:SessionEnd \
                25000:SessionStart 25010:UserPromptSubmit 25100:Stop; do
      ev S_DRIFT "${pair%%:*}" "${pair#*:}"
    done
    ;;
  profile-7d|profile-7d-gated|profile-7d-split)
    # Stage 10 (spec 4.2), as of Wed 2026-09-30. Tool and hook coverage start on
    # 2026-08-21, before both windows' first days (09-01 and 09-24), and that
    # first call and event fall outside both windows. Every other input lands on
    # 2026-09-28, so the 30-day and the 7-day window of 09-30 see the same data
    # and every discipline must score the same over both. The gated variant has
    # 19 requests in the last 7 days and 5 more on 09-10: 24 in the 30-day
    # window (scored) and 19 in the 7-day one (gated, no 7-day rows). Four
    # subagent launches (not five) keep automation's runs part under full marks,
    # so a headless session outside the 7 days can still move it.
    #
    # The split variant is profile-7d plus inputs on 09-10, inside the 30-day
    # window only, one or more for every per-window table that feeds a score:
    # 8 requests in 4 two-request sessions at a 300,000 context on a third model,
    # two of them API errors and one headless (sdk-cli); 8 tool errors, 2
    # subagent launches and 2 calls to a second MCP server; slash commands /cmd3,
    # /cmd4 and /cmd0 x4; 2 compactions and 4 prompts under bypassPermissions.
    # Its 7-day window is profile-7d's, so its 7-day scores must be profile-7d's;
    # its 30-day window moves most of the ten.
    ev_at P7_OLD "$(epoch 2026-08-21T12:00:00Z)" SessionStart
    tc_at P7_OLD_TC P7_OLD "$(epoch 2026-08-21T12:00:00Z)" Read 0 0
    n=24; if [ "$scenario" = profile-7d-gated ]; then n=19; fi
    t0="$(epoch 2026-09-28T10:00:00Z)"
    for i in $(seq 0 $((n - 1))); do
      s="P7_S$((i % 3))"; t=$((t0 + i * 60))
      req_at "P7_$i" "$s" "$t" /tmp/fx 900 0 10 "$((20000 + i * 1000))" 0
      if [ $((i % 4)) -eq 0 ]; then req_meta "P7_$i" fx-model-2 cli; fi
      tc_at "P7_TC_$i" "$s" "$((t + 10))" Read 0 0
      if [ $((i % 6)) -eq 0 ]; then tc_at "P7_TCE_$i" "$s" "$((t + 20))" Bash 1 0; fi
      if [ $((i % 5)) -eq 0 ]; then tc_at "P7_MCP_$i" "$s" "$((t + 30))" mcp__fx__lookup 0 0; fi
      if [ $((i % 6)) -eq 3 ]; then tc_at "P7_AG_$i" "$s" "$((t + 40))" Task 0 0; fi
      if [ $((i % 4)) -eq 1 ]; then sl_at "P7_SL_$i" "$s" "$((t + 50))" "/cmd$((i % 3))"; fi
      ev_at "$s" "$((t + 5))" UserPromptSubmit '{"permission_mode":"default"}'
    done
    ev_at P7_S0 "$((t0 + 3000))" PreCompact
    if [ "$scenario" = profile-7d-gated ]; then
      t1="$(epoch 2026-09-10T10:00:00Z)"
      for i in 0 1 2 3 4; do req_at "P7_OLD_$i" P7_OLD "$((t1 + i * 60))" /tmp/fx 900 0 10 20000 0; done
    fi
    if [ "$scenario" = profile-7d-split ]; then
      t1="$(epoch 2026-09-10T10:00:00Z)"
      for i in 0 1 2 3 4 5 6 7; do
        s="P7_X$((i % 4))"; t=$((t1 + i * 60))
        req_at "P7_X_$i" "$s" "$t" /tmp/fx 900 0 10 300000 0
        if [ "$i" -lt 2 ]; then req_meta "P7_X_$i" fx-model-3 cli 500
        elif [ "$i" -eq 7 ]; then req_meta "P7_X_$i" fx-model-3 sdk-cli
        else req_meta "P7_X_$i" fx-model-3 cli; fi
        tc_at "P7_XE_$i" "$s" "$((t + 10))" Bash 1 0
        if [ "$i" -lt 2 ]; then
          tc_at "P7_XAG_$i" "$s" "$((t + 20))" Task 0 0
          tc_at "P7_XMCP_$i" "$s" "$((t + 30))" mcp__fy__lookup 0 0
          ev_at "$s" "$((t + 40))" PreCompact
        fi
        if [ "$i" -lt 4 ]; then
          ev_at "$s" "$((t + 5))" UserPromptSubmit '{"permission_mode":"bypassPermissions"}'
          sl_at "P7_XSL_$i" "$s" "$((t + 50))" /cmd0
        fi
      done
      sl_at P7_XSL_8 P7_X0 "$((t1 + 600))" /cmd3
      sl_at P7_XSL_9 P7_X1 "$((t1 + 660))" /cmd4
    fi
    ;;
  attr-days)
    # Stage 10 (spec 4.3-4.5), as of Wed 2026-09-30. Requests only (no tool call,
    # so verification, prompt-hygiene and reuse are needs-data): 20 at context
    # 200,000 on 09-01, and 20 at 10,000 on 09-15, half on a second model. So
    # INT's 30-day Form differs between 09-01 and 09-15 (guard 2), WIS on 09-30
    # has two needs-data constituents and one measured (guard 1), and the
    # 7-day window of 09-30 holds no request (gated: no boost, guard 5). Claude
    # has about an hour of driven time on each of the two days.
    for d in 2026-09-01 2026-09-15; do
      t0="$(epoch "${d}T10:00:00Z")"; s="AT_$d"
      sess_at "$s" "$t0"
      ev_at "$s" "$t0" SessionStart
      ev_at "$s" "$((t0 + 5))" UserPromptSubmit
      for k in $(seq 1 12); do ev_at "$s" "$((t0 + k * 300))" PostToolUse; done
      ev_at "$s" "$((t0 + 3605))" Stop
      for i in $(seq 0 19); do
        if [ "$d" = 2026-09-01 ]; then cr=200000; else cr=10000; fi
        req_at "${s}_$i" "R_$d" "$((t0 + 60 + i * 60))" /tmp/fx 90 0 10 "$cr" 0
        if [ "$d" = 2026-09-15 ] && [ "$i" -lt 10 ]; then req_meta "${s}_$i" fx-model-2 cli; fi
      done
    done
    ;;
  attr-floor)
    # Stage 10 (spec 4.5), as of Wed 2026-09-30: a drain larger than Base, so
    # Now is floored at 1. Requests only, no tool call and no permission mode,
    # so WIS reads model-routing alone. On 09-10, 40 requests split over two
    # models and a five-minute session: WIS's 30-day Form is high but it trains
    # minutes, a Base under 10. On 09-28, 20 requests on a third model: the
    # 7-day window scores model-routing 0 and the boost is clamped to -10.
    t0="$(epoch 2026-09-10T10:00:00Z)"
    sess_at AF_S "$t0"
    ev_at AF_S "$t0" SessionStart
    ev_at AF_S "$((t0 + 5))" UserPromptSubmit
    ev_at AF_S "$((t0 + 300))" PostToolUse
    ev_at AF_S "$((t0 + 305))" Stop
    for i in $(seq 0 39); do
      req_at "AF_OLD_$i" AF_R1 "$((t0 + 10 + i * 5))" /tmp/fx 90 0 10 10000 0
      if [ $((i % 2)) -eq 0 ]; then req_meta "AF_OLD_$i" fx-model-2 cli; else req_meta "AF_OLD_$i" fx-model-3 cli; fi
    done
    t1="$(epoch 2026-09-28T10:00:00Z)"
    for i in $(seq 0 19); do req_at "AF_NEW_$i" AF_R2 "$((t1 + i * 60))" /tmp/fx 90 0 10 10000 0; done
    ;;
  *)
    echo "unknown scenario: $scenario" >&2; exit 1 ;;
esac
