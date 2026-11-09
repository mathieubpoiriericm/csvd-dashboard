import {
  assertEquals,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { App, HttpError } from "fresh";

import {
  applyFrameProtection,
  FRAME_ANCESTORS_DIRECTIVE,
  frameProtection,
} from "../server/frame_protection.ts";
import { sameSiteCsrf } from "../server/same_site_origin.ts";

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

function assertFramed(response: Response): void {
  assertEquals(
    response.headers.get("content-security-policy"),
    FRAME_ANCESTORS_DIRECTIVE,
  );
  assertEquals(response.headers.get("x-frame-options"), "DENY");
  assertEquals(response.headers.get("cache-control"), "no-store");
}

Deno.test("frame middleware covers thrown denials and unmatched routes", async () => {
  const handler = new App()
    .use(frameProtection())
    .use(() => {
      throw new HttpError(403);
    })
    .get("/", () => new Response("page"))
    .handler();
  const forbidden = await handler(new Request("http://localhost/"));
  assertEquals(forbidden.status, 403);
  assertEquals(await forbidden.text(), "Forbidden");
  assertFramed(forbidden);

  const routed = new App()
    .use(frameProtection())
    .get("/", () => new Response("page"))
    .handler();
  const missing = await routed(new Request("http://localhost/nonexistent"));
  assertEquals(missing.status, 404);
  assertFramed(missing);
  const wrongMethod = await routed(
    new Request("http://localhost/", { method: "DELETE" }),
  );
  assertEquals([404, 405].includes(wrongMethod.status), true);
  assertFramed(wrongMethod);
  await wrongMethod.body?.cancel();
});

Deno.test("frame middleware covers a cross-site POST the csrf check rejects", async () => {
  const handler = new App()
    .use(frameProtection())
    .use(sameSiteCsrf())
    .post("/login", () => new Response("ok"))
    .handler();
  const response = await handler(
    new Request("http://localhost/login", {
      method: "POST",
      headers: {
        "Sec-Fetch-Site": "cross-site",
        Origin: "https://evil.example",
      },
    }),
  );
  assertEquals(response.status, 403);
  assertFramed(response);
  await response.body?.cancel();
});

Deno.test("frame middleware turns an unexpected exception into a framed 500", async () => {
  const original = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => logged.push(...args);
  try {
    const failure = new Error("boom");
    const handler = new App()
      .use(frameProtection())
      .get("/", () => {
        throw failure;
      })
      .get("/http", () => {
        throw new HttpError(502);
      })
      .handler();
    const response = await handler(new Request("http://localhost/"));
    assertEquals(response.status, 500);
    assertEquals(await response.text(), "Internal server error");
    assertFramed(response);
    const bad = await handler(new Request("http://localhost/http"));
    assertEquals(bad.status, 502);
    assertFramed(bad);
    await bad.body?.cancel();
    assertEquals(logged.includes(failure), true);
    assertEquals(logged.length, 2);
  } finally {
    console.error = original;
  }
});
