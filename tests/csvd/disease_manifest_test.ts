/**
 * The cSVD manifest, pinned value by value.
 *
 * The normalizer and schema tests that hold for any manifest are in
 * tests/disease_manifest_test.ts; this is the record of what the first
 * instance says, and a fork deletes the whole tests/csvd/ tree.
 */
import { assertEquals } from "@std/assert";

import { CELL_TYPE_NAMES } from "../../lib/constants.ts";
import { genes } from "../../lib/data/genes.ts";
import { manifest } from "../../lib/disease.ts";
import { ABSENT_SENTINELS } from "../../lib/sentinels.ts";
import { splitCellTypes } from "../../lib/tooltips.ts";

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
 * Abbreviations the hand-curated gold table's human cell-type column uses
 * and gold does not define -- its footnotes give none for that table. They
 * render without a tooltip rather than with a definition gold never gave.
 */
const UNDEFINED_BY_GOLD = ["BC", "OPC", "PVM", "RBC", "TC"];

Deno.test("the glossary defines every committed abbreviation but the five gold leaves undefined", () => {
  const used = new Set(
    genes.flatMap((g) => splitCellTypes(g.brainCellTypes).parts),
  );
  // `splitCellTypes` returns qualifiers as well as abbreviations -- "all<40",
  // "EC (arterial)" and similar prose the glossary was never meant to define.
  // The filter keeps only what looks like an abbreviation: an
  // uppercase-alphabetic token, which every glossary key is (EC, SMC, VSMC,
  // AC, MG, OL, PC, FB) and no free-text cell is.
  const undefinedAbbreviations = [...used].filter(
    (abbr) =>
      !ABSENT_SENTINELS.has(abbr) &&
      /^[A-Z]+$/.test(abbr) &&
      !(abbr in CELL_TYPE_NAMES),
  );
  assertEquals(undefinedAbbreviations.sort(), UNDEFINED_BY_GOLD);
});
