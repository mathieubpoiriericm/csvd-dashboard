/**
 * The karyogram layout rules, over the committed rows (looped) and over
 * constructed ones. Every test holds for any dataset; the cSVD numbers --
 * 79 genes, 21 chromosomes, CENPF's row -- are tests/csvd/phenogram_layout_test.ts.
 */
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import { cytobands, type CytobandTable, placeGene } from "../lib/cytobands.ts";
import families from "../disease/phenogram.json" with { type: "json" };
import vocabulary from "../disease/vocabulary.json" with { type: "json" };
import { genes } from "../lib/data.ts";
import { sampleGene } from "./fixtures/rows.ts";
import {
  blockHeight,
  chromosomeShapes,
  computePhenogramLayout,
  encoding,
  pillsFor,
  resolveCollisions,
} from "../lib/phenogram.ts";

const layout = computePhenogramLayout(genes);
const L = encoding.layout;
const chromosome = (name: string) =>
  layout.chromosomes.find((c) => c.name === name)!;

Deno.test("only chromosomes carrying a gene are drawn, in karyotype order across two rows", () => {
  const drawn = layout.chromosomes.map((c) => c.name);
  assertEquals(new Set(drawn), new Set(layout.blocks.map((b) => b.chromosome)));
  assertEquals(layout.rows.flat().map((c) => c.name), drawn);
  assertEquals(layout.blocks.map((b) => b.index), [
    ...Array(layout.blocks.length).keys(),
  ]);
  assertEquals(layout.blocks.length + layout.unplaced.length, genes.length);
  assertEquals(layout.canvas, { width: L.viewBox[0], height: L.viewBox[1] });
});

Deno.test("a constructed table draws to scale, top-aligned in its row, one per column", () => {
  const placed = computePhenogramLayout([
    // Two genes on chromosome 1, on different bands, in the wrong order:
    // the blocks come out by marker position, not by input order.
    sampleGene({ gene: "GENE4", chromosomalLocation: "1q42.13" }),
    sampleGene({ gene: "GENE1", chromosomalLocation: "1p36.33" }),
    sampleGene({ gene: "GENE5", chromosomalLocation: "1p31.1" }),
    sampleGene({ gene: "GENE2", chromosomalLocation: "13q34" }),
    sampleGene({ gene: "GENE3", chromosomalLocation: "Xq22.1" }),
  ]);
  assertEquals(placed.chromosomes.map((c) => c.name), ["1", "13", "X"]);
  assertEquals(placed.blocks.map((b) => b.symbol), [
    "GENE1",
    "GENE5",
    "GENE4",
    "GENE2",
    "GENE3",
  ]);
  // The row break is after chromosome `rowSplitAfter`, not at a count.
  assertEquals(placed.rows.map((row) => row.map((c) => c.name)), [
    ["1"],
    ["13", "X"],
  ]);
  const one = placed.chromosomes[0];
  assertAlmostEquals(one.height, L.rowHeight, 1e-6);
  assertEquals(one.y, L.margin);
  const thirteen = placed.chromosomes[1];
  assertAlmostEquals(
    thirteen.height,
    114364328 / 248956422 * L.rowHeight,
    1e-6,
  );
  assertEquals(thirteen.y, L.margin + L.rowHeight + L.rowGap);
  assertEquals(thirteen.row, 1);
  const pitch = L.chromosomeWidth + L.leaderGap + L.labelColumn;
  for (const row of placed.rows) {
    row.forEach((c, i) =>
      assertEquals(c.x, L.margin + i * pitch, `chr${c.name} x`)
    );
  }
});

Deno.test("a gene on every chromosome draws the whole karyotype in two rows", () => {
  const rows = cytobands.chromosomes.flatMap((c, i) => [
    sampleGene({
      gene: `A${i}`,
      chromosomalLocation: `${c.name}${c.bands[0].name}`,
    }),
    sampleGene({
      gene: `Z${i}`,
      chromosomalLocation: `${c.name}${c.bands.at(-1)!.name}`,
    }),
  ]);
  const placed = computePhenogramLayout(rows);
  assertEquals(placed.unplaced, []);
  assertEquals(
    placed.chromosomes.map((c) => c.name),
    cytobands.chromosomes.map((c) => c.name),
  );
  assertEquals(placed.blocks.length, rows.length);
  assertEquals(placed.rows[0].at(-1)!.name, L.rowSplitAfter);
  // Within a chromosome the first band's gene precedes the last band's.
  for (const c of placed.chromosomes) {
    const here = placed.blocks.filter((b) => b.chromosome === c.name);
    assertEquals(here.map((b) => b.symbol[0]), ["A", "Z"]);
  }
});

