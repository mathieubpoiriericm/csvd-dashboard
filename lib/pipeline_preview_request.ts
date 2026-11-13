/**
 * Whether a request switches the About page's pipeline preview on.
 *
 * Server-only, and apart from `lib/pipeline_preview.ts` for that reason: the
 * island and `e2e/fixtures/expected.deno.ts` import that module, and the cookie
 * parser here would follow it into the client bundle and into every
 * `deno run` that cannot resolve `@std` through the root's import map.
 */
import { getCookies } from "@std/http/cookie";

import { PREVIEW_COOKIE, previewCookie } from "./pipeline_preview.ts";

/** Whether the request's cookies switch the preview on. */
export function previewRequested(headers: Headers): boolean {
  return getCookies(headers)[PREVIEW_COOKIE] === "1";
}

/**
 * The `Set-Cookie` value that renews the preview cookie, or `null` when
 * there is nothing to renew.
 *
 * The switch writes the cookie from script, and WebKit caps a cookie
 * written that way at seven days whatever `Max-Age` asks for, so a Safari
 * visitor found the preview switched off a week later. A cookie the server
 * sets is not capped: the page that draws the preview (`offered`: gold-only
 * with a run recorded) sends the visitor's own cookie back for the year the
 * switch asked for. It is the switch's assignment byte for byte, and not
 * `HttpOnly`, so the switch still clears it. The server never turns the
 * preview on: a request without the cookie gets none.
 */
export function previewRenewal(
  headers: Headers,
  offered: boolean,
): string | null {
  return offered && previewRequested(headers) ? previewCookie(true) : null;
}
