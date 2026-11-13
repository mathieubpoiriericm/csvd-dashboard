import { assertEquals } from "@std/assert";

import { previewRequested } from "../lib/pipeline_preview_request.ts";

Deno.test("only the cookie's own value turns the preview on", () => {
  const on = (cookie?: string) =>
    previewRequested(new Headers(cookie ? { cookie } : {}));
  assertEquals(on("pipeline_preview=1"), true);
  assertEquals(on("other=1; pipeline_preview=1"), true);
  assertEquals(on("pipeline_preview=0"), false);
  assertEquals(on("other=1"), false);
  assertEquals(on(), false);
});
