/**
 * The account-request island, rendered as the server draws it.
 *
 * What a press does once live -- the dialog opening, the form's validation and
 * its notice -- is the end-to-end suite's.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import ReviewRequest from "../islands/ReviewRequest.tsx";
import {
  REQUEST_DEMO,
  REQUEST_NOTICE,
  REQUEST_OPEN,
  REQUEST_SUBMIT,
  REQUEST_TITLE,
} from "../lib/review/copy.ts";
import { escapeHtml } from "./helpers/html.ts";

const html = () => renderToString(<ReviewRequest />);

Deno.test("the button opens a dialog, and is inert until the island is live", () => {
  const button = html().match(/<button[^>]*>/)?.[0] ?? "";
  assertStringIncludes(button, 'type="button"');
  assertStringIncludes(button, 'class="review-action"');
  assertStringIncludes(button, 'aria-haspopup="dialog"');
  assertStringIncludes(button, "disabled");
  assertStringIncludes(html(), `>${escapeHtml(REQUEST_OPEN)}</button>`);
  // One dialog, and no menu: the island is the request alone.
  assertEquals(html().match(/<dialog/g)?.length, 1);
  assert(!html().includes('role="menu"'));
});

Deno.test("the request form says it collects nothing", () => {
  const page = html();
  const dialog = page.match(
    /<dialog[^>]*aria-labelledby="review-request-title"[^>]*>.*?<\/dialog>/s,
  )?.[0] ?? "";
  assert(dialog !== "", page);
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
  assert(!page.includes(escapeHtml(REQUEST_NOTICE)), page);
  assertStringIncludes(dialog, `>${escapeHtml(REQUEST_SUBMIT)}<`);
});

Deno.test("every request field has a visible label and a stable id", () => {
  const page = html();
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
      page,
      `<label for="${id}">${escapeHtml(label)}</label>`,
    );
    const control = page.match(new RegExp(`<${tag}[^>]*id="${id}"[^>]*>`))
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
    page.match(/<input[^>]*id="review-request-email"[^>]*>/)?.[0] ?? "",
    'type="email"',
  );
  const options = [
    ...page.matchAll(/<option[^>]*>([^<]*)<\/option>/g),
  ].map((m) => m[1]);
  assertEquals(options, ["Voting member", "Observer"]);
});

Deno.test("the request dialog is described by its demonstration notice", () => {
  // showModal() focuses the first field, so a screen reader hears the
  // dialog's name and description and then "Full name": the notice has to
  // be the description, or it is skipped.
  const page = html();
  const dialog = page.match(
    /<dialog[^>]*aria-labelledby="review-request-title"[^>]*>/,
  )?.[0] ?? "";
  assertStringIncludes(dialog, 'aria-describedby="review-request-demo"');
  assertStringIncludes(
    page,
    `<p id="review-request-demo" class="review-demo">${
      escapeHtml(REQUEST_DEMO)
    }</p>`,
  );
});

Deno.test("the notice's live region is in the page before anything is sent", () => {
  // A region that appears with its text is often not announced; it is drawn
  // empty from the start, and focus moves onto it once the notice is in it,
  // so "Nothing was sent" is what is read rather than the Close button.
  const page = html();
  const region = page.match(/<p id="review-request-sent"([^>]*)>(.*?)<\/p>/s);
  assert(region !== null, page);
  assertStringIncludes(region[1], 'class="review-sent"');
  assertStringIncludes(region[1], 'role="status"');
  assertStringIncludes(region[1], 'tabindex="-1"');
  assertEquals(region[2], "");
});
