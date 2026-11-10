import { assertEquals, assertStrictEquals } from "@std/assert";

import { formatDay, SESSION_COPY } from "../../lib/adapt/session.ts";
import type { SessionLink } from "../../lib/adapt/session.ts";
import { SESSION_TTL_MS } from "../../lib/adapt/session_code.ts";
import {
  indicator,
  INITIAL_SESSION,
  type SessionEvent,
  sessionReducer,
  type SessionState,
  warnsOnLeave,
} from "../../lib/adapt/session_state.ts";

// 2026-11-24 16:42 UTC.
const SAVED_AT = Date.UTC(2026, 10, 24, 16, 42);
const LINK: SessionLink = {
  code: "ABCDEFGHJKMNPQRSTVWX",
  revision: 3,
  savedAt: SAVED_AT,
  dirty: false,
};
const DIRTY: SessionLink = { ...LINK, dirty: true };

const attached = (link: SessionLink = LINK): SessionState => ({
  ...INITIAL_SESSION,
  link,
});

Deno.test("a browser with sessions on, no link and no draft is greeted", () => {
  const state = sessionReducer(INITIAL_SESSION, {
    type: "loaded",
    enabled: true,
    link: null,
    hasDraft: false,
  });
  assertEquals(state.dialog, "greeting");
  assertEquals(state.link, null);
});

Deno.test("a browser with a draft or a link is not greeted", () => {
  const withDraft = sessionReducer(INITIAL_SESSION, {
    type: "loaded",
    enabled: true,
    link: null,
    hasDraft: true,
  });
  assertEquals(withDraft.dialog, "none");
  const withLink = sessionReducer(INITIAL_SESSION, {
    type: "loaded",
    enabled: true,
    link: DIRTY,
    hasDraft: false,
  });
  assertEquals(withLink.dialog, "none");
  // The link's dirty flag survives the reload.
  assertEquals(withLink.link, DIRTY);
});

Deno.test("with sessions off nothing is greeted and no link is held", () => {
  for (const link of [null, LINK]) {
    const state = sessionReducer(INITIAL_SESSION, {
      type: "loaded",
      enabled: false,
      link,
      hasDraft: false,
    });
    assertEquals(state, INITIAL_SESSION);
  }
});

Deno.test("an edit marks an attached session unsaved and nothing else", () => {
  assertEquals(
    sessionReducer(attached(), { type: "edited" }).link,
    DIRTY,
  );
  // Already unsaved, or not attached: the same state, so nothing re-renders
  // and the link is not written again.
  const dirty = attached(DIRTY);
  assertStrictEquals(sessionReducer(dirty, { type: "edited" }), dirty);
  assertStrictEquals(
    sessionReducer(INITIAL_SESSION, { type: "edited" }),
    INITIAL_SESSION,
  );
});

Deno.test("a save in flight ignores a second press", () => {
  const started = sessionReducer(
    { ...attached(DIRTY), message: "old" },
    { type: "save-started" },
  );
  assertEquals(started.saving, true);
  assertEquals(started.message, "");
  assertStrictEquals(
    sessionReducer(started, { type: "save-started" }),
    started,
  );
  assertStrictEquals(
    sessionReducer(started, { type: "resume-started" }),
    started,
  );
});

Deno.test("a created session is held and its code shown", () => {
  const state = sessionReducer(
    { ...INITIAL_SESSION, saving: true },
    { type: "created", link: LINK, epoch: 0 },
  );
  assertEquals(state.link, LINK);
  assertEquals(state.dialog, "code");
  assertEquals(state.saving, false);
});

Deno.test("a save clears the unsaved mark and says when the copy was revived", () => {
  const saving = { ...attached(DIRTY), saving: true };
  const saved = sessionReducer(saving, {
    type: "saved",
    epoch: 0,
    link: LINK,
    revived: false,
  });
  assertEquals(saved.link?.dirty, false);
  assertEquals(saved.message, "");
  assertEquals(saved.saving, false);
  const revived = sessionReducer(saving, {
    type: "saved",
    epoch: 0,
    link: LINK,
    revived: true,
    timeZone: "UTC",
  });
  assertEquals(
    revived.message,
    SESSION_COPY.revived(formatDay(SAVED_AT + SESSION_TTL_MS, "UTC")),
  );
  assertEquals(revived.message.includes("8 Dec 2026"), true);
});

