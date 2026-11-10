import { useHydratedRef } from "../components/useHydratedRef.ts";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import { Tooltip } from "../components/Tooltip.tsx";
import { PhenogramDownload } from "../components/PhenogramDownload.tsx";
import {
  measureSvgTextWidths,
  whenFontsReady,
} from "../components/svgMeasurements.ts";
import { genes } from "../lib/data/genes.ts";
import { isAbsent } from "../lib/sentinels.ts";
import type { Gene } from "../lib/types.ts";
import {
  computePhenogramLayout,
  encoding,
  type GeneBlock,
} from "../lib/phenogram.ts";
import {
  figureTextWidths,
  type KeyFont,
  layoutPhenogramKey,
  phenogramKeyWidth,
} from "../lib/phenogram_svg.ts";
import {
  Block,
  Chromosome,
  GLYPH_SIZE,
  glyphPath,
} from "../components/PhenogramShapes.tsx";
import {
  phenogramTooltip,
  phenotypeTooltip,
} from "../lib/phenogram_tooltips.ts";

/**
 * Widths of exported text, measured with the page's own loaded faces.
 *
 * Always a DOM canvas, which sees the document's @font-face fonts. The text is
 * measured ten times larger and scaled back, so hinting to whole pixels is
 * negligible in any engine.
 */
function measureWithCanvas(text: string, font: KeyFont): number {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) throw new Error("No 2D canvas context to measure key text with.");
  ctx.font = `${font.weight} ${font.size * 10}px "${font.family}"`;
  return ctx.measureText(text).width / 10;
}

const percent = (value: number, of: number) => `${(value / of) * 100}%`;

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
interface PhenogramProps {
  /** The genes to place; the committed table by default. Tests hand in synthetic rows. */
  rows?: readonly Gene[];
}

export default function Phenogram({ rows = genes }: PhenogramProps = {}) {
  // Computed once per row set, on the server and in the browser alike.
  const karyogram = useMemo(() => computePhenogramLayout(rows), [rows]);
  const { width, height } = karyogram.canvas;
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

  const { families, evidence } = karyogram.legend;

  /** Called from the download menu's click handlers only, never during SSR. */
  const buildSvg = async (withKey: boolean): Promise<string> => {
    // A face the page has not used yet is not loaded, and canvas and SVG
    // measurement would both fall back to a different font.
    await Promise.all([
      document.fonts.load('600 15px "Barlow Condensed"'),
      document.fonts.load("400 12px Barlow"),
      document.fonts.load("600 12px Barlow"),
    ]);
    await document.fonts.ready;
    // Not the live boxes: those are hinted at the page's scale, a little
    // narrower than the file's text in an editor.
    const measured = figureTextWidths(karyogram.blocks, measureWithCanvas);
    const key = withKey
      ? layoutPhenogramKey(
        karyogram.legend,
        // Never narrower than the key can be laid out without overlap: a
        // karyogram of one or two chromosomes is narrower than that.
        phenogramKeyWidth(
          width,
          encoding.layout.margin,
          karyogram.legend,
          measureWithCanvas,
        ),
        measureWithCanvas,
      )
      : null;
    // Loaded on download only, so the page does not carry the renderer.
    const { phenogramSvg } = await import("../components/PhenogramExport.tsx");
    return phenogramSvg({ karyogram, widths: measured, key });
  };

  return (
    <div class="phenogram-layout" ref={hydratedRef}>
      <a class="skip-figure" href="#phenogram-end">Skip the figure</a>

      <div class="phenogram-toolbar">
        <PhenogramDownload build={buildSvg} />
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
      </div>

      {
        /* The scroller is `overflow: auto`, which clips the frame's
          registration marks at their negative inset, so the frame is a
          wrapper rather than the scroller itself. */
      }
      <div class="blueprint-frame">
        <div class="phenogram-scroll">
          <div
            class="phenogram-canvas"
            style={{ aspectRatio: `${width} / ${height}` }}
          >
            <svg
              ref={svgRef}
              class="phenogram-figure"
              viewBox={`0 0 ${width} ${height}`}
              aria-hidden="true"
            >
              {karyogram.chromosomes.map((shape) => (
                <Chromosome key={shape.name} shape={shape} />
              ))}
              {karyogram.blocks.map((block) => (
                <Block key={block.index} block={block} widths={widths} />
              ))}
            </svg>
            <ul
              class="phenogram-genes"
              aria-label="Genes by chromosomal position"
            >
              {karyogram.blocks.map((block) => (
                <li
                  key={block.index}
                  style={{
                    left: percent(block.x, width),
                    top: percent(block.y, height),
                    width: percent(block.width, width),
                    height: percent(block.height, height),
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
      {karyogram.unplaced.length > 0 && (
        <p class="phenogram-unplaced">
          Not placed on the figure (no hg38 band for the location): {karyogram
            .unplaced
            .map((g) =>
              `${g.gene} (${
                isAbsent(g.chromosomalLocation)
                  ? "no location recorded"
                  : g.chromosomalLocation
              })`
            )
            .join(", ")}
        </p>
      )}

      <p class="figure-end" id="phenogram-end" tabIndex={-1}>
        End of the phenogram
      </p>
    </div>
  );
}
