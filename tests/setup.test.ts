import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Runner } from "@/lib/setup/facts";
import { runSetup } from "@/lib/setup/run";
import {
  INSTALLED, linkTarget, makeCheckout, present, sandbox, stopDashboards, type Sandbox,
} from "./helpers/setup-sandbox.ts";
import { slow } from "./helpers/timeout";

// `watchtower setup`, driven as a user drives it: bin/watchtower in a child
// process, in a temp copy of the checkout, under a temp HOME. Guards 6-12 of
// the Stage 9 spec (§6.1) live here, one test each; the rest assert identities.

const MAKE_TRANSCRIPTS = path.resolve(import.meta.dirname, "fixtures", "make-transcripts.sh");
const CLOSING = "Tokens, cost and the Usage Profile cover your past history. Active hours, levels and quests start with your next Claude Code session.";

let checkout: string;
const config = () => path.join(checkout, "watchtower.config.json");
const linkOf = (t: Sandbox) => path.join(t.home, ".local", "bin", "watchtower");

beforeAll(() => {
  checkout = makeCheckout();
});

afterEach(() => {
  stopDashboards();
  // The checkout is shared by the file's tests; a config one test wrote must not reach the next.
  rmSync(config(), { force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The browser stub is spawned detached, so it may write after setup has exited. */
async function opened(t: Sandbox): Promise<string> {
  for (let i = 0; i < 60 && !existsSync(t.browserLog); i++) await sleep(50);
  return existsSync(t.browserLog) ? readFileSync(t.browserLog, "utf8") : "";
}

const scripts = (dir: string) => INSTALLED.map((s) => (existsSync(path.join(dir, s)) ? readFileSync(path.join(dir, s), "utf8") : null));

/** The Claude dir after setup equals a direct install.sh run into a twin, and nothing else was written. */
function expectTodaysInstall(t: Sandbox, twin: string): void {
  t.install(twin);
  const settings = (dir: string) => readFileSync(path.join(dir, "settings.json"), "utf8").split(dir).join("X");
  expect(settings(t.claudeDir)).toBe(settings(twin));
  expect(scripts(t.claudeDir)).toEqual(scripts(twin));
  expect(scripts(t.claudeDir)).not.toContain(null);
  expect(existsSync(t.db), "database").toBe(false);
  expect(present(linkOf(t)), "link").toBe(false);
  expect(existsSync(config()), "config").toBe(false);
  expect(existsSync(t.browserLog), "browser").toBe(false);
}

/** A twin Claude dir, installed into already when the case is an existing install. */
function twinFor(t: Sandbox, existing: boolean): string {
  const twin = mkdtempSync(path.join(tmpdir(), "wt-setup-twin-"));
  if (existing) {
    t.install(t.claudeDir);
    t.install(twin);
  }
  return twin;
}

const passThrough: Runner = (cmd, args, o) => {
  const r = spawnSync(cmd, args, { env: o.env, cwd: o.cwd, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * runSetup in this process, with an injected runner that records every call.
 * HOME points into the sandbox for the call, because the config defaults
 * expand `~` through os.homedir().
 */
async function inProcess(t: Sandbox, argv: string[], runner: Runner): Promise<{ code: number; out: string; calls: string[][] }> {
  const calls: string[][] = [];
  let out = "";
  const before = process.env.HOME;
  process.env.HOME = t.home;
  try {
    const code = await runSetup(argv, t.env, {
      checkout: t.checkout,
      cwd: t.home,
      out: (s) => { out += s; },
      err: (s) => { out += s; },
      asker: { ask: () => { throw new Error("asked a question in a non-interactive run"); } },
      runner: (cmd, args, o) => {
        calls.push([cmd, ...args]);
        return runner(cmd, args, o);
      },
    });
    return { code, out, calls };
  } finally {
    if (before === undefined) delete process.env.HOME;
    else process.env.HOME = before;
  }
}

/** The calls that come after the install: backfill, sync and open. */
const laterCalls = (calls: string[][]) =>
  calls.filter((c) => c.some((a) => /watchtower-ingest\.sh|claude-usage-rollup\.sh$/.test(a) || a === "sync" || a === "open"));

describe("watchtower setup", { timeout: slow(60_000) }, () => {
  // Guard 6.
  it("non-interactive without flags is today's install", async () => {
    for (const existing of [false, true]) {
      const t = await sandbox(checkout);
      const twin = twinFor(t, existing);
      const r = t.setup([]);
      expect(`${r.status}: ${r.stderr}`, existing ? "existing" : "fresh").toBe("0: ");
      expectTodaysInstall(t, twin);
    }
  });

  // Guard 7.
  it("Enter through every question on an existing install is today's install", async () => {
    const t = await sandbox(checkout);
    const twin = twinFor(t, true);
    const r = t.setup([], { input: "\n".repeat(10) });
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(r.stdout).toContain("?");
    expectTodaysInstall(t, twin);
  });

  // Guard 8.
  it("--yes on a fresh home sets everything up", async () => {
    const t = await sandbox(checkout);
    execFileSync("bash", [MAKE_TRANSCRIPTS, "single", path.join(t.claudeDir, "projects")]);
    const r = t.setup(["--yes"]);
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");

    const settings = JSON.parse(readFileSync(path.join(t.claudeDir, "settings.json"), "utf8"));
    expect(settings.statusLine.command).toBe(`${t.claudeDir}/watchtower-snapshot.sh`);
    expect(Number(execFileSync("sqlite3", [t.db, "SELECT COUNT(*) FROM claude_requests;"], { encoding: "utf8" }))).toBeGreaterThan(0);
    expect(realpathSync(linkOf(t))).toBe(realpathSync(path.join(t.checkout, "bin", "watchtower")));
    expect(await opened(t)).toContain(`http://127.0.0.1:${t.port}/`);
    expect(r.stdout).toContain(CLOSING);
  });

  // Guard 10.
  it("an existing config is left alone", async () => {
    const t = await sandbox(checkout);
    const text = '{"dashboard":{"port":4400}}';
    writeFileSync(config(), text);
    mkdirSync(path.join(t.home, ".codex", "sessions"), { recursive: true });
    writeFileSync(path.join(t.home, ".codex", "sessions", "placeholder"), "");

    const r = t.setup(["--no-status-line", "--no-backfill", "--no-link", "--no-open"], { input: "\n".repeat(10) });
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(r.stdout).not.toContain("Track");
    expect(r.stdout).toContain(config());
    expect(readFileSync(config(), "utf8")).toBe(text);
  });

  // Guard 11.
  it("an existing link elsewhere keeps its target", async () => {
    const t = await sandbox(checkout);
    mkdirSync(path.dirname(linkOf(t)), { recursive: true });
    symlinkSync("/bin/echo", linkOf(t));

    const r = t.setup(["--yes", "--no-backfill", "--no-open"]);
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(linkTarget(linkOf(t))).toBe("/bin/echo");
    expect(r.stdout).toContain("/bin/echo");
  });

  // Guard 12.
  it("a preview mismatch stops setup", async () => {
    const t = await sandbox(checkout);
    const settings = path.join(t.claudeDir, "settings.json");
    const r = await inProcess(t, ["--yes"], (cmd, args, o) => {
      if (args.some((a) => a.endsWith("install.sh")) && !args.includes("--dry-run")) {
        writeFileSync(settings, "{}\n");
        return { status: 0, stdout: "", stderr: "" };
      }
      return passThrough(cmd, args, o);
    });
    expect(r.code).toBe(1);
    expect(laterCalls(r.calls)).toEqual([]);
    expect(present(linkOf(t))).toBe(false);
    expect(r.out).toContain(path.join(t.claudeDir, "backups"));
  });

  it("a failing step stops setup and says which", async () => {
    const t = await sandbox(checkout);
    const r = await inProcess(t, ["--yes"], (cmd, args, o) =>
      [cmd, ...args].some((a) => a.endsWith("watchtower-ingest.sh")) ? { status: 3, stdout: "", stderr: "" } : passThrough(cmd, args, o));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/backfill[^\n]*exited 3/);
    expect(r.out).toMatch(/done: install/i);
    // The failing ingest is the last call: no rollup, sync or open after it.
    const later = laterCalls(r.calls);
    expect(later).toHaveLength(1);
    expect(later[0].some((a) => a.endsWith("watchtower-ingest.sh"))).toBe(true);
    expect(present(linkOf(t))).toBe(false);
  });

  it("invalid settings.json stops setup before any question", async () => {
    const t = await sandbox(checkout);
    const settings = path.join(t.claudeDir, "settings.json");
    writeFileSync(settings, "{not json");
    const r = t.setup([], { input: "\n".repeat(10) });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("?");
    expect(r.stderr).toContain(settings);
    expect(readFileSync(settings, "utf8")).toBe("{not json");
    expect(scripts(t.claudeDir)).toEqual(INSTALLED.map(() => null));
  });

  it("stdin ending mid-questions writes nothing", async () => {
    const t = await sandbox(checkout);
    const r = t.setup([], { input: "\n" });
    expect(r.status).toBe(1);
    expect(existsSync(path.join(t.claudeDir, "settings.json"))).toBe(false);
    expect(scripts(t.claudeDir)).toEqual(INSTALLED.map(() => null));
  });

  it("answering No to Apply writes nothing", async () => {
    const t = await sandbox(checkout);
    // Status line, backfill, link, open: yes. Then Apply: no.
    const r = t.setup([], { input: "y\ny\ny\ny\nn\n" });
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(r.stdout).toContain("Nothing was changed.");
    expect(existsSync(path.join(t.claudeDir, "settings.json"))).toBe(false);
    expect(scripts(t.claudeDir)).toEqual(INSTALLED.map(() => null));
    expect(existsSync(t.db)).toBe(false);
    expect(present(linkOf(t))).toBe(false);
    expect(existsSync(config())).toBe(false);
    expect(existsSync(t.browserLog)).toBe(false);
  });

  it("a second setup --yes changes nothing", async () => {
    const t = await sandbox(checkout);
    expect(t.setup(["--yes"]).status).toBe(0);
    const settings = () => readFileSync(path.join(t.claudeDir, "settings.json"), "utf8");
    const before = { settings: settings(), scripts: scripts(t.claudeDir), link: linkTarget(linkOf(t)) };

    const r = t.setup(["--yes"]);
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(r.stdout).toContain("settings.json: no change");
    expect({ settings: settings(), scripts: scripts(t.claudeDir), link: linkTarget(linkOf(t)) }).toEqual(before);
    expect(existsSync(config())).toBe(false);
  });

  it("a config written by setup is read from another directory", async () => {
    const t = await sandbox(checkout);
    const r = t.setup(["--disable", "codex", "--no-backfill", "--no-link", "--no-open"], { cwd: t.home });
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(existsSync(config())).toBe(true);

    const sync = t.cli(["sync", "--no-rollup"], { cwd: t.home });
    expect(`${sync.status}: ${sync.stderr}`).toBe("0: ");
    const ids = (JSON.parse(sync.stdout).sources as { source: string }[]).map((s) => s.source);
    expect(ids).toContain("hermes");
    expect(ids).not.toContain("codex");
  });
});
