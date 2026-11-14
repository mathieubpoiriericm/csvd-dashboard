/** The previews' strip and the page shell's `before` slot, as the server draws them. */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { Page } from "../components/Page.tsx";
import { PreviewSwitcher } from "../components/PreviewSwitcher.tsx";
import { previewFeatures } from "../lib/previews.ts";

const ALL = previewFeatures({ pipeline: true, review: true }, 365);
const links = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*aria-current="([^"]*)"[^>]*>/g)]
    .map((m) => [m[1], m[2]]);

Deno.test("the strip leads back to the hub and names every feature, the current one marked", () => {
  const html = renderToString(
    <PreviewSwitcher features={ALL} pathname="/adapt" />,
  );
  assertStringIncludes(
    html,
    '<nav class="preview-switcher" aria-label="Feature previews">',
  );
  assertEquals(links(html), [
    ["/previews", "false"],
    ["/previews/pipeline", "false"],
    ["/adapt", "page"],
    ["/review", "false"],
  ]);
  assert(!html.includes("preview-switcher-sub"));
});

Deno.test("inside the review a second row links the queue and the progress", () => {
  const queue = links(
    renderToString(<PreviewSwitcher features={ALL} pathname="/review" />),
  );
  assertEquals(queue.slice(3), [
    ["/review", "page"],
    ["/review", "page"],
    ["/review/progress", "false"],
  ]);
  const progress = links(
    renderToString(
      <PreviewSwitcher features={ALL} pathname="/review/progress" />,
    ),
  );
  assertEquals(progress.slice(3), [
    ["/review", "true"],
    ["/review", "false"],
    ["/review/progress", "page"],
  ]);
  // A gene's page is in the review, and is neither of the two.
  const gene = links(
    renderToString(<PreviewSwitcher features={ALL} pathname="/review/gene" />),
  );
  assertEquals(gene.slice(3), [
    ["/review", "true"],
    ["/review", "false"],
    ["/review/progress", "false"],
  ]);
});

Deno.test("with one feature the strip is the back link and that name", () => {
  const html = renderToString(
    <PreviewSwitcher
      features={previewFeatures({ pipeline: false, review: false }, null)}
      pathname="/adapt"
    />,
  );
  assertEquals(links(html), [["/previews", "false"], ["/adapt", "page"]]);
});

Deno.test("the page shell draws `before` above its header", () => {
  const html = renderToString(
    <Page title="T" description="D" before={<i id="b" />}>x</Page>,
  );
  assert(html.indexOf('id="b"') < html.indexOf("page-header"));
  // Absent, nothing is added.
  assertEquals(
    renderToString(<Page title="T" description="D">x</Page>),
    html.replace('<i id="b"></i>', ""),
  );
});
