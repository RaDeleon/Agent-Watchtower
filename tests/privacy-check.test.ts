import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addedLines, findings, homeNames, main, parseTerms } from "../script/check-privacy.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "script", "check-privacy.ts");

// Built at run time so this file never contains a real-looking home path
// itself; the --tree check reads it like any other tracked file.
const mac = (name: string, rest = "dev/repo") => ["", "Users", name, rest].join("/");
const linux = (name: string) => ["", "home", name, ".claude"].join("/");
const claudeDir = (name: string) => `/private/tmp/claude-501/-${"Users"}-${name}-Developer-repo/scratchpad`;
const personal = ["jordan", "example.org"].join("@");

describe("home-directory paths", () => {
  it("flags a real user's home on macOS and Linux, and Claude Code's folder form", () => {
    expect(homeNames(`RUN v4 ${mac("jordan")}`)).toEqual(["jordan"]);
    expect(homeNames(`hook at ${linux("sam")}/hooks/x.sh`)).toEqual(["sam"]);
    expect(homeNames(`P=${claudeDir("jordan")}`)).toEqual(["jordan"]);
  });

  it("allows the placeholder names that docs and fixtures use", () => {
    for (const n of ["you", "x", "a", "fx", "runner", "user", "Shared"]) expect(homeNames(mac(n))).toEqual([]);
    expect(homeNames("~/.claude/projects and $HOME/.theone")).toEqual([]);
  });
});

describe("findings", () => {
  const lines = [
    { path: "docs/a.md", line: 3, text: `see ${mac("jordan")}` },
    { path: "docs/b.md", line: 7, text: `mail ${personal.toUpperCase()}` },
    { path: "docs/c.md", line: 9, text: "worked on the Acme-Portal again" },
    { path: "docs/d.md", line: 1, text: "nothing personal here" },
  ];

  it("reports the file, line and rule for each, never the text", () => {
    expect(findings(lines, { email: personal, terms: ["acme-portal"] })).toEqual([
      { path: "docs/a.md", line: 3, rule: "home" },
      { path: "docs/b.md", line: 7, rule: "email" },
      { path: "docs/c.md", line: 9, rule: "term" },
    ]);
  });

  it("checks no email when there is no personal address", () => {
    expect(findings(lines, { terms: [] }).map((f) => f.rule)).toEqual(["home"]);
  });

  it("reads terms one per line, skipping comments, blanks and fragments under three characters", () => {
    expect(parseTerms("# clients\nAcme-Portal\n\n  globex  # trailing note\nab\n")).toEqual(["Acme-Portal", "globex"]);
  });
});

describe("the added lines of a staged diff", () => {
  it("numbers each added line in its new file", () => {
    const diff = [
      "diff --git a/docs/a.md b/docs/a.md",
      "--- a/docs/a.md",
      "+++ b/docs/a.md",
      "@@ -10,0 +11,2 @@ heading",
      "+first",
      "+second",
      "@@ -40 +42 @@",
      "-old",
      "+replaced",
      "diff --git a/docs/gone.md b/docs/gone.md",
      "--- a/docs/gone.md",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-removed",
    ].join("\n");
    expect(addedLines(diff)).toEqual([
      { path: "docs/a.md", line: 11, text: "first" },
      { path: "docs/a.md", line: 12, text: "second" },
      { path: "docs/a.md", line: 42, text: "replaced" },
    ]);
  });
});

describe("the pre-commit check, end to end", () => {
  function repo(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wt-privacy-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", personal], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    return dir;
  }
  const stage = (dir: string, file: string, text: string) => {
    writeFileSync(path.join(dir, file), text);
    execFileSync("git", ["add", file], { cwd: dir });
  };
  const run = (dir: string) => spawnSync(process.execPath, [SCRIPT, "--staged"], { cwd: dir, encoding: "utf8" });

  it("passes a clean commit", () => {
    const dir = repo();
    stage(dir, "notes.md", "paths are written as ~/.claude\n");
    expect(run(dir).status).toBe(0);
  });

  it("blocks a home path, the committer's address and a private term, naming only file, line and rule", () => {
    const dir = repo();
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "info", "private-terms"), "# local\nAcme-Portal\n");
    stage(dir, "report.md", `ok\n${mac("jordan")}\ncontact ${personal}\nthe acme-portal numbers\n`);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("report.md:2  (home)");
    expect(r.stderr).toContain("report.md:3  (email)");
    expect(r.stderr).toContain("report.md:4  (term)");
    expect(r.stderr).not.toMatch(/jordan|acme/i);
  });

  it("refuses a usage error", () => {
    expect(main([])).toBe(2);
    expect(main(["--everything"])).toBe(2);
  });
});

describe("this repository", () => {
  it("has no personal details in any tracked file", () => {
    expect(main(["--tree"])).toBe(0);
  });
});
