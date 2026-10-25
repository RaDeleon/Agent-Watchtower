import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAndRoll, rows } from "./helpers/fixture-db";
import { createClaudeAdapter } from "@/lib/adapters/claude";
import { runSync } from "@/lib/core/sync";
import type { WatchtowerAdapter } from "@/lib/core/adapters";
import type { WatchtowerRecord } from "@/lib/core/records";

const ROOT = path.resolve(__dirname, "..");
/** The CLI must never read the real ~/.codex or ~/.hermes. */
const tempHome = () => mkdtempSync(path.join(tmpdir(), "wt-home-"));

describe("runSync", () => {
  it("applies the schema, registers the source and fills wt_requests", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    const summary = await runSync({ db, adapters: [createClaudeAdapter({ db })] });

    expect(summary.length).toBe(1);
    expect(summary[0].source).toBe("claude");
    expect(summary[0].ingested).toBeGreaterThan(0);
    expect(summary[0].malformed).toBe(0);

    const src = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM claude_requests;")[0].n;
    const out = rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests;")[0].n;
    // Both the source count and the output count are pinned to a real number
    // (the orphan-request-tokens fixture carries exactly 2 requests), so this
    // cannot pass by both sides being zero.
    expect(src).toBe(2);
    expect(out).toBe(src);
  });

  it("is idempotent: a second run changes no row count and no data", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    const count = () => rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests;")[0].n;
    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    const first = count();
    const snapshot = rows<Record<string, unknown>>(
      db, "SELECT * FROM wt_requests ORDER BY source_record_id;");
    expect(first).toBeGreaterThan(0);

    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    expect(count()).toBe(first);
    expect(rows<Record<string, unknown>>(
      db, "SELECT * FROM wt_requests ORDER BY source_record_id;")).toEqual(snapshot);
  });

  it("writes nothing on a second run over unchanged data", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    const first = await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    const second = await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    expect(first[0].ingested).toBeGreaterThan(0);
    expect(second[0].ingested).toBe(0);
    expect(second[0].unchanged).toBe(first[0].ingested);
  });

  /**
   * Why sync compares fingerprints instead of keeping a cursor: Claude's rows
   * change IN PLACE. ingest.sh raises token counts on an existing request_id,
   * and rollup.sh resolves a cwd's project months after the request landed.
   * A "rows since last time" cursor sees neither.
   */
  it("picks up a request whose tokens were raised in place", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    execFileSync("sqlite3", [db,
      "UPDATE claude_requests SET tokens_out = 4321 WHERE request_id = 'r_live';"]);

    const s = await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    expect(s[0].ingested).toBeGreaterThan(0);
    expect(rows<{ tokens_out: number }>(db,
      "SELECT tokens_out FROM wt_requests WHERE source_record_id = 'r_live';"))
      .toEqual([{ tokens_out: 4321 }]);
  });

  it("picks up a project path resolved after the first sync", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO claude_project_paths
      (cwd, project_path, resolved_at, source) VALUES ('/tmp/fx', '/tmp/fx-repo', 0, 'git');`]);

    await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    expect(rows<{ project: string }>(db,
      "SELECT project FROM wt_requests WHERE source_record_id = 'r_live';"))
      .toEqual([{ project: "/tmp/fx-repo" }]);
  });

  it("rejects nothing when Claude is the only source", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    const s = await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    // Every metric Claude emits is one it owns. A rejection here means the
    // authority declaration and the generators disagree.
    expect(s[0].ingested).toBeGreaterThan(0);
    expect(s[0].metricsRejected).toBe(0);
  });

  it("skips a source the caller does not pass, even if enabled elsewhere", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    const summary = await runSync({ db, adapters: [] });
    expect(summary).toEqual([]);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests;")[0].n).toBe(0);
  });
});

describe("watchtower sync", () => {
  it("runs end to end against a real database and prints a JSON summary", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const out = execFileSync("node", [path.join(ROOT, "bin", "watchtower"), "sync"], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db, HOME: tempHome() },
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    expect(parsed.sources[0].source).toBe("claude");
    expect(parsed.sources[0].ingested).toBeGreaterThan(0);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests;")[0].n).toBe(2);
  });

  it("--quiet prints nothing and still syncs", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const out = execFileSync("node",
      [path.join(ROOT, "bin", "watchtower"), "sync", "--quiet"], {
        env: { ...process.env, WATCHTOWER_DB_PATH: db, HOME: tempHome() }, encoding: "utf8",
      });
    expect(out).toBe("");
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests;")[0].n)
      .toBeGreaterThan(0);
  });

  it("prints rollup { ran: false, ok: true } when no rollup is installed", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const env: NodeJS.ProcessEnv = { ...process.env, WATCHTOWER_DB_PATH: db, HOME: tempHome() };
    delete env.WATCHTOWER_ROLLUP_PATH; delete env.CC_LIB_PATH;
    const parsed = JSON.parse(execFileSync("node", [path.join(ROOT, "bin", "watchtower"), "sync"], { env, encoding: "utf8" }));
    expect(parsed.rollup).toMatchObject({ ran: false, ok: true });
    expect(typeof parsed.rollup.script).toBe("string");
  });

  it("runs the rollup the paths point at", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const out = execFileSync("node", [path.join(ROOT, "bin", "watchtower"), "sync"], {
      env: {
        ...process.env, WATCHTOWER_DB_PATH: db, HOME: tempHome(), TZ: "UTC",
        WATCHTOWER_ROLLUP_PATH: path.join(ROOT, "capture", "rollup.sh"),
        CC_LIB_PATH: path.join(ROOT, "capture", "lib.sh"),
      },
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    expect(parsed.rollup.ran).toBe(true);
    expect(parsed.rollup.ok).toBe(true);
  });

  it("--no-rollup prints no rollup key", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const out = execFileSync("node", [path.join(ROOT, "bin", "watchtower"), "sync", "--no-rollup"], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db, HOME: tempHome() }, encoding: "utf8",
    });
    expect("rollup" in JSON.parse(out)).toBe(false);
  });

  // RF4: one source's failure is a failed sync, but not a lost one.
  it("exits 1 after printing the summary when a source fails, and the others still sync", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const home = tempHome();
    mkdirSync(path.join(home, ".hermes"));
    writeFileSync(path.join(home, ".hermes", "state.db"), "not a database\n");
    const r = spawnSync("node", [path.join(ROOT, "bin", "watchtower"), "sync", "--no-rollup"], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db, HOME: home }, encoding: "utf8",
    });
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    const by = (id: string) => parsed.sources.find((s: { source: string }) => s.source === id);
    expect(typeof by("hermes").error).toBe("string");
    expect(by("claude").ingested).toBeGreaterThan(0);
  });

  it("skips a source disabled in the config file", () => {
    const db = buildAndRoll("orphan-request-tokens");
    const cwd = mkdtempSync(path.join(tmpdir(), "wt-cfg-"));
    writeFileSync(path.join(cwd, "watchtower.config.json"),
      JSON.stringify({ sources: { claude: { enabled: false } } }));

    const out = execFileSync("node", [path.join(ROOT, "bin", "watchtower"), "sync"], {
      cwd, env: { ...process.env, WATCHTOWER_DB_PATH: db, HOME: tempHome() }, encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    // No adapters were passed to runSync at all -- not "ran but ingested
    // nothing" -- so a disabled source cannot leave stale wt_ingest_state
    // behind either.
    expect(parsed.sources).toEqual([]);
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests;")[0].n).toBe(0);
  });
});

/**
 * Its own directory, every time. Both schema markers (`.schema-vN` from
 * capture/lib.sh and `.wt-schema-vN` from lib/core/schema.ts) live in the
 * DATABASE'S directory, so two databases sharing one directory share a marker
 * and the second silently gets no schema.
 */
function freshDir(tag: string): string {
  return mkdtempSync(path.join(tmpdir(), `wt-${tag}-`));
}

describe("runSync against a source that is not there", () => {
  /**
   * THE FIRST-RUN CRASH.
   *
   * Before this, `WATCHTOWER_DB_PATH=<new path> watchtower sync` died inside
   * the adapter's first paged read with `no such table: claude_sessions` and
   * an unhandled Node stack, exit 1. detect() had returned the right answer
   * since Task 6 and safeDetect had enforced the never-throws contract since
   * Task 6 -- runSync called neither, so both were dead code outside tests.
   */
  it("reports a brand-new database as not detected instead of throwing", async () => {
    const db = path.join(freshDir("fresh"), "new.sqlite");
    const summary = await runSync({ db, adapters: [createClaudeAdapter({ db })] });

    expect(summary).toEqual([{
      source: "claude",
      detected: false,
      detail: `no database at ${db}`,
      ingested: 0,
      unchanged: 0,
      metricsRejected: 0,
      malformed: 0,
    }]);

    // The wt_* schema is still applied: it is this database's OUTPUT side, and
    // a reader must find its tables whether or not a source had data today.
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_requests;")[0].n).toBe(0);
    // An undetected source is NOT registered. Registering one would park an
    // absent source's authority claims on metrics it cannot supply.
    expect(rows<{ n: number }>(db, "SELECT COUNT(*) AS n FROM wt_sources;")[0].n).toBe(0);
  });

  it("reports a database that exists but has no claude_* tables", async () => {
    const db = path.join(freshDir("noclaude"), "other.sqlite");
    execFileSync("sqlite3", [db, "CREATE TABLE unrelated (a INTEGER);"]);

    const summary = await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    expect(summary[0].detected).toBe(false);
    expect(summary[0].detail).toBe("no claude_* tables");
    expect(summary[0].ingested).toBe(0);
    // The unrelated database is not touched beyond gaining the wt_* tables.
    expect(rows<{ n: number }>(db,
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'unrelated';")[0].n).toBe(1);
  });

  it("a detected source still reports detected:true and the database it read", async () => {
    // Otherwise the two cases above could pass with detect() hard-wired false.
    const db = buildAndRoll("orphan-request-tokens");
    const summary = await runSync({ db, adapters: [createClaudeAdapter({ db })] });
    expect(summary[0].detected).toBe(true);
    expect(summary[0].detail).toBe(db);
    expect(summary[0].ingested).toBeGreaterThan(0);
  });

  /**
   * A destination that cannot be written is a REAL failure, unlike an absent
   * source -- but it is still worth one sentence. applyWtSchema's statement is
   * the whole wt_* DDL, so execFileSync's own message wraps sqlite3's one-line
   * complaint in a hundred lines of CREATE TABLE.
   */
  it("fails with one legible line, not a stack or the whole DDL", () => {
    const db = path.join(freshDir("cli-bad"), "bad.sqlite");
    writeFileSync(db, "this is not a database, it is a sentence\n");

    let status = 0;
    let stderr = "";
    try {
      execFileSync("node", [path.join(ROOT, "bin", "watchtower"), "sync"], {
        env: { ...process.env, WATCHTOWER_DB_PATH: db, HOME: tempHome() },
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      status = err.status ?? 0;
      stderr = String(err.stderr ?? "");
    }

    expect(status).toBe(2);
    expect(stderr).toContain("sync failed on");
    expect(stderr).toContain("file is not a database");
    expect(stderr).not.toContain("CREATE TABLE");     // not the whole statement
    expect(stderr).not.toContain("at querySql");      // not a Node stack
  });

  it("exits 0 from the CLI on a brand-new database and says why", () => {
    const db = path.join(freshDir("cli-fresh"), "new.sqlite");
    // execFileSync throws on a non-zero exit, so reaching the parse IS the
    // exit-0 assertion; this used to exit 1 with a stack on stderr.
    const out = execFileSync("node", [path.join(ROOT, "bin", "watchtower"), "sync"], {
      env: { ...process.env, WATCHTOWER_DB_PATH: db, HOME: tempHome() }, encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    const claude = parsed.sources.find((s: { source: string }) => s.source === "claude");
    expect(claude.detected).toBe(false);
    expect(String(claude.detail)).toContain("no database at");
  });
});

describe("runSync streams the adapter", () => {
  /**
   * THE PAGING FIX, END TO END.
   *
   * tests/claude-records-scale.test.ts asserts the generators "read lazily, so
   * an unbounded table never lands in memory whole" -- and runSync used to
   * drain every record into a WatchtowerRecord[] before ingesting any of them,
   * putting the whole archive straight back on the heap. Counts alone cannot
   * tell the two apart, so this observes WHEN the writes happen relative to
   * the reads: at most one chunk may be held before it is written.
   */
  it("writes each chunk before pulling past it, rather than draining first", async () => {
    const db = buildAndRoll("orphan-request-tokens");
    const N = 5;
    const writtenWhenProduced: number[] = [];

    const adapter: WatchtowerAdapter = {
      id: "fxstream",
      type: "agent",
      label: "fx stream",
      version: 1,
      capabilities: [],
      authority: [],
      async detect() { return { detected: true, detail: db }; },
      async health() { return { state: "ok" }; },
      async *ingest(): AsyncIterable<WatchtowerRecord> {
        for (let i = 1; i <= N; i++) {
          writtenWhenProduced.push(rows<{ n: number }>(db,
            "SELECT COUNT(*) AS n FROM wt_requests WHERE source = 'fxstream';")[0].n);
          yield {
            source: "fxstream",
            sourceRecordId: `fx${i}`,
            kind: "request",
            timestamp: new Date(1750000000000 + i * 1000).toISOString(),
            authority: "authoritative",
            schemaVersion: 1,
          };
        }
      },
    };

    const summary = await runSync({ db, adapters: [adapter], chunkSize: 2 });
    expect(summary[0].ingested).toBe(N);
    expect(rows<{ n: number }>(db,
      "SELECT COUNT(*) AS n FROM wt_requests WHERE source = 'fxstream';")[0].n).toBe(N);

    // Chunks of 2: records 1-2 are written before record 3 is produced, 3-4
    // before record 5. Draining the generator first gives [0, 0, 0, 0, 0].
    expect(writtenWhenProduced).toEqual([0, 0, 2, 2, 4]);
  });
});

describe("per-adapter isolation (R17)", () => {
  const fake = (id: string, over: Partial<WatchtowerAdapter> = {}, recs: WatchtowerRecord[] = []): WatchtowerAdapter => ({
    id, type: "agent", label: id, version: 1, capabilities: ["requests"],
    authority: [{ kind: "request", metrics: ["tokens_in"], scope: "own" }],
    async detect() { return { detected: true }; },
    async health() { return { state: "ok" }; },
    async *ingest() { yield* recs; },
    ...over,
  });
  const req = (source: string, id: string, timestamp: string): WatchtowerRecord => ({
    recordVersion: 1, source, sourceRecordId: id, kind: "request", timestamp,
    metrics: { tokens_in: 5 },
  } as unknown as WatchtowerRecord);
  const dbOf = () => {
    const db = path.join(mkdtempSync(path.join(tmpdir(), "wtiso-")), "t.sqlite");
    return db;
  };
  const state = (db: string, s: string) => rows<Record<string, unknown>>(
    db, `SELECT * FROM wt_ingest_state WHERE source = '${s}';`)[0];

  it("a throwing source is degraded and reported; its neighbour still ingests", async () => {
    const db = dbOf();
    const boom = fake("boom", {
      async *ingest() { yield req("boom", "a", "2026-09-15T10:00:00Z"); throw new Error("boom\nsecond line"); },
    });
    const good = fake("good", {}, [req("good", "g1", "2026-09-15T10:00:00Z")]);
    const out = await runSync({ db, adapters: [boom, good] });
    expect(out[0]).toMatchObject({ source: "boom", detected: true, error: "boom" });
    expect(state(db, "boom")).toMatchObject({ health: "degraded", last_error: "boom" });
    expect(out[1].error).toBeUndefined();
    expect(out[1].ingested).toBe(1);
  });

  it("finish() malformed lines are added; last_ok_at stays set", async () => {
    const db = dbOf();
    const a = fake("fin", { finish: () => ({ malformed: 2, detail: "2 bad" }) },
      [req("fin", "a", "2026-09-15T10:00:00Z")]);
    const out = await runSync({ db, adapters: [a] });
    expect(out[0].malformed).toBe(2);
    expect(state(db, "fin")).toMatchObject({ records_malformed: 2, health: "degraded" });
    expect(state(db, "fin").last_ok_at).not.toBeNull();
  });

  it("finish() gets clean false when a record failed to write", async () => {
    const db = dbOf();
    let seen: boolean | undefined;
    const a = fake("fin", { finish: ({ clean }) => { seen = clean; return { malformed: 0 }; } },
      [req("fin", "bad", "2026-09-15T10:00:00")]);
    await runSync({ db, adapters: [a] });
    expect(seen).toBe(false);
  });
});
