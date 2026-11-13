/**
 * The run details' derivations (`lib/pipeline_details.ts`).
 *
 * The dialog renders what these return: which tabs it has and what each
 * counts, how the findings group, what a paper's row says, which columns the
 * services table needs, and what Setup holds. Pinned here, against one
 * recorded run and a few lists built for the purpose, rather than read back
 * out of rendered HTML.
 */

import {
  assert,
  assertEquals,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";

import {
  apiColumns,
  confidenceMarks,
  detailTabs,
  floorLegend,
  nextTab,
  paperNotes,
  paperRows,
  rejectionGroups,
  setupMethod,
  setupUsage,
  type TabId,
} from "../lib/pipeline_details.ts";
import { formatDuration, formatPercent } from "../lib/pipeline_display.ts";
import type { RejectedGene, RunPaper } from "../lib/types.ts";
import { RUN, runWith, step, warning } from "./fixtures/pipeline_run.ts";

const held = (symbol: string): RejectedGene => ({
  symbol,
  pmid: null,
  confidence: 0.5,
  reasons: ["Held below the insert floor: 0.50 < 0.65 (new gene)"],
});
const low = (symbol: string): RejectedGene => ({
  symbol,
  pmid: "42942992",
  confidence: 0.2,
  reasons: ["Low confidence: 0.20 < 0.45"],
});
const paper = (patch: Partial<RunPaper>): RunPaper => ({
  pmid: "42000001",
  source: "europepmc",
  fulltext: true,
  geneCount: 0,
  rejectedCount: 0,
  processingSeconds: 41,
  error: null,
  extractionModel: RUN.config.model,
  refusal: null,
  ...patch,
});
const list = <T>(items: T[], total = items.length) => ({
  shown: items.length,
  total,
  items,
});

Deno.test("a tab exists only when there is something in it, and Setup always does", () => {
  const empty = runWith({
    acceptedGenes: list([]),
    rejectedGenes: list([]),
    papersDetail: list([]),
    apis: [],
  });
  assertEquals(detailTabs(empty), [{
    id: "setup",
    label: "Setup",
    count: null,
  }]);
  // A count is the list's total, not how many of it the report holds.
  const full = runWith({
    rejectedGenes: list([held("GENE1")], 22),
    acceptedGenes: list([], 10),
  });
  assertEquals(detailTabs(full), [
    { id: "findings", label: "Findings", count: 32 },
    { id: "papers", label: "Papers", count: RUN.papersDetail.total },
    { id: "services", label: "Services", count: RUN.apis.length },
    { id: "setup", label: "Setup", count: null },
  ]);
});

Deno.test("the arrow keys walk the tabs and wrap", () => {
  const tabs: TabId[] = ["findings", "papers", "setup"];
  assertEquals(nextTab(tabs, "findings", "ArrowRight"), "papers");
  assertEquals(nextTab(tabs, "setup", "ArrowRight"), "findings");
  assertEquals(nextTab(tabs, "findings", "ArrowLeft"), "setup");
  assertEquals(nextTab(tabs, "papers", "Home"), "findings");
  assertEquals(nextTab(tabs, "papers", "End"), "setup");
  assertEquals(nextTab(tabs, "papers", "a"), "papers");
});

Deno.test("rejections group by kind, in the encoding's order, under their own headings", () => {
  const groups = rejectionGroups(
    runWith({
      rejectedGenes: list([held("GENE1"), low("GENE2"), held("GENE3")]),
    }),
  );
  assertEquals(groups.map((g) => [g.kind, g.heading, g.count]), [
    ["low_confidence", "Under the confidence floor", 1],
    ["insert_floor", "Held for more evidence", 2],
  ]);
  assertEquals(groups[1].items.map((gene) => gene.symbol), ["GENE1", "GENE3"]);
});

Deno.test("a capped list gives its groups no count", () => {
  // The kinds are cut from the items the report holds, so past the cap a
  // group's size is not its total, and printing it would read as one.
  const groups = rejectionGroups(
    runWith({ rejectedGenes: list([held("GENE1")], 1412) }),
  );
  assertEquals(groups[0].count, null);
});

Deno.test("a finding with several reasons sits with its first, and one with none is an error", () => {
  const both = {
    ...low("GENE1"),
    reasons: ["Low confidence: 0.30 < 0.45", "Quote not found in the paper"],
  };
  const none = { ...low("GENE2"), reasons: [] };
  assertEquals(
    rejectionGroups(runWith({ rejectedGenes: list([both, none]) })).map((g) => [
      g.kind,
      g.heading,
    ]),
    [["low_confidence", "Under the confidence floor"], ["error", "Error"]],
  );
});

Deno.test("an errored paper leads, and each row says who read it", () => {
  const run = runWith({
    config: { ...RUN.config, fallbackModel: "fallback-model" },
    papersDetail: list([
      paper({ pmid: "1" }),
      paper({ pmid: "2", extractionModel: "fallback-model", refusal: "bio" }),
      paper({
        pmid: "3",
        extractionModel: null,
        refusal: "bio",
        error: "Refused",
        processingSeconds: null,
      }),
      paper({ pmid: "4", extractionModel: null }),
      // No text was retrieved, so no model ran: nobody read it. It does
      // not lead, since it is not an error.
      paper({
        pmid: "5",
        source: "none",
        fulltext: false,
        extractionModel: null,
      }),
    ]),
  });
  const { rows, declinedColumn, written } = paperRows(run);
  assertEquals(
    rows.map((r) => [r.paper.pmid, r.readBy, r.declinedBy, r.time]),
    [
      ["3", "unread", "Biology safety classifier", null],
      ["1", "primary", null, formatDuration(41)],
      ["2", "fallback", "Biology safety classifier", formatDuration(41)],
      // A report from before the model was recorded per paper: the run's.
      ["4", "primary", null, formatDuration(41)],
      ["5", "unread", null, formatDuration(41)],
    ],
  );
  assert(declinedColumn && written);
  const plain = paperRows(
    runWith({ database: null, papersDetail: list([paper({})]) }),
  );
  assert(!plain.declinedColumn && !plain.written);
});

Deno.test("the fallback story is the run's own two notes", () => {
  const run = runWith({
    steps: [
      step({
        warnings: [
          warning("genes_rejected"),
          warning("model_fallback", 34),
          warning("paper_refused"),
        ],
      }),
    ],
  });
  assertEquals(paperNotes(run).map((w) => w.kind), [
    "model_fallback",
    "paper_refused",
  ]);
  assertEquals(paperNotes(RUN), []);
});

Deno.test("a trouble column appears only when a service had that trouble", () => {
  assertEquals(apiColumns(RUN.apis), {
    retried: true,
    notFound: false,
    failed: true,
  });
  assertEquals(apiColumns([{ ...RUN.apis[0], notFound: 2 }]).notFound, true);
  assertEquals(apiColumns([]), {
    retried: false,
    notFound: false,
    failed: false,
  });
});

Deno.test("the track marks the floors the run recorded", () => {
  assertEquals(confidenceMarks(RUN.config), [0.45, 0.65]);
  assertEquals(
    confidenceMarks({ ...RUN.config, confidenceThresholdUpdate: null }),
    [0.65],
  );
  assertEquals(
    confidenceMarks({
      ...RUN.config,
      confidenceThresholdUpdate: null,
      confidenceThresholdInsert: null,
    }),
    [],
  );
});

Deno.test("Setup states the method, and leaves out what the run did not record", () => {
  assertEquals(setupMethod(RUN), [
    { label: "Mode", value: "PubMed search", sub: null, code: false },
    { label: "Model", value: "claude-opus-5", sub: "high effort", code: false },
    { label: "Prompt", value: "v6", sub: null, code: false },
    {
      label: "Confidence floors",
      value: "0.45 to update, 0.65 to add",
      sub: null,
      code: false,
    },
  ]);
  const full = runWith({
    config: {
      ...RUN.config,
      fallbackModel: "f",
      disease: "d",
      promptSha256: "abc",
      skipValidation: true,
      dryRun: true,
      batch: true,
      confidenceThresholdUpdate: null,
    },
  });
  assertEquals(setupMethod(full).map((r) => [r.label, r.value, r.sub]), [
    ["Mode", "PubMed search", null],
    ["Model", "claude-opus-5", "high effort, Batch API"],
    ["Fallback model", "f", null],
    ["Prompt", "v6", "d abc"],
    ["Confidence floors", "0.65 to add", null],
    ["Validation", "Skipped", null],
    ["Dry run", "Nothing was written", null],
  ]);
  assert(setupMethod(full)[3].code, "the prompt's bytes are set as code");
  const bare = runWith({
    config: {
      ...RUN.config,
      model: null,
      effort: null,
      promptVersion: null,
      confidenceThresholdUpdate: null,
      confidenceThresholdInsert: null,
    },
  });
  assertEquals(setupMethod(bare).map((r) => r.label), ["Mode"]);
  // A batched run whose effort was never recorded still says it was batched.
  const batched = runWith({
    config: { ...RUN.config, effort: null, batch: true },
  });
  assertEquals(setupMethod(batched)[1].sub, "Batch API");
  assertEquals(
    setupMethod(runWith({ config: { ...RUN.config, effort: null } }))[1].sub,
    null,
  );
  // The floor a run recorded alone is still stated.
  assertEquals(
    setupMethod(
      runWith({ config: { ...RUN.config, confidenceThresholdInsert: null } }),
    )[3].value,
    "0.45 to update",
  );
});

Deno.test("Setup states the usage and the checks, and never the cost", () => {
  const usage = setupUsage(RUN);
  assertEquals(usage.map((r) => r.label), [
    "Duration",
    "Tokens",
    "Source quotes",
  ]);
  assertEquals(usage[0], {
    label: "Duration",
    value: formatDuration(RUN.durationSeconds),
    sub: `${formatDuration(RUN.computeSeconds)} of work, run in parallel`,
    code: false,
  });
  assertEquals(usage[1].value, "175,584");
  assertEquals(
    usage[1].sub,
    `153,712 in, 21,872 out, ${
      formatPercent(RUN.tokens.cacheHitRate)
    } of input served from cache`,
  );
  assertEquals(usage[2], {
    label: "Source quotes",
    value: "25 of 26 found in their paper",
    sub: "8 attested by the model's own citations",
    code: false,
  });
  assertNotMatch(JSON.stringify([setupMethod(RUN), usage]), /1\.38|cost/i);

  const cached = runWith({
    tokens: { ...RUN.tokens, cacheCreationInputTokens: 1200 },
  });
  assertStringIncludes(
    setupUsage(cached)[1].sub ?? "",
    "1,200 written to cache",
  );
  const none = runWith({
    tokens: { ...RUN.tokens, cacheCreationInputTokens: 0 },
  });
  assertNotMatch(setupUsage(none)[1].sub ?? "", /written to cache/);

  const bare = runWith({
    genes: { ...RUN.genes, quotesChecked: 0 },
    tokens: { ...RUN.tokens, totalTokens: 0 },
  });
  assertEquals(setupUsage(bare).map((r) => r.label), ["Duration"]);
});

Deno.test("Setup prints the work under the duration only when it was measured", () => {
  // No paper was timed: a sum of nothing is not "0 ms of work".
  assertEquals(setupUsage(runWith({ computeSeconds: 0 }))[0], {
    label: "Duration",
    value: formatDuration(RUN.durationSeconds),
    sub: null,
    code: false,
  });
  // A batch entry is never timed, so on a batch run the sum holds only the
  // papers the fallback rescued, which is not the run's work.
  const batch = runWith({ config: { ...RUN.config, batch: true } });
  assertEquals(setupUsage(batch)[0].sub, null);
  const streamed = runWith({ config: { ...RUN.config, batch: false } });
  assertEquals(
    setupUsage(streamed)[0].sub,
    `${formatDuration(RUN.computeSeconds)} of work, run in parallel`,
  );
});

Deno.test("the legend says what the track's marks are, for the floors the run recorded", () => {
  assertEquals(
    floorLegend(RUN.config),
    "Marked at the floors: 0.45 to update a known gene, 0.65 to add a new one",
  );
  assertEquals(
    floorLegend({ ...RUN.config, confidenceThresholdUpdate: null }),
    "Marked at the floors: 0.65 to add a new one",
  );
  assertEquals(
    floorLegend({ ...RUN.config, confidenceThresholdInsert: null }),
    "Marked at the floors: 0.45 to update a known gene",
  );
  assertEquals(
    floorLegend({
      ...RUN.config,
      confidenceThresholdUpdate: null,
      confidenceThresholdInsert: null,
    }),
    null,
  );
});
