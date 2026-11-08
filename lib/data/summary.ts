/** Headline counts shown on the About page. */

import { isDoi } from "../citations.ts";
import { uniqueCount } from "../collections.ts";
import type { Gene, Trial } from "../types.ts";
import { genes } from "./genes.ts";
import { trials } from "./trials.ts";

export interface Summary {
  geneCount: number;
  drugCount: number;
  trialCount: number;
  /** Distinct publications cited: numeric PMIDs and DOIs, never a sentinel. */
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
    // A DOI is how the curators cite a paper they give no PMID for; it is a
    // publication all the same, and the Genes table links it.
    publicationCount: uniqueCount(
      geneRows.flatMap((gene) => gene.references)
        .map((reference) => reference.trim())
        .filter((reference) =>
          /^[1-9]\d*$/.test(reference) || isDoi(reference)
        ),
    ),
  };
}

export const { geneCount, drugCount, trialCount, publicationCount } = summarize(
  genes,
  trials,
);
