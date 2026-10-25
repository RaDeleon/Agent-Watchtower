import { beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAndRoll } from "./helpers/fixture-db.ts";
import { readLive } from "@/lib/read/live";
import {
  findSessionTranscripts, findTranscript, readSessionUsage, readTranscriptUsage, resetTranscriptCache,
} from "@/lib/read/transcript";

process.env.TZ = "UTC";

const BASE = 1750000000;
const NOW = BASE + 400;
const iso = (offset: number) => new Date((BASE + offset) * 1000).toISOString();

/** One transcript line, in Claude Code's shape. */
function usageLine(o: {
  requestId: string; offset: number; out: number; in?: number;
}): string {
  return JSON.stringify({
    requestId: o.requestId,
    sessionId: "S_LIVE",
    timestamp: iso(o.offset),
    message: {
      id: `msg_${o.requestId}`,
      model: "claude-opus-5",
      usage: {
        input_tokens: o.in ?? 5,
        output_tokens: o.out,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  }) + "\n";
}

/** A projects dir holding one session transcript, as Claude Code lays it out. */
function transcriptDir(lines: string[]): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-tx-"));
  const project = path.join(dir, "-Users-me-repo");
  mkdirSync(project);
  const file = path.join(project, "S_LIVE.jsonl");
  writeFileSync(file, lines.join(""));
  return { dir, file };
}

beforeEach(() => {
  // The parsed-progress cache is module state, and these tests reuse file paths.
  resetTranscriptCache();
});

describe("findTranscript", () => {
  it("finds the session's file inside a project directory", () => {
    const { dir, file } = transcriptDir([usageLine({ requestId: "r1", offset: 10, out: 100 })]);
    expect(findTranscript(dir, "S_LIVE")).toBe(file);
  });

  it("returns null for a session with no transcript, and for a missing directory", () => {
    const { dir } = transcriptDir([]);
    expect(findTranscript(dir, "S_OTHER")).toBeNull();
    expect(findTranscript(path.join(dir, "nope"), "S_LIVE")).toBeNull();
  });

  // The session id reaches this from the database and is interpolated into a
  // path. Anything but a plain id is refused rather than escaped.
  it("refuses a session id that is not a plain identifier", () => {
    const { dir } = transcriptDir([]);
    expect(findTranscript(dir, "../../etc/passwd")).toBeNull();
  });
});

/**
 * Add a subagent transcript beside a session's main file, where Claude Code
 * writes one: `<project>/<session-id>/subagents/agent-<id>.jsonl`.
 */
function addSubagent(dir: string, name: string, lines: string[]): string {
  const sub = path.join(dir, "-Users-me-repo", "S_LIVE", "subagents");
  mkdirSync(sub, { recursive: true });
  const file = path.join(sub, `${name}.jsonl`);
  writeFileSync(file, lines.join(""));
  return file;
}

describe("findSessionTranscripts", () => {
  // ingest.sh reads every *.jsonl under the projects tree, subagent files
  // included, and their rows carry the parent's session id. The live tail must
  // read the same set or the two figures describe different work.
  it("returns the main file and every subagent file, and nothing else", () => {
    const { dir, file } = transcriptDir([]);
    const a = addSubagent(dir, "agent-a1", []);
    const b = addSubagent(dir, "agent-b2", []);
    writeFileSync(path.join(dir, "-Users-me-repo", "S_LIVE", "subagents", "notes.txt"), "x");
    writeFileSync(path.join(dir, "-Users-me-repo", "S_OTHER.jsonl"), "");
    expect(findSessionTranscripts(dir, "S_LIVE")).toEqual([file, a, b]);
  });

  it("refuses '..' and path-like ids", () => {
    const { dir } = transcriptDir([]);
    expect(findSessionTranscripts(dir, "..")).toEqual([]);
    expect(findSessionTranscripts(dir, "a/b")).toEqual([]);
  });
});

describe("readSessionUsage", () => {
  // The main thread waits while its agents work: only the subagent file moves.
  it("folds subagent files in, so agent work inside the window counts", () => {
    const { file } = transcriptDir([usageLine({ requestId: "r_main", offset: 50, out: 1000 })]);
    const agent = addSubagent(path.dirname(path.dirname(file)), "agent-a1", [
      usageLine({ requestId: "r_agent", offset: 300, out: 100 }),
      usageLine({ requestId: "r_agent", offset: 301, out: 600 }),
    ]);
    const u = readSessionUsage([file, agent], { until: NOW, windowSeconds: 300 })!;
    expect(u.sessionRequests).toBe(2);
    expect(u.sessionTokensOut).toBe(1600);
    expect(u.windowRequests).toBe(1);
    expect(u.windowTokensOut).toBe(600);
  });

  // ingest's primary key is request_id alone, so a request seen in two files
  // is one request, at its maxima.
  it("folds one requestId across files by MAX, not by sum", () => {
    const { file } = transcriptDir([usageLine({ requestId: "r_x", offset: 200, out: 300 })]);
    const agent = addSubagent(path.dirname(path.dirname(file)), "agent-a1", [
      usageLine({ requestId: "r_x", offset: 210, out: 700 }),
    ]);
    const u = readSessionUsage([file, agent], { until: NOW, windowSeconds: 300 })!;
    expect(u.sessionRequests).toBe(1);
    expect(u.sessionTokensOut).toBe(700);
  });

  it("returns null when no file can be read", () => {
    expect(readSessionUsage(["/nonexistent/a.jsonl"], { until: NOW, windowSeconds: 300 })).toBeNull();
  });
});

describe("readTranscriptUsage", () => {
  // THE RULE THIS SHARES WITH ingest.sh. Streaming writes partials under one
  // requestId with growing output_tokens: summing rows overcounts (100+400+900
  // = 1400) and first-seen-wins undercounts (100). Only MAX gives 900.
  it("folds streaming partials to MAX per requestId, not a sum", () => {
    const { file } = transcriptDir([
      usageLine({ requestId: "r_stream", offset: 150, out: 100 }),
      usageLine({ requestId: "r_stream", offset: 151, out: 400 }),
      usageLine({ requestId: "r_stream", offset: 152, out: 900 }),
    ]);
    const u = readTranscriptUsage(file, { until: NOW, windowSeconds: 300 })!;
    expect(u.sessionRequests).toBe(1);
    expect(u.sessionTokensOut).toBe(900);
    expect(u.windowTokensOut).toBe(900);
  });

  // A request is placed by its FIRST timestamp (ingest takes MIN too), and the
  // window's older edge is exclusive: `ts > until - windowSeconds`. Pinned
  // because a request that straddles the edge must land on one side only.
  it("places a request by its first timestamp, on an exclusive older edge", () => {
    const { file } = transcriptDir([
      usageLine({ requestId: "r_edge", offset: 100, out: 100 }),   // exactly NOW-300
      usageLine({ requestId: "r_edge", offset: 260, out: 500 }),   // later partial, inside
      usageLine({ requestId: "r_in", offset: 101, out: 70 }),      // one second inside
    ]);
    const u = readTranscriptUsage(file, { until: NOW, windowSeconds: 300 })!;
    expect(u.windowRequests).toBe(1);
    expect(u.windowTokensOut).toBe(70);
    expect(u.sessionTokensOut).toBe(570);
  });

  it("counts only requests inside the window, but totals the whole session", () => {
    const { file } = transcriptDir([
      usageLine({ requestId: "r_old", offset: 50, out: 5000 }),   // before the window
      usageLine({ requestId: "r_a", offset: 200, out: 1200 }),
      usageLine({ requestId: "r_b", offset: 350, out: 800 }),
    ]);
    const u = readTranscriptUsage(file, { until: NOW, windowSeconds: 300 })!;
    expect(u.windowRequests).toBe(2);
    expect(u.windowTokensOut).toBe(2000);
    expect(u.sessionRequests).toBe(3);
    expect(u.sessionTokensOut).toBe(7000);
    expect(u.latestTs).toBe(BASE + 350);
  });

  // The file is being appended to while it is read. Re-reading must pick up the
  // new bytes without re-counting the old ones — that is what makes a 38 MB
  // transcript affordable on a 5-second poll.
  it("picks up appended lines without double-counting", () => {
    const { file } = transcriptDir([usageLine({ requestId: "r_a", offset: 200, out: 1000 })]);
    expect(readTranscriptUsage(file, { until: NOW, windowSeconds: 300 })!.sessionTokensOut).toBe(1000);
    appendFileSync(file, usageLine({ requestId: "r_b", offset: 300, out: 500 }));
    const u = readTranscriptUsage(file, { until: NOW, windowSeconds: 300 })!;
    expect(u.sessionRequests).toBe(2);
    expect(u.sessionTokensOut).toBe(1500);
  });

  // A record still being written is a half line at the end of the file.
  it("ignores a partial trailing line until it is complete", () => {
    const { file } = transcriptDir([usageLine({ requestId: "r_a", offset: 200, out: 1000 })]);
    const partial = usageLine({ requestId: "r_b", offset: 300, out: 500 });
    appendFileSync(file, partial.slice(0, 40));
    expect(readTranscriptUsage(file, { until: NOW, windowSeconds: 300 })!.sessionRequests).toBe(1);
    appendFileSync(file, partial.slice(40));
    expect(readTranscriptUsage(file, { until: NOW, windowSeconds: 300 })!.sessionRequests).toBe(2);
  });

  it("re-reads a rewritten file from the start instead of resuming past its end", () => {
    const { file } = transcriptDir([
      usageLine({ requestId: "r_a", offset: 200, out: 1000 }),
      usageLine({ requestId: "r_b", offset: 210, out: 1000 }),
    ]);
    expect(readTranscriptUsage(file, { until: NOW, windowSeconds: 300 })!.sessionRequests).toBe(2);
    writeFileSync(file, usageLine({ requestId: "r_z", offset: 220, out: 7 }));
    const u = readTranscriptUsage(file, { until: NOW, windowSeconds: 300 })!;
    expect(u.sessionRequests).toBe(1);
    expect(u.sessionTokensOut).toBe(7);
  });

  it("survives a corrupt line and a line with no usage block", () => {
    const { file } = transcriptDir([
      `{"this is": "not a record"\n`,
      `{"type":"user","message":{"content":"hello"}}\n`,
      usageLine({ requestId: "r_a", offset: 200, out: 42 }),
    ]);
    const u = readTranscriptUsage(file, { until: NOW, windowSeconds: 300 })!;
    expect(u.sessionRequests).toBe(1);
    expect(u.sessionTokensOut).toBe(42);
  });

  it("returns null for a file that is not there", () => {
    expect(readTranscriptUsage("/nonexistent/none.jsonl", { until: NOW, windowSeconds: 300 })).toBeNull();
  });
});

describe("readLive with a live transcript", () => {
  // The point of the whole file: the database only holds what SessionEnd has
  // ingested, so the transcript is what makes the figure live. Measured on the
  // real machine: the transcript was 1s old while the newest stored request was
  // 11 minutes old.
  it("prefers the transcript over the stored requests, and says so", () => {
    const db = buildAndRoll("live");
    const { dir } = transcriptDir([
      usageLine({ requestId: "r_live1", offset: 250, out: 3000 }),
      usageLine({ requestId: "r_live2", offset: 380, out: 3000 }),
    ]);
    const d = readLive(db, { now: NOW, transcriptsDir: dir });
    expect(d.burnRate.source).toBe("transcript");
    expect(d.burnRate.tokensOut).toBe(6000);
    expect(d.burnRate.tokensPerMin).toBe(1200);
    expect(d.sessionUsage?.requests).toBe(2);
  });

  // Killing mutation: drop the subagent glob from findSessionTranscripts. The
  // main thread is idle in the window while an agent works; without the
  // subagent file the burn rate reads "idle" while tokens are being spent.
  it("counts subagent work in the live burn rate and session totals", () => {
    const db = buildAndRoll("live");
    const { dir } = transcriptDir([usageLine({ requestId: "r_main", offset: 20, out: 500 })]);
    addSubagent(dir, "agent-a1", [usageLine({ requestId: "r_agent", offset: 380, out: 1500 })]);
    const d = readLive(db, { now: NOW, transcriptsDir: dir });
    expect(d.burnRate.source).toBe("transcript");
    expect(d.burnRate.tokensOut).toBe(1500);
    expect(d.sessionUsage?.requests).toBe(2);
    expect(d.sessionUsage?.tokensOut).toBe(2000);
  });

  it("falls back to the stored requests when the transcript is gone", () => {
    const db = buildAndRoll("live");
    const d = readLive(db, { now: NOW, transcriptsDir: mkdtempSync(path.join(tmpdir(), "wt-empty-")) });
    expect(d.burnRate.source).toBe("database");
    expect(d.burnRate.tokensOut).toBe(2000);
    expect(d.sessionUsage).toBeNull();
  });
});
