/**
 * `watchtower setup`'s decisions, as pure functions: facts, flags and answers
 * in; choices and ordered steps out. Every default in the spec's §5.2 table
 * lives here, and nothing here reads a file or runs a process.
 *
 * Each question carries two values (ruling P2): `def`, which the prompt shows
 * and which Enter and `--yes` take, and `today`, which a non-interactive run
 * without `--yes` takes. On an existing install the two are equal for every
 * question, so pressing Enter throughout gives exactly today's install.
 *
 * Imported by bin/watchtower under plain Node, so relative `.ts` imports only.
 */
import type { SetupFacts } from "./facts.ts";

export type QuestionKey = "statusLine" | "backfill" | "link" | "open" | "apply" | `source:${string}`;

export interface Question { key: QuestionKey; text: string; def: boolean; today: boolean }

export interface Flags {
  yes: boolean;
  statusLine?: boolean;
  backfill?: boolean;
  link?: boolean;
  open?: boolean;
  /** Source ids to turn off. Given, it answers every source question. */
  disable?: string[];
}

export interface Choices { statusLine: boolean; disable: string[]; backfill: boolean; link: boolean; open: boolean }

export type Step =
  | { kind: "install"; statusLine: boolean }
  | { kind: "config"; disable: string[] }
  | { kind: "backfill" }
  | { kind: "link" }
  | { kind: "open" };

export const SETUP_USAGE =
  "usage: watchtower setup [--yes] [--[no-]status-line|backfill|link|open] [--disable <id,…>]";

/** The sources setup can turn off, in adaptersFor's order. Claude is the one it installs. */
export const SOURCE_IDS: readonly string[] = ["codex", "hermes", "openviking", "atlas"];

// Ruling P5: shipped defaults that a written config must restate, because a
// config's source map replaces the defaults rather than merging with them.
// tests/setup-plan.test.ts holds them equal to lib/config.ts's defaults.
const OPENVIKING_BASE_URL = "http://127.0.0.1:1933";
const ATLAS_ROOTS = ["~/Developer"];

/** What each source reads, for its question. */
const READS: Record<string, string> = {
  codex: "rollout files under ~/.codex, counts only",
  hermes: "~/.hermes/state.db, read-only",
  openviking: `local counters, and requests /health from ${OPENVIKING_BASE_URL}`,
  atlas: `checkpoints under ${ATLAS_ROOTS.join(", ")}`,
};

/** Asked after the preview, in interactive mode only. */
export const APPLY: Question = { key: "apply", text: "Apply?", def: true, today: true };

const SWITCHES = { "status-line": "statusLine", backfill: "backfill", link: "link", open: "open" } as const;

/** The command line after `setup`. A usage error is `{ error }`, never a throw. */
export function parseFlags(argv: string[]): Flags | { error: string } {
  const f: Flags = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") {
      f.yes = true;
      continue;
    }
    if (a === "--disable" || a.startsWith("--disable=")) {
      const v = a === "--disable" ? argv[++i] : a.slice("--disable=".length);
      if (v === undefined || v.startsWith("--")) return { error: "--disable expects source ids, for example --disable codex,hermes" };
      const ids = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
      if (ids.length === 0) return { error: "--disable expects source ids, for example --disable codex,hermes" };
      const unknown = ids.filter((id) => !SOURCE_IDS.includes(id));
      if (unknown.length > 0) {
        return { error: `--disable: unknown source ${unknown.join(", ")}; expected ${SOURCE_IDS.join(", ")}` };
      }
      const all = new Set([...(f.disable ?? []), ...ids]);
      f.disable = SOURCE_IDS.filter((id) => all.has(id));
      continue;
    }
    const m = /^--(no-)?(status-line|backfill|link|open)$/.exec(a);
    if (m !== null) {
      f[SWITCHES[m[2] as keyof typeof SWITCHES]] = m[1] === undefined;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  return f;
}

/** One question, whether it applies (can change anything here) and whether a flag already answered it. */
interface Slot { q: Question; applies: boolean; flagged: boolean }

