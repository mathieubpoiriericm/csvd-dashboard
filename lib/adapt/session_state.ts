/**
 * Every decision the wizard makes about its saved session, as a reducer.
 * The island's handlers cannot be reached from a test (`jsx: "precompile"`
 * renders them as attributes), so they only call the client, `confirm()` and
 * storage, and dispatch what happened here. It is pure: a time zone it needs
 * comes in on the event.
 */

import {
  formatClock,
  formatDay,
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
}

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
  | { type: "created"; link: SessionLink }
  | { type: "saved"; link: SessionLink; revived: boolean; timeZone?: string }
  | { type: "save-failed"; message: string }
  | { type: "resume-opened" }
  | { type: "resume-started" }
  | { type: "resumed"; link: SessionLink }
  | { type: "resume-failed"; message: string }
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
};

export function sessionReducer(
  state: SessionState,
  event: SessionEvent,
): SessionState {
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
      return {
        ...state,
        link: event.link,
        // The code window shows the link's code; with none it has nothing.
        dialog: state.dialog === "code" && event.link === null
          ? "none"
          : state.dialog,
      };
    case "detached":
      return {
        ...state,
        link: null,
        dialog: "none",
        screen: "wizard",
        message: "",
      };
  }
}

/** What the bar says beside Save session; null with no session. */
export function indicator(
  state: SessionState,
  timeZone?: string,
): { tone: "ok" | "danger"; text: string } | null {
  if (state.link === null) return null;
  if (state.link.dirty) return { tone: "danger", text: "Unsaved changes" };
  return {
    tone: "ok",
    text: `Saved ${formatClock(state.link.savedAt, timeZone)}`,
  };
}

/** Closing the tab asks first while the session lacks this tab's answers. */
export function warnsOnLeave(state: SessionState): boolean {
  return state.link !== null && state.link.dirty;
}
