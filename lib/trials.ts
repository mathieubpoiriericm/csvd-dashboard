import { GOLD_ONLY } from "./gold_only.ts";
import { isAbsent } from "./sentinels.ts";
import type { Trial, TrialLocation } from "./types.ts";

function defineRegistry(
  label: string,
  baseUrl: string,
  searchOnly = false,
) {
  return { label, baseUrl, searchOnly };
}

const REGISTRIES = {
  NCT: defineRegistry(
    "ClinicalTrials.gov",
    "https://clinicaltrials.gov/study/",
  ),
  ISRCTN: defineRegistry("ISRCTN", "https://www.isrctn.com/"),
  ACTRN: defineRegistry(
    "ANZCTR",
    "https://www.anzctr.org.au/Trial/Registration/TrialReview.aspx?ACTRN=",
  ),
  // ChiCTR record URLs use an unrelated internal numeric id that cannot be
  // derived from the public registration number.
  ChiCTR: defineRegistry(
    "ChiCTR",
    "https://www.chictr.org.cn/searchprojEN.html",
    true,
  ),
} as const;

type Registry = keyof typeof REGISTRIES;

interface RegistryLink {
  registryLabel: string;
  href: string;
  actionLabel: string;
}

/** Registry prefix from a public registration id, if it is supported. */
export function registryOf(registryId: string): Registry | null {
  const prefix = /^[A-Za-z]+/.exec(registryId.trim())?.[0].toLowerCase();
  if (!prefix) return null;
  return (Object.keys(REGISTRIES) as Registry[]).find((registry) =>
    registry.toLowerCase() === prefix
  ) ?? null;
}

/** Public registry link and labels for a registration id. */
export function registryLink(registryId: string): RegistryLink | null {
  const id = registryId.trim();
  const key = registryOf(id);
  if (!key) return null;

  const registry = REGISTRIES[key];
  return {
    registryLabel: registry.label,
    href: registry.searchOnly
      ? registry.baseUrl
      : `${registry.baseUrl}${encodeURIComponent(id)}`,
    actionLabel: `${
      registry.searchOnly ? "Search" : "View on"
    } ${registry.label}`,
  };
}

export {
  type ResolvedTrialStatus,
  resolveTrialStatus,
} from "./trial_status.ts";

/**
 * A phase as the trials readout labels its bar.
 *
 * The export fills a missing phase with `(unknown)`, which the table prints
 * as the absent dash and the filter offers as "Phase not stated"; under a bar,
 * and in the readout's spoken list, it read as the raw sentinel.
 */
export function phaseBarLabel(phase: string): string {
  return phase.trim() === "" || isAbsent(phase) ? "Not stated" : phase;
}

/** Human-readable city/state/country string for a trial facility. */
export function formatTrialPlace(
  location: Pick<TrialLocation, "city" | "state" | "country">,
): string {
  return [location.city, location.state, location.country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

/**
 * A curated target may name why the gene is a target before naming it:
 * "GWAS for ischemic stroke: PDE3A". The colon has to be followed by
 * whitespace, so a symbol carrying its own colon is left whole.
 * `_TARGET_QUALIFIER` in pipeline/export/text.py is the export's copy; the two
 * have to agree or a tooltip looks up a key the export never wrote.
 */
const TARGET_QUALIFIER = /^[^:]*:\s+/;

/**
 * One piece of a genetic-target cell split into the label in front of the
 * symbol ("GWAS for ischemic stroke: ", or "" when there is none) and the
 * symbol itself, so the cell can print both verbatim and look up the symbol
 * alone.
 */
export function splitTargetQualifier(
  piece: string,
): { qualifier: string; symbol: string } {
  const qualifier = piece.match(TARGET_QUALIFIER)?.[0] ?? "";
  return { qualifier, symbol: piece.slice(qualifier.length) };
}

/**
 * The map's facilities, each with the status the map labels and filters it by.
 *
 * Otherwise that is ClinicalTrials.gov's own per-facility status, which
 * `deno task geocode` writes. Under `GOLD_ONLY` each facility takes its
 * trial's published Table 2 status instead, so the map says what the table
 * and the radar say rather than a per-site status that can disagree with the
 * trial's own. A status the table leaves unstated (the export's "(unknown)"),
 * or a facility whose trial the table does not list, becomes null -- no badge,
 * and filed under Unknown, as the table files its own unstated rows.
 */
export function locationsWithTableStatus(
  locations: readonly TrialLocation[],
  trials: readonly Pick<Trial, "registryId" | "overallStatus">[],
  goldOnly: boolean = GOLD_ONLY,
): TrialLocation[] {
  if (!goldOnly) return [...locations];
  const key = (id: string) => id.trim().toUpperCase();
  const statusByTrial = new Map<string, string>();
  for (const trial of trials) {
    if (!statusByTrial.has(key(trial.registryId))) {
      statusByTrial.set(key(trial.registryId), trial.overallStatus);
    }
  }
  return locations.map((location) => {
    const status = statusByTrial.get(key(location.nctId));
    return {
      ...location,
      status: status === undefined || isAbsent(status) ? null : status,
    };
  });
}
