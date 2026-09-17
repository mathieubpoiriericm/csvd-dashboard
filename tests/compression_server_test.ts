import { assert, assertEquals } from "@std/assert";

import {
  acceptsGzip,
  compression,
  isViteDevServer,
  shouldCompress,
} from "../server/compression.ts";

const BODY = "x".repeat(4096);

function response(
  body: BodyInit | null,
  headers: Record<string, string>,
  status = 200,
): Response {
  return new Response(body, { status, headers });
}

/** The middleware takes only `req` and `next` off the context. */
function run(
  request: Request,
  next: () => Response | Promise<Response>,
): Promise<Response> {
  // deno-lint-ignore no-explicit-any -- a two-field stand-in for Fresh's ctx.
  return compression()({ req: request, next } as any) as Promise<Response>;
}

const gzipRequest = () =>
  new Request("https://example.test/app.css", {
    headers: { "Accept-Encoding": "gzip, deflate, br" },
  });

Deno.test("gzip is offered only when the client lists it", () => {
  assert(acceptsGzip("gzip"));
  assert(acceptsGzip("deflate, gzip;q=0.8"));
  // A wildcard means the client will take whatever the server picks.
  assert(acceptsGzip("*"));
  assert(!acceptsGzip("br"));
  assert(!acceptsGzip(""));
  assert(!acceptsGzip(null));
});

Deno.test("only compressible, large enough, unencoded bodies qualify", () => {
  const css = { "Content-Type": "text/css", "Content-Length": "4096" };
  assert(shouldCompress(response(BODY, css), "gzip"));

  // Already compressed containers: gzip would add bytes.
  assert(
    !shouldCompress(
      response(BODY, {
        "Content-Type": "font/woff2",
        "Content-Length": "4096",
      }),
      "gzip",
    ),
  );
  // A body the edge already encoded must not be encoded twice.
  assert(
    !shouldCompress(
      response(BODY, { ...css, "Content-Encoding": "br" }),
      "gzip",
    ),
  );
  // Below the floor the framing costs more than it saves.
  assert(
    !shouldCompress(
      response("small", { "Content-Type": "text/css", "Content-Length": "5" }),
      "gzip",
    ),
  );
  // No body to compress.
  assert(!shouldCompress(response(null, css, 304), "gzip"));
  assert(!shouldCompress(response(null, css, 204), "gzip"));
  // A client that cannot decode it.
  assert(!shouldCompress(response(BODY, css), "br"));
  // A streamed response has no declared length and is compressed anyway.
  assert(
    shouldCompress(response(BODY, { "Content-Type": "text/html" }), "gzip"),
  );
});

// This also proves the default `compression()` -- and therefore the default
// `isDev` (`isViteDevServer`) -- still compresses under plain `deno test`,
// where `import.meta.env` is undefined: `run()` below calls `compression()`
// with no options, exactly as `main.ts` does.
Deno.test("a compressible response is gzipped and re-tagged", async () => {
  const result = await run(
    gzipRequest(),
    () =>
      response(BODY, {
        "Content-Type": "text/css",
        "Content-Length": String(BODY.length),
        "ETag": 'W/"abc"',
        "Vary": "Cookie",
      }),
  );

  assertEquals(result.headers.get("Content-Encoding"), "gzip");
  // A wrong length is worse than an absent one: the body is now a stream.
  assertEquals(result.headers.get("Content-Length"), null);
  // The gzip body is a different representation from the one staticFiles tagged.
  assertEquals(result.headers.get("ETag"), 'W/"abc-gzip"');
  // The pre-existing Vary survives; Accept-Encoding joins it.
  assertEquals(result.headers.get("Vary"), "Cookie, Accept-Encoding");

  const bytes = new Uint8Array(await result.arrayBuffer());
  assert(bytes.length < BODY.length, "the body should be smaller");
  // gzip's magic number, so this is a real member rather than a passthrough.
  assertEquals([bytes[0], bytes[1]], [0x1f, 0x8b]);

  const decoded = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();
  assertEquals(decoded, BODY);
});

Deno.test("a compressible response still varies when the client cannot take it", async () => {
  const request = new Request("https://example.test/app.css");
  const result = await run(
    request,
    () =>
      response(BODY, {
        "Content-Type": "text/css",
        "Content-Length": String(BODY.length),
      }),
  );

  assertEquals(result.headers.get("Content-Encoding"), null);
  // Without this a shared cache could hand a gzip body to a client that did
  // not ask for one.
  assertEquals(result.headers.get("Vary"), "Accept-Encoding");
  assertEquals(await result.text(), BODY);
});

Deno.test("Vary is not duplicated when it already lists the field", async () => {
  const result = await run(
    gzipRequest(),
    () =>
      response(BODY, {
        "Content-Type": "text/css",
        "Content-Length": String(BODY.length),
        "Vary": "accept-encoding",
      }),
  );
  assertEquals(result.headers.get("Vary"), "accept-encoding");
});

Deno.test("an incompressible response passes through untouched", async () => {
  const original = response(BODY, {
    "Content-Type": "font/woff2",
    "Content-Length": String(BODY.length),
  });
  const result = await run(gzipRequest(), () => original);

  // The same object, not a rebuilt one: nothing needed changing.
  assert(result === original);
  assertEquals(result.headers.get("Vary"), null);
});

Deno.test("a bodiless response passes through untouched", async () => {
  const original = new Response(null, {
    status: 304,
    headers: { "Content-Type": "text/css" },
  });
  const result = await run(gzipRequest(), () => original);
  assert(result === original);
});

Deno.test("the dev server's responses are left alone", async () => {
  const next = () => response(BODY, { "Content-Type": "text/html" });
  const res = await compression()(
    // deno-lint-ignore no-explicit-any -- a two-field stand-in for Fresh's ctx.
    { req: gzipRequest(), next, config: { mode: "development" } } as any,
  );
  assertEquals(res.headers.get("Content-Encoding"), null);
});

// `ctx.config.mode` never reads "development" under this app's real
// (Vite-plugin) dev server -- see `isViteDevServer`'s doc comment -- so this
// is the path that actually fires there. `isDev` is injected because
// `import.meta.env` cannot be monkey-patched from a test.
Deno.test("an injected isDev also leaves the response alone", async () => {
  const next = () => response(BODY, { "Content-Type": "text/html" });
  const res = await compression({ isDev: () => true })(
    // deno-lint-ignore no-explicit-any -- a two-field stand-in for Fresh's ctx.
    { req: gzipRequest(), next } as any,
  );
  assertEquals(res.headers.get("Content-Encoding"), null);
});

Deno.test("isViteDevServer is false when import.meta.env is undefined", () => {
  // Plain `deno test` never runs through Vite, so `import.meta.env` is
  // undefined here -- this pins the null-safe guard rather than any real
  // dev/production distinction.
  assertEquals(isViteDevServer(), false);
});
