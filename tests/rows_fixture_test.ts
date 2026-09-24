/**
 * The synthetic rows behave like committed ones: they pass the data
 * boundary unchanged and answer every filter vocabulary.
 */
import { assert, assertEquals } from "@std/assert";

import {
  PHASE_CHOICES,
  SPONSOR_CHOICES,
  STATUS_CHOICES,
} from "../lib/constants.ts";
import {
  normalizeGene,
  normalizeTrial,
  normalizeTrialLocation,
} from "../lib/data.ts";
import { placeGene } from "../lib/cytobands.ts";
import { sampleGene, sampleLocation, sampleTrial } from "./fixtures/rows.ts";

Deno.test("the sample rows survive the data boundary unchanged", () => {
  assertEquals(normalizeGene(sampleGene()), sampleGene());
  assertEquals(normalizeTrial(sampleTrial()), sampleTrial());
  assertEquals(normalizeTrialLocation(sampleLocation()), sampleLocation());
});

Deno.test("the sample trial answers the filter vocabularies", () => {
  const trial = sampleTrial();
  const values = (choices: typeof PHASE_CHOICES) => choices.map((c) => c.value);
  assert(values(PHASE_CHOICES).includes(trial.clinicalTrialPhase));
  assert(values(SPONSOR_CHOICES).includes(trial.sponsorType));
  assert(values(STATUS_CHOICES).includes(trial.overallStatus));
});

Deno.test("the sample gene sits on a band the hg38 table carries", () => {
  assert(placeGene(sampleGene().chromosomalLocation) !== null);
});

Deno.test("overrides win", () => {
  assertEquals(sampleGene({ gene: "X" }).gene, "X");
  assertEquals(sampleTrial({ drug: "Y" }).drug, "Y");
  assertEquals(sampleLocation({ country: "Z" }).country, "Z");
});
