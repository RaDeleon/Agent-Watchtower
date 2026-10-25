import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const LIB = path.join(ROOT, "capture", "lib.sh");
const INGEST = path.join(ROOT, "capture", "ingest.sh");
const MAKE_TX = path.join(ROOT, "tests", "fixtures", "make-transcripts.sh");

/** Build a transcript tree, ingest it, return the db path. Each DB in its OWN
 *  directory: the .schema-vN marker is per-directory. */
export function ingestScenario(scenario: string, args: string[] = []): string {
  const dir = mkdtempSync(path.join(tmpdir(), `wt-ing-${scenario}-`));
  const tx = path.join(dir, "projects");
  const dbDir = path.join(dir, "db");
  execFileSync("mkdir", ["-p", tx, dbDir]);
  execFileSync("bash", [MAKE_TX, scenario, tx], { encoding: "utf8" });
  const db = path.join(dbDir, "fixture.sqlite");
  execFileSync("bash", [INGEST, "--quiet", ...args], {
    env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB,
           WATCHTOWER_TRANSCRIPTS_DIR: tx, TZ: "UTC" },
    encoding: "utf8",
  });
  return db;
}
export function q(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

/** Re-run ingest.sh against an already-ingested tree/db pair. Module scope so
 *  both the MAX-rule and idempotence tests can drive separate ingest runs. */
function reingest(db: string, tx: string, args: string[] = []): void {
  execFileSync("bash", [INGEST, "--quiet", ...args], {
    env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB,
           WATCHTOWER_TRANSCRIPTS_DIR: tx, TZ: "UTC" }, encoding: "utf8" });
}
const txOf = (db: string) => path.join(path.dirname(path.dirname(db)), "projects");

