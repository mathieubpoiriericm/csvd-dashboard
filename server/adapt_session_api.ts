/**
 * The three POST handlers behind /adapt/session/{create,save,resume}.
 *
 * The resume code travels in the JSON body only, never in a URL, so it
 * reaches no access log, history entry or Referer. The routes sit behind the
 * login gate and csrf() like every other write (main.ts); the per-client
 * limit on wrong codes and new sessions is server/adapt_session_limiter.ts,
 * and the cap on how many sessions one connection holds is the store's
 * (SESSION_PER_CLIENT_CAP), given the owner tag these handlers derive from
 * the route's client key. Each handler takes the store as an argument, so a test can give it one on
 * a temporary directory instead of the process's environment, and the holder
 * likewise: on a machine that does not hold the sessions, every request is
 * handed over before its body is read (server/adapt_session_holder.ts).
 */

import type { Answers } from "../lib/adapt/answers.ts";
import { type Imported, parseExport } from "../lib/adapt/bundle.ts";
import { normaliseCode } from "../lib/adapt/session_code.ts";
import { loginConfig } from "../lib/auth.ts";
import { type Holder, replayToHolder } from "./adapt_session_holder.ts";
import type { SessionStore } from "./adapt_sessions.ts";

/** Set to "created" on a response that made a new session file. */
export const CREATED_HEADER = "X-Adapt-Session";

/**
 * The largest body the three routes read, in bytes. Two logos at their 1 MB
 * cap make an export of about 2.7 MB, escaped into a JSON string with the
 * other fields; this leaves room for that and no more. It is well under
 * IMPORT_BYTE_LIMIT (lib/adapt/bundle.ts), which bounds a file imported in
 * the browser and so never reaches the server: each request here is held
 * several times over while it is parsed, on a machine that serves the whole
 * dashboard, and every byte of it may end up on the session volume.
 *
 * The gap between the two limits is deliberate, not an oversight: the volume
 * is 1 GB shared by every session, so a draft imported at between 4 and
 * 8 MB is not saved, and its holder is told it is "too large to save as a
 * session" and to use Export answers (lib/adapt/session.ts) rather than the
 * save failing silently.
 */
export const SESSION_BODY_LIMIT = 4_000_000;
const NOT_A_REQUEST = "That request is not one this page sends.";

type Body = Record<string, unknown>;

function reply(
  status: number,
  body: unknown,
  created = false,
): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
  });
  if (created) headers.set(CREATED_HEADER, "created");
  return new Response(JSON.stringify(body), { status, headers });
}

const off = () => reply(404, { error: "off" });
const tooLarge = () => reply(413, { error: "too-large" });
const invalid = (message = NOT_A_REQUEST) =>
  reply(400, { error: "invalid", message });

/**
 * The body as text, or null once it is past SESSION_BODY_LIMIT. Counted as it
 * arrives, so neither a false Content-Length nor a body without one makes
 * the server hold more than the limit.
 */
async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > SESSION_BODY_LIMIT) {
    await req.body?.cancel();
    return null;
  }
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SESSION_BODY_LIMIT) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The body as a JSON object, or the response that refuses it. */
async function readJson(req: Request): Promise<Body | Response> {
  const text = await readCapped(req);
  if (text === null) return tooLarge();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return invalid();
  }
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? body as Body
    : invalid();
}

/**
 * The body's answers, parsed as Import parses a file, or the refusal. Their
 * size needs no check of its own: the body around them is already within
 * SESSION_BODY_LIMIT. The parsed answers go to the store as they are, so the
 * export is parsed once; the store still blanks the NCBI pair itself.
 */
function readAnswers(
  body: Body,
  parse: (text: string) => Imported,
): Answers | Response {
  const { answers } = body;
  if (typeof answers !== "string") return invalid();
  const parsed = parse(answers);
  return "error" in parsed ? invalid(parsed.error) : parsed.answers;
}

function readCode(body: Body): string | null {
  return typeof body.code === "string" ? normaliseCode(body.code) : null;
}

const HERE: Holder = { kind: "here" };

