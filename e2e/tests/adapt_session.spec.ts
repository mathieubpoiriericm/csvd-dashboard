import {
  type Browser,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

import { STORAGE_STATE } from "../fixtures/auth.ts";
import { openAdapt } from "../helpers.ts";

/**
 * The guide's saved sessions in a real browser: the first-visit greeting,
 * the code window, resuming from another browser, the conflict question, the
 * sign-out message, and the native dialogs' own behaviour under Escape.
 * The e2e server runs with sessions on (playwright.config.ts). Its sessions
 * directory is emptied when the server starts, but a reused local server
 * keeps it, so every test makes its own session and none relies on the
 * directory being empty. Nothing here names a disease: the
 * answers are the placeholders any adaptation starts with.
 */

test.use({ actionTimeout: 15_000, navigationTimeout: 30_000 });

// Strings below are copied from lib/adapt/session.ts's SESSION_COPY (and the
// island's KEPT_OTHER), as adapt.spec.ts copies the lookups' shapes: Playwright
// cannot transpile the app's modules, and a changed sentence should fail here.
const GREETING_TITLE = "Is this your first time here?";
const SIGNED_OUT =
  "You are signed out of the dashboard. Sign in again in another tab, then save. Your answers are still in this browser.";
const UNKNOWN =
  "No session answers to that code. A session is deleted 14 days after its last save; if you exported your answers, use Import answers.";
const KEPT_OTHER = "Kept the other copy; nothing was saved.";
const CONFLICT =
  /^This session was saved from somewhere else on .+ at \d\d:\d\d\. Overwrite that copy with the answers here\?$/;

const CODE = /^([0-9A-HJKMNP-TV-Z]{5}-){3}[0-9A-HJKMNP-TV-Z]{5}$/;
/** Well formed, and no session answers to it. */
const NO_SUCH_CODE = "ABCDE-FGHJK-MNPQR-STVWX";

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const NAME = (page: Page) =>
  page.getByLabel("Disease name", { exact: true });
const indicator = (page: Page) => page.locator(".adapt-bar-indicator");
const statusLine = (page: Page) =>
  page.locator(".adapt-messages > [role=status]");
const saveButton = (page: Page) =>
  page.getByRole("button", { name: "Save session" });
const codeWindow = (page: Page) =>
  page.getByRole("dialog", { name: "Your resume code" });
const resumeWindow = (page: Page) =>
  page.getByRole("dialog", { name: "Resume a session" });
const greeting = (page: Page) =>
  page.getByRole("dialog", { name: GREETING_TITLE });

/** A signed-in browser of its own: no draft, no link. */
async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  return await context.newPage();
}

/**
 * The bar's session details, opened where this width keeps them: behind the
 * Session button on a wide screen, first in More on a narrow one.
 */
async function openDetails(page: Page): Promise<Locator> {
  const session = page.getByRole("button", { name: "Session", exact: true });
  if (await session.isVisible()) await session.click();
  else await page.getByRole("button", { name: "More" }).click();
  const details = page.locator(".adapt-bar-details:visible");
  await expect(details).toBeVisible();
  return details;
}

/** Closes whichever popover openDetails opened. */
async function closeDetails(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(".adapt-bar-details:visible")).toHaveCount(0);
}

/** Types a disease name, saves, and returns the code the window shows. */
async function saveFirst(page: Page, name = "exampleitis"): Promise<string> {
  await NAME(page).fill(name);
  await saveButton(page).click();
  const window = codeWindow(page);
  await expect(window).toBeVisible();
  const code = (await window.locator(".adapt-dialog-code").innerText()).trim();
  expect(code).toMatch(CODE);
  await window.getByRole("button", { name: "Done" }).click();
  await expect(window).toBeHidden();
  return code;
}

/** Resumes `code` in a window opened from the greeting or the bar. */
async function resumeWith(page: Page, code: string) {
  const window = resumeWindow(page);
  await window.getByLabel("Resume code").fill(code);
  await window.getByRole("button", { name: "Resume", exact: true }).click();
}

test("a first visit is greeted, and a browser with a draft is not", async ({ browser }) => {
  const page = await freshPage(browser);
  await page.goto("/adapt");
  await expect(greeting(page)).toBeVisible();
  await expect(greeting(page).getByRole("button", {
    name: "I have a resume code",
  })).toBeVisible();
  await greeting(page).getByRole("button", { name: "Start a new session" })
    .click();
  await expect(greeting(page)).toBeHidden();
  await NAME(page).fill("exampleitis");
  await page.reload();
  await expect(page.locator("fieldset.adapt:enabled")).toBeAttached();
  await expect(NAME(page)).toHaveValue("exampleitis");
  await expect(greeting(page)).toBeHidden();
  await page.context().close();
});

