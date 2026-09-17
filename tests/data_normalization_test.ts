import { assertEquals } from "@std/assert";

import {
  normalizeGene,
  normalizeGenes,
  normalizePipelineStatus,
  normalizeTrial,
  normalizeTrialLocation,
  normalizeTrialLocations,
  normalizeTrials,
} from "../lib/data.ts";
import type { Gene, Trial } from "../lib/types.ts";

Deno.test("normalizeGene trims text, preserves lists, and replaces invalid values", () => {
  const raw = {
    gene: "  COL4A1  ",
    protein: 42,
    chromosomalLocation: " ",
    gwasTrait: [" WMH ", null, ""],
    mendelianRandomization: null,
    evidenceFromOtherOmicsStudies: " TWAS; brain ",
    linkToMonogenicDisease: [],
    brainCellTypes: " NA ",
    affectedPathway: "n/a",
    references: [" 12345 ", undefined],
    sourceQuote: undefined,
    confidence: 1.5,
  } as unknown as Partial<Gene>;

  assertEquals(normalizeGene(raw), {
    gene: "COL4A1",
    protein: "(unknown)",
    chromosomalLocation: "(unknown)",
    gwasTrait: ["WMH"],
    mendelianRandomization: "(unknown)",
    evidenceFromOtherOmicsStudies: ["TWAS; brain"],
    linkToMonogenicDisease: ["(none found)"],
    brainCellTypes: "(unknown)",
    affectedPathway: "(unknown)",
    references: ["12345"],
    sourceQuote: "(not yet extracted)",
    confidence: null,
  });
});

Deno.test("normalizeGene keeps a real quote and a bounded confidence score", () => {
  const raw = {
    gene: "NOTCH3",
    sourceQuote: " NOTCH3 variants were associated with WMH (p=1e-12). ",
    confidence: 0.87,
  } as unknown as Partial<Gene>;

  const normalized = normalizeGene(raw);
  assertEquals(
    normalized.sourceQuote,
    "NOTCH3 variants were associated with WMH (p=1e-12).",
  );
  assertEquals(normalized.confidence, 0.87);
});

Deno.test("gene normalization accepts malformed rows and top-level values", () => {
  assertEquals(normalizeGene(null), normalizeGene({}));
  assertEquals(normalizeGenes({ gene: "NOTCH3" }), []);
  assertEquals(normalizeGenes([null]), [normalizeGene({})]);
});

Deno.test("normalizeTrial enforces the complete string-only boundary", () => {
  const raw = {
    drug: "  Aspirin ",
    mechanismOfAction: " ",
    geneticTarget: " - ",
    geneticEvidence: 1,
    trialName: null,
    registryId: undefined,
    clinicalTrialPhase: " III ",
    svdPopulation: " SVD ",
    svdPopulationDetails: " Details ",
    targetSampleSize: " 1,200 ",
    estimatedCompletionDate: " 5/2030 ",
    primaryOutcome: " Outcome ",
    sponsorType: " Academic ",
    overallStatus: " RECRUITING ",
  } as unknown as Partial<Trial>;

  assertEquals(normalizeTrial(raw), {
    drug: "Aspirin",
    mechanismOfAction: "(unknown)",
    geneticTarget: "(none)",
    geneticEvidence: "(unknown)",
    trialName: "(unknown)",
    registryId: "(unknown)",
    clinicalTrialPhase: "III",
    svdPopulation: "SVD",
    svdPopulationDetails: "Details",
    targetSampleSize: "1,200",
    estimatedCompletionDate: "5/2030",
    primaryOutcome: "Outcome",
    sponsorType: "Academic",
    overallStatus: "RECRUITING",
  });
});

Deno.test("trial normalization accepts malformed rows and top-level values", () => {
  assertEquals(normalizeTrial(null), normalizeTrial({}));
  assertEquals(normalizeTrials({ drug: "Cilostazol" }), []);
  assertEquals(normalizeTrials([null]), [normalizeTrial({})]);
});

