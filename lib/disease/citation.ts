/** The imaging or clinical standard the vocabulary's definitions are quoted from. */

import type { CitationStandard } from "../types.ts";
import { manifest } from "./manifest.ts";

export const CITATION_STANDARD: CitationStandard | null =
  manifest.citationStandard;

/** The tooltip link for a trait whose definition comes from the standard. */
export function citationLink(
  standard: CitationStandard | null = CITATION_STANDARD,
): { href: string; label: string } | undefined {
  if (standard === null) return undefined;
  return {
    href: `https://doi.org/${standard.doi}`,
    label: standard.linkLabel,
  };
}

/** Row label for a definition, e.g. "STRIVE-2 definition". */
export function definitionLabel(
  standard: CitationStandard | null = CITATION_STANDARD,
): string {
  return standard === null ? "Definition" : `${standard.name} definition`;
}
