#!/usr/bin/env node
// Validate a release tag against the source before anything is built:
//   - package.json's version is a three-part version, and the tag is v<version>;
//   - docs/release-notes/<version>.md exists and is not empty (it becomes the
//     GitHub release body);
//   - docs/releases.md's release history lists the version.
//
//   node script/release-metadata.ts v0.8.0
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function validateRelease(tag: string, root: string = ROOT): { version: string; notes: string } {
  const version: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("package.json needs a three-part version, such as 0.8.0");
  }
  if (tag !== `v${version}`) throw new Error(`the release tag must match package.json: v${version}`);
  const notes = path.join("docs", "release-notes", `${version}.md`);
  const notesPath = path.join(root, notes);
  if (!existsSync(notesPath) || readFileSync(notesPath, "utf8").trim() === "") {
    throw new Error(`add release notes at ${notes}`);
  }
  const history = path.join(root, "docs", "releases.md");
  const listed = existsSync(history) &&
    readFileSync(history, "utf8").split("\n").some((line) => line.startsWith(`| [${version}](`));
  if (!listed) throw new Error(`add ${version} to the release history in docs/releases.md`);
  return { version, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateRelease(process.argv[2] ?? "");
    console.log(`Validated ${process.argv[2]}`);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
