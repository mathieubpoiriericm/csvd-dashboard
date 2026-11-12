/**
 * The About page's technical-preview switch, rendered as the server draws
 * it.
 *
 * The island is rendered directly with a fixture run, for the reason
 * `tests/pipeline_widget_test.tsx` gives: the route renders it with
 * `initialOn` alone, and the island reads the committed run itself. What
 * the switch does once live -- the cookie, the click -- is the end-to-end
 * suite's (`e2e/tests/about.spec.ts`).
 */

import {
  assert,
  assertEquals,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { renderToString } from "preact-render-to-string";

import PipelinePreview from "../islands/PipelinePreview.tsx";
import { GOLD_ONLY_NOTICE } from "../lib/gold_only.ts";
import { previewInvitation, previewNote } from "../lib/pipeline_preview.ts";
import { RUN as BASE, runWith } from "./fixtures/pipeline_run.ts";
import { escapeHtml } from "./helpers/html.ts";

const RUN = runWith({ config: { ...BASE.config, daysBack: 365 } });

Deno.test("off: the notice invites, and no widget renders", () => {
  const html = renderToString(<PipelinePreview initialOn={false} run={RUN} />);
  assertStringIncludes(html, GOLD_ONLY_NOTICE);
  assertStringIncludes(html, escapeHtml(previewInvitation(365)));
  assertStringIncludes(html, 'role="switch"');
  assertStringIncludes(html, 'aria-checked="false"');
  assertNotMatch(html, /pipeline-card/);
});

Deno.test("on: the note replaces the invitation and the widget follows the notice", () => {
  const html = renderToString(<PipelinePreview initialOn run={RUN} />);
  assertStringIncludes(html, escapeHtml(previewNote(365)));
  assert(!html.includes(escapeHtml(previewInvitation(365))));
  assertStringIncludes(html, 'aria-checked="true"');
  assert(html.indexOf("about-gold-notice") < html.indexOf("pipeline-card"));
  assertStringIncludes(html, "pipeline-preview-mark");
  assertStringIncludes(html, "Technical preview");
});

Deno.test("no report: today's notice, whatever the cookie said", () => {
  const html = renderToString(<PipelinePreview initialOn run={null} />);
  assertEquals(
    html,
    `<p class="notice notice-neutral about-gold-notice">${GOLD_ONLY_NOTICE}</p>`,
  );
});

Deno.test("the switch is named, and inert until the island is live", () => {
  // The server's HTML cannot act on a click: a switch drawn enabled before
  // hydration would take one and do nothing.
  const html = renderToString(<PipelinePreview initialOn={false} run={RUN} />);
  const button = html.match(/<button[^>]*>/)?.[0] ?? "";
  assertStringIncludes(button, 'type="button"');
  assertStringIncludes(button, 'class="about-preview-switch"');
  assertStringIncludes(
    button,
    'aria-label="Technical preview of a pipeline run"',
  );
  assertStringIncludes(button, "disabled");
});
