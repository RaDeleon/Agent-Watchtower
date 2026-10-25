import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import { buildAndRoll } from "./helpers/fixture-db.ts";
import { hostAllowed, startDashboard } from "@/lib/serve";

process.env.TZ = "UTC";

const BASE = 1750000000;
const NOW = BASE + 400;

describe("dashboard server", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const db = buildAndRoll("live");
    // Port 0: the OS picks a free one, so the suite never collides with a
    // dashboard the user is actually running.
    const started = await startDashboard({
      db, host: "127.0.0.1", port: 0, pollSeconds: 5, schemaVersion: 4, now: () => NOW,
      home: mkdtempSync(path.join(os.tmpdir(), "wt-serve-home-")),
    });
    server = started.server;
    base = started.url.replace(/\/$/, "");
  });

  afterAll(() => {
    server?.close();
  });

  it("serves the Live view as one self-contained HTML document", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("108.0%");
    expect(html).toContain("no reading");
  });

  // Stage 3D shell: amber + pills is the document's own state (so a browser
  // with storage blocked renders it), Sessions is in the nav, and the tool row
  // is real links since Stage 5.
  it("renders the themed shell with Sessions in the nav and the tool row as real links", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('<html lang="en" data-theme="amber" data-nav="pills">');
    expect(html).toContain('<a href="/sessions">Sessions</a>');
    expect(html).toContain('<a href="/" aria-current="page"><span class="dot"></span>Live</a>');
    expect(html).toContain('<a href="/profile">Usage Profile</a>');
    expect(html).toContain('<a href="/performance">Performance</a>');
    expect(html.indexOf('<a href="/performance">')).toBeGreaterThan(html.indexOf('<a href="/profile">'));
    expect(html).toContain('<a class="pill t-overview" href="/overview">Overview</a>');
    expect(html).toContain('<span class="pill on tool-cc" aria-current="true">Claude Code</span>');
    expect(html).toContain('<a class="pill t-agent" href="/codex">Codex</a>');
    expect(html).toContain('<a class="pill t-agent" href="/hermes">Hermes</a>');
    expect(html).not.toContain("pill soon");
    // The settings popover offers all five themes by label.
    for (const label of ["TheOne amber", "Claude", "SF Giants", "Toronto Raptors", "Buffalo Bills"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain('data-set-nav="sidebar"');
  });

  it("serves the Overview with its own tool current", async () => {
    const res = await fetch(`${base}/overview`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<span class="pill on t-overview" aria-current="true">Overview</span>');
    expect(html).toContain('<a class="pill tool-cc" href="/">Claude Code</a>');
  });

  it("serves the poll route as JSON carrying the same rendered panel", async () => {
    const res = await fetch(`${base}/api/live`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.rateLimits.fiveHour.pct).toBe(108);
    expect(body.rateLimits.sevenDay.pct).toBeNull();
    expect(body.burnRate.tokensPerMin).toBe(400);
    // One renderer: the polled fragment is the same HTML the page first painted.
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain(body.html);
  });

  it("serves the History view", async () => {
    const res = await fetch(`${base}/history`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<a href="/history" aria-current="page">History</a>');
    expect(html).toContain("<h2>Hygiene</h2>");
  });

  // Spec §4.5: served pills are plain links, and ?range= picks the span.
  it("serves History for the range in the query, with link pills", async () => {
    const html = await (await fetch(`${base}/history?range=7d`)).text();
    expect(html).toContain('<a class="rp" href="/history?range=7d" aria-current="true">7d</a>');
    expect(html).toContain("<h2>Active vs idle · last 7 days</h2>");
    expect(html).not.toContain('<button type="button" class="rp"'); // toggles are the report's
    const plain = await (await fetch(`${base}/history`)).text();
    expect(plain).toContain('<a class="rp" href="/history?range=30d" aria-current="true">30d</a>');
  });

  // Review Focus 3, part 1: a hostile ?range= falls back to 30d and is never
  // reflected. A 10 KB value is the same.
  it("falls back to 30d for a hostile or oversized ?range=, reflecting none of it", async () => {
    for (const q of ["%3Cscript%3Ealert(1)%3C%2Fscript%3E", "x".repeat(10 * 1024), "7d%22%3E%3Cb%3E"]) {
      const res = await fetch(`${base}/history?range=${q}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('<a class="rp" href="/history?range=30d" aria-current="true">30d</a>');
      expect(html.match(/class="rp"[^>]*aria-current/g)).toHaveLength(1);
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("alert(1)");
      expect(html).not.toContain("xxxxxxxxxx");
      expect(html).not.toContain('7d"><b>');
    }
  });

  it("serves the Projects and Models & Skills views", async () => {
    for (const [route, heading] of [["/projects", "<h2>Projects · ranked"], ["/skills", "<h2>Fresh vs cache vs total</h2>"]]) {
      const res = await fetch(`${base}${route}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain(`<a href="${route}" aria-current="page">`);
      expect(html).toContain(heading);
    }
  });

  it("serves the Usage Profile view", async () => {
    const res = await fetch(`${base}/profile`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<a href="/profile" aria-current="page">Usage Profile</a>');
    expect(html).toContain("<h2>Usage ladder</h2>");
    expect(html).toContain("<h2>Matrix score</h2>");
  });

  // Spec §4.5 / Review Focus 3: a hostile ?range= falls back to 30d and is
  // never reflected on the Usage Profile page either.
  it("falls back to 30d for a hostile ?range= on the Usage Profile page, reflecting none of it", async () => {
    const res = await fetch(`${base}/profile?range=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a class="rp" href="/profile?range=30d" aria-current="true">30d</a>');
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("alert(1)");
  });

  // Stage 4B: the Performance page is ranged like the others, and a hostile
  // ?range= falls back to 30d without being reflected.
  it("serves the Performance view, ranged, falling back on a hostile ?range=", async () => {
    const res = await fetch(`${base}/performance`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain('<a href="/performance" aria-current="page">Performance</a>');
    expect(html).toContain("<h2>Cost by model");
    expect(html).toContain('<a class="rp" href="/performance?range=30d" aria-current="true">30d</a>');
    const week = await (await fetch(`${base}/performance?range=7d`)).text();
    expect(week).toContain('<a class="rp" href="/performance?range=7d" aria-current="true">7d</a>');
    const hostile = await fetch(`${base}/performance?range=%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
    expect(hostile.status).toBe(200);
    const h = await hostile.text();
    expect(h).toContain('<a class="rp" href="/performance?range=30d" aria-current="true">30d</a>');
    expect(h.match(/class="rp"[^>]*aria-current/g)).toHaveLength(1);
    expect(h).not.toContain("<script>alert");
    expect(h).not.toContain("alert(1)");
  });

  it("serves the Sessions view, ranged, with the most expensive session as its hero", async () => {
    const res = await fetch(`${base}/sessions`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a href="/sessions" aria-current="page">Sessions</a>');
    expect(html).toContain("<h2>Most expensive session · last 30 days</h2>");
    expect(html).toContain('<table class="sortable">');
    expect(html).toContain('<a class="rp" href="/sessions?range=30d" aria-current="true">30d</a>');
    // Served, a project cell filters the table.
    expect(html).toContain('<a href="/sessions?range=30d&amp;project=(unfiled)" title="(unfiled)">(unfiled)</a>');
  });

  it("filters Sessions to a project on record, keeping the filter across ranges", async () => {
    const html = await (await fetch(`${base}/sessions?range=7d&project=%28unfiled%29`)).text();
    expect(html).toContain("<h2>Sessions · last 7 days · (unfiled)</h2>");
    expect(html).toContain('<a class="rp" href="/sessions?range=90d&amp;project=(unfiled)">90d</a>');
    expect(html).toContain('<span class="sid" title="S_LIVE">S_LIVE</span>');
  });

  // Review Focus 3, part 2: a hostile, traversal-shaped, NUL-bearing or 10 KB
  // ?project= is a 200 with the empty state. None of it is reflected: an
  // unknown project never reaches SQL, the page or the pills.
  it("answers a hostile or oversized ?project= with the empty state, reflecting none of it", async () => {
    for (const q of ["..%2F..%2Fx", "../../x", "%3Cscript%3Ealert(1)%3C%2Fscript%3E", "x".repeat(10 * 1024), "a%00b", "%22%3E%3Cb%3E"]) {
      const res = await fetch(`${base}/sessions?project=${q}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("No sessions on record for that project.");
      expect(html).toContain("no sessions for this project in the last 30 days");
      expect(html).toContain('<a class="rp" href="/sessions?range=30d" aria-current="true">30d</a>');
      expect(html).not.toContain("../../x");
      expect(html).not.toContain("alert(1)");
      expect(html).not.toContain("xxxxxxxxxx");
      expect(html).not.toContain('"><b>');
      expect(html).not.toContain("project=");
    }
  });

  it("serves Projects for the range in the query, with link pills", async () => {
    const html = await (await fetch(`${base}/projects?range=90d`)).text();
    expect(html).toContain('<a class="rp" href="/projects?range=90d" aria-current="true">90d</a>');
    expect(html).toContain("<h2>Projects · ranked by active hours · last 90 days</h2>");
    expect(html).toContain("<h2>Terminals · last 90 days</h2>");
  });

  it("serves the Sources view, reporting an unsynced database rather than failing", async () => {
    const res = await fetch(`${base}/sources`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a href="/sources" aria-current="page">Sources</a>');
    expect(html).toContain("has never run against it");
  });

  it("reports health, including when the rollup last ran", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.schemaVersion).toBe(4);
    expect(typeof body.lastRollup).toBe("number");
  });

  // `watchtower stop` signals the pid health reports, and nothing else: it
  // never looks a process up by port. This server runs in the test's own
  // process, so its pid is this one.
  it("reports the serving process's pid in health", async () => {
    const body = await (await fetch(`${base}/api/health`)).json();
    expect(body.pid).toBe(process.pid);
  });

  it("answers an unknown path with a plain-text 404, not a rendered page", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("not found");
  });

  // Killing mutation: remove the Host check. Through DNS rebinding a hostile
  // page resolves its own name to 127.0.0.1 and reads /api/live same-origin;
  // the browser still sends that name in Host, so the server must refuse it.
  // fetch() will not set Host, so this goes through node:http directly.
  it("refuses a request whose Host is not a loopback name on this port", async () => {
    const port = Number(new URL(base).port);
    const get = (host: string) =>
      new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/api/live", headers: { host, origin: "http://evil.example" } },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    const evil = await get(`evil.example:${port}`);
    expect(evil.status).toBe(421);
    expect(evil.type).toContain("text/plain");
    expect(evil.body).not.toContain("rateLimits");
    expect((await get(`localhost:${port}`)).status).toBe(200);
  });

  it("marks every response nosniff, the 404 that echoes a path included", async () => {
    expect((await fetch(`${base}/`)).headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(`${base}/nope`)).headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("accepts only loopback names on the port the request arrived on", () => {
    expect(hostAllowed("127.0.0.1:4317", 4317)).toBe(true);
    expect(hostAllowed("LOCALHOST:4317", 4317)).toBe(true);
    expect(hostAllowed("[::1]:4317", 4317)).toBe(true);
    expect(hostAllowed("localhost", 80)).toBe(true);
    expect(hostAllowed("localhost:4318", 4317)).toBe(false);
    expect(hostAllowed("evil.example:4317", 4317)).toBe(false);
    expect(hostAllowed("127.0.0.1.evil.example:4317", 4317)).toBe(false);
    expect(hostAllowed("[::2]:4317", 4317)).toBe(false);
    expect(hostAllowed(undefined, 4317)).toBe(false);
    expect(hostAllowed("", 4317)).toBe(false);
  });

  it("refuses a write method", async () => {
    expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(405);
  });

  // Killing mutation: bind to "0.0.0.0". Watchtower reads a database of what
  // you typed into every repo you own; it is loopback only, and the server
  // checks that itself rather than trusting config validation to have run.
  it("refuses to bind anywhere but loopback", async () => {
    await expect(
      startDashboard({ db: ":memory:", host: "0.0.0.0", port: 0, pollSeconds: 5, schemaVersion: 4 }),
    ).rejects.toThrow(/loopback only/);
  });

  it("reports an unreadable database as unhealthy instead of crashing", async () => {
    const started = await startDashboard({
      db: "/nonexistent/watchtower.sqlite", host: "127.0.0.1", port: 0,
      pollSeconds: 5, schemaVersion: 4, now: () => NOW,
      home: mkdtempSync(path.join(os.tmpdir(), "wt-serve-home-")),
    });
    try {
      const res = await fetch(`${started.url}api/health`);
      expect(res.status).toBe(503);
      expect((await res.json()).ok).toBe(false);
    } finally {
      started.server.close();
    }
  });
});
