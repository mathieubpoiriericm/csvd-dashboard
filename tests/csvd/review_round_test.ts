/**
 * The committed round is the 365-day preview run of 12 Nov 2026 measured
 * against the gold database: 80 genes changed, 15 of them new. The counts are
 * what `deno task data:preview` wrote, not estimates from the committed
 * tables, so a re-export from a different preview database shows up here.
 */
import { assert, assertEquals } from "@std/assert";

import { reviewRound } from "../../lib/data/review_round.ts";
import { FIELD_LABELS, proposalLine } from "../../lib/review/display.ts";
import { ACCOUNTS, simulate } from "../../lib/review/simulate.ts";
import { reviewState } from "../../lib/review/summary.ts";
import type { ReviewKind } from "../../lib/types.ts";

const count = (kind: ReviewKind) =>
  reviewRound!.changes.filter((c) => c.kind === kind).length;

Deno.test("the 12 Nov 2026 round", () => {
  assert(reviewRound !== null);
  assertEquals(reviewRound.runTimestamp, "2026-11-12T19:58:24.560698+00:00");
  assertEquals(reviewRound.changes.length, 80);
  assertEquals(count("new"), 15);
  assertEquals(count("claims"), 23);
  assertEquals(count("citation_protein"), 13);
  assertEquals(count("citation"), 29);
  // The run replaced 20 curated proteins (the merge then read a protein
  // equal to the symbol as a placeholder): 13 beside a citation alone, 7
  // in changes whose claims changed too.
  assertEquals(
    reviewRound!.changes.filter((c) =>
      c.fields.some((f) => f.field === "protein")
    ).length,
    20,
  );
  assertEquals(reviewRound.changes[0].gene, "STN1");
});

Deno.test("the queue's line names every changed field of the round", () => {
  for (const change of reviewRound!.changes) {
    const line = proposalLine(change).toLowerCase();
    for (const f of change.fields) {
      if (f.field === "sourceQuote" || f.field === "confidence") continue;
      const label = FIELD_LABELS[f.field].toLowerCase();
      const added = `+${f.added.length} ${label.slice(0, 4)}`;
      assert(
        line.includes(`${label} changed`) ||
          (f.added.length > 0 && line.includes(added)),
        `${change.gene}: "${proposalLine(change)}" omits ${label}`,
      );
    }
  }
});

Deno.test("the simulated review of the round is about half settled", () => {
  const round = reviewRound!;
  const s = reviewState(round, ACCOUNTS, simulate(round)).summary;
  assertEquals(
    [
      s.accepted,
      s.rejected,
      s.conflict,
      s.inReview,
      s.notStarted,
      s.noQuorum,
      s.editsToReconcile,
      s.resolvedByChair,
    ],
    [35, 1, 1, 41, 1, 1, 6, 1],
  );
});
