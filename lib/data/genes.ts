/** Putative-causal-gene table and its runtime normalization boundary. */

import tableJson from "../../data/table1.json" with { type: "json" };

import type { Gene } from "../types.ts";
import {
  NONE_FOUND,
  NOT_YET_EXTRACTED,
  REFERENCE_NEEDED,
  UNKNOWN,
} from "../sentinels.ts";
import {
  list,
  numberInRange,
  record,
  text,
  textList,
  textWithout,
} from "./normalize.ts";

/**
 * Keep the UI usable if an older or partially generated file violates the
 * string-only boundary. Raw-data contract tests still catch generator drift.
 */
export function normalizeGene(row: unknown): Gene {
  const source = record(row);
  return {
    gene: text(source.gene, UNKNOWN),
    protein: text(source.protein, UNKNOWN),
    chromosomalLocation: text(source.chromosomalLocation, UNKNOWN),
    gwasTrait: textList(source.gwasTrait, NONE_FOUND),
    mendelianRandomization: text(
      source.mendelianRandomization,
      UNKNOWN,
    ),
    evidenceFromOtherOmicsStudies: textList(
      source.evidenceFromOtherOmicsStudies,
      NONE_FOUND,
    ),
    linkToMonogenicDisease: textList(
      source.linkToMonogenicDisease,
      NONE_FOUND,
    ),
    brainCellTypes: textWithout(
      source.brainCellTypes,
      UNKNOWN,
      /^(?:NA|N\/A)$/i,
    ),
    affectedPathway: textWithout(
      source.affectedPathway,
      UNKNOWN,
      /^(?:NA|N\/A)$/i,
    ),
    references: textList(source.references, REFERENCE_NEEDED),
    sourceQuote: text(source.sourceQuote, NOT_YET_EXTRACTED),
    confidence: numberInRange(source.confidence, 0, 1),
  };
}

export function normalizeGenes(value: unknown): Gene[] {
  return list(value).map(normalizeGene);
}

export const genes = normalizeGenes(tableJson);
