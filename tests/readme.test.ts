/**
 * The README keeps up with the code. A stage that ships adds pages, tables or
 * a version, and each of these fails the suite until the README says so. They check
 * that a thing is named, not what is said about it: the words are the PR's job.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NAV, TOOLS } from "@/lib/render/layout";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const README = read("README.md");

/** The body rows of the first table whose header row starts with `| <first> |`, as cells. */
function tableRows(md: string, first: string): string[][] {
  const lines = md.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`| ${first} |`));
  if (at < 0) throw new Error(`README has no table headed "${first}"`);
  const rows: string[][] = [];
  for (const line of lines.slice(at + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(line.split("|").slice(1, -1).map((c) => c.trim()));
  }
  return rows;
}

/** Every table a schema creates: capture's `claude_*` and the rest, and the `wt_*` namespace. */
const schemaTables = () =>
  ["capture/lib.sh", "lib/core/schema.ts"]
    .flatMap((f) => [...read(f).matchAll(/^CREATE TABLE IF NOT EXISTS (\w+)/gm)].map((m) => m[1]))
    .sort();

describe("README", () => {
  it("lists exactly the dashboard's pages", () => {
    const pages = [...NAV, ...TOOLS.filter((t) => !NAV.some((n) => n.href === t.href))].map((p) => p.label);
    const listed = tableRows(README, "Page").flatMap((r) => r[0].replace(/\*\*/g, "").split(" / "));
    expect([...listed].sort()).toEqual([...pages].sort());
  });

  it("lists every database table, by name or by a `prefix_*` group", () => {
    const tables = schemaTables();
    const names = tableRows(README, "Tables").flatMap((r) => [...r[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]));
    const covers = (n: string, t: string) => (n.endsWith("*") ? t.startsWith(n.slice(0, -1)) : n === t);
    expect(tables.filter((t) => !names.some((n) => covers(n, t)))).toEqual([]);
    expect(names.filter((n) => !tables.some((t) => covers(n, t)))).toEqual([]);
  });

  it("has a What's new row for package.json's version", () => {
    const { version } = JSON.parse(read("package.json")) as { version: string };
    const versions = tableRows(README, "Version").map((r) => r[0].match(/^\[([^\]]+)\]/)?.[1]);
    expect(versions).toContain(version);
  });
});
