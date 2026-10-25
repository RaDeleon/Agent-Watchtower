#!/usr/bin/env bash
# A Hermes state.db for the adapter tests, with Hermes's REAL column set
# (sqlite3 -readonly ~/.hermes/state.db .schema, 2026-10-03; FTS triggers dropped).
#   make-hermes-db.sh <scenario> <path>     scenarios: core | midnight | veteran | legend
# Expected numbers: plan "Fixture reference".
set -euo pipefail
SCEN="$1"; DB="$2"
# shellcheck source=/dev/null
. "$(cd "$(dirname "$0")/../../capture" && pwd)/lib.sh"     # encoders only; no cc_init_db
mkdir -p "$(dirname "$DB")"
fx() { sqlite3 -cmd ".bail on" "$DB" "$1" >/dev/null; }

if [ ! -f "$DB" ]; then
sqlite3 -cmd ".bail on" "$DB" >/dev/null <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, user_id TEXT, model TEXT, model_config TEXT,
    system_prompt TEXT, parent_session_id TEXT, started_at REAL NOT NULL, ended_at REAL,
    end_reason TEXT, message_count INTEGER DEFAULT 0, tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0,
    reasoning_tokens INTEGER DEFAULT 0, billing_provider TEXT, billing_base_url TEXT,
    billing_mode TEXT, estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT,
    cost_source TEXT, pricing_version TEXT, title TEXT, api_call_count INTEGER DEFAULT 0,
    handoff_state TEXT, handoff_platform TEXT, handoff_error TEXT, "cwd" TEXT,
    "rewind_count" INTEGER NOT NULL DEFAULT 0, "archived" INTEGER NOT NULL DEFAULT 0,
    "git_branch" TEXT, "git_repo_root" TEXT, "session_key" TEXT, "chat_id" TEXT,
    "chat_type" TEXT, "thread_id" TEXT, "compression_failure_cooldown_until" REAL,
    "compression_failure_error" TEXT, "display_name" TEXT, "origin_json" TEXT,
    "expiry_finalized" INTEGER DEFAULT 0, "compression_fallback_streak" INTEGER NOT NULL DEFAULT 0,
    "profile_name" TEXT, "compression_ineffective_count" INTEGER NOT NULL DEFAULT 0,
    "pinned" INTEGER NOT NULL DEFAULT 0, "system_prompt_hash" TEXT, "last_activity_at" REAL,
    "last_activity_description" TEXT, "last_activity_provenance" TEXT, "last_read_at" REAL,
    "title_source" TEXT, "git_metadata_generation" INTEGER NOT NULL DEFAULT 0,
    "hidden" INTEGER NOT NULL DEFAULT 0, "compression_recovery_deadline" REAL, "tool_names" TEXT,
    "transport_profile" TEXT, "created_source" TEXT,
    "compression_overload_streak" INTEGER NOT NULL DEFAULT 0, "auto_archived" INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);
CREATE UNIQUE INDEX idx_sessions_title_unique ON sessions(title) WHERE title IS NOT NULL;
CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '',
    billing_base_url TEXT NOT NULL DEFAULT '', billing_mode TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
    actual_cost_usd REAL NOT NULL DEFAULT 0, cost_status TEXT, cost_source TEXT,
    first_seen REAL, last_seen REAL,
    PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task)
);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL, content TEXT, tool_call_id TEXT, tool_calls TEXT, tool_name TEXT,
    timestamp REAL NOT NULL, token_count INTEGER, finish_reason TEXT, reasoning TEXT,
    reasoning_content TEXT, reasoning_details TEXT, codex_reasoning_items TEXT,
    codex_message_items TEXT, platform_message_id TEXT, observed INTEGER DEFAULT 0,
    "active" INTEGER NOT NULL DEFAULT 1, "compacted" INTEGER NOT NULL DEFAULT 0,
    "effect_disposition" TEXT, "api_content" TEXT, "display_kind" TEXT, "display_metadata" TEXT,
    "_compressed_summary" INTEGER NOT NULL DEFAULT 0, "display_identity" BLOB,
    "display_order" INTEGER, "message_uid" TEXT, "absorbed_message_uids" TEXT,
    "tool_call_uids" TEXT, "tool_call_uid" TEXT
);
SQL
fi

