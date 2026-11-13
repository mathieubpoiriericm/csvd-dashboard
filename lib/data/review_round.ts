/** The review round and its runtime normalization boundary. */

import reviewRoundJson from "../../data/review_round.json" with {
  type: "json",
};

import type {
  Gene,
  ReviewChange,
  ReviewFieldChange,
  ReviewFieldValue,
  ReviewFinding,
  ReviewKind,
  ReviewRound,
  RoundState,
} from "../types.ts";
import { normalizeGene } from "./genes.ts";
import {
  normalizeRows,
  nullableText,
  numberInRange,
  record,
  textArray,
} from "./normalize.ts";

const STATES: ReadonlySet<string> = new Set(["open", "promoted", "closed"]);
const KINDS: ReadonlySet<string> = new Set([
  "new",
  "claims",
  "citation_protein",
  "citation",
]);

// The keys of a `Gene`, read off the normalizer that builds one, so a column
// added to `Gene` is accepted here without a second list to keep in step.
const GENE_KEYS: ReadonlySet<string> = new Set(Object.keys(normalizeGene({})));

function fieldValue(value: unknown): ReviewFieldValue {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return textArray(value);
  return nullableText(value);
}

function normalizeField(value: unknown): ReviewFieldChange | null {
  const source = record(value);
  const field = nullableText(source.field);
  if (field === null || !GENE_KEYS.has(field)) return null;
  const before = fieldValue(source.before);
  const after = fieldValue(source.after);
  // As the writer does: a value is added or removed only between two lists.
  // A malformed file's `added` beside a non-list `after` would otherwise reach
  // code that indexes into `after` as a list and throw at import.
  const listed = Array.isArray(before) && Array.isArray(after);
  return {
    field: field as keyof Gene,
    before,
    after,
    added: listed ? textArray(source.added) : [],
    removed: listed ? textArray(source.removed) : [],
  };
}

function normalizeFinding(value: unknown): ReviewFinding {
  const source = record(value);
  return {
    pmid: nullableText(source.pmid),
    confidence: numberInRange(source.confidence, 0, 1),
    gwasTraits: textArray(source.gwasTraits),
    // Absent from a round written before findings carried it.
    proteinName: nullableText(source.proteinName),
    mendelianRandomization: typeof source.mendelianRandomization === "boolean"
      ? source.mendelianRandomization
      : null,
    omicsEvidence: textArray(source.omicsEvidence),
    causalEvidenceSummary: nullableText(source.causalEvidenceSummary),
    sourceQuote: nullableText(source.sourceQuote),
    citationOnly: source.citationOnly === true,
    fulltext: typeof source.fulltext === "boolean" ? source.fulltext : null,
    extractionModel: nullableText(source.extractionModel),
  };
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A change with no gene, version, kind or after row cannot be shown. */
function normalizeChange(value: unknown): ReviewChange | null {
  const source = record(value);
  const gene = nullableText(source.gene);
  const version = nullableText(source.version);
  const kind = nullableText(source.kind);
  if (
    gene === null || version === null || kind === null || !KINDS.has(kind) ||
    !isObject(source.after)
  ) return null;
  return {
    gene,
    kind: kind as ReviewKind,
    version,
    before: isObject(source.before) ? normalizeGene(source.before) : null,
    after: normalizeGene(source.after),
    fields: normalizeRows(source.fields, normalizeField),
    findings: normalizeRows(source.findings, normalizeFinding),
  };
}

/**
 * Null until the pipeline has written a round.
 *
 * All-or-nothing on the four fields that identify a round, like
 * `normalizePipelineRun`: a page with no id, state or base has nothing to
 * say which round it shows. The timestamp must also parse as a date: the
 * simulated history is dated from it, and an invalid date would throw where
 * the app imports the review. A change that cannot be displayed is dropped
 * rather than thrown on, so one bad row does not hide the rest.
 */
export function normalizeReviewRound(value: unknown): ReviewRound | null {
  if (!isObject(value)) return null;
  const source = value as Record<string, unknown>;
  const id = nullableText(source.id);
  const runTimestamp = nullableText(source.runTimestamp);
  const base = nullableText(source.base);
  const state = nullableText(source.state);
  if (
    id === null || runTimestamp === null || base === null || state === null ||
    !STATES.has(state) || Number.isNaN(Date.parse(runTimestamp))
  ) return null;
  return {
    id,
    state: state as RoundState,
    runTimestamp,
    base,
    changes: normalizeRows(source.changes, normalizeChange),
  };
}

export const reviewRound = normalizeReviewRound(reviewRoundJson);