/** What a route passes beyond the request, the store and the holder. */
export interface SessionRequestOptions {
  /**
   * The client's key, as clientKeyOf() (server/login_post_limiter.ts) derives
   * it for the limiters. Without one the store applies no per-connection cap.
   */
  clientKey?: string;
  /** The key for the owner tag; loginConfig()'s session secret by default. */
  secret?: string;
  /** Reads an export's text; a test passes one that counts its calls. */
  parse?: (text: string) => Imported;
}

const encoder = new TextEncoder();

/**
 * The owner tag the store marks a connection's sessions with: the first 16
 * hex characters of HMAC-SHA256 over the client key, keyed with the session
 * secret. Without the server's secret it cannot be turned back into an
 * address, and nothing writes or logs the key itself. Rotating
 * DASHBOARD_SESSION_SECRET orphans every tag: the sessions already marked then
 * count toward nobody, which errs toward the people saving, and the markers
 * go with their sessions as usual.
 */
export async function ownerTag(
  clientKey: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(clientKey));
  return Array.from(
    new Uint8Array(mac).subarray(0, 8),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The owner tag for this request's client, or undefined when there is none. */
async function ownerOf(
  options: SessionRequestOptions,
): Promise<string | undefined> {
  if (options.clientKey === undefined) return undefined;
  const secret = options.secret ?? loginConfig()?.sessionSecret;
  return secret ? await ownerTag(options.clientKey, secret) : undefined;
}

/**
 * The answer to a store that cannot take the write: 429 for a connection at
 * its session quota (not the server failing, and no Retry-After, since
 * waiting does not free a session), 503 otherwise.
 */
const unavailable = (error: "full" | "quota" | "failed") =>
  reply(error === "quota" ? 429 : 503, { error });

export async function handleCreate(
  req: Request,
  store: SessionStore | null,
  holder: Holder = HERE,
  options: SessionRequestOptions = {},
): Promise<Response> {
  if (holder.kind === "elsewhere") return replayToHolder(holder.machine);
  if (store === null) return off();
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const answers = readAnswers(body, options.parse ?? parseExport);
  if (answers instanceof Response) return answers;
  const result = await store.create(answers, await ownerOf(options));
  if ("error" in result) return unavailable(result.error);
  return reply(201, result, true);
}

export async function handleSave(
  req: Request,
  store: SessionStore | null,
  holder: Holder = HERE,
  options: SessionRequestOptions = {},
): Promise<Response> {
  if (holder.kind === "elsewhere") return replayToHolder(holder.machine);
  if (store === null) return off();
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const code = readCode(body);
  // savedAt is optional on the wire: a page loaded before the browser sent
  // it sends none, and the store treats that as a copy it has not seen.
  const { revision, savedAt, force = false } = body;
  if (
    code === null || !Number.isSafeInteger(revision) ||
    (savedAt !== undefined && !Number.isSafeInteger(savedAt)) ||
    typeof force !== "boolean"
  ) {
    return invalid();
  }
  const answers = readAnswers(body, options.parse ?? parseExport);
  if (answers instanceof Response) return answers;
  const result = await store.save(
    code,
    { revision: revision as number, savedAt: savedAt as number | undefined },
    answers,
    force,
    await ownerOf(options),
  );
  if (!("error" in result)) return reply(200, result, result.revived);
  if (result.error === "conflict") return reply(409, result);
  return unavailable(result.error);
}

export async function handleResume(
  req: Request,
  store: SessionStore | null,
  holder: Holder = HERE,
): Promise<Response> {
  if (holder.kind === "elsewhere") return replayToHolder(holder.machine);
  if (store === null) return off();
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const code = readCode(body);
  if (code === null) return invalid();
  const result = await store.load(code);
  if ("text" in result) {
    const { text, revision, savedAt } = result;
    return reply(200, { answers: text, revision, savedAt });
  }
  // One body for a code that never existed and one whose session was
  // deleted or has expired: the caller cannot tell them apart.
  if (result.error === "unknown") return reply(404, { error: "unknown" });
  return reply(422, { error: "unreadable", message: result.message });
}
