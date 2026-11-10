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
import { GOLD_ONLY } from "../lib/gold_only.ts";
import { encoding as phenogram } from "../lib/phenogram.ts";
import { encoding as timeline } from "../lib/timeline.ts";
import {
  characterisedMechanism,
  sampleGene,
  sampleTrial,
} from "./fixtures/rows.ts";
import { escapeHtml } from "./helpers/html.ts";

const count = (html: string, needle: string) => html.split(needle).length - 1;

const TRAIT = phenogram.traits[0];
const POPULATION = timeline.populations[0].key;
// Never the flagged family's, which a disease may list first.
const MECHANISM = characterisedMechanism(timeline);
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
    clinicalTrialPhase: "I",
    targetSampleSize: "(unknown)",
    sponsorType: "Industry",
  }),
  // A registry-less, phase-less row: shown, since it is recruiting, but no
  // ring can place it.
  sampleTrial({
    drug: "Drug C",
    registryId: "(unknown)",
    clinicalTrialPhase: "",
    targetPopulation: POPULATION,
    mechanismOfAction: MECHANISM,
  }),
  // A status the registry never stated folds onto the Unknown choice, which
  // the default selection leaves unticked, so this row starts hidden.
  sampleTrial({
    drug: "Drug D",
    registryId: "NCT00000004",
    overallStatus: "(unknown)",
    clinicalTrialPhase: "III",
    targetPopulation: POPULATION,
    mechanismOfAction: MECHANISM,
  }),
];

Deno.test("GenesView renders tooltipped values, absent cells and citations from synthetic rows", () => {
  const html = renderToString(<GenesView rows={GENES} />);
  assertStringIncludes(html, "GENE1");
  assertStringIncludes(html, "GENE3");
  assertStringIncludes(html, 'class="cell-absent"');
  // The study type is its own tooltip, and the detail prints plain after it.
  assertStringIncludes(html, ">TWAS</button>");
  assertStringIncludes(html.replace(/<[^>]+>/g, ""), "TWAS (whole blood)");
  // A PMID with no citation record renders as the number itself.
  assertStringIncludes(html, ">10000001<");
  assertStringIncludes(html, "showing 13 of 13 rows");
  assertStringIncludes(html, "Showing 1–10 of 13");
  assertStringIncludes(html, "Genes by chromosome");
});

Deno.test("GenesView's first page ends at the last row when the table is shorter than a page", () => {
  // Where a disease's first export leaves it: fewer genes than a page holds.
  const html = renderToString(<GenesView rows={GENES.slice(0, 3)} />);
  assertStringIncludes(html, "showing 3 of 3 rows");
  assertStringIncludes(html, "Showing 1–3 of 3");
});

Deno.test("GenesView offers the traits its rows carry under gold-only, and every one otherwise", () => {
  // GENES carries one trait; the label of any other must be absent under
  // gold-only and present otherwise.
  const other = phenogram.traits.find((t) => t.key !== TRAIT.key);
  const label = (text: string) => `>${escapeHtml(text)}<`;
  const gold = renderToString(<GenesView rows={GENES} goldOnly />);
  assertStringIncludes(gold, label(TRAIT.label));
  const run = renderToString(<GenesView rows={GENES} goldOnly={false} />);
  assertStringIncludes(run, label(TRAIT.label));
  if (other) {
    assert(!gold.includes(label(other.label)), `${other.key} offered`);
    assertStringIncludes(run, label(other.label));
  }
});

Deno.test("GenesView links a DOI reference to the resolver, encoded", () => {
  const doi = "10.1000/50%-é";
  const html = renderToString(
    <GenesView rows={[sampleGene({ references: [doi] })]} />,
  );
  assertStringIncludes(html, 'href="https://doi.org/10.1000/50%25-%C3%A9"');
  assertStringIncludes(html, `>${doi}</a>`);
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
  // GENE3's location is the export's `(unknown)`: it is named as missing,
  // never printed raw inside the note's own parentheses.
  assertStringIncludes(html, "GENE3 (no location recorded)");
  assert(!html.includes("((unknown))"));
  assertStringIncludes(html, escapeHtml(TRAIT.label));
});

