import omimJson from "../../data/omim_info.json" with { type: "json" };

import { indexBy } from "../collections.ts";
import type { OmimEntry } from "../types.ts";
import { normalizeOmimEntry, normalizeRows } from "./normalize.ts";

export function normalizeOmimEntries(value: unknown): OmimEntry[] {
  return normalizeRows(value, normalizeOmimEntry);
}

export function indexOmimByNumber(
  value: unknown,
): ReadonlyMap<string, OmimEntry> {
  return indexBy(normalizeOmimEntries(value), (row) => String(row.omimNum));
}

export const omimByNumber = indexOmimByNumber(omimJson);
