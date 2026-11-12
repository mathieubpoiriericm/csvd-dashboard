/**
 * The review the pages show. Server code: it is the one module here that reads
 * the committed round, so a browser island must not import it.
 */

import { GOLD_ONLY } from "../gold_only.ts";
import { reviewRound } from "../data/review_round.ts";
import type { ReviewRound } from "../types.ts";
import { reviewState } from "./summary.ts";
import type { ReviewState } from "./summary.ts";
import { ACCOUNTS, simulate } from "./simulate.ts";

/** There is a review only while gold-only holds and a round exists. */
export function currentReview(
  goldOnly: boolean,
  round: ReviewRound | null,
): ReviewState | null {
  if (!goldOnly || round === null) return null;
  return reviewState(round, ACCOUNTS, simulate(round));
}

export const REVIEW: ReviewState | null = currentReview(GOLD_ONLY, reviewRound);
