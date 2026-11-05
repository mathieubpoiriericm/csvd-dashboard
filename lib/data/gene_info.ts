import geneInfoJson from "../../data/gene_info.json" with { type: "json" };

import { groupBy } from "../collections.ts";
import type { GeneInfo } from "../types.ts";
import { normalizeGeneInfo, normalizeRows } from "./normalize.ts";

export function normalizeGeneInfoRows(value: unknown): GeneInfo[] {
  return normalizeRows(value, normalizeGeneInfo);
}

/**
 * Every lookup row under its curated key: one for most genes, one per member
 * gene for an alias key.
 */
export function indexGeneInfoByName(
  value: unknown,
): ReadonlyMap<string, readonly GeneInfo[]> {
  return groupBy(normalizeGeneInfoRows(value), (row) => row.name);
}

export const geneInfoByName = indexGeneInfoByName(geneInfoJson);
