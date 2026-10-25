/**
 * `watchtower` (= `watchtower open`) and `watchtower stop`: one word to the
 * dashboard, and the terminal back.
 *
 * Everything here identifies the dashboard by its own `/api/health` and by
 * nothing else. Open reuses a Watchtower already serving this database,
 * refuses a port held by anything else, and otherwise starts `serve` detached
 * in the background. Stop signals only the pid a Watchtower reported about
 * itself -- never a process looked up by port -- so it can only ever kill a
 * process that has identified itself as Watchtower.
 *
 * Imported by bin/watchtower under plain Node, so relative `.ts` imports only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";

/** What `/api/health` said, as far as launching needs it. */
export interface ProbedHealth {
  ok: boolean;
  dbPath: string;
  schemaVersion: number;
  /** null from a dashboard that predates `pid` in health: it cannot be stopped from here. */
  pid: number | null;
}

export type Probe =
  | { kind: "none" }
  | { kind: "watchtower"; health: ProbedHealth }
  | { kind: "foreign"; reason: string };

/** What the CLI prints and exits with. It prints `out` to stdout, `err` to stderr. */
export interface Outcome {
  code: 0 | 2;
  out?: string;
  err?: string;
}

/** Written beside the database: the background server's stdout and stderr. */
export const SERVE_LOG = "watchtower-serve.log";

const PROBE_TIMEOUT_MS = 1000;
const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = 3000;
const POLL_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function dashboardUrl(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}/`;
}

/** The command that opens a URL, or null to open nothing and rely on the printed URL. */
export function browserCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const chosen = env.WATCHTOWER_BROWSER;
  if (chosen !== undefined) return chosen === "" ? null : chosen;
  if (platform === "darwin") return "open";
  if (platform === "linux") return "xdg-open";
  return null;
}

/**
 * Was the connection refused -- nothing listening? fetch wraps the code in
 * `cause`, and a dual-stack attempt (localhost) in an AggregateError.
 */
function refused(e: unknown, depth = 0): boolean {
  if (typeof e !== "object" || e === null || depth > 4) return false;
  const o = e as { code?: unknown; cause?: unknown; errors?: unknown };
  if (o.code === "ECONNREFUSED") return true;
  if (Array.isArray(o.errors) && o.errors.length > 0 && o.errors.every((x) => refused(x, depth + 1))) return true;
  return refused(o.cause, depth + 1);
}

/**
 * Health's shape, exactly as `serve` answers it: 200 with ok:true, or 503 with
 * ok:false (an unreadable database -- still Watchtower, and the page says why).
 */
function asHealth(status: number, body: unknown): ProbedHealth | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.ok !== "boolean" || typeof b.dbPath !== "string" || typeof b.schemaVersion !== "number") return null;
  if (!((status === 200 && b.ok) || (status === 503 && !b.ok))) return null;
  const pid = typeof b.pid === "number" && Number.isInteger(b.pid) && b.pid > 0 ? b.pid : null;
  return { ok: b.ok, dbPath: b.dbPath, schemaVersion: b.schemaVersion, pid };
}

/** Who, if anyone, answers `/api/health` at `url`. Never throws. */
export async function probeHealth(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Probe> {
  let status: number;
  let type: string;
  let text: string;
  try {
    const res = await fetch(new URL("api/health", url), { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    status = res.status;
    type = (res.headers.get("content-type") ?? "no content-type").split(";")[0];
    text = await res.text();
  } catch (e) {
    if (refused(e)) return { kind: "none" };
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "foreign", reason: `no answer from /api/health within ${timeoutMs} ms` };
    }
    const cause = (e as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
    return { kind: "foreign", reason: `/api/health failed: ${String(cause?.code ?? cause?.message ?? e)}` };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: not Watchtower
  }
  const health = asHealth(status, body);
  if (health === null) return { kind: "foreign", reason: `it answered /api/health with ${status} ${type}` };
  return { kind: "watchtower", health };
}

/**
 * The last non-empty line written to `log` at or after byte `from`, or null.
 * Starting at `from` matters: the log is appended to across runs, and an older
 * run's last line is not this run's failure.
 */
export function lastLogLine(log: string, from = 0): string | null {
  let fd: number;
  try {
    fd = openSync(log, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(from, size - 64 * 1024);
    if (size <= start) return null;
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "");
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } finally {
    closeSync(fd);
  }
}

/** Spawn the browser detached and forget it. Every failure is swallowed: the printed URL is the fallback. */
function openBrowser(url: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  const cmd = browserCommand(env, platform);
  if (cmd === null) return;
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // the printed URL is the fallback
  }
}

function inUse(port: number, reason: string, tail: string): Outcome {
  return { code: 2, err: `watchtower: port ${port} is in use by something else (${reason}); ${tail}` };
}

export interface OpenOptions {
  host: string;
  port: number;
  /** The database this dashboard must serve: cfg.database.path. */
  db: string;
  /** The script to run as `<script> serve --port <port>`: bin/watchtower itself. */
  script: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  probeTimeoutMs?: number;
  startTimeoutMs?: number;
}

/**
 * Open the dashboard in a browser, starting it in the background if nothing
 * is serving this port. Never starts a second server, and never opens a
 * browser on a page that is not this database's dashboard.
 */
export async function openDashboard(o: OpenOptions): Promise<Outcome> {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const url = dashboardUrl(o.host, o.port);
  const probe = await probeHealth(url, o.probeTimeoutMs);

  if (probe.kind === "foreign") return inUse(o.port, probe.reason, "pass --port or set dashboard.port in the config");
  if (probe.kind === "watchtower") {
    if (probe.health.dbPath !== o.db) {
      return {
        code: 2,
        err: `watchtower: the dashboard on port ${o.port} serves ${probe.health.dbPath}, not ${o.db}; run \`watchtower stop\` first`,
      };
    }
    openBrowser(url, env, platform);
    return { code: 0, out: `watchtower: dashboard at ${url}` };
  }

  const failed = await startInBackground(o, url);
  if (failed !== null) return { code: 2, err: failed };
  openBrowser(url, env, platform);
  return { code: 0, out: `watchtower: dashboard at ${url} (running in the background; \`watchtower stop\` to stop it)` };
}

