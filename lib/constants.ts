/**
 * Application constants: tab routing, filter definitions, external URL
 * templates and display labels.
 *
 * Ported from the Shiny app's R/constants.R and the sidebar `choices` lists in
 * R/ui.R. Filter values are matched against the data literally, sentinel
 * strings included, so they must stay byte-identical to what
 * `pipeline/export/tables.py` emits.
 *
 * `GWAS_TRAIT_CHOICES` is derived from `disease/vocabulary.json`, the single
 * source of truth for the trait vocabulary. Add a trait there, not here.
 */

import vocabulary from "../disease/vocabulary.json" with { type: "json" };
import type { Acronym, FilterChoice } from "./types.ts";
import type { IconName } from "../components/Icon.tsx";
import { POPULATIONS } from "./disease/populations.ts";
import { GOLD_ONLY } from "./gold_only.ts";
import { NONE_FOUND, UNKNOWN } from "./sentinels.ts";
import { parseMonthYear } from "./sorting.ts";
import { STATUS_NOT_STATED, TRIAL_STATUSES } from "./trial_status.ts";

/** The name in the tab title, on the login card and in the page footer. */
export { SITE_TITLE } from "./disease/site.ts";

export const SHOW_ALL = "all";
// The sentinels are declared once, in lib/sentinels.ts; NONE_FOUND is
// re-exported because two filter choice lists name it.
export { NONE_FOUND };

/**
 * Whether a list column carries evidence, or only the empty sentinel.
 *
 * One predicate rather than one per caller: the sentinel has to stay
 * byte-identical to what `pipeline/export/tables.py` emits, so every site that
 * tests for it has to move when it moves. `lib/data/genes.ts` has already
 * trimmed each entry and dropped the empty ones, so a bare inequality is
 * enough.
 */
export function hasRealValues(values: readonly string[]): boolean {
  return values.some((value) => value !== NONE_FOUND);
}

// -----------------------------------------------------------------------------
// NAVIGATION
// -----------------------------------------------------------------------------

interface Tab {
  href: string;
  label: string;
  /** Heroicons v2 outline glyph from `components/Icon.tsx`, inlined in the nav. */
  icon: IconName;
}

export const TABS: readonly Tab[] = [
  { href: "/", label: "About", icon: "info" },
  { href: "/genes", label: "Genes", icon: "dna" },
  { href: "/phenogram", label: "Phenogram", icon: "chartBar" },
  { href: "/trials", label: "Clinical Trials", icon: "beaker" },
  { href: "/timeline", label: "Trials Radar", icon: "clock" },
  { href: "/map", label: "Trials Map", icon: "map" },
];

const LONG_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** Format an ISO-like timestamp for display, or null when it is unusable. */
export function formatLongDate(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : LONG_DATE_FORMAT.format(date);
}

const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** The trial table's M/YYYY completion dates as "Jul 2028"; other text verbatim. */
export function formatMonthYear(value: string): string {
  const parsed = parseMonthYear(value);
  if (!parsed) return value;
  return MONTH_YEAR_FORMAT.format(
    new Date(Date.UTC(parsed.year, parsed.month - 1, 1)),
  );
}

// -----------------------------------------------------------------------------
// GENES TAB FILTERS
// -----------------------------------------------------------------------------

export const YES_NO_CHOICES: readonly FilterChoice[] = [
  { label: "Yes", value: "Yes" },
  { label: "No", value: "No" },
];

export const GWAS_TRAIT_CHOICES: readonly FilterChoice[] = [
  { label: "Show All", value: SHOW_ALL },
  { label: "None Found", value: NONE_FOUND },
  // Derived, never listed: `disease/vocabulary.json` is the one place a trait's
  // key and label live. Listing them here too is what once let one trait's
  // label here and the phenogram's drift apart, capitalised differently,
  // unnoticed.
  ...vocabulary.traits.map((trait) => ({
    label: trait.label,
    value: trait.key,
    description: trait.name,
  })),
];

export const OMICS_CHOICES: readonly FilterChoice[] = [
  { label: "Show All", value: SHOW_ALL },
  { label: "None Found", value: NONE_FOUND },
  { label: "EWAS", value: "EWAS" },
  { label: "TWAS", value: "TWAS" },
  { label: "PWAS", value: "PWAS" },
  { label: "Proteomics", value: "Proteomics" },
  // Sequencing evidence, distinct from the association studies above. Added
  // when the extraction began reporting it: the pipeline produces "WES/WGS"
  // routinely, and an omics value absent from this list is unreachable in
  // the filter and fails the data contract test.
  { label: "WES/WGS", value: "WES/WGS" },
  // The curated evidence the hand-curated gold sheet folds into this column.
  { label: "Proteogenomic MR", value: "Proteogenomic MR" },
  { label: "Fine-mapping", value: "Fine-mapping" },
  { label: "Experimental", value: "Experimental" },
  {
    label: "MENTR",
    value: "mutation effect prediction on ncRNA transcription",
  },
];