Deno.test("normalizeTrialLocation rejects malformed identities and coordinates", () => {
  assertEquals(normalizeTrialLocation(null), null);
  assertEquals(normalizeTrialLocation("not an object"), null);
  assertEquals(normalizeTrialLocation({ nctId: "", lat: 1, lon: 2 }), null);
  assertEquals(
    normalizeTrialLocation({ nctId: "NCT1", lat: "1", lon: 2 }),
    null,
  );
  assertEquals(
    normalizeTrialLocation({ nctId: "NCT1", lat: -91, lon: 2 }),
    null,
  );
  assertEquals(
    normalizeTrialLocation({ nctId: "NCT1", lat: 1, lon: Infinity }),
    null,
  );
  assertEquals(
    normalizeTrialLocation({ nctId: "NCT1", lat: 1, lon: 181 }),
    null,
  );
});

Deno.test("normalizeTrialLocation keeps bounded coordinates and nullable text", () => {
  assertEquals(
    normalizeTrialLocation({
      nctId: " NCT00000001 ",
      facilityName: " Hospital ",
      city: " ",
      state: 7,
      country: " France ",
      trialTitle: null,
      status: " RECRUITING ",
      lat: -90,
      lon: 180,
    }),
    {
      nctId: "NCT00000001",
      facilityName: "Hospital",
      city: null,
      state: null,
      country: "France",
      trialTitle: null,
      status: "RECRUITING",
      lat: -90,
      lon: 180,
    },
  );
});

Deno.test("normalizeTrialLocation omits only the reviewed Amsterdam state defect", () => {
  const amsterdam = {
    nctId: "NCT06814730",
    facilityName: "Amsterdam UMC",
    city: "Amsterdam",
    state: "New Hampshire",
    country: "Netherlands",
    lat: 52.37403,
    lon: 4.88669,
  };
  assertEquals(normalizeTrialLocation(amsterdam)?.state, null);

  // A different facility in the same trial keeps its legitimate province,
  // and even the suspicious value is preserved outside the reviewed row.
  assertEquals(
    normalizeTrialLocation({
      ...amsterdam,
      facilityName: "CTC-Netherlands",
      city: "Groningen",
      state: "Provincie Groningen",
    })?.state,
    "Provincie Groningen",
  );
  assertEquals(
    normalizeTrialLocation({ ...amsterdam, nctId: "NCT00000001" })?.state,
    "New Hampshire",
  );
});

Deno.test("normalizeTrialLocations filters bad rows and rejects non-arrays", () => {
  const valid = { nctId: "NCT00000001", lat: 45, lon: -73 };
  assertEquals(normalizeTrialLocations(undefined), []);
  assertEquals(normalizeTrialLocations([null, valid, { ...valid, lat: NaN }]), [
    {
      nctId: "NCT00000001",
      facilityName: null,
      city: null,
      state: null,
      country: null,
      trialTitle: null,
      status: null,
      lat: 45,
      lon: -73,
    },
  ]);
});

Deno.test("normalizePipelineStatus accepts only complete nonnegative counts", () => {
  assertEquals(normalizePipelineStatus(null), null);
  assertEquals(normalizePipelineStatus("status"), null);
  assertEquals(normalizePipelineStatus([]), null);
  assertEquals(normalizePipelineStatus([{}]), null);
  assertEquals(normalizePipelineStatus({}), null);
  assertEquals(
    normalizePipelineStatus({
      runTimestamp: {},
      papersProcessed: [],
      fulltextRetrieved: {},
      genesExtracted: [],
      genesValidated: {},
    }),
    null,
  );
  assertEquals(
    normalizePipelineStatus({
      runTimestamp: "2026-08-30T12:00:00Z",
      papersProcessed: 1.5,
      fulltextRetrieved: 2,
      genesExtracted: 3,
      genesValidated: 4,
    }),
    null,
  );
  assertEquals(
    normalizePipelineStatus({
      runTimestamp: "2026-08-30T12:00:00Z",
      papersProcessed: -1,
      fulltextRetrieved: 2,
      genesExtracted: 3,
      genesValidated: 4,
    }),
    null,
  );
  assertEquals(
    normalizePipelineStatus({
      runTimestamp: " 2026-08-30T12:00:00Z ",
      papersProcessed: 0,
      fulltextRetrieved: 2,
      genesExtracted: 3,
      genesValidated: 4,
    }),
    {
      runTimestamp: "2026-08-30T12:00:00Z",
      papersProcessed: 0,
      fulltextRetrieved: 2,
      genesExtracted: 3,
      genesValidated: 4,
    },
  );
});
