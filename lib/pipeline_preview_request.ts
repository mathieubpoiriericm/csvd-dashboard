/**
 * Whether a request switches the About page's pipeline preview on.
 *
 * Server-only, and apart from `lib/pipeline_preview.ts` for that reason: the
 * island and `e2e/fixtures/expected.deno.ts` import that module, and the cookie
 * parser here would follow it into the client bundle and into every
 * `deno run` that cannot resolve `@std` through the root's import map.
 */
import { getCookies } from "@std/http/cookie";

import { PREVIEW_COOKIE } from "./pipeline_preview.ts";

/** Whether the request's cookies switch the preview on. */
export function previewRequested(headers: Headers): boolean {
  return getCookies(headers)[PREVIEW_COOKIE] === "1";
}
