/** Minimal document framing policy, kept separate from script/style CSP rules. */

import { STATUS_TEXT, type StatusCode } from "@std/http/status";
import { HttpError, type Middleware } from "fresh";

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

/**
 * The answer Fresh's own top-level error handler would give for `error`,
 * which it builds outside the middleware chain with no headers at all, so a
 * thrown denial (csrf()'s 403, an unmatched route's 404 or 405, a handler's
 * 500) would otherwise skip every header policy. Logged the way Fresh logs it.
 */
export function errorResponse(error: unknown): Response {
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (error instanceof HttpError) {
    // deno-lint-ignore no-console
    if (error.status >= 500) console.error(error);
    const message = error.message ||
      STATUS_TEXT[error.status as StatusCode] || "Error";
    return new Response(message, { status: error.status, headers });
  }
  // deno-lint-ignore no-console
  console.error(error);
  return new Response("Internal server error", { status: 500, headers });
}

/**
 * Apply framing protection to static files, route responses, and early
 * exits, whether a denial is returned or thrown.
 */
export function frameProtection<State>(): Middleware<State> {
  return async function frameProtection(ctx) {
    let response: Response;
    try {
      response = await ctx.next();
    } catch (error) {
      response = errorResponse(error);
    }
    return applyFrameProtection(response);
  };
}
