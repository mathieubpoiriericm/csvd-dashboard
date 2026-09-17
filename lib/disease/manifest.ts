/**
 * The disease manifest at the web boundary.
 *
 * Mirrors `lib/data/normalize.ts`: strings are trimmed and an optional
 * string that is empty becomes null. The one difference is failure: a
 * required key that is missing or a `schemaVersion` this code does not
 * know throws at module load. A manifest is authored, not fetched, so a
 * wrong one is a build error rather than a data gap to paper over.
 */

import manifestJson from "../../disease/manifest.json" with { type: "json" };

import type {
  AboutCitation,
  AdditionalSource,
  CitationStandard,
  DiseaseManifest,
  Population,
} from "../types.ts";
import { list, nullableText, record } from "../data/normalize.ts";

function required(
  source: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const value = nullableText(source[key]);
  if (value === null) throw new Error(`disease/manifest.json: missing ${path}`);
  return value;
}

function optional(source: Record<string, unknown>, key: string): string | null {
  return nullableText(source[key]);
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    const text = nullableText(entry);
    if (text !== null) out[key.trim()] = text;
  }
  return out;
}

function population(value: unknown, index: number): Population {
  const source = record(value);
  return {
    key: required(source, "key", `populations[${index}].key`),
    label: required(source, "label", `populations[${index}].label`),
  };
}

function citationStandard(value: unknown): CitationStandard | null {
  if (value === null || value === undefined) return null;
  const source = record(value);
  return {
    name: required(source, "name", "citationStandard.name"),
    label: required(source, "label", "citationStandard.label"),
    doi: required(source, "doi", "citationStandard.doi"),
    linkLabel: required(source, "linkLabel", "citationStandard.linkLabel"),
  };
}

function aboutCitation(value: unknown): AboutCitation | null {
  if (value === null || value === undefined) return null;
  const source = record(value);
  const year = source.year;
  if (typeof year !== "number" || !Number.isInteger(year)) {
    throw new Error(
      "disease/manifest.json: about.citation.year must be an integer",
    );
  }
  return {
    authors: required(source, "authors", "about.citation.authors"),
    title: required(source, "title", "about.citation.title"),
    journal: required(source, "journal", "about.citation.journal"),
    year,
    doi: required(source, "doi", "about.citation.doi"),
  };
}

function additionalSource(value: unknown, index: number): AdditionalSource {
  const source = record(value);
  const licence = record(source.licence);
  const at = `about.additionalSources[${index}]`;
  return {
    name: required(source, "name", `${at}.name`),
    href: required(source, "href", `${at}.href`),
    licence: {
      label: required(licence, "label", `${at}.licence.label`),
      href: optional(licence, "href"),
    },
    provides: required(source, "provides", `${at}.provides`),
  };
}

export function normalizeManifest(raw: unknown): DiseaseManifest {
  const source = record(raw);
  if (source.schemaVersion !== 1) {
    throw new Error(
      `disease/manifest.json: schemaVersion must be 1, got ${
        JSON.stringify(source.schemaVersion)
      }`,
    );
  }
  const disease = record(source.disease);
  const site = record(source.site);
  const pages = record(site.pages);
  const institute = record(source.institute);
  const logo = record(institute.logo);
  const maintainer = record(record(source.contact).maintainer);
  const about = record(source.about);
  const hosting = record(source.hosting);
  const populationField = record(source.populationField);
  const cellTypes = record(source.cellTypes);
  const populations = list(source.populations).map(population);
  if (populations.length === 0) {
    throw new Error("disease/manifest.json: populations must not be empty");
  }

  return {
    schemaVersion: 1,
    disease: {
      key: required(disease, "key", "disease.key"),
      name: required(disease, "name", "disease.name"),
      short: required(disease, "short", "disease.short"),
      abbreviation: required(disease, "abbreviation", "disease.abbreviation"),
      adjective: required(disease, "adjective", "disease.adjective"),
    },
    site: {
      title: required(site, "title", "site.title"),
      heading: required(site, "heading", "site.heading"),
      metaDescription: required(
        site,
        "metaDescription",
        "site.metaDescription",
      ),
      aboutTitle: required(site, "aboutTitle", "site.aboutTitle"),
      aboutLede: required(site, "aboutLede", "site.aboutLede"),
      loginLede: required(site, "loginLede", "site.loginLede"),
      pages: {
        genes: required(pages, "genes", "site.pages.genes"),
        trials: required(pages, "trials", "site.pages.trials"),
        timeline: required(pages, "timeline", "site.pages.timeline"),
        map: required(pages, "map", "site.pages.map"),
      },
    },
    institute: {
      name: required(institute, "name", "institute.name"),
      short: required(institute, "short", "institute.short"),
      url: optional(institute, "url"),
      copyright: required(institute, "copyright", "institute.copyright"),
      logo: {
        src: required(logo, "src", "institute.logo.src"),
        srcOnDark: optional(logo, "srcOnDark"),
        alt: required(logo, "alt", "institute.logo.alt"),
      },
    },
    contact: {
      maintainer: {
        name: required(maintainer, "name", "contact.maintainer.name"),
        email: required(maintainer, "email", "contact.maintainer.email"),
      },
    },
    about: {
      citation: aboutCitation(about.citation),
      board: optional(about, "board"),
      contactUs: optional(about, "contactUs"),
      acknowledgements: optional(about, "acknowledgements"),
      additionalSources: list(about.additionalSources).map(additionalSource),
    },
    hosting: { url: optional(hosting, "url") },
    populations,
    populationField: {
      label: required(populationField, "label", "populationField.label"),
      detailsLabel: required(
        populationField,
        "detailsLabel",
        "populationField.detailsLabel",
      ),
    },
    cellTypes: {
      label: required(cellTypes, "label", "cellTypes.label"),
      glossary: stringMap(cellTypes.glossary),
    },
    citationStandard: citationStandard(source.citationStandard),
  };
}

export const manifest: DiseaseManifest = normalizeManifest(manifestJson);