test("Save session shows a code once, and the bar keeps it", async ({ page }) => {
  await openAdapt(page);
  await NAME(page).fill("exampleitis");
  await saveButton(page).click();
  const window = codeWindow(page);
  await expect(window).toBeVisible();
  const code = (await window.locator(".adapt-dialog-code").innerText()).trim();
  expect(code).toMatch(CODE);
  await window.getByRole("button", { name: "Done" }).click();
  await expect(window).toBeHidden();

  await expect(indicator(page)).toHaveText(/^Saved \d\d:\d\d$/);
  const details = await openDetails(page);
  await expect(details.locator("code")).toHaveText(code);
  await expect(details.locator(".adapt-bar-kept")).toContainText("kept until");
  await closeDetails(page);

  // A second save writes over the session and shows no window.
  await NAME(page).fill("exampleitis two");
  await expect(indicator(page)).toHaveText("Unsaved changes");
  await saveButton(page).click();
  await expect(indicator(page)).toHaveText(/^Saved \d\d:\d\d$/);
  await expect(codeWindow(page)).toBeHidden();
});

test("a saved session resumes in a fresh browser on the welcome-back panels", async ({ page, browser }) => {
  await openAdapt(page);
  const code = await saveFirst(page);

  const other = await freshPage(browser);
  await other.goto("/adapt");
  await greeting(other).getByRole("button", { name: "I have a resume code" })
    .click();
  // Lower case and no hyphens: the way a code is read out or retyped.
  await resumeWith(other, code.replaceAll("-", "").toLowerCase());

  const title = other.getByRole("heading", { name: "Welcome back" });
  await expect(title).toBeVisible();
  // Focus lands on the heading, so the screen is announced.
  await expect(title).toBeFocused();
  expect(
    await other.evaluate(() => document.activeElement?.textContent?.trim()),
  ).toBe("Welcome back");
  await expect(other.locator(".adapt-welcome-saved")).toContainText(
    "last saved",
  );
  await expect(other.locator(".adapt-welcome-saved")).toContainText(
    "kept until",
  );
  await expect(other.getByRole("heading", { name: "Completed" }))
    .toBeVisible();
  await expect(other.getByRole("heading", { name: "Remaining" }))
    .toBeVisible();
  await expect(other.getByText("Not started").first()).toBeVisible();
  await expect(other.getByRole("button", { name: "Review all steps" }))
    .toBeVisible();

  await other.getByRole("button", { name: /^Continue at / }).click();
  await expect(other.locator(".adapt-welcome")).toHaveCount(0);
  await other.getByRole("button", { name: "Identity", exact: true }).click();
  await expect(NAME(other)).toHaveValue("exampleitis");
  await other.context().close();
});

test("the NCBI key stays behind", async ({ page, browser }) => {
  await openAdapt(page);
  await NAME(page).fill("exampleitis");
  await page.getByRole("button", { name: "Search terms", exact: true })
    .click();
  const key = page.getByLabel("NCBI API key (optional)", { exact: true });
  if (!(await key.isVisible())) {
    await key.locator("xpath=ancestor::section[@data-card][1]/h3/button")
      .click();
  }
  await key.fill("SECRETKEY123");
  const request = page.waitForRequest("**/adapt/session/create");
  await saveButton(page).click();
  expect((await request).postData()).not.toContain("SECRETKEY123");
  const window = codeWindow(page);
  await expect(window).toBeVisible();
  const code = (await window.locator(".adapt-dialog-code").innerText()).trim();
  await window.getByRole("button", { name: "Done" }).click();

  const other = await freshPage(browser);
  await other.goto("/adapt");
  await greeting(other).getByRole("button", { name: "I have a resume code" })
    .click();
  await resumeWith(other, code);
  await other.getByRole("button", { name: "Review all steps" }).click();
  await other.getByRole("button", { name: "Search terms", exact: true })
    .click();
  const there = other.getByLabel("NCBI API key (optional)", { exact: true });
  if (!(await there.isVisible())) {
    await there.locator("xpath=ancestor::section[@data-card][1]/h3/button")
      .click();
  }
  await expect(there).toHaveValue("");
  await other.context().close();
});

