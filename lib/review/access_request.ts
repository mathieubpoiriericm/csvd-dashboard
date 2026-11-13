/**
 * Whether a request is from a visitor in the review area.
 *
 * Server-only, and apart from `lib/review/access.ts` for that reason: the
 * navbar's Review control imports that module, and the cookie parser here
 * would follow it into the island's client bundle.
 */
import { getCookies } from "@std/http/cookie";

import { isReviewPath, REVIEW_COOKIE } from "./access.ts";

/**
 * Entered as an observer: the cookie says so, or the page is in the review
 * area itself, which a deep link reaches without the cookie.
 */
export function observerEntered(headers: Headers, pathname: string): boolean {
  return getCookies(headers)[REVIEW_COOKIE] === "1" || isReviewPath(pathname);
}
