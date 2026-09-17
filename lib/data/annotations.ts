import annotationJson from "../../data/gene_annotations.json" with {
  type: "json",
};

import type { GeneAnnotation, RelatedXref } from "../types.ts";
import {
  list,
  nonnegativeInteger,
  nullableText,
  record,
  text,
  textArray,
} from "./normalize.ts";

/**
 * Cross-references to a *different* concept, each carrying the relation its
 * source reported.
 *
 * A missing relation stays missing. The export never invents one — an absent
 * `DisorderMappingRelation`, Orphanet's "ND" (not yet decided) and "W" (wrong
 * mapping) are not evidence that a code is broader or narrower.
 */
/**
 * The per-source version map, normalized at the public boundary as every
 * other field here is.
 *
 * A key whose value is absent or unreadable becomes `null` rather than being
 * dropped: the key's presence records that the source contributed to this
 * row, which is a separate fact from whether it names a version.
 */
function sourceVersions(value: unknown): Record<string, string | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string | null> = {};
  for (const [source, version] of Object.entries(value)) {
    if (source.trim() === "") continue;
    out[source.trim()] = nullableText(version);
  }
  return out;
}

function relatedXrefs(value: unknown): RelatedXref[] {
  if (!Array.isArray(value)) return [];
  const out: RelatedXref[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const xref = entry as Partial<RelatedXref>;
    const id = nullableText(xref.id);
    if (id === null) continue;
    out.push({ id, relation: nullableText(xref.relation) });
  }
  return out;
}

export function normalizeAnnotation(
  row: unknown,
): GeneAnnotation {
  const source = record(row);
  return {
    geneSymbol: text(source.geneSymbol, "(unknown)"),
    groupKey: text(source.groupKey, "(unknown)"),
    diseaseName: text(source.diseaseName, "(unknown)"),
    omimId: nullableText(source.omimId),
    mondoId: nullableText(source.mondoId),
    orphacode: nullableText(source.orphacode),
    medgenId: nullableText(source.medgenId),
    omimSeries: textArray(source.omimSeries),
    classification: nullableText(source.classification),
    recordCount: nonnegativeInteger(source.recordCount),
    relatedXrefs: relatedXrefs(source.relatedXrefs),
    sourceVersions: sourceVersions(source.sourceVersions),
  };
}

export function normalizeAnnotations(value: unknown): GeneAnnotation[] {
  return list(value).map(normalizeAnnotation);
}

export const geneAnnotations = normalizeAnnotations(annotationJson);