// -----------------------------------------------------------------------------
// CLINICAL TRIALS TAB FILTERS
// -----------------------------------------------------------------------------

export const REGISTRY_CHOICES: readonly FilterChoice[] = [
  { label: "Show All", value: SHOW_ALL },
  { label: "ClinicalTrials.gov (NCT)", value: "NCT" },
  {
    label: "International Standard Randomised Controlled Trial Number (ISRCTN)",
    value: "ISRCTN",
  },
  {
    label: "Australian New Zealand Clinical Trials Registry (ANZCTR)",
    value: "ACTRN",
  },
  { label: "Chinese Clinical Trial Register (ChiCTR)", value: "ChiCTR" },
];

export const PHASE_CHOICES: readonly FilterChoice[] = [
  { label: "Show All", value: SHOW_ALL },
  // A seamless design ("II/III", "I/II") deliberately gets no choice of its
  // own: `matchesPhase` reads each Roman token, so a II/III trial already
  // answers both "Phase II" and "Phase III" -- which is what the table is
  // asked, "does this trial cover phase II". (The radar has no ring for it
  // and leaves it off; see `.claude/rules/timeline.md`.)
  { label: "Phase I", value: "I" },
  { label: "Phase II", value: "II" },
  { label: "Phase III", value: "III" },
  { label: "Phase IV", value: "IV" },
  { label: "Phase not stated", value: UNKNOWN },
];

export const POPULATION_CHOICES: readonly FilterChoice[] = [
  { label: "Show All", value: SHOW_ALL },
  // Derived, never listed: `disease/manifest.json` is the one place a
  // population's key and label live, and `disease/timeline.json` gives the
  // same keys their sector colours. tests/disease_manifest_test.ts holds the
  // two in the same order.
  ...POPULATIONS.map((p) => ({ label: p.label, value: p.key })),
];

export const SPONSOR_CHOICES: readonly FilterChoice[] = [
  { label: "Show All", value: SHOW_ALL },
  { label: "Academic", value: "Academic" },
  { label: "Industry", value: "Industry" },
];

/**
 * Derived from the status vocabulary rather than restated: every published
 * token needs a choice or `tests/data_contract_test.ts` fails. TERMINATED
 * and WITHDRAWN never publish (`_UNPUBLISHED_TRIAL_STATUSES` in
 * pipeline/export/main.py); SUSPENDED can, so it keeps a choice.
 */
export const STATUS_CHOICES: readonly FilterChoice[] = [
  { label: "Show All", value: SHOW_ALL },
  ...Object.entries(TRIAL_STATUSES)
    .filter(([token, status]) =>
      status.kind !== "terminated" || token === "SUSPENDED"
    )
    .map(([token, status]) => (
      token === STATUS_NOT_STATED
        ? {
          label: status.label,
          value: token,
          description: "registry not updated, or no ClinicalTrials.gov record",
        }
        : { label: status.label, value: token }
    )),
];

/**
 * Statuses the trials pages start with unticked. They stay in the record and
 * one tick away, but off the page until asked for: a completed trial is over,
 * a suspended one is paused, and a status not stated -- CT.gov's own UNKNOWN,
 * or a trial with no ClinicalTrials.gov record at all -- says nothing current.
 */
const HIDDEN_BY_DEFAULT: ReadonlySet<string> = new Set([
  "COMPLETED",
  "SUSPENDED",
  STATUS_NOT_STATED,
]);

/**
 * The status selection the trials table, radar and map start from.
 *
 * Under `GOLD_ONLY` it is Show All, every status the "(unknown)" sentinel
 * included: a curated trial registered outside ClinicalTrials.gov carries no
 * registry status and reads as not stated, so the run default would hide
 * every such trial, and every completed one, from all three trials pages,
 * where the curated set is meant to be seen whole. Otherwise every status but
 * those in `HIDDEN_BY_DEFAULT`.
 */
export function defaultTrialStatuses(
  goldOnly: boolean = GOLD_ONLY,
): readonly string[] {
  if (goldOnly) return [SHOW_ALL];
  return STATUS_CHOICES
    .map((choice) => choice.value)
    .filter((value) => value !== SHOW_ALL && !HIDDEN_BY_DEFAULT.has(value));
}

