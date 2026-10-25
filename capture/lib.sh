#!/usr/bin/env bash
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
# The database lives at ~/.theone/claude-code-usage.sqlite on any install that
# already has one, and at ~/.watchtower/watchtower.sqlite on a fresh machine
# (override WATCHTOWER_DB_PATH, or the deprecated THEONE_DB_PATH alias).
# It is the user's own durable, local capture store — regenerable rollups derive
# from the raw event/session/snapshot tables.

# ---- config ---------------------------------------------------------------
CC_SCHEMA_VERSION=11

# Database location. This MUST resolve identically to defaultDbPath() in
# lib/config.ts: that is the reader, this is the writer, they are two languages
# aimed at one file, and every write on the hook path swallows its own error.
# A split between them therefore shows up as an empty dashboard rather than as
# a failure -- WATCHTOWER_DB_PATH shipped to the reader alone and did exactly
# that.
#
# The fresh-machine branch only ever fires where no legacy database exists, so
# an existing install never moves and TheOneOS keeps reading the file it knows.
cc_db_path() {
  if [ -n "${WATCHTOWER_DB_PATH:-}" ]; then printf '%s' "$WATCHTOWER_DB_PATH"; return; fi
  if [ -n "${THEONE_DB_PATH:-}" ]; then printf '%s' "$THEONE_DB_PATH"; return; fi
  if [ -f "$HOME/.theone/claude-code-usage.sqlite" ]; then
    printf '%s' "$HOME/.theone/claude-code-usage.sqlite"
  else
    printf '%s' "$HOME/.watchtower/watchtower.sqlite"
  fi
}
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
  updated_at             INTEGER,
  -- Stage 4B (schema v6): API-rate cost and its coverage, filled by rollup.sh.
  cost_table_usd         REAL    DEFAULT 0,
  priced_requests        INTEGER DEFAULT 0,
  unpriced_requests      INTEGER DEFAULT 0,
  sessions_with_cost     INTEGER DEFAULT 0
);

-- cwd -> git toplevel, resolved once and KEPT. A row here is a durable answer to
-- a question the filesystem may stop being able to answer: a project deleted
-- next week keeps the attribution it had this week. Never DELETEd by the
-- rebuild -- unlike the rollup tables, this one is not regenerable.
CREATE TABLE IF NOT EXISTS claude_project_paths (
  cwd           TEXT PRIMARY KEY,
  project_path  TEXT,              -- NULL: resolved, and not a repo -> (unfiled)
  resolved_at   INTEGER NOT NULL,
  source        TEXT NOT NULL      -- 'git' | 'gone' | 'excluded'
);

-- Derived per-project daily history. Same rebuild discipline as
-- claude_daily_rollups: DELETE + re-INSERT inside the same transaction, under
-- .bail on, so a failure mid-rebuild cannot commit a half-built table.
CREATE TABLE IF NOT EXISTS claude_project_rollups (
  project_key            TEXT NOT NULL,
  day                    TEXT NOT NULL,     -- YYYY-MM-DD, local, session START day
  display_name           TEXT,              -- basename at resolution time, for a vanished path
  active_ms              INTEGER DEFAULT 0,
  window_ms              INTEGER DEFAULT 0,
  idle_ms                INTEGER DEFAULT 0,
  sessions_count         INTEGER DEFAULT 0,
  prompts                INTEGER DEFAULT 0,
  compacts               INTEGER DEFAULT 0,
  clears                 INTEGER DEFAULT 0,
  subagents              INTEGER DEFAULT 0,
  tokens_in              INTEGER DEFAULT 0,
  tokens_out             INTEGER DEFAULT 0,
  tokens_cache_read      INTEGER DEFAULT 0,
  tokens_cache_creation  INTEGER DEFAULT 0,
  cost_usd               REAL    DEFAULT 0,
  models_json            TEXT,              -- {"model": {"sessions":N,"thinking":N,"effort":{...}}}
  peak_context_pct       REAL    DEFAULT 0,
  avg_context_pct        REAL    DEFAULT 0,
  updated_at             INTEGER,
  -- Stage 4B (schema v6), as on claude_daily_rollups.
  cost_table_usd         REAL    DEFAULT 0,
  priced_requests        INTEGER DEFAULT 0,
  unpriced_requests      INTEGER DEFAULT 0,
  sessions_with_cost     INTEGER DEFAULT 0,
  PRIMARY KEY (project_key, day)
);
CREATE INDEX IF NOT EXISTS idx_projroll_day ON claude_project_rollups(day);

