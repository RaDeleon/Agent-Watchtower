import { applyWtSchema } from "./schema.ts";
import { registerSource, safeDetect, type WatchtowerAdapter } from "./adapters.ts";
import { addMalformed, ingestRecordsStream, recordRunFailure } from "./ingest.ts";
import { errorLine } from "./sql.ts";

export interface SourceSummary {
  source: string;
  /**
   * Whether the source's data was actually there this run.
   *
   * false is a NORMAL state, not a failure: a machine that has never run
   * Codex has no Codex tables, and that is the answer, not an error. The
   * Sources view renders it as "not detected"; nothing was read, nothing was
   * written, and the source is not registered in wt_sources by a run that
   * could not see it.
   */
  detected: boolean;
  /** The database path when detected; the reason when not. */
  detail?: string;
  /** Records written this run because they were new or had changed. */
  ingested: number;
  /** Records read this run and skipped because nothing about them changed. */
  unchanged: number;
  metricsRejected: number;
  malformed: number;
  /** Set when the source was detected and its run threw. The other sources are unaffected (R17). */
  error?: string;
}

function skipped(id: string, detail?: string): SourceSummary {
  return {
    source: id, detected: false, detail,
    ingested: 0, unchanged: 0, metricsRejected: 0, malformed: 0,
  };
}

/**
 * Project every given adapter into wt_*.
 *
 * This is the one thing all three callers share: the CLI, the dashboard on
 * start, and the dashboard's poll interval. It is idempotent, and every wt_*
 * write is ON CONFLICT ... DO UPDATE, so a concurrent run or a concurrent
 * capture-side insert self-heals rather than corrupting state.
 *
 * It READS the whole source every run and WRITES only what changed. A cursor
 * would read less, but Claude's rows change in place -- ingest raises token
 * counts on an existing request_id, rollup resolves a project path months
 * later -- and a cursor misses exactly those updates. Comparing fingerprints
 * catches any change to a record however it happened (see
 * wt_record_fingerprints). Measured on the live archive, 2026-09-16: see
 * docs/superpowers/specs/2026-09-15-sync-trigger-and-surfaces-design.md §5.
 *
 * DETECTION COMES FIRST, and it comes before applyWtSchema.
 *
 * An adapter whose source is absent is SKIPPED and reported, never ingested.
 * Without this, `watchtower sync` against a database with no claude_* tables
 * -- which is every brand-new install, and the shape of a first run -- died
 * inside the first paged read with `no such table: claude_sessions` and an
 * unhandled Node stack. The probes existed (Task 6) and nothing in production
 * called them.
 *
 * The probe runs BEFORE applyWtSchema because applyWtSchema CREATES the file.
 * Probing afterwards still detects correctly, but it reports the wrong thing:
 * existsSync is true by then, so a first run says "no claude_* tables" about a
 * database that did not exist a moment earlier. Probing first is what makes the
 * detail read "no database at <path>" -- the difference between telling someone
 * their install is empty and telling them it is not there.
 *
 * The ordering does NOT shield applyWtSchema. The schema is applied
 * unconditionally afterwards, so an unwritable or non-SQLite DESTINATION still
 * fails loudly, and should: wt_* is this database's output side, and a reader
 * must find its tables whether or not any source had data today. An absent
 * source is a state; an unwritable destination is an error.
 *
 * safeDetect, not detect, because the contract is that a probe must not throw
 * and a contract nobody enforces is a wish. One adapter blowing up must not
 * take the rest of the sweep with it.
 *
 * Each adapter runs in its own try/catch (Stage 5 R17): a source that throws is
 * marked degraded and reported with `error`, and the others still run.
 *
 * It is NOT one atomic snapshot of the source tables. The adapters' record
 * generators page their reads (see pagedRows in lib/core/sql.ts), which spans
 * several separate sqlite3 processes while capture/hook.sh and
 * capture/ingest.sh may be inserting concurrently -- a row that sorts before
 * the current offset can still shift which rows later pages see. There is no
 * read-side watermark, so "when it runs relative to capture" is a question of
 * freshness, not of correctness: a row missed by one page arrives whole on
 * the next sync.
 */
export async function runSync(opts: {
  db: string; adapters: WatchtowerAdapter[];
  /** Records per write batch. Tests shrink it; everyone else takes the default. */
  chunkSize?: number;
}): Promise<SourceSummary[]> {
  const probed: { adapter: WatchtowerAdapter; detail?: string; detected: boolean }[] = [];
  for (const adapter of opts.adapters) {
    const d = await safeDetect(adapter);
    probed.push({ adapter, detected: d.detected, detail: d.detail });
  }

  applyWtSchema(opts.db);
  const out: SourceSummary[] = [];

  for (const { adapter, detected, detail } of probed) {
    if (!detected) {
      out.push(skipped(adapter.id, detail));
      continue;
    }

    // ISOLATED. One source failing -- Hermes's state.db mid-write, a corrupt
    // registry row -- is recorded against that source and the sweep goes on.
    // The destination is still loud: applyWtSchema above throws on a bad DB.
    try {
      registerSource(opts.db, adapter);
      const res = await ingestRecordsStream(
        opts.db, adapter.id, adapter.ingest(), opts.chunkSize);
      const extra = adapter.finish?.({ clean: res.malformed === 0 }) ?? { malformed: 0 };
      addMalformed(opts.db, adapter.id, extra.malformed, extra.detail);
      out.push({
        source: adapter.id, detected: true, detail,
        ingested: res.ingested, unchanged: res.unchanged,
        metricsRejected: res.metricsRejected, malformed: res.malformed + extra.malformed,
      });
    } catch (e) {
      const error = errorLine(e);
      recordRunFailure(opts.db, adapter.id, error);
      out.push({ ...skipped(adapter.id, detail), detected: true, error });
    }
  }

  return out;
}
