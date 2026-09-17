import geneInfoJson from "../../data/gene_info.json" with { type: "json" };

import { indexBy } from "../collections.ts";
import type { GeneInfo } from "../types.ts";
import { normalizeGeneInfo, normalizeRows } from "./normalize.ts";

export function normalizeGeneInfoRows(value: unknown): GeneInfo[] {
  return normalizeRows(value, normalizeGeneInfo);
}

export function indexGeneInfoByName(
  value: unknown,
): ReadonlyMap<string, GeneInfo> {
  return indexBy(normalizeGeneInfoRows(value), (row) => row.name);
}

export const geneInfoByName = indexGeneInfoByName(geneInfoJson);
