#!/usr/bin/env node
// Offline secret detection. Downloads a pinned Gitleaks release on first use,
// verifies its SHA-256, and caches it in the ignored .tools/ directory. No
// source or credentials are uploaded anywhere. Findings are fully redacted.
//
//   node script/check-secrets.ts --staged    # pre-commit: staged changes only
//   node script/check-secrets.ts --history   # every locally available ref
//
// Exit codes: 0 clean, 1 findings or a blocked path, 2 the check could not run
// (download, checksum or scanner failure), which blocks the commit too.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isPrivateArtifact } from "./artifact-policy.ts";
import { pinnedExecutable, type PinnedTool } from "./pinned-tool.ts";

export { tarMember } from "./pinned-tool.ts";

export const GITLEAKS_VERSION = "8.30.1";

const archive = (name: string, sha256: string) => ({
  url: `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${name}.tar.gz`,
  sha256,
});

const GITLEAKS: PinnedTool = {
  name: "gitleaks",
  version: GITLEAKS_VERSION,
  member: "gitleaks",
  archives: {
    "darwin-arm64": archive("darwin_arm64", "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"),
    "darwin-x64": archive("darwin_x64", "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"),
    "linux-x64": archive("linux_x64", "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"),
    "linux-arm64": archive("linux_arm64", "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"),
  },
};

function git(root: string | undefined, args: string[]): Buffer {
  const r = spawnSync("git", args, { cwd: root });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}

export async function main(argv: string[]): Promise<number> {
  const mode = argv[0];
  if (argv.length !== 1 || (mode !== "--staged" && mode !== "--history")) {
    console.error("usage: node script/check-secrets.ts --staged | --history");
    return 2;
  }
  let executable: string | undefined;
  try {
    const root = git(undefined, ["rev-parse", "--show-toplevel"]).toString().trim();
    if (mode === "--staged") {
      const staged = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
        .toString().split("\0").filter(Boolean);
      const blocked = staged.filter(isPrivateArtifact);
      if (blocked.length > 0) {
        console.error("Commit blocked: a usage database, transcript, log, live config or local state file is staged.");
        for (const p of blocked) console.error(`  ${JSON.stringify(p)}`);
        return 1;
      }
    }
    executable = await pinnedExecutable(root, GITLEAKS);
    const args = ["git", root, "--redact=100", "--no-banner", "--no-color", "--ignore-gitleaks-allow"];
    args.push(...(mode === "--staged" ? ["--pre-commit", "--staged"] : ["--log-opts=--all --full-history"]));
    // Ambient overrides must not silently change the guard's rules.
    const env = { ...process.env };
    delete env.GITLEAKS_CONFIG;
    delete env.GITLEAKS_CONFIG_TOML;
    const r = spawnSync(executable, args, { env, stdio: "inherit" });
    return r.status ?? 2;
  } catch (error) {
    console.error(`Secret check could not complete; commit/check blocked (${(error as Error).message}).`);
    return 2;
  } finally {
    if (executable) rmSync(executable, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
