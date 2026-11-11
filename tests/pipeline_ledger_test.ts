/**
 * The run card's derivations (`lib/pipeline_ledger.ts`).
 *
 * The card renders what these return and decides nothing itself, so what a
 * step's row says, what counts as "to review" and what the verdict row holds
 * are pinned here, against one recorded run, rather than read back out of
 * rendered HTML.
 */

import { assert, assertEquals } from "@std/assert";

import {
  counted,
  isOpenable,
  isPmid,
  isReview,
  reviewCount,
  splitSubjects,
  stepFlag,
  stepOutcome,
} from "../lib/pipeline_ledger.ts";
import { RUN, runWith, step, warning } from "./fixtures/pipeline_run.ts";

const seg = (value: string | null, text: string) => ({ value, text });
const at = (key: string) => RUN.steps.findIndex((s) => s.key === key);

Deno.test("a count takes its noun's number", () => {
  assertEquals(counted(1, "gene"), "1 gene");
  assertEquals(counted(1412, "finding"), "1,412 findings");
});

Deno.test("a kind the encoding has never seen needs a look", () => {
  assert(isReview("paper_refused"));
  assert(!isReview("model_fallback"));
  assert(isReview("something_new"));
});

Deno.test("to review counts notes, not the things they name", () => {
  // RUN: genes_rejected (24, routine) and paper_retrieval_failed (1, review).
  assertEquals(reviewCount(RUN), 1);
});

Deno.test("a step's flag names one thing, counts several, and says Failed", () => {
  assertEquals(stepFlag(step({ warnings: [warning("paper_refused", 2)] })), {
    tint: "ember",
    icon: "exclamationTriangle",
    label: "2 papers declined",
  });
  assertEquals(
    stepFlag(step({ warnings: [warning("paper_refused")] }))?.label,
    "1 paper declined",
  );
  assertEquals(
    stepFlag(
      step({
        warnings: [warning("paper_refused"), warning("batch_validation")],
      }),
    )?.label,
    "2 to review",
  );
  assertEquals(
    stepFlag(step({ warnings: [warning("something_new")] }))?.label,
    "1 to review",
  );
  assertEquals(
    stepFlag(step({ warnings: [warning("model_fallback", 34)] })),
    null,
  );
  assertEquals(stepFlag(step({ status: "failed" })), {
    tint: "danger",
    icon: "xCircle",
    label: "Failed",
  });
});

Deno.test("each known step reads out the run's own counts", () => {
  assertEquals(stepOutcome(RUN, at("searching_pubmed")), {
    lines: [[seg("40", "papers matched")]],
    quiet: false,
  });
  assertEquals(stepOutcome(RUN, at("filtering_pmids")).lines, [
    [seg("16", "new"), seg("24", "seen before")],
  ]);
  assertEquals(stepOutcome(RUN, at("processing_papers")).lines, [
    [seg("15", "read"), seg(null, "10 full text, 5 abstract only, 1 no text")],
    [
      seg("50", "findings extracted"),
      seg(null, "26 passed validation, 24 rejected"),
    ],
  ]);
  assertEquals(stepOutcome(RUN, at("merging_database")).lines, [
    [
      seg("3", "genes added"),
      seg("21", "updated"),
      seg("2", "findings held for more evidence"),
    ],
  ]);
});

Deno.test("failed papers are a part of the row, and zero parts are left out", () => {
  const run = runWith({
    papers: { ...RUN.papers, noTextAvailable: 0, failed: 1 },
    genes: { ...RUN.genes, rejectedAtInsertFloor: 0 },
    database: { inserted: 1, updated: 0 },
  });
  assertEquals(
    stepOutcome(run, at("processing_papers")).lines[0][1].text,
    "10 full text, 5 abstract only, 1 failed",
  );
  assertEquals(stepOutcome(run, at("merging_database")).lines, [
    [seg("1", "gene added"), seg("0", "updated")],
  ]);
});

Deno.test("the cross-check counts findings", () => {
  const run = runWith({ steps: [step({ key: "batch_validation" })] });
  assertEquals(stepOutcome(run, 0).lines, [
    [seg("26", "findings cross-checked")],
  ]);
});

Deno.test("a row falls back to the step's own sentences", () => {
  const offline = runWith({
    papers: { ...RUN.papers, found: null, newlySeen: null, alreadySeen: null },
  });
  assertEquals(stepOutcome(offline, at("searching_pubmed")), {
    lines: [[
      seg(null, "Searched PubMed over the last 7 days: 40 papers matched"),
    ]],
    quiet: true,
  });
  // The filter step recorded no sentence, so it has nothing to fall back to.
  assertEquals(stepOutcome(offline, at("filtering_pmids")).lines, [
    [seg(null, "Nothing to report")],
  ]);
  const twice = runWith({
    steps: [RUN.steps[0], {
      ...RUN.steps[0],
      actions: ["Searched again", "And again"],
    }],
  });
  assertEquals(stepOutcome(twice, 1).lines, [
    [seg(null, "Searched again. And again")],
  ]);
  const unknown = runWith({
    steps: [step({ key: "something_new", actions: [] })],
  });
  assertEquals(stepOutcome(unknown, 0), {
    lines: [[seg(null, "Nothing to report")]],
    quiet: true,
  });
  const unwritten = runWith({ database: null });
  assert(stepOutcome(unwritten, at("merging_database")).quiet);
  // Finalizing has no readout of its own: it says what it did, or nothing.
  assert(stepOutcome(runWith({ steps: [step()] }), 0).quiet);
});

Deno.test("a step that was not reached says so", () => {
  const run = runWith({
    steps: [step({ key: "merging_database", status: "skipped" })],
  });
  assertEquals(stepOutcome(run, 0), {
    lines: [[seg(null, "Not reached")]],
    quiet: true,
  });
});

Deno.test("a row opens only on a note or an error", () => {
  assert(!isOpenable(step({ actions: ["Did a thing"] })));
  assert(isOpenable(step({ warnings: [warning("model_fallback")] })));
  assert(isOpenable(RUN.steps[at("merging_database")]));
});

Deno.test("subjects past the eighth wait behind a disclosure", () => {
  const ten = Array.from({ length: 10 }, (_, i) => String(40000000 + i));
  assertEquals(splitSubjects(ten).shown.length, 8);
  assertEquals(splitSubjects(ten).rest.length, 2);
  assertEquals(splitSubjects(["GENE1"]), { shown: ["GENE1"], rest: [] });
  assert(isPmid("42169653"));
  assert(!isPmid("GENE1"));
});
