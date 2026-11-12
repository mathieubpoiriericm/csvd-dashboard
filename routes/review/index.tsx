import { HttpError } from "fresh";

import { define } from "../../utils.ts";
import { Page } from "../../components/Page.tsx";
import { ReviewNotice } from "../../components/review/ReviewNotice.tsx";
import {
  KINDS,
  ReviewQueue,
  STANDINGS,
} from "../../components/review/ReviewQueue.tsx";
import { REVIEW } from "../../lib/review/current.ts";
import type { Standing } from "../../lib/review/rules.ts";
import type { ReviewState } from "../../lib/review/summary.ts";
import type { ReviewKind } from "../../lib/types.ts";

interface QueueFilters {
  kind: ReviewKind | null;
  standing: Standing | null;
}

/**
 * The filters a queue URL asks for. A value the queue does not know is
 * dropped rather than refused: a stale or mistyped link still opens the
 * queue, unfiltered on that row.
 */
export function queueFilters(params: URLSearchParams): QueueFilters {
  const kind = params.get("kind");
  const standing = params.get("standing");
  return {
    kind: KINDS.find((k) => k === kind) ?? null,
    standing: STANDINGS.find((s) => s === standing) ?? null,
  };
}

/** The queue page itself, from a review and the two filters. */
export function ReviewQueueContent(
  { state, kind, standing }: { state: ReviewState } & QueueFilters,
) {
  return (
    <Page
      title="Review queue"
      description="Every gene the pipeline run changed, one row each, with the committee's standing on it."
    >
      <ReviewNotice />
      <ReviewQueue state={state} kind={kind} standing={standing} />
    </Page>
  );
}

/**
 * The review queue. Server-rendered with no island: the filters are links,
 * and the round is read here, never in the browser. There is no queue while
 * there is no review.
 */
export default define.page(function ReviewQueuePage(ctx) {
  if (REVIEW === null) throw new HttpError(404);
  return (
    <ReviewQueueContent
      state={REVIEW}
      {...queueFilters(ctx.url.searchParams)}
    />
  );
});
