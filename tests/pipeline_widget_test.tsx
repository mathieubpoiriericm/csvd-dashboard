/**
 * The pipeline widget's rendering.
 *
 * The island is rendered directly here rather than through the route,
 * because the route renders it with no props at all: Fresh serialises
 * island props for hydration, and every island in this repo reads its own
 * data instead. The `run` prop exists for these tests.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { renderToString } from "preact-render-to-string";

import PipelineRunView, {
  PipelineRunDetails,
} from "../islands/PipelineRun.tsx";
import type { PipelineRun } from "../lib/types.ts";

const RUN: PipelineRun = {
  runTimestamp: "2026-08-31T02:17:55+00:00",
  status: "completed_with_warnings",
  runMode: "standard",
  durationSeconds: 167.2,
  computeSeconds: 763.3,
  config: {
    model: "claude-opus-5",
    effort: "high",
    promptVersion: "v6",
    disease: null,
    promptSha256: null,
    mode: "standard",
    skipValidation: false,
    dryRun: false,
    confidenceThresholdUpdate: 0.45,
    confidenceThresholdInsert: 0.65,
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
          title: "24 genes did not clear the validation floor",
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

const details = () => renderToString(<PipelineRunDetails run={RUN} />);
const html = () => renderToString(<PipelineRunView run={RUN} />);

Deno.test("the headline reads as words, not as an enum", () => {
  const markup = html();
  assertStringIncludes(markup, "Completed with warnings");
  assertStringIncludes(markup, "August 31, 2026");
  assertStringIncludes(markup, "UTC");
  assertStringIncludes(markup, "PubMed search");
  assertStringIncludes(markup, "claude-opus-5");
  assertStringIncludes(markup, "2m 47s");
});

Deno.test("every step renders with its badge and its prose", () => {
  const markup = html();
  assertStringIncludes(markup, "Search PubMed");
  assertStringIncludes(markup, "Retrieve &amp; extract");
  assertStringIncludes(markup, "Merge to database");
  assertStringIncludes(markup, "Searched PubMed over the last 7 days");
  assertStringIncludes(
    markup,
    "Retrieved full text for 10, abstract only for 5",
  );
  assertStringIncludes(markup, "Passed with warnings");
});

Deno.test("a step's warning count totals things, not rows", () => {
  // Two warnings, 24 + 1 things.
  assertStringIncludes(html(), '<span class="pipeline-badge-count">25</span>');
});

Deno.test("a failure reads as a sentence, a meaning, then the raw detail", () => {
  // The console text is kept but demoted; it is never the headline.
  const markup = html();
  assertStringIncludes(
    markup,
    "The service asked us to slow down (E-utilities fetch)",
  );
  assertStringIncludes(markup, "Runs back off and retry");
  assertStringIncludes(markup, "HTTP 429 Too Many Requests");
  assertMatch(markup, /pipeline-error-detail/);
});

Deno.test("the funnel shows what was fetched before what was accepted", () => {
  const markup = html();
  assertStringIncludes(markup, "Found");
  assertStringIncludes(markup, "Processed");
  assertStringIncludes(markup, "Extracted");
  assertStringIncludes(markup, "Accepted");
  assertStringIncludes(markup, "Rejected");
});

Deno.test("the insert floor's holds are shown, not just published", () => {
  // rejectedAtInsertFloor was in the document and rendered nowhere, so
  // nothing on the page reconciled "Accepted" against the drawer's
  // rejected list.
  const markup = html();
  assertStringIncludes(markup, "Held (new gene)");
  // Accepted counts what reached the database: the accepted list's own
  // total, 24 here.
  assertStringIncludes(markup, ">24<");
});

Deno.test("accepted is the accepted list's total, not validated less held", () => {
  // `validated` counts one per paper and a hold counts one per merged
  // gene: COL4A1 and COL4A2 validated from two papers and held once as
  // COL4A1/2 is two validated, one held, and *none* accepted. The
  // subtraction said one.
  const merged = {
    ...RUN,
    genes: { ...RUN.genes, validated: 2, rejectedAtInsertFloor: 1 },
    acceptedGenes: { shown: 0, total: 0, items: [] },
  };
  const markup = renderToString(<PipelineRunView run={merged} />);
  assertMatch(
    markup,
    /Accepted<\/span><span class="pipeline-stat-value">0<\/span>/,
  );
});

Deno.test("papers that failed outright are a line in the funnel", () => {
  // Counted in the document and shown nowhere, so "Processed 9" over 12
  // papers had no line saying where the other three went.
  // Absent while zero: the stat, not the step badge that also says
  // "Failed".
  assertNotMatch(html(), /Failed<\/span><span class="pipeline-stat-value">/);
  const failed = { ...RUN, papers: { ...RUN.papers, failed: 3 } };
  const markup = renderToString(<PipelineRunView run={failed} />);
  assertMatch(
    markup,
    /Failed<\/span><span class="pipeline-stat-value">3<\/span>/,
  );
});

Deno.test("the header states the method, not only the model", () => {
  const markup = html();
  assertStringIncludes(markup, "high effort");
  assertStringIncludes(markup, "Prompt v6");
});

Deno.test("the disease and prompt hash appear only once both are set", () => {
  assertNotMatch(html(), /csvd/);
  const withProvenance = {
    ...RUN,
    config: {
      ...RUN.config,
      disease: "csvd",
      promptSha256: "70908abc0302" + "0".repeat(52),
    },
  };
  const markup = renderToString(<PipelineRunView run={withProvenance} />);
  assertStringIncludes(markup, "csvd 70908abc0302");
});

Deno.test("the API inventory names the service, method and endpoint", () => {
  const markup = details();
  assertStringIncludes(markup, "E-utilities fetch");
  assertStringIncludes(markup, "GET");
  assertStringIncludes(markup, "/entrez/eutils/efetch.fcgi");
  assertStringIncludes(
    markup,
    "32 calls · 1 retried · 1 failed · 4.1 s · 51.2 kB",
  );
});

Deno.test("the two quote numbers are reported as two numbers", () => {
  // `verbatim` asks whether the sentence is in the paper, of every gene;
  // `cited` asks whether the API attested to that span, which is bounded
  // by how much prose the model wrote. One averaged rate would report a
  // quality figure the second number cannot carry.
  const markup = html();
  assertStringIncludes(markup, "25 of 26 quotes found in the paper");
  assertStringIncludes(markup, "8 attested by the model&#39;s own citations");
});

Deno.test("a run that checked no quotes says nothing about them", () => {
  const none = {
    ...RUN,
    genes: {
      ...RUN.genes,
      quotesChecked: 0,
      quotesVerbatim: 0,
      quotesCited: 0,
    },
  };
  const markup = renderToString(<PipelineRunView run={none} />);
  assert(!markup.includes("quotes found in the paper"));
});

Deno.test("cost and token use are reported", () => {
  const markup = html();
  assertStringIncludes(markup, "175,584 tokens");
  assertStringIncludes(markup, "47% served from cache");
  assertStringIncludes(markup, "$1.38");
});

Deno.test("the drawer is present but hidden and inert until opened", () => {
  const markup = html();
  assertStringIncludes(markup, 'id="pipeline-run-drawer"');
  assertMatch(markup, /<aside[^>]*hidden/);
  assertStringIncludes(markup, "Everything this run recorded");
  assertNotMatch(markup, /class="pipeline-record"/);
});

Deno.test("the drawer carries a gene's evidence, not just its name", () => {
  const markup = details();
  assertStringIncludes(markup, "HTRA1");
  assertStringIncludes(markup, "HtrA serine peptidase 1");
  assertStringIncludes(markup, "extreme-cSVD");
  assertStringIncludes(markup, "MAGMA");
  assertStringIncludes(markup, "Validated monogenic cause of cSVD.");
  assertStringIncludes(
    markup,
    "The diagnosis is established by molecular testing.",
  );
});

Deno.test("a rejection is badged by kind and keeps its own numbers", () => {
  // The badge says the category, so the detail must not repeat it -- and
  // the comparison the pipeline recorded has to survive the split.
  const markup = details();
  assertStringIncludes(markup, "Low confidence</span>0.60 &lt; 0.65");
  assert(!markup.includes("Low confidence: 0.60"));
});

Deno.test("an unrecognised rejection reason is shown whole", () => {
  // The fallback badge must not cut a sentence it does not understand.
  const odd = {
    ...RUN,
    rejectedGenes: {
      ...RUN.rejectedGenes,
      items: [{
        ...RUN.rejectedGenes.items[0],
        reasons: ["Something the encoding has never seen"],
      }],
    },
  };
  const markup = renderToString(<PipelineRunDetails run={odd} />);
  assertStringIncludes(
    markup,
    "Error</span>Something the encoding has never seen",
  );
});

Deno.test("a rejected gene's PMID links to the paper like an accepted one's", () => {
  const links = details().match(/pubmed\.ncbi\.nlm\.nih\.gov\/32517579\//g) ??
    [];
  // Once from the rejected card, once from the paper row.
  assertEquals(links.length, 2);
});

Deno.test("a gene's Mendelian randomization support is shown when it has it", () => {
  // Recorded on every gene and rendered on none. "Yes" only: "No" on
  // every row would be noise.
  const before = details();
  assert(!before.includes("Mendelian randomization</span>Yes"));
  const supported = {
    ...RUN,
    acceptedGenes: {
      ...RUN.acceptedGenes,
      items: [{ ...RUN.acceptedGenes.items[0], mendelianRandomization: true }],
    },
  };
  const markup = renderToString(<PipelineRunDetails run={supported} />);
  assertStringIncludes(markup, "Mendelian randomization</span>Yes");
});

Deno.test("a paper's source reads as words, and its time is shown", () => {
  const markup = details();
  assertStringIncludes(markup, "Full text from Europe PMC");
  assert(!markup.includes(">europepmc<"));
  assertStringIncludes(markup, "11 s");
});

Deno.test("a paper with no retrievable text does not read as 'none'", () => {
  const none = {
    ...RUN,
    papersDetail: {
      ...RUN.papersDetail,
      items: [{
        ...RUN.papersDetail.items[0],
        source: "none",
        fulltext: false,
      }],
    },
  };
  const markup = renderToString(<PipelineRunDetails run={none} />);
  assertStringIncludes(markup, "No text retrieved");
  assert(!markup.includes(">none<"));
});

Deno.test("a step that did the same thing twice lists it twice", () => {
  // A re-entered step merges its visits' actions, and two visits that
  // did the same thing produce the same sentence; a text-keyed list
  // collapsed them.
  const twice = {
    ...RUN,
    steps: [{
      ...RUN.steps[0],
      actions: ["Recorded 9 processed PMIDs", "Recorded 9 processed PMIDs"],
    }],
  };
  const markup = renderToString(<PipelineRunView run={twice} />);
  const rows = markup.match(/Recorded 9 processed PMIDs/g) ?? [];
  assertEquals(rows.length, 2);
});

Deno.test("a run that recorded no detail offers no drawer", () => {
  // A run that failed before it processed a paper records nothing for
  // the drawer to show; a trigger reading "View everything this run
  // recorded" over an empty panel is a promise it cannot keep. The
  // services it called are part of that record now, so a run with
  // nothing to show has none of those either.
  const bare = {
    ...RUN,
    papersDetail: { shown: 0, total: 0, items: [] },
    acceptedGenes: { shown: 0, total: 0, items: [] },
    rejectedGenes: { shown: 0, total: 0, items: [] },
    apis: [],
  };
  const markup = renderToString(<PipelineRunView run={bare} />);
  assert(!markup.includes("View everything this run recorded"));
  assert(!markup.includes('id="pipeline-run-drawer"'));
  // The rest of the widget is unaffected.
  assertStringIncludes(markup, "Search PubMed");
});

Deno.test("the drawer trigger sits on the title row, and the row survives without it", () => {
  // F26: the trigger used to sit at the foot of the card, ~600px from the
  // drawer's close button at the top of the same box. It now shares
  // .pipeline-title-row with the heading -- checked here as markup, since
  // a CSS-only assertion (`.pipeline-title-row` is flex with
  // space-between, see styles_contract_test.ts) would pass even if the
  // trigger were rendered anywhere else in the document, or if the row
  // wrapped nothing but itself.
  const withTrigger = renderToString(<PipelineRunView run={RUN} />);
  const rowOpen = withTrigger.indexOf('class="pipeline-title-row"');
  const rowClose = withTrigger.indexOf("</div>", rowOpen);
  assert(rowOpen > -1, "the title row renders");
  const row = withTrigger.slice(rowOpen, rowClose);
  assertStringIncludes(row, "Last Pipeline Run");
  assertStringIncludes(row, "pipeline-drawer-trigger");

  // The row's own layout must not depend on the trigger: a run with
  // nothing for the drawer to show renders the heading alone, still
  // inside .pipeline-title-row rather than the row disappearing with it.
  const bare = {
    ...RUN,
    papersDetail: { shown: 0, total: 0, items: [] },
    acceptedGenes: { shown: 0, total: 0, items: [] },
    rejectedGenes: { shown: 0, total: 0, items: [] },
    apis: [],
  };
  const withoutTrigger = renderToString(<PipelineRunView run={bare} />);
  const bareRowOpen = withoutTrigger.indexOf('class="pipeline-title-row"');
  assert(bareRowOpen > -1, "the title row still renders with no trigger");
  const bareRowClose = withoutTrigger.indexOf("</div>", bareRowOpen);
  const bareRow = withoutTrigger.slice(bareRowOpen, bareRowClose);
  assertStringIncludes(bareRow, "Last Pipeline Run");
  assert(!bareRow.includes("pipeline-drawer-trigger"));
});

Deno.test("the external services list is in the drawer, not on the card", () => {
  // Endpoint paths and HTTP verbs are a maintainer's register, and the
  // card sits above a Data Sources panel that names the same class of
  // thing in prose.
  const markup = html();
  const drawerAt = markup.indexOf('id="pipeline-run-drawer"');
  const servicesAt = markup.indexOf("External services");
  assert(drawerAt > -1, "the drawer renders");
  assertEquals(servicesAt, -1, "closed drawer defers its details");
  assertStringIncludes(details(), "External services");
});

Deno.test("a run that reached only an API still has a drawer", () => {
  // The services moved into the drawer, so they are on their own enough
  // of a record to open it.
  const apisOnly = {
    ...RUN,
    papersDetail: { shown: 0, total: 0, items: [] },
    acceptedGenes: { shown: 0, total: 0, items: [] },
    rejectedGenes: { shown: 0, total: 0, items: [] },
  };
  const markup = renderToString(<PipelineRunView run={apisOnly} />);
  assertStringIncludes(markup, "View everything this run recorded");
  assertStringIncludes(
    renderToString(<PipelineRunDetails run={apisOnly} />),
    "External services",
  );
});

Deno.test("one identifier reads one way: every PMID is a chip", () => {
  // The paper rows used to carry a bare <a>, so the same PMID rendered
  // ember at 16px in one drawer section and indigo at 13px in another.
  const anchors = details().match(/<a\b[^>]*>/g) ?? [];
  const pubmed = anchors.filter((tag) =>
    tag.includes("pubmed.ncbi.nlm.nih.gov")
  );
  assert(pubmed.length > 0, "the drawer links out to PubMed");
  for (const tag of pubmed) {
    assertStringIncludes(tag, "pipeline-chip");
  }
});

Deno.test("a truncated list says so rather than reading as complete", () => {
  const markup = details();
  assertStringIncludes(markup, "Showing 1 of 24");
  assertStringIncludes(markup, "Showing 1 of 24");
  assertStringIncludes(markup, "Showing 1 of 15");
});

Deno.test("a step with nothing to expand is not a control", () => {
  // "Filter new papers" recorded no actions, warnings or error.
  assertMatch(html(), /pipeline-step-head"[^>]*disabled/);
});

Deno.test("every step header is an expandable control", () => {
  const markup = html();
  const heads = markup.match(/class="pipeline-step-head"/g) ?? [];
  assertEquals(heads.length, RUN.steps.length);
  assertStringIncludes(markup, 'aria-controls="pipeline-run-drawer-step-3"');
  assertStringIncludes(markup, 'aria-expanded="false"');
});

Deno.test("no run renders nothing at all", () => {
  assertEquals(renderToString(<PipelineRunView run={null} />), "");
});

Deno.test("the offline case omits the search count it cannot claim", () => {
  // An offline run was handed its identifiers and never searched, so
  // there is no "found" denominator to report.
  const offline = {
    ...RUN,
    papers: { ...RUN.papers, found: null, newlySeen: null, alreadySeen: null },
  };
  const markup = renderToString(<PipelineRunView run={offline} />);
  assert(!markup.includes(">Found<"));
  assertStringIncludes(markup, "Processed");
});

Deno.test("step warnings preserve the detail explaining the flagged record", () => {
  const run = {
    ...RUN,
    steps: [{
      ...RUN.steps[0],
      warnings: [{
        kind: "batch_validation",
        title: "1 batch check flagged something",
        count: 1,
        detail: "Gene NOTCH3 extracted from 4 different papers",
        subjects: [],
      }],
    }],
  };
  assertStringIncludes(
    renderToString(<PipelineRunView run={run} />),
    "Gene NOTCH3 extracted from 4 different papers",
  );
});

Deno.test("duplicate step ordinals still reference distinct detail panels", () => {
  const run = {
    ...RUN,
    steps: [RUN.steps[0], { ...RUN.steps[0], label: "Second visit" }],
  };
  const markup = renderToString(<PipelineRunView run={run} />);
  const controls = [...markup.matchAll(/aria-controls="([^"]+-step-[^"]+)"/g)]
    .map((match) => match[1]);
  assertEquals(controls.length, 2);
  assertEquals(new Set(controls).size, 2);
  for (const id of controls) {
    assertEquals(markup.split(`id="${id}"`).length - 1, 1);
  }
});

Deno.test("empty deferred details render no record sections or service inventory", () => {
  const empty = {
    ...RUN,
    acceptedGenes: { total: 0, shown: 0, items: [] },
    rejectedGenes: { total: 0, shown: 0, items: [] },
    papersDetail: { total: 0, shown: 0, items: [] },
    apis: [],
  };
  assertEquals(renderToString(<PipelineRunDetails run={empty} />), "");
});

Deno.test("deferred paper records preserve retrieval failures", () => {
  const failed = {
    ...RUN,
    papersDetail: {
      ...RUN.papersDetail,
      items: [{
        ...RUN.papersDetail.items[0],
        error: "Publisher request timed out",
      }],
    },
  };
  const markup = renderToString(<PipelineRunDetails run={failed} />);
  assertStringIncludes(markup, "Publisher request timed out");
  assertStringIncludes(markup, "Reason");
});
