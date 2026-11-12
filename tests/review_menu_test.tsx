/**
 * The navbar's Review control, rendered as the server draws it.
 *
 * What a press does once live -- the menu opening, the dialogs, the cookie,
 * the request form's validation and its notice -- is the end-to-end suite's:
 * the control renders only while a review round exists.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import ReviewMenu from "../islands/ReviewMenu.tsx";
import {
  CONTROL,
  CONTROL_ENTERED,
  ENTER_OBSERVER,
  LOGIN_BODY,
  LOGIN_TITLE,
  MENU_LEAVE,
  MENU_LOG_IN,
  MENU_PROGRESS,
  MENU_QUEUE,
  MENU_REQUEST,
  REQUEST_DEMO,
  REQUEST_NOTICE,
  REQUEST_SUBMIT,
  REQUEST_TITLE,
} from "../lib/review/copy.ts";
import { escapeHtml } from "./helpers/html.ts";

const signedOut = () => renderToString(<ReviewMenu entered={false} />);
const entered = () => renderToString(<ReviewMenu entered />);

/** The control's own button: the first in the island. */
const trigger = (html: string) => html.match(/<button[^>]*>/)?.[0] ?? "";

Deno.test("signed out, the control offers the two ways in", () => {
  const html = signedOut();
  const button = trigger(html);
  assertStringIncludes(html, `>${escapeHtml(CONTROL)}<`);
  assert(!html.includes(escapeHtml(CONTROL_ENTERED)), html);
  // Inert until the island is live, and a menu button whose collapsed state
  // is in the server's HTML (aria-* as strings: islands/CLAUDE.md).
  assertStringIncludes(button, 'type="button"');
  assertStringIncludes(button, "disabled");
  assertStringIncludes(button, 'aria-haspopup="menu"');
  assertStringIncludes(button, 'aria-expanded="false"');
  assertStringIncludes(button, 'aria-controls="review-menu"');
  // The menu is in the page, hidden until opened, with its two items.
  const menu = html.match(/<ul[^>]*id="review-menu"[^>]*>/)?.[0] ?? "";
  assertStringIncludes(menu, 'role="menu"');
  assertStringIncludes(menu, "hidden");
  const items = [...html.matchAll(/role="menuitem"[^>]*>([^<]*)</g)].map((m) =>
    m[1]
  );
  assertEquals(items, [MENU_LOG_IN, MENU_REQUEST].map(escapeHtml));
  assert(!html.includes(escapeHtml(MENU_LEAVE)), html);
  assert(!html.includes('href="/review'), html);
});

Deno.test("signed out, the log-in dialog's one action is to enter as an observer", () => {
  const html = signedOut();
  const dialog = html.match(
    /<dialog[^>]*aria-labelledby="review-login-title"[^>]*>.*?<\/dialog>/s,
  )?.[0] ?? "";
  assert(dialog !== "", html);
  assertStringIncludes(dialog, escapeHtml(LOGIN_TITLE));
  assertStringIncludes(dialog, escapeHtml(LOGIN_BODY));
  assertStringIncludes(dialog, `>${escapeHtml(ENTER_OBSERVER)}<`);
  // No field to sign in with: there are no members yet.
  assert(!dialog.includes("<input"), dialog);
  assert(!dialog.includes("<form"), dialog);
});

Deno.test("the request form says it collects nothing", () => {
  const html = signedOut();
  const dialog = html.match(
    /<dialog[^>]*aria-labelledby="review-request-title"[^>]*>.*?<\/dialog>/s,
  )?.[0] ?? "";
  assert(dialog !== "", html);
  assertStringIncludes(dialog, escapeHtml(REQUEST_TITLE));
  // The demonstration notice stands above the form.
  const demo = dialog.indexOf(escapeHtml(REQUEST_DEMO));
  const form = dialog.indexOf("<form");
  assert(demo !== -1 && form !== -1 && demo < form, dialog);
  // Nowhere to send it: no action, no method, and the notice that replaces
  // the form is not drawn until a submit has passed validation.
  const formTag = dialog.match(/<form[^>]*>/)?.[0] ?? "";
  assert(!formTag.includes("action="), formTag);
  assert(!formTag.includes("method="), formTag);
  assert(!formTag.includes("novalidate"), formTag);
  assert(!html.includes(escapeHtml(REQUEST_NOTICE)), html);
  assertStringIncludes(dialog, `>${escapeHtml(REQUEST_SUBMIT)}<`);
});

