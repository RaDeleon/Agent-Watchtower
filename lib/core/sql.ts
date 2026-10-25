import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Quote a string as a SQL literal. Doubling the apostrophe is the whole job.
 *
 * capture/lib.sh's cc_sqlstr carried a real data-loss bug here that stayed
 * invisible because the fixtures did their own quoting. This one is tested
 * directly and round-tripped through sqlite3.
 */
export function sqlStr(v: string | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  return `'${v.replace(/'/g, "''")}'`;
}

/** Numbers only. undefined/null -> NULL, because absent is not zero. */
export function sqlNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  if (!Number.isFinite(v)) throw new Error(`sqlNum: value must be finite, got ${v}`);
  return String(v);
}

/**
 * Explicit ceiling on the output captured from a sqlite3 child process.
 *
 * Node's default is 1 MiB, and that default is what broke `watchtower sync` on
 * the real archive. claudeRequestRecords issued ONE SELECT over all of
 * claude_requests; sqlite3's -json rendering of it measured 9,895,624 bytes --
 * 9.4x the default -- so spawnSync aborted the child with SIGPIPE and threw a
 * bare ENOBUFS, and wt_requests was left at 0. Nothing was projected at all.
 * Every fixture in the suite held a handful of rows, so 333 tests passed while
 * measuring the code against data too small to reach the limit.
 *
 * 64 MiB is chosen to be UNREACHABLE by a correctly paged query rather than
 * merely bigger than today's archive -- a ceiling picked to fit current data is
 * the same bug again, one growth spurt later. The generators now read in
 * SQL_PAGE_SIZE-row pages, whose fattest measured rendering is ~1.8 MB: a 35x
 * margin that a row would have to average 13 KB to close.
 *
 * It is still a bound, deliberately. A runaway query fails here rather than
 * consuming the machine's memory, and an archive cannot grow its way past a
 * limit that no longer scales with it.
 */
export const SQLITE_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Turn a maxBuffer overrun into something a human can act on.
 *
 * Raising the ceiling does NOT by itself make an overflow legible: Node reports
 * a maxBuffer overrun as `spawnSync sqlite3 ENOBUFS` whatever the limit is,
 * naming neither the database, the statement, nor the size it exceeded. The
 * original failure cost real time precisely because the message said none of
 * those things. Anything that reaches SQLITE_MAX_BUFFER is re-thrown saying all
 * three, and says what to do about it -- page the read, do not raise the roof.
 *
 * Returns undefined for every other error, so a genuine SQL error still
 * propagates verbatim and is never masked by this wrapper.
 */
function bufferOverflow(e: unknown, db: string, sql: string): Error | undefined {
  if ((e as { code?: string } | null)?.code !== "ENOBUFS") return undefined;
  const excerpt = sql.trim().replace(/\s+/g, " ").slice(0, 160);
  return new Error(
    `sqlite3 output exceeded maxBuffer (${SQLITE_MAX_BUFFER} bytes) on ${db}. ` +
    `Read this query in pages instead of raising the ceiling -- see pagedRows. ` +
    `SQL: ${excerpt}`,
  );
}

/**
 * Run statements that return nothing. Errors are LOUD -- this is not the hook path.
 *
 * maxBuffer is set here too even though stdout is discarded, because stderr is
 * piped and IS capped by it: a sqlite3 error message long enough to overrun the
 * default would surface as ENOBUFS and hide the SQL error that actually caused
 * it. That is a small risk, but it is the failure mode where a legible message
 * matters most, so it costs nothing to close.
 *
 * Note that the ceiling does not bound this function's INPUT. The statement
 * rides in argv, so it is bounded by ARG_MAX (1 MiB on macOS, shared with the
 * environment), not by maxBuffer. Batches of statements go through
 * execSqlBatch, which feeds sqlite3 on stdin for exactly that reason.
 */
export function execSql(db: string, sql: string): void {
  try {
    execFileSync("sqlite3", ["-cmd", ".timeout 8000", "-cmd", ".bail on", db, sql], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: SQLITE_MAX_BUFFER,
    });
  } catch (e) {
    throw bufferOverflow(e, db, sql) ?? e;
  }
}

