import type { Answers, LogoFile } from "../answers.ts";
import { clean, cleanAll, jsonText } from "./json.ts";

/** The path under static/ the logo is published at, keeping its extension. */
export function logoPath(file: LogoFile, which: "light" | "dark"): string {
  const match = file.name.match(/\.([A-Za-z0-9]+)$/);
  const ext = match ? match[1].toLowerCase() : "svg";
  return `/institute/logo-${which}.${ext}`;
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
    citationStandard: citationStandard === null
      ? null
      : cleanAll(citationStandard),
  });
}
