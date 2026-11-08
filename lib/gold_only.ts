/**
 * The gold-only switch.
 *
 * While it is on, the dashboard publishes only the hand-curated tables, and the
 * pages say so: the About page dates the data from the curated release rather
 * than from a pipeline run, shows `GOLD_ONLY_NOTICE` where the run report
 * would be, and the Genes table drops the extraction-provenance columns, which
 * only a pipeline extraction fills.
 */

/** Whether the dashboard shows only the hand-curated data. */
export const GOLD_ONLY = true;

/** The day the hand-curated release was committed, as an ISO date. */
export const GOLD_DATA_DATE = "2026-11-06";

/** The notice that stands where the pipeline run report would be. */
export const GOLD_ONLY_NOTICE =
  "Pending further review, only the hand-curated data is fed to the dashboard.";
