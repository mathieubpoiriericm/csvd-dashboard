import { assert, assertEquals } from "@std/assert";

import appearance from "../lib/phenogram_encoding.json" with { type: "json" };
import families from "../disease/phenogram.json" with { type: "json" };
import vocabulary from "../disease/vocabulary.json" with { type: "json" };
import { encoding as composed } from "../lib/phenogram.ts";
import { GWAS_TRAIT_CHOICES, NONE_FOUND, SHOW_ALL } from "../lib/constants.ts";
import { STAINS } from "../lib/cytobands.ts";
import { genes } from "../lib/data.ts";
import { deltaE, HEX, oklab } from "./helpers/colour.ts";

/**
 * `disease/vocabulary.json` is the one place a GWAS trait gets its key, label,
 * family and definition; `lib/phenogram_encoding.json` carries appearance only.
 * Two renderers compose them — `lib/phenogram.ts` for the island and
 * `scripts/phenogram_figure.py` for print. These assertions make the committed
 * data, the filter choices and the vocabulary fail together. The two palette gates that need no colour-blindness simulation are
 * re-checked here; the CVD result (worst adjacent ΔE 9.2) is recorded in the
 * design spec and was computed at design time.
 */

// Order is the disease's, read from its file; the assertions below check the
// vocabulary groups into exactly these families in exactly this order.
const FAMILY_ORDER = families.families.map((f) => f.key);

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

  const familyKeys = families.families.map((f) => f.key);
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
  for (const family of families.families) {
    assert(
      vocabulary.traits.some((t) => t.family === family.key),
      `${family.key} has no traits`,
    );
  }
});

Deno.test("the family keys equal the set of vocabulary families", () => {
  const used = new Set(vocabulary.traits.map((t) => t.family));
  assertEquals(new Set(FAMILY_ORDER), used);
});

Deno.test("every GWAS trait in the committed data has an entry", () => {
  const keys = new Set(vocabulary.traits.map((t) => t.key));
  const missing = [...new Set(genes.flatMap((g) => g.gwasTrait))]
    .filter((value) => value !== NONE_FOUND && !keys.has(value));
  assertEquals(missing, [], `traits without an encoding: ${missing}`);
});

Deno.test("family hues pass the lightness band and the adjacent normal-vision floor", () => {
  const hues = families.families.map((f) => f.hue);
  for (const family of families.families) {
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
      `${families.families[i - 1].key}/${families.families[i].key}: ΔE ${
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
  assertEquals(Object.keys(appearance.glyphs).sort(), [
    "square",
    "star",
    "triangle",
  ]);
  for (const [shape, geometry] of Object.entries(appearance.glyphs)) {
    assert(
      geometry.scale > 0 && geometry.scale <= 1,
      `${shape}: scale ${geometry.scale} outside (0, 1]`,
    );
  }
  const star = appearance.glyphs.star;
  assert("innerRatio" in star, "star: no innerRatio");
  assert(
    star.innerRatio >= 0.3 && star.innerRatio <= 0.7,
    `star: innerRatio ${star.innerRatio} stops reading as a star`,
  );
  // The composed encoding is what both renderers actually consume.
  assertEquals(composed.glyphs, appearance.glyphs);
});

/**
 * Ink is area, not bounding box. Square = s^2, apex-up triangle = s^2/2, and a
 * five-pointed star = 5 * R * r * sin36. Pinned as a ratio rather than as three
 * absolutes so the set can be rescaled without editing the test, and bounded at
 * 1.75 because that is the gap this encoding exists to close.
 */
Deno.test("the three glyphs carry comparable ink", () => {
  const box = appearance.layout.symbolLine; // any constant; ratios are scale-free
  const areaOf = (shape: string): number => {
    const g = appearance.glyphs[shape as keyof typeof appearance.glyphs];
    const size = box * g.scale;
    if (shape === "square") return size * size;
    if (shape === "triangle") return (size * size) / 2;
    const outer = size / 2;
    const inner = outer * appearance.glyphs.star.innerRatio;
    return 5 * outer * inner * Math.sin(Math.PI / 5);
  };
  const areas = ["square", "triangle", "star"].map(areaOf);
  const spread = Math.max(...areas) / Math.min(...areas);
  assert(
    spread <= 1.75,
    `glyph ink spread ${spread.toFixed(2)}x: ${areas.map((a) => a.toFixed(1))}`,
  );
});

Deno.test("evidence glyphs and the stains are complete", () => {
  assertEquals(appearance.evidence.map((e) => e.key), [
    "omics",
    "monogenic",
    "mr",
  ]);
  for (const entry of appearance.evidence) {
    assert(["triangle", "square", "star"].includes(entry.shape), entry.key);
    assert(
      entry.shape in appearance.glyphs,
      `${entry.key}: shape has no geometry`,
    );
  }
  assertEquals(Object.keys(appearance.stains).sort(), [...STAINS].sort());
  for (const value of Object.values(appearance.stains)) {
    assert(HEX.test(value));
  }
  for (const trait of vocabulary.traits.filter((t) => "standard" in t)) {
    assert(
      "definition" in trait,
      `${trait.key}: standard without a definition`,
    );
  }
});

Deno.test("the layout constants fit ten columns and two rows on the canvas", () => {
  const L = appearance.layout;
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
