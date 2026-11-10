/**
 * The per-client limit on the adaptation guide's session routes: wrong
 * resume codes and new session files, counted the way the login limiter
 * counts wrong passphrases, on the same ledger.
 */

import type { Middleware } from "fresh";

import { CREATED_HEADER } from "./adapt_session_api.ts";
import {
  AttemptLedger,
  type LoginPostLimiterOptions,
  remoteClientKey,
  resolveOptions,
} from "./login_post_limiter.ts";

export const SESSION_PER_CLIENT_LIMIT = 10;

const OPERATIONS = ["create", "save", "resume"] as const;
type Operation = typeof OPERATIONS[number];

/**
 * Which session route a path names, with separator-normalised aliases
 * counted as the route itself, as isLoginPostPath() does for /login; null
 * for any other path.
 */
export function isAdaptSessionPath(
  pathname: string,
  basePath = "",
): Operation | null {
  let candidate = pathname;
  if (basePath) {
    if (!candidate.startsWith(`${basePath}/`)) return null;
    candidate = candidate.slice(basePath.length);
  }
  let segments: string[];
  try {
    segments = decodeURIComponent(candidate).split("/").filter(Boolean);
  } catch {
    return null;
  }
  const [adapt, session, operation, ...rest] = segments;
  return adapt === "adapt" && session === "session" && rest.length === 0 &&
      (OPERATIONS as readonly string[]).includes(operation)
    ? operation as Operation
    : null;
}

function limited(retryAfterSeconds: number): Response {
  return Response.json({ error: "limited" }, {
    status: 429,
    headers: {
      "Cache-Control": "private, no-store",
      "Retry-After": String(retryAfterSeconds),
    },
  });
}

/**
 * Limit POSTs to the three session routes per client and across the
 * process, on a ledger of its own so that resuming a session cannot spend a
 * visitor's sign-in attempts or the other way round.
 *
 * A resume that finds no session stays counted, as a wrong passphrase does,
 * and so does any response that made a new file (a create, or a save that
 * revived an expired session), which bounds how fast one client can fill
 * the volume. Everything else, an ordinary save and a resume that finds its
 * session among them, releases only its own reservation and forgives
 * nothing. Unlike a correct passphrase, a found session must not clear the
 * client's earlier counts: anyone can create a session and so hold a valid
 * code, and forgiving on success would let a client alternate creates or
 * guesses with a resume of its own code and never be limited. The cost is
 * that someone who mistypes their code ten times waits out the window.
 * The client is identified exactly as the login
 * limiter identifies it, `trustedClientIpHeader` included.
 */
export function adaptSessionLimiter<State>(
  options: LoginPostLimiterOptions = {},
): Middleware<State> {
  const resolved = resolveOptions({
    perClientLimit: SESSION_PER_CLIENT_LIMIT,
    ...options,
  });
  const header = resolved.trustedClientIpHeader;
  const ledger = new AttemptLedger(resolved);

  return async function adaptSessionLimiter(ctx) {
    const operation = ctx.req.method === "POST"
      ? isAdaptSessionPath(ctx.url.pathname, ctx.config.basePath)
      : null;
    if (operation === null) return await ctx.next();

    const forwarded = header ? ctx.req.headers.get(header) : null;
    const reservation = ledger.reserve(
      forwarded ? `header:${forwarded}` : remoteClientKey(ctx.info.remoteAddr),
    );
    if (!reservation.allowed) return limited(reservation.retryAfterSeconds);

    let response: Response;
    try {
      response = await ctx.next();
    } catch (error) {
      reservation.settle("other");
      throw error;
    }

    reservation.settle(
      response.headers.get(CREATED_HEADER) === "created" ||
        (operation === "resume" && response.status === 404)
        ? "auth-failure"
        : "other",
    );
    return response;
  };
}
