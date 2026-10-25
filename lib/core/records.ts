export const RECORD_ENVELOPE_VERSION = 1;

export const RECORD_KINDS = [
  "session", "request", "usage", "tool", "memory",
  "git", "checkpoint", "health", "event", "custom",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface WatchtowerRecord {
  source: string;
  sourceRecordId: string;
  kind: RecordKind;
  timestamp: string;
  observedAt?: string;
  sessionId?: string;          // SOURCE-LOCAL. Canonical ids come from wt_sessions.
  project?: string; repo?: string; branch?: string;
  agent?: string; model?: string;
  metrics?: Record<string, number>;
  dimensions?: Record<string, string | number | boolean>;
  metadata?: Record<string, unknown>;
  authority: "authoritative" | "enrichment";
  schemaVersion: number;
}

const RFC3339_WITH_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/**
 * RFC3339 -> epoch seconds. An explicit offset is REQUIRED.
 *
 * rollup.sh buckets by LOCAL day, so a naked local time is ambiguous and
 * accepting one silently would corrupt day buckets for every source.
 */
export function toEpochSeconds(ts: string): number {
  if (!RFC3339_WITH_OFFSET.test(ts)) {
    throw new Error(`timestamp must carry an explicit UTC offset: ${ts}`);
  }
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new Error(`unparseable timestamp: ${ts}`);
  return Math.floor(ms / 1000);
}

function req(o: Record<string, unknown>, field: string): string {
  const v = o[field];
  if (typeof v !== "string" || v === "") {
    throw new Error(`record is missing required field ${field}`);
  }
  return v;
}

export function validateRecord(v: unknown): WatchtowerRecord {
  if (typeof v !== "object" || v === null) throw new Error("record must be an object");
  const o = v as Record<string, unknown>;

  const kind = req(o, "kind");
  if (!(RECORD_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`unknown record kind: ${kind}`);
  }

  const timestamp = req(o, "timestamp");
  toEpochSeconds(timestamp);                       // validate now, fail at the boundary
  if (o.observedAt !== undefined) toEpochSeconds(String(o.observedAt));

  // Absent stays absent. Only validate what is actually present.
  let metrics: Record<string, number> | undefined;
  if (o.metrics !== undefined) {
    if (typeof o.metrics !== "object" || o.metrics === null) {
      throw new Error("metrics must be an object");
    }
    metrics = {};
    for (const [k, mv] of Object.entries(o.metrics as Record<string, unknown>)) {
      if (typeof mv !== "number") throw new Error(`metric ${k} must be a number, got ${typeof mv}`);
      if (!Number.isFinite(mv)) throw new Error(`metric ${k} must be finite`);
      metrics[k] = mv;
    }
  }

  const authority = o.authority === "authoritative" ? "authoritative" : "enrichment";

  return {
    source: req(o, "source"),
    sourceRecordId: req(o, "sourceRecordId"),
    kind: kind as RecordKind,
    timestamp,
    observedAt: o.observedAt as string | undefined,
    sessionId: o.sessionId as string | undefined,
    project: o.project as string | undefined,
    repo: o.repo as string | undefined,
    branch: o.branch as string | undefined,
    agent: o.agent as string | undefined,
    model: o.model as string | undefined,
    metrics,
    dimensions: o.dimensions as WatchtowerRecord["dimensions"],
    metadata: o.metadata as Record<string, unknown> | undefined,
    authority,
    schemaVersion: typeof o.schemaVersion === "number" ? o.schemaVersion : RECORD_ENVELOPE_VERSION,
  };
}

/**
 * Epoch seconds -> RFC3339 with an EXPLICIT offset.
 *
 * validateRecord refuses a naked local time: rollup.sh buckets by local day, so
 * an offset-less timestamp is ambiguous and accepting one silently corrupts day
 * buckets for every source. toISOString always ends in Z, which qualifies.
 */
export function epochToRfc3339(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}
