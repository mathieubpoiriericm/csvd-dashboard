/** Headline counts shown on the About page. */

import { uniqueCount } from "../collections.ts";
import type { Gene, Trial } from "../types.ts";
import { genes } from "./genes.ts";
import { trials } from "./trials.ts";

export interface Summary {
  geneCount: number;
  drugCount: number;
  trialCount: number;
  /** Distinct numeric PMIDs, excluding display sentinels. */
  publicationCount: number;
}

/**
 * The four totals over any gene and trial tables. Pure, so the rule is
 * testable on synthetic rows; the module-level constants below are the same
 * function over the committed data.
 */
export function summarize(
  geneRows: readonly Gene[],
  trialRows: readonly Trial[],
): Summary {
  return {
    geneCount: uniqueCount(geneRows.map((gene) => gene.gene)),
    drugCount: uniqueCount(trialRows.map((trial) => trial.drug)),
    trialCount: uniqueCount(trialRows.map((trial) => trial.registryId)),
    publicationCount: uniqueCount(
      geneRows.flatMap((gene) => gene.references).filter((reference) =>
        /^[1-9]\d*$/.test(reference)
      ),
    ),
  };
}

export const { geneCount, drugCount, trialCount, publicationCount } = summarize(
  genes,
  trials,
);
