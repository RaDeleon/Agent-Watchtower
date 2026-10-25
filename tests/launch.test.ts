import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserCommand, dashboardUrl, openDashboard, probeHealth } from "@/lib/launch";
import { startDashboard } from "@/lib/serve";

// The CLI end to end (start, reuse, stop, refusals) is tests/cli-open.test.ts.
// This file covers what that one cannot reach cheaply: the URL for an IPv6
// host, the browser choice per platform, a Watchtower that answers 503, a
// listener that never answers, and a server that fails or hangs on start.

async function freePort(): Promise<number> {
  const srv = createNetServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("dashboardUrl", () => {
  it("brackets an IPv6 host and leaves the others alone", () => {
    expect(dashboardUrl("127.0.0.1", 4317)).toBe("http://127.0.0.1:4317/");
    expect(dashboardUrl("localhost", 4318)).toBe("http://localhost:4318/");
    expect(dashboardUrl("::1", 4317)).toBe("http://[::1]:4317/");
  });
});

describe("browserCommand", () => {
  it("prefers WATCHTOWER_BROWSER, where the empty string opens nothing", () => {
    expect(browserCommand({ WATCHTOWER_BROWSER: "/bin/echo" }, "darwin")).toBe("/bin/echo");
    expect(browserCommand({ WATCHTOWER_BROWSER: "" }, "darwin")).toBeNull();
  });

  it("uses open on macOS, xdg-open on Linux, and nothing elsewhere", () => {
    expect(browserCommand({}, "darwin")).toBe("open");
    expect(browserCommand({}, "linux")).toBe("xdg-open");
    expect(browserCommand({}, "win32")).toBeNull();
  });
});

describe("probeHealth", () => {
  it("reads a refused connection as nothing running", async () => {
    const port = await freePort();
    expect(await probeHealth(dashboardUrl("127.0.0.1", port))).toEqual({ kind: "none" });
  });

  // An unreadable database makes /api/health answer 503 with ok:false. That is
  // still Watchtower -- a fresh machine whose rollup has never run is exactly
  // where `watchtower` must start the dashboard and then recognise it.
  it("recognises a Watchtower whose database is unreadable (503, ok:false), with its pid", async () => {
    const started = await startDashboard({
      db: "/nonexistent/watchtower.sqlite", host: "127.0.0.1", port: 0, pollSeconds: 5, schemaVersion: 6,
    });
    cleanups.push(() => new Promise<void>((r) => started.server.close(() => r())));
    const probe = await probeHealth(started.url);
    expect(probe).toMatchObject({
      kind: "watchtower",
      health: { ok: false, dbPath: "/nonexistent/watchtower.sqlite", pid: process.pid },
    });
  });

  it("gives up on a listener that never answers, calling it something else", async () => {
    const sockets: Socket[] = [];
    const hung: NetServer = createNetServer((s) => sockets.push(s));
    await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r));
    cleanups.push(() => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((r) => hung.close(() => r()));
    });
    const { port } = hung.address() as AddressInfo;
    const t0 = Date.now();
    const probe = await probeHealth(dashboardUrl("127.0.0.1", port), 200);
    expect(probe.kind).toBe("foreign");
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("openDashboard, when the server it starts does not come up", () => {
  /** A stand-in for bin/watchtower: whatever `serve` would print, then its fate. */
  function fakeServe(body: string): { script: string; db: string; log: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "wt-launch-"));
    const script = path.join(dir, "fake-serve.mjs");
    writeFileSync(script, body);
    const db = path.join(dir, "watchtower.sqlite");
    return { script, db, log: path.join(dir, "watchtower-serve.log") };
  }

  // The log is appended to across runs; an older run's last line must never
  // be reported as this run's failure -- so a run that writes nothing says so.
  it("fails with the last line this run wrote to the log when the server exits", async () => {
    const f = fakeServe(`process.stderr.write("starting\\ncould not start the dashboard: listen EADDRINUSE\\n\\n"); process.exit(2);\n`);
    writeFileSync(f.log, "an older run's last line\n");
    const port = await freePort();
    const open = (script: string) => openDashboard({
      host: "127.0.0.1", port, db: f.db, script, env: { WATCHTOWER_BROWSER: "" }, platform: "darwin",
    });
    const r = await open(f.script);
    expect(r.code).toBe(2);
    expect(r.out).toBeUndefined();
    expect(r.err).toContain("could not start the dashboard: listen EADDRINUSE");
    expect(r.err).not.toContain("starting");

    const silent = path.join(path.dirname(f.script), "silent-serve.mjs");
    writeFileSync(silent, "process.exit(1);\n");
    const quiet = await open(silent);
    expect(quiet.code).toBe(2);
    expect(quiet.err).toContain("nothing in the log");
    expect(quiet.err).not.toContain("EADDRINUSE");
  });

  it("fails at the deadline when the server never answers, and stops the server it started", async () => {
    const f = fakeServe(`console.log("pid " + process.pid); setTimeout(() => {}, 30000);\n`);
    const port = await freePort();
    const r = await openDashboard({
      host: "127.0.0.1", port, db: f.db, script: f.script, env: { WATCHTOWER_BROWSER: "" }, platform: "darwin",
      startTimeoutMs: 600,
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain(`did not answer on http://127.0.0.1:${port}/`);
    const m = /pid (\d+)/.exec(r.err ?? "");
    expect(m).not.toBeNull();
    const pid = Number(m![1]);
    cleanups.push(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } });
    expect(await waitFor(() => !alive(pid), 2000)).toBe(true);
  });
});