-- Singleton lifetime rank/XP snapshot (rebuilt by the rollup).
-- DEPRECATED (Stage 5): the 5,000 h ladder. Still written exactly as before, for TheOneOS until its lockstep PR merges; agent_progress replaces it. Not removed in Stage 5.
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

-- One row per Claude API request, ingested from ~/.claude/projects transcripts
-- by ingest.sh. DURABLE, unlike the rollup tables: it is never DELETEd and
-- rebuilt, because transcripts are deleted after cleanupPeriodDays and a
-- rebuild-from-filesystem design would zero the token history the day cleanup
-- ran. Same reasoning as claude_project_paths -- a cached answer must outlive
-- the thing it was derived from.
--
-- request_id is the idempotency key. 47% of transcript usage rows are
-- duplicates of one already seen (49,774 rows -> 26,270 requests measured
-- 2026-09-11), and 2,115 requestIds carry monotonically GROWING output_tokens
-- across copies because streaming writes partials. So the upsert takes MAX per
-- token field, never first-seen: see ingest.sh.
--
-- Deliberately NO project_path column. Stage 1.5 shipped
-- claude_events.project_path, which nothing reads; cwd resolves through
-- claude_project_paths at rollup time instead.
CREATE TABLE IF NOT EXISTS claude_requests (
  request_id             TEXT PRIMARY KEY,
  message_id             TEXT,
  session_id             TEXT,    -- joins claude_sessions, but MAY NOT MATCH ONE:
                                  -- 22.4% of requests predate the tracker
  ts                     INTEGER, -- unix seconds, from the ISO timestamp
  cwd                    TEXT,
  git_branch             TEXT,
  model                  TEXT,
  effort                 TEXT,
  service_tier           TEXT,
  is_sidechain           INTEGER DEFAULT 0,
  entrypoint             TEXT,
  cc_version             TEXT,
  tokens_in              INTEGER DEFAULT 0,
  tokens_out             INTEGER DEFAULT 0,
  tokens_cache_read      INTEGER DEFAULT 0,
  tokens_cache_creation  INTEGER DEFAULT 0,
  attribution_skill      TEXT,
  attribution_mcp_server TEXT,
  attribution_mcp_tool   TEXT,
  attribution_plugin     TEXT,
  api_error_status       TEXT,
  ingested_at            INTEGER,
  -- Stage 4B (schema v6). NULL means "not recorded", never 0: rows from before
  -- the upgrade, or with no transcript left to backfill from, stay NULL.
  first_ms               INTEGER, -- ms, first partial (NULL-aware MIN)
  last_ms                INTEGER, -- ms, last partial (NULL-aware MAX)
  sent_ms                INTEGER, -- ms, the user entry before it (NULL-aware MIN)
  cache_write_5m         INTEGER, -- usage.cache_creation.ephemeral_5m_input_tokens
  cache_write_1h         INTEGER, -- usage.cache_creation.ephemeral_1h_input_tokens
  speed                  TEXT     -- 'standard' | 'fast' | NULL
);
CREATE INDEX IF NOT EXISTS idx_requests_ts      ON claude_requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_session ON claude_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_requests_skill   ON claude_requests(attribution_skill);
CREATE INDEX IF NOT EXISTS idx_requests_cwd     ON claude_requests(cwd);

-- Per-file ingest progress. ADVISORY ONLY: correctness comes from
-- claude_requests.request_id being a primary key, so deleting this table costs
-- a slower run and nothing else. Never treat a cursor as proof a file was read.
CREATE TABLE IF NOT EXISTS claude_ingest_cursor (
  file_path  TEXT PRIMARY KEY,
  bytes_read INTEGER,
  mtime      INTEGER,
  updated_at INTEGER,
  last_user_ms INTEGER  -- v6: ms of the file's last type=="user" entry read so far
);

