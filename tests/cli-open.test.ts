import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAndRoll } from "./helpers/fixture-db.ts";
import { slow } from "./helpers/timeout";

// `watchtower`, `watchtower open` and `watchtower stop`, driven as the user
// drives them: the real bin/watchtower in a child process, which starts the
// real dashboard detached in the background.
//
// Every run gets its own fixture database in its own directory (the
// .schema-vN marker and watchtower-serve.log both live beside the database),
// its own free port, and WATCHTOWER_BROWSER pointing at a script that appends
// the URL it was given to a file -- so no real browser opens, and the test can
// see exactly what was opened. afterEach SIGTERMs every dashboard left on a
// port the test used, by the pid its health reports.

const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "bin", "watchtower");
const LOG = "watchtower-serve.log";

interface Run { status: number | null; stdout: string; stderr: string; ms: number }

const ports: number[] = [];
const closers: (() => Promise<void>)[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() >= end) return false;
    await sleep(50);
  }
}

/** A port nothing listens on, from the OS. Recorded, so afterEach can clean it. */
async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  ports.push(port);
  return port;
}

/** The dashboard's health on a port, or null when nothing answers it. */
async function health(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const port of ports.splice(0)) {
    // Rounds, with a settle after each kill: a defect that spawns a second
    // server (planted, or real) can leave it still booting when the first is
    // killed, and it binds the freed port after a single look has passed.
    for (let round = 0; round < 3; round++) {
      const h = await health(port);
      // Never this process: an in-process server's health carries our own pid.
      if (h === null || typeof h.pid !== "number" || h.pid === process.pid) break;
      try {
        process.kill(h.pid, "SIGTERM");
      } catch {
        // already gone
      }
      await waitFor(async () => (await health(port)) === null, 3000);
      await sleep(500);
    }
  }
});

