import { assertEquals } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { AcronymText } from "../components/AcronymText.tsx";
import { OmicsEntryView } from "../components/OmicsEntryView.tsx";

// TWAS is a generic glossary term, so these hold for any disease's manifest;
// "Q" and the tissues are in no glossary.

/** The text of every tooltip trigger, in order. */
const triggers = (html: string) =>
  [...html.matchAll(
    /<button[^>]*class="tooltip-box[^"]*"[^>]*>(.*?)<\/button>/g,
  )]
    .map((match) => match[1]);

/** What the cell reads as: every tag gone (closed panels render empty). */
const text = (html: string) => html.replace(/<[^>]+>/g, "");

Deno.test("an omics entry prints the format and boxes only acronyms", () => {
  const html = renderToString(
    <OmicsEntryView value="TWAS;Q: artery aorta*, nerve tibial" />,
  );
  assertEquals(triggers(html), ["TWAS"]);
  assertEquals(text(html), "TWAS (Q: artery aorta, nerve tibial)");
});

Deno.test("an omics entry with nothing to explain renders plain text", () => {
  const html = renderToString(<OmicsEntryView value="Qomics;Q: a" />);
  assertEquals(triggers(html), []);
  assertEquals(text(html), "Qomics (Q: a)");
});

Deno.test("a starred entry whose type the glossary lacks still boxes the type", () => {
  const html = renderToString(<OmicsEntryView value="Qomics;Q: a*" />);
  assertEquals(triggers(html), ["Qomics"]);
});

Deno.test("an acronym inside an item is boxed", () => {
  const html = renderToString(<OmicsEntryView value="Qomics;TWAS: a, TWAS*" />);
  assertEquals(triggers(html), ["Qomics", "TWAS", "TWAS"]);
  assertEquals(text(html), "Qomics (TWAS: a, TWAS)");
});

Deno.test("AcronymText boxes each acronym and leaves the words around it", () => {
  const html = renderToString(<AcronymText text="multi-trait TWAS and more" />);
  assertEquals(triggers(html), ["TWAS"]);
  assertEquals(text(html), "multi-trait TWAS and more");
});
