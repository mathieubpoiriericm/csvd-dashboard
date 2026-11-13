/**
 * The committed round and the committed run report come from one preview
 * export, so they must describe the same run: the round's new genes are the
 * rows the run inserted, its changes every row it wrote. A round exported
 * from a different preview database than the report would disagree here.
 *
 * Generic: both files are `null` in a repository with no preview run, and the
 * review is `null` whenever gold-only is off, so each test returns early then.
 * A report without a round is legitimate (a fork with gold-only off exports
 * the report and `null` for the round); a round without its report is not.
 */
import { assert, assertEquals } from "@std/assert";

import { genes } from "../lib/data/genes.ts";
import { pipelineRun } from "../lib/data/pipeline_run.ts";
import { reviewRound } from "../lib/data/review_round.ts";
import { REVIEW } from "../lib/review/current.ts";
import type { Standing } from "../lib/review/rules.ts";

Deno.test("the round and the run report describe one run", () => {
  if (reviewRound === null) return;
  assert(
    pipelineRun !== null,
    "data/review_round.json holds a round but data/pipeline_run.json is null: the two are written together by one preview export, so commit both",
  );
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

/** What a round that no longer matches gold means, and the two ways out. */
const STALE =
  `data/review_round.json no longer matches the committed gold genes (data/table1.json): the round was measured against a gold that has since been curated, so its "before" column and its new genes are wrong. Either write null to data/review_round.json (deno task data:empty shows the form), or rebuild the preview database from gold, make a new preview run, and export it with deno task data:preview.`;

Deno.test("the round is measured against the committed gold genes", () => {
  if (reviewRound === null) return;
  const gold = new Map(genes.map((g) => [g.gene, g]));
  for (const change of reviewRound.changes) {
    if (change.kind === "new") {
      assert(
        !gold.has(change.gene),
        `${change.gene} is new but in gold. ${STALE}`,
      );
    } else {
      assertEquals(
        change.before,
        gold.get(change.gene),
        `${change.gene}. ${STALE}`,
      );
    }
  }
});
