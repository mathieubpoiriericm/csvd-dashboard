/**
 * The four data islands server-rendered over synthetic rows.
 *
 * Each island defaults to the committed table, which on the empty export a
 * fork starts from renders nothing but its chrome. These hand in rows built
 * from the encodings so the row-driven branches -- pills and glyphs, markers
 * and rings, merged cells, tooltipped values -- run on any dataset.
 *
 * The adapt wizard is here too: it reads no dataset, so its case only has
 * to prove the first paint happens on the server.
 */
import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { options } from "preact";
import { renderToString } from "preact-render-to-string";

import AdaptWizard from "../islands/AdaptWizard.tsx";
import GenesView from "../islands/GenesView.tsx";
import Phenogram from "../islands/Phenogram.tsx";
import TrialsTimeline from "../islands/TrialsTimeline.tsx";
import TrialsView from "../islands/TrialsView.tsx";
import {
  type Answers,
  DRAFT_STORAGE_KEY,
  parseDraft,
} from "../lib/adapt/answers.ts";
import { placeGene } from "../lib/cytobands.ts";
import { encoding as phenogram } from "../lib/phenogram.ts";
import { encoding as timeline } from "../lib/timeline.ts";
import { sampleGene, sampleTrial } from "./fixtures/rows.ts";

const count = (html: string, needle: string) => html.split(needle).length - 1;

const TRAIT = phenogram.traits[0];
const POPULATION = timeline.populations[0].key;
const MECHANISM = Object.keys(timeline.mechanisms)[0];
const UNCHARACTERISED = timeline.families.find((f) =>
  f.key === "uncharacterised"
)?.mechanisms[0];

const GENES = [
  sampleGene({
    gene: "GENE1",
    protein: "Protein one",
    chromosomalLocation: "1p36.33",
    gwasTrait: [TRAIT.key],
    evidenceFromOtherOmicsStudies: ["TWAS;whole blood", "Proteomics"],
    linkToMonogenicDisease: ["100000"],
    mendelianRandomization: "Yes",
    brainCellTypes: "EC > PC",
    affectedPathway: "A pathway",
    references: ["10000001", "(reference needed)"],
    confidence: 0.5,
  }),
  sampleGene({
    gene: "GENE2",
    protein: "(unknown)",
    chromosomalLocation: "13q34",
    confidence: null,
    affectedPathway: "NA",
  }),
  sampleGene({ gene: "GENE3", chromosomalLocation: "(unknown)" }),
  // Enough rows for a second page, so the pager's next button is live; every
  // band is a real hg38 one so each row also draws on the karyogram.
  ...[
    "2p25.3",
    "2p24.1",
    "2p23.3",
    "2p22.3",
    "2p21",
    "2p16.3",
    "2p13.3",
    "2q11.2",
    "2q21.1",
    "2q31.1",
  ].map((band, i) =>
    sampleGene({ gene: `GENE${i + 4}`, chromosomalLocation: band })
  ),
];

const TRIALS = [
  sampleTrial({
    drug: "Drug A",
    registryId: "NCT00000001",
    targetPopulation: POPULATION,
    mechanismOfAction: MECHANISM,
    geneticEvidence: "Yes",
    geneticTarget: "GENE1, GENE2",
    clinicalTrialPhase: "II",
  }),
  sampleTrial({
    drug: "Drug A",
    registryId: "NCT00000002",
    targetPopulation: POPULATION,
    mechanismOfAction: MECHANISM,
    geneticEvidence: "No",
    geneticTarget: "GENE1",
    clinicalTrialPhase: "II",
    estimatedCompletionDate: "(unknown)",
  }),
  // The last population: its label may run to two lines.
  sampleTrial({
    drug: "Drug B",
    registryId: "ISRCTN00000003",
    targetPopulation: timeline.populations.at(-1)!.key,
    mechanismOfAction: UNCHARACTERISED ?? MECHANISM,
    clinicalTrialPhase: "(unknown)",
    targetSampleSize: "(unknown)",
    sponsorType: "Industry",
  }),
  // A registry-less, status-less row, completed and so hidden by default.
  sampleTrial({
    drug: "Drug C",
    registryId: "(unknown)",
    overallStatus: "(unknown)",
    clinicalTrialPhase: "",
    targetPopulation: POPULATION,
    mechanismOfAction: MECHANISM,
  }),
];

Deno.test("GenesView renders tooltipped values, absent cells and citations from synthetic rows", () => {
  const html = renderToString(<GenesView rows={GENES} />);
  assertStringIncludes(html, "GENE1");
  assertStringIncludes(html, "GENE3");
  assertStringIncludes(html, 'class="cell-absent"');
  assertStringIncludes(html, "TWAS (whole blood)");
  // A PMID with no citation record renders as the number itself.
  assertStringIncludes(html, ">10000001<");
  assertStringIncludes(html, "showing 13 of 13 rows");
  assertStringIncludes(html, "Showing 1–10 of 13");
  assertStringIncludes(html, "Genes by chromosome");
});

