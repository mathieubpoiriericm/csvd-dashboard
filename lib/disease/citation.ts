/** The imaging or clinical standard the vocabulary's definitions are quoted from. */

import type { CitationStandard } from "../types.ts";
import { manifest } from "./manifest.ts";

export const CITATION_STANDARD: CitationStandard | null =
  manifest.citationStandard;

/** The tooltip link for a trait whose definition comes from the standard. */
export function citationLink(): { href: string; label: string } | undefined {
  if (CITATION_STANDARD === null) return undefined;
  return {
    href: `https://doi.org/${CITATION_STANDARD.doi}`,
    label: CITATION_STANDARD.linkLabel,
  };
}

/** Row label for a definition, e.g. "STRIVE-2 definition". */
export function definitionLabel(): string {
  return CITATION_STANDARD === null
    ? "Definition"
    : `${CITATION_STANDARD.name} definition`;
}
