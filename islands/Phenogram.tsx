import { useHydratedRef } from "../components/useHydratedRef.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";

import { Tooltip } from "../components/Tooltip.tsx";
import {
  measureSvgTextWidths,
  whenFontsReady,
} from "../components/svgMeasurements.ts";
import { genes } from "../lib/data/genes.ts";
import {
  type ChromosomeShape,
  computePhenogramLayout,
  encoding,
  type GeneBlock,
} from "../lib/phenogram.ts";
import {
  phenogramTooltip,
  phenotypeTooltip,
} from "../lib/phenogram_tooltips.ts";

/** Computed once at module load, on the server and in the browser alike. */
const LAYOUT = computePhenogramLayout(genes);
const { width: WIDTH, height: HEIGHT } = LAYOUT.canvas;
const L = encoding.layout;

const SYMBOL_FONT_SIZE = 12;
const PILL_FONT_SIZE = 9.5;
const CHROMOSOME_FONT_SIZE = 13;
const GLYPH_SIZE = 9;
const GLYPH_GAP = 4;
const PILL_PADDING_X = 5;
const PILL_INSET = 2;
/**
 * Pre-hydration estimate of a text width, in em per character. Every pill
 * background and glyph position is refitted from `getBBox()` as soon as the
 * island mounts, and again once the web font has loaded — block positions
 * never depend on it.
 */
const PLACEHOLDER_EM = 0.6;

const percent = (value: number, of: number) => `${(value / of) * 100}%`;

/** Geometry for a shape the encoding does not know — unreachable on committed data (the encoding test). */
const FALLBACK_GLYPH = { scale: 1, innerRatio: 0.5 };

/**
 * How far to raise a glyph off the symbol line, in viewBox units.
 *
 * An apex-up triangle's centroid sits at a third of its height, below its box
 * centre, so box-centring it against bold text reads low. Half that offset is
 * enough to correct without making it float above its neighbours.
 */
