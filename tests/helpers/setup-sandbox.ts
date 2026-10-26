import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

// `watchtower setup` writes into the checkout (its config) and under $HOME (the
// ~/.local/bin link), so no setup test may run the real checkout or the real
// home. Every test runs a temp copy of the checkout under a temp HOME, with
// CLAUDE_DIR, the database, the browser and the dashboard port all inside it.

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** What install.sh writes under the Claude dir, besides settings.json and backups. */
export const INSTALLED = [
  "cc-track-lib.sh", "hooks/cc-track-hook.sh", "claude-usage-rollup.sh",
  "watchtower-snapshot.sh", "watchtower-ingest.sh",
] as const;

/** A temp copy of the checkout: bin/, lib/, capture/ and package.json. One per test file. */
export function makeCheckout(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-setup-checkout-"));
  for (const p of ["bin", "lib", "capture", "package.json"]) {
    cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
  }
  return dir;
}

/** A port nothing listens on, from the OS. */
async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

/** The environment with every Watchtower and capture override removed. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("WATCHTOWER_") || k.startsWith("CC_") || k === "CLAUDE_DIR") delete env[k];
  }
  return env;
}

export interface Run { status: number | null; stdout: string; stderr: string }

export interface Sandbox {
  checkout: string;
  home: string;
  claudeDir: string;
  db: string;
  env: NodeJS.ProcessEnv;
  browserLog: string;
  port: number;
  /** `node <checkout>/bin/watchtower setup …`. With `input`, interactive (P1) with that stdin. */
  setup(args: string[], o?: { input?: string; cwd?: string }): Run;
  /** Any other `watchtower` command, from `cwd` (default: HOME). */
  cli(args: string[], o?: { cwd?: string }): Run;
  /** `bash <checkout>/capture/install.sh` into `dir`, as a user runs it today. */
  install(dir: string): void;
}

const made: Sandbox[] = [];

/** One user's world: a temp HOME with .claude/, a stub browser and a free port. */
export async function sandbox(checkout: string): Promise<Sandbox> {
  const home = mkdtempSync(path.join(tmpdir(), "wt-setup-home-"));
  const claudeDir = path.join(home, ".claude");
  mkdirSync(claudeDir);
  // Its own directory: the .schema-vN marker lives beside the database.
  const db = path.join(home, "db", "watchtower.sqlite");
  const browserLog = path.join(home, "browser.log");
  const browser = path.join(home, "browser.sh");
  writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${browserLog}'\n`);
  chmodSync(browser, 0o755);
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(), HOME: home, CLAUDE_DIR: claudeDir, WATCHTOWER_DB_PATH: db,
    WATCHTOWER_BROWSER: browser, WATCHTOWER_DASHBOARD_PORT: String(port), WATCHTOWER_SYNC_SECONDS: "0",
  };
  const bin = path.join(checkout, "bin", "watchtower");
  const node = (args: string[], o: { input?: string; cwd?: string; env: NodeJS.ProcessEnv }): Run => {
    const r = spawnSync(process.execPath, [bin, ...args], {
      cwd: o.cwd ?? home, env: o.env, input: o.input ?? "", encoding: "utf8", timeout: 120_000,
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const t: Sandbox = {
    checkout, home, claudeDir, db, env, browserLog, port,
    setup: (args, o = {}) => node(["setup", ...args], {
      ...o, env: o.input === undefined ? env : { ...env, WATCHTOWER_SETUP_INTERACTIVE: "1" },
    }),
    cli: (args, o = {}) => node(args, { ...o, env }),
    install: (dir) => {
      execFileSync("bash", [path.join(checkout, "capture", "install.sh")], { env: { ...env, CLAUDE_DIR: dir }, stdio: "ignore" });
    },
  };
  made.push(t);
  return t;
}

/** Stop every dashboard a sandbox may have opened. For afterEach. */
export function stopDashboards(): void {
  for (const t of made.splice(0)) t.cli(["stop", "--port", String(t.port)]);
}

/** A path's own existence, a dangling symlink included. */
export function present(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** A symlink's target, or null when there is no link. */
export function linkTarget(p: string): string | null {
  return present(p) ? readlinkSync(p) : null;
}
