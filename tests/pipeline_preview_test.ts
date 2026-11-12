import { assertEquals } from "@std/assert";

import {
  PREVIEW_COOKIE,
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
