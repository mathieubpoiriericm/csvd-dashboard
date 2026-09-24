/** The imaging or clinical standard the vocabulary's definitions are quoted from. */

import type { CitationStandard } from "../types.ts";
import { manifest } from "./manifest.ts";

export const CITATION_STANDARD: CitationStandard | null =
  manifest.citationStandard;

/**
 * The tooltip link for a trait whose definition comes from the standard.
 *
 * The manifest holds the DOI alone, but one copied as its own address or
 * cited with "doi:" in front is written by hand often enough: either would
 * link to https://doi.org/https://doi.org/…, so the prefix comes off here too.
 */
export function citationLink(
  standard: CitationStandard | null = CITATION_STANDARD,
): { href: string; label: string } | undefined {
  if (standard === null) return undefined;
  const doi = standard.doi.trim()
    .replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)\s*/i, "");
  return {
    href: `https://doi.org/${doi}`,
    label: standard.linkLabel,
  };
}

/** Row label for a definition, e.g. "STRIVE-2 definition". */
export function definitionLabel(
  standard: CitationStandard | null = CITATION_STANDARD,
): string {
  return standard === null ? "Definition" : `${standard.name} definition`;
}
