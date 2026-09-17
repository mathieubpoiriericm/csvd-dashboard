import { getCookies } from "@std/http/cookie";

import { define } from "../utils.ts";
import {
  isExemptPath,
  LOGIN_PATH,
  loginConfig,
  LOGOUT_PATH,
  notConfiguredResponse,
  SESSION_COOKIE,
  verifySession,
} from "../lib/auth.ts";

/**
 * The login gate. Runs for every file route and lets through only /login,
 * /logout and requests carrying a valid session cookie. Ordinary static
 * assets are served before file routing; main.ts gives the generated
 * protected-data chunk its own equivalent session check before staticFiles().
 *
 * It fails closed: with either secret unset, every gated route answers 503
 * rather than opening. There is no environment-sniffing bypass for
 * development; put the two variables in .env instead.
 */
export const requireLogin = define.middleware(async (ctx) => {
  const { pathname, search } = ctx.url;
  const canonical = canonicalAuthPath(pathname);
  if (canonical !== null) {
    // 308 keeps POST as POST, so /login/ and /logout/ can be canonicalized
    // without turning a credential or sign-out submission into a GET.
    return noStore(ctx.redirect(canonical + search, 308));
  }
  if (isExemptPath(pathname)) return noStore(await ctx.next());

  const config = loginConfig();
  if (config === null) return noStore(notConfiguredResponse());

  const cookie = getCookies(ctx.req.headers)[SESSION_COOKIE];
  if (await verifySession(config.sessionSecret, cookie)) {
    ctx.state.authenticated = true;
    return noStore(await ctx.next());
  }

  const next = encodeURIComponent(pathname + search);
  return noStore(ctx.redirect(`${LOGIN_PATH}?next=${next}`, 303));
});

function canonicalAuthPath(pathname: string): string | null {
  if (pathname === `${LOGIN_PATH}/`) return LOGIN_PATH;
  if (pathname === `${LOGOUT_PATH}/`) return LOGOUT_PATH;
  return null;
}

/** Prevent browsers from restoring authenticated file-route responses. */
function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export default requireLogin;
