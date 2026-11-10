import {
  type ChromosomeShape,
  encoding,
  type GeneBlock,
} from "../lib/phenogram.ts";
import { SVG_PALETTE } from "../lib/phenogram_svg.ts";

const L = encoding.layout;

/** The face the figure is set in; an exported file carries it as an attribute, having no stylesheet. */
const FONT_FAMILY = "Barlow, sans-serif";

export const SYMBOL_FONT_SIZE = 12;
export const PILL_FONT_SIZE = 9.5;
export const CHROMOSOME_FONT_SIZE = 13;
export const GLYPH_SIZE = 9;
export const GLYPH_GAP = 4;
export const PILL_PADDING_X = 5;
export const PILL_INSET = 2;
/**
 * Pre-hydration estimate of a text width, in em per character. Every pill
 * background and glyph position is refitted from `getBBox()` as soon as the
 * island mounts, and again once the web font has loaded — block positions
 * never depend on it.
 */
export const PLACEHOLDER_EM = 0.6;

/** Geometry for a shape the encoding does not know — unreachable on committed data (the encoding test). */
const FALLBACK_GLYPH = { scale: 1, innerRatio: 0.5 };

/**
 * How far to raise a glyph off the symbol line, in viewBox units.
 *
 * An apex-up triangle's centroid sits at a third of its height, below its box
 * centre, so box-centring it against bold text reads low. Half that offset is
 * enough to correct without making it float above its neighbours.
 */
export function glyphLift(shape: string): number {
  return encoding.glyphs[shape]?.lift ?? 0;
}

/**
 * One evidence glyph, centred in a `size` × `size` advance box at (x, y).
 *
 * The geometry comes from `encoding.glyphs`, never from constants here:
 * `scripts/phenogram_figure.py` reads the same numbers, and while each renderer
 * owned its own the two drew measurably different stars — matplotlib's built-in
 * `*` hard-codes an inner ratio of 0.381966 against the 0.42 this file used.
 *
 * `scale` shrinks a shape inside the box without moving the box, so glyph
 * positions never change. The triangle's `lift` is deliberately *not* applied
 * here: it corrects where the glyph sits against the bold gene symbol, which is
 * placement rather than shape, so `glyphLift` applies it at the call site and
 * the legend reuses the same path unlifted and unclipped.
 */
export function glyphPath(
  shape: string,
  x: number,
  y: number,
  size: number,
): string {
  const geometry = encoding.glyphs[shape] ?? FALLBACK_GLYPH;
  const side = size * geometry.scale;
  const inset = (size - side) / 2;
  const left = x + inset;
  const top = y + inset;
  const n = (value: number) => value.toFixed(2);

  if (shape === "triangle") {
    return `M ${n(left)} ${n(top + side)} L ${n(left + side)} ${
      n(top + side)
    } L ${n(left + side / 2)} ${n(top)} Z`;
  }
  if (shape === "square") {
    return `M ${n(left)} ${n(top)} h ${n(side)} v ${n(side)} h ${n(-side)} Z`;
  }
  const cx = left + side / 2;
  const cy = top + side / 2;
  const outer = side / 2;
  const inner = outer * (geometry.innerRatio ?? FALLBACK_GLYPH.innerRatio);
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    points.push(
      `${n(cx + r * Math.cos(angle))} ${n(cy + r * Math.sin(angle))}`,
    );
  }
  return `M ${points.join(" L ")} Z`;
}

