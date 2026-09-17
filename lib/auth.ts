/**
 * The passphrase login: one shared passphrase, a 30-day signed cookie, no
 * store.
 *
 * Server-only. Nothing in here may be imported by an island. Every function
 * takes its secret as an argument rather than reading the environment, so
 * the routes stay thin and this file stays fully testable; `loginConfig`
 * is the one place the environment is read, and it too takes its reader.
 *
 * The session is a stateless token, `"<expiresMs>.<base64url HMAC>"`: the
 * HMAC is SHA-256 over the expiry string under DASHBOARD_SESSION_SECRET, so
 * a token cannot be forged or extended without the secret, and rotating the
 * secret logs everyone out at once. The passphrase and the session secret
 * are separate so that a memorable passphrase cannot become a guessable
 * signing key. `main.ts` applies a bounded, process-local login limiter before
 * this module is called; passphrase entropy remains important because restarts
 * clear that limiter and replicas do not share it.
 */
import { timingSafeEqual } from "@std/crypto/timing-safe-equal";
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import { type Cookie, deleteCookie, setCookie } from "@std/http/cookie";

export const SESSION_COOKIE = "svd_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const LOGIN_PATH = "/login";
export const LOGOUT_PATH = "/logout";

/** The two routes the gate lets through without a session. */
export function isExemptPath(pathname: string): boolean {
  return pathname === LOGIN_PATH || pathname === LOGOUT_PATH;
}

/** Hosts served over plain HTTP in development; the cookie is Secure elsewhere. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

const PASSPHRASE_VAR = "DASHBOARD_PASSPHRASE";
const SESSION_SECRET_VAR = "DASHBOARD_SESSION_SECRET";

export interface LoginConfig {
  passphrase: string;
  sessionSecret: string;
}

const encoder = new TextEncoder();

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/** A token that expires `SESSION_TTL_MS` after `now`. */
export async function issueSession(
  secret: string,
  now: number = Date.now(),
): Promise<string> {
  const expiry = String(now + SESSION_TTL_MS);
  const key = await hmacKey(secret, "sign");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(expiry),
  );
  return `${expiry}.${encodeBase64Url(signature)}`;
}

/**
 * True only for a token this secret issued that has not yet expired.
 *
 * `crypto.subtle.verify` compares in constant time, so the shape checks
 * before it are the only early returns, and each of them rejects a value no
 * honest client would ever send.
 */
export async function verifySession(
  secret: string,
  value: string | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (value === undefined) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expiry = value.slice(0, dot);
  if (!/^\d{1,15}$/.test(expiry) || Number(expiry) <= now) return false;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    // Copied so the view is over a plain ArrayBuffer, which is what
    // `BufferSource` demands; decodeBase64Url types its buffer more loosely.
    signature = new Uint8Array(decodeBase64Url(value.slice(dot + 1)));
  } catch {
    return false;
  }
  const key = await hmacKey(secret, "verify");
  return await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(expiry),
  );
}

/**
 * Constant-time comparison of two passphrases. Both are digested first so
 * the comparison never depends on either length.
 */
export async function passphraseMatches(
  expected: string,
  given: string,
): Promise<boolean> {
  const [a, b] = await Promise.all(
    [expected, given].map((s) =>
      crypto.subtle.digest("SHA-256", encoder.encode(s))
    ),
  );
  return timingSafeEqual(a, b);
}

/**
 * The path to return to after login, or `/` when the value is anything
 * else. Only a path that starts with exactly one `/` passes: `//host` is a
 * scheme-relative URL, and browsers read `/\host` the same way.
 */
export function safeNext(raw: string | null | undefined): string {
  return typeof raw === "string" && /^\/(?![/\\])/.test(raw) ? raw : "/";
}

/** The session cookie: HttpOnly, Lax, site-wide, 30 days, Secure off localhost. */
export function sessionCookie(value: string, hostname: string): Cookie {
  return {
    name: SESSION_COOKIE,
    value,
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
    secure: !LOCAL_HOSTS.has(hostname),
  };
}

/**
 * Both variables, or `null` when either is missing or empty. `null` is what
 * makes the gate fail closed: the caller answers 503 rather than opening.
 */
export function loginConfig(
  get: (name: string) => string | undefined = (name) => Deno.env.get(name),
): LoginConfig | null {
  const passphrase = get(PASSPHRASE_VAR);
  const sessionSecret = get(SESSION_SECRET_VAR);
  if (!passphrase || !sessionSecret) return null;
  return { passphrase, sessionSecret };
}

/** The fail-closed answer: a 503 naming the variables, never the site. */
export function notConfiguredResponse(): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
      `<title>Login is not configured</title></head><body>` +
      `<h1>Login is not configured</h1>` +
      `<p>This deployment is missing <code>${PASSPHRASE_VAR}</code> or ` +
      `<code>${SESSION_SECRET_VAR}</code>. Set both and redeploy.</p>` +
      `</body></html>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

/** The POST /logout answer: the cookie cleared, and back to the login page. */
export function logoutResponse(): Response {
  const headers = new Headers({ location: LOGIN_PATH });
  deleteCookie(headers, SESSION_COOKIE, { path: "/" });
  return new Response(null, { status: 303, headers });
}

/**
 * The POST /login decision: a redirect carrying the session cookie when the
 * passphrase matches, `null` when it does not so the route can re-render
 * the form.
 */
export async function loginResponse(
  config: LoginConfig,
  form: FormData,
  hostname: string,
  now: number = Date.now(),
): Promise<Response | null> {
  const given = form.get("passphrase");
  if (
    typeof given !== "string" ||
    !(await passphraseMatches(config.passphrase, given))
  ) {
    return null;
  }
  const headers = new Headers({
    location: safeNext(form.get("next")?.toString()),
  });
  setCookie(
    headers,
    sessionCookie(await issueSession(config.sessionSecret, now), hostname),
  );
  return new Response(null, { status: 303, headers });
}
