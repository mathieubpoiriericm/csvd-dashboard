/**
 * Synthetic rows for tests that need *a* gene, trial or facility rather than
 * a committed one.
 *
 * `{ ...genes[0], gene: "X" }` was the idiom before, and it throws the moment
 * `data/table1.json` is `[]` -- which is where a repository generated for
 * another disease starts (`deno task data:empty`). Every default here is a
 * member of the vocabulary the filters and the two figures read, so a sample
 * row behaves like a committed one: the phase is a `PHASE_CHOICES` token, the
 * sponsor a `SPONSOR_CHOICES` one, the status a `TRIAL_STATUSES` key, and the
 * band one the hg38 table carries. Nothing here names a disease.
 */

import type { TimelineEncoding } from "../../lib/timeline.ts";
import type { Gene, Trial, TrialLocation } from "../../lib/types.ts";
import { NONE, NONE_FOUND, UNKNOWN } from "../../lib/sentinels.ts";

/** A gene row with every field valid and no disease content. */
export function sampleGene(overrides: Partial<Gene> = {}): Gene {
  return {
    gene: "GENE1",
    protein: "Protein one",
    chromosomalLocation: "1p36.33",
    gwasTrait: [NONE_FOUND],
    mendelianRandomization: "No",
    evidenceFromOtherOmicsStudies: [NONE_FOUND],
    linkToMonogenicDisease: [NONE_FOUND],
    brainCellTypes: UNKNOWN,
    affectedPathway: UNKNOWN,
    references: ["10000001"],
    sourceQuote: "GENE1 was associated with the phenotype (p = 1e-9).",
    confidence: 0.9,
    ...overrides,
  };
}

/** A trial row every filter choice and both radar renderers accept. */
export function sampleTrial(overrides: Partial<Trial> = {}): Trial {
  return {
    drug: "Drug A",
    mechanismOfAction: "Mechanism A",
    geneticTarget: NONE,
    geneticEvidence: "No",
    trialName: "Trial A",
    registryId: "NCT00000001",
    clinicalTrialPhase: "II",
    targetPopulation: "Population A",
    targetPopulationDetails: UNKNOWN,
    targetSampleSize: "100",
    estimatedCompletionDate: "1/2030",
    primaryOutcome: UNKNOWN,
    sponsorType: "Academic",
    overallStatus: "RECRUITING",
    ...overrides,
  };
}

/**
 * A mechanism the radar's record flag leaves alone: the encoding's first
 * outside its `uncharacterised` family, which a disease may list first.
 * When every mechanism is filed there it is `sampleTrial`'s own, which the
 * encoding does not list -- drawn in the fallback colour, and not flagged
 * either. `_mechanism` in tests/scripts/test_timeline_figure.py is its twin.
 */
export function characterisedMechanism(
  enc: Pick<TimelineEncoding, "mechanisms" | "families">,
): string {
  const flagged = enc.families.find((f) => f.key === "uncharacterised")
    ?.mechanisms ?? [];
  return Object.keys(enc.mechanisms).find((m) => !flagged.includes(m)) ??
    sampleTrial().mechanismOfAction;
}

/**
 * A value in the other case, ASCII letters only: what the filters'
 * `trim().toLowerCase()` comparison is defined to ignore. `toUpperCase()`
 * is not that -- it turns the micro sign into a capital mu, which lowers to
 * the Greek letter, and "ß" into "SS" -- so a trait keyed with either came
 * back as a different key.
 */
export function swapAsciiCase(value: string): string {
  return value.replace(
    /[A-Za-z]/g,
    (c) => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
  );
}

/** A geocoded facility the map can place. */
export function sampleLocation(
  overrides: Partial<TrialLocation> = {},
): TrialLocation {
  return {
    nctId: "NCT00000001",
    facilityName: "Facility A",
    city: "City A",
    state: null,
    country: "Country A",
    trialTitle: "Trial A",
    status: "RECRUITING",
    lat: 48.85,
    lon: 2.35,
    ...overrides,
  };
}
