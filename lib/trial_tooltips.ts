/** Tooltip content used only by the clinical-trials table. */

import { table2GeneInfoByName } from "./data/trial_lookups.ts";
import { geneInfoTooltip, type TooltipContent } from "./tooltip_content.ts";
import { registryLink } from "./trials.ts";

/** NCBI summary for a trial's genetic target. */
export function trialGeneTooltip(geneSymbol: string): TooltipContent | null {
  return geneInfoTooltip(table2GeneInfoByName.get(geneSymbol));
}

/** Registry link for a trial ID, or null for an unrecognised registry. */
export function registryTooltip(registryId: string): TooltipContent | null {
  const registry = registryLink(registryId);
  if (!registry) return null;

  return {
    rows: [{ label: "Registry", value: registry.registryLabel }],
    link: { href: registry.href, label: registry.actionLabel },
  };
}
