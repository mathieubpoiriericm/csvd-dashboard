/**
 * The committed cSVD annotations: that there are any, and that HTRA1's
 * CARASIL row carries its three identifiers through the boundary.
 *
 * The shape and normalizer rules are in tests/annotations_test.ts and pass
 * vacuously on the empty export; a fork deletes the whole tests/csvd/ tree.
 */
import { assert, assertEquals } from "@std/assert";

import { geneAnnotations } from "../../lib/data/annotations.ts";
import rawAnnotationJson from "../../data/gene_annotations.json" with {
  type: "json",
};

Deno.test("the committed annotations file has rows", () => {
  assert(
    (rawAnnotationJson as unknown[]).length > 0,
    "data/gene_annotations.json is empty",
  );
});

Deno.test("HTRA1's CARASIL survives the boundary with its identifiers", () => {
  const carasil = geneAnnotations.find(
    (row) => row.geneSymbol === "HTRA1" && row.groupKey === "MONDO:0010829",
  );
  assert(carasil, "HTRA1 has no MONDO:0010829 row");
  assertEquals(carasil.omimId, "600142");
  assertEquals(carasil.orphacode, "199354");
  assertEquals(carasil.mondoId, "MONDO:0010829");
});
