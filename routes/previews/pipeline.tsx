import { HttpError } from "fresh";

import { define } from "../../utils.ts";
import { Page } from "../../components/Page.tsx";
import { PreviewSwitcher } from "../../components/PreviewSwitcher.tsx";
import PipelineRunView from "../../islands/PipelineRun.tsx";
import {
  PIPELINE_PREVIEW_PATH,
  PREVIEW_NOTE_LABEL,
  previewNote,
} from "../../lib/previews.ts";
import type { PreviewFeature } from "../../lib/previews.ts";
import { PREVIEW_RUN_DAYS_BACK, PREVIEWS } from "../../lib/previews_current.ts";

/**
 * The run's page itself: the strip, a note saying the run is a preview whose
 * findings are not in the other pages, then the widget. The island takes no
 * `run`: it reads its own report, which does not survive Fresh's props.
 */
export function PipelinePreviewContent(
  { features, daysBack }: {
    features: readonly PreviewFeature[];
    daysBack: number | null;
  },
) {
  return (
    <Page
      contained
      before={
        <PreviewSwitcher features={features} pathname={PIPELINE_PREVIEW_PATH} />
      }
      title="Pipeline run"
      description="The report of the pipeline's last preview run: what it read, what it proposed and how each step went."
    >
      <p class="notice notice-neutral preview-note">
        <strong class="note-label">{PREVIEW_NOTE_LABEL}</strong>{" "}
        {previewNote(daysBack)}
      </p>
      <PipelineRunView preview />
    </Page>
  );
}

/**
 * The last preview run's report. Offered only while gold-only holds and a
 * report is committed; with gold-only off the About page shows it as the run
 * of record, so there is no preview to give it a page of its own.
 */
export default define.page(function PipelinePreviewPage() {
  if (!PREVIEWS.some((f) => f.key === "pipeline")) throw new HttpError(404);
  return (
    <PipelinePreviewContent
      features={PREVIEWS}
      daysBack={PREVIEW_RUN_DAYS_BACK}
    />
  );
});
