/** The full pipeline-run report and its runtime normalization boundary. */

import pipelineRunJson from "../../data/pipeline_run.json" with {
  type: "json",
};

import type {
  DatabaseCounts,
  GeneCounts,
  PaperCounts,
  PipelineRun,
  RejectedGene,
  RunConfig,
  RunError,
  RunGene,
  RunPaper,
  RunStatus,
  RunStep,
  RunWarning,
  StepStatus,
  TokenCounts,
} from "../types.ts";
import {
  capped,
  list,
  nonnegativeInteger,
  nonnegativeNumber,
  normalizeApis,
  nullableText,
  numberInRange,
  record,
  textArray,
} from "./normalize.ts";

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "completed_with_warnings",
  "failed",
]);

const STEP_STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "warning",
  "failed",
  "skipped",
]);

function count(value: unknown, fallback = 0): number {
  return nonnegativeInteger(value) ?? fallback;
}

function nullableBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeConfig(value: unknown): RunConfig {
  const source = record(value);
  return {
    model: nullableText(source.model),
    effort: nullableText(source.effort),
    promptVersion: nullableText(source.promptVersion),
    disease: nullableText(source.disease),
    promptSha256: nullableText(source.promptSha256),
    mode: nullableText(source.mode),
    skipValidation: source.skipValidation === true,
    dryRun: source.dryRun === true,
    confidenceThresholdUpdate: numberInRange(
      source.confidenceThresholdUpdate,
      0,
      1,
    ),
    confidenceThresholdInsert: numberInRange(
      source.confidenceThresholdInsert,
      0,
      1,
    ),
  };
}

function normalizePapers(value: unknown): PaperCounts {
  const source = record(value);
  return {
    found: nonnegativeInteger(source.found),
    newlySeen: nonnegativeInteger(source.newlySeen),
    alreadySeen: nonnegativeInteger(source.alreadySeen),
    processed: count(source.processed),
    fulltext: count(source.fulltext),
    abstractOnly: count(source.abstractOnly),
    noTextAvailable: count(source.noTextAvailable),
    failed: count(source.failed),
  };
}

function normalizeGenes(value: unknown): GeneCounts {
  const source = record(value);
  return {
    extracted: count(source.extracted),
    validated: count(source.validated),
    rejected: count(source.rejected),
    rejectedAtInsertFloor: count(source.rejectedAtInsertFloor),
    quotesChecked: count(source.quotesChecked),
    quotesVerbatim: count(source.quotesVerbatim),
    quotesCited: count(source.quotesCited),
  };
}

function normalizeTokens(value: unknown): TokenCounts {
  const source = record(value);
  return {
    inputTokens: count(source.inputTokens),
    outputTokens: count(source.outputTokens),
    thinkingTokens: count(source.thinkingTokens),
    cacheReadInputTokens: count(source.cacheReadInputTokens),
    totalTokens: count(source.totalTokens),
    cacheHitRate: numberInRange(source.cacheHitRate, 0, 1) ?? 0,
    truncatedResponses: count(source.truncatedResponses),
    estimatedCostUsd: nonnegativeNumber(source.estimatedCostUsd) ?? 0,
  };
}

function normalizeDatabase(value: unknown): DatabaseCounts | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  return {
    inserted: count(source.inserted),
    updated: count(source.updated),
  };
}

function normalizeWarning(value: unknown): RunWarning {
  const source = record(value);
  return {
    kind: nullableText(source.kind) ?? "unknown",
    title: nullableText(source.title) ?? "",
    count: count(source.count, 1),
    detail: nullableText(source.detail),
    subjects: textArray(source.subjects),
  };
}

function normalizeError(value: unknown): RunError | null {
  const source = record(value);
  const title = nullableText(source.title);
  if (title === null) return null;
  return {
    kind: nullableText(source.kind) ?? "unknown",
    title,
    detail: nullableText(source.detail),
    subject: nullableText(source.subject),
  };
}

