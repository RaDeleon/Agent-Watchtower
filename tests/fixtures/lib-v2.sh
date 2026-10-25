#!/usr/bin/env bash
# VENDORED test fixture: verbatim `git show 8a43e88:capture/lib.sh` (schema v2, before Stage 1.5 added its two project tables), so the v2 -> current upgrade test needs no git history.
# cc-track-lib.sh — shared helpers for TheOne's Claude Code usage tracker.
#
# Sourced by:  cc-track.sh (launcher), hooks/cc-track-hook.sh (event writer),
#              claude-usage-rollup.sh (daily rollup), and ~/.claude/statusline.sh
#              (throttled status snapshots).
#
# Owns the single source of truth for the SQLite schema and every DB write, so
# the whole system stays concurrency-safe (WAL + busy_timeout) and fail-safe:
# every DB call is best-effort and NEVER aborts the caller — a broken tracker
# must never break Claude Code, your launcher, or your status line.
#
# The database lives at ~/.theone/claude-code-usage.sqlite (override THEONE_DB_PATH).
# It is the user's own durable, local capture store — regenerable rollups derive
# from the raw event/session/snapshot tables.

# ---- config ---------------------------------------------------------------
CC_SCHEMA_VERSION=2

cc_db_path() { printf '%s' "${THEONE_DB_PATH:-$HOME/.theone/claude-code-usage.sqlite}"; }
cc_db_dir()  { dirname "$(cc_db_path)"; }
cc_now()     { date +%s; }

# All external deps present? (sqlite3 for the DB, jq for parsing hook/status JSON.)
cc_have_deps() { command -v sqlite3 >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; }

# ---- SQL value encoders (safe for arbitrary input) ------------------------
# String literal: NULL when empty/absent, else single-quote-escaped 'value'.
# The quote to replace MUST come from a variable. Written literally as
# ${v//\'/\'\'} the backslashes survive into the output ('o\'\'brien'), and
# written as ${v//"'"/"''"} bash 3.2 -- which is what /usr/bin/env bash resolves
# to on stock macOS -- treats the inner double quotes as DATA and emits
# 'o"''"brien'. Both make sqlite3 reject the whole statement as a parse error,
# and cc_sql swallows errors by design, so every event, session and snapshot
# under a path containing an apostrophe was silently dropped with nothing on
# stdout or stderr. The $q form below is the one that is correct on bash 3.2,
# bash 5 and zsh alike; tests/capture-scripts.test.ts pins the output.
cc_sqlstr() {
  local v="$1" q="'"
  if [ -z "$v" ]; then printf 'NULL'; else printf "'%s'" "${v//$q/$q$q}"; fi
}
# Numeric literal: the number if it looks numeric, else NULL.
cc_sqlnum() { local v="$1"; if [[ "$v" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then printf '%s' "$v"; else printf 'NULL'; fi; }
# Boolean literal: 1/0/NULL.
cc_sqlbool(){ case "$1" in true|1) printf 1;; false|0) printf 0;; *) printf 'NULL';; esac; }

# ---- schema (single source of truth) --------------------------------------
cc_schema_sql() {
cat <<'SQL'
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

-- One row per Claude Code session (session_id == transcript filename UUID ==
-- ccflare clientSessionId). A single terminal sitting may span several ids
-- (each /clear or /compact restart mints a new session_id + SessionStart).
CREATE TABLE IF NOT EXISTS claude_sessions (
  session_id     TEXT PRIMARY KEY,
  launch_id      TEXT,            -- correlates to the cc-track.sh launcher run (via THEONE_LAUNCH_ID)
  terminal_app   TEXT,            -- "terax" | "iterm" | "vscode" | ... (best-effort)
  profile        TEXT,            -- THEONE_PROFILE (e.g. "theone")
  cwd            TEXT,
  repo           TEXT,
  project_path   TEXT,            -- git toplevel of cwd; NULL = not in a repo
  model          TEXT,
  source         TEXT,            -- SessionStart.source: startup|resume|clear|compact
  started_at     INTEGER,         -- epoch seconds
  ended_at       INTEGER,         -- epoch seconds (SessionEnd / launcher close)
  end_reason     TEXT,            -- SessionEnd.reason | launcher_exit | rollup_orphan
  -- WARNING: NOT a valid session duration, and read by nothing. A session_id
  -- survives --resume, so (ended_at - started_at) spans every dormant calendar
  -- gap between sittings: on the real DB this column sums to 10,370 hours
  -- against 186h of active and 934h of window time. Booking it is precisely the
  -- ~10,389-hour phantom this project exists to correct. It is still written on
  -- SessionEnd for raw-capture fidelity; the ONLY valid session duration is
  -- window_s, summed per gap by capture/rollup.sh. Do not read this column.
  duration_ms    INTEGER,         -- (ended_at - started_at) * 1000 -- see above
  prompts        INTEGER DEFAULT 0,
  compacts       INTEGER DEFAULT 0,
  subagents      INTEGER DEFAULT 0,
  updated_at     INTEGER
);

-- Append-only stream of hook events (the activity heartbeat used for active-time).
CREATE TABLE IF NOT EXISTS claude_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ts               INTEGER NOT NULL,      -- epoch seconds
  session_id       TEXT,
  launch_id        TEXT,
  hook_event_name  TEXT NOT NULL,
  cwd              TEXT,
  repo             TEXT,
  project_path     TEXT,                  -- git toplevel of cwd; NULL = not in a repo
  model            TEXT,
  terminal_app     TEXT,
  payload_json     TEXT                   -- compact, PII-light: source/reason/trigger/tool/agent/prompt_len
);
CREATE INDEX IF NOT EXISTS idx_events_session ON claude_events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON claude_events(ts);
CREATE INDEX IF NOT EXISTS idx_events_name    ON claude_events(hook_event_name);