Deno.test("a failed save keeps the link unsaved and says why", () => {
  const state = sessionReducer(
    { ...attached(DIRTY), saving: true },
    { type: "save-failed", message: SESSION_COPY.failed, epoch: 0 },
  );
  assertEquals(state.link, DIRTY);
  assertEquals(state.message, SESSION_COPY.failed);
  assertEquals(state.saving, false);
});

Deno.test("a resume opens the welcome screen, and leaving it the wizard", () => {
  const opened = sessionReducer(
    { ...INITIAL_SESSION, dialog: "greeting" },
    { type: "resume-opened" },
  );
  assertEquals(opened.dialog, "resume");
  const busy = sessionReducer(opened, { type: "resume-started" });
  assertEquals(busy.saving, true);
  const resumed = sessionReducer(busy, {
    type: "resumed",
    link: LINK,
    epoch: 0,
  });
  assertEquals(resumed.screen, "welcome");
  assertEquals(resumed.dialog, "none");
  assertEquals(resumed.link, LINK);
  assertEquals(resumed.saving, false);
  const left = sessionReducer(resumed, { type: "welcome-left" });
  assertEquals(left.screen, "wizard");
  assertEquals(left.link, LINK);
});

Deno.test("a failed resume keeps its window open with the reason, until reopened", () => {
  const failed = sessionReducer(
    { ...INITIAL_SESSION, dialog: "resume", saving: true },
    { type: "resume-failed", message: SESSION_COPY.unknown, epoch: 0 },
  );
  assertEquals(failed.dialog, "resume");
  assertEquals(failed.resumeError, SESSION_COPY.unknown);
  assertEquals(failed.saving, false);
  assertEquals(
    sessionReducer(failed, { type: "resume-opened" }).resumeError,
    "",
  );
  const closed = sessionReducer(failed, { type: "dialog-closed" });
  assertEquals(closed.dialog, "none");
  assertEquals(closed.resumeError, "");
});

Deno.test("the resume window cannot be closed while its request runs", () => {
  const busy: SessionState = {
    ...INITIAL_SESSION,
    dialog: "resume",
    saving: true,
  };
  assertStrictEquals(sessionReducer(busy, { type: "dialog-closed" }), busy);
  // Any other window closes whatever is in flight.
  assertEquals(
    sessionReducer({ ...attached(), dialog: "code", saving: true }, {
      type: "dialog-closed",
    }).dialog,
    "none",
  );
});

Deno.test("another tab's link is adopted without opening a window", () => {
  const adopted = sessionReducer(INITIAL_SESSION, {
    type: "link-adopted",
    link: DIRTY,
  });
  assertEquals(adopted.link, DIRTY);
  assertEquals(adopted.dialog, "none");
  const greeted = sessionReducer({ ...attached(), dialog: "greeting" }, {
    type: "link-adopted",
    link: null,
  });
  assertEquals(greeted.link, null);
  assertEquals(greeted.dialog, "greeting");
  // The code window has nothing to show once the link is gone.
  const shown = sessionReducer({ ...attached(), dialog: "code" }, {
    type: "link-adopted",
    link: null,
  });
  assertEquals(shown.dialog, "none");
});

Deno.test("Start over detaches the session", () => {
  const state = sessionReducer(
    { ...attached(DIRTY), dialog: "code", screen: "welcome" },
    { type: "detached" },
  );
  assertEquals(state.link, null);
  assertEquals(state.dialog, "none");
  assertEquals(state.screen, "wizard");
});

Deno.test("the indicator says whether the session holds the answers", () => {
  assertEquals(indicator(INITIAL_SESSION), null);
  assertEquals(indicator(attached(DIRTY), SAVED_AT, "UTC"), {
    tone: "danger",
    text: "Unsaved changes",
  });
  assertEquals(indicator(attached(), SAVED_AT + 60_000, "UTC"), {
    tone: "ok",
    text: "Saved 16:42",
  });
});

