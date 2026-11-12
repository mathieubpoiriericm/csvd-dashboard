/**
 * The About page's technical-preview switch and the widget it shows, each
 * rendered as the server draws it.
 *
 * The switch holds no data: the route hands it the run's window and whether
 * the cookie has it on. The widget is an island of its own, drawn by the
 * route only when it is on. What a press does once live -- the cookie, the
 * fetch of the widget, the two islands keeping step -- is the end-to-end
 * suite's (`e2e/tests/about.spec.ts`).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import PipelinePreview from "../islands/PipelinePreview.tsx";
import PipelinePreviewWidget from "../islands/PipelinePreviewWidget.tsx";
import { GOLD_ONLY_NOTICE } from "../lib/gold_only.ts";
import { previewInvitation, previewNote } from "../lib/pipeline_preview.ts";
import { RUN } from "./fixtures/pipeline_run.ts";
import { escapeHtml } from "./helpers/html.ts";

Deno.test("off: the notice invites, and no widget renders", () => {
  const html = renderToString(
    <PipelinePreview initialOn={false} daysBack={365} />,
  );
  assertStringIncludes(html, GOLD_ONLY_NOTICE);
  assertStringIncludes(html, escapeHtml(previewInvitation(365)));
  assertStringIncludes(html, 'role="switch"');
  assertStringIncludes(html, 'aria-checked="false"');
  assert(!html.includes("pipeline-card"));
});

Deno.test("on: the note replaces the invitation, and the widget is not the switch's to draw", () => {
  // The route draws the widget for a visitor whose cookie has it on, as the
  // island after this one; drawn here too it would be on the page twice.
  const html = renderToString(<PipelinePreview initialOn daysBack={365} />);
  assertStringIncludes(html, escapeHtml(previewNote(365)));
  assert(!html.includes(escapeHtml(previewInvitation(365))));
  assertStringIncludes(html, 'aria-checked="true"');
  assert(!html.includes("pipeline-card"));
});

Deno.test("a run that states no window is offered without one", () => {
  const html = renderToString(
    <PipelinePreview initialOn={false} daysBack={null} />,
  );
  assertStringIncludes(html, escapeHtml(previewInvitation(null)));
});

Deno.test("the switch is named, and inert until the island is live", () => {
  // The server's HTML cannot act on a click: a switch drawn enabled before
  // hydration would take one and do nothing.
  const html = renderToString(
    <PipelinePreview initialOn={false} daysBack={365} />,
  );
  const button = html.match(/<button[^>]*>/)?.[0] ?? "";
  assertStringIncludes(button, 'type="button"');
  assertStringIncludes(button, 'class="about-preview-switch"');
  assertStringIncludes(
    button,
    'aria-label="Technical preview of a pipeline run"',
  );
  assertStringIncludes(button, "disabled");
});

Deno.test("the sentence a press changes is a live region", () => {
  // It is the only word of a press's outcome when the widget cannot be
  // fetched.
  const html = renderToString(
    <PipelinePreview initialOn={false} daysBack={365} />,
  );
  assertStringIncludes(
    html,
    '<p class="about-preview-line" aria-live="polite">',
  );
});

Deno.test("the widget island draws the run, marked as a preview", () => {
  const html = renderToString(<PipelinePreviewWidget run={RUN} />);
  assertStringIncludes(html, "pipeline-card");
  assertStringIncludes(html, "pipeline-preview-mark");
  assertStringIncludes(html, "Technical preview");
});

Deno.test("the widget island draws nothing without a run", () => {
  assertEquals(renderToString(<PipelinePreviewWidget run={null} />), "");
});
