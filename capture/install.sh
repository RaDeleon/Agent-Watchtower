#!/usr/bin/env bash
# install.sh — install the Watchtower capture layer into a Claude Code config dir.
#
# Idempotent: safe to run repeatedly. Backs up anything it replaces into
# <CLAUDE_DIR>/backups/ before writing.
#
# Deliberately installs to the EXISTING tracker paths. A second set of hooks
# under new names would fire alongside the old ones and double-count every
# session.
#
# usage: install.sh [--status-line] [--dry-run]
#   --status-line  when settings.json has no statusLine and no snapshot writer is
#                  found, make watchtower-snapshot.sh the status line, in the same
#                  jq pass that registers the hooks. It records snapshots and
#                  displays nothing. An existing status line is never edited.
#   --dry-run      run the pre-flight, print the settings.json this run would
#                  write, and exit. Nothing is written: no directory, backup,
#                  temp file or script. Messages go to stderr, so stdout is
#                  exactly the file. `watchtower setup` previews with it.
# With no arguments it writes exactly what it wrote before the flags existed.
set -euo pipefail

USAGE="usage: install.sh [--status-line] [--dry-run]"
DRY_RUN=0
STATUS_LINE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY_RUN=1 ;;
    --status-line) STATUS_LINE=1 ;;
    *) echo "install: unknown argument: $arg" >&2; echo "$USAGE" >&2; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
HOOKS_DIR="$CLAUDE_DIR/hooks"
BACKUP_DIR="$CLAUDE_DIR/backups"
SETTINGS="$CLAUDE_DIR/settings.json"
STAMP="$(date +%Y%m%d-%H%M%S)"

command -v jq >/dev/null 2>&1 || { echo "install: jq is required" >&2; exit 1; }
# Every capture script exits 0 silently without sqlite3, so an install without it
# would report done and record nothing.
command -v sqlite3 >/dev/null 2>&1 || { echo "install: sqlite3 is required" >&2; exit 1; }

# ---- 0. pre-flight: refuse a partial install -------------------------------
# Check every source script exists BEFORE touching anything in CLAUDE_DIR. Without
# this, a missing source aborts partway through the install_script calls below
# (set -e still catches it) — but by then some scripts are already live in the
# user's config dir while settings.json was never wired: a half-installed
# config-mutating tool. Refuse up front instead, naming what's missing.
missing=()
for f in lib.sh hook.sh rollup.sh snapshot.sh ingest.sh; do
  [ -f "$SRC/$f" ] || missing+=("$f")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "install: missing source script(s): ${missing[*]}" >&2
  exit 1
fi

# ---- the settings.json merge ----------------------------------------------
# Defined before anything is written, so --dry-run prints exactly what section 2
# writes: one function, one jq program, two callers.
HOOK="$HOOKS_DIR/cc-track-hook.sh"
ROLLUP="$CLAUDE_DIR/claude-usage-rollup.sh"
INGEST="$CLAUDE_DIR/watchtower-ingest.sh"
SNAPSHOT="$CLAUDE_DIR/watchtower-snapshot.sh"
# SessionEnd chains the rollup AFTER the hook so the session's ended_at is
# written before the rebuild reads it. Without this the rollup only ever ran
# from the cc launcher's exit trap, and derived tables silently froze.
#
# Order matters: ingest BEFORE the rollup, so the rollup aggregates this
# session's requests in the same run that records its end. `;`, not `&&`, so a
# failed ingest never skips the rollup.
#
# Ingest and the rollup run in the BACKGROUND. Claude Code cancels SessionEnd
# hooks after 1.5s (CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS), and ingest alone
# takes seconds, so the foreground chain was killed on every exit and the
# derived tables froze for four days. The hook itself stays inline: it is fast.
# The redirects release the hook's pipes, which Claude Code waits on, and keep
# any stderr or `exit 1` away from it. nohup survives the terminal closing.
# Verified against Claude Code 2.1.274: the job outlives the claude process.
SESSION_END_CMD="$HOOK; nohup sh -c '$INGEST --quiet; $ROLLUP --quiet' </dev/null >/dev/null 2>&1 &"

