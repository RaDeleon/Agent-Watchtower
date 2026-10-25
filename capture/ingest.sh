#!/usr/bin/env bash
# ingest.sh — per-request token usage and timing, tool calls, slash commands
# and turn boundaries from Claude Code transcripts.
#
# Installed as ~/.claude/watchtower-ingest.sh and chained on SessionEnd BEFORE
# the rollup, so the rollup sees this session's requests in the same run that
# records its end.
#
# WHY THIS EXISTS: snapshot.sh can only see .context_window.current_usage --
# context-window OCCUPANCY, not cumulative usage -- so every token figure
# derived from snapshots is wrong by 63-201x. The transcripts carry the real
# per-request usage, plus cwd, branch, effort and skill/MCP attribution, and
# they are historical. No proxy required.
#
# THE ONE RULE THAT MUST NOT MOVE: the upsert takes MAX per token field.
# 47% of transcript usage rows repeat a requestId already seen, and 2,115 of
# them carry monotonically GROWING output_tokens because streaming writes
# partials -- so first-seen-wins UNDERCOUNTS. MAX is order-independent,
# commutative and idempotent, which is what makes the cursor advisory: drop
# claude_ingest_cursor and the next run converges on identical numbers.
#
# STAGE 4A (schema v5) added two more DURABLE tables, filled from the SAME
# single pass over each transcript file:
#   - claude_tool_calls: one row per tool_use id, built from BOTH the
#     tool_use block (name, mcp_server, is_sidechain) and its tool_result
#     block (is_error) -- which routinely land in SEPARATE ingest runs,
#     because the result is only written once the tool finishes. The upsert
#     below is idempotent, and order-independent for ts, is_sidechain,
#     is_error and tool_name: MIN for ts/is_sidechain, a NULL-aware MAX for
#     is_error (NULL only while neither side has ever seen a tool_result),
#     and one name per tool_use. Its other COALESCE fields keep the FIRST
#     non-NULL arrival, which is order-dependent -- 157 live ids carry
#     sessionIds that differ across files -- and no number reads them.
#   - claude_slash_commands: one row per slash-command transcript entry
#     (e.g. "/compact"). A slash command is a fact about ONE line, never
#     revised, so INSERT OR IGNORE on entry_uuid is enough -- there is
#     nothing to merge across runs.
# Both tables are durable, like claude_requests: transcripts are deleted
# after cleanupPeriodDays, and a rebuild-from-filesystem design would zero
# this history the day cleanup ran.
#
# STAGE 4B (schema v6) times every request and marks every turn, still from
# the same single pass:
#   - claude_requests gains first_ms/last_ms (each partial's ms timestamp,
#     NULL-aware MIN/MAX), the cache-write split and speed (NULL-aware MAX;
#     NULL means "not recorded", never 0), and sent_ms: the ms of the
#     type=="user" entry before the request in its file. That needs CARRIED
#     STATE -- the jq pass walks each file in order holding the latest user
#     entry's ms, and hands it at EOF to the cursor (last_user_ms), where a
#     resumed read picks it up. Delete the cursor and the full re-read reaches
#     the same value, so the cursor stays advisory.
#   - sent_ms merges by a NULL-aware MIN, and that is right even when one
#     request's partials span two runs: the earliest partial always sees the
#     user entry that actually preceded the request, and a later partial can
#     only see that entry or a later one (a tool result written mid-stream, or
#     the cursor's value). A file that starts mid-turn leaves it NULL.
#   - claude_prompts: one row per turn boundary (a main-thread, non-meta user
#     entry with content and no tool_result), with its kind. DURABLE for the
#     same reason as the two 4A tables. A forked session repeats a boundary
#     under another sessionId, so its session_id follows claude_requests'
#     rule exactly (MAX within a batch, first arrival across batches).
# Files already read to EOF before the upgrade only reach these through one
# --backfill; every merge is a MIN, a MAX or first-arrival, so re-reading is
# harmless.
set -uo pipefail

CC_LIB_PATH="${CC_LIB_PATH:-$HOME/.claude/cc-track-lib.sh}"
# shellcheck source=/dev/null
[ -r "$CC_LIB_PATH" ] && . "$CC_LIB_PATH" || exit 0

QUIET=0
BACKFILL=0
for a in "$@"; do
  case "$a" in
    --quiet)    QUIET=1 ;;
    --backfill) BACKFILL=1 ;;
  esac
