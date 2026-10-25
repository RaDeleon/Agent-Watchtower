# Stage 10 — Character attributes and level caps past 99: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six D&D attributes (STR … CHA) on `/character`, each with a Base level trained by hours × that day's 30-day Form, a 0–99 Form over 30 and 7 days, and a Now level boosted or drained by this week against the month. Levels continue past 99 to 200, opened by global level caps.

**Architecture:** Everything is computed in `capture/rollup.sh`. The profile section scores the ten disciplines over a 7-day window for the as-of day. The agent section derives Form, inserts attribute training rows into `_sk_daily` so Stage 6's keyed level pipeline levels them, extends the XP curve and tiers to 200, and stores `character_attributes` and `level_caps`. The TypeScript readers parse and label; the renderers draw a new Attributes card and the "/cap" displays.

**Tech Stack:** bash + sqlite3 (`capture/`), TypeScript run natively by Node 22+ (`lib/`, no build), vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-stage-10-character-attributes-design.md`. Read it before your task; this plan argues from it, and every § below refers to it.

## Global Constraints

- `CC_SCHEMA_VERSION` = **11** in `capture/lib.sh` and `schemaVersion: 11` in `lib/config.ts`. `WT_SCHEMA_VERSION` stays **3**.
- Every formula, anchor, cap, tier and the discipline → attribute map lives in `capture/rollup.sh` only. `lib/` reads, parses, sorts and labels. It never computes a Form, a boost, a level or a cap. No `120000`, `MIN(gap,`, tier name past Master, or XP constant under `lib/`.
- NULL means "no reading" or "no XP". It never renders as `0`, `Lv 1` or `$0.00`.
- Read phases (`BEGIN DEFERRED`) write only `_`-prefixed TEMP tables; the swap (`BEGIN IMMEDIATE`) only `DELETE`s and `INSERT … SELECT … FROM _x ORDER BY rowid`. `tests/rollup-lock.test.ts` and `tests/profile-rollup.test.ts` pin the shape.
- The as-of day comes from `_pf_asof` (profile section) and `_sk_asof` / `_sk_d` (agent section), never `date('now')`. Tests pin it with `WATCHTOWER_ROLLUP_TODAY`.
- STR's full marks: **120,000** output tokens per active hour. Its gate: **3,600,000** active ms in the window.
- Past 99: level 99+n at exactly 9,000,000 + 900,000·n seconds (2,500 + 250n hours), up to **200**. Caps: 99 → 120 → 150 → 170 → 200. Tiers: ≥200 Eternal, ≥170 Mythic, ≥150 Legend, ≥120 Grandmaster, ≥99 Master; below 99 unchanged.
- Boost = `CAST(round((form_7 − form_30) / 5.0) AS INTEGER)` clamped to −10…10, NULL when either Form is NULL. Now = `MAX(1, base + COALESCE(boost, 0))`, NULL with no base.
- R21: each guard's literal values live in exactly one test; a guard is done only when its plant turns **exactly one** test red. Record each plant and the test it reddened in `.superpowers/sdd/2026-10-13-stage-10-character-attributes/progress.md`.
- Tests never touch `~/.claude` or `~/.theone`. Fixture DBs come from `tests/helpers/fixture-db.ts`; never run two whole suites at once; always `--exclude '.claude/**'`.
- Public-repo hygiene (CLAUDE.md): no home paths, real names, real ids or live cost figures in anything committed. No AI attribution in commits.
- Commit after each task with a conventional message (`feat(rollup): …`, `feat(character): …`, `docs: …`).

## Rulings made while planning (do not re-ask)

- **R1 — `_pf_in` reads `_pf_matrix`, not `_pf_profile`.** For a `'30'` row of an ungated day the two hold identical values (`_pf_profile` copies `_pf_matrix` at `win='30'`, nulling only gated days, which `_pf_dw` excludes). Reading `_pf_matrix m ON m.win = dw.win AND m.day = dw.day` serves both windows from one query.
- **R2 — one scored table.** A new `_pf_sc` scores every `(win, day, discipline)` once. `_pf_scores` takes `win='30'` and `_pf_scores7d` takes `win='7'`, so the 0–60 scale and the status rule stay in one place.
- **R3 — `_pf_qpick` joins `_pf_ev` on `e.win = '30'`.** Without it, an as-of day that is a Sunday doubles the rows for that Sunday and breaks `claude_quests`' `UNIQUE (week, discipline)`.
- **R4 — STR's day set** is every day with tokens or hours, **plus the as-of day**, so a quiet as-of day still has a 30-day STR Form.
- **R5 — STR's tokens** are Claude's `claude_daily_rollups.tokens_out` plus `_ag_r.tokens_out` (Codex and Hermes, the same numbers the swap writes to `agent_daily_rollups`). `_ag_daily`'s columns are unnamed, so it is not read. **Amended at the final review:** Codex's and Hermes's tokens are `_ag_rm.tokens_out` of driven sessions only, joined to `_ag_sess` as `_ag_ev` joins its events, because their hours are driven-only; `_ag_r` and `agent_daily_rollups` are unchanged.
- **R6 — guard 5 moves to Task 2** (the boost is built there). Task 1 pins the 7-day pipeline with an identity (7d = 30d when every input is in the last 7 days) and a gated window that writes no 7-day rows.
- **R7 — guard 11's plant** must let a `character` row reach pace: build `_sk_win` from `(SELECT DISTINCT source FROM _sk_daily WHERE kind IN ('tool','attribute'))` with `s.kind IN ('tool','attribute')`. Reading kind `attribute` alone is vacuous, because `_sk_win` iterates `_ag_life`'s tools.
- **R8 — guard 12 is re-aimed** at the level-up label. `readCharacter` builds sections from the shown tools, so a `character` row can never get one and the spec's plant is vacuous. The new guard is "an attribute level-up is labelled by its name". Plant: drop the `attribute` branch in `pathOf`, which renders "undefined › attribute › Strength".
- **R9 — the old veteran test is retired.** Its literals (level, stars) would redden alongside guards 6 and 8. A Hermes `legend` scenario (101,339,999 s, past 200) replaces it as "the only test past 9,000,000 s" for stars. The 11,699,999 s `veteran` scenario stays for guard 9.
- **R10 — the v10 → v11 upgrade test** builds a v11 database, then removes the v11 tables and column and stamps `.schema-v10`, instead of reading an old `lib.sh` from git history (backlog item 2 removes those history reads).
- **R11 — discipline labels** come from `lib/render/profile.ts`'s `DISCIPLINE_META`, exported through a new `disciplineLabel(id)`. The spec says `lib/read/profile.ts`, but the labels live in the renderer.
- **R12 — version 0.9.0.** Stage 10 is the next stage to ship (`docs/releases.md`: "the next stage to ship is 0.9.0").

## Review Focus

1. **The as-of day is a Sunday.** The `'7'` row lands on a quest-pick day. Quests must be unchanged (R3). Test: Task 1, "an as-of Sunday picks each week's quests once".
2. **A v11 install before its first rollup.** `character_attributes` and `level_caps` exist but are empty. The page must read "pending", never error and never show "Lv 1". Test: Task 3, "empty v11 tables read as pending".
3. **The as-of day has no activity yet.** STR's 30-day Form must still read (R4), and the Claude attributes read that day's scores, which exist for idle days. Test: Task 2, "a quiet as-of day still has a 30-day Strength Form".
4. **A Form of exactly 0.** It must render "0" (measured), distinct from "no reading", and train nothing. Test: Task 3 render, "a measured zero form reads 0"; Task 2 identity (no training row with `active_ms <= 0`).
5. **A drain larger than Base.** Now is floored at 1, never 0 or negative. Test: Task 2 identity on `now_level`; Task 3 render, "a drained tile never reads below 1" (stored values only).

---

### Task 1: Schema v11 and the 7-day discipline scores

**Model:** opus (the profile pipeline is long, and a missed `win` join silently corrupts the 30-day scores).

**Files:**
- Modify: `capture/lib.sh` (`CC_SCHEMA_VERSION`, three tables, the `skill_pace` column, `cc_added_columns`, comments on `skill_level_ups.level` and `skill_pace.eta_next_days`)
- Modify: `lib/config.ts:117` (`schemaVersion: 11`)
- Modify: `capture/rollup.sh` profile section (~lines 1456–1992)
- Modify: `tests/fixtures/make-fixture.sh` (scenarios `profile-7d`, `profile-7d-gated`; helper `sess_at` for Task 2)
- Modify: `tests/profile-rollup.test.ts` (new `describe("Stage 10: 7-day discipline scores")`)
- Modify: `tests/capture-scripts.test.ts` (the v10 → v11 upgrade test)
- Modify: `tests/quests-rollup.test.ts` (the Sunday test)

**Interfaces:**
- Produces: table `claude_discipline_scores_7d(day TEXT, discipline TEXT, score INTEGER, status TEXT, PK(day, discipline))`, written each rollup, with 10 rows for the as-of day or none when its 7-day window has under 20 requests. Tables `character_attributes` and `level_caps` and column `skill_pace.eta_cap_days` are declared (filled in Task 2). Fixture helper `sess_at <session> <abs-ts>`.

- [ ] **Step 1: Declare schema v11 in `capture/lib.sh`.**

Set `CC_SCHEMA_VERSION=11`. Add `eta_cap_days INTEGER` as the last column of `skill_pace`'s `CREATE TABLE`, with the comment `-- v11: days to xp(current cap) at the 28-day pace; NULL for 'all', with no pace or level, at 200`. Change `skill_level_ups.level`'s comment to `-- 2..200 (Lv 1 is never logged)` and `skill_pace.eta_next_days`'s to `-- NULL with no pace, at 200, or with no level, and never 0`. Append after `character_points`:

```sql
-- Stage 10 (schema v11): the as-of day's 7-day discipline scores, regenerable,
-- filled by rollup.sh's profile section beside claude_discipline_scores. Only
-- the boost reads them, so only the as-of day is scored (spec 4.2).
CREATE TABLE IF NOT EXISTS claude_discipline_scores_7d (
  day        TEXT    NOT NULL,           -- the as-of day only
  discipline TEXT    NOT NULL,
  score      INTEGER NOT NULL,           -- 0-60; 0 when needs-data, as in claude_discipline_scores
  status     TEXT    NOT NULL,           -- the same rules as claude_discipline_scores
  PRIMARY KEY (day, discipline)
);

-- Stage 10: the six attributes and the level caps. Regenerable, filled by
-- rollup.sh's agent section.
CREATE TABLE IF NOT EXISTS character_attributes (
  attribute     TEXT    PRIMARY KEY,     -- 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'
  ord           INTEGER NOT NULL,        -- 1-6, display order
  as_of_day     TEXT    NOT NULL,
  form_30       INTEGER,                 -- 0-99; NULL = no reading
  form_7        INTEGER,                 -- 0-99; NULL = no reading
  boost         INTEGER,                 -- -10..10; NULL when either Form is NULL
  base_level    INTEGER,                 -- NULL with no attribute XP
  now_level     INTEGER,                 -- MAX(1, base_level + COALESCE(boost, 0)); NULL with no XP
  evidence_json TEXT    NOT NULL         -- constituents' 30-day scores, or STR's per-hour rates
);
CREATE TABLE IF NOT EXISTS level_caps (
  cap           INTEGER PRIMARY KEY,     -- 99, 120, 150, 170, 200
  reached_level INTEGER,                 -- the level that opened it; NULL for 99
  opened_day    TEXT,                    -- NULL for 99
  source        TEXT,                    -- the stat that opened it; NULL for 99
  kind          TEXT,
  key           TEXT
);
```

Append `skill_pace|eta_cap_days INTEGER` as the last line of `cc_added_columns`. Set `schemaVersion: 11` in `lib/config.ts`.

- [ ] **Step 2: Write the upgrade test (failing until Step 1 is applied correctly).**

In `tests/capture-scripts.test.ts`, beside "upgrades a real v5 database in one call", add a test. Copy the env and marker handling from the v5 test in the same file, and give the database its own directory (the marker is per directory):

```ts
// Stage 10 (spec 6.1, R10): a v10 database gains the v11 tables and column in
// one cc_init_db call, rows untouched. A v10 shape is made from v11 by
// removing exactly what v11 added, so no old lib.sh is read from git history.
it("upgrades a v10 database in one call: the v11 tables and column, rows untouched", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-v10-"));
  const db = path.join(dir, "claude-code-usage.sqlite");
  const env = { ...process.env, THEONE_DB_PATH: db, WATCHTOWER_DB_PATH: db, CC_LIB_PATH: LIB_PATH };
  const init = () => execFileSync("bash", ["-c", '. "$CC_LIB_PATH" && cc_init_db'], { env, encoding: "utf8" });
  init();
  execFileSync("sqlite3", [db, `DROP TABLE claude_discipline_scores_7d; DROP TABLE character_attributes;
    DROP TABLE level_caps; ALTER TABLE skill_pace DROP COLUMN eta_cap_days;
    INSERT INTO skill_pace (source, as_of_day, xp_today, xp_7d, xp_28d, pace_xp_per_day, eta_next_days,
      eta_99_days, streak_current, streak_best) VALUES ('claude', '2026-09-30', 1, 2, 3, 0.1, 4, 5, 6, 7);`]);
  rmSync(path.join(dir, `.schema-v${schemaVersion()}`));
  writeFileSync(path.join(dir, ".schema-v10"), "");
  const tables = () => execFileSync("sqlite3", [db, `SELECT name FROM sqlite_master WHERE type = 'table'
    AND name IN ('claude_discipline_scores_7d', 'character_attributes', 'level_caps') ORDER BY name;`],
    { encoding: "utf8" }).trim();
  expect(tables()).toBe("");
  init();
  expect(tables().split("\n")).toEqual(["character_attributes", "claude_discipline_scores_7d", "level_caps"]);
  expect(execFileSync("sqlite3", [db, "SELECT source, xp_28d, streak_best, eta_cap_days FROM skill_pace;"],
    { encoding: "utf8" }).trim()).toBe("claude|3|7|");
});
```

Add `rmSync` to the `node:fs` import if it is missing. Run: `npx vitest run tests/capture-scripts.test.ts -t "v10 database"`. Expected: PASS once Step 1 is in. Plant: delete the `cc_added_columns` line. Expected: this test fails (no `eta_cap_days`). Restore it.

- [ ] **Step 3: Add the fixtures to `tests/fixtures/make-fixture.sh`.**

After `ev_at()`, add the absolute-time session helper that Task 2 needs:

```bash
# Stage 10: a claude_sessions row at an ABSOLUTE start time, beside ev_at(), so
# a fixture can give Claude hours on real recent days (sess() is BASE-relative).
sess_at() { # sess_at <session> <abs-ts>
  fx_sql "INSERT INTO claude_sessions (session_id, started_at, updated_at, cwd, repo, prompts)
          VALUES ($(cc_sqlstr "$1"), $2, $2, $CWD_FX, $REPO_FX, 1);"
}
```

Before the `*)` branch, add:

```bash
  profile-7d|profile-7d-gated)
    # Stage 10 (spec 4.2), as of Wed 2026-09-30. Tool and hook coverage start on
    # 2026-08-21, before both windows' first days (09-01 and 09-24), and that
    # first call and event fall outside both windows. Every other input lands on
    # 2026-09-28, so the 30-day and the 7-day window of 09-30 see the same data
    # and every discipline must score the same over both. The gated variant has
    # 19 requests in the last 7 days and 5 more on 09-10: 24 in the 30-day
    # window (scored) and 19 in the 7-day one (gated, no 7-day rows).
    ev_at P7_OLD "$(epoch 2026-08-21T12:00:00Z)" SessionStart
    tc_at P7_OLD_TC P7_OLD "$(epoch 2026-08-21T12:00:00Z)" Read 0 0
    n=24; if [ "$scenario" = profile-7d-gated ]; then n=19; fi
    t0="$(epoch 2026-09-28T10:00:00Z)"
    for i in $(seq 0 $((n - 1))); do
      s="P7_S$((i % 3))"; t=$((t0 + i * 60))
      req_at "P7_$i" "$s" "$t" /tmp/fx 900 0 10 "$((20000 + i * 1000))" 0
      if [ $((i % 4)) -eq 0 ]; then req_meta "P7_$i" fx-model-2 cli; fi
      tc_at "P7_TC_$i" "$s" "$((t + 10))" Read 0 0
      if [ $((i % 6)) -eq 0 ]; then tc_at "P7_TCE_$i" "$s" "$((t + 20))" Bash 1 0; fi
      if [ $((i % 5)) -eq 0 ]; then tc_at "P7_MCP_$i" "$s" "$((t + 30))" mcp__fx__lookup 0 0; fi
      if [ $((i % 3)) -eq 0 ]; then tc_at "P7_AG_$i" "$s" "$((t + 40))" Task 0 0; fi
      if [ $((i % 4)) -eq 1 ]; then sl_at "P7_SL_$i" "$s" "$((t + 50))" "/cmd$((i % 3))"; fi
      ev_at "$s" "$((t + 5))" UserPromptSubmit '{"permission_mode":"default"}'
    done
    ev_at P7_S0 "$((t0 + 3000))" PreCompact
    if [ "$scenario" = profile-7d-gated ]; then
      t1="$(epoch 2026-09-10T10:00:00Z)"
      for i in 0 1 2 3 4; do req_at "P7_OLD_$i" P7_OLD "$((t1 + i * 60))" /tmp/fx 900 0 10 20000 0; done
    fi
    ;;
