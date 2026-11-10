/**
 * The browser's side of a saved session: the link it keeps in localStorage,
 * the client for the three /adapt/session routes, the overview the resume
 * dialog shows, and the words the island prints.
 *
 * The island that imports this is data-free, so nothing here reaches for
 * server/ or lib/data/. The server's wire format is in
 * server/adapt_session_api.ts; this module reads it, it does not import it.
 */

import type { Answers } from "./answers.ts";
import { exportText, importText } from "./bundle.ts";
import { issueLabel } from "./cards.ts";
import type { Store } from "./draft_storage.ts";
import { progressOf, stepRequired } from "./feedback.ts";
import { normaliseCode, SESSION_TTL_MS } from "./session_code.ts";
import {
  issuesFor,
  STEP_LABELS,
  STEP_ORDER,
  type StepId,
  validate,
} from "./validate.ts";

export const SESSION_KEY = "svd-adapt-session";

/**
 * The request header that sends a session request to the one machine holding
 * the sessions, when the page names one. Fly's documentation
 * (https://docs.fly.io/networking/dynamic-request-routing, read 2026-11-10)
 * says of it: "Forces routing to a specific Machine." and "No fallback if
 * Machine is ultimately unavailable." It lives here, not in server/, because
 * this module goes into a data-free island; the server imports it from here.
 */
export const FORCE_INSTANCE_HEADER = "fly-force-instance-id";

/**
 * What this browser remembers of its session: the code (the only way back),
 * the revision it last saved or read, when that was, and whether the answers
 * have changed since.
 */
export interface SessionLink {
  code: string;
  revision: number;
  savedAt: number;
  dirty: boolean;
}

