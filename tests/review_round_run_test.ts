/**
 * The committed round and the committed run report come from one preview
 * export, so they must describe the same run: the round's new genes are the
 * rows the run inserted, its changes every row it wrote. A round exported
 * from a different preview database than the report would disagree here.
 *
 * Generic: both files are `null` in a repository with no preview run, and the
 * review is `null` whenever gold-only is off, so each test returns early then.
 */
import { assert, assertEquals } from "@std/assert";

import { pipelineRun } from "../lib/data/pipeline_run.ts";
import { reviewRound } from "../lib/data/review_round.ts";
import { REVIEW } from "../lib/review/current.ts";
import type { Standing } from "../lib/review/rules.ts";

Deno.test("the round and the run report describe one run", () => {
  if (reviewRound === null || pipelineRun === null) return;
  const database = pipelineRun.database;
  assert(database !== null, "a round needs a run that wrote the database");
  assertEquals(reviewRound.runTimestamp, pipelineRun.runTimestamp);
  assertEquals(
    reviewRound.changes.filter((c) => c.kind === "new").length,
    database.inserted,
  );
  assertEquals(
    reviewRound.changes.length,
    database.inserted + database.updated,
  );
  // A finding for a row the run left unchanged is dropped, so at most the
  // total.
  assert(
    reviewRound.changes.flatMap((c) => c.findings).length <=
      pipelineRun.acceptedGenes.total,
  );
  assert(reviewRound.changes.every((c) => c.findings.length > 0));
});

Deno.test("the simulated review of the committed round shows every standing", () => {
  if (REVIEW === null) return;
  const standings: Standing[] = [
    "not_started",
    "in_review",
    "conflict",
    "accepted",
    "rejected",
    "no_quorum",
  ];
  const shown = new Set(REVIEW.reviews.map((r) => r.standing));
  for (const standing of standings) {
    assert(shown.has(standing), `no review stands at ${standing}`);
  }
  assert(REVIEW.reviews.some((r) => r.editsToReconcile));
  assert(REVIEW.reviews.some((r) => r.resolvedByChair));
});
