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
  canvasFor,
  CHROMOSOME_LABEL_DESCENT,
  type ChromosomeShape,
  chromosomeShapes,
  columnWidth,
  computePhenogramLayout,
  encoding,
  fontMetrics,
  glyphsFor,
  labelWidth,
  type PhenogramLayout,
  phenogramLegend,
  pillsFor,
  resolveCollisions,
  splitRows,
  textWidth,
} from "../lib/phenogram.ts";

const layout = computePhenogramLayout(genes);
const L = encoding.layout;
const chromosome = (name: string) =>
  layout.chromosomes.find((c) => c.name === name)!;
const pitchOf = (c: ChromosomeShape) =>
  L.chromosomeWidth + L.leaderGap + c.columnWidth;
const rowWidth = (row: readonly ChromosomeShape[]) =>
  row.reduce((sum, c) => sum + pitchOf(c), 0);

/** A gene on every chromosome, at both ends: the whole karyotype. */
const everywhere = cytobands.chromosomes.flatMap((c, i) => [
  sampleGene({
    gene: `A${i}`,
    chromosomalLocation: `${c.name}${c.bands[0].name}`,
  }),
  sampleGene({
    gene: `Z${i}`,
    chromosomalLocation: `${c.name}${c.bands.at(-1)!.name}`,
  }),
]);

/**
 * What every layout owes its canvas, whatever the data: each chromosome sits
 * after the previous one's label column, each block inside its own column and
 * on the canvas, the rows split as evenly as the order allows, and the canvas
 * no larger than the drawing plus its margin.
 */
function assertFits(placed: PhenogramLayout, label: string) {
  const { width, height } = placed.canvas;
  for (const row of placed.rows) {
    let right = L.margin;
    for (const c of row) {
      assert(
        c.x >= right - 1e-6,
        `${label}: chr${c.name} overlaps the column before it`,
      );
      assertEquals(c.x, right, `${label}: chr${c.name} x`);
      right = c.x + pitchOf(c);
      assert(
        right <= width - L.margin + 1e-6,
        `${label}: chr${c.name} off the right`,
      );
      assert(
        c.labelPoint.y + CHROMOSOME_LABEL_DESCENT <= height - L.margin + 1e-6,
      );
    }
  }
  for (const block of placed.blocks) {
    const c = placed.chromosomes.find((c) => c.name === block.chromosome)!;
    assertEquals(block.width, c.columnWidth, `${label}: ${block.symbol}`);
    const drawn = labelWidth(block.symbol, block.pills, block.glyphs.length);
    assert(
      block.x + drawn <= c.x + pitchOf(c) + 1e-6,
      `${label}: ${block.symbol} leaves its column`,
    );
    assert(block.x >= 0 && block.y >= 0, `${label}: ${block.symbol}`);
    assert(block.x + block.width <= width + 1e-6, `${label}: ${block.symbol}`);
    assert(
      block.y + block.height <= height + 1e-6,
      `${label}: ${block.symbol}`,
    );
  }
  // The split: no other cut of the same order makes the wider row narrower.
  const pitches = placed.rows.flat().map(pitchOf);
  const widest = Math.max(...placed.rows.map(rowWidth));
  for (let k = 1; k < pitches.length; k++) {
    const first = pitches.slice(0, k).reduce((a, b) => a + b, 0);
    const rest = pitches.slice(k).reduce((a, b) => a + b, 0);
    assert(widest <= Math.max(first, rest), `${label}: cut at ${k} is better`);
  }
  // The canvas is the drawing's extent, not a fixed plate.
  if (placed.chromosomes.length > 0) {
    assertEquals(
      width,
      Math.ceil(2 * L.margin + Math.max(...placed.rows.map(rowWidth))),
    );
    const bottom = Math.max(
      ...placed.chromosomes.map((c) =>
        c.labelPoint.y + CHROMOSOME_LABEL_DESCENT
      ),
      ...placed.blocks.map((b) => b.y + b.height),
    );
    assertEquals(height, Math.ceil(bottom + L.margin));
  }
}

Deno.test("only chromosomes carrying a gene are drawn, in karyotype order across two rows", () => {
  const drawn = layout.chromosomes.map((c) => c.name);
  assertEquals(new Set(drawn), new Set(layout.blocks.map((b) => b.chromosome)));
  assertEquals(layout.rows.flat().map((c) => c.name), drawn);
  assertEquals(layout.blocks.map((b) => b.index), [
    ...Array(layout.blocks.length).keys(),
  ]);
  assertEquals(layout.blocks.length + layout.unplaced.length, genes.length);
  assertEquals(layout.canvas, canvasFor(layout.rows, layout.blocks));
});

