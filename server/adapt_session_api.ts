/**
 * The three POST handlers behind /adapt/session/{create,save,resume}.
 *
 * The resume code travels in the JSON body only, never in a URL, so it
 * reaches no access log, history entry or Referer. The routes sit behind the
 * login gate and csrf() like every other write (main.ts); the per-client
 * limit on wrong codes and new sessions is server/adapt_session_limiter.ts.
 * Each handler takes the store as an argument, so a test can give it one on
 * a temporary directory instead of the process's environment, and the holder
 * likewise: on a machine that does not hold the sessions, every request is
 * handed over before its body is read (server/adapt_session_holder.ts).
 */

import { IMPORT_BYTE_LIMIT, parseExport } from "../lib/adapt/bundle.ts";
import { normaliseCode } from "../lib/adapt/session_code.ts";
import { type Holder, replayToHolder } from "./adapt_session_holder.ts";
import type { SessionStore } from "./adapt_sessions.ts";

/** Set to "created" on a response that made a new session file. */
export const CREATED_HEADER = "X-Adapt-Session";

/** An export at the limit, escaped into a JSON string, plus the other fields. */
const BODY_BYTE_LIMIT = IMPORT_BYTE_LIMIT + 4096;
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
 * The body as text, or null once it is past BODY_BYTE_LIMIT. Counted as it
 * arrives, so neither a false Content-Length nor a body without one makes
 * the server hold more than the limit.
 */
async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > BODY_BYTE_LIMIT) {
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
    if (total > BODY_BYTE_LIMIT) {
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

/** The body's answers, checked as Import checks a file, or the refusal. */
function readAnswers(body: Body): string | Response {
  const { answers } = body;
  if (typeof answers !== "string") return invalid();
  if (new TextEncoder().encode(answers).byteLength > IMPORT_BYTE_LIMIT) {
    return tooLarge();
  }
  const parsed = parseExport(answers);
  return "error" in parsed ? invalid(parsed.error) : answers;
}

function readCode(body: Body): string | null {
  return typeof body.code === "string" ? normaliseCode(body.code) : null;
}

const unavailable = (error: "full" | "failed") => reply(503, { error });

const HERE: Holder = { kind: "here" };

export async function handleCreate(
  req: Request,
  store: SessionStore | null,
  holder: Holder = HERE,
): Promise<Response> {
  if (holder.kind === "elsewhere") return replayToHolder(holder.machine);
  if (store === null) return off();
  const body = await readJson(req);
  if (body instanceof Response) return body;
  const answers = readAnswers(body);
  if (answers instanceof Response) return answers;
  const result = await store.create(answers);
  if ("error" in result) return unavailable(result.error);
  return reply(201, result, true);
}

export async function handleSave(
  req: Request,
  store: SessionStore | null,
  holder: Holder = HERE,
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
  const answers = readAnswers(body);
  if (answers instanceof Response) return answers;
  const result = await store.save(
    code,
    { revision: revision as number, savedAt: savedAt as number | undefined },
    answers,
    force,
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
