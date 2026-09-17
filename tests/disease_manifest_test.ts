import { assert, assertEquals, assertThrows } from "@std/assert";

import manifestJson from "../disease/manifest.json" with { type: "json" };
import diseaseTimeline from "../disease/timeline.json" with { type: "json" };
import {
  CELL_TYPE_NAMES,
  CELL_TYPES_LABEL,
  manifest,
  normalizeManifest,
} from "../lib/disease.ts";
import { POPULATION_CHOICES, SHOW_ALL } from "../lib/constants.ts";
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
  const missing = [...used].filter(
    (abbr) =>
      !ABSENT_SENTINELS.has(abbr) &&
      /^[A-Z]+$/.test(abbr) &&
      !(abbr in CELL_TYPE_NAMES),
  );
  assertEquals(missing, []);
});
