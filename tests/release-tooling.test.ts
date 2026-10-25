import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPrivateArtifact } from "../script/artifact-policy.ts";
import { main as checkSecrets, tarMember } from "../script/check-secrets.ts";
import { main as lint, shellScripts } from "../script/lint.ts";
import { validateRelease } from "../script/release-metadata.ts";
import { buildRelease, ghEnv, ownerGh, publish, main as release } from "../script/release.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

describe("artifact policy", () => {
  it.each([
    "claude-code-usage.sqlite",
    "copies/main/claude-code-usage.sqlite-wal",
    "fixtures/usage.db",
    ".schema-v10",
    "transcripts/0d9f.jsonl",
    "codex/rollout-2026-10-01.jsonl",
    "watchtower-serve.log",
    "watchtower.config.json",
    ".claude/settings.local.json",
    "settings.json",
    "auth.json",
    "ovcli.conf",
    ".env",
    ".env.local",
    "certs/server.key",
    ".tools/gitleaks/8.30.1/darwin_arm64/gitleaks.tar.gz",
    "dist/agent-watchtower-0.8.0.tar.gz",
    "tmp/scratch.md",
    "SESSION.md",
    ".private/client-notes.md",
    ".superpowers/sdd/2026-10-22-stage-9-onboarding/progress.md",
  ])("blocks %s", (p) => {
    expect(isPrivateArtifact(p)).toBe(true);
  });

  it.each([
    "README.md",
    "capture/rollup.sh",
    "watchtower.config.example.json",
    ".env.example",
    "tests/fixtures/make-fixture.sh",
    "docs/release-notes/0.8.0.md",
    "docs/assets/watchtower-banner.svg",
    "lib/read/sessions.ts",
  ])("allows %s", (p) => {
    expect(isPrivateArtifact(p)).toBe(false);
  });

  // Every file the repository tracks today must stay committable.
  it("blocks no tracked file", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT }).toString().split("\0").filter(Boolean);
    expect(tracked.length).toBeGreaterThan(200);
    expect(tracked.filter(isPrivateArtifact)).toEqual([]);
  });
});

describe("the scanner archive", () => {
  it("extracts one regular file by name", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wt-tar-"));
    writeFileSync(path.join(dir, "README.md"), "readme\n");
    writeFileSync(path.join(dir, "gitleaks"), "#!/bin/sh\necho scanner\n");
    const tar = execFileSync("tar", ["-cf", "-", "-C", dir, "README.md", "gitleaks"]);
    expect(tarMember(tar, "gitleaks").toString()).toBe("#!/bin/sh\necho scanner\n");
    expect(() => tarMember(tar, "missing")).toThrow(/missing/);
  });

  it("refuses a usage error before downloading anything", async () => {
    expect(await checkSecrets([])).toBe(2);
    expect(await checkSecrets(["--everything"])).toBe(2);
  });
});

describe("release metadata", () => {
  function release(version: string, opts: { notes?: string; history?: string } = {}): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "wt-release-"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
    mkdirSync(path.join(root, "docs", "release-notes"), { recursive: true });
    if (opts.notes !== undefined) writeFileSync(path.join(root, "docs", "release-notes", `${version}.md`), opts.notes);
    if (opts.history !== undefined) writeFileSync(path.join(root, "docs", "releases.md"), opts.history);
    return root;
  }
  const row = (v: string) => `| Version | Date | Contents |\n| --- | --- | --- |\n| [${v}](release-notes/${v}.md) | 2026-10-12 | x |\n`;

  it("accepts a tag that matches the version, with notes and a history row", () => {
    const root = release("1.2.3", { notes: "# 1.2.3\n", history: row("1.2.3") });
    expect(validateRelease("v1.2.3", root)).toEqual({ version: "1.2.3", notes: path.join("docs", "release-notes", "1.2.3.md") });
  });

  it("rejects a tag that does not match package.json", () => {
    const root = release("1.2.3", { notes: "# 1.2.3\n", history: row("1.2.3") });
    expect(() => validateRelease("v1.2.4", root)).toThrow(/must match package.json: v1.2.3/);
    expect(() => validateRelease("1.2.3", root)).toThrow(/must match/);
  });

  it("rejects a version that is not three numbers", () => {
    const root = release("1.2", { notes: "x", history: row("1.2") });
    expect(() => validateRelease("v1.2", root)).toThrow(/three-part version/);
  });

  it("requires release notes that are not empty", () => {
    expect(() => validateRelease("v1.2.3", release("1.2.3", { history: row("1.2.3") }))).toThrow(/add release notes/);
    expect(() => validateRelease("v1.2.3", release("1.2.3", { notes: "  \n", history: row("1.2.3") }))).toThrow(/add release notes/);
  });

  it("requires a release history row for the version", () => {
    expect(() => validateRelease("v1.2.3", release("1.2.3", { notes: "x", history: row("1.2.4") }))).toThrow(/release history/);
    expect(() => validateRelease("v1.2.3", release("1.2.3", { notes: "x" }))).toThrow(/release history/);
  });

  // A version bump without its notes or history row fails the suite before any tag.
  it("the repository's own version is releasable", () => {
    const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(validateRelease(`v${version}`).version).toBe(version);
  });
});

