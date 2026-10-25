import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexAdapter } from "@/lib/adapters/codex";
import { createHermesAdapter } from "@/lib/adapters/hermes";
import { entryLists } from "@/lib/config";
import { applyWtSchema } from "@/lib/core/schema";
import { runSync } from "@/lib/core/sync";
import { readAgent } from "@/lib/read/agent";
import { roll } from "./helpers/agent-seed";
import { buildAndRoll } from "./helpers/fixture-db";

process.env.TZ = "UTC";

const NOW = Math.floor(Date.parse("2026-10-03T12:00:00Z") / 1000);
const MAKE_CODEX = path.resolve(__dirname, "fixtures", "make-codex-logs.sh");
const MAKE_HERMES = path.resolve(__dirname, "fixtures", "make-hermes-db.sh");

async function codexDb(): Promise<{ db: string; home: string }> {
  const cwd = mkdtempSync(path.join(tmpdir(), "wt-ra-repo-"));
  execFileSync("git", ["init", "-q"], { cwd });
  const home = mkdtempSync(path.join(tmpdir(), "wt-ra-codex-"));
  execFileSync("bash", [MAKE_CODEX, "core", home], { env: { ...process.env, WT_CODEX_CWD: cwd } });
  const db = buildAndRoll("resumed");
  applyWtSchema(db);
  await runSync({ db, adapters: [createCodexAdapter({ db, home, lists: entryLists("codex", undefined) })] });
  roll(db);
  return { db, home };
}
async function hermesDb(): Promise<{ db: string; home: string }> {
  const home = mkdtempSync(path.join(tmpdir(), "wt-ra-hermes-"));
  execFileSync("bash", [MAKE_HERMES, "core", path.join(home, ".hermes", "state.db")]);
  const db = buildAndRoll("resumed");
  applyWtSchema(db);
  await runSync({ db, adapters: [createHermesAdapter({ db, home, lists: entryLists("hermes", undefined) })] });
  roll(db);
  return { db, home };
}

describe("readAgent, Codex", () => {
  it("is synced, levelled, and names the unclassified entry point and its key", async () => {
    const { db, home } = await codexDb();
    const d = readAgent(db, "codex", { now: NOW, range: "all", home });
    expect(d.status.state).toBe("synced");
    expect(d.level.state).toBe("level");
    expect(d.unclassified).toEqual([{ entry: "mystery-client", sessions: 1 }]);
    expect(d.configKey).toBe("sources.codex.driven");
  });

  it("lists models by requests, then name", async () => {
    const { db, home } = await codexDb();
    const d = readAgent(db, "codex", { now: NOW, range: "all", home });
    expect(d.models.map((m) => [m.model, m.requests])).toEqual(
      [["gpt-5.5", 5], ["gpt-5.2", 2], ["codex-auto-review", 1], ["gpt-9-imaginary", 1]]);
  });

  it("lists six sessions newest first with the tool's own id", async () => {
    const { db, home } = await codexDb();
    const rowsOut = readAgent(db, "codex", { now: NOW, range: "all", home }).sessionRows;
    expect(rowsOut).toHaveLength(6);
    const starts = rowsOut.map((r) => r.startedAt);
    expect(starts).toEqual([...starts].sort((a, b) => b - a));
    const s1 = rowsOut.find((r) => r.id === "codex-s1")!;
    expect([s1.entry, s1.driven, s1.requests]).toEqual(["Codex Desktop", 1, 2]);
    const s8 = rowsOut.find((r) => r.id === "codex-s8")!;
    expect([s8.entry, s8.driven]).toEqual(["subagent:thread_spawn", 0]);
  });

  it("not installed: an empty home and a DB that never synced Codex", () => {
    const db = buildAndRoll("resumed");
    const home = mkdtempSync(path.join(tmpdir(), "wt-ra-empty-"));
    const d = readAgent(db, "codex", { now: NOW, range: "all", home });
    expect(d.status.state).toBe("not-installed");
    expect(d.status.lookedAt.endsWith("/.codex/sessions")).toBe(true);
    expect(d.models).toEqual([]);
  });
});

describe("readAgent, Hermes", () => {
  it("groups sessions by entry point and carries Hermes's own cost, never an API cost", async () => {
    const { db, home } = await hermesDb();
    const d = readAgent(db, "hermes", { now: NOW, range: "all", home });
    const byEntry: Record<string, number> = {};
    for (const r of d.sessionRows) byEntry[r.entry ?? "—"] = (byEntry[r.entry ?? "—"] ?? 0) + 1;
    expect(byEntry).toEqual({ cli: 1, api_server: 1, telegram: 1 });
    expect(d.sessionRows.find((r) => r.entry === "telegram")!.hermesCost).toEqual({ usd: 0, priced: 0, unpriced: 1 });
    expect(d.sessionRows.every((r) => r.apiCost === null)).toBe(true);
  });
});