/** Every question in §5.2's order, applicable or not. */
function slots(f: SetupFacts, flags: Flags): Slot[] {
  // Spec decision 3: on a fresh install the recommended steps default to yes;
  // on an existing one every new step defaults to no, which is today.
  const recommended = f.fresh;
  const out: Slot[] = [{
    q: { key: "statusLine", text: "Use Watchtower's capture as your status line? It records snapshots and displays nothing.", def: recommended, today: false },
    applies: f.statusLineOffered,
    flagged: flags.statusLine !== undefined,
  }];
  for (const s of f.sources) {
    const reads = READS[s.id];
    out.push({
      q: { key: `source:${s.id}`, text: reads === undefined ? `Track ${s.label}?` : `Track ${s.label}? It reads ${reads}.`, def: true, today: true },
      // An existing config belongs to the user (decision 6): nothing to ask.
      applies: s.detected && f.configFile === null,
      flagged: flags.disable !== undefined,
    });
  }
  out.push(
    { q: { key: "backfill", text: "Read your existing history now?", def: recommended, today: false }, applies: true, flagged: flags.backfill !== undefined },
    { q: { key: "link", text: "Put watchtower on your PATH (~/.local/bin)?", def: recommended, today: false }, applies: f.link.state === "absent", flagged: flags.link !== undefined },
    { q: { key: "open", text: "Open the dashboard when done?", def: recommended, today: false }, applies: true, flagged: flags.open !== undefined },
  );
  return out;
}

/** The questions to ask: applicable and not answered by a flag, in §5.2's order. */
export function questionsFor(f: SetupFacts, flags: Flags): Question[] {
  return slots(f, flags).filter((s) => s.applies && !s.flagged).map((s) => s.q);
}

/**
 * What to do. A flag wins. Otherwise "none" (non-interactive, no `--yes`) takes
 * each question's `today`, "yes" its `def`, and "interactive" the answer given,
 * or `def` for a question that was not asked because it cannot apply.
 */
export function choose(
  f: SetupFacts, flags: Flags, mode: "interactive" | "yes" | "none", answers: Map<QuestionKey, boolean>,
): Choices {
  const all = slots(f, flags);
  const value = (key: QuestionKey, flag: boolean | undefined): boolean => {
    if (flag !== undefined) return flag;
    const q = all.find((s) => s.q.key === key)?.q;
    if (q === undefined) return false;
    if (mode === "none") return q.today;
    if (mode === "interactive") return answers.get(key) ?? q.def;
    return q.def;
  };
  const disable = flags.disable !== undefined
    ? [...flags.disable]
    : f.sources.filter((s) => !value(`source:${s.id}`, undefined)).map((s) => s.id);
  return {
    statusLine: value("statusLine", flags.statusLine),
    disable,
    backfill: value("backfill", flags.backfill),
    link: value("link", flags.link),
    open: value("open", flags.open),
  };
}

/** The steps, in the order they run: install first, then config, backfill, link, open. */
export function stepsFor(c: Choices): Step[] {
  const steps: Step[] = [{ kind: "install", statusLine: c.statusLine }];
  if (c.disable.length > 0) steps.push({ kind: "config", disable: [...c.disable] });
  if (c.backfill) steps.push({ kind: "backfill" });
  if (c.link) steps.push({ kind: "link" });
  if (c.open) steps.push({ kind: "open" });
  return steps;
}

/**
 * The config written when a source is declined (ruling P5): every source,
 * each with `enabled` and `type`, plus the defaults a replacing map would
 * otherwise drop. No driven/automated lists, so entryLists keeps falling back
 * to the shipped ones. Two-space JSON and a newline.
 */
export function sourcesConfig(disable: string[]): string {
  const on = (id: string): boolean => !disable.includes(id);
  const sources = {
    claude: { enabled: true, type: "claude" },
    codex: { enabled: on("codex"), type: "codex" },
    hermes: { enabled: on("hermes"), type: "hermes" },
    openviking: { enabled: on("openviking"), type: "openviking", baseUrl: OPENVIKING_BASE_URL },
    atlas: { enabled: on("atlas"), type: "atlas", projectRoots: [...ATLAS_ROOTS] },
  };
  return `${JSON.stringify({ sources }, null, 2)}\n`;
}
