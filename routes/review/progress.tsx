import { HttpError } from "fresh";
import type { ComponentChildren } from "preact";

import { define } from "../../utils.ts";
import { Page } from "../../components/Page.tsx";
import { PreviewSwitcher } from "../../components/PreviewSwitcher.tsx";
import { MembersTable } from "../../components/review/MembersTable.tsx";
import { ProgressKpis } from "../../components/review/ProgressKpis.tsx";
import { ReviewNotice } from "../../components/review/ReviewNotice.tsx";
import { StandingBars } from "../../components/review/StandingBars.tsx";
import { PREVIEWS } from "../../lib/previews_current.ts";
import { REVIEW } from "../../lib/review/current.ts";
import type { ReviewState } from "../../lib/review/summary.ts";

/** The progress page itself, from a review, under the strip in `before`. */
export function ReviewProgressContent(
  { state, before }: { state: ReviewState; before?: ComponentChildren },
) {
  return (
    <Page
      before={before}
      title="Committee progress"
      description="The state of the whole review, where the genes stand by kind of change, and each member's progress."
    >
      <ReviewNotice runTimestamp={state.round.runTimestamp} />
      <ProgressKpis summary={state.summary} />
      <StandingBars summary={state.summary} />
      <MembersTable
        summary={state.summary}
        runTimestamp={state.round.runTimestamp}
      />
    </Page>
  );
}

/**
 * The committee's progress. Server-rendered with no island, like the queue
 * and the gene page; there is no progress while there is no review.
 */
export default define.page(function ReviewProgressPage() {
  if (REVIEW === null) throw new HttpError(404);
  return (
    <ReviewProgressContent
      state={REVIEW}
      before={
        <PreviewSwitcher features={PREVIEWS} pathname="/review/progress" />
      }
    />
  );
});
