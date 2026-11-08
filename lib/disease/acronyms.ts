/**
 * The acronym glossary the trait and omics cells' tooltips read: the generic
 * terms in `lib/constants.ts`, overridden by the disease's own in
 * `disease/manifest.json`.
 *
 * A disease entry may leave its name out when `disease/vocabulary.json`
 * already names the trait, so a trait's full name is written once. An entry
 * nothing names is a build error, as every other manifest mistake is.
 */

import vocabulary from "../../disease/vocabulary.json" with { type: "json" };

import { GENERIC_ACRONYMS } from "../constants.ts";
import type { Acronym, DiseaseManifest } from "../types.ts";
import { manifest } from "./manifest.ts";

export function resolveAcronyms(
  generic: Readonly<Record<string, Acronym>>,
  disease: DiseaseManifest["acronyms"],
  traitNames: ReadonlyMap<string, string>,
): ReadonlyMap<string, Acronym> {
  const out = new Map<string, Acronym>(Object.entries(generic));
  for (const [key, { name, kind }] of Object.entries(disease)) {
    const resolved = name ?? traitNames.get(key) ?? generic[key]?.name;
    if (resolved === undefined) {
      throw new Error(
        `disease/manifest.json: acronyms.${key} has no name, and no vocabulary trait names it`,
      );
    }
    out.set(key, { name: resolved, kind });
  }
  return out;
}

/** A trait's full name, where the vocabulary gives one beyond the key itself. */
const TRAIT_NAMES: ReadonlyMap<string, string> = new Map(
  vocabulary.traits
    .filter((trait) => trait.name !== trait.key)
    .map((trait) => [trait.key, trait.name]),
);

export const ACRONYMS: ReadonlyMap<string, Acronym> = resolveAcronyms(
  GENERIC_ACRONYMS,
  manifest.acronyms,
  TRAIT_NAMES,
);