describe("ingest extracts one row per request", () => {
  it("records both requests with their token fields and metadata", () => {
    const db = ingestScenario("single");
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("2");
    expect(q(db, "SELECT tokens_out FROM claude_requests WHERE request_id='req_a';")).toBe("100");
    expect(q(db, "SELECT tokens_in, tokens_cache_read, tokens_cache_creation FROM claude_requests WHERE request_id='req_a';"))
      .toBe("10|1000|100");
    expect(q(db, "SELECT model, effort, service_tier, git_branch, cc_version, entrypoint FROM claude_requests WHERE request_id='req_a';"))
      .toBe("claude-opus-5|high|standard|main|2.0.0|cli");
    expect(q(db, "SELECT session_id, cwd FROM claude_requests WHERE request_id='req_a';"))
      .toBe("s1|/tmp/fx");
  });

  it("converts the millisecond ISO timestamp to unix seconds", () => {
    const db = ingestScenario("single");
    // 2026-07-10T10:00:00.000Z
    expect(q(db, "SELECT ts FROM claude_requests WHERE request_id='req_a';")).toBe("1783677600");
  });

  it("captures skill, MCP and plugin attribution", () => {
    const db = ingestScenario("attributed");
    expect(q(db, "SELECT attribution_skill FROM claude_requests WHERE request_id='req_s';"))
      .toBe("superpowers:brainstorming");
    expect(q(db, "SELECT attribution_mcp_server, attribution_mcp_tool, attribution_plugin FROM claude_requests WHERE request_id='req_m';"))
      .toBe("claude-in-chrome|computer|cic");
  });

  it("streaming partials converge to the LARGEST output_tokens, not the first", () => {
    const db = ingestScenario("streaming-partials");
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("1");
    expect(q(db, "SELECT tokens_out FROM claude_requests WHERE request_id='req_g';")).toBe("900");
  });

  // req_g's three copies carry DIFFERENT timestamps (10:00:00, :01, :02). A
  // bare `ts` column in a GROUP BY query that also carries other min/max
  // aggregates is picked from an unspecified row by SQLite -- this pins it to
  // MIN(ts), the instant the request began, so re-ingesting is idempotent and
  // Task 5's day(ts) rollup grouping cannot flip across a midnight boundary.
  it("converges the timestamp to MIN(ts) across streaming partials, deterministically", () => {
    const db = ingestScenario("streaming-partials");
    // 2026-07-10T10:00:00.000Z, the earliest of the three copies (same instant
    // as req_a in the "single" scenario above, hence the same epoch value).
    expect(q(db, "SELECT ts FROM claude_requests WHERE request_id='req_g';")).toBe("1783677600");
  });

  it("counts a request appearing in two files once, main-chain winning", () => {
    const db = ingestScenario("cross-file-duplicate");
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("1");
    expect(q(db, "SELECT tokens_out, is_sidechain FROM claude_requests WHERE request_id='req_d';"))
      .toBe("900|0");
  });

  // The in-batch GROUP BY only folds copies that land in the SAME ingest run.
  // A live transcript grows BETWEEN SessionEnd hook runs, so the same
  // requestId is commonly ingested once with a partial output_tokens and
  // again later, in a SEPARATE run, with a larger one -- two single-row
  // batches that never share a GROUP BY. Only the ON CONFLICT ...
  // tokens_out = MAX(tokens_out, excluded.tokens_out) clause can fold that
  // upward. This is the production path Mutation A/B's in-batch redundancy
  // does not cover (see "streaming partials", where both copies share one
  // batch and the in-batch MAX alone already suffices).
  it("folds tokens_out upward across SEPARATE ingest runs via ON CONFLICT MAX", () => {
    const db = ingestScenario("single");
    const tx = txOf(db);
    const f = path.join(tx, "-tmp-fx", "s1.jsonl");
    appendFileSync(f, JSON.stringify({
      requestId: "req_p", sessionId: "s1", timestamp: "2026-07-10T13:00:00.000Z",
      cwd: "/tmp/fx", isSidechain: false,
      message: { id: "msg_p1", model: "claude-opus-5",
                 usage: { input_tokens: 1, output_tokens: 50,
                          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n");
    reingest(db, tx); // run 1: req_p inserted fresh, tokens_out=50
    expect(q(db, "SELECT tokens_out FROM claude_requests WHERE request_id='req_p';")).toBe("50");

    appendFileSync(f, JSON.stringify({
      requestId: "req_p", sessionId: "s1", timestamp: "2026-07-10T13:00:01.000Z",
      cwd: "/tmp/fx", isSidechain: false,
      message: { id: "msg_p2", model: "claude-opus-5",
                 usage: { input_tokens: 1, output_tokens: 800,
                          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n");
    reingest(db, tx); // run 2: req_p already exists -- must fold via ON CONFLICT MAX
    expect(q(db, "SELECT count(*) FROM claude_requests WHERE request_id='req_p';")).toBe("1");
    expect(q(db, "SELECT tokens_out FROM claude_requests WHERE request_id='req_p';")).toBe("800");
  });
});

describe("idempotence", () => {
  it("re-ingesting the same tree changes nothing", () => {
    const db = ingestScenario("single");
    const before = q(db, "SELECT count(*), SUM(tokens_out) FROM claude_requests;");
    reingest(db, txOf(db));
    reingest(db, txOf(db));
    expect(q(db, "SELECT count(*), SUM(tokens_out) FROM claude_requests;")).toBe(before);
  });

  it("produces identical numbers after the cursor is deleted", () => {
    const db = ingestScenario("single");
    const before = q(db, "SELECT count(*), SUM(tokens_out), SUM(tokens_in) FROM claude_requests;");
    execFileSync("sqlite3", [db, "DELETE FROM claude_ingest_cursor;"]);
    reingest(db, txOf(db));
    expect(q(db, "SELECT count(*), SUM(tokens_out), SUM(tokens_in) FROM claude_requests;")).toBe(before);
  });

  it("--backfill over an already-ingested tree changes nothing", () => {
    const db = ingestScenario("streaming-partials");
    const before = q(db, "SELECT count(*), SUM(tokens_out) FROM claude_requests;");
    reingest(db, txOf(db), ["--backfill"]);
    expect(q(db, "SELECT count(*), SUM(tokens_out) FROM claude_requests;")).toBe(before);
  });

  it("picks up rows appended after the first ingest", () => {
    const db = ingestScenario("single");
    const tx = txOf(db);
    const f = path.join(tx, "-tmp-fx", "s1.jsonl");
    appendFileSync(f, JSON.stringify({
      requestId: "req_c", sessionId: "s1", timestamp: "2026-07-10T11:00:00.000Z",
      cwd: "/tmp/fx", isSidechain: false,
      message: { id: "msg_c", model: "claude-opus-5",
                 usage: { input_tokens: 1, output_tokens: 42,
                          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n");
    reingest(db, tx);
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("3");
    expect(q(db, "SELECT tokens_out FROM claude_requests WHERE request_id='req_c';")).toBe("42");
  });

  it("re-reads a rewritten (shrunk) file instead of resuming past its end", () => {
    const db = ingestScenario("single");
    const tx = txOf(db);
    const f = path.join(tx, "-tmp-fx", "s1.jsonl");
    writeFileSync(f, JSON.stringify({
      requestId: "req_z", sessionId: "s1", timestamp: "2026-07-10T12:00:00.000Z",
      cwd: "/tmp/fx", isSidechain: false,
      message: { id: "msg_z", model: "claude-opus-5",
                 usage: { input_tokens: 1, output_tokens: 7,
                          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n");
    reingest(db, tx);
    expect(q(db, "SELECT tokens_out FROM claude_requests WHERE request_id='req_z';")).toBe("7");
  });
});

describe("robustness", () => {
  // The "malformed" fixture carries TWO corrupt lines: one with no `"usage"`
  // substring at all (dropped by ingest.sh's `grep '"usage"'` prefilter
  // before jq ever runs), and one that DOES contain `"usage"` -- a truncated
  // record missing its closing braces -- so it genuinely reaches jq and
  // exercises `fromjson? // empty`. Both must be dropped and the good rows
  // must still land.
  //
  // NOTE: `fromjson? // empty` turns out to be belt-and-braces here, not the
  // sole reason bad lines are harmless. jq (run without -e) continues past a
  // parse error on one line to the next by default, and ingest.sh invokes it
  // as `jq ... 2>/dev/null >> "$tsv" || true`, which discards stderr and
  // swallows jq's exit code regardless. So no test in this file pins
  // `fromjson? // empty` as uniquely load-bearing -- only that the pipeline
  // as a whole survives a corrupt line. Do not remove the guard: it is
  // explicit and harmless, and keeping it means correctness does not quietly
  // depend on jq's incidental multi-line error behaviour.
  it("survives a corrupt line inside the usage stream without losing the file's other rows", () => {
    const db = ingestScenario("malformed");
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("2");
    expect(q(db, "SELECT group_concat(request_id) FROM (SELECT request_id FROM claude_requests ORDER BY request_id);"))
      .toBe("req_ok1,req_ok2");
  });

  // The cursors used to be written by a separate sqlite3 call after the upsert,
  // and ingest.sh has no `set -e`, so a failed upsert (a lock held past the
  // timeout, say) still moved every cursor past rows that never landed. The
  // next run resumed after them and they were lost for good. A trigger stands
  // in for the lock: it fails the upsert deterministically.
  it("does not advance the cursor when the upsert fails, so the next run recovers the rows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-ing-failed-upsert-"));
    const tx = path.join(dir, "projects");
    const db = path.join(dir, "db", "fixture.sqlite");
    execFileSync("mkdir", ["-p", tx, path.dirname(db)]);
    execFileSync("bash", [MAKE_TX, "single", tx], { encoding: "utf8" });
    execFileSync("bash", ["-c", '. "$CC_LIB_PATH" && cc_init_db'], {
      env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB },
    });
    q(db, `CREATE TRIGGER planted_failure BEFORE INSERT ON claude_requests
           BEGIN SELECT RAISE(ABORT, 'planted'); END;`);

    reingest(db, tx);
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("0");
    expect(q(db, "SELECT count(*) FROM claude_ingest_cursor;")).toBe("0");

    q(db, "DROP TRIGGER planted_failure;");
    reingest(db, tx);
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("2");
  });

  // Task 1 review M6: the awk split into rows/tools/slash TSVs had its exit
  // status unchecked, so a failed split (disk full, a tmp failure) went on to
  // an upsert of empty TSVs that still committed the cursors -- the lines'
  // rows lost from DURABLE tables until a manual --backfill. A PATH shim fails
  // exactly that awk call (the only one given rowsf=) and runs the real awk
  // for anything else.
  it("does not advance the cursor when the row split fails, so the next run recovers the rows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-ing-failed-split-"));
    const tx = path.join(dir, "projects");
    const db = path.join(dir, "db", "fixture.sqlite");
    const shim = path.join(dir, "shim");
    execFileSync("mkdir", ["-p", tx, path.dirname(db), shim]);
    execFileSync("bash", [MAKE_TX, "single", tx], { encoding: "utf8" });
    const realAwk = execFileSync("sh", ["-c", "command -v awk"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(shim, "awk"),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in rowsf=*) exit 1 ;; esac; done\nexec "${realAwk}" "$@"\n`,
      { mode: 0o755 });
    execFileSync("bash", [INGEST, "--quiet"], {
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, THEONE_DB_PATH: db, CC_LIB_PATH: LIB,
             WATCHTOWER_TRANSCRIPTS_DIR: tx, TZ: "UTC" }, encoding: "utf8" });
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("0");
    expect(q(db, "SELECT count(*) FROM claude_ingest_cursor;")).toBe("0");

    reingest(db, tx);
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("2");
  });

  // Stage 4B: each file's jq output now passes through its own awk, which
  // peels off the EOF carry (the C row) before the rows reach all.tsv. The same
  // rule as the split above: if that awk fails, the file's cursor must not
  // advance past rows that never landed. The shim fails only the awk given cf=.
  it("does not advance a file's cursor when its carry split fails, so the next run recovers the rows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-ing-failed-carry-"));
    const tx = path.join(dir, "projects");
    const db = path.join(dir, "db", "fixture.sqlite");
    const shim = path.join(dir, "shim");
    execFileSync("mkdir", ["-p", tx, path.dirname(db), shim]);
    execFileSync("bash", [MAKE_TX, "single", tx], { encoding: "utf8" });
    const realAwk = execFileSync("sh", ["-c", "command -v awk"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(shim, "awk"),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in cf=*) exit 1 ;; esac; done\nexec "${realAwk}" "$@"\n`,
      { mode: 0o755 });
    execFileSync("bash", [INGEST, "--quiet"], {
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, THEONE_DB_PATH: db, CC_LIB_PATH: LIB,
             WATCHTOWER_TRANSCRIPTS_DIR: tx, TZ: "UTC" }, encoding: "utf8" });
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("0");
    expect(q(db, "SELECT count(*) FROM claude_ingest_cursor;")).toBe("0");

    reingest(db, tx);
    expect(q(db, "SELECT count(*) FROM claude_requests;")).toBe("2");
  });

  it("exits 0 and writes nothing when the transcript dir is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-noTx-"));
    const db = path.join(dir, "fixture.sqlite");
    const out = execFileSync("bash", [INGEST, "--quiet"], {
      env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB,
             WATCHTOWER_TRANSCRIPTS_DIR: path.join(dir, "nope"), TZ: "UTC" },
      encoding: "utf8",
    });
    expect(out).toBe("");
  });
});

/** Build an EMPTY transcript tree (no scenario applied yet) and an empty db. */
function freshTree(label: string): { dir: string; tx: string; db: string } {
  const dir = mkdtempSync(path.join(tmpdir(), `wt-tools-${label}-`));
  const tx = path.join(dir, "projects");
  const dbDir = path.join(dir, "db");
  execFileSync("mkdir", ["-p", tx, dbDir]);
  return { dir, tx, db: path.join(dbDir, "fixture.sqlite") };
}
/** Materialize a scenario's files into an EXISTING transcript tree (does
 *  not wipe files another scenario already placed there — make-transcripts.sh
 *  only ever creates or appends to its own files). */
function addScenario(tx: string, scenario: string): void {
  execFileSync("bash", [MAKE_TX, scenario, tx], { encoding: "utf8" });
}

describe("tool calls and slash commands", () => {
  it("merges a tool_use and its result landing in SEPARATE ingest runs into one row", () => {
    const { tx, db } = freshTree("split");
    addScenario(tx, "tools-split-a");
    reingest(db, tx);
    // Before B arrives: the row exists, name known, is_error still NULL.
    expect(q(db, "SELECT tool_name, is_error FROM claude_tool_calls WHERE tool_use_id='tu_split1';"))
      .toBe("mcp__plugin_x-mcp_y__navigate_page|");

    addScenario(tx, "tools-split-b");
    reingest(db, tx);
    expect(q(db, "SELECT count(*) FROM claude_tool_calls;")).toBe("1");
    expect(q(db, "SELECT tool_name, is_error FROM claude_tool_calls WHERE tool_use_id='tu_split1';"))
      .toBe("mcp__plugin_x-mcp_y__navigate_page|1");
    // The merge for ts/is_sidechain is NULL-aware (CASE WHEN ... IS NULL THEN
    // excluded... ELSE MIN(...) END), not a plain MIN(ts, excluded.ts): the E
    // batch's ts/is_sidechain are both NULL (only the T side ever reports
    // them), and a bare MIN(x, NULL) is NULL in SQLite -- silently erasing the
    // tool_use side's real values instead of keeping them. tools-split-a's
    // tuse call encodes ts 2026-09-10T10:00:00.000Z (1789034400) and
    // sidechain=false (0); tools-split-b's tres call carries neither.
    expect(q(db, "SELECT ts, is_sidechain FROM claude_tool_calls WHERE tool_use_id='tu_split1';"))
      .toBe("1789034400|0");
  });

  it("gives an identical table whichever order the two halves are ingested in", () => {
    const forward = freshTree("order-fwd");
    addScenario(forward.tx, "tools-split-a");
    reingest(forward.db, forward.tx);
    addScenario(forward.tx, "tools-split-b");
    reingest(forward.db, forward.tx);

    const backward = freshTree("order-bwd");
    addScenario(backward.tx, "tools-split-b");
    reingest(backward.db, backward.tx);
    addScenario(backward.tx, "tools-split-a");
    reingest(backward.db, backward.tx);

    const dump = (db: string) =>
      q(db, "SELECT * FROM claude_tool_calls ORDER BY 1;");
    expect(dump(backward.db)).toBe(dump(forward.db));
  });

  it("re-ingesting and --backfill both change the merged row nothing further", () => {
    const { tx, db } = freshTree("split-idem");
    addScenario(tx, "tools-split-a");
    reingest(db, tx);
    addScenario(tx, "tools-split-b");
    reingest(db, tx);
    const before = q(db, "SELECT * FROM claude_tool_calls ORDER BY 1;");

    reingest(db, tx);
    expect(q(db, "SELECT * FROM claude_tool_calls ORDER BY 1;")).toBe(before);

    reingest(db, tx, ["--backfill"]);
    expect(q(db, "SELECT * FROM claude_tool_calls ORDER BY 1;")).toBe(before);
  });

  it("flags a sidechain tool call with is_sidechain = 1", () => {
    const db = ingestScenario("tools-sidechain");
    expect(q(db, "SELECT is_sidechain FROM claude_tool_calls WHERE tool_use_id='tu_side';"))
      .toBe("1");
  });

  it("splits an mcp__ tool name on the FIRST __ boundary", () => {
    const { tx, db } = freshTree("mcp-split");
    addScenario(tx, "tools-split-a");
    reingest(db, tx);
    expect(q(db, "SELECT mcp_server FROM claude_tool_calls WHERE tool_use_id='tu_split1';"))
      .toBe("plugin_x-mcp_y");
  });

  it("slash-mixed records exactly /compact and /model, nothing else", () => {
    const db = ingestScenario("slash-mixed");
    expect(q(db, "SELECT group_concat(command) FROM (SELECT command FROM claude_slash_commands ORDER BY command);"))
      .toBe("/compact,/model");
  });

  it("a tool_use whose result never arrives keeps is_error NULL, not 0", () => {
    const db = ingestScenario("tools-unresolved");
    expect(q(db, "SELECT tool_name, is_error IS NULL FROM claude_tool_calls WHERE tool_use_id='tu_unres';"))
      .toBe("Bash|1");
  });

  it("a corrupt line between a tool_use and its result loses only itself", () => {
    const { tx, db } = freshTree("corrupt");
    execFileSync("mkdir", ["-p", path.join(tx, "-tmp-fx")]);
    const f = path.join(tx, "-tmp-fx", "s1.jsonl");
    writeFileSync(f, "");
    appendFileSync(f, JSON.stringify({
      requestId: "req_cu", sessionId: "s_cu", timestamp: "2026-09-10T10:00:00.000Z",
      cwd: "/tmp/fx", isSidechain: false, type: "assistant",
      message: { id: "msg_cu", model: "claude-opus-5",
                 content: [{ type: "tool_use", id: "tu_cu", name: "Bash", input: {} }],
                 usage: { input_tokens: 1, output_tokens: 1,
                          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + "\n");
    appendFileSync(f, 'THIS IS NOT JSON {{{ "usage"\n');
    appendFileSync(f, JSON.stringify({
      type: "user", sessionId: "s_cu", timestamp: "2026-09-10T10:00:01.000Z",
      isSidechain: false,
      message: { content: [{ type: "tool_result", tool_use_id: "tu_cu", is_error: false, content: "x" }] },
    }) + "\n");
    reingest(db, tx);
    expect(q(db, "SELECT tool_name, is_error FROM claude_tool_calls WHERE tool_use_id='tu_cu';"))
      .toBe("Bash|0");
    expect(q(db, "SELECT count(*) FROM claude_tool_calls;")).toBe("1");
  });

  it("lands a request row and its tool call in the same ingest run", () => {
    const db = ingestScenario("tools-unresolved");
    expect(q(db, "SELECT count(*) FROM claude_requests WHERE request_id='req_unres';")).toBe("1");
    expect(q(db, "SELECT count(*) FROM claude_tool_calls WHERE request_id='req_unres';")).toBe("1");
  });
});

describe("Stage 4B capture", () => {
  const ms = (iso: string) => String(Date.parse(iso));
  /** Every claude_requests column but ingested_at (the run's wall clock). */
  const REQ_COLS =
    "request_id, message_id, session_id, ts, cwd, git_branch, model, effort, service_tier, " +
    "is_sidechain, entrypoint, cc_version, tokens_in, tokens_out, tokens_cache_read, " +
    "tokens_cache_creation, attribution_skill, attribution_mcp_server, attribution_mcp_tool, " +
    "attribution_plugin, api_error_status, first_ms, last_ms, sent_ms, cache_write_5m, " +
    "cache_write_1h, speed";
  const NEW_COLS = "request_id, first_ms, last_ms, sent_ms, cache_write_5m, cache_write_1h, speed";
  const dumpRequests = (db: string, where = "1") =>
    q(db, `SELECT ${REQ_COLS} FROM claude_requests WHERE ${where} ORDER BY request_id;`);
  const dumpPrompts = (db: string) => q(db, "SELECT * FROM claude_prompts ORDER BY entry_uuid;");

  it("lands ms first/last, sent_ms, the cache-write split and speed per request", () => {
    const db = ingestScenario("ms-split");
    // Two partials, .5Z and no fraction: MIN and MAX of their ms; sent_ms is
    // the .120Z prompt before both.
    expect(q(db, "SELECT first_ms, last_ms, sent_ms, cache_write_5m, cache_write_1h, speed FROM claude_requests WHERE request_id='req_m';"))
      .toBe([ms("2026-07-10T10:00:01.500Z"), ms("2026-07-10T10:00:03.000Z"),
             ms("2026-07-10T10:00:00.120Z"), "60", "40", "standard"].join("|"));
    // No cache_creation object and no speed: NULL ("not recorded"), never 0 --
    // and the old total still lands.
    expect(q(db, "SELECT cache_write_5m IS NULL, cache_write_1h IS NULL, speed IS NULL, tokens_cache_creation FROM claude_requests WHERE request_id='req_n';"))
      .toBe("1|1|1|100");
    expect(q(db, "SELECT speed, model FROM claude_requests WHERE request_id='req_f';"))
      .toBe("fast|claude-mystery-9");
  });

  // The prompt lands in one run and its request in the next, resumed from the
  // byte offset: only the cursor's last_user_ms can carry the prompt across.
  // The cursor is advisory, so deleting it and re-reading the whole file must
  // reach the very same values.
  it("carries the last user entry's ms across runs through the cursor, and a deleted cursor converges", () => {
    const { tx, db } = freshTree("sent-cursor");
    addScenario(tx, "sent-cursor-a");
    reingest(db, tx);
    addScenario(tx, "sent-cursor-b");
    reingest(db, tx);
    const u = ms("2026-07-10T11:00:00.250Z");
    expect(q(db, "SELECT sent_ms FROM claude_requests WHERE request_id='req_c';")).toBe(u);
    expect(q(db, "SELECT last_user_ms FROM claude_ingest_cursor WHERE file_path LIKE '%/s2.jsonl';")).toBe(u);

    const before = q(db, `SELECT ${NEW_COLS} FROM claude_requests ORDER BY request_id;`);
    const cursorBefore = q(db, "SELECT last_user_ms FROM claude_ingest_cursor ORDER BY file_path;");
    execFileSync("sqlite3", [db, "DELETE FROM claude_ingest_cursor;"]);
    reingest(db, tx);
    expect(q(db, `SELECT ${NEW_COLS} FROM claude_requests ORDER BY request_id;`)).toBe(before);
    expect(q(db, "SELECT last_user_ms FROM claude_ingest_cursor ORDER BY file_path;")).toBe(cursorBefore);
  });

  it("keeps sent_ms on the prompt when a tool result lands between two partials", () => {
    const db = ingestScenario("sent-midstream");
    expect(q(db, "SELECT sent_ms FROM claude_requests WHERE request_id='req_s';"))
      .toBe(ms("2026-07-10T12:00:00.000Z"));
  });

  it("leaves sent_ms NULL for a transcript that starts mid-turn, and still times the request", () => {
    const db = ingestScenario("mid-turn");
    expect(q(db, "SELECT sent_ms IS NULL, first_ms, last_ms FROM claude_requests WHERE request_id='req_mt';"))
      .toBe(["1", ms("2026-07-10T13:00:01.000Z"), ms("2026-07-10T13:00:01.000Z")].join("|"));
  });

  // Every kind's prefix, and five user entries that are not boundaries: meta,
  // a tool result, a sidechain, and (plan P5) null and absent content.
  it("records exactly the eleven turn boundaries, each with its kind", () => {
    const db = ingestScenario("turn-kinds");
    const at = (s: number) => ms(`2026-09-10T09:00:${String(s).padStart(2, "0")}.000Z`);
    expect(q(db, "SELECT entry_uuid, session_id, ts_ms, kind FROM claude_prompts ORDER BY ts_ms;"))
      .toBe([
        `u_prompt|s_k|${at(0)}|prompt`,
        `u_array|s_k|${at(1)}|prompt`,
        `u_cmd|s_k|${at(2)}|command`,
        `u_cmsg|s_k|${at(3)}|command`,
        `u_note|s_k|${at(4)}|notification`,
        `u_lstd|s_k|${at(5)}|local`,
        `u_lerr|s_k|${at(6)}|local`,
        `u_bash|s_k|${at(7)}|local`,
        `u_bout|s_k|${at(8)}|local`,
        `u_berr|s_k|${at(9)}|local`,
        `u_int|s_k|${at(10)}|interrupt`,
      ].join("\n"));
  });

  // order-x and order-y each carry a copy of req_q, so its row is built by
  // the cross-run ON CONFLICT merge -- once in each order. Every new column
  // must come out the same either way, and at its rule's value: first_ms and
  // sent_ms the MIN, last_ms and the split the MAX, speed whichever copy has it.
  // req_q's `ts` is left out on purpose: since Stage 2 it is MIN within a run
  // but FIRST ARRIVAL across runs (ON CONFLICT never touches it), so the two
  // orders legitimately store 15:00:02 and 15:00:03. That is pre-4B behaviour,
  // not a v6 merge, and in append order the first arrival is the earliest.
  it("converges on identical tables whichever order two files sharing a request arrive in, and on replay", () => {
    const a = freshTree("order-a");
    addScenario(a.tx, "ms-split");
    addScenario(a.tx, "order-x");
    reingest(a.db, a.tx);
    addScenario(a.tx, "turn-kinds");
    addScenario(a.tx, "order-y");
    reingest(a.db, a.tx);

    const b = freshTree("order-b");
    addScenario(b.tx, "turn-kinds");
    addScenario(b.tx, "order-y");
    reingest(b.db, b.tx);
    addScenario(b.tx, "ms-split");
    addScenario(b.tx, "order-x");
    reingest(b.db, b.tx);

    const reqQ = (db: string) =>
      q(db, `SELECT ${NEW_COLS}, tokens_out FROM claude_requests WHERE request_id='req_q';`);
    const expected = ["req_q", ms("2026-07-10T15:00:02.000Z"), ms("2026-07-10T15:00:03.000Z"),
                      ms("2026-07-10T15:00:00.000Z"), "70", "50", "standard", "900"].join("|");
    expect(`a: ${reqQ(a.db)}`).toBe(`a: ${expected}`);
    expect(`b: ${reqQ(b.db)}`).toBe(`b: ${expected}`);
    expect(dumpRequests(b.db, "request_id <> 'req_q'")).toBe(dumpRequests(a.db, "request_id <> 'req_q'"));
    expect(dumpPrompts(b.db)).toBe(dumpPrompts(a.db));

    const requests = dumpRequests(a.db);
    const prompts = dumpPrompts(a.db);
    reingest(a.db, a.tx);
    reingest(a.db, a.tx, ["--backfill"]);
    expect(dumpRequests(a.db)).toBe(requests);
    expect(dumpPrompts(a.db)).toBe(prompts);
  });

  // M5: the boundaries commit in the SAME transaction as the requests and the
  // cursors. A trigger stands in for any failure of the claude_prompts insert,
  // as in "does not advance the cursor when the upsert fails".
  it("rolls back the requests and the cursors when the claude_prompts insert fails", () => {
    const { tx, db } = freshTree("prompts-fail");
    addScenario(tx, "turn-kinds");
    addScenario(tx, "single");
    execFileSync("bash", ["-c", '. "$CC_LIB_PATH" && cc_init_db'], {
      env: { ...process.env, THEONE_DB_PATH: db, CC_LIB_PATH: LIB },
    });
    q(db, `CREATE TRIGGER planted_failure BEFORE INSERT ON claude_prompts
           BEGIN SELECT RAISE(ABORT, 'planted'); END;`);

    reingest(db, tx);
    expect(q(db, "SELECT (SELECT count(*) FROM claude_requests), (SELECT count(*) FROM claude_prompts), (SELECT count(*) FROM claude_ingest_cursor);"))
      .toBe("0|0|0");

    q(db, "DROP TRIGGER planted_failure;");
    reingest(db, tx);
    // The rows land. (Which entries count as boundaries is the turn-kinds
    // test's job, so this checks one plain prompt rather than the total.)
    expect(q(db, "SELECT (SELECT count(*) FROM claude_requests), (SELECT count(*) FROM claude_prompts WHERE entry_uuid='u_prompt'), (SELECT count(*) FROM claude_ingest_cursor);"))
      .toBe("2|1|2");
  });

  // Review round 1, Important 2 (a): one request's partials in TWO runs. Run 2
  // resumes after a tool result, so its partial carries a later sent_ms, a
  // later ms and a larger split; only ON CONFLICT can merge the two runs.
  it("merges a request's partials across runs: MIN first_ms and sent_ms, MAX last_ms and split", () => {
    const { tx, db } = freshTree("xrun");
    addScenario(tx, "xrun-a");
    reingest(db, tx);
    addScenario(tx, "xrun-b");
    reingest(db, tx);
    expect(q(db, `SELECT ${NEW_COLS} FROM claude_requests WHERE request_id='req_x';`))
      .toBe(["req_x", ms("2026-07-10T14:00:01.000Z"), ms("2026-07-10T14:00:03.000Z"),
             ms("2026-07-10T14:00:00.000Z"), "90", "60", "standard"].join("|"));
  });

  // Review round 1, Important 2 (b): the shape every row has after the v6
  // upgrade -- all six columns NULL -- and the rollout --backfill that must
  // fill them. A scalar MIN(x, NULL) is NULL in SQLite, so only the NULL-aware
  // CASE merge lets the backfill land.
  it("fills the new columns of a pre-v6 (all-NULL) row on --backfill", () => {
    const db = ingestScenario("ms-split");
    const filled = q(db, `SELECT ${NEW_COLS} FROM claude_requests ORDER BY request_id;`);
    q(db, `UPDATE claude_requests SET first_ms=NULL, last_ms=NULL, sent_ms=NULL,
           cache_write_5m=NULL, cache_write_1h=NULL, speed=NULL;`);
    expect(q(db, "SELECT count(*) FROM claude_requests WHERE COALESCE(first_ms, last_ms, sent_ms, cache_write_5m, cache_write_1h, speed) IS NOT NULL;"))
      .toBe("0");
    reingest(db, txOf(db), ["--backfill"]);
    expect(q(db, `SELECT ${NEW_COLS} FROM claude_requests ORDER BY request_id;`)).toBe(filled);
  });

  // Review round 1, Important 3: a forked session repeats a boundary uuid AND
  // its requests under a different sessionId. claude_prompts.session_id must
  // follow claude_requests.session_id's rule (MAX within a batch, first
  // arrival across batches), or which file find returns first decides it and a
  // boundary disagrees with its own requests. Both sessionId placements run.
  it("gives a forked boundary the same session_id as its request, whichever file is read first", () => {
    for (const scenario of ["forked-uuid", "forked-uuid-swapped"]) {
      const db = ingestScenario(scenario);
      expect(`${scenario}: ${q(db, `SELECT p.session_id, r.session_id FROM claude_prompts p, claude_requests r
                                    WHERE p.entry_uuid='u_fork' AND r.request_id='req_fork';`)}`)
        .toBe(`${scenario}: s_fork_b|s_fork_b`);
    }
  });

  // Review round 1, Minor 2: jq emits the C row even on empty input, so a
  // file with no C row is a file whose jq failed. Its cursor must not advance
  // past rows that never landed; the other files must still land. The shim
  // fails jq for s4.jsonl's run only.
  it("does not advance the cursor of a file whose jq failed, and still lands the others", () => {
    const { dir, tx, db } = freshTree("jq-fail");
    addScenario(tx, "single");
    addScenario(tx, "mid-turn");
    const shim = path.join(dir, "shim");
    execFileSync("mkdir", ["-p", shim]);
    const realJq = execFileSync("sh", ["-c", "command -v jq"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(shim, "jq"),
      `#!/bin/sh\nin=$(mktemp)\ncat > "$in"\nif grep -q '"sessionId":"s4"' "$in"; then rm -f "$in"; exit 5; fi\n` +
      `"${realJq}" "$@" < "$in"; rc=$?\nrm -f "$in"\nexit $rc\n`,
      { mode: 0o755 });
    execFileSync("bash", [INGEST, "--quiet"], {
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, THEONE_DB_PATH: db, CC_LIB_PATH: LIB,
             WATCHTOWER_TRANSCRIPTS_DIR: tx, TZ: "UTC" }, encoding: "utf8" });
    expect(q(db, "SELECT group_concat(request_id) FROM (SELECT request_id FROM claude_requests ORDER BY 1);"))
      .toBe("req_a,req_b");
    expect(q(db, "SELECT count(*) FROM claude_ingest_cursor WHERE file_path LIKE '%/s4.jsonl';")).toBe("0");
    expect(q(db, "SELECT count(*) FROM claude_ingest_cursor WHERE file_path LIKE '%/s1.jsonl';")).toBe("1");

    reingest(db, tx);
    expect(q(db, "SELECT count(*) FROM claude_requests WHERE request_id='req_mt';")).toBe("1");
  });

  // Review round 1, Minor 4: tool_use blocks are read from assistant entries
  // only (the M8 gate). The line's request still lands; its tool call does not.
  it("takes no tool call from a tool_use block on a non-assistant line", () => {
    const db = ingestScenario("tools-untyped");
    expect(q(db, "SELECT (SELECT count(*) FROM claude_requests WHERE request_id='req_untyped'), (SELECT count(*) FROM claude_tool_calls);"))
      .toBe("1|0");
  });
});
