/**
 * How a visitor is in the review area: the observer cookie and the paths that
 * count as the area.
 *
 * Observing needs no account, so the cookie is the only state and it holds no
 * identity: it says only that this browser entered as an observer, so the
 * navbar's control reads "Review · Observer" on every page until the visitor
 * leaves. It imports nothing, because the control is an island; reading the
 * cookie off a request is server-only and lives in
 * `lib/review/access_request.ts`, as the preview switch's does.
 */

/** The cookie that remembers an observer. */
export const REVIEW_COOKIE = "review_observer";

/** The cookie's lifetime in seconds: one year. */
const OBSERVER_MAX_AGE = 31536000;

/** The review area's own path, and the root of every page under it. */
const REVIEW_PATH = "/review";

/** The `document.cookie` assignment that enters or leaves as an observer. */
export function observerCookie(on: boolean): string {
  const value = on ? "1" : "";
  const maxAge = on ? OBSERVER_MAX_AGE : 0;
  return `${REVIEW_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

/** Whether a page is the review area: `/review` or a page under it. */
export function isReviewPath(pathname: string): boolean {
  return pathname === REVIEW_PATH || pathname.startsWith(`${REVIEW_PATH}/`);
}

/**
 * Whether a browser's `document.cookie` string already remembers the observer.
 * A deep link into the area enters by its path; the island writes the cookie
 * then, so the rest of the site agrees.
 */
export function hasObserverCookie(documentCookie: string): boolean {
  return documentCookie.split(";").some((pair) =>
    pair.trim() === `${REVIEW_COOKIE}=1`
  );
}
