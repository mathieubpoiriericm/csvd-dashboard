/**
 * The previews on offer, from the committed data. Server code: it reads the
 * run report and the review round, so a browser island must not import it.
 * It imports nothing from `@std` either, because the e2e fixtures load it
 * under a plain `deno run`.
 */

import { GOLD_ONLY } from "./gold_only.ts";
import { pipelineRun } from "./data/pipeline_run.ts";
import { REVIEW } from "./review/current.ts";
import { previewFeatures } from "./previews.ts";
import type { PreviewFeature } from "./previews.ts";
import type { PipelineRun } from "./types.ts";

/** The window a run searched, in days, when there is a run and it says. */
export function runDaysBack(
  run: Pick<PipelineRun, "config"> | null,
): number | null {
  return run?.config.daysBack ?? null;
}

/**
 * The features a dataset offers. The run is a preview only while gold-only
 * holds: with it off, the About page shows the report as the run of record.
 * Apart from the constants below so that every branch is tested whichever
 * the committed data holds.
 */
export function offeredPreviews(
  goldOnly: boolean,
  run: Pick<PipelineRun, "config"> | null,
  review: unknown,
): PreviewFeature[] {
  return previewFeatures(
    { pipeline: goldOnly && run !== null, review: review !== null },
    runDaysBack(run),
  );
}

export const PREVIEW_RUN_DAYS_BACK: number | null = runDaysBack(pipelineRun);

export const PREVIEWS: readonly PreviewFeature[] = offeredPreviews(
  GOLD_ONLY,
  pipelineRun,
  REVIEW,
);
