/**
 * The run report's data boundary.
 *
 * `lib/data/pipeline_run.ts` is what stands between a generated file and
 * the island. A partially generated or older file must never crash the
 * About page or silently present truncated data as complete.
 */

import { assert, assertEquals } from "@std/assert";

import { normalizePipelineRun } from "../lib/data/pipeline_run.ts";

function run(overrides: Record<string, unknown> = {}): unknown {
  return {
    runTimestamp: "2026-08-31T02:17:55+00:00",
    status: "completed_with_warnings",
    runMode: "standard",
    durationSeconds: 167.2,
    computeSeconds: 763.3,
    ...overrides,
  };
}

Deno.test("a complete report normalizes", () => {
  const result = normalizePipelineRun(run());
  assert(result !== null);
  assertEquals(result.runTimestamp, "2026-08-31T02:17:55+00:00");
  assertEquals(result.status, "completed_with_warnings");
  assertEquals(result.durationSeconds, 167.2);
});

Deno.test("a fully populated report keeps every value it was given", () => {
  // The tests below mostly exercise absent fields. This one exercises
  // the present side of every fallback, so a normalizer that silently
  // dropped a populated field would fail here rather than in the UI.
  const result = normalizePipelineRun(run({
    config: {
      model: "claude-opus-5",
      effort: "high",
      promptVersion: "v6",
      disease: "csvd",
      promptSha256: "70908abc0302" + "0".repeat(52),
      mode: "pmid_list",
      skipValidation: true,
      dryRun: true,
      confidenceThresholdUpdate: 0.45,
      confidenceThresholdInsert: 0.65,
    },
    papers: {
      found: 40,
      newlySeen: 9,
      alreadySeen: 31,
      processed: 15,
      fulltext: 10,
      abstractOnly: 5,
      noTextAvailable: 1,
      failed: 1,
    },
    genes: {
      extracted: 50,
      validated: 26,
      rejected: 24,
      rejectedAtInsertFloor: 2,
    },
    tokens: {
      inputTokens: 153712,
      outputTokens: 21872,
      thinkingTokens: 3624,
      cacheReadInputTokens: 134985,
      totalTokens: 175584,
      cacheHitRate: 0.4676,
      truncatedResponses: 1,
      estimatedCostUsd: 1.38,
    },
    steps: [{
      key: "processing_papers",
      label: "Retrieve & extract",
      ordinal: 3,
      status: "warning",
      startedAt: "2026-08-31T02:18:00+00:00",
      durationSeconds: 131.2,
      actions: ["Retrieved full text for 10, abstract only for 5"],
      warnings: [{
        kind: "genes_rejected",
        title: "24 genes did not clear the validation floor",
        count: 24,
        detail: "the update floor is 0.45",
        subjects: ["POLR2F", "WDR12"],
      }],
      error: {
        kind: "timeout",
        title: "The request timed out",
        detail: "read timeout after 15s",
        subject: "32517579",
      },
    }],
    apis: [{
      service: "ncbi_eutils",
      label: "E-utilities fetch",
      endpoint: "/entrez/eutils/efetch.fcgi",
      method: "POST",
      calls: 32,
      ok: 31,
      errors: 1,
      retries: 1,
      totalMs: 4100.5,
      bytes: 2048,
    }],
    acceptedGenes: {
      items: [{
        symbol: "HTRA1",
        pmid: "20437615",
        confidence: 1,
        gwasTraits: ["extreme-cSVD"],
        proteinName: "HtrA serine peptidase 1",
        mendelianRandomization: true,
        omicsEvidence: ["MAGMA"],
        causalEvidenceSummary: "Validated monogenic cause.",
        sourceQuote: "The diagnosis is established by molecular testing.",
      }],
    },
  }));

  assert(result !== null);
  assertEquals(result.config.model, "claude-opus-5");
  assertEquals(result.config.promptVersion, "v6");
  assertEquals(result.config.disease, "csvd");
  assertEquals(result.config.promptSha256, "70908abc0302" + "0".repeat(52));
  assertEquals(result.config.skipValidation, true);
  assertEquals(result.config.dryRun, true);
  assertEquals(result.config.confidenceThresholdInsert, 0.65);
  assertEquals(result.papers.found, 40);
  assertEquals(result.papers.alreadySeen, 31);
  assertEquals(result.papers.noTextAvailable, 1);
  assertEquals(result.genes.rejectedAtInsertFloor, 2);
  assertEquals(result.tokens.cacheHitRate, 0.4676);
  assertEquals(result.tokens.estimatedCostUsd, 1.38);

  const step = result.steps[0];
  assertEquals(step.status, "warning");
  assertEquals(step.startedAt, "2026-08-31T02:18:00+00:00");
  assertEquals(step.durationSeconds, 131.2);
  assertEquals(step.actions.length, 1);
  assertEquals(step.warnings[0].count, 24);
  assertEquals(step.warnings[0].detail, "the update floor is 0.45");
  assertEquals(step.warnings[0].subjects, ["POLR2F", "WDR12"]);
  assertEquals(step.error?.subject, "32517579");
  assertEquals(step.error?.detail, "read timeout after 15s");

  assertEquals(result.apis[0].label, "E-utilities fetch");
  assertEquals(result.apis[0].method, "POST");
  assertEquals(result.apis[0].bytes, 2048);

  const gene = result.acceptedGenes.items[0];
  assertEquals(gene.proteinName, "HtrA serine peptidase 1");
  assertEquals(gene.mendelianRandomization, true);
  assertEquals(gene.omicsEvidence, ["MAGMA"]);
  assertEquals(gene.causalEvidenceSummary, "Validated monogenic cause.");
  assertEquals(
    gene.sourceQuote,
    "The diagnosis is established by molecular testing.",
  );
});

