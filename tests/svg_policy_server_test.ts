import { assertEquals, assertStrictEquals } from "@std/assert";
import { App } from "fresh";

import {
  FRAME_ANCESTORS_DIRECTIVE,
  frameProtection,
} from "../server/frame_protection.ts";
import { applySvgPolicy, SVG_POLICY, svgPolicy } from "../server/svg_policy.ts";

const svg = (contentType: string) =>
  new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
    headers: { "Content-Type": contentType },
  });

Deno.test("svg policy gives every SVG response a script-free sandbox", () => {
  for (
    const type of [
      "image/svg+xml",
      "image/svg+xml; charset=utf-8",
      " Image/SVG+XML ",
    ]
  ) {
    const response = applySvgPolicy(svg(type));
    assertEquals(response.headers.get("content-security-policy"), SVG_POLICY);
  }
  assertEquals(
    SVG_POLICY,
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  );
});

Deno.test("svg policy replaces a weaker policy on an SVG", () => {
  const response = applySvgPolicy(
    new Response("<svg/>", {
      headers: {
        "Content-Type": "image/svg+xml",
        "Content-Security-Policy": "script-src *",
      },
    }),
  );
  assertEquals(response.headers.get("content-security-policy"), SVG_POLICY);
});

Deno.test("svg policy leaves every other response as it was", () => {
  for (
    const response of [
      new Response("page", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
      new Response("png", { headers: { "Content-Type": "image/png" } }),
      new Response("xml", { headers: { "Content-Type": "image/svg+xmlx" } }),
      new Response(null, { status: 204 }),
    ]
  ) {
    assertStrictEquals(applySvgPolicy(response), response);
  }
});

// main.ts's order: frameProtection() wraps svgPolicy(), so the framing rule
// lands on the SVG's policy too, and an HTML page keeps exactly its own.
Deno.test("svg middleware under frame protection sandboxes SVGs and nothing else", async () => {
  const handler = new App()
    .use(frameProtection())
    .use(svgPolicy())
    .get("/logo.svg", () => svg("image/svg+xml"))
    .get(
      "/",
      () =>
        new Response("page", {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    )
    .handler();

  const logo = await handler(new Request("http://localhost/logo.svg"));
  assertEquals(
    logo.headers.get("content-security-policy"),
    `${SVG_POLICY}; ${FRAME_ANCESTORS_DIRECTIVE}`,
  );
  assertEquals(logo.headers.get("x-frame-options"), "DENY");
  assertEquals(await logo.text(), "<svg xmlns='http://www.w3.org/2000/svg'/>");

  const page = await handler(new Request("http://localhost/"));
  assertEquals(
    page.headers.get("content-security-policy"),
    FRAME_ANCESTORS_DIRECTIVE,
  );
});