-- Throttled (<=1/60s per session) status-line snapshots: tokens/context/cost/limits.
CREATE TABLE IF NOT EXISTS claude_status_snapshots (
  id                                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id                            TEXT,
  ts                                    INTEGER NOT NULL,
  cwd                                   TEXT,
  repo                                  TEXT,
  project_path                          TEXT,
  model                                 TEXT,
  effort                                TEXT,
  thinking_enabled                      INTEGER,
  context_used_percentage               REAL,
  context_window_size                   INTEGER,
  input_tokens                          INTEGER,
  output_tokens                         INTEGER,
  cache_read_tokens                     INTEGER,
  cache_creation_tokens                 INTEGER,
  cache_hit_percentage                  REAL,
  total_cost_usd                        REAL,
  total_duration_ms                     INTEGER,
  total_api_duration_ms                 INTEGER,
  total_lines_added                     INTEGER,
  total_lines_removed                   INTEGER,
  five_hour_rate_limit_used_percentage  REAL,
  seven_day_rate_limit_used_percentage  REAL
);
CREATE INDEX IF NOT EXISTS idx_snap_session ON claude_status_snapshots(session_id);
CREATE INDEX IF NOT EXISTS idx_snap_ts      ON claude_status_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_events_projpath ON claude_events(project_path);

-- Derived daily history (rebuilt idempotently by claude-usage-rollup.sh).
CREATE TABLE IF NOT EXISTS claude_daily_rollups (
  day                    TEXT PRIMARY KEY,   -- YYYY-MM-DD (local, session start day)
  total_session_ms       INTEGER DEFAULT 0,
  active_ms              INTEGER DEFAULT 0,
  idle_ms                INTEGER DEFAULT 0,
  sessions_count         INTEGER DEFAULT 0,
  tokens_in              INTEGER DEFAULT 0,
  tokens_out             INTEGER DEFAULT 0,
  tokens_cache_read      INTEGER DEFAULT 0,
  tokens_cache_creation  INTEGER DEFAULT 0,
  cache_hit_percentage   REAL    DEFAULT 0,
  cost_usd               REAL    DEFAULT 0,
  repos_json             TEXT,               -- {"repo": active_seconds, ...}
  models_json            TEXT,               -- {"model": sessions, ...}
  compacts               INTEGER DEFAULT 0,
  clears                 INTEGER DEFAULT 0,
  subagents              INTEGER DEFAULT 0,
  prompts                INTEGER DEFAULT 0,
  avg_context_pct        REAL    DEFAULT 0,
  peak_context_pct       REAL    DEFAULT 0,
  hygiene_score          REAL    DEFAULT 0,
  updated_at             INTEGER
);

-- Singleton lifetime rank/XP snapshot (rebuilt by the rollup).
CREATE TABLE IF NOT EXISTS claude_rank_progress (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  total_hours          REAL    DEFAULT 0,
  active_hours         REAL    DEFAULT 0,
  lifetime_cost_usd    REAL    DEFAULT 0,
  lifetime_tokens_in   INTEGER DEFAULT 0,
  lifetime_tokens_out  INTEGER DEFAULT 0,
  sessions_count       INTEGER DEFAULT 0,
  rank_index           INTEGER DEFAULT 0,
  rank_name            TEXT,
  hours_into_rank      REAL    DEFAULT 0,
  hours_to_next        REAL,
  next_rank_name       TEXT,
  xp                   REAL    DEFAULT 0,
  hygiene_score        REAL    DEFAULT 0,
  updated_at           INTEGER
);
SQL
}