Deno.test("a list field that is not a list becomes an empty one", () => {
  const result = normalizePipelineRun(run({
    steps: "not a list",
    apis: { not: "a list" },
    acceptedGenes: { items: [{ symbol: "A", gwasTraits: "PVWMH" }] },
  }));
  assert(result !== null);
  assertEquals(result.steps, []);
  assertEquals(result.apis, []);
  assertEquals(result.acceptedGenes.items[0].gwasTraits, []);
});

Deno.test("a non-object where a block belongs falls back to defaults", () => {
  const result = normalizePipelineRun(run({
    config: "nonsense",
    papers: 42,
    genes: null,
    tokens: [],
    acceptedGenes: "nonsense",
  }));
  assert(result !== null);
  assertEquals(result.config.model, null);
  assertEquals(result.papers.processed, 0);
  assertEquals(result.genes.extracted, 0);
  assertEquals(result.tokens.totalTokens, 0);
  assertEquals(result.acceptedGenes, { shown: 0, total: 0, items: [] });
});

Deno.test("API rows require a usable identity and never render blank", () => {
  const result = normalizePipelineRun(run({
    apis: [null, [], {}, { label: " Friendly API " }, {
      endpoint: " /health ",
    }],
  }));
  assert(result !== null);
  assertEquals(
    result.apis.map(({ service, label, endpoint }) => ({
      service,
      label,
      endpoint,
    })),
    [
      { service: "Friendly API", label: "Friendly API", endpoint: "" },
      { service: "/health", label: "/health", endpoint: "/health" },
    ],
  );
});

Deno.test("an explicit null block is handled like an absent one", () => {
  // `null` and "missing" arrive by different routes -- the writer emits
  // null for a dry run's database, and an older file simply omits the
  // key -- so both guards have to hold.
  const result = normalizePipelineRun(run({
    database: null,
    steps: [{ key: "x", label: "X", ordinal: 1, status: "ok", error: null }],
  }));
  assert(result !== null);
  assertEquals(result.database, null);
  assertEquals(result.steps[0].error, null);
});

Deno.test("a step with no status at all is not reached", () => {
  const result = normalizePipelineRun(
    run({ steps: [{ key: "x", label: "X", ordinal: 1 }] }),
  );
  assert(result !== null);
  assertEquals(result.steps[0].status, "skipped");
});

Deno.test("rows missing their own identifiers still render", () => {
  // Every identifier has a fallback, so a partially generated file
  // produces blank cells rather than `undefined` in the markup. The
  // widget skips empty rows; it must never print "undefined".
  const result = normalizePipelineRun({
    runTimestamp: "2026-08-31T02:17:55+00:00",
    status: "completed",
    steps: [{
      ordinal: 1,
      status: "failed",
      warnings: [{}],
      error: { title: "Something went wrong" },
    }],
    acceptedGenes: { items: [{}] },
    rejectedGenes: { items: [{}] },
  });

  assert(result !== null);
  assertEquals(result.runMode, "standard");

  const step = result.steps[0];
  assertEquals(step.key, "");
  assertEquals(step.label, "");
  assertEquals(step.warnings[0].kind, "unknown");
  assertEquals(step.warnings[0].title, "");
  assertEquals(step.error?.kind, "unknown");
  assertEquals(step.error?.title, "Something went wrong");

  assertEquals(result.acceptedGenes.items[0].symbol, "");
  assertEquals(result.rejectedGenes.items[0].symbol, "");
});

