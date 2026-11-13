/** Synthetic review-round rows for the tests, naming no real gene or trait. */

import type {
  ReviewChange,
  ReviewFinding,
  ReviewKind,
  ReviewRound,
} from "../../lib/types.ts";
import { sampleGene } from "./rows.ts";

// Three of the four kinds: tests rely on where each sits in the cycle.
const KINDS: ReviewKind[] = ["new", "claims", "citation"];

export function sampleFinding(
  overrides: Partial<ReviewFinding> = {},
): ReviewFinding {
  return {
    pmid: "10000001",
    confidence: 0.9,
    gwasTraits: ["TRAIT-A"],
    proteinName: null,
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

/**
 * A change of the given kind. `sampleRound` cycles the first three kinds
 * only, so the tests that rely on a kind's index in it stay put;
 * `citation_protein` is built here for the tests that need one.
 */
export function kindChange(
  kind: ReviewKind,
  gene: string,
  version: string,
): ReviewChange {
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
  if (kind === "citation_protein") {
    return sampleChange({
      gene,
      kind,
      version,
      before: sampleGene({ gene, protein: gene }),
      after: sampleGene({
        gene,
        protein: "Protein one",
        references: ["10000001", "10000002"],
      }),
      fields: [{
        field: "protein",
        before: gene,
        after: "Protein one",
        added: [],
        removed: [],
      }, {
        field: "references",
        before: ["10000001"],
        after: ["10000001", "10000002"],
        added: ["10000002"],
        removed: [],
      }],
      findings: [
        sampleFinding({
          pmid: "10000002",
          citationOnly: true,
          proteinName: "Protein one",
        }),
      ],
    });
  }
  return sampleChange({ gene, version });
}

/**
 * An open round of `count` changes, kinds cycling new, claims, citation;
 * `withEveryKind` appends a `citation_protein` change to it.
 */
export function sampleRound(count: number): ReviewRound {
  return {
    id: "round-1",
    state: "open",
    runTimestamp: "2026-01-05T10:00:00+00:00",
    base: "gold-1",
    changes: Array.from(
      { length: count },
      (_, i) =>
        kindChange(KINDS[i % KINDS.length], `GENE${i + 1}`, `v${i + 1}`),
    ),
  };
}

/** `sampleRound(count)` with a `citation_protein` change appended. */
export function withEveryKind(count: number): ReviewRound {
  const round = sampleRound(count);
  const n = count + 1;
  return {
    ...round,
    changes: [
      ...round.changes,
      kindChange("citation_protein", `GENE${n}`, `v${n}`),
    ],
  };
}
