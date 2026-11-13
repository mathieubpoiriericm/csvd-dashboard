import { assertEquals } from "@std/assert";

import { followSkipLink } from "../lib/skip_link.ts";

/** A click on a link to `hash`, and what became of it. */
function click(hash: string) {
  const seen = { prevented: 0, focused: [] as string[] };
  const event = {
    preventDefault: () => void seen.prevented++,
    currentTarget: { hash },
  };
  const page = {
    getElementById: (id: string) =>
      id === "figure-end" ? { focus: () => void seen.focused.push(id) } : null,
  };
  followSkipLink(event, page);
  return seen;
}

Deno.test("a skip link focuses its target in place of the browser's navigation", () => {
  assertEquals(click("#figure-end"), { prevented: 1, focused: ["figure-end"] });
});

Deno.test("a skip link with no target is left to the browser", () => {
  assertEquals(click("#elsewhere"), { prevented: 0, focused: [] });
  assertEquals(click(""), { prevented: 0, focused: [] });
});

Deno.test("the page a skip link searches is the document by default", () => {
  const real = globalThis.document;
  const focused: string[] = [];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      getElementById: (id: string) => ({ focus: () => void focused.push(id) }),
    },
  });
  try {
    followSkipLink({ preventDefault: () => {}, currentTarget: { hash: "#x" } });
  } finally {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: real,
    });
  }
  assertEquals(focused, ["x"]);
});
