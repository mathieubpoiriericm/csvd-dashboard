/**
 * Every count the end-to-end suite expects, derived under Deno from the
 * app's own `lib/` over the committed `data/*.json` and `disease/`.
 *
 * `expected-data.ts` runs this file once per Playwright process and parses
 * the one JSON object it prints. It runs under Deno rather than Node so the
 * numbers come from the same filter rules, layout functions and status
 * vocabulary the islands use -- a Node re-implementation would be a second
 * copy of each to drift. Nothing here is a literal: a fork with its own data
 * and disease gets its own expectations for free, and on the empty export
 * every count is zero.
 *
 * `e2e/` is excluded from Deno's tooling (see e2e/CLAUDE.md), so
 * `deno task check` names this file explicitly: a `lib/` rename fails there
 * before it fails in a spec.
 */
import {
  DEFAULT_TRIAL_STATUSES,
  formatLongDate,
  NONE_FOUND,
  OMICS_CHOICES,
  PHASE_CHOICES,
  REGISTRY_CHOICES,
  SHOW_ALL,
  SPONSOR_CHOICES,
  STATUS_CHOICES,
} from "../../lib/constants.ts";
import { uniqueCount } from "../../lib/collections.ts";
import { genes } from "../../lib/data/genes.ts";
import { trialLocations } from "../../lib/data/locations.ts";
import { pipelineStatus } from "../../lib/data/pipeline.ts";
import { pipelineRun } from "../../lib/data/pipeline_run.ts";
import { summarize } from "../../lib/data/summary.ts";
import { trials } from "../../lib/data/trials.ts";
import { manifest } from "../../lib/disease.ts";
import {
  GOLD_DATA_DATE,
  GOLD_ONLY,
  GOLD_ONLY_NOTICE,
} from "../../lib/gold_only.ts";
import {
  filterGenes,
  filterLocationsByStatus,
  filterTrials,
  gwasTraitChoices,
  omicsType,
  visibleTrials,
} from "../../lib/filters.ts";
import { computePhenogramLayout } from "../../lib/phenogram.ts";
import { previewInvitation, previewNote } from "../../lib/pipeline_preview.ts";
import { chromosomeOf } from "../../lib/sorting.ts";
import { locationsWithTableStatus, phaseBarLabel } from "../../lib/trials.ts";
import {
  computeTimelineLayout,
  encoding as timeline,
} from "../../lib/timeline.ts";
import { HYSTERESIS } from "../../lib/timeline_scale.ts";
import type { Gene, Trial } from "../../lib/types.ts";

// ---------------------------------------------------------------------------
// Filter scenarios, through the real filter functions
// ---------------------------------------------------------------------------

const NO_GENE_FILTERS = {
  mendelianRandomization: ["Yes", "No"],
  gwasTraits: [SHOW_ALL],
  omics: [SHOW_ALL],
};

/** The trials page's opening state: every group open, statuses at default. */
const DEFAULT_TRIAL_FILTERS = {
  geneticEvidence: ["Yes", "No"],
  registries: [SHOW_ALL],
  phases: [SHOW_ALL],
  populations: [SHOW_ALL],
  sponsors: [SHOW_ALL],
  statuses: [...DEFAULT_TRIAL_STATUSES],
};

const countGenes = (
  overrides: Partial<Parameters<typeof filterGenes>[1]>,
): number => filterGenes(genes, { ...NO_GENE_FILTERS, ...overrides }).length;

const countTrials = (
  overrides: Partial<Parameters<typeof filterTrials>[1]>,
): number =>
  filterTrials(trials, { ...DEFAULT_TRIAL_FILTERS, ...overrides }).length;

const choices = (list: readonly { label: string; value: string }[]) =>
  list.filter((c) => c.value !== SHOW_ALL);

// The choices the page offers: under GOLD_ONLY only the traits a gene carries.
const traitChoices = choices(gwasTraitChoices(genes)).filter((c) =>
  c.value !== NONE_FOUND
);
const traits = traitChoices.map((c) => ({
  key: c.value,
  label: c.label,
  count: countGenes({ gwasTraits: [c.value] }),
}));
const traitsWithRows = [...traits].sort((a, b) => b.count - a.count);
const omics = choices(OMICS_CHOICES).map((c) => ({
  label: c.label,
  value: c.value,
  count: countGenes({ omics: [c.value] }),
}));
const omicsWithRows = omics.filter((o) => o.value !== NONE_FOUND && o.count > 0)
  .sort((a, b) => b.count - a.count);

