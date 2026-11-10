/**
 * Layout for the phenogram karyogram: chromosomes drawn to scale from the
 * hg38 cytobands, one marker per gene at the midpoint of its band, and a label
 * block beside the chromosome — the symbol with its evidence glyphs on the
 * first line, then one GWAS-phenotype pill per line. Pure functions over
 * `Gene` rows; no DOM, so the same code runs on the server, in the island and
 * under `deno test`.
 *
 * `scripts/phenogram_figure.py` implements this rule a second time for print.
 * Both read `lib/phenogram_encoding.json` for appearance, `disease/phenogram.json`
 * for the families and `disease/vocabulary.json` for trait identity --
 * together the only place colours, labels, definitions, band stains and the
 * geometry constants live — keep the *rule* here in step with the Python
 * twin (same names, same order of operations).
 *
 * Nothing about the canvas is fixed: each chromosome's label column is as wide
 * as its widest label, measured from `lib/phenogram_font_metrics.json` (the
 * shipped Barlow faces' advance widths, written by `deno task
 * phenogram:metrics`); the two rows split where they come out most even; and
 * the canvas is the drawing's own extent plus the margin.
 *
 * Coordinates are SVG user units, the figure's `viewBox` being `canvas`; y
 * grows down.
 */

import appearanceJson from "./phenogram_encoding.json" with { type: "json" };
import fontMetricsJson from "./phenogram_font_metrics.json" with {
  type: "json",
};
import familiesJson from "../disease/phenogram.json" with { type: "json" };
import vocabulary from "../disease/vocabulary.json" with { type: "json" };
import {
  type BandHit,
  cytobands as defaultCytobands,
  type CytobandTable,
  placeGene,
} from "./cytobands.ts";
import { groupBy, indexBy } from "./collections.ts";
import { hasRealValues, NONE_FOUND } from "./constants.ts";
import { normalize } from "./filters.ts";
import { GOLD_ONLY } from "./gold_only.ts";
import { CHROMOSOMES } from "./sorting.ts";
import type { Gene } from "./types.ts";

export interface FamilyEncoding {
  key: string;
  label: string;
  hue: string;
  tint: string;
}

export interface TraitEncoding {
  key: string;
  label: string;
  family: string;
  name: string;
  definition?: string;
  /** Has a definition quoted from the manifest's citation standard. */
  standard?: boolean;
  /** Ontology term, or null where no exact one exists. Internal, never published. */
  xref?: string | null;
  xrefLabel?: string;
  xrefNote?: string;
}

export interface EvidenceEncoding {
  key: string;
  label: string;
  shape: string;
}

/**
 * Geometry of one evidence glyph, in fractions of the 9-unit advance box.
 *
 * `scale` is linear, and exists because the three shapes are a symbol set that
 * has to carry comparable ink: a full-box square is 3.24x a 0.42-ratio star.
 * `lift` raises an apex-up triangle, whose centroid sits at a third of its
 * height and so reads low beside the bold gene symbol. `innerRatio` is the
 * star's waist -- named here rather than left to the renderer because
 * matplotlib's built-in `*` hard-codes 0.381966 and the island drew 0.42, so
 * the two figures carried visibly different stars.
 */
export interface GlyphGeometry {
  scale: number;
  lift?: number;
  innerRatio?: number;
}

export interface LayoutConstants {
  margin: number;
  rowHeight: number;
  rowGap: number;
  chromosomeWidth: number;
  leaderGap: number;
  /** The narrowest a label column gets; a wider label widens its own column. */
  labelColumn: number;
  /** Added to the widest label before rounding up: absorbs the kerning the metric table ignores. */
  labelSlack: number;
  blockGap: number;
  symbolLine: number;
  pillLine: number;
  blockPadding: number;
  /** Gene symbol size, set at weight 600. */
  symbolFont: number;
  /** Pill label size, set at weight 400. */
  pillFont: number;
  glyphSize: number;
  glyphGap: number;
  pillPaddingX: number;
}

