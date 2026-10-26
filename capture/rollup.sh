#!/usr/bin/env bash
# claude-usage-rollup.sh — rebuild Watchtower's derived daily rollups + rank record.
#
# Idempotent: recomputes claude_daily_rollups and the claude_rank_progress singleton
# from the raw claude_sessions / claude_events / claude_status_snapshots /
# claude_requests tables. TOKENS come from claude_requests only (exact per-request
# counts out of the transcripts); the status-line snapshots report a CONTEXT
# WINDOW, which is wrong as a usage total by 63x on input and 201x on output.
# The in-app dashboard reads the raw tables LIVE, so this rollup is a persisted
# history + canonical rank snapshot (safe to re-run anytime; dropping it loses nothing).
#
# Run:  ~/.claude/claude-usage-rollup.sh            # rebuild + print today's summary
#       ~/.claude/claude-usage-rollup.sh --quiet    # rebuild silently (used by the SessionEnd hook)
#       ~/.claude/claude-usage-rollup.sh --resolve  # also resolve ALL pending cwd->project
#                                                    # cache rows in one pass, ignoring the
#                                                    # per-run cap (one-time backfill; see
#                                                    # WATCHTOWER_RESOLVE_PER_RUN below)
#
# Activity model (rev 3): time is attributed per GAP between consecutive hook
# events, classified by what the session was doing during that gap:
#   THINK  a gap ENDING at UserPromptSubmit (you were reading or typing) — and
#          any gap with no turn in flight — counts up to 300s, then it is idle.
#   WORK   a gap while a turn IS in flight counts IN FULL, up to a 14400s crash
#          sanity bound. The old rev-2 rule discarded any gap over 600s, which
#          silently threw away ~93h of long autonomous runs.
#   Gaps ending at SessionStart count 0: a resumed session_id spans the dormant
#          calendar gap between sittings, and booking it is the 10,389-hour bug
#          this model exists to correct.
# Session duration is the SUM of these per-gap windows (window_s), NEVER
# ended_at - started_at. A session is attributed to its (local) start day.
# The authoritative rules — including every cap constant — are the SQL below.

set -o pipefail
QUIET=0
RESOLVE_ALL=0
for _arg in "$@"; do
  case "$_arg" in
    --quiet)   QUIET=1 ;;
    --resolve) RESOLVE_ALL=1 ;;
  esac
done

LIB="${CC_LIB_PATH:-$HOME/.claude/cc-track-lib.sh}"
[ -f "$LIB" ] || { echo "cc-rollup: $LIB not found" >&2; exit 1; }
# shellcheck source=/dev/null
. "$LIB"
cc_have_deps || { [ "$QUIET" -eq 1 ] || echo "cc-rollup: sqlite3/jq required" >&2; exit 1; }
cc_init_db
DB="$(cc_db_path)"