# hs <id> <source> <started_at> <ended_at-or-empty> <cwd-or-empty>
hs() {
  fx "INSERT INTO sessions (id, source, model, system_prompt, started_at, ended_at, title, cwd)
      VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$2"), $(cc_sqlstr fx-model), $(cc_sqlstr SECRET-SYSTEM),
              $(cc_sqlnum "$3"), $(cc_sqlnum "$4"), $(cc_sqlstr "SECRET-TITLE-$1"), $(cc_sqlstr "$5"));"
}
# hm <session> <timestamp> <role> <finish_reason-or-empty>
hm() {
  fx "INSERT INTO messages (session_id, role, content, timestamp, finish_reason, reasoning)
      VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$3"), $(cc_sqlstr SECRET-CONTENT), $(cc_sqlnum "$2"),
              $(cc_sqlstr "$4"), $(cc_sqlstr SECRET-REASONING));"
}
# hu <session> <model> <provider> <in> <out> <cache_read> <cache_write> <reasoning> <estimated> <actual> <status>
hu() {
  fx "INSERT INTO session_model_usage (session_id, model, billing_provider, input_tokens,
        output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
        estimated_cost_usd, actual_cost_usd, cost_status)
      VALUES ($(cc_sqlstr "$1"), $(cc_sqlstr "$2"), $(cc_sqlstr "$3"), $(cc_sqlnum "$4"),
              $(cc_sqlnum "$5"), $(cc_sqlnum "$6"), $(cc_sqlnum "$7"), $(cc_sqlnum "$8"),
              $(cc_sqlnum "$9"), $(cc_sqlnum "${10}"), $(cc_sqlstr "${11}"));"
}

case "$SCEN" in
  core)
    t=1790596800; hs h1 cli $t $((t+500)) /tmp/wt-hermes-cli
    hm h1 $((t+10)) user ""; hm h1 $((t+40)) assistant tool_calls; hm h1 $((t+100)) tool ""
    hm h1 $((t+160)) assistant stop; hm h1 $((t+400)) user ""; hm h1 $((t+460)) assistant stop
    hu h1 qwen3-coder local 1000 200 0 0 0 0 0 estimated
    hu h1 gpt-oss-120b openrouter 3000 500 2000 100 50 0.02 0.5 actual
    t=1790672400; hs h2 api_server $t $((t+40)) ""
    hm h2 $((t+5)) user ""; hm h2 $((t+30)) assistant stop
    hu h2 gpt-oss-120b openrouter 400 40 0 0 0 0.0123 0 estimated
    t=1790841600; hs h3 telegram $t "" /tmp/wt-hermes-cli
    hm h3 $((t+5)) user ""; hm h3 $((t+20)) assistant stop
    hu h3 mystery-model unknown 50 5 0 0 0 0 0 unknown
    ;;
  midnight)
    t=1789948200; hs h5 cli $t "" /tmp/wt-hermes-cli
    hm h5 $((t+10)) user ""; hm h5 $((t+300)) assistant tool_calls; hm h5 $((t+700)) assistant stop
    hu h5 gpt-oss-120b openrouter 100 10 0 0 0 0.001 0 estimated
    ;;
  veteran)
    t=1700000000; hs h9 cli $t "" /tmp/wt-hermes-cli
    hm h9 $((t+1)) user ""
    fx "WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 812)
        INSERT INTO messages (session_id, role, content, timestamp, finish_reason)
        SELECT 'h9', 'assistant', 'SECRET-CONTENT', $((t+1)) + i * 14400, 'tool_calls' FROM k;"
    hm h9 $((t + 1 + 812*14400 + 7198)) assistant stop
    ;;
  legend)
    # Stage 10: veteran's shape at 101,339,999 s of driven time, past Lv 200
    # (99,900,000 s) by 1.6 stars' worth, so ROUND and FLOOR differ.
    t=1600000000; hs h9 cli $t "" /tmp/wt-hermes-cli
    hm h9 $((t+1)) user ""
    fx "WITH RECURSIVE k(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM k WHERE i < 7037)
        INSERT INTO messages (session_id, role, content, timestamp, finish_reason)
        SELECT 'h9', 'assistant', 'SECRET-CONTENT', $((t+1)) + i * 14400, 'tool_calls' FROM k;"
    hm h9 $((t + 1 + 7037*14400 + 7198)) assistant stop
    ;;
  *) echo "make-hermes-db.sh: unknown scenario $SCEN" >&2; exit 2 ;;
esac
