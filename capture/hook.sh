#!/usr/bin/env bash
# cc-track-hook.sh — universal Claude Code hook writer for Watchtower.
#
# Registered on SessionStart, SessionEnd, UserPromptSubmit, Stop, SubagentStart,
# SubagentStop, PreCompact, PostCompact. Reads the hook JSON on stdin, writes one
# claude_events row + updates the session's counters/lifecycle in a SINGLE sqlite3
# call, and exits 0 with no stdout (so it never interferes with the Terax
# terminalSequence hooks that share these events).
#
# Fail-safe: any missing dep / DB error is swallowed — a hook must never break Claude Code.

LIB="${CC_LIB_PATH:-$HOME/.claude/cc-track-lib.sh}"
[ -f "$LIB" ] || exit 0
# shellcheck source=/dev/null
. "$LIB"
cc_have_deps || exit 0

input="$(cat 2>/dev/null)"
[ -z "$input" ] && exit 0

jqget() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

session="$(jqget '.session_id')"
cwd="$(jqget '.cwd')"
event="$(jqget '.hook_event_name')"
model="$(jqget '.model // .model.id // .model.display_name')"
source_v="$(jqget '.source')"
reason_v="$(jqget '.reason')"

[ -z "$event" ] && exit 0

cc_init_db

ts="$(cc_now)"
# One git fork, not two: fetch the toplevel once and derive repo (the
# basename) from it inline, matching cc_repo's exact fallback (toplevel
# basename, else cwd basename, else empty) without calling cc_repo, which
# would fork git again for the same cwd.
# ${x##*/}, not basename: no subprocess at all on the per-event path, and
# correct for a value beginning with "-", which basename parses as an OPTION --
# writing "basename: illegal option" to stderr and returning empty, in a hook
# whose contract is to exit 0 saying nothing.
proj="$(cc_project_path "$cwd")"
repo=""
if [ -n "$proj" ]; then repo="${proj##*/}"; elif [ -n "$cwd" ]; then repo="${cwd##*/}"; fi
term="$(cc_terminal_app)"

# PII-light payload: keep only the event-shaping fields + prompt LENGTH (never the text).
payload="$(printf '%s' "$input" | jq -c '{
  source: .source, reason: .reason, trigger: .trigger,
  tool_name: .tool_name, agent_type: .agent_type,
  permission_mode: .permission_mode,
  prompt_len: (if .prompt then (.prompt | length) else null end)
} | with_entries(select(.value != null))' 2>/dev/null)"
[ -z "$payload" ] && payload="{}"

# ---- encode literals -------------------------------------------------------
Lsession=$(cc_sqlstr "$session"); Lcwd=$(cc_sqlstr "$cwd"); Lrepo=$(cc_sqlstr "$repo")
Lproj=$(cc_sqlstr "$proj")
Lmodel=$(cc_sqlstr "$model");     Lterm=$(cc_sqlstr "$term")
Levent=$(cc_sqlstr "$event");     Lsource=$(cc_sqlstr "$source_v")
Lreason=$(cc_sqlstr "$reason_v"); Lpayload=$(cc_sqlstr "$payload")

# ---- build one SQL batch ---------------------------------------------------
sql="INSERT INTO claude_events (ts, session_id, hook_event_name, cwd, repo, project_path, model, terminal_app, payload_json)
     VALUES ($ts, $Lsession, $Levent, $Lcwd, $Lrepo, $Lproj, $Lmodel, $Lterm, $Lpayload);"

if [ -n "$session" ]; then
  # Ensure the session row exists (SessionStart may have been missed on resume).
  sql="$sql
  INSERT OR IGNORE INTO claude_sessions (session_id, terminal_app, cwd, repo, project_path, model, started_at, updated_at)
    VALUES ($Lsession, $Lterm, $Lcwd, $Lrepo, $Lproj, $Lmodel, $ts, $ts);"

  case "$event" in
    SessionStart)
      sql="$sql
      UPDATE claude_sessions SET
        terminal_app = COALESCE($Lterm, terminal_app),
        cwd          = COALESCE($Lcwd, cwd),
        repo         = COALESCE($Lrepo, repo),
        model        = COALESCE($Lmodel, model),
        source       = COALESCE($Lsource, source),
        started_at   = COALESCE(started_at, $ts),
        updated_at   = $ts
      WHERE session_id = $Lsession;" ;;
    UserPromptSubmit)
      sql="$sql
      UPDATE claude_sessions SET prompts = prompts + 1,
        model = COALESCE(model, $Lmodel), repo = COALESCE(repo, $Lrepo),
        cwd = COALESCE(cwd, $Lcwd), updated_at = $ts
      WHERE session_id = $Lsession;" ;;
    PreCompact)
      sql="$sql
      UPDATE claude_sessions SET compacts = compacts + 1, updated_at = $ts WHERE session_id = $Lsession;" ;;
    SubagentStart)
      sql="$sql
      UPDATE claude_sessions SET subagents = subagents + 1, updated_at = $ts WHERE session_id = $Lsession;" ;;
    SessionEnd)
      sql="$sql
      UPDATE claude_sessions SET
        ended_at    = $ts,
        end_reason  = COALESCE($Lreason, end_reason),
        duration_ms = ($ts - COALESCE(started_at, $ts)) * 1000,
        updated_at  = $ts
      WHERE session_id = $Lsession;" ;;
    *)
      sql="$sql
      UPDATE claude_sessions SET updated_at = $ts WHERE session_id = $Lsession;" ;;
  esac
fi

cc_sql "$sql"
exit 0