/** A trait no Mendelian-randomisation gene carries, for the empty state. */
const impossibleGene = traits.find((t) =>
  t.count > 0 &&
  countGenes({ mendelianRandomization: ["Yes"], gwasTraits: [t.key] }) === 0
) ?? null;

const registries = choices(REGISTRY_CHOICES).map((c) => ({
  label: c.label,
  value: c.value,
  shown: countTrials({ registries: [c.value] }),
}));
const phases = choices(PHASE_CHOICES).map((c) => ({
  label: c.label,
  value: c.value,
  shown: countTrials({ phases: [c.value] }),
}));
const populations = manifest.populations.map((p) => ({
  key: p.key,
  label: p.label,
  radarLabel: timeline.populations.find((tp) => tp.key === p.key)?.label
    .join(" ") ?? p.label,
  shown: countTrials({ populations: [p.key] }),
}));
const sponsors = choices(SPONSOR_CHOICES).map((c) => ({
  label: c.label,
  value: c.value,
  shown: countTrials({ sponsors: [c.value] }),
}));

const firstWithRows = <T extends { shown: number }>(list: T[]): T | null =>
  list.find((entry) => entry.shown > 0) ?? null;

/** A registry and a phase that both have rows, and their intersection. */
const registryPhase = (() => {
  const registry = firstWithRows(registries);
  const phase = firstWithRows(phases);
  return registry && phase
    ? {
      registry,
      phase,
      shown: countTrials({
        registries: [registry.value],
        phases: [phase.value],
      }),
    }
    : null;
})();

/** A phase and a population that each have rows but none in common. */
const impossibleTrial = (() => {
  for (const phase of phases) {
    if (phase.shown === 0) continue;
    for (const population of populations) {
      if (population.shown === 0) continue;
      if (
        countTrials({
          phases: [phase.value],
          populations: [population.key],
        }) ===
          0
      ) return { phase, population };
    }
  }
  return null;
})();

// ---------------------------------------------------------------------------
// Tables, readouts and the map
// ---------------------------------------------------------------------------

const shownTrials = visibleTrials(trials);
// The statuses the pages start with ticked. Empty when the default is Show
// All (`GOLD_ONLY`): the status group then starts unconstrained and the
// banner carries no status fragment.
const statusLabels = STATUS_CHOICES.filter((c) =>
  c.value !== SHOW_ALL && DEFAULT_TRIAL_STATUSES.includes(c.value)
).map((c) => c.label);

/** TanStack's `text` sort: a case-folded basic compare. */
const textCompare = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y ? 0 : x > y ? 1 : -1;
};
const genesByName = [...genes].sort((a, b) => textCompare(a.gene, b.gene));

const PHASE_ORDER = ["I", "I/II", "II", "II/III", "III", "IV"];
const phasesInTable = new Set(trials.map((t) => t.clinicalTrialPhase.trim()));
const phasesPresent = [
  ...PHASE_ORDER.filter((p) => phasesInTable.has(p)),
  ...[...phasesInTable].filter((p) => !PHASE_ORDER.includes(p)).sort(),
].map(phaseBarLabel);

// The statuses the map labels and filters by: the trials table's under
// GOLD_ONLY, ClinicalTrials.gov's per-site ones otherwise.
const mapLocations = locationsWithTableStatus(trialLocations, trials);
const shownLocations = filterLocationsByStatus(
  mapLocations,
  DEFAULT_TRIAL_STATUSES,
);
const nctKey = (value: string) => value.trim().toUpperCase();

// ---------------------------------------------------------------------------
// The two figures
// ---------------------------------------------------------------------------

const radar = computeTimelineLayout(shownTrials);
const radarAll = computeTimelineLayout(trials);
/** A status whose trials put no marker on the radar: the empty phone list. */
const emptyRadarStatus = STATUS_CHOICES.find((c) =>
  c.value !== SHOW_ALL &&
  computeTimelineLayout(
      filterTrials(trials, { ...DEFAULT_TRIAL_FILTERS, statuses: [c.value] }),
    ).markers.length === 0
)?.label ?? null;
/**
 * The status that alone puts the most markers on the radar, with the labels
 * its plate draws, for a status change that leaves a crowded plate; null
 * when no status puts a marker there.
 */
