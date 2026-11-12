import {
  ANSWER_LABELS,
  settlesWords,
  tallyWords,
} from "../../lib/review/display.ts";
import type { Account } from "../../lib/review/events.ts";
import { votes } from "../../lib/review/events.ts";
import type { GeneReview } from "../../lib/review/rules.ts";

/**
 * Each voter's current answer on the gene, in the accounts' order, with the
 * tally over them. The observer reads and never answers, so it is not a row:
 * listed, it would read as a vote still owed. While the gene is in review the
 * line under the tally says how many answers would settle it.
 */
export function CommitteeVotes(
  { review, accounts }: { review: GeneReview; accounts: readonly Account[] },
) {
  return (
    <section class="card">
      <div class="card-body">
        <h2 class="card-title">Committee</h2>
        <p class="review-tally-words">{tallyWords(review.tally)}</p>
        {review.standing === "in_review" && (
          <p class="review-settles">{settlesWords(review.tally)}</p>
        )}
        <ul class="review-votes">
          {accounts.filter(votes).map((account) => {
            const answer = review.answers.get(account.id)?.answer;
            return (
              <li key={account.id}>
                <span>
                  {account.name}
                  {account.role === "chair" && (
                    <>
                      {" "}
                      <span class="review-role">chair</span>
                    </>
                  )}
                </span>
                <span
                  class={`review-badge review-answer-${answer ?? "none"}`}
                >
                  {answer ? ANSWER_LABELS[answer] : "Not yet"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