Deno.test("the committed layout fits its canvas", () => {
  assertFits(layout, "committed");
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
  // Three equal columns: either cut leaves a row of two, and a tie goes to
  // the later cut.
  assertEquals(placed.rows.map((row) => row.map((c) => c.name)), [
    ["1", "13"],
    ["X"],
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
  assertEquals(thirteen.y, L.margin);
  const x = placed.chromosomes[2];
  assertEquals(x.y, L.margin + L.rowHeight + L.rowGap);
  assertEquals(x.row, 1);
  // No label is wider than the minimum column, so every pitch is the minimum.
  const pitch = L.chromosomeWidth + L.leaderGap + L.labelColumn;
  for (const row of placed.rows) {
    row.forEach((c, i) => {
      assertEquals(c.columnWidth, L.labelColumn);
      assertEquals(c.x, L.margin + i * pitch, `chr${c.name} x`);
    });
  }
  assertFits(placed, "constructed");
});

Deno.test("a gene on every chromosome draws the whole karyotype in two even rows", () => {
  const rows = everywhere;
  const placed = computePhenogramLayout(rows);
  assertEquals(placed.unplaced, []);
  assertEquals(
    placed.chromosomes.map((c) => c.name),
    cytobands.chromosomes.map((c) => c.name),
  );
  assertEquals(placed.blocks.length, rows.length);
  // Twenty-four equal columns split twelve and twelve.
  assertEquals(placed.rows.map((row) => row.length), [12, 12]);
  assertFits(placed, "karyotype");
  // Within a chromosome the first band's gene precedes the last band's.
  for (const c of placed.chromosomes) {
    const here = placed.blocks.filter((b) => b.chromosome === c.name);
    assertEquals(here.map((b) => b.symbol[0]), ["A", "Z"]);
  }
});

Deno.test("chromosomes are drawn to scale, top-aligned in their row, one per column", () => {
  for (const row of layout.rows) {
    let x = L.margin;
    for (const c of row) {
      assertEquals(c.x, x, `chr${c.name} x`);
      x += pitchOf(c);
    }
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
    assertEquals(block.width, c.columnWidth);
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

Deno.test("the layout's legend is the key over its rows", () => {
  assertEquals(layout.legend, phenogramLegend(genes));
});

Deno.test("outside gold-only the legend lists the disease's families with every trait", () => {
  // The family order is disease/phenogram.json's, as the encoding test
  // derives it; the trait total is counted from the vocabulary, not
  // restated, because the list grows by curation decision. No row is
  // needed: the key does not follow the data.
  const legend = phenogramLegend([], encoding, false);
  assertEquals(
    legend.families.map((f) => f.family.key),
    families.families.map((f) => f.key),
  );
  assertEquals(
    legend.families.reduce((n, f) => n + f.traits.length, 0),
    vocabulary.traits.length,
  );
  assertEquals(legend.evidence.map((e) => e.shape), [
    "triangle",
    "square",
    "star",
  ]);
});

Deno.test("under gold-only the legend lists only the traits the rows carry", () => {
  const first = vocabulary.traits[0];
  const last = vocabulary.traits.at(-1)!;
  const rows = [
    sampleGene({ gwasTrait: [` ${last.key.toUpperCase()} `] }),
    sampleGene({ gwasTrait: [first.key] }),
    sampleGene(),
  ];
  const legend = phenogramLegend(rows, encoding, true);
  // Families keep the disease's order; a family no row reaches drops out.
  assertEquals(
    legend.families.map((f) => f.family.key),
    families.families.map((f) => f.key)
      .filter((key) => key === first.family || key === last.family),
  );
  assertEquals(
    legend.families.flatMap((f) => f.traits.map((t) => t.key)),
    [...new Set([first.key, last.key])],
  );
  assertEquals(legend.evidence, encoding.evidence);
  assertEquals(phenogramLegend([], encoding, true).families, []);
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

Deno.test("textWidth sums the face's advances and charges an unknown character the widest", () => {
  const advances = fontMetrics.advances;
  const em = fontMetrics.unitsPerEm;
  const a = advances["600"][String("A".codePointAt(0))];
  assertAlmostEquals(textWidth("AA", 600, 12), 2 * a / em * 12, 1e-9);
  assertEquals(textWidth("", 400, 9.5), 0);
  const widest = Math.max(...Object.values(advances["400"]));
  assertAlmostEquals(textWidth("\u{1F9EC}", 400, 10), widest / em * 10, 1e-9);
  // Bold symbols measure wider than the same letters in a pill's regular.
  assert(textWidth("abc", 600, 12) > textWidth("abc", 400, 12));
});

Deno.test("labelWidth is the wider of the first line, glyphs included, and each pill", () => {
  const symbol = textWidth("GENE1", 600, L.symbolFont);
  assertAlmostEquals(labelWidth("GENE1", [], 0), symbol, 1e-9);
  // Glyphs start two gaps after the symbol and sit a gap apart, as Block draws them.
  assertAlmostEquals(
    labelWidth("GENE1", [], 3),
    symbol + 2 * L.glyphGap + 3 * L.glyphSize + 2 * L.glyphGap,
    1e-9,
  );
  const long = "A pill label far longer than any gene symbol";
  assertAlmostEquals(
    labelWidth("GENE1", [{ label: "WMH" }, { label: long }], 1),
    textWidth(long, 400, L.pillFont) + 2 * L.pillPaddingX,
    1e-9,
  );
  const rich = sampleGene({
    evidenceFromOtherOmicsStudies: ["TWAS"],
    mendelianRandomization: "Yes",
  });
  assertEquals(glyphsFor(rich).length, 2);
});

Deno.test("columnWidth never narrows below labelColumn and rounds the slack up", () => {
  assertEquals(columnWidth([]), L.labelColumn);
  assertEquals(columnWidth([10, 40]), L.labelColumn);
  assertEquals(
    columnWidth([L.labelColumn + 0.25]),
    L.labelColumn + Math.ceil(0.25 + L.labelSlack),
  );
});

Deno.test("splitRows makes the wider row narrowest, the later cut on a tie", () => {
  assertEquals(splitRows([]), 0);
  assertEquals(splitRows([152]), 1);
  assertEquals(splitRows([1, 1]), 1);
  assertEquals(splitRows([1, 1, 1]), 2);
  assertEquals(splitRows([10, 1, 1, 1]), 1);
  assertEquals(splitRows([1, 1, 1, 10]), 3);
  // Against a brute force over small widths.
  let seed = 7;
  const next = () => (seed = (seed * 48271) % 2147483647) % 5 + 1;
  for (let trial = 0; trial < 200; trial++) {
    const pitches = Array.from({ length: 2 + trial % 7 }, next);
    const cost = (k: number) =>
      Math.max(
        pitches.slice(0, k).reduce((a, b) => a + b, 0),
        pitches.slice(k).reduce((a, b) => a + b, 0),
      );
    let best = 1;
    for (let k = 1; k < pitches.length; k++) {
      if (cost(k) <= cost(best)) best = k;
    }
    assertEquals(splitRows(pitches), best, pitches.join(","));
  }
});

Deno.test("a pill wider than the minimum column widens only its own column", () => {
  const long = "MTAG (every trait this gene was ever linked with, at once)";
  const placed = computePhenogramLayout([
    sampleGene({ gene: "GENE1", chromosomalLocation: "1p36.33" }),
    sampleGene({
      gene: "GENE2",
      chromosomalLocation: "2p25.3",
      gwasTrait: [long],
    }),
    sampleGene({ gene: "GENE3", chromosomalLocation: "3p26.3" }),
  ]);
  const widths = new Map(
    placed.chromosomes.map((c) => [c.name, c.columnWidth]),
  );
  const pill = textWidth(long, 400, L.pillFont) + 2 * L.pillPaddingX;
  assert(pill > L.labelColumn);
  assertEquals(widths.get("2"), Math.ceil(pill + L.labelSlack));
  assertEquals(widths.get("1"), L.labelColumn);
  assertEquals(widths.get("3"), L.labelColumn);
  assertFits(placed, "wide pill");
});

Deno.test("chromosomeShapes takes each column's width and splits on the pitches", () => {
  const rows = chromosomeShapes(
    new Set(["1", "2", "3"]),
    cytobands,
    encoding,
    new Map([["1", 400]]),
  );
  // 1's pitch outweighs 2 and 3 together, so it stands alone.
  assertEquals(rows.map((row) => row.map((c) => c.name)), [["1"], [
    "2",
    "3",
  ]]);
  assertEquals(rows[0][0].columnWidth, 400);
  assertEquals(
    rows[1][1].x,
    L.margin + L.chromosomeWidth + L.leaderGap + L.labelColumn,
  );
  // A single chromosome keeps the two-row structure with an empty second row.
  assertEquals(chromosomeShapes(new Set(["7"])).map((r) => r.length), [1, 0]);
});

Deno.test("an empty layout gets the one-column empty canvas", () => {
  const empty = { width: 2 * L.margin + L.labelColumn, height: 2 * L.margin };
  assertEquals(computePhenogramLayout([]).canvas, empty);
  assertEquals(canvasFor([[], []], []), empty);
});

// Disease-neutral numbers pinned identically in
// tests/scripts/test_phenogram_figure.py (TestDerivedCanvas), so the two
// renderers' measurement cannot drift apart even with the csvd/ trees gone.
// They move only with the Barlow files or the layout constants.
Deno.test("the measurement twins agree on synthetic literals", () => {
  const label = "Synthetic label (42, X/Y)";
  assertAlmostEquals(textWidth(label, 400, 9.5), 97.261, 1e-6);
  assertAlmostEquals(textWidth(label, 600, 12), 127.656, 1e-6);
  assertAlmostEquals(labelWidth("GENE1", [], 3), 76.828, 1e-6);
  const long = "MTAG (every trait this gene was ever linked with, at once)";
  assertEquals(columnWidth([labelWidth("GENE2", [{ label: long }], 0)]), 252);
});
