/**
 * In-process protection for the public POST /login password check, and the
 * machinery every POST limiter shares.
 *
 * This module owns how a client is identified (clientKeyOf), the bounded
 * attempt ledger, and the middleware body (postLimiter): match the path,
 * reserve, refuse, and settle the reservation from the response, or as
 * "other" when the route throws. A limiter supplies only what differs: which
 * paths it counts, what a response means for the count, and how a refusal
 * reads. loginPostLimiter is the login's configuration; the adapt guide's
 * session routes have theirs in server/adapt_session_limiter.ts, on a ledger
 * of their own.
 */

import type { Middleware } from "fresh";

import { LOGIN_PATH, SESSION_COOKIE } from "../lib/auth.ts";

export const LOGIN_LIMIT_WINDOW_MS = 60_000;
export const LOGIN_PER_CLIENT_LIMIT = 5;
export const LOGIN_GLOBAL_LIMIT = 64;
export const LOGIN_MAX_TRACKED_CLIENTS = 64;

/**
 * Names the header a proxying host's ingress sets with the visitor's address
 * (fly.toml sets Fly-Client-IP). main.ts hands it to both limiters, and the
 * adapt session routes read it to key a client's sessions the same way.
 */
export const CLIENT_IP_HEADER_VAR = "LOGIN_CLIENT_IP_HEADER";

type AttemptState = "pending" | "failed";
export type AttemptOutcome = "auth-failure" | "success" | "other";

interface Attempt {
  id: number;
  client: string;
  createdAt: number;
  state: AttemptState;
}

interface AcceptedReservation {
  allowed: true;
  settle(outcome: AttemptOutcome): void;
}

interface RejectedReservation {
  allowed: false;
  retryAfterSeconds: number;
}

type Reservation = AcceptedReservation | RejectedReservation;

export interface LoginPostLimiterOptions {
  perClientLimit?: number;
  globalLimit?: number;
  windowMs?: number;
  maxTrackedClients?: number;
  now?: () => number;
  trustedClientIpHeader?: string;
}

export interface ResolvedOptions {
  perClientLimit: number;
  globalLimit: number;
  windowMs: number;
  maxTrackedClients: number;
  now: () => number;
  trustedClientIpHeader: string | undefined;
}

/** Headers a client may append to, so no single value in them names the client. */
const FORWARDING_LISTS = new Set(["x-forwarded-for", "forwarded"]);

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function trustedHeaderName(name: string | undefined): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;
  // Headers rejects an invalid name with a TypeError, so a typo in the
  // deployment's setting fails at startup instead of on every sign-in.
  new Headers().has(trimmed);
  if (FORWARDING_LISTS.has(trimmed.toLowerCase())) {
    throw new TypeError(
      `${trimmed} is a client-appendable list and cannot identify a client`,
    );
  }
  return trimmed;
}

export function resolveOptions(
  options: LoginPostLimiterOptions,
): ResolvedOptions {
  return {
    perClientLimit: positiveInteger(
      options.perClientLimit ?? LOGIN_PER_CLIENT_LIMIT,
      "perClientLimit",
    ),
    globalLimit: positiveInteger(
      options.globalLimit ?? LOGIN_GLOBAL_LIMIT,
      "globalLimit",
    ),
    windowMs: positiveInteger(
      options.windowMs ?? LOGIN_LIMIT_WINDOW_MS,
      "windowMs",
    ),
    maxTrackedClients: positiveInteger(
      options.maxTrackedClients ?? LOGIN_MAX_TRACKED_CLIENTS,
      "maxTrackedClients",
    ),
    now: options.now ?? Date.now,
    trustedClientIpHeader: trustedHeaderName(options.trustedClientIpHeader),
  };
}

/**
 * The part of an address that names one client. An IPv6 address is grouped
 * on its /64, the block one host or household is ordinarily given, so a
 * single sender cannot mint a fresh client for every request from inside it
 * and fill the tracked-client cap or the global limit on its own (which would
 * refuse every other visitor's sign-in). The address is parsed and
 * canonicalised first, so two spellings of one address group together; an
 * IPv4-mapped IPv6 address is keyed as the IPv4 address it carries. Anything
 * that does not parse as IPv6 (an IPv4 address, a malformed header) is kept
 * as it was.
 */
export function addressKey(address: string): string {
  const trimmed = address.trim();
  if (!trimmed.includes(":")) return trimmed;
  let canonical: string;
  try {
    canonical = new URL(`http://[${trimmed.replace(/^\[|\]$/g, "")}]/`)
      .hostname.slice(1, -1);
  } catch {
    return trimmed;
  }
  const [head, tail] = canonical.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined
    ? left
    : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return trimmed;
  const hextets = groups.map((group) => parseInt(group, 16));
  if (hextets.slice(0, 5).every((n) => n === 0) && hextets[5] === 0xffff) {
    return [
      hextets[6] >> 8,
      hextets[6] & 255,
      hextets[7] >> 8,
      hextets[7] & 255,
    ].join(".");
  }
  return `${groups.slice(0, 4).join(":")}::/64`;
}

