import { assert, assertEquals } from "@std/assert";

import encoding from "../lib/phenogram_encoding.json" with { type: "json" };
import vocabulary from "../lib/vocabulary.json" with { type: "json" };
import { encoding as composed } from "../lib/phenogram.ts";
import { GWAS_TRAIT_CHOICES, NONE_FOUND, SHOW_ALL } from "../lib/constants.ts";
import { STAINS } from "../lib/cytobands.ts";
import { genes } from "../lib/data.ts";

/**
 * `lib/vocabulary.json` is the one place a GWAS trait gets its key, label,
 * family and definition; `lib/phenogram_encoding.json` carries appearance only.
 * Two renderers compose them — `lib/phenogram.ts` for the island and
 * `scripts/phenogram_figure.py` for print. These assertions make the committed
 * data, the filter choices and the vocabulary fail together. The two palette gates that need no colour-blindness simulation are
 * re-checked here; the CVD result (worst adjacent ΔE 9.2) is recorded in the
 * design spec and was computed at design time.
 */

const HEX = /^#[0-9a-f]{6}$/;
const FAMILY_ORDER = [
  "pvs",
  "diffusion",
  "extreme",
  "wmh",
  "stroke",
  "cmb",
  "lacunes",
];

const linear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** sRGB hex → OKLab. */
function oklab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) =>
    linear(parseInt(hex.slice(i, i + 2), 16) / 255)
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Euclidean distance in OKLab × 100, the unit the design spec records. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return 100 * Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

Deno.test("the filter choices are derived from the vocabulary, not restated", () => {
  // Guards the regression this file exists for: `lacunar stroke` was once
  // "Lacunar Stroke" in lib/constants.ts and "Lacunar stroke" in the encoding,
  // and nothing compared the two files' labels. Re-hardcoding the list fails here.
  const derived = GWAS_TRAIT_CHOICES
    .filter((c) => c.value !== SHOW_ALL && c.value !== NONE_FOUND)
    .map((c) => ({ value: c.value, label: c.label }));
  assertEquals(
    derived,
    vocabulary.traits.map((t) => ({ value: t.key, label: t.label })),
  );
});

Deno.test("both renderers compose the same trait identity", () => {
  assertEquals(composed.traits, vocabulary.traits);
});

Deno.test("trait keys are exactly the GWAS filter values, grouped in family order", () => {
  const keys = vocabulary.traits.map((t) => t.key);
  const choices = GWAS_TRAIT_CHOICES.map((c) => c.value)
    .filter((v) => v !== SHOW_ALL && v !== NONE_FOUND);
  assertEquals([...keys].sort(), [...choices].sort());
  assertEquals(new Set(keys).size, keys.length, "trait keys repeat");

  const familyKeys = encoding.families.map((f) => f.key);
  assertEquals(familyKeys, FAMILY_ORDER);
  for (const trait of vocabulary.traits) {
    assert(familyKeys.includes(trait.family), `${trait.key}: unknown family`);
    assert(trait.label.length > 0 && trait.name.length > 0, trait.key);
  }
  // Grouped: the sequence of families never returns to an earlier one.
  const seen = vocabulary.traits.map((t) => familyKeys.indexOf(t.family));
  for (let i = 1; i < seen.length; i++) {
    assert(
      seen[i] >= seen[i - 1],
      `${vocabulary.traits[i].key} is out of family order`,
    );
  }
  for (const family of encoding.families) {
    assert(
      vocabulary.traits.some((t) => t.family === family.key),
      `${family.key} has no traits`,
    );
  }
});

Deno.test("every GWAS trait in the committed data has an entry", () => {
  const keys = new Set(vocabulary.traits.map((t) => t.key));
  const missing = [...new Set(genes.flatMap((g) => g.gwasTrait))]
    .filter((value) => value !== NONE_FOUND && !keys.has(value));
  assertEquals(missing, [], `traits without an encoding: ${missing}`);
});

Deno.test("family hues pass the lightness band and the adjacent normal-vision floor", () => {
  const hues = encoding.families.map((f) => f.hue);
  for (const family of encoding.families) {
    assert(HEX.test(family.hue), `${family.key}: bad hue`);
    assert(HEX.test(family.tint), `${family.key}: bad tint`);
    const [l] = oklab(family.hue);
    assert(
      l >= 0.43 && l <= 0.77,
      `${family.key}: hue lightness ${l.toFixed(3)}`,
    );
    const [tintL] = oklab(family.tint);
    assert(tintL >= 0.9, `${family.key}: tint too dark for ink`);
  }
  assertEquals(new Set(hues).size, hues.length, "two families share a hue");
  for (let i = 1; i < hues.length; i++) {
    const distance = deltaE(hues[i - 1], hues[i]);
    assert(
      distance >= 15,
      `${encoding.families[i - 1].key}/${encoding.families[i].key}: ΔE ${
        distance.toFixed(1)
      }`,
    );
  }
});

