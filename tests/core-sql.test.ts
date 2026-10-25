import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  sqlStr, sqlNum, execSql, execSqlBatch, querySql, pagedRows, SQLITE_MAX_BUFFER, SQL_PAGE_SIZE,
} from "@/lib/core/sql";

function tmpDb(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "wtsql-")), "t.sqlite");
}

/** A table of `n` rows whose single column is the integers 1..n, in order. */
function seq(n: number): string {
  const db = tmpDb();
  execSql(db, `CREATE TABLE t (i INTEGER PRIMARY KEY);`);
  if (n > 0) {
    execSql(db, `INSERT INTO t (i)
      WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < ${n})
      SELECT i FROM s;`);
  }
  return db;
}

describe("sqlStr", () => {
  // capture/lib.sh's cc_sqlstr had a REAL data-loss bug on apostrophes that a
  // fixture with its own quoting could not see. This escaper gets its own test.
  it("doubles embedded apostrophes", () => {
    expect(sqlStr("it's")).toBe("'it''s'");
  });

  it("round-trips an apostrophe through the database", () => {
    const db = tmpDb();
    execSql(db, `CREATE TABLE t (v TEXT);`);
    execSql(db, `INSERT INTO t (v) VALUES (${sqlStr("O'Brien \"x\" \\ y")});`);
    expect(querySql<{ v: string }>(db, `SELECT v FROM t;`)[0].v)
      .toBe(`O'Brien "x" \\ y`);
  });

  it("renders null as SQL NULL, not the string 'null'", () => {
    expect(sqlStr(null)).toBe("NULL");
  });
});

describe("sqlNum", () => {
  // undefined and 0 are DIFFERENT FACTS. A metric the source does not expose
  // must not become a zero.
  it("renders undefined and null as NULL but 0 as 0", () => {
    expect(sqlNum(undefined)).toBe("NULL");
    expect(sqlNum(null)).toBe("NULL");
    expect(sqlNum(0)).toBe("0");
  });

  it("refuses a non-finite number rather than emitting broken SQL", () => {
    expect(() => sqlNum(NaN)).toThrow(/finite/);
    expect(() => sqlNum(Infinity)).toThrow(/finite/);
  });
});

