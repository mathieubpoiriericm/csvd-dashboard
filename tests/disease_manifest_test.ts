import { assert, assertEquals, assertThrows } from "@std/assert";

import manifestJson from "../disease/manifest.json" with { type: "json" };
import diseaseTimeline from "../disease/timeline.json" with { type: "json" };
import {
  CELL_TYPE_NAMES,
  CELL_TYPES_LABEL,
  citationLink,
  definitionLabel,
  manifest,
  normalizeManifest,
  RADAR_TITLE,
  SITE_TITLE,
} from "../lib/disease.ts";
import {
  POPULATION_CHOICES,
  SHOW_ALL,
  SITE_TITLE as CONSTANTS_SITE_TITLE,
} from "../lib/constants.ts";
import { genes } from "../lib/data/genes.ts";
import { splitCellTypes } from "../lib/tooltips.ts";
import { ABSENT_SENTINELS } from "../lib/sentinels.ts";

Deno.test("the manifest normalizes to the committed values", () => {
  assertEquals(manifest.schemaVersion, 1);
  assertEquals(manifest.disease.key, "csvd");
  assertEquals(manifest.site.title, "ICM Cerebral SVD Dashboard");
  assertEquals(manifest.populations.map((p) => p.key), [
    "CAA",
    "Cognitive Impairment",
    "Stroke",
    "SVD",
  ]);
  assertEquals(manifest.populationField.label, "SVD Population");
  assertEquals(manifest.cellTypes.glossary.EC, "Endothelial Cells");
  assertEquals(manifest.citationStandard?.name, "STRIVE-2");
  assertEquals(manifest.about.citation, null);
  assertEquals(manifest.about.additionalSources, []);
  assertEquals(manifest.institute.logo.srcOnDark, "/institute/logo-dark.svg");
});

Deno.test("strings are trimmed and empty optional strings become null", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  (raw.site as Record<string, unknown>).title = "  Padded  ";
  (raw.institute as Record<string, unknown>).url = "   ";
  (raw.hosting as Record<string, unknown>).url = "";
  const normalized = normalizeManifest(raw);
  assertEquals(normalized.site.title, "Padded");
  assertEquals(normalized.institute.url, null);
  assertEquals(normalized.hosting.url, null);
});

Deno.test("a wrong schemaVersion throws at load, never falls back", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  raw.schemaVersion = 2;
  assertThrows(() => normalizeManifest(raw), Error, "schemaVersion");
});

Deno.test("a missing required string throws and names the key", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  delete (raw.site as Record<string, unknown>).heading;
  assertThrows(() => normalizeManifest(raw), Error, "site.heading");
});

Deno.test("every population key is unique and non-empty", () => {
  const keys = manifest.populations.map((p) => p.key);
  assertEquals(new Set(keys).size, keys.length);
  assert(keys.every((k) => k.length > 0));
});

Deno.test("the radar's populations are the manifest's, in order", () => {
  assertEquals(
    diseaseTimeline.populations.map((p) => p.key),
    manifest.populations.map((p) => p.key),
  );
});

Deno.test("POPULATION_CHOICES is Show All followed by the manifest's populations", () => {
  assertEquals(POPULATION_CHOICES.map((c) => c.value), [
    SHOW_ALL,
    ...manifest.populations.map((p) => p.key),
  ]);
  assertEquals(POPULATION_CHOICES.map((c) => c.label), [
    "Show All",
    ...manifest.populations.map((p) => p.label),
  ]);
});

Deno.test("the cell-type glossary is the manifest's and covers the committed rows", () => {
  assertEquals(CELL_TYPE_NAMES, manifest.cellTypes.glossary);
  assertEquals(CELL_TYPES_LABEL, "Brain Cell Types");
  const used = new Set(
    genes.flatMap((g) => splitCellTypes(g.brainCellTypes).parts),
  );
  // `brainCellTypes` is a curated free-text column, so `splitCellTypes`
  // returns qualifiers as well as abbreviations -- "all<40", "EC (arterial)"
  // and similar prose the glossary was never meant to define. The filter
  // keeps only what looks like an abbreviation: an uppercase-alphabetic
  // token, which every glossary key is (EC, SMC, VSMC, AC, MG, OL, PC, FB)
  // and no free-text cell is, because each of those carries a digit, a
  // lowercase letter or a symbol. So this asserts that every abbreviation
  // the rows use is defined, and says nothing about the prose beside them.
  const missing = [...used].filter(
    (abbr) =>
      !ABSENT_SENTINELS.has(abbr) &&
      /^[A-Z]+$/.test(abbr) &&
      !(abbr in CELL_TYPE_NAMES),
  );
  assertEquals(missing, []);
});

