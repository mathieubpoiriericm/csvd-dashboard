/**
 * Every decision the wizard makes about its saved session, as a reducer.
 * The island's handlers cannot be reached from a test (`jsx: "precompile"`
 * renders them as attributes), so they only call the client, `confirm()` and
 * storage, and dispatch what happened here. The reducer is pure: a time zone
 * it needs comes in on the event. indicator() reads the clock only when its
 * caller passes no `now`.
 */

import {
  formatClock,
  formatDay,
  formatDayMonth,
  SESSION_COPY,
  type SessionLink,
} from "./session.ts";
import { SESSION_TTL_MS } from "./session_code.ts";

export type Screen = "wizard" | "welcome";

export interface SessionState {
  link: SessionLink | null;
  /**
   * A session request is in flight: a save, or a resume. One at a time, so
   * a double click creates one session, not two.
   */
  saving: boolean;
  dialog: "none" | "greeting" | "code" | "resume";
  screen: Screen;
  /** Goes to the current step's status line. */
  message: string;
  resumeError: string;
  /**
   * Which session this browser is in, counted: a Start over here, or another
   * tab's link replacing this one's, begins a new one. A request carries the
   * epoch it started in and its result is dropped once that has passed,
   * since it answers for a session the browser has left.
   */
  epoch: number;
}

/** A request's result, and the epoch the request was started in. */
type Result<T> = T & { epoch: number };

export type SessionEvent =
  /** After the stored draft is read; `enabled` is the island's prop. */
  | {
    type: "loaded";
    enabled: boolean;
    link: SessionLink | null;
    hasDraft: boolean;
  }
  /** Any change to the answers. */
  | { type: "edited" }
  | { type: "save-started" }
  | Result<{ type: "created"; link: SessionLink }>
  | Result<{
    type: "saved";
    link: SessionLink;
    revived: boolean;
    timeZone?: string;
  }>
  | Result<{ type: "save-failed"; message: string }>
  | { type: "resume-opened" }
  | { type: "resume-started" }
  | Result<{ type: "resumed"; link: SessionLink }>
  | Result<{ type: "resume-failed"; message: string }>
  | { type: "dialog-closed" }
  | { type: "welcome-left" }
  /** Another tab wrote the stored link. */
  | { type: "link-adopted"; link: SessionLink | null }
  /** Start over. */
  | { type: "detached" };

export const INITIAL_SESSION: SessionState = {
  link: null,
  saving: false,
  dialog: "none",
  screen: "wizard",
  message: "",
  resumeError: "",
  epoch: 0,
};

/** Whether `event` is the result of a request started in an earlier epoch. */
const stale = (state: SessionState, event: SessionEvent) =>
  "epoch" in event && event.epoch !== state.epoch;

/**
 * The browser has left its session: what it was waiting for no longer
 * answers for it, and the welcome screen of the one it left must not come
 * back unasked.
 */
const left = (state: SessionState, link: SessionLink | null): SessionState => ({
  ...state,
  link,
  saving: false,
  screen: "wizard",
  epoch: state.epoch + 1,
});

export function sessionReducer(
  state: SessionState,
  event: SessionEvent,
): SessionState {
  // A save that lands after Start over would attach the browser again to
  // the session it left, and the next save would empty that copy. A create
  // dropped this way leaves a session on the server that nobody holds the
  // code for; it is deleted 14 days after that save, as any other is.
  if (stale(state, event)) return state;
  switch (event.type) {
    case "loaded":
      // Off, the server keeps nothing: no greeting, and a link left from a
      // time it was on names a session nobody can reach from here.
      if (!event.enabled) return INITIAL_SESSION;
      return {
        ...state,
        link: event.link,
        // Only a first visit is asked; one with answers or a code has
        // already chosen.
        dialog: event.link === null && !event.hasDraft ? "greeting" : "none",
      };
    case "edited":
      // The same state when nothing changes, so the link is not rewritten
      // on every keystroke.
      if (state.link === null || state.link.dirty) return state;
      return { ...state, link: { ...state.link, dirty: true } };
    case "save-started":
    case "resume-started":
      if (state.saving) return state;
      return { ...state, saving: true, message: "", resumeError: "" };
    case "created":
      return { ...state, link: event.link, saving: false, dialog: "code" };
    case "saved":
      return {
        ...state,
        link: event.link,
        saving: false,
        message: event.revived
          ? SESSION_COPY.revived(
            formatDay(event.link.savedAt + SESSION_TTL_MS, event.timeZone),
          )
          : "",
      };
    case "save-failed":
      return { ...state, saving: false, message: event.message };
    case "resume-opened":
      return { ...state, dialog: "resume", resumeError: "" };
    case "resumed":
      return {
        ...state,
        link: event.link,
        saving: false,
        dialog: "none",
        screen: "welcome",
        message: "",
        resumeError: "",
      };
    case "resume-failed":
      return {
        ...state,
        saving: false,
        dialog: "resume",
        resumeError: event.message,
      };
    case "dialog-closed":
      // The resume window waits for its request to settle: closed now, the
      // answers would still be replaced a moment later with nothing asked.
      if (state.dialog === "resume" && state.saving) return state;
      return { ...state, dialog: "none", resumeError: "" };
    case "welcome-left":
      return { ...state, screen: "wizard" };
    case "link-adopted":
      // The same session, saved or edited there: only its state moves.
      if (event.link !== null && event.link.code === state.link?.code) {
        return { ...state, link: event.link };
      }
      return {
        ...left(state, event.link),
        // The code window shows the link's code; with none it has nothing.
        dialog: state.dialog === "code" && event.link === null
          ? "none"
          : state.dialog,
      };
    case "detached":
      return { ...left(state, null), dialog: "none", message: "" };
  }
}

/**
 * What the bar says beside Save session; null with no session. A save made
 * on an earlier day than `now`, in the viewer's time zone, names its day, so
 * a link saved three days ago does not read as saved today.
 */
export function indicator(
  state: SessionState,
  now: number = Date.now(),
  timeZone?: string,
): { tone: "ok" | "danger"; text: string } | null {
  if (state.link === null) return null;
  if (state.link.dirty) return { tone: "danger", text: "Unsaved changes" };
  const { savedAt } = state.link;
  const clock = formatClock(savedAt, timeZone);
  const today = formatDay(savedAt, timeZone) === formatDay(now, timeZone);
  return {
    tone: "ok",
    text: today
      ? `Saved ${clock}`
      : `Saved ${formatDayMonth(savedAt, timeZone)}, ${clock}`,
  };
}

/** Closing the tab asks first while the session lacks this tab's answers. */
export function warnsOnLeave(state: SessionState): boolean {
  return state.link !== null && state.link.dirty;
}