/** One user's world: a fixture database, a working directory and a fake browser. */
function setup() {
  const db = buildAndRoll("live");
  const work = mkdtempSync(path.join(tmpdir(), "wt-open-"));
  const home = mkdtempSync(path.join(tmpdir(), "wt-open-home-"));
  const opened = path.join(work, "opened.txt");
  const browser = path.join(work, "browser.sh");
  writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`);
  chmodSync(browser, 0o755);
  const log = path.join(path.dirname(db), LOG);

  /**
   * Run bin/watchtower. Resolves on "close", not "exit": close also waits for
   * the pipes, so a background server holding the CLI's stdout open would
   * keep this from resolving and turn the run red.
   */
  const cli = (args: string[], extraEnv: Record<string, string> = {}): Promise<Run> => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.WATCHTOWER_DASHBOARD_PORT;
    Object.assign(env, { THEONE_DB_PATH: db, WATCHTOWER_DB_PATH: db, WATCHTOWER_BROWSER: browser, WATCHTOWER_SYNC_SECONDS: "0", HOME: home }, extraEnv);
    const started = Date.now();
    return new Promise((resolve, reject) => {
      // The scratch cwd has no config, so the checkout's watchtower.config.json (gitignored; setup writes
      // only `sources`) is the fallback. These tests pass --port and override the database through env,
      // so a sources-only config changes nothing they assert.
      const child = spawn(process.execPath, [BIN, ...args], { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      child.on("error", reject);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr, ms: Date.now() - started });
      });
    });
  };

  const openedUrls = (): string[] =>
    existsSync(opened) ? readFileSync(opened, "utf8").split("\n").filter((l) => l !== "") : [];

  /** The browser is spawned detached, so it may write after the CLI is gone. */
  const waitOpened = async (n: number): Promise<string[]> => {
    await waitFor(() => openedUrls().length >= n, 3000);
    return openedUrls();
  };

  return { db, work, log, cli, openedUrls, waitOpened };
}

const backgroundLine = (url: string) =>
  `watchtower: dashboard at ${url} (running in the background; \`watchtower stop\` to stop it)\n`;

describe("watchtower open / stop", { timeout: slow(30000) }, () => {
  it("starts the dashboard in the background on the first open and opens the browser on it", async () => {
    const t = setup();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const before = readdirSync(path.dirname(t.db));

    const r = await t.cli(["open", "--port", String(port)]);
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(r.stdout).toBe(backgroundLine(url));
    expect(r.ms).toBeLessThan(5000);

    // The CLI is gone; the server it started is not, and it serves this database.
    const h = await health(port);
    expect(h?.dbPath).toBe(t.db);
    expect(typeof h?.pid).toBe("number");
    expect(h?.pid).not.toBe(process.pid);
    expect(await t.waitOpened(1)).toEqual([url]);

    // The server's log is the one file it adds beside the database. SQLite's
    // own -wal and -shm are not counted: a read-only query creates them on the
    // SQLite versions that need the query_only fallback (lib/core/sql.ts).
    const sidecars = [`${path.basename(t.db)}-wal`, `${path.basename(t.db)}-shm`];
    const added = readdirSync(path.dirname(t.db)).filter((f) => !before.includes(f) && !sidecars.includes(f));
    expect(added).toEqual([LOG]);
    expect(readFileSync(t.log, "utf8")).toContain(`watchtower: serving ${t.db} at ${url}`);
  });

  it("reuses a dashboard already serving the same database instead of starting another", async () => {
    const t = setup();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    expect((await t.cli(["open", "--port", String(port)])).status).toBe(0);
    const first = await health(port);
    const logAfterFirst = readFileSync(t.log, "utf8");

    const r = await t.cli(["open", "--port", String(port)]);
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(r.stdout).toBe(`watchtower: dashboard at ${url}\n`);
    expect((await health(port))?.pid).toBe(first?.pid);
    expect(await t.waitOpened(2)).toEqual([url, url]);
    // Nothing was spawned: a second server would have written its start, or
    // its EADDRINUSE, to the same log.
    expect(readFileSync(t.log, "utf8")).toBe(logAfterFirst);
  });

  it("stops a running dashboard, which then no longer answers", async () => {
    const t = setup();
    const port = await freePort();
    expect((await t.cli(["open", "--port", String(port)])).status).toBe(0);
    const pid = (await health(port))?.pid as number;
    expect(typeof pid).toBe("number");

    const r = await t.cli(["stop", "--port", String(port)]);
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(r.stdout).toBe(`watchtower: stopped the dashboard on port ${port}\n`);
    expect(await health(port)).toBeNull();
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true);
  });

  it("says so, and exits 0, when stop finds nothing running", async () => {
    const t = setup();
    const port = await freePort();
    const r = await t.cli(["stop", "--port", String(port)]);
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(r.stdout).toBe(`watchtower: no dashboard running on port ${port}\n`);
  });

  // Plain text, and JSON that is not health, are both "something else". Open
  // must not start a server (it would only die of EADDRINUSE) or open a
  // browser on a stranger's page; stop must not kill what it cannot identify.
  it("refuses a port held by something that is not Watchtower: nothing spawned, opened or killed", async () => {
    const t = setup();
    const port = await freePort();
    let answer = { type: "text/plain", body: "hello\n" };
    const foreign: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": answer.type });
      res.end(answer.body);
    });
    await new Promise<void>((r) => foreign.listen(port, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => {
      foreign.closeAllConnections();
      foreign.close(() => r());
    }));

    for (const a of [answer, { type: "application/json", body: JSON.stringify({ ok: true }) }]) {
      answer = a;
      const r = await t.cli(["open", "--port", String(port)]);
      expect(`${r.status}`).toBe("2");
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`port ${port} is in use by something else`);
      expect(r.stderr).toContain("pass --port or set dashboard.port");
    }

    const stop = await t.cli(["stop", "--port", String(port)]);
    expect(`${stop.status}`).toBe("2");
    expect(stop.stderr).toContain(`port ${port} is in use by something else`);

    expect(existsSync(t.log)).toBe(false);
    await sleep(200);
    expect(t.openedUrls()).toEqual([]);
    const still = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    expect(still.status).toBe(200);
  });

  it("refuses to open a dashboard serving a different database, naming both", async () => {
    const a = setup();
    const b = setup();
    const port = await freePort();
    expect((await a.cli(["open", "--port", String(port)])).status).toBe(0);

    const r = await b.cli(["open", "--port", String(port)]);
    expect(`${r.status}`).toBe("2");
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(a.db);
    expect(r.stderr).toContain(b.db);
    expect(r.stderr).toContain("watchtower stop");
    expect(existsSync(b.log)).toBe(false);
    await sleep(200);
    expect(b.openedUrls()).toEqual([]);
    expect((await health(port))?.dbPath).toBe(a.db);
  });

  // Usage reads `watchtower [open] [--port <n>]`: the word is optional with
  // the flag too, in both its spellings.
  it("opens the dashboard on a bare `watchtower`, as open does, with or without --port", async () => {
    const t = setup();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const r = await t.cli([], { WATCHTOWER_DASHBOARD_PORT: String(port) });
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(r.stdout).toBe(backgroundLine(url));
    expect((await health(port))?.dbPath).toBe(t.db);

    for (const args of [["--port", String(port)], [`--port=${port}`]]) {
      const again = await t.cli(args);
      expect(`${again.status}: ${again.stderr}`).toBe("0: ");
      expect(again.stdout).toBe(`watchtower: dashboard at ${url}\n`);
    }
    expect(await t.waitOpened(3)).toEqual([url, url, url]);
  });

  it.each(["help", "-h", "--help"])("prints usage, naming open and stop, and exits 0 for %s", async (arg) => {
    const t = setup();
    const r = await t.cli([arg]);
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(r.stdout).toContain("usage: watchtower [open] [--port <n>]");
    expect(r.stdout).toContain("watchtower stop [--port <n>]");
    expect(r.stdout).toContain("watchtower serve [--port <n>]");
  });

  it.each([["open", "0"], ["open", "abc"], ["stop", "70000"]])("rejects %s --port %s", async (cmd, port) => {
    const t = setup();
    const r = await t.cli([cmd, "--port", port]);
    expect(`${r.status}`).toBe("2");
    expect(r.stderr).toContain("--port expects an integer 1-65535");
    expect(t.openedUrls()).toEqual([]);
  });
});
