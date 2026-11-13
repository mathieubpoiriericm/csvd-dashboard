/**
 * The review the pages show. Server code: it is the one module here that reads
 * the committed round and the committed genes, so a browser island must not
 * import it.
 */

import { GOLD_ONLY } from "../gold_only.ts";
import { genes } from "../data/genes.ts";
import { reviewRound } from "../data/review_round.ts";
import type { Gene, ReviewRound } from "../types.ts";
import { staleChanges } from "./stale.ts";
import { reviewState } from "./summary.ts";
import type { ReviewState } from "./summary.ts";
import { ACCOUNTS, simulate } from "./simulate.ts";

/** A round that would be shown, were it not stale. */
function shownRound(
  goldOnly: boolean,
  round: ReviewRound | null,
): ReviewRound | null {
  return goldOnly && round !== null && round.state === "open" ? round : null;
}

/**
 * There is a review only while gold-only holds and an open round exists that
 * still describes `genes`: stage 1 has no page for a promoted or closed round,
 * and a round measured against a gold since curated would show the committee
 * a "before" column that is no longer gold. Such a round fails closed rather
 * than failing the test suite, so a gold fix is never blocked on a new run.
 */
export function currentReview(
  goldOnly: boolean,
  round: ReviewRound | null,
  genes: readonly Gene[],
): ReviewState | null {
  const shown = shownRound(goldOnly, round);
  if (shown === null || staleChanges(shown, genes).length > 0) return null;
  return reviewState(shown, ACCOUNTS, simulate(shown));
}

/**
 * Says once, through `warn`, that a round which would otherwise be shown is
 * stale, and what to do about it; says nothing in every other case.
 */
export function warnIfStale(
  goldOnly: boolean,
  round: ReviewRound | null,
  genes: readonly Gene[],
  warn: (message: string) => void = console.warn,
): void {
  const shown = shownRound(goldOnly, round);
  if (shown === null) return;
  const stale = staleChanges(shown, genes);
  if (stale.length === 0) return;
  warn(
    `data/review_round.json no longer matches the gold genes in ` +
      `data/table1.json for ${stale.length} of its ${shown.changes.length} ` +
      `changes (${stale.slice(0, 5).join(", ")}${
        stale.length > 5 ? ", ..." : ""
      }), so the review area is hidden. Make a new preview run and export ` +
      `it with deno task data:preview.`,
  );
}

warnIfStale(GOLD_ONLY, reviewRound, genes);

export const REVIEW: ReviewState | null = currentReview(
  GOLD_ONLY,
  reviewRound,
  genes,
);