done
say() { [ "$QUIET" = 1 ] || printf 'ingest: %s\n' "$*"; }

cc_have_deps || exit 0
cc_init_db

TX_DIR="${WATCHTOWER_TRANSCRIPTS_DIR:-$HOME/.claude/projects}"
[ -d "$TX_DIR" ] || { say "no transcripts at $TX_DIR"; exit 0; }

db="$(cc_db_path)"
work="$(mktemp -d)" || exit 0
trap 'rm -rf "$work"' EXIT
all_tsv="$work/all.tsv"
: > "$all_tsv"
: > "$work/cursors.sql"

# Free-text fields are gsub'd of tabs/newlines/CRs before @tsv, because
# sqlite3's .import in tabs mode does NOT unescape jq's \t and \n. These are
# paths, branch names and identifiers, so collapsing whitespace is lossless in
# practice and deliberate.
#
# -R with `fromjson? // empty` is what makes a corrupt transcript harmless: a
# line that will not parse is dropped and the rest of the file still lands.
# Without it one bad byte aborts jq and the whole file is skipped.
#
# One program, tagged output: each parsed line can yield an R row (the
# request columns), any number of T rows (one per tool_use block in an
# assistant entry), any number of E rows (one per tool_result block, only
# inside a type=="user" entry), at most one S row (a type=="user" entry whose
# string content matches a slash command) and at most one P row (a turn
# boundary, below). All five kinds interleave in file order and are split
# apart afterwards by tag -- there is still exactly ONE read of each
# transcript file per run.
#
# Stage 4B made the program STATEFUL within a file: `foreach` walks the lines
# in order and carries the ms timestamp of the most recent type=="user" entry
# -- prompt, tool result or meta alike -- and each R row reports that carry as
# the request's sent_ms. Each file is one thread (subagents write their own
# files), so the carry never crosses files. A trailing `null` input is the EOF
# sentinel: it emits one C row holding the carry, which becomes the file's
# cursor last_user_ms, and a RESUMED read starts from it (--argjson carry).
# `try rows($p) catch empty` keeps "a corrupt line drops only itself" now that
# one error would otherwise end the whole foreach.
#
# A P row is a turn boundary (spec 3.3): a main-thread (isSidechain not true),
# non-meta type=="user" entry with content and no tool_result block. Its text
# -- the string content, or the first text block of an array -- decides the
# kind by its start. A user entry with no content at all is not a boundary.
# shellcheck disable=SC2016  # a jq program: every $ is jq's, not the shell's
JQ_PROG='
def clean: (. // "") | tostring | gsub("[\t\n\r]"; " ");
def ts2unix: if . == "" then 0 else (sub("\\.[0-9]+"; "") | fromdateiso8601) end;
# ISO -> integer ms: ".123Z" -> 123, ".5Z" -> 500, no fraction -> 000.
def ts2ms: if . == "" then null
  else (sub("\\.[0-9]+"; "") | fromdateiso8601) * 1000
     + ((capture("\\.(?<f>[0-9]+)") | (.f + "00")[0:3] | tonumber) // 0) end;
def opt: if . == null then "" else tostring end;        # NULL -> "" -> NULLIF-ed in SQL
def btext: (if (.message.content | type) == "string" then .message.content
            elif (.message.content | type) == "array"
            then ([.message.content[] | select(type == "object" and .type == "text") | .text][0] // "")
            else "" end) | tostring;
def bkind:
  if startswith("<command-name>") or startswith("<command-message>") then "command"
  elif startswith("<task-notification>") then "notification"
  elif startswith("<local-command-stdout>") or startswith("<local-command-stderr>")
    or startswith("<bash-input>") or startswith("<bash-stdout>") or startswith("<bash-stderr>")
  then "local"
  elif startswith("[Request interrupted") then "interrupt"
  else "prompt" end;
def rows($prev):
  . as $e
  | (
      select($e.message.usage != null and ($e.requestId // "") != "")
      | [ "R",
          $e.requestId,
          ($e.message.id | clean),
          (($e.sessionId // $e.session_id) | clean),
          (($e.timestamp // "") | ts2unix),
          ($e.cwd | clean),
          ($e.gitBranch | clean),
          ($e.message.model | clean),
          ($e.effort | clean),
          ($e.message.usage.service_tier | clean),
          (if $e.isSidechain then 1 else 0 end),
          ($e.entrypoint | clean),
          ($e.version | clean),
          ($e.message.usage.input_tokens // 0),
          ($e.message.usage.output_tokens // 0),
          ($e.message.usage.cache_read_input_tokens // 0),
          ($e.message.usage.cache_creation_input_tokens // 0),
          ($e.attributionSkill | clean),
          ($e.attributionMcpServer | clean),
          ($e.attributionMcpTool | clean),
          ($e.attributionPlugin | clean),
          ($e.apiErrorStatus | clean),
          (($e.timestamp // "") | tostring | ts2ms | opt),        # ms
          ($prev | opt),                                           # sent_ms
          ($e.message.usage.cache_creation.ephemeral_5m_input_tokens | opt),
          ($e.message.usage.cache_creation.ephemeral_1h_input_tokens | opt),
          ($e.message.usage.speed | clean)
        ] | @tsv
    ),
    (
      select($e.type == "assistant")
      | ($e.message.content // []) | (if type == "array" then .[] else empty end)
      | select(.type == "tool_use")
      | [ "T",
          (.id | clean),
          ($e.requestId | clean),
          (($e.sessionId // $e.session_id) | clean),
          (($e.timestamp // "") | ts2unix),
          (.name | clean),
          ((.name | clean) | if startswith("mcp__") then (.[5:] | split("__")[0]) else "" end),
          (if $e.isSidechain then 1 else 0 end)
        ] | @tsv
    ),
    (
      select($e.type == "user")
      | ($e.message.content // []) | (if type == "array" then .[] else empty end)
      | select(.type == "tool_result")
      | [ "E", (.tool_use_id | clean), (if .is_error == true then 1 else 0 end) ] | @tsv
    ),
    (
      select($e.type == "user")
      | select(($e.message.content | type) == "string")
      | select($e.isSidechain != true)
      | ($e.message.content | tostring | match("<command-name>\\s*(/[^<\\s]+)")?) as $m
      | select($m != null)
      | [ "S", ($e.uuid | clean), (($e.sessionId // $e.session_id) | clean),
          (($e.timestamp // "") | ts2unix), ($m.captures[0].string | clean) ] | @tsv
    ),
    (
      select($e.type == "user" and $e.isSidechain != true and $e.isMeta != true
             and $e.message.content != null
             and ((($e.message.content | type) == "array"
                   and any($e.message.content[]; type == "object" and .type == "tool_result")) | not)
             and ($e.uuid // "") != "" and ($e.timestamp // "") != "")
      | [ "P", ($e.uuid | clean), (($e.sessionId // $e.session_id) | clean),
          ($e.timestamp | tostring | ts2ms | opt), ($e | btext | bkind) ] | @tsv
    );
foreach ((inputs | fromjson? // empty | objects), null) as $e
  ( {u: $carry, prev: $carry, e: null};
    .prev = .u | .e = $e
    | if $e != null and $e.type == "user"
      then .u = ((try (($e.timestamp // "") | tostring | ts2ms) catch null) // .u)
      else . end;
    if .e == null then (["C", (.u | opt)] | @tsv)
    else (.prev as $p | .e | try rows($p) catch empty) end )
'

now="$(cc_now)"
files=0
scanned=0

# `find -print0` with `read -r -d ''` keeps paths containing spaces intact.
# Process substitution, NOT a pipe: the loop body runs in THIS shell, so the
# counters below are plain variables and survive the loop. A pipe would put
# the body in a subshell and silently zero them.
while IFS= read -r -d '' f; do
  files=$((files + 1))
  size=$(wc -c < "$f" 2>/dev/null | tr -d ' ') || continue
  # GNU form first, as in snapshot.sh: GNU stat takes `-f %m` as a file-system
  # query and prints a block before failing, which corrupts the captured value.
  mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)

  offset=0
  # The carry a resumed read starts from: the ms of the last user entry BEFORE
  # the offset, saved in the cursor by the run that read up to it. A full read
  # (new file, rewritten file, --backfill) starts from nothing.
  carry=null
  if [ "$BACKFILL" = 0 ]; then
    row="$(cc_sql_val "SELECT bytes_read || '|' || mtime || '|' || COALESCE(last_user_ms,'')
                       FROM claude_ingest_cursor WHERE file_path = $(cc_sqlstr "$f");")"
    if [ -n "$row" ]; then
      prev_bytes="${row%%|*}"; rest="${row#*|}"
      prev_mtime="${rest%%|*}"; prev_user="${rest#*|}"
      # Unchanged: skip entirely. Grown: resume. Shrunk or mtime moved
      # BACKWARDS: the file was rewritten, so re-read it whole.
      if [ "$size" = "$prev_bytes" ] && [ "$mtime" = "$prev_mtime" ]; then
        continue
      elif [ "$size" -gt "$prev_bytes" ] && [ "$mtime" -ge "$prev_mtime" ]; then
        offset="$prev_bytes"
        [[ "$prev_user" =~ ^[0-9]+$ ]] && carry="$prev_user"
      fi
    fi
  fi

  if [ "$offset" -gt 0 ]; then
    tail -c +$((offset + 1)) "$f" 2>/dev/null
  else
    cat "$f" 2>/dev/null
  fi | grep -E '"usage"|"tool_result"|<command-name>|"type":"user"' 2>/dev/null \
    | jq -nRr --argjson carry "$carry" "$JQ_PROG" 2>/dev/null > "$work/one.tsv" || true
  # The C row is the file's EOF carry, bound for its cursor; everything else is
  # a data row. The carry file is emptied first so a file whose jq emitted no C
  # row cannot inherit the previous file's value. jq emits the C row even on
  # empty input, so NO C row means jq failed: awk then exits non-zero. Either
  # way -- a failed jq or a failed awk -- this file's cursor is skipped rather
  # than advanced past rows that never reached all.tsv, the same rule as the
  # split below. The next run re-reads the file, and every merge is idempotent.
  : > "$work/carry"
  awk -F'\t' -v cf="$work/carry" '
    $1=="C" { printf "%s", $2 > cf; c=1; next }
            { print }
    END     { exit !c }' "$work/one.tsv" >> "$all_tsv" || continue
  last_user=""; IFS= read -r last_user < "$work/carry" || true

  scanned=$((scanned + 1))
  printf 'INSERT INTO claude_ingest_cursor(file_path,bytes_read,mtime,updated_at,last_user_ms)
           VALUES(%s,%s,%s,%s,%s)
           ON CONFLICT(file_path) DO UPDATE SET
             bytes_read=excluded.bytes_read, mtime=excluded.mtime,
             updated_at=excluded.updated_at, last_user_ms=excluded.last_user_ms;\n' \
    "$(cc_sqlstr "$f")" "$(cc_sqlnum "$size")" "$(cc_sqlnum "$mtime")" "$now" \
    "$(cc_sqlnum "$last_user")" >> "$work/cursors.sql"
done < <(find "$TX_DIR" -type f -name '*.jsonl' -print0 2>/dev/null)

# This single count covers every destination (R, T/E, S and P rows alike):
# it is taken on the tagged output BEFORE the split below, so a run that
# offered only tool, slash or boundary rows (no new requests) still proceeds.
rows=$(wc -l < "$all_tsv" | tr -d ' ')
if [ "${rows:-0}" -eq 0 ]; then
  say "scanned $files file(s), no new rows"
  # Cursors still advance: a file with no usable rows has still been read.
  [ -s "$work/cursors.sql" ] && sqlite3 -cmd ".timeout 4000" "$db" < "$work/cursors.sql" >/dev/null 2>&1
  exit 0
fi

# Split the tagged stream into four TSVs, tag stripped: rows.tsv (R),
# tools.tsv (T merged with E onto one 8-column layout matching claude_tool_calls
# minus its primary key ordering: tool_use_id, request_id, session_id, ts,
# tool_name, mcp_server, is_error, is_sidechain -- tool_name/mcp_server/
# is_sidechain empty on an E row, is_error empty on a T row), slash.tsv (S)
# and prompts.tsv (P).
rows_tsv="$work/rows.tsv"; tools_tsv="$work/tools.tsv"; slash_tsv="$work/slash.tsv"
prompts_tsv="$work/prompts.tsv"
: > "$rows_tsv"; : > "$tools_tsv"; : > "$slash_tsv"; : > "$prompts_tsv"
awk -F'\t' -v rowsf="$rows_tsv" -v toolsf="$tools_tsv" -v slashf="$slash_tsv" \
    -v promptsf="$prompts_tsv" '
  $1=="R" { line=$0; sub(/^R\t/,"",line); print line > rowsf; next }
  $1=="T" { printf "%s\t%s\t%s\t%s\t%s\t%s\t\t%s\n", $2,$3,$4,$5,$6,$7,$8 > toolsf; next }
  $1=="E" { printf "%s\t\t\t\t\t\t%s\t\n", $2,$3 > toolsf; next }
  $1=="S" { line=$0; sub(/^S\t/,"",line); print line > slashf; next }
  $1=="P" { line=$0; sub(/^P\t/,"",line); print line > promptsf; next }
' "$all_tsv" || exit 0
# ^ A failed split must stop here: the upsert below would import empty or
# partial TSVs and still commit the cursors, losing these lines' rows from
# durable tables until a --backfill. Exiting 0 leaves the cursors where they
# were, so the next run re-reads the lines.

# One transaction: the temp tables, the upserts, then the cursors. A failure
# anywhere rolls the whole thing back and the next run redoes it -- which is
# safe precisely because every upsert here is idempotent.
if ! sqlite3 -cmd ".timeout 4000" "$db" <<SQL >/dev/null 2>&1
.bail on
BEGIN IMMEDIATE;
CREATE TEMP TABLE _incoming (
  request_id TEXT, message_id TEXT, session_id TEXT, ts INTEGER,
  cwd TEXT, git_branch TEXT, model TEXT, effort TEXT, service_tier TEXT,
  is_sidechain INTEGER, entrypoint TEXT, cc_version TEXT,
  tokens_in INTEGER, tokens_out INTEGER,
  tokens_cache_read INTEGER, tokens_cache_creation INTEGER,
  attribution_skill TEXT, attribution_mcp_server TEXT,
  attribution_mcp_tool TEXT, attribution_plugin TEXT, api_error_status TEXT,
  ms TEXT, sent_ms TEXT, cw5 TEXT, cw1 TEXT, speed TEXT
);
.mode tabs
.import "$rows_tsv" _incoming

INSERT INTO claude_requests (
  request_id, message_id, session_id, ts, cwd, git_branch, model, effort,
  service_tier, is_sidechain, entrypoint, cc_version,
  tokens_in, tokens_out, tokens_cache_read, tokens_cache_creation,
  attribution_skill, attribution_mcp_server, attribution_mcp_tool,
  attribution_plugin, api_error_status, ingested_at,
  first_ms, last_ms, sent_ms, cache_write_5m, cache_write_1h, speed)
-- EVERY non-key column below is wrapped in an explicit aggregate, on purpose.
-- This query has 5+ min/max aggregates (the 4 token MAXes plus the
-- is_sidechain MIN), and once a GROUP BY query carries more than one
-- min()/max(), SQLite's bare-column special case ("bare columns take their
-- value from the row that produced the extremum") no longer applies -- ANY
-- bare column here would take an arbitrary row's value within the group, not
-- a chosen one. That is not cosmetic for two of these fields:
--   - ts genuinely DIFFERS across copies of one requestId (the
--     streaming-partials fixture has three different timestamps for the same
--     req_g), and the rollup groups tokens by day(ts) -- an arbitrary ts
--     near a midnight boundary would book the request to an arbitrary day and
--     make re-ingest non-idempotent. MIN(ts) (the instant the request began)
--     is deterministic and stable as later partials arrive.
--   - attribution_* copies can genuinely disagree WITHIN one batch (one copy
--     carries attributionSkill, another does not), and a bare column could
--     silently pick the null copy, losing the attribution before ON CONFLICT
--     ever sees it. MAX(NULLIF(col,'')) ignores NULLs/empties and prefers a
--     real value, deterministically -- the same preference ON CONFLICT's
--     COALESCE already expresses for merges ACROSS batches.
-- Do not "simplify" any of these back to a bare column.
SELECT
  request_id,
  MAX(NULLIF(message_id,'')), MAX(NULLIF(session_id,'')), MIN(ts),
  MAX(NULLIF(cwd,'')), MAX(NULLIF(git_branch,'')), MAX(NULLIF(model,'')),
  MAX(NULLIF(effort,'')),
  MAX(NULLIF(service_tier,'')), MIN(COALESCE(is_sidechain,0)),
  MAX(NULLIF(entrypoint,'')), MAX(NULLIF(cc_version,'')),
  MAX(COALESCE(tokens_in,0)), MAX(COALESCE(tokens_out,0)),
  MAX(COALESCE(tokens_cache_read,0)), MAX(COALESCE(tokens_cache_creation,0)),
  MAX(NULLIF(attribution_skill,'')), MAX(NULLIF(attribution_mcp_server,'')),
  MAX(NULLIF(attribution_mcp_tool,'')), MAX(NULLIF(attribution_plugin,'')),
  MAX(NULLIF(api_error_status,'')), $now,
  MIN(CAST(NULLIF(ms,'') AS INTEGER)), MAX(CAST(NULLIF(ms,'') AS INTEGER)),
  MIN(CAST(NULLIF(sent_ms,'') AS INTEGER)),
  MAX(CAST(NULLIF(cw5,'') AS INTEGER)), MAX(CAST(NULLIF(cw1,'') AS INTEGER)),
  MAX(NULLIF(speed,''))
FROM _incoming
WHERE COALESCE(request_id,'') <> ''
GROUP BY request_id
ON CONFLICT(request_id) DO UPDATE SET
  tokens_in             = MAX(tokens_in,             excluded.tokens_in),
  tokens_out            = MAX(tokens_out,            excluded.tokens_out),
  tokens_cache_read     = MAX(tokens_cache_read,     excluded.tokens_cache_read),
  tokens_cache_creation = MAX(tokens_cache_creation, excluded.tokens_cache_creation),
  is_sidechain          = MIN(is_sidechain,          excluded.is_sidechain),
  attribution_skill      = COALESCE(attribution_skill,      excluded.attribution_skill),
  attribution_mcp_server = COALESCE(attribution_mcp_server, excluded.attribution_mcp_server),
  attribution_mcp_tool   = COALESCE(attribution_mcp_tool,   excluded.attribution_mcp_tool),
  attribution_plugin     = COALESCE(attribution_plugin,     excluded.attribution_plugin),
  api_error_status       = COALESCE(api_error_status,        excluded.api_error_status),
  -- Stage 4B. Scalar MIN/MAX return NULL if either side is NULL, so these
  -- are NULL-aware CASEs, exactly like the claude_tool_calls ts merge below.
  -- NULL means "not recorded" here, never 0, so they must not ride the
  -- tokens' DEFAULT 0 MAX.
  first_ms = CASE WHEN first_ms IS NULL THEN excluded.first_ms
                  WHEN excluded.first_ms IS NULL THEN first_ms ELSE MIN(first_ms, excluded.first_ms) END,
  last_ms  = CASE WHEN last_ms IS NULL THEN excluded.last_ms
                  WHEN excluded.last_ms IS NULL THEN last_ms ELSE MAX(last_ms, excluded.last_ms) END,
  sent_ms  = CASE WHEN sent_ms IS NULL THEN excluded.sent_ms
                  WHEN excluded.sent_ms IS NULL THEN sent_ms ELSE MIN(sent_ms, excluded.sent_ms) END,
  cache_write_5m = CASE WHEN cache_write_5m IS NULL THEN excluded.cache_write_5m
                        WHEN excluded.cache_write_5m IS NULL THEN cache_write_5m
                        ELSE MAX(cache_write_5m, excluded.cache_write_5m) END,
  cache_write_1h = CASE WHEN cache_write_1h IS NULL THEN excluded.cache_write_1h
                        WHEN excluded.cache_write_1h IS NULL THEN cache_write_1h
                        ELSE MAX(cache_write_1h, excluded.cache_write_1h) END,
  speed    = CASE WHEN speed IS NULL THEN excluded.speed
                  WHEN excluded.speed IS NULL THEN speed ELSE MAX(speed, excluded.speed) END;

-- Stage 4A: tool calls and slash commands, same transaction, same
-- best-effort-or-rollback discipline as the request upsert above.
CREATE TEMP TABLE _tools_in (
  tool_use_id TEXT, request_id TEXT, session_id TEXT, ts TEXT,
  tool_name TEXT, mcp_server TEXT, is_error TEXT, is_sidechain TEXT
);
.import "$tools_tsv" _tools_in
CREATE TEMP TABLE _slash_in (
  entry_uuid TEXT, session_id TEXT, ts TEXT, command TEXT
);
.import "$slash_tsv" _slash_in

-- A tool_use and its tool_result routinely arrive in SEPARATE ingest runs, so
-- this upsert is idempotent, and order-independent for every field a number
-- reads: MIN for ts/is_sidechain, a NULL-aware MAX for is_error (NULL only
-- while NEITHER side has ever seen a tool_result -- an unresolved call, Review
-- Focus 1), and COALESCE for tool_name, which every copy of a tool_use
-- carries identically. The other COALESCE fields -- request_id, session_id,
-- mcp_server -- keep the FIRST non-NULL arrival, which is not
-- order-independent: 157 live tool_use ids carry sessionIds that differ
-- across files. No number reads those fields.
INSERT INTO claude_tool_calls (tool_use_id, request_id, session_id, ts, tool_name,
                               mcp_server, is_error, is_sidechain)
SELECT tool_use_id, MAX(NULLIF(request_id,'')), MAX(NULLIF(session_id,'')),
       MIN(NULLIF(ts,'')), MAX(NULLIF(tool_name,'')), MAX(NULLIF(mcp_server,'')),
       MAX(CAST(NULLIF(is_error,'') AS INTEGER)), MIN(CAST(NULLIF(is_sidechain,'') AS INTEGER))
FROM _tools_in WHERE COALESCE(tool_use_id,'') <> '' GROUP BY tool_use_id
ON CONFLICT(tool_use_id) DO UPDATE SET
  request_id   = COALESCE(request_id,   excluded.request_id),
  session_id   = COALESCE(session_id,   excluded.session_id),
  tool_name    = COALESCE(tool_name,    excluded.tool_name),
  mcp_server   = COALESCE(mcp_server,   excluded.mcp_server),
  ts           = CASE WHEN ts IS NULL THEN excluded.ts
                      WHEN excluded.ts IS NULL THEN ts ELSE MIN(ts, excluded.ts) END,
  is_sidechain = CASE WHEN is_sidechain IS NULL THEN excluded.is_sidechain
                      WHEN excluded.is_sidechain IS NULL THEN is_sidechain
                      ELSE MIN(is_sidechain, excluded.is_sidechain) END,
  is_error     = CASE WHEN is_error IS NULL THEN excluded.is_error
                      WHEN excluded.is_error IS NULL THEN is_error
                      ELSE MAX(is_error, excluded.is_error) END;

-- A slash command is a fact about ONE transcript line, never revised: IGNORE
-- on entry_uuid makes replaying a file (including --backfill) a no-op.
INSERT OR IGNORE INTO claude_slash_commands (entry_uuid, session_id, ts, command)
SELECT entry_uuid, session_id, CAST(ts AS INTEGER), command FROM _slash_in
WHERE COALESCE(entry_uuid,'') <> '' AND COALESCE(command,'') <> '';

-- Stage 4B: turn boundaries. NOT merely "a fact about one line": a forked
-- session repeats the same boundary uuid under a different sessionId (1.4% of
-- live uuids), so session_id follows claude_requests.session_id's rule EXACTLY
-- -- MAX within a batch, and first arrival across batches (DO NOTHING, as the
-- request upsert never touches session_id) -- and a boundary lands on the same
-- session as requests that arrived with it. Not MAX across batches: that would
-- drift from claude_requests, and turns join the two on session_id. ts_ms and
-- kind are the same on every copy; they still take explicit aggregates, never
-- bare columns, for the reason given at the request upsert.
CREATE TEMP TABLE _prompts_in (entry_uuid TEXT, session_id TEXT, ts_ms TEXT, kind TEXT);
.import "$prompts_tsv" _prompts_in
INSERT INTO claude_prompts (entry_uuid, session_id, ts_ms, kind)
SELECT entry_uuid, MAX(NULLIF(session_id,'')), MIN(CAST(ts_ms AS INTEGER)), MAX(kind)
FROM _prompts_in
WHERE COALESCE(entry_uuid,'') <> '' AND COALESCE(ts_ms,'') <> '' AND COALESCE(kind,'') <> ''
GROUP BY entry_uuid
ON CONFLICT(entry_uuid) DO NOTHING;

-- The cursors commit WITH the rows. Written after the transaction, a failed
-- upsert still advanced them past rows that never landed, and nothing re-read
-- those rows. Pinned by "does not advance the cursor when the upsert fails".
.read "$work/cursors.sql"
COMMIT;
SQL
then
  say "upsert failed; cursors not advanced, the next run retries"
  exit 0
fi

say "scanned $scanned of $files file(s), $rows row(s) offered"
exit 0