Deno.test("every request field has a visible label and a stable id", () => {
  const html = signedOut();
  const fields: Array<[string, string, string]> = [
    ["review-request-name", "Full name", "input"],
    ["review-request-email", "Email address", "input"],
    ["review-request-affiliation", "Affiliation", "input"],
    ["review-request-expertise", "Area of expertise", "input"],
    ["review-request-type", "Account type", "select"],
    [
      "review-request-note",
      "Anything the administrator should know (optional)",
      "textarea",
    ],
  ];
  for (const [id, label, tag] of fields) {
    assertStringIncludes(
      html,
      `<label for="${id}">${escapeHtml(label)}</label>`,
    );
    const control = html.match(new RegExp(`<${tag}[^>]*id="${id}"[^>]*>`))
      ?.[0] ?? "";
    assert(control !== "", `${id}: no <${tag}>`);
    // Everything but the note is required.
    assertEquals(
      control.includes("required"),
      id !== "review-request-note",
      control,
    );
  }
  assertStringIncludes(
    html.match(/<input[^>]*id="review-request-email"[^>]*>/)?.[0] ?? "",
    'type="email"',
  );
  const options = [
    ...html.matchAll(/<option[^>]*>([^<]*)<\/option>/g),
  ].map((m) => m[1]);
  assertEquals(options, ["Voting member", "Observer"]);
});

Deno.test("entered, the control says so and links the two pages", () => {
  const html = entered();
  assertStringIncludes(trigger(html), "disabled");
  assertStringIncludes(html, `>${escapeHtml(CONTROL_ENTERED)}<`);
  const items = [...html.matchAll(/<(a|button)[^>]*role="menuitem"[^>]*>/g)]
    .map((m) => m[0]);
  assertEquals(items.length, 3);
  assertStringIncludes(items[0], 'href="/review"');
  assertStringIncludes(items[1], 'href="/review/progress"');
  assert(items[2].startsWith("<button"), items[2]);
  assertStringIncludes(html, `>${escapeHtml(MENU_QUEUE)}<`);
  assertStringIncludes(html, `>${escapeHtml(MENU_PROGRESS)}<`);
  assertStringIncludes(html, `>${escapeHtml(MENU_LEAVE)}<`);
  // The ways in are gone, and so are their dialogs.
  assert(!html.includes(escapeHtml(MENU_LOG_IN)), html);
  assert(!html.includes(escapeHtml(MENU_REQUEST)), html);
  assert(!html.includes("<dialog"), html);
});

Deno.test("the request dialog is described by its demonstration notice", () => {
  // showModal() focuses the first field, so a screen reader hears the
  // dialog's name and description and then "Full name": the notice has to
  // be the description, or it is skipped.
  const html = signedOut();
  const dialog = html.match(
    /<dialog[^>]*aria-labelledby="review-request-title"[^>]*>/,
  )?.[0] ?? "";
  assertStringIncludes(dialog, 'aria-describedby="review-request-demo"');
  assertStringIncludes(
    html,
    `<p id="review-request-demo" class="review-demo">${
      escapeHtml(REQUEST_DEMO)
    }</p>`,
  );
});

Deno.test("the notice's live region is in the page before anything is sent", () => {
  // A region that appears with its text is often not announced; it is drawn
  // empty from the start, and focus moves onto it once the notice is in it,
  // so "Nothing was sent" is what is read rather than the Close button.
  const html = signedOut();
  const region = html.match(/<p id="review-request-sent"([^>]*)>(.*?)<\/p>/s);
  assert(region !== null, html);
  assertStringIncludes(region[1], 'class="review-sent"');
  assertStringIncludes(region[1], 'role="status"');
  assertStringIncludes(region[1], 'tabindex="-1"');
  assertEquals(region[2], "");
});
