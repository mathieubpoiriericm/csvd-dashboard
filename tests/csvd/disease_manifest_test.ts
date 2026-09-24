/**
 * The cSVD manifest, pinned value by value.
 *
 * The normalizer and schema tests that hold for any manifest are in
 * tests/disease_manifest_test.ts; this is the record of what the first
 * instance says, and a fork deletes the whole tests/csvd/ tree.
 */
import { assertEquals } from "@std/assert";

import { manifest } from "../../lib/disease.ts";

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