# Exact historical spellings of OUR SessionEnd command, newest first. `ensure`
# dedupes by exact string equality, so a command whose text we changed is no
# longer recognised as ours and would be left registered alongside the new one.
# This list is EXACT strings only, never substrings: matching on
# `contains("cc-track-hook.sh")` would make the delete step aggressive inside
# the very function that already shipped one hook-deletion bug.
RETIRED_SESSION_END=(
  "$HOOK; $INGEST --quiet >/dev/null 2>&1 || true; $ROLLUP --quiet >/dev/null 2>&1 || true"
  "$HOOK; $ROLLUP --quiet >/dev/null 2>&1 || true"
)
RETIRED_SESSION_END_JSON="$(printf '%s\n' "${RETIRED_SESSION_END[@]}" | jq -R . | jq -s .)"

# Registering our command has to survive two shapes a real settings.json takes.
#
# 1. A group holding our command ALONGSIDE an unrelated one (PostCompact: one
#    group with both an obsidian hook and cc-track-hook.sh). The original filter
#    tested whether [.hooks[]?.command] contained our command and dropped the
#    whole GROUP, silently deleting the sibling hook.
# 2. A group holding ONLY our command, but carrying a `matcher` the user set to
#    scope it. Stripping our command emptied that group, the empty group was
#    dropped, and a fresh bare group was appended -- silently widening a
#    deliberately-scoped hook to fire on everything.
#
# So: never rebuild a group that already carries our command. Collapse repeat
# copies down to the first occurrence (within a group, then across groups),
# leave that first occurrence exactly where the user has it -- group fields,
# matcher, siblings and their own timeout/async intact -- drop only groups left
# with no commands, and append a fresh group ONLY when our command is absent
# entirely. Idempotent by construction: the second run finds it present and
# changes nothing.
#
# The status line is set only when $addStatusLine is true AND settings.json has
# none: the caller decides from the snapshot state (below), and the jq program
# re-checks, so an existing status line is never replaced.
merge_settings() { # merge_settings <true|false> [settings-file]: print the merged settings.json (stdin without a file)
  local add_status_line="$1"
  shift
  jq --arg hook "$HOOK" --arg sessionEnd "$SESSION_END_CMD" \
     --argjson retiredSessionEnd "$RETIRED_SESSION_END_JSON" \
     --argjson addStatusLine "$add_status_line" --arg snapshot "$SNAPSHOT" '
    # Deliberate, documented consequence: if $cmd was the ONLY command in its
    # group, stripping it empties the group, and the cleanup below drops empty
    # groups -- fields (a `matcher`) included. `ensure` then appends a fresh
    # bare group for the new command, so a matcher that scoped the OLD command
    # does not carry forward. Threading the matcher from retire into ensure to
    # preserve it would add real complexity to the one function that already
    # shipped a hook-deletion bug, for a case that does not occur in practice.
    # Pinned by "drops a stale matcher when migrating off the old chain".
    def retire($event; $cmd):
      .hooks[$event] = (
        ((.hooks[$event] // [])
          | map(.hooks = ((.hooks // []) | map(select(.command != $cmd))))
          | map(select(((.hooks // []) | length) > 0)))
      );
    def ensure($event; $cmd):
      .hooks[$event] = (
        ((.hooks[$event] // [])
          | map(.hooks = ((.hooks // [])
              | reduce .[] as $h ([];
                  if ($h.command == $cmd) and any(.[]; .command == $cmd)
                  then . else . + [$h] end)))
          | reduce .[] as $g ({seen: false, out: []};
              if (($g.hooks // []) | any(.command == $cmd))
              then (if .seen
                    then .out += [$g | .hooks = ((.hooks // []) | map(select(.command != $cmd)))]
                    else .seen = true | .out += [$g] end)
              else .out += [$g] end)
          | .out
          | map(select(((.hooks // []) | length) > 0))) as $kept
        | if ($kept | map((.hooks // []) | map(.command)) | flatten | index($cmd)) != null
          then $kept
          else $kept + [{ hooks: [{ type: "command", command: $cmd }] }]
          end
      );
    .hooks = (.hooks // {})
    | ensure("SessionStart";     $hook)
    | ensure("UserPromptSubmit"; $hook)
    | ensure("Stop";             $hook)
    | ensure("SubagentStart";    $hook)
    | ensure("SubagentStop";     $hook)
    | ensure("PreCompact";       $hook)
    | ensure("PostCompact";      $hook)
    | reduce $retiredSessionEnd[] as $old (.; retire("SessionEnd"; $old))
    | ensure("SessionEnd";       $sessionEnd)
    | if $addStatusLine and .statusLine == null
      then .statusLine = { type: "command", command: $snapshot }
      else . end
  ' "$@"
}

# settings.json as the merge will read it: a missing file is `{}`, which is what
# section 2 writes before merging.
current_settings() {
  if [ -f "$SETTINGS" ]; then cat "$SETTINGS"; else echo '{}'; fi
}

# ---- snapshot state --------------------------------------------------------
# Read before anything is written. Three states:
#   writer  a snapshot writer is already wired: statusline.sh calls one, or
#           settings.json's statusLine runs watchtower-snapshot.sh itself
#   none    settings.json has no statusLine
#   other   a statusLine that writes no snapshots
# --status-line sets the status line in `none` only. A second writer would
# insert every snapshot row twice, and an existing display is the user's.
#
# The user's statusline.sh may ALREADY contain an inline snapshot writer.
# Both spellings are matched. "claude_status_snapshots" finds an INLINE writer
# (the old shape, with the INSERT in statusline.sh itself); "watchtower-snapshot.sh"
# finds the one-line call this installer tells the user to add — which does NOT
# contain the table name, so grepping only for that name told a user who had
# followed the instruction "no snapshot capture found" forever. settings.json is
# checked too: after --status-line, the writer IS the status line, and a re-run
# that looked only at statusline.sh would report "no snapshot capture found".
#
# A settings.json that is not JSON reads as `invalid` here and is left to section
# 2, which refuses it exactly as it did before these flags (--dry-run refuses it
# below). Nothing here exits on it.
STATUSLINE="$CLAUDE_DIR/statusline.sh"
STATUS_LINE_CMD=""
if [ -f "$STATUSLINE" ] && grep -qE "claude_status_snapshots|watchtower-snapshot\.sh" "$STATUSLINE"; then
  SNAPSHOT_STATE=writer-statusline
else
  SNAPSHOT_STATE="$(current_settings | jq -r '
    if .statusLine == null then "none"
    elif ((.statusLine.command? // "") | tostring | contains("watchtower-snapshot.sh")) then "writer-settings"
    else "other" end' 2>/dev/null)" || SNAPSHOT_STATE=invalid
  if [ "$SNAPSHOT_STATE" = other ]; then
    STATUS_LINE_CMD="$(current_settings | jq -r '.statusLine.command? // "" | tostring')"
  fi
fi
ADD_STATUS_LINE=false
if [ "$STATUS_LINE" = 1 ] && [ "$SNAPSHOT_STATE" = none ]; then
  ADD_STATUS_LINE=true
fi

snapshot_messages() {
  case "$SNAPSHOT_STATE" in
    writer-statusline)
      echo "install: existing snapshot capture detected in statusline.sh — leaving it alone" ;;
    writer-settings)
      echo "install: existing snapshot capture detected in settings.json's statusLine — leaving it alone" ;;
    *)
      echo "install: no snapshot capture found; wire $CLAUDE_DIR/watchtower-snapshot.sh into your status line"
      if [ "$ADD_STATUS_LINE" = true ]; then
        echo "install: status line set to $SNAPSHOT (records snapshots, displays nothing)"
      elif [ "$SNAPSHOT_STATE" = other ]; then
        if [ "$STATUS_LINE" = 1 ]; then
          echo "install: --status-line changed nothing: an existing status line is never edited"
        fi
        echo "install: your status line${STATUS_LINE_CMD:+ ($STATUS_LINE_CMD)} records no snapshots; to record them, pass its stdin JSON to $SNAPSHOT, for example at the top of a shell script: input=\$(cat); printf '%s' \"\$input\" | $SNAPSHOT, then read \$input instead of stdin"
      fi ;;
  esac
}

# ---- dry run: print the merge, write nothing -------------------------------
if [ "$DRY_RUN" = 1 ]; then
  if [ -f "$SETTINGS" ] && ! jq empty "$SETTINGS" >/dev/null 2>&1; then
    echo "install: $SETTINGS is not valid JSON; refusing to preview it" >&2
    exit 1
  fi
  current_settings | merge_settings "$ADD_STATUS_LINE"
  snapshot_messages >&2
  exit 0
fi

mkdir -p "$HOOKS_DIR" "$BACKUP_DIR"

# NOTE: the brief's original form was `[ -f "$1" ] && cp ... || true`. Under
# set -e that swallows a GENUINE cp failure (permission denied, disk full):
# the `|| true` fires whether the `[ -f ]` test failed OR the cp failed, so a
# failed backup would silently let the installer overwrite the file it just
# failed to back up. This form only short-circuits the *missing file* case;
# a real cp failure propagates and aborts the script (set -e), same as any
# other step here.
backup() {
  [ -f "$1" ] || return 0
  cp "$1" "$BACKUP_DIR/$(basename "$1").$STAMP"
}

# ---- 1. scripts ------------------------------------------------------------
install_script() { # install_script <src-name> <dest-path>
  backup "$2"
  cp "$SRC/$1" "$2"
  chmod +x "$2"
}
install_script lib.sh      "$CLAUDE_DIR/cc-track-lib.sh"
install_script hook.sh     "$HOOKS_DIR/cc-track-hook.sh"
install_script rollup.sh   "$CLAUDE_DIR/claude-usage-rollup.sh"
install_script snapshot.sh "$CLAUDE_DIR/watchtower-snapshot.sh"
install_script ingest.sh   "$CLAUDE_DIR/watchtower-ingest.sh"

# ---- 2. hooks in settings.json --------------------------------------------
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
backup "$SETTINGS"

# The temp file is written inside CLAUDE_DIR, not $TMPDIR: if it lived on a
# different filesystem than settings.json, the `mv` below could silently degrade
# from an atomic rename to copy-then-unlink, risking a truncated settings.json on
# a crash mid-copy. Same-directory mktemp keeps the mv on one filesystem. That
# means any abort between here and the mv (invalid-JSON refusal, Ctrl-C, a
# crash) would otherwise leave a stray .settings.json.tmp.* sitting in the user's
# config dir — so the cleanup trap is armed FIRST, with $tmp pre-declared empty.
# Armed after mktemp, there is a window in which the file exists and nothing
# would remove it; and under `set -u` the trap would then read an unset variable
# on any earlier exit. The trap is a no-op once the mv has renamed the file away,
# and its own exit status does not override the script's (verified).
tmp=""
trap '[ -n "$tmp" ] && rm -f "$tmp"' EXIT
tmp="$(mktemp "$CLAUDE_DIR/.settings.json.tmp.XXXXXX")"
merge_settings "$ADD_STATUS_LINE" "$SETTINGS" > "$tmp"

jq empty "$tmp" 2>/dev/null || { echo "install: refusing to write invalid settings.json" >&2; rm -f "$tmp"; exit 1; }
mv "$tmp" "$SETTINGS"

# ---- 3. snapshot wiring ----------------------------------------------------
# What the state above found. The display itself is never modified; only
# --status-line, with no status line at all, sets one.
snapshot_messages

echo "install: done (backups in $BACKUP_DIR)"
