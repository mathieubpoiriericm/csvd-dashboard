/** Headline counts shown on the About page. */

import { uniqueCount } from "../collections.ts";
import { genes } from "./genes.ts";
import { trials } from "./trials.ts";

export const geneCount = uniqueCount(genes.map((gene) => gene.gene));
export const drugCount = uniqueCount(trials.map((trial) => trial.drug));
export const trialCount = uniqueCount(trials.map((trial) => trial.registryId));

/** Distinct numeric PMIDs, excluding display sentinels. */
export const publicationCount = uniqueCount(
  genes.flatMap((gene) => gene.references).filter((reference) =>
    /^[1-9]\d*$/.test(reference)
  ),
);
