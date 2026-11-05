/**
 * The `Origin` check behind Fresh's `csrf()`.
 *
 * When a browser sends no `Sec-Fetch-Site` -- Safari before 16.4, Firefox
 * before 90, or anything a proxy or extension strips it from -- `csrf()`
 * falls back to comparing `Origin` with `ctx.url.origin`. Fly terminates TLS
 * at its edge, so the app sees an `http://` URL while the browser's
 * `Origin` says `https://`, and every sign-in and sign-out from
 * such a browser was a bare 403. The page's own host over HTTPS is the same
 * site; no other site can make a browser send it.
 */

import { csrf, type Middleware } from "fresh";

export function isSameSiteOrigin(origin: string, url: URL): boolean {
  return origin === url.origin || origin === `https://${url.host}`;
}

/** `csrf()`, accepting this host's own origin over HTTPS behind a proxy. */
export function sameSiteCsrf<State>(): Middleware<State> {
  return csrf<State>({
    origin: (origin, ctx) => isSameSiteOrigin(origin, ctx.url),
  });
}