Deno.test("site strings derive from the manifest", () => {
  assertEquals(SITE_TITLE, manifest.site.title);
  assertEquals(CONSTANTS_SITE_TITLE, SITE_TITLE);
  assertEquals(
    RADAR_TITLE,
    "Cerebral SVD clinical trials by population and phase",
  );
});

Deno.test("about.citation normalizes a full citation object", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  (raw.about as Record<string, unknown>).citation = {
    authors: "Duering, M. et al.",
    title: "Neuroimaging standards for research into small vessel disease",
    journal: "The Lancet Neurology",
    year: 2023,
    doi: "10.1016/S1474-4422(23)00131-X",
  };
  const normalized = normalizeManifest(raw);
  assertEquals(normalized.about.citation, {
    authors: "Duering, M. et al.",
    title: "Neuroimaging standards for research into small vessel disease",
    journal: "The Lancet Neurology",
    year: 2023,
    doi: "10.1016/S1474-4422(23)00131-X",
  });
});

Deno.test("about.citation.year must be an integer", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  (raw.about as Record<string, unknown>).citation = {
    authors: "Duering, M. et al.",
    title: "Neuroimaging standards",
    journal: "The Lancet Neurology",
    year: 2023.5,
    doi: "10.1016/S1474-4422(23)00131-X",
  };
  assertThrows(
    () => normalizeManifest(raw),
    Error,
    "about.citation.year must be an integer",
  );
});

Deno.test("about.additionalSources normalizes entries with and without a licence href", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  (raw.about as Record<string, unknown>).additionalSources = [
    {
      name: "ClinVar",
      href: "https://www.ncbi.nlm.nih.gov/clinvar/",
      licence: {
        label: "Public Domain",
        href: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
      },
      provides: "Curated variant-disease relationships",
    },
    {
      name: "Orphadata",
      href: "https://www.orphadata.com/",
      licence: { label: "CC-BY 4.0" },
      provides: "Rare disease nomenclature",
    },
  ];
  const normalized = normalizeManifest(raw);
  assertEquals(normalized.about.additionalSources, [
    {
      name: "ClinVar",
      href: "https://www.ncbi.nlm.nih.gov/clinvar/",
      licence: {
        label: "Public Domain",
        href: "https://www.ncbi.nlm.nih.gov/home/about/policies/",
      },
      provides: "Curated variant-disease relationships",
    },
    {
      name: "Orphadata",
      href: "https://www.orphadata.com/",
      licence: { label: "CC-BY 4.0", href: null },
      provides: "Rare disease nomenclature",
    },
  ]);
});

Deno.test("an empty populations list throws", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  raw.populations = [];
  assertThrows(
    () => normalizeManifest(raw),
    Error,
    "populations must not be empty",
  );
});

Deno.test("citationStandard normalizes to null when absent", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  raw.citationStandard = null;
  const normalized = normalizeManifest(raw);
  assertEquals(normalized.citationStandard, null);
});

Deno.test("institute.logo.srcOnDark normalizes to null when absent", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  delete (raw.institute as Record<string, unknown> & {
    logo: Record<string, unknown>;
  }).logo.srcOnDark;
  const normalized = normalizeManifest(raw);
  assertEquals(normalized.institute.logo.srcOnDark, null);
});

Deno.test("citationLink returns undefined for a null standard", () => {
  assertEquals(citationLink(null), undefined);
});

Deno.test("citationLink builds the DOI link for a given standard", () => {
  assertEquals(citationLink(manifest.citationStandard), {
    href: "https://doi.org/10.1016/S1474-4422(23)00131-X",
    label: "View STRIVE-2 (Lancet Neurol 2023)",
  });
});

Deno.test('definitionLabel falls back to "Definition" for a null standard', () => {
  assertEquals(definitionLabel(null), "Definition");
});

Deno.test("definitionLabel names the standard when one is given", () => {
  assertEquals(
    definitionLabel(manifest.citationStandard),
    "STRIVE-2 definition",
  );
});

