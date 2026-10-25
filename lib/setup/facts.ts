/**
 * What `watchtower setup` finds before it asks anything. It reads and writes
 * nothing of its own: the only processes it runs are install.sh's two dry runs
 * (ruling P4), and install.sh writes nothing under --dry-run.
 *
 * The status-line state is install.sh's, not a second detector's: setup asks
 * about the status line exactly when `--dry-run --status-line` prints a
 * different settings.json than `--dry-run`, and the chosen output is the
 * preview, so the preview and the real run come from one jq program.
 *
 * Imported by bin/watchtower under plain Node, so relative `.ts` imports only.
 */
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { adaptersFor } from "../adapters/index.ts";
import { configFileFor, loadConfig, type WatchtowerConfig } from "../config.ts";
import { safeDetect } from "../core/adapters.ts";

/** Runs a process. `capture: false` passes its output straight through to the terminal. */
export type Runner = (
  cmd: string, args: string[], o: { env: NodeJS.ProcessEnv; capture: boolean; cwd?: string },
) => { status: number; stdout: string; stderr: string };

export interface SetupFacts {
  /** Capture is not installed yet: `<claudeDir>/cc-track-lib.sh` does not exist (spec decision 3). */
  fresh: boolean;
  claudeDir: string;
  checkout: string;
  db: { path: string; exists: boolean };
  /** The config file loadConfig reads, or null when defaults apply. */
  configFile: string | null;
  /** Every enabled source but Claude, in adaptersFor's order. */
  sources: { id: string; label: string; detected: boolean; detail?: string }[];
  /** install.sh would add a status line: the two dry runs differ. */
  statusLineOffered: boolean;
  settingsPath: string;
  /** settings.json as it is now, or null when there is none. */
  settingsNow: string | null;
  /** The settings.json install.sh would write, without and with --status-line. */
  preview: { plain: string; withStatusLine: string };
  scripts: { src: string; dest: string; state: "new" | "changed" | "same" }[];
  link: { path: string; state: "absent" | "ours" | "other"; target?: string; onPath: boolean };
}

/** install.sh's sources and where it installs each, relative to the Claude dir. */
const SCRIPTS: readonly (readonly [string, string])[] = [
  ["lib.sh", "cc-track-lib.sh"],
  ["hook.sh", "hooks/cc-track-hook.sh"],
  ["rollup.sh", "claude-usage-rollup.sh"],
  ["snapshot.sh", "watchtower-snapshot.sh"],
  ["ingest.sh", "watchtower-ingest.sh"],
];

/**
 * The environment every child of setup runs with (ruling P3): the Claude dir,
 * the lib the capture scripts source, and the database setup reported, so a
 * backfill lands where the dashboard reads. Everything else passes through.
 */
export function childEnv(env: NodeJS.ProcessEnv, claudeDir: string, db: string): NodeJS.ProcessEnv {
  return { ...env, CLAUDE_DIR: claudeDir, CC_LIB_PATH: path.join(claudeDir, "cc-track-lib.sh"), WATCHTOWER_DB_PATH: db };
}

/** What is at `linkPath`: nothing, a link to `ownBin`, or something else (and where it points). */
export function linkState(linkPath: string, ownBin: string): { state: "absent" | "ours" | "other"; target?: string } {
  let isLink: boolean;
  try {
    isLink = lstatSync(linkPath).isSymbolicLink();
  } catch {
    return { state: "absent" };
  }
  const target = isLink ? readlinkSync(linkPath) : undefined;
  try {
    if (realpathSync(linkPath) === realpathSync(ownBin)) return { state: "ours", target };
  } catch {
    // A dangling link, or no ownBin: either way it is not this checkout's.
  }
  return { state: "other", target };
}

function scriptState(src: string, dest: string): "new" | "changed" | "same" {
  if (!existsSync(dest)) return "new";
  try {
    return readFileSync(src).equals(readFileSync(dest)) ? "same" : "changed";
  } catch {
    return "changed";
  }
}

/** The last non-empty line of a failed run's stderr: install.sh's own message, verbatim (ruling R4). */
function lastLine(r: { status: number; stderr: string }, what: string): string {
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  return lines.length > 0 ? lines[lines.length - 1] : `${what} exited ${r.status}`;
}

export async function gatherFacts(o: {
  env: NodeJS.ProcessEnv; cwd: string; checkout: string; runner: Runner;
}): Promise<SetupFacts | { error: string }> {
  const home = o.env.HOME || os.homedir();
  let cfg: WatchtowerConfig;
  try {
    cfg = loadConfig({ cwd: o.cwd, checkoutDir: o.checkout, env: o.env });
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  const claudeDir = o.env.CLAUDE_DIR || cfg.capture.installDir;
  const settingsPath = path.join(claudeDir, "settings.json");

  // The two dry runs, first: a settings.json install.sh refuses stops setup
  // before it prints a fact or asks a question.
  const install = path.join(o.checkout, "capture", "install.sh");
  const env = childEnv(o.env, claudeDir, cfg.database.path);
  const plain = o.runner("bash", [install, "--dry-run"], { env, capture: true, cwd: o.cwd });
  if (plain.status !== 0) return { error: lastLine(plain, "install.sh --dry-run") };
  const withStatusLine = o.runner("bash", [install, "--dry-run", "--status-line"], { env, capture: true, cwd: o.cwd });
  if (withStatusLine.status !== 0) return { error: lastLine(withStatusLine, "install.sh --dry-run --status-line") };

  const sources: SetupFacts["sources"] = [];
  for (const a of adaptersFor(cfg, { home })) {
    if (a.id === "claude") continue;
    const d = await safeDetect(a);
    sources.push({ id: a.id, label: a.label, detected: d.detected, detail: d.detail });
  }

  const linkPath = path.join(home, ".local", "bin", "watchtower");
  const linkDir = path.dirname(linkPath);
  const onPath = (o.env.PATH ?? "").split(path.delimiter)
    .some((p) => p !== "" && path.resolve(p.replace(/^~(?=\/|$)/, home)) === linkDir);

  return {
    fresh: !existsSync(path.join(claudeDir, "cc-track-lib.sh")),
    claudeDir,
    checkout: o.checkout,
    db: { path: cfg.database.path, exists: existsSync(cfg.database.path) },
    configFile: configFileFor(o.cwd, o.checkout),
    sources,
    statusLineOffered: plain.stdout !== withStatusLine.stdout,
    settingsPath,
    settingsNow: existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null,
    preview: { plain: plain.stdout, withStatusLine: withStatusLine.stdout },
    scripts: SCRIPTS.map(([src, dest]) => {
      const s = path.join(o.checkout, "capture", src);
      const d = path.join(claudeDir, dest);
      return { src: s, dest: d, state: scriptState(s, d) };
    }),
    link: { path: linkPath, ...linkState(linkPath, path.join(o.checkout, "bin", "watchtower")), onPath },
  };
}