Deno.test("phenogram renders the download control", () => {
  const html = renderToString(<Phenogram rows={GENES} />);
  assertMatch(html, /<button[^>]*popovertarget="[^"]+"[^>]*>\s*Download SVG/);
  assertMatch(html, /<div\s+popover[^>]*id="[^"]+"/);
  assertStringIncludes(html, ">Figure only</button>");
  assertStringIncludes(html, ">Figure with key</button>");
  assertStringIncludes(html, "Install them before editing in Inkscape.");
});

Deno.test("Phenogram over no genes draws no chromosome and no unplaced note", () => {
  const html = renderToString(<Phenogram rows={[]} />);
  assertEquals(count(html, 'class="phenogram-block"'), 0);
  assert(!html.includes('class="phenogram-unplaced"'));
  assertStringIncludes(html, "GWAS phenotypes");
});

Deno.test("TrialsTimeline draws a marker per visible trial with rings, gaps and both legends", () => {
  const html = renderToString(<TrialsTimeline rows={TRIALS} />);
  // One marker group per visible trial the rings can place; the phase-less
  // row is counted but drawn nowhere. The status-less one starts hidden with
  // the rest of Unknown -- except under gold-only, whose default is Show All.
  assertEquals(count(html, 'data-drug="Drug A"'), 2);
  assertEquals(count(html, 'class="marker"'), GOLD_ONLY ? 4 : 3);
  assertEquals(html.includes('data-drug="Drug D"'), GOLD_ONLY);
  assertStringIncludes(html, 'class="evidence"');
  assertStringIncludes(html, 'class="gap"');
  assertStringIncludes(html, `Showing ${GOLD_ONLY ? 5 : 4} of 5 trials`);
  assertStringIncludes(html, 'class="timeline-legend-item"');
  assertStringIncludes(
    html,
    escapeHtml(timeline.populations[0].label.join(" ")),
  );
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
  // The status-less row starts hidden with the rest of Unknown, except under
  // gold-only, whose default is Show All.
  assertStringIncludes(html, `showing ${GOLD_ONLY ? 5 : 4} of 5 rows`);
  assertEquals(html.includes("NCT00000004"), GOLD_ONLY);
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
  // The action bar is pinned above the stepper, on every step.
  const bar = html.indexOf('class="adapt-bar"');
  assert(bar !== -1 && bar < html.indexOf('class="adapt-stepper"'), html);
  assertStringIncludes(html, "Identity");
  assertStringIncludes(html, "Disease name");
  // Until the island has read the stored draft the form is disabled, and a
  // note inside it says why; a page whose island never starts keeps it.
  assertMatch(
    html,
    /<fieldset class="adapt"\s+disabled[^>]*><p class="adapt-status">Loading the wizard/,
  );
});

Deno.test("the adapt wizard offers sessions only when the server keeps them", () => {
  for (
    const html of [
      renderToString(<AdaptWizard />),
      renderToString(<AdaptWizard sessions={false} />),
    ]
  ) {
    assert(!html.includes("Save session"), html);
    assert(!html.includes("<dialog"), html);
    assertStringIncludes(html, 'data-sessions="off"');
  }
  const on = renderToString(<AdaptWizard sessions />);
  assertStringIncludes(on, "Save session");
  assertMatch(on, /<fieldset class="adapt"[^>]*data-sessions="on"/);
  // The windows sit outside the fieldset, which is disabled until the
  // draft is read and would disable every control inside them.
  const fieldsetEnd = on.lastIndexOf("</fieldset>");
  assert(on.indexOf("<dialog") > fieldsetEnd, on);
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
