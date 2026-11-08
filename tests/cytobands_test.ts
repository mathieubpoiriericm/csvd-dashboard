import { assert, assertEquals, assertNotEquals } from "@std/assert";

import { cytobands, placeGene, STAINS } from "../lib/cytobands.ts";
import { genes } from "../lib/data.ts";
import { computePhenogramLayout } from "../lib/phenogram.ts";
import { CHROMOSOMES } from "../lib/sorting.ts";

/**
 * `data/cytobands_hg38.json` is the karyogram's geometry and the lookup that
 * places a gene from its `chromosomalLocation`. The last test holds that a
 * location the table cannot resolve is reported rather than drawn; the
 * guardrail on the committed data's own band strings is in
 * tests/csvd/phenogram_layout_test.ts.
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

Deno.test("placeGene spans a band range on one chromosome", () => {
  // NCBI names a gene that crosses a band edge with a range: SLK runs from
  // 103.97 to 104.03 Mb on chr10, across the q24.33/q25.1 edge at 104.0 Mb.
  // The span is both bands, so the marker goes at its midpoint -- the same
  // rule as one band, over the region the location actually names.
  assertEquals(placeGene("10q24.33-q25.1"), {
    chromosome: "10",
    band: "q24.33-q25.1",
    start: 103100000,
    end: 110100000,
    midpoint: 106600000,
  });
  const reversed = placeGene("10q25.1-q24.33");
  assertEquals([reversed?.start, reversed?.end], [103100000, 110100000]);
  // Both ends exact bands of one chromosome, or nothing.
  assertEquals(placeGene("10q24.33-q25"), null);
  assertEquals(placeGene("10q24.33-"), null);
  assertEquals(placeGene("10q24.33-11q25.1"), null);
  assertEquals(placeGene("10q24.33-q25.1-q25.2"), null);
});

Deno.test("placeGene refuses a range across the centromere", () => {
  // Both ends are exact bands, but one is on p and the other on q: the span
  // is most of the chromosome, and its midpoint is the centromere, which
  // says nothing about where the gene is. Listed as unplaced instead.
  assertEquals(placeGene("1p36.33-q44"), null);
  assertEquals(placeGene("1q21.1-p13.3"), null);
  assertNotEquals(placeGene("10q24.33-q25.1"), null);
});

// Which committed locations resolve is a fact about one disease's data:
// tests/csvd/phenogram_layout_test.ts pins the one gold location hg38 has
// no band for. What holds for any data is that such a location is reported,
// never drawn somewhere it is not.
Deno.test("a committed location with no hg38 band is reported as unplaced, not drawn", () => {
  const layout = computePhenogramLayout(genes);
  const unresolved = genes
    .filter((gene) => placeGene(gene.chromosomalLocation) === null)
    .map((gene) => gene.gene);
  assertEquals(layout.unplaced.map((gene) => gene.gene), unresolved);
  const drawn = new Set(layout.blocks.map((block) => block.symbol));
  for (const symbol of unresolved) assert(!drawn.has(symbol), symbol);
  assertEquals(layout.blocks.length, genes.length - unresolved.length);
});
