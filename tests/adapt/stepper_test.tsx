import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import {
  keepInView,
  Stepper,
  type StepperStep,
} from "../../components/adapt/Stepper.tsx";

const count = (html: string, needle: string) =>
  html.toLowerCase().split(needle.toLowerCase()).length - 1;

/** The description a step's button points at: the detail span's markup. */
function detailOf(html: string, id: string): string {
  const match = html.match(
    new RegExp(`id="adapt-stepper-${id}">(.*?)</span></li>`),
  );
  return match?.[1] ?? "";
}

const render = (steps: StepperStep[], current = steps[0].id) =>
  renderToString(
    <Stepper steps={steps} current={current} onSelect={() => {}} />,
  );

Deno.test("the stepper is a named list, and each button is named by its step alone", () => {
  const html = render([
    { id: "a", label: "One", state: "todo", detail: "Not started", fill: 0 },
  ]);
  assertStringIncludes(html, '<ol class="adapt-stepper" aria-label="Steps">');
  // The bar is decoration, so the button's text is the label alone: the e2e
  // spec finds a step by it.
  assertStringIncludes(
    html,
    '<span class="adapt-stepper-bar" aria-hidden="true">',
  );
  assertStringIncludes(html, "</span></span>One</button>");
});

Deno.test("a state the detail already says in words is not said a second time", () => {
  const html = render([
    { id: "a", label: "One", state: "todo", detail: "Not started", fill: 0 },
    { id: "b", label: "Two", state: "done", detail: "Done", fill: 100 },
    { id: "c", label: "Three", state: "fix", detail: "1 to fix", fill: 40 },
    // Review reuses the todo and done states with words of its own.
    { id: "d", label: "Review", state: "todo", detail: "Not ready", fill: 0 },
    { id: "e", label: "Review", state: "done", detail: "Ready", fill: 100 },
  ]);
  assertEquals(detailOf(html, "a"), "Not started");
  assertEquals(detailOf(html, "b"), "Done");
  assertEquals(detailOf(html, "c"), "1 to fix");
  assertEquals(detailOf(html, "d"), "Not ready");
  assertEquals(detailOf(html, "e"), "Ready");
  assertEquals(count(html, "not started"), 1);
  assertEquals(count(html, "complete"), 0);
  assertEquals(count(html, "visually-hidden"), 0);
});

Deno.test("a step in progress spells its count out for a screen reader", () => {
  const html = render([
    { id: "a", label: "One", state: "progress", detail: "3/24", fill: 13 },
  ]);
  // "3/24" reads as a fraction or a date aloud, so the visible count is
  // hidden from the description and the words stand in for it.
  assertEquals(
    detailOf(html, "a"),
    '<span aria-hidden="true">3/24</span><span class="visually-hidden">3 of 24 answered, in progress</span>',
  );
});

Deno.test("the current segment is scrolled to the middle of its row", () => {
  // Below 900px the row scrolls; only it moves, never the page.
  const row = {
    scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 8, width: 359 }),
  };
  const segment = {
    parentElement: row,
    getBoundingClientRect: () => ({ left: 436, width: 104 }),
  };
  keepInView(segment as unknown as HTMLLIElement);
  // The segment's centre, 488, to the row's, 187.5.
  assertEquals(row.scrollLeft, 300.5);
  // Preact hands a ref null as its element goes; nothing moves then.
  keepInView(null);
  assertEquals(row.scrollLeft, 300.5);
});
