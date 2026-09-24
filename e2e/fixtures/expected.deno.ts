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
  GWAS_TRAIT_CHOICES,
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
  filterGenes,
  filterLocationsByStatus,
  filterTrials,
  omicsType,
  visibleTrials,
} from "../../lib/filters.ts";
import {
  computePhenogramLayout,
  encoding as phenogram,
} from "../../lib/phenogram.ts";
import { chromosomeOf } from "../../lib/sorting.ts";
import {
  computeTimelineLayout,
  encoding as timeline,
} from "../../lib/timeline.ts";
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

const traitChoices = choices(GWAS_TRAIT_CHOICES).filter((c) =>
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
const statusLabels = STATUS_CHOICES.filter((c) =>
  DEFAULT_TRIAL_STATUSES.includes(c.value)
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
].map((p) => p || "—");

const shownLocations = filterLocationsByStatus(
  trialLocations,
  DEFAULT_TRIAL_STATUSES,
);
const nctKey = (value: string) => value.trim().toUpperCase();

// ---------------------------------------------------------------------------
// The two figures
// ---------------------------------------------------------------------------

const radar = computeTimelineLayout(shownTrials);
const radarAll = computeTimelineLayout(trials);
const karyogram = computePhenogramLayout(genes);

const firstGene = (rows: readonly Gene[]) => rows[0]?.gene ?? null;
const distinct = <T>(values: readonly T[]) => new Set(values).size;

const expected = {
  ...summarize(genes, trials),
  siteTitle: manifest.site.title,
  aboutHeading: manifest.site.aboutTitle,
  populationLabel: manifest.populationField.label,
  instituteAlt: manifest.institute.logo.alt,
  instituteCopyright: manifest.institute.copyright,
  maintainerEmail: manifest.contact.maintainer.email,
  traitCount: phenogram.traits.length,

  geneRows: genes.length,
  trialRows: trials.length,
  trialRowsShown: shownTrials.length,
  statusSummary: `Study status: ${statusLabels.join(", ")}`,
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
  },

  firstGeneAsc: firstGene(genesByName),
  firstGeneDesc: firstGene([...genesByName].reverse()),
  chromosomesWithGenes: distinct(
    genes.map((g) => chromosomeOf(g.chromosomalLocation)).filter(Boolean),
  ),

  map: {
    sites: trialLocations.length,
    sitesShown: shownLocations.length,
    countries: uniqueCount(
      trialLocations.map((l) => l.country).filter(Boolean),
    ),
    trials: uniqueCount(trialLocations.map((l) => nctKey(l.nctId))),
  },

  timeline: {
    markers: radar.markers.length,
    allMarkers: radarAll.markers.length,
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
    families: phenogram.families.length,
    firstGene: karyogram.blocks[0]?.symbol ?? null,
  },

  hasPipelineStatus: pipelineStatus !== null,
  hasPipelineRun: pipelineRun !== null,
};

export type Expected = typeof expected;
export type ExpectedTrial = Trial;

console.log(JSON.stringify(expected));