/** The socket peer only: source ports and client-controlled forwarding headers are ignored. */
export function remoteClientKey(
  address: Deno.ServeHandlerInfo["remoteAddr"],
): string {
  if ("hostname" in address) {
    return `${address.transport}:${addressKey(address.hostname)}`;
  }
  if ("path" in address) return `${address.transport}:${address.path}`;
  return address.transport;
}

/**
 * The key one client is counted under: the value of the trusted client-IP
 * header when `header` names one and the request carries it, the socket peer
 * otherwise, with an IPv6 address grouped on its /64 (addressKey). Every
 * limiter and the adapt session routes derive the key here, so they can
 * never disagree about who a client is. `header` may be the
 * environment's raw value; resolveOptions() has already refused a bad one at
 * start-up.
 */
export function clientKeyOf(
  ctx: { req: Request; info: Deno.ServeHandlerInfo },
  header: string | undefined,
): string {
  const name = header?.trim();
  const forwarded = name ? ctx.req.headers.get(name) : null;
  return forwarded
    ? `header:${addressKey(forwarded)}`
    : remoteClientKey(ctx.info.remoteAddr);
}

/**
 * Treat separator-normalized aliases as the same login endpoint. This is
 * deliberately a little broader than today's router so a future Fresh route
 * normalization cannot expose an unreserved password check.
 */
export function isLoginPostPath(pathname: string, basePath = ""): boolean {
  let candidate = pathname;
  if (basePath) {
    if (candidate === basePath) candidate = "/";
    else if (candidate.startsWith(`${basePath}/`)) {
      candidate = candidate.slice(basePath.length);
    } else {
      return false;
    }
  }

  try {
    const segments = decodeURIComponent(candidate).split("/").filter(Boolean);
    return segments.length === 1 && segments[0] === "login";
  } catch (error) {
    if (error instanceof URIError) return false;
    throw error;
  }
}

/**
 * A timer-free, bounded attempt ledger. A reservation is inserted synchronously
 * before the route begins its asynchronous password check, so concurrent guesses
 * cannot all observe the same remaining slot. Expired entries are pruned on the
 * next request; globalLimit bounds tokens and maxTrackedClients bounds map keys.
 */
export class AttemptLedger {
  readonly #options: ResolvedOptions;
  #attempts: Attempt[] = [];
  #byClient = new Map<string, Attempt[]>();
  #nextId = 1;

  constructor(options: ResolvedOptions) {
    this.#options = options;
  }

  /**
   * `perClientOnly` reserves against the client's own limit alone, for a
   * request that other clients' attempts must not refuse. Its reservation
   * still joins the ledger, so while pending or once counted it weighs on
   * everyone else's global and tracked-client checks as any other does.
   */
  reserve(client: string, perClientOnly = false): Reservation {
    const now = this.#options.now();
    this.#prune(now);

    const clientAttempts = this.#byClient.get(client) ?? [];
    const waits: number[] = [];
    if (clientAttempts.length >= this.#options.perClientLimit) {
      waits.push(this.#retryAfter(clientAttempts, now));
    }
    if (
      !perClientOnly && this.#attempts.length >= this.#options.globalLimit
    ) {
      waits.push(this.#retryAfter(this.#attempts, now));
    }
    if (
      !perClientOnly && clientAttempts.length === 0 &&
      this.#byClient.size >= this.#options.maxTrackedClients
    ) {
      waits.push(this.#retryAfterTrackedClientSlot(now));
    }

    if (waits.length > 0) {
      return { allowed: false, retryAfterSeconds: Math.max(...waits) };
    }

    const attempt: Attempt = {
      id: this.#nextId++,
      client,
      createdAt: now,
      state: "pending",
    };
    this.#attempts.push(attempt);
    this.#byClient.set(client, [...clientAttempts, attempt]);

    let settled = false;
    return {
      allowed: true,
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        this.#settle(attempt, outcome);
      },
    };
  }

  #settle(attempt: Attempt, outcome: AttemptOutcome): void {
    if (!this.#attempts.includes(attempt)) return;

    if (outcome === "auth-failure") {
      attempt.state = "failed";
      return;
    }

    if (outcome === "success") {
      // Clear this successful request and completed earlier failures for the
      // same peer. Earlier guesses still in flight remain reserved and become
      // failures if their responses later say so.
      this.#remove((candidate) =>
        candidate === attempt ||
        (candidate.client === attempt.client &&
          candidate.id <= attempt.id && candidate.state === "failed")
      );
      return;
    }

    // Parser/config/server failures did not prove a bad password. Release only
    // this reservation without forgiving earlier authentication failures.
    this.#remove((candidate) => candidate === attempt);
  }

  #prune(now: number): void {
    this.#remove((attempt) =>
      attempt.createdAt + this.#options.windowMs <= now
    );
  }

  #remove(predicate: (attempt: Attempt) => boolean): void {
    if (!this.#attempts.some(predicate)) return;
    this.#attempts = this.#attempts.filter((attempt) => !predicate(attempt));
    this.#rebuildClientIndex();
  }

  #rebuildClientIndex(): void {
    const next = new Map<string, Attempt[]>();
    for (const attempt of this.#attempts) {
      const entries = next.get(attempt.client);
      if (entries) entries.push(attempt);
      else next.set(attempt.client, [attempt]);
    }
    this.#byClient = next;
  }

  #retryAfter(attempts: readonly Attempt[], now: number): number {
    const retryAt = Math.min(
      ...attempts.map((attempt) => attempt.createdAt + this.#options.windowMs),
    );
    return Math.max(1, Math.ceil((retryAt - now) / 1000));
  }

  #retryAfterTrackedClientSlot(now: number): number {
    const retryAt = Math.min(
      ...this.#byClient.values().map((attempts) =>
        Math.max(
          ...attempts.map((attempt) =>
            attempt.createdAt + this.#options.windowMs
          ),
        )
      ),
    );
    return Math.max(1, Math.ceil((retryAt - now) / 1000));
  }
}

