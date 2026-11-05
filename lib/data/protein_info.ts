import proteinInfoJson from "../../data/protein_info.json" with {
  type: "json",
};

import { groupBy } from "../collections.ts";
import type { ProteinInfo } from "../types.ts";
import { normalizeProteinInfo, normalizeRows } from "./normalize.ts";

export function normalizeProteinInfoRows(value: unknown): ProteinInfo[] {
  return normalizeRows(value, normalizeProteinInfo);
}

/** Every UniProt row under its curated key; see `indexGeneInfoByName`. */
export function indexProteinInfoByGene(
  value: unknown,
): ReadonlyMap<string, readonly ProteinInfo[]> {
  return groupBy(normalizeProteinInfoRows(value), (row) => row.gene);
}

export const proteinInfoByGene = indexProteinInfoByGene(proteinInfoJson);
