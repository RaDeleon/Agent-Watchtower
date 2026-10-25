/**
 * `watchtower setup`: one guided command from a checkout to an open dashboard.
 *
 * Facts first (facts.ts), then every question, all before anything is written,
 * so Ctrl-C or the end of input leaves nothing changed. Then the preview: the
 * exact settings.json change, as install.sh's own dry run prints it. Then the
 * steps, in order, each stopping setup if it fails: install.sh (the only
 * writer under the Claude dir), the config, the backfill, the PATH link and
 * `watchtower open`. After the install, settings.json must equal the preview.
 *
 * The decisions are plan.ts's; this file asks, prints and runs. Its process
 * runner is injected, so a test can make install.sh misbehave.
 *
 * Imported by bin/watchtower under plain Node, so relative `.ts` imports only.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { childEnv, gatherFacts, linkState, type Runner, type SetupFacts } from "./facts.ts";
import {
  APPLY, choose, parseFlags, questionsFor, SETUP_USAGE, sourcesConfig, stepsFor,
  type Choices, type Flags, type Question, type QuestionKey, type Step,
} from "./plan.ts";

/** Asks one question. `null` means the input ended. */
export interface Asker { ask(q: Question): Promise<boolean | null> }

type Mode = "interactive" | "yes" | "none";

/** This checkout: lib/setup/ is two levels below it. */
const CHECKOUT = path.resolve(import.meta.dirname, "../..");

/** Printed on a fresh install only (ruling P8): a backfill recovers tokens, not hook events. */
const CLOSING = "Tokens, cost and the Usage Profile cover your past history. Active hours, levels and quests start with your next Claude Code session.";

