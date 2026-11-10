/** The export palette must track the light tokens in assets/app.css. */
import { assert, assertEquals } from "@std/assert";

import {
  PILL_FONT_SIZE,
  SYMBOL_FONT_SIZE,
} from "../components/PhenogramShapes.tsx";
import { sampleGene } from "./fixtures/rows.ts";

import {
  computePhenogramLayout,
  encoding,
  type PhenogramLayout,
} from "../lib/phenogram.ts";
import {
  exportFontTexts,
  figureTextWidths,
  KEY_FONTS,
  type KeyLayout,
  type KeyPill,
  type KeyText,
  layoutPhenogramKey,
  type MeasureText,
  phenogramDocumentWidth,
  phenogramFileName,
  phenogramKeyMinWidth,
  phenogramKeyWidth,
  SVG_PALETTE,
} from "../lib/phenogram_svg.ts";

const css = await Deno.readTextFile(
  new URL("../assets/app.css", import.meta.url),
);
// The light theme is the first `:root` block, ending before the dark query.
const light = css.slice(
  css.indexOf(":root {"),
  css.indexOf("@media (prefers-color-scheme: dark)"),
);
const lines = light.split("\n").map((l) => l.trim());

function declaration(name: string): string {
  const line = lines.find((l) => l.startsWith(`--svd-${name}:`));
  assert(line, `--svd-${name} is not defined in the light block`);
  return line;
}