Deno.test("null and non-objects are null, not a crash", () => {
  assertEquals(normalizePipelineRun(null), null);
  assertEquals(normalizePipelineRun(undefined), null);
  assertEquals(normalizePipelineRun("a string"), null);
  assertEquals(normalizePipelineRun(42), null);
  assertEquals(normalizePipelineRun([]), null);
});

Deno.test("a run with no timestamp or status is null", () => {
  // Without those two the widget has no headline, and rendering the rest
  // under a blank header is worse than the fallback summary card.
  assertEquals(normalizePipelineRun(run({ runTimestamp: "" })), null);
  assertEquals(normalizePipelineRun(run({ runTimestamp: 5 })), null);
  assertEquals(normalizePipelineRun(run({ status: null })), null);
});

Deno.test("a status outside the known set is refused", () => {
  // A status the widget has no badge for would render as "Unknown" over
  // a real run; falling back to the summary card is more honest.
  assertEquals(normalizePipelineRun(run({ status: "mostly_fine" })), null);
});

Deno.test("blocks a later pipeline added arrive defaulted, not missing", () => {
  const result = normalizePipelineRun(run());
  assert(result !== null);
  assertEquals(result.papers.processed, 0);
  assertEquals(result.genes.extracted, 0);
  assertEquals(result.tokens.totalTokens, 0);
  assertEquals(result.database, null);
  assertEquals(result.steps, []);
  assertEquals(result.apis, []);
  assertEquals(result.config.model, null);
  assertEquals(result.config.disease, null);
  assertEquals(result.config.promptSha256, null);
  assertEquals(result.config.skipValidation, false);
});

Deno.test("counts reject NaN and Infinity rather than rendering them", () => {
  const result = normalizePipelineRun(
    run({
      durationSeconds: Number.NaN,
      papers: { processed: Number.POSITIVE_INFINITY, fulltext: 10 },
    }),
  );
  assert(result !== null);
  assertEquals(result.durationSeconds, 0);
  assertEquals(result.papers.processed, 0);
  assertEquals(result.papers.fulltext, 10);
});

Deno.test("metrics reject impossible signs, fractions, and rates", () => {
  const result = normalizePipelineRun(run({
    durationSeconds: -1,
    computeSeconds: -2,
    config: {
      confidenceThresholdUpdate: -0.1,
      confidenceThresholdInsert: 1.1,
    },
    papers: { found: 1.5, processed: -1 },
    genes: { extracted: -1 },
    tokens: {
      inputTokens: 1.5,
      cacheHitRate: 1.1,
      estimatedCostUsd: -0.01,
    },
    database: { inserted: -1, updated: 1.5 },
    steps: [{
      ordinal: 1.5,
      status: "warning",
      durationSeconds: -1,
      warnings: [{ count: -1 }],
    }],
    apis: [{ service: "metrics", calls: -1, totalMs: -1, bytes: 1.5 }],
    papersDetail: { total: 1.5, items: [] },
    acceptedGenes: { items: [{ confidence: 1.1 }] },
    rejectedGenes: { items: [{ confidence: -0.1 }] },
  }));

  assert(result !== null);
  assertEquals(result.durationSeconds, 0);
  assertEquals(result.computeSeconds, 0);
  assertEquals(result.config.confidenceThresholdUpdate, null);
  assertEquals(result.config.confidenceThresholdInsert, null);
  assertEquals(result.papers.found, null);
  assertEquals(result.papers.processed, 0);
  assertEquals(result.genes.extracted, 0);
  assertEquals(result.tokens.inputTokens, 0);
  assertEquals(result.tokens.cacheHitRate, 0);
  assertEquals(result.tokens.estimatedCostUsd, 0);
  assertEquals(result.database, { inserted: 0, updated: 0 });
  assertEquals(result.steps[0].ordinal, 1);
  assertEquals(result.steps[0].durationSeconds, null);
  assertEquals(result.steps[0].warnings[0].count, 1);
  assertEquals(result.apis[0].calls, 0);
  assertEquals(result.apis[0].totalMs, 0);
  assertEquals(result.apis[0].bytes, 0);
  assertEquals(result.papersDetail.total, 0);
  assertEquals(result.acceptedGenes.items[0].confidence, null);
  assertEquals(result.rejectedGenes.items[0].confidence, null);
});

