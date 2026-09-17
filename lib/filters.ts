/**
 * Filtering for the two data tables.
 *
 * The Shiny app kept five `fastmap` inverted indices so it could intersect
 * row-id vectors without copying a data.table. Over 63 gene rows and 16 trial
 * rows a straight `Array.filter` is equivalent and far less machinery, so the
 * indices are gone.
 *
 * Matching normalizes case and surrounding whitespace on both sides. That is a
 * deliberate change from the R behaviour, which compared raw strings and so
 * silently dropped three cases:
 *   * the "Proteomics" choice never matched, because the data says
 *     "proteomics";
 *   * traits stored with a trailing space ("PSMD ", "WMH ") were missed by
 *     their own filter;
 *   * both bugs failed closed, hiding rows rather than showing extra ones.
 * The runtime data boundary also trims display strings; these helpers remain
 * defensive so synthetic callers and older data behave the same way.
 */

import {
  DEFAULT_TRIAL_STATUSES,
  SHOW_ALL,
  YES_NO_CHOICES,
} from "./constants.ts";
import { isAbsent } from "./sentinels.ts";
import { STATUS_NOT_STATED } from "./trial_status.ts";
import type { FilterChoice, Gene, Trial, TrialLocation } from "./types.ts";
import { registryOf } from "./trials.ts";

export type FilterMode = "showAll" | "binary";

/**
 * Case- and whitespace-insensitive comparison key.
 *
 * Exported so the readouts and the phenogram's evidence glyphs compare the
 * same way the filters do. A raw `=== "Yes"` beside a normalized filter is how
 * a row stays visible in the table while quietly losing its glyph or its tally.
 */
export function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The omics column packs a study type and a tissue into one string
 * ("TWAS;whole blood"). Filters match on the type before the first semicolon.
 */
export function omicsType(value: string): string {
  return value.split(";")[0].trim();
}

/** The wire form `Type;detail` as the cell shows it: `Type (detail)`. */
export function formatOmicsValue(value: string): string {
  const semicolon = value.indexOf(";");
  if (semicolon === -1) return value.trim();
  const detail = value.slice(semicolon + 1).trim();
  const type = value.slice(0, semicolon).trim();
  return detail ? `${type} (${detail})` : type;
}

/** Whether a selection constrains its rows under the UI's selection rules. */
export function isFilterActive(
  selected: readonly string[],
  mode: FilterMode = "showAll",
): boolean {
  return mode === "binary"
    ? selected.length === 1
    : selected.length > 0 && !selected.includes(SHOW_ALL);
}

type NormalizedSelection = ReadonlySet<string>;

/** Normalized choices when a filter constrains rows, otherwise null. */
function activeSelection(
  selected: readonly string[],
  mode: FilterMode = "showAll",
): NormalizedSelection | null {
  return isFilterActive(selected, mode)
    ? new Set(selected.map(normalize))
    : null;
}

function matches(value: string, selected: NormalizedSelection): boolean {
  return selected.has(normalize(value));
}

/** True when any of `values` matches a normalized selection. */
function matchesAny(
  values: readonly string[],
  selected: NormalizedSelection,
): boolean {
  return values.some((value) => matches(value, selected));
}

// -----------------------------------------------------------------------------
// GENES
// -----------------------------------------------------------------------------

interface GeneFilters {
  /** Mendelian randomization: only constrains when exactly one is selected. */
  mendelianRandomization: readonly string[];
  gwasTraits: readonly string[];
  omics: readonly string[];
}

export function filterGenes(
  genes: readonly Gene[],
  filters: GeneFilters,
): Gene[] {
  const { mendelianRandomization: mr, gwasTraits, omics } = filters;

  // Selecting both Yes and No is the same as no filter, matching the R rule
  // that only a length-1 selection constrains.
  const wantedMr = activeSelection(mr, "binary");
  const wantedGwas = activeSelection(gwasTraits);
  const wantedOmics = activeSelection(omics);

  return genes.filter((gene) => {
    if (wantedMr && !matches(gene.mendelianRandomization, wantedMr)) {
      return false;
    }
    if (wantedGwas && !matchesAny(gene.gwasTrait, wantedGwas)) {
      return false;
    }
    if (
      wantedOmics &&
      !matchesAny(
        gene.evidenceFromOtherOmicsStudies.map(omicsType),
        wantedOmics,
      )
    ) {
      return false;
    }
    return true;
  });
}

// -----------------------------------------------------------------------------
// TRIALS
// -----------------------------------------------------------------------------

export interface TrialFilters {
  geneticEvidence: readonly string[];
  registries: readonly string[];
  phases: readonly string[];
  populations: readonly string[];
  sponsors: readonly string[];
  statuses: readonly string[];
}

/**
 * Phase labels in the data are free text ("Phase II", "II/III"). A trial
 * matches a selected phase when that roman numeral appears as a whole token.
 */
