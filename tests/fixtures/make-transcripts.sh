#!/usr/bin/env bash
# make-transcripts.sh <scenario> <dir>
#
# Builds a synthetic ~/.claude/projects tree so ingest.sh can be asserted
# against a known request stream. Fails LOUDLY (set -e), for the same reason
# make-fixture.sh does: a silent fixture failure means assertions run against
# a tree that was never built.
set -euo pipefail

scenario="${1:?scenario required}"
root="${2:?dir required}"

# 2026-06-13T01:28:57.263Z == 1781314137, deliberately BEFORE the tracker's
# first day so the orphan case is reachable.
mkfile() { mkdir -p "$(dirname "$1")"; : > "$1"; }

# rec <file> <requestId> <sessionId> <iso-ts> <cwd> <out-tokens> [extra-json]
rec() {
  local f="$1" rid="$2" sid="$3" ts="$4" cwd="$5" out="$6" extra="${7:-}"
  local base
  base=$(printf '{"requestId":"%s","sessionId":"%s","timestamp":"%s","cwd":"%s","gitBranch":"main","version":"2.0.0","entrypoint":"cli","effort":"high","isSidechain":false,"message":{"id":"msg_%s","model":"claude-opus-5","usage":{"input_tokens":10,"output_tokens":%s,"cache_read_input_tokens":1000,"cache_creation_input_tokens":100,"service_tier":"standard"}}}' \
    "$rid" "$sid" "$ts" "$cwd" "$rid" "$out")
  if [ -n "$extra" ]; then
    printf '%s\n' "$base" | jq -c ". + $extra" >> "$f"
  else
    printf '%s\n' "$base" >> "$f"
  fi
}

# patch_last <file> <jq-filter> [jq-args...]
#
# Rewrites the file's LAST line through a jq filter, typically a path
# assignment (.a.b = x), which updates only the fields it names. rec's own
# extra-json merge is a SHALLOW `. + extra`, so merging {"message":{...}} that
# way would clobber the whole message object -- usage, model and all. Any
# further arguments go to jq ahead of the filter (e.g. --arg name value).
patch_last() {
  local f="$1" filter="$2"; shift 2
  local last patched tmp
  last=$(tail -n 1 "$f")
  patched=$(printf '%s' "$last" | jq -c "$@" "$filter")
  tmp="$f.patch.tmp"
  sed '$d' "$f" > "$tmp"
  printf '%s\n' "$patched" >> "$tmp"
  mv "$tmp" "$f"
}

# tuse <file> <requestId> <sessionId> <iso-ts> <tool_use_id> <name> [sidechain]
#
# An assistant line with usage (built via rec, so it also lands a
# claude_requests row -- the tool_use and the request it belongs to always
# arrive on the same transcript line) whose message.content is patched in
# afterwards with patch_last, leaving usage/model/etc. intact.
tuse() {
  local f="$1" rid="$2" sid="$3" ts="$4" tuid="$5" name="$6" side="${7:-false}"
  rec "$f" "$rid" "$sid" "$ts" /tmp/fx 50
  # shellcheck disable=SC2016  # a jq filter: $side, $tuid and $name are jq's
  patch_last "$f" '.type = "assistant" | .isSidechain = $side
     | .message.content = [{"type":"tool_use","id":$tuid,"name":$name,"input":{}}]' \
    --arg tuid "$tuid" --arg name "$name" --argjson side "$side"
}

# tres <file> <sessionId> <iso-ts> <tool_use_id> <true|false>
#
# A type:"user" line carrying the tool's result. No requestId/usage: a tool
# result is sent back to the model, it does not carry token usage itself.
tres() {
  local f="$1" sid="$2" ts="$3" tuid="$4" iserr="$5"
  printf '{"type":"user","sessionId":"%s","timestamp":"%s","isSidechain":false,"message":{"content":[{"type":"tool_result","tool_use_id":"%s","is_error":%s,"content":"x"}]}}\n' \
    "$sid" "$ts" "$tuid" "$iserr" >> "$f"
}

