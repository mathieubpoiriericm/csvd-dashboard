import { assert, assertEquals } from "@std/assert";

import { cytobands, placeGene, STAINS } from "../lib/cytobands.ts";
import { genes } from "../lib/data.ts";
import { CHROMOSOMES } from "../lib/sorting.ts";

/**
 * `data/cytobands_hg38.json` is the karyogram's geometry and the lookup that
 * places a gene from its `chromosomalLocation`. The last test is the
 * guardrail: a regenerated gene table whose band strings no longer resolve
 * fails here, not silently on the page.
 */

Deno.test("the table carries the 24 human chromosomes in CHROMOSOMES order", () => {
  assertEquals(cytobands.assembly, "hg38");
  assertEquals(cytobands.chromosomes.map((c) => c.name), [...CHROMOSOMES]);
  assertEquals(
    cytobands.chromosomes.reduce((n, c) => n + c.bands.length, 0),
    862,
  );
});

Deno.test("bands are sorted, contiguous, inside the chromosome, and use known stains", () => {
  for (const chromosome of cytobands.chromosomes) {
    let cursor = 0;
    for (const band of chromosome.bands) {
      assertEquals(
        band.start,
        cursor,
        `chr${chromosome.name} ${band.name} does not start where the previous band ends`,
      );
      assert(
        band.end > band.start,
        `chr${chromosome.name} ${band.name} is empty`,
      );
      assert(
        (STAINS as readonly string[]).includes(band.stain),
        `chr${chromosome.name} ${band.name}: unknown stain ${band.stain}`,
      );
      cursor = band.end;
    }
    assertEquals(cursor, chromosome.length, `chr${chromosome.name} length`);
    assertEquals(
      chromosome.bands.filter((b) => b.stain === "acen").length,
      2,
      `chr${chromosome.name} centromere`,
    );
  }
});

Deno.test("placeGene resolves an exact band to its midpoint and nothing else", () => {
  assertEquals(placeGene("7q31.1"), {
    chromosome: "7",
    band: "q31.1",
    start: 107800000,
    end: 115000000,
    midpoint: 111400000,
  });
  assertEquals(placeGene("13q34")?.chromosome, "13");
  assertEquals(placeGene("Xq28")?.chromosome, "X");
  assertEquals(placeGene(" 7q31.1 "), placeGene("7q31.1"));
  // Not a band name in the ideogram, so not a guess either.
  assertEquals(placeGene("1p3"), null);
  assertEquals(placeGene("23q11"), null);
  assertEquals(placeGene("(unknown)"), null);
  assertEquals(placeGene("7q31.1x"), null);
});

Deno.test("every committed gene's chromosomal location is an exact hg38 band", () => {
  const unresolved = genes
    .filter((gene) => placeGene(gene.chromosomalLocation) === null)
    .map((gene) => `${gene.gene} ${gene.chromosomalLocation}`);
  assertEquals(unresolved, []);
});
