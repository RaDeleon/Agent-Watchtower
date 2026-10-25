import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalise, parseRollout, subagentOf } from "@/lib/adapters/codex/parse";

const MAKE_CODEX = path.resolve(__dirname, "fixtures", "make-codex-logs.sh");
const T0 = 1789466400;
const CWD = "/tmp/wt-codex-repo";

function coreHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "wt-codex-parse-"));
  execFileSync("bash", [MAKE_CODEX, "core", home], { env: { ...process.env, WT_CODEX_CWD: CWD } });
  return home;
}

describe("parseRollout", () => {
  it("S1: events, session and clean counters (R3, R6)", () => {
    const home = coreHome();
    const f = path.join(home, ".codex/sessions/2026/09/15/rollout-2026-09-15T10-00-00-codex-s1.jsonl");
    const p = parseRollout(readFileSync(f, "utf8"), "rollout-2026-09-15T10-00-00-codex-s1");
    const ev = p.records.filter((r) => r.kind === "event")
      .map((r) => [r.dimensions?.seq, r.dimensions?.event]);
    expect(ev).toEqual([[1, "session_start"], [3, "activity"], [4, "prompt"], [5, "activity"],
      [6, "activity"], [7, "activity"], [9, "stop"], [10, "activity"], [11, "prompt"],
      [12, "activity"], [14, "activity"], [15, "stop"]]);
    expect(p.session).toEqual({
      id: "codex-s1", entry: "Codex Desktop", cwd: CWD, branch: "main",
      repo: "https://example.invalid/r.git", model: "gpt-5.5",
      startedAt: T0, endedAt: T0 + 220, subagent: false,
    });
    expect(p.malformed).toBe(0);
    expect(p.partialTail).toBe(false);
  });

  it("a later meta for the file's own id is session_start; another id is activity", () => {
    const t = (s: number) => new Date((T0 + s) * 1000).toISOString();
    const meta = (id: string, s: number) =>
      JSON.stringify({ timestamp: t(s), type: "session_meta", payload: { id, originator: "o" } });
    const text = [meta("x", 0), meta("y", 5), meta("x", 10)].join("\n") + "\n";
    const p = parseRollout(text, "f");
    expect(p.session?.id).toBe("x");
    expect(p.records.map((r) => r.dimensions?.event)).toEqual(["session_start", "activity", "session_start"]);
  });

  it.each([
    [{ subagent: { thread_spawn: {} } }, "subagent:thread_spawn"],
    [{ subagent: { other: "guardian" } }, "subagent:guardian"],
    ["vscode", undefined],
    [{ subagent: "review" }, "subagent:review"],
  ])("subagentOf(%j) is %s", (src, want) => {
    expect(subagentOf(src)).toBe(want);
  });

  it("normalise: cache and reasoning counts", () => {
    const n = normalise({ input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 20 });
    expect(n.tokens_cache_read).toBe(400);
    expect(n.tokens_cache_creation).toBe(0);
    expect(n.reasoning_tokens).toBe(20);
  });

  it("a file with no session_meta is skipped, not malformed", () => {
    const text = '{"timestamp":"2026-09-15T10:00:00Z","type":"event_msg","payload":{"type":"task_started"}}\n';
    expect(parseRollout(text, "x")).toEqual({ session: null, records: [], malformed: 0, partialTail: false });
  });

  it("separates a partial last line from a complete line that does not parse", () => {
    const META = '{"timestamp":"2026-09-15T10:00:00Z","type":"session_meta","payload":{"id":"m"}}';
    const a = parseRollout(`${META}\nnot json\n{"timest`, "x");
    expect([a.malformed, a.partialTail]).toEqual([1, true]);
    const b = parseRollout(`${META}\n{"timest\n`, "x");
    expect([b.malformed, b.partialTail]).toEqual([1, false]);
  });
});