```

(The script runs under `set -euo pipefail`, so every conditional is an `if`, never `[ … ] && cmd`.)

- [ ] **Step 4: Write the failing profile tests.**

Append to `tests/profile-rollup.test.ts`:

```ts
// Stage 10 (spec 4.2): the as-of day's 7-day discipline scores.
describe("Stage 10: 7-day discipline scores", () => {
  const ASOF = { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" };
  type S = { day: string; discipline: string; score: number; status: string };
  const s30 = (db: string) => rows<S>(db, `SELECT day, discipline, score, status FROM claude_discipline_scores
    WHERE day = '2026-09-30' ORDER BY discipline;`);
  const s7 = (db: string) => rows<S>(db, "SELECT day, discipline, score, status FROM claude_discipline_scores_7d ORDER BY discipline;");

  // Identity: with every input inside the last 7 days, both windows see the
  // same data, so every one of the ten scores the same.
  it("scores the same over 7 days as over 30 when every input is in the last 7", () => {
    const db = buildAndRoll("profile-7d", ASOF);
    expect(s30(db)).toHaveLength(10);
    expect(s30(db).filter((r) => r.status !== "needs-data").length).toBeGreaterThan(6); // non-vacuity
    expect(s7(db)).toEqual(s30(db));
  });

  it("writes no 7-day scores when the 7-day window has under 20 requests", () => {
    const db = buildAndRoll("profile-7d-gated", ASOF);
    expect(s30(db)).toHaveLength(10);
    expect(s7(db)).toEqual([]);
  });
});
```

Run: `npx vitest run tests/profile-rollup.test.ts -t "Stage 10"`. Expected: FAIL (`no such table: claude_discipline_scores_7d` until Step 1, then empty `s7`).

- [ ] **Step 5: Parameterize the profile pipeline by window (`capture/rollup.sh`).**

Make these edits exactly:

1. Replace `_pf_dw`:

```sql
DROP TABLE IF EXISTS _pf_dw;
CREATE TEMP TABLE _pf_dw AS
SELECT '30' AS win, p.day, w.lo, w.hi, p.tool_covered, p.event_covered
FROM _pf_profile p
JOIN _pf_win w ON w.win = '30' AND w.day = p.day
WHERE p.window_requests >= 20
UNION ALL
-- Stage 10 (spec 4.2): the as-of day's 7-day window, one row, under the same
-- gate counted over its own 7 days. Coverage is checked against the window's
-- own first day. Filtered to the as-of day HERE, so every range join below
-- costs one more window, not one per day of history.
SELECT '7', w.day, w.lo, w.hi,
       CASE WHEN cov.coverage_start IS NOT NULL AND w.lo >= cov.coverage_start THEN 1 ELSE 0 END,
       CASE WHEN ev.event_start IS NOT NULL AND w.lo >= ev.event_start THEN 1 ELSE 0 END
FROM _pf_win w
CROSS JOIN _pf_asof a
CROSS JOIN _pf_coverage cov
CROSS JOIN _pf_evcov ev
JOIN _pf_agg g ON g.win = '7' AND g.day = w.day
WHERE w.win = '7' AND w.day = a.d0 AND g.n_requests >= 20;
```

2. In each of `_pf_wtool`, `_pf_wmcp`, `_pf_wev`, `_pf_wreq` and `_pf_wsdk`, select `dw.win, dw.day` and `GROUP BY dw.win, dw.day`. In `_pf_wslash` and `_pf_wmodel`, the innermost select and its `GROUP BY` gain `dw.win`, `ROW_NUMBER() OVER (PARTITION BY win, day …)`, and the outer `SELECT win, day, …` / `GROUP BY win, day`. In `_pf_wcost`, do the same: the inner select and group gain `dw.win`, and the outer `SELECT win, day, AVG(mx) … GROUP BY win, day`.

3. In `_pf_in`, select `dw.win, dw.day,` then take the Matrix inputs from `_pf_matrix` (R1). Replace the seven `p.` columns with `m.median_ctx, m.median_n AS median_requests, m.long_sessions, m.long_with_reset, m.cache_fresh_ratio, m.f_context, m.f_compaction, m.f_session_length, m.f_efficiency`. Change its joins to:

```sql
FROM _pf_dw dw
JOIN _pf_matrix m        ON m.win  = dw.win AND m.day  = dw.day
JOIN _pf_wreq rq         ON rq.win = dw.win AND rq.day = dw.day
LEFT JOIN _pf_wtool  t   ON t.win   = dw.win AND t.day   = dw.day
LEFT JOIN _pf_wmcp   mc  ON mc.win  = dw.win AND mc.day  = dw.day
LEFT JOIN _pf_wslash sl  ON sl.win  = dw.win AND sl.day  = dw.day
LEFT JOIN _pf_wmodel md  ON md.win  = dw.win AND md.day  = dw.day
LEFT JOIN _pf_wev    ev  ON ev.win  = dw.win AND ev.day  = dw.day
LEFT JOIN _pf_wsdk   sdk ON sdk.win = dw.win AND sdk.day = dw.day
LEFT JOIN _pf_wcost  co  ON co.win  = dw.win AND co.day  = dw.day;
```

Add a comment above `_pf_in`: `-- Stage 10 (R1): the Matrix inputs come from _pf_matrix at the row's own window. For a '30' row of an ungated day that is exactly what _pf_profile copied.`

4. In `_pf_parts` and `_pf_ev`, every `SELECT day,` and `UNION ALL SELECT day,` becomes `SELECT win, day,` / `UNION ALL SELECT win, day,`. There are 16 in `_pf_parts` and 10 in `_pf_ev`.

5. Replace the `_pf_scores` block (from `DROP TABLE IF EXISTS _pf_scores;` through its `ORDER BY e.day, e.ord;`) with:

```sql
-- Every (window, day, discipline) scored once (R2): the mean of its DEFINED
-- parts (SQLite's AVG skips NULLs) scaled to 0-60 as TheOne does it,
-- clamp(round(mean/100 * 60), 0, 60). No defined part -> needs-data, 0.
-- Status: TheOne's statusFor.
DROP TABLE IF EXISTS _pf_sc;
CREATE TEMP TABLE _pf_sc AS
SELECT e.win, e.day, e.discipline, e.ord, e.definition, e.evidence, s.score,
       CASE WHEN s.mean IS NULL THEN 'needs-data'
            WHEN s.score >= 45 THEN 'strong'
            WHEN s.score >= 30 THEN 'ok'
            ELSE 'needs-work' END AS status
FROM _pf_ev e
JOIN (SELECT win, day, discipline, mean,
             CASE WHEN mean IS NULL THEN 0
                  ELSE MIN(60, MAX(0, CAST(round((mean / 100.0) * 60) AS INTEGER))) END AS score
      FROM (SELECT win, day, discipline, AVG(v) AS mean FROM _pf_parts GROUP BY win, day, discipline)) s
  ON s.win = e.win AND s.day = e.day AND s.discipline = e.discipline;

-- The 30-day scores, staged in claude_discipline_scores' shape (its PRIMARY
-- KEY as a unique index) like _pf_profile.
DROP TABLE IF EXISTS _pf_scores;
CREATE TEMP TABLE _pf_scores AS SELECT * FROM main.claude_discipline_scores WHERE 0;
CREATE UNIQUE INDEX idx_pf_scores ON _pf_scores(day, discipline);
INSERT INTO _pf_scores (day, discipline, score, status, definition, evidence_json)
SELECT day, discipline, score, status, definition, evidence FROM _pf_sc WHERE win = '30' ORDER BY day, ord;

-- Stage 10: the as-of day's 7-day scores (10 rows, or none when gated).
DROP TABLE IF EXISTS _pf_scores7d;
CREATE TEMP TABLE _pf_scores7d AS SELECT * FROM main.claude_discipline_scores_7d WHERE 0;
CREATE UNIQUE INDEX idx_pf_scores7d ON _pf_scores7d(day, discipline);
INSERT INTO _pf_scores7d (day, discipline, score, status)
SELECT day, discipline, score, status FROM _pf_sc WHERE win = '7' ORDER BY day, ord;
```

6. In `_pf_qpick`, change `JOIN _pf_ev e ON e.day = s.day AND e.discipline = s.discipline` to `JOIN _pf_ev e ON e.win = '30' AND e.day = s.day AND e.discipline = s.discipline` (R3).

7. In the write phase, after `INSERT INTO claude_discipline_scores …`:

```sql
DELETE FROM claude_discipline_scores_7d;
INSERT INTO claude_discipline_scores_7d (day, discipline, score, status)
SELECT day, discipline, score, status FROM _pf_scores7d ORDER BY rowid;
```

Then `grep -n "_pf_dw\|_pf_in\b\|_pf_parts\|_pf_ev\b\|_pf_w\(tool\|mcp\|slash\|model\|ev\|req\|sdk\|cost\)\b" capture/rollup.sh` and confirm that every reader joins on `win` or filters it.

- [ ] **Step 6: Run the new tests and the suites that pin the profile.**

Run: `npx vitest run tests/profile-rollup.test.ts tests/quests-rollup.test.ts tests/achievements-rollup.test.ts tests/rollup-lock.test.ts tests/capture-scripts.test.ts tests/read-profile.test.ts`
Expected: all PASS. Every pre-existing profile, quest and achievement literal is unchanged, which shows the `'30'` path did not move.

- [ ] **Step 7: Pin the Sunday quest pick (R3).**

Append to `tests/quests-rollup.test.ts`:

```ts
// Stage 10 (R3): on a Sunday as-of day the 7-day scores land on a quest-pick
// day. Each week must still get each discipline once.
it("an as-of Sunday picks each week's quests once", () => {
  const db = buildAndRoll("quest-weeks", { WATCHTOWER_ROLLUP_TODAY: "2026-08-23" });
  const weeks = rows<{ week: string; n: number; d: number }>(db,
    "SELECT week, COUNT(*) AS n, COUNT(DISTINCT discipline) AS d FROM claude_quests GROUP BY week;");
  expect(weeks.length).toBeGreaterThan(0);
  for (const w of weeks) expect(w.d).toBe(w.n);
  expect(rows(db, "SELECT COUNT(*) AS n FROM claude_discipline_scores_7d;")).toEqual([{ n: 10 }]);
});
```

(Week C's 20 requests on Tue 2026-08-18 put the as-of Sunday's 7-day window over the gate.) Run it. Expected: PASS. Plant: drop `e.win = '30'` from `_pf_qpick`. Expected: this one test fails (the rollup exits 1 on the `UNIQUE` constraint, or a week repeats a discipline). Restore.

- [ ] **Step 8: Measure the cost.** On a `.backup` copy of the live DB in its own directory, time `bash capture/rollup.sh --quiet` three times with this branch and three times with `main`'s scripts (`git show main:capture/rollup.sh`, `git show main:capture/lib.sh`, each copy in its own directory). Record the medians in the ledger. The budget for the whole stage is +1 s.

- [ ] **Step 9: Typecheck, then commit.**

Run: `npm run typecheck`. Expected: clean.

```bash
git add capture/lib.sh capture/rollup.sh lib/config.ts tests/fixtures/make-fixture.sh tests/profile-rollup.test.ts tests/quests-rollup.test.ts tests/capture-scripts.test.ts
git commit -m "feat(rollup): schema v11 and the as-of day's 7-day discipline scores"
```

---

### Task 2: The agent section — attributes, the curve to 200, caps and pace to the cap

**Model:** opus.

**Files:**
- Modify: `capture/rollup.sh` agent section (~lines 2246–2671)
- Modify: `tests/fixtures/make-fixture.sh` (scenario `attr-days`)
- Modify: `tests/fixtures/make-hermes-db.sh` (scenario `legend`)
- Create: `tests/attributes-rollup.test.ts`
- Modify: `tests/agent-rollup.test.ts` (curve test sliced to 1–99, veteran test retired per R9)
- Modify: `tests/rollup-lock.test.ts` (`AG_READ_PHASE_TABLES`, `AG_SWAPPED`)
- Modify: `tests/capture-scripts.test.ts` (constants guard tokens)

**Interfaces:**
- Consumes: `claude_discipline_scores`, `claude_discipline_scores_7d` (Task 1, committed before this section runs); `sess_at` (Task 1).
- Produces: `skill_daily` / `skill_progress` / `skill_level_ups` rows with `source = 'character'`, `kind = 'attribute'`, `key ∈ {str, dex, con, int, wis, cha}`; `character_attributes` (6 rows, ord 1–6); `level_caps` (the 99 row always, plus each opened cap); `skill_pace.eta_cap_days`. Levels to 200 and tiers past Master in every `skill_*` row and in `agent_progress`.

- [ ] **Step 1: Add the fixtures.**

`tests/fixtures/make-hermes-db.sh`: copy the `veteran)` branch as `legend)`, with `t=1600000000` and `i < 7037`, and the closing message at `$((t + 1 + 7037*14400 + 7198))`. That is 101,339,999 s of driven time, past level 200 (99,900,000 s) by 1.6 stars' worth, so `ROUND` and `FLOOR` differ. Add `legend` to the scenarios comment on line 4.

`tests/fixtures/make-fixture.sh`, before `*)`:

```bash
  attr-days)
    # Stage 10 (spec 4.3-4.5), as of Wed 2026-09-30. Requests only (no tool call,
    # so verification, prompt-hygiene and reuse are needs-data): 20 at context
    # 200,000 on 09-01, and 20 at 10,000 on 09-15, half on a second model. So
    # INT's 30-day Form differs between 09-01 and 09-15 (guard 2), WIS on 09-30
    # has two needs-data constituents and one measured (guard 1), and the
    # 7-day window of 09-30 holds no request (gated: no boost, guard 5). Claude
    # has about an hour of driven time on each of the two days.
    for d in 2026-09-01 2026-09-15; do
      t0="$(epoch "${d}T10:00:00Z")"; s="AT_$d"
      sess_at "$s" "$t0"
      ev_at "$s" "$t0" SessionStart
      ev_at "$s" "$((t0 + 5))" UserPromptSubmit
      for k in $(seq 1 12); do ev_at "$s" "$((t0 + k * 300))" PostToolUse; done
      ev_at "$s" "$((t0 + 3605))" Stop
      for i in $(seq 0 19); do
        if [ "$d" = 2026-09-01 ]; then cr=200000; else cr=10000; fi
        req_at "${s}_$i" "R_$d" "$((t0 + 60 + i * 60))" /tmp/fx 90 0 10 "$cr" 0
        if [ "$d" = 2026-09-15 ] && [ "$i" -lt 10 ]; then req_meta "${s}_$i" fx-model-2 cli; fi
      done
    done
    ;;
```

- [ ] **Step 2: Write the failing tests.**

Create `tests/attributes-rollup.test.ts`. Literal values appear only in the guard tests named in the spec's §6.1 table. Everything else asserts identities.

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyWtSchema } from "@/lib/core/schema";
import { runSync } from "@/lib/core/sync";
import { createHermesAdapter } from "@/lib/adapters/hermes";
import { entryLists } from "@/lib/config";
import { DISCIPLINE_ORDER } from "@/lib/read/profile";
import { roll, seedAgents, type AgentEvent, type SeedSession } from "./helpers/agent-seed";
import { buildAndRoll, ROLLUP, rows } from "./helpers/fixture-db";
import { slow } from "./helpers/timeout";

