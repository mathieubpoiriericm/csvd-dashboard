/**
 * The gold-only switch: what the About page and the Genes table show while
 * only the hand-curated data is published.
 *
 * Every case passes `goldOnly` explicitly, so the file says the same thing
 * whichever way `GOLD_ONLY` is set; the run branch is tested with
 * `goldOnly={false}` in tests/routes_test.tsx.
 */

import {
  assertEquals,
  assertNotMatch,
  assertStringIncludes,
} from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { AboutContent } from "../routes/index.tsx";
import GenesView, { BrainCellTypesCell } from "../islands/GenesView.tsx";
import { GOLD_DATA_DATE, GOLD_ONLY_NOTICE } from "../lib/gold_only.ts";
import { formatLongDate } from "../lib/constants.ts";
import { splitCellTypes } from "../lib/tooltips.ts";
import type { PipelineRun, SyncRun } from "../lib/types.ts";
import { sampleGene } from "./fixtures/rows.ts";

const RECORDED_RUN = {
  runTimestamp: "2026-08-31T02:17:55+00:00",
  status: "completed",
} as unknown as PipelineRun;

const RECORDED_REFRESH = {
  runTimestamp: "2026-09-02T03:00:00Z",
  mode: "annotation_sync",
  status: "completed",
  durationSeconds: 91.235,
  sources: [],
  apis: [],
  errors: { shown: 0, total: 0, items: [] },
} as unknown as SyncRun;

const STATUS = {
  runTimestamp: "2026-08-30T12:00:00Z",
  papersProcessed: 9,
  fulltextRetrieved: 1,
  genesExtracted: 6,
  genesValidated: 0,
};

Deno.test("the gold data date reads as a long date", () => {
  assertEquals(formatLongDate(GOLD_DATA_DATE), "November 6, 2026");
});

Deno.test("gold-only About shows the notice and the curated date, and no run", () => {
  // Every pipeline account is supplied, so nothing is missing for want of
  // data: the notice stands in their place.
  const html = renderToString(
    <AboutContent
      goldOnly
      run={RECORDED_RUN}
      status={STATUS}
      syncs={[RECORDED_REFRESH]}
    />,
  );
  assertStringIncludes(html, GOLD_ONLY_NOTICE);
  // It informs, so it wears the neutral notice, not the warning's red.
  assertStringIncludes(html, 'class="notice notice-neutral about-gold-notice"');
  assertStringIncludes(html, "Hand-curated data as of November 6, 2026");
  assertNotMatch(html, /Up to date as of/);
  assertNotMatch(html, /Last Pipeline Run/);
  assertNotMatch(html, /value-box-row/);
  assertNotMatch(html, /pipeline-card/);
  assertNotMatch(html, /Reference Data Refreshes/);
  assertNotMatch(html, /pipeline-sync/);
});

Deno.test("gold-only About keeps its date and notice with no pipeline data", () => {
  // The empty-data start: nothing recorded at all.
  const html = renderToString(
    <AboutContent goldOnly run={null} status={null} syncs={[]} />,
  );
  assertStringIncludes(html, GOLD_ONLY_NOTICE);
  assertStringIncludes(html, "Hand-curated data as of November 6, 2026");
  assertNotMatch(html, /Data update date unavailable/);
});

Deno.test("the run branch carries no notice", () => {
  const html = renderToString(
    <AboutContent goldOnly={false} run={null} status={STATUS} />,
  );
  assertNotMatch(html, new RegExp(GOLD_ONLY_NOTICE));
  assertStringIncludes(html, "Up to date as of August 30, 2026");
});

Deno.test("gold-only Genes table has no provenance columns", () => {
  const html = renderToString(
    <GenesView goldOnly rows={[sampleGene()]} />,
  );
  assertNotMatch(html, /Extraction Provenance/);
  assertNotMatch(html, /Source Quote/);
  assertNotMatch(html, /Confidence/);
  assertNotMatch(html, /col-sourceQuote/);
  assertNotMatch(html, /col-confidence/);
  assertStringIncludes(html, "col-references");
});

Deno.test("the full Genes table keeps the provenance columns", () => {
  const html = renderToString(
    <GenesView goldOnly={false} rows={[sampleGene()]} />,
  );
  assertStringIncludes(html, "Extraction Provenance");
  assertStringIncludes(html, "col-sourceQuote");
  assertStringIncludes(html, "col-confidence");
});

Deno.test("a DOI reference with no citation links to the resolver, showing the DOI", () => {
  // No refs.json row: a cited preprint renders as a citation instead.
  const doi = "10.1000/uncited.1";
  const html = renderToString(
    <GenesView rows={[sampleGene({ references: ["10000001", doi] })]} />,
  );
  assertStringIncludes(html, `href="https://doi.org/${doi}"`);
  assertStringIncludes(html, `>${doi}</a>`);
  // The PMID beside it still renders as before.
  assertStringIncludes(html, ">10000001<");
});

Deno.test("splitCellTypes reads a labelled value as one chain per label", () => {
  assertEquals(
    splitCellTypes("Mouse: FB>PC; Human: Matrix.PC >> Venous.SMC"),
    {
      parts: ["FB", "PC", "Matrix.PC", "Venous.SMC"],
      chains: [
        { label: "Mouse", parts: ["FB", "PC"], separators: [">"] },
        {
          label: "Human",
          parts: ["Matrix.PC", "Venous.SMC"],
          separators: [">>"],
        },
      ],
    },
  );
  // Either side may be missing.
  assertEquals(splitCellTypes("Human: MG > RBC >> OPC").chains, [
    {
      label: "Human",
      parts: ["MG", "RBC", "OPC"],
      separators: [">", ">>"],
    },
  ]);
});

Deno.test("a value that is not labelled throughout stays one plain chain", () => {
  // A colon in one segment only is free text, not a label.
  assertEquals(splitCellTypes("Mouse: FB; EC").chains, [
    { label: null, parts: ["Mouse: FB; EC"], separators: [] },
  ]);
});

Deno.test("the cell prints each chain under its label", () => {
  const html = renderToString(
    <BrainCellTypesCell value="Mouse: FB>PC; Human: Matrix.PC >> Venous.SMC" />,
  );
  const text = html.replace(/<[^>]*>/g, "");
  assertStringIncludes(text, "Mouse: ");
  assertStringIncludes(text, "; Human: ");
  assertStringIncludes(text, "Matrix.PC >> Venous.SMC");
});