# uent <file> <uuid> <sessionId> <iso-ts> <content-json> [extra-json]
#
# A main-thread type:"user" line whose message.content is exactly the given
# JSON value (a quoted string or an array of blocks), shallow-merged with
# extra-json for top-level flags such as {"isMeta":true}, {"isSidechain":true}
# or {"entrypoint":"sdk-cli"}. Compact JSON, like the real transcripts: the
# ingest line filter matches the literal "type":"user".
uent() {
  local f="$1" uuid="$2" sid="$3" ts="$4" content="$5" extra="${6:-}"
  local base
  base=$(printf '{"type":"user","uuid":"%s","sessionId":"%s","timestamp":"%s","isSidechain":false,"message":{"role":"user","content":%s}}' \
    "$uuid" "$sid" "$ts" "$content")
  if [ -n "$extra" ]; then
    printf '%s\n' "$base" | jq -c ". + $extra" >> "$f"
  else
    printf '%s\n' "$base" | jq -c . >> "$f"
  fi
}

# slash <file> <uuid> <sessionId> <iso-ts> <content-json> [sidechain]
#
# A type:"user" line whose message.content is exactly the given JSON value
# (a quoted string for the real slash-command shape, or an array/object for
# the negative cases that must NOT be counted).
slash() {
  local f="$1" uuid="$2" sid="$3" ts="$4" content="$5" side="${6:-false}"
  printf '{"type":"user","uuid":"%s","sessionId":"%s","timestamp":"%s","isSidechain":%s,"message":{"content":%s}}\n' \
    "$uuid" "$sid" "$ts" "$side" "$content" >> "$f"
}