-- Stage 4A (schema v5). One row per distinct tool_use id, from the tool_use
-- and tool_result blocks in ~/.claude/projects transcripts. DURABLE, like
-- claude_requests, for the same reason: transcripts are deleted after
-- cleanupPeriodDays. A tool_use and its tool_result routinely land in
-- SEPARATE ingest runs -- the result is only written once the tool finishes,
-- often after the SessionEnd hook that ingested the tool_use side has already
-- run -- so this row is assembled incrementally across runs and must survive
-- between them.
--
-- The cross-run merge is idempotent, so replaying a file changes nothing. It
-- is order-independent for ts, is_sidechain, is_error and tool_name -- the
-- fields a number reads:
--   - ts, is_sidechain: the smaller non-NULL value (MIN).
--   - is_error: a NULL-aware MAX -- NULL only while neither side has ever
--     seen a tool_result, then 0/1 once one has.
--   - tool_name: COALESCE(existing, excluded), and every copy of a tool_use
--     carries the same name.
-- The other COALESCE fields (request_id, session_id, mcp_server) keep the
-- FIRST non-NULL arrival, which is NOT order-independent: 157 live tool_use
-- ids carry sessionIds that differ across files. No number reads those
-- fields. See ingest.sh for the upsert.
CREATE TABLE IF NOT EXISTS claude_tool_calls (
  tool_use_id  TEXT PRIMARY KEY,
  request_id   TEXT,              -- NULL until the tool_use side is seen
  session_id   TEXT,
  ts           INTEGER,           -- unix seconds of the tool_use entry
  tool_name    TEXT,              -- NULL until the tool_use side is seen
  mcp_server   TEXT,              -- NULL unless tool_name is mcp__*
  is_error     INTEGER,           -- NULL until the tool_result is seen; then 0/1
  is_sidechain INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_ts      ON claude_tool_calls(ts);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON claude_tool_calls(session_id);

-- One row per slash-command transcript entry (e.g. "/compact"). DURABLE for
-- the same reason as claude_tool_calls above. A slash command is a fact about
-- ONE transcript line that is never revised after the fact, so there is
-- nothing to merge across runs: INSERT OR IGNORE on entry_uuid makes
-- re-ingesting a file the entry was already read from (including a
-- --backfill re-read) a no-op.
CREATE TABLE IF NOT EXISTS claude_slash_commands (
  entry_uuid   TEXT PRIMARY KEY,
  session_id   TEXT,
  ts           INTEGER,
  command      TEXT NOT NULL      -- e.g. "/compact"
);
CREATE INDEX IF NOT EXISTS idx_slash_ts ON claude_slash_commands(ts);

-- Stage 4B (schema v6). Turn boundaries (spec 3.3): one row per main-thread,
-- non-meta user entry with content and no tool_result. DURABLE, like
-- claude_slash_commands, for the same reason. A forked session repeats a
-- boundary uuid under another sessionId, so session_id follows
-- claude_requests.session_id's rule exactly: MAX within a batch, first arrival
-- across batches (ON CONFLICT DO NOTHING). See ingest.sh.
CREATE TABLE IF NOT EXISTS claude_prompts (
  entry_uuid TEXT PRIMARY KEY,
  session_id TEXT,
  ts_ms      INTEGER NOT NULL,
  kind       TEXT NOT NULL      -- prompt | command | notification | local | interrupt
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON claude_prompts(session_id, ts_ms);

-- REGENERABLE: rollup.sh rebuilds all three every run (DELETE + INSERT from temp).
-- Shipped empty under v6 with the durable table above, so a v6 marker never
-- predates a table the rollup fills.
CREATE TABLE IF NOT EXISTS claude_prices (
  model TEXT NOT NULL, speed TEXT NOT NULL, effective_from TEXT NOT NULL,
  input REAL NOT NULL, output REAL NOT NULL, cache_read REAL NOT NULL,
  cache_write_5m REAL NOT NULL, cache_write_1h REAL NOT NULL,
  verified_on TEXT NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY (model, speed, effective_from)
);
CREATE TABLE IF NOT EXISTS claude_request_metrics (
  request_id TEXT PRIMARY KEY, day TEXT NOT NULL, session_id TEXT, model TEXT,
  is_sidechain INTEGER,
  priced INTEGER, price_note TEXT, cost_table_usd REAL,
  cost_write_5m_usd REAL, cost_write_1h_usd REAL,     -- plan P1
  response_ms INTEGER, tok_per_s REAL
);
CREATE INDEX IF NOT EXISTS idx_request_metrics_day ON claude_request_metrics(day);
CREATE TABLE IF NOT EXISTS claude_turns (
  entry_uuid TEXT PRIMARY KEY, session_id TEXT, day TEXT NOT NULL, kind TEXT NOT NULL,
  requests INTEGER NOT NULL, wait_ms INTEGER, status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_turns_day ON claude_turns(day);

-- Stage 4A Usage Profile output. REGENERABLE, like claude_daily_rollups:
-- rebuilt with DELETE + re-INSERT inside capture/rollup.sh's own transaction,
-- from claude_requests, claude_tool_calls, claude_slash_commands and
-- claude_events. Shipped here empty under schema v5, alongside the durable
-- pair above, so a v5 marker never predates a table the profile rollup fills
-- -- every table Stage 4A needs exists from the first v5 init, whether or not
-- the rollup that fills them has run yet.
CREATE TABLE IF NOT EXISTS claude_profile_daily (
  day TEXT PRIMARY KEY,
  window_requests INTEGER NOT NULL,
  tool_covered INTEGER NOT NULL,          -- 0/1
  total INTEGER, measured INTEGER, tier_index INTEGER, tier_points_to_next INTEGER,
  total_wow INTEGER,
  matrix_score INTEGER, matrix_tier INTEGER, matrix_points_to_next INTEGER,
  f_context INTEGER, f_compaction INTEGER, f_session_length INTEGER, f_efficiency INTEGER,
  median_ctx REAL, median_requests REAL, long_sessions INTEGER, long_with_reset INTEGER,
  cache_fresh_ratio REAL,
  matrix_7d INTEGER, matrix_wow INTEGER,
  event_covered INTEGER NOT NULL DEFAULT 0  -- v6: 0/1, spec 4B §4.5
);
CREATE TABLE IF NOT EXISTS claude_discipline_scores (
  day TEXT NOT NULL,
  discipline TEXT NOT NULL,               -- 'prompt-hygiene', … TheOne's ids
  score INTEGER NOT NULL,                 -- 0–60; 0 when needs-data
  status TEXT NOT NULL,                   -- needs-data | needs-work | ok | strong
  definition TEXT NOT NULL,               -- 'theone' | 'watchtower'
  evidence_json TEXT NOT NULL,            -- raw numbers only, e.g. {"slash_kinds":4}
  PRIMARY KEY (day, discipline)
);

-- Stage 5 (schema v7): the agent rollups. All four are REGENERABLE -- rollup.sh's
-- agent section DELETEs and re-INSERTs them on every run, from wt_* (written by
-- `watchtower sync`, never by a hook) and claude_daily_rollups.
CREATE TABLE IF NOT EXISTS agent_prices (
  model          TEXT NOT NULL,
  effective_from TEXT NOT NULL,           -- YYYY-MM-DD, UTC midnight
  input          REAL NOT NULL,           -- USD per 1M tokens
  cached_input   REAL NOT NULL,
  output         REAL NOT NULL,
  verified_on    TEXT NOT NULL,
  source         TEXT NOT NULL,           -- the pricing page the row was read from
  PRIMARY KEY (model, effective_from)
);

CREATE TABLE IF NOT EXISTS agent_request_metrics (
  source           TEXT NOT NULL,         -- 'codex' | 'hermes'
  source_record_id TEXT NOT NULL,
  canonical_id     TEXT,
  day              TEXT NOT NULL,         -- local day of the request
  project_key      TEXT NOT NULL,         -- its session's, as claude_project_paths resolves the cwd
  model            TEXT,
  priced           INTEGER,               -- NULL for Hermes; 0 with a price_note; 1
  price_note       TEXT,                  -- 'no-price-yet' | 'unknown-model' | 'no-public-rate'
  cost_table_usd   REAL,                  -- at API prices; NULL unless priced = 1
  own_cost_usd     REAL,                  -- Hermes's figure; NULL when Hermes did not price it
  PRIMARY KEY (source, source_record_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_request_metrics_day ON agent_request_metrics(source, day);

CREATE TABLE IF NOT EXISTS agent_daily_rollups (
  source                TEXT NOT NULL,
  day                   TEXT NOT NULL,    -- local day
  project_key           TEXT NOT NULL,
  active_s              INTEGER,          -- NULL: no driven gap on this row. Never 0 for "not measured".
  sessions_driven       INTEGER NOT NULL DEFAULT 0,   -- by start day
  sessions_automated    INTEGER NOT NULL DEFAULT 0,
  sessions_unclassified INTEGER NOT NULL DEFAULT 0,
  requests              INTEGER NOT NULL DEFAULT 0,
  tokens_in             INTEGER NOT NULL DEFAULT 0,
  tokens_out            INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read     INTEGER NOT NULL DEFAULT 0,
  tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
  -- Sums beside their counts: a reader decides "not priced" from the counts, never from a $0.
  cost_table_usd        REAL    NOT NULL DEFAULT 0,
  priced_requests       INTEGER NOT NULL DEFAULT 0,
  unpriced_requests     INTEGER NOT NULL DEFAULT 0,
  own_cost_usd          REAL    NOT NULL DEFAULT 0,
  own_priced_requests   INTEGER NOT NULL DEFAULT 0,
  own_unpriced_requests INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (source, day, project_key)
);

CREATE TABLE IF NOT EXISTS agent_progress (
  source        TEXT PRIMARY KEY,         -- 'claude' | 'codex' | 'hermes'
  active_s      INTEGER NOT NULL,         -- lifetime driven seconds
  xp            INTEGER NOT NULL,
  level         INTEGER,                  -- NULL when active_s = 0: no level, never Lv 1 for nothing
  tier          TEXT,
  xp_into_level INTEGER,
  xp_to_next    INTEGER,                  -- NULL at 99
  s_to_next     INTEGER,                  -- NULL at 99
  stars         INTEGER,                  -- one per 900,000 s past 9,000,000; NULL with no level
  updated_at    INTEGER NOT NULL
);

-- Stage 6 (schema v8): the Character page. All regenerable. claude_model_rollups
-- is filled by section 1 of rollup.sh, which holds Claude's per-gap rows; the
-- skill_* tables by the agent section, beside agent_progress.
CREATE TABLE IF NOT EXISTS claude_model_rollups (
  day        TEXT NOT NULL,              -- YYYY-MM-DD, local, session START day (as claude_daily_rollups)
  model      TEXT NOT NULL,              -- the driving model; '(no model)' when none is known
  active_ms  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, model)
);

CREATE TABLE IF NOT EXISTS skill_daily (
  source    TEXT NOT NULL,               -- 'claude' | 'codex' | 'hermes'
  kind      TEXT NOT NULL,               -- 'tool' | 'project' | 'model' | 'skill' | 'pack' | 'skill-use'
  key       TEXT NOT NULL,               -- the source, a project_key, or a model
  day       TEXT NOT NULL,               -- Claude: session start day, agents: the gap's end day
  active_ms INTEGER NOT NULL,            -- > 0: a day without time has no row
  PRIMARY KEY (source, kind, key, day)
);

CREATE TABLE IF NOT EXISTS skill_progress (
  source        TEXT NOT NULL,
  kind          TEXT NOT NULL,
  key           TEXT NOT NULL,
  active_s      INTEGER NOT NULL,        -- > 0: no seconds, no row, never Lv 1
  xp            INTEGER NOT NULL,
  level         INTEGER NOT NULL,
  tier          TEXT NOT NULL,
  xp_into_level INTEGER NOT NULL,
  xp_to_next    INTEGER,                 -- NULL at 99
  s_to_next     INTEGER,                 -- NULL at 99
  stars         INTEGER NOT NULL,
  first_day     TEXT NOT NULL,
  last_day      TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (source, kind, key)
);

CREATE TABLE IF NOT EXISTS skill_level_ups (
  source       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  key          TEXT NOT NULL,
  level        INTEGER NOT NULL,         -- 2..200 (Lv 1 is never logged)
  day          TEXT NOT NULL,            -- the first day whose end-of-day XP reached xp(level)
  tier         TEXT NOT NULL,            -- the tier at this level
  tier_changed INTEGER NOT NULL,         -- 1 when this level opens a new tier
  PRIMARY KEY (source, kind, key, level)
);

CREATE TABLE IF NOT EXISTS skill_pace (
  source          TEXT PRIMARY KEY,      -- a tool, or 'all'
  as_of_day       TEXT NOT NULL,
  xp_today        INTEGER NOT NULL,
  xp_7d           INTEGER NOT NULL,
  xp_28d          INTEGER NOT NULL,
  pace_xp_per_day REAL NOT NULL,         -- xp_28d / 28.0: per CALENDAR day
  eta_next_days   INTEGER,               -- NULL with no pace, at 200, or with no level, and never 0
  eta_99_days     INTEGER,
  streak_current  INTEGER NOT NULL,
  streak_best     INTEGER NOT NULL,
  eta_cap_days    INTEGER                -- v11: days to xp(current cap) at the 28-day pace; NULL for 'all', with no pace or level, at 200
);

-- Stage 7 (schema v9): Claude Code skills as sub-skills. claude_skill_rollups is
-- regenerable, filled by section 1 of rollup.sh beside claude_model_rollups.
CREATE TABLE IF NOT EXISTS claude_skill_rollups (
  day        TEXT NOT NULL,              -- YYYY-MM-DD, local, session START day (as claude_daily_rollups)
  skill      TEXT NOT NULL,              -- attribution_skill of the main-thread request at the gap's end
  active_ms  INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, skill)
);

-- DURABLE, like claude_project_paths: each skill name's pack, resolved once by
-- rollup.sh's _resolve_new_skills (spec 4.3) and never updated or deleted, so
-- uninstalling a pack moves no history.
CREATE TABLE IF NOT EXISTS claude_skill_packs (
  skill       TEXT PRIMARY KEY,
  pack        TEXT NOT NULL,             -- a plugin, a skills folder others link into (its own router skill included), or '(no pack)'
  via         TEXT NOT NULL,             -- 'plugin' | 'link' | 'none'
  resolved_at INTEGER NOT NULL
);

-- Stage 8 (schema v10): each week's quests, regenerable, filled by rollup.sh's
-- profile section. week is the Monday; value NULL means not measured.
CREATE TABLE IF NOT EXISTS claude_quests (
  week       TEXT    NOT NULL,           -- YYYY-MM-DD, the week's Monday, local
  week_end   TEXT    NOT NULL,           -- YYYY-MM-DD, its Sunday
  slot       INTEGER NOT NULL,           -- 1-3, lowest score first
  discipline TEXT    NOT NULL,
  score      INTEGER NOT NULL,           -- the 30-day score on the Sunday before, which chose it
  direction  TEXT    NOT NULL,           -- 'at-least' | 'at-most'
  baseline   REAL    NOT NULL,           -- last week's value
  target     REAL    NOT NULL,
  hold       INTEGER NOT NULL,           -- 1: the baseline was already at full marks
  value      REAL,                       -- this week's, at the quest's precision; NULL = not measured
  requests   INTEGER NOT NULL,           -- this week's requests so far
  status     TEXT    NOT NULL,           -- 'open' | 'done' | 'missed' | 'no data'
  PRIMARY KEY (week, slot),
  UNIQUE (week, discipline)
);

-- Stage 8: every achievement's four tiers, per tool, and the two point totals.
-- Regenerable, filled by rollup.sh's agent section.
CREATE TABLE IF NOT EXISTS achievement_tiers (
  achievement  TEXT    NOT NULL,
  source       TEXT    NOT NULL,         -- 'claude' | 'codex' | 'hermes'
  tier         INTEGER NOT NULL,         -- 1 bronze .. 4 platinum
  threshold    INTEGER NOT NULL,
  value        INTEGER,                  -- the current value; NULL = nothing measured (no level)
  unlocked_day TEXT,                     -- the first day history reached the threshold; NULL = locked
  points       INTEGER NOT NULL,         -- the tier when unlocked, else 0
  updated_at   INTEGER,
  PRIMARY KEY (achievement, source, tier)
);
CREATE TABLE IF NOT EXISTS character_points (
  qp         INTEGER NOT NULL,           -- Quest Points: quests done
  ap         INTEGER NOT NULL,           -- Achievement Points: the sum of achievement_tiers.points
  updated_at INTEGER
);

-- Stage 10 (schema v11): the as-of day's 7-day discipline scores, regenerable,
-- filled by rollup.sh's profile section beside claude_discipline_scores. Only
-- the boost reads them, so only the as-of day is scored (spec 4.2).
CREATE TABLE IF NOT EXISTS claude_discipline_scores_7d (
  day        TEXT    NOT NULL,           -- the as-of day only
  discipline TEXT    NOT NULL,
  score      INTEGER NOT NULL,           -- 0-60; 0 when needs-data, as in claude_discipline_scores
  status     TEXT    NOT NULL,           -- the same rules as claude_discipline_scores
  PRIMARY KEY (day, discipline)
);

-- Stage 10: the six attributes and the level caps. Regenerable, filled by
-- rollup.sh's agent section.
CREATE TABLE IF NOT EXISTS character_attributes (
  attribute     TEXT    PRIMARY KEY,     -- 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
  ord           INTEGER NOT NULL,        -- 1-6, display order
  as_of_day     TEXT    NOT NULL,
  form_30       INTEGER,                 -- 0-99; NULL = no reading
  form_7        INTEGER,                 -- 0-99; NULL = no reading
  boost         INTEGER,                 -- -10..10; NULL when either Form is NULL
  base_level    INTEGER,                 -- NULL with no attribute XP
  now_level     INTEGER,                 -- MAX(1, base_level + COALESCE(boost, 0)); NULL with no XP
  evidence_json TEXT    NOT NULL         -- constituents' 30-day scores, or STR's per-hour rates
);
CREATE TABLE IF NOT EXISTS level_caps (
  cap           INTEGER PRIMARY KEY,     -- 99, 120, 150, 170, 200
  reached_level INTEGER,                 -- the level that opened it; NULL for 99
  opened_day    TEXT,                    -- NULL for 99
  source        TEXT,                    -- the stat that opened it; NULL for 99
  kind          TEXT,
  key           TEXT
);
SQL
}

# Every column added to an EXISTING table after it first shipped, one
# "table|column definition" per line. cc_init_db reads this ONE list twice: to
# ALTER each column in, and to probe that each one is really there before it
# stamps the marker -- so the two cannot drift. The next new column goes at
# the end, with a CC_SCHEMA_VERSION bump.
cc_added_columns() {
cat <<'COLS'
claude_events|project_path TEXT
claude_sessions|project_path TEXT
claude_status_snapshots|project_path TEXT
claude_requests|first_ms INTEGER
claude_requests|last_ms INTEGER
claude_requests|sent_ms INTEGER
claude_requests|cache_write_5m INTEGER
claude_requests|cache_write_1h INTEGER
claude_requests|speed TEXT
claude_ingest_cursor|last_user_ms INTEGER
claude_daily_rollups|cost_table_usd REAL DEFAULT 0
claude_daily_rollups|priced_requests INTEGER DEFAULT 0
claude_daily_rollups|unpriced_requests INTEGER DEFAULT 0
claude_daily_rollups|sessions_with_cost INTEGER DEFAULT 0
claude_project_rollups|cost_table_usd REAL DEFAULT 0
claude_project_rollups|priced_requests INTEGER DEFAULT 0
claude_project_rollups|unpriced_requests INTEGER DEFAULT 0
claude_project_rollups|sessions_with_cost INTEGER DEFAULT 0
claude_profile_daily|event_covered INTEGER NOT NULL DEFAULT 0
skill_pace|eta_cap_days INTEGER
COLS
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
  # The added-column backfill (cc_added_columns: project_path since v2, the
  # Stage 4B columns since v6). It runs on EVERY init that misses the fast path
  # above -- not only a v1 database -- because there is one marker per version,
  # so a v2 -> v3 upgrade comes through here too. That is harmless: each ALTER
  # is run as its own sqlite3 call with its error swallowed independently, so
  # on anything already carrying the column every one fails with "duplicate
  # column name" and is discarded. This is why they are NOT run as one script
  # under .bail on. A fresh install gets every column from CREATE TABLE
  # instead, and each ALTER fails harmlessly first.
  #
  # The ORDERING is the part that must not move. CREATE TABLE IF NOT EXISTS
  # never alters an existing table, so on a genuinely pre-existing v1 database
  # cc_schema_sql's CREATE INDEX idx_events_projpath ON
  # claude_events(project_path) needs the ALTER-added column to already be
  # there. Get it backwards and the whole piped schema-apply exits non-zero: no
  # index, and no marker, so every later run repeats the failure.
  # tests/capture-scripts.test.ts pins this after exactly ONE cc_init_db call,
  # because a second call succeeds either way.
  #
  # NOTE FOR THE NEXT SCHEMA CHANGE: adding a TABLE to cc_schema_sql needs no
  # ALTER here (CREATE TABLE IF NOT EXISTS covers it) but it DOES need
  # CC_SCHEMA_VERSION bumped, or an existing install's marker short-circuits the
  # fast path above and the table never arrives. Stage 1.5 added
  # claude_project_paths and claude_project_rollups under an unchanged version
  # 2; rollup.sh then aborted its whole transaction on every v2 install -- and
  # it runs --quiet from the SessionEnd hook, so daily tracking simply went
  # stale in silence. Adding a COLUMN to an existing table needs both: the
  # version bump AND a line in cc_added_columns.
  #
  # Every call here waits out another writer's lock (.timeout, as cc_sql does):
  # every hook, the status line, ingest and the rollup all run this init, so at
  # an upgrade several race it. An ALTER can still lose that race, and the
  # schema apply succeeds without the column -- so the marker is stamped only
  # once the probe below proves every added column is there. Stamped without
  # it, the fast path would skip the ALTER for good and every later ingest
  # upsert would fail, silently under --quiet. No marker means the next init
  # simply retries.
  local _t _c probe=""
  while IFS='|' read -r _t _c; do
    [ -n "$_t" ] || continue
    sqlite3 -cmd ".timeout 4000" "$db" "ALTER TABLE $_t ADD COLUMN $_c;" >/dev/null 2>&1 || true
    probe="$probe SELECT ${_c%% *} FROM $_t LIMIT 0;"
  done <<< "$(cc_added_columns)"
  # Materialize schema.sql (for the user's reference) and apply it.
  # The redirect is GROUPED so 2>/dev/null covers the OPEN of schema.sql as well
  # as cc_schema_sql itself: written as `cc_schema_sql > f 2>/dev/null`, the
  # shell opens f before the stderr redirect is in effect, so a non-writable
  # directory leaks "No such file or directory" / "Permission denied" straight
  # to the caller -- a hook or the status line, both of which must say nothing.
  { cc_schema_sql > "$dir/schema.sql"; } 2>/dev/null || true
  # Redirect stdout too: PRAGMA journal_mode=WAL prints "wal", which must never
  # leak into a hook's or the status line's output.
  if cc_schema_sql | sqlite3 -cmd ".timeout 4000" "$db" >/dev/null 2>&1 \
     && sqlite3 -bail -cmd ".timeout 4000" "$db" "$probe" >/dev/null 2>&1; then
    : > "$marker" 2>/dev/null || true
  fi
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
# ${x##*/}, not basename -- the same expansion hook.sh and snapshot.sh inline.
# basename is a subprocess, and it parses a value beginning with "-" as an
# OPTION: it writes "basename: illegal option" to stderr and returns nothing,
# in a library whose whole posture is to fail silently. Once its two callers
# switched to the expansion, this was the last -- and only wrong -- copy of the
# rule. All three now behave identically, which is the point of having one
# documented helper at all.
cc_repo() {
  local d="$1" top
  [ -z "$d" ] && { printf ''; return; }
  top="$(cc_project_path "$d")"
  if [ -n "$top" ]; then printf '%s' "${top##*/}"; else printf '%s' "${d##*/}"; fi
}

# cc_is_excluded <cwd> [pattern...] -> exit 0 when cwd matches any pattern.
# A pattern is either a path PREFIX (matches the dir and everything under it) or
# a glob. Matching is bash `case` globbing, deliberately not a regex engine.
# The trailing-slash test is what stops /a/bc matching the prefix /a/b.
cc_is_excluded() {
  local d="$1"; shift
  local p
  for p in "$@"; do
    [ -z "$p" ] && continue
    # shellcheck disable=SC2254  # the unquoted $p) is the glob case, on purpose
    case "$d" in
      "$p"|"$p"/*) return 0 ;;
      $p) return 0 ;;
    esac
  done
  return 1
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
