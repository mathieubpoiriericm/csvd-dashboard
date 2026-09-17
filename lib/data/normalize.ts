/** Defensive normalization shared by the generated-data boundaries. */

import type {
  ApiService,
  CappedList,
  GeneInfo,
  OmimEntry,
  ProteinInfo,
  Reference,
} from "../types.ts";

export function nullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function text(value: unknown, fallback: string): string {
  return nullableText(value) ?? fallback;
}

/** Readable strings from a list that may legitimately be empty. */
export function textArray(value: unknown): string[] {
  return list(value).map(nullableText).filter((entry) => entry !== null);
}

export function textList(value: unknown, fallback: string): string[] {
  const normalized = textArray(Array.isArray(value) ? value : [value]);
  return normalized.length > 0 ? normalized : [fallback];
}

export function textWithout(
  value: unknown,
  fallback: string,
  invalid: RegExp,
): string {
  const normalized = text(value, fallback);
  return invalid.test(normalized) ? fallback : normalized;
}

export function numberInRange(
  value: unknown,
  min: number,
  max: number,
): number | null {
  return typeof value === "number" && Number.isFinite(value) &&
      value >= min && value <= max
    ? value
    : null;
}

export function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Normalize readable rows, omitting records rejected by their boundary. */
export function normalizeRows<T>(
  value: unknown,
  normalize: (row: unknown) => T | null,
): T[] {
  return list(value).map(normalize).filter((row) => row !== null);
}

/** One keyed NCBI lookup row, or null when it has no safe index key. */
export function normalizeGeneInfo(value: unknown): GeneInfo | null {
  const source = record(value);
  const name = nullableText(source.name);
  if (name === null) return null;
  return {
    name,
    uid: nullableText(source.uid),
    description: nullableText(source.description),
    otheraliases: nullableText(source.otheraliases),
  };
}

/** One keyed UniProt lookup row, or null when it has no safe index key. */
export function normalizeProteinInfo(value: unknown): ProteinInfo | null {
  const source = record(value);
  const gene = nullableText(source.gene);
  if (gene === null) return null;
  return {
    gene,
    accession: nullableText(source.accession),
    url: nullableText(source.url),
  };
}

/** One keyed OMIM lookup row, or null when its numeric identity is unusable. */
export function normalizeOmimEntry(value: unknown): OmimEntry | null {
  const source = record(value);
  const omimNum = nonnegativeInteger(source.omimNum);
  if (omimNum === null || omimNum === 0) return null;
  return {
    omimNum,
    omimLink: text(source.omimLink, ""),
    phenotype: text(source.phenotype, ""),
    inheritance: text(source.inheritance, ""),
    geneOrLocus: text(source.geneOrLocus, ""),
    geneOrLocusMimNumber: text(source.geneOrLocusMimNumber, ""),
  };
}

/** One keyed PubMed lookup row, or null when its PMID cannot be linked. */
export function normalizeReference(value: unknown): Reference | null {
  const source = record(value);
  const pmid = nullableText(source.pmid);
  if (pmid === null || !/^\d+$/.test(pmid)) return null;
  return {
    pmid,
    authors: nullableText(source.authors),
    title: nullableText(source.title),
    journal: nullableText(source.journal),
    publicationDate: nullableText(source.publicationDate),
    doi: nullableText(source.doi),
    formattedRef: text(
      source.formattedRef,
      `PMID: ${pmid} (citation not available)`,
    ),
  };
}

/**
 * A capped list, kept honest about its own truncation.
 *
 * `shown` is recomputed from the items actually present rather than
 * trusted: a file whose `shown` disagrees with its `items` would make the
 * UI print "showing 200 of 1,412" over 12 rows.
 */
export function capped<T>(
  value: unknown,
  item: (raw: unknown) => T,
): CappedList<T> {
  const source = record(value);
  const items = list(source.items).map(item);
  return {
    shown: items.length,
    total: Math.max(
      nonnegativeInteger(source.total) ?? items.length,
      items.length,
    ),
    items,
  };
}

/**
 * One row of the External services panel.
 *
 * Shared by the run report and the reference-data refreshes rather than
 * written twice: both publish `ApiServiceRecord` verbatim, and a second
 * copy would be a second answer to what an API row is.
 *
 * The label falls back to the service key because the pipeline records an
 * unregistered host under its own hostname -- an open-access PDF host arrives
 * from Unpaywall's payload, so no registry could name it in advance. A legacy
 * endpoint-only row can still name itself by that endpoint; a row with none of
 * the three identities is omitted rather than rendered as a blank list item.
 */
export function normalizeApi(value: unknown): ApiService | null {
  const source = record(value);
  const service = nullableText(source.service);
  const endpoint = nullableText(source.endpoint);
  const label = nullableText(source.label) ?? service ?? endpoint;
  if (label === null) return null;

  return {
    // The renderer also uses service in its row key. A legacy label-only or
    // endpoint-only record therefore borrows that usable identity rather than
    // creating a second kind of blank value behind a nonblank heading.
    service: service ?? endpoint ?? label,
    label,
    endpoint: endpoint ?? "",
    method: nullableText(source.method) ?? "GET",
    calls: nonnegativeInteger(source.calls) ?? 0,
    ok: nonnegativeInteger(source.ok) ?? 0,
    notFound: nonnegativeInteger(source.notFound) ?? 0,
    errors: nonnegativeInteger(source.errors) ?? 0,
    retries: nonnegativeInteger(source.retries) ?? 0,
    totalMs: nonnegativeNumber(source.totalMs) ?? 0,
    bytes: nonnegativeInteger(source.bytes) ?? 0,
  };
}

/** Every API row that has enough identity to render a nonblank heading. */
export function normalizeApis(value: unknown): ApiService[] {
  return normalizeRows(value, normalizeApi);
}