/** `defaultTrialStatuses()` as the dashboard is built: the one filter default the pages start from that is not always Show-All. */
export const DEFAULT_TRIAL_STATUSES: readonly string[] = defaultTrialStatuses();

// -----------------------------------------------------------------------------
// REGISTRIES AND EXTERNAL LINKS
// -----------------------------------------------------------------------------

export const NCBI_GENE_BASE_URL = "https://www.ncbi.nlm.nih.gov/gene/";
export const PUBMED_BASE_URL = "https://pubmed.ncbi.nlm.nih.gov/";

// Re-exported from the disease manifest:
export { CELL_TYPE_NAMES } from "./disease/cell_types.ts";

// -----------------------------------------------------------------------------
// ABBREVIATION EXPANSIONS
// -----------------------------------------------------------------------------

/**
 * Acronyms that mean the same thing whatever the disease: omics methods,
 * anatomy, reference datasets, lab methods. The disease's own terms live in
 * `disease/manifest.json`'s `acronyms`, which override these on a clash;
 * `lib/disease/acronyms.ts` merges the two.
 */
export const GENERIC_ACRONYMS: Readonly<Record<string, Acronym>> = {
  TWAS: {
    name: "Transcriptome-Wide Association Study",
    kind: "omics methodology",
  },
  PWAS: { name: "Proteome-Wide Association Study", kind: "omics methodology" },
  EWAS: { name: "Epigenome-Wide Association Study", kind: "omics methodology" },
  "WES/WGS": {
    name: "Whole-exome / whole-genome sequencing",
    kind: "omics methodology",
  },
  MR: { name: "Mendelian randomization", kind: "statistical method" },
  SMR: {
    name: "Summary-data-based Mendelian randomization",
    kind: "statistical method",
  },
  HEIDI: {
    name: "Heterogeneity in dependent instruments (test)",
    kind: "statistical method",
  },
  MTAG: { name: "Multi-Trait Analysis of GWAS", kind: "statistical method" },
  MENTR: {
    name: "Mutation Effect prediction on ncRNA TRanscription",
    kind: "computational method",
  },
  ML: { name: "Machine learning", kind: "computational method" },
  ncRNA: { name: "Non-coding RNA", kind: "molecule" },
  "RNA-Seq": { name: "RNA sequencing", kind: "lab method" },
  CRISPR: { name: "CRISPR-Cas genome editing", kind: "lab method" },
  siRNA: { name: "Small interfering RNA", kind: "lab method" },
  HBMEC: {
    name: "Human brain microvascular endothelial cells",
    kind: "cell model",
  },
  LoF: { name: "Loss of function", kind: "variant class" },
  sQTL: { name: "Splicing quantitative trait locus", kind: "molecular trait" },
  eQTL: {
    name: "Expression quantitative trait locus",
    kind: "molecular trait",
  },
  pQTL: { name: "Protein quantitative trait locus", kind: "molecular trait" },
  sCCA1: {
    name:
      "Cross-tissue expression feature 1, from sparse canonical correlation analysis of GTEx tissues",
    kind: "expression model",
  },
  sCCA2: {
    name:
      "Cross-tissue expression feature 2, from sparse canonical correlation analysis of GTEx tissues",
    kind: "expression model",
  },
  sCCA3: {
    name:
      "Cross-tissue expression feature 3, from sparse canonical correlation analysis of GTEx tissues",
    kind: "expression model",
  },
  YFS: { name: "Young Finns Study", kind: "reference dataset (whole blood)" },
  GTEx: {
    name: "Genotype-Tissue Expression project",
    kind: "reference dataset (multiple tissues)",
  },
  UKB: { name: "UK Biobank", kind: "cohort" },
  CMC: {
    name: "CommonMind Consortium",
    kind: "reference dataset (dorsolateral prefrontal cortex)",
  },
  NTR: {
    name: "Netherlands Twin Register",
    kind: "reference dataset (peripheral blood)",
  },
  dlPFC: {
    name: "Dorsolateral prefrontal cortex",
    kind: "anatomical location",
  },
  dPFC: { name: "Dorsolateral prefrontal cortex", kind: "anatomical location" },
  BA9: { name: "Brodmann area 9", kind: "anatomical location" },
  BA24: { name: "Brodmann area 24", kind: "anatomical location" },
  C1: {
    name: "First cervical segment of the spinal cord",
    kind: "anatomical location",
  },
};