describe("querySql", () => {
  it("returns [] for an empty result rather than throwing", () => {
    const db = tmpDb();
    execSql(db, `CREATE TABLE t (v TEXT);`);
    expect(querySql(db, `SELECT * FROM t;`)).toEqual([]);
  });

  // THE BUFFER HALF OF THE ENOBUFS FIX.
  //
  // querySql ran on Node's DEFAULT maxBuffer of 1 MiB. `watchtower sync` died
  // with a bare `spawnSync sqlite3 ENOBUFS` on the real archive because one
  // SELECT over claude_requests rendered 9,895,624 bytes of -json, and
  // wt_requests was left at 0 -- nothing projected at all. 333 tests passed
  // through it because every fixture held a handful of rows.
  //
  // 2 MiB is the size asserted here: comfortably past the 1 MiB default that
  // broke, and small enough that a recursive CTE produces it in milliseconds
  // with no fixture to build. A payload this size is the cheapest thing that
  // can tell the old ceiling from the new one.
  it("returns a result larger than Node's 1 MiB default maxBuffer", () => {
    const db = tmpDb();
    const target = 2 * 1024 * 1024;
    const rowBytes = 256;
    const n = Math.ceil(target / rowBytes);
    const got = querySql<{ v: string }>(db, `
      WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < ${n})
      SELECT hex(zeroblob(${rowBytes / 2})) AS v FROM s;`);

    expect(got.length).toBe(n);
    expect(got.length * rowBytes).toBeGreaterThan(1024 * 1024);
  });

  // querySql set no `stdio`, and execFileSync then echoes the child's stderr
  // through process.stderr.write, so a probe that caught its own failure still
  // printed `file is not a database (26)` into the command's output. The
  // message must travel with the error instead. e.stderr is filled either way,
  // so the echo itself is what this watches.
  it("carries sqlite3's error on the thrown error rather than printing it", () => {
    const notSqlite = path.join(mkdtempSync(path.join(tmpdir(), "wtsql-")), "not.sqlite");
    writeFileSync(notSqlite, "this is plain text, not a database file ".repeat(20));
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let err: { stderr?: string | null } | undefined;
    let echoed: string;
    try {
      // A query that reads the schema: sqlite3 before 3.54 opens a file lazily,
      // so a bare `SELECT 1` never reads it and succeeds on plain text.
      querySql(notSqlite, `SELECT count(*) FROM sqlite_master;`);
    } catch (e) {
      err = e as { stderr?: string | null };
    } finally {
      // Read before restoring: mockRestore also clears the recorded calls.
      echoed = spy.mock.calls.map((c) => String(c[0])).join("");
      spy.mockRestore();
    }
    expect(err?.stderr).toContain("file is not a database");
    expect(echoed).toBe("");
  });

  // A REAL failure, found by serving a .backup copy of the live database.
  // capture/lib.sh puts every database in WAL mode, and a WAL database can only
  // be opened read-only when its -shm file already exists: building the WAL
  // index is itself a write. SQLite deletes -shm when the last connection
  // closes cleanly, so an idle machine is in exactly this state -- the
  // dashboard broke precisely when no Claude session was running. Fixtures
  // never showed it because a fixture is written moments before it is read.
  describe("a WAL database with no -shm file", () => {
    function walDbWithoutShm(): string {
      const db = tmpDb();
      execSql(db, `PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT);`);
      execSql(db, `INSERT INTO t (v) VALUES ('x');`);
      // A fresh `sqlite3 .backup` copy arrives as the database file ALONE, and
      // that is the state being reproduced. Remove the sidecars rather than
      // assuming the platform did: macOS leaves them behind after a clean
      // close, so relying on that would build a database that opens read-only
      // perfectly well and prove nothing.
      for (const side of [`${db}-shm`, `${db}-wal`]) if (existsSync(side)) unlinkSync(side);
      expect(existsSync(`${db}-shm`)).toBe(false);
      // Byte 18 of the header is the write format: 2 means WAL. Read from the
      // file rather than asked of sqlite3, because opening it would recreate
      // the -shm this test needs to be missing.
      expect(readFileSync(db).at(18)).toBe(2);
      return db;
    }

    it("is still readable", () => {
      expect(querySql<{ v: string }>(walDbWithoutShm(), `SELECT v FROM t;`, { readonly: true }))
        .toEqual([{ v: "x" }]);
    });

    // The fallback opens the file normally, so this is what keeps the
    // dashboard's "never writes" promise true on that path.
    it("still refuses a write", () => {
      const db = walDbWithoutShm();
      expect(() => querySql(db, `INSERT INTO t (v) VALUES ('nope');`, { readonly: true }))
        .toThrow();
      expect(querySql<{ n: number }>(db, `SELECT COUNT(*) AS n FROM t;`, { readonly: true })[0].n)
        .toBe(1);
    });

    // The fallback is gated on the file existing: a normal sqlite3 open CREATES
    // a missing database, and creating one is the single write that must never
    // happen. A dashboard pointed at a typo'd path must fail, not mint an
    // empty database that then reads as a user with no history.
    it("does not create a database that is not there", () => {
      const missing = path.join(mkdtempSync(path.join(tmpdir(), "wtsql-")), "absent.sqlite");
      expect(() => querySql(missing, `SELECT 1;`, { readonly: true })).toThrow();
      expect(existsSync(missing)).toBe(false);
    });
  });

  it("has an explicit ceiling well above the default it replaced", () => {
    // Pinned so the value cannot drift back toward the default by accident.
    expect(SQLITE_MAX_BUFFER).toBe(64 * 1024 * 1024);
    expect(SQLITE_MAX_BUFFER).toBeGreaterThan(1024 * 1024);
  });
});