function normalizeStep(value: unknown, index: number): RunStep {
  const source = record(value);
  const status = nullableText(source.status);
  // The ordinal is the step's identity in the widget -- it names the
  // panel and is what "expanded" compares against -- so two steps that
  // both fell back to 0 shared an id and toggled together. Position in
  // the list is the fallback, one-based like the pipeline's own.
  const ordinal = nonnegativeInteger(source.ordinal) ?? 0;
  return {
    key: nullableText(source.key) ?? "",
    label: nullableText(source.label) ?? "",
    ordinal: ordinal > 0 ? ordinal : index + 1,
    status:
      (status !== null && STEP_STATUSES.has(status)
        ? status
        : "skipped") as StepStatus,
    startedAt: nullableText(source.startedAt),
    durationSeconds: nonnegativeNumber(source.durationSeconds),
    actions: textArray(source.actions),
    warnings: list(source.warnings).map(normalizeWarning),
    error: normalizeError(source.error),
  };
}

function normalizePaper(value: unknown): RunPaper {
  const source = record(value);
  return {
    pmid: nullableText(source.pmid) ?? "",
    source: nullableText(source.source) ?? "unknown",
    fulltext: source.fulltext === true,
    geneCount: count(source.geneCount),
    rejectedCount: count(source.rejectedCount),
    processingSeconds: nonnegativeNumber(source.processingSeconds),
    error: nullableText(source.error),
  };
}

function normalizeGene(value: unknown): RunGene {
  const source = record(value);
  return {
    symbol: nullableText(source.symbol) ?? "",
    pmid: nullableText(source.pmid),
    confidence: numberInRange(source.confidence, 0, 1),
    gwasTraits: textArray(source.gwasTraits),
    proteinName: nullableText(source.proteinName),
    mendelianRandomization: nullableBool(source.mendelianRandomization),
    omicsEvidence: textArray(source.omicsEvidence),
    causalEvidenceSummary: nullableText(source.causalEvidenceSummary),
    sourceQuote: nullableText(source.sourceQuote),
  };
}

function normalizeRejected(value: unknown): RejectedGene {
  const source = record(value);
  return {
    symbol: nullableText(source.symbol) ?? "",
    pmid: nullableText(source.pmid),
    confidence: numberInRange(source.confidence, 0, 1),
    reasons: textArray(source.reasons),
  };
}

/**
 * Null until the pipeline has recorded a complete run report.
 *
 * All-or-nothing on the two fields that identify a run, like
 * `normalizePipelineStatus`: without a timestamp and a status the widget
 * has no headline, and rendering the rest under a blank header would be
 * worse than falling back to the summary card. Everything below them is
 * defaulted rather than rejected, so an older file missing a block that
 * a later pipeline added still renders.
 */
export function normalizePipelineRun(value: unknown): PipelineRun | null {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;

  const runTimestamp = nullableText(source.runTimestamp);
  const status = nullableText(source.status);
  if (runTimestamp === null || status === null || !RUN_STATUSES.has(status)) {
    return null;
  }

  return {
    runTimestamp,
    status: status as RunStatus,
    runMode: nullableText(source.runMode) ?? "standard",
    durationSeconds: nonnegativeNumber(source.durationSeconds) ?? 0,
    computeSeconds: nonnegativeNumber(source.computeSeconds) ?? 0,
    config: normalizeConfig(source.config),
    papers: normalizePapers(source.papers),
    genes: normalizeGenes(source.genes),
    tokens: normalizeTokens(source.tokens),
    database: normalizeDatabase(source.database),
    steps: list(source.steps).map((step, index) => normalizeStep(step, index)),
    apis: normalizeApis(source.apis),
    papersDetail: capped(source.papersDetail, normalizePaper),
    acceptedGenes: capped(source.acceptedGenes, normalizeGene),
    rejectedGenes: capped(source.rejectedGenes, normalizeRejected),
  };
}

export const pipelineRun = normalizePipelineRun(pipelineRunJson);