# ---- resolve cwd -> project, once per cwd, cached forever --------------------
# Runs in BASH, above the SQL, because resolving a cwd means `git rev-parse` and
# SQL cannot shell out. Bounded by NEW cwds, not total: the steady state is one
# SELECT returning nothing. The cache is never rebuilt -- see cc_schema_sql.
#
# WATCHTOWER_EXCLUDE_PATHS is a newline-separated list, supplied by the caller
# (lib/config.ts owns the defaults). Empty means exclude nothing -- which is why
# the expansion below is ${VAR-...} and NOT ${VAR:-...}. The colon form
# substitutes the default when the variable is EMPTY as well as when it is
# unset, so an explicitly empty list silently resurrected all five defaults,
# contradicting this comment, lib/config.ts (where excludePaths: [] excludes
# exactly nothing) and the parity test that pins the two together.
#
# Defaults live here as well as in lib/config.ts because rollup.sh runs from the
# SessionEnd hook with no Node available to read the config file. config.ts is
# authoritative for the dashboard; these two lists must be kept in step, and
# tests/project-rollup.test.ts asserts they match.
WATCHTOWER_EXCLUDE_PATHS="${WATCHTOWER_EXCLUDE_PATHS-$(cat <<EOF
$HOME/Library/Application Support/CodexBar/ClaudeProbe
$HOME/.meridian
$HOME/Library/Application Support/Claude/scratch-workspaces
/private/tmp/claude-*
/private/var/folders/*/T/cc-headless-*
EOF
)}"

# Delete the cwds whose exclusion verdict flipped, bounded by the SAME limit the
# resolve SELECT below uses, so a run never deletes more rows than it can
# re-resolve in the same pass. That bound is the point: a deleted row is
# unresolved until it is resolved again, and an unresolved cwd keys to
# (unfiled) -- which the reader DISPLAYS. Uncapped, work the user has just asked
# to hide would sit in the most visible bucket until a later run caught up.
# Measured before the cap, at budget 1 with three flipped verdicts:
# (excluded) 1 / (unfiled) 4, then 2/3, then 3/2 over successive runs.
#
# `WHERE cwd IN (SELECT ... ORDER BY cwd LIMIT n)`, not `DELETE ... LIMIT n`:
# the latter needs the SQLITE_ENABLE_UPDATE_DELETE_LIMIT compile option, which
# the sqlite3 that happens to be on PATH may not carry (the Apple-supplied
# 3.54.0 on this machine does; a Homebrew build commonly does not). The subquery
# form is portable and needs no such option. ORDER BY cwd makes WHICH rows a
# capped run takes deterministic rather than left to the query planner.
# $1 is a comma-separated list of cc_sqlstr-encoded literals, $2 the LIMIT
# clause (empty under --resolve, meaning no bound).
_delete_flipped() {
  [ -z "$1" ] && return 0
  cc_sql "DELETE FROM claude_project_paths WHERE cwd IN (
            SELECT cwd FROM claude_project_paths WHERE cwd IN ($1) ORDER BY cwd$2);"
}

_resolve_new_cwds() {
  local unresolved cached cwd proj now src limit_sql per_run _flip
  # No git on PATH: cc_project_path returns empty for EVERY cwd, so each real
  # directory would be cached as source='git', project_path=NULL -- permanently
  # indistinguishable from "a real directory that is not a repo", and this table
  # is never rebuilt, so that wrong answer would be forever. Skip resolution for
  # this run instead; the next run with git present does it. (git is the only
  # dep this step adds; sqlite3 and jq are already checked by cc_have_deps.)
  command -v git >/dev/null 2>&1 || return 0
  # WATCHTOWER_EXCLUDE_PATHS is newline-separated, so it is split into an array
  # ONCE here, on newline only, rather than passed unquoted to cc_is_excluded
  # (word-splitting on the default IFS, which includes space). Three of the
  # five default patterns above contain a space (Library/Application Support/
  # ...), so an unquoted expansion silently turns each into two patterns that
  # match nothing -- the CodexBar probe (74% of sessions in the real DB) would
  # then be resolved as a normal project instead of excluded.
  local -a _pats=()
  local _p
  while IFS= read -r _p; do
    [ -n "$_p" ] && _pats+=("$_p")
  done <<EOF
$WATCHTOWER_EXCLUDE_PATHS
EOF
  # Step 13's measurement: resolving 75 already-captured cwds on the real DB
  # took ~1.2s (git rev-parse + a sqlite3 write per cwd, ~15ms/cwd), over the
  # ~1s budget for a run triggered from the SessionEnd hook. So an ordinary
  # run (no --resolve) is capped at WATCHTOWER_RESOLVE_PER_RUN new cwds; the
  # rest are picked up on later hook-triggered runs, or all at once via
  # `rollup.sh --resolve` (used for the one-time backfill of pre-Task-1 data).
  #
  # WATCHTOWER_RESOLVE_PER_RUN is the ONE value in the capture layer that is
  # interpolated into SQL rather than encoded by cc_sqlstr/cc_sqlnum (a LIMIT
  # cannot be a bound literal here), so it is validated as a POSITIVE INTEGER
  # and falls back to the default otherwise. Unvalidated it had two failure
  # modes, both demonstrated: "abc" made the SELECT a syntax error, cc_sql_val
  # swallowed it by design, and the loop silently resolved NOTHING -- rc=0,
  # reconciliation identity still passing, every project stuck at (unfiled)
  # forever; and "20; DROP TABLE claude_daily_rollups" ran as a second
  # statement and dropped the table. The test is pure `case` globbing, not
  # `[ -gt ]`, so a 20-digit value cannot trip arithmetic overflow either.
  per_run="${WATCHTOWER_RESOLVE_PER_RUN:-20}"
  case "$per_run" in
    ''|*[!0-9]*) per_run=20 ;;   # empty, signed, fractional, or anything else
    *[!0]*)      : ;;            # all digits with at least one non-zero
    *)           per_run=20 ;;   # all zeros: a LIMIT 0 resolves nothing, ever
  esac
  limit_sql=""
  [ "$RESOLVE_ALL" -eq 1 ] || limit_sql=" LIMIT $per_run"

  # Exclusion decisions are RE-EVALUATED every run; git resolution stays
  # write-once. Spec 4.5 promises the choice is reversible -- "dropping an entry
  # from excludePaths and rebuilding brings the history back, because nothing
  # was destroyed" -- but the cache only ever grew (INSERT OR IGNORE over cwds
  # NOT IN it), so an excluded cwd stayed (excluded) forever and a newly added
  # exclusion never reached already-cached history.
  #
  # The fix is to DELETE the rows whose exclusion decision no longer matches the
  # current patterns; they then fall back into the normal unresolved path below
  # and are re-resolved from scratch. Two directions, and only these two:
  #   1. source='excluded' but no longer matching -> the exclusion was dropped.
  #   2. source<>'excluded' but now matching      -> an exclusion was added.
  # Case 2 deletes a real resolved project_path. That is correct: the user has
  # just asked for that path to be excluded, and removing the exclusion later
  # re-resolves it via case 1. What must NOT regress is the reason the cache
  # exists at all -- a project surviving its directory being deleted -- and it
  # does not, because a row is only ever touched when its EXCLUSION verdict
  # disagrees with the patterns, never because the filesystem changed.
  #
  # Cost in the steady state: two SELECTs plus pure-bash `case` globbing over
  # ~75 cached rows, and not one further subprocess unless a verdict changed.
  #
  # Candidacy is decided HERE, in bash, and cannot be pushed into the DELETE's
  # WHERE clause: the verdict is `case` globbing against WATCHTOWER_EXCLUDE_PATHS
  # and SQL has no way to evaluate it. So bash picks the rows and SQL bounds and
  # removes them. BOTH directions accumulate into ONE list and one bounded
  # DELETE, deliberately: a bound applied per direction would let a run whose
  # flips fall on both sides delete up to twice the budget it can re-resolve.
  _flip=""
  cached="$(cc_sql_val "SELECT cwd FROM claude_project_paths WHERE source = 'excluded';")"
  while IFS= read -r cwd; do
    [ -z "$cwd" ] && continue
    cc_is_excluded "$cwd" "${_pats[@]}" && continue
    _flip="$_flip${_flip:+,}$(cc_sqlstr "$cwd")"
  done <<EOF
$cached
EOF
  cached="$(cc_sql_val "SELECT cwd FROM claude_project_paths WHERE source <> 'excluded';")"
  while IFS= read -r cwd; do
    [ -z "$cwd" ] && continue
    cc_is_excluded "$cwd" "${_pats[@]}" || continue
    _flip="$_flip${_flip:+,}$(cc_sqlstr "$cwd")"
  done <<EOF
$cached
EOF
  _delete_flipped "$_flip" "$limit_sql"

  # claude_requests as well as claude_events: the transcripts surface cwds the
  # event stream never saw -- every session that ran before the tracker was
  # installed -- and those cwds now carry tokens into the rollups. Left out of
  # this SELECT they would never be resolved and would key to (unfiled) forever,
  # which is Stage 1.5's §4.5 deferral. The ORDER BY / LIMIT applies to the
  # compound, so the per-run budget still bounds the union, not each arm.
  #
  # Stage 5: Codex and Hermes sessions carry a cwd too, and resolve by the same
  # rules. Only when wt_sessions has the column: cc_sql_val swallows errors, so a
  # missing column would silently resolve NOTHING, Claude's cwds included. Claude's
  # cwds sort first (k = 0) so the per-run cap never delays one behind an agent's.
  local wt_arm=""
  [ "$(cc_sql_val "SELECT COUNT(*) FROM pragma_table_info('wt_sessions') WHERE name = 'cwd';")" = "1" ] &&
    wt_arm="UNION ALL SELECT DISTINCT cwd, 1 AS k FROM wt_sessions WHERE cwd IS NOT NULL AND cwd <> ''"
  unresolved="$(cc_sql_val "SELECT cwd FROM (
                              SELECT cwd, MIN(k) AS k FROM (
                                SELECT DISTINCT cwd, 0 AS k FROM claude_events
                                WHERE cwd IS NOT NULL AND cwd <> ''
                                UNION ALL
                                SELECT DISTINCT cwd, 0 AS k FROM claude_requests
                                WHERE cwd IS NOT NULL AND cwd <> ''
                                ${wt_arm}
                              ) GROUP BY cwd
                            )
                            WHERE cwd NOT IN (SELECT cwd FROM claude_project_paths)
                            ORDER BY k, cwd${limit_sql};")"
  [ -z "$unresolved" ] && return 0
  now="$(cc_now)"
  while IFS= read -r cwd; do
    [ -z "$cwd" ] && continue
    if cc_is_excluded "$cwd" "${_pats[@]}"; then
      src="excluded"; proj=""
    elif [ ! -d "$cwd" ]; then
      src="gone"; proj=""
    else
      src="git"; proj="$(cc_project_path "$cwd")"
    fi
    cc_sql "INSERT OR IGNORE INTO claude_project_paths (cwd, project_path, resolved_at, source)
            VALUES ($(cc_sqlstr "$cwd"), $(cc_sqlstr "$proj"), $now, $(cc_sqlstr "$src"));"
  done <<EOF
$unresolved
EOF
}
_resolve_new_cwds

# ---- resolve skill -> pack, once per skill name, cached forever (Stage 7) -----
# Spec 4.3. Runs in BASH beside the cwd resolution above, for the same reason:
# following a symlink is a filesystem read SQL cannot make. Bounded by NEW
# names: the steady state is one SELECT returning nothing. Rows are INSERT OR
# IGNORE, never updated or deleted, so uninstalling a pack moves no history.
# Best-effort like the rest of this file's bash: a missing skills directory, a
# dangling link or a failed insert leaves a name at (no pack) or unresolved
# (which _sk_daily counts as (no pack)), never a failed run.
#   plugin  "pack:name"                                           -> pack
#   link    $SK/<name>/SKILL.md resolves to $SK/<pack>/.../SKILL.md,
#           <pack> <> <name>  (gstack's install shape)            -> <pack>
#   link    a pack's own router skill: $SK/<name>/ is a plain folder and at
#           least one $SK/<name>/<sub>/SKILL.md has a top-level symlink twin
#           $SK/<sub>/SKILL.md resolving to it (/gstack)          -> <name>
#   none    anything else: a plain folder, a built-in, a removed
#           skill, or a name that is not one safe path segment    -> (no pack)
_realpath() {  # every symlink followed, then the directory resolved; nothing on failure
  local p="$1" t d n=0
  while [ -L "$p" ]; do
    [ "$n" -ge 40 ] && return 1
    t="$(readlink "$p")" || return 1
    case "$t" in /*) p="$t" ;; *) p="$(dirname "$p")/$t" ;; esac
    n=$((n + 1))
  done
  d="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s\n' "$d" "$(basename "$p")"
}
_is_pack_root() {  # _is_pack_root <sk> <skreal> <name>: is $sk/<name>/ a pack others link into? silent
  local sk="$1" skreal="$2" name="$3" d sub
  for d in "$sk/$name"/*/; do
    [ -d "$d" ] || continue
    sub="${d%/}"; sub="${sub##*/}"
    [ "$sub" = "$name" ] && continue
    [ -f "$sk/$name/$sub/SKILL.md" ] && [ -L "$sk/$sub/SKILL.md" ] || continue
    [ "$(_realpath "$sk/$sub/SKILL.md")" = "$skreal/$name/$sub/SKILL.md" ] && return 0
  done
  return 1
}
_resolve_new_skills() {
  local names sk skreal now name pack via real rel
  names="$(cc_sql_val "SELECT DISTINCT attribution_skill FROM claude_requests
                       WHERE attribution_skill IS NOT NULL AND attribution_skill <> ''
                         AND attribution_skill NOT IN (SELECT skill FROM claude_skill_packs)
                       ORDER BY attribution_skill;")"
  [ -z "$names" ] && return 0
  sk="${CLAUDE_DIR:-$HOME/.claude}/skills"
  skreal="$(cd "$sk" 2>/dev/null && pwd -P)"
  now="$(cc_now)"
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    pack="(no pack)"; via="none"
    case "$name" in
      ?*:*) pack="${name%%:*}"; via="plugin" ;;
      *)
        if [ -n "$skreal" ] && [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [ -f "$sk/$name/SKILL.md" ]; then
          real="$(_realpath "$sk/$name/SKILL.md")"
          case "$real" in
            "$skreal"/*/*)
              rel="${real#"$skreal"/}"
              if [ "${rel%%/*}" != "$name" ]; then pack="${rel%%/*}"; via="link"
              elif [ "$rel" = "$name/SKILL.md" ] && _is_pack_root "$sk" "$skreal" "$name"; then pack="$name"; via="link"
              fi ;;
          esac
        fi ;;
    esac
    cc_sql "INSERT OR IGNORE INTO claude_skill_packs (skill, pack, via, resolved_at)
            VALUES ($(cc_sqlstr "$name"), $(cc_sqlstr "$pack"), $(cc_sqlstr "$via"), $now);"
  done <<EOF
$names
EOF
}
_resolve_new_skills

# ---- rebuild daily rollups (one connection; temp tables persist within it) ----
# .bail on + BEGIN IMMEDIATE make the rebuild ATOMIC. Without the transaction,
# the DELETE and the re-INSERT below are separate auto-committed statements: a
# lock timeout or a crash between them leaves claude_daily_rollups EMPTY while
# claude_rank_progress still holds the old totals, silently. Without .bail on,
# a RUNTIME error (a busy DB, a full disk) does not stop the script -- sqlite3
# runs on and COMMITs a half-rebuilt table. Both are needed; verified.
sqlite3 -cmd ".bail on" -cmd ".timeout 8000" "$DB" <<'SQL' 2>/dev/null || { [ "$QUIET" -eq 1 ] || echo "cc-rollup: rebuild failed" >&2; exit 1; }
-- Stage 4B (plan P2, rule C1): a READ phase first. Everything 4B derives -- the
-- price table, per-request cost, and the aggregates the write phase joins --
-- is built under BEGIN DEFERRED, which takes no write lock. The rebuild takes
-- seconds and grows with history; held under BEGIN IMMEDIATE it stalled
-- concurrent hook writes past their timeouts. The write lock (BEGIN IMMEDIATE,
-- below) covers only the DELETEs and INSERTs. _pk moved up here verbatim
-- because the cost aggregates need project keys. The pre-existing temp tables
-- (_dtok, _ptok, _act, _sx, ...) deliberately stay in the write phase: moving
-- them is out of scope.
BEGIN DEFERRED;
DROP TABLE IF EXISTS _pk;
-- cwd -> project_key, the ONLY place the reserved keys are minted. Parenthesised
-- so they cannot collide with a real toplevel, which is always absolute.
-- LEFT JOIN, not INNER: a cwd the resolution step has not seen must still land
-- somewhere, and (unfiled) is the honest answer.
CREATE TEMP TABLE _pk AS
SELECT e.cwd,
       CASE
         WHEN p.source = 'excluded'   THEN '(excluded)'
         WHEN p.project_path IS NULL  THEN '(unfiled)'
         ELSE p.project_path
       END AS project_key
FROM (SELECT DISTINCT cwd FROM claude_events
      WHERE cwd IS NOT NULL AND cwd <> ''
      UNION
      SELECT DISTINCT cwd FROM claude_requests
      WHERE cwd IS NOT NULL AND cwd <> '') e
LEFT JOIN claude_project_paths p ON p.cwd = e.cwd;
CREATE INDEX IF NOT EXISTS _pk_cwd ON _pk(cwd);

DROP TABLE IF EXISTS _prices;
CREATE TEMP TABLE _prices (model TEXT, speed TEXT, effective_from TEXT, input REAL, output REAL,
  cache_read REAL, cache_write_5m REAL, cache_write_1h REAL, verified_on TEXT, source TEXT);
-- Spec 4.1, verified 2026-09-28. USD per MTok. One INSERT per model id, so a
-- price change is one new line with a later effective_from, and history is
-- never repriced. No rate may appear under lib/ (a test greps for these).
INSERT INTO _prices VALUES ('claude-fable-5-1','standard','2026-01-01',10,50,0.25,12.50,20,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-fable-5','standard','2026-01-01',10,50,1.00,12.50,20,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-opus-5-5','standard','2026-01-01',4,20,0.20,5.00,8,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-opus-5','standard','2026-01-01',5,25,0.50,6.25,10,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-opus-4-8','standard','2026-01-01',5,25,0.50,6.25,10,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-opus-4-7','standard','2026-01-01',5,25,0.50,6.25,10,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-sonnet-5-5','standard','2026-01-01',2,10,0.20,2.50,4,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-sonnet-5','standard','2026-01-01',2,10,0.20,2.50,4,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-sonnet-4-6','standard','2026-01-01',3,15,0.30,3.75,6,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-haiku-4-5','standard','2026-01-01',1,5,0.10,1.25,2,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
INSERT INTO _prices VALUES ('claude-haiku-4-5-20251001','standard','2026-01-01',1,5,0.10,1.25,2,'2026-09-28','https://platform.claude.com/docs/en/about-claude/pricing');
-- 4B: end of the price table
DROP TABLE IF EXISTS _pwin;
CREATE TEMP TABLE _pwin AS
SELECT *, LEAD(effective_from) OVER (PARTITION BY model, speed ORDER BY effective_from) AS effective_to
FROM _prices;

DROP TABLE IF EXISTS _rm;
CREATE TEMP TABLE _rm AS
SELECT request_id, day, project_key, session_id, model, is_sidechain, priced, price_note,
       CASE WHEN priced = 1 THEN (tin * p_in + tout * p_out + tcr * p_cr
                                  + COALESCE(w5, 0) * p_w5 + COALESCE(w1, 0) * p_w1) / 1e6 END AS cost_table_usd,
       CASE WHEN priced = 1 THEN COALESCE(w5, 0) * p_w5 / 1e6 END AS cost_write_5m_usd,
       CASE WHEN priced = 1 THEN COALESCE(w1, 0) * p_w1 / 1e6 END AS cost_write_1h_usd,
       -- Spec 4.2: response = the last partial's ms minus the ms of the user
       -- entry before the request in its own file. Positive, or NULL: a
       -- missing endpoint (a file that starts mid-turn) or a non-positive
       -- difference (clock skew, a partial in the prompt's own ms) is "not
       -- measured", never 0. last_ms, sent_ms and tout are the inner SELECT's.
       CASE WHEN last_ms IS NOT NULL AND sent_ms IS NOT NULL AND last_ms - sent_ms > 0
            THEN last_ms - sent_ms END AS response_ms,
       CASE WHEN last_ms IS NOT NULL AND sent_ms IS NOT NULL AND last_ms - sent_ms > 0 AND tout > 0
            THEN tout * 1000.0 / (last_ms - sent_ms) END AS tok_per_s
FROM (
  SELECT r.request_id, r.day, COALESCE(k.project_key, '(unfiled)') AS project_key,
         r.session_id, r.model, r.is_sidechain, r.last_ms, r.sent_ms,
         r.tokens_in AS tin, r.tokens_out AS tout, r.tokens_cache_read AS tcr,
         r.cache_write_5m AS w5, r.cache_write_1h AS w1,
         p.input AS p_in, p.output AS p_out, p.cache_read AS p_cr,
         p.cache_write_5m AS p_w5, p.cache_write_1h AS p_w1,
         -- Spec 4.1's case table, in its order. No window row for the model on
         -- the request's day is one of two notes (fix round, M1): the model has
         -- price rows, all starting after that day (no-price-yet), or it has
         -- none at all (unknown-model). no-split is BOTH cache-write sides NULL;
         -- one NULL side is priced as 0 by the COALESCEs above (M2).
         CASE WHEN r.model = '<synthetic>' THEN NULL
              WHEN p.model IS NULL THEN 0
              WHEN r.speed IS NOT NULL AND r.speed <> 'standard' THEN 0
              WHEN r.tokens_cache_creation > 0 AND r.cache_write_5m IS NULL AND r.cache_write_1h IS NULL THEN 0
              ELSE 1 END AS priced,
         CASE WHEN r.model = '<synthetic>' THEN 'synthetic'
              WHEN p.model IS NULL AND r.model IN (SELECT model FROM _prices WHERE speed = 'standard') THEN 'no-price-yet'
              WHEN p.model IS NULL THEN 'unknown-model'
              WHEN r.speed IS NOT NULL AND r.speed <> 'standard' THEN 'fast'
              WHEN r.tokens_cache_creation > 0 AND r.cache_write_5m IS NULL AND r.cache_write_1h IS NULL THEN 'no-split'
              WHEN r.speed IS NULL THEN 'speed-absent'
         END AS price_note
  -- day is EXACTLY _dtok's expression, so cost buckets with tokens (spec 4.1).
  -- claude_requests has no `day` column, so the alias cannot shadow one.
  FROM (SELECT *, strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day
        FROM claude_requests WHERE ts IS NOT NULL) r
  LEFT JOIN _pk k ON k.cwd = r.cwd
  LEFT JOIN _pwin p ON p.model = r.model AND p.speed = 'standard'
        AND p.effective_from <= r.day AND (p.effective_to IS NULL OR r.day < p.effective_to)
);

DROP TABLE IF EXISTS _cost_d;
CREATE TEMP TABLE _cost_d AS
SELECT day, TOTAL(CASE WHEN priced = 1 THEN cost_table_usd END) AS cost_t,
       SUM(CASE WHEN priced = 1 THEN 1 ELSE 0 END) AS priced_n,
       SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced_n
FROM _rm GROUP BY day;
DROP TABLE IF EXISTS _cost_p;
CREATE TEMP TABLE _cost_p AS
SELECT project_key, day, TOTAL(CASE WHEN priced = 1 THEN cost_table_usd END) AS cost_t,
       SUM(CASE WHEN priced = 1 THEN 1 ELSE 0 END) AS priced_n,
       SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced_n
FROM _rm GROUP BY project_key, day;

-- Turn boundaries in session order. Ties within one ms: kinds that do not start
-- a measured turn first, so a prompt/command owns the requests after a same-ms
-- local/notification line (plan P3); entry_uuid last, for determinism.
DROP TABLE IF EXISTS _bnd;
CREATE TEMP TABLE _bnd AS
SELECT entry_uuid, session_id, ts_ms, kind,
       LEAD(ts_ms) OVER (PARTITION BY session_id
                         ORDER BY ts_ms, (kind IN ('prompt','command')), entry_uuid) AS next_ms
FROM claude_prompts WHERE COALESCE(session_id, '') <> '';
-- Requests whose main thread handed the turn back to the user (a question, a
-- plan to approve): the wait then includes human time, so it is not measured.
DROP TABLE IF EXISTS _human;
CREATE TEMP TABLE _human AS
SELECT DISTINCT request_id FROM claude_tool_calls
WHERE tool_name IN ('AskUserQuestion', 'ExitPlanMode') AND COALESCE(is_sidechain, 0) = 0
  AND request_id IS NOT NULL;
-- Spec 4.3: main-thread requests of the same session, first_ms in [B, next B).
DROP TABLE IF EXISTS _trq;
CREATE TEMP TABLE _trq AS
SELECT b.entry_uuid, r.request_id, r.last_ms,
       CASE WHEN substr(COALESCE(r.entrypoint, ''), 1, 4) = 'sdk-' THEN 1 ELSE 0 END AS sdk,
       CASE WHEN h.request_id IS NOT NULL THEN 1 ELSE 0 END AS human
FROM _bnd b
JOIN claude_requests r ON r.session_id = b.session_id AND r.is_sidechain = 0
                      AND r.first_ms >= b.ts_ms AND (b.next_ms IS NULL OR r.first_ms < b.next_ms)
LEFT JOIN _human h ON h.request_id = r.request_id
WHERE b.kind IN ('prompt', 'command');
-- One row per prompt/command boundary that owns at least one request. Its wait
-- runs from the boundary to its last request's last partial.
DROP TABLE IF EXISTS _turns;
CREATE TEMP TABLE _turns AS
SELECT b.entry_uuid, b.session_id,
       strftime('%Y-%m-%d', b.ts_ms / 1000, 'unixepoch', 'localtime') AS day,   -- plan P4
       b.kind, COUNT(*) AS requests, MAX(t.last_ms) - b.ts_ms AS wait_ms,
       CASE WHEN MIN(t.sdk) = 1 THEN 'headless'
            WHEN MAX(t.human) = 1 THEN 'human'
            ELSE 'measured' END AS status
FROM _bnd b JOIN _trq t ON t.entry_uuid = b.entry_uuid
GROUP BY b.entry_uuid, b.session_id, b.ts_ms, b.kind;

-- Stage 6 (spec 4.3): the model each Claude event was driven by, the model of
-- the session's latest MAIN-THREAD request at or before the event. Built here,
-- in the read phase, because it is the expensive part: one merge of events and
-- requests per session, sorted once. Requests sort before events in the same
-- second, so a turn's Stop credits the model that answered it; requests in one
-- second order by request_id, so the greater one wins. The running window
-- carries the latest request without a correlated subquery: grp counts the
-- requests so far, and the first row of each grp is the request that opened it.
-- An event before the session's first request gets no row; _sfm covers it.
-- Stage 7: it also carries that request's skill (attribution_skill), NULL when untagged.
DROP TABLE IF EXISTS _evm;
CREATE TEMP TABLE _evm AS
WITH st AS (
  SELECT session_id, ts, 1 AS k, id AS tb, id AS eid, NULL AS model, NULL AS skill
  FROM claude_events
  WHERE session_id IS NOT NULL AND hook_event_name NOT IN ('LauncherStart','LauncherEnd')
  UNION ALL
  SELECT session_id, ts, 0, request_id, NULL, model, NULLIF(attribution_skill, '')
  FROM claude_requests
  WHERE session_id IS NOT NULL AND is_sidechain = 0 AND model IS NOT NULL AND model <> '<synthetic>'
), g AS (
  SELECT st.*, SUM(1 - k) OVER (PARTITION BY session_id ORDER BY ts, k, tb
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp
  FROM st
), m AS (
  SELECT eid, k, grp,
         FIRST_VALUE(model) OVER (PARTITION BY session_id, grp ORDER BY ts, k, tb) AS model,
         -- Stage 7 (spec 4.2): the same request's skill. Claude Code clears the
         -- tag at the next prompt, so this is the skill of the turn in flight.
         FIRST_VALUE(skill) OVER (PARTITION BY session_id, grp ORDER BY ts, k, tb) AS skill
  FROM g
)
SELECT eid AS id, model, skill FROM m WHERE k = 1 AND grp > 0;
CREATE INDEX IF NOT EXISTS _evm_id ON _evm(id);

-- The fallback for a gap with no main-thread request at or before it (spec 4.3
-- steps 3-5): the session's FIRST main-thread request's model, then the model
-- the session recorded (claude_sessions.model with any "[1m]"-style suffix
-- removed; '' and 'unknown' are no record), then '(no model)'. 2,433 live
-- sessions have no ingested request; their recorded model names all but 2.4 h
-- of their 46.3 h.
DROP TABLE IF EXISTS _sfm;
CREATE TEMP TABLE _sfm AS
WITH fr AS (
  SELECT session_id, model,
         ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts, request_id) AS rn
  FROM claude_requests
  WHERE session_id IS NOT NULL AND is_sidechain = 0 AND model IS NOT NULL AND model <> '<synthetic>'
), sm AS (
  SELECT session_id,
         NULLIF(NULLIF(CASE WHEN instr(model, '[') > 0 THEN substr(model, 1, instr(model, '[') - 1)
                            ELSE model END, ''), 'unknown') AS model
  FROM claude_sessions
)
SELECT e.session_id, COALESCE(fr.model, sm.model, '(no model)') AS model
FROM (SELECT DISTINCT session_id FROM claude_events WHERE session_id IS NOT NULL) e
LEFT JOIN fr ON fr.session_id = e.session_id AND fr.rn = 1
LEFT JOIN sm ON sm.session_id = e.session_id;
CREATE INDEX IF NOT EXISTS _sfm_id ON _sfm(session_id);
COMMIT;
BEGIN IMMEDIATE;

-- Day-grouped request tokens. DELIBERATELY independent of claude_sessions:
-- 22.4% of requests (5,878 / 26,270 measured 2026-09-11) carry a session_id
-- with no claude_sessions row, all from the pre-install days the transcripts
-- uniquely cover. Joining through sessions drops 22.7% of output tokens while
-- the reconciliation identity keeps passing, because both sides omit it
-- equally.
--
-- DECLARED DIVERGENCE: a session crossing midnight books its HOURS entirely to
-- its start day, but a request books to ITS OWN day. A request has a true
-- timestamp; forcing it onto a session's start day would launder model math
-- through an attribution rule, and does not work for orphans at all.
DROP TABLE IF EXISTS _dtok;
CREATE TEMP TABLE _dtok AS
SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day,
       CAST(SUM(tokens_in)              AS INTEGER) AS tin,
       CAST(SUM(tokens_out)             AS INTEGER) AS tout,
       CAST(SUM(tokens_cache_read)      AS INTEGER) AS tcr,
       CAST(SUM(tokens_cache_creation)  AS INTEGER) AS tcw
FROM claude_requests WHERE ts IS NOT NULL
-- GROUP BY the EXPRESSION, never the bare output alias. SQLite resolves a name
-- in GROUP BY against the INPUT columns first and only falls back to the result
-- alias if nothing matches, so a bare `GROUP BY day` is safe here only for as
-- long as claude_requests has no column called `day`. Writing the expression
-- removes that dependency; see _ptok below, where the same shape was a real bug.
GROUP BY strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime');

-- Per-project request tokens. Every request carries its own cwd, so tokens
-- attribute DIRECTLY -- no is_dom dominance rule and no time-splitting. The
-- identity then holds by construction: _dtok and _ptok are the same SUM over
-- the same table differing by one GROUP BY key.
DROP TABLE IF EXISTS _ptok;
CREATE TEMP TABLE _ptok AS
SELECT COALESCE(k.project_key, '(unfiled)') AS project_key,
       strftime('%Y-%m-%d', r.ts, 'unixepoch', 'localtime') AS day,
       CAST(SUM(r.tokens_in)             AS INTEGER) AS tin,
       CAST(SUM(r.tokens_out)            AS INTEGER) AS tout,
       CAST(SUM(r.tokens_cache_read)     AS INTEGER) AS tcr,
       CAST(SUM(r.tokens_cache_creation) AS INTEGER) AS tcw
FROM claude_requests r
LEFT JOIN _pk k ON k.cwd = r.cwd
WHERE r.ts IS NOT NULL
-- GROUP BY the EXPRESSIONS, NOT the bare output aliases. SQLite resolves a name
-- in GROUP BY against the INPUT columns first, and _pk really does have a column
-- called project_key -- so `GROUP BY project_key` bound to k.project_key, which
-- is NULL for a request whose cwd is NULL, empty, or otherwise absent from _pk.
-- Such a row grouped SEPARATELY from a resolved-but-unfiled one while the SELECT
-- list COALESCEd both to '(unfiled)': two _ptok rows under one key and day. The
-- project INSERT then fans out on them and trips UNIQUE(project_key, day), .bail
-- on rolls the entire rebuild back, and because the SessionEnd hook runs this as
-- `--quiet >/dev/null 2>&1 || true` the tracker would silently stop updating
-- with no error anyone could see. No data corruption -- just silence, which is
-- the failure mode this project exists to prevent.
GROUP BY COALESCE(k.project_key, '(unfiled)'),
         strftime('%Y-%m-%d', r.ts, 'unixepoch', 'localtime');

DROP TABLE IF EXISTS _gap;
-- Activity model (rev 3, 2026-09-07), in _gap. Time is attributed per GAP between
-- consecutive events, classified by what the session was doing during it:
--   WORK  (a task was running: last boundary event was UserPromptSubmit)
--         -> counted IN FULL, capped at 14400s (4h) as a crash sanity bound. The
--            rev-2 model discarded any gap >600s, which silently threw away ~93h
--            of long autonomous runs.
--   THINK (reading output / composing: last boundary was Stop or SessionStart)
--         -> counted up to 300s (5min), then it is idle, not work.
--   Gaps ending at SessionStart are BETWEEN SITTINGS (a resumed session_id) and
--   count 0 toward BOTH figures. This is what stops a session resumed 55 days
--   later from booking 1308 hours.
--   Gaps ending at SessionEnd are the walk-away before closing the window and
--   count 0 toward BOTH figures (user decision, 2026-09-08: "not just an idle
--   claude window open doing nothing"). Measured on the real DB at the time of
--   the change: window 946.98h -> 486.11h, active 187.98h unchanged.
-- window_s is the same span WITHOUT the think cap: "window open at the desk",
-- used for the idle/hygiene ratio. active_s <= window_s always holds.
-- Rows sharing a ts are ordered by the claude_events AUTOINCREMENT id, i.e. the
-- order the hooks actually fired. ORDER BY ts alone leaves ties to an order
-- SQLite does not promise; the real DB has 472 tied groups across 387 sessions,
-- and breaking those ties the other way moves lifetime active 185.59h -> 180.10h.
-- Grouped by (session_id, project_key), NOT by cwd: a repo and a subdirectory of
-- that repo are two cwds resolving to the SAME key, and grouping by cwd would
-- give one session two rows under one project -- SUM(is_dom) would then count it
-- twice and the per-project/daily identity would fail on the commonest shape.
-- The gap is ts - LAG(ts), so it ENDS at the current row: ev.project_key is
-- already the key of the event that ends the gap, which is the attribution rule
-- exactly. No extra window function is needed.
CREATE TEMP TABLE _gap AS
WITH ev AS (
  SELECT e.session_id, e.ts, e.hook_event_name AS evt, e.id,
         COALESCE(k.project_key, '(unfiled)') AS project_key,
         e.ts - LAG(e.ts) OVER (PARTITION BY e.session_id ORDER BY e.ts, e.id) AS gap,
         MAX(CASE WHEN e.hook_event_name = 'UserPromptSubmit' THEN e.ts ELSE 0 END)
           OVER (PARTITION BY e.session_id ORDER BY e.ts, e.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS last_work,
         MAX(CASE WHEN e.hook_event_name IN ('Stop','SessionStart') THEN e.ts ELSE 0 END)
           OVER (PARTITION BY e.session_id ORDER BY e.ts, e.id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS last_idle
  FROM claude_events e
  LEFT JOIN _pk k ON k.cwd = e.cwd
  WHERE e.session_id IS NOT NULL
    AND e.hook_event_name NOT IN ('LauncherStart','LauncherEnd')
)
SELECT ev.session_id, ev.project_key, ev.id, ev.ts,
       CASE WHEN ev.gap IS NULL                             THEN 0
            WHEN ev.evt IN ('SessionStart','SessionEnd')    THEN 0
            -- A gap ENDING at UserPromptSubmit is always think time: you were
            -- reading or typing, never executing. This must not depend on
            -- WORK/THINK state, because Stop is unreliable -- one session had
            -- 4 Stop events for 23 prompts, so the state machine can sit in
            -- WORK indefinitely and bill a walk-away as 4h of task time.
            WHEN ev.evt = 'UserPromptSubmit'                THEN MIN(gap, 300)
            WHEN ev.last_work > ev.last_idle                THEN MIN(gap, 14400)
            ELSE                                                 MIN(gap, 300)
       END AS active_s,
       CASE WHEN ev.gap IS NULL                             THEN 0
            WHEN ev.evt IN ('SessionStart','SessionEnd')    THEN 0
            ELSE                                                 MIN(gap, 14400)
       END AS window_s,
       -- Stage 6 (spec 4.3): the gap's driving model is the model at the event
       -- that ENDS it, else the session's fallback (_sfm). R3: an event written
       -- after the read phase has neither, and is '(no model)'.
       COALESCE(m.model, f.model, '(no model)') AS model,
       -- Stage 7 (spec 4.2): the skill on that same request, or NULL. No _sfm
       -- fallback: a turn that loaded no skill is not skill time.
       m.skill AS skill
FROM ev
LEFT JOIN _evm m ON m.id = ev.id
LEFT JOIN _sfm f ON f.session_id = ev.session_id;

DROP TABLE IF EXISTS _act;
-- One row per (session, project_key): the per-gap rows above, summed. Same
-- numbers as before Stage 6, which kept the rule's text in one place.
CREATE TEMP TABLE _act AS
SELECT session_id, project_key,
       -- the deterministic tie-break for _pdom below
       MAX(id) AS last_id,
       SUM(active_s) AS active_s,
       SUM(window_s) AS window_s
FROM _gap GROUP BY session_id, project_key;

DROP TABLE IF EXISTS _pdom;
-- The project a session's SCALARS belong to: tokens, cost, prompts, sessions
-- count. Time splits per gap, scalars do not -- a session counted 1 in two rows
-- makes SUM(sessions_count) exceed the daily rollup, and duplicating the latest
-- snapshot's tokens into both rows is the same fan-out that once doubled every
-- daily aggregate. 20 of 2,478 sessions touch more than one cwd.
-- Ties break by the session's LAST event id -- the same ordering discipline _act
-- uses, because ORDER BY ts alone leaves ties to an order SQLite does not promise.
CREATE TEMP TABLE _pdom AS
SELECT session_id, project_key FROM (
  SELECT session_id, project_key,
         ROW_NUMBER() OVER (PARTITION BY session_id
                            ORDER BY active_s DESC, last_id DESC) AS rn
  FROM _act
)
WHERE rn = 1;

DROP TABLE IF EXISTS _snap;
-- The LATEST snapshot per session -- exactly ONE row per session_id. The old
-- MAX(ts) join emitted one row per snapshot TIED at that max ts, and _sx below
-- fans out on it, so two snapshots sharing (session_id, ts) doubled sessions,
-- active time, tokens and cost for that session in every daily aggregate. The
-- only thing keeping snapshots unique is snapshot.sh's 60s throttle, which
-- stops working the moment its marker file cannot be written.
-- ROW_NUMBER, not a correlated "id = (SELECT ... LIMIT 1)" subquery: the
-- correlated form re-sorts every session's snapshots once PER ROW and measured
-- 6.5s against the real 57k-row table, versus 0.04s here. This runs inside the
-- SessionEnd hook, so it must stay fast.
-- effort and thinking_enabled ONLY. The four token columns this used to carry
-- are deliberately gone: claude_status_snapshots reports a CONTEXT WINDOW, not
-- usage, and selecting them here left the wrong source sitting ready to hand
-- for the next editor to graft back onto _sx. Tokens come from _dtok / _ptok.
CREATE TEMP TABLE _snap AS
SELECT session_id, effort, thinking_enabled
FROM (SELECT session_id, effort, thinking_enabled,
             ROW_NUMBER() OVER (PARTITION BY session_id
                                ORDER BY ts DESC, id DESC) AS rn
      FROM claude_status_snapshots
      WHERE session_id IS NOT NULL)
WHERE rn = 1;

DROP TABLE IF EXISTS _cost;
CREATE TEMP TABLE _cost AS
SELECT session_id,
       MAX(total_cost_usd)          AS cost,
       AVG(context_used_percentage) AS avgctx,
       MAX(context_used_percentage) AS peakctx
FROM claude_status_snapshots GROUP BY session_id;

DROP TABLE IF EXISTS _sx;
CREATE TEMP TABLE _sx AS
SELECT
  s.session_id,
  strftime('%Y-%m-%d',
    COALESCE(s.started_at, (SELECT MIN(ts) FROM claude_events e WHERE e.session_id=s.session_id)),
    'unixepoch','localtime') AS day,
  COALESCE(s.repo,'(none)')  AS repo,
  COALESCE(s.model,'(unknown)') AS model,
  s.source, s.compacts, s.subagents, s.prompts,
  -- NOT (ended_at - started_at): a resumed session_id spans the dormant calendar
  -- gap between sittings. 41 such sessions were 86.5% of all recorded hours.
  COALESCE(a.window_s, 0) AS dur_s,
  COALESCE(a.active_s,0) AS active_s,
  COALESCE(c.cost,0)     AS cost,
  -- A reading is a POSITIVE cost (Stage 4B fix round, I1). The status line
  -- prints total_cost_usd = 0 before a session has priced anything, and 786
  -- live sessions never got past it; counted as readings they stored
  -- sessions_with_cost > 0 beside cost_usd 0.0, and Projects and History
  -- printed "$0.00" as Claude Code's figure next to a real cost at API
  -- prices. cost itself stays the MAX, so cost_usd sums do not move.
  -- lib/read/history.ts's snapshotDays is this rule's twin, for Live's today
  -- and the Skills series; tests/cost-rollup.test.ts pins the two together.
  CASE WHEN c.cost > 0 THEN 1 ELSE 0 END AS has_cost,
  -- NEITHER is COALESCE'd: a session with no snapshot has no context reading.
  -- A 0 avgctx was averaged in by AVG(avgctx) below as "an empty window",
  -- dragging the daily and per-project averages ~10x low (Stage 3D fix wave,
  -- I5); a 0 peakctx was scored by hygiene as an empty context all day -- full
  -- marks for a term nobody measured. NULL is skipped by AVG and MAX, so a day
  -- reads the sessions that WERE read, and a day none of whose sessions was
  -- read stores NULL in both; hygiene then drops the context term and rescales
  -- (below).
  c.avgctx               AS avgctx,
  c.peakctx              AS peakctx,
  -- NO token columns here, deliberately. _sx is built FROM claude_sessions, so
  -- any token routed through it silently drops every request whose session_id
  -- has no session row -- 22.7% of real output tokens. _dtok / _ptok above are
  -- the only token sources. _snap survives for effort / thinking, which the
  -- status line is the only place to get.
  COALESCE(sn.effort,'(none)')          AS effort,
  COALESCE(sn.thinking_enabled,0)       AS thinking
FROM claude_sessions s
-- Pre-aggregated: _act is now one row per (session, project_key), so joining it
-- on session_id alone would multiply every session-level figure in the DAILY
-- rollups for a session touching two projects -- the Stage 1 fan-out, reborn.
LEFT JOIN (SELECT session_id, SUM(active_s) AS active_s, SUM(window_s) AS window_s
           FROM _act GROUP BY session_id) a ON a.session_id = s.session_id
LEFT JOIN _cost c  ON c.session_id  = s.session_id
LEFT JOIN _snap sn ON sn.session_id = s.session_id
WHERE COALESCE(s.started_at, (SELECT MIN(ts) FROM claude_events e WHERE e.session_id=s.session_id)) IS NOT NULL;

-- Key space is the UNION of days with sessions and days with requests, so a
-- pre-install day that has tokens and no sessions still gets a row. UNION +
-- LEFT JOIN rather than FULL OUTER JOIN: portable to any sqlite3 the installed
-- copy might meet, including older Linux builds.
DROP TABLE IF EXISTS _days;
CREATE TEMP TABLE _days AS
  SELECT day FROM _sx UNION SELECT day FROM _dtok UNION SELECT day FROM _cost_d;

DELETE FROM claude_daily_rollups;
INSERT INTO claude_daily_rollups (
  day, total_session_ms, active_ms, idle_ms, sessions_count,
  tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, cache_hit_percentage,
  cost_usd, compacts, clears, subagents, prompts, avg_context_pct, peak_context_pct, updated_at,
  cost_table_usd, priced_requests, unpriced_requests, sessions_with_cost)
SELECT
  d.day,
  CAST(COALESCE(s.dur_s, 0)    * 1000 AS INTEGER),
  CAST(COALESCE(s.active_s, 0) * 1000 AS INTEGER),
  CAST(MAX(0, COALESCE(s.dur_s, 0) - COALESCE(s.active_s, 0)) * 1000 AS INTEGER),
  COALESCE(s.n, 0),
  COALESCE(t.tin, 0), COALESCE(t.tout, 0), COALESCE(t.tcr, 0), COALESCE(t.tcw, 0),
  -- NULL, not 0, when there was no cache traffic to measure at all. 21 of 68
  -- real days have sessions and events but NO transcript left to ingest, so they
  -- correctly report 0 tokens -- and a fabricated 0% hit rate on such a day is a
  -- measurement of absent data, the same error class as the NULL context
  -- percentages below. It cost them 25 of hygiene's 100 points: measured 80.9 on
  -- covered days against 57.76 on uncovered ones, a 23-point penalty for missing
  -- transcripts rather than bad practice, which then dragged lifetime hygiene
  -- from ~80.9 to 73.855. CONSUMERS MUST TREAT THIS COLUMN AS NULLABLE too.
  100.0 * COALESCE(t.tcr, 0)
    / NULLIF(COALESCE(t.tcr, 0) + COALESCE(t.tcw, 0), 0),
  COALESCE(s.cost, 0), COALESCE(s.compacts, 0), COALESCE(s.clears, 0),
  COALESCE(s.subagents, 0), COALESCE(s.prompts, 0),
  -- NOT COALESCE'd, unlike every column above: on a day with no sessions, or
  -- none with a status-line snapshot, these two land NULL, deliberately. A
  -- context percentage is a reading taken from a running session; with no
  -- reading, 0.0 would assert "the context was empty all day" -- a fabricated
  -- measurement of the same class as the status-line token figures Stage 2
  -- removed. NULL is also skipped by AVG() where a fabricated 0.0 would drag the
  -- average down. CONSUMERS MUST TREAT BOTH COLUMNS AS
  -- NULLABLE, despite the REAL DEFAULT 0 in the schema.
  s.avgctx, s.peakctx,
  strftime('%s', 'now'),
  COALESCE(c.cost_t, 0), COALESCE(c.priced_n, 0), COALESCE(c.unpriced_n, 0), COALESCE(s.with_cost, 0)
FROM _days d
LEFT JOIN (SELECT day,
                  SUM(dur_s)    AS dur_s,
                  SUM(active_s) AS active_s,
                  COUNT(*)      AS n,
                  SUM(cost)     AS cost,
                  SUM(has_cost) AS with_cost,
                  SUM(compacts) AS compacts,
                  SUM(CASE WHEN source='clear' THEN 1 ELSE 0 END) AS clears,
                  SUM(subagents) AS subagents,
                  SUM(prompts)   AS prompts,
                  AVG(avgctx)    AS avgctx,
                  MAX(peakctx)   AS peakctx
           FROM _sx GROUP BY day) s ON s.day = d.day
LEFT JOIN _dtok t ON t.day = d.day
LEFT JOIN _cost_d c ON c.day = d.day;

-- per-day breakdown JSON (active seconds by repo; session count by model)
-- Runs over EVERY day, including one with no _sx rows at all -- both columns are
-- TEXT with no DEFAULT and are not named in the INSERT above, so skipping a
-- session-less day here would leave NULL where every other day holds an object.
-- The COALESCE(..., '{}') is belt-and-braces: sqlite3 3.54.0's json_group_object
-- already returns '{}' over zero rows rather than NULL (verified directly), but
-- this script runs against whatever sqlite3 is on PATH, so the fallback stays.
UPDATE claude_daily_rollups AS r SET
  repos_json = COALESCE((SELECT json_group_object(repo, secs) FROM
                 (SELECT repo, CAST(SUM(active_s) AS INTEGER) AS secs FROM _sx WHERE day=r.day GROUP BY repo)), '{}'),
  models_json = COALESCE((SELECT json_group_object(model, cnt) FROM
                 (SELECT model, COUNT(*) AS cnt FROM _sx WHERE day=r.day GROUP BY model)), '{}');

-- Stage 6 (spec 4.3): Claude's hours by driving model, booked exactly as the
-- daily rollup books them -- to the session's START day, through _sx -- so per
-- day these rows sum to claude_daily_rollups.active_ms. Time in excluded
-- projects is in here, as it is in the daily row.
DELETE FROM claude_model_rollups;
INSERT INTO claude_model_rollups (day, model, active_ms, updated_at)
SELECT sx.day, g.model, CAST(SUM(g.active_s) * 1000 AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
FROM _gap g JOIN _sx sx ON sx.session_id = g.session_id
GROUP BY sx.day, g.model
HAVING SUM(g.active_s) > 0;

-- Stage 7 (spec 4.2): Claude's hours by Claude Code skill, booked exactly as the
-- model rows are -- to the session's START day, through _sx -- so per day they
-- never exceed claude_daily_rollups.active_ms. An untagged gap is in no row.
DELETE FROM claude_skill_rollups;
INSERT INTO claude_skill_rollups (day, skill, active_ms, updated_at)
SELECT sx.day, g.skill, CAST(SUM(g.active_s) * 1000 AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
FROM _gap g JOIN _sx sx ON sx.session_id = g.session_id
WHERE g.skill IS NOT NULL
GROUP BY sx.day, g.skill
HAVING SUM(g.active_s) > 0;

-- hygiene score (0-100) from OBSERVABLE signals only:
--   cache efficiency (25) + context discipline (30) + compact-vs-clear (25) + focus/idle (20)
-- COALESCE on the cache term ONLY so a NULL cache_hit_percentage cannot NULL the
-- whole sum. It does NOT mean "0% hit rate": the rescale immediately below
-- removes the fabricated term entirely on those days. On a day that HAS cache
-- traffic this statement is byte-for-byte the arithmetic it always was, which is
-- why the rescale is a separate statement rather than a factor folded in here --
-- folding it in would re-associate the additions and could move the last bits of
-- a normal day's score. A NULL peak (no context reading) falls to the ELSE 30
-- here, and that whole score is then rewritten by the NULL-peak statement below.
UPDATE claude_daily_rollups SET hygiene_score = max(0.0, min(100.0,
    (COALESCE(cache_hit_percentage, 0.0) * 0.25)
  + (CASE WHEN peak_context_pct > 85 AND compacts = 0 THEN max(0.0, 30.0 - (peak_context_pct-85.0)*2.0)
          WHEN peak_context_pct > 85 AND compacts > 0 THEN 24.0
          ELSE 30.0 END)
  + (CASE WHEN (compacts+clears) = 0 THEN 18.0 ELSE 25.0*compacts/(compacts+clears) END)
  + (CASE WHEN total_session_ms = 0 THEN 10.0
          ELSE max(0.0, min(20.0, 20.0*(1.0 - CAST(idle_ms AS REAL)/total_session_ms))) END)
));

-- A day with sessions but no transcript coverage has no cache reading at all.
-- Its other THREE terms -- context discipline, compact-vs-clear and focus/idle --
-- are derived from EVENTS, which such a day does have, so they are genuinely
-- measured and must not be thrown away. Rescale them to 100 instead of diluting
-- them with a cache term that does not exist.
--
-- The denominator is the maximum THAT DAY COULD ACTUALLY ATTAIN, not a fixed 75.
-- Normally that is 30 (context) + 25 (compact-vs-clear) + 20 (focus/idle) = 75.
-- But the focus/idle term is a FLAT 10.0 when total_session_ms = 0 rather than a
-- 0-20 range, so such a day tops out at 65 -- and dividing it by 75 would
-- normalise against a maximum it cannot reach, which is precisely the error this
-- rescale exists to remove. 9 of 69 real days are that shape (sessions_count > 0
-- with total_session_ms = 0: 2026-07-11 with 135 sessions, 2026-07-17 with 201,
-- and seven more). They scored 77.33 against a fixed 75; 58 of an attainable 65
-- is 89.23.
--
-- Deliberately a SEPARATE statement gated on IS NULL rather than a factor folded
-- into the expression above: folding it in would re-associate that expression's
-- additions, and floating-point addition is not associative, so a day WITH cache
-- traffic could shift in its last bits. Gated, such a day is never rewritten at
-- all. (The clamp is inert -- no attainable sum exceeds its own denominator --
-- and is kept to state the bound.)
--
-- Gated on a peak too (Stage 4B): a day with no context reading is written by
-- the statement below instead, from scratch, so every day is written by
-- exactly one rescale. No number depends on this gate today -- the statement
-- below overwrites those days whole -- which is why nothing tests it; it
-- states the partition, so reordering the two cannot rescale a day twice.
UPDATE claude_daily_rollups
   SET hygiene_score = min(100.0, hygiene_score
         * (100.0 / CASE WHEN total_session_ms = 0 THEN 65.0 ELSE 75.0 END))
 WHERE cache_hit_percentage IS NULL AND peak_context_pct IS NOT NULL;

-- A day with sessions but no context reading (no snapshot) has no context
-- term. Spec 4.4: score = measured terms x 100 / what they could reach that day:
-- cache 25 if measured, compact-vs-clear 25, focus 20 (10 when the window is 0).
-- 70 / 60 with a cache reading, 45 / 35 without. A separate statement gated on
-- IS NULL, like the cache rescale above, so a day WITH a peak is never rewritten.
UPDATE claude_daily_rollups SET hygiene_score = max(0.0, min(100.0,
    ( COALESCE(cache_hit_percentage * 0.25, 0.0)
    + (CASE WHEN (compacts+clears) = 0 THEN 18.0 ELSE 25.0*compacts/(compacts+clears) END)
    + (CASE WHEN total_session_ms = 0 THEN 10.0
            ELSE max(0.0, min(20.0, 20.0*(1.0 - CAST(idle_ms AS REAL)/total_session_ms))) END) )
  * 100.0 / ( (CASE WHEN cache_hit_percentage IS NULL THEN 0.0 ELSE 25.0 END) + 25.0
            + (CASE WHEN total_session_ms = 0 THEN 10.0 ELSE 20.0 END) )))
 WHERE peak_context_pct IS NULL;

-- hygiene_score is a BEHAVIOURAL score: three of its four terms (context
-- discipline, compact-vs-clear, idle ratio) are meaningless without a session.
-- Left alone, a token-only pre-install day would score on cache efficiency
-- alone and pollute claude_rank_progress.hygiene_score, which is
-- AVG(NULLIF(hygiene_score,0)) across days -- so zeroing here excludes them
-- from the lifetime average with no new logic downstream.
UPDATE claude_daily_rollups SET hygiene_score = 0 WHERE sessions_count = 0;

DROP TABLE IF EXISTS _psess;
-- The SESSION-derived half of a project row: everything that is not a token.
-- Materialised as its own temp table rather than inlined twice, because the
-- INSERT below needs it AND _pkeys needs its key space, and two hand-copied
-- copies of a fifteen-line subquery drift.
--
-- Every non-key column is aggregated explicitly. In a GROUP BY with more than
-- one aggregate a BARE column takes its value from an ARBITRARY row of the
-- group -- not the row that produced the MIN or MAX beside it -- so there is no
-- such thing as a column that "comes along with" peakctx here.
CREATE TEMP TABLE _psess AS
SELECT project_key, day,
       SUM(active_s) AS active_s,
       SUM(window_s) AS window_s,
       SUM(is_dom)   AS n,
       SUM(is_dom * COALESCE(prompts,0))   AS prompts,
       SUM(is_dom * COALESCE(compacts,0))  AS compacts,
       SUM(is_dom * CASE WHEN source='clear' THEN 1 ELSE 0 END) AS clears,
       SUM(is_dom * COALESCE(subagents,0)) AS subagents,
       SUM(is_dom * cost) AS cost,
       SUM(is_dom * has_cost) AS with_cost,
       -- Gated on is_dom like every other per-session column. Spec 4.6 puts both
       -- context columns in the per-session class -- assigned WHOLE to the
       -- dominant project and to no other -- and ungated they were the two that
       -- escaped it: on a session spanning two projects the non-dominant row read
       -- sessions_count = 0 and tokens_in = 0 while still carrying the session's
       -- full peak_context_pct. Neither column is in the reconciliation identity,
       -- so nothing else would ever have noticed. CASE WHEN, not is_dom * x: a
       -- multiplication would turn a non-dominant row into a real 0.0 that MAX and
       -- AVG would then count, where the NULL is simply absent from both.
       MAX(CASE WHEN is_dom = 1 THEN peakctx END) AS peakctx,
       AVG(CASE WHEN is_dom = 1 THEN avgctx  END) AS avgctx
FROM (
  -- Driven from _sx, LEFT JOINing _act -- NOT the other way round.
  -- claude_daily_rollups.sessions_count is COUNT(*) over _sx, and _sx is every
  -- claude_sessions row with a resolvable start time INCLUDING one with no
  -- events at all. Such a session has no _act row, so under an inner join it
  -- would count in the daily rollup and in no project row, and
  -- SUM(sessions_count) -- along with its prompts and cost -- would quietly
  -- fall short. Both a and d are then NULL, both COALESCE to '(unfiled)',
  -- is_dom is 1, and it counts exactly once.
  SELECT COALESCE(a.project_key, '(unfiled)') AS project_key,
         sx.day, sx.session_id,
         COALESCE(a.active_s, 0) AS active_s,
         COALESCE(a.window_s, 0) AS window_s,
         sx.prompts, sx.compacts, sx.subagents, sx.source,
         sx.cost, sx.has_cost, sx.peakctx, sx.avgctx,
         CASE WHEN COALESCE(d.project_key, '(unfiled)')
                 = COALESCE(a.project_key, '(unfiled)') THEN 1 ELSE 0 END AS is_dom
  FROM _sx sx
  LEFT JOIN _act  a ON a.session_id = sx.session_id
  LEFT JOIN _pdom d ON d.session_id = sx.session_id
)
GROUP BY project_key, day;

DROP TABLE IF EXISTS _pkeys;
-- (project, day) key space: the UNION of the pairs sessions produce and the
-- pairs requests produce. A cwd seen only in the transcripts -- a project the
-- tracker never watched -- has no session row anywhere, and without the UNION
-- its tokens would land in claude_daily_rollups and in no project row at all,
-- breaking the identity the moment the orphan tokens started being counted.
CREATE TEMP TABLE _pkeys AS
  SELECT project_key, day FROM _psess
  UNION
  SELECT project_key, day FROM _ptok
  UNION
  SELECT project_key, day FROM _cost_p;

DELETE FROM claude_project_rollups;
INSERT INTO claude_project_rollups (
  project_key, day, display_name,
  active_ms, window_ms, idle_ms, sessions_count, prompts, compacts, clears, subagents,
  tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation, cost_usd,
  peak_context_pct, avg_context_pct, updated_at,
  cost_table_usd, priced_requests, unpriced_requests, sessions_with_cost)
SELECT
  pk.project_key,
  pk.day,
  CASE WHEN pk.project_key LIKE '(%)' THEN pk.project_key
       ELSE replace(pk.project_key, rtrim(pk.project_key, replace(pk.project_key,'/','')), '') END,
  CAST(COALESCE(sp.active_s, 0) * 1000 AS INTEGER),
  CAST(COALESCE(sp.window_s, 0) * 1000 AS INTEGER),
  -- MAX(0, ...) exactly as the daily rollup at the INSERT above does it. It is
  -- a no-op while active_s <= window_s holds per row, which is the point: the
  -- clamp states the invariant, and stating it in one of the two places and not
  -- the other invites the reader to conclude it is not real.
  CAST(MAX(0, COALESCE(sp.window_s, 0) - COALESCE(sp.active_s, 0)) * 1000 AS INTEGER),
  COALESCE(sp.n, 0),
  COALESCE(sp.prompts, 0),
  COALESCE(sp.compacts, 0),
  COALESCE(sp.clears, 0),
  COALESCE(sp.subagents, 0),
  -- Tokens come from _ptok -- request cwd straight to project_key -- and NOT
  -- from the session-derived rows beside them. No is_dom gate: a request is not
  -- a session scalar to be handed whole to a dominant project, it already knows
  -- which directory it ran in.
  COALESCE(pt.tin, 0), COALESCE(pt.tout, 0),
  COALESCE(pt.tcr, 0), COALESCE(pt.tcw, 0),
  COALESCE(sp.cost, 0),
  sp.peakctx,
  sp.avgctx,
  strftime('%s','now'),
  COALESCE(c.cost_t, 0), COALESCE(c.priced_n, 0), COALESCE(c.unpriced_n, 0), COALESCE(sp.with_cost, 0)
FROM _pkeys pk
LEFT JOIN _psess sp ON sp.project_key = pk.project_key AND sp.day = pk.day
LEFT JOIN _ptok  pt ON pt.project_key = pk.project_key AND pt.day = pk.day
LEFT JOIN _cost_p c ON c.project_key = pk.project_key AND c.day = pk.day;

-- models_json: {"model": {"sessions":N,"thinking":N,"effort":{"high":N,...}}}
-- DOMINANT sessions only, so a session split across projects contributes its
-- model to exactly one of them -- the same rule as every other scalar. The inner
-- joins are correct here: models_json is not part of the reconciliation
-- identity, and a session with no events legitimately contributes no model row.
DROP TABLE IF EXISTS _pmodel;
CREATE TEMP TABLE _pmodel AS
SELECT a.project_key, sx.day, sx.model, sx.effort,
       COUNT(DISTINCT a.session_id) AS sessions,
       SUM(sx.thinking)             AS thinking
FROM _act a
JOIN _sx   sx ON sx.session_id = a.session_id
JOIN _pdom d  ON d.session_id  = a.session_id AND d.project_key = a.project_key
GROUP BY a.project_key, sx.day, sx.model, sx.effort;

UPDATE claude_project_rollups AS r SET models_json = (
  SELECT json_group_object(m.model, json_object(
           'sessions', m.sessions,
           'thinking', m.thinking,
           -- json(): json_group_object returns a value carrying the JSON
           -- subtype, but that subtype does NOT survive the subquery below, so
           -- a bare m.effort_json is embedded as an escaped STRING
           -- ("{\"(none)\":1}") instead of the nested object section 5
           -- documents. json() re-marks it as JSON.
           'effort',   json(m.effort_json)))
  FROM (SELECT project_key, day, model,
               SUM(sessions) AS sessions, SUM(thinking) AS thinking,
               json_group_object(effort, sessions) AS effort_json
        FROM _pmodel GROUP BY project_key, day, model) m
  WHERE m.project_key = r.project_key AND m.day = r.day
);

DELETE FROM claude_prices;
INSERT INTO claude_prices (model, speed, effective_from, input, output, cache_read, cache_write_5m, cache_write_1h, verified_on, source)
SELECT model, speed, effective_from, input, output, cache_read, cache_write_5m, cache_write_1h, verified_on, source FROM _prices ORDER BY rowid;
DELETE FROM claude_request_metrics;
INSERT INTO claude_request_metrics (request_id, day, session_id, model, is_sidechain, priced, price_note, cost_table_usd, cost_write_5m_usd, cost_write_1h_usd, response_ms, tok_per_s)
SELECT request_id, day, session_id, model, is_sidechain, priced, price_note, cost_table_usd, cost_write_5m_usd, cost_write_1h_usd, response_ms, tok_per_s FROM _rm ORDER BY rowid;
DELETE FROM claude_turns;
INSERT INTO claude_turns (entry_uuid, session_id, day, kind, requests, wait_ms, status)
SELECT entry_uuid, session_id, day, kind, requests, wait_ms, status FROM _turns ORDER BY rowid;
COMMIT;
SQL

# ---- lifetime aggregates -> rank ladder (computed in bash) -----------------
read -r TH AH LC LTIN LTOUT NSESS HYG <<EOF
$(sqlite3 -cmd ".timeout 8000" "$DB" -separator ' ' "SELECT
  COALESCE(SUM(total_session_ms),0)/3600000.0,
  COALESCE(SUM(active_ms),0)/3600000.0,
  COALESCE(SUM(cost_usd),0),
  COALESCE(SUM(tokens_in),0),
  COALESCE(SUM(tokens_out),0),
  COALESCE(SUM(sessions_count),0),
  COALESCE(AVG(NULLIF(hygiene_score,0)),0)
FROM claude_daily_rollups;" 2>/dev/null)
EOF
TH=${TH:-0}; AH=${AH:-0}; LC=${LC:-0}; LTIN=${LTIN:-0}; LTOUT=${LTOUT:-0}; NSESS=${NSESS:-0}; HYG=${HYG:-0}

names=(Noobie Apprentice Builder Intermediate Advanced Pro Master)
# ACTIVE hours (rev 3). Master at 5000h maps to the "conservatory / professionally
# competent" tier in the deliberate-practice literature, and is ~4 years at the
# user's measured pace of ~1000-1200 active hours/year. The 10000h figure is an
# average of an already-elite group (Ericsson 1993), never a threshold.
mins=(0 20 100 300 800 2000 5000)
idx=0
for i in "${!mins[@]}"; do
  if awk -v t="$AH" -v m="${mins[$i]}" 'BEGIN{exit !(t>=m)}'; then idx=$i; fi
done
rank="${names[$idx]}"
into=$(awk -v t="$AH" -v m="${mins[$idx]}" 'BEGIN{printf "%.4f", t-m}')
if [ "$idx" -lt 6 ]; then
  next="${names[$((idx+1))]}"
  tonext=$(awk -v n="${mins[$((idx+1))]}" -v t="$AH" 'BEGIN{v=n-t; if(v<0)v=0; printf "%.4f", v}')
  Lnext="'$next'"; Ltonext="$tonext"
else
  Lnext="NULL"; Ltonext="NULL"
fi
xp=$(awk -v a="$AH" -v t="$TH" -v h="$HYG" -v s="$NSESS" 'BEGIN{printf "%.0f", a*100 + t*20 + h*5 + s*2}')

sqlite3 -cmd ".timeout 8000" "$DB" "INSERT OR REPLACE INTO claude_rank_progress
  (id, total_hours, active_hours, lifetime_cost_usd, lifetime_tokens_in, lifetime_tokens_out,
   sessions_count, rank_index, rank_name, hours_into_rank, hours_to_next, next_rank_name, xp, hygiene_score, updated_at)
  VALUES (1, $TH, $AH, $LC, $LTIN, $LTOUT, $NSESS, $idx, '$rank', $into, $Ltonext, $Lnext, $xp, $HYG, strftime('%s','now'));" 2>/dev/null || true

# Stage 8 (spec 4.0): the as-of day, once, for the profile section's quests and
# the agent section's pace and streaks. WATCHTOWER_ROLLUP_TODAY pins it for
# tests; anything but YYYY-MM-DD is ignored.
_sk_today="$(date +%Y-%m-%d)"
case "${WATCHTOWER_ROLLUP_TODAY:-}" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) _sk_today="$WATCHTOWER_ROLLUP_TODAY" ;;
esac

# ---- rebuild the Usage Profile (Stage 4A) -----------------------------------
# Its OWN sqlite3 run, deliberately AFTER the rank write above: rank and the
# daily/project rollups have already committed by this point, so a failure
# rebuilding the profile cannot cost them. All scoring lives HERE and nowhere
# else (CLAUDE.md) -- TypeScript reads and formats only; a guard test fails the
# build if a scoring threshold shows up under lib/.
#
# TWO transactions, and the split is the point. Recomputing every day's windows
# takes seconds (2.8 s on the live copy at 108 days, 10 s at 3x that history)
# and grows with history. Held under the database WRITE lock, that stalled
# every concurrent hook write for the whole rebuild -- past SessionEnd's 1.5 s
# cancel today, and past cc_sql's 4 s busy timeout (a silently DROPPED
# claude_events row) within weeks. So:
#   1. READ: every _pf_* temp table, including the staged output (_pf_profile,
#      _pf_scores), is built inside ONE deferred read transaction. The DB is
#      WAL: a reader never blocks a writer, and writing the TEMP schema takes no
#      lock on main (measured: a BEGIN IMMEDIATE from another connection
#      succeeds throughout this phase). One read transaction gives every temp
#      table the SAME snapshot -- an ingest committing mid-build cannot land in
#      some tables and not others.
#   2. WRITE: BEGIN IMMEDIATE, DELETE both tables, INSERT from the staged temp
#      tables, COMMIT -- milliseconds. The DELETEs sit INSIDE that transaction,
#      so a failure anywhere rolls back to the previous profile, never to empty.
# tests/profile-rollup.test.ts pins both the shape and the failure behaviour.
# Stage 8: the as-of day reaches the heredoc as a one-row temp table, printed
# ahead of it as the agent section's prelude is.
{ printf 'CREATE TEMP TABLE _pf_asof (d0 TEXT NOT NULL);\nINSERT INTO _pf_asof VALUES (%s);\n' "$(cc_sqlstr "$_sk_today")"; cat <<'SQL'
BEGIN DEFERRED;

-- One row per LOCAL day from the first ever request through today. A day with
-- zero requests must still exist here iff at least one request exists anywhere
-- (an idle day between two active ones still gets a profile row, spec 4.1/4.5
-- Review Focus 4) -- and must NOT exist when claude_requests is empty, or the
-- anchor's NULL MIN() would mint a day = NULL row that the PRIMARY KEY on
-- claude_profile_daily.day then rejects, rolling back this whole transaction
-- under .bail on. Many fixtures (event-only scenarios with no req() call) are
-- exactly that empty case.
DROP TABLE IF EXISTS _pf_days;
CREATE TEMP TABLE _pf_days AS
WITH RECURSIVE d(day) AS (
  SELECT (SELECT MIN(strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime'))
          FROM claude_requests WHERE ts IS NOT NULL)
  UNION ALL
  SELECT date(day, '+1 day') FROM d WHERE day < date('now', 'localtime')
)
SELECT day FROM d WHERE day IS NOT NULL;

-- Three rolling windows per day (spec 3.3 names): the 30-day scoring window,
-- the current 7-day week and the PRIOR 7-day week, used only for week-over-week.
DROP TABLE IF EXISTS _pf_win;
CREATE TEMP TABLE _pf_win AS
SELECT day, '30' AS win, date(day, '-29 day') AS lo, day AS hi FROM _pf_days
UNION ALL
SELECT day, '7',  date(day, '-6 day'),  day               FROM _pf_days
UNION ALL
SELECT day, '7p', date(day, '-13 day'), date(day, '-7 day') FROM _pf_days
UNION ALL
-- Stage 8 (spec 4.2): one calendar week per Monday, Monday..Sunday, keyed by
-- its Monday, through the week of the as-of day. The one place a week is defined.
SELECT DISTINCT date(d.day, '-6 days', 'weekday 1'), 'wk',
       date(d.day, '-6 days', 'weekday 1'), date(d.day, '-6 days', 'weekday 1', '+6 days')
FROM _pf_days d CROSS JOIN _pf_asof a
WHERE date(d.day, '-6 days', 'weekday 1') <= a.d0;

-- Every request's OWN local day, computed once and indexed, so the range join
-- below is an index range scan per window (a few hundred rows) rather than a
-- full table scan of claude_requests per window (hundreds x tens of thousands).
DROP TABLE IF EXISTS _pf_reqday;
CREATE TEMP TABLE _pf_reqday AS
SELECT request_id, session_id, ts, model,
       tokens_in AS tin, tokens_out AS tout, tokens_cache_read AS tcr,
       (NULLIF(api_error_status, '') IS NOT NULL) AS err,
       entrypoint,
       strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS rday
FROM claude_requests WHERE ts IS NOT NULL;
CREATE INDEX idx_pf_reqday ON _pf_reqday(rday);

-- One row per request per window it falls in. ALL requests, sidechain
-- included: every API call counts, so request-based inputs see them all
-- (spec 4.1). Reused verbatim by Task 3.
DROP TABLE IF EXISTS _pf_rq;
CREATE TEMP TABLE _pf_rq AS
SELECT w.win, w.day, q.request_id, q.session_id, q.ts, q.model,
       q.tin, q.tout, q.tcr, q.err, q.entrypoint
FROM _pf_win w
JOIN _pf_reqday q ON q.rday BETWEEN w.lo AND w.hi;
CREATE INDEX idx_pf_rq ON _pf_rq(win, day, session_id, ts);

-- Per (window, day, session) stats. Rows with an empty session_id are left out
-- of session statistics (spec 4.1's "unattributed" bucket) -- they still count
-- in the token totals via _pf_agg below, which reads _pf_rq directly, ungated.
-- reset: at least one request whose running max of EARLIER cache_read values in
-- (win, day, session) climbed past 80,000 before dropping to under half of it.
-- "At least one" is enough, since the peak equals the running max until the
-- first reset (spec 4.3).
DROP TABLE IF EXISTS _pf_sess;
CREATE TEMP TABLE _pf_sess AS
WITH s AS (
  SELECT win, day, session_id,
         COUNT(*)              AS n,
         MAX(ts) - MIN(ts)     AS span,
         SUM(tcr) * 1.0 / COUNT(*) AS ctx
  FROM _pf_rq
  WHERE COALESCE(session_id, '') <> ''
  GROUP BY win, day, session_id
),
r AS (
  SELECT win, day, session_id,
         MAX(CASE WHEN tcr > 0 AND prior > 80000 AND tcr * 2 < prior THEN 1 ELSE 0 END) AS reset
  FROM (SELECT *, MAX(tcr) OVER (PARTITION BY win, day, session_id ORDER BY ts, request_id
                                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prior
        FROM _pf_rq WHERE COALESCE(session_id, '') <> '')
  GROUP BY win, day, session_id
)
SELECT s.win, s.day, s.session_id, s.n, s.span, s.ctx, COALESCE(r.reset, 0) AS reset
FROM s LEFT JOIN r ON r.win = s.win AND r.day = s.day AND r.session_id = s.session_id;
CREATE INDEX idx_pf_sess ON _pf_sess(win, day);

-- The median: the mean of the two middle values (identical to the single
-- middle value when the count is odd, since (c+1)/2 = (c+2)/2 then). Two
-- separate tables -- not one pivoted -- so the idiom stays exactly the shape
-- spec 4.1's brief shows it, parameterised only by which column feeds v.
DROP TABLE IF EXISTS _pf_medctx;
CREATE TEMP TABLE _pf_medctx AS
SELECT win, day, AVG(v) AS median_ctx FROM (
  SELECT win, day, v, ROW_NUMBER() OVER (PARTITION BY win, day ORDER BY v) AS rn,
         COUNT(*) OVER (PARTITION BY win, day) AS c
  FROM (SELECT win, day, ctx AS v FROM _pf_sess)
) WHERE rn IN ((c + 1) / 2, (c + 2) / 2)
GROUP BY win, day;

DROP TABLE IF EXISTS _pf_medn;
CREATE TEMP TABLE _pf_medn AS
SELECT win, day, AVG(v) AS median_n FROM (
  SELECT win, day, v, ROW_NUMBER() OVER (PARTITION BY win, day ORDER BY v) AS rn,
         COUNT(*) OVER (PARTITION BY win, day) AS c
  FROM (SELECT win, day, n AS v FROM _pf_sess)
) WHERE rn IN ((c + 1) / 2, (c + 2) / 2)
GROUP BY win, day;

-- "Long" sessions (n >= 30 or span >= 2700s) and how many of them show a reset.
DROP TABLE IF EXISTS _pf_long;
CREATE TEMP TABLE _pf_long AS
SELECT win, day,
       SUM(CASE WHEN n >= 30 OR span >= 2700 THEN 1 ELSE 0 END) AS long_sessions,
       SUM(CASE WHEN (n >= 30 OR span >= 2700) AND reset = 1 THEN 1 ELSE 0 END) AS long_with_reset
FROM _pf_sess
GROUP BY win, day;

-- Window-wide totals for the efficiency factor: ALL rows in the window,
-- session or not (spec 4.1) -- a cache re-read ratio is a fact about the whole
-- window's traffic, not about attributed sessions.
DROP TABLE IF EXISTS _pf_agg;
CREATE TEMP TABLE _pf_agg AS
SELECT win, day, COUNT(*) AS n_requests,
       SUM(tcr) AS sum_tcr,
       SUM(COALESCE(tin, 0) + COALESCE(tout, 0)) AS sum_fresh
FROM _pf_rq
GROUP BY win, day;

-- The four Matrix factors and the Matrix score itself, computed generically for
-- EVERY (win, day) -- '30' feeds the day's own Matrix card, '7' feeds
-- matrix_7d, '7p' feeds the prior week for matrix_wow. The H/L helpers,
-- written with the exact arithmetic order spec 4.2 gives them (floating-point
-- addition is not associative, and a different order can move a .5 rounding
-- case). f_context / f_session_length are NULL, not a fabricated number, when
-- the window has no attributed session at all -- and that NULL alone is enough
-- to null the whole Matrix score below, since compaction and efficiency are
-- always defined (90 and a real ratio, never "no data").
DROP TABLE IF EXISTS _pf_matrix;
CREATE TEMP TABLE _pf_matrix AS
WITH base AS (
  SELECT a.win, a.day, a.n_requests,
         mc.median_ctx, mn.median_n,
         COALESCE(l.long_sessions, 0)   AS long_sessions,
         COALESCE(l.long_with_reset, 0) AS long_with_reset,
         CASE WHEN a.sum_fresh > 0 THEN a.sum_tcr * 1.0 / a.sum_fresh ELSE 0.0 END AS ratio
  FROM _pf_agg a
  LEFT JOIN _pf_medctx mc ON mc.win = a.win AND mc.day = a.day
  LEFT JOIN _pf_medn   mn ON mn.win = a.win AND mn.day = a.day
  LEFT JOIN _pf_long    l ON l.win  = a.win AND l.day  = a.day
),
factors AS (
  SELECT win, day, n_requests, median_ctx, median_n, long_sessions, long_with_reset, ratio,
    -- context: L(median_ctx, 60000, 350000)
    CASE WHEN median_ctx IS NULL THEN NULL
         WHEN median_ctx <= 60000  THEN 100
         WHEN median_ctx >= 350000 THEN 0
         ELSE CAST(round(100 * (1 - (median_ctx - 60000) * 1.0 / (350000 - 60000))) AS INTEGER)
    END AS f_context,
    -- compaction: no long sessions this window -> 90 (nothing to fault yet)
    CASE WHEN long_sessions = 0 THEN 90
         ELSE CAST(round(100.0 * long_with_reset / long_sessions) AS INTEGER)
    END AS f_compaction,
    -- sessionLength: L(median_n, 40, 250)
    CASE WHEN median_n IS NULL THEN NULL
         WHEN median_n <= 40  THEN 100
         WHEN median_n >= 250 THEN 0
         ELSE CAST(round(100 * (1 - (median_n - 40) * 1.0 / (250 - 40))) AS INTEGER)
    END AS f_session_length,
    -- efficiency: L(ratio, 10, 45). ratio is a real 0, not "no data", when the
    -- window has no fresh tokens at all (spec 4.3 says so explicitly).
    CASE WHEN ratio <= 10 THEN 100
         WHEN ratio >= 45 THEN 0
         ELSE CAST(round(100 * (1 - (ratio - 10) * 1.0 / (45 - 10))) AS INTEGER)
    END AS f_efficiency
  FROM base
)
SELECT win, day, n_requests, median_ctx, median_n, long_sessions, long_with_reset,
       ratio AS cache_fresh_ratio, f_context, f_compaction, f_session_length, f_efficiency,
       -- Matrix score sums LEFT TO RIGHT exactly as spec 4.3 writes it.
       CASE WHEN f_context IS NULL OR f_session_length IS NULL THEN NULL
            ELSE CAST(round(((f_context * 0.3 + f_compaction * 0.25) + f_session_length * 0.2) + f_efficiency * 0.25) AS INTEGER)
       END AS matrix_score
FROM factors;
CREATE INDEX idx_pf_matrix ON _pf_matrix(win, day);

-- Tool coverage (spec 3.3): a window is tool-covered only if its FIRST day is on
-- or after the local day of the earliest main-thread tool call. A single-row
-- table so the INSERT below can CROSS JOIN it; coverage_start is NULL (and every
-- window uncovered) until claude_tool_calls has a main-thread row at all.
DROP TABLE IF EXISTS _pf_coverage;
CREATE TEMP TABLE _pf_coverage AS
SELECT strftime('%Y-%m-%d', MIN(ts), 'unixepoch', 'localtime') AS coverage_start
FROM claude_tool_calls WHERE is_sidechain = 0;

-- Event coverage (Stage 4B spec 4.5), the same rule for hook data: a window is
-- event-covered only if its FIRST day is on or after the local day of the
-- earliest claude_events row. Before the hooks were installed nothing could
-- record a PreCompact or a prompt's permission mode, so a window reaching back
-- past that day has those inputs UNMEASURED, not 0: session hygiene's
-- compactions part is undefined and security is needs-data (_pf_in below).
-- event_start is NULL, and every window uncovered, while claude_events is empty.
DROP TABLE IF EXISTS _pf_evcov;
CREATE TEMP TABLE _pf_evcov AS
SELECT strftime('%Y-%m-%d', MIN(ts), 'unixepoch', 'localtime') AS event_start FROM claude_events;

-- One row per day. The gate (spec 4.1's MIN_PROFILE_RECORDS = 20, "fewer than
-- 20" -- strictly less-than) nulls every '30'-window score column, f_* included,
-- when window_requests < 20; window_requests and tool_covered are NOT NULL and
-- never gated. matrix_7d and matrix_wow get NO gate at all (spec 4.5): a
-- missing '7'/'7p' row already means zero requests in that week, which the
-- LEFT JOIN alone turns into NULL -- the same "no measurement" NULL a real gate
-- would produce, so no extra CASE is needed for matrix_wow beyond checking both
-- weeks' scores are non-NULL.
--
-- Staged in _pf_profile, a column-for-column copy of claude_profile_daily's
-- shape (same names, same affinities), and copied across only in the write
-- transaction at the end. The unique index stands in for the table's PRIMARY
-- KEY, so a duplicate day fails here, in the read phase, too.
DROP TABLE IF EXISTS _pf_profile;
CREATE TEMP TABLE _pf_profile AS SELECT * FROM main.claude_profile_daily WHERE 0;
CREATE UNIQUE INDEX idx_pf_profile ON _pf_profile(day);
INSERT INTO _pf_profile (
  day, window_requests, tool_covered, event_covered,
  total, measured, tier_index, tier_points_to_next, total_wow,
  matrix_score, matrix_tier, matrix_points_to_next,
  f_context, f_compaction, f_session_length, f_efficiency,
  median_ctx, median_requests, long_sessions, long_with_reset,
  cache_fresh_ratio,
  matrix_7d, matrix_wow
)
SELECT
  d.day,
  COALESCE(m30.n_requests, 0) AS window_requests,
  CASE WHEN cov.coverage_start IS NOT NULL
        AND date(d.day, '-29 day') >= cov.coverage_start THEN 1 ELSE 0 END AS tool_covered,
  CASE WHEN ev.event_start IS NOT NULL
        AND date(d.day, '-29 day') >= ev.event_start THEN 1 ELSE 0 END AS event_covered,
  NULL, NULL, NULL, NULL, NULL,  -- total / measured / tier_index / tier_points_to_next / total_wow: Task 3
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL ELSE m30.matrix_score END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL
       ELSE CASE WHEN m30.matrix_score >= 75 THEN 2 WHEN m30.matrix_score >= 45 THEN 1 ELSE 0 END
  END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL
       ELSE CASE WHEN m30.matrix_score >= 75 THEN NULL
                 WHEN m30.matrix_score >= 45 THEN 75 - m30.matrix_score
                 ELSE 45 - m30.matrix_score END
  END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL ELSE m30.f_context END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL ELSE m30.f_compaction END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL ELSE m30.f_session_length END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL ELSE m30.f_efficiency END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL ELSE m30.median_ctx END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL ELSE m30.median_n END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL ELSE m30.long_sessions END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL ELSE m30.long_with_reset END,
  CASE WHEN COALESCE(m30.n_requests, 0) < 20 THEN NULL ELSE m30.cache_fresh_ratio END,
  m7.matrix_score AS matrix_7d,
  CASE WHEN m7.matrix_score IS NULL OR m7p.matrix_score IS NULL THEN NULL
       ELSE m7.matrix_score - m7p.matrix_score END AS matrix_wow
FROM _pf_days d
CROSS JOIN _pf_coverage cov
CROSS JOIN _pf_evcov ev
LEFT JOIN _pf_matrix m30 ON m30.win = '30' AND m30.day = d.day
LEFT JOIN _pf_matrix m7  ON m7.win  = '7'  AND m7.day  = d.day
LEFT JOIN _pf_matrix m7p ON m7p.win = '7p' AND m7p.day = d.day;

-- ============================================================================
-- The ten disciplines (spec 4.4), the 600 total and the 6-tier ladder (4.5).
-- Only UNGATED days (window_requests >= 20) get discipline rows; a gated day
-- keeps its NULL totals and has none (spec 4.6).
--
-- Every input is aggregated ONCE per local day into a small _pf_*day table
-- (a few hundred rows at most), then summed over each day's '30' window by a
-- range join -- not recomputed per window from the raw tables. Stage 10 adds
-- the as-of day's '7' window beside them, so every table from _pf_dw to _pf_sc
-- is keyed by (win, day), and every join between them matches win.
-- ============================================================================
DROP TABLE IF EXISTS _pf_dw;
CREATE TEMP TABLE _pf_dw AS
SELECT '30' AS win, p.day, w.lo, w.hi, p.tool_covered, p.event_covered
FROM _pf_profile p
JOIN _pf_win w ON w.win = '30' AND w.day = p.day
WHERE p.window_requests >= 20
UNION ALL
-- Stage 10 (spec 4.2): the as-of day's 7-day window, one row, under the same
-- gate counted over its own 7 days. Coverage is checked against the window's
-- own first day. Filtered to the as-of day HERE, so every range join below
-- costs one more window, not one per day of history.
SELECT '7', w.day, w.lo, w.hi,
       CASE WHEN cov.coverage_start IS NOT NULL AND w.lo >= cov.coverage_start THEN 1 ELSE 0 END,
       CASE WHEN ev.event_start IS NOT NULL AND w.lo >= ev.event_start THEN 1 ELSE 0 END
FROM _pf_win w
CROSS JOIN _pf_asof a
CROSS JOIN _pf_coverage cov
CROSS JOIN _pf_evcov ev
JOIN _pf_agg g ON g.win = '7' AND g.day = w.day
WHERE w.win = '7' AND w.day = a.d0 AND g.n_requests >= 20;

-- Tool calls: MAIN THREAD only (is_sidechain = 0 -- top-level transcripts
-- only, spec 4.1) and only rows whose tool_use side was seen
-- (tool_name NOT NULL; a result-only row is not a call). A call whose result
-- never arrived keeps is_error NULL: it counts as a CALL and not as an ERROR
-- (errors / tool uses; Review Focus 1). substr, not LIKE: '_' is a
-- LIKE wildcard, so LIKE 'mcp__%' would also match 'mcpXY...'.
DROP TABLE IF EXISTS _pf_tcday;
CREATE TEMP TABLE _pf_tcday AS
SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS tday,
       COUNT(*) AS calls,
       SUM(CASE WHEN tool_name IN ('Read', 'Grep', 'Glob') THEN 1 ELSE 0 END) AS inspect,
       SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) AS errors,
       SUM(CASE WHEN tool_name IN ('Task', 'Agent') THEN 1 ELSE 0 END) AS subagents,
       SUM(CASE WHEN substr(tool_name, 1, 5) = 'mcp__' THEN 1 ELSE 0 END) AS mcp_calls
FROM claude_tool_calls
WHERE is_sidechain = 0 AND tool_name IS NOT NULL AND ts IS NOT NULL
GROUP BY tday;
CREATE INDEX idx_pf_tcday ON _pf_tcday(tday);

DROP TABLE IF EXISTS _pf_mcpday;
CREATE TEMP TABLE _pf_mcpday AS
SELECT DISTINCT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS tday, mcp_server
FROM claude_tool_calls
WHERE is_sidechain = 0 AND tool_name IS NOT NULL AND ts IS NOT NULL
  AND COALESCE(mcp_server, '') <> '';
CREATE INDEX idx_pf_mcpday ON _pf_mcpday(tday);

-- Slash commands. Sidechain entries never reach this table: ingest.sh drops
-- them at capture (spec 3.1), so there is no flag to filter on here.
DROP TABLE IF EXISTS _pf_slday;
CREATE TEMP TABLE _pf_slday AS
SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS sday, command, COUNT(*) AS n
FROM claude_slash_commands
WHERE ts IS NOT NULL
GROUP BY sday, command;
CREATE INDEX idx_pf_slday ON _pf_slday(sday);

-- Hook events: real compactions (PreCompact) and the permission mode each
-- prompt was submitted under. json_valid() first: json_extract RAISES on a
-- malformed payload, and under .bail on one bad row would roll back the whole
-- profile rebuild.
DROP TABLE IF EXISTS _pf_evday;
CREATE TEMP TABLE _pf_evday AS
SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS eday,
       SUM(CASE WHEN hook_event_name = 'PreCompact' THEN 1 ELSE 0 END) AS compactions,
       SUM(CASE WHEN pm IS NOT NULL THEN 1 ELSE 0 END) AS prompts_with_mode,
       SUM(CASE WHEN pm = 'bypassPermissions' THEN 1 ELSE 0 END) AS bypass
FROM (SELECT ts, hook_event_name,
             CASE WHEN hook_event_name = 'UserPromptSubmit' AND json_valid(payload_json)
                  THEN NULLIF(json_extract(payload_json, '$.permission_mode'), '') END AS pm
      FROM claude_events
      WHERE hook_event_name IN ('PreCompact', 'UserPromptSubmit'))
GROUP BY eday;
CREATE INDEX idx_pf_evday ON _pf_evday(eday);

-- Requests: ALL of them (sidechain included, spec 4.1), per local day.
DROP TABLE IF EXISTS _pf_rqday;
CREATE TEMP TABLE _pf_rqday AS
SELECT rday, COUNT(*) AS n, SUM(err) AS errs FROM _pf_reqday GROUP BY rday;
CREATE INDEX idx_pf_rqday ON _pf_rqday(rday);

-- Model mix: '<synthetic>' (Claude Code's own locally-minted messages) and an
-- empty model are not models.
DROP TABLE IF EXISTS _pf_modday;
CREATE TEMP TABLE _pf_modday AS
SELECT rday, model, COUNT(*) AS n
FROM _pf_reqday
WHERE COALESCE(model, '') <> '' AND model <> '<synthetic>'
GROUP BY rday, model;
CREATE INDEX idx_pf_modday ON _pf_modday(rday);

-- Headless runs: sessions with a request whose entrypoint starts 'sdk-'
-- (sdk-cli, sdk-ts). An empty session_id is not a session (spec 4.1).
DROP TABLE IF EXISTS _pf_sdkday;
CREATE TEMP TABLE _pf_sdkday AS
SELECT DISTINCT rday, session_id
FROM _pf_reqday
WHERE substr(entrypoint, 1, 4) = 'sdk-' AND COALESCE(session_id, '') <> '';
CREATE INDEX idx_pf_sdkday ON _pf_sdkday(rday);

-- Cost per session, evidence only. total_cost_usd is CUMULATIVE per session
-- (CLAUDE.md): MAX it, never SUM it. Per (session, day) here, then MAX again
-- over the window's days below -- only snapshots INSIDE the window count.
DROP TABLE IF EXISTS _pf_costday;
CREATE TEMP TABLE _pf_costday AS
SELECT strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS cday, session_id,
       MAX(total_cost_usd) AS mx
FROM claude_status_snapshots
WHERE total_cost_usd IS NOT NULL AND COALESCE(session_id, '') <> ''
GROUP BY cday, session_id;
CREATE INDEX idx_pf_costday ON _pf_costday(cday);

-- Per-window rollups of the per-day tables above.
DROP TABLE IF EXISTS _pf_wtool;
CREATE TEMP TABLE _pf_wtool AS
SELECT dw.win, dw.day, SUM(t.calls) AS calls, SUM(t.inspect) AS inspect, SUM(t.errors) AS errors,
       SUM(t.subagents) AS subagents, SUM(t.mcp_calls) AS mcp_calls
FROM _pf_dw dw JOIN _pf_tcday t ON t.tday BETWEEN dw.lo AND dw.hi
GROUP BY dw.win, dw.day;

DROP TABLE IF EXISTS _pf_wmcp;
CREATE TEMP TABLE _pf_wmcp AS
SELECT dw.win, dw.day, COUNT(DISTINCT m.mcp_server) AS servers
FROM _pf_dw dw JOIN _pf_mcpday m ON m.tday BETWEEN dw.lo AND dw.hi
GROUP BY dw.win, dw.day;

-- Slash commands and models: per (window, name) totals, then the top one per
-- window by ROW_NUMBER (ties broken by name) -- never a bare column beside an
-- aggregate, whose row SQLite would pick arbitrarily.
DROP TABLE IF EXISTS _pf_wslash;
CREATE TEMP TABLE _pf_wslash AS
SELECT win, day, COUNT(*) AS kinds,
       MAX(CASE WHEN rn = 1 THEN command END) AS top_command,
       MAX(CASE WHEN rn = 1 THEN n END)       AS max_repeat
FROM (SELECT win, day, command, n,
             ROW_NUMBER() OVER (PARTITION BY win, day ORDER BY n DESC, command) AS rn
      FROM (SELECT dw.win, dw.day, s.command, SUM(s.n) AS n
            FROM _pf_dw dw JOIN _pf_slday s ON s.sday BETWEEN dw.lo AND dw.hi
            GROUP BY dw.win, dw.day, s.command))
GROUP BY win, day;

DROP TABLE IF EXISTS _pf_wmodel;
CREATE TEMP TABLE _pf_wmodel AS
SELECT win, day, COUNT(*) AS models,
       MAX(CASE WHEN rn = 1 THEN model END) AS top_model,
       MAX(CASE WHEN rn = 1 THEN n END)     AS top_n
FROM (SELECT win, day, model, n,
             ROW_NUMBER() OVER (PARTITION BY win, day ORDER BY n DESC, model) AS rn
      FROM (SELECT dw.win, dw.day, m.model, SUM(m.n) AS n
            FROM _pf_dw dw JOIN _pf_modday m ON m.rday BETWEEN dw.lo AND dw.hi
            GROUP BY dw.win, dw.day, m.model))
GROUP BY win, day;

DROP TABLE IF EXISTS _pf_wev;
CREATE TEMP TABLE _pf_wev AS
SELECT dw.win, dw.day, SUM(e.compactions) AS compactions,
       SUM(e.prompts_with_mode) AS prompts_with_mode, SUM(e.bypass) AS bypass
FROM _pf_dw dw JOIN _pf_evday e ON e.eday BETWEEN dw.lo AND dw.hi
GROUP BY dw.win, dw.day;

DROP TABLE IF EXISTS _pf_wreq;
CREATE TEMP TABLE _pf_wreq AS
SELECT dw.win, dw.day, SUM(r.n) AS n, SUM(r.errs) AS errs
FROM _pf_dw dw JOIN _pf_rqday r ON r.rday BETWEEN dw.lo AND dw.hi
GROUP BY dw.win, dw.day;

DROP TABLE IF EXISTS _pf_wsdk;
CREATE TEMP TABLE _pf_wsdk AS
SELECT dw.win, dw.day, COUNT(DISTINCT s.session_id) AS headless
FROM _pf_dw dw JOIN _pf_sdkday s ON s.rday BETWEEN dw.lo AND dw.hi
GROUP BY dw.win, dw.day;

DROP TABLE IF EXISTS _pf_wcost;
CREATE TEMP TABLE _pf_wcost AS
SELECT win, day, AVG(mx) AS cost_per_session
FROM (SELECT dw.win, dw.day, c.session_id, MAX(c.mx) AS mx
      FROM _pf_dw dw JOIN _pf_costday c ON c.cday BETWEEN dw.lo AND dw.hi
      GROUP BY dw.win, dw.day, c.session_id)
GROUP BY win, day;

-- Every input of spec 4.4, one row per _pf_dw (win, day). Tool-covered (†) inputs
-- are NULL -- not measured -- when the window is not tool-covered; inspect
-- share and tool-error rate are ALSO NULL when a covered window holds zero
-- tool calls (spec 4.4's first departure: zero calls is not a perfect 0%
-- error rate). Hook-event inputs (compactions, permission modes) are NULL in
-- the same way when the window is not event-covered (Stage 4B spec 4.5). NULL
-- here propagates through every part below.
-- Stage 10 (R1): the Matrix inputs come from _pf_matrix at the row's own
-- window. For a '30' row of an ungated day that is exactly what _pf_profile copied.
DROP TABLE IF EXISTS _pf_in;
CREATE TEMP TABLE _pf_in AS
SELECT dw.win, dw.day,
       m.median_ctx, m.median_n AS median_requests, m.long_sessions, m.long_with_reset, m.cache_fresh_ratio,
       m.f_context, m.f_compaction, m.f_session_length, m.f_efficiency,
       -- †
       CASE WHEN dw.tool_covered = 1 THEN COALESCE(sl.kinds, 0) END      AS slash_kinds,
       CASE WHEN dw.tool_covered = 1 THEN COALESCE(sl.max_repeat, 0) END AS slash_max_repeat,
       CASE WHEN dw.tool_covered = 1 THEN sl.top_command END             AS top_command,
       CASE WHEN dw.tool_covered = 1 THEN COALESCE(t.calls, 0) END       AS tool_calls,
       CASE WHEN dw.tool_covered = 1 AND t.calls > 0 THEN t.inspect * 1.0 / t.calls END AS inspect_share,
       CASE WHEN dw.tool_covered = 1 AND t.calls > 0 THEN t.errors * 1.0 / t.calls END  AS tool_error_rate,
       CASE WHEN dw.tool_covered = 1 THEN COALESCE(t.subagents, 0) END   AS subagent_launches,
       CASE WHEN dw.tool_covered = 1 THEN COALESCE(t.mcp_calls, 0) END   AS mcp_calls,
       CASE WHEN dw.tool_covered = 1 THEN COALESCE(mc.servers, 0) END    AS mcp_servers,
       -- always measured once the day is ungated
       COALESCE(sdk.headless, 0)         AS headless_sessions,
       -- measured only once the hooks cover the whole window (spec 4B 4.5)
       dw.event_covered                  AS event_covered,
       CASE WHEN dw.event_covered = 1 THEN COALESCE(ev.compactions, 0) END       AS compactions,
       CASE WHEN dw.event_covered = 1 THEN COALESCE(ev.prompts_with_mode, 0) END AS prompts_with_mode,
       CASE WHEN dw.event_covered = 1 THEN COALESCE(ev.bypass, 0) END            AS bypass_prompts,
       CASE WHEN dw.event_covered = 1 AND ev.prompts_with_mode > 0
            THEN ev.bypass * 1.0 / ev.prompts_with_mode END                      AS bypass_share,
       COALESCE(md.models, 0) AS models,
       md.top_model,
       -- The top model's share of ALL the window's requests, rounded to a
       -- whole percent, in this arithmetic order.
       CAST(round((md.top_n * 1.0 / rq.n) * 100) AS INTEGER) AS top_pct,
       rq.n    AS requests,
       rq.errs AS api_errors,
       -- Success: 1 - error share (spec).
       (rq.n - rq.errs) * 1.0 / rq.n AS success,
       co.cost_per_session
FROM _pf_dw dw
JOIN _pf_matrix m        ON m.win  = dw.win AND m.day  = dw.day
JOIN _pf_wreq rq         ON rq.win = dw.win AND rq.day = dw.day
LEFT JOIN _pf_wtool  t   ON t.win   = dw.win AND t.day   = dw.day
LEFT JOIN _pf_wmcp   mc  ON mc.win  = dw.win AND mc.day  = dw.day
LEFT JOIN _pf_wslash sl  ON sl.win  = dw.win AND sl.day  = dw.day
LEFT JOIN _pf_wmodel md  ON md.win  = dw.win AND md.day  = dw.day
LEFT JOIN _pf_wev    ev  ON ev.win  = dw.win AND ev.day  = dw.day
LEFT JOIN _pf_wsdk   sdk ON sdk.win = dw.win AND sdk.day = dw.day
LEFT JOIN _pf_wcost  co  ON co.win  = dw.win AND co.day  = dw.day;

-- Each part, one row per (win, day, discipline, part), 0-100 or NULL (undefined).
-- H and L are the helpers, in spec 4.2's exact arithmetic order (the literal
-- subtractions such as (0.4 - 0.05) are deliberate -- that double is not the
-- literal 0.35). clamp(v) is MIN(100, MAX(0, v)); SQLite's
-- multi-argument MIN/MAX return NULL when any argument is NULL, so an
-- undefined input stays undefined through the clamp.
DROP TABLE IF EXISTS _pf_parts;
CREATE TEMP TABLE _pf_parts AS
-- 1 prompt-hygiene: clamp(slash_kinds x 20) †
SELECT win, day, 'prompt-hygiene' AS discipline, MIN(100, MAX(0, slash_kinds * 20)) AS v FROM _pf_in
-- 2 context-hygiene: the Matrix context factor
UNION ALL SELECT win, day, 'context-hygiene', f_context FROM _pf_in
-- 3 session-hygiene: Matrix sessionLength; Matrix compaction; clamp(PreCompact x 20)
--   -- the last is NULL, and left out of the mean, when not event-covered
UNION ALL SELECT win, day, 'session-hygiene', f_session_length FROM _pf_in
UNION ALL SELECT win, day, 'session-hygiene', f_compaction FROM _pf_in
UNION ALL SELECT win, day, 'session-hygiene', MIN(100, MAX(0, compactions * 20)) FROM _pf_in
-- 4 model-routing: clamp((models - 1) x 45); H(1 - top_pct/100, 0, 0.35)
UNION ALL SELECT win, day, 'model-routing', MIN(100, MAX(0, (models - 1) * 45)) FROM _pf_in
UNION ALL SELECT win, day, 'model-routing',
  CASE WHEN top_pct IS NULL THEN NULL
       WHEN MIN(1, MAX(0, 1 - top_pct / 100.0)) <= 0    THEN 0
       WHEN MIN(1, MAX(0, 1 - top_pct / 100.0)) >= 0.35 THEN 100
       ELSE CAST(round(100 * ((MIN(1, MAX(0, 1 - top_pct / 100.0)) - 0) / (0.35 - 0))) AS INTEGER)
  END FROM _pf_in
-- 5 cost-discipline: the Matrix efficiency factor
UNION ALL SELECT win, day, 'cost-discipline', f_efficiency FROM _pf_in
-- 6 verification: H(inspect_share, 0.1, 0.5) †; L(tool_error_rate, 0.05, 0.4) †
UNION ALL SELECT win, day, 'verification',
  CASE WHEN inspect_share IS NULL THEN NULL
       WHEN inspect_share <= 0.1 THEN 0
       WHEN inspect_share >= 0.5 THEN 100
       ELSE CAST(round(100 * ((inspect_share - 0.1) / (0.5 - 0.1))) AS INTEGER)
  END FROM _pf_in
UNION ALL SELECT win, day, 'verification',
  CASE WHEN tool_error_rate IS NULL THEN NULL
       WHEN tool_error_rate <= 0.05 THEN 100
       WHEN tool_error_rate >= 0.4  THEN 0
       ELSE CAST(round(100 * (1 - (tool_error_rate - 0.05) / (0.4 - 0.05))) AS INTEGER)
  END FROM _pf_in
-- 7 automation (Watchtower definition): clamp(runs x 20), runs = headless
--   sessions + subagent launches † (headless alone without tool data);
--   mcp_calls > 0 ? clamp(20 + 2 x mcp_calls) : 0 †
UNION ALL SELECT win, day, 'automation',
  MIN(100, MAX(0, (headless_sessions + COALESCE(subagent_launches, 0)) * 20)) FROM _pf_in
UNION ALL SELECT win, day, 'automation',
  CASE WHEN mcp_calls IS NULL THEN NULL
       WHEN mcp_calls > 0 THEN MIN(100, MAX(0, 20 + mcp_calls * 2))
       ELSE 0
  END FROM _pf_in
-- 8 reuse: H(slash_max_repeat, 1, 8) †; clamp(mcp_servers x 33) †
UNION ALL SELECT win, day, 'reuse',
  CASE WHEN slash_max_repeat IS NULL THEN NULL
       WHEN slash_max_repeat <= 1 THEN 0
       WHEN slash_max_repeat >= 8 THEN 100
       ELSE CAST(round(100 * ((slash_max_repeat - 1.0) / (8.0 - 1.0))) AS INTEGER)
  END FROM _pf_in
UNION ALL SELECT win, day, 'reuse', MIN(100, MAX(0, mcp_servers * 33)) FROM _pf_in
-- 9 security (Watchtower definition): L(bypass_share, 0.02, 0.25); needs-data
--   when not event-covered (bypass_share NULL)
UNION ALL SELECT win, day, 'security',
  CASE WHEN bypass_share IS NULL THEN NULL
       WHEN bypass_share <= 0.02 THEN 100
       WHEN bypass_share >= 0.25 THEN 0
       ELSE CAST(round(100 * (1 - (bypass_share - 0.02) / (0.25 - 0.02))) AS INTEGER)
  END FROM _pf_in
-- 10 output-quality: H(success, 0.9, 1); L(tool_error_rate, 0.05, 0.4) † as in 6
UNION ALL SELECT win, day, 'output-quality',
  CASE WHEN success IS NULL THEN NULL
       WHEN success <= 0.9 THEN 0
       WHEN success >= 1   THEN 100
       ELSE CAST(round(100 * ((success - 0.9) / (1 - 0.9))) AS INTEGER)
  END FROM _pf_in
UNION ALL SELECT win, day, 'output-quality',
  CASE WHEN tool_error_rate IS NULL THEN NULL
       WHEN tool_error_rate <= 0.05 THEN 100
       WHEN tool_error_rate >= 0.4  THEN 0
       ELSE CAST(round(100 * (1 - (tool_error_rate - 0.05) / (0.4 - 0.05))) AS INTEGER)
  END FROM _pf_in;

-- Evidence: the raw numbers behind each score, JSON null when undefined
-- (spec 4.6 -- numbers, never sentences). ord is the spec's display order.
DROP TABLE IF EXISTS _pf_ev;
CREATE TEMP TABLE _pf_ev AS
SELECT win, day, 'prompt-hygiene' AS discipline, 1 AS ord, 'original' AS definition,
       json_object('slash_kinds', slash_kinds) AS evidence FROM _pf_in
UNION ALL SELECT win, day, 'context-hygiene', 2, 'original',
       json_object('median_ctx', median_ctx, 'factor', f_context) FROM _pf_in
UNION ALL SELECT win, day, 'session-hygiene', 3, 'original',
       json_object('median_requests', median_requests, 'long_sessions', long_sessions,
                   'long_with_reset', long_with_reset, 'compactions', compactions,
                   'f_session_length', f_session_length, 'f_compaction', f_compaction,
                   'event_covered', event_covered) FROM _pf_in
UNION ALL SELECT win, day, 'model-routing', 4, 'original',
       json_object('models', models, 'top_model', top_model, 'top_pct', top_pct) FROM _pf_in
UNION ALL SELECT win, day, 'cost-discipline', 5, 'original',
       json_object('cache_fresh_ratio', cache_fresh_ratio, 'factor', f_efficiency,
                   'cost_per_session', cost_per_session) FROM _pf_in
UNION ALL SELECT win, day, 'verification', 6, 'original',
       json_object('tool_calls', tool_calls, 'inspect_share', inspect_share,
                   'tool_error_rate', tool_error_rate) FROM _pf_in
UNION ALL SELECT win, day, 'automation', 7, 'watchtower',
       json_object('headless_sessions', headless_sessions, 'subagent_launches', subagent_launches,
                   'mcp_calls', mcp_calls) FROM _pf_in
UNION ALL SELECT win, day, 'reuse', 8, 'original',
       json_object('slash_max_repeat', slash_max_repeat, 'top_command', top_command,
                   'mcp_servers', mcp_servers) FROM _pf_in
UNION ALL SELECT win, day, 'security', 9, 'watchtower',
       json_object('prompts_with_mode', prompts_with_mode, 'bypass_prompts', bypass_prompts,
                   'bypass_share', bypass_share, 'event_covered', event_covered) FROM _pf_in
UNION ALL SELECT win, day, 'output-quality', 10, 'original',
       json_object('requests', requests, 'api_errors', api_errors, 'success', success,
                   'tool_error_rate', tool_error_rate) FROM _pf_in;

-- Every (window, day, discipline) scored once (R2): the mean of its DEFINED
-- parts (SQLite's AVG skips NULLs) scaled to 0-60,
-- clamp(round(mean/100 * 60), 0, 60). No defined part -> needs-data, 0.
-- Status: strong from 45, ok from 30, else needs-work.
DROP TABLE IF EXISTS _pf_sc;
CREATE TEMP TABLE _pf_sc AS
SELECT e.win, e.day, e.discipline, e.ord, e.definition, e.evidence, s.score,
       CASE WHEN s.mean IS NULL THEN 'needs-data'
            WHEN s.score >= 45 THEN 'strong'
            WHEN s.score >= 30 THEN 'ok'
            ELSE 'needs-work' END AS status
FROM _pf_ev e
JOIN (SELECT win, day, discipline, mean,
             CASE WHEN mean IS NULL THEN 0
                  ELSE MIN(60, MAX(0, CAST(round((mean / 100.0) * 60) AS INTEGER))) END AS score
      FROM (SELECT win, day, discipline, AVG(v) AS mean FROM _pf_parts GROUP BY win, day, discipline)) s
  ON s.win = e.win AND s.day = e.day AND s.discipline = e.discipline;

-- The 30-day scores, staged in claude_discipline_scores' shape (its PRIMARY
-- KEY as a unique index) like _pf_profile.
DROP TABLE IF EXISTS _pf_scores;
CREATE TEMP TABLE _pf_scores AS SELECT * FROM main.claude_discipline_scores WHERE 0;
CREATE UNIQUE INDEX idx_pf_scores ON _pf_scores(day, discipline);
INSERT INTO _pf_scores (day, discipline, score, status, definition, evidence_json)
SELECT day, discipline, score, status, definition, evidence FROM _pf_sc WHERE win = '30' ORDER BY day, ord;

-- Stage 10: the as-of day's 7-day scores (10 rows, or none when gated).
DROP TABLE IF EXISTS _pf_scores7d;
CREATE TEMP TABLE _pf_scores7d AS SELECT * FROM main.claude_discipline_scores_7d WHERE 0;
CREATE UNIQUE INDEX idx_pf_scores7d ON _pf_scores7d(day, discipline);
INSERT INTO _pf_scores7d (day, discipline, score, status)
SELECT day, discipline, score, status FROM _pf_sc WHERE win = '7' ORDER BY day, ord;

-- Total (needs-data counts 0), how many of the ten measured,
-- and the 6-tier ladder: Noobie .. Master, min(5, total / 100) -- integer
-- division is floor here since total >= 0. Points to next is NULL at Master.
UPDATE _pf_profile
SET total = (SELECT SUM(score) FROM _pf_scores s WHERE s.day = _pf_profile.day),
    measured = (SELECT SUM(CASE WHEN status <> 'needs-data' THEN 1 ELSE 0 END)
                FROM _pf_scores s WHERE s.day = _pf_profile.day)
WHERE window_requests >= 20;
UPDATE _pf_profile
SET tier_index = MIN(5, total / 100),
    tier_points_to_next = CASE WHEN MIN(5, total / 100) = 5 THEN NULL
                               ELSE (MIN(5, total / 100) + 1) * 100 - total END
WHERE total IS NOT NULL;
-- Total week over week: total(D) - total(D-7), NULL when
-- either is NULL -- a gated D-7 or no D-7 row at all.
UPDATE _pf_profile
SET total_wow = total - (SELECT p7.total FROM _pf_profile p7
                         WHERE p7.day = date(_pf_profile.day, '-7 day'))
WHERE total IS NOT NULL;

-- ============================================================================
-- Stage 8: weekly quests (spec 4.2-4.4). Each (week, discipline) is measured
-- once, in _pf_wk: that week's value, and the next week's baseline.
-- ============================================================================

-- Each quest's rule, and the only place it lives (spec 4.4). A target is the
-- baseline plus step -- or, with rel = 1, the baseline times (1 + step) --
-- never past full_marks. p is the precision every value, baseline and target
-- is stored at, so the page shows exactly the numbers status compared.
DROP TABLE IF EXISTS _pf_qdef;
CREATE TEMP TABLE _pf_qdef (discipline TEXT PRIMARY KEY, direction TEXT NOT NULL,
  step REAL NOT NULL, rel INTEGER NOT NULL, full_marks REAL NOT NULL, p REAL NOT NULL);
INSERT INTO _pf_qdef (discipline, direction, step, rel, full_marks, p) VALUES
  ('verification',    'at-least',  0.02,  0, 0.5,   0.001),
  ('cost-discipline', 'at-most',  -0.1,   1, 10,    1),
  ('context-hygiene', 'at-most',  -0.1,   1, 60000, 1000),
  ('session-hygiene', 'at-least',  0.1,   0, 1,     0.001),
  ('model-routing',   'at-least',  0.05,  0, 0.35,  0.001),
  ('security',        'at-most',  -0.01,  0, 0.02,  0.001),
  ('output-quality',  'at-most',  -0.005, 0, 0.05,  0.001),
  ('prompt-hygiene',  'at-least',  1,     0, 5,     1),
  ('reuse',           'at-least',  1,     0, 8,     1),
  ('automation',      'at-least',  2,     0, 5,     1);

-- One row per week: its '30'-style aggregates from the 'wk' window, the
-- per-day tables summed over Monday..Sunday (as _pf_wtool and its siblings sum
-- them over each '30' window), and whether tool calls and hook events were
-- being recorded -- the profile's coverage rules, applied to the week's Monday.
DROP TABLE IF EXISTS _pf_wkin;
CREATE TEMP TABLE _pf_wkin AS
SELECT w.day AS week, w.lo, w.hi,
       COALESCE(a.n_requests, 0) AS requests,
       CASE WHEN cov.coverage_start IS NOT NULL AND w.lo >= cov.coverage_start THEN 1 ELSE 0 END AS tool_covered,
       CASE WHEN ev.event_start IS NOT NULL AND w.lo >= ev.event_start THEN 1 ELSE 0 END AS event_covered,
       a.sum_tcr, a.sum_fresh, mc.median_ctx, l.long_sessions, l.long_with_reset,
       t.calls, t.inspect, t.errors, t.subagents,
       sl.kinds AS slash_kinds, sl.top AS slash_top,
       e.prompts_with_mode, e.bypass,
       md.top AS top_n,
       sdk.headless
FROM _pf_win w
CROSS JOIN _pf_coverage cov
CROSS JOIN _pf_evcov ev
LEFT JOIN _pf_agg a     ON a.win  = 'wk' AND a.day  = w.day
LEFT JOIN _pf_medctx mc ON mc.win = 'wk' AND mc.day = w.day
LEFT JOIN _pf_long l    ON l.win  = 'wk' AND l.day  = w.day
LEFT JOIN (SELECT x.day AS week, SUM(t.calls) AS calls, SUM(t.inspect) AS inspect,
                  SUM(t.errors) AS errors, SUM(t.subagents) AS subagents
           FROM _pf_win x JOIN _pf_tcday t ON t.tday BETWEEN x.lo AND x.hi
           WHERE x.win = 'wk' GROUP BY x.day) t ON t.week = w.day
LEFT JOIN (SELECT week, COUNT(*) AS kinds, MAX(n) AS top
           FROM (SELECT x.day AS week, s.command, SUM(s.n) AS n
                 FROM _pf_win x JOIN _pf_slday s ON s.sday BETWEEN x.lo AND x.hi
                 WHERE x.win = 'wk' GROUP BY x.day, s.command)
           GROUP BY week) sl ON sl.week = w.day
LEFT JOIN (SELECT x.day AS week, SUM(v.prompts_with_mode) AS prompts_with_mode, SUM(v.bypass) AS bypass
           FROM _pf_win x JOIN _pf_evday v ON v.eday BETWEEN x.lo AND x.hi
           WHERE x.win = 'wk' GROUP BY x.day) e ON e.week = w.day
LEFT JOIN (SELECT week, MAX(n) AS top
           FROM (SELECT x.day AS week, m.model, SUM(m.n) AS n
                 FROM _pf_win x JOIN _pf_modday m ON m.rday BETWEEN x.lo AND x.hi
                 WHERE x.win = 'wk' GROUP BY x.day, m.model)
           GROUP BY week) md ON md.week = w.day
LEFT JOIN (SELECT x.day AS week, COUNT(DISTINCT s.session_id) AS headless
           FROM _pf_win x JOIN _pf_sdkday s ON s.rday BETWEEN x.lo AND x.hi
           WHERE x.win = 'wk' GROUP BY x.day) sdk ON sdk.week = w.day
WHERE w.win = 'wk';

-- One row per (week, discipline), spec 4.2's table. value is NULL -- not
-- measured -- under 20 requests and wherever that table says; otherwise it is
-- stored at its quest's precision. round(.., 3) after the step makes 0.35
-- the double 0.35, not 0.35000000000000003.
DROP TABLE IF EXISTS _pf_wk;
CREATE TEMP TABLE _pf_wk AS
WITH m AS (
  SELECT week, lo, hi, requests, 'verification' AS discipline,
         CASE WHEN tool_covered = 1 AND calls > 0 THEN inspect * 1.0 / calls END AS raw FROM _pf_wkin
  UNION ALL SELECT week, lo, hi, requests, 'cost-discipline',
         CASE WHEN sum_fresh > 0 THEN sum_tcr * 1.0 / sum_fresh END FROM _pf_wkin
  UNION ALL SELECT week, lo, hi, requests, 'context-hygiene', median_ctx FROM _pf_wkin
  UNION ALL SELECT week, lo, hi, requests, 'session-hygiene',
         CASE WHEN long_sessions > 0 THEN long_with_reset * 1.0 / long_sessions END FROM _pf_wkin
  UNION ALL SELECT week, lo, hi, requests, 'model-routing',
         CASE WHEN top_n IS NOT NULL AND requests > 0 THEN 1 - top_n * 1.0 / requests END FROM _pf_wkin
  UNION ALL SELECT week, lo, hi, requests, 'security',
         CASE WHEN event_covered = 1 AND prompts_with_mode > 0 THEN bypass * 1.0 / prompts_with_mode END FROM _pf_wkin
  UNION ALL SELECT week, lo, hi, requests, 'output-quality',
         CASE WHEN tool_covered = 1 AND calls > 0 THEN errors * 1.0 / calls END FROM _pf_wkin
  UNION ALL SELECT week, lo, hi, requests, 'prompt-hygiene',
         CASE WHEN tool_covered = 1 THEN COALESCE(slash_kinds, 0) END FROM _pf_wkin
  UNION ALL SELECT week, lo, hi, requests, 'reuse',
         CASE WHEN tool_covered = 1 THEN COALESCE(slash_top, 0) END FROM _pf_wkin
  UNION ALL SELECT week, lo, hi, requests, 'automation',
         CASE WHEN tool_covered = 1 THEN COALESCE(subagents, 0) + COALESCE(headless, 0) END FROM _pf_wkin
)
SELECT m.week, m.lo, m.hi, m.discipline, m.requests,
       CASE WHEN m.requests < 20 OR m.raw IS NULL THEN NULL
            ELSE round(round(m.raw / d.p) * d.p, 3) END AS value
FROM m JOIN _pf_qdef d ON d.discipline = m.discipline;
CREATE UNIQUE INDEX idx_pf_wk ON _pf_wk(week, discipline);

-- Spec 4.3: a week's quests are the three lowest eligible 30-day scores on the
-- Sunday before it, ties by display order. Eligible: measured that day (not
-- needs-data), and measured the week before -- that value is the baseline.
DROP TABLE IF EXISTS _pf_qpick;
CREATE TEMP TABLE _pf_qpick AS
SELECT week, slot, discipline, score, baseline FROM (
  SELECT w.week, s.discipline, s.score, b.value AS baseline,
         ROW_NUMBER() OVER (PARTITION BY w.week ORDER BY s.score, e.ord) AS slot
  FROM (SELECT DISTINCT week FROM _pf_wk) w
  JOIN _pf_scores s ON s.day = date(w.week, '-1 day') AND s.status <> 'needs-data'
  JOIN _pf_ev e     ON e.win = '30' AND e.day = s.day AND e.discipline = s.discipline
  JOIN _pf_wk b     ON b.week = date(w.week, '-7 days') AND b.discipline = s.discipline AND b.value IS NOT NULL
) WHERE slot <= 3;

-- Spec 4.4: each quest's target and status, staged in claude_quests' shape.
-- The week holding the as-of day is open; a closed week with no value is
-- 'no data', never 'missed'.
DROP TABLE IF EXISTS _pf_quests;
CREATE TEMP TABLE _pf_quests AS SELECT * FROM main.claude_quests WHERE 0;
CREATE UNIQUE INDEX idx_pf_quests ON _pf_quests(week, slot);
INSERT INTO _pf_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status)
SELECT week, hi, slot, discipline, score, direction, baseline, target, hold, value, requests,
       CASE WHEN d0 BETWEEN lo AND hi THEN 'open'
            WHEN value IS NULL THEN 'no data'
            WHEN direction = 'at-least' AND value >= target THEN 'done'
            WHEN direction = 'at-most'  AND value <= target THEN 'done'
            ELSE 'missed'
       END
FROM (
  SELECT q.week, q.slot, q.discipline, q.score, d.direction, q.baseline, w.value, w.requests, w.lo, w.hi, a.d0,
         round(round(CASE WHEN d.direction = 'at-least' THEN MIN(q.moved, d.full_marks)
                          ELSE MAX(q.moved, d.full_marks) END / d.p) * d.p, 3) AS target,
         CASE WHEN d.direction = 'at-least' THEN q.baseline >= d.full_marks
              ELSE q.baseline <= d.full_marks END AS hold
  FROM (SELECT p.*, CASE WHEN d.rel = 1 THEN p.baseline * (1 + d.step) ELSE p.baseline + d.step END AS moved
        FROM _pf_qpick p JOIN _pf_qdef d ON d.discipline = p.discipline) q
  JOIN _pf_qdef d ON d.discipline = q.discipline
  JOIN _pf_wk w   ON w.week = q.week AND w.discipline = q.discipline
  CROSS JOIN _pf_asof a
)
ORDER BY week, slot;

-- End of the READ phase: everything above wrote only the TEMP schema.
COMMIT;

-- The WRITE phase: the only statements that run under the write lock. Nothing
-- is computed here -- copy the staged rows across, in their staged order.
BEGIN IMMEDIATE;
DELETE FROM claude_profile_daily;
DELETE FROM claude_discipline_scores;
INSERT INTO claude_profile_daily (day, window_requests, tool_covered, event_covered, total, measured, tier_index, tier_points_to_next, total_wow, matrix_score, matrix_tier, matrix_points_to_next, f_context, f_compaction, f_session_length, f_efficiency, median_ctx, median_requests, long_sessions, long_with_reset, cache_fresh_ratio, matrix_7d, matrix_wow)
SELECT day, window_requests, tool_covered, event_covered, total, measured, tier_index, tier_points_to_next, total_wow, matrix_score, matrix_tier, matrix_points_to_next, f_context, f_compaction, f_session_length, f_efficiency, median_ctx, median_requests, long_sessions, long_with_reset, cache_fresh_ratio, matrix_7d, matrix_wow
FROM _pf_profile ORDER BY rowid;
INSERT INTO claude_discipline_scores (day, discipline, score, status, definition, evidence_json)
SELECT day, discipline, score, status, definition, evidence_json
FROM _pf_scores ORDER BY rowid;
DELETE FROM claude_discipline_scores_7d;
INSERT INTO claude_discipline_scores_7d (day, discipline, score, status)
SELECT day, discipline, score, status FROM _pf_scores7d ORDER BY rowid;
DELETE FROM claude_quests;
INSERT INTO claude_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status)
SELECT week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status FROM _pf_quests ORDER BY rowid;
COMMIT;
SQL
} | sqlite3 -cmd ".bail on" -cmd ".timeout 8000" "$DB" 2>/dev/null || { [ "$QUIET" -eq 1 ] || echo "cc-rollup: profile rebuild failed" >&2; exit 1; }

# ---- rebuild the agent rollups (Stage 5) -------------------------------------
# Codex and Hermes (from wt_*, written by `watchtower sync`) and every tool's
# level. Runs LAST, after every Claude section has committed, so a failure here
# can never cost Claude a number. Same two phases as the sections above: every
# intermediate under BEGIN DEFERRED (no write lock), and only the swap under
# BEGIN IMMEDIATE.
#
# A database that has never been synced at v3 has no wt_sessions.cwd/entry/
# driven. TEMP stand-ins shadow the main tables then (an unqualified name
# resolves to temp first), so the same SQL runs and writes only Claude's
# agent_progress row (spec 4.1).
_ag_ready="$(cc_sql_val "SELECT COUNT(*) FROM pragma_table_info('wt_sessions') WHERE name IN ('cwd','entry','driven');")"
_ag_prelude=""
[ "$_ag_ready" = "3" ] || _ag_prelude="
CREATE TEMP TABLE wt_sources (source TEXT PRIMARY KEY);
CREATE TEMP TABLE wt_sessions (canonical_id TEXT PRIMARY KEY, first_source TEXT, started_at INTEGER,
  cwd TEXT, entry TEXT, driven INTEGER);
CREATE TEMP TABLE wt_events (source TEXT, source_record_id TEXT, canonical_id TEXT, ts INTEGER,
  kind TEXT, dimensions TEXT);
CREATE TEMP TABLE wt_requests (source TEXT, source_record_id TEXT, canonical_id TEXT, ts INTEGER,
  model TEXT, tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER,
  tokens_cache_creation INTEGER, cost_usd REAL);"

# Stage 6 (spec 4.6): pace and streaks are measured as of _sk_today, the run's
# local day, computed before the profile section (Stage 8 spec 4.0).
_ag_prelude="$_ag_prelude
CREATE TEMP TABLE _sk_asof (d0 TEXT NOT NULL);
INSERT INTO _sk_asof VALUES ($(cc_sqlstr "$_sk_today"));"

{ printf '%s\n' "$_ag_prelude"; cat <<'SQL'
BEGIN DEFERRED;

DROP TABLE IF EXISTS _ag_prices;
CREATE TEMP TABLE _ag_prices (model TEXT, effective_from TEXT, input REAL, cached_input REAL,
  output REAL, verified_on TEXT, source TEXT);
-- Spec 4.3 / plan R14: OpenAI's published API rates, standard tier, USD per 1M
-- tokens, read 2026-10-03. One INSERT per model, so a price change is one new
-- line with a later effective_from and history is never repriced. No rate may
-- appear under lib/ (tests/cost-rollup.test.ts greps for them).
INSERT INTO _ag_prices VALUES ('gpt-6-astra','2025-01-01',10,1.00,50,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-6.1-sol','2025-01-01',2,0.10,10,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-5.6-sol','2025-01-01',4,0.40,20,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-5.5','2025-01-01',5,0.50,30,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-5.4-mini','2025-01-01',0.75,0.075,4.50,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-5.2','2025-01-01',1.75,0.175,14,'2026-10-03','https://developers.openai.com/api/docs/pricing');
INSERT INTO _ag_prices VALUES ('gpt-5','2025-01-01',1.25,0.125,10,'2026-10-03','https://developers.openai.com/api/docs/pricing');

-- Models OpenAI does not sell on the API: 'no-public-rate', not 'unknown-model'.
-- gpt-5.2-codex: the pricing page (checked 2026-10-03) lists gpt-5.2 and
-- gpt-5.3-codex, not gpt-5.2-codex. A sibling's rate is never borrowed.
DROP TABLE IF EXISTS _ag_no_rate;
CREATE TEMP TABLE _ag_no_rate (model TEXT PRIMARY KEY);
INSERT INTO _ag_no_rate VALUES ('codex-auto-review');
INSERT INTO _ag_no_rate VALUES ('gpt-5.2-codex');

-- Each rate's window: from its effective_from to the next row's, as epoch seconds.
DROP TABLE IF EXISTS _ag_pwin;
CREATE TEMP TABLE _ag_pwin AS
SELECT model, input, cached_input, output,
       CAST(strftime('%s', effective_from) AS INTEGER) AS from_s,
       CAST(strftime('%s', LEAD(effective_from) OVER (PARTITION BY model ORDER BY effective_from)) AS INTEGER) AS until_s
FROM _ag_prices;

-- Codex and Hermes sessions with their project, keyed exactly as Claude's _pk
-- keys a cwd: excluded, unresolved and non-repo cwds are real rows.
DROP TABLE IF EXISTS _ag_sess;
CREATE TEMP TABLE _ag_sess AS
SELECT s.canonical_id, s.first_source, s.started_at, s.driven,
       CASE WHEN p.source = 'excluded'  THEN '(excluded)'
            WHEN p.project_path IS NULL THEN '(unfiled)'
            ELSE p.project_path
       END AS project_key
FROM wt_sessions s
LEFT JOIN claude_project_paths p ON p.cwd = s.cwd
WHERE s.first_source IN ('codex','hermes');
CREATE INDEX IF NOT EXISTS _ag_sess_id ON _ag_sess(canonical_id);

-- One row per request. Hermes rows carry Hermes's own figure and are never
-- priced here (decision 4: Hermes's figure never enters "at API prices").
-- The priced CASE has one branch per note, so each "not priced" is explicit.
DROP TABLE IF EXISTS _ag_rm;
CREATE TEMP TABLE _ag_rm AS
SELECT q.source, q.source_record_id, q.canonical_id, q.day, q.project_key, q.model,
       q.tokens_in, q.tokens_out, q.tokens_cache_read, q.tokens_cache_creation,
       q.priced,
       CASE WHEN q.priced = 0 THEN q.note END AS price_note,
       CASE WHEN q.priced = 1 THEN
         ((COALESCE(q.tokens_in, 0) + COALESCE(q.tokens_cache_creation, 0)) * q.input
          + COALESCE(q.tokens_cache_read, 0) * q.cached_input
          + COALESCE(q.tokens_out, 0) * q.output) / 1000000.0
       END AS cost_table_usd,
       CASE WHEN q.source = 'hermes' THEN q.cost_usd END AS own_cost_usd
FROM (
  SELECT r.source, r.source_record_id, r.canonical_id, r.model,
         strftime('%Y-%m-%d', r.ts, 'unixepoch', 'localtime') AS day,
         COALESCE(s.project_key, '(unfiled)') AS project_key,
         r.tokens_in, r.tokens_out, r.tokens_cache_read, r.tokens_cache_creation, r.cost_usd,
         w.input, w.cached_input, w.output,
         CASE WHEN r.source = 'hermes'                                         THEN NULL
              WHEN r.model IN (SELECT model FROM _ag_no_rate)                  THEN 0
              WHEN NOT EXISTS (SELECT 1 FROM _ag_prices p WHERE p.model = r.model) THEN 0
              WHEN w.model IS NULL                                             THEN 0
              ELSE                                                                  1
         END AS priced,
         CASE WHEN r.model IN (SELECT model FROM _ag_no_rate)                  THEN 'no-public-rate'
              WHEN NOT EXISTS (SELECT 1 FROM _ag_prices p WHERE p.model = r.model) THEN 'unknown-model'
              WHEN w.model IS NULL                                             THEN 'no-price-yet'
         END AS note
  FROM wt_requests r
  LEFT JOIN _ag_sess s ON s.canonical_id = r.canonical_id
  LEFT JOIN _ag_pwin w ON w.model = r.model AND r.ts >= w.from_s AND (w.until_s IS NULL OR r.ts < w.until_s)
  WHERE r.source IN ('codex','hermes')
) q;

-- Activity events of DRIVEN sessions only (decision 3): an automated or
-- unclassified session earns no hours.
DROP TABLE IF EXISTS _ag_ev;
CREATE TEMP TABLE _ag_ev AS
SELECT e.source, e.canonical_id, e.source_record_id, e.ts,
       json_extract(e.dimensions, '$.event') AS evt,
       json_extract(e.dimensions, '$.seq')   AS seq,
       s.project_key
FROM wt_events e
JOIN _ag_sess s ON s.canonical_id = e.canonical_id AND s.first_source = e.source AND s.driven = 1
WHERE e.source IN ('codex','hermes') AND e.kind = 'event';

-- Stage 6 (spec 4.3): the driving model of each Codex event, by Claude's rule
-- over the session's requests: the latest at or before the event, requests
-- before events in the same second, ties to the greater source_record_id.
-- codex-auto-review is a reviewer and never drives; Codex records no subagent
-- flag, so it is the only exclusion. Hermes stores no per-call times, so it
-- has no rows here; _ag_sfm gives each of its sessions one model.
DROP TABLE IF EXISTS _ag_evm;
CREATE TEMP TABLE _ag_evm AS
WITH st AS (
  SELECT canonical_id, ts, 1 AS k, seq AS s1, source_record_id AS s2, NULL AS model
  FROM _ag_ev WHERE source = 'codex'
  UNION ALL
  SELECT canonical_id, ts, 0, 0, source_record_id, model
  FROM wt_requests
  WHERE source = 'codex' AND model IS NOT NULL AND model <> 'codex-auto-review'
), g AS (
  SELECT st.*, SUM(1 - k) OVER (PARTITION BY canonical_id ORDER BY ts, k, s1, s2
                                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS grp
  FROM st
), m AS (
  SELECT s2, k, grp, FIRST_VALUE(model) OVER (PARTITION BY canonical_id, grp ORDER BY ts, k, s1, s2) AS model
  FROM g
)
SELECT s2 AS source_record_id, model FROM m WHERE k = 1 AND grp > 0;
CREATE INDEX IF NOT EXISTS _ag_evm_id ON _ag_evm(source_record_id);

-- The fallback (spec 4.3): a Codex session's first non-reviewer request; a
-- Hermes session's one model, or '(several models)' when it used two or more
-- -- never a guessed split; otherwise '(no model)'.
DROP TABLE IF EXISTS _ag_sfm;
CREATE TEMP TABLE _ag_sfm AS
WITH cr AS (
  SELECT canonical_id, model,
         ROW_NUMBER() OVER (PARTITION BY canonical_id ORDER BY ts, source_record_id) AS rn
  FROM wt_requests
  WHERE source = 'codex' AND model IS NOT NULL AND model <> 'codex-auto-review'
), hr AS (
  SELECT canonical_id,
         CASE WHEN COUNT(DISTINCT model) = 1 THEN MAX(model) ELSE '(several models)' END AS model
  FROM wt_requests WHERE source = 'hermes' AND model IS NOT NULL
  GROUP BY canonical_id
)
SELECT s.canonical_id,
       COALESCE(CASE WHEN s.first_source = 'codex' THEN cr.model ELSE hr.model END, '(no model)') AS model
FROM _ag_sess s
LEFT JOIN cr ON cr.canonical_id = s.canonical_id AND cr.rn = 1
LEFT JOIN hr ON hr.canonical_id = s.canonical_id;
CREATE INDEX IF NOT EXISTS _ag_sfm_id ON _ag_sfm(canonical_id);

-- Claude's gap rule (section 1's _act), unchanged in meaning: the gap ENDS at
-- the current event, a gap ending at session_start/session_end counts 0, one
-- ending at a prompt is think time, and while working (the last prompt later
-- than the last stop or session_start) a gap counts up to 4 h. Ties order by
-- the event's ordinal in its file or table. tests/agent-rollup.test.ts runs one
-- stream through both copies; they must agree to the second.
-- Booked to the local day of the event that ENDS the gap (plan R5), so a session
-- across midnight splits by day. Claude keeps booking to its start day.
DROP TABLE IF EXISTS _ag_gap;
CREATE TEMP TABLE _ag_gap AS
WITH ev AS (
  SELECT e.source, e.canonical_id, e.project_key, e.ts, e.evt, e.source_record_id,
         e.ts - LAG(e.ts) OVER (PARTITION BY e.canonical_id ORDER BY e.ts, e.seq, e.source_record_id) AS gap,
         MAX(CASE WHEN e.evt = 'prompt' THEN e.ts ELSE 0 END)
           OVER (PARTITION BY e.canonical_id ORDER BY e.ts, e.seq, e.source_record_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS last_work,
         MAX(CASE WHEN e.evt IN ('stop','session_start') THEN e.ts ELSE 0 END)
           OVER (PARTITION BY e.canonical_id ORDER BY e.ts, e.seq, e.source_record_id
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS last_idle
  FROM _ag_ev e
)
SELECT ev.source, ev.canonical_id, ev.project_key, ev.ts,
       strftime('%Y-%m-%d', ev.ts, 'unixepoch', 'localtime') AS day,
       CASE WHEN gap IS NULL                              THEN 0
            WHEN evt IN ('session_start','session_end')   THEN 0
            WHEN evt = 'prompt'                           THEN MIN(gap, 300)
            WHEN last_work > last_idle                    THEN MIN(gap, 14400)
            ELSE                                               MIN(gap, 300)
       END AS active_s,
       -- Stage 6: the model at the event that ENDS the gap, else the session's.
       COALESCE(m.model, f.model, '(no model)') AS model
FROM ev
LEFT JOIN _ag_evm m ON ev.source = 'codex' AND m.source_record_id = ev.source_record_id
LEFT JOIN _ag_sfm f ON f.canonical_id = ev.canonical_id;

DROP TABLE IF EXISTS _ag_g;
CREATE TEMP TABLE _ag_g AS
SELECT source, day, project_key, SUM(active_s) AS active_s
FROM _ag_gap GROUP BY source, day, project_key;

-- Sessions count on their START day, by class.
DROP TABLE IF EXISTS _ag_s;
CREATE TEMP TABLE _ag_s AS
SELECT first_source AS source,
       strftime('%Y-%m-%d', started_at, 'unixepoch', 'localtime') AS day,
       project_key,
       SUM(CASE WHEN driven = 1 THEN 1 ELSE 0 END)     AS driven,
       SUM(CASE WHEN driven = 0 THEN 1 ELSE 0 END)     AS automated,
       SUM(CASE WHEN driven IS NULL THEN 1 ELSE 0 END) AS unclassified
FROM _ag_sess WHERE started_at IS NOT NULL
GROUP BY 1, 2, 3;

DROP TABLE IF EXISTS _ag_r;
CREATE TEMP TABLE _ag_r AS
SELECT source, day, project_key, COUNT(*) AS requests,
       COALESCE(SUM(tokens_in), 0)             AS tokens_in,
       COALESCE(SUM(tokens_out), 0)            AS tokens_out,
       COALESCE(SUM(tokens_cache_read), 0)     AS tokens_cache_read,
       COALESCE(SUM(tokens_cache_creation), 0) AS tokens_cache_creation,
       TOTAL(cost_table_usd)                   AS cost_table_usd,
       SUM(CASE WHEN priced = 1 THEN 1 ELSE 0 END) AS priced_requests,
       SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END) AS unpriced_requests,
       TOTAL(own_cost_usd)                     AS own_cost_usd,
       SUM(CASE WHEN source = 'hermes' AND own_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS own_priced_requests,
       SUM(CASE WHEN source = 'hermes' AND own_cost_usd IS NULL     THEN 1 ELSE 0 END) AS own_unpriced_requests
FROM _ag_rm GROUP BY source, day, project_key;

DROP TABLE IF EXISTS _ag_keys;
CREATE TEMP TABLE _ag_keys AS
  SELECT source, day, project_key FROM _ag_g
  UNION SELECT source, day, project_key FROM _ag_s
  UNION SELECT source, day, project_key FROM _ag_r;

-- Column order is load-bearing: the write phase copies this with SELECT *.
DROP TABLE IF EXISTS _ag_daily;
CREATE TEMP TABLE _ag_daily AS
SELECT k.source, k.day, k.project_key,
       g.active_s,
       COALESCE(s.driven, 0), COALESCE(s.automated, 0), COALESCE(s.unclassified, 0),
       COALESCE(r.requests, 0),
       COALESCE(r.tokens_in, 0), COALESCE(r.tokens_out, 0),
       COALESCE(r.tokens_cache_read, 0), COALESCE(r.tokens_cache_creation, 0),
       COALESCE(r.cost_table_usd, 0), COALESCE(r.priced_requests, 0), COALESCE(r.unpriced_requests, 0),
       COALESCE(r.own_cost_usd, 0), COALESCE(r.own_priced_requests, 0), COALESCE(r.own_unpriced_requests, 0)
FROM _ag_keys k
LEFT JOIN _ag_g g ON g.source = k.source AND g.day = k.day AND g.project_key = k.project_key
LEFT JOIN _ag_s s ON s.source = k.source AND s.day = k.day AND s.project_key = k.project_key
LEFT JOIN _ag_r r ON r.source = k.source AND r.day = k.day AND r.project_key = k.project_key
ORDER BY k.source, k.day, k.project_key;

-- OSRS: the XP needed for each level, xp(L) = floor(1/4 * sum_{l=1}^{L-1}
-- floor(l + 300 * 2^(l/7))) to 99. Stage 10 (spec 4.6): past 99 each level is
-- 250 hours, xp(99+n) = (9000000 + 900000n) * 13034431 / 9000000 (integer
-- division), so level 99+n is reached at exactly 2,500 + 250n hours, up to 200.
-- tests/agent-rollup.test.ts recomputes all 200.
DROP TABLE IF EXISTS _ag_xp;
CREATE TEMP TABLE _ag_xp (level INTEGER PRIMARY KEY, xp INTEGER NOT NULL);
INSERT INTO _ag_xp (level, xp) VALUES
(1,0),(2,83),(3,174),(4,276),(5,388),(6,512),(7,650),(8,801),(9,969),(10,1154),
(11,1358),(12,1584),(13,1833),(14,2107),(15,2411),(16,2746),(17,3115),(18,3523),(19,3973),(20,4470),
(21,5018),(22,5624),(23,6291),(24,7028),(25,7842),(26,8740),(27,9730),(28,10824),(29,12031),(30,13363),
(31,14833),(32,16456),(33,18247),(34,20224),(35,22406),(36,24815),(37,27473),(38,30408),(39,33648),(40,37224),
(41,41171),(42,45529),(43,50339),(44,55649),(45,61512),(46,67983),(47,75127),(48,83014),(49,91721),(50,101333),
(51,111945),(52,123660),(53,136594),(54,150872),(55,166636),(56,184040),(57,203254),(58,224466),(59,247886),(60,273742),
(61,302288),(62,333804),(63,368599),(64,407015),(65,449428),(66,496254),(67,547953),(68,605032),(69,668051),(70,737627),
(71,814445),(72,899257),(73,992895),(74,1096278),(75,1210421),(76,1336443),(77,1475581),(78,1629200),(79,1798808),(80,1986068),
(81,2192818),(82,2421087),(83,2673114),(84,2951373),(85,3258594),(86,3597792),(87,3972294),(88,4385776),(89,4842295),(90,5346332),
(91,5902831),(92,6517253),(93,7195629),(94,7944614),(95,8771558),(96,9684577),(97,10692629),(98,11805606),(99,13034431)
,(100,14337874),(101,15641317),(102,16944760),(103,18248203),(104,19551646),(105,20855089),(106,22158532),(107,23461975),(108,24765418),(109,26068862),
(110,27372305),(111,28675748),(112,29979191),(113,31282634),(114,32586077),(115,33889520),(116,35192963),(117,36496406),(118,37799849),(119,39103293),
(120,40406736),(121,41710179),(122,43013622),(123,44317065),(124,45620508),(125,46923951),(126,48227394),(127,49530837),(128,50834280),(129,52137724),
(130,53441167),(131,54744610),(132,56048053),(133,57351496),(134,58654939),(135,59958382),(136,61261825),(137,62565268),(138,63868711),(139,65172155),
(140,66475598),(141,67779041),(142,69082484),(143,70385927),(144,71689370),(145,72992813),(146,74296256),(147,75599699),(148,76903142),(149,78206586),
(150,79510029),(151,80813472),(152,82116915),(153,83420358),(154,84723801),(155,86027244),(156,87330687),(157,88634130),(158,89937573),(159,91241017),
(160,92544460),(161,93847903),(162,95151346),(163,96454789),(164,97758232),(165,99061675),(166,100365118),(167,101668561),(168,102972004),(169,104275448),
(170,105578891),(171,106882334),(172,108185777),(173,109489220),(174,110792663),(175,112096106),(176,113399549),(177,114702992),(178,116006435),(179,117309879),
(180,118613322),(181,119916765),(182,121220208),(183,122523651),(184,123827094),(185,125130537),(186,126433980),(187,127737423),(188,129040866),(189,130344310),
(190,131647753),(191,132951196),(192,134254639),(193,135558082),(194,136861525),(195,138164968),(196,139468411),(197,140771854),(198,142075297),(199,143378741),
(200,144682184);

-- Stage 6 (R1): each level's tier, once. _sk_prog and _sk_ups both read it, so
-- the tier boundaries live in this one CASE.
DROP TABLE IF EXISTS _ag_tier;
CREATE TEMP TABLE _ag_tier AS
SELECT level,
       CASE WHEN level >= 200 THEN 'Eternal'
            WHEN level >= 170 THEN 'Mythic'
            WHEN level >= 150 THEN 'Legend'
            WHEN level >= 120 THEN 'Grandmaster'
            WHEN level >= 99  THEN 'Master'
            WHEN level >= 85  THEN 'Pro'
            WHEN level >= 70 THEN 'Advanced'
            WHEN level >= 50 THEN 'Intermediate'
            WHEN level >= 25 THEN 'Builder'
            WHEN level >= 10 THEN 'Apprentice'
            ELSE                  'Noobie'
       END AS tier
FROM _ag_xp;

-- Lifetime driven seconds per tool. Claude's are its own hours, from the
-- daily rollup section 1 just committed (decision 8: unchanged). Codex and
-- Hermes appear only once sync has registered them.
DROP TABLE IF EXISTS _ag_life;
CREATE TEMP TABLE _ag_life AS
SELECT 'claude' AS source, COALESCE(SUM(active_ms), 0) / 1000 AS active_s FROM claude_daily_rollups
UNION ALL
SELECT w.source, COALESCE((SELECT SUM(g.active_s) FROM _ag_gap g WHERE g.source = w.source), 0)
FROM wt_sources w WHERE w.source IN ('codex','hermes');

-- Stage 6 (spec 4.2): driven time per day for every skill -- each tool, its
-- projects and its models, and (Stage 7) Claude's Claude Code skills, their
-- packs and all skill time. Claude's rows copy the rollups section 1 committed.
-- The agents' come from this section's own gaps: _ag_g is exactly what the swap
-- below writes as agent_daily_rollups.active_s, read here because the swap has
-- not happened yet (R2). Milliseconds throughout, so Claude's carry over
-- exactly. Only days with time get a row. Per source and day the project rows
-- and the model rows each sum to the tool row (tests/skill-rollup.test.ts).
DROP TABLE IF EXISTS _sk_daily;
CREATE TEMP TABLE _sk_daily AS
SELECT source, kind, key, day, active_ms FROM (
  SELECT 'claude' AS source, 'tool' AS kind, 'claude' AS key, day, active_ms FROM claude_daily_rollups
  UNION ALL SELECT 'claude', 'project', project_key, day, active_ms FROM claude_project_rollups
  UNION ALL SELECT 'claude', 'model', model, day, active_ms FROM claude_model_rollups
  -- Stage 7 (spec 4.4): each Claude Code skill, each pack through the durable
  -- map (an unresolved skill counts as '(no pack)'), and all skill time as one
  -- 'skill-use' row. Every kind below _sk_daily is generic over (source, kind,
  -- key); _ag_life, _sk_win, _sk_runs and _sk_pace read only kind = 'tool', so
  -- none of this reaches agent_progress, skill_pace or the Total level.
  UNION ALL SELECT 'claude', 'skill', skill, day, active_ms FROM claude_skill_rollups
  UNION ALL SELECT 'claude', 'pack', COALESCE(p.pack, '(no pack)'), r.day, SUM(r.active_ms)
            FROM claude_skill_rollups r LEFT JOIN claude_skill_packs p ON p.skill = r.skill
            GROUP BY COALESCE(p.pack, '(no pack)'), r.day
  UNION ALL SELECT 'claude', 'skill-use', 'all', day, SUM(active_ms) FROM claude_skill_rollups GROUP BY day
  UNION ALL SELECT source, 'tool', source, day, SUM(active_s) * 1000 FROM _ag_g GROUP BY source, day
  UNION ALL SELECT source, 'project', project_key, day, SUM(active_s) * 1000 FROM _ag_g GROUP BY source, project_key, day
  UNION ALL SELECT source, 'model', model, day, SUM(active_s) * 1000 FROM _ag_gap GROUP BY source, model, day
) WHERE active_ms > 0
ORDER BY source, kind, key, day;

-- Spec 4.6: the as-of day (R6) and its windows.
DROP TABLE IF EXISTS _sk_d;
CREATE TEMP TABLE _sk_d AS
SELECT d0, date(d0, '-1 day') AS d1, date(d0, '-6 days') AS d6, date(d0, '-27 days') AS d27 FROM _sk_asof;

-- ============================================================================
-- Stage 10 (spec 4.3-4.4): the six attributes. _at_def maps each discipline to
-- its attribute and is the only place that mapping lives. STR has no
-- disciplines: its Form is output tokens per active hour, every tool pooled.
-- ============================================================================
DROP TABLE IF EXISTS _at_attr;
CREATE TEMP TABLE _at_attr (attribute TEXT PRIMARY KEY, ord INTEGER NOT NULL);
INSERT INTO _at_attr (attribute, ord) VALUES ('str',1),('dex',2),('con',3),('int',4),('wis',5),('cha',6);

DROP TABLE IF EXISTS _at_def;
CREATE TEMP TABLE _at_def (discipline TEXT PRIMARY KEY, attribute TEXT NOT NULL);
INSERT INTO _at_def (discipline, attribute) VALUES
  ('automation','dex'), ('reuse','dex'),
  ('session-hygiene','con'), ('output-quality','con'),
  ('context-hygiene','int'), ('cost-discipline','int'),
  ('verification','wis'), ('model-routing','wis'), ('security','wis'),
  ('prompt-hygiene','cha');

-- Each day's pooled output tokens and active ms, and Claude's own active ms
-- (R5, amended): Claude's tokens from its daily rollup, every tool's hours from
-- its kind = 'tool' row in _sk_daily, and Codex's and Hermes's tokens from
-- _ag_rm over DRIVEN sessions only, joined as _ag_ev joins its events. Their
-- hours are driven-only (decision 3), and a rate must compare like with like:
-- an automated session's output has no hours under it, so counting it would
-- pin STR at 99 for work that earned no XP. agent_daily_rollups (_ag_r) still
-- counts every session's tokens; only STR's numerator is driven-only.
DROP TABLE IF EXISTS _at_day;
CREATE TEMP TABLE _at_day AS
SELECT day, SUM(tokens) AS tokens, SUM(all_ms) AS all_ms, SUM(claude_ms) AS claude_ms FROM (
  SELECT day, tokens_out AS tokens, 0 AS all_ms, 0 AS claude_ms FROM claude_daily_rollups
  UNION ALL SELECT m.day, COALESCE(SUM(m.tokens_out), 0), 0, 0 FROM _ag_rm m
            JOIN _ag_sess s ON s.canonical_id = m.canonical_id AND s.first_source = m.source AND s.driven = 1
            GROUP BY m.day
  UNION ALL SELECT day, 0, active_ms, CASE WHEN source = 'claude' THEN active_ms ELSE 0 END
            FROM _sk_daily WHERE kind = 'tool'
) GROUP BY day;
CREATE UNIQUE INDEX idx_at_day ON _at_day(day);

-- STR's window totals (spec 4.3): '30' on every day with tokens or hours and
-- on the as-of day (R4), '7' on the as-of day only. Under one active hour, no
-- reading; otherwise the rate against 120,000 an hour (2,000 a minute), to 99.
DROP TABLE IF EXISTS _at_str;
CREATE TEMP TABLE _at_str AS
SELECT win, day, tokens, active_ms,
       CASE WHEN active_ms >= 3600000 THEN tokens * 3600000.0 / active_ms END AS rate,
       CASE WHEN active_ms >= 3600000
            THEN CAST(round(99 * MIN(1.0, tokens * 3600000.0 / active_ms / 120000.0)) AS INTEGER) END AS form
FROM (
  SELECT '30' AS win, d.day, COALESCE(SUM(x.tokens), 0) AS tokens, COALESCE(SUM(x.all_ms), 0) AS active_ms
  FROM (SELECT day FROM _at_day UNION SELECT d0 FROM _sk_d) d
  LEFT JOIN _at_day x ON x.day BETWEEN date(d.day, '-29 day') AND d.day
  GROUP BY d.day
  UNION ALL
  SELECT '7', d.d0, COALESCE(SUM(x.tokens), 0), COALESCE(SUM(x.all_ms), 0)
  FROM _sk_d d LEFT JOIN _at_day x ON x.day BETWEEN date(d.d0, '-6 day') AND d.d0
  GROUP BY d.d0
);

-- Every Form, 0-99 (spec 4.3); no row is no reading. A Claude attribute
-- averages its MEASURED disciplines' scores on the day: needs-data is left
-- out, never counted as 0, and a gated day has no rows at all.
DROP TABLE IF EXISTS _at_form;
CREATE TEMP TABLE _at_form AS
SELECT s.win, d.attribute, s.day, CAST(round(AVG(s.score) * 99.0 / 60) AS INTEGER) AS form
FROM (SELECT '30' AS win, day, discipline, score, status FROM claude_discipline_scores
      UNION ALL SELECT '7', day, discipline, score, status FROM claude_discipline_scores_7d) s
JOIN _at_def d ON d.discipline = s.discipline
WHERE s.status <> 'needs-data'
GROUP BY s.win, d.attribute, s.day
UNION ALL
SELECT win, 'str', day, form FROM _at_str WHERE form IS NOT NULL;
CREATE UNIQUE INDEX idx_at_form ON _at_form(win, attribute, day);

-- Spec 4.4: each day trains each attribute at that day's own 30-day Form, the
-- day's hours x Form / 99 (integer division). STR trains on every tool's
-- hours, the rest on Claude's. No Form, or nothing earned, is no row, so from
-- here Stage 6's keyed pipeline levels attributes like any other skill.
-- _ag_life, _sk_win, _sk_runs and _sk_pace read only kind = 'tool', and _ac_*
-- names its kinds, so none of this reaches agent_progress, pace, streaks,
-- achievements or the Total level.
INSERT INTO _sk_daily (source, kind, key, day, active_ms)
SELECT 'character', 'attribute', attribute, day, ms FROM (
  SELECT f.attribute, f.day,
         CASE WHEN f.attribute = 'str' THEN d.all_ms ELSE d.claude_ms END * f.form / 99 AS ms
  FROM _at_form f JOIN _at_day d ON d.day = f.day
  WHERE f.win = '30'
) WHERE ms > 0
ORDER BY attribute, day;

-- Lifetime seconds per skill. The tool rows are _ag_life's, unchanged from
-- Stage 5, so agent_progress cannot move (R4): a registered tool with no
-- seconds keeps its row, with no level. Every other skill exists once it has time.
DROP TABLE IF EXISTS _sk_life;
CREATE TEMP TABLE _sk_life AS
SELECT source, 'tool' AS kind, source AS key, active_s FROM _ag_life
UNION ALL
SELECT source, kind, key, SUM(active_ms) / 1000 FROM _sk_daily WHERE kind <> 'tool' GROUP BY source, kind, key;

-- Spec 4.4 (Stage 5's 4.4, keyed). XP = active_s * 13,034,431 / 9,000,000
-- (integer division: 2,500 h is exactly 99). Level is the highest L with
-- xp(L) <= XP, and NULL with no driven seconds. s_to_next is the integer
-- ceiling of the seconds that reach xp(L+1), NULL only at 200. Stars: one per
-- 900,000 s (250 h) past 99,900,000 s (Lv 200), floored.
DROP TABLE IF EXISTS _sk_prog;
CREATE TEMP TABLE _sk_prog AS
WITH x AS (
  SELECT source, kind, key, active_s, active_s * 13034431 / 9000000 AS xp FROM _sk_life
), l AS (
  SELECT x.source, x.kind, x.key, x.active_s, x.xp,
         CASE WHEN x.active_s > 0 THEN (SELECT MAX(t.level) FROM _ag_xp t WHERE t.xp <= x.xp) END AS level
  FROM x
), span AS (
  SELECT source, kind, key, MIN(day) AS first_day, MAX(day) AS last_day
  FROM _sk_daily GROUP BY source, kind, key
)
SELECT l.source, l.kind, l.key, l.active_s, l.xp, l.level, tr.tier,
       l.xp - cur.xp AS xp_into_level,
       nxt.xp - l.xp AS xp_to_next,
       (nxt.xp * 9000000 + 13034430) / 13034431 - l.active_s AS s_to_next,
       CASE WHEN l.level IS NULL          THEN NULL
            WHEN l.active_s >= 99900000   THEN (l.active_s - 99900000) / 900000
            ELSE                               0
       END AS stars,
       sp.first_day, sp.last_day
FROM l
LEFT JOIN _ag_xp cur  ON cur.level = l.level
LEFT JOIN _ag_xp nxt  ON nxt.level = l.level + 1
LEFT JOIN _ag_tier tr ON tr.level = l.level
LEFT JOIN span sp     ON sp.source = l.source AND sp.kind = l.kind AND sp.key = l.key
ORDER BY l.source, l.kind, l.key;

-- agent_progress, unchanged in every column: the keyed pipeline's tool rows.
DROP TABLE IF EXISTS _ag_prog;
CREATE TEMP TABLE _ag_prog AS
SELECT source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars
FROM _sk_prog WHERE kind = 'tool' ORDER BY source;

-- skill_progress: every skill with time. No seconds, no row -- never Lv 1.
DROP TABLE IF EXISTS _sk_progress;
CREATE TEMP TABLE _sk_progress AS
SELECT source, kind, key, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars,
       first_day, last_day
FROM _sk_prog WHERE active_s > 0 ORDER BY source, kind, key;

-- Spec 4.5: the day each level was reached -- the first day whose end-of-day
-- cumulative XP is at least xp(L). A band join: each day claims the levels its
-- XP crossed since the day before, so each level appears once. Lv 1 is never
-- logged; a level whose tier differs from the level below opens a new tier.
-- CROSS JOIN pins b as the outer loop: as a plain JOIN, SQLite scanned the
-- thresholds outside and re-ran b's windows once per level (0.30 s against
-- 0.01 s on the density-270 fixture). Same rows either way.
DROP TABLE IF EXISTS _sk_ups;
CREATE TEMP TABLE _sk_ups AS
WITH c AS (
  SELECT source, kind, key, day,
         (SUM(active_ms) OVER (PARTITION BY source, kind, key ORDER BY day
                               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) / 1000)
           * 13034431 / 9000000 AS xp
  FROM _sk_daily
), b AS (
  SELECT c.*, COALESCE(LAG(xp) OVER (PARTITION BY source, kind, key ORDER BY day), 0) AS prev_xp FROM c
)
SELECT b.source, b.kind, b.key, t.level, b.day, tr.tier,
       CASE WHEN tr.tier <> pr.tier THEN 1 ELSE 0 END AS tier_changed
FROM b
CROSS JOIN _ag_xp t ON t.level >= 2 AND t.xp > b.prev_xp AND t.xp <= b.xp
JOIN _ag_tier tr ON tr.level = t.level
JOIN _ag_tier pr ON pr.level = t.level - 1
ORDER BY b.source, b.kind, b.key, t.level;

-- Spec 4.7: the level caps. Each next cap opens on the first day any stat of
-- any kind reaches the cap below it; ties on a day go to a tool, then by
-- source, kind and key. 99 is always open. A stat at 120 has passed 99, so the
-- caps open in order. A cap is a milestone and a display ceiling: no level is
-- ever held at one.
DROP TABLE IF EXISTS _lc_def;
CREATE TEMP TABLE _lc_def (cap INTEGER PRIMARY KEY, next INTEGER NOT NULL);
INSERT INTO _lc_def (cap, next) VALUES (99,120), (120,150), (150,170), (170,200);

DROP TABLE IF EXISTS _lc;
CREATE TEMP TABLE _lc AS
SELECT cap, reached_level, opened_day, source, kind, key FROM (
  SELECT 99 AS cap, NULL AS reached_level, NULL AS opened_day, NULL AS source, NULL AS kind, NULL AS key
  UNION ALL
  SELECT d.next, u.level, u.day, u.source, u.kind, u.key
  FROM _lc_def d
  JOIN (SELECT level, day, source, kind, key,
               ROW_NUMBER() OVER (PARTITION BY level
                                  ORDER BY day, CASE WHEN kind = 'tool' THEN 0 ELSE 1 END, source, kind, key) AS rn
        FROM _sk_ups WHERE level IN (SELECT cap FROM _lc_def)) u
    ON u.level = d.cap AND u.rn = 1
) ORDER BY cap;

-- XP earned in each window, per tool with a progress row, by the XP rule over
-- the window's seconds. Days after the as-of day are in no window.
DROP TABLE IF EXISTS _sk_win;
CREATE TEMP TABLE _sk_win AS
SELECT t.source,
       (COALESCE(SUM(CASE WHEN s.day = d.d0  THEN s.active_ms END), 0) / 1000) * 13034431 / 9000000 AS xp_today,
       (COALESCE(SUM(CASE WHEN s.day >= d.d6 THEN s.active_ms END), 0) / 1000) * 13034431 / 9000000 AS xp_7d,
       (COALESCE(SUM(s.active_ms), 0) / 1000) * 13034431 / 9000000 AS xp_28d
FROM _ag_life t
CROSS JOIN _sk_d d
LEFT JOIN _sk_daily s ON s.source = t.source AND s.kind = 'tool' AND s.day BETWEEN d.d27 AND d.d0
GROUP BY t.source
ORDER BY t.source;

-- Runs of consecutive active days (any driven time), per tool and for 'all'
-- (any tool), up to the as-of day. Along a run, a day's julian number minus its
-- rank is constant.
DROP TABLE IF EXISTS _sk_runs;
CREATE TEMP TABLE _sk_runs AS
WITH ad AS (
  SELECT source, day FROM _sk_daily, _sk_d WHERE kind = 'tool' AND day <= d0
  UNION
  SELECT 'all', day FROM _sk_daily, _sk_d WHERE kind = 'tool' AND day <= d0
), isl AS (
  SELECT source, day,
         CAST(julianday(day) AS INTEGER) - ROW_NUMBER() OVER (PARTITION BY source ORDER BY day) AS run
  FROM ad
)
SELECT source, MAX(day) AS last_day, COUNT(*) AS days FROM isl GROUP BY source, run;

-- Spec 4.6: one row per tool and one 'all'. Pace is XP per CALENDAR day over
-- 28 days. The ETAs are integer ceilings without a float (R7): x / (xp_28d /
-- 28) rounded up is (x * 28 + xp_28d - 1) / xp_28d. NULL with no pace, at 200
-- and with no level (xp_to_next is NULL in both); 'all' has none. A current
-- streak survives a today with no activity yet: the run ending yesterday counts.
DROP TABLE IF EXISTS _sk_pace;
CREATE TEMP TABLE _sk_pace AS
WITH w AS (
  SELECT source, xp_today, xp_7d, xp_28d FROM _sk_win
  UNION ALL
  SELECT 'all', COALESCE(SUM(xp_today), 0), COALESCE(SUM(xp_7d), 0), COALESCE(SUM(xp_28d), 0) FROM _sk_win
)
SELECT w.source, d.d0 AS as_of_day, w.xp_today, w.xp_7d, w.xp_28d,
       w.xp_28d / 28.0 AS pace_xp_per_day,
       CASE WHEN w.source = 'all' OR w.xp_28d = 0 OR p.xp_to_next IS NULL THEN NULL
            ELSE (p.xp_to_next * 28 + w.xp_28d - 1) / w.xp_28d END AS eta_next_days,
       -- Spec 4.6: the 99 ETA keeps its meaning, NULL at 99 and past it (it
       -- would turn negative there); xp_to_next is NULL only at 200 now.
       CASE WHEN w.source = 'all' OR w.xp_28d = 0 OR p.xp_to_next IS NULL OR p.xp >= 13034431 THEN NULL
            ELSE ((13034431 - p.xp) * 28 + w.xp_28d - 1) / w.xp_28d END AS eta_99_days,
       -- Spec 4.8: days to xp(current cap) at the same pace, rounded up alike.
       CASE WHEN w.source = 'all' OR w.xp_28d = 0 OR p.xp_to_next IS NULL OR p.xp >= c.xp THEN NULL
            ELSE ((c.xp - p.xp) * 28 + w.xp_28d - 1) / w.xp_28d END AS eta_cap_days,
       COALESCE((SELECT r.days FROM _sk_runs r WHERE r.source = w.source AND r.last_day = d.d0),
                (SELECT r.days FROM _sk_runs r WHERE r.source = w.source AND r.last_day = d.d1),
                0) AS streak_current,
       COALESCE((SELECT MAX(r.days) FROM _sk_runs r WHERE r.source = w.source), 0) AS streak_best
FROM w
CROSS JOIN _sk_d d
LEFT JOIN _sk_prog p ON p.source = w.source AND p.kind = 'tool'
LEFT JOIN _ag_xp c ON c.level = (SELECT MAX(cap) FROM _lc)
ORDER BY CASE w.source WHEN 'all' THEN 1 ELSE 0 END, w.source;

-- Spec 4.5: the sheet, as of the as-of day. The boost is this week against the
-- month, a level per 5 Form points (round halves away from zero), clamped to
-- ten; with either Form unmeasured there is no boost, never a drain. Now is
-- Base plus the boost, floored at 1, and may pass the cap. Evidence: each
-- constituent's 30-day score on the day (null when needs-data or gated) --
-- the page matches quests through these keys -- or STR's two rates.
DROP TABLE IF EXISTS _at_sheet;
CREATE TEMP TABLE _at_sheet AS
SELECT attribute, ord, as_of_day, form_30, form_7, boost, base_level,
       CASE WHEN base_level IS NOT NULL THEN MAX(1, base_level + COALESCE(boost, 0)) END AS now_level,
       evidence_json
FROM (
  SELECT a.attribute, a.ord, d.d0 AS as_of_day, f30.form AS form_30, f7.form AS form_7,
         CASE WHEN f30.form IS NOT NULL AND f7.form IS NOT NULL
              THEN MIN(10, MAX(-10, CAST(round((f7.form - f30.form) / 5.0) AS INTEGER))) END AS boost,
         p.level AS base_level,
         CASE WHEN a.attribute = 'str'
              THEN json_object(
                     'per_hour_30', (SELECT CAST(round(rate) AS INTEGER) FROM _at_str WHERE win = '30' AND day = d.d0),
                     'per_hour_7',  (SELECT CAST(round(rate) AS INTEGER) FROM _at_str WHERE win = '7'  AND day = d.d0))
              ELSE (SELECT json_group_object(x.discipline, CASE WHEN s.status <> 'needs-data' THEN s.score END)
                    FROM _at_def x
                    LEFT JOIN claude_discipline_scores s ON s.day = d.d0 AND s.discipline = x.discipline
                    WHERE x.attribute = a.attribute)
         END AS evidence_json
  FROM _at_attr a
  CROSS JOIN _sk_d d
  LEFT JOIN _at_form f30 ON f30.win = '30' AND f30.attribute = a.attribute AND f30.day = d.d0
  LEFT JOIN _at_form f7  ON f7.win  = '7'  AND f7.attribute  = a.attribute AND f7.day  = d.d0
  LEFT JOIN _sk_prog p   ON p.source = 'character' AND p.kind = 'attribute' AND p.key = a.attribute
)
ORDER BY ord;

-- ============================================================================
-- Stage 8 (spec 4.5-4.6): achievements and the two point totals. Every value
-- and every date comes from a table this section already built, or one an
-- earlier section committed (claude_daily_rollups, claude_discipline_scores,
-- claude_quests). No level or streak rule is restated here.
-- ============================================================================

-- The catalogue: each achievement's four thresholds, the only place they live.
-- per_tool = 1: one row for every tool with an agent_progress row; 0: Claude's alone.
DROP TABLE IF EXISTS _ac_def;
CREATE TEMP TABLE _ac_def (achievement TEXT NOT NULL, per_tool INTEGER NOT NULL, tier INTEGER NOT NULL,
  threshold INTEGER NOT NULL, PRIMARY KEY (achievement, tier));
INSERT INTO _ac_def (achievement, per_tool, tier, threshold) VALUES
  ('seasoned', 1, 1, 50), ('seasoned', 1, 2, 70), ('seasoned', 1, 3, 90), ('seasoned', 1, 4, 99),
  ('daily-habit', 1, 1, 7), ('daily-habit', 1, 2, 30), ('daily-habit', 1, 3, 100), ('daily-habit', 1, 4, 365),
  ('regular', 1, 1, 10), ('regular', 1, 2, 100), ('regular', 1, 3, 1000), ('regular', 1, 4, 5000),
  ('wordsmith', 1, 1, 1000000), ('wordsmith', 1, 2, 10000000), ('wordsmith', 1, 3, 100000000), ('wordsmith', 1, 4, 1000000000),
  ('explorer', 1, 1, 3), ('explorer', 1, 2, 10), ('explorer', 1, 3, 25), ('explorer', 1, 4, 50),
  ('skill-collector', 0, 1, 5), ('skill-collector', 0, 2, 15), ('skill-collector', 0, 3, 30), ('skill-collector', 0, 4, 50),
  ('skill-master', 0, 1, 50), ('skill-master', 0, 2, 70), ('skill-master', 0, 3, 90), ('skill-master', 0, 4, 99),
  ('pack-master', 0, 1, 50), ('pack-master', 0, 2, 70), ('pack-master', 0, 3, 90), ('pack-master', 0, 4, 99),
  ('skill-user', 0, 1, 50), ('skill-user', 0, 2, 70), ('skill-user', 0, 3, 90), ('skill-user', 0, 4, 99),
  ('all-rounder', 0, 1, 4), ('all-rounder', 0, 2, 6), ('all-rounder', 0, 3, 8), ('all-rounder', 0, 4, 10),
  ('quester', 0, 1, 10), ('quester', 0, 2, 50), ('quester', 0, 3, 150), ('quester', 0, 4, 300),
  ('perfect-week', 0, 1, 1), ('perfect-week', 0, 2, 5), ('perfect-week', 0, 3, 20), ('perfect-week', 0, 4, 52);

-- Running totals by day. Sessions and output tokens: Claude's from its daily
-- rollup (sessions by start day), Codex's and Hermes's from _ag_s and _ag_r,
-- exactly what the swap below writes as agent_daily_rollups. Quest Points and
-- perfect weeks: by each week's Sunday.
DROP TABLE IF EXISTS _ac_cum;
CREATE TEMP TABLE _ac_cum AS
WITH x AS (
  SELECT 'regular' AS achievement, 'claude' AS source, day, sessions_count AS n FROM claude_daily_rollups
  UNION ALL SELECT 'regular', source, day, SUM(driven) FROM _ag_s GROUP BY source, day
  UNION ALL SELECT 'wordsmith', 'claude', day, tokens_out FROM claude_daily_rollups
  UNION ALL SELECT 'wordsmith', source, day, SUM(tokens_out) FROM _ag_r GROUP BY source, day
  UNION ALL SELECT 'quester', 'claude', week_end, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)
            FROM claude_quests GROUP BY week, week_end
  UNION ALL SELECT 'perfect-week', 'claude', week_end,
            CASE WHEN SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) = COUNT(*) THEN 1 ELSE 0 END
            FROM claude_quests GROUP BY week, week_end
)
SELECT achievement, source, day,
       SUM(n) OVER (PARTITION BY achievement, source ORDER BY day
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total
FROM x;

-- Things counted by when each first appeared: projects with time per tool
-- ((unfiled) and (excluded) are buckets, not projects), and Claude Code
-- skills with time. n is each one's place in that order.
DROP TABLE IF EXISTS _ac_first;
CREATE TEMP TABLE _ac_first AS
SELECT achievement, source, first_day AS day,
       ROW_NUMBER() OVER (PARTITION BY achievement, source ORDER BY first_day, key) AS n
FROM (SELECT 'explorer' AS achievement, source, key, MIN(day) AS first_day FROM _sk_daily
      WHERE kind = 'project' AND key NOT IN ('(unfiled)', '(excluded)') GROUP BY source, key
      UNION ALL
      SELECT 'skill-collector', source, key, MIN(day) FROM _sk_daily
      WHERE source = 'claude' AND kind = 'skill' GROUP BY source, key);

-- The disciplines strong on each scored day.
DROP TABLE IF EXISTS _ac_strong;
CREATE TEMP TABLE _ac_strong AS
SELECT day, COUNT(*) AS n FROM claude_discipline_scores WHERE status = 'strong' GROUP BY day;

-- Each achievement's current value. A level is NULL with no level; a count or
-- a sum is a real number, 0 included.
DROP TABLE IF EXISTS _ac_val;
CREATE TEMP TABLE _ac_val AS
SELECT 'seasoned' AS achievement, l.source, p.level AS value
FROM _ag_life l LEFT JOIN _sk_prog p ON p.source = l.source AND p.kind = 'tool'
UNION ALL
SELECT 'daily-habit', l.source, COALESCE((SELECT MAX(r.days) FROM _sk_runs r WHERE r.source = l.source), 0)
FROM _ag_life l
UNION ALL
SELECT a.achievement, l.source,
       COALESCE((SELECT MAX(c.total) FROM _ac_cum c WHERE c.achievement = a.achievement AND c.source = l.source), 0)
FROM _ag_life l CROSS JOIN (SELECT 'regular' AS achievement UNION ALL SELECT 'wordsmith') a
UNION ALL
SELECT 'explorer', l.source, (SELECT COUNT(*) FROM _ac_first f WHERE f.achievement = 'explorer' AND f.source = l.source)
FROM _ag_life l
UNION ALL SELECT 'skill-collector', 'claude', (SELECT COUNT(*) FROM _ac_first WHERE achievement = 'skill-collector')
UNION ALL SELECT 'skill-master', 'claude', (SELECT MAX(level) FROM _sk_prog WHERE source = 'claude' AND kind = 'skill')
UNION ALL SELECT 'pack-master', 'claude',
          (SELECT MAX(level) FROM _sk_prog WHERE source = 'claude' AND kind = 'pack' AND key <> '(no pack)')
UNION ALL SELECT 'skill-user', 'claude', (SELECT level FROM _sk_prog WHERE source = 'claude' AND kind = 'skill-use')
UNION ALL SELECT 'all-rounder', 'claude', COALESCE((SELECT MAX(n) FROM _ac_strong), 0)
UNION ALL
SELECT a.achievement, 'claude', COALESCE((SELECT MAX(c.total) FROM _ac_cum c WHERE c.achievement = a.achievement), 0)
FROM (SELECT 'quester' AS achievement UNION ALL SELECT 'perfect-week') a;

-- The day each tier was reached: the first day history met its threshold.
DROP TABLE IF EXISTS _ac_reach;
CREATE TEMP TABLE _ac_reach AS
-- a level: its day in the level-up log above (the earliest, over skills or packs)
SELECT d.achievement, u.source, d.tier, MIN(u.day) AS day
FROM _ac_def d
JOIN _sk_ups u ON u.level = d.threshold
 AND ((d.achievement = 'seasoned'     AND u.kind = 'tool')
   OR (d.achievement = 'skill-master' AND u.kind = 'skill')
   OR (d.achievement = 'pack-master'  AND u.kind = 'pack' AND u.key <> '(no pack)')
   OR (d.achievement = 'skill-user'   AND u.kind = 'skill-use'))
GROUP BY d.achievement, u.source, d.tier
UNION ALL
-- a streak: the day the first run long enough reached it
SELECT 'daily-habit', r.source, d.tier, MIN(date(r.last_day, '-' || (r.days - d.threshold) || ' days'))
FROM _ac_def d JOIN _sk_runs r ON r.days >= d.threshold AND r.source <> 'all'
WHERE d.achievement = 'daily-habit'
GROUP BY r.source, d.tier
UNION ALL
-- a running total: the first day it met the threshold
SELECT d.achievement, c.source, d.tier, MIN(c.day)
FROM _ac_def d JOIN _ac_cum c ON c.achievement = d.achievement AND c.total >= d.threshold
GROUP BY d.achievement, c.source, d.tier
UNION ALL
-- a count of firsts: the day the N-th arrived
SELECT d.achievement, f.source, d.tier, f.day
FROM _ac_def d JOIN _ac_first f ON f.achievement = d.achievement AND f.n = d.threshold
UNION ALL
-- disciplines strong on one day: the first day with at least N
SELECT 'all-rounder', 'claude', d.tier, MIN(s.day)
FROM _ac_def d JOIN _ac_strong s ON s.n >= d.threshold
WHERE d.achievement = 'all-rounder'
GROUP BY d.tier;

-- One row per achievement, tool and tier, in catalogue order. A tier's points
-- are its number (1 bronze .. 4 platinum) once unlocked.
DROP TABLE IF EXISTS _ac_tiers;
CREATE TEMP TABLE _ac_tiers AS
SELECT d.achievement, l.source, d.tier, d.threshold, v.value, r.day AS unlocked_day,
       CASE WHEN r.day IS NOT NULL THEN d.tier ELSE 0 END AS points
FROM _ac_def d
JOIN _ag_life l ON d.per_tool = 1 OR l.source = 'claude'
LEFT JOIN _ac_val v   ON v.achievement = d.achievement AND v.source = l.source
LEFT JOIN _ac_reach r ON r.achievement = d.achievement AND r.source = l.source AND r.tier = d.tier
ORDER BY d.rowid, l.source;

-- Quest Points (quests done) and Achievement Points (unlocked tiers' points).
DROP TABLE IF EXISTS _ac_points;
CREATE TEMP TABLE _ac_points AS
SELECT (SELECT COUNT(*) FROM claude_quests WHERE status = 'done') AS qp,
       (SELECT COALESCE(SUM(points), 0) FROM _ac_tiers) AS ap;

-- End of the READ phase: everything above wrote only the TEMP schema.
COMMIT;

-- The WRITE phase: copy the staged rows across, in their staged order.
-- agent_prices only once an agent source has synced, so an unsynced database
-- holds Claude's agent_progress row and nothing else (spec 4.1).
BEGIN IMMEDIATE;
DELETE FROM agent_prices;
INSERT INTO agent_prices (model, effective_from, input, cached_input, output, verified_on, source)
SELECT model, effective_from, input, cached_input, output, verified_on, source FROM _ag_prices
WHERE EXISTS (SELECT 1 FROM wt_sources WHERE source IN ('codex','hermes'))
ORDER BY rowid;
DELETE FROM agent_request_metrics;
INSERT INTO agent_request_metrics (source, source_record_id, canonical_id, day, project_key, model,
  priced, price_note, cost_table_usd, own_cost_usd)
SELECT source, source_record_id, canonical_id, day, project_key, model,
       priced, price_note, cost_table_usd, own_cost_usd FROM _ag_rm ORDER BY rowid;
DELETE FROM agent_daily_rollups;
INSERT INTO agent_daily_rollups (source, day, project_key, active_s,
  sessions_driven, sessions_automated, sessions_unclassified, requests,
  tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation,
  cost_table_usd, priced_requests, unpriced_requests,
  own_cost_usd, own_priced_requests, own_unpriced_requests, updated_at)
SELECT *, CAST(strftime('%s','now') AS INTEGER) FROM _ag_daily ORDER BY rowid;
DELETE FROM agent_progress;
INSERT INTO agent_progress (source, active_s, xp, level, tier, xp_into_level, xp_to_next,
  s_to_next, stars, updated_at)
SELECT source, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars,
       CAST(strftime('%s','now') AS INTEGER) FROM _ag_prog ORDER BY rowid;
DELETE FROM skill_daily;
INSERT INTO skill_daily (source, kind, key, day, active_ms)
SELECT source, kind, key, day, active_ms FROM _sk_daily ORDER BY rowid;
DELETE FROM skill_progress;
INSERT INTO skill_progress (source, kind, key, active_s, xp, level, tier, xp_into_level, xp_to_next,
  s_to_next, stars, first_day, last_day, updated_at)
SELECT source, kind, key, active_s, xp, level, tier, xp_into_level, xp_to_next, s_to_next, stars,
       first_day, last_day, CAST(strftime('%s','now') AS INTEGER) FROM _sk_progress ORDER BY rowid;
DELETE FROM skill_level_ups;
INSERT INTO skill_level_ups (source, kind, key, level, day, tier, tier_changed)
SELECT source, kind, key, level, day, tier, tier_changed FROM _sk_ups ORDER BY rowid;
DELETE FROM skill_pace;
INSERT INTO skill_pace (source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_day, eta_next_days,
  eta_99_days, eta_cap_days, streak_current, streak_best)
SELECT source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_day, eta_next_days, eta_99_days,
       eta_cap_days, streak_current, streak_best FROM _sk_pace ORDER BY rowid;
DELETE FROM achievement_tiers;
INSERT INTO achievement_tiers (achievement, source, tier, threshold, value, unlocked_day, points, updated_at)
SELECT achievement, source, tier, threshold, value, unlocked_day, points,
       CAST(strftime('%s','now') AS INTEGER) FROM _ac_tiers ORDER BY rowid;
DELETE FROM character_points;
INSERT INTO character_points (qp, ap, updated_at)
SELECT qp, ap, CAST(strftime('%s','now') AS INTEGER) FROM _ac_points ORDER BY rowid;
DELETE FROM character_attributes;
INSERT INTO character_attributes (attribute, ord, as_of_day, form_30, form_7, boost, base_level, now_level, evidence_json)
SELECT attribute, ord, as_of_day, form_30, form_7, boost, base_level, now_level, evidence_json FROM _at_sheet ORDER BY rowid;
DELETE FROM level_caps;
INSERT INTO level_caps (cap, reached_level, opened_day, source, kind, key)
SELECT cap, reached_level, opened_day, source, kind, key FROM _lc ORDER BY rowid;
COMMIT;
SQL
} | sqlite3 -cmd ".bail on" -cmd ".timeout 8000" "$DB" 2>/dev/null || { [ "$QUIET" -eq 1 ] || echo "cc-rollup: agent rebuild failed" >&2; exit 1; }

# ---- summary ---------------------------------------------------------------
if [ "$QUIET" -eq 0 ]; then
  today="$(date +%Y-%m-%d)"
  printf 'Rank: %s  (%.1fh active, %.1fh window, %s sessions)\n' "$rank" "$AH" "$TH" "$NSESS"
  sqlite3 -cmd ".timeout 8000" "$DB" -column -header "SELECT day,
    printf('%.2f', total_session_ms/3600000.0) AS window,
    printf('%.2f', active_ms/3600000.0)       AS active,
    sessions_count AS sess, compacts, clears, subagents,
    printf('%.0f', hygiene_score) AS hygiene
    FROM claude_daily_rollups WHERE day='$today';" 2>/dev/null
fi
