/** Shared, data-independent builders for structured tooltip content. */

import { NCBI_GENE_BASE_URL } from "./constants.ts";
import type { GeneInfo, OmimEntry, ProteinInfo } from "./types.ts";

export interface TooltipRow {
  label: string;
  value: string;
}

export interface TooltipContent {
  rows: TooltipRow[];
  link?: { href: string; label: string };
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

/** The NCBI Gene link a tooltip offers for a UID, or none when there is no UID. */
export function ncbiGeneLink(
  uid: string | undefined,
): TooltipContent["link"] {
  return uid
    ? {
      href: `${NCBI_GENE_BASE_URL}${encodeURIComponent(uid)}`,
      label: "View on NCBI Gene",
    }
    : undefined;
}

export function geneInfoTooltip(
  info: GeneInfo | undefined,
): TooltipContent | null {
  if (!info) return null;
  const uid = optionalText(info.uid);
  if (
    !uid && !optionalText(info.description) && !optionalText(info.otheraliases)
  ) return null;

  return {
    rows: [
      { label: "UID", value: orNotAvailable(info.uid) },
      { label: "Description", value: orNotAvailable(info.description) },
      { label: "Other Aliases", value: orNotAvailable(info.otheraliases) },
    ],
    link: ncbiGeneLink(uid),
  };
}

export function proteinInfoTooltip(
  info: ProteinInfo | undefined,
): TooltipContent | null {
  const accession = optionalText(info?.accession);
  if (!info || !accession) return null;
  const href = safeHttpsUrl(info.url);

  return {
    rows: [{ label: "UniProt Accession Number", value: accession }],
    link: href ? { href, label: "View on UniProt" } : undefined,
  };
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
    link: href ? { href, label: "View on OMIM" } : undefined,
  };
}