Deno.test("chromosomes are drawn to scale, top-aligned in their row, one per column", () => {
  const pitch = L.chromosomeWidth + L.leaderGap + L.labelColumn;
  for (const row of layout.rows) {
    row.forEach((c, i) =>
      assertEquals(c.x, L.margin + i * pitch, `chr${c.name} x`)
    );
  }
  for (const c of layout.chromosomes) {
    assertEquals(c.y, L.margin + c.row * (L.rowHeight + L.rowGap));
    assert(c.height <= L.rowHeight + 1e-6);
    let cursor = c.y;
    for (const band of c.bands) {
      assertAlmostEquals(band.y, cursor, 1e-6, `chr${c.name} ${band.name}`);
      assertEquals(band.fill, encoding.stains[band.stain]);
      cursor += band.height;
    }
    assertAlmostEquals(cursor, c.y + c.height, 1e-6);
    assert(c.pArm.height > 0 && c.centromere.height > 0 && c.qArm.height > 0);
    assertAlmostEquals(c.pArm.y + c.pArm.height, c.centromere.y, 1e-6);
    assertAlmostEquals(c.centromere.y + c.centromere.height, c.qArm.y, 1e-6);
    assertEquals(c.labelPoint, {
      x: c.x + L.chromosomeWidth / 2,
      y: c.y + c.height + 18,
    });
  }
});

Deno.test("each marker sits at its band's midpoint inside its chromosome", () => {
  for (const block of layout.blocks) {
    const c = chromosome(block.chromosome);
    const hit = placeGene(block.gene.chromosomalLocation)!;
    assertEquals(block.band, hit.band);
    assertAlmostEquals(
      block.markerY,
      c.y + (hit.midpoint / c.length) * c.height,
      1e-6,
      block.symbol,
    );
    assert(block.markerY >= c.y && block.markerY <= c.y + c.height);
    assertEquals(block.x, c.x + L.chromosomeWidth + L.leaderGap);
    assertEquals(block.width, L.labelColumn);
    assert(
      block.leader.startsWith(`M ${(c.x + L.chromosomeWidth).toFixed(2)} `),
    );
  }
});

Deno.test("label blocks never overlap, stay in their row, and keep marker order", () => {
  for (const c of layout.chromosomes) {
    const blocks = layout.blocks.filter((b) => b.chromosome === c.name);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      assert(block.y >= c.y - 1e-6, `${block.symbol} is above its row`);
      assert(
        block.y + block.height <= c.y + L.rowHeight + 1e-6,
        `${block.symbol} is below its row`,
      );
      if (i === 0) continue;
      const previous = blocks[i - 1];
      assert(
        previous.markerY <= block.markerY,
        `${block.symbol} is out of order`,
      );
      assert(
        block.y >= previous.y + previous.height + L.blockGap - 1e-6,
        `${previous.symbol}/${block.symbol} overlap`,
      );
    }
  }
});

Deno.test("pills and glyphs derive from the four evidence columns", () => {
  const first = encoding.traits[0];
  const family = encoding.families.find((f) => f.key === first.family)!;
  const evidence = sampleGene({
    gene: "GENE1",
    gwasTrait: [first.key],
    evidenceFromOtherOmicsStudies: ["TWAS"],
    linkToMonogenicDisease: ["100000"],
    mendelianRandomization: "Yes",
  });
  const bare = sampleGene({ gene: "GENE2" });
  const placed = computePhenogramLayout([evidence, bare]);
  const byGene = new Map(placed.blocks.map((b) => [b.symbol, b]));

  const rich = byGene.get("GENE1")!;
  assertEquals(rich.pills, [{
    key: first.key,
    label: first.label,
    family: family.key,
    fill: family.tint,
    stroke: family.hue,
  }]);
  assertEquals(rich.glyphs.map((g) => g.key), ["omics", "monogenic", "mr"]);
  assertEquals(rich.glyphs[0], {
    key: "omics",
    label: "Other omics",
    shape: "triangle",
  });
  assertEquals(rich.height, blockHeight(1));
  assert(blockHeight(3) > blockHeight(0));

  const plain = byGene.get("GENE2")!;
  assertEquals(plain.pills, []);
  assertEquals(plain.glyphs, []);
  assertEquals(plain.height, blockHeight(0));
});