/**
 * The three glyphs are a symbol set, so they have to carry comparable ink. They
 * did not: a full-box square is 3.24x a 0.42-ratio star. `glyphs` holds the
 * linear scale that closes that, and both renderers read it -- the island
 * through `glyphPath`, the print script through `MarkerPath.unit_regular_star`
 * and a per-shape `markersize`. matplotlib's built-in `*` is hard-coded to
 * inner ratio 0.381966, so before this existed the two renderers drew
 * measurably different stars and nothing here could see it.
 */
Deno.test("every evidence glyph carries geometry both renderers can read", () => {
  assertEquals(Object.keys(encoding.glyphs).sort(), [
    "square",
    "star",
    "triangle",
  ]);
  for (const [shape, geometry] of Object.entries(encoding.glyphs)) {
    assert(
      geometry.scale > 0 && geometry.scale <= 1,
      `${shape}: scale ${geometry.scale} outside (0, 1]`,
    );
  }
  const star = encoding.glyphs.star;
  assert("innerRatio" in star, "star: no innerRatio");
  assert(
    star.innerRatio >= 0.3 && star.innerRatio <= 0.7,
    `star: innerRatio ${star.innerRatio} stops reading as a star`,
  );
  // The composed encoding is what both renderers actually consume.
  assertEquals(composed.glyphs, encoding.glyphs);
});

/**
 * Ink is area, not bounding box. Square = s^2, apex-up triangle = s^2/2, and a
 * five-pointed star = 5 * R * r * sin36. Pinned as a ratio rather than as three
 * absolutes so the set can be rescaled without editing the test, and bounded at
 * 1.75 because that is the gap this encoding exists to close.
 */
Deno.test("the three glyphs carry comparable ink", () => {
  const box = encoding.layout.symbolLine; // any constant; ratios are scale-free
  const areaOf = (shape: string): number => {
    const g = encoding.glyphs[shape as keyof typeof encoding.glyphs];
    const size = box * g.scale;
    if (shape === "square") return size * size;
    if (shape === "triangle") return (size * size) / 2;
    const outer = size / 2;
    const inner = outer * encoding.glyphs.star.innerRatio;
    return 5 * outer * inner * Math.sin(Math.PI / 5);
  };
  const areas = ["square", "triangle", "star"].map(areaOf);
  const spread = Math.max(...areas) / Math.min(...areas);
  assert(
    spread <= 1.75,
    `glyph ink spread ${spread.toFixed(2)}x: ${areas.map((a) => a.toFixed(1))}`,
  );
});

Deno.test("evidence glyphs, the citation and the stains are complete", () => {
  assertEquals(encoding.evidence.map((e) => e.key), [
    "omics",
    "monogenic",
    "mr",
  ]);
  for (const entry of encoding.evidence) {
    assert(["triangle", "square", "star"].includes(entry.shape), entry.key);
    assert(
      entry.shape in encoding.glyphs,
      `${entry.key}: shape has no geometry`,
    );
  }
  assert(encoding.citation.label.includes("Duering"));
  assertEquals(encoding.citation.doi, "10.1016/S1474-4422(23)00131-X");
  assertEquals(Object.keys(encoding.stains).sort(), [...STAINS].sort());
  for (const value of Object.values(encoding.stains)) assert(HEX.test(value));
  for (const trait of vocabulary.traits.filter((t) => "strive" in t)) {
    assert("definition" in trait, `${trait.key}: strive without a definition`);
  }
});

Deno.test("the layout constants fit ten columns and two rows on the canvas", () => {
  const L = encoding.layout;
  const pitch = L.chromosomeWidth + L.leaderGap + L.labelColumn;
  assert(
    2 * L.margin + 10 * pitch <= L.viewBox[0],
    "columns overflow the width",
  );
  assert(
    2 * L.margin + 2 * L.rowHeight + L.rowGap <= L.viewBox[1],
    "rows overflow the height",
  );
  for (
    const [name, value] of Object.entries(L).filter(([k]) =>
      k !== "viewBox" && k !== "rowSplitAfter"
    )
  ) {
    assert(typeof value === "number" && value > 0, `${name} must be positive`);
  }
  assertEquals(L.rowSplitAfter, "10");
});
