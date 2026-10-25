/**
 * The dashboard server. `node:http`, zero dependencies, loopback only.
 *
 * It never writes: every read goes through `querySql(..., { readonly: true })`,
 * so sqlite3 itself refuses a write rather than a reviewer having to notice
 * one. A stale page is correct behaviour when the rollup has not run — the
 * dashboard does not run it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isLoopback } from "./config.ts";
import { querySql } from "./core/sql.ts";
import { readLive } from "./read/live.ts";
import { parseRange } from "./read/range.ts";
import type { ConfiguredSource } from "./read/sources.ts";
import { localZone } from "./render/html.ts";
import { renderLivePage, renderLivePanel } from "./render/live.ts";
import { renderStaticRoute } from "./views.ts";

export interface ServeOptions {
  db: string;
  host: string;
  port: number;
  pollSeconds: number;
  schemaVersion: number;
  /** Where Claude Code's transcripts live. Defaults to ~/.claude/projects. */
  transcriptsDir?: string;
  /** Injectable clock, so an end-to-end test can pin a fixture's epoch. */
  now?: () => number;
  /** Sources named in config, for the Sources view. */
  configured?: Record<string, ConfiguredSource>;
  /**
   * The zone every page prints its times in. Defaults to the process's -- the
   * same zone the readers' sqlite3 child buckets local days in.
   */
  tz?: string;
  /** The home directory tools are looked for under. Defaults to os.homedir(); tests inject one. */
  home?: string;
}

export interface Health {
  ok: boolean;
  dbPath: string;
  schemaVersion: number;
  /** Epoch seconds of the last rollup, or null if the table is empty or unreadable. */
  lastRollup: number | null;
  /**
   * The serving process. `watchtower stop` signals this pid and nothing else:
   * it only ever kills a process that has identified itself as Watchtower.
   */
  pid: number;
}

function health(opts: ServeOptions): Health {
  try {
    const rows = querySql<{ last: number | null }>(
      opts.db,
      `SELECT MAX(updated_at) AS last FROM claude_daily_rollups;`,
      { readonly: true },
    );
    return { ok: true, dbPath: opts.db, schemaVersion: opts.schemaVersion, lastRollup: rows[0]?.last ?? null, pid: process.pid };
  } catch {
    // A missing or unreadable database is a state the page must be able to
    // report, not a crash: this route exists precisely to say "not ok".
    return { ok: false, dbPath: opts.db, schemaVersion: opts.schemaVersion, lastRollup: null, pid: process.pid };
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    // The 404 body echoes the path; no body may be sniffed into another type.
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

/** Host names a browser may address the dashboard by. Lower-case; IPv6 bracketed. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Is the request's `Host` a loopback name on the port it actually arrived on?
 *
 * The bind being loopback is not enough: through DNS rebinding a hostile page
 * can point its own hostname at 127.0.0.1 and then read every page and
 * `/api/live` as same-origin. The browser still sends that hostname in `Host`,
 * so refusing any Host that is not a loopback name closes it. The port is the
 * socket's local port, so a server started on `:0` checks the port it got.
 */
export function hostAllowed(host: string | undefined, localPort: number | undefined): boolean {
  if (host === undefined) return false;
  const m = /^(\[[^\]]*\]|[^:]+)(?::(\d+))?$/.exec(host.trim().toLowerCase());
  if (m === null || !LOOPBACK_HOSTS.has(m[1])) return false;
  const port = m[2] === undefined ? 80 : Number(m[2]);
  return port === localPort;
}

export function handle(req: IncomingMessage, res: ServerResponse, opts: ServeOptions): void {
  if (!hostAllowed(req.headers.host, req.socket.localPort)) {
    send(res, 421, "text/plain; charset=utf-8", "misdirected request: this dashboard answers only to 127.0.0.1, localhost or [::1]\n");
    return;
  }
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const tz = opts.tz ?? localZone();
  // The URL is only ever used for routing; `req.url` is relative, and the base
  // is a placeholder that never reaches the network.
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.pathname;

  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "text/plain; charset=utf-8", "method not allowed\n");
    return;
  }

  try {
    if (route === "/") {
      const data = readLive(opts.db, { now: now(), transcriptsDir: opts.transcriptsDir });
      send(res, 200, "text/html; charset=utf-8", renderLivePage(data, { pollSeconds: opts.pollSeconds, tz }));
      return;
    }
    if (route === "/api/live") {
      const data = readLive(opts.db, { now: now(), transcriptsDir: opts.transcriptsDir });
      // The payload carries BOTH the data and the server-rendered panel: the
      // page swaps the fragment in, so there is one renderer rather than a
      // second one written in browser JS.
      send(res, 200, "application/json; charset=utf-8",
        JSON.stringify({ ...data, html: renderLivePanel(data, { tz }) }));
      return;
    }
    // History, Projects, Sessions, Skills and Sources: the same table `report`
    // walks. The range is PARSED, never passed through: anything but the four
    // known values is the default, so no page can reflect the raw query. The
    // project filter is matched by the Sessions reader against the projects on
    // record and is otherwise ignored; an empty one is no filter.
    const html = renderStaticRoute(route, {
      db: opts.db, now: now(), configured: opts.configured, range: parseRange(url.searchParams.get("range")),
      project: url.searchParams.get("project") || undefined, served: true, tz, home: opts.home,
    });
    if (html !== null) {
      send(res, 200, "text/html; charset=utf-8", html);
      return;
    }
    if (route === "/api/health") {
      const h = health(opts);
      send(res, h.ok ? 200 : 503, "application/json; charset=utf-8", JSON.stringify(h));
      return;
    }
  } catch (e) {
    // One legible line. The dashboard reporting its own failure beats a stack
    // trace on a blank page.
    send(res, 500, "text/plain; charset=utf-8", `watchtower: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n`);
    return;
  }

  // No catch-all rendering: an unknown path is a 404, in plain text.
  send(res, 404, "text/plain; charset=utf-8", `not found: ${route}\n`);
}

export function createDashboardServer(opts: ServeOptions): Server {
  return createServer((req, res) => handle(req, res, opts));
}

/**
 * Bind the server. Loopback only, checked here as well as in config.
 *
 * Watchtower reads a database of what you typed into every repo you own.
 * Binding it to a LAN interface is not a knob worth shipping, so a non-loopback
 * host is refused rather than corrected.
 */
export function startDashboard(opts: ServeOptions): Promise<{ server: Server; port: number; url: string }> {
  if (!isLoopback(opts.host)) {
    return Promise.reject(
      new Error(`refusing to bind dashboard to ${JSON.stringify(opts.host)}: loopback only (127.0.0.1, localhost or ::1)`),
    );
  }
  const server = createDashboardServer(opts);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : opts.port;
      resolve({ server, port, url: `http://${opts.host}:${port}/` });
    });
  });
}
