/**
 * The committed round is the 365-day preview run of 12 Nov 2026 measured
 * against the gold database: 80 genes changed, 15 of them new. The counts are
 * what `deno task data:preview` wrote, not estimates from the committed
 * tables, so a re-export from a different preview database shows up here.
 */
import { assert, assertEquals } from "@std/assert";

import { reviewRound } from "../../lib/data/review_round.ts";
import type { ReviewKind } from "../../lib/types.ts";

const count = (kind: ReviewKind) =>
  reviewRound!.changes.filter((c) => c.kind === kind).length;

Deno.test("the 12 Nov 2026 round", () => {
  assert(reviewRound !== null);
  assertEquals(reviewRound.runTimestamp, "2026-11-12T19:58:24.560698+00:00");
  assertEquals(reviewRound.changes.length, 80);
  assertEquals(count("new"), 15);
  assertEquals(count("claims"), 23);
  assertEquals(count("citation"), 42);
  assertEquals(reviewRound.changes[0].gene, "STN1");
});