// Stage 10 (spec 4.3-4.8, 6.1). Guards 1-11 each own one test below (R21: their
// literals live there alone); the identities assert no literal.

const ASOF = { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" };
type Attr = { attribute: string; ord: number; as_of_day: string; form_30: number | null; form_7: number | null;
  boost: number | null; base_level: number | null; now_level: number | null; evidence_json: string };
const sheet = (db: string) => rows<Attr>(db, "SELECT * FROM character_attributes ORDER BY ord;");
const attr = (db: string, a: string) => sheet(db).find((r) => r.attribute === a)!;
const train = (db: string, a: string) => rows<{ day: string; active_ms: number }>(db,
  `SELECT day, active_ms FROM skill_daily WHERE source = 'character' AND kind = 'attribute' AND key = '${a}' ORDER BY day;`);
const scores = (db: string, day: string) => rows<{ discipline: string; score: number; status: string }>(db,
  `SELECT discipline, score, status FROM claude_discipline_scores WHERE day = '${day}';`);
/** The spec's Form from stored scores: measured constituents only (spec 4.3). */
const formOf = (db: string, day: string, of: string[]): number | null => {
  const m = scores(db, day).filter((s) => of.includes(s.discipline) && s.status !== "needs-data");
  return m.length === 0 ? null : Math.round((m.reduce((a, s) => a + s.score, 0) / m.length) * 99 / 60);
};

/** One driven Codex session on `day`: `seconds` of driven time, `tout` output tokens. */
function codexDay(id: string, day: string, seconds: number, tout: number): SeedSession {
  const t0 = Date.parse(`${day}T10:00:00Z`) / 1000;
  const events: Array<[number, AgentEvent]> = [[t0, "session_start"], [t0 + 30, "prompt"]];
  for (let s = 330; s < seconds; s += 300) events.push([t0 + s, "activity"]);
  events.push([t0 + seconds, "stop"]);
  return { source: "codex", id, entry: "Codex Desktop", driven: 1, startedAt: t0, cwd: "/tmp/wt-at",
    events, requests: [{ id: `${id}-r`, ts: t0 + 60, model: "gpt-5.5", tout }] };
}
const codexMs = (db: string) => rows<{ ms: number }>(db,
  "SELECT COALESCE(SUM(active_ms), 0) AS ms FROM skill_daily WHERE source = 'codex' AND kind = 'tool';")[0].ms;
function codexDb(sessions: SeedSession[], env = ASOF): string {
  const db = buildAndRoll("resumed");
  seedAgents(db, sessions);
  roll(db, env);
  return db;
}
const MAKE_HERMES = path.join(__dirname, "fixtures", "make-hermes-db.sh");
async function hermesDb(scenario: string, env: Record<string, string> = {}): Promise<string> {
  const home = mkdtempSync(path.join(tmpdir(), "wt-at-hermes-"));
  execFileSync("bash", [MAKE_HERMES, scenario, path.join(home, ".hermes", "state.db")]);
  const db = buildAndRoll("resumed");
  applyWtSchema(db);
  await runSync({ db, adapters: [createHermesAdapter({ db, home, lists: entryLists("hermes", undefined) })] });
  roll(db, env);
  return db;
}

let ad: string; // attr-days
let legend: string; // Hermes past 200
beforeAll(async () => {
  ad = buildAndRoll("attr-days", ASOF);
  legend = await hermesDb("legend");
}, slow(120000));

describe("Stage 10: Form and training", () => {
  // Guard 1. WIS on 09-30: verification and security are needs-data, model-routing is measured.
  it("needs-data is left out of Form", () => {
    const wis = scores(ad, "2026-09-30").filter((s) => ["verification", "model-routing", "security"].includes(s.discipline));
    expect(wis.filter((s) => s.status === "needs-data").length).toBe(2);
    expect(attr(ad, "wis").form_30).toBe(formOf(ad, "2026-09-30", ["verification", "model-routing", "security"]));
    expect(attr(ad, "wis").form_30).not.toBeNull();
  });

  // Guard 2. INT trains on 09-01 and 09-15, each at its own day's Form.
  it("each day trains at that day's Form", () => {
    const of = ["context-hygiene", "cost-discipline"];
    const days = train(ad, "int");
    expect(days.map((d) => d.day)).toEqual(["2026-09-01", "2026-09-15"]);
    expect(formOf(ad, "2026-09-01", of)).not.toBe(formOf(ad, "2026-09-15", of));
    for (const d of days) {
      const ms = rows<{ ms: number }>(ad, `SELECT active_ms AS ms FROM claude_daily_rollups WHERE day = '${d.day}';`)[0].ms;
      expect(d.active_ms).toBe(Math.floor((ms * formOf(ad, d.day, of)!) / 99));
    }
  });

  // Guard 3. 59 minutes is no reading; an hour at 96,000 output tokens is 79.
  it("Strength needs an active hour", () => {
    const short = codexDb([codexDay("s", "2026-09-30", 3540, 96000)]);
    expect(codexMs(short)).toBe(3540000);
    expect([attr(short, "str").form_30, attr(short, "str").form_7]).toEqual([null, null]);
    expect(train(short, "str")).toEqual([]);
    const hour = codexDb([codexDay("h", "2026-09-30", 3600, 96000)]);
    expect(codexMs(hour)).toBe(3600000);
    expect([attr(hour, "str").form_30, attr(hour, "str").form_7]).toEqual([79, 79]);
  });

  // Review Focus 3 (R4): nothing on the as-of day itself.
  it("a quiet as-of day still has a 30-day Strength Form", () => {
    const db = codexDb([codexDay("q", "2026-09-20", 3600, 96000)]);
    expect(attr(db, "str").form_30).not.toBeNull();
  });
});

describe("Stage 10: boost and Now", () => {
  // Guard 4. 10 h with no output on 09-10, then an hour at 120,000 on 09-28:
  // 30 days read 9, the last 7 read 99, a raw boost of 18.
  it("the boost is clamped to ten", () => {
    const db = codexDb([codexDay("o", "2026-09-10", 36000, 0), codexDay("n", "2026-09-28", 3600, 120000)]);
    expect(codexMs(db)).toBe(39600000);
    const s = attr(db, "str");
    expect([s.form_30, s.form_7, s.boost]).toEqual([9, 99, 10]);
  });

  // Guard 5. attr-days' 7-day window of 09-30 is gated.
  it("no 7-day reading means no boost", () => {
    expect(rows(ad, "SELECT * FROM claude_discipline_scores_7d;")).toEqual([]);
    const con = attr(ad, "con");
    expect(con.form_30).not.toBeNull();
    expect(con.base_level).not.toBeNull();
    expect([con.form_7, con.boost, con.now_level]).toEqual([null, null, con.base_level]);
  });
});

describe("Stage 10: past 99", () => {
  // Guard 8. 101,339,999 s: 1,439,999 s past Lv 200's 99,900,000 is 1.6 stars, floored.
  it("stars start past 200", () => {
    expect(rows(legend, `SELECT level, tier, xp_to_next, s_to_next, stars FROM agent_progress WHERE source = 'hermes';`))
      .toEqual([{ level: 200, tier: "Eternal", xp_to_next: null, s_to_next: null, stars: 1 }]);
  });

  // Guard 7.
  it("tiers past Master", () => {
    const at = rows<{ level: number; tier: string; tier_changed: number }>(legend, `SELECT level, tier, tier_changed
      FROM skill_level_ups WHERE source = 'hermes' AND kind = 'tool' AND level IN (98, 99, 119, 120, 149, 150, 169, 170, 199, 200)
      ORDER BY level;`);
    expect(at.map((r) => [r.level, r.tier, r.tier_changed])).toEqual([
      [98, "Pro", 0], [99, "Master", 1], [119, "Master", 0], [120, "Grandmaster", 1], [149, "Grandmaster", 0],
      [150, "Legend", 1], [169, "Legend", 0], [170, "Mythic", 1], [199, "Mythic", 0], [200, "Eternal", 1],
    ]);
  });

  // Guard 10. Each cap opens on the day a stat first reaches the cap below; the
  // Hermes tool, project and model reach each level together, and the tool wins.
  it("a cap opens on the day a stat reaches it", () => {
    const caps = rows<{ cap: number; reached_level: number | null; opened_day: string | null; source: string | null; kind: string | null; key: string | null }>(
      legend, "SELECT * FROM level_caps ORDER BY cap;");
    expect(caps.map((c) => [c.cap, c.reached_level, c.source, c.kind, c.key])).toEqual([
      [99, null, null, null, null], [120, 99, "hermes", "tool", "hermes"], [150, 120, "hermes", "tool", "hermes"],
      [170, 150, "hermes", "tool", "hermes"], [200, 170, "hermes", "tool", "hermes"],
    ]);
    expect(caps[0].opened_day).toBeNull();
  });

  // Guard 9. The 11,699,999 s veteran (Lv 101) with pace: its 99 ETA is NULL, not negative.
  it("the 99 ETA stops at 99", async () => {
    const last = new Date((1700000000 + 11699999) * 1000).toISOString().slice(0, 10);
    const db = await hermesDb("veteran", { WATCHTOWER_ROLLUP_TODAY: last });
    const [p] = rows<{ eta_next_days: number | null; eta_99_days: number | null; eta_cap_days: number | null }>(db,
      "SELECT eta_next_days, eta_99_days, eta_cap_days FROM skill_pace WHERE source = 'hermes';");
    expect(p.eta_next_days).not.toBeNull();
    expect(p.eta_99_days).toBeNull();
    expect(p.eta_cap_days! >= p.eta_next_days!).toBe(true);
  }, slow(60000));

  // Guard 11 (R7).
  it("attributes have no pace", () => {
    for (const db of [ad, legend]) {
      const pace = rows<{ source: string; xp_28d: number }>(db, "SELECT source, xp_28d FROM skill_pace;");
      expect(pace.map((p) => p.source)).not.toContain("character");
      const tools = pace.filter((p) => p.source !== "all").reduce((a, p) => a + p.xp_28d, 0);
      expect(pace.find((p) => p.source === "all")!.xp_28d).toBe(tools);
    }
  });
});

describe("Stage 10: identities", () => {
  it("each attribute's lifetime seconds are its training rows", () => {
    for (const db of [ad, legend]) {
      const prog = rows<{ key: string; active_s: number }>(db,
        "SELECT key, active_s FROM skill_progress WHERE source = 'character' AND kind = 'attribute';");
      for (const p of prog) {
        expect(p.active_s).toBe(Math.floor(train(db, p.key).reduce((a, d) => a + d.active_ms, 0) / 1000));
      }
    }
  });

  it("no day trains more than its hours, and none trains nothing", () => {
    for (const db of [ad, legend]) {
      const bad = rows(db, `SELECT a.key, a.day FROM skill_daily a
        LEFT JOIN (SELECT day, SUM(active_ms) AS all_ms, SUM(CASE WHEN source = 'claude' THEN active_ms ELSE 0 END) AS claude_ms
                   FROM skill_daily WHERE kind = 'tool' GROUP BY day) h ON h.day = a.day
        WHERE a.source = 'character' AND a.kind = 'attribute'
          AND (a.active_ms <= 0 OR a.active_ms > CASE WHEN a.key = 'str' THEN h.all_ms ELSE h.claude_ms END);`);
      expect(bad).toEqual([]);
    }
  });

  it("Now is Base plus the boost, never below 1", () => {
    for (const db of [ad, legend]) {
      for (const a of sheet(db)) {
        expect(a.now_level).toBe(a.base_level === null ? null : Math.max(1, a.base_level + (a.boost ?? 0)));
      }
    }
  });

  it("each opened cap is dated by the first level-up at its level", () => {
    const caps = rows<{ reached_level: number; opened_day: string }>(legend,
      "SELECT reached_level, opened_day FROM level_caps WHERE opened_day IS NOT NULL;");
    expect(caps.length).toBeGreaterThan(0);
    for (const c of caps) {
      expect(c.opened_day).toBe(rows<{ d: string }>(legend,
        `SELECT MIN(day) AS d FROM skill_level_ups WHERE level = ${c.reached_level};`)[0].d);
    }
  });

  it("every discipline maps to exactly one attribute", () => {
    const keys = sheet(ad).filter((a) => a.attribute !== "str").flatMap((a) => Object.keys(JSON.parse(a.evidence_json)));
    expect([...keys].sort()).toEqual([...DISCIPLINE_ORDER].sort());
    expect(Object.keys(JSON.parse(attr(ad, "str").evidence_json)).sort()).toEqual(["per_hour_30", "per_hour_7"]);
  });

  it("always writes six attributes in order and the 99 cap", () => {
    for (const db of [ad, legend]) {
      expect(sheet(db).map((a) => [a.attribute, a.ord])).toEqual([
        ["str", 1], ["dex", 2], ["con", 3], ["int", 4], ["wis", 5], ["cha", 6],
      ]);
      expect(rows(db, "SELECT cap FROM level_caps WHERE cap = 99;")).toEqual([{ cap: 99 }]);
    }
  });

  it("an attribute with no measured Form has no XP and no level, never Lv 1", () => {
    const cha = attr(ad, "cha"); // prompt-hygiene is needs-data on every day: no tool calls
    expect([cha.form_30, cha.base_level, cha.now_level]).toEqual([null, null, null]);
    expect(train(ad, "cha")).toEqual([]);
  });
});
```

The imports match `tests/agent-rollup.test.ts`'s (`createHermesAdapter` from `@/lib/adapters/hermes`, `entryLists` from `@/lib/config`, `runSync` from `@/lib/core/sync`). If a `codexMs` precondition fails, the agent gap rule capped a gap: keep each gap at 300 s or less, or split the time into one-hour sessions. Do not loosen the assertion.

Run: `npx vitest run tests/attributes-rollup.test.ts`. Expected: FAIL (no attribute rows; `level_caps` empty; `agent_progress` level 99).

- [ ] **Step 3: Extend the curve, the tiers and stars.**

In `_ag_xp`, append to the `VALUES` list (after `(99,13034431)`, before the `;`) and update its comment:

```sql
-- OSRS: the XP needed for each level, xp(L) = floor(1/4 * sum_{l=1}^{L-1}
-- floor(l + 300 * 2^(l/7))) to 99. Stage 10 (spec 4.6): past 99 each level is
-- 250 hours, xp(99+n) = (9000000 + 900000n) * 13034431 / 9000000 (integer
-- division), so level 99+n is reached at exactly 2,500 + 250n hours, up to 200.
-- tests/agent-rollup.test.ts recomputes all 200.
```

```
,(100,14337874),(101,15641317),(102,16944760),(103,18248203),(104,19551646),(105,20855089),(106,22158532),(107,23461975),(108,24765418),(109,26068862),
(110,27372305),(111,28675748),(112,29979191),(113,31282634),(114,32586077),(115,33889520),(116,35192963),(117,36496406),(118,37799849),(119,39103293),
(120,40406736),(121,41710179),(122,43013622),(123,44317065),(124,45620508),(125,46923951),(126,48227394),(127,49530837),(128,50834280),(129,52137724),
(130,53441167),(131,54744610),(132,56048053),(133,57351496),(134,58654939),(135,59958382),(136,61261825),(137,62565268),(138,63868711),(139,65172155),
(140,66475598),(141,67779041),(142,69082484),(143,70385927),(144,71689370),(145,72992813),(146,74296256),(147,75599699),(148,76903142),(149,78206586),
(150,79510029),(151,80813472),(152,82116915),(153,83420358),(154,84723801),(155,86027244),(156,87330687),(157,88634130),(158,89937573),(159,91241017),
(160,92544460),(161,93847903),(162,95151346),(163,96454789),(164,97758232),(165,99061675),(166,100365118),(167,101668561),(168,102972004),(169,104275448),
(170,105578891),(171,106882334),(172,108185777),(173,109489220),(174,110792663),(175,112096106),(176,113399549),(177,114702992),(178,116006435),(179,117309879),
(180,118613322),(181,119916765),(182,121220208),(183,122523651),(184,123827094),(185,125130537),(186,126433980),(187,127737423),(188,129040866),(189,130344310),
(190,131647753),(191,132951196),(192,134254639),(193,135558082),(194,136861525),(195,138164968),(196,139468411),(197,140771854),(198,142075297),(199,143378741),
(200,144682184)
```

`_ag_tier`'s `CASE` becomes:

```sql
       CASE WHEN level >= 200 THEN 'Eternal'
            WHEN level >= 170 THEN 'Mythic'
            WHEN level >= 150 THEN 'Legend'
            WHEN level >= 120 THEN 'Grandmaster'
            WHEN level >= 99  THEN 'Master'
            WHEN level >= 85  THEN 'Pro'
            …the rest unchanged…
```

In `_sk_prog`, change the stars `CASE` and its comment ("Stars: one per 900,000 s (250 h) past 99,900,000 s (Lv 200), floored"):

```sql
       CASE WHEN l.level IS NULL          THEN NULL
            WHEN l.active_s >= 99900000   THEN (l.active_s - 99900000) / 900000
            ELSE                               0
       END AS stars,
```

- [ ] **Step 4: Add the attribute training (right after `_sk_daily` is created, before `_sk_life`).**

```sql
-- ============================================================================
-- Stage 10 (spec 4.3-4.4): the six attributes. _at_def maps each discipline to
-- its attribute and is the only place that mapping lives. STR has no
-- disciplines: its Form is output tokens per active hour, every tool pooled.
-- ============================================================================
DROP TABLE IF EXISTS _at_attr;
CREATE TEMP TABLE _at_attr (attribute TEXT PRIMARY KEY, ord INTEGER NOT NULL);
INSERT INTO _at_attr (attribute, ord) VALUES ('str',1),('dex',2),('con',3),('int',4),('wis',5),('cha',6);

DROP TABLE IF EXISTS _at_def;
CREATE TEMP TABLE _at_def (discipline TEXT PRIMARY KEY, attribute TEXT NOT NULL);
INSERT INTO _at_def (discipline, attribute) VALUES
  ('automation','dex'), ('reuse','dex'),
  ('session-hygiene','con'), ('output-quality','con'),
  ('context-hygiene','int'), ('cost-discipline','int'),
  ('verification','wis'), ('model-routing','wis'), ('security','wis'),
  ('prompt-hygiene','cha');

-- Each day's pooled output tokens and active ms, and Claude's own active ms
-- (R5): Claude's tokens from its daily rollup, Codex's and Hermes's from _ag_r
-- (what the swap writes to agent_daily_rollups), and every tool's hours from
-- its kind = 'tool' row in _sk_daily.
DROP TABLE IF EXISTS _at_day;
CREATE TEMP TABLE _at_day AS
SELECT day, SUM(tokens) AS tokens, SUM(all_ms) AS all_ms, SUM(claude_ms) AS claude_ms FROM (
  SELECT day, tokens_out AS tokens, 0 AS all_ms, 0 AS claude_ms FROM claude_daily_rollups
  UNION ALL SELECT day, SUM(tokens_out), 0, 0 FROM _ag_r GROUP BY day
  UNION ALL SELECT day, 0, active_ms, CASE WHEN source = 'claude' THEN active_ms ELSE 0 END
            FROM _sk_daily WHERE kind = 'tool'
) GROUP BY day;
CREATE UNIQUE INDEX idx_at_day ON _at_day(day);

-- STR's window totals (spec 4.3): '30' on every day with tokens or hours and
-- on the as-of day (R4), '7' on the as-of day only. Under one active hour, no
-- reading; otherwise the rate against 120,000 an hour (2,000 a minute), to 99.
DROP TABLE IF EXISTS _at_str;
CREATE TEMP TABLE _at_str AS
SELECT win, day, tokens, active_ms,
       CASE WHEN active_ms >= 3600000 THEN tokens * 3600000.0 / active_ms END AS rate,
       CASE WHEN active_ms >= 3600000
            THEN CAST(round(99 * MIN(1.0, tokens * 3600000.0 / active_ms / 120000.0)) AS INTEGER) END AS form
FROM (
  SELECT '30' AS win, d.day, COALESCE(SUM(x.tokens), 0) AS tokens, COALESCE(SUM(x.all_ms), 0) AS active_ms
  FROM (SELECT day FROM _at_day UNION SELECT d0 FROM _sk_d) d
  LEFT JOIN _at_day x ON x.day BETWEEN date(d.day, '-29 day') AND d.day
  GROUP BY d.day
  UNION ALL
  SELECT '7', d.d0, COALESCE(SUM(x.tokens), 0), COALESCE(SUM(x.all_ms), 0)
  FROM _sk_d d LEFT JOIN _at_day x ON x.day BETWEEN date(d.d0, '-6 day') AND d.d0
  GROUP BY d.d0
);

-- Every Form, 0-99 (spec 4.3); no row is no reading. A Claude attribute
-- averages its MEASURED disciplines' scores on the day: needs-data is left
-- out, never counted as 0, and a gated day has no rows at all.
DROP TABLE IF EXISTS _at_form;
CREATE TEMP TABLE _at_form AS
SELECT s.win, d.attribute, s.day, CAST(round(AVG(s.score) * 99.0 / 60) AS INTEGER) AS form
FROM (SELECT '30' AS win, day, discipline, score, status FROM claude_discipline_scores
      UNION ALL SELECT '7', day, discipline, score, status FROM claude_discipline_scores_7d) s
JOIN _at_def d ON d.discipline = s.discipline
WHERE s.status <> 'needs-data'
GROUP BY s.win, d.attribute, s.day
UNION ALL
SELECT win, 'str', day, form FROM _at_str WHERE form IS NOT NULL;
CREATE UNIQUE INDEX idx_at_form ON _at_form(win, attribute, day);

-- Spec 4.4: each day trains each attribute at that day's own 30-day Form, the
-- day's hours x Form / 99 (integer division). STR trains on every tool's
-- hours, the rest on Claude's. No Form, or nothing earned, is no row, so from
-- here Stage 6's keyed pipeline levels attributes like any other skill.
-- _ag_life, _sk_win, _sk_runs and _sk_pace read only kind = 'tool', and _ac_*
-- names its kinds, so none of this reaches agent_progress, pace, streaks,
-- achievements or the Total level.
INSERT INTO _sk_daily (source, kind, key, day, active_ms)
SELECT 'character', 'attribute', attribute, day, ms FROM (
  SELECT f.attribute, f.day,
         CASE WHEN f.attribute = 'str' THEN d.all_ms ELSE d.claude_ms END * f.form / 99 AS ms
  FROM _at_form f JOIN _at_day d ON d.day = f.day
  WHERE f.win = '30'
) WHERE ms > 0
ORDER BY attribute, day;
```

`_sk_d` is created later in the file (`DROP TABLE IF EXISTS _sk_d; CREATE TEMP TABLE _sk_d AS …`). **Move that `_sk_d` block up** to just before this Stage 10 block. It reads only `_sk_asof`, so its position is free.

- [ ] **Step 5: Level caps, and pace to the cap.**

After `_sk_ups`, before `_sk_win`:

```sql
-- Spec 4.7: the level caps. Each next cap opens on the first day any stat of
-- any kind reaches the cap below it; ties on a day go to a tool, then by
-- source, kind and key. 99 is always open. A stat at 120 has passed 99, so the
-- caps open in order. A cap is a milestone and a display ceiling: no level is
-- ever held at one.
DROP TABLE IF EXISTS _lc_def;
CREATE TEMP TABLE _lc_def (cap INTEGER PRIMARY KEY, next INTEGER NOT NULL);
INSERT INTO _lc_def (cap, next) VALUES (99,120), (120,150), (150,170), (170,200);

DROP TABLE IF EXISTS _lc;
CREATE TEMP TABLE _lc AS
SELECT cap, reached_level, opened_day, source, kind, key FROM (
  SELECT 99 AS cap, NULL AS reached_level, NULL AS opened_day, NULL AS source, NULL AS kind, NULL AS key
  UNION ALL
  SELECT d.next, u.level, u.day, u.source, u.kind, u.key
  FROM _lc_def d
  JOIN (SELECT level, day, source, kind, key,
               ROW_NUMBER() OVER (PARTITION BY level
                                  ORDER BY day, CASE WHEN kind = 'tool' THEN 0 ELSE 1 END, source, kind, key) AS rn
        FROM _sk_ups WHERE level IN (SELECT cap FROM _lc_def)) u
    ON u.level = d.cap AND u.rn = 1
) ORDER BY cap;
```

In `_sk_pace`, replace the `eta_99_days` expression and add `eta_cap_days` after it:

```sql
       -- Spec 4.6: the 99 ETA keeps its meaning, NULL at 99 and past it (it
       -- would turn negative there); xp_to_next is NULL only at 200 now.
       CASE WHEN w.source = 'all' OR w.xp_28d = 0 OR p.xp_to_next IS NULL OR p.xp >= 13034431 THEN NULL
            ELSE ((13034431 - p.xp) * 28 + w.xp_28d - 1) / w.xp_28d END AS eta_99_days,
       -- Spec 4.8: days to xp(current cap) at the same pace, rounded up alike.
       CASE WHEN w.source = 'all' OR w.xp_28d = 0 OR p.xp_to_next IS NULL OR p.xp >= c.xp THEN NULL
            ELSE ((c.xp - p.xp) * 28 + w.xp_28d - 1) / w.xp_28d END AS eta_cap_days,
```

and add `LEFT JOIN _ag_xp c ON c.level = (SELECT MAX(cap) FROM _lc)` after `LEFT JOIN _sk_prog p …`. Update the comment above `_sk_pace` ("NULL with no pace, at 200 and with no level"). Add `eta_cap_days` to the swap's `skill_pace` column list and its `SELECT`, after `eta_99_days`.

- [ ] **Step 6: The character sheet (after `_sk_pace`, before the achievements block).**

```sql
-- Spec 4.5: the sheet, as of the as-of day. The boost is this week against the
-- month, a level per 5 Form points (round halves away from zero), clamped to
-- ten; with either Form unmeasured there is no boost, never a drain. Now is
-- Base plus the boost, floored at 1, and may pass the cap. Evidence: each
-- constituent's 30-day score on the day (null when needs-data or gated) --
-- the page matches quests through these keys -- or STR's two rates.
DROP TABLE IF EXISTS _at_sheet;
CREATE TEMP TABLE _at_sheet AS
SELECT attribute, ord, as_of_day, form_30, form_7, boost, base_level,
       CASE WHEN base_level IS NOT NULL THEN MAX(1, base_level + COALESCE(boost, 0)) END AS now_level,
       evidence_json
FROM (
  SELECT a.attribute, a.ord, d.d0 AS as_of_day, f30.form AS form_30, f7.form AS form_7,
         CASE WHEN f30.form IS NOT NULL AND f7.form IS NOT NULL
              THEN MIN(10, MAX(-10, CAST(round((f7.form - f30.form) / 5.0) AS INTEGER))) END AS boost,
         p.level AS base_level,
         CASE WHEN a.attribute = 'str'
              THEN json_object(
                     'per_hour_30', (SELECT CAST(round(rate) AS INTEGER) FROM _at_str WHERE win = '30' AND day = d.d0),
                     'per_hour_7',  (SELECT CAST(round(rate) AS INTEGER) FROM _at_str WHERE win = '7'  AND day = d.d0))
              ELSE (SELECT json_group_object(x.discipline, CASE WHEN s.status <> 'needs-data' THEN s.score END)
                    FROM _at_def x
                    LEFT JOIN claude_discipline_scores s ON s.day = d.d0 AND s.discipline = x.discipline
                    WHERE x.attribute = a.attribute)
         END AS evidence_json
  FROM _at_attr a
  CROSS JOIN _sk_d d
  LEFT JOIN _at_form f30 ON f30.win = '30' AND f30.attribute = a.attribute AND f30.day = d.d0
  LEFT JOIN _at_form f7  ON f7.win  = '7'  AND f7.attribute  = a.attribute AND f7.day  = d.d0
  LEFT JOIN _sk_prog p   ON p.source = 'character' AND p.kind = 'attribute' AND p.key = a.attribute
)
ORDER BY ord;
```

Append to the swap, after `character_points`:

```sql
DELETE FROM character_attributes;
INSERT INTO character_attributes (attribute, ord, as_of_day, form_30, form_7, boost, base_level, now_level, evidence_json)
SELECT attribute, ord, as_of_day, form_30, form_7, boost, base_level, now_level, evidence_json FROM _at_sheet ORDER BY rowid;
DELETE FROM level_caps;
INSERT INTO level_caps (cap, reached_level, opened_day, source, kind, key)
SELECT cap, reached_level, opened_day, source, kind, key FROM _lc ORDER BY rowid;
```

- [ ] **Step 7: Update the pinned tests.**

`tests/rollup-lock.test.ts`: add `"_at_attr", "_at_def", "_at_day", "_at_str", "_at_form", "_lc_def", "_lc", "_at_sheet"` to `AG_READ_PHASE_TABLES`. Append `["character_attributes", "_at_sheet"], ["level_caps", "_lc"]` to `AG_SWAPPED`.

`tests/agent-rollup.test.ts`:
- "XP thresholds equal the OSRS formula": compare `pairs.slice(0, 99)` with `expected` (1–99), keeping the four literals.
- After it, add guard 6:

```ts
  // GUARD 6 (Stage 10, spec 4.6). Past 99 each level is 250 hours: level 99+n
  // at exactly 9,000,000 + 900,000n seconds, through 200.
  it("past 99 each level is 250 hours", () => {
    const src = readFileSync(ROLLUP, "utf8");
    const list = src.slice(src.indexOf("INSERT INTO _ag_xp (level, xp) VALUES"));
    const pairs = [...list.slice(0, list.indexOf(";")).matchAll(/\((\d+),(\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const past = pairs.slice(99);
    expect(past.map(([L]) => L)).toEqual(Array.from({ length: 101 }, (_, i) => 100 + i));
    const k = 13034431n, d = 9000000n;
    for (const [L, xp] of past) {
      const s = 9000000n + 900000n * BigInt(L - 99);
      expect([L, (s * k) / d]).toEqual([L, BigInt(xp)]);
      expect([L, ((s - 1n) * k) / d < BigInt(xp)]).toEqual([L, true]);
    }
  });
```

- Delete "a veteran past 99 earns floor stars" (R9). Its job moved to guard 8 in `tests/attributes-rollup.test.ts`.
- Update the comment on "every tool levels by the OSRS formula" ("the only lifetime literals besides the legend").

`tests/capture-scripts.test.ts` constants guard: add `"120000", "120_000", "Grandmaster", "Legend", "Mythic", "Eternal"` to `tokens`, add `"120000"` and `"Grandmaster"` to the rollup-side list, and extend the comment ("Stage 10: STR's full marks and the tiers past Master").

- [ ] **Step 8: Run, then plant every guard.**

Run: `npx vitest run tests/attributes-rollup.test.ts tests/agent-rollup.test.ts tests/rollup-lock.test.ts tests/capture-scripts.test.ts tests/skill-rollup.test.ts tests/skill-xp-rollup.test.ts tests/achievements-rollup.test.ts tests/quests-rollup.test.ts tests/read-character.test.ts`. Expected: PASS.

Then plant each defect and run `npx vitest run tests/attributes-rollup.test.ts tests/agent-rollup.test.ts`. Each must turn exactly one test red; record it in the ledger, then restore:

| # | Plant | Red |
|---|---|---|
| 1 | `_at_form`: drop `WHERE s.status <> 'needs-data'` | needs-data is left out of Form |
| 2 | training: join `_at_form f` on the as-of day's Form (`f.day = (SELECT d0 FROM _sk_d)`, and `_at_day d ON d.day` from a second alias) | each day trains at that day's Form |
| 3 | `_at_str`: `>= 3600000` → `>= 0` (both) | Strength needs an active hour |
| 4 | `_at_sheet`: drop the `MIN(10, MAX(-10, …))` | the boost is clamped to ten |
| 5 | `_at_sheet`: `f7.form` → `COALESCE(f7.form, 0)` in the boost (both places) | no 7-day reading means no boost |
| 6 | `_ag_xp`: replace (101,15641317) with (101,14337874) | past 99 each level is 250 hours |
| 7 | `_ag_tier`: `>= 120` → `>= 121` | tiers past Master |
| 8 | `_sk_prog` stars: `99900000` → `9000000` (both) | stars start past 200 |
| 9 | `_sk_pace`: drop `OR p.xp >= 13034431` | the 99 ETA stops at 99 |
| 10 | `_lc`: `ON u.level = d.cap` → `ON u.level = d.cap - 1` and `level IN (SELECT cap - 1 FROM _lc_def)` | a cap opens on the day a stat reaches it |
| 11 | R7's `_sk_win` plant | attributes have no pace |

If a plant reds two tests, move the literal so that it lives in one (R21), and record the move.

- [ ] **Step 9: Whole suite, typecheck, commit.**

Run: `npm test -- --exclude '.claude/**'` (alone; no other suite running) and `npm run typecheck`. Expected: all pass. Fix any test whose literal moved only because levels now pass 99 (none is expected outside the files above). Record such a fix in the ledger with its reason.

```bash
git add capture/rollup.sh tests/fixtures/make-fixture.sh tests/fixtures/make-hermes-db.sh tests/attributes-rollup.test.ts tests/agent-rollup.test.ts tests/rollup-lock.test.ts tests/capture-scripts.test.ts
git commit -m "feat(rollup): character attributes, levels to 200 and level caps"
```

---

### Task 3: The page — Attributes card, "/cap", Max Cape, the level-up log

**Model:** sonnet (the shapes and strings are fixed here; no judgment calls left).

**Files:**
- Modify: `lib/read/level.ts` (`Level.cap`, `readLevelCaps`, `maxCape`)
- Create: `lib/read/attributes.ts`
- Modify: `lib/read/character.ts` (cap, cap raises, attributes, attribute labels, `etaCapDays`)
- Modify: `lib/read/overview.ts` (`maxCape` with the cap)
- Modify: `lib/render/level.ts` ("/cap", "past 200")
- Create: `lib/render/attributes.ts`
- Modify: `lib/render/character.ts` (the card, the hero cap, tiles, pace kv, the log)
- Modify: `lib/render/overview.ts` (Max Cape text)
- Modify: `lib/render/profile.ts` (export `disciplineLabel`)
- Modify: `lib/render/empty.ts` (new strings)
- Modify: `lib/render/layout.ts` (CSS `.boost`, `.drain`)
- Tests: `tests/read-level.test.ts`, `tests/read-character.test.ts`, `tests/render-level.test.ts`, `tests/render-character.test.ts`, `tests/render-overview.test.ts`, `tests/read-overview.test.ts`; create `tests/render-attributes.test.ts`, `tests/read-attributes.test.ts`

**Interfaces:**
- Consumes: `character_attributes`, `level_caps`, `skill_progress` (source `character`), `skill_level_ups`, `skill_pace.eta_cap_days`, `claude_quests` (Tasks 1–2).
- Produces:

```ts
// lib/read/level.ts
export interface Level { /* …existing… */ cap?: number | null }   // the current cap; absent/null before v11
export interface CapRaise { cap: number; reachedLevel: number; day: string; source: string; kind: string; key: string }
export interface LevelCaps { current: number; first: number; raises: CapRaise[] }  // raises: newest first
export function readLevelCaps(db: string): LevelCaps | null;   // null: no table, or no rows yet
export function maxCape(states: readonly LevelState[], at: number | null): { at: number; reached: number; of: number } | null;

// lib/read/attributes.ts
export type AttributeId = "str" | "dex" | "con" | "int" | "wis" | "cha";
export const ATTRIBUTE_NAMES: Record<AttributeId, { abbr: string; name: string }>;
export interface Attribute {
  id: AttributeId; ord: number;
  form30: number | null; form7: number | null; boost: number | null;
  base: number | null; now: number | null;
  /** skill_progress (source 'character'); null with no XP. */
  level: Level | null;
  /** Claude attributes: discipline -> 30-day score (null = no reading). STR: per_hour_30, per_hour_7. */
  evidence: Record<string, number | null>;
}
export interface AttributesData {
  /** No character_attributes table, or no rows yet: before the first v11 rollup. */
  pending: boolean;
  asOfDay: string | null;
  attributes: Attribute[];   // ord order
  /** The lowest measured 30-day Form (ties by ord); null when none is measured. */
  lowest: { id: AttributeId; quests: Array<{ discipline: string; name: string }> } | null;
}
export function readAttributes(db: string, cap: number | null): AttributesData;

// lib/read/character.ts
export type SkillKind = "tool" | "project" | "model" | "skill" | "pack" | "skill-use" | "attribute";
// Pace gains: etaCapDays: number | null; dateCap: string | null   (asOfDay + etaCapDays)
// CharacterData gains: cap: number | null; capRaises: CapRaise[]; attributes: AttributesData

// lib/render/attributes.ts
export function attributesCard(a: AttributesData, cap: number | null, served: boolean): string;

// lib/render/profile.ts
export function disciplineLabel(id: string): string;   // DISCIPLINE_META[id]?.label ?? id
```

- [ ] **Step 1: Readers — failing tests first.**

`tests/read-level.test.ts`: replace the `maxCape` test with:

```ts
  it("maxCape counts tools at or past the first cap, and is pending without one", () => {
    expect(maxCape([L(99), L(120), L(5), { state: "none", activeS: 0 }], 99)).toEqual({ at: 99, reached: 2, of: 4 });
    expect(maxCape([L(99)], null)).toBeNull();
  });
  it("readLevelCaps is null before the v11 rollup and reads the stored caps after it", () => {
    const db = buildAndRoll("resumed");
    expect(readLevelCaps(db)).toEqual({ current: 99, first: 99, raises: [] });
    execFileSync("sqlite3", [db, "INSERT INTO level_caps VALUES (120, 99, '2026-09-30', 'claude', 'tool', 'claude');"]);
    expect(readLevelCaps(db)).toEqual({ current: 120, first: 99,
      raises: [{ cap: 120, reachedLevel: 99, day: "2026-09-30", source: "claude", kind: "tool", key: "claude" }] });
    execFileSync("sqlite3", [db, "DELETE FROM level_caps;"]);
    expect(readLevelCaps(db)).toBeNull();
    execFileSync("sqlite3", [db, "DROP TABLE level_caps;"]);
    expect(readLevelCaps(db)).toBeNull();
    expect(readLevels(db).claude.state).not.toBe("pending"); // agent_progress still reads
  });
```

(`L(n)` is the file's existing level-state helper. Import `execFileSync` and `buildAndRoll` if absent.)

Create `tests/read-attributes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readAttributes } from "@/lib/read/attributes";
import { buildAndRoll } from "./helpers/fixture-db";

describe("readAttributes", () => {
  it("reads six attributes in order with their stored values", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    const a = readAttributes(db, 99);
    expect(a.pending).toBe(false);
    expect(a.attributes.map((x) => x.id)).toEqual(["str", "dex", "con", "int", "wis", "cha"]);
    const cha = a.attributes[5];
    expect([cha.form30, cha.base, cha.now, cha.level]).toEqual([null, null, null, null]);
    expect(a.attributes[2].level!.cap).toBe(99);
  });
  it("follows a stored Form, never computing one", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    execFileSync("sqlite3", [db, "UPDATE character_attributes SET form_30 = 42, form_7 = 7, boost = -7 WHERE attribute = 'con';"]);
    const con = readAttributes(db, 99).attributes[2];
    expect([con.form30, con.form7, con.boost]).toEqual([42, 7, -7]);
  });
  it("empty v11 tables read as pending", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    execFileSync("sqlite3", [db, "DELETE FROM character_attributes;"]);
    expect(readAttributes(db, 99)).toEqual({ pending: true, asOfDay: null, attributes: [], lowest: null });
    execFileSync("sqlite3", [db, "DROP TABLE character_attributes;"]);
    expect(readAttributes(db, null).pending).toBe(true);
  });
  it("the lowest-Form footer names this week's quests from the attribute's own sources", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    execFileSync("sqlite3", [db, `UPDATE character_attributes SET form_30 = 1 WHERE attribute = 'int';
      DELETE FROM claude_quests;
      INSERT INTO claude_quests (week, week_end, slot, discipline, score, direction, baseline, target, hold, value, requests, status)
      VALUES ('2026-09-28', '2026-10-04', 1, 'cost-discipline', 0, 'at-most', 40, 30, 0, NULL, 0, 'open'),
             ('2026-09-28', '2026-10-04', 2, 'verification', 0, 'at-least', 0.1, 0.2, 0, NULL, 0, 'open'),
             ('2026-09-21', '2026-09-27', 1, 'context-hygiene', 0, 'at-most', 1, 1, 0, NULL, 0, 'missed');`]);
    expect(readAttributes(db, 99).lowest).toEqual({ id: "int", quests: [{ discipline: "cost-discipline", name: "Lean cache" }] });
  });
});
```

`tests/read-character.test.ts`: add

```ts
  it("labels attribute level-ups by name and reads the cap, its raises and the attributes", () => {
    const db = buildAndRoll("attr-days", { WATCHTOWER_ROLLUP_TODAY: "2026-09-30" });
    const c = readCharacter(db, { now: NOW, home: home() });
    expect(c.cap).toBe(99);
    expect(c.capRaises).toEqual([]);
    expect(c.attributes.pending).toBe(false);
    const ups = c.levelUps.filter((u) => u.kind === "attribute");
    expect(ups.length).toBeGreaterThan(0);
    expect(new Set(ups.map((u) => u.label))).toEqual(new Set(ups.map((u) =>
      ({ str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" })[u.key])));
    for (const t of c.tools) for (const s of [...t.projects, ...t.models]) expect(s.level.source).not.toBe("character");
  });
```

Run: `npx vitest run tests/read-level.test.ts tests/read-attributes.test.ts tests/read-character.test.ts`. Expected: FAIL (missing exports).

- [ ] **Step 2: Implement the readers.**

`lib/read/level.ts`:

```ts
export interface Level {
  // …existing fields…
  /** Stage 10: the current level cap from level_caps; absent or null before the v11 rollup. */
  cap?: number | null;
}

/** Stage 10: a cap the rollup opened, and the stat that opened it. */
export interface CapRaise { cap: number; reachedLevel: number; day: string; source: string; kind: string; key: string }
export interface LevelCaps {
  /** MAX(cap): what "Lv X/cap" shows. */
  current: number;
  /** MIN(cap): Max Cape's threshold (spec 4.7). */
  first: number;
  /** Newest first. */
  raises: CapRaise[];
}

/** Null before the first v11 rollup: no level_caps table, or no rows in it yet. */
export function readLevelCaps(db: string): LevelCaps | null {
  if (!hasTable(db, "level_caps")) return null;
  const [m] = read<{ current: number | null; first: number | null }>(db,
    "SELECT MAX(cap) AS current, MIN(cap) AS first FROM level_caps;");
  if (m.current === null || m.first === null) return null;
  const raises = read<{ cap: number; reached_level: number; opened_day: string; source: string; kind: string; key: string }>(db,
    `SELECT cap, reached_level, opened_day, source, kind, key FROM level_caps
     WHERE opened_day IS NOT NULL ORDER BY opened_day DESC, cap DESC;`)
    .map((r) => ({ cap: r.cap, reachedLevel: r.reached_level, day: r.opened_day, source: r.source, kind: r.kind, key: r.key }));
  return { current: m.current, first: m.first, raises };
}
```

In `readLevels`, read the caps once and set `cap: caps?.current ?? null` on every `level` state (pass it into `toState`). Replace `maxCape`:

```ts
/**
 * Max Cape over the detected tools (spec §5): how many have reached the first
 * cap, MIN(cap) from level_caps, of how many. Null before the v11 rollup,
 * which the page shows as pending. No level number lives here.
 */
export function maxCape(states: readonly LevelState[], at: number | null): { at: number; reached: number; of: number } | null {
  if (at === null) return null;
  return { at, reached: states.filter((s) => s.state === "level" && s.level.level >= at).length, of: states.length };
}
```

`lib/read/overview.ts`: `maxCape: { at: number; reached: number; of: number } | null;` and `maxCape: maxCape(detected, readLevelCaps(db)?.first ?? null)`.

`lib/read/attributes.ts`: implement exactly the interface above. In `readAttributes(db, cap)`:
- Return pending when `hasTable(db, "character_attributes")` is false or the table has no rows.
- `SELECT attribute, ord, as_of_day, form_30, form_7, boost, base_level, now_level, evidence_json FROM character_attributes ORDER BY ord`.
- Read levels with `SELECT … FROM skill_progress WHERE source = 'character' AND kind = 'attribute'`, mapped to `Level` like `toSkill` (`source` cast, plus `cap`).
- `evidence` is `JSON.parse(evidence_json)`.
- `lowest`: among attributes with `form30 !== null`, the minimum `form30`, ties by `ord` (a sort, which is labelling). For it, the quests are `SELECT discipline FROM claude_quests WHERE week = (SELECT MAX(week) FROM claude_quests) ORDER BY slot`, keeping those whose discipline is a key of the attribute's `evidence`. Each is named by `QUESTS[discipline].name` from `lib/read/quests.ts`. With no `claude_quests` table, or for STR, the list is empty.
- Header comment: Stage 10, spec §5. It reads `character_attributes`, `skill_progress` and `claude_quests`, and computes nothing. Every Form, boost and level is stored.

`lib/read/character.ts`:
- `SkillKind` gains `"attribute"`. `labelOf`: `kind === "attribute" ? ATTRIBUTE_NAMES[key as AttributeId]?.name ?? key : …`.
- `readCharacter`: `const caps = readLevelCaps(db);`. Pass `caps?.current ?? null` into `toSkill` as `cap`. The `prog` query adds `AND source <> 'character'` (attributes are read by `readAttributes`). Return `cap: caps?.current ?? null`, `capRaises: caps?.raises ?? []` and `attributes: readAttributes(db, caps?.current ?? null)`. The pending early return gets `cap: null, capRaises: [], attributes: { pending: true, asOfDay: null, attributes: [], lowest: null }`.
- `PaceRow` gains `eta_cap_days?: number | null`. `toPace` sets `etaCapDays: r.eta_cap_days ?? null` and `dateCap` (from `addDays`, like `date99`).
- The level-up label: `u.kind === "tool" ? AGENT_LABEL[…] : labelOf(u.kind, u.key)` already routes attributes through `labelOf`.

Run the Step 1 tests. Expected: PASS.

- [ ] **Step 3: Renderers — failing tests first.**

Create `tests/render-attributes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Attribute, AttributesData } from "@/lib/read/attributes";
import type { Level } from "@/lib/read/level";
import { attributesCard } from "@/lib/render/attributes";

const lv = (level: number): Level => ({ source: "claude", activeS: 1, xp: 1, level, tier: "Advanced",
  xpIntoLevel: 1, xpToNext: 1, sToNext: 1, stars: 0, cap: 99 });
const at = (over: Partial<Attribute> = {}): Attribute => ({ id: "int", ord: 4, form30: 58, form7: 63, boost: 1,
  base: 77, now: 78, level: lv(77), evidence: { "context-hygiene": 60, "cost-discipline": 0 }, ...over });
const data = (attributes: Attribute[], over: Partial<AttributesData> = {}): AttributesData =>
  ({ pending: false, asOfDay: "2026-09-30", attributes, lowest: null, ...over });

describe("attributesCard", () => {
  it("titles the card with the cap and draws Now/Base with a green boost", () => {
    const h = attributesCard(data([at()]), 99, true);
    expect(h).toContain("Attributes · level cap 99");
    expect(h).toContain("INT Intelligence");
    expect(h).toContain(`78<span class="muted">/77</span> <span class="boost">▲1</span>`);
  });
  it("draws a drain in red, and Base alone with no boost", () => {
    expect(attributesCard(data([at({ boost: -3, now: 66, base: 69 })]), 99, true)).toContain(`66<span class="muted">/69</span> <span class="drain">▼3</span>`);
    for (const boost of [0, null]) {
      const h = attributesCard(data([at({ boost, now: 77 })]), 99, true);
      expect(h).not.toContain("▲");
      expect(h).not.toContain("▼");
      expect(h).toContain(`<div class="big lv">77</div>`);
    }
  });
  // Guard 13.
  it("an unmeasured form reads no reading", () => {
    const h = attributesCard(data([at({ form7: null, boost: null })]), 99, true);
    expect(h).toContain("form no reading · 58 (7d · 30d)");
  });
  it("a measured zero form reads 0", () => {
    expect(attributesCard(data([at({ form7: 0, form30: 0, boost: 0, now: 77 })]), 99, true)).toContain("form 0 · 0 (7d · 30d)");
  });
  it("a drained tile never reads below 1", () => {
    expect(attributesCard(data([at({ base: 3, now: 1, boost: -10 })]), 99, true)).toContain(`1<span class="muted">/3</span>`);
  });
  it("an attribute with no XP says so, never Lv 1", () => {
    const h = attributesCard(data([at({ base: null, now: null, level: null, form30: null, form7: null, boost: null })]), 99, true);
    expect(h).toContain("No attribute XP yet.");
    expect(h).not.toContain("Lv 1");
  });
  it("links sources to /profile when served, with their 30-day scores, and STR says what it measures", () => {
    const h = attributesCard(data([at(), at({ id: "str", ord: 1, evidence: { per_hour_30: 85000, per_hour_7: 92000 } })]), 99, true);
    expect(h).toContain(`<a href="/profile">Context hygiene</a> 60`);
    expect(h).toContain(`<a href="/profile">Cost discipline</a> 0`);
    expect(h).toContain("output per active hour, every tool · 85,000");
    expect(attributesCard(data([at()]), 99, false)).not.toContain(`href="/profile"`);
  });
  it("is pending before the v11 rollup", () => {
    const h = attributesCard(data([], { pending: true, asOfDay: null }), null, true);
    expect(h).toContain("Attributes are pending until the v11 rollup");
  });
  it("names the lowest-Form attribute and this week's matching quests", () => {
    const h = attributesCard(data([at()], { lowest: { id: "int", quests: [{ discipline: "cost-discipline", name: "Lean cache" }] } }), 99, true);
    expect(h).toContain("Lowest form: Intelligence");
    expect(h).toContain(`<a href="/quests">Lean cache</a>`);
  });
});
```

In `tests/render-character.test.ts`:
- `lv()` gains `cap: 99`. `data()` gains `cap: 99, capRaises: [], attributes: { pending: true, asOfDay: null, attributes: [], lowest: null }`. `pace()` and `idle()` gain `etaCapDays` and `dateCap` (same values as `eta99Days` / `date99`).
- The "Lv 57/99" test stays, because cap 99 is in the fixture. Add `expect(html(data({ tools: [tool({ state: { state: "level", level: lv({ cap: 120 }) } })] }))).toContain(`Lv 57<span class="muted">/120</span>`);`.
- "at 99 shows stars and no ETA" becomes "at 200 shows stars past 200 and no ETA": level 200, `xpToNext: null`, stars 2, and assert `aria-label="2 stars past 200"`.
- Add:

```ts
  // Guard 12 (R8).
  it("an attribute level-up is labelled by its name", () => {
    const h = html(data({ levelUps: [up(0, { source: "character" as never, kind: "attribute", key: "str", label: "Strength", level: 78 })] }));
    expect(h).toContain(">Strength<");
    expect(h).not.toContain("undefined");
  });
  // Guard 14.
  it("the log shows a cap raise", () => {
    const h = html(data({ cap: 120, capRaises: [{ cap: 120, reachedLevel: 99, day: "2026-09-30", source: "claude", kind: "tool", key: "claude" }] }));
    expect(h).toContain("Level cap raised to 120 · Claude Code reached Lv 99");
  });
  it("shows the cap on the hero card and the pace to it", () => {
    const h = html(data({ cap: 120, tools: [tool({ pace: pace({ etaCapDays: 40, dateCap: "2026-11-09" }) })] }));
    expect(h).toContain("level cap");
    expect(h).toContain("Lv 120");
    expect(h).toContain("by 2026-11-09");
  });
```

`LevelUp.source` is typed `AgentSource`. Widen it to `AgentSource | "character"` in `lib/read/character.ts` and drop the `as never`.

`tests/render-level.test.ts`: "2 stars past 99" becomes "2 stars past 200". Add a test that `levelBlock` shows `Lv 57<span class="muted">/120</span>` with `cap: 120` and plain `Lv 57` with no cap.

`tests/render-overview.test.ts`: `maxCape: { at: 99, reached: 1, of: 3 }`, expect "1 of 3 tools at 99+". Add a case with `maxCape: null` that expects "pending". `tests/read-overview.test.ts`: `expect(d.maxCape!.of).toBe(3)`.

Run: `npx vitest run tests/render-attributes.test.ts tests/render-character.test.ts tests/render-level.test.ts tests/render-overview.test.ts tests/read-overview.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement the renderers.**

`lib/render/empty.ts`:

```ts
/** Stage 10. */
export const ATTRIBUTES_PENDING = "Attributes are pending until the v11 rollup";
export const NO_ATTRIBUTE_XP = "No attribute XP yet.";
export const STR_SOURCE = "output per active hour, every tool";
```

`lib/render/layout.ts` CSS, beside `.pending`: `.boost { color: var(--ok); } .drain { color: var(--over); }`.

`lib/render/profile.ts`: `export const disciplineLabel = (id: string): string => DISCIPLINE_META[id as DisciplineId]?.label ?? id;`

`lib/render/level.ts`:
- The stars `aria-label`: "past 99" → "past 200".
- `levelBlock` shows the cap: `` `<div class="big lv">Lv ${l.level}${l.cap == null ? "" : `<span class="muted">/${l.cap}</span>`}</div>` ``.

`lib/render/attributes.ts`:

```ts
/**
 * The Attributes card (Stage 10, spec §5): six tiles, Now over Base with the
 * stored boost, the tier and XP meter, both Forms and their sources. It labels
 * what character_attributes, skill_progress and claude_quests store; it
 * computes no Form, boost or level. NULL reads "no reading", never 0.
 */
import { ATTRIBUTE_NAMES, type Attribute, type AttributesData } from "../read/attributes.ts";
import { ATTRIBUTES_PENDING, NO_ATTRIBUTE_XP, NO_READING, STR_SOURCE } from "./empty.ts";
import { esc, grouped } from "./html.ts";
import { card } from "./layout.ts";
import { meter } from "./level.ts";
import { disciplineLabel } from "./profile.ts";

const reading = (n: number | null) => (n === null ? NO_READING : String(n));
const link = (href: string, text: string, served: boolean) =>
  served ? `<a href="${href}">${esc(text)}</a>` : esc(text);

function nowBase(a: Attribute): string {
  if (a.now === null || a.base === null) return `<div class="state absent">${esc(NO_ATTRIBUTE_XP)}</div>`;
  if (a.boost === null || a.boost === 0) return `<div class="big lv">${a.base}</div>`;
  const arrow = a.boost > 0 ? `<span class="boost">▲${a.boost}</span>` : `<span class="drain">▼${-a.boost}</span>`;
  return `<div class="big lv">${a.now}<span class="muted">/${a.base}</span> ${arrow}</div>`;
}

function sources(a: Attribute, served: boolean): string {
  if (a.id === "str") {
    const r = a.evidence.per_hour_30;
    return `${esc(STR_SOURCE)} · ${r == null ? esc(NO_READING) : grouped(r)}`;
  }
  return Object.entries(a.evidence)
    .map(([d, s]) => `${link("/profile", disciplineLabel(d), served)} ${s === null ? esc(NO_READING) : s}`)
    .join(" · ");
}

function tile(a: Attribute, served: boolean): string {
  const n = ATTRIBUTE_NAMES[a.id];
  const lvl = a.level === null ? "" : `<div class="muted label">${esc(a.level.tier)}</div>${meter(a.level)}`;
  return `<div class="c tile"><h2>${esc(`${n.abbr} ${n.name}`)}</h2>${nowBase(a)}${lvl}` +
    `<div class="muted block">form ${esc(reading(a.form7))} · ${esc(reading(a.form30))} (7d · 30d)</div>` +
    `<div class="muted">${sources(a, served)}</div></div>`;
}

export function attributesCard(d: AttributesData, cap: number | null, served: boolean): string {
  const title = cap === null ? "Attributes" : `Attributes · level cap ${cap}`;
  if (d.pending) return card({ title, wide: true, body: `<div class="state absent">${esc(ATTRIBUTES_PENDING)}</div>` });
  const foot = d.lowest === null ? "" : `<p class="note">Lowest form: ${esc(ATTRIBUTE_NAMES[d.lowest.id].name)}` +
    (d.lowest.quests.length === 0 ? "" : ` · this week: ${d.lowest.quests.map((q) => link("/quests", q.name, served)).join(", ")}`) +
    `</p>`;
  return card({ title, wide: true, body: `<div class="g g-tiles">${d.attributes.map((a) => tile(a, served)).join("")}</div>${foot}` });
}
```

`lib/render/character.ts`:
- `tileOf`: the "/99" becomes `` `/${l.cap ?? 99}` ``. If `l.cap` is null (pre-v11), show no "/cap" at all, as `levelBlock` does: `${l.cap == null ? "" : `<span class="muted">/${l.cap}</span>`}`. The stars `aria-label` reads "past 200".
- `characterCard`: after the total, add `d.cap === null ? "" : kv("level cap", `<b>${d.cap}</b>`)` to `facts`, even when `d.all` is null.
- `paceBlock(p, cap)`: replace the `date99` kv with `cap !== null && p.dateCap !== null ? kv(`Lv ${cap}`, `<b>by ${esc(p.dateCap)}</b>${atPace}`) : p.date99 === null ? "" : kv("99", `<b>by ${esc(p.date99)}</b>${atPace}`)`. Pass `d.cap` from `toolSection` (thread `cap` through its signature).
- `pathOf`: add `u.kind === "attribute" ? u.label :` as the second branch (guard 12's plant removes exactly this).
- `levelUpsCard`: merge `d.capRaises` into the rows by date, newest first, a cap raise before level-ups on the same day. The served list is bounded at `LEVEL_UP_CAP` rows and the report at `REPORT_LEVEL_UPS`. The count note uses `d.levelUpCount + d.capRaises.length`. A cap-raise row's skill cell is `` `Level cap raised to ${r.cap} · ${pathOf(asUp(r))} reached Lv ${r.reachedLevel}` ``, where `asUp` builds a `LevelUp` from the raise. Its label for an attribute is `ATTRIBUTE_NAMES[key].name`, for a tool `AGENT_LABEL[source]`, else `labelOf(kind, key)`; reuse `labelOf`, exporting it from `lib/read/character.ts`. Its level and tier cells are empty.
- `characterView`: `characterCard(d) + attributesCard(d.attributes, d.cap, served) + skillsCard(d) + …`. Footer: add `character_attributes and level_caps` to the "from …" list.

`lib/render/overview.ts`: `kv("Max Cape", d.maxCape === null ? `<b class="absent">pending</b>` : `<b>${d.maxCape.reached} of ${d.maxCape.of} tools at ${d.maxCape.at}+</b>`)`.

Run the Step 3 tests. Expected: PASS.

- [ ] **Step 5: Plant guards 12–14.**

| # | Plant | Red |
|---|---|---|
| 12 | `pathOf`: delete the `attribute` branch | an attribute level-up is labelled by its name |
| 13 | `reading`: `n === null ? NO_READING` → `String(n ?? 0)` | an unmeasured form reads no reading |
| 14 | `levelUpsCard`: drop the cap-raise merge | the log shows a cap raise |

Each must red exactly one test. Record them in the ledger, then restore.

- [ ] **Step 6: The report and the whole suite.**

Run: `npx vitest run tests/report-budget.test.ts` (character `PER_WEEK_LIMIT` stays 50, since the card is fixed-size), then `npm test -- --exclude '.claude/**'` and `npm run typecheck`. Expected: all pass. A report test that pins the character page's markup reads it through `tests/helpers/marks.ts`. If one fails only because the card was added, update its expectation and record why.

- [ ] **Step 7: Commit.**

```bash
git add lib tests
git commit -m "feat(character): the Attributes card, level caps and Max Cape at the first cap"
```

---

### Task 4: Live proof, docs and the 0.9.0 release files

**Owner:** the controller (no subagent: it reads the live DB through backups and writes `SESSION.md`).

**Files:**
- Modify: `CLAUDE.md` (schema 11; the three tables; attribute rows in `skill_*`; levels to 200 and tiers past Master; test count)
- Modify: `docs/releases.md` (a 0.9.0 history row), create `docs/release-notes/0.9.0.md`, `package.json` `version` → `0.9.0`
- Modify: `SESSION.md` (local only, never committed)
- Ledger: `.superpowers/sdd/2026-10-13-stage-10-character-attributes/progress.md`

- [ ] **Step 1: Live proof (spec §6.2).** Make two directories, `main/` and `branch/`, each holding a `sqlite3 .backup` copy of the live DB. Run `git show main:capture/rollup.sh` / `lib.sh` over `main/` and the branch's scripts over `branch/`, both with the same `WATCHTOWER_ROLLUP_TODAY` and `TZ`. Then:
  1. On every Stage 8 proof table, `EXCEPT` both ways under `-bail`, `updated_at` aside: `skill_*` with `WHERE kind <> 'attribute'`, and `skill_pace` on its v10 columns. Every count must be `0|0`.
  2. Run the §6.1 identities' SQL on `branch/`: 0 mismatches.
  3. By hand: one attribute's 30-day Form on one day; STR's 30-day rate; one day's training ms; each discipline's 7-day score beside its 30-day score on the as-of day.
  4. `node tests/fixtures/theone-level-proof.mjs` and `node tests/fixtures/theone-watch-proof.mjs --all` on `branch/`.
  5. Time the rollup on both copies, median of 3, with under 1 s added. Generate the report from `branch/`: under 2,000,000 bytes, the card present, no `NaN`, no fabricated 0.
- [ ] **Step 2: Record in `SESSION.md`:** the six attributes (Form 30/7, boost, Base, Now, tier), the `level_caps` rows, and the rollup times.
- [ ] **Step 3: Docs and the release files.** Update `CLAUDE.md`'s architecture notes (Stage 10, schema v11 bullet, `CC_SCHEMA_VERSION` **11**) and the test count from the final `npm test` run. Add the 0.9.0 release notes and history row in the format of 0.8.0. Bump `package.json`. Run `npx vitest run tests/release-tooling.test.ts`. Expected: PASS.
- [ ] **Step 4: Final checks and commit.** Run `npm test -- --exclude '.claude/**'`, `npm run typecheck`, `npm run lint` (if `main` carries PR #27), `node script/check-privacy.ts --tree`. Then:

```bash
git add CLAUDE.md docs package.json .superpowers/sdd/2026-10-13-stage-10-character-attributes
git commit -m "docs: Stage 10 — attributes, level caps, schema v11; release 0.9.0"
```

Then a whole-branch review on the most capable model, at most one fix wave, and the PR. The user merges it and pushes the tag (`!` commands).