/** Advance widths of the two Barlow weights, as `deno task phenogram:metrics` writes them. */
export interface FontMetrics {
  unitsPerEm: number;
  /** Weight to decimal code point to advance, in font units. */
  advances: Record<string, Record<string, number>>;
}

export interface PhenogramEncoding {
  families: FamilyEncoding[];
  traits: TraitEncoding[];
  evidence: EvidenceEncoding[];
  glyphs: Record<string, GlyphGeometry>;
  stains: Record<string, string>;
  layout: LayoutConstants;
}

// Appearance from the encoding, families from disease/, identity from the
// vocabulary. Composed here so every downstream consumer -- pills, legend,
// both renderers -- keeps reading one `encoding.families` / `encoding.traits`,
// while a family and a trait are each still defined in exactly one file.
export const encoding: PhenogramEncoding = {
  ...appearanceJson,
  families: familiesJson.families,
  traits: vocabulary.traits,
};

export const fontMetrics: FontMetrics = fontMetricsJson;

/** Baseline offset of a chromosome's name under its q-arm. */
export const CHROMOSOME_LABEL_OFFSET = 18;

/** Pill colours for a trait the encoding does not know — unreachable on committed data (the encoding test). */
const FALLBACK_PILL = { fill: "#ffffff", stroke: "#888888" };
const FALLBACK_STAIN = "#cccccc";

export interface Point {
  x: number;
  y: number;
}

export interface Span {
  y: number;
  height: number;
}

export interface BandShape {
  name: string;
  y: number;
  height: number;
  stain: string;
  fill: string;
}

export interface ChromosomeShape {
  name: string;
  length: number;
  row: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Width of the label column right of the leader gap. */
  columnWidth: number;
  bands: BandShape[];
  pArm: Span;
  centromere: Span;
  qArm: Span;
  labelPoint: Point;
}

export interface Pill {
  key: string;
  label: string;
  family: string;
  fill: string;
  stroke: string;
}

export interface Glyph {
  key: string;
  label: string;
  shape: string;
}

export interface GeneBlock {
  index: number;
  gene: Gene;
  symbol: string;
  chromosome: string;
  band: string;
  markerY: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pills: Pill[];
  glyphs: Glyph[];
  /** SVG path from the chromosome's right edge at the marker to the block's left-middle. */
  leader: string;
}

export interface LegendFamily {
  family: FamilyEncoding;
  traits: TraitEncoding[];
}

export interface PhenogramLayout {
  canvas: { width: number; height: number };
  rows: ChromosomeShape[][];
  chromosomes: ChromosomeShape[];
  blocks: GeneBlock[];
  unplaced: Gene[];
  legend: { families: LegendFamily[]; evidence: EvidenceEncoding[] };
}

const fixed = (n: number) => n.toFixed(2);

/** Height of a label block carrying `pillCount` pills. */
export function blockHeight(
  pillCount: number,
  layout: LayoutConstants = encoding.layout,
): number {
  return 2 * layout.blockPadding + layout.symbolLine +
    pillCount * layout.pillLine;
}

/** One pill per non-sentinel GWAS trait, in the table's order. */
export function pillsFor(
  gene: Gene,
  enc: PhenogramEncoding = encoding,
): Pill[] {
  const families = indexBy(enc.families, (f) => f.key);
  const traits = indexBy(enc.traits, (t) => t.key);
  return gene.gwasTrait
    .filter((value) => value !== NONE_FOUND)
    .map((value) => {
      const trait = traits.get(value);
      const family = trait ? families.get(trait.family) : undefined;
      return {
        key: value,
        label: trait?.label ?? value,
        family: trait?.family ?? "unknown",
        fill: family?.tint ?? FALLBACK_PILL.fill,
        stroke: family?.hue ?? FALLBACK_PILL.stroke,
      };
    });
}

/** Evidence glyphs in encoding order: other omics, monogenic disease, Mendelian randomization. */
export function glyphsFor(
  gene: Gene,
  enc: PhenogramEncoding = encoding,
): Glyph[] {
  const present: Record<string, boolean> = {
    omics: hasRealValues(gene.evidenceFromOtherOmicsStudies),
    monogenic: hasRealValues(gene.linkToMonogenicDisease),
    // Through the filters' rule: a raw compare drops the glyph — and the
    // gene's spoken evidence in `accessibleName` — for a value the sidebar
    // filter still matches.
    mr: normalize(gene.mendelianRandomization) === "yes",
  };
  return enc.evidence
    .filter((entry) => present[entry.key])
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      shape: entry.shape,
    }));
}