function primitiveHex(name: string): string {
  const hex = declaration(name).match(/\/\*\s*(#[0-9a-f]{6})/i)?.[1];
  assert(hex, `--svd-${name} has no hex comment`);
  return hex.toLowerCase();
}

function value(name: string): string {
  return declaration(name).match(/:\s*([^;]+);/)![1].trim();
}

Deno.test("SVG_PALETTE matches the light tokens in app.css", () => {
  assertEquals(SVG_PALETTE.ink, primitiveHex("slate-950"));
  assertEquals(SVG_PALETTE.inkMuted, primitiveHex("slate-700"));
  assertEquals(SVG_PALETTE.lineStrong, primitiveHex("slate-400"));
  assertEquals(value("white"), "#fff");
  assertEquals(SVG_PALETTE.plate, "#ffffff");
  assertEquals(value("ink"), "var(--svd-slate-950)");
  assertEquals(value("figure-ink"), "var(--svd-slate-950)");
  assertEquals(value("ink-muted"), "var(--svd-slate-700)");
  assertEquals(value("line-strong"), "var(--svd-slate-400)");
  assertEquals(value("figure-plate"), "var(--svd-white)");
});

const measure: MeasureText = (text, font) => text.length * font.size * 0.5;
const PANEL_GAP = 40;

type Legend = PhenogramLayout["legend"];

function makeLegend(families: number, traitsEach: number): Legend {
  return {
    evidence: encoding.evidence,
    families: Array.from({ length: families }, (_, i) => ({
      family: {
        key: `f${i}`,
        label: `Family ${i}`,
        hue: `#00${i}000`,
        tint: `#ff${i}fff`,
      },
      traits: Array.from({ length: traitsEach }, (_, j) => ({
        key: `t${i}-${j}`,
        label: `Trait number ${i}-${j}`,
        family: `f${i}`,
        name: `t${i}-${j}`,
      })),
    })),
  };
}

function allTexts(layout: KeyLayout): KeyText[] {
  return layout.panels.flatMap((p) => [
    p.title,
    ...p.texts,
    ...p.pills.map((x) => x.label),
    ...p.groups.flatMap((g) => [
      ...g.texts,
      ...g.pills.map((x) => x.label),
    ]),
  ]);
}

function allPills(layout: KeyLayout): KeyPill[] {
  return layout.panels.flatMap((p) => [
    ...p.pills,
    ...p.groups.flatMap((g) => g.pills),
  ]);
}

Deno.test("KEY_FONTS pins the sizes", () => {
  assertEquals(KEY_FONTS, {
    title: { family: "Barlow Condensed", weight: 600, size: 15 },
    item: { family: "Barlow", weight: 400, size: 12 },
    family: { family: "Barlow", weight: 600, size: 12 },
    pill: { family: "Barlow", weight: 400, size: 9.5 },
  });
});

Deno.test("the key splits the width one third to two", () => {
  const width = 1672;
  const third = (width - PANEL_GAP) / 3;
  const layout = layoutPhenogramKey(makeLegend(6, 8), width, measure);
  assertEquals(layout.width, width);
  const [a, b] = layout.panels;
  const aRight = Math.max(
    ...[a.title, ...a.texts].map((t) => t.x + measure(t.text, t.font)),
    ...a.pills.map((p) => p.x + p.width),
  );
  assert(aRight <= third);
  assertEquals(b.title.x, third + PANEL_GAP);
  const bPills = b.groups.flatMap((g) => g.pills);
  assert(Math.min(...bPills.map((p) => p.x)) >= third + PANEL_GAP);
  assert(Math.max(...bPills.map((p) => p.x + p.width)) <= width);
});

Deno.test("the evidence panel lists the sample pill then one row per evidence", () => {
  const legend = makeLegend(1, 1);
  const [panel] = layoutPhenogramKey(legend, 1672, measure).panels;
  assertEquals(panel.id, "key-evidence");
  assertEquals(panel.title.text, "Supporting evidence");
  assertEquals(panel.title.fill, SVG_PALETTE.ink);
  assertEquals(panel.groups, []);
  assertEquals(panel.pills.length, 1);
  assertEquals(panel.pills[0].label.text, "GWAS");
  assertEquals(panel.pills[0].fill, "none");
  assertEquals(panel.pills[0].stroke, SVG_PALETTE.lineStrong);
  assertEquals(panel.glyphs.length, legend.evidence.length);
  assertEquals(
    panel.glyphs.map((g) => g.shape),
    legend.evidence.map((e) => e.shape),
  );
  assert(panel.glyphs.every((g) => g.size === 9));
  assertEquals(panel.texts.map((t) => t.text), [
    "one pill per associated phenotype",
    ...legend.evidence.map((e) => e.label),
  ]);
  assert(panel.texts.every((t) => t.fill === SVG_PALETTE.ink));
});

Deno.test("family names are uppercase and muted", () => {
  const legend = makeLegend(3, 2);
  const [, panel] = layoutPhenogramKey(legend, 1672, measure).panels;
  assertEquals(panel.id, "key-phenotypes");
  assertEquals(panel.title.text, "GWAS phenotypes");
  assertEquals(panel.groups.length, 3);
  panel.groups.forEach((g, i) => {
    assertEquals(g.label, legend.families[i].family.label);
    const [name] = g.texts;
    assertEquals(name.text, legend.families[i].family.label.toUpperCase());
    assertEquals(name.fill, SVG_PALETTE.inkMuted);
    assertEquals(name.letterSpacing, 0.48);
    assertEquals(g.swatches.length, 1);
    assertEquals(g.swatches[0].fill, legend.families[i].family.hue);
    assertEquals(g.swatches[0].r, 4.5);
  });
});

Deno.test("phenotype pills use the family colours and square corners", () => {
  const legend = makeLegend(2, 3);
  const [, panel] = layoutPhenogramKey(legend, 1672, measure).panels;
  panel.groups.forEach((g, i) => {
    const { family, traits } = legend.families[i];
    assertEquals(g.pills.length, traits.length);
    g.pills.forEach((pill, j) => {
      assertEquals(pill.fill, family.tint);
      assertEquals(pill.stroke, family.hue);
      assertEquals(
        pill.width,
        measure(traits[j].label, KEY_FONTS.pill) + 10,
      );
      assertEquals(pill.height, 12);
      assertEquals(pill.label.text, traits[j].label);
      assertEquals(pill.label.font, KEY_FONTS.pill);
      assertEquals(pill.label.fill, SVG_PALETTE.ink);
    });
  });
});

Deno.test("pills wrap inside their column and never overlap", () => {
  const width = 900;
  const layout = layoutPhenogramKey(makeLegend(5, 30), width, measure);
  const panel = layout.panels[1];
  const left = (width - PANEL_GAP) / 3 + PANEL_GAP;
  const w = width - left;
  const n = Math.max(1, Math.floor((w + 24) / 244));
  const colWidth = (w - (n - 1) * 24) / n;
  panel.groups.forEach((g, i) => {
    const colLeft = left + (i % n) * (colWidth + 24);
    for (const p of g.pills) {
      assert(p.x >= colLeft);
      assert(p.x + p.width <= colLeft + colWidth + 1e-9);
    }
  });
  const pills = panel.groups.flatMap((g) => g.pills);
  assert(new Set(pills.map((p) => p.y)).size > 5, "pills wrap");
  for (let i = 0; i < pills.length; i++) {
    for (let j = i + 1; j < pills.length; j++) {
      const a = pills[i], b = pills[j];
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x ||
        a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert(apart, `pills ${i} and ${j} overlap`);
    }
  }
});

Deno.test("an over-wide pill still gets a line of its own", () => {
  const legend = makeLegend(1, 1);
  legend.families[0].traits[0].label = "x".repeat(200);
  const [, panel] = layoutPhenogramKey(legend, 700, measure).panels;
  assertEquals(panel.groups[0].pills.length, 1);
});

Deno.test("families flow row-major in columns of at least 220 units", () => {
  const width = 1672;
  const legend = makeLegend(7, 1);
  legend.families[1].traits = makeLegend(1, 40).families[0].traits;
  const panel = layoutPhenogramKey(legend, width, measure).panels[1];
  const left = (width - PANEL_GAP) / 3 + PANEL_GAP;
  const w = width - left;
  const n = Math.max(1, Math.floor((w + 24) / 244));
  assert(n > 1);
  const colWidth = (w - (n - 1) * 24) / n;
  assert(colWidth >= 220);
  const rowTop = (i: number) => panel.groups[i].swatches[0].cy - 6;
  const extent = (i: number) =>
    Math.max(...panel.groups[i].pills.map((p) => p.y + p.height)) - rowTop(i);
  panel.groups.forEach((g, i) => {
    assertEquals(g.swatches[0].cx, left + (i % n) * (colWidth + 24) + 4.5);
    if (i % n === 0 && i > 0) {
      const prev = Array.from({ length: n }, (_, k) => i - n + k);
      assertEquals(
        rowTop(i),
        rowTop(i - n) + Math.max(...prev.map(extent)) + 16,
      );
    }
  });
  assert(extent(1) > extent(0), "the tall family sets its row height");
});

Deno.test("nothing in the key overlaps", () => {
  const layout = layoutPhenogramKey(makeLegend(7, 12), 1672, measure);
  const boxes = allTexts(layout).map((t) => ({
    x: t.x,
    y: t.y - t.font.size,
    w: measure(t.text, t.font),
    h: t.font.size,
  }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x ||
        a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert(apart, `texts ${i} and ${j} overlap`);
    }
  }
});

Deno.test("a key with no families has a title only", () => {
  const layout = layoutPhenogramKey(makeLegend(0, 0), 1672, measure);
  const panel = layout.panels[1];
  assertEquals(panel.groups, []);
  assertEquals(panel.texts, []);
  assertEquals(panel.pills, []);
  assert(Number.isFinite(layout.height) && layout.height > 0);
});

Deno.test("the key height covers the tallest panel", () => {
  const layout = layoutPhenogramKey(makeLegend(7, 12), 1672, measure);
  const bottoms = allPills(layout).map((p) => p.y + p.height);
  const glyphBottoms = layout.panels[0].glyphs.map((g) => g.y + g.size);
  assert(layout.height >= Math.max(...bottoms, ...glyphBottoms));
  const tall = layoutPhenogramKey(makeLegend(7, 80), 1672, measure);
  assert(tall.height > layout.height);
});

Deno.test("phenogramFileName uses the local date, day first", () => {
  const date = new Date(2026, 10, 9);
  assertEquals(
    phenogramFileName(false, date, "x"),
    "x-dashboard-phenogram_09-11-2026.svg",
  );
  assertEquals(
    phenogramFileName(true, date, "x"),
    "x-dashboard-phenogram-key_09-11-2026.svg",
  );
});

Deno.test("figureTextWidths keys every symbol and pill as Block reads them", () => {
  const { blocks } = computePhenogramLayout([
    sampleGene({
      gene: "GENE1",
      chromosomalLocation: "1p36.32",
      gwasTrait: [encoding.traits[0].key, encoding.traits[1].key],
    }),
  ]);
  const seen: [string, number][] = [];
  const widths = figureTextWidths(blocks, (text, font) => {
    seen.push([text, font.size]);
    return text.length;
  });
  const block = blocks[0];
  assertEquals(widths.get(`symbol-${block.index}`), "GENE1".length);
  assert(block.pills.length > 0);
  block.pills.forEach((pill, i) =>
    assertEquals(widths.get(`pill-${block.index}-${i}`), pill.label.length)
  );
  assertEquals(widths.size, 1 + block.pills.length);
  assertEquals(seen[0], ["GENE1", SYMBOL_FONT_SIZE]);
  assertEquals(seen[1][1], PILL_FONT_SIZE);
});

/** Every text's box, letter spacing included, and every pill's. */
function keyBoxes(layout: KeyLayout) {
  const texts = allTexts(layout).map((t) => ({
    label: t.text,
    x: t.x,
    y: t.y - t.font.size,
    w: measure(t.text, t.font) + (t.letterSpacing ?? 0) * t.text.length,
    h: t.font.size,
  }));
  return texts;
}

function assertNoOverlap(layout: KeyLayout) {
  const boxes = keyBoxes(layout);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x ||
        a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert(apart, `${a.label} / ${b.label} overlap`);
    }
  }
  for (const box of boxes) {
    assert(box.x + box.w <= layout.width + 1e-9, `${box.label} leaves the key`);
  }
  for (const pill of allPills(layout)) {
    assert(pill.x + pill.width <= layout.width + 1e-9, pill.label.text);
  }
}

