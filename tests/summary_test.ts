/** The About page's four totals, over synthetic rows and over the committed ones. */
import { assertEquals } from "@std/assert";

import { genes, trials } from "../lib/data.ts";
import {
  drugCount,
  geneCount,
  publicationCount,
  summarize,
  trialCount,
} from "../lib/data/summary.ts";
import { REFERENCE_NEEDED } from "../lib/sentinels.ts";
import { sampleGene, sampleTrial } from "./fixtures/rows.ts";

Deno.test("summarize counts distinct genes, drugs, trials and numeric PMIDs", () => {
  const summary = summarize(
    [
      sampleGene({ gene: "GENE1", references: ["1", "2"] }),
      sampleGene({ gene: "GENE1", references: ["2", REFERENCE_NEEDED] }),
      sampleGene({ gene: "GENE2", references: ["0123", "3"] }),
    ],
    [
      sampleTrial({ drug: "Drug A", registryId: "NCT00000001" }),
      sampleTrial({ drug: "Drug A", registryId: "NCT00000002" }),
      sampleTrial({ drug: "Drug B", registryId: "NCT00000002" }),
    ],
  );
  assertEquals(summary, {
    geneCount: 2,
    drugCount: 2,
    trialCount: 2,
    // "0123" is not a PMID and the sentinel is a gap marker.
    publicationCount: 3,
  });
});

Deno.test("summarize of nothing is four zeros", () => {
  assertEquals(summarize([], []), {
    geneCount: 0,
    drugCount: 0,
    trialCount: 0,
    publicationCount: 0,
  });
});

Deno.test("the module constants are summarize over the committed data", () => {
  assertEquals(
    { geneCount, drugCount, trialCount, publicationCount },
    summarize(genes, trials),
  );
});