/**
 * Top edges for one chromosome's blocks. `desired` (sorted by marker) and
 * `heights` are parallel; the result keeps that order, separates neighbours
 * by `gap`, and stays inside `[top, bottom]` whenever the stack fits. A stack
 * taller than the row spills above `top` — the layout test pins that no
 * committed chromosome does. `scripts/phenogram_figure.py` carries the twin.
 */
export function resolveCollisions(
  desired: readonly number[],
  heights: readonly number[],
  top: number,
  bottom: number,
  gap: number,
): number[] {
  const y = desired.map((d, i) =>
    Math.min(Math.max(d, top), bottom - heights[i])
  );
  for (let i = 1; i < y.length; i++) {
    y[i] = Math.max(y[i], y[i - 1] + heights[i - 1] + gap);
  }
  for (let i = y.length - 1; i >= 0; i--) {
    const limit = i === y.length - 1
      ? bottom - heights[i]
      : y[i + 1] - gap - heights[i];
    y[i] = Math.min(y[i], limit);
  }
  return y;
}

/** Descent of a chromosome's name below its baseline, for the canvas's bottom edge. */
export const CHROMOSOME_LABEL_DESCENT = 4;

/**
 * Width of `text` set in Barlow at `weight` and `size`: the sum of the
 * advances, scaled from font units. Kerning is ignored (`labelSlack` absorbs
 * it), and a character the face does not draw takes its widest advance, so an
 * unforeseen symbol overestimates rather than overflows.
 */
export function textWidth(
  text: string,
  weight: 400 | 600,
  size: number,
  metrics: FontMetrics = fontMetrics,
): number {
  const advances = metrics.advances[String(weight)];
  const widest = Math.max(...Object.values(advances));
  let units = 0;
  for (const ch of text) {
    units += advances[String(ch.codePointAt(0))] ?? widest;
  }
  return units / metrics.unitsPerEm * size;
}

/**
 * How wide a gene's label block draws: the larger of its first line -- the
 * symbol, then each glyph's advance box after a double gap, where
 * `components/PhenogramShapes.tsx`'s `Block` puts them -- and each pill.
 */
export function labelWidth(
  symbol: string,
  pills: readonly Pick<Pill, "label">[],
  glyphCount: number,
  layout: LayoutConstants = encoding.layout,
  metrics: FontMetrics = fontMetrics,
): number {
  let first = textWidth(symbol, 600, layout.symbolFont, metrics);
  if (glyphCount > 0) {
    first += 2 * layout.glyphGap + glyphCount * layout.glyphSize +
      (glyphCount - 1) * layout.glyphGap;
  }
  return Math.max(
    first,
    ...pills.map((pill) =>
      textWidth(pill.label, 400, layout.pillFont, metrics) +
      2 * layout.pillPaddingX
    ),
  );
}

/** A label column wide enough for `labelWidths`, never narrower than `labelColumn`. */
export function columnWidth(
  labelWidths: readonly number[],
  layout: LayoutConstants = encoding.layout,
): number {
  return Math.max(
    layout.labelColumn,
    Math.ceil(Math.max(0, ...labelWidths) + layout.labelSlack),
  );
}

/**
 * How many of `pitches`, in order, go in the first row: the split that makes
 * the wider row narrowest, the later split on a tie. Everything in the first
 * row when there are fewer than two.
 */
export function splitRows(pitches: readonly number[]): number {
  if (pitches.length <= 1) return pitches.length;
  const total = pitches.reduce((sum, p) => sum + p, 0);
  let best = Infinity;
  let bestK = 1;
  let first = 0;
  for (let k = 1; k < pitches.length; k++) {
    first += pitches[k - 1];
    const widest = Math.max(first, total - first);
    if (widest <= best) {
      best = widest;
      bestK = k;
    }
  }
  return bestK;
}

