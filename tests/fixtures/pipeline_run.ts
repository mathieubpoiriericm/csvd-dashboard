/**
 * A recorded run for tests that need *a* run rather than the committed one.
 *
 * It was the fixture at the head of `tests/pipeline_widget_test.tsx` until the
 * card's derivations moved into `lib/pipeline_ledger.ts` and
 * `lib/pipeline_details.ts` and needed the same run: a count pinned in one
 * file and rendered in another is only the same number while both read one
 * object. `data/pipeline_run.json` is `null` in a repository generated for
 * another disease, so nothing here reads it.
 */

import type { PipelineRun, RunStep, RunWarning } from "../../lib/types.ts";

export const RUN: PipelineRun = {
  runTimestamp: "2026-08-31T02:17:55+00:00",
  status: "completed_with_warnings",
  runMode: "standard",
  durationSeconds: 167.2,
  computeSeconds: 763.3,
  config: {
    model: "claude-opus-5",
    fallbackModel: null,
    effort: "high",
    promptVersion: "v6",
    disease: null,
    promptSha256: null,
    mode: "standard",
    skipValidation: false,
    dryRun: false,
    confidenceThresholdUpdate: 0.45,
    confidenceThresholdInsert: 0.65,
    batch: null,
    daysBack: 7,
  },
  papers: {
    found: 40,
    newlySeen: 16,
    alreadySeen: 24,
    processed: 15,
    fulltext: 10,
    abstractOnly: 5,
    noTextAvailable: 1,
    failed: 0,
  },
  genes: {
    extracted: 50,
    validated: 26,
    rejected: 24,
    rejectedAtInsertFloor: 2,
    quotesChecked: 26,
    quotesVerbatim: 25,
    quotesCited: 8,
  },
  tokens: {
    inputTokens: 153712,
    outputTokens: 21872,
    thinkingTokens: 3624,
    cacheReadInputTokens: 134985,
    totalTokens: 175584,
    cacheHitRate: 0.4676,
    truncatedResponses: 0,
    estimatedCostUsd: 1.38,
    cacheCreationInputTokens: null,
  },
  database: { inserted: 3, updated: 21 },
  steps: [
    {
      key: "searching_pubmed",
      label: "Search PubMed",
      ordinal: 1,
      status: "ok",
      startedAt: "2026-08-31T02:15:08+00:00",
      durationSeconds: 0.9,
      actions: ["Searched PubMed over the last 7 days: 40 papers matched"],
      warnings: [],
      error: null,
    },
    {
      key: "filtering_pmids",
      label: "Filter new papers",
      ordinal: 2,
      status: "ok",
      startedAt: "2026-08-31T02:15:09+00:00",
      durationSeconds: 0.1,
      actions: [],
      warnings: [],
      error: null,
    },
    {
      key: "processing_papers",
      label: "Retrieve & extract",
      ordinal: 3,
      status: "warning",
      startedAt: "2026-08-31T02:15:09+00:00",
      durationSeconds: 131.4,
      actions: ["Retrieved full text for 10, abstract only for 5"],
      warnings: [
        {
          kind: "genes_rejected",
          title: "24 findings did not clear the validation floor",
          count: 24,
          detail: null,
          subjects: [],
        },
        {
          kind: "paper_retrieval_failed",
          title: "1 paper had no retrievable text",
          count: 1,
          detail: null,
          subjects: ["19539236"],
        },
      ],
      error: null,
    },
    {
      key: "merging_database",
      label: "Merge to database",
      ordinal: 5,
      status: "failed",
      startedAt: "2026-08-31T02:17:40+00:00",
      durationSeconds: 2.4,
      actions: [],
      warnings: [],
      error: {
        kind: "rate_limited",
        title: "The service asked us to slow down",
        detail: "HTTP 429 Too Many Requests",
        subject: "E-utilities fetch",
      },
    },
  ],
  apis: [
    {
      service: "ncbi_eutils",
      label: "E-utilities fetch",
      endpoint: "/entrez/eutils/efetch.fcgi",
      method: "GET",
      calls: 32,
      ok: 31,
      notFound: 0,
      errors: 1,
      retries: 1,
      totalMs: 4100,
      bytes: 51200,
    },
  ],
  papersDetail: {
    shown: 1,
    total: 15,
    items: [
      {
        pmid: "32517579",
        source: "europepmc",
        fulltext: true,
        geneCount: 2,
        rejectedCount: 1,
        processingSeconds: 10.664,
        error: null,
        extractionModel: "claude-opus-5",
        refusal: null,
      },
    ],
  },
  // 26 validated less the 2 held: the list's own total is what reached
  // the database, and is exact even when the list is capped.
  acceptedGenes: {
    shown: 1,
    total: 24,
    items: [
      {
        symbol: "HTRA1",
        pmid: "20437615",
        confidence: 1,
        gwasTraits: ["extreme-cSVD"],
        proteinName: "HtrA serine peptidase 1",
        mendelianRandomization: false,
        omicsEvidence: ["MAGMA"],
        causalEvidenceSummary: "Validated monogenic cause of cSVD.",
        sourceQuote: "The diagnosis is established by molecular testing.",
        citationOnly: false,
      },
    ],
  },
  rejectedGenes: {
    shown: 1,
    total: 24,
    items: [
      {
        symbol: "POLR2F",
        pmid: "32517579",
        confidence: 0.6,
        reasons: ["Low confidence: 0.60 < 0.65"],
      },
    ],
  },
};

/** `RUN` with some of its top-level blocks replaced. */
export function runWith(patch: Partial<PipelineRun>): PipelineRun {
  return { ...RUN, ...patch };
}

/** A step that passed and has nothing to report, with `patch` over it. */
export function step(patch: Partial<RunStep> = {}): RunStep {
  return {
    key: "finalizing",
    label: "Finalize",
    ordinal: 6,
    status: "ok",
    startedAt: null,
    durationSeconds: 0.03,
    actions: [],
    warnings: [],
    error: null,
    ...patch,
  };
}

/** A warning of `kind` about `count` things, named by `subjects`. */
export function warning(
  kind: string,
  count = 1,
  subjects: string[] = [],
): RunWarning {
  return { kind, title: `${count} ${kind}`, count, detail: null, subjects };
}