Deno.test("a capped list recomputes shown from the items it actually has", () => {
  // A file claiming "showing 200" over 2 rows would make the UI lie.
  const result = normalizePipelineRun(
    run({
      acceptedGenes: {
        shown: 200,
        total: 1412,
        items: [{ symbol: "HTRA1" }, { symbol: "COL4A1" }],
      },
    }),
  );
  assert(result !== null);
  assertEquals(result.acceptedGenes.shown, 2);
  assertEquals(result.acceptedGenes.total, 1412);
  assertEquals(result.acceptedGenes.items.length, 2);
});

Deno.test("a total below the item count is raised to it", () => {
  const result = normalizePipelineRun(
    run({ acceptedGenes: { shown: 0, total: 0, items: [{ symbol: "A" }] } }),
  );
  assert(result !== null);
  assertEquals(result.acceptedGenes.total, 1);
});

Deno.test("a missing capped list is an empty one", () => {
  const result = normalizePipelineRun(run());
  assert(result !== null);
  assertEquals(result.acceptedGenes, { shown: 0, total: 0, items: [] });
});

Deno.test("a step with an unknown status is not reached rather than invented", () => {
  const result = normalizePipelineRun(
    run({ steps: [{ key: "x", label: "X", ordinal: 1, status: "weird" }] }),
  );
  assert(result !== null);
  assertEquals(result.steps[0].status, "skipped");
  assertEquals(result.steps[0].actions, []);
  assertEquals(result.steps[0].warnings, []);
  assertEquals(result.steps[0].error, null);
});

Deno.test("a step without an ordinal takes its position", () => {
  // The ordinal names the step's panel and is what "expanded" compares
  // against, so two steps falling back to the same value shared an id
  // and toggled together.
  const result = normalizePipelineRun(
    run({
      steps: [
        { key: "a", status: "ok" },
        { key: "b", status: "ok", ordinal: 0 },
        { key: "c", status: "ok", ordinal: 6 },
      ],
    }),
  );
  assert(result !== null);
  assertEquals(result.steps.map((step) => step.ordinal), [1, 2, 6]);
});

Deno.test("a step error without a title is dropped", () => {
  // An error box with no sentence in it is worse than no error box.
  const result = normalizePipelineRun(
    run({
      steps: [
        {
          key: "x",
          label: "X",
          ordinal: 1,
          status: "failed",
          error: { kind: "timeout" },
        },
      ],
    }),
  );
  assert(result !== null);
  assertEquals(result.steps[0].error, null);
});

Deno.test("a step error with a title survives", () => {
  const result = normalizePipelineRun(
    run({
      steps: [
        {
          key: "x",
          label: "X",
          ordinal: 1,
          status: "failed",
          error: { kind: "timeout", title: "The request timed out" },
        },
      ],
    }),
  );
  assert(result !== null);
  assertEquals(result.steps[0].error?.title, "The request timed out");
  assertEquals(result.steps[0].error?.detail, null);
});

Deno.test("warnings default their count to one thing", () => {
  const result = normalizePipelineRun(
    run({
      steps: [
        {
          key: "x",
          label: "X",
          ordinal: 1,
          status: "warning",
          warnings: [{ kind: "genes_rejected", title: "some rejected" }],
        },
      ],
    }),
  );
  assert(result !== null);
  assertEquals(result.steps[0].warnings[0].count, 1);
  assertEquals(result.steps[0].warnings[0].subjects, []);
});

Deno.test("an api row falls back to its service key for a label", () => {
  // A publisher host, because that is the case the fallback is really for:
  // the open-access PDF URL comes from Unpaywall's payload, so the host set
  // is the publishing world and no registry could name it in advance.
  const result = normalizePipelineRun(
    run({
      apis: [{ service: "link.springer.com", endpoint: "/content/pdf/:id" }],
    }),
  );
  assert(result !== null);
  assertEquals(result.apis[0].label, "link.springer.com");
  assertEquals(result.apis[0].method, "GET");
});