test("no machine is named when none is designated", async ({ page }) => {
  // The e2e server sets no ADAPT_SESSIONS_MACHINE, as local development and
  // a one-machine deployment set none: the page names no machine and the
  // guide's requests force none.
  await openAdapt(page);
  await expect(page.locator("fieldset.adapt")).not.toHaveAttribute(
    "data-sessions-machine",
    /.*/,
  );
  await NAME(page).fill("exampleitis");
  const request = page.waitForRequest("**/adapt/session/create");
  await saveButton(page).click();
  expect((await (await request).allHeaders())["fly-force-instance-id"])
    .toBeUndefined();
  const window = codeWindow(page);
  await expect(window).toBeVisible();
  await window.getByRole("button", { name: "Done" }).click();
  await expect(window).toBeHidden();
  // The next save goes to the save route, and names no machine either.
  await NAME(page).fill("exampleitis two");
  const save = page.waitForRequest("**/adapt/session/save");
  await saveButton(page).click();
  expect((await (await save).allHeaders())["fly-force-instance-id"])
    .toBeUndefined();
});

test("an unknown code says so and stays on the window", async ({ browser }) => {
  const page = await freshPage(browser);
  await page.goto("/adapt");
  await greeting(page).getByRole("button", { name: "I have a resume code" })
    .click();
  await resumeWith(page, NO_SUCH_CODE);
  const window = resumeWindow(page);
  await expect(window.getByRole("alert")).toHaveText(UNKNOWN);
  await expect(window).toBeVisible();
  await expect(window.getByRole("button", { name: "Resume", exact: true }))
    .toBeEnabled();
  await page.context().close();
});

test("a save over a newer copy asks first", async ({ page, browser }) => {
  await openAdapt(page);
  const code = await saveFirst(page);

  // B holds the session as A first saved it.
  const other = await freshPage(browser);
  await other.goto("/adapt");
  await greeting(other).getByRole("button", { name: "I have a resume code" })
    .click();
  await resumeWith(other, code);
  await other.getByRole("button", { name: "Review all steps" }).click();
  await other.getByRole("button", { name: "Identity", exact: true }).click();

  // A saves again, so B's copy is behind.
  await NAME(page).fill("from the first browser");
  await saveButton(page).click();
  await expect(indicator(page)).toHaveText(/^Saved /);

  await NAME(other).fill("from the second browser");
  const asked: string[] = [];
  other.once("dialog", (dialog) => {
    asked.push(dialog.message());
    return dialog.dismiss();
  });
  await saveButton(other).click();
  await expect(statusLine(other)).toHaveText(KEPT_OTHER);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatch(CONFLICT);
  await expect(indicator(other)).toHaveText("Unsaved changes");

  other.once("dialog", (dialog) => {
    asked.push(dialog.message());
    return dialog.accept();
  });
  await saveButton(other).click();
  await expect(indicator(other)).toHaveText(/^Saved \d\d:\d\d$/);
  expect(asked).toHaveLength(2);
  await other.context().close();
});

test("two tabs of one browser share the session", async ({ page, context }) => {
  await openAdapt(page);
  await saveFirst(page);
  const second = await context.newPage();
  const asked: string[] = [];
  for (const tab of [page, second]) {
    tab.on("dialog", (dialog) => {
      asked.push(dialog.message());
      return dialog.dismiss();
    });
  }
  await openAdapt(second);
  // The link is the browser's, so this tab is attached with no greeting.
  await expect(indicator(second)).toHaveText(/^Saved /);
  await NAME(second).fill("edited in the second tab");
  await saveButton(second).click();
  await expect(indicator(second)).toHaveText(/^Saved /);
  await expect(codeWindow(second)).toBeHidden();
  expect(asked).toEqual([]);
});

test("leaving with unsaved session changes asks; a saved session does not", async ({ page }) => {
  await openAdapt(page);
  await saveFirst(page);
  // Typed, not filled: Chrome asks before leaving only a page the visitor has
  // used, and a key press is a use where a programmatic fill is not.
  await NAME(page).pressSequentially(" changed after the save");
  await expect(indicator(page)).toHaveText("Unsaved changes");

  const types: string[] = [];
  page.on("dialog", (dialog) => {
    types.push(dialog.type());
    // Stay on the page.
    return dialog.dismiss();
  });
  /** What closing the page with its unload handlers run came to. */
  const closing = async () => {
    const closed = page.waitForEvent("close").then(() => "closed");
    const asked = page.waitForEvent("dialog").then(() => "asked");
    // Neither promise is left dangling by the other's win in a way that
    // matters: the page and its listeners go with the test.
    closed.catch(() => {});
    asked.catch(() => {});
    await page.close({ runBeforeUnload: true });
    return await Promise.race([closed, asked]);
  };
  expect(await closing()).toBe("asked");
  expect(types).toEqual(["beforeunload"]);
  expect(page.isClosed()).toBe(false);

  await saveButton(page).click();
  await expect(indicator(page)).toHaveText(/^Saved /);
  // The leave warning is dropped in an effect that follows the indicator's
  // repaint; the link in storage is written by the same one.
  await expect.poll(() =>
    page.evaluate(() =>
      JSON.parse(localStorage.getItem("svd-adapt-session") ?? "{}").dirty
    )
  ).toBe(false);
  expect(await closing()).toBe("closed");
  expect(types).toEqual(["beforeunload"]);
});