const busiestRadarStatus = STATUS_CHOICES
  .filter((c) => c.value !== SHOW_ALL)
  .map((c) => {
    const layout = computeTimelineLayout(
      filterTrials(trials, { ...DEFAULT_TRIAL_FILTERS, statuses: [c.value] }),
    );
    return {
      label: c.label,
      markers: layout.markers.length,
      labels: layout.markers.length + layout.populationLabels.length +
        layout.phaseLabels.length,
    };
  })
  .filter((c) => c.markers > 0)
  .sort((a, b) => b.markers - a.markers)[0] ?? null;
const karyogram = computePhenogramLayout(genes);

const firstGene = (rows: readonly Gene[]) => rows[0]?.gene ?? null;

// The perf harness's search queries (e2e/perf/scenarios.mjs). A row's raw
// values stand in for the tables' search text, which is wider: it also
// searches what the cells print (short citations, cell types, formatted
// omics entries), so the app can match more rows than `rowsHolding` counts,
// never fewer -- the query is in the gene or drug column, which it searches.
// The count is a lower bound, and that is enough: the scenario asserts only
// that the banner names the query and that the first row kept holds it, and
// every row the search keeps holds it in its rendered text.
const rowText = (row: object) =>
  JSON.stringify(Object.values(row)).toLowerCase();
const rowsHolding = (rows: readonly object[], query: string) =>
  rows.filter((row) => rowText(row).includes(query.toLowerCase())).length;
/** A gene query typed as a prefix: a longer symbol's first five characters
 * that one gene row alone holds, the first such in name order; or null. */
const geneQuery = genesByName.map((g) => g.gene.trim())
  .filter((symbol) => symbol.length > 5).map((symbol) => symbol.slice(0, 5))
  .find((query) => rowsHolding(genes, query) === 1) ?? null;
/** A trial query: a whole drug name that one shown trial row alone holds,
 * one word if any is, the first such in name order; or null. */
const trialQueries = [...new Set(shownTrials.map((t) => t.drug.trim()))]
  .sort(textCompare)
  .filter((drug) => drug !== "" && rowsHolding(shownTrials, drug) === 1);
const trialQuery =
  trialQueries.find((drug) => /^[\p{L}\p{N}-]+$/u.test(drug)) ??
    trialQueries[0] ?? null;
const distinct = <T>(values: readonly T[]) => new Set(values).size;

