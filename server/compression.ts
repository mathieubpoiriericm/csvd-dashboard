/** Response compression for the whole app, static assets included. */

import type { Middleware } from "fresh";

/**
 * Compressible types. Everything the app serves that is not already a
 * compressed container: markup, styles, the island bundles, JSON and SVG.
 * Fonts are `woff2`, images are `png`/`ico`/`webp` -- all already compressed,
 * and running them through gzip costs CPU to add bytes.
 */
const COMPRESSIBLE =
  /^(?:text\/|image\/svg\+xml|application\/(?:javascript|json|manifest\+json|xml))/;

/**
 * Below this, the gzip header and trailer are a meaningful share of the body
 * and the round trip is dominated by latency anyway.
 */
const MIN_BYTES = 1024;

/** Append a field to `Vary` without duplicating one already listed. */
function addVary(headers: Headers, field: string): void {
  const existing = headers.get("Vary");
  const fields = existing?.split(",").map((value) => value.trim()).filter(
    Boolean,
  ) ?? [];
  if (fields.some((value) => value.toLowerCase() === field.toLowerCase())) {
    return;
  }
  fields.push(field);
  headers.set("Vary", fields.join(", "));
}

/** True when the client offered gzip. `CompressionStream` speaks no brotli. */
export function acceptsGzip(acceptEncoding: string | null): boolean {
  if (!acceptEncoding) return false;
  return acceptEncoding
    .split(",")
    .map((value) => value.trim().split(";")[0].toLowerCase())
    .some((coding) => coding === "gzip" || coding === "*");
}

/**
 * Whether this response is worth compressing.
 *
 * A response that already carries `Content-Encoding` is left alone, so a host
 * that compresses at the edge cannot end up double-encoding. A 304 has no body
 * to compress, and neither does a 204.
 */
export function shouldCompress(
  response: Response,
  acceptEncoding: string | null,
): boolean {
  if (!acceptsGzip(acceptEncoding)) return false;
  if (!response.body) return false;
  if (response.status === 204 || response.status === 304) return false;
  if (response.headers.has("Content-Encoding")) return false;

  const type = response.headers.get("Content-Type");
  if (!type || !COMPRESSIBLE.test(type)) return false;

  // Length is advisory: a streamed response has none, and is compressed on the
  // assumption that a body worth streaming is worth compressing.
  const length = response.headers.get("Content-Length");
  if (length !== null && Number(length) < MIN_BYTES) return false;

  return true;
}

/**
 * True when Vite's own dev server is serving this request.
 *
 * `@fresh/plugin-vite`'s generated server entry hardcodes `"production"` into
 * `setBuildCache(app, …, "production")` for both `deno task dev` and
 * `deno task build` -- so `ctx.config.mode` never reads `"development"` under
 * `npm:vite`, only under the classic (non-Vite) Fresh dev builder. Vite itself
 * still statically replaces `import.meta.env.DEV`/`PROD` per environment, so
 * that is what actually distinguishes the two here; `deno task start` runs
 * the built `_fresh/server.js` outside Vite entirely, where `DEV` is `false`.
 */
export function isViteDevServer(): boolean {
  // `import.meta.env` is a Vite global with no declaration in Deno's type graph.
  // deno-lint-ignore no-explicit-any
  return (import.meta as any).env?.DEV === true;
}

/**
 * Gzip every compressible response.
 *
 * Nothing in the app compressed before this: `staticFiles()` serves the built
 * bundles verbatim, so `deno task start` shipped the 409 KB protected-data
 * chunk, the 79 KB stylesheet and the 152 KB Leaflet bundle at full size on
 * every navigation -- and the gate makes the HTML and that chunk `no-store`, so
 * every navigation pays again. Measured on the production build, this is the
 * single largest reduction available to any route.
 *
 * It is deliberately the outermost middleware, so it also covers the
 * protected-data chunk that `protectDataAssets()` rewrites and the early
 * denials that never reach file routing. `Content-Length` is dropped rather
 * than recomputed: the compressed body is a stream, and a wrong length is worse
 * than an absent one.
 */
export function compression<State>(
  { isDev = isViteDevServer }: { isDev?: () => boolean } = {},
): Middleware<State> {
  return async function compression(ctx) {
    // Vite's dev pipeline transforms the HTML after this middleware runs and
    // treats the gzip bytes as text; the browser then reports
    // ERR_CONTENT_DECODING_FAILED and never fires `load`. Production is the
    // only mode that ships bundles worth compressing anyway. `ctx.config.mode`
    // is checked too: it is what the classic Fresh dev builder reports, and
    // what one unit test below stands in for; `isDev` is the injectable seam
    // that lets another unit test drive the check that actually fires under
    // this app's real (Vite-plugin) dev server -- see `isViteDevServer`'s own
    // comment for why `ctx.config.mode` alone never does.
    if (ctx.config?.mode === "development" || isDev()) {
      return ctx.next();
    }

    const response = await ctx.next();
    if (!shouldCompress(response, ctx.req.headers.get("Accept-Encoding"))) {
      // A compressible response that this client cannot take still varies by
      // the header, or a cache would hand a gzip body to a client without it.
      if (response.body && response.headers.get("Content-Type")) {
        const headers = new Headers(response.headers);
        if (COMPRESSIBLE.test(headers.get("Content-Type") ?? "")) {
          addVary(headers, "Accept-Encoding");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
      }
      return response;
    }

    const headers = new Headers(response.headers);
    headers.set("Content-Encoding", "gzip");
    headers.delete("Content-Length");
    addVary(headers, "Accept-Encoding");
    // An entity tag identifies one representation, and the gzip body is a
    // different representation from the one staticFiles() tagged. Suffixing it
    // costs a revalidation that the hashed, `immutable` asset URLs never make,
    // and prevents a cache pairing this tag with an identity body.
    const etag = headers.get("ETag");
    if (etag !== null) {
      headers.set("ETag", etag.replace(/"$/, '-gzip"'));
    }

    return new Response(
      response.body!.pipeThrough(new CompressionStream("gzip")),
      { status: response.status, statusText: response.statusText, headers },
    );
  };
}
