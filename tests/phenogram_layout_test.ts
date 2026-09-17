import { assert, assertAlmostEquals, assertEquals } from "@std/assert";

import { type CytobandTable, placeGene } from "../lib/cytobands.ts";
import vocabulary from "../disease/vocabulary.json" with { type: "json" };
import { genes } from "../lib/data.ts";
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
const byGene = new Map(layout.blocks.map((b) => [b.symbol, b]));
const chromosome = (name: string) =>
  layout.chromosomes.find((c) => c.name === name)!;

/** Chromosomes carrying a gene in the committed table — the Python test pins the same list. */
const DRAWN = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "13",
  "14",
  "16",
  "17",
  "18",
  "19",
  "20",
  "21",
  "22",
  "X",
];

// X joined the list when the 365-day run added GLA (Xq22.1, Fabry disease),
// and 18 when it added AQP4 (18q11.2) -- the first genes the dashboard has
// carried on either.
Deno.test("79 genes are placed, none unplaced, on 21 chromosomes including X", () => {
  assertEquals(layout.blocks.length, 79);
  assertEquals(layout.unplaced, []);
  assertEquals(layout.chromosomes.map((c) => c.name), DRAWN);
  assertEquals(layout.rows.map((row) => row.map((c) => c.name)), [
    DRAWN.slice(0, 10),
    DRAWN.slice(10),
  ]);
  assertEquals(layout.canvas, { width: 1732, height: 1160 });
  assertEquals(layout.blocks.map((b) => b.index), [...Array(79).keys()]);
});

Deno.test("chromosomes are drawn to scale, top-aligned in their row, one per column", () => {
  const one = chromosome("1");
  assertAlmostEquals(one.height, L.rowHeight, 1e-6);
  assertEquals(one.y, L.margin);
  const thirteen = chromosome("13");
  assertAlmostEquals(
    thirteen.height,
    114364328 / 248956422 * L.rowHeight,
    1e-6,
  );
  assertEquals(thirteen.y, L.margin + L.rowHeight + L.rowGap);
  assertEquals(thirteen.row, 1);

  const pitch = L.chromosomeWidth + L.leaderGap + L.labelColumn;
  for (const row of layout.rows) {
    row.forEach((c, i) =>
      assertEquals(c.x, L.margin + i * pitch, `chr${c.name} x`)
    );
  }
  for (const c of layout.chromosomes) {
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
  assertEquals(byGene.get("ABO")!.chromosome, "9");
  assertEquals(byGene.get("APOE")!.chromosome, "19");
  assertEquals(byGene.get("C6orf195")!.chromosome, "6");
  assertEquals(byGene.get("COL4A1/2")!.chromosome, "13");
});

// Absolute numbers computed from this layout and pinned in both suites, so
// the print twin (scripts/phenogram_figure.py, TestPlacement in
// tests/scripts/test_phenogram_figure.py) and this browser renderer cannot
// silently drift apart.
Deno.test("CENPF's marker position is pinned", () => {
  const cenpf = byGene.get("CENPF")!;
  assertAlmostEquals(cenpf.markerY, 487.74276110057525, 1e-6);
  assertAlmostEquals(cenpf.y, 402, 1e-6);
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
  const labels = (s: string) => byGene.get(s)!.pills.map((p) => p.label);
  const glyphs = (s: string) => byGene.get(s)!.glyphs.map((g) => g.key);
  assertEquals(labels("LAMB1"), []);
  assertEquals(glyphs("LAMB1"), []);
  assertEquals(labels("JAK1"), ["PSMD"]);
  assertEquals(glyphs("JAK1"), ["omics", "monogenic"]);
  assertEquals(labels("PCSK9"), []);
  assertEquals(glyphs("PCSK9"), ["omics", "monogenic", "mr"]);
  assertEquals(labels("TLR1"), []);
  assertEquals(glyphs("TLR1"), ["omics", "mr"]);
  assertEquals(labels("CENPF"), ["WM-PVS", "HIP-PVS", "PSMD"]);
  assertEquals(glyphs("CENPF"), ["omics", "monogenic"]);
  // The gene the runs have moved most: Lacunes and CMB from PMID 42437605
  // on the first live --pubmed run, FA from 42607872 on the 30-day run,
  // then BG-PVS, Extreme-cSVD, Lacunar stroke and Stroke from the 365-day
  // one. Ten pills is the tallest block in the table and what set the row
  // height. The labels are the encoding's display forms.
  assertEquals(labels("COL4A1/2"), [
    "WMH",
    "SVS",
    "MD",
    "Lacunes",
    "CMB",
    "FA",
    "BG-PVS",
    "Extreme-cSVD",
    "Lacunar stroke",
    "Stroke",
  ]);

  const cenpf = byGene.get("CENPF")!;
  assertEquals(cenpf.height, blockHeight(3));
  assertEquals(blockHeight(0), 22);
  assertEquals(blockHeight(3), 64);
  assertEquals(cenpf.pills[0], {
    key: "WM-PVS",
    label: "WM-PVS",
    family: "pvs",
    fill: "#d8edff",
    stroke: "#2a78d6",
  });
  assertEquals(cenpf.pills[2].stroke, "#eb6834");
  assertEquals(cenpf.glyphs[0], {
    key: "omics",
    label: "Other omics",
    shape: "triangle",
  });
});

Deno.test("unknown traits and families receive explicit fallback pills", () => {
  const unknownTrait = { ...genes[0], gwasTrait: ["FUTURE"] };
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

Deno.test("the legend lists the seven families with every trait", () => {
  assertEquals(layout.legend.families.map((f) => f.family.key), [
    "pvs",
    "diffusion",
    "extreme",
    "wmh",
    "stroke",
    "cmb",
    "lacunes",
  ]);
  // Counted from the vocabulary, not restated: the trait list grows by
  // curation decision (PVWMH and DWMH were added once the extraction showed it
  // was naming them), and a hardcoded total only records how many there were
  // when someone last looked.
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
  const bogus = { ...genes[0], gene: "FAKE1", chromosomalLocation: "1p3" };
  const partial = computePhenogramLayout([bogus, genes[0]]);
  assertEquals(partial.unplaced.map((g) => g.gene), ["FAKE1"]);
  assertEquals(partial.blocks.map((b) => b.symbol), [genes[0].gene]);
  assertEquals(computePhenogramLayout([]).chromosomes, []);
});

Deno.test("resolveCollisions keeps separated blocks where they are", () => {
  assertEquals(resolveCollisions([0, 50], [20, 20], 0, 400, 6), [0, 50]);
});

Deno.test("resolveCollisions pushes a following block down past the gap", () => {
  assertEquals(resolveCollisions([0, 10], [20, 20], 0, 400, 6), [0, 26]);
});

Deno.test("resolveCollisions pulls a stack up when it would run past the row", () => {
  assertEquals(resolveCollisions([380, 390], [20, 20], 0, 400, 6), [354, 380]);
});

Deno.test("resolveCollisions clamps a lone block to the row", () => {
  assertEquals(resolveCollisions([-10], [20], 0, 400, 6), [0]);
  assertEquals(resolveCollisions([395], [20], 0, 400, 6), [380]);
  assertEquals(resolveCollisions([], [], 0, 400, 6), []);
});
