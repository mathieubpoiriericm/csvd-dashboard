import { assertEquals } from "@std/assert";

import { glossaryGaps } from "../lib/acronyms.ts";
import { genes } from "../lib/data/genes.ts";

// Derived from whatever rows are committed, so it holds for any disease and
// passes trivially on `deno task data:empty`. The traits and study types
// come from closed vocabularies and a curated row's wording was reviewed, so
// a gap in any of them is a manifest bug and fails here. A biomarker or item
// a pipeline run wrote is the model's own words, which name methods the
// glossary has not met yet: that is a reason to grow the glossary, not to
// hold a deploy back, so those gaps are a GitHub warning on the run instead.
Deno.test("every acronym in the trait and omics columns a run cannot coin has a glossary entry", () => {
  const { enforced, reported } = glossaryGaps(genes);
  if (reported.length > 0) {
    // A workflow command: GitHub shows it as an annotation on the CI run,
    // which a passing test's console output never reaches.
    console.log(
      `::warning title=Acronyms with no glossary entry::${reported.join("; ")}`,
    );
  }
  assertEquals(enforced, []);
});