P="$root/-tmp-fx"
case "$scenario" in
  single)
    mkfile "$P/s1.jsonl"
    rec "$P/s1.jsonl" req_a s1 "2026-07-10T10:00:00.000Z" /tmp/fx 100
    rec "$P/s1.jsonl" req_b s1 "2026-07-10T10:05:00.000Z" /tmp/fx 200
    ;;
  streaming-partials)
    # Same requestId three times with GROWING output_tokens. first-seen-wins
    # would record 5; MAX records 900.
    mkfile "$P/s1.jsonl"
    rec "$P/s1.jsonl" req_g s1 "2026-07-10T10:00:00.000Z" /tmp/fx 5
    rec "$P/s1.jsonl" req_g s1 "2026-07-10T10:00:01.000Z" /tmp/fx 400
    rec "$P/s1.jsonl" req_g s1 "2026-07-10T10:00:02.000Z" /tmp/fx 900
    ;;
  cross-file-duplicate)
    # One request in a parent AND a subagent transcript, partial + sidechain in
    # the subagent copy. Must count ONCE, at 900, is_sidechain 0.
    mkfile "$P/s1.jsonl"; mkfile "$P/s1/subagents/agent-x.jsonl"
    rec "$P/s1.jsonl" req_d s1 "2026-07-10T10:00:00.000Z" /tmp/fx 900
    rec "$P/s1/subagents/agent-x.jsonl" req_d s1 "2026-07-10T10:00:00.000Z" /tmp/fx 3 \
      '{"isSidechain":true}'
    ;;
  attributed)
    mkfile "$P/s1.jsonl"
    rec "$P/s1.jsonl" req_s s1 "2026-07-10T10:00:00.000Z" /tmp/fx 100 \
      '{"attributionSkill":"superpowers:brainstorming"}'
    rec "$P/s1.jsonl" req_m s1 "2026-07-10T10:01:00.000Z" /tmp/fx 100 \
      '{"attributionMcpServer":"claude-in-chrome","attributionMcpTool":"computer","attributionPlugin":"cic"}'
    ;;
  malformed)
    # Two corrupt lines: one with no "usage" substring at all -- dropped by
    # ingest.sh's `grep '"usage"'` prefilter before jq ever sees it -- and one
    # that DOES contain "usage": a truncated record missing its closing
    # braces, so it actually reaches jq and must be caught by
    # `fromjson? // empty`. The good rows must still land either way.
    mkfile "$P/s1.jsonl"
    rec "$P/s1.jsonl" req_ok1 s1 "2026-07-10T10:00:00.000Z" /tmp/fx 100
    printf '%s\n' 'THIS IS NOT JSON {{{' >> "$P/s1.jsonl"
    printf '%s\n' '{"requestId":"req_bad","message":{"usage":{"output_tokens":' >> "$P/s1.jsonl"
    rec "$P/s1.jsonl" req_ok2 s1 "2026-07-10T10:02:00.000Z" /tmp/fx 100
    ;;
  orphan)
    # A request whose session has no claude_sessions row, dated BEFORE the
    # tracker's first day. This is the 22.7%-of-tokens case.
    mkfile "$P/pre.jsonl"
    rec "$P/pre.jsonl" req_o1 s_ghost "2026-06-13T01:28:57.263Z" /tmp/fx 700
    ;;
  tools-split-a)
    # The tool_use half of a call that is resolved in a SEPARATE file
    # (tools-split-b), exercising the cross-run merge. The tool name is
    # mcp__-prefixed so the same fixture also covers the mcp_server split.
    mkfile "$P/split-a.jsonl"
    tuse "$P/split-a.jsonl" req_split1 s_split "2026-09-10T10:00:00.000Z" \
      tu_split1 "mcp__plugin_x-mcp_y__navigate_page"
    ;;
  tools-split-b)
    # The tool_result half, same tool_use_id, is_error true.
    mkfile "$P/split-b.jsonl"
    tres "$P/split-b.jsonl" s_split "2026-09-10T10:00:01.000Z" tu_split1 true
    ;;
  tools-sidechain)
    mkfile "$P/side.jsonl"
    tuse "$P/side.jsonl" req_side s_side "2026-09-10T10:00:00.000Z" tu_side "Read" true
    ;;
  tools-unresolved)
    # A tool_use whose result never arrives (Review Focus 1): is_error must
    # stay NULL, not fall back to 0.
    mkfile "$P/unresolved.jsonl"
    tuse "$P/unresolved.jsonl" req_unres s_unres "2026-09-10T10:00:00.000Z" tu_unres "Bash"
    ;;
  slash-mixed)
    mkfile "$P/slash.jsonl"
    # Counted: a real slash-command string.
    slash "$P/slash.jsonl" u1 s_slash "2026-09-10T10:00:00.000Z" \
      '"<command-name>/compact</command-name>"'
    # Counted, but only the command token -- "/model", not "/model opus".
    slash "$P/slash.jsonl" u2 s_slash "2026-09-10T10:01:00.000Z" \
      '"<command-name>/model opus</command-name>"'
    # NOT counted: array content, a text block merely mentioning the tag.
    slash "$P/slash.jsonl" u3 s_slash "2026-09-10T10:02:00.000Z" \
      '[{"type":"text","text":"<command-name>/foo</command-name>"}]'
    # NOT counted: a type:"user" entry whose message.content is null/absent,
    # carrying the command text only in a top-level attachment/prompt-snapshot
    # field, not in message.content itself. (A top-level {"type":"attachment",
    # ...} LINE with no .message at all would already be excluded by the
    # type=="user" check alone, before the content-is-a-string check ever ran
    # -- too weak a fixture to prove that check does anything. This shape
    # passes the type=="user" gate and is excluded ONLY by the string check,
    # so a slash branch that falls back to $e.attachment.text when
    # message.content is absent -- a plausible "catch attachments too" bug --
    # would leak /bar through.)
    printf '%s\n' '{"type":"user","uuid":"u4","sessionId":"s_slash","timestamp":"2026-09-10T10:04:00.000Z","isSidechain":false,"attachment":{"type":"prompt_snapshot","text":"<command-name>/bar</command-name>"},"message":{"content":null}}' \
      >> "$P/slash.jsonl"
    # NOT counted: a sidechain string.
    slash "$P/slash.jsonl" u5 s_slash "2026-09-10T10:03:00.000Z" \
      '"<command-name>/baz</command-name>"' true
    # NOT counted: the REAL shape of a prompt snapshot -- a top-level
    # type:"attachment" line with no .message at all. u4 above is the synthetic
    # case that only the string check excludes; this one is what transcripts
    # actually carry, and it reaches jq because it contains <command-name>.
    printf '%s\n' '{"type":"attachment","uuid":"u6","sessionId":"s_slash","timestamp":"2026-09-10T10:05:00.000Z","attachment":{"type":"prompt_snapshot","text":"<command-name>/qux</command-name>"}}' \
      >> "$P/slash.jsonl"
    ;;
  ms-split)
    # Stage 4B: ms timestamps, sent_ms, the cache-write split and speed.
    # req_m streams two partials (.5Z and no fraction at all), both after the
    # .120Z prompt; req_n carries no split and no speed; req_f is fast mode on a
    # model no price row knows.
    mkfile "$P/s1.jsonl"
    uent "$P/s1.jsonl" u_p1 s1 "2026-07-10T10:00:00.120Z" '"hello"'
    rec "$P/s1.jsonl" req_m s1 "2026-07-10T10:00:01.5Z" /tmp/fx 5
    patch_last "$P/s1.jsonl" '.message.usage.cache_creation = {"ephemeral_5m_input_tokens":60,"ephemeral_1h_input_tokens":40} | .message.usage.speed = "standard"'
    rec "$P/s1.jsonl" req_m s1 "2026-07-10T10:00:03Z" /tmp/fx 900
    patch_last "$P/s1.jsonl" '.message.usage.cache_creation = {"ephemeral_5m_input_tokens":60,"ephemeral_1h_input_tokens":40} | .message.usage.speed = "standard"'
    rec "$P/s1.jsonl" req_n s1 "2026-07-10T10:00:04.000Z" /tmp/fx 7
    rec "$P/s1.jsonl" req_f s1 "2026-07-10T10:00:05.000Z" /tmp/fx 7
    patch_last "$P/s1.jsonl" '.message.usage.speed = "fast" | .message.model = "claude-mystery-9"'
    ;;
  sent-cursor-a)
    # A prompt and nothing else. Its ms must reach the cursor, because the
    # request it starts only arrives in the NEXT run (sent-cursor-b).
    mkfile "$P/s2.jsonl"
    uent "$P/s2.jsonl" u_c s2 "2026-07-10T11:00:00.250Z" '"go"'
    ;;
  sent-cursor-b)
    # APPENDS to sent-cursor-a's file -- no mkfile -- so the next ingest resumes
    # from the cursor's byte offset and sees no user entry before req_c.
    rec "$P/s2.jsonl" req_c s2 "2026-07-10T11:00:02.000Z" /tmp/fx 50
    ;;
  sent-midstream)
    # A tool result lands between two partials of ONE request. The later
    # partial's carried user entry is that tool result, so only a MIN merge keeps
    # sent_ms on the prompt that actually preceded the request.
    mkfile "$P/s3.jsonl"
    uent "$P/s3.jsonl" u_s s3 "2026-07-10T12:00:00.000Z" '"x"'
    rec "$P/s3.jsonl" req_s s3 "2026-07-10T12:00:01.000Z" /tmp/fx 5
    tres "$P/s3.jsonl" s3 "2026-07-10T12:00:02.000Z" tu_x false
    rec "$P/s3.jsonl" req_s s3 "2026-07-10T12:00:03.000Z" /tmp/fx 90
    ;;
  mid-turn)
    # A transcript that starts mid-turn (resumed or rotated): no user entry
    # anywhere in the file, so there is nothing to measure from (Review Focus 1).
    mkfile "$P/s4.jsonl"
    rec "$P/s4.jsonl" req_mt s4 "2026-07-10T13:00:01.000Z" /tmp/fx 10
    ;;
  turn-kinds)
    # One user entry per line, 1 s apart: eleven boundaries of five kinds, then
    # five entries that are not boundaries (meta, a tool result, a sidechain,
    # null content and absent content -- plan P5).
    mkfile "$P/kinds.jsonl"
    k="$P/kinds.jsonl"
    uent "$k" u_prompt s_k "2026-09-10T09:00:00.000Z" '"fix it"'
    uent "$k" u_array  s_k "2026-09-10T09:00:01.000Z" '[{"type":"image","source":{}},{"type":"text","text":"look"}]'
    uent "$k" u_cmd    s_k "2026-09-10T09:00:02.000Z" '"<command-name>/review</command-name>"'
    uent "$k" u_cmsg   s_k "2026-09-10T09:00:03.000Z" '"<command-message>review</command-message>"'
    uent "$k" u_note   s_k "2026-09-10T09:00:04.000Z" '"<task-notification>x</task-notification>"'
    uent "$k" u_lstd   s_k "2026-09-10T09:00:05.000Z" '"<local-command-stdout>ok</local-command-stdout>"'
    uent "$k" u_lerr   s_k "2026-09-10T09:00:06.000Z" '"<local-command-stderr>no</local-command-stderr>"'
    uent "$k" u_bash   s_k "2026-09-10T09:00:07.000Z" '"<bash-input>ls</bash-input>"'
    uent "$k" u_bout   s_k "2026-09-10T09:00:08.000Z" '"<bash-stdout>a.txt</bash-stdout>"'
    uent "$k" u_berr   s_k "2026-09-10T09:00:09.000Z" '"<bash-stderr>denied</bash-stderr>"'
    uent "$k" u_int    s_k "2026-09-10T09:00:10.000Z" '[{"type":"text","text":"[Request interrupted by user]"}]'
    uent "$k" u_meta   s_k "2026-09-10T09:00:11.000Z" '"ctx"' '{"isMeta":true}'
    uent "$k" u_tr     s_k "2026-09-10T09:00:12.000Z" '[{"type":"tool_result","tool_use_id":"t1","content":"x"}]'
    uent "$k" u_side   s_k "2026-09-10T09:00:13.000Z" '"sub"' '{"isSidechain":true}'
    uent "$k" u_null   s_k "2026-09-10T09:00:14.000Z" 'null'
    uent "$k" u_absent s_k "2026-09-10T09:00:15.000Z" 'null' '{"message":{"role":"user"}}'
    ;;
  xrun-a)
    # One request whose partials land in TWO ingest runs (xrun-b appends): the
    # cross-run ON CONFLICT merge is the only thing that can combine them.
    mkfile "$P/s5.jsonl"
    uent "$P/s5.jsonl" u_x5 s5 "2026-07-10T14:00:00.000Z" '"go on"'
    rec "$P/s5.jsonl" req_x s5 "2026-07-10T14:00:01.000Z" /tmp/fx 5
    patch_last "$P/s5.jsonl" '.message.usage.cache_creation = {"ephemeral_5m_input_tokens":60,"ephemeral_1h_input_tokens":40} | .message.usage.speed = "standard"'
    ;;
  xrun-b)
    # APPENDS to xrun-a's file: a tool result moves the carry, then the second
    # partial -- later, and with a larger split.
    tres "$P/s5.jsonl" s5 "2026-07-10T14:00:02.000Z" tu_x5 false
    rec "$P/s5.jsonl" req_x s5 "2026-07-10T14:00:03.000Z" /tmp/fx 900
    patch_last "$P/s5.jsonl" '.message.usage.cache_creation_input_tokens = 150 | .message.usage.cache_creation = {"ephemeral_5m_input_tokens":90,"ephemeral_1h_input_tokens":60} | .message.usage.speed = "standard"'
    ;;
  order-x)
    # order-x and order-y each carry a copy of req_q, in separate files, so an
    # ingest of one then the other exercises every cross-run merge -- in either
    # order. x: earlier prompt and partial, smaller split, no speed.
    mkfile "$P/ox.jsonl"
    uent "$P/ox.jsonl" u_ox s_o "2026-07-10T15:00:00.000Z" '"a"'
    rec "$P/ox.jsonl" req_q s_o "2026-07-10T15:00:02.000Z" /tmp/fx 5
    patch_last "$P/ox.jsonl" '.message.usage.cache_creation = {"ephemeral_5m_input_tokens":60,"ephemeral_1h_input_tokens":40}'
    ;;
  order-y)
    # y: later prompt and partial, larger split, speed standard.
    mkfile "$P/oy.jsonl"
    uent "$P/oy.jsonl" u_oy s_o "2026-07-10T15:00:01.000Z" '"b"'
    rec "$P/oy.jsonl" req_q s_o "2026-07-10T15:00:03.000Z" /tmp/fx 900
    patch_last "$P/oy.jsonl" '.message.usage.cache_creation = {"ephemeral_5m_input_tokens":70,"ephemeral_1h_input_tokens":50} | .message.usage.speed = "standard"'
    ;;
  forked-uuid|forked-uuid-swapped)
    # A forked session: the same boundary uuid and the same request in two
    # files under DIFFERENT sessionIds (1.4% of live boundary uuids). The swap
    # puts each sessionId in the other file, so a rule that depends on which
    # file is read first fails in one of the two, whatever order find returns.
    a=s_fork_a; b=s_fork_b
    [ "$scenario" = forked-uuid-swapped ] && { a=s_fork_b; b=s_fork_a; }
    mkfile "$P/fork1.jsonl"; mkfile "$P/fork2.jsonl"
    uent "$P/fork1.jsonl" u_fork "$a" "2026-09-10T11:00:00.000Z" '"forked"'
    rec "$P/fork1.jsonl" req_fork "$a" "2026-09-10T11:00:01.000Z" /tmp/fx 10
    uent "$P/fork2.jsonl" u_fork "$b" "2026-09-10T11:00:00.000Z" '"forked"'
    rec "$P/fork2.jsonl" req_fork "$b" "2026-09-10T11:00:01.000Z" /tmp/fx 10
    ;;
  tools-untyped)
    # A tool_use block on a line whose type is not "assistant" (M8 gate): the
    # request still lands, the tool call does not.
    mkfile "$P/untyped.jsonl"
    rec "$P/untyped.jsonl" req_untyped s_untyped "2026-09-10T10:00:00.000Z" /tmp/fx 50
    patch_last "$P/untyped.jsonl" '.type = "progress"
      | .message.content = [{"type":"tool_use","id":"tu_untyped","name":"Bash","input":{}}]'
    ;;
  turns-mixed)
    # Stage 4B Task 3: response time and turns. One session (s_t) with every
    # boundary kind, in file order, all on 2026-09-10; a subagent partial inside
    # u_p1's range; a headless (sdk-) turn; and a transcript with no user entry.
    mkfile "$P/s_t.jsonl"; mkfile "$P/s_t/subagents/agent-a.jsonl"
    mkfile "$P/s_h.jsonl"; mkfile "$P/s_m.jsonl"
    t="$P/s_t.jsonl"
    uent "$t" u_p1 s_t "2026-09-10T10:00:00.000Z" '"fix the bug"'
    rec  "$t" r1 s_t "2026-09-10T10:00:01.500Z" /tmp/fx 5
    rec  "$t" r1 s_t "2026-09-10T10:00:03.000Z" /tmp/fx 600
    tres "$t" s_t "2026-09-10T10:00:04.000Z" tu_a false
    rec  "$t" r2 s_t "2026-09-10T10:00:05.250Z" /tmp/fx 250
    uent "$t" u_i1 s_t "2026-09-10T10:00:06.000Z" '[{"type":"text","text":"[Request interrupted by user]"}]'
    uent "$t" u_n1 s_t "2026-09-10T10:01:00.000Z" '"<task-notification>done</task-notification>"'
    rec  "$t" r3 s_t "2026-09-10T10:01:02.000Z" /tmp/fx 100
    uent "$t" u_c1 s_t "2026-09-10T10:02:00.000Z" '"<command-name>/review</command-name>"'
    tuse "$t" r4 s_t "2026-09-10T10:02:02.000Z" tu_q AskUserQuestion
    tres "$t" s_t "2026-09-10T10:02:30.000Z" tu_q false
    rec  "$t" r5 s_t "2026-09-10T10:02:31.000Z" /tmp/fx 80
    # Review Focus 3: a command and a local output in ONE millisecond. The
    # local line is first in the file; the command must still own r6.
    uent "$t" u_l1 s_t "2026-09-10T10:03:00.000Z" '"<local-command-stdout>ok</local-command-stdout>"'
    uent "$t" u_c2 s_t "2026-09-10T10:03:00.000Z" '"<command-name>/model</command-name>"'
    rec  "$t" r6 s_t "2026-09-10T10:03:01.000Z" /tmp/fx 40
    # Review Focus 2: the request's last partial lands in the prompt's own ms.
    uent "$t" u_p2 s_t "2026-09-10T10:04:00.000Z" '"hi"'
    rec  "$t" r7 s_t "2026-09-10T10:04:00.000Z" /tmp/fx 30
    # A subagent partial whose first_ms falls inside u_p1's range: sidechain,
    # so no turn may count it.
    rec "$P/s_t/subagents/agent-a.jsonl" r_side s_t "2026-09-10T10:00:04.500Z" /tmp/fx 999 \
      '{"isSidechain":true}'
    # A headless run: its only request came in through the SDK.
    uent "$P/s_h.jsonl" u_h s_h "2026-09-10T11:00:00.000Z" '"run"'
    rec  "$P/s_h.jsonl" r_h s_h "2026-09-10T11:00:02.000Z" /tmp/fx 10
    patch_last "$P/s_h.jsonl" '.entrypoint = "sdk-ts"'
    # Review Focus 1: a transcript that starts mid-turn -- no user entry at all.
    rec "$P/s_m.jsonl" r_m s_m "2026-09-10T12:00:01.000Z" /tmp/fx 10
    ;;
  *) echo "unknown scenario: $scenario" >&2; exit 1 ;;
esac