Deno.test("a narrow karyogram's key is laid out at its minimum width, without overlap", () => {
  const margin = encoding.layout.margin;
  // The empty-data canvas: one empty column.
  const empty = computePhenogramLayout([]);
  for (
    const legend of [makeLegend(0, 0), makeLegend(1, 3), makeLegend(7, 12)]
  ) {
    const min = phenogramKeyMinWidth(legend, measure);
    const width = phenogramKeyWidth(
      empty.canvas.width,
      margin,
      legend,
      measure,
    );
    assertEquals(width, min);
    assert(width > empty.canvas.width - 2 * margin);
    const layout = layoutPhenogramKey(legend, width, measure);
    assertNoOverlap(layout);
    // The page is wide enough for the key and its margins.
    const page = phenogramDocumentWidth(empty.canvas.width, margin, layout);
    assertEquals(page, layout.width + 2 * margin);
    assert(page > empty.canvas.width);
  }
});

Deno.test("the minimum key width covers the widest family name and pill", () => {
  const legend = makeLegend(2, 2);
  legend.families[1].family.label = "A family name far wider than a column";
  legend.families[0].traits[1].label = "x".repeat(90);
  const min = phenogramKeyMinWidth(legend, measure);
  const layout = layoutPhenogramKey(legend, min, measure);
  assertNoOverlap(layout);
  assert(min >= PANEL_GAP + 1.5 * 220, "one column of at least COLUMN_MIN");
});