/**
 * The wait in words, rounded up to whole minutes: the per-client window is a
 * minute, so this is usually "about a minute".
 */
export function waitInWords(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
}

/**
 * The login refusal, as a page: a browser shows it in place of the form, so
 * it carries a title, a language, the wait in words (Retry-After is not shown
 * to anyone) and a way back to <basePath>/login (absolute: the POST may have
 * come in on an alias such as "/login/"). The wording blames no one, because
 * the global limit and the tracked-client cap refuse visitors who never
 * failed. A static string, not the login card: the limiter runs before any
 * route renders.
 */
export function tooManyRequests(
  retryAfterSeconds: number,
  basePath = "",
): Response {
  const wait = waitInWords(retryAfterSeconds);
  const back = escapeAttribute(`${basePath}${LOGIN_PATH}`);
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>Too many sign-in attempts</title></head><body>` +
      `<main><h1>Too many sign-in attempts</h1>` +
      `<p role="alert">This site has received too many sign-in attempts ` +
      `right now. Please try again in ${wait}.</p>` +
      `<p><a href="${back}">Back to sign in</a></p></main>` +
      `</body></html>`,
    {
      status: 429,
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Type": "text/html; charset=utf-8",
        "Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function issuedSession(response: Response): boolean {
  return response.status >= 200 && response.status < 400 &&
    response.headers.getSetCookie().some((cookie) =>
      cookie.trimStart().startsWith(`${SESSION_COOKIE}=`)
    );
}

/**
 * Limit exact POST /login requests per client and across this process.
 *
 * Counters are deliberately process-local: restarts clear them and N replicas
 * allow roughly N times the global limit. A deployment with multiple workers or
 * instances still needs a distributed ingress limit.
 *
 * The client is the socket peer, ctx.info.remoteAddr, unless the deployment
 * names `trustedClientIpHeader`. Behind a proxying host every socket peer is
 * the proxy, so all visitors would otherwise share one bucket and five wrong
 * guesses from anyone would lock out everyone. Name only a header the host's
 * ingress proxy sets on every request (Fly.io's `Fly-Client-IP`), and only
 * where that proxy is the sole way in. A request without it falls back to the
 * socket peer. X-Forwarded-For and Forwarded are refused outright: a client
 * can append to both. Even a spoofable header cannot raise the guess rate past
 * the global limit, which keys on nothing a client sends.
 */
export function loginPostLimiter<State>(
  options: LoginPostLimiterOptions = {},
): Middleware<State> {
  return postLimiter<State, true>(
    resolveOptions(options),
    (pathname, basePath) => isLoginPostPath(pathname, basePath) || null,
    (response) =>
      response.status === 401
        ? "auth-failure"
        : issuedSession(response)
        ? "success"
        : "other",
    tooManyRequests,
  );
}

/**
 * The middleware every POST limiter runs, on a ledger of its own. `match`
 * says which counted route a POST's path names, or null to pass it through
 * uncounted; `outcomeOf` turns the route's response into what the ledger
 * records; `refuse` is the answer once the client or the process is over its
 * limit. A route that throws releases its reservation as "other".
 * `perClientOnly` names the matches held to the client's own limit alone
 * (AttemptLedger.reserve); by default every match is held to all three.
 */
export function postLimiter<State, Match>(
  resolved: ResolvedOptions,
  match: (pathname: string, basePath: string) => Match | null,
  outcomeOf: (response: Response, match: Match) => AttemptOutcome,
  refuse: (retryAfterSeconds: number, basePath: string) => Response,
  perClientOnly: (match: Match) => boolean = () => false,
): Middleware<State> {
  const header = resolved.trustedClientIpHeader;
  const ledger = new AttemptLedger(resolved);

  return async function postLimiter(ctx) {
    const matched = ctx.req.method === "POST"
      ? match(ctx.url.pathname, ctx.config.basePath)
      : null;
    if (matched === null) return await ctx.next();

    const reservation = ledger.reserve(
      clientKeyOf(ctx, header),
      perClientOnly(matched),
    );
    if (!reservation.allowed) {
      return refuse(reservation.retryAfterSeconds, ctx.config.basePath);
    }

    let response: Response;
    try {
      response = await ctx.next();
    } catch (error) {
      reservation.settle("other");
      throw error;
    }

    reservation.settle(outcomeOf(response, matched));
    return response;
  };
}
