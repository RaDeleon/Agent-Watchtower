import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseNdjson } from "@/lib/adapters/external/ndjson";

const ROOT = path.resolve(__dirname, "..");

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const base = {
  source: "my-agent", sourceRecordId: "1", kind: "session",
  timestamp: "2026-09-14T20:00:00Z",
};

describe("parseNdjson", () => {
  it("parses one record per line", () => {
    const out = parseNdjson([line(base), line({ ...base, sourceRecordId: "2" })].join("\n"));
    expect(out.records).toHaveLength(2);
    expect(out.malformed).toBe(0);
  });

  // A bad line must NOT abort the stream.
  it("counts a malformed line and continues", () => {
    const out = parseNdjson([line(base), "{ not json", line({ ...base, sourceRecordId: "3" })].join("\n"));
    expect(out.records).toHaveLength(2);
    expect(out.malformed).toBe(1);
    // Specifically: the line AFTER the bad one survived. Asserting only the
    // count would stay green if parsing stopped early and something else
    // incremented malformed.
    expect(out.records.map((r) => r.sourceRecordId)).toEqual(["1", "3"]);
  });

  it("ignores blank lines without counting them as malformed", () => {
    const out = parseNdjson(`${line(base)}\n\n  \n`);
    expect(out.records).toHaveLength(1);
    expect(out.malformed).toBe(0);
  });

  it("returns nothing for empty input rather than throwing", () => {
    expect(parseNdjson("")).toEqual({ records: [], malformed: 0 });
  });

  it("maps an unknown kind to custom rather than dropping the record", () => {
    const out = parseNdjson(line({ ...base, kind: "weird-thing" }));
    expect(out.records).toHaveLength(1);
    expect(out.records[0].kind).toBe("custom");
  });

  it("leaves a known kind alone", () => {
    expect(parseNdjson(line({ ...base, kind: "request" })).records[0].kind).toBe("request");
  });

  // ABSENT IS NOT UNKNOWN. kind is a required envelope field; a record that
  // never states one is malformed, not a "custom" record. Coercing a missing
  // field to a default is the same mistake as filling an absent metric with 0.
  it("counts a record with no kind as malformed instead of inventing custom", () => {
    const { kind, ...noKind } = base;
    const out = parseNdjson(line(noKind));
    expect(out).toEqual({ records: [], malformed: 1 });
  });

  // A line that parses as JSON but fails envelope validation is malformed too,
  // and must not abort the stream either.
  it("counts an invalid record as malformed and keeps going", () => {
    const out = parseNdjson([
      line({ ...base, timestamp: "2026-09-14T20:00:00" }),   // no UTC offset
      line({ ...base, sourceRecordId: "4" }),
    ].join("\n"));
    expect(out.malformed).toBe(1);
    expect(out.records.map((r) => r.sourceRecordId)).toEqual(["4"]);
  });

  it("counts a JSON line that is not an object as malformed", () => {
    expect(parseNdjson("[1,2,3]\n42\n\"hi\"").malformed).toBe(3);
  });

  // Decision 12: external records are enrichment unless config grants authority.
  it("forces authority to enrichment even if the payload claims otherwise", () => {
    const out = parseNdjson(line({ ...base, authority: "authoritative" }));
    expect(out.records[0].authority).toBe("enrichment");
  });

  it("forces authority to enrichment on every record, not just the first", () => {
    const out = parseNdjson([
      line({ ...base, authority: "authoritative" }),
      line({ ...base, sourceRecordId: "2", authority: "authoritative" }),
    ].join("\n"));
    expect(out.records).toHaveLength(2);
    expect(out.records.map((r) => r.authority)).toEqual(["enrichment", "enrichment"]);
  });

  it("preserves metrics without inventing absent ones", () => {
    const out = parseNdjson(line({ ...base, metrics: { widgets: 0 } }));
    expect(out.records[0].metrics).toEqual({ widgets: 0 });
    expect(parseNdjson(line(base)).records[0].metrics).toBeUndefined();
  });

  it("tolerates CRLF line endings", () => {
    const out = parseNdjson(`${line(base)}\r\n${line({ ...base, sourceRecordId: "2" })}\r\n`);
    expect(out.records).toHaveLength(2);
    expect(out.malformed).toBe(0);
  });
});

// The CLI is the only consumer that runs these modules through NODE rather than
// vitest, and the two resolvers do not agree: vitest resolves the "@/" alias
// from vitest.config.ts, Node does not. Without this, lib/adapters/** could
// import "@/lib/core/records.ts", every unit test above would stay green, and
// `watchtower ingest` would die with ERR_MODULE_NOT_FOUND in the user's hands.
describe("bin/watchtower", () => {
  const BIN = path.join(ROOT, "bin", "watchtower");

  const run = (args: string[], stdin: string) =>
    spawnSync(process.execPath, [BIN, ...args], { input: stdin, encoding: "utf8" });

  it("is executable and declared as the package bin", () => {
    expect(existsSync(BIN)).toBe(true);
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(pkg.bin.watchtower).toBe("bin/watchtower");
    // Zero runtime dependencies is guarded in tests/capture-scripts.test.ts
    // ("declares zero runtime dependencies"), which owns that defect alone.
  });

  it("parses NDJSON from stdin under plain node, with no build step", () => {
    const r = run(["ingest", "--stdin", "--source", "my-agent"],
      [line(base), "{ not json", line({ ...base, sourceRecordId: "2" })].join("\n"));
    expect(`${r.status}: ${r.stderr}`).toBe("0: ");
    expect(JSON.parse(r.stdout)).toEqual({ source: "my-agent", parsed: 2, malformed: 1 });
  });

  it("accepts empty stdin", () => {
    const r = run(["ingest", "--stdin", "--source", "x"], "");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ source: "x", parsed: 0, malformed: 0 });
  });

  // A bare `watchtower` is not a usage error any more: it opens the dashboard,
  // which tests/cli-open.test.ts drives against its own database and port.
  it.each([
    [["bogus"], "unknown command"],
    [["ingest", "--source", "x"], "requires --stdin"],
    [["ingest", "--stdin"], "--source"],
  ])("exits 2 with a usage error for %j", (args, needle) => {
    const r = run(args as string[], "");
    expect(`${r.status}`).toBe("2");
    expect(r.stderr + r.stdout).toContain(needle as string);
  });
});
