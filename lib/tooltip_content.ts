/** Shared, data-independent builders for structured tooltip content. */

import { NCBI_GENE_BASE_URL } from "./constants.ts";
import type { GeneInfo, OmimEntry, ProteinInfo } from "./types.ts";

export interface TooltipRow {
  label: string;
  value: string;
}

export interface TooltipLink {
  href: string;
  label: string;
}

/**
 * `links` is a list because one curated key can stand for several genes (an
 * alias key is published as one lookup row per member), and each member's
 * record is its own destination.
 */
export interface TooltipContent {
  rows: TooltipRow[];
  links?: TooltipLink[];
}

const NOT_AVAILABLE = "Not available";

export function optionalText(
  value: string | null | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

const orNotAvailable = (value: string | null | undefined) =>
  optionalText(value) ?? NOT_AVAILABLE;

export function safeHttpsUrl(
  value: string | null | undefined,
): string | undefined {
  const normalized = optionalText(value);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The NCBI Gene link a tooltip offers for a UID, or none when there is no UID.
 * `symbol` names the member gene when the tooltip lists more than one.
 */
export function ncbiGeneLink(
  uid: string | undefined,
  symbol?: string,
): TooltipLink | undefined {
  return uid
    ? {
      href: `${NCBI_GENE_BASE_URL}${encodeURIComponent(uid)}`,
      label: symbol ? `View ${symbol} on NCBI Gene` : "View on NCBI Gene",
    }
    : undefined;
}

/** Present values only, so an absent link is not a list entry. */
function present<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

/**
 * The tooltip for a curated key's lookup rows, built one block per row.
 *
 * A key with one row -- every gene but an alias key -- renders as it always
 * has. A key with several (an alias key, one row per member gene) heads each
 * member's block with a `Gene` row naming it, and names it in its link, so a
 * reader can tell whose record is whose. A row with nothing to show is
 * dropped; with none left there is no tooltip, so the cell renders as plain
 * text rather than opening onto "Not available" lines.
 */
function memberTooltip<T extends { symbol: string }>(
  infos: readonly T[] | undefined,
  { shows, rows, link }: {
    shows: (info: T) => boolean;
    rows: (info: T) => TooltipRow[];
    link: (info: T, symbol: string | undefined) => TooltipLink | undefined;
  },
): TooltipContent | null {
  const several = (infos?.length ?? 0) > 1;
  const shown = (infos ?? []).filter(shows);
  if (!shown.length) return null;
  return {
    rows: shown.flatMap((info) =>
      several
        ? [{ label: "Gene", value: info.symbol }, ...rows(info)]
        : rows(info)
    ),
    links: present(
      shown.map((info) => link(info, several ? info.symbol : undefined)),
    ),
  };
}

export function geneInfoTooltip(
  infos: readonly GeneInfo[] | undefined,
): TooltipContent | null {
  return memberTooltip(infos, {
    shows: (info) =>
      Boolean(
        optionalText(info.uid) || optionalText(info.description) ||
          optionalText(info.otheraliases),
      ),
    rows: (info) => [
      { label: "UID", value: orNotAvailable(info.uid) },
      { label: "Description", value: orNotAvailable(info.description) },
      { label: "Other Aliases", value: orNotAvailable(info.otheraliases) },
    ],
    link: (info, symbol) => ncbiGeneLink(optionalText(info.uid), symbol),
  });
}

export function proteinInfoTooltip(
  infos: readonly ProteinInfo[] | undefined,
): TooltipContent | null {
  return memberTooltip(infos, {
    shows: (info) => Boolean(optionalText(info.accession)),
    rows: (info) => [{
      label: "UniProt Accession Number",
      value: optionalText(info.accession)!,
    }],
    link: (info, symbol) => {
      const href = safeHttpsUrl(info.url);
      if (!href) return undefined;
      return {
        href,
        label: symbol ? `View ${symbol} on UniProt` : "View on UniProt",
      };
    },
  });
}

export function omimEntryTooltip(
  entry: OmimEntry | undefined,
): TooltipContent | null {
  if (!entry) return null;
  const href = safeHttpsUrl(entry.omimLink);

  return {
    rows: [
      { label: "Phenotype", value: orNotAvailable(entry.phenotype) },
      { label: "Inheritance", value: orNotAvailable(entry.inheritance) },
      { label: "Gene or Locus", value: orNotAvailable(entry.geneOrLocus) },
      {
        label: "Gene or Locus MIM Number",
        value: orNotAvailable(entry.geneOrLocusMimNumber),
      },
    ],
    links: href ? [{ href, label: "View on OMIM" }] : [],
  };
}
