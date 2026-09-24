/** A script-free policy for every SVG this origin serves. */

import type { Middleware } from "fresh";

import { rewriteResponseHeaders } from "./response_header_policy.ts";

/**
 * An SVG opened as a page runs its own scripts on this origin, where they
 * could read every gated page with the viewer's session. The institute logos
 * are whatever a fork's adapt wizard was given and are served before login,
 * so no SVG is trusted: nothing loads or runs, inline styles still apply,
 * and the sandbox gives the document an opaque origin besides. An <img>
 * renders the file exactly as before.
 */
export const SVG_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const SVG_MEDIA_TYPE = /^\s*image\/svg\+xml\s*(?:;|$)/i;

/** Replace an SVG response's policy; leave every other response untouched. */
export function applySvgPolicy(response: Response): Response {
  if (!SVG_MEDIA_TYPE.test(response.headers.get("Content-Type") ?? "")) {
    return response;
  }
  return rewriteResponseHeaders(response, (headers) => {
    headers.set("Content-Security-Policy", SVG_POLICY);
  });
}

/** Apply the SVG policy to static files and route responses alike. */
export function svgPolicy<State>(): Middleware<State> {
  return async function svgPolicy(ctx) {
    return applySvgPolicy(await ctx.next());
  };
}
