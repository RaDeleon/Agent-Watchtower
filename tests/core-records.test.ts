import { describe, expect, it } from "vitest";
import { validateRecord, toEpochSeconds } from "@/lib/core/records.ts";

const ok = {
  source: "claude", sourceRecordId: "r1", kind: "request",
  timestamp: "2026-09-14T18:37:55.016862+00:00", schemaVersion: 1,
};

describe("toEpochSeconds", () => {
  // Independently verified: `date -u -j -f "%Y-%m-%dT%H:%M:%S" \
  //   "2026-09-14T00:00:00" +%s` and Python's datetime both give 1789344000.
  it("parses an RFC3339 timestamp with an explicit offset", () => {
    expect(toEpochSeconds("2026-09-14T00:00:00+00:00")).toBe(1789344000);
  });

  it("parses a non-UTC offset correctly", () => {
    expect(toEpochSeconds("2026-09-14T02:00:00+02:00"))
      .toBe(toEpochSeconds("2026-09-14T00:00:00Z"));
  });

  // A naked local time is ambiguous, and the rollup buckets by LOCAL day.
  // Accepting one silently would corrupt day buckets for every source.
  it("rejects a timestamp with no offset", () => {
    expect(() => toEpochSeconds("2026-09-14T00:00:00")).toThrow(/offset/);
  });

  it("rejects an unparseable timestamp", () => {
    expect(() => toEpochSeconds("yesterday")).toThrow();
  });
});

describe("validateRecord", () => {
  it("accepts a minimal valid record", () => {
    expect(validateRecord(ok).sourceRecordId).toBe("r1");
  });

  it("rejects an unknown kind", () => {
    expect(() => validateRecord({ ...ok, kind: "nonsense" })).toThrow(/kind/);
  });

  it.each(["source", "sourceRecordId", "kind", "timestamp"])(
    "rejects a record missing %s", (field) => {
      const bad: Record<string, unknown> = { ...ok };
      delete bad[field];
      expect(() => validateRecord(bad)).toThrow(new RegExp(field));
    });

  // THE INVARIANT: absent is not zero.
  it("keeps an absent metric absent and a zero metric zero", () => {
    const withZero = validateRecord({ ...ok, metrics: { tokens_out: 0 } });
    expect(withZero.metrics?.tokens_out).toBe(0);
    expect(validateRecord(ok).metrics).toBeUndefined();
  });

  it("rejects a non-numeric metric rather than coercing it", () => {
    expect(() => validateRecord({ ...ok, metrics: { tokens_out: "12" } }))
      .toThrow(/metric/);
  });

  it("rejects a non-finite metric", () => {
    expect(() => validateRecord({ ...ok, metrics: { x: Infinity } })).toThrow(/finite/);
  });

  it("defaults authority to enrichment", () => {
    expect(validateRecord(ok).authority).toBe("enrichment");
  });
});
