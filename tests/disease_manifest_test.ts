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
import { type Schema, schemaErrors } from "../lib/adapt/schema.ts";
import { splitCellTypes } from "../lib/tooltips.ts";
import { ABSENT_SENTINELS } from "../lib/sentinels.ts";

// The committed values themselves are pinned in tests/csvd/disease_manifest_test.ts.
Deno.test("the manifest normalizes to the committed document", () => {
  assertEquals(manifest.schemaVersion, 1);
  assertEquals(manifest.disease.key, manifestJson.disease.key);
  assertEquals(manifest.site.title, manifestJson.site.title.trim());
  assertEquals(
    manifest.populations.map((p) => p.key),
    manifestJson.populations.map((p) => p.key),
  );
  assertEquals(
    manifest.populationField.label,
    manifestJson.populationField.label,
  );
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
  assertEquals(CELL_TYPES_LABEL, manifest.cellTypes.label);
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
    `${manifest.disease.adjective} clinical trials by population and phase`,
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

Deno.test("citationStandard normalizes a full object", () => {
  const raw = structuredClone(manifestJson) as Record<string, unknown>;
  raw.citationStandard = {
    name: " STANDARD-1 ",
    label: "Author, A. et al. A standard. Journal 1, 1–2 (2020).",
    doi: "10.1000/standard.1",
    linkLabel: "View STANDARD-1",
  };
  const normalized = normalizeManifest(raw);
  assertEquals(normalized.citationStandard, {
    name: "STANDARD-1",
    label: "Author, A. et al. A standard. Journal 1, 1–2 (2020).",
    doi: "10.1000/standard.1",
    linkLabel: "View STANDARD-1",
  });
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
  const standard = {
    name: "STANDARD-1",
    label: "Author, A. et al. A standard. Journal 1, 1–2 (2020).",
    doi: "10.1000/example",
    linkLabel: "View STANDARD-1 (Journal 2020)",
  };
  assertEquals(citationLink(standard), {
    href: "https://doi.org/10.1000/example",
    label: "View STANDARD-1 (Journal 2020)",
  });
  // A DOI written as its own address, or cited with "doi:", links once.
  for (
    const doi of [
      "https://doi.org/10.1000/example",
      "http://dx.doi.org/10.1000/example",
      "doi: 10.1000/example",
    ]
  ) {
    assertEquals(
      citationLink({ ...standard, doi })?.href,
      "https://doi.org/10.1000/example",
    );
  }
  // And the manifest's own, when it carries one.
  const own = manifest.citationStandard;
  if (own !== null) {
    assertEquals(citationLink(own), {
      href: `https://doi.org/${own.doi}`,
      label: own.linkLabel,
    });
  }
});

Deno.test('definitionLabel falls back to "Definition" for a null standard', () => {
  assertEquals(definitionLabel(null), "Definition");
});

Deno.test("definitionLabel names the standard when one is given", () => {
  const standard = {
    name: "STANDARD-1",
    label: "Author, A. et al. A standard. Journal 1, 1–2 (2020).",
    doi: "10.1000/example",
    linkLabel: "View STANDARD-1 (Journal 2020)",
  };
  assertEquals(definitionLabel(standard), "STANDARD-1 definition");
});

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

Deno.test("no gene symbol reaches the files every visitor downloads before login", async () => {
  // The manifest, the radar's timeline and the karyogram's families ship in
  // chunks served before the login, which the gene table sits behind.
  const pipeline = await readDiseaseJson("pipeline.json") as {
    monogenicGenes: string[];
    geneAliases: Record<string, string[]>;
  };
  const symbols = [
    ...pipeline.monogenicGenes,
    ...Object.entries(pipeline.geneAliases).flat(2),
  ].filter((symbol) => symbol.trim() !== "");
  if (symbols.length === 0) return;
  const escaped = [...new Set(symbols)]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const word = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${escaped.join("|")})(?![\\p{L}\\p{N}])`,
    "u",
  );
  const hits: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === "string") {
      const hit = word.exec(value);
      if (hit) hits.push(`${path}: ${hit[0]}`);
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        walk(key, `${path} key`);
        walk(item, `${path}.${key}`);
      }
    }
  };
  for (const name of ["manifest.json", "timeline.json", "phenogram.json"]) {
    walk(await readDiseaseJson(name), name);
  }
  assertEquals(hits, []);
});