/**
 * A structural check of each disease document against its committed JSON
 * Schema.
 *
 * No validator is in the import map and neither document is worth adding
 * one for, so this walks the schema beside the value and reports only the
 * keywords these two schemas actually use. It is a test helper, not a
 * library: a keyword it does not handle is silently satisfied, which is
 * fine here and would not be in a validator.
 */
type Schema = Record<string, unknown>;

function schemaErrors(
  node: Schema,
  value: unknown,
  root: Schema,
  path: string,
): string[] {
  const ref = node.$ref as string | undefined;
  if (ref) {
    const defs = root.$defs as Record<string, Schema>;
    return schemaErrors(defs[ref.replace("#/$defs/", "")], value, root, path);
  }
  if (Array.isArray(node.oneOf)) {
    const branches = (node.oneOf as Schema[]).map((branch) =>
      schemaErrors(branch, value, root, path)
    );
    return branches.some((errors) => errors.length === 0)
      ? []
      : [`${path}: matches no oneOf branch`];
  }
  const errors: string[] = [];
  const types = node.type === undefined
    ? []
    : Array.isArray(node.type)
    ? node.type as string[]
    : [node.type as string];
  const actual = value === null
    ? "null"
    : Array.isArray(value)
    ? "array"
    : Number.isInteger(value)
    ? "integer"
    : typeof value;
  if (types.length > 0 && !types.includes(actual)) {
    return [`${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if ("const" in node && value !== node.const) {
    errors.push(`${path}: must be ${JSON.stringify(node.const)}`);
  }
  if (typeof value === "string") {
    const pattern = node.pattern as string | undefined;
    if (pattern && !new RegExp(pattern).test(value)) {
      errors.push(`${path}: does not match ${pattern}`);
    }
    const minLength = node.minLength as number | undefined;
    if (minLength !== undefined && value.length < minLength) {
      errors.push(`${path}: shorter than ${minLength}`);
    }
  }
  if (Array.isArray(value)) {
    const minItems = node.minItems as number | undefined;
    if (minItems !== undefined && value.length < minItems) {
      errors.push(`${path}: fewer than ${minItems} items`);
    }
    const items = node.items as Schema | undefined;
    if (items) {
      value.forEach((entry, index) =>
        errors.push(...schemaErrors(items, entry, root, `${path}[${index}]`))
      );
    }
  }
  if (actual === "object") {
    const record = value as Record<string, unknown>;
    const properties = (node.properties ?? {}) as Record<string, Schema>;
    const extra = node.additionalProperties;
    for (const key of (node.required ?? []) as string[]) {
      if (!(key in record)) errors.push(`${path}.${key}: required, missing`);
    }
    for (const [key, entry] of Object.entries(record)) {
      const child = properties[key] ??
        (typeof extra === "object" ? extra as Schema : null);
      if (child) {
        errors.push(...schemaErrors(child, entry, root, `${path}.${key}`));
      } else if (extra === false) {
        errors.push(`${path}.${key}: not allowed`);
      }
    }
  }
  return errors;
}

/**
 * `disease/pipeline.json` is read rather than imported: an `import … with
 * { type: "json" }` inlines a file into whatever pulls it in, and the
 * pipeline document is the half of the seam that holds gene symbols.
 */
async function readDiseaseJson(name: string): Promise<Schema> {
  return JSON.parse(
    await Deno.readTextFile(new URL(`../disease/${name}`, import.meta.url)),
  );
}

const SCHEMA_PAIRS: readonly (readonly [string, string])[] = [
  ["manifest.json", "manifest.schema.json"],
  ["pipeline.json", "pipeline.schema.json"],
];

Deno.test("both disease documents validate against their schemas", async () => {
  for (const [document, schema] of SCHEMA_PAIRS) {
    const root = await readDiseaseJson(schema);
    assertEquals(
      schemaErrors(root, await readDiseaseJson(document), root, document),
      [],
    );
  }
});

Deno.test("an unknown key at the root of either document is reported", async () => {
  for (const [document, schema] of SCHEMA_PAIRS) {
    const root = await readDiseaseJson(schema);
    const value = { ...await readDiseaseJson(document), strayKey: "x" };
    assertEquals(schemaErrors(root, value, root, document), [
      `${document}.strayKey: not allowed`,
    ]);
  }
});
