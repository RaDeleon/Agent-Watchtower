#!/usr/bin/env bash
# snapshot.sh — write one throttled status-line snapshot row.
#
# Reads the Claude Code status-line JSON on stdin. Throttled to at most one row
# per session per 60s via a marker file, matching the inline writer it replaces.
#
# Silent and exit-0 always: a snapshot failure must never affect the status line.

LIB="${CC_LIB_PATH:-$HOME/.claude/cc-track-lib.sh}"
[ -f "$LIB" ] || exit 0
# shellcheck source=/dev/null
. "$LIB"
cc_have_deps || exit 0

input="$(cat 2>/dev/null)"
[ -z "$input" ] && exit 0
jqget() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

session="$(jqget '.session_id')"
[ -z "$session" ] && exit 0

# ---- throttle: one row per session per 60s -------------------------------
# The session id is a PATH COMPONENT here, so it is flattened first. A '/' in an
# id does not just make stderr noise: the marker write silently fails, the
# throttle stops working for that session entirely, and every status-line render
# inserts another snapshot row -- which is the precondition for the rollup's
# _snap fan-out. Everything else here already treats the id as data (cc_sqlstr).
marker_dir="${TMPDIR:-/tmp}/cc-snap"
# Flattening '/' is necessary but not sufficient: "." and ".." survive the
# substitution and name directories that already exist, so the marker write
# fails and the throttle silently stops throttling. Prefix them out of the way.
# Pure parameter expansion, no subprocess -- this runs on every status-line
# render, ahead of the throttle check itself.
marker_name="${session//\//_}"
case "$marker_name" in .|..) marker_name="_$marker_name" ;; esac
marker="$marker_dir/$marker_name"
mkdir -p "$marker_dir" 2>/dev/null
if [ -f "$marker" ]; then
  # GNU form first. GNU stat reads `-f %m` as "file-system status of the files
  # %m and $marker": it prints a multi-line block for the marker, then fails on
  # %m, so the fallback's number landed after that block, the arithmetic below
  # failed, and Linux never throttled. BSD stat rejects -c with nothing on stdout.
  mt=$(stat -c %Y "$marker" 2>/dev/null || stat -f %m "$marker" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - mt )) -lt 60 ] && exit 0
fi
: > "$marker" 2>/dev/null   # claim the slot before doing work

dir="$(jqget '.cwd')"
model="$(jqget '.model.display_name // .model.id // .model')"
effort="$(jqget '.effort.level')"
thinking="$(jqget '.thinking.enabled')"
think=0; [ "$thinking" = "true" ] && think=1
# One git fork, not two: fetch the toplevel once and derive repo (the
# basename) from it inline, matching cc_repo's exact fallback (toplevel
# basename, else cwd basename, else empty) without calling cc_repo, which
# would fork git again for the same dir.
# ${x##*/}, not basename: the comment two lines up is about avoiding a
# subprocess on this exact path, and basename is one -- per snapshot, from the
# status line. It is also wrong for a value beginning with "-", which it parses
# as an OPTION, printing "basename: illegal option" to stderr and returning
# empty.
proj=""; [ -n "$dir" ] && proj="$(cc_project_path "$dir")"
repo=""
if [ -n "$proj" ]; then repo="${proj##*/}"; elif [ -n "$dir" ]; then repo="${dir##*/}"; fi

ctx_pct="$(jqget '.context_window.used_percentage')"
ctx_size="$(jqget '.context_window.context_window_size // .context_window.size')"
tok_in="$(jqget '.context_window.current_usage.input_tokens // .usage.input_tokens')"
tok_out="$(jqget '.context_window.current_usage.output_tokens // .usage.output_tokens')"
tok_cr="$(jqget '.context_window.current_usage.cache_read_input_tokens // .usage.cache_read_input_tokens')"
tok_cw="$(jqget '.context_window.current_usage.cache_creation_input_tokens // .usage.cache_creation_input_tokens')"
cost="$(jqget '.cost.total_cost_usd')"
dur_ms="$(jqget '.cost.total_duration_ms')"
api_ms="$(jqget '.cost.total_api_duration_ms')"
added="$(jqget '.cost.total_lines_added')"
removed="$(jqget '.cost.total_lines_removed')"
r5="$(jqget '.rate_limits.five_hour.used_percentage')"
r7="$(jqget '.rate_limits.seven_day.used_percentage')"

cache_hit=""
if [ -n "$tok_cr" ] && [ -n "$tok_cw" ]; then
  cache_hit=$(awk -v r="$tok_cr" -v w="$tok_cw" 'BEGIN{t=r+w; if(t>0) printf "%.4f", 100.0*r/t; else printf ""}')
fi

cc_init_db
cc_sql "INSERT INTO claude_status_snapshots (
  session_id, ts, cwd, repo, project_path, model, effort, thinking_enabled,
  context_used_percentage, context_window_size,
  input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_hit_percentage,
  total_cost_usd, total_duration_ms, total_api_duration_ms, total_lines_added, total_lines_removed,
  five_hour_rate_limit_used_percentage, seven_day_rate_limit_used_percentage)
  VALUES (
  $(cc_sqlstr "$session"), $(cc_now), $(cc_sqlstr "$dir"), $(cc_sqlstr "$repo"), $(cc_sqlstr "$proj"), $(cc_sqlstr "$model"),
  $(cc_sqlstr "$effort"), $think,
  $(cc_sqlnum "$ctx_pct"), $(cc_sqlnum "$ctx_size"),
  $(cc_sqlnum "$tok_in"), $(cc_sqlnum "$tok_out"), $(cc_sqlnum "$tok_cr"), $(cc_sqlnum "$tok_cw"), $(cc_sqlnum "$cache_hit"),
  $(cc_sqlnum "$cost"), $(cc_sqlnum "$dur_ms"), $(cc_sqlnum "$api_ms"), $(cc_sqlnum "$added"), $(cc_sqlnum "$removed"),
  $(cc_sqlnum "$r5"), $(cc_sqlnum "$r7"));"
exit 0