/**
 * Run many statements in ONE sqlite3 process, fed on stdin, as ONE transaction.
 *
 * This is what makes sync fast. Spawning sqlite3 costs milliseconds, and the
 * old ingest path spawned several per record -- ~852s to re-project 44,515
 * records. Batching turns that into one spawn per chunk.
 *
 * stdin, not argv: a batch is far larger than ARG_MAX (see execSql).
 *
 * All or nothing. `.bail on` stops at the first failing statement, and sqlite3
 * exiting with the transaction still open rolls it back, so a failed batch
 * leaves no partial writes behind for a retry to trip over.
 *
 * BEGIN IMMEDIATE takes the write lock up front, under the busy timeout, rather
 * than failing to upgrade a read lock halfway through the batch.
 */
export function execSqlBatch(db: string, statements: string[]): void {
  if (statements.length === 0) return;
  const script = `BEGIN IMMEDIATE;\n${statements.join("\n")}\nCOMMIT;\n`;
  try {
    execFileSync("sqlite3", ["-cmd", ".timeout 8000", "-cmd", ".bail on", db], {
      input: script,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "pipe"],
      maxBuffer: SQLITE_MAX_BUFFER,
    });
  } catch (e) {
    throw bufferOverflow(e, db, statements[0]) ?? e;
  }
}

/**
 * Run a SELECT and parse -json output.
 *
 * stdio is explicit because execFileSync without it echoes the child's stderr
 * to ours, so a caller that catches a failed probe still prints sqlite3's
 * message. Piped, the message stays on the thrown error's `stderr`.
 */
export function querySql<T>(db: string, sql: string, opts: { readonly?: boolean } = {}): T[] {
  const run = (flags: string[]): string =>
    execFileSync("sqlite3", ["-cmd", ".timeout 8000", ...flags, "-json", db, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: SQLITE_MAX_BUFFER,
    });

  let out: string;
  try {
    // `-readonly` goes before the filename, and it is how the dashboard keeps
    // its promise never to write: sqlite3 enforces it, rather than a reviewer
    // having to check every SELECT. Sync leaves it off -- it writes.
    out = run(opts.readonly === true ? ["-readonly"] : []);
  } catch (e) {
    // A WAL database whose -shm file is absent CANNOT be opened read-only:
    // building the WAL index is itself a write, and sqlite3 fails with
    // "unable to open database file (14)". SQLite deletes -shm when the last
    // connection closes cleanly, so this is the state the database is in
    // whenever no hook is running -- i.e. exactly when someone opens the
    // dashboard while not working. Measured on a .backup copy: read-only open
    // fails, normal open succeeds and creates the -shm.
    //
    // The fallback opens normally but with `query_only`, so writes are still
    // refused by sqlite3 -- what changes is the WAL index, not the data. It is
    // gated on the file EXISTING, because a normal open would otherwise create
    // an empty database, which is the one write that must never happen.
    const stderr = e && typeof e === "object" && "stderr" in e ? String((e as { stderr: unknown }).stderr) : "";
    const missingWalIndex = opts.readonly === true && /unable to open database file/.test(stderr) && existsSync(db);
    if (!missingWalIndex) throw bufferOverflow(e, db, sql) ?? e;
    try {
      out = run(["-cmd", "PRAGMA query_only=1"]);
    } catch (e2) {
      throw bufferOverflow(e2, db, sql) ?? e2;
    }
  }
  return out.trim() === "" ? [] : (JSON.parse(out) as T[]);
}

/**
 * Rows drawn per query by every generator that reads a whole table.
 *
 * Paging bounds a query's output in ROWS; SQLITE_MAX_BUFFER bounds it in BYTES.
 * 5,000 is picked so the two can never meet. The fattest of these queries on
 * the live archive renders 9,895,624 bytes across 27,165 rows -- ~364 bytes a
 * row -- so a 5,000-row page is ~1.8 MB, leaving a 35x margin under the 64 MiB
 * ceiling that the average row would have to reach 13 KB to close.
 *
 * Neither number is load-bearing alone. What matters is that the page COUNT
 * grows with the archive while the page SIZE does not, so no amount of history
 * moves a read closer to the limit. 5,000 also keeps the whole live archive to
 * six queries rather than one, which is not a cost worth optimising.
 */
export const SQL_PAGE_SIZE = 5000;