/**
 * The chromosomes in `names`, in `CHROMOSOMES` order, scaled so the longest
 * chromosome in the table fills `rowHeight`, top-aligned in two rows split by
 * `splitRows`. Each takes its chromosome, the leader gap and its label column
 * from `columnWidths`, `labelColumn` where it has none.
 */
export function chromosomeShapes(
  names: ReadonlySet<string>,
  table: CytobandTable = defaultCytobands,
  enc: PhenogramEncoding = encoding,
  columnWidths: ReadonlyMap<string, number> = new Map(),
): ChromosomeShape[][] {
  const L = enc.layout;
  const longest = Math.max(...table.chromosomes.map((c) => c.length));
  const scale = L.rowHeight / longest;
  const present = CHROMOSOMES.flatMap((name) => {
    if (!names.has(name)) return [];
    const chromosome = table.chromosomes.find((c) => c.name === name);
    return chromosome ? [chromosome] : [];
  });
  const widths = present.map((c) => columnWidths.get(c.name) ?? L.labelColumn);
  const pitches = widths.map((w) => L.chromosomeWidth + L.leaderGap + w);
  const split = splitRows(pitches);
  const rows: ChromosomeShape[][] = [[], []];
  const cursor = [L.margin, L.margin];

  present.forEach((chromosome, order) => {
    const name = chromosome.name;
    const row = order < split ? 0 : 1;
    const x = cursor[row];
    cursor[row] += pitches[order];
    const y = L.margin + row * (L.rowHeight + L.rowGap);
    const height = chromosome.length * scale;
    const toY = (bp: number) => y + bp * scale;
    const acen = chromosome.bands.filter((b) => b.stain === "acen");
    const cenStart = acen.length ? acen[0].start : chromosome.length / 2;
    const cenEnd = acen.length ? acen[acen.length - 1].end : cenStart;
    rows[row].push({
      name,
      length: chromosome.length,
      row,
      x,
      y,
      width: L.chromosomeWidth,
      height,
      columnWidth: widths[order],
      bands: chromosome.bands.map((band) => ({
        name: band.name,
        y: toY(band.start),
        height: (band.end - band.start) * scale,
        stain: band.stain,
        fill: enc.stains[band.stain] ?? FALLBACK_STAIN,
      })),
      pArm: { y, height: cenStart * scale },
      centromere: { y: toY(cenStart), height: (cenEnd - cenStart) * scale },
      qArm: { y: toY(cenEnd), height: (chromosome.length - cenEnd) * scale },
      labelPoint: {
        x: x + L.chromosomeWidth / 2,
        y: y + height + CHROMOSOME_LABEL_OFFSET,
      },
    });
  });
  return rows;
}

/**
 * The drawing's extent plus the margin: as wide as the wider row, as tall as
 * the lowest chromosome name or label block. With nothing drawn, one empty
 * column.
 */
export function canvasFor(
  rows: readonly (readonly ChromosomeShape[])[],
  blocks: readonly Pick<GeneBlock, "y" | "height">[],
  layout: LayoutConstants = encoding.layout,
): PhenogramLayout["canvas"] {
  const chromosomes = rows.flat();
  if (chromosomes.length === 0) {
    return {
      width: 2 * layout.margin + layout.labelColumn,
      height: 2 * layout.margin,
    };
  }
  const rowWidth = (row: readonly ChromosomeShape[]) =>
    row.reduce(
      (sum, c) =>
        sum + layout.chromosomeWidth + layout.leaderGap + c.columnWidth,
      0,
    );
  const bottom = Math.max(
    ...chromosomes.map((c) => c.labelPoint.y + CHROMOSOME_LABEL_DESCENT),
    ...blocks.map((b) => b.y + b.height),
  );
  return {
    width: Math.ceil(2 * layout.margin + Math.max(...rows.map(rowWidth))),
    height: Math.ceil(bottom + layout.margin),
  };
}

interface Placed {
  gene: Gene;
  hit: BandHit;
  markerY: number;
}

