import { assert, assertEquals, assertThrows } from "@std/assert";

import manifestJson from "../disease/manifest.json" with { type: "json" };
import { manifest, normalizeManifest } from "../lib/disease.ts";

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