describe("pagedRows", () => {
  // THE PAGING HALF. A raised ceiling alone only relocates the cliff, so every
  // whole-table read is drawn in fixed-size pages. These cases are the page
  // arithmetic itself, run at a tiny page size so the boundaries are cheap to
  // reach: the row counts that break a naive loop are the ones AROUND a page
  // boundary, not the ones far from it.
  const sql = `SELECT i FROM t ORDER BY i`;
  const ids = (db: string, pageSize: number) =>
    [...pagedRows<{ i: number }>(db, sql, pageSize)].map((r) => r.i);

  it("yields every row exactly once, in order, at every boundary", () => {
    // 0 and 1 are the degenerate ends; 2 is page-1; 3 is EXACTLY one page, the
    // case where a loop that stops only on an empty page and one that stops on
    // a short page disagree; 4 is the first row of a second page; 6 is exactly
    // two pages; 7 is two pages plus a remainder.
    for (const n of [0, 1, 2, 3, 4, 6, 7]) {
      const expected = Array.from({ length: n }, (_, k) => k + 1);
      expect(`n=${n}: ${ids(seq(n), 3)}`).toBe(`n=${n}: ${expected}`);
    }
  });

  it("agrees with the unpaged query it replaces, whatever the page size", () => {
    // The contract is INDISTINGUISHABILITY: same rows, same order, same count.
    // Page size must be an implementation detail and nothing more.
    const db = seq(50);
    const unpaged = querySql<{ i: number }>(db, `${sql};`).map((r) => r.i);
    for (const pageSize of [1, 2, 7, 49, 50, 51, 1000]) {
      expect(`pageSize=${pageSize}: ${ids(db, pageSize)}`)
        .toBe(`pageSize=${pageSize}: ${unpaged}`);
    }
  });

  it("drops and duplicates nothing across many pages", () => {
    // A bad OFFSET step is the failure mode this exists for: too small
    // duplicates rows, too large skips them, and a count alone catches
    // neither when they cancel out.
    const got = ids(seq(1000), 7);
    expect(got.length).toBe(1000);
    expect(new Set(got).size).toBe(1000);
    expect(got[0]).toBe(1);
    expect(got[999]).toBe(1000);
  });

  it("reads lazily -- a consumer that stops early does not pay for the rest", () => {
    // The generator is the reason a huge table never lands in memory whole.
    // Materialising it internally would restore the defect while passing every
    // assertion above.
    const db = seq(1000);
    const first: number[] = [];
    for (const r of pagedRows<{ i: number }>(db, sql, 5)) {
      first.push(r.i);
      if (first.length === 3) break;
    }
    expect(first).toEqual([1, 2, 3]);
  });

  it("refuses a page size that could never terminate", () => {
    // pageSize 0 makes every page short-but-empty; a negative one is a SQL
    // error at best. Both are better caught at the call than diagnosed later.
    for (const bad of [0, -1, 1.5]) {
      expect(() => [...pagedRows(seq(3), sql, bad)]).toThrow(/positive integer/);
    }
  });

  it("uses a page size that keeps a page far below the buffer ceiling", () => {
    // The two constants only work as a pair. The live archive's fattest query
    // averages ~364 bytes a row, so a full page is ~1.8 MB; this asserts the
    // margin rather than the arithmetic, and goes red if either constant moves
    // far enough to make an overflow reachable again.
    expect(SQL_PAGE_SIZE).toBe(5000);
    expect(SQL_PAGE_SIZE * 364).toBeLessThan(SQLITE_MAX_BUFFER / 10);
  });

  // THE INFINITE-LOOP GUARD. pagedRows appends "LIMIT n OFFSET m" as raw text
  // after the caller's SQL, with no parser in between. A trailing `--` line
  // comment, or an unclosed `/* block comment`, swallows that appended clause
  // into the comment: sqlite3 never sees it, every page returns the WHOLE
  // table, `page.length < pageSize` is never true, and the generator yields
  // duplicates forever -- confirmed directly (guard disabled, page size 5,
  // 20-row table): the line-comment case ran past 200 duplicate rows before
  // being interrupted, and the unclosed-block-comment case returned all 20
  // rows on what should have been a 5-row page.
  //
  // Both of those two cases get their OWN reproduction below that calls
  // `.next()` exactly ONCE rather than draining the generator with a spread.
  // assertPageableSql runs synchronously before the generator's loop ever
  // issues a query, so with the guard in place the first `.next()` throws
  // immediately -- zero DB reads, zero risk of hanging. That property is what
  // makes the test safe even if the guard regresses: a single `.next()` call
  // can never loop, so a regression makes the assertion FAIL (wrong value /
  // no throw), never HANG the suite. A test that instead spread the generator
  // (`[...pagedRows(...)]`) would be correct today but would hang the whole
  // run forever the moment this guard was deleted -- exactly the failure mode
  // this guard exists to prevent, reproduced in the test harness itself.
  describe("refuses SQL that would break LIMIT/OFFSET silently", () => {
    it("rejects a trailing line comment on the very first advance, before any query", () => {
      const db = seq(20);
      const sql = `SELECT i FROM t ORDER BY i -- trailing comment`;
      const gen = pagedRows<{ i: number }>(db, sql, 5);
      expect(() => gen.next()).toThrow(/line comment/);
    });

    it("rejects an unclosed block comment on the very first advance, before any query", () => {
      // Deliberately UNCLOSED: a closed `/* ... */` leaves the appended
      // LIMIT/OFFSET outside the comment, which is harmless, so only the
      // unclosed form reproduces the hazard. The guard bans both shapes
      // (closed or not) rather than trying to parse comment nesting.
      const db = seq(20);
      const sql = `SELECT i FROM t ORDER BY i /* trailing comment`;
      const gen = pagedRows<{ i: number }>(db, sql, 5);
      expect(() => gen.next()).toThrow(/block comment/);
    });

    it("rejects a trailing semicolon", () => {
      // Unlike the two cases above this one does not hang: sqlite3's CLI
      // treats "...; LIMIT 5 OFFSET 0;" as a second, syntactically invalid
      // statement and errors immediately. It is still rejected here because
      // that error is confusing and gives no hint that pagedRows is the
      // reason -- the existing JSDoc already named the hazard; this pins it.
      const db = seq(20);
      const sql = `SELECT i FROM t ORDER BY i;`;
      expect(() => [...pagedRows<{ i: number }>(db, sql, 5)]).toThrow(/semicolon/);
    });

    it("still accepts ordinary SQL with none of those shapes", () => {
      const db = seq(3);
      expect([...pagedRows<{ i: number }>(db, `SELECT i FROM t ORDER BY i`, 5)])
        .toEqual([{ i: 1 }, { i: 2 }, { i: 3 }]);
    });
  });
});