function matchesPhase(
  phase: string,
  selected: NormalizedSelection,
): boolean {
  // Word boundaries matter here. Splitting on non-Roman characters treats the
  // "i" in free-text values such as "Clinical Trial Phase II" as Phase I.
  const tokens = phase.match(/\b(?:IX|IV|V?I{1,3}|X)\b/gi) ?? [];
  // A value carrying no numeral at all is still a phase the data states --
  // "(unknown)" is what the export writes when the registry declares none --
  // so it is compared whole. Without this the sentinel matches no choice and
  // the row is hidden by every phase selection rather than selected by one.
  if (tokens.length === 0) return matches(phase, selected);
  return tokens.some((token) => matches(token, selected));
}

/**
 * Sponsor values carry sub-variants ("Industry - Pharma"), so Industry is a
 * prefix match while Academic is exact — mirroring the R comment on
 * SPONSOR_INDUSTRY.
 */
function matchesSponsor(
  sponsorType: string,
  selected: NormalizedSelection,
): boolean {
  const value = normalize(sponsorType);
  // Word boundary, not a literal trailing space: the data says
  // "Industry (Alnylam Pharmaceuticals)" today, but "Industry-Sponsored" or
  // "Industry/Academic" would match neither the exact choice nor a
  // space-prefixed one, and the Industry filter would hide the row instead of
  // selecting it — the fail-closed behaviour this module exists to end.
  // `\b` still rejects a different word that merely starts the same way
  // ("industrywide").
  return selected.has(value) ||
    (selected.has("industry") && /^industry\b/.test(value));
}

/**
 * A row with no ClinicalTrials.gov record publishes "(unknown)", a facility
 * with none carries null; both answer the same choice as CT.gov's UNKNOWN.
 */
function matchesStatus(
  status: string | null,
  selected: NormalizedSelection,
): boolean {
  const value = status === null || isAbsent(status)
    ? STATUS_NOT_STATED
    : status;
  return matches(value, selected);
}

export function filterTrials(
  trials: readonly Trial[],
  filters: TrialFilters,
): Trial[] {
  const {
    geneticEvidence,
    registries,
    phases,
    populations,
    sponsors,
    statuses,
  } = filters;

  const wantedEvidence = activeSelection(geneticEvidence, "binary");
  const wantedRegistries = activeSelection(registries);
  const wantedPhases = activeSelection(phases);
  const wantedPopulations = activeSelection(populations);
  const wantedSponsors = activeSelection(sponsors);
  const wantedStatuses = activeSelection(statuses);

  return trials.filter((trial) => {
    if (wantedEvidence && !matches(trial.geneticEvidence, wantedEvidence)) {
      return false;
    }

    if (wantedRegistries) {
      const registry = registryOf(trial.registryId);
      if (registry === null || !matches(registry, wantedRegistries)) {
        return false;
      }
    }

    if (wantedPhases && !matchesPhase(trial.clinicalTrialPhase, wantedPhases)) {
      return false;
    }

    if (
      wantedPopulations && !matches(trial.svdPopulation, wantedPopulations)
    ) {
      return false;
    }

    if (wantedSponsors && !matchesSponsor(trial.sponsorType, wantedSponsors)) {
      return false;
    }

    if (wantedStatuses && !matchesStatus(trial.overallStatus, wantedStatuses)) {
      return false;
    }

    return true;
  });
}

/** Every group unconstrained except status, which starts without Completed. */
export function defaultTrialFilters(): TrialFilters {
  return {
    geneticEvidence: YES_NO_CHOICES.map((choice) => choice.value),
    registries: [SHOW_ALL],
    phases: [SHOW_ALL],
    populations: [SHOW_ALL],
    sponsors: [SHOW_ALL],
    statuses: [...DEFAULT_TRIAL_STATUSES],
  };
}

/** The rows a page shows before anyone touches a filter. */
export function visibleTrials(rows: readonly Trial[]): Trial[] {
  return filterTrials(rows, defaultTrialFilters());
}

/** The map's facilities under a status selection. */
export function filterLocationsByStatus(
  locations: readonly TrialLocation[],
  statuses: readonly string[],
): TrialLocation[] {
  const wanted = activeSelection(statuses);
  if (!wanted) return [...locations];
  return locations.filter((location) => matchesStatus(location.status, wanted));
}

// -----------------------------------------------------------------------------
// FILTER MESSAGE
// -----------------------------------------------------------------------------

interface FilterSummarySpec {
  label: string;
  value: readonly string[];
  mode?: FilterMode;
  /** When given, each value is printed as its choice's label. */
  choices?: readonly FilterChoice[];
}

/** Builds the "Active Filters: …" fragments shown above each table. */
export function buildFilterSummary(
  specs: readonly FilterSummarySpec[],
): string[] {
  return specs
    .filter((spec) => isFilterActive(spec.value, spec.mode))
    .map((spec) => {
      const named = spec.value.map((value) =>
        spec.choices?.find((choice) => choice.value === value)?.label ??
          value
      );
      return `${spec.label}: ${named.join(", ")}`;
    });
}
