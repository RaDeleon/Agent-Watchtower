import { validateRecord, RECORD_KINDS, type WatchtowerRecord } from "../../core/records.ts";

export interface NdjsonResult { records: WatchtowerRecord[]; malformed: number }

/**
 * Parse NDJSON into records.
 *
 * A malformed line is counted and SKIPPED; the stream continues. One bad line
 * from a third-party adapter must not abort an otherwise good ingest, and the
 * count is what keeps the skips visible -- a silent drop is how a systematic
 * producer bug hides.
 *
 * An UNKNOWN kind maps to "custom" rather than dropping the record: a source
 * that reports something Watchtower has no name for still carries a timestamp
 * and provenance worth keeping. An ABSENT kind is a different fact and stays
 * malformed -- inventing a default for a required field is the same mistake as
 * filling an absent metric with 0.
 *
 * Authority is forced to "enrichment" regardless of what the payload claims.
 * An external producer must not be able to seize ownership of Claude's token
 * counts by asserting it in its own JSON; that grant lives in config only.
 */
export function parseNdjson(input: string): NdjsonResult {
  const records: WatchtowerRecord[] = [];
  let malformed = 0;

  for (const raw of input.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("record must be a JSON object");
      }
      const o = parsed as Record<string, unknown>;
      if (typeof o.kind === "string" && o.kind !== ""
          && !(RECORD_KINDS as readonly string[]).includes(o.kind)) {
        o.kind = "custom";
      }
      o.authority = "enrichment";
      records.push(validateRecord(o));
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}