export function computePhenogramLayout(
  rows: readonly Gene[],
  enc: PhenogramEncoding = encoding,
  table: CytobandTable = defaultCytobands,
): PhenogramLayout {
  const L = enc.layout;
  const hits: Array<{ gene: Gene; hit: BandHit }> = [];
  const unplaced: Gene[] = [];
  for (const gene of rows) {
    const hit = placeGene(gene.chromosomalLocation, table);
    if (hit) hits.push({ gene, hit });
    else unplaced.push(gene);
  }
  const hitsByChromosome = groupBy(hits, ({ hit }) => hit.chromosome);

  // The label columns come from the genes, so they are measured before any
  // chromosome is placed.
  const columnWidths = new Map(
    [...hitsByChromosome].map(([name, here]) => [
      name,
      columnWidth(
        here.map(({ gene }) =>
          labelWidth(
            gene.gene,
            pillsFor(gene, enc),
            glyphsFor(gene, enc).length,
            L,
          )
        ),
        L,
      ),
    ]),
  );
  const chromosomeRows = chromosomeShapes(
    new Set(hitsByChromosome.keys()),
    table,
    enc,
    columnWidths,
  );
  const chromosomes = chromosomeRows.flat();
  const blocks: GeneBlock[] = [];

  for (const chromosome of chromosomes) {
    // `chromosomes` is built from the same hit keys, so every shape has a group.
    const here: Placed[] = hitsByChromosome.get(chromosome.name)!
      .map((h) => ({
        ...h,
        markerY: chromosome.y +
          (h.hit.midpoint / chromosome.length) * chromosome.height,
      }))
      .sort((a, b) =>
        a.markerY - b.markerY || a.gene.gene.localeCompare(b.gene.gene, "en")
      );
    const pills = here.map((p) => pillsFor(p.gene, enc));
    const heights = pills.map((list) => blockHeight(list.length, L));
    const tops = resolveCollisions(
      here.map((p, i) => p.markerY - heights[i] / 2),
      heights,
      chromosome.y,
      chromosome.y + L.rowHeight,
      L.blockGap,
    );
    const x = chromosome.x + L.chromosomeWidth + L.leaderGap;
    const edge = chromosome.x + L.chromosomeWidth;
    here.forEach((p, i) => {
      const y = tops[i];
      const height = heights[i];
      blocks.push({
        index: blocks.length,
        gene: p.gene,
        symbol: p.gene.gene,
        chromosome: chromosome.name,
        band: p.hit.band,
        markerY: p.markerY,
        x,
        y,
        width: chromosome.columnWidth,
        height,
        pills: pills[i],
        glyphs: glyphsFor(p.gene, enc),
        leader: `M ${fixed(edge)} ${fixed(p.markerY)} L ${fixed(x)} ${
          fixed(y + height / 2)
        }`,
      });
    });
  }

  return {
    canvas: canvasFor(chromosomeRows, blocks, L),
    rows: chromosomeRows,
    chromosomes,
    blocks,
    unplaced,
    legend: phenogramLegend(rows, enc),
  };
}

/**
 * The key over `rows`: each family with its traits, and the evidence glyphs.
 *
 * Otherwise every vocabulary trait, as the GWAS filter offers. Under
 * `GOLD_ONLY` only the traits some row carries, as `gwasTraitChoices` does,
 * and a family left with none drops out, so the key names no phenotype the
 * curated set does not.
 */
export function phenogramLegend(
  rows: readonly Pick<Gene, "gwasTrait">[],
  enc: PhenogramEncoding = encoding,
  goldOnly: boolean = GOLD_ONLY,
): PhenogramLayout["legend"] {
  const carried = new Set(rows.flatMap((row) => row.gwasTrait.map(normalize)));
  const listed = (trait: TraitEncoding) =>
    !goldOnly || carried.has(normalize(trait.key));
  return {
    families: enc.families
      .map((family) => ({
        family,
        traits: enc.traits.filter((t) => t.family === family.key && listed(t)),
      }))
      .filter((entry) => entry.traits.length > 0),
    evidence: enc.evidence,
  };
}