/**
 * Start `serve` detached, its output appended to the log beside the database,
 * and wait for it to answer health. Returns null once it does, else the
 * one-line reason it did not. A server that never answers is stopped rather
 * than left running where neither `open` nor `stop` can see it.
 */
async function startInBackground(o: OpenOptions, url: string): Promise<string | null> {
  const log = path.join(path.dirname(o.db), SERVE_LOG);
  let fd: number;
  try {
    fd = openSync(log, "a");
  } catch (e) {
    return `watchtower: could not open ${log}: ${e instanceof Error ? e.message : String(e)}`;
  }
  const from = fstatSync(fd).size;
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [o.script, "serve", "--port", String(o.port)], {
      detached: true,
      stdio: ["ignore", fd, fd],
    });
  } catch (e) {
    return `watchtower: could not start the dashboard: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    // The child has its own copy; this process must not hold the log open.
    closeSync(fd);
  }
  const state = { exited: false };
  child.on("error", () => (state.exited = true));
  child.on("exit", () => (state.exited = true));
  child.unref();

  const timeout = o.startTimeoutMs ?? START_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  const said = () => `${lastLogLine(log, from) ?? "nothing in the log"} (log: ${log})`;
  for (;;) {
    const probe = await probeHealth(url, o.probeTimeoutMs);
    if (probe.kind === "watchtower" && probe.health.dbPath === o.db) return null;
    if (state.exited) return `watchtower: the dashboard exited before it answered on ${url}: ${said()}`;
    if (Date.now() >= deadline) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      return `watchtower: the dashboard did not answer on ${url} within ${timeout / 1000} s: ${said()}`;
    }
    await sleep(POLL_MS);
  }
}

export interface StopOptions {
  host: string;
  port: number;
  probeTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/** Stop the dashboard on this port, if it is Watchtower. Signals only the pid its health reports. */
export async function stopDashboard(o: StopOptions): Promise<Outcome> {
  const url = dashboardUrl(o.host, o.port);
  const probe = await probeHealth(url, o.probeTimeoutMs);
  if (probe.kind === "none") return { code: 0, out: `watchtower: no dashboard running on port ${o.port}` };
  if (probe.kind === "foreign") return inUse(o.port, probe.reason, "stopped nothing");

  const pid = probe.health.pid;
  if (pid === null) {
    return {
      code: 2,
      err: `watchtower: the dashboard on port ${o.port} did not report its pid (it predates \`watchtower stop\`); stop it where it was started`,
    };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    // ESRCH: it is already gone, which the poll below will confirm.
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
      return { code: 2, err: `watchtower: could not signal the dashboard (pid ${pid}): ${(e as Error).message}` };
    }
  }

  const timeout = o.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  for (;;) {
    if ((await probeHealth(url, o.probeTimeoutMs)).kind === "none") {
      return { code: 0, out: `watchtower: stopped the dashboard on port ${o.port}` };
    }
    if (Date.now() >= deadline) {
      return { code: 2, err: `watchtower: the dashboard on port ${o.port} (pid ${pid}) is still answering after ${timeout / 1000} s` };
    }
    await sleep(POLL_MS);
  }
}
