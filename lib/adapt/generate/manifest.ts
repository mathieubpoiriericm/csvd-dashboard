import { uncoveredAcronyms } from "../../acronyms.ts";
import { GENERIC_ACRONYMS } from "../../constants.ts";
import type { Acronym } from "../../types.ts";
import type { Answers, LogoFile } from "../answers.ts";
import { clean, cleanAll, jsonText } from "./json.ts";
import { grouped } from "./vocabulary.ts";

/** The path under static/ the logo is published at, keeping its extension. */
export function logoPath(file: LogoFile, which: "light" | "dark"): string {
  const match = file.name.match(/\.([A-Za-z0-9]+)$/);
  const ext = match ? match[1].toLowerCase() : "svg";
  return `/institute/logo-${which}.${ext}`;
}

/** The glossary a fork has before its manifest adds to it. */
const GENERIC: ReadonlyMap<string, Acronym> = new Map(
  Object.entries(GENERIC_ACRONYMS),
);

/**
 * The glossary entries the trait keys need, in vocabulary.json's order.
 *
 * A gene's traits are closed-vocabulary values, so
 * `tests/acronym_coverage_test.ts` fails the fork on the first exported gene
 * whose trait holds an acronym the glossary cannot explain -- and a trait
 * key (`T1`, `AB-X9`) nearly always is one. The gate's own rule picks the
 * keys, so the two cannot disagree. The entry is the whole key, which
 * explains a longer key as the trait it is, and carries the name outright:
 * `lib/disease/acronyms.ts` finds none in the vocabulary for a trait named
 * by its key. The kind is the family's label, the one thing the answers say
 * about what sort of trait it is; a draft whose family is not listed yet
 * shows the key typed for it.
 */
function traitAcronyms(
  answers: Answers,
): Record<string, Acronym> {
  const { families } = answers.vocabulary;
  // Built from entries, so no key can set the object's prototype.
  return Object.fromEntries(
    grouped(answers)
      .filter((t) => uncoveredAcronyms(clean(t.key), GENERIC).length > 0)
      .map((t) => {
        const family = families.find((f) => clean(f.key) === clean(t.family));
        return [clean(t.key), {
          name: clean(t.name),
          kind: clean(family?.label ?? t.family),
        }];
      }),
  );
}

export function generateManifest(answers: Answers): string {
  const {
    disease,
    site,
    institute,
    logoLight,
    logoDark,
    maintainer,
    cellTypes,
  } = answers.identity;
  // Built from entries, so no abbreviation can set the object's prototype.
  const glossary = Object.fromEntries(
    cellTypes.glossary.map((row) => [clean(row.abbrev), clean(row.name)]),
  );
  const url = clean(institute.url);
  const { populationField } = answers.trials;
  const { citationStandard } = answers.vocabulary;
  return jsonText({
    schemaVersion: 1,
    disease: cleanAll(disease),
    site: { ...cleanAll(site), pages: cleanAll(site.pages) },
    institute: {
      name: clean(institute.name),
      short: clean(institute.short),
      url: url === "" ? null : url,
      copyright: clean(institute.copyright),
      logo: {
        src: logoLight === null
          ? "/institute/logo-light.svg"
          : logoPath(logoLight, "light"),
        srcOnDark: logoDark === null ? null : logoPath(logoDark, "dark"),
        alt: clean(institute.logoAlt),
      },
    },
    contact: { maintainer: cleanAll(maintainer) },
    about: {
      citation: null,
      board: null,
      contactUs: null,
      acknowledgements: null,
      additionalSources: [],
    },
    hosting: { url: null },
    populations: answers.trials.populations.map((p) => ({
      key: clean(p.key),
      label: clean(p.label),
    })),
    populationField: cleanAll(populationField),
    cellTypes: { label: clean(cellTypes.label), glossary },
    acronyms: traitAcronyms(answers),
    citationStandard: citationStandard === null
      ? null
      : cleanAll(citationStandard),
  });
}
