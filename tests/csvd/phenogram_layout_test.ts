/**
 * The cSVD karyogram, pinned: the gold table's 114 placeable genes on 22
 * chromosomes, CENPF's row, the pills, the eight families.
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
  "12",
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
// carried on either. The 2026-11-03 re-extraction under Opus 5.5 started
// again from the curated 31 August table and found GLA but not AQP4, so 18
// left the list again. The gold-only switch (2026-11-07) publishes the
// hand-curated table instead, which puts genes on 12 and 18 as well, and
// writes MSMP's band as "9q13.3", which hg38 does not have: gold is
// published verbatim, so MSMP is the one gene left off the figure.
Deno.test("114 genes are placed, MSMP unplaced, on 22 chromosomes including X", () => {
  assertEquals(layout.blocks.length, 114);
  assertEquals(
    layout.unplaced.map((g) => `${g.gene} ${g.chromosomalLocation}`),
    ["MSMP 9q13.3"],
  );
  assertEquals(layout.chromosomes.map((c) => c.name), DRAWN);
  assertEquals(layout.rows.map((row) => row.map((c) => c.name)), [
    DRAWN.slice(0, 10),
    DRAWN.slice(10),
  ]);
  assertEquals(layout.canvas, { width: 1732, height: 1640 });
  assertEquals(layout.blocks.map((b) => b.index), [...Array(114).keys()]);
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
  assertAlmostEquals(cenpf.markerY, 699.0086508393023, 1e-6);
  assertAlmostEquals(cenpf.y, 572, 1e-6);
});

Deno.test("pills and glyphs derive from the four evidence columns", () => {
  const labels = (s: string) => byGene.get(s)!.pills.map((p) => p.label);
  const glyphs = (s: string) => byGene.get(s)!.glyphs.map((g) => g.key);
  assertEquals(labels("LAMB1"), []);
  assertEquals(glyphs("LAMB1"), ["monogenic"]);
  assertEquals(labels("JAK1"), ["PSMD"]);
  assertEquals(glyphs("JAK1"), ["omics", "monogenic"]);
  assertEquals(labels("PCSK9"), []);
  assertEquals(glyphs("PCSK9"), ["omics", "monogenic", "mr"]);
  assertEquals(labels("TLR1"), []);
  assertEquals(glyphs("TLR1"), ["omics", "mr"]);
  assertEquals(labels("CENPF"), ["WM-PVS", "HIP-PVS", "PSMD"]);
  // Gold gives CENPF no other-omics entry, so the omics glyph is gone.
  assertEquals(glyphs("CENPF"), ["monogenic"]);
  // The gold table's four. The pipeline's re-extractions had taken it to
  // eight; gold-only publishes the curated row alone. The labels are the
  // encoding's display forms.
  assertEquals(labels("COL4A1/2"), [
    "WMH",
    "SVS",
    "MD",
    "MTAG (all ICH, SVS, WMH, FA, MD, AD)",
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
  // CENPF carried the omics glyph before gold-only; JAK1 still does.
  assertEquals(byGene.get("JAK1")!.glyphs[0], {
    key: "omics",
    label: "Other omics",
    shape: "triangle",
  });
});

Deno.test("the legend lists the eight families with every trait", () => {
  assertEquals(layout.legend.families.map((f) => f.family.key), [
    "pvs",
    "diffusion",
    "extreme",
    "wmh",
    "stroke",
    "cmb",
    "lacunes",
    "ich",
  ]);
  assertEquals(
    layout.legend.families.reduce((n, f) => n + f.traits.length, 0),
    vocabulary.traits.length,
  );
});
