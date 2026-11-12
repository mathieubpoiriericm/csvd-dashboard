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
 * **This island holds no data and imports none.** It is on the page for
 * every gold-only visitor, and the run report is a protected chunk that is
 * never cached, so a static import here would put the whole report on every
 * visit whether or not anyone looks at it. The widget, and the report with
 * it, arrive one of two ways instead:
 *
 * - switched on in the page, this island fetches `PipelineRun.tsx` with a
 *   dynamic import and draws it beneath the notice;
 * - switched on already (the cookie), the route draws the widget as an
 *   island of its own, `PipelinePreviewWidget`, directly after this one,
 *   and this island only announces each press (`announcePreview`) for it
 *   to follow.
 *
 * `ON_DEMAND_ISLANDS` in `server/protected_data_build.ts` fails the build
 * if this island ever reaches a dataset through a static import again.
 */

import type { FunctionComponent } from "preact";
import { useEffect, useState } from "preact/hooks";

import { GOLD_ONLY_NOTICE } from "../lib/gold_only.ts";
import {
  announcePreview,
  PREVIEW_LOAD_FAILED,
  previewCookie,
  previewInvitation,
  previewNote,
} from "../lib/pipeline_preview.ts";

interface PipelinePreviewProps {
  /**
   * What the visitor's cookie asked for. When it is on the route has drawn
   * the widget itself, as the island after this one.
   */
  initialOn: boolean;
  /** The run's search window, for the two sentences; null when unstated. */
  daysBack: number | null;
}

type Widget = FunctionComponent<{ preview?: boolean }>;

export default function PipelinePreview(
  { initialOn, daysBack }: PipelinePreviewProps,
) {
  const [on, setOn] = useState(initialOn);
  // The widget this island fetched. Wrapped in an object because a
  // component is a function, and a state setter calls a function it is
  // handed instead of storing it.
  const [fetched, setFetched] = useState<{ Widget: Widget } | null>(null);
  const [failed, setFailed] = useState(false);
  // The server's HTML cannot act on a press, so the switch is disabled
  // until this island is live; enabled from the start, a press before
  // hydration would reach no state and do nothing.
  const [live, setLive] = useState(false);
  useEffect(() => setLive(true), []);

  const set = (next: boolean) => {
    setOn(next);
    document.cookie = previewCookie(next);
    announcePreview(next);
  };

  const toggle = async () => {
    const next = !on;
    setFailed(false);
    set(next);
    // Nothing to fetch when switching off, when the route drew the widget,
    // or when an earlier press already fetched it.
    if (!next || initialOn || fetched !== null) return;
    try {
      const module = await import("./PipelineRun.tsx");
      setFetched({ Widget: module.default });
    } catch {
      // Offline, or a deploy replaced the chunk under an open page. The
      // switch goes back off, cookie included, so the page never claims a
      // preview it is not showing, and the line says what happened.
      set(false);
      setFailed(true);
    }
  };

  const line = failed
    ? PREVIEW_LOAD_FAILED
    : on
    ? previewNote(daysBack)
    : previewInvitation(daysBack);

  return (
    <>
      <div class="notice notice-neutral about-gold-notice has-preview">
        <div class="about-gold-text">
          <p>{GOLD_ONLY_NOTICE}</p>
          {
            /* A live region: the sentence is the only word of a press's
              outcome when the widget could not be fetched. */
          }
          <p class="about-preview-line" aria-live="polite">{line}</p>
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
      {on && fetched !== null && <fetched.Widget preview />}
    </>
  );
}
