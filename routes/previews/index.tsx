import { define } from "../../utils.ts";
import { Icon } from "../../components/Icon.tsx";
import { Page } from "../../components/Page.tsx";
import ReviewRequest from "../../islands/ReviewRequest.tsx";
import { PREVIEWS_LABEL, PREVIEWS_LEAD } from "../../lib/previews.ts";
import type { PreviewFeature } from "../../lib/previews.ts";
import { PREVIEWS } from "../../lib/previews_current.ts";
import { ENTER_OBSERVER } from "../../lib/review/copy.ts";

/**
 * A card's way in. The review has two: an observer goes straight in, and a
 * would-be member asks for an account, which is where the committee's way in
 * is explained.
 */
function PreviewActions({ feature }: { feature: PreviewFeature }) {
  switch (feature.key) {
    case "pipeline":
      return (
        <a class="review-action review-action-primary" href={feature.href}>
          Open the pipeline run
        </a>
      );
    case "adapt":
      return (
        <a class="review-action review-action-primary" href={feature.href}>
          Open the adaptation guide
        </a>
      );
    case "review":
      return (
        <>
          <a class="review-action review-action-primary" href={feature.href}>
            {ENTER_OBSERVER}
          </a>
          <ReviewRequest />
        </>
      );
  }
}

/**
 * The hub: one card per feature on offer, in the strip's order. It draws no
 * strip of its own, being where the strip leads back to.
 */
export function PreviewsHub(
  { features }: { features: readonly PreviewFeature[] },
) {
  return (
    <Page contained title={PREVIEWS_LABEL} description={PREVIEWS_LEAD}>
      <div class="preview-cards">
        {features.map((f) => (
          <section
            key={f.key}
            class="card preview-card"
            aria-labelledby={`preview-card-${f.key}`}
          >
            <div class="card-body">
              <h2 class="card-title" id={`preview-card-${f.key}`}>
                <Icon name={f.icon} />
                {f.title}
              </h2>
              <p class="preview-card-text">{f.summary}</p>
              <div class="preview-card-actions">
                <PreviewActions feature={f} />
              </div>
            </div>
          </section>
        ))}
      </div>
    </Page>
  );
}

/** The features that work today and are still in preview. */
export default define.page(function PreviewsPage() {
  return <PreviewsHub features={PREVIEWS} />;
});
