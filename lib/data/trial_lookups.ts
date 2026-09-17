/** NCBI records for the genetic targets named by clinical trials. */

import geneInfoJson from "../../data/gene_info_table2.json" with {
  type: "json",
};

import { indexBy } from "../collections.ts";
import type { GeneInfo } from "../types.ts";
import { normalizeGeneInfo, normalizeRows } from "./normalize.ts";

export function normalizeTrialGeneInfoRows(value: unknown): GeneInfo[] {
  return normalizeRows(value, normalizeGeneInfo);
}

export function indexTrialGeneInfoByName(
  value: unknown,
): ReadonlyMap<string, GeneInfo> {
  return indexBy(normalizeTrialGeneInfoRows(value), (row) => row.name);
}

export const table2GeneInfoByName = indexTrialGeneInfoByName(geneInfoJson);
