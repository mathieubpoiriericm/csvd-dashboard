/**
 * The gold-only switch.
 *
 * While it is on, the dashboard publishes only the hand-curated tables, and the
 * pages say so: the About page dates the data from the curated release rather
 * than from a pipeline run, shows `GOLD_ONLY_NOTICE` where the run report
 * would be, the Genes table drops the extraction-provenance columns, which
 * only a pipeline extraction fills, and the trait filter and the phenogram's
 * key list only the traits a curated gene carries. `pipeline.main` reads this
 * same line (`pipeline/gold_only.py`) and refuses `--pubmed` and
 * `--clinical-trials` while it is `true`.
 *
 * ## Undoing it
 *
 * 1. Set `GOLD_ONLY` below to `false`.
 * 2. Restore the database from `~/csvd-backups/pre-gold-2026-11-07.dump`
 *    (schema 015, paired with commit 06df770) with `pg_restore --clean`, as
 *    the `regenerate-data` skill restores a dump, then
 *    `cd pipeline && uv run alembic upgrade head`. The migrations since are
 *    additive.
 * 3. `deno task data`, then `deno task geocode`.
 * 4. Restore the four `csvd/` test trees from 06df770
 *    (`git checkout 06df770 -- tests/csvd e2e/tests/csvd tests/pipeline/csvd
 *    tests/scripts/csvd`) and re-pin what the lasting changes below move.
 *
 * These changes outlast the switch, and the undo keeps them:
 *
 * - the export publishes a protein as stored; it no longer rewrites a protein
 *   equal to its gene symbol to "(unknown)";
 * - the gold traits stay in `disease/vocabulary.json`, with their filter
 *   choices and phenogram pills;
 * - `disease/timeline.json` keeps the gold mechanism spellings as extra keys
 *   beside the earlier ones;
 * - the export no longer lowercases the affected pathway.
 */

/** Whether the dashboard shows only the hand-curated data. */
export const GOLD_ONLY = true;

/** The day the hand-curated release was committed, as an ISO date. */
export const GOLD_DATA_DATE = "2026-11-06";

/** The notice that stands where the pipeline run report would be. */
export const GOLD_ONLY_NOTICE =
  "Pending further review, only the hand-curated data is fed to the dashboard.";
