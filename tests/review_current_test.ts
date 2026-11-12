import { assertEquals } from "@std/assert";

import { currentReview, REVIEW } from "../lib/review/current.ts";
import { ACCOUNTS, simulate } from "../lib/review/simulate.ts";
import { reviewState } from "../lib/review/summary.ts";
import { reviewRound } from "../lib/data/review_round.ts";
import { GOLD_ONLY } from "../lib/gold_only.ts";
import { sampleRound } from "./fixtures/review.ts";

Deno.test("there is a review only under gold-only with a round", () => {
  assertEquals(currentReview(false, sampleRound(3)), null);
  assertEquals(currentReview(true, null), null);
  assertEquals(currentReview(true, sampleRound(3))?.reviews.length, 3);
});

Deno.test("the current review is the simulated committee's state", () => {
  const round = sampleRound(5);
  assertEquals(
    currentReview(true, round),
    reviewState(round, ACCOUNTS, simulate(round)),
  );
});

Deno.test("the exported review follows the committed round", () => {
  assertEquals(REVIEW, currentReview(GOLD_ONLY, reviewRound));
});
