import proteinInfoJson from "../../data/protein_info.json" with {
  type: "json",
};

import { indexBy } from "../collections.ts";
import type { ProteinInfo } from "../types.ts";
import { normalizeProteinInfo, normalizeRows } from "./normalize.ts";

export function normalizeProteinInfoRows(value: unknown): ProteinInfo[] {
  return normalizeRows(value, normalizeProteinInfo);
}

export function indexProteinInfoByGene(
  value: unknown,
): ReadonlyMap<string, ProteinInfo> {
  return indexBy(normalizeProteinInfoRows(value), (row) => row.gene);
}

export const proteinInfoByGene = indexProteinInfoByGene(proteinInfoJson);
