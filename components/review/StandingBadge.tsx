import { STANDING_LABELS } from "../../lib/review/display.ts";
import type { GeneReview } from "../../lib/review/rules.ts";

/**
 * The committee's standing on a gene as a pill, and one more pill for each
 * flag it carries. Each pill says its state in words; the tint only repeats
 * it.
 */
export function StandingBadge({ review }: { review: GeneReview }) {
  return (
    <span class="review-badges">
      <span class={`review-badge review-standing-${review.standing}`}>
        {STANDING_LABELS[review.standing]}
      </span>
      {review.editsToReconcile && (
        <span class="review-badge review-flag-edits">Edits to reconcile</span>
      )}
      {review.resolvedByChair && (
        <span class="review-badge review-flag-chair">Resolved by chair</span>
      )}
    </span>
  );
}
