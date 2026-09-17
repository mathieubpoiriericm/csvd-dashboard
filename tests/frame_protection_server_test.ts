import {
  assertEquals,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { App } from "fresh";

import {
  applyFrameProtection,
  FRAME_ANCESTORS_DIRECTIVE,
  frameProtection,
} from "../server/frame_protection.ts";

Deno.test("frame policy denies framing without constraining inline bootstrap", () => {
  const response = applyFrameProtection(new Response("page"));
  assertEquals(
    response.headers.get("content-security-policy"),
    FRAME_ANCESTORS_DIRECTIVE,
  );
  assertEquals(response.headers.get("x-frame-options"), "DENY");
  assertNotMatch(
    response.headers.get("content-security-policy") ?? "",
    /(?:default|script|style)-src/i,
  );
});

Deno.test("frame policy preserves CSP and replaces a weaker ancestor rule", () => {
  const response = applyFrameProtection(
    new Response("page", {
      headers: {
        "Content-Security-Policy":
          "script-src 'nonce-bootstrap'; frame-ancestors *; style-src 'self'",
      },
    }),
  );
  const policy = response.headers.get("content-security-policy") ?? "";
  assertStringIncludes(policy, "script-src 'nonce-bootstrap'");
  assertStringIncludes(policy, "style-src 'self'");
  assertStringIncludes(policy, FRAME_ANCESTORS_DIRECTIVE);
  assertNotMatch(policy, /frame-ancestors \*/i);
  assertEquals(response.headers.get("x-frame-options"), "DENY");
});

Deno.test("frame policy hardens an immutable redirect without changing it", () => {
  const response = applyFrameProtection(
    Response.redirect("http://localhost/login", 303),
  );
  assertEquals(response.status, 303);
  assertEquals(response.headers.get("location"), "http://localhost/login");
  assertEquals(
    response.headers.get("content-security-policy"),
    FRAME_ANCESTORS_DIRECTIVE,
  );
  assertEquals(response.headers.get("x-frame-options"), "DENY");
});

Deno.test("frame middleware covers normal application responses", async () => {
  const handler = new App()
    .use(frameProtection())
    .get("/", () => new Response("page"))
    .handler();
  const response = await handler(new Request("http://localhost/"));
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("content-security-policy"),
    FRAME_ANCESTORS_DIRECTIVE,
  );
  assertEquals(response.headers.get("x-frame-options"), "DENY");
});