Deno.test("Phenogram draws a block per placeable gene and reports the rest", () => {
  const html = renderToString(<Phenogram rows={GENES} />);
  const placed = GENES.filter((g) => placeGene(g.chromosomalLocation) !== null);
  assert(placed.length >= 2 && placed.length < GENES.length);
  assertEquals(count(html, 'class="phenogram-block"'), placed.length);
  assertEquals(
    count(html, 'class="phenogram-chromosome"'),
    new Set(placed.map((g) => placeGene(g.chromosomalLocation)!.chromosome))
      .size,
  );
  assertStringIncludes(html, 'class="phenogram-pill-mark"');
  assertStringIncludes(html, 'class="phenogram-glyph"');
  assertStringIncludes(html, 'class="phenogram-unplaced"');
  assertStringIncludes(html, "GENE3");
  assertStringIncludes(html, TRAIT.label);
});

Deno.test("Phenogram over no genes draws no chromosome and no unplaced note", () => {
  const html = renderToString(<Phenogram rows={[]} />);
  assertEquals(count(html, 'class="phenogram-block"'), 0);
  assert(!html.includes('class="phenogram-unplaced"'));
  assertStringIncludes(html, "GWAS phenotypes");
});

Deno.test("TrialsTimeline draws a marker per visible trial with rings, gaps and both legends", () => {
  const html = renderToString(<TrialsTimeline rows={TRIALS} />);
  // One marker group per trial the rings can place; the phase-less row is
  // counted but drawn nowhere.
  assertEquals(count(html, 'data-drug="Drug A"'), 2);
  assertEquals(count(html, 'class="marker"'), 3);
  assertStringIncludes(html, 'class="evidence"');
  assertStringIncludes(html, 'class="gap"');
  assertStringIncludes(html, "Showing 4 of 4 trials");
  assertStringIncludes(html, 'class="timeline-legend-item"');
  assertStringIncludes(html, timeline.populations[0].label.join(" "));
});

Deno.test("TrialsTimeline over no trials keeps its key and its count", () => {
  const html = renderToString(<TrialsTimeline rows={[]} />);
  assertStringIncludes(html, "Showing 0 of 0 trials");
  assert(!html.includes("data-drug="));
});

Deno.test("TrialsView merges a drug's rows and tooltips its targets and registry ids", () => {
  const html = renderToString(<TrialsView rows={TRIALS} />);
  assertStringIncludes(html, "group-cell");
  assertStringIncludes(html, "NCT00000001");
  assertStringIncludes(html, "GENE1");
  assertStringIncludes(html, "Recruiting");
  // A status the registry never stated folds onto the UNKNOWN choice, which
  // the default selection keeps, so every synthetic row shows.
  assertStringIncludes(html, "showing 4 of 4 rows");
  assertStringIncludes(html, "Jan 2030");
});

Deno.test("TrialsView over no trials renders the empty state and its readout", () => {
  const html = renderToString(<TrialsView rows={[]} />);
  assertStringIncludes(html, "No rows match the current filters.");
  assertStringIncludes(html, "showing 0 of 0 rows");
});

Deno.test("the adapt wizard server-renders the stepper and the first step", () => {
  const html = renderToString(<AdaptWizard />);
  assertStringIncludes(html, 'class="adapt-stepper"');
  assertStringIncludes(html, "Identity");
  assertStringIncludes(html, "Disease name");
  // Until the island has read the stored draft the form is disabled, and a
  // note inside it says why; a page whose island never starts keeps it.
  assertMatch(
    html,
    /<fieldset class="adapt"\s+disabled[^>]*><p class="adapt-status">Loading the wizard/,
  );
});

Deno.test("the wizard saves a draft whenever a step edits the answers", () => {
  // The island hands each step an `update`, and every field calls it. This
  // takes the one the first step was handed and applies a real edit: what
  // comes back has to be in storage, parseable, and carry the edit --
  // otherwise a reload loses the interview.
  const store = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    },
  });
  const updates: Array<(change: (draft: Answers) => void) => void> = [];
  const previous = options.vnode;
  options.vnode = (vnode) => {
    const update = (vnode.props as { update?: unknown }).update;
    if (typeof update === "function") {
      updates.push(update as (change: (draft: Answers) => void) => void);
    }
    previous?.(vnode);
  };
  try {
    renderToString(<AdaptWizard />);
    assert(updates.length > 0, "no step was handed an update");
    updates[0]((draft) => draft.identity.disease.name = "exampleitis");
  } finally {
    options.vnode = previous;
    Object.defineProperty(globalThis, "localStorage", original);
  }
  const saved = parseDraft(store.get(DRAFT_STORAGE_KEY) ?? "");
  assertEquals(saved?.identity.disease.name, "exampleitis");
});

Deno.test("the wizard's first render marks the Next button and no step amber", () => {
  const html = renderToString(<AdaptWizard />);
  assertStringIncludes(html, "data-next");
  assert(!html.includes("is-fix"), "no step starts amber");
  assertStringIncludes(html, "adapt-stepper-item is-todo is-current");
  assertStringIncludes(html, 'data-card="disease"');
  assertStringIncludes(html, 'aria-expanded="true"');
  assertStringIncludes(html, "0</strong> of 24 answered");
  assert(!html.includes('aria-invalid="true"'), "no field starts in error");
});
