import { assertEquals } from "@std/assert";

import { previewCookie } from "../lib/pipeline_preview.ts";
import {
  previewRenewal,
  previewRequested,
} from "../lib/pipeline_preview_request.ts";

Deno.test("only the cookie's own value turns the preview on", () => {
  const on = (cookie?: string) =>
    previewRequested(new Headers(cookie ? { cookie } : {}));
  assertEquals(on("pipeline_preview=1"), true);
  assertEquals(on("other=1; pipeline_preview=1"), true);
  assertEquals(on("pipeline_preview=0"), false);
  assertEquals(on("other=1"), false);
  assertEquals(on(), false);
});

Deno.test("the server renews the cookie of a visitor who has the preview on", () => {
  // A cookie written from script is capped at seven days by WebKit, so the
  // page that draws the preview sends it again as a header, for the year
  // the switch asked for. It is the switch's own cookie, byte for byte, so
  // the switch can still clear it.
  const on = new Headers({ cookie: "pipeline_preview=1" });
  assertEquals(previewRenewal(on, true), previewCookie(true));
  assertEquals(
    previewRenewal(on, true),
    "pipeline_preview=1; Path=/; Max-Age=31536000; SameSite=Lax",
  );
  // Nothing is set for a visitor who never switched it on, or switched it
  // off: the server never turns the preview on by itself.
  assertEquals(previewRenewal(new Headers(), true), null);
  assertEquals(
    previewRenewal(new Headers({ cookie: "pipeline_preview=0" }), true),
    null,
  );
  // Nor where the page offers no preview, whatever the cookie says.
  assertEquals(previewRenewal(on, false), null);
});
