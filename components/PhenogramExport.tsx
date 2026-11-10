import { renderToString } from "preact-render-to-string";

import { encoding, type PhenogramLayout } from "../lib/phenogram.ts";
import {
  type KeyLayout,
  type KeyPanel,
  type KeyPill,
  type KeySwatch,
  type KeyText,
  phenogramDocumentWidth,
  SVG_PALETTE,
} from "../lib/phenogram_svg.ts";
import { Block, Chromosome, glyphPath } from "./PhenogramShapes.tsx";

/** Space between the key and the figure under it, in viewBox units. */
export const KEY_GAP = 40;

/** Exported files are sized at 100 viewBox units per inch. */
const UNITS_PER_INCH = 100;

const XMLNS = "http://www.w3.org/2000/svg";
const XMLNS_INKSCAPE = "http://www.inkscape.org/namespaces/inkscape";

/**
 * What XML 1.0 forbids even as a character reference: the C0 controls but tab,
 * newline and carriage return, and the two noncharacters. One of them in a
 * gene symbol or a label made a file no editor or browser would open.
 */
// deno-lint-ignore no-control-regex
const XML_ILLEGAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

/** JSX cannot name a namespaced attribute, so it goes in through a spread. */
const label = (text: string) => ({ "inkscape:label": text });

/** Inkscape lists a group marked as a layer in its Layers panel. */
const layer = { "inkscape:groupmode": "layer" };

function KeyLabel({ text }: { text: KeyText }) {
  return (
    <text
      x={text.x}
      y={text.y}
      fill={text.fill}
      font-family={`${text.font.family}, sans-serif`}
      font-weight={text.font.weight}
      font-size={text.font.size}
      letter-spacing={text.letterSpacing}
    >
      {text.text}
    </text>
  );
}

function KeyPillMark({ pill }: { pill: KeyPill }) {
  return (
    <g>
      <rect
        x={pill.x}
        y={pill.y}
        width={pill.width}
        height={pill.height}
        fill={pill.fill}
        stroke={pill.stroke}
        stroke-width={1}
      />
      <KeyLabel text={pill.label} />
    </g>
  );
}

function KeySwatchMark({ swatch }: { swatch: KeySwatch }) {
  return (
    <circle cx={swatch.cx} cy={swatch.cy} r={swatch.r} fill={swatch.fill} />
  );
}

function KeyPanelMark({ panel }: { panel: KeyPanel }) {
  return (
    <g id={panel.id} {...label(panel.title.text)}>
      <KeyLabel text={panel.title} />
      {panel.texts.map((text, i) => <KeyLabel key={i} text={text} />)}
      {panel.pills.map((pill, i) => <KeyPillMark key={i} pill={pill} />)}
      {panel.glyphs.map((glyph, i) => (
        <path
          key={i}
          fill={SVG_PALETTE.ink}
          d={glyphPath(glyph.shape, glyph.x, glyph.y, glyph.size)}
        />
      ))}
      {panel.swatches.map((swatch, i) => (
        <KeySwatchMark key={i} swatch={swatch} />
      ))}
      {panel.groups.map((group, i) => (
        <g key={i} id={`key-family-${i}`} {...label(group.label)}>
          {group.swatches.map((swatch, j) => (
            <KeySwatchMark key={j} swatch={swatch} />
          ))}
          {group.texts.map((text, j) => <KeyLabel key={j} text={text} />)}
          {group.pills.map((pill, j) => <KeyPillMark key={j} pill={pill} />)}
        </g>
      ))}
    </g>
  );
}

export interface PhenogramSvgOptions {
  karyogram: PhenogramLayout;
  /** Measured text widths by `symbol-N` / `pill-N-M`, as the live figure holds them. */
  widths: ReadonlyMap<string, number>;
  /** The laid-out key, or null for the figure alone. */
  key: KeyLayout | null;
}

/**
 * The figure, and optionally its key above it, as one standalone SVG file.
 *
 * Nothing refers to a stylesheet: every colour and font is an attribute, so the
 * file opens the same in Inkscape as in a browser.
 */
export function phenogramSvg(
  { karyogram, widths, key }: PhenogramSvgOptions,
): string {
  const margin = encoding.layout.margin;
  // The karyogram keeps its coordinates; a key wider than it widens the page.
  const width = phenogramDocumentWidth(karyogram.canvas.width, margin, key);
  const offset = key ? key.height + KEY_GAP : 0;
  const height = karyogram.canvas.height + offset;
  const svg = (
    <svg
      xmlns={XMLNS}
      {...{ "xmlns:inkscape": XMLNS_INKSCAPE }}
      viewBox={`0 0 ${width} ${height}`}
      width={`${width / UNITS_PER_INCH}in`}
      height={`${height / UNITS_PER_INCH}in`}
    >
      <rect
        id="background"
        x={0}
        y={0}
        width={width}
        height={height}
        fill={SVG_PALETTE.plate}
      />
      {key && (
        <g
          id="key"
          {...layer}
          transform={`translate(${margin} ${margin})`}
          {...label("Key")}
        >
          {key.panels.map((panel) => (
            <KeyPanelMark key={panel.id} panel={panel} />
          ))}
        </g>
      )}
      <g
        id="karyogram"
        {...layer}
        transform={key ? `translate(0 ${offset})` : undefined}
        {...label("Karyogram")}
      >
        {karyogram.chromosomes.map((shape) => (
          <g
            key={shape.name}
            id={`chr-${shape.name}`}
            {...label(`Chromosome ${shape.name}`)}
          >
            <Chromosome shape={shape} />
          </g>
        ))}
        {karyogram.blocks.map((block) => (
          <g
            key={block.index}
            id={`gene-${block.index}`}
            {...label(block.symbol)}
          >
            <Block
              block={block}
              widths={widths}
              labelAttrs={{
                id: `gene-${block.index}-label`,
                ...label(`${block.symbol} label`),
              }}
            />
          </g>
        ))}
      </g>
    </svg>
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n${
    renderToString(svg).replace(XML_ILLEGAL, "")
  }`;
}
