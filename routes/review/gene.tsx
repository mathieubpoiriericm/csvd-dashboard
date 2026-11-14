import { HttpError } from "fresh";
import type { ComponentChildren } from "preact";

import { define } from "../../utils.ts";
import { Page } from "../../components/Page.tsx";
import { PreviewSwitcher } from "../../components/PreviewSwitcher.tsx";
import { CommitteeVotes } from "../../components/review/CommitteeVotes.tsx";
import { Findings } from "../../components/review/Findings.tsx";
import { GeneDiff } from "../../components/review/GeneDiff.tsx";
import { History } from "../../components/review/History.tsx";
import { ReviewNotice } from "../../components/review/ReviewNotice.tsx";
import { StandingBadge } from "../../components/review/StandingBadge.tsx";
import { PREVIEWS } from "../../lib/previews_current.ts";
import { REVIEW } from "../../lib/review/current.ts";
import { KIND_LABELS } from "../../lib/review/display.ts";
import type { ReviewState } from "../../lib/review/summary.ts";

/**
 * One gene's page, from a review and the gene's key. The key is matched
 * exactly, so a symbol holding a slash is found as the queue linked it; a key
 * the round does not hold is a 404, not an empty page. `before` is the
 * previews' strip.
 */
export function ReviewGeneContent(
  { state, gene, before }: {
    state: ReviewState;
    gene: string | null;
    before?: ComponentChildren;
  },
) {
  const i = state.round.changes.findIndex((c) => c.gene === gene);
  if (i < 0) throw new HttpError(404);
  const change = state.round.changes[i];
  const review = state.reviews[i];
  return (
    <Page
      before={before}
      header={
        <div class="page-header">
          {
            /* "false" outright: Fresh marks a link to an ancestor of the
              page's own path as current, and /review is one. */
          }
          <a class="review-back" href="/review" aria-current="false">
            Back to the review queue
          </a>
          <h1>{change.gene}</h1>
          <p class="review-gene-meta">
            <span>{KIND_LABELS[change.kind]}</span>
            <StandingBadge review={review} />
          </p>
        </div>
      }
    >
      <ReviewNotice runTimestamp={state.round.runTimestamp} />
      <div class="review-gene">
        <div class="review-gene-column">
          <GeneDiff change={change} />
          <Findings findings={change.findings} />
        </div>
        <div class="review-gene-column">
          <CommitteeVotes review={review} accounts={state.accounts} />
          <History
            review={review}
            accounts={state.accounts}
            runTimestamp={state.round.runTimestamp}
          />
        </div>
      </div>
    </Page>
  );
}

/**
 * One gene under review. Server-rendered with no island, like the queue: the
 * gene comes from `?g=`, and there is no gene page while there is no review.
 */
export default define.page(function ReviewGenePage(ctx) {
  if (REVIEW === null) throw new HttpError(404);
  return (
    <ReviewGeneContent
      state={REVIEW}
      gene={ctx.url.searchParams.get("g")}
      before={<PreviewSwitcher features={PREVIEWS} pathname="/review/gene" />}
    />
  );
});