/** The stored link, or null when absent, unreadable or not a link. */
export function readLink(store: Store): SessionLink | null {
  let raw: unknown;
  try {
    const text = store.getItem(SESSION_KEY);
    if (text === null) return null;
    raw = JSON.parse(text);
  } catch {
    // Storage refused (private browsing) or the JSON is damaged.
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { code, revision, savedAt, dirty } = raw as Record<string, unknown>;
  if (
    typeof code !== "string" || normaliseCode(code) !== code ||
    typeof revision !== "number" || typeof savedAt !== "number" ||
    typeof dirty !== "boolean"
  ) {
    return null;
  }
  return { code, revision, savedAt, dirty };
}

/**
 * Stores the link, or forgets it for null. A refused write is swallowed: it
 * must not turn a save that succeeded on the server into a failure here.
 */
export function writeLink(store: Store, link: SessionLink | null): void {
  try {
    if (link === null) store.removeItem(SESSION_KEY);
    else store.setItem(SESSION_KEY, JSON.stringify(link));
  } catch {
    // The session is on the server; the link is a convenience.
  }
}

export type SessionFailure =
  | "off"
  | "signed-out"
  | "limited"
  | "full"
  | "too-large"
  | "invalid"
  | "unknown"
  | "unreadable"
  | "conflict"
  | "failed";

type Failure = { ok: false; reason: SessionFailure; message: string };

export type Created = { ok: true; link: SessionLink } | Failure;
export type SavedSession =
  | { ok: true; link: SessionLink; revived: boolean }
  | (Failure & { savedAt?: number });
export type Resumed =
  | { ok: true; link: SessionLink; answers: Answers; dropped: string[] }
  | Failure;

export interface SessionClient {
  create(answers: Answers): Promise<Created>;
  save(
    link: SessionLink,
    answers: Answers,
    force: boolean,
  ): Promise<SavedSession>;
  /** The answers come back with this browser's NCBI credentials kept. */
  resume(code: string, current: Answers): Promise<Resumed>;
}

export const SESSION_COPY = {
  greetingTitle: "Is this your first time here?",
  greetingBody:
    "The guide has eight steps and some need files prepared in advance. You can stop and pick it up later, on any computer.",
  greetingNew: "Start a new session",
  greetingResume: "I have a resume code",
  codeTitle: "Your resume code",
  codeBody:
    "Write this down or copy it. It is the only way back to this session, and it stays one click away in the bar above while you work. If you lose it, Export answers is your backup. A session is deleted 14 days after its last save.",
  resumeTitle: "Resume a session",
  resumeAction: "Resume",
  unknown:
    "No session answers to that code. A session is deleted 14 days after its last save; if you exported your answers, use Import answers.",
  revived: (day: string): string =>
    `The saved copy had expired; it has been saved again, and is kept until ${day}.`,
  conflict: (day: string, clock: string): string =>
    `This session was saved from somewhere else on ${day} at ${clock}. Overwrite that copy with the answers here?`,
  replaceDraft:
    "Replace the answers in this browser with the saved session? Export them first to keep them.",
  signedOut:
    "You are signed out of the dashboard. Sign in again in another tab, then save. Your answers are still in this browser.",
  limited: "Too many attempts. Wait a minute and try again.",
  full:
    "The server cannot take another session right now. Use Export answers instead.",
  failed:
    "The session could not be reached. Your answers are still in this browser; try again, or use Export answers.",
  resetAttached:
    "Discard every answer and the saved draft? This browser will also forget its resume code; the saved session stays on the server until it expires.",
  unreadable:
    "The saved session could not be read by this version of the guide. If you exported your answers, use Import answers.",
  tooLarge:
    "These answers are too large to save as a session. Use Export answers instead.",
  off:
    "Saved sessions are not available on this server. Use Export answers instead.",
  invalid:
    "The answers could not be saved as they are. Use Export answers instead.",
} as const;

const fail = (reason: SessionFailure, message: string): Failure => ({
  ok: false,
  reason,
  message,
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

/** A failure for what the server said, or the reply when it is a 2xx. */
function classify(
  reply: Reply,
): Failure & { savedAt?: number } | null {
  const { status, body } = reply;
  if (status >= 200 && status < 300) return null;
  const message = typeof body.message === "string" ? body.message : null;
  switch (status) {
    case 400:
      return fail("invalid", message ?? SESSION_COPY.invalid);
    case 404:
      if (body.error === "off") return fail("off", SESSION_COPY.off);
      if (body.error === "unknown") {
        return fail("unknown", SESSION_COPY.unknown);
      }
      break;
    case 409:
      if (typeof body.savedAt === "number") {
        const at = body.savedAt;
        return {
          ...fail(
            "conflict",
            SESSION_COPY.conflict(formatDay(at), formatClock(at)),
          ),
          savedAt: at,
        };
      }
      break;
    case 413:
      return fail("too-large", SESSION_COPY.tooLarge);
    case 422:
      return fail("unreadable", message ?? SESSION_COPY.unreadable);
    case 429:
      return fail("limited", SESSION_COPY.limited);
    case 503:
      if (body.error === "full") return fail("full", SESSION_COPY.full);
      break;
  }
  return fail("failed", SESSION_COPY.failed);
}

/**
 * The client for the three session routes. `machine` is the machine the page
 * says holds the sessions; each request names it, so that a save too large
 * for Fly to replay still reaches the volume it belongs on. Without one, no
 * request names a machine and the proxy picks as it always has.
 */
export function sessionClient(
  fetch: typeof globalThis.fetch,
  machine?: string | null,
): SessionClient {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (machine) headers[FORCE_INSTANCE_HEADER] = machine;

  /** The reply, or the failure that stands for not getting one. */
  async function post(
    path: string,
    payload: unknown,
  ): Promise<Reply | Failure> {
    let response: Response;
    try {
      response = await fetch(`/adapt/session/${path}`, {
        method: "POST",
        // A sign-in redirect would be followed into an HTML page; manual
        // turns it into an opaque response this can name.
        redirect: "manual",
        headers,
        body: JSON.stringify(payload),
      });
    } catch {
      return fail("failed", SESSION_COPY.failed);
    }
    if (response.type === "opaqueredirect") {
      return fail("signed-out", SESSION_COPY.signedOut);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return fail("failed", SESSION_COPY.failed);
    }
    if (typeof body !== "object" || body === null) {
      return fail("failed", SESSION_COPY.failed);
    }
    return { status: response.status, body: body as Record<string, unknown> };
  }

  /** The body of a success, or the failure the reply amounts to. */
  async function request(
    path: string,
    payload: unknown,
  ): Promise<
    { body: Record<string, unknown> } | (Failure & { savedAt?: number })
  > {
    const reply = await post(path, payload);
    if ("ok" in reply) return reply;
    return classify(reply) ?? { body: reply.body };
  }

  const unreadReply = () => fail("failed", SESSION_COPY.failed);

  return {
    async create(answers) {
      const result = await request("create", { answers: exportText(answers) });
      if (!("body" in result)) return result;
      const { code, revision, savedAt } = result.body;
      if (
        typeof code !== "string" || typeof revision !== "number" ||
        typeof savedAt !== "number"
      ) {
        return unreadReply();
      }
      return { ok: true, link: { code, revision, savedAt, dirty: false } };
    },

    async save(link, answers, force) {
      const result = await request("save", {
        code: link.code,
        revision: link.revision,
        force,
        answers: exportText(answers),
      });
      if (!("body" in result)) return result;
      const { revision, savedAt, revived } = result.body;
      if (typeof revision !== "number" || typeof savedAt !== "number") {
        return unreadReply();
      }
      return {
        ok: true,
        link: { code: link.code, revision, savedAt, dirty: false },
        revived: revived === true,
      };
    },

    async resume(input, current) {
      const code = normaliseCode(input);
      // The server would answer 400 to this; there is no use asking.
      if (code === null) return fail("unknown", SESSION_COPY.unknown);
      const result = await request("resume", { code });
      if (!("body" in result)) return result;
      const { answers, revision, savedAt } = result.body;
      if (
        typeof answers !== "string" || typeof revision !== "number" ||
        typeof savedAt !== "number"
      ) {
        return unreadReply();
      }
      const imported = importText(answers, current);
      if ("error" in imported) return fail("unreadable", imported.error);
      return {
        ok: true,
        link: { code, revision, savedAt, dirty: false },
        answers: imported.answers,
        dropped: imported.dropped,
      };
    },
  };
}

export interface Remaining {
  step: StepId;
  label: string;
  count: number;
  /** Something in the step is already answered. */
  started: boolean;
  items: { label: string | null; message: string }[];
}

export interface Overview {
  completed: { step: StepId; label: string }[];
  remaining: Remaining[];
  first: StepId | null;
}

/** Which steps the answers finish and what each of the others still lacks. */
export function overview(answers: Answers): Overview {
  const issues = validate(answers);
  const completed: Overview["completed"] = [];
  const remaining: Remaining[] = [];
  for (const step of STEP_ORDER) {
    const own = issuesFor(issues, step);
    const label = STEP_LABELS[step];
    if (own.length === 0) {
      completed.push({ step, label });
      continue;
    }
    const progress = progressOf(issues, step, stepRequired(answers, step));
    remaining.push({
      step,
      label,
      count: own.length,
      started: progress.answered > 0,
      items: own.map((issue) => ({
        label: issueLabel(answers, issue),
        message: issue.message,
      })),
    });
  }
  return { completed, remaining, first: remaining[0]?.step ?? null };
}

function formatter(
  options: Intl.DateTimeFormatOptions,
  timeZone?: string,
): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone });
}

/** "24 Nov 2026", in the viewer's time zone unless one is given. */
export function formatDay(ms: number, timeZone?: string): string {
  return formatter(
    { day: "numeric", month: "short", year: "numeric" },
    timeZone,
  ).format(ms);
}

/** "16:42", in the viewer's time zone unless one is given. */
export function formatClock(ms: number, timeZone?: string): string {
  return formatter(
    { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
    timeZone,
  ).format(ms);
}

/** When a session saved at `savedAt` will be deleted, as the bar says it. */
export function keptUntil(savedAt: number, timeZone?: string): string {
  return `kept until ${formatDay(savedAt + SESSION_TTL_MS, timeZone)}`;
}
