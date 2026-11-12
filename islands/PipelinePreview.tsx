/**
 * The gold-only notice on the About page, and the switch that shows the
 * pipeline run widget beneath it as a technical preview.
 *
 * While `GOLD_ONLY` is on no run fed what the page shows, so the run widget
 * is not part of the page; a visitor who wants to see what the pipeline
 * does can still switch it on. The switch is off by default and remembered
 * in a cookie (`lib/pipeline_preview.ts`) that the route reads, so the
 * server draws the page the visitor left rather than flashing it closed.
 *
 * With no run recorded there is nothing to preview, and the notice is the
 * plain line it was before the switch existed.
 *
 * The widget renders inside this island as an ordinary component: Fresh
 * marks only the outermost island for hydration, so `PipelineRunView`
 * passes no props across the boundary and still reads `pipelineRun`
 * itself on the client.
 */

import { useEffect, useState } from "preact/hooks";

import PipelineRunView from "./PipelineRun.tsx";
import { pipelineRun } from "../lib/data/pipeline_run.ts";
import { GOLD_ONLY_NOTICE } from "../lib/gold_only.ts";
import {
  previewCookie,
  previewInvitation,
  previewNote,
} from "../lib/pipeline_preview.ts";
import type { PipelineRun } from "../lib/types.ts";

interface PipelinePreviewProps {
  /** What the visitor's cookie asked for. */
  initialOn: boolean;
  /**
   * Injectable for tests only. The route passes `initialOn` alone: a run
   * report does not survive Fresh's serialisation of island props, which
   * leaves the island drawn and never live (islands/CLAUDE.md).
   */
  run?: PipelineRun | null;
}

export default function PipelinePreview(
  { initialOn, run = pipelineRun }: PipelinePreviewProps,
) {
  const [on, setOn] = useState(initialOn && run !== null);
  // The server's HTML cannot act on a press, so the switch is disabled
  // until this island is live; enabled from the start, a press before
  // hydration would reach no state and do nothing.
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);

  if (run === null) {
    return (
      <p class="notice notice-neutral about-gold-notice">{GOLD_ONLY_NOTICE}</p>
    );
  }

  const daysBack = run.config.daysBack;
  const toggle = () => {
    const next = !on;
    setOn(next);
    document.cookie = previewCookie(next);
  };

  return (
    <>
      <div class="notice notice-neutral about-gold-notice has-preview">
        <div class="about-gold-text">
          <p>{GOLD_ONLY_NOTICE}</p>
          <p class="about-preview-line">
            {on ? previewNote(daysBack) : previewInvitation(daysBack)}
          </p>
        </div>
        {
          /* `aria-checked` as a string: the server renderer drops an aria
            attribute whose value is boolean `false`, and hydration does
            not put it back (islands/CLAUDE.md). */
        }
        <button
          type="button"
          role="switch"
          class="about-preview-switch"
          aria-checked={on ? "true" : "false"}
          aria-label="Technical preview of a pipeline run"
          disabled={!live}
          onClick={toggle}
        >
        </button>
      </div>
      {on && <PipelineRunView run={run} preview />}
    </>
  );
}