test("Start over forgets the code and the session still resumes", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await openAdapt(page);
  const code = await saveFirst(page);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Start over" }).click();
  await expect(NAME(page)).toHaveValue("");
  await expect(indicator(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("svd-adapt-session")))
    .toBeNull();
  const details = await openDetails(page);
  await expect(details.locator("code")).toHaveCount(0);

  await details.getByRole("button", { name: "I have a resume code" }).click();
  await resumeWith(page, code);
  await expect(page.getByRole("heading", { name: "Welcome back" }))
    .toBeVisible();
  await page.getByRole("button", { name: "Review all steps" }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await expect(NAME(page)).toHaveValue("exampleitis");
});

test("signed out, Save says to sign in and keeps the answers", async ({ page }) => {
  await openAdapt(page);
  await NAME(page).fill("exampleitis");
  await page.context().clearCookies();
  await saveButton(page).click();
  await expect(statusLine(page)).toHaveText(SIGNED_OUT);
  await expect(NAME(page)).toHaveValue("exampleitis");
  await expect(codeWindow(page)).toBeHidden();
});

test("on a phone Save and the indicator are on the bar, and the code is under More", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openAdapt(page);
  const code = await saveFirst(page);
  await expect(saveButton(page)).toBeVisible();
  await expect(indicator(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Session", exact: true }))
    .toBeHidden();
  await expect(page.locator(".adapt-bar-code:visible")).toHaveCount(0);
  const details = await openDetails(page);
  await expect(details.locator("code")).toHaveText(code);
  await expect(details.getByRole("button", { name: "Copy code" }))
    .toBeVisible();
});

test("Escape on the greeting starts a new session", async ({ browser }) => {
  const page = await freshPage(browser);
  await page.goto("/adapt");
  await expect(greeting(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(greeting(page)).toBeHidden();
  // Usable, and attached to nothing.
  await NAME(page).fill("exampleitis");
  await expect(NAME(page)).toHaveValue("exampleitis");
  await expect(indicator(page)).toHaveCount(0);
  await page.context().close();
});

test("Escape on the code window closes it and the session stays attached", async ({ page }) => {
  await openAdapt(page);
  await NAME(page).fill("exampleitis");
  await saveButton(page).click();
  await expect(codeWindow(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(codeWindow(page)).toBeHidden();
  await expect(indicator(page)).toHaveText(/^Saved /);
  const details = await openDetails(page);
  await expect(details.locator("code")).toHaveText(CODE);
});

test("Escape twice on the resume window leaves it able to open again, empty", async ({ browser }) => {
  const page = await freshPage(browser);
  await page.setViewportSize(DESKTOP);
  await page.goto("/adapt");
  await greeting(page).getByRole("button", { name: "I have a resume code" })
    .click();
  const window = resumeWindow(page);
  await expect(window).toBeVisible();
  await window.getByLabel("Resume code").fill("ABC");
  // Chrome closes a modal on a second Escape without a `cancel` event, and
  // the island has to hear that as a close all the same.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(window).toBeHidden();

  for (const typed of ["ABC", NO_SUCH_CODE]) {
    const details = await openDetails(page);
    await details.getByRole("button", { name: "I have a resume code" })
      .click();
    await expect(window).toBeVisible();
    await expect(window.getByLabel("Resume code")).toHaveValue("");
    await window.getByLabel("Resume code").fill(typed);
    if (typed === NO_SUCH_CODE) {
      await window.getByRole("button", { name: "Resume", exact: true })
        .click();
      await expect(window.getByRole("alert")).toHaveText(UNKNOWN);
    }
    await window.getByRole("button", { name: "Cancel" }).click();
    await expect(window).toBeHidden();
  }
  await page.context().close();
});
