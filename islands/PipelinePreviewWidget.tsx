/**
 * The run widget as the server draws it for a visitor whose cookie has the
 * technical preview switched on.
 *
 * The route renders this island directly after the gold-only notice
 * (`PipelinePreview`) only when the preview is on, so its chunk, and the
 * run report the widget imports, are fetched only on a page that shows
 * them. It follows the switch through `observePreview` rather than through
 * props or shared state: the two islands hydrate apart, and neither
 * imports the other.
 */

import { useEffect, useState } from "preact/hooks";

import PipelineRunView from "./PipelineRun.tsx";
import { observePreview } from "../lib/pipeline_preview.ts";
import type { PipelineRun } from "../lib/types.ts";

interface PipelinePreviewWidgetProps {
  /**
   * Injectable for tests only. The route renders this island with no props:
   * a run report does not survive Fresh's serialisation of island props
   * (islands/CLAUDE.md), so the widget reads the committed one itself.
   */
  run?: PipelineRun | null;
}

export default function PipelinePreviewWidget(
  { run }: PipelinePreviewWidgetProps = {},
) {
  // Drawn only when the preview is on, so on is where it starts.
  const [on, setOn] = useState(true);
  useEffect(() => observePreview(setOn), []);
  if (!on) return null;
  return run === undefined
    ? <PipelineRunView preview />
    : <PipelineRunView run={run} preview />;
}
