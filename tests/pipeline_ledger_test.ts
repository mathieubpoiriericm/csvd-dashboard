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
  isReview,
  reviewCount,
  stepFlag,
} from "../lib/pipeline_ledger.ts";
import { RUN, step, warning } from "./fixtures/pipeline_run.ts";

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