Deno.test("the indicator names the day of a save made before today", () => {
  // The same local day, from its first minute to its last.
  const midnight = Date.UTC(2026, 10, 24);
  assertEquals(
    indicator(attached(), midnight + 24 * 3_600_000 - 1, "UTC")?.text,
    "Saved 16:42",
  );
  // The next day, and three days on.
  assertEquals(
    indicator(attached(), midnight + 24 * 3_600_000, "UTC")?.text,
    "Saved 24 Nov, 16:42",
  );
  assertEquals(
    indicator(attached(), SAVED_AT + 3 * 24 * 3_600_000, "UTC")?.text,
    "Saved 24 Nov, 16:42",
  );
  // "Today" is the viewer's: 16:42 UTC is already the 25th in Tokyo.
  assertEquals(
    indicator(attached(), Date.UTC(2026, 10, 25, 1), "Asia/Tokyo")?.text,
    "Saved 01:42",
  );
  assertEquals(
    indicator(attached(), Date.UTC(2026, 10, 25, 16), "Asia/Tokyo")?.text,
    "Saved 25 Nov, 01:42",
  );
  // Unsaved changes say nothing of when.
  assertEquals(
    indicator(attached(DIRTY), SAVED_AT + 3 * 24 * 3_600_000, "UTC")?.text,
    "Unsaved changes",
  );
});

Deno.test("leaving warns only over unsaved session changes", () => {
  assertEquals(warnsOnLeave(INITIAL_SESSION), false);
  assertEquals(warnsOnLeave(attached()), false);
  assertEquals(warnsOnLeave(attached(DIRTY)), true);
});

Deno.test("a save that lands after Start over is dropped", () => {
  // Saving, then Start over while the request runs: a new epoch, nothing in
  // flight, and the results of the old request change nothing.
  const saving = sessionReducer(attached(DIRTY), { type: "save-started" });
  const detached = sessionReducer(saving, { type: "detached" });
  assertEquals(detached.saving, false);
  assertEquals(detached.epoch, saving.epoch + 1);
  const late: SessionEvent[] = [
    { type: "created", link: LINK, epoch: saving.epoch },
    { type: "saved", link: LINK, revived: false, epoch: saving.epoch },
    { type: "save-failed", message: "x", epoch: saving.epoch },
    { type: "resumed", link: LINK, epoch: saving.epoch },
    { type: "resume-failed", message: "x", epoch: saving.epoch },
  ];
  for (const event of late) {
    assertStrictEquals(sessionReducer(detached, event), detached);
  }
  // A save started afterwards is answered.
  const again = sessionReducer(detached, { type: "save-started" });
  assertEquals(
    sessionReducer(again, { type: "created", link: LINK, epoch: again.epoch })
      .link,
    LINK,
  );
});

Deno.test("another tab leaving or changing the session drops what is in flight", () => {
  const OTHER: SessionLink = { ...LINK, code: "ZYXWVTSRQPNMKJHGFEDC" };
  const saving: SessionState = {
    ...attached(DIRTY),
    saving: true,
    screen: "welcome",
  };
  for (const link of [null, OTHER]) {
    const adopted = sessionReducer(saving, { type: "link-adopted", link });
    assertEquals(adopted.link, link);
    assertEquals(adopted.saving, false);
    // A welcome screen must not come back later, unasked.
    assertEquals(adopted.screen, "wizard");
    assertEquals(adopted.epoch, saving.epoch + 1);
    const late: SessionEvent = {
      type: "saved",
      link: LINK,
      revived: false,
      epoch: saving.epoch,
    };
    assertStrictEquals(sessionReducer(adopted, late), adopted);
  }
  // The same session saved or edited there moves only its state: the
  // request here still answers for it, and the welcome screen stays.
  const same = sessionReducer(saving, { type: "link-adopted", link: LINK });
  assertEquals(same.link, LINK);
  assertEquals(same.saving, true);
  assertEquals(same.screen, "welcome");
  assertEquals(same.epoch, saving.epoch);
});
