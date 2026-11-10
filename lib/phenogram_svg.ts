import type { GeneBlock, PhenogramLayout } from "./phenogram.ts";

/**
 * The phenogram's SVG export: colours the live figure takes from CSS tokens,
 * written out as literals because an exported file has no stylesheet.
 *
 * These are the light-theme values; `tests/phenogram_svg_test.ts` reads
 * `assets/app.css` and fails when a token is retuned without this table.
 */
export const SVG_PALETTE = {
  /** `--svd-figure-ink` / `--svd-ink` (slate-950). */
  ink: "#1d1f20",
  /** `--svd-ink-muted` (slate-700). */
  inkMuted: "#5d5d60",
  /** `--svd-line-strong` (slate-400). */
  lineStrong: "#b7b7ba",
  /** `--svd-figure-plate` (white). */
  plate: "#ffffff",
} as const;

export interface KeyFont {
  family: "Barlow" | "Barlow Condensed";
  weight: 400 | 600;
  size: number;
}

/** Width in viewBox units of `text` set in `font`. */
export type MeasureText = (text: string, font: KeyFont) => number;

/** Sizes in viewBox units, matching the live key at the figure's scale. */
export const KEY_FONTS = {
  title: { family: "Barlow Condensed", weight: 600, size: 15 },
  item: { family: "Barlow", weight: 400, size: 12 },
  family: { family: "Barlow", weight: 600, size: 12 },
  pill: { family: "Barlow", weight: 400, size: 9.5 },
} as const satisfies Record<string, KeyFont>;

/** `y` is the text's baseline. */
export interface KeyText {
  x: number;
  y: number;
  text: string;
  font: KeyFont;
  fill: string;
  letterSpacing?: number;
}

export interface KeyPill {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  label: KeyText;
}

/** `x`, `y` are the top-left of the `size` box. */
export interface KeyGlyph {
  shape: string;
  x: number;
  y: number;
  size: number;
}

export interface KeySwatch {
  cx: number;
  cy: number;
  r: number;
  fill: string;
}

export interface KeyPanel {
  id: "key-evidence" | "key-phenotypes";
  title: KeyText;
  texts: KeyText[];
  pills: KeyPill[];
  glyphs: KeyGlyph[];
  swatches: KeySwatch[];
  groups: {
    label: string;
    texts: KeyText[];
    pills: KeyPill[];
    swatches: KeySwatch[];
  }[];
}

/** Coordinates are relative to the key's top-left corner. */
export interface KeyLayout {
  width: number;
  height: number;
  panels: [KeyPanel, KeyPanel];
}

const PANEL_GAP = 40;
const TITLE_LINE = 22;
const TITLE_TO_LIST = 8;
const TITLE_BASELINE = 15;
const LIST_TOP = TITLE_LINE + TITLE_TO_LIST;
const EVIDENCE_PITCH = 18;
const GLYPH_SIZE = 9;
const GLYPH_TO_TEXT = 8;
const COLUMN_MIN = 220;
const COLUMN_GAP = 24;
const FAMILY_ROW_GAP = 16;
const SWATCH_R = 4.5;
const SWATCH_TO_NAME = 8;
const NAME_LINE = 12;
const NAME_TO_PILLS = 6;
const PILL_HEIGHT = 12;
const PILL_PAD_X = 5;
const PILL_GAP = 4;
const PILL_PITCH = 16;
/** Baseline of a 9.5-unit label centred in a 12-unit pill. */
const PILL_BASELINE = 9;
const PHENOTYPE_TITLE = "GWAS phenotypes";

function pill(
  x: number,
  y: number,
  label: string,
  fill: string,
  stroke: string,
  measure: MeasureText,
): KeyPill {
  return {
    x,
    y,
    width: measure(label, KEY_FONTS.pill) + 2 * PILL_PAD_X,
    height: PILL_HEIGHT,
    fill,
    stroke,
    label: {
      x: x + PILL_PAD_X,
      y: y + PILL_BASELINE,
      text: label,
      font: KEY_FONTS.pill,
      fill: SVG_PALETTE.ink,
    },
  };
}

function title(x: number, text: string): KeyText {
  return {
    x,
    y: TITLE_BASELINE,
    text,
    font: KEY_FONTS.title,
    fill: SVG_PALETTE.ink,
  };
}

function evidencePanel(
  evidence: PhenogramLayout["legend"]["evidence"],
  measure: MeasureText,
): KeyPanel {
  const item = (x: number, rowTop: number, text: string): KeyText => ({
    x,
    y: rowTop + 13,
    text,
    font: KEY_FONTS.item,
    fill: SVG_PALETTE.ink,
  });
  const sample = pill(
    0,
    LIST_TOP + (EVIDENCE_PITCH - PILL_HEIGHT) / 2,
    "GWAS",
    "none",
    SVG_PALETTE.lineStrong,
    measure,
  );
  const texts = [
    item(
      sample.width + GLYPH_TO_TEXT,
      LIST_TOP,
      "one pill per associated phenotype",
    ),
  ];
  const glyphs: KeyGlyph[] = [];
  evidence.forEach((entry, i) => {
    const rowTop = LIST_TOP + (i + 1) * EVIDENCE_PITCH;
    glyphs.push({
      shape: entry.shape,
      x: 0,
      y: rowTop + (EVIDENCE_PITCH - GLYPH_SIZE) / 2,
      size: GLYPH_SIZE,
    });
    texts.push(item(GLYPH_SIZE + GLYPH_TO_TEXT, rowTop, entry.label));
  });
  return {
    id: "key-evidence",
    title: title(0, "Supporting evidence"),
    texts,
    pills: [sample],
    glyphs,
    swatches: [],
    groups: [],
  };
}