/** Two rounded arms clipped over the band stripes, a narrower centromere, the name below. */
export function Chromosome({ shape }: { shape: ChromosomeShape }) {
  const clipId = `phenogram-arms-${shape.name}`;
  const rx = shape.width / 2;
  const arms = [shape.pArm, shape.qArm];
  return (
    <g class="phenogram-chromosome" data-chromosome={shape.name}>
      <clipPath id={clipId}>
        {arms.map((arm, i) => (
          <rect
            key={i}
            x={shape.x}
            y={arm.y}
            width={shape.width}
            height={arm.height}
            rx={rx}
          />
        ))}
      </clipPath>
      <g clip-path={`url(#${clipId})`}>
        {shape.bands.map((band) => (
          <rect
            key={band.name}
            x={shape.x}
            y={band.y}
            width={shape.width}
            height={band.height}
            fill={band.fill}
          />
        ))}
      </g>
      {arms.map((arm, i) => (
        <rect
          key={`outline-${i}`}
          x={shape.x}
          y={arm.y}
          width={shape.width}
          height={arm.height}
          rx={rx}
          fill="none"
          stroke={encoding.stains.gpos100}
          stroke-width={1}
        />
      ))}
      <rect
        x={shape.x + shape.width * 0.2}
        y={shape.centromere.y}
        width={shape.width * 0.6}
        height={shape.centromere.height}
        fill={encoding.stains.acen}
      />
      <text
        class="label-ink"
        fill={SVG_PALETTE.ink}
        font-family={FONT_FAMILY}
        x={shape.labelPoint.x}
        y={shape.labelPoint.y}
        text-anchor="middle"
        font-size={CHROMOSOME_FONT_SIZE}
        font-weight={600}
      >
        {shape.name}
      </text>
    </g>
  );
}

export interface BlockProps {
  block: GeneBlock;
  widths: ReadonlyMap<string, number>;
}

/** Marker tick, leader, the symbol followed by its glyphs, one pill per line. */
export function Block({ block, widths }: BlockProps) {
  const symbolBaseline = block.y + L.blockPadding + L.symbolLine * 0.78;
  const glyphY = block.y + L.blockPadding + (L.symbolLine - GLYPH_SIZE) / 2;
  const chromosomeLeft = block.x - L.leaderGap - L.chromosomeWidth;
  const symbolWidth = widths.get(`symbol-${block.index}`) ??
    block.symbol.length * SYMBOL_FONT_SIZE * PLACEHOLDER_EM;
  return (
    <g
      class="phenogram-block"
      data-gene={block.symbol}
      data-chromosome={block.chromosome}
    >
      <line
        class="phenogram-marker"
        stroke={SVG_PALETTE.ink}
        stroke-width={2}
        x1={chromosomeLeft}
        x2={block.x - L.leaderGap}
        y1={block.markerY}
        y2={block.markerY}
      />
      <path
        class="phenogram-leader"
        d={block.leader}
        fill="none"
        stroke={SVG_PALETTE.ink}
        stroke-width={1}
      />
      <text
        class="label-ink phenogram-symbol"
        fill={SVG_PALETTE.ink}
        font-family={FONT_FAMILY}
        data-symbol={`symbol-${block.index}`}
        x={block.x}
        y={symbolBaseline}
        font-size={SYMBOL_FONT_SIZE}
        font-weight={600}
      >
        {block.symbol}
      </text>
      {block.glyphs.map((glyph, i) => {
        const x = block.x + symbolWidth + 2 * GLYPH_GAP +
          i * (GLYPH_SIZE + GLYPH_GAP);
        return (
          <path
            key={glyph.key}
            class="phenogram-glyph"
            fill={SVG_PALETTE.ink}
            d={glyphPath(
              glyph.shape,
              x,
              glyphY - glyphLift(glyph.shape),
              GLYPH_SIZE,
            )}
          />
        );
      })}
      {block.pills.map((pill, i) => {
        const id = `pill-${block.index}-${i}`;
        const top = block.y + L.blockPadding + L.symbolLine + i * L.pillLine;
        const textWidth = widths.get(id) ??
          pill.label.length * PILL_FONT_SIZE * PLACEHOLDER_EM;
        const height = L.pillLine - PILL_INSET;
        return (
          <g key={id} class="phenogram-pill-mark">
            <rect
              class="pill-bg"
              x={block.x}
              y={top + PILL_INSET / 2}
              width={textWidth + 2 * PILL_PADDING_X}
              height={height}
              rx={height / 2}
              fill={pill.fill}
              stroke={pill.stroke}
              stroke-width={1}
            />
            <text
              class="label-ink"
              fill={SVG_PALETTE.ink}
              font-family={FONT_FAMILY}
              data-pill={id}
              x={block.x + PILL_PADDING_X}
              y={top + L.pillLine / 2}
              dy="0.35em"
              font-size={PILL_FONT_SIZE}
              font-weight={400}
            >
              {pill.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
