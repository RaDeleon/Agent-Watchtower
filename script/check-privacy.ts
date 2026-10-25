#!/usr/bin/env node
// Keep personal details out of a repository that is public, or soon will be.
//
//   node script/check-privacy.ts --staged   # pre-commit: the lines a commit adds
//   node script/check-privacy.ts --tree     # every tracked text file
//
// Three rules:
//   home   a path inside a real home directory: /Users/<name>, /home/<name>, or
//          the -Users-<name>- form Claude Code uses for its project and scratch
//          folders. The placeholder names docs and fixtures use are allowed.
//   email  the committer's own address, unless it is a GitHub noreply address
//          (staged only).
//   term   any line of the local file .git/info/private-terms, case-insensitive:
//          client names and anything else that must stay private. The list
//          lives inside .git, so it is never committed itself.
// Findings name the file, the line and the rule, never the matched text.
// Exit codes: 0 clean, 1 findings, 2 the check could not run.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PLACEHOLDER_NAMES = new Set([
  "you", "me", "user", "name", "example", "runner", "x", "a", "fx", "shared",
]);

export type Line = { path: string; line: number; text: string };
export type Finding = { path: string; line: number; rule: "home" | "email" | "term" };
export type Rules = { email?: string; terms: string[] };

const HOME = /(?:\/(?:Users|home)\/|-(?:Users|home)-)([A-Za-z0-9._]+)/g;

/** The user names of every home-directory path in a line that are not placeholders. */
export function homeNames(text: string): string[] {
  return [...text.matchAll(HOME)].map((m) => m[1]).filter((n) => !PLACEHOLDER_NAMES.has(n.toLowerCase()));
}

export function findings(lines: Line[], rules: Rules): Finding[] {
  const email = rules.email?.toLowerCase();
  const terms = rules.terms.map((t) => t.toLowerCase());
  const out: Finding[] = [];
  for (const l of lines) {
    const lower = l.text.toLowerCase();
    if (homeNames(l.text).length > 0) out.push({ path: l.path, line: l.line, rule: "home" });
    if (email && lower.includes(email)) out.push({ path: l.path, line: l.line, rule: "email" });
    if (terms.some((t) => lower.includes(t))) out.push({ path: l.path, line: l.line, rule: "term" });
  }
  return out;
}

/** Lines three or more characters long from the private-terms file; # starts a comment. */
export function parseTerms(source: string): string[] {
  return source.split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter((l) => l.length >= 3);
}

/** The added lines of a unified diff produced with -U0, with their new line numbers. */
export function addedLines(diff: string): Line[] {
  const out: Line[] = [];
  let file = "";
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = raw.startsWith("+++ b/") ? raw.slice(6) : "";
    } else if (raw.startsWith("@@")) {
      const m = /\+(\d+)/.exec(raw);
      next = m ? Number(m[1]) : 0;
    } else if (raw.startsWith("+") && file) {
      out.push({ path: file, line: next, text: raw.slice(1) });
      next += 1;
    }
  }
  return out;
}

function git(root: string | undefined, args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout.toString();
}

function trackedLines(root: string): Line[] {
  const out: Line[] = [];
  for (const p of git(root, ["ls-files", "-z"]).split("\0").filter(Boolean)) {
    const full = path.join(root, p);
    if (!existsSync(full)) continue;
    const data = readFileSync(full);
    if (data.includes(0)) continue; // binary
    data.toString("utf8").split("\n").forEach((text, i) => out.push({ path: p, line: i + 1, text }));
  }
  return out;
}

export function main(argv: string[]): number {
  const mode = argv[0];
  if (argv.length !== 1 || (mode !== "--staged" && mode !== "--tree")) {
    console.error("usage: node script/check-privacy.ts --staged | --tree");
    return 2;
  }
  try {
    const root = git(undefined, ["rev-parse", "--show-toplevel"]).trim();
    const termsFile = path.resolve(root, git(root, ["rev-parse", "--git-path", "info/private-terms"]).trim());
    const terms = existsSync(termsFile) ? parseTerms(readFileSync(termsFile, "utf8")) : [];
    let lines: Line[];
    let email: string | undefined;
    if (mode === "--staged") {
      lines = addedLines(git(root, ["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR"]));
      const configured = spawnSync("git", ["config", "user.email"], { cwd: root }).stdout.toString().trim();
      email = configured && !configured.endsWith("@users.noreply.github.com") ? configured : undefined;
    } else {
      lines = trackedLines(root);
    }
    const found = findings(lines, { email, terms });
    if (found.length === 0) return 0;
    console.error(mode === "--staged"
      ? "Commit blocked: personal details in the lines this commit adds."
      : "Personal details in tracked files.");
    for (const f of found) console.error(`  ${f.path}:${f.line}  (${f.rule})`);
    console.error("Write paths relative to the repository or as ~; see CONTRIBUTING.md.");
    return 1;
  } catch (error) {
    console.error(`Privacy check could not complete; commit/check blocked (${(error as Error).message}).`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