/** Letter spacing of a family name, which is set in capitals. */
const FAMILY_TRACKING = 0.04 * KEY_FONTS.family.size;

/**
 * The narrowest a family column may be: `COLUMN_MIN`, or wider for a family
 * name or a single pill that would not fit it, so no column's content runs
 * into the next column or off the key.
 */
function familyColumnMin(
  families: PhenogramLayout["legend"]["families"],
  measure: MeasureText,
): number {
  return Math.max(
    COLUMN_MIN,
    ...families.flatMap(({ family, traits }) => {
      const name = family.label.toUpperCase();
      return [
        2 * SWATCH_R + SWATCH_TO_NAME + measure(name, KEY_FONTS.family) +
        FAMILY_TRACKING * [...name].length,
        ...traits.map((t) => measure(t.label, KEY_FONTS.pill) + 2 * PILL_PAD_X),
      ];
    }),
  );
}

function phenotypePanel(
  families: PhenogramLayout["legend"]["families"],
  left: number,
  width: number,
  measure: MeasureText,
): KeyPanel {
  const columns = Math.max(
    1,
    Math.floor(
      (width + COLUMN_GAP) /
        (familyColumnMin(families, measure) + COLUMN_GAP),
    ),
  );
  const columnWidth = (width - (columns - 1) * COLUMN_GAP) / columns;
  const groups: KeyPanel["groups"] = [];
  let rowTop = LIST_TOP;
  let rowHeight = 0;
  families.forEach(({ family, traits }, i) => {
    const column = i % columns;
    if (column === 0 && i > 0) {
      rowTop += rowHeight + FAMILY_ROW_GAP;
      rowHeight = 0;
    }
    const x = left + column * (columnWidth + COLUMN_GAP);
    const pills: KeyPill[] = [];
    let px = 0;
    let py = rowTop + NAME_LINE + NAME_TO_PILLS;
    for (const trait of traits) {
      let placed = pill(
        x + px,
        py,
        trait.label,
        family.tint,
        family.hue,
        measure,
      );
      // A pill wider than the whole column still gets a line to itself.
      if (px > 0 && px + placed.width > columnWidth) {
        px = 0;
        py += PILL_PITCH;
        placed = pill(x, py, trait.label, family.tint, family.hue, measure);
      }
      pills.push(placed);
      px += placed.width + PILL_GAP;
    }
    rowHeight = Math.max(rowHeight, py + PILL_HEIGHT - rowTop);
    groups.push({
      label: family.label,
      texts: [{
        x: x + 2 * SWATCH_R + SWATCH_TO_NAME,
        y: rowTop + NAME_LINE - 2,
        text: family.label.toUpperCase(),
        font: KEY_FONTS.family,
        fill: SVG_PALETTE.inkMuted,
        letterSpacing: FAMILY_TRACKING,
      }],
      pills,
      swatches: [{
        cx: x + SWATCH_R,
        cy: rowTop + NAME_LINE / 2,
        r: SWATCH_R,
        fill: family.hue,
      }],
    });
  });
  return {
    id: "key-phenotypes",
    title: title(left, PHENOTYPE_TITLE),
    texts: [],
    pills: [],
    glyphs: [],
    swatches: [],
    groups,
  };
}

function panelBottom(panel: KeyPanel): number {
  const pills = [...panel.pills, ...panel.groups.flatMap((g) => g.pills)];
  return Math.max(
    TITLE_LINE,
    ...pills.map((p) => p.y + p.height),
    ...panel.glyphs.map((g) => g.y + g.size),
  );
}

/** Lays the key out in two panels, one third and two thirds of `width`. */
export function layoutPhenogramKey(
  legend: PhenogramLayout["legend"],
  width: number,
  measure: MeasureText,
): KeyLayout {
  const left = (width - PANEL_GAP) / 3 + PANEL_GAP;
  const panels: [KeyPanel, KeyPanel] = [
    evidencePanel(legend.evidence, measure),
    phenotypePanel(legend.families, left, width - left, measure),
  ];
  return {
    width,
    height: Math.max(panelBottom(panels[0]), panelBottom(panels[1])),
    panels,
  };
}

/** Right edge of everything a panel draws, from its own left edge at 0. */
function textRight(text: KeyText, measure: MeasureText): number {
  return text.x + measure(text.text, text.font) +
    (text.letterSpacing ?? 0) * [...text.text].length;
}

