#!/usr/bin/env bash
# Codex rollout logs for the adapter and rollup tests.
#   make-codex-logs.sh <scenario> <codex_home>
# Scenarios and every expected number: docs/superpowers/plans/2026-10-03-stage-5-agents-and-levels.md,
# "Fixture reference". WT_CODEX_CWD sets the driven sessions' cwd (default /tmp/wt-codex-repo).
set -euo pipefail
SCEN="$1"; H="$2"
T0=1789466400
CWD="${WT_CODEX_CWD:-/tmp/wt-codex-repo}"

# line <file> <epoch> <type> <payload-json>
line() {
  mkdir -p "$(dirname "$1")"
  jq -nc --arg t "$2" --arg ty "$3" --argjson p "$4" \
    '{timestamp: ($t|tonumber|todate), type: $ty, payload: $p}' >> "$1"
}
# meta <file> <epoch> <id> <originator> <cwd-or-empty> [extra-json merged into payload]
meta() {
  local extra="${6:-}"; [ -n "$extra" ] || extra='{}'
  line "$1" "$2" session_meta "$(jq -nc --arg id "$3" --arg o "$4" --arg cwd "$5" --arg t "$2" --argjson x "$extra" \
    '{id:$id, timestamp:($t|tonumber|todate), originator:$o, cli_version:"0.99.0", source:"vscode"}
     + (if $cwd == "" then {} else {cwd:$cwd} end) + $x')"
}
ctx()  { line "$1" "$2" turn_context "$(jq -nc --arg m "$3" '{model:$m}')"; }
ev()   { line "$1" "$2" event_msg "$(jq -nc --arg ty "$3" '{type:$ty}')"; }
# usage <in> <cached> <write> <out> <reasoning> -> usage object, total = in + out
usage() {
  jq -nc --arg i "$1" --arg c "$2" --arg w "$3" --arg o "$4" --arg r "$5" \
    '{input_tokens:($i|tonumber), cached_input_tokens:($c|tonumber),
      cache_write_input_tokens:($w|tonumber), output_tokens:($o|tonumber),
      reasoning_output_tokens:($r|tonumber), total_tokens:(($i|tonumber)+($o|tonumber))}'
}
# tur_json <epoch> <response_id> <in> <cached> <write> <out> <reasoning> -> one whole line
tur_json() {
  local u; u="$(usage "$3" "$4" "$5" "$6" "$7")"
  jq -nc --arg t "$1" --arg r "$2" --argjson u "$u" \
    '{timestamp: ($t|tonumber|todate), type: "token_usage_record",
      payload: {response_id:$r, usage:$u, thread_id:"t", turn_id:"u"}}'
}
tur()    { mkdir -p "$(dirname "$1")"; tur_json "$2" "$3" "$4" "$5" "$6" "$7" "$8" >> "$1"; }
# tcount <file> <epoch> <in> <cached> <write> <out> <reasoning>: a CUMULATIVE total
tcount() {
  local u; u="$(usage "$3" "$4" "$5" "$6" "$7")"
  line "$1" "$2" event_msg "$(jq -nc --argjson u "$u" \
    '{type:"token_count", info:{total_token_usage:$u, last_token_usage:$u, model_context_window:258400}}')"
}
user_msg() { line "$1" "$2" response_item '{"type":"message","role":"user","content":[{"type":"input_text","text":"SECRET-PROMPT"}]}'; }
asst_msg() { line "$1" "$2" response_item '{"type":"message","role":"assistant","content":[{"type":"output_text","text":"SECRET-ANSWER"}]}'; }
reasoning() { line "$1" "$2" response_item '{"type":"reasoning","encrypted_content":"SECRET-REASONING"}'; }
done_msg() { line "$1" "$2" event_msg '{"type":"task_complete","last_agent_message":"SECRET-ANSWER"}'; }

