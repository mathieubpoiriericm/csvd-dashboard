import { assertEquals } from "@std/assert";

import { uncoveredAcronyms } from "../lib/acronyms.ts";
import { genes } from "../lib/data/genes.ts";

import { isAbsent } from "../lib/sentinels.ts";

// Derived from whatever rows are committed, so it holds for any disease and
// passes trivially on `deno task data:empty`. A gene symbol written in prose
// is no acronym, and the public glossary must never hold one; a term marked
// `[?]` awaits the curators, so the glossary cannot know it yet.
Deno.test("every acronym in the trait and omics columns has a glossary entry", () => {
  const symbols = new Set(genes.map((gene) => gene.gene));
  const missing = genes.flatMap((gene) =>
    [
      ...gene.gwasTrait,
      // The stored value, not the printed one: a `[?]` is what exempts the
      // term before it, and printing turns it into a bare `?`.
      ...gene.evidenceFromOtherOmicsStudies.map((v) => v.replaceAll("*", "")),
    ]
      .filter((value) => !isAbsent(value))
      .flatMap((value) => uncoveredAcronyms(value))
      .filter((token) => !symbols.has(token))
      .map((token) => `${gene.gene}: ${token}`)
  );
  assertEquals(missing, []);
});