/**
 * Refuse SQL that would make `${sql} LIMIT n OFFSET m` mean something other
 * than what it looks like.
 *
 * pagedRows appends its LIMIT/OFFSET clause as raw text after `sql`, with no
 * parser in between. Three shapes of input make that appended text land
 * somewhere other than where it reads:
 *
 * - A trailing `--` line comment: the appended `LIMIT n OFFSET m` lands
 *   INSIDE the comment and is never seen by sqlite3. Every page then re-runs
 *   the query unpaged, `page.length < pageSize` is never true, and the
 *   generator yields the full result set forever -- reproduced directly:
 *   `pagedRows(db, "SELECT i FROM t ORDER BY i -- trailing comment", 5)` over
 *   a 20-row table yielded 200+ duplicate rows before being interrupted.
 * - An unclosed `/* block comment *\/`: same failure, different spelling.
 * - A trailing semicolon: sqlite3's CLI accepts `...; LIMIT 5 OFFSET 0;` as
 *   two statements, running the LIMIT/OFFSET as a no-op SELECT and returning
 *   the unpaged result on every page -- the same infinite duplication.
 *
 * This codebase's SQL lives inside unusually dense explanatory comments (see
 * this very file), so appending `-- why this filter` to the last line of a
 * paged query is a plausible future edit, not a contrived one. DO NOT delete
 * this guard as paranoia: it is the difference between that edit throwing a
 * clear error here and it hanging a sync while flooding wt_* with duplicates.
 */
function assertPageableSql(sql: string): void {
  const excerpt = () => sql.trim().replace(/\s+/g, " ").slice(0, 160);
  if (sql.includes("--")) {
    throw new Error(
      `pagedRows: SQL contains "--" (a line comment). The appended LIMIT/OFFSET ` +
      `would land inside it and every page would silently return the WHOLE ` +
      `result set, so this would hang and duplicate forever instead of paging. ` +
      `Move the comment above the query, outside the string passed to pagedRows. ` +
      `SQL: ${excerpt()}`,
    );
  }
  if (sql.includes("/*") || sql.includes("*/")) {
    throw new Error(
      `pagedRows: SQL contains a block comment (/* */). Same hazard as a line ` +
      `comment -- the appended LIMIT/OFFSET can land inside or after it, so ` +
      `paging silently stops working. Move the comment above the query. ` +
      `SQL: ${excerpt()}`,
    );
  }
  if (sql.trim().endsWith(";")) {
    throw new Error(
      `pagedRows: SQL must not end in a trailing semicolon -- pagedRows appends ` +
      `LIMIT/OFFSET itself. A semicolon here makes sqlite3 run two statements, ` +
      `so LIMIT/OFFSET applies to a no-op second statement and every page ` +
      `returns the whole unpaged result. Drop the trailing ";". SQL: ${excerpt()}`,
    );
  }
}

/**
 * Read `sql` in pages, yielding rows in exactly the order one unpaged query
 * would have yielded them.
 *
 * `sql` must end in an ORDER BY and carry NO trailing semicolon, and NO line
 * or block comment, since LIMIT and OFFSET are appended to it as raw text --
 * see assertPageableSql for exactly how each of those shapes breaks paging.
 *
 * That ORDER BY must be a TOTAL order -- unique and non-null over the result
 * set. This is the entire safety argument for LIMIT/OFFSET: ties are free to
 * land in either page, so a non-unique sort key silently drops some rows and
 * duplicates others, which is exactly the corruption paging must not introduce.
 *
 * The precondition holds structurally for every caller, not by luck.
 * claude_requests.request_id and claude_events.id are PRIMARY KEYs, and
 * claude_project_paths.cwd is a PRIMARY KEY too -- so the LEFT JOIN those
 * queries make cannot fan one request out into two rows. Verified on the live
 * archive: joined and unjoined counts are both 27,165.
 *
 * A short page ends the walk, so the common case costs exactly the one query it
 * did before paging; only a row count that is an exact multiple of the page
 * size pays for a final empty read.
 */
export function* pagedRows<T>(
  db: string, sql: string, pageSize = SQL_PAGE_SIZE, opts: { readonly?: boolean } = {},
): Generator<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`pagedRows: pageSize must be a positive integer, got ${pageSize}`);
  }
  assertPageableSql(sql);
  for (let offset = 0; ; offset += pageSize) {
    const page = querySql<T>(db, `${sql} LIMIT ${pageSize} OFFSET ${offset};`, opts);
    yield* page;
    if (page.length < pageSize) return;
  }
}

/**
 * One legible line from a failed call: sqlite3's own complaint when there is one
 * (the child's stderr), else the first line of the message. Rendered next to a
 * source name, so it has to fit on a line.
 */
export function errorLine(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | null;
  const stderr = String(err?.stderr ?? "").trim();
  if (stderr !== "") return stderr.split("\n").filter((l) => l.trim() !== "").pop() ?? stderr;
  return String(err?.message ?? e).split("\n")[0];
}
