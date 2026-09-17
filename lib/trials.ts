import type { TrialLocation } from "./types.ts";

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

/** Human-readable city/state/country string for a trial facility. */
export function formatTrialPlace(
  location: Pick<TrialLocation, "city" | "state" | "country">,
): string {
  return [location.city, location.state, location.country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(", ");
}
