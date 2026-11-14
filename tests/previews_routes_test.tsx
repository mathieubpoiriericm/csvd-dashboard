/**
 * The previews hub, the pipeline run's own page, and the strip at the head of
 * every feature page. Which features exist is derived from the committed data
 * at test time, so these hold with no run, no review, or gold-only off.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { HttpError } from "fresh";
import { h } from "preact";
import { renderToString } from "preact-render-to-string";

import PreviewsPage, { PreviewsHub } from "../routes/previews/index.tsx";
import PipelinePreviewPage, {
  PipelinePreviewContent,
} from "../routes/previews/pipeline.tsx";
import AdaptPage from "../routes/adapt.tsx";
import { ReviewQueueContent } from "../routes/review/index.tsx";
import { ReviewGeneContent } from "../routes/review/gene.tsx";
import { ReviewProgressContent } from "../routes/review/progress.tsx";
import { PreviewSwitcher } from "../components/PreviewSwitcher.tsx";
import {
  previewFeatures,
  previewNote,
  PREVIEWS_LABEL,
  PREVIEWS_LEAD,
} from "../lib/previews.ts";
import {
  offeredPreviews,
  PREVIEW_RUN_DAYS_BACK,
  PREVIEWS,
  runDaysBack,
} from "../lib/previews_current.ts";
import type { PipelineRun } from "../lib/types.ts";
import { GOLD_ONLY } from "../lib/gold_only.ts";
import { pipelineRun } from "../lib/data/pipeline_run.ts";
import { currentReview, REVIEW } from "../lib/review/current.ts";
import { goldOf, sampleRound } from "./fixtures/review.ts";
import { escapeHtml } from "./helpers/html.ts";

const render = (component: unknown) =>
  renderToString(
    h(component as preact.ComponentType<Record<string, never>>, {}),
  );

const ALL = previewFeatures({ pipeline: true, review: true }, 365);
const cardIds = (html: string) =>
  [...html.matchAll(/id="preview-card-(\w+)"/g)].map((m) => m[1]);

/**
 * A card's way in, as a link drawn as the primary button. Either attribute
 * order: `preact/compat`, which the run widget's module graph brings into
 * this file, rebuilds an element's props and writes `class` after `href`.
 */
const action = (href: string, text: string) => {
  const cls = 'class="review-action review-action-primary"';
  const to = `href="${href.replaceAll("/", "\\/")}"`;
  return new RegExp(`<a (?:${cls} ${to}|${to} ${cls})>${text}<\\/a>`);
};

Deno.test("the hub draws one card per feature, each with its way in", () => {
  const html = renderToString(<PreviewsHub features={ALL} />);
  assertStringIncludes(html, `<h1>${PREVIEWS_LABEL}</h1>`);
  assertStringIncludes(html, escapeHtml(PREVIEWS_LEAD));
  assertEquals(cardIds(html), ["pipeline", "adapt", "review"]);
  for (const f of ALL) assertStringIncludes(html, escapeHtml(f.summary));
  assertMatch(html, action("/previews/pipeline", "Open the pipeline run"));
  assertMatch(html, action("/adapt", "Open the adaptation guide"));
  assertMatch(html, action("/review", "Enter as observer"));
  assertStringIncludes(html, 'aria-labelledby="review-request-title"');
  // The hub is where the strip leads back to, so it has none.
  assert(!html.includes("preview-switcher"));
});

Deno.test("the hub offers only what exists, down to the guide alone", () => {
  const html = renderToString(
    <PreviewsHub
      features={previewFeatures({ pipeline: false, review: false }, null)}
    />,
  );
  assertEquals(cardIds(html), ["adapt"]);
  assert(!html.includes('href="/review"'));
  assert(!html.includes('href="/previews/pipeline"'));
  assert(!html.includes("<dialog"));
});

Deno.test("the run is offered only while gold-only holds and a report exists", () => {
  const run = { config: { daysBack: 30 } } as Pick<PipelineRun, "config">;
  const keys = (features: readonly { key: string }[]) =>
    features.map((f) => f.key);
  assertEquals(keys(offeredPreviews(true, run, {})), [
    "pipeline",
    "adapt",
    "review",
  ]);
  assertEquals(keys(offeredPreviews(false, run, null)), ["adapt"]);
  assertEquals(keys(offeredPreviews(true, null, null)), ["adapt"]);
  assertEquals(runDaysBack(run), 30);
  assertEquals(runDaysBack(null), null);
  assertEquals(PREVIEW_RUN_DAYS_BACK, pipelineRun?.config.daysBack ?? null);
});

Deno.test("the committed hub matches the committed data", () => {
  const want = [
    ...(GOLD_ONLY && pipelineRun !== null ? ["pipeline"] : []),
    "adapt",
    ...(REVIEW !== null ? ["review"] : []),
  ];
  assertEquals(PREVIEWS.map((f) => f.key), want);
  assertEquals(cardIds(render(PreviewsPage)), want);
});

Deno.test("the run's page says it is a preview, above the widget and under the strip", () => {
  const html = renderToString(
    <PipelinePreviewContent features={ALL} daysBack={365} />,
  );
  const strip = html.indexOf("preview-switcher");
  const note = html.indexOf("preview-note");
  assert(strip !== -1 && strip < html.indexOf("<h1>Pipeline run</h1>"));
  assert(html.indexOf("<h1>") < note);
  assertStringIncludes(
    html,
    `<strong class="note-label">Technical preview:</strong> ${
      escapeHtml(previewNote(365))
    }`,
  );
});

Deno.test("the run's page is a 404 unless the run is offered", () => {
  const offered = PREVIEWS.some((f) => f.key === "pipeline");
  if (offered) render(PipelinePreviewPage);
  else assertThrows(() => render(PipelinePreviewPage), HttpError);
});

Deno.test("the guide and the review pages open on the strip", () => {
  assertStringIncludes(render(AdaptPage), 'class="preview-switcher"');
  const state = currentReview(true, sampleRound(3), goldOf(sampleRound(3)))!;
  const strip = <PreviewSwitcher features={ALL} pathname="/review" />;
  for (
    const html of [
      renderToString(
        <ReviewQueueContent
          state={state}
          kind={null}
          standing={null}
          before={strip}
        />,
      ),
      renderToString(<ReviewProgressContent state={state} before={strip} />),
      renderToString(
        <ReviewGeneContent
          state={state}
          gene={state.round.changes[0].gene}
          before={strip}
        />,
      ),
    ]
  ) {
    const s = html.indexOf("preview-switcher");
    assert(s !== -1 && s < html.indexOf("page-header"), html.slice(0, 300));
  }
});
