#!/usr/bin/env node
// Static checks the test suite does not make. A pinned ShellCheck reads every
// tracked shell script. It is downloaded on first use, verified and cached like
// the secret scanner (script/pinned-tool.ts).
//
//   node script/lint.ts    # npm run lint
//
// Exit codes: 0 clean, 1 findings, 2 the check could not run.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { pinnedExecutable, type PinnedTool } from "./pinned-tool.ts";

export const SHELLCHECK_VERSION = "0.11.0";

const shellcheckArchive = (name: string, sha256: string) => ({
  url: `https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.${name}.tar.gz`,
  sha256,
});

const SHELLCHECK: PinnedTool = {
  name: "shellcheck",
  version: SHELLCHECK_VERSION,
  member: `shellcheck-v${SHELLCHECK_VERSION}/shellcheck`,
  archives: {
    "darwin-arm64": shellcheckArchive("darwin.aarch64", "339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f"),
    "darwin-x64": shellcheckArchive("darwin.x86_64", "c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51"),
    "linux-x64": shellcheckArchive("linux.x86_64", "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6"),
    "linux-arm64": shellcheckArchive("linux.aarch64", "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc"),
  },
};

// Old schema-v1, v2 and v5 lib.sh files, vendored unchanged for the migration tests.
const VENDORED = new Set(["tests/fixtures/lib-v1.sh", "tests/fixtures/lib-v2.sh", "tests/fixtures/lib-v5.sh"]);

/** The tracked files ShellCheck reads. */
export function shellScripts(tracked: string[]): string[] {
  return tracked.filter((p) => (p.endsWith(".sh") || p.startsWith(".githooks/")) && !VENDORED.has(p)).sort();
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length !== 0) {
    console.error("usage: node script/lint.ts");
    return 2;
  }
  const executables: string[] = [];
  try {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"]);
    if (top.status !== 0) throw new Error("git rev-parse failed");
    const root = top.stdout.toString().trim();
    const files = spawnSync("git", ["ls-files", "-z"], { cwd: root });
    if (files.status !== 0) throw new Error("git ls-files failed");
    const scripts = shellScripts(files.stdout.toString().split("\0").filter(Boolean));

    const shellcheck = await pinnedExecutable(root, SHELLCHECK);
    executables.push(shellcheck);

    // Ambient overrides must not silently change the rules.
    const env = { ...process.env };
    delete env.SHELLCHECK_OPTS;

    console.log(`ShellCheck ${SHELLCHECK_VERSION}: ${scripts.length} scripts`);
    const sc = spawnSync(shellcheck, ["--norc", ...scripts], { cwd: root, env, stdio: "inherit" });
    if (sc.status === null || sc.status > 1) return 2;
    return sc.status;
  } catch (error) {
    console.error(`Lint could not complete (${(error as Error).message}).`);
    return 2;
  } finally {
    for (const e of executables) rmSync(e, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