Deno.test("text is trimmed at the boundary", () => {
  const result = normalizePipelineRun(
    run({ acceptedGenes: { items: [{ symbol: "  HTRA1  ", pmid: "  1  " }] } }),
  );
  assert(result !== null);
  assertEquals(result.acceptedGenes.items[0].symbol, "HTRA1");
  assertEquals(result.acceptedGenes.items[0].pmid, "1");
});

Deno.test("a gene's booleans distinguish false from absent", () => {
  const result = normalizePipelineRun(
    run({
      acceptedGenes: {
        items: [
          { symbol: "A", mendelianRandomization: false },
          { symbol: "B" },
        ],
      },
    }),
  );
  assert(result !== null);
  assertEquals(result.acceptedGenes.items[0].mendelianRandomization, false);
  assertEquals(result.acceptedGenes.items[1].mendelianRandomization, null);
});

Deno.test("non-string entries in a list are dropped, not stringified", () => {
  const result = normalizePipelineRun(
    run({
      acceptedGenes: {
        items: [{ symbol: "A", gwasTraits: ["PVWMH", null, 7, "  WMH  "] }],
      },
    }),
  );
  assert(result !== null);
  assertEquals(result.acceptedGenes.items[0].gwasTraits, ["PVWMH", "WMH"]);
});

Deno.test("database counts survive, and a missing block is null", () => {
  const written = normalizePipelineRun(
    run({ database: { inserted: 4, updated: 7 } }),
  );
  assert(written !== null);
  assertEquals(written.database, { inserted: 4, updated: 7 });

  // A dry run wrote nothing, which is different from having written zero.
  assertEquals(normalizePipelineRun(run())!.database, null);
  assertEquals(normalizePipelineRun(run({ database: "yes" }))!.database, null);
  assertEquals(
    normalizePipelineRun(run({ database: {} }))!.database,
    { inserted: 0, updated: 0 },
  );
});

Deno.test("paper records normalize, defaulting an unknown source", () => {
  const result = normalizePipelineRun(
    run({
      papersDetail: {
        items: [
          {
            pmid: "32517579",
            source: "europepmc",
            fulltext: true,
            geneCount: 2,
            rejectedCount: 1,
            processingSeconds: 10.664,
            error: null,
          },
          {},
        ],
      },
    }),
  );
  assert(result !== null);
  const [full, bare] = result.papersDetail.items;
  assertEquals(full.pmid, "32517579");
  assertEquals(full.fulltext, true);
  assertEquals(full.geneCount, 2);
  assertEquals(full.rejectedCount, 1);
  assertEquals(full.processingSeconds, 10.664);
  assertEquals(full.error, null);
  assertEquals(bare.source, "unknown");
  assertEquals(bare.fulltext, false);
  assertEquals(bare.processingSeconds, null);
});

Deno.test("a rejected gene keeps the pipeline's own reasons", () => {
  // The gates already phrase these; re-wording them in the UI would put
  // two accounts of the same decision in the repo.
  const result = normalizePipelineRun(
    run({
      rejectedGenes: {
        items: [
          {
            symbol: "POLR2F",
            pmid: "32517579",
            confidence: 0.6,
            reasons: ["Low confidence: 0.60 < 0.65"],
          },
          { symbol: "WDR12" },
        ],
      },
    }),
  );
  assert(result !== null);
  const [scored, bare] = result.rejectedGenes.items;
  assertEquals(scored.reasons, ["Low confidence: 0.60 < 0.65"]);
  assertEquals(scored.confidence, 0.6);
  assertEquals(bare.reasons, []);
  assertEquals(bare.confidence, null);
  assertEquals(bare.pmid, null);
});

Deno.test("the committed file is null or a complete run", async () => {
  // data/pipeline_run.json is bootstrapped as `null` and stays that way
  // until a real run records a report. Both must work.
  const raw = JSON.parse(
    await Deno.readTextFile(
      new URL("../data/pipeline_run.json", import.meta.url),
    ),
  );
  const result = normalizePipelineRun(raw);
  if (raw === null) {
    assertEquals(result, null);
    return;
  }
  assert(result !== null, "a non-null pipeline_run.json must normalize");
  assert(result.steps.length > 0, "a recorded run has steps");
});
