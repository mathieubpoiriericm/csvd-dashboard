/**
 * The words the review pages print: labels, one-line descriptions of a change
 * and of a tally. Browser-safe: it imports only the pure rules.
 */

import type { Gene, ReviewChange, ReviewKind } from "../types.ts";
import type { Answer } from "./events.ts";
import { settlesAt } from "./rules.ts";
import type { Standing, Tally } from "./rules.ts";

export const KIND_LABELS: Record<ReviewKind, string> = {
  new: "New gene",
  claims: "Claims changed",
  citation: "Citation only",
};

export const STANDING_LABELS: Record<Standing, string> = {
  not_started: "Not started",
  in_review: "In review",
  conflict: "Conflict",
  accepted: "Accepted",
  rejected: "Rejected",
  no_quorum: "No quorum",
};

export const ANSWER_LABELS: Record<Answer, string> = {
  accept: "Accept",
  accept_with_edits: "Accept with edits",
  reject: "Reject",
  abstain: "Abstain",
};

export const FIELD_LABELS: Record<keyof Gene, string> = {
  gene: "Gene",
  protein: "Protein",
  chromosomalLocation: "Chromosomal location",
  gwasTrait: "GWAS traits",
  mendelianRandomization: "Mendelian randomization",
  evidenceFromOtherOmicsStudies: "Omics evidence",
  linkToMonogenicDisease: "Monogenic disease links",
  brainCellTypes: "Brain cell types",
  affectedPathway: "Affected pathway",
  references: "References",
  sourceQuote: "Source quote",
  confidence: "Confidence",
};

/** The singular and plural noun of each list field a change can add to. */
const LIST_NOUNS: Partial<Record<keyof Gene, [string, string]>> = {
  gwasTrait: ["GWAS trait", "GWAS traits"],
  evidenceFromOtherOmicsStudies: ["omics entry", "omics entries"],
  linkToMonogenicDisease: [
    "monogenic disease link",
    "monogenic disease links",
  ],
  references: ["reference", "references"],
};

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** What a change adds, in a line: its additions, else what kind of change. */
export function proposalLine(change: ReviewChange): string {
  if (change.kind === "new") {
    return plural(change.findings.length, "finding", "findings");
  }
  const parts: string[] = [];
  for (const field of change.fields) {
    const nouns = LIST_NOUNS[field.field];
    if (nouns && field.added.length > 0) {
      parts.push(`+${plural(field.added.length, nouns[0], nouns[1])}`);
    }
  }
  if (change.fields.some((f) => f.field === "mendelianRandomization")) {
    parts.push("Mendelian randomization changed");
  }
  return parts.length > 0
    ? parts.join(" · ")
    : "Quote and confidence for a paper already cited";
}

export function tallyWords(tally: Tally): string {
  return `${tally.accept} accept · ${tally.reject} reject · ${tally.abstain} abstain · ${tally.outstanding} to come`;
}

export function settlesWords(tally: Tally): string {
  const { needed, of } = settlesAt(tally);
  return `Settles at ${needed} of the ${of} not abstaining`;
}

/** The gene's page; the key is encoded because a symbol can hold a slash. */
export function geneHref(gene: string): string {
  return "/review/gene?g=" + encodeURIComponent(gene);
}

/** A whole per cent; zero for an empty whole. */
export function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}
