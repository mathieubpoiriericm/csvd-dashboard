/** Clinical-trial table and its runtime normalization boundary. */

import tableJson from "../../data/table2.json" with { type: "json" };

import type { Trial } from "../types.ts";
import { NONE, UNKNOWN } from "../sentinels.ts";
import { list, record, text, textWithout } from "./normalize.ts";

export function normalizeTrial(row: unknown): Trial {
  const source = record(row);
  return {
    drug: text(source.drug, UNKNOWN),
    mechanismOfAction: text(source.mechanismOfAction, UNKNOWN),
    geneticTarget: textWithout(
      source.geneticTarget,
      NONE,
      /^(?:NA|N\/A|-)$/i,
    ),
    geneticEvidence: text(source.geneticEvidence, UNKNOWN),
    trialName: text(source.trialName, UNKNOWN),
    registryId: text(source.registryId, UNKNOWN),
    clinicalTrialPhase: text(source.clinicalTrialPhase, UNKNOWN),
    svdPopulation: text(source.svdPopulation, UNKNOWN),
    svdPopulationDetails: text(source.svdPopulationDetails, UNKNOWN),
    targetSampleSize: text(source.targetSampleSize, UNKNOWN),
    estimatedCompletionDate: text(
      source.estimatedCompletionDate,
      UNKNOWN,
    ),
    primaryOutcome: text(source.primaryOutcome, UNKNOWN),
    sponsorType: text(source.sponsorType, UNKNOWN),
    overallStatus: text(source.overallStatus, UNKNOWN),
  };
}

export function normalizeTrials(value: unknown): Trial[] {
  return list(value).map(normalizeTrial);
}

export const trials = normalizeTrials(tableJson);
