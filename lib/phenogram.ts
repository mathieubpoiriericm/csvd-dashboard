/**
 * Layout for the phenogram karyogram: chromosomes drawn to scale from the
 * hg38 cytobands, one marker per gene at the midpoint of its band, and a label
 * block beside the chromosome — the symbol with its evidence glyphs on the
 * first line, then one GWAS-phenotype pill per line. Pure functions over
 * `Gene` rows; no DOM, so the same code runs on the server, in the island and
 * under `deno test`.
 *
 * `scripts/phenogram_figure.py` implements this rule a second time for print.
 * Both read `phenogram_encoding.json` for appearance and `vocabulary.json`
 * for trait identity -- together the only place colours, labels,
 * definitions, band stains and the geometry constants live — keep the *rule*
 * here in step with the Python twin (same names, same order of operations).
 *
 * Coordinates are SVG user units in the encoding's `viewBox`; y grows down.
 */

import encodingJson from "./phenogram_encoding.json" with { type: "json" };
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
  viewBox: number[];
  margin: number;
  rowSplitAfter: string;
  rowHeight: number;
  rowGap: number;
  chromosomeWidth: number;
  leaderGap: number;
  labelColumn: number;
  blockGap: number;
  symbolLine: number;
  pillLine: number;
  blockPadding: number;
}

export interface PhenogramEncoding {
  families: FamilyEncoding[];
  traits: TraitEncoding[];
  evidence: EvidenceEncoding[];
  glyphs: Record<string, GlyphGeometry>;
  citation: { label: string; doi: string };
  stains: Record<string, string>;
  layout: LayoutConstants;
}

// Appearance from the encoding, identity from the vocabulary. Composed here so
// every downstream consumer -- pills, legend, both renderers -- keeps reading one
// `encoding.traits`, while a trait is still defined in exactly one file.
export const encoding: PhenogramEncoding = {
  ...encodingJson,
  traits: vocabulary.traits,
};

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

/**
 * The chromosomes in `names`, in `CHROMOSOMES` order, scaled so the longest
 * chromosome in the table fills `rowHeight`, top-aligned in two rows split
 * after `rowSplitAfter`, one column each.
 */
export function chromosomeShapes(
  names: ReadonlySet<string>,
  table: CytobandTable = defaultCytobands,
  enc: PhenogramEncoding = encoding,
): ChromosomeShape[][] {
  const L = enc.layout;
  const longest = Math.max(...table.chromosomes.map((c) => c.length));
  const scale = L.rowHeight / longest;
  const pitch = L.chromosomeWidth + L.leaderGap + L.labelColumn;
  const splitIndex = CHROMOSOMES.indexOf(L.rowSplitAfter);
  const rows: ChromosomeShape[][] = [[], []];

  CHROMOSOMES.forEach((name, order) => {
    if (!names.has(name)) return;
    const chromosome = table.chromosomes.find((c) => c.name === name);
    if (!chromosome) return;
    const row = order <= splitIndex ? 0 : 1;
    const x = L.margin + rows[row].length * pitch;
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

  const chromosomeRows = chromosomeShapes(
    new Set(hits.map((h) => h.hit.chromosome)),
    table,
    enc,
  );
  const chromosomes = chromosomeRows.flat();
  const blocks: GeneBlock[] = [];
  const hitsByChromosome = groupBy(hits, ({ hit }) => hit.chromosome);

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
        width: L.labelColumn,
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
    canvas: { width: L.viewBox[0], height: L.viewBox[1] },
    rows: chromosomeRows,
    chromosomes,
    blocks,
    unplaced,
    legend: {
      families: enc.families.map((family) => ({
        family,
        traits: enc.traits.filter((t) => t.family === family.key),
      })),
      evidence: enc.evidence,
    },
  };
}