function glyphLift(shape: string): number {
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
function glyphPath(shape: string, x: number, y: number, size: number): string {
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

/** What a screen reader gets for a gene; the SVG itself is decoration. */
function accessibleName(block: GeneBlock): string {
  const traits = block.pills.length
    ? block.pills.map((p) => p.label).join(", ")
    : "none found";
  const evidence = block.glyphs.length
    ? block.glyphs.map((g) => g.label).join(", ")
    : "none";
  return `${block.symbol}, ${block.chromosome}${block.band}. ` +
    `GWAS phenotypes: ${traits}. Other evidence: ${evidence}.`;
}

/** Two rounded arms clipped over the band stripes, a narrower centromere, the name below. */
function Chromosome({ shape }: { shape: ChromosomeShape }) {
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

interface BlockProps {
  block: GeneBlock;
  widths: ReadonlyMap<string, number>;
}

/** Marker tick, leader, the symbol followed by its glyphs, one pill per line. */
function Block({ block, widths }: BlockProps) {
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
        x1={chromosomeLeft}
        x2={block.x - L.leaderGap}
        y1={block.markerY}
        y2={block.markerY}
      />
      <path class="phenogram-leader" d={block.leader} />
      <text
        class="label-ink phenogram-symbol"
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
              data-pill={id}
              x={block.x + PILL_PADDING_X}
              y={top + L.pillLine / 2}
              dy="0.35em"
              font-size={PILL_FONT_SIZE}
            >
              {pill.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * The phenogram karyogram: putative causal genes on their hg38 chromosomes.
 *
 * Replaces the sandboxed iframe around a PhenoGram raster with pixel-colour
 * hit-testing. The layout is `lib/phenogram.ts`; this island renders it as a
 * decorative SVG and lays a list of real buttons over the label blocks, so
 * every gene has a focus target, an accessible name and the same popover
 * tooltip the tables use — hover, Enter, Tab-to-link and Escape all come from
 * `Tooltip` unchanged.
 */
export default function Phenogram() {
  const hydratedRef = useHydratedRef<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [widths, setWidths] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );

  const measure = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const next = measureSvgTextWidths(
      svg,
      "text[data-pill], text[data-symbol]",
      (text) => text.dataset.pill ?? text.dataset.symbol ?? "",
    );
    setWidths((previous) =>
      previous.size === next.size &&
        [...next].every(([key, width]) =>
          Math.abs((previous.get(key) ?? NaN) - width) <= 0.01
        )
        ? previous
        : next
    );
  };

  // Fit the pill backgrounds once on mount, and again when the web font lands.
  useLayoutEffect(measure, []);
  useEffect(() => whenFontsReady(measure), []);

  const { families, evidence } = LAYOUT.legend;

  return (
    <div class="phenogram-layout" ref={hydratedRef}>
      <a class="skip-figure" href="#phenogram-end">Skip the figure</a>

      <details class="figure-key" id="phenogram-key">
        <summary class="figure-key-summary">Key</summary>
        <div class="phenogram-legend">
          <section class="phenogram-legend-panel">
            <h2 class="phenogram-legend-title">Supporting evidence</h2>
            <ul class="phenogram-legend-list">
              <li class="phenogram-legend-item">
                <span class="phenogram-pill phenogram-pill-sample">
                  GWAS
                </span>
                one pill per associated phenotype
              </li>
              {evidence.map((entry) => (
                <li key={entry.key} class="phenogram-legend-item">
                  <svg
                    class="phenogram-legend-glyph"
                    viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
                    aria-hidden="true"
                  >
                    <path
                      d={glyphPath(entry.shape, 0, 0, GLYPH_SIZE)}
                      fill="currentColor"
                    />
                  </svg>
                  {entry.label}
                </li>
              ))}
            </ul>
          </section>
          <section class="phenogram-legend-panel">
            <h2 class="phenogram-legend-title">GWAS phenotypes</h2>
            <ul class="phenogram-legend-list">
              {families.map(({ family, traits }) => (
                <li key={family.key} class="phenogram-legend-family">
                  <span class="phenogram-legend-family-name">
                    <span
                      class="phenogram-legend-swatch"
                      style={{ background: family.hue }}
                      aria-hidden="true"
                    />
                    {family.label}
                  </span>
                  <ul class="phenogram-legend-traits">
                    {traits.map((trait) => (
                      <li key={trait.key}>
                        <Tooltip content={phenotypeTooltip(trait)}>
                          <span
                            class="phenogram-pill"
                            style={{
                              background: family.tint,
                              borderColor: family.hue,
                            }}
                          >
                            {trait.label}
                          </span>
                        </Tooltip>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </details>

      {
        /* The scroller is `overflow: auto`, which clips the frame's
          registration marks at their negative inset, so the frame is a
          wrapper rather than the scroller itself. */
      }
      <div class="blueprint-frame">
        <div class="phenogram-scroll">
          <div
            class="phenogram-canvas"
            style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
          >
            <svg
              ref={svgRef}
              class="phenogram-figure"
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              aria-hidden="true"
            >
              {LAYOUT.chromosomes.map((shape) => (
                <Chromosome key={shape.name} shape={shape} />
              ))}
              {LAYOUT.blocks.map((block) => (
                <Block key={block.index} block={block} widths={widths} />
              ))}
            </svg>
            <ul
              class="phenogram-genes"
              aria-label="Genes by chromosomal position"
            >
              {LAYOUT.blocks.map((block) => (
                <li
                  key={block.index}
                  style={{
                    left: percent(block.x, WIDTH),
                    top: percent(block.y, HEIGHT),
                    width: percent(block.width, WIDTH),
                    height: percent(block.height, HEIGHT),
                  }}
                >
                  <Tooltip content={phenogramTooltip(block.gene)}>
                    <span class="visually-hidden">{accessibleName(block)}</span>
                  </Tooltip>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      {LAYOUT.unplaced.length > 0 && (
        <p class="phenogram-unplaced">
          Not placed on the figure (no hg38 band for the location): {LAYOUT
            .unplaced
            .map((g) => `${g.gene} (${g.chromosomalLocation})`)
            .join(", ")}
        </p>
      )}

      <p class="figure-end" id="phenogram-end" tabIndex={-1}>
        End of the phenogram
      </p>
    </div>
  );
}