const expected = {
  ...summarize(genes, trials),
  siteTitle: manifest.site.title,
  aboutHeading: manifest.site.aboutTitle,
  populationLabel: manifest.populationField.label,
  instituteAlt: manifest.institute.logo.alt,
  instituteCopyright: manifest.institute.copyright,
  maintainerEmail: manifest.contact.maintainer.email,
  /** The GWAS group's trait choices, Show All and None Found aside. */
  traitCount: traitChoices.length,

  geneRows: genes.length,
  trialRows: trials.length,
  trialRowsShown: shownTrials.length,
  statusSummary: statusLabels.length > 0
    ? `Study status: ${statusLabels.join(", ")}`
    : null,
  defaultStatusLabels: statusLabels,
  statusChoiceCount: STATUS_CHOICES.length,

  genes: {
    mrYes: countGenes({ mendelianRandomization: ["Yes"] }),
    mrNo: countGenes({ mendelianRandomization: ["No"] }),
    traits,
    topTraits: traitsWithRows.slice(0, 2),
    topTraitsUnion: traitsWithRows.length >= 2
      ? countGenes({
        gwasTraits: traitsWithRows.slice(0, 2).map((t) => t.key),
      })
      : 0,
    /** A trait whose label is not its wire value, or null. */
    relabelledTrait: traits.find((t) => t.label !== t.key) ?? null,
    omics,
    topOmics: omicsWithRows[0] ?? null,
    noneFound: countGenes({ gwasTraits: [NONE_FOUND] }),
    noneFoundBoth: countGenes({
      gwasTraits: [NONE_FOUND],
      omics: [NONE_FOUND],
    }),
    mrYesTopOmics: omicsWithRows[0]
      ? countGenes({
        mendelianRandomization: ["Yes"],
        omics: [omicsWithRows[0].value],
      })
      : 0,
    impossible: impossibleGene,
    omicsTypes: distinct(
      genes.flatMap((g) => g.evidenceFromOtherOmicsStudies).map(omicsType),
    ),
  },
  trials: {
    evidenceYes: countTrials({ geneticEvidence: ["Yes"] }),
    evidenceNo: countTrials({ geneticEvidence: ["No"] }),
    registries,
    registryUnion: registries.slice(0, 2).every((r) => r.shown > 0)
      ? countTrials({ registries: registries.slice(0, 2).map((r) => r.value) })
      : null,
    phases,
    phaseUnion: phases.slice(1, 3).every((p) => p.shown > 0)
      ? countTrials({ phases: phases.slice(1, 3).map((p) => p.value) })
      : null,
    populations,
    sponsors,
    registryPhase,
    impossible: impossibleTrial,
    phasesPresent,
    completedOnly: countTrials({ statuses: ["COMPLETED"] }),
  },

  /** The perf harness's search queries, each held by one row's raw values
   * (the app may match more); or null. */
  search: { genes: geneQuery, trials: trialQuery },

  firstGeneAsc: firstGene(genesByName),
  firstGeneDesc: firstGene([...genesByName].reverse()),
  chromosomesWithGenes: distinct(
    genes.map((g) => chromosomeOf(g.chromosomalLocation)).filter(Boolean),
  ),

  map: {
    sites: trialLocations.length,
    sitesShown: shownLocations.length,
    /** Sites whose popup carries a status badge (a stated status). */
    sitesWithStatus: mapLocations.filter((l) => l.status !== null).length,
    countries: uniqueCount(
      trialLocations.map((l) => l.country).filter(Boolean),
    ),
    trials: uniqueCount(trialLocations.map((l) => nctKey(l.nctId))),
  },

  timeline: {
    markers: radar.markers.length,
    allMarkers: radarAll.markers.length,
    /** How much wider the room must get before the phone list gives way. */
    hysteresis: HYSTERESIS,
    emptyStatus: emptyRadarStatus,
    busiestStatus: busiestRadarStatus,
    cells: radar.cells.length,
    rimBands: radar.rimBands.length,
    populationLabels: radar.populationLabels.length,
    phaseLabels: radar.phaseLabels.length,
    evidenceRings: radar.markers.filter((m) => m.evidenceRing !== null).length,
    evidenceDashed: radar.markers.filter((m) => m.evidenceDash !== null).length,
    gaps: radar.markers.filter((m) => m.flagReasons.length > 0).length,
    families: radar.familyLegend.length,
    legendEntries: radar.familyLegend.reduce((n, f) => n + f.entries.length, 0),
    swatches: distinct(
      radar.familyLegend.flatMap((f) => f.entries.map((e) => e.color)),
    ),
    /** Every text label on the plate: one per marker, population and ring. */
    labels: radar.markers.length + radar.populationLabels.length +
      radar.phaseLabels.length,
    labelsAll: radarAll.markers.length + radarAll.populationLabels.length +
      radarAll.phaseLabels.length,
    /** The first marker drawn, for the drawer tests. */
    firstMarker: radar.markers[0]
      ? {
        drug: radar.markers[0].trial.drug,
        phase: radar.markers[0].phase,
        population: radar.markers[0].population,
        populationLabel: radar.markers[0].populationLabel,
        registryId: radar.markers[0].trial.registryId,
        flagged: radar.markers[0].flagReasons.length > 0,
      }
      : null,
    /** A wedge that carries a marker, for the hover tests. */
    filledCell: radar.cells.find((c) => c.filled)
      ? {
        population: radar.cells.find((c) => c.filled)!.population,
        phase: radar.cells.find((c) => c.filled)!.phase,
        populationLabel: populations.find((p) =>
          p.key === radar.cells.find((c) => c.filled)!.population
        )?.radarLabel ?? null,
      }
      : null,
  },

  phenogram: {
    chromosomes: karyogram.chromosomes.length,
    blocks: karyogram.blocks.length,
    families: karyogram.legend.families.length,
    legendTraits: karyogram.legend.families.reduce(
      (n, f) => n + f.traits.length,
      0,
    ),
    firstGene: karyogram.blocks[0]?.symbol ?? null,
    /** The figure's viewBox, derived from the genes' labels. */
    canvas: karyogram.canvas,
  },

  hasPipelineStatus: pipelineStatus !== null,
  hasPipelineRun: pipelineRun !== null,

  /** The gold-only switch, and what the About page says while it is on. */
  goldOnly: GOLD_ONLY,
  goldOnlyNotice: GOLD_ONLY_NOTICE,
  goldDataDate: formatLongDate(GOLD_DATA_DATE),
  /** The two sentences of the About page's technical-preview switch. */
  previewInvitation: previewInvitation(pipelineRun?.config.daysBack ?? null),
  previewNote: previewNote(pipelineRun?.config.daysBack ?? null),
};

export type Expected = typeof expected;
export type ExpectedTrial = Trial;

console.log(JSON.stringify(expected));
