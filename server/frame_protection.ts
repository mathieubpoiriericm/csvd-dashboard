/** Minimal document framing policy, kept separate from script/style CSP rules. */

import type { Middleware } from "fresh";

import { rewriteResponseHeaders } from "./response_header_policy.ts";

export const FRAME_ANCESTORS_DIRECTIVE = "frame-ancestors 'none'";

/** Preserve any future CSP directives while making frame-ancestors deny-all. */
export function applyFrameProtection(response: Response): Response {
  return rewriteResponseHeaders(response, (headers) => {
    const current = headers.get("Content-Security-Policy");
    const directives = current?.split(";").map((directive) => directive.trim())
      .filter(Boolean).filter((directive) =>
        !/^frame-ancestors(?:\s|$)/i.test(directive)
      ) ?? [];
    directives.push(FRAME_ANCESTORS_DIRECTIVE);

    headers.set("Content-Security-Policy", directives.join("; "));
    headers.set("X-Frame-Options", "DENY");
  });
}

/** Apply framing protection to static files, route responses, and early exits. */
export function frameProtection<State>(): Middleware<State> {
  return async function frameProtection(ctx) {
    return applyFrameProtection(await ctx.next());
  };
}