describe("GitHub Actions", () => {
  // Nothing runs on GitHub, so a required check would never report and block every merge.
  it("has no workflow, no Dependabot entry for actions, and the ruleset requires no status check", () => {
    expect(existsSync(path.join(ROOT, ".github", "workflows"))).toBe(false);
    expect(readFileSync(path.join(ROOT, ".github", "dependabot.yml"), "utf8")).not.toContain("github-actions");
    const ruleset = JSON.parse(readFileSync(path.join(ROOT, ".github", "rulesets", "main.json"), "utf8"));
    expect(ruleset.rules.map((r: { type: string }) => r.type).sort()).toEqual(["deletion", "non_fast_forward", "pull_request"]);
  });
});

describe("the local release", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=you@example.com", ...args], { cwd, encoding: "utf8" }).trim();

  /** A repository with one commit tagged v1.2.3 that passes every check; `edit` changes it before the commit. */
  function tagged(edit: (root: string) => void = () => {}): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "wt-release-"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    mkdirSync(path.join(root, "docs", "release-notes"), { recursive: true });
    writeFileSync(path.join(root, "docs", "release-notes", "1.2.3.md"), "# 1.2.3\n");
    writeFileSync(path.join(root, "docs", "releases.md"), "| [1.2.3](release-notes/1.2.3.md) | 2026-10-17 | x |\n");
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin", "watchtower"), "#!/usr/bin/env node\n", { mode: 0o755 });
    mkdirSync(path.join(root, "capture"));
    writeFileSync(path.join(root, "capture", "hook.sh"), "echo ok\n");
    edit(root);
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "release");
    git(root, "tag", "v1.2.3");
    return root;
  }

  it("builds the archive, its checksum, the notes and the source commit from the tag", () => {
    const root = tagged();
    const b = buildRelease("v1.2.3", root);
    expect(b.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(readFileSync(b.sourceCommit, "utf8")).toBe(`${b.commit}\n`);
    expect(readFileSync(b.notes, "utf8")).toBe("# 1.2.3\n");
    expect(execFileSync("shasum", ["-a", "256", "-c", path.basename(b.checksum)], { cwd: path.dirname(b.checksum), encoding: "utf8" }))
      .toBe("agent-watchtower-1.2.3.tar.gz: OK\n");
    const listing = execFileSync("tar", ["-tzf", b.archive], { encoding: "utf8" }).split("\n");
    expect(listing).toContain("agent-watchtower-1.2.3/bin/watchtower");
  });

  // Uncommitted work, or a later commit on the branch, must never ship under the tag.
  it("checks the tag's files, not the working tree's", () => {
    const root = tagged();
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    writeFileSync(path.join(root, "capture", "hook.sh"), "if then\n");
    expect(buildRelease("v1.2.3", root).version).toBe("1.2.3");
  });

  it("refuses a tag that is missing or malformed", () => {
    expect(() => buildRelease("v1.2.4", tagged())).toThrow(/no tag v1\.2\.4/);
    expect(() => buildRelease("1.2.3", tagged())).toThrow(/looks like v0\.9\.0/);
  });

  it("refuses an archive that fails the release metadata check", () => {
    expect(() => buildRelease("v1.2.3", tagged((r) => rmSync(path.join(r, "docs", "release-notes", "1.2.3.md"))))).toThrow(/add release notes/);
  });

  it("refuses an archive whose CLI is not executable", () => {
    expect(() => buildRelease("v1.2.3", tagged((r) => chmodSync(path.join(r, "bin", "watchtower"), 0o644)))).toThrow(/not executable/);
  });

  it("refuses an archive with invalid bash in capture/", () => {
    expect(() => buildRelease("v1.2.3", tagged((r) => writeFileSync(path.join(r, "capture", "hook.sh"), "if then\n")))).toThrow(/capture\/hook\.sh is not valid bash/);
  });

  const build = { version: "1.2.3", commit: "c", archive: "a.tar.gz", checksum: "a.tar.gz.sha256", sourceCommit: "SOURCE-COMMIT.txt", notes: "RELEASE-NOTES.md" };
  function fakeGh(existing: { isDraft: boolean } | null) {
    const calls: string[] = [];
    const gh = (args: string[]) => {
      calls.push(args.join(" "));
      if (args[1] === "view" && args[4] === "isDraft") {
        if (!existing) throw new Error("release not found");
        return JSON.stringify(existing);
      }
      return args[1] === "view" ? "42" : "";
    };
    return { calls, gh };
  }

  // The v0.8.0 run stopped here: GET releases/tags/<tag> answers 404 for a draft,
  // so the release it had just created and filled was never published.
  it("creates a draft, uploads the assets, then publishes the draft it finds by gh release view", () => {
    const { calls, gh } = fakeGh(null);
    publish(build, "v1.2.3", gh);
    expect(calls).toEqual([
      "release view v1.2.3 --json isDraft",
      "release create v1.2.3 --verify-tag --draft --title Agent Watchtower 1.2.3 --notes-file RELEASE-NOTES.md",
      "release upload v1.2.3 a.tar.gz a.tar.gz.sha256 SOURCE-COMMIT.txt --clobber",
      "release view v1.2.3 --json databaseId --jq .databaseId",
      "api --method PATCH repos/{owner}/{repo}/releases/42 -F draft=false -F prerelease=false -f make_latest=legacy --jq .tag_name",
    ]);
  });

  it("refills a draft, and never touches a published release", () => {
    const draft = fakeGh({ isDraft: true });
    publish(build, "v1.2.3", draft.gh);
    expect(draft.calls.some((c) => c.startsWith("release create"))).toBe(false);
    expect(draft.calls).toContain("release upload v1.2.3 a.tar.gz a.tar.gz.sha256 SOURCE-COMMIT.txt --clobber");
    const published = fakeGh({ isDraft: false });
    expect(() => publish(build, "v1.2.3", published.gh)).toThrow(/already published/);
    expect(published.calls).toEqual(["release view v1.2.3 --json isDraft"]);
  });

  // The v0.10.0 run failed with "Could not resolve to a Repository": gh ran as the
  // active account, which cannot see the private repository its owner can.
  describe("the gh account", () => {
    function lookups() {
      const owners: string[] = [];
      return { owners, tokenFor: (owner: string) => (owners.push(owner), `token-of-${owner}`) };
    }
    const withOrigin = (url: string) => {
      const root = tagged();
      git(root, "remote", "add", "origin", url);
      return root;
    };

    it("is the owner of origin when no token is set", () => {
      for (const url of ["git@github.com:Owner/Agent-Watchtower.git", "https://github.com/Owner/Agent-Watchtower"]) {
        const { owners, tokenFor } = lookups();
        expect(ghEnv(withOrigin(url), { PATH: "/bin" }, tokenFor)).toEqual({ PATH: "/bin", GH_TOKEN: "token-of-Owner" });
        expect(owners).toEqual(["Owner"]);
      }
    });

    it("is the caller's when GH_TOKEN or GITHUB_TOKEN is set", () => {
      const root = withOrigin("git@github.com:Owner/Agent-Watchtower.git");
      for (const env of [{ GH_TOKEN: "mine" }, { GITHUB_TOKEN: "mine" }]) {
        const { owners, tokenFor } = lookups();
        expect(ghEnv(root, env, tokenFor)).toEqual(env);
        expect(owners).toEqual([]);
      }
    });

    it("is the one `gh auth token` stores, passed to every gh call", () => {
      const bin = mkdtempSync(path.join(os.tmpdir(), "wt-gh-"));
      const log = path.join(bin, "auth.log");
      writeFileSync(path.join(bin, "gh"), `#!/bin/sh\nif [ "$1" = auth ]; then echo "$*" >> "${log}"; echo stored-token; exit 0; fi\necho "$GH_TOKEN|$*"\n`, { mode: 0o755 });
      const gh = ownerGh(withOrigin("git@github.com:Owner/Agent-Watchtower.git"), { PATH: `${bin}:${process.env.PATH}` });
      expect(gh(["release", "view", "v1.2.3"])).toBe("stored-token|release view v1.2.3");
      expect(gh(["release", "upload", "v1.2.3"])).toBe("stored-token|release upload v1.2.3");
      expect(readFileSync(log, "utf8")).toMatch(/^auth token --hostname github\.com --user \S+\n$/);
    });

    it("is gh's active account without an origin, or without a stored token for its owner", () => {
      expect(ghEnv(tagged(), { PATH: "/bin" }, lookups().tokenFor)).toEqual({ PATH: "/bin" });
      const signedOut = () => { throw new Error("no oauth token found for github.com account Owner"); };
      expect(ghEnv(withOrigin("git@github.com:Owner/Agent-Watchtower.git"), { PATH: "/bin" }, signedOut)).toEqual({ PATH: "/bin" });
    });
  });

  it("refuses a usage error before building anything", () => {
    expect(release([])).toBe(2);
    expect(release(["v1.2.3", "v1.2.4"])).toBe(2);
    expect(release(["--publish"])).toBe(2);
  });
});

describe("lint", () => {
  it("reads every tracked shell script and hook, except the vendored old libs", () => {
    expect(shellScripts([
      "capture/lib.sh", ".githooks/pre-commit", "tests/fixtures/lib-v1.sh", "tests/fixtures/lib-v2.sh", "tests/fixtures/lib-v5.sh",
      "tests/fixtures/make-fixture.sh", "bin/watchtower", "README.md", "script/lint.ts",
    ])).toEqual([".githooks/pre-commit", "capture/lib.sh", "tests/fixtures/make-fixture.sh"]);
  });

  it("covers the repository's capture scripts", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT }).toString().split("\0").filter(Boolean);
    const scripts = shellScripts(tracked);
    for (const f of ["hook.sh", "ingest.sh", "install.sh", "lib.sh", "rollup.sh", "snapshot.sh"]) {
      expect(scripts).toContain(`capture/${f}`);
    }
  });

  it("refuses a usage error before downloading anything", async () => {
    expect(await lint(["--fix"])).toBe(2);
  });
});
