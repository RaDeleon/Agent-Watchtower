#!/usr/bin/env node
// Publish a release from this machine; no GitHub Actions runs. Push the tag first:
//   - `git archive` builds agent-watchtower-<version>.tar.gz from the tag, never the
//     working tree, into dist/, beside its SHA-256, the notes and SOURCE-COMMIT.txt;
//   - the unpacked archive must pass script/release-metadata.ts (the tag's own
//     package.json, notes and history row), have an executable CLI and valid bash
//     in capture/;
//   - gh creates a draft release, uploads the assets, then publishes it, signed in as
//     the owner of `origin` (`gh auth token --user <owner>`) unless GH_TOKEN or
//     GITHUB_TOKEN is set, so another active gh account cannot hide a private repo.
//
//   node script/release.ts v0.9.0             # npm run release -- v0.9.0
//   node script/release.ts v0.9.0 --dry-run   # build and verify; publish nothing
//
// Exit codes: 0 published (or verified, with --dry-run), 1 a check failed, 2 usage.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateRelease } from "./release-metadata.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string =>
  execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * `env` with GH_TOKEN set to the token `tokenFor` gives the owner of `root`'s `origin`.
 * A token the caller set wins; without an origin, or a stored token for its owner, gh
 * keeps its active account.
 */
export function ghEnv(root: string, env: NodeJS.ProcessEnv, tokenFor: (owner: string) => string): NodeJS.ProcessEnv {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env;
  try {
    const url = run("git", ["config", "--get", "remote.origin.url"], root);
    const owner = url.replace(/\/$/, "").replace(/\.git$/, "").split(/[/:]/).at(-2);
    const token = owner ? tokenFor(owner) : "";
    return token ? { ...env, GH_TOKEN: token } : env;
  } catch {
    return env;
  }
}

/** A gh runner for `root`, signed in as `ghEnv` decides: looked up once, used for every call. */
export function ownerGh(root: string = ROOT, base: NodeJS.ProcessEnv = process.env): (args: string[]) => string {
  const env = ghEnv(root, base, (owner) => run("gh", ["auth", "token", "--hostname", "github.com", "--user", owner], root, base));
  return (args) => run("gh", args, root, env);
}

export interface Build {
  version: string;
  commit: string;
  archive: string;
  checksum: string;
  sourceCommit: string;
  notes: string;
}

/** Build the release assets for `tag` in `<root>/dist` and verify them. Throws on any failed check. */
export function buildRelease(tag: string, root: string = ROOT): Build {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`a release tag looks like v0.9.0, not ${tag}`);
  let commit: string;
  try {
    commit = run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], root);
  } catch {
    throw new Error(`no tag ${tag}: tag the merge commit on main and push the tag first`);
  }
  const version = tag.slice(1);
  const name = `agent-watchtower-${version}`;
  const dist = path.join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const archive = path.join(dist, `${name}.tar.gz`);
  run("git", ["archive", "--format=tar.gz", `--prefix=${name}/`, "-o", archive, commit], root);

  const out = mkdtempSync(path.join(os.tmpdir(), "wt-release-"));
  try {
    run("tar", ["-xzf", archive, "-C", out], root);
    const src = path.join(out, name);
    const { notes } = validateRelease(tag, src);
    try {
      accessSync(path.join(src, "bin", "watchtower"), constants.X_OK);
    } catch {
      throw new Error("the archive's bin/watchtower is missing or not executable");
    }
    for (const f of readdirSync(path.join(src, "capture")).filter((f) => f.endsWith(".sh")).sort()) {
      try {
        run("bash", ["-n", path.join(src, "capture", f)], root);
      } catch {
        throw new Error(`the archive's capture/${f} is not valid bash`);
      }
    }
    copyFileSync(path.join(src, notes), path.join(dist, "RELEASE-NOTES.md"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }

  const checksum = `${archive}.sha256`;
  writeFileSync(checksum, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${name}.tar.gz\n`);
  const sourceCommit = path.join(dist, "SOURCE-COMMIT.txt");
  writeFileSync(sourceCommit, `${commit}\n`);
  return { version, commit, archive, checksum, sourceCommit, notes: path.join(dist, "RELEASE-NOTES.md") };
}

/** Create a draft release for `tag`, upload the assets, then publish it. A published release is never touched. */
export function publish(build: Build, tag: string, gh: (args: string[]) => string = ownerGh()): void {
  let isDraft: boolean | undefined;
  try {
    isDraft = JSON.parse(gh(["release", "view", tag, "--json", "isDraft"])).isDraft;
  } catch {
    isDraft = undefined;
  }
  if (isDraft === false) throw new Error(`${tag} is already published; release a new version instead`);
  if (isDraft === undefined) {
    gh(["release", "create", tag, "--verify-tag", "--draft", "--title", `Agent Watchtower ${build.version}`, "--notes-file", build.notes]);
  }
  gh(["release", "upload", tag, build.archive, build.checksum, build.sourceCommit, "--clobber"]);
  // GitHub's get-a-release-by-tag endpoint never returns a draft; `gh release view` does.
  const id = gh(["release", "view", tag, "--json", "databaseId", "--jq", ".databaseId"]);
  gh(["api", "--method", "PATCH", `repos/{owner}/{repo}/releases/${id}`, "-F", "draft=false", "-F", "prerelease=false", "-f", "make_latest=legacy", "--jq", ".tag_name"]);
}

export function main(argv: string[]): number {
  const dryRun = argv.includes("--dry-run");
  const rest = argv.filter((a) => a !== "--dry-run");
  if (rest.length !== 1 || rest[0].startsWith("-")) {
    console.error("usage: node script/release.ts <tag> [--dry-run]");
    return 2;
  }
  const tag = rest[0];
  try {
    const build = buildRelease(tag);
    console.log(`Built and verified ${path.relative(ROOT, build.archive)} from ${build.commit.slice(0, 12)}`);
    if (dryRun) {
      console.log("Dry run: nothing published.");
      return 0;
    }
    publish(build, tag);
    console.log(`Published ${tag}`);
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
