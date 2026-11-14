import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  currentPreview,
  isPreviewPath,
  PREVIEW_NOTE_LABEL,
  previewFeatures,
  previewNote,
  PREVIEWS_LABEL,
  previewsTip,
} from "../lib/previews.ts";

Deno.test("the guide is always offered; the run and the review only when they exist", () => {
  const keys = (pipeline: boolean, review: boolean) =>
    previewFeatures({ pipeline, review }, 365).map((f) => f.key);
  assertEquals(keys(true, true), ["pipeline", "adapt", "review"]);
  assertEquals(keys(false, true), ["adapt", "review"]);
  assertEquals(keys(true, false), ["pipeline", "adapt"]);
  assertEquals(keys(false, false), ["adapt"]);
});

Deno.test("each feature names its page, and only the review has pages inside it", () => {
  const [run, guide, review] = previewFeatures(
    { pipeline: true, review: true },
    365,
  );
  assertEquals([run.href, guide.href, review.href], [
    "/previews/pipeline",
    "/adapt",
    "/review",
  ]);
  assertEquals([run.name, guide.name, review.name], [
    "Pipeline run",
    "Adaptation guide",
    "Review committee",
  ]);
  assertEquals(run.subpages, []);
  assertEquals(guide.subpages, []);
  assertEquals(review.subpages, [
    { href: "/review", label: "Review queue" },
    { href: "/review/progress", label: "Committee progress" },
  ]);
});

Deno.test("the run's sentences name its window, or none", () => {
  assertEquals(
    previewNote(365),
    "A real pipeline run over the last 365 days of publications. Its findings are not in the other pages.",
  );
  assertEquals(
    previewNote(1),
    "A real pipeline run over the last day of publications. Its findings are not in the other pages.",
  );
  assertEquals(
    previewNote(1500),
    "A real pipeline run over the last 1,500 days of publications. Its findings are not in the other pages.",
  );
  for (const none of [null, 0]) {
    assertEquals(
      previewNote(none),
      "A real pipeline run. Its findings are not in the other pages.",
    );
    assertStringIncludes(
      previewFeatures({ pipeline: true, review: false }, none)[0].summary,
      "A real run of the literature pipeline: what it read",
    );
  }
});

Deno.test("a preview path is a root or a page under one, never a lookalike", () => {
  for (
    const yes of [
      "/previews",
      "/previews/",
      "/previews/pipeline",
      "/adapt",
      "/adapt/session/save",
      "/review",
      "/review/gene",
      "/review/progress",
    ]
  ) {
    assert(isPreviewPath(yes), yes);
  }
  for (
    const no of [
      "/",
      "/genes",
      "/previewsx",
      "/reviewers",
      "/adaptation",
      "/login",
    ]
  ) {
    assert(!isPreviewPath(no), no);
  }
});

Deno.test("a page says which feature it belongs to; the hub belongs to none", () => {
  assertEquals(currentPreview("/previews"), null);
  assertEquals(currentPreview("/previews/pipeline"), "pipeline");
  assertEquals(currentPreview("/adapt"), "adapt");
  assertEquals(currentPreview("/review/gene"), "review");
  assertEquals(currentPreview("/reviewers"), null);
  assertEquals(currentPreview("/genes"), null);
});

Deno.test("the fixed copy is exported verbatim", () => {
  assertEquals(PREVIEWS_LABEL, "New Feature Previews");
  assertEquals(PREVIEW_NOTE_LABEL, "Technical preview:");
});

Deno.test("the navbar tip names only the features on offer", () => {
  const tip = (pipeline: boolean, review: boolean) =>
    previewsTip(previewFeatures({ pipeline, review }, 365));
  assertEquals(
    tip(true, true),
    "New. Three features in preview: the pipeline run, the disease adaptation guide and the scientific review committee.",
  );
  assertEquals(
    tip(true, false),
    "New. Two features in preview: the pipeline run and the disease adaptation guide.",
  );
  assertEquals(
    tip(false, true),
    "New. Two features in preview: the disease adaptation guide and the scientific review committee.",
  );
  assertEquals(
    tip(false, false),
    "New. One feature in preview: the disease adaptation guide.",
  );
});
