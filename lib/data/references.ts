import refsJson from "../../data/refs.json" with { type: "json" };

import { indexBy } from "../collections.ts";
import type { Reference } from "../types.ts";
import { normalizeReference, normalizeRows } from "./normalize.ts";

export function normalizeReferences(value: unknown): Reference[] {
  return normalizeRows(value, normalizeReference);
}

export function indexReferencesByPmid(
  value: unknown,
): ReadonlyMap<string, Reference> {
  return indexBy(normalizeReferences(value), (row) => row.pmid);
}

/**
 * Every reference, by PMID.
 *
 * This held `pmid -> formattedRef` while that string was all the export
 * published. It carries the whole row now, because the Genes table composes a
 * citation from the discrete fields rather than parsing the fragment.
 */
export const referenceByPmid = indexReferencesByPmid(refsJson);
