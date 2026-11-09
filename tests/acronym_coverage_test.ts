import { assertEquals } from "@std/assert";

import { glossaryGaps } from "../lib/acronyms.ts";
import { genes } from "../lib/data/genes.ts";

// Derived from whatever rows are committed, so it holds for any disease and
// passes trivially on `deno task data:empty`. A curated row must be fully
// covered; a row a pipeline run wrote only reports its gaps (`glossaryGaps`),
// because the model names methods the glossary has not met yet, and that is
// a reason to grow the glossary, not to hold a deploy back.
Deno.test("every acronym in the curated trait and omics columns has a glossary entry", () => {
  const { curated, extracted } = glossaryGaps(genes);
  if (extracted.length > 0) {
    console.warn(
      `Acronyms in pipeline-written rows with no glossary entry yet: ${
        extracted.join("; ")
      }`,
    );
  }
  assertEquals(curated, []);
});