describe("execSqlBatch", () => {
  it("writes every statement in one call", () => {
    const db = seq(0);
    execSqlBatch(db, [1, 2, 3].map((i) => `INSERT INTO t (i) VALUES (${i});`));
    expect(querySql<{ n: number }>(db, `SELECT COUNT(*) AS n FROM t;`)[0].n).toBe(3);
  });

  // ingestChunk's fallback replays a failed batch one record at a time. That is
  // only safe if the failed batch left NOTHING behind.
  it("writes nothing at all when any statement fails", () => {
    const db = seq(0);
    expect(() => execSqlBatch(db, [
      `INSERT INTO t (i) VALUES (1);`,
      `INSERT INTO t (i) VALUES (1);`, // primary key violation
      `INSERT INTO t (i) VALUES (2);`,
    ])).toThrow();
    expect(querySql<{ n: number }>(db, `SELECT COUNT(*) AS n FROM t;`)[0].n).toBe(0);
  });
});

describe("pagedRows readonly", () => {
  it("passes the readonly option through", () => {
    const db = seq(1);
    expect([...pagedRows(db, "SELECT 1 AS i UNION ALL SELECT 2 ORDER BY i", 1, { readonly: true })])
      .toEqual([{ i: 1 }, { i: 2 }]);
  });
});