Deno.test("unknown traits and families receive explicit fallback pills", () => {
  const unknownTrait = { ...sampleGene(), gwasTrait: ["FUTURE"] };
  assertEquals(pillsFor(unknownTrait), [{
    key: "FUTURE",
    label: "FUTURE",
    family: "unknown",
    fill: "#ffffff",
    stroke: "#888888",
  }]);

  const missingFamilyEncoding = {
    ...encoding,
    families: [],
    traits: [{
      key: "FUTURE",
      label: "Future trait",
      family: "future-family",
      name: "Future trait",
    }],
  };
  assertEquals(pillsFor(unknownTrait, missingFamilyEncoding), [{
    key: "FUTURE",
    label: "Future trait",
    family: "future-family",
    fill: "#ffffff",
    stroke: "#888888",
  }]);
});

Deno.test("chromosomeShapes tolerates partial tables, absent centromeres, and new stains", () => {
  const table: CytobandTable = {
    assembly: "test",
    source: "fixture",
    chromosomes: [{
      name: "1",
      length: 100,
      bands: [{ name: "p1", start: 0, end: 100, stain: "future" }],
    }],
  };
  const customEncoding = { ...encoding, stains: {} };
  const rows = chromosomeShapes(
    new Set(["1", "2"]),
    table,
    customEncoding,
  );
  const shape = rows[0][0];

  assertEquals(rows.flat().map((entry) => entry.name), ["1"]);
  assertEquals(shape.bands[0].fill, "#cccccc");
  assertEquals(shape.pArm.height, customEncoding.layout.rowHeight / 2);
  assertEquals(shape.centromere.height, 0);
  assertEquals(shape.qArm.height, customEncoding.layout.rowHeight / 2);
});

Deno.test("the legend lists the disease's families with every trait", () => {
  // The family order is disease/phenogram.json's, as the encoding test
  // derives it; the trait total is counted from the vocabulary, not
  // restated, because the list grows by curation decision.
  assertEquals(
    layout.legend.families.map((f) => f.family.key),
    families.families.map((f) => f.key),
  );
  assertEquals(
    layout.legend.families.reduce((n, f) => n + f.traits.length, 0),
    vocabulary.traits.length,
  );
  assertEquals(layout.legend.evidence.map((e) => e.shape), [
    "triangle",
    "square",
    "star",
  ]);
});

Deno.test("a gene with an unknown band is reported, not drawn", () => {
  const bogus = { ...sampleGene(), gene: "FAKE1", chromosomalLocation: "1p3" };
  const placeable = sampleGene();
  const partial = computePhenogramLayout([bogus, placeable]);
  assertEquals(partial.unplaced.map((g) => g.gene), ["FAKE1"]);
  assertEquals(partial.blocks.map((b) => b.symbol), [placeable.gene]);
  assertEquals(computePhenogramLayout([]).chromosomes, []);
});

Deno.test("resolveCollisions keeps separated blocks where they are", () => {
  assertEquals(resolveCollisions([0, 50], [20, 20], 0, 400, 6), [0, 50]);
});

Deno.test("resolveCollisions pushes a following block down past the gap", () => {
  assertEquals(resolveCollisions([0, 10], [20, 20], 0, 400, 6), [0, 26]);
  // A stack of three: each block is pushed clear of the one above it.
  assertEquals(
    resolveCollisions([0, 10, 20], [20, 20, 20], 0, 400, 6),
    [0, 26, 52],
  );
});

Deno.test("resolveCollisions pulls a stack up when it would run past the row", () => {
  assertEquals(resolveCollisions([380, 390], [20, 20], 0, 400, 6), [354, 380]);
});

Deno.test("resolveCollisions clamps a lone block to the row", () => {
  assertEquals(resolveCollisions([-10], [20], 0, 400, 6), [0]);
  assertEquals(resolveCollisions([395], [20], 0, 400, 6), [380]);
  assertEquals(resolveCollisions([], [], 0, 400, 6), []);
});
