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
import type { FilterChoice } from "./types.ts";
import type { IconName } from "../components/Icon.tsx";
import { NONE_FOUND, UNKNOWN } from "./sentinels.ts";
import { parseMonthYear } from "./sorting.ts";
import { STATUS_NOT_STATED, TRIAL_STATUSES } from "./trial_status.ts";

/** The name in the tab title, on the login card and in the page footer. */
export const SITE_TITLE = "ICM Cerebral SVD Dashboard";

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
  // key and label live. Listing them here too is what let "Lacunar Stroke"
  // and the phenogram's "Lacunar stroke" drift apart unnoticed.
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
  // own, though the radar gives it a ring: `matchesPhase` reads each Roman
  // token, so a II/III trial already answers both "Phase II" and
  // "Phase III" -- which is what the table is asked, "does this trial cover
  // phase II". The figure is asked something else, "where does this marker
  // go", and there a band of its own is the only honest answer.
  { label: "Phase I", value: "I" },
  { label: "Phase II", value: "II" },
  { label: "Phase III", value: "III" },
  { label: "Phase IV", value: "IV" },
  { label: "Phase not stated", value: UNKNOWN },
];

export const POPULATION_CHOICES: readonly FilterChoice[] = [
  { label: "Show All", value: SHOW_ALL },
  { label: "CAA", value: "CAA" },
  { label: "Cognitive Impairment", value: "Cognitive Impairment" },
  { label: "Stroke", value: "Stroke" },
  { label: "SVD", value: "SVD" },
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

/** The first filter default that is not Show-All: completed trials stay in the record and off the page. */
export const DEFAULT_TRIAL_STATUSES: readonly string[] = STATUS_CHOICES
  .map((choice) => choice.value)
  .filter((value) => value !== SHOW_ALL && value !== "COMPLETED");

// -----------------------------------------------------------------------------
// REGISTRIES AND EXTERNAL LINKS
// -----------------------------------------------------------------------------

export const NCBI_GENE_BASE_URL = "https://www.ncbi.nlm.nih.gov/gene/";
export const PUBMED_BASE_URL = "https://pubmed.ncbi.nlm.nih.gov/";

// -----------------------------------------------------------------------------
// ABBREVIATION EXPANSIONS
// -----------------------------------------------------------------------------

/** Brain cell type abbreviations shown in the "Brain Cell Types" column. */
export const CELL_TYPE_NAMES: Record<string, string> = {
  EC: "Endothelial Cells",
  SMC: "Smooth Muscle Cells",
  VSMC: "Vascular Smooth Muscle Cells",
  AC: "Astrocytes",
  MG: "Microglia",
  OL: "Oligodendrocytes",
  PC: "Pericytes",
  FB: "Fibroblasts",
};

/** Omics study-type abbreviations. */
export const OMICS_FULL_NAMES: Record<string, string> = {
  PWAS: "Proteome-Wide Association Study",
  EWAS: "Epigenome-Wide Association Study",
  TWAS: "Transcriptome-Wide Association Study",
};
