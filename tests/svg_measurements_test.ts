import { assertEquals } from "@std/assert";

import {
  measureSvgTextBoxes,
  measureSvgTextWidths,
  whenFontsReady,
} from "../components/svgMeasurements.ts";

const TEXTS = [
  {
    dataset: { label: "visible" },
    getBBox: () => ({ x: 1, y: 2, width: 3, height: 4 }),
  },
  {
    dataset: { label: "empty" },
    getBBox: () => ({ x: 5, y: 6, width: 0, height: 7 }),
  },
  {
    dataset: { label: "detached" },
    getBBox: () => {
      throw new Error("not measurable");
    },
  },
] as unknown as SVGTextElement[];

const SVG = {
  querySelectorAll(selector: string) {
    assertEquals(selector, "text[data-label]");
    return TEXTS;
  },
} as unknown as SVGSVGElement;

Deno.test("SVG measurement helpers ignore empty and unmeasurable text", () => {
  const keyOf = (text: SVGTextElement) => text.dataset.label ?? "";

  assertEquals(
    measureSvgTextBoxes(SVG, "text[data-label]", keyOf),
    new Map([
      ["visible", { x: 1, y: 2, width: 3, height: 4 }],
    ]),
  );
  assertEquals(
    measureSvgTextWidths(SVG, "text[data-label]", keyOf),
    new Map([["visible", 3]]),
  );
});

Deno.test("whenFontsReady skips a callback after cancellation", async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const ready = Promise.resolve({} as FontFaceSet);
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { fonts: { ready } },
  });

  try {
    let calls = 0;
    whenFontsReady(() => calls += 1);
    const cancel = whenFontsReady(() => calls += 1);
    cancel();

    await ready;
    assertEquals(calls, 1);
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      delete (globalThis as unknown as Record<string, unknown>).document;
    }
  }
});
