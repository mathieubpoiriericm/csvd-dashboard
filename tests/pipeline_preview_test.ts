import { assertEquals } from "@std/assert";

import {
  announcePreview,
  observePreview,
  PREVIEW_COOKIE,
  PREVIEW_LOAD_FAILED,
  previewCookie,
  previewInvitation,
  previewNote,
} from "../lib/pipeline_preview.ts";

Deno.test("the invitation names the window the report states", () => {
  assertEquals(
    previewInvitation(365),
    "Curious what the pipeline can do? Switch on a technical preview of a real run over the last 365 days of publications.",
  );
  assertEquals(
    previewInvitation(1),
    "Curious what the pipeline can do? Switch on a technical preview of a real run over the last day of publications.",
  );
  assertEquals(
    previewInvitation(null),
    "Curious what the pipeline can do? Switch on a technical preview of a real run.",
  );
  assertEquals(
    previewInvitation(0),
    "Curious what the pipeline can do? Switch on a technical preview of a real run.",
  );
});

Deno.test("the note says the findings are not in the other pages", () => {
  assertEquals(
    previewNote(365),
    "Technical preview: a real pipeline run over the last 365 days of publications. Its findings are not in the other pages.",
  );
  assertEquals(
    previewNote(null),
    "Technical preview: a real pipeline run. Its findings are not in the other pages.",
  );
});

Deno.test("the cookie is set for a year and cleared when off", () => {
  assertEquals(PREVIEW_COOKIE, "pipeline_preview");
  assertEquals(
    previewCookie(true),
    "pipeline_preview=1; Path=/; Max-Age=31536000; SameSite=Lax",
  );
  assertEquals(
    previewCookie(false),
    "pipeline_preview=; Path=/; Max-Age=0; SameSite=Lax",
  );
});

Deno.test("a switch is announced to whoever observes it, until they stop", () => {
  const target = new EventTarget();
  const heard: boolean[] = [];
  const stop = observePreview((on) => heard.push(on), target);
  announcePreview(true, target);
  announcePreview(false, target);
  stop();
  announcePreview(true, target);
  assertEquals(heard, [true, false]);
});

Deno.test("the switch is announced on the page itself by default", () => {
  const heard: boolean[] = [];
  const stop = observePreview((on) => heard.push(on));
  announcePreview(true);
  stop();
  assertEquals(heard, [true]);
});

Deno.test("a failed load asks for a reload, the recovery that works", () => {
  // Another press imports the same dead chunk after a deploy or an expired
  // session, so the sentence must not offer one.
  assertEquals(
    PREVIEW_LOAD_FAILED,
    "The preview could not be loaded. Reload the page to try again.",
  );
});
