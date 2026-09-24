/**
 * The cSVD karyogram, pinned: 79 genes on 21 chromosomes, CENPF's row, the
 * pills the runs have added, the seven families.
 *
 * The rules that hold for any dataset are in tests/phenogram_layout_test.ts;
 * this file is the record of what the committed cSVD data draws, mirrored in
 * tests/scripts/csvd/test_csvd_phenogram_figure.py, and a fork deletes the
 * whole tests/csvd/ tree.
 */
import { assertAlmostEquals, assertEquals } from "@std/assert";

import vocabulary from "../../disease/vocabulary.json" with { type: "json" };
import { genes } from "../../lib/data.ts";
import {
  blockHeight,
  computePhenogramLayout,
  encoding,
} from "../../lib/phenogram.ts";

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

Deno.test("chromosome 1 heads the first row and 13 the second", () => {
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
});

Deno.test("the raster's errors are gone: ABO on 9, C6orf195 on 6, COL4A1/2 on 13", () => {
  assertEquals(byGene.get("ABO")!.chromosome, "9");
  assertEquals(byGene.get("APOE")!.chromosome, "19");
  assertEquals(byGene.get("C6orf195")!.chromosome, "6");
  assertEquals(byGene.get("COL4A1/2")!.chromosome, "13");
});

// Absolute numbers computed from this layout and pinned in both suites, so
// the print twin (scripts/phenogram_figure.py, TestPlacement in
// tests/scripts/csvd/test_csvd_phenogram_figure.py) and this browser renderer
// cannot silently drift apart.
Deno.test("CENPF's marker position is pinned", () => {
  const cenpf = byGene.get("CENPF")!;
  assertAlmostEquals(cenpf.markerY, 487.74276110057525, 1e-6);
  assertAlmostEquals(cenpf.y, 402, 1e-6);
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
  assertEquals(
    layout.legend.families.reduce((n, f) => n + f.traits.length, 0),
    vocabulary.traits.length,
  );
});