# ---- init (idempotent, guarded by a per-version marker) --------------------
cc_init_db() {
  cc_have_deps || return 0
  local dir marker db
  dir="$(cc_db_dir)"; db="$(cc_db_path)"
  marker="$dir/.schema-v${CC_SCHEMA_VERSION}"
  mkdir -p "$dir" 2>/dev/null || return 0
  # Fast path: schema already applied for this version and the DB exists.
  if [ -f "$marker" ] && [ -f "$db" ]; then return 0; fi
  # v1 -> v2: CREATE TABLE IF NOT EXISTS never alters an existing table, so the
  # new nullable columns are added explicitly, BEFORE cc_schema_sql runs below.
  # cc_schema_sql's CREATE INDEX idx_events_projpath ON claude_events(project_path)
  # requires the column to already exist on an existing (pre-v2) claude_events
  # table -- CREATE TABLE IF NOT EXISTS silently skips a table that already
  # exists, so without this ordering the index statement fails with "no such
  # column: project_path", the whole piped script exits non-zero, and the
  # marker below is never written. Each ALTER fails harmlessly with "duplicate
  # column name" once already applied (or if the table doesn't exist yet on a
  # brand-new DB, where cc_schema_sql below creates it with the column
  # present), which is why every one is independently swallowed rather than
  # run under .bail on.
  for _t in claude_events claude_sessions claude_status_snapshots; do
    sqlite3 "$db" "ALTER TABLE $_t ADD COLUMN project_path TEXT;" >/dev/null 2>&1 || true
  done
  # Materialize schema.sql (for the user's reference) and apply it.
  cc_schema_sql > "$dir/schema.sql" 2>/dev/null || true
  # Redirect stdout too: PRAGMA journal_mode=WAL prints "wal", which must never
  # leak into a hook's or the status line's output.
  cc_schema_sql | sqlite3 "$db" >/dev/null 2>&1 && : > "$marker" 2>/dev/null || true
  return 0
}

# ---- low-level exec (best-effort, never fails the caller) ------------------
# cc_sql "<sql>"  -> runs against the DB with a busy timeout; swallows errors.
cc_sql() {
  cc_have_deps || return 0
  sqlite3 -cmd ".timeout 4000" "$(cc_db_path)" "$1" >/dev/null 2>&1 || true
}
# cc_sql_val "<select>" -> single scalar to stdout (empty on error).
cc_sql_val() {
  cc_have_deps || return 0
  sqlite3 -cmd ".timeout 4000" "$(cc_db_path)" "$1" 2>/dev/null || true
}

# ---- context helpers -------------------------------------------------------
# Git toplevel PATH for a cwd, or empty when the cwd is not in a repo.
# Deliberately NOT basename'd: the PATH is the project key, the basename is only
# how it is displayed, so two same-named repos under different parents stay
# distinct rows. Empty is meaningful and means Unfiled.
# This is the ONLY function that forks git for this purpose: cc_repo below
# derives its basename-only label from THIS function's result rather than
# invoking git a second time, so a caller that needs both (hook.sh,
# snapshot.sh) computes project_path once via this function and derives repo
# from that same result inline instead of also calling cc_repo -- so recording
# the toplevel costs no additional subprocess on the hook path. Calling
# cc_repo() itself is still one git fork (it delegates to this function), so a
# caller that already has the toplevel should not call cc_repo redundantly.
cc_project_path() {
  local d="$1"
  [ -z "$d" ] && { printf ''; return 0; }
  git -C "$d" --no-optional-locks rev-parse --show-toplevel 2>/dev/null || printf ''
}

# Repo label for a cwd: git top-level basename, else cwd basename, else "".
# Delegates to cc_project_path for the git call so there is exactly one
# implementation of "find the toplevel" in this file.
cc_repo() {
  local d="$1" top
  [ -z "$d" ] && { printf ''; return; }
  top="$(cc_project_path "$d")"
  if [ -n "$top" ]; then basename "$top"; else basename "$d"; fi
}

# Best-effort terminal app tag. Honors an explicit THEONE_TERMINAL_APP, then the
# Terax marker your other hooks already use, then TERM_PROGRAM, else "unknown".
cc_terminal_app() {
  if [ -n "$THEONE_TERMINAL_APP" ]; then printf '%s' "$THEONE_TERMINAL_APP"; return; fi
  if [ -n "$TERAX_TERMINAL" ]; then printf 'terax'; return; fi
  case "$TERM_PROGRAM" in
    iTerm.app) printf 'iterm' ;;
    Apple_Terminal) printf 'apple-terminal' ;;
    vscode) printf 'vscode' ;;
    WarpTerminal) printf 'warp' ;;
    "") printf 'unknown' ;;
    *) printf '%s' "$TERM_PROGRAM" ;;
  esac
}