/**
 * The narrowest key `layoutPhenogramKey` lays out without overlap: the
 * evidence panel's widest line in its third, and in the other two thirds one
 * family column (`familyColumnMin`) or the phenotype title, whichever is
 * wider. A karyogram with few chromosomes is narrower than
 * this, so the export widens its page to the key rather than the reverse.
 */
export function phenogramKeyMinWidth(
  legend: PhenogramLayout["legend"],
  measure: MeasureText,
): number {
  const evidence = evidencePanel(legend.evidence, measure);
  const evidenceWidth = Math.max(
    ...[evidence.title, ...evidence.texts].map((t) => textRight(t, measure)),
    ...evidence.pills.map((p) => p.x + p.width),
  );
  const phenotypeWidth = Math.max(
    familyColumnMin(legend.families, measure),
    textRight(title(0, PHENOTYPE_TITLE), measure),
  );
  // The evidence panel gets (width - gap) / 3 and the phenotypes twice that.
  return Math.ceil(
    PANEL_GAP + 3 * Math.max(evidenceWidth, phenotypeWidth / 2),
  );
}

/** The width the export lays its key out at: the karyogram's, or the key's minimum. */
export function phenogramKeyWidth(
  canvasWidth: number,
  margin: number,
  legend: PhenogramLayout["legend"],
  measure: MeasureText,
): number {
  return Math.max(
    canvasWidth - 2 * margin,
    phenogramKeyMinWidth(legend, measure),
  );
}

/** The exported document's width: the karyogram's canvas, widened to hold the key. */
export function phenogramDocumentWidth(
  canvasWidth: number,
  margin: number,
  key: Pick<KeyLayout, "width"> | null,
): number {
  return Math.max(canvasWidth, key ? key.width + 2 * margin : 0);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `<key>-dashboard-phenogram[-key]_DD-MM-YYYY.svg`, in local time. */
export function phenogramFileName(
  withKey: boolean,
  date: Date,
  diseaseKey: string,
): string {
  const stamp = `${pad2(date.getDate())}-${
    pad2(date.getMonth() + 1)
  }-${date.getFullYear()}`;
  const kind = withKey ? "-key" : "";
  return `${diseaseKey}-dashboard-phenogram${kind}_${stamp}.svg`;
}

/**
 * Widths of every gene symbol and pill label, keyed as the figure's `Block`
 * reads them: `symbol-N` and `pill-N-M`. The symbol is set as `KEY_FONTS.family`
 * and the pills as `KEY_FONTS.pill`, the figure's own sizes.
 */
export function figureTextWidths(
  blocks: readonly GeneBlock[],
  measure: MeasureText,
): Map<string, number> {
  const widths = new Map<string, number>();
  for (const block of blocks) {
    widths.set(
      `symbol-${block.index}`,
      measure(block.symbol, KEY_FONTS.family),
    );
    block.pills.forEach((pill, i) => {
      widths.set(
        `pill-${block.index}-${i}`,
        measure(pill.label, KEY_FONTS.pill),
      );
    });
  }
  return widths;
}

/** A face as `FontFaceSet.load()` takes it, and the characters set in it. */
export interface FontText {
  font: string;
  text: string;
}

/**
 * Every face the export sets text in, with the characters it sets in it.
 *
 * `document.fonts.load(font)` alone loads only the file whose `unicode-range`
 * holds a space, which is the latin one: a label with a latin-ext letter was
 * then measured in the fallback face on the first download, about a tenth too
 * wide, and in Barlow on the second. The key's strings are read off a layout
 * rather than restated, so a string added there cannot be missed here.
 */
export function exportFontTexts(
  karyogram: Pick<PhenogramLayout, "blocks" | "chromosomes" | "legend">,
  withKey: boolean,
): FontText[] {
  const chars = new Map<string, Set<string>>();
  const add = (font: KeyFont, text: string) => {
    const css = `${font.weight} ${font.size}px "${font.family}"`;
    const set = chars.get(css) ?? new Set<string>();
    for (const ch of text) set.add(ch);
    chars.set(css, set);
  };
  // The figure's bold text, the symbols and the chromosome names, is one face.
  for (const shape of karyogram.chromosomes) add(KEY_FONTS.family, shape.name);
  for (const block of karyogram.blocks) {
    add(KEY_FONTS.family, block.symbol);
    for (const pill of block.pills) add(KEY_FONTS.pill, pill.label);
  }
  if (withKey) {
    const key = layoutPhenogramKey(karyogram.legend, 0, () => 0);
    for (const panel of key.panels) {
      const texts = [
        panel.title,
        ...panel.texts,
        ...panel.pills.map((p) => p.label),
        ...panel.groups.flatMap((g) => [
          ...g.texts,
          ...g.pills.map((p) => p.label),
        ]),
      ];
      for (const text of texts) add(text.font, text.text);
    }
  }
  return [...chars].map(([font, set]) => ({ font, text: [...set].join("") }));
}