Deno.test("a key wider than its minimum is untouched, and so is a wide page", () => {
  const legend = makeLegend(7, 12);
  const margin = encoding.layout.margin;
  assertEquals(phenogramKeyWidth(1732, margin, legend, measure), 1672);
  assertEquals(phenogramDocumentWidth(1732, margin, { width: 1672 }), 1732);
  assertEquals(phenogramDocumentWidth(188, margin, null), 188);
});

Deno.test("exportFontTexts names every character each face sets", () => {
  const karyogram = computePhenogramLayout([
    sampleGene({
      gene: "G\u0141NE1",
      chromosomalLocation: "1p36.32",
      gwasTrait: [encoding.traits[0].key],
    }),
  ]);
  const legend: PhenogramLayout["legend"] = {
    evidence: [{ ...karyogram.legend.evidence[0], label: "Evid\u0119nce" }],
    families: karyogram.legend.families.slice(0, 1).map((entry) => ({
      family: { ...entry.family, label: "fam\u015b" },
      traits: entry.traits.map((t) => ({ ...t, label: "tr\u0105it" })),
    })),
  };
  const face = (texts: ReturnType<typeof exportFontTexts>, f: string) => {
    const hit = texts.filter((t) => t.font === f);
    assertEquals(hit.length, 1, f);
    return hit[0].text;
  };
  const has = (text: string, chars: string) =>
    [...chars].every((c) => text.includes(c));

  const figure = exportFontTexts({ ...karyogram, legend }, false);
  assertEquals(figure.map((t) => t.font).sort(), [
    '400 9.5px "Barlow"',
    '600 12px "Barlow"',
  ]);
  // The symbol and the chromosome's name are bold; the pill is regular.
  assert(has(face(figure, '600 12px "Barlow"'), "G\u0141NE1"));
  assert(
    has(face(figure, '400 9.5px "Barlow"'), karyogram.blocks[0].pills[0].label),
  );
  assert(!face(figure, '400 9.5px "Barlow"').includes("\u0105"));

  const withKey = exportFontTexts({ ...karyogram, legend }, true);
  // The family name is drawn in capitals, so the capital is what must load.
  assert(has(face(withKey, '600 12px "Barlow"'), "G\u0141NE1FAM\u015a"));
  assert(has(face(withKey, '400 9.5px "Barlow"'), "tr\u0105itGWAS"));
  assert(has(face(withKey, '400 12px "Barlow"'), "Evid\u0119nce"));
  assert(
    has(face(withKey, '600 15px "Barlow Condensed"'), "Supporting evidence"),
  );
});