S="$H/.codex/sessions"; A="$H/.codex/archived_sessions"
case "$SCEN" in
  core)
    f="$S/2026/09/15/rollout-2026-09-15T10-00-00-codex-s1.jsonl"
    meta "$f" $T0 codex-s1 "Codex Desktop" "$CWD" \
      '{"git":{"branch":"main","repository_url":"https://example.invalid/r.git"},"base_instructions":{"text":"SECRET-BASE"}}'
    ctx "$f" $T0 gpt-5.5
    ev "$f" $((T0+20)) thread_settings_applied
    ev "$f" $((T0+22)) task_started
    user_msg "$f" $((T0+30))
    reasoning "$f" $((T0+60))
    tur "$f" $((T0+70)) resp_s1_a 1000 400 0 200 20
    tcount "$f" $((T0+70)) 1000 400 0 200 20
    done_msg "$f" $((T0+90))
    ev "$f" $((T0+190)) thread_settings_applied
    ev "$f" $((T0+195)) task_started
    tur "$f" $((T0+215)) resp_s1_b 2000 1500 0 300 30
    tcount "$f" $((T0+215)) 3000 1900 0 500 50
    asst_msg "$f" $((T0+220))
    ev "$f" $((T0+220)) task_complete

    f="$S/2026/09/15/rollout-2026-09-15T10-05-00-codex-s8.jsonl"; t=$((T0+300))
    meta "$f" $t codex-s8 "Codex Desktop" "" \
      '{"source":{"subagent":{"thread_spawn":{"parent_thread_id":"codex-s1","depth":1,"agent_role":"worker"}}}}'
    meta "$f" $t codex-s1 "Codex Desktop" "$CWD"
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+1)) task_started
    tur "$f" $((t+20)) resp_s8_a 400 0 0 40 0
    ev "$f" $((t+30)) task_complete

    f="$S/2026/09/15/rollout-2026-09-15T10-16-40-codex-s2.jsonl"; t=$((T0+1000))
    meta "$f" $t codex-s2 codex_exec /tmp/wt-codex-exec
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+1)) task_started
    tur "$f" $((t+10)) resp_s2_a 500 0 0 100 0
    ctx "$f" $((t+11)) gpt-9-imaginary
    tur "$f" $((t+20)) resp_s2_b 50 0 0 5 0
    ev "$f" $((t+30)) task_complete

    f="$S/2026/09/15/rollout-2026-09-15T10-33-20-codex-s3.jsonl"; t=$((T0+2000))
    meta "$f" $t codex-s3 mystery-client /tmp/wt-codex-mystery
    ctx "$f" $t codex-auto-review
    ev "$f" $((t+1)) task_started
    tur "$f" $((t+10)) resp_s3_a 300 100 0 50 0
    ev "$f" $((t+20)) task_complete

    f="$S/2026/09/16/rollout-2026-09-16T09-00-00-codex-s4.jsonl"; t=1789549200
    meta "$f" $t codex-s4 codex-tui "$CWD"
    ctx "$f" $t gpt-5.2
    ev "$f" $((t+5)) task_started
    tcount "$f" $((t+30)) 1000 600 0 100 10
    tcount "$f" $((t+30)) 1000 600 0 100 10
    line "$f" $((t+40)) event_msg '{"type":"token_count","info":null}'
    tcount "$f" $((t+60)) 2500 1200 0 250 30
    ev "$f" $((t+95)) task_complete

    f="$A/rollout-2026-09-14T08-00-00-codex-s6.jsonl"; t=1789372800
    meta "$f" $t codex-s6 codex_vscode "$CWD"
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+5)) task_started
    tur "$f" $((t+10)) resp_s6_a 100 0 0 10 0
    ev "$f" $((t+15)) task_complete
    ;;
  resume)
    f="$S/2026/09/15/rollout-2026-09-15T14-00-00-codex-s5.jsonl"; t=1789480800
    meta "$f" $t codex-s5 "Codex Desktop" "$CWD"
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+2)) task_started
    tur "$f" $((t+10)) resp_s5_a 100 0 0 10 0
    ev "$f" $((t+12)) task_complete
    f="$S/2026/09/18/rollout-2026-09-18T09-00-00-codex-s5b.jsonl"; t=1789722000
    meta "$f" $t codex-s5 "Codex Desktop" "$CWD"
    ev "$f" $((t+5)) task_started
    tur "$f" $((t+15)) resp_s5_b 100 0 0 10 0
    ev "$f" $((t+25)) task_complete
    ;;
  partial|partial-complete)
    f="$S/2026/09/15/rollout-2026-09-15T11-23-20-codex-s10.jsonl"; t=$((T0+5000))
    full="$(tur_json $((t+9)) resp_s10_b 100 0 0 10 0)"
    if [ "$SCEN" = partial ]; then
      meta "$f" $t codex-s10 "Codex Desktop" "$CWD"
      ev "$f" $((t+1)) task_started
      tur "$f" $((t+5)) resp_s10_a 100 0 0 10 0
      printf '%s' "${full:0:40}" >> "$f"
      g="$S/2026/09/15/rollout-2026-09-15T11-40-00-codex-s11.jsonl"; u=$((T0+6000))
      meta "$g" $u codex-s11 "Codex Desktop" "$CWD"
      printf 'not json at all\n' >> "$g"
      ev "$g" $((u+3)) task_complete
    else
      printf '%s\n' "${full:40}" >> "$f"
      ev "$f" $((t+12)) task_complete
    fi
    ;;
  midnight)
    f="$S/2026/09/20/rollout-2026-09-20T23-58-00-codex-s9.jsonl"; t=1789948680
    meta "$f" $t codex-s9 "Codex Desktop" "$CWD"
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+10)) task_started
    tur "$f" $((t+60)) resp_s9_a 100 0 0 10 0
    asst_msg "$f" $((t+150))
    tur "$f" $((t+170)) resp_s9_b 200 0 0 10 0
    ev "$f" $((t+190)) task_complete
    ;;
  dup|dup-b-only)
    if [ "$SCEN" = dup ]; then
      f="$S/2026/09/15/rollout-2026-09-15T15-00-00-codex-da.jsonl"; t=$((T0+18000))
      meta "$f" $t codex-da "Codex Desktop" "$CWD"; ev "$f" $((t+1)) task_started
      tur "$f" $((t+5)) resp_dup 100 0 0 10 0; ev "$f" $((t+9)) task_complete
    fi
    f="$S/2026/09/15/rollout-2026-09-15T16-00-00-codex-db.jsonl"
    if [ ! -f "$f" ]; then
      t=$((T0+21600))
      meta "$f" $t codex-db "Codex Desktop" "$CWD"; ev "$f" $((t+1)) task_started
      tur "$f" $((t+5)) resp_dup 100 0 0 10 0; ev "$f" $((t+9)) task_complete
    fi
    ;;
  early)
    f="$S/2024/01/01/rollout-2024-01-01T00-00-00-codex-s7.jsonl"; t=1704067200
    meta "$f" $t codex-s7 "Codex Desktop" "$CWD"
    ctx "$f" $t gpt-5.5
    ev "$f" $((t+1)) task_started
    tur "$f" $((t+5)) resp_s7_a 100 0 0 10 0
    ev "$f" $((t+9)) task_complete
    ;;
  *) echo "make-codex-logs.sh: unknown scenario $SCEN" >&2; exit 2 ;;
esac