/** The real runner. Children never read stdin: the answers were all taken before any step ran. */
export const spawnRunner: Runner = (cmd, args, o) => {
  const r = spawnSync(cmd, args, {
    env: o.env, cwd: o.cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    stdio: o.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
  });
  if (r.error !== undefined) return { status: 127, stdout: "", stderr: `${cmd}: ${r.error.message}` };
  const status = r.status ?? 128 + (r.signal !== null ? os.constants.signals[r.signal] : 0);
  return { status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const prompt = (q: Question): string => `${q.text} ${q.def ? "[Y/n]" : "[y/N]"} `;

/** y or yes, n or no, or an empty line for the question's default. Anything else is not an answer. */
function parseAnswer(line: string, def: boolean): boolean | undefined {
  const a = line.trim().toLowerCase();
  if (a === "") return def;
  if (a === "y" || a === "yes") return true;
  if (a === "n" || a === "no") return false;
  return undefined;
}

/**
 * Ruling P1, for WATCHTOWER_SETUP_INTERACTIVE=1: stdin, read to its end once,
 * one line per question, with each question and its answer echoed. readline is
 * not used here, because it drops piped lines that arrive before a question is
 * asked.
 */
function lineAsker(input: string, out: (s: string) => void): Asker {
  const lines = input === "" ? [] : input.replace(/\n$/, "").split("\n");
  let next = 0;
  return {
    async ask(q) {
      for (;;) {
        if (next >= lines.length) {
          out(`${prompt(q)}\n`);
          return null;
        }
        const line = lines[next++].replace(/\r$/, "");
        out(`${prompt(q)}${line}\n`);
        const a = parseAnswer(line, q.def);
        if (a !== undefined) return a;
        out("Please answer y or n.\n");
      }
    },
  };
}

/** A real terminal. Ctrl-D, or Ctrl-C while a question is open, ends the input. */
function terminalAsker(): Asker & { close(): void } {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  let pending: ((line: string | null) => void) | null = null;
  rl.on("close", () => {
    closed = true;
    pending?.(null);
    pending = null;
  });
  rl.on("SIGINT", () => {
    process.stdout.write("\n");
    rl.close();
  });
  const line = (p: string): Promise<string | null> => new Promise((resolve) => {
    if (closed) {
      resolve(null);
      return;
    }
    pending = resolve;
    rl.question(p, (answer) => {
      pending = null;
      resolve(answer);
    });
  });
  return {
    async ask(q) {
      for (;;) {
        const l = await line(prompt(q));
        if (l === null) return null;
        const a = parseAnswer(l, q.def);
        if (a !== undefined) return a;
        process.stdout.write("Please answer y or n.\n");
      }
    },
    close: () => {
      if (!closed) rl.close();
    },
  };
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A path as a shell word, for the commands printed for later. */
function sh(p: string): string {
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
}

function printFacts(f: SetupFacts, out: (s: string) => void): void {
  const row = (label: string, value: string) => out(`  ${label.padEnd(13)}${value}\n`);
  out("Watchtower setup\n\n");
  row("Claude Code", `${f.claudeDir} (${f.fresh ? "capture not installed yet" : "capture installed"})`);
  row("Database", `${f.db.path} (${f.db.exists ? "existing" : "new"})`);
  row("Config", f.configFile === null ? "none, so the defaults apply" : `${f.configFile} (setup leaves it as it is)`);
  for (const s of f.sources) row(s.label, s.detected ? `found${s.detail === undefined ? "" : ` at ${s.detail}`}` : "not found");

  let statusLine: string;
  if (f.statusLineOffered) {
    statusLine = "none set";
  } else {
    let cmd: unknown;
    try {
      cmd = (JSON.parse(f.settingsNow ?? "{}") as { statusLine?: { command?: unknown } }).statusLine?.command;
    } catch {
      cmd = undefined;
    }
    statusLine = typeof cmd === "string" && cmd !== ""
      ? `${cmd} (${cmd.includes("watchtower-snapshot.sh") ? "records snapshots" : "setup leaves it as it is"})`
      : "snapshot capture already wired";
  }
  row("Status line", statusLine);

  const named = (state: "new" | "changed") =>
    f.scripts.filter((s) => s.state === state).map((s) => path.relative(f.claudeDir, s.dest));
  const fresh = named("new");
  const changed = named("changed");
  const scripts = [
    ...(fresh.length > 0 ? [`${fresh.length} to install`] : []),
    ...(changed.length > 0 ? [`${changed.join(", ")} to replace (backed up first)`] : []),
  ];
  row("Scripts", scripts.length > 0 ? scripts.join("; ") : "up to date");

  const l = f.link;
  row("PATH link", l.state === "absent" ? `none at ${l.path}`
    : l.state === "ours" ? `${l.path} links to this checkout`
    : `${l.path} ${l.target === undefined ? "is not a link" : `links to ${l.target}`}; setup leaves it alone`);
}

/** The diff from today's settings.json to the one setup would write, or `settings.json: no change`. */
function showPreview(f: SetupFacts, preview: string, c: { runner: Runner; env: NodeJS.ProcessEnv; out: (s: string) => void }): void {
  if (f.settingsNow === preview) {
    c.out("\nsettings.json: no change\n");
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "watchtower-setup-"));
  try {
    const after = path.join(dir, "settings.json");
    writeFileSync(after, preview);
    const r = c.runner("diff", [
      "-u", "--label", f.settingsPath, "--label", `${f.settingsPath} (after setup)`,
      f.settingsNow === null ? "/dev/null" : f.settingsPath, after,
    ], { env: c.env, capture: true });
    c.out(`\nThe change to settings.json:\n${r.stdout}`);
    if (r.status > 1) c.out(`(diff could not compare them: ${r.stderr.trim()})\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The questions, the choices and the preview. A number is an exit code: setup ends there. */
async function decide(
  f: SetupFacts, flags: Flags, mode: Mode, asker: Asker | undefined,
  c: { runner: Runner; env: NodeJS.ProcessEnv; out: (s: string) => void },
): Promise<{ choices: Choices; preview: string } | number> {
  const ended = (): number => {
    c.out("\nThe input ended before every question was answered. Nothing was written.\n");
    return 1;
  };
  const answers = new Map<QuestionKey, boolean>();
  if (mode === "interactive" && asker !== undefined) {
    const questions = questionsFor(f, flags);
    if (questions.length > 0) c.out("\nEnter takes the default, the capital letter.\n");
    for (const q of questions) {
      const a = await asker.ask(q);
      if (a === null) return ended();
      answers.set(q.key, a);
    }
  }
  const choices = choose(f, flags, mode, answers);
  const preview = choices.statusLine ? f.preview.withStatusLine : f.preview.plain;
  showPreview(f, preview, c);
  if (mode === "interactive" && asker !== undefined) {
    const a = await asker.ask(APPLY);
    if (a === null) return ended();
    if (!a) {
      c.out("Nothing was changed.\n");
      return 0;
    }
  }
  return { choices, preview };
}

interface Apply {
  f: SetupFacts; choices: Choices; preview: string; env: NodeJS.ProcessEnv;
  cwd: string; checkout: string; runner: Runner; out: (s: string) => void;
}

/** The steps in order. The first that fails stops setup, naming itself and what already ran. */
function applySteps(steps: Step[], c: Apply): number {
  const { f, out } = c;
  const env = childEnv(c.env, f.claudeDir, f.db.path);
  const ownBin = path.join(c.checkout, "bin", "watchtower");
  const ingest = path.join(f.claudeDir, "watchtower-ingest.sh");
  const rollup = path.join(f.claudeDir, "claude-usage-rollup.sh");
  const done: string[] = [];
  const lines: string[] = [];

  const stop = (why: string): number => {
    out(`\nsetup stopped: ${why}.\n`);
    out(`Already done: ${done.length > 0 ? done.join(", ") : "nothing"}.\n`);
    out("Every step is safe to repeat, so running watchtower setup again picks up from here.\n");
    return 1;
  };
  /** Name a command, then run it with its output passed through. */
  const run = (label: string, cmd: string, args: string[], extra: NodeJS.ProcessEnv = {}): number => {
    out(`\n==> ${label}\n`);
    return c.runner(cmd, args, { env: { ...env, ...extra }, capture: false, cwd: c.cwd }).status;
  };

  for (const step of steps) {
    if (step.kind === "install") {
      const install = path.join(c.checkout, "capture", "install.sh");
      const args = step.statusLine ? [install, "--status-line"] : [install];
      const status = run(`bash ${args.join(" ")}`, "bash", args);
      if (status !== 0) return stop(`the install (${install}) exited ${status}`);
      done.push("install");
      // The preview is the file (spec §5.2, step 4.1). Anything else stops
      // setup before any other step runs.
      const now = existsSync(f.settingsPath) ? readFileSync(f.settingsPath, "utf8") : null;
      if (now !== c.preview) {
        out(`\n${f.settingsPath} is not the file setup previewed. install.sh backs up the settings.json it replaces in ${path.join(f.claudeDir, "backups")}.\n`);
        return stop("settings.json differs from its preview");
      }
      lines.push(`Capture is installed in ${f.claudeDir}.`);
    } else if (step.kind === "config") {
      const file = path.join(c.checkout, "watchtower.config.json");
      if (existsSync(file)) return stop(`${file} appeared while setup ran, so it was left alone`);
      const tmp = path.join(c.checkout, `.watchtower.config.json.${process.pid}.tmp`);
      try {
        writeFileSync(tmp, sourcesConfig(step.disable));
        renameSync(tmp, file);
      } catch (e) {
        rmSync(tmp, { force: true });
        return stop(`the config could not be written: ${message(e)}`);
      }
      done.push("config");
      lines.push(`Wrote ${file}: ${step.disable.join(", ")} off, every other source as shipped.`);
    } else if (step.kind === "backfill") {
      const commands: [string, string, string[], NodeJS.ProcessEnv?][] = [
        [`${ingest} --backfill`, ingest, ["--backfill"]],
        [`${rollup} --resolve`, rollup, ["--resolve"]],
        [`${ownBin} sync`, process.execPath, [ownBin, "sync"], { WATCHTOWER_ROLLUP_PATH: rollup }],
      ];
      for (const [label, cmd, args, extra] of commands) {
        const status = run(label, cmd, args, extra);
        if (status !== 0) return stop(`the backfill step (${label}) exited ${status}`);
      }
      done.push("backfill");
      lines.push(`Read your existing history into ${f.db.path}.`);
    } else if (step.kind === "link") {
      // Spec decision 9: the link never overwrites. Whatever is there now is
      // reported and left alone.
      const now = linkState(f.link.path, ownBin);
      if (now.state === "absent") {
        try {
          mkdirSync(path.dirname(f.link.path), { recursive: true });
          symlinkSync(ownBin, f.link.path);
        } catch (e) {
          return stop(`the link could not be made: ${message(e)}`);
        }
        done.push("link");
        lines.push(`Linked ${f.link.path} to ${ownBin}.`);
      } else if (now.state === "ours") {
        lines.push(`${f.link.path} already links to this checkout.`);
      } else {
        lines.push(`${f.link.path} already exists${now.target === undefined ? "" : ` and links to ${now.target}`}; setup left it alone.`);
      }
    } else {
      const status = run(`${ownBin} open`, process.execPath, [ownBin, "open"]);
      if (status !== 0) return stop(`opening the dashboard (${ownBin} open) exited ${status}`);
      done.push("open");
      lines.push("Opened the dashboard.");
    }
  }

  out("\nSetup is done.\n");
  for (const l of lines) out(`  ${l}\n`);
  const later: string[] = [];
  if (f.statusLineOffered && !c.choices.statusLine) {
    later.push(`Use the status line:     bash ${sh(path.join(c.checkout, "capture", "install.sh"))} --status-line`);
  }
  if (!c.choices.backfill) {
    later.push(`Read your history:       ${sh(ingest)} --backfill && ${sh(rollup)} --resolve && ${sh(ownBin)} sync`);
  }
  if (!c.choices.link && f.link.state === "absent") {
    later.push(`Put it on your PATH:     mkdir -p ~/.local/bin && ln -s ${sh(ownBin)} ~/.local/bin/watchtower`);
  }
  if (!c.choices.open) later.push(`Open the dashboard:      ${sh(ownBin)}`);
  if (later.length > 0) {
    out("\nTo do later, if you want to:\n");
    for (const l of later) out(`  ${l}\n`);
  }
  if (linkState(f.link.path, ownBin).state === "ours" && !f.link.onPath) {
    out("\n~/.local/bin is not on your PATH. To put it there, add this line to your shell profile:\n");
    out("  export PATH=\"$HOME/.local/bin:$PATH\"\n");
  }
  if (f.fresh) out(`\n${CLOSING}\n`);
  return 0;
}

export async function runSetup(
  argv: string[], env: NodeJS.ProcessEnv,
  io: {
    out?: (s: string) => void; err?: (s: string) => void; asker?: Asker; runner?: Runner;
    cwd?: string; checkout?: string;
  } = {},
): Promise<number> {
  const out = io.out ?? ((s: string) => { process.stdout.write(s); });
  const err = io.err ?? ((s: string) => { process.stderr.write(s); });
  const runner = io.runner ?? spawnRunner;
  const cwd = io.cwd ?? process.cwd();
  const checkout = io.checkout ?? CHECKOUT;

  if (argv.includes("--help") || argv.includes("-h")) {
    out(`${SETUP_USAGE}\n`);
    return 0;
  }
  const flags = parseFlags(argv);
  if ("error" in flags) {
    err(`setup: ${flags.error}\n${SETUP_USAGE}\n`);
    return 2;
  }

  const f = await gatherFacts({ env, cwd, checkout, runner });
  if ("error" in f) {
    err(`${f.error}\n`);
    return 1;
  }
  if (flags.disable !== undefined && f.configFile !== null) {
    err(`setup: --disable writes a new config, but ${f.configFile} exists; edit that file instead\n`);
    return 2;
  }

  // Spec §5.3: interactive on a terminal, or when the suite forces it, and
  // never under --yes. Otherwise a flag or `today` answers each question.
  const forced = env.WATCHTOWER_SETUP_INTERACTIVE === "1";
  const mode: Mode = flags.yes ? "yes"
    : forced || (process.stdin.isTTY === true && process.stdout.isTTY === true) ? "interactive"
    : "none";

  printFacts(f, out);

  let asker = io.asker;
  let close = (): void => {};
  if (mode === "interactive" && asker === undefined) {
    if (forced) {
      asker = lineAsker(readStdin(), out);
    } else {
      const t = terminalAsker();
      asker = t;
      close = t.close;
    }
  }
  let decided: Awaited<ReturnType<typeof decide>>;
  try {
    decided = await decide(f, flags, mode, asker, { runner, env, out });
  } finally {
    close();
  }
  if (typeof decided === "number") return decided;
  return applySteps(stepsFor(decided.choices), {
    f, choices: decided.choices, preview: decided.preview, env, cwd, checkout, runner, out,
  });
}
