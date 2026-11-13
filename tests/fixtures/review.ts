/** Synthetic review-round rows for the tests, naming no real gene or trait. */

import type {
  ReviewChange,
  ReviewFinding,
  ReviewKind,
  ReviewRound,
} from "../../lib/types.ts";
import { sampleGene } from "./rows.ts";

const KINDS: ReviewKind[] = ["new", "claims", "citation"];

export function sampleFinding(
  overrides: Partial<ReviewFinding> = {},
): ReviewFinding {
  return {
    pmid: "10000001",
    confidence: 0.9,
    gwasTraits: ["TRAIT-A"],
    mendelianRandomization: false,
    omicsEvidence: [],
    causalEvidenceSummary: "GENE1 was associated with TRAIT-A.",
    sourceQuote: "GENE1 was associated with the phenotype (p = 1e-9).",
    citationOnly: false,
    fulltext: true,
    extractionModel: "model-a",
    ...overrides,
  };
}

/** A `claims` change: gold gains one GWAS trait. */
export function sampleChange(
  overrides: Partial<ReviewChange> = {},
): ReviewChange {
  const gene = overrides.gene ?? "GENE1";
  return {
    gene,
    kind: "claims",
    version: "v1",
    before: sampleGene({ gene }),
    after: sampleGene({ gene, gwasTrait: ["TRAIT-A"] }),
    fields: [{
      field: "gwasTrait",
      before: ["(none found)"],
      after: ["TRAIT-A"],
      added: ["TRAIT-A"],
      removed: ["(none found)"],
    }],
    findings: [sampleFinding()],
    ...overrides,
  };
}

function changeOf(kind: ReviewKind, gene: string, version: string) {
  if (kind === "new") {
    return sampleChange({
      gene,
      kind,
      version,
      before: null,
      after: sampleGene({ gene, gwasTrait: ["TRAIT-A"] }),
      fields: [],
    });
  }
  if (kind === "citation") {
    return sampleChange({
      gene,
      kind,
      version,
      before: sampleGene({ gene }),
      after: sampleGene({ gene, references: ["10000001", "10000002"] }),
      fields: [{
        field: "references",
        before: ["10000001"],
        after: ["10000001", "10000002"],
        added: ["10000002"],
        removed: [],
      }],
      findings: [sampleFinding({ pmid: "10000002", citationOnly: true })],
    });
  }
  return sampleChange({ gene, version });
}

/** An open round of `count` changes, kinds cycling new, claims, citation. */
export function sampleRound(count: number): ReviewRound {
  return {
    id: "round-1",
    state: "open",
    runTimestamp: "2026-01-05T10:00:00+00:00",
    base: "gold-1",
    changes: Array.from(
      { length: count },
      (_, i) => changeOf(KINDS[i % KINDS.length], `GENE${i + 1}`, `v${i + 1}`),
    ),
  };
}
