/**
 * The cSVD manifest, pinned value by value.
 *
 * The normalizer and schema tests that hold for any manifest are in
 * tests/disease_manifest_test.ts; this is the record of what the first
 * instance says, and a fork deletes the whole tests/csvd/ tree.
 */
import { assertEquals } from "@std/assert";

import { genes } from "../../lib/data/genes.ts";
import { manifest } from "../../lib/disease.ts";
import { ABSENT_SENTINELS } from "../../lib/sentinels.ts";
import { cellTypeTooltip, splitCellTypes } from "../../lib/tooltips.ts";

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

/**
 * The committed parts that are prose rather than a cell type: "all < 40"
 * splits on its "<", and "NOT FOUND" is the curators' own note.
 */
const PROSE_PARTS = ["40", "NOT FOUND", "all"];

Deno.test("every committed cell type gets a tooltip, subtypes and noted ones included", () => {
  const used = new Set(
    genes.flatMap((g) => splitCellTypes(g.brainCellTypes).parts),
  );
  const plain = [...used].filter(
    (part) => !ABSENT_SENTINELS.has(part) && cellTypeTooltip(part) === null,
  );
  assertEquals(plain.sort(), PROSE_PARTS);
});
