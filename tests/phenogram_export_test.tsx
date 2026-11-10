/** The export document: a standalone, Inkscape-editable SVG of the figure and its key. */
import { assert, assertEquals } from "@std/assert";

import { KEY_GAP, phenogramSvg } from "../components/PhenogramExport.tsx";
import {
  computePhenogramLayout,
  encoding,
  phenogramLegend,
} from "../lib/phenogram.ts";
import { layoutPhenogramKey } from "../lib/phenogram_svg.ts";
import { sampleGene } from "./fixtures/rows.ts";

const measure = (text: string) => text.length * 6;
const margin = encoding.layout.margin;

function build(symbol = "GENE1", withKey = true, label = "Vascular & co") {
  const karyogram = computePhenogramLayout([
    sampleGene({
      gene: symbol,
      chromosomalLocation: "1p36.32",
      gwasTrait: [encoding.traits[0].key],
      evidenceFromOtherOmicsStudies: ["TWAS"],
    }),
  ]);
  const legend = phenogramLegend([], encoding, false);
  legend.families = legend.families.map((entry, i) =>
    i === 0
      ? {
        family: { ...entry.family, label },
        traits: entry.traits.map((t) => ({ ...t, label })),
      }
      : entry
  );
  const key = withKey
    ? layoutPhenogramKey(legend, karyogram.canvas.width - 2 * margin, measure)
    : null;
  const svg = phenogramSvg({ karyogram, widths: new Map(), key });
  return { karyogram, key, svg };
}

Deno.test("figure only has no key", () => {
  const { karyogram, svg } = build("GENE1", false);
  assert(!svg.includes('id="key"'));
  assert(/<g[^>]*id="karyogram"(?![^>]*transform)[^>]*>/.test(svg));
  assert(svg.includes(`height="${karyogram.canvas.height / 100}in"`));
});

Deno.test("figure with key puts the key on top", () => {
  const { karyogram, key, svg } = build();
  assert(svg.indexOf('id="key"') > 0);
  assert(svg.indexOf('id="key"') < svg.indexOf('id="karyogram"'));
  assert(
    svg.includes(`translate(0 ${key!.height + KEY_GAP})`),
    "karyogram is pushed below the key",
  );
  assert(svg.includes(`translate(${margin} ${margin})`));
  const height = karyogram.canvas.height + key!.height + 40;
  assert(svg.includes(`height="${height / 100}in"`));
  assert(svg.includes(`viewBox="0 0 ${karyogram.canvas.width} ${height}"`));
  assert(svg.includes(`width="${karyogram.canvas.width / 100}in"`));
});

Deno.test("is self-contained for Inkscape", () => {
  const { svg } = build();
  assert(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'));
  for (const banned of ["var(", "foreignObject", "<image", "<style"]) {
    assert(!svg.includes(banned), banned);
  }
  assert(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert(
    svg.includes(
      'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"',
    ),
  );
  const texts = svg.match(/<text\b[^>]*>/g) ?? [];
  assert(texts.length > 0);
  for (const tag of texts) {
    for (
      const attr of ["fill=", "font-family=", "font-size=", "font-weight="]
    ) {
      assert(tag.includes(attr), `${attr} missing in ${tag}`);
    }
  }
});

Deno.test("one group per chromosome and per gene", () => {
  const { karyogram, svg } = build();
  assertEquals(
    svg.match(/id="chr-/g)?.length,
    karyogram.chromosomes.length,
  );
  assertEquals(svg.match(/id="gene-/g)?.length, karyogram.blocks.length);
  assert(svg.includes('inkscape:label="Chromosome 1"'));
  assert(svg.includes('inkscape:label="GENE1"'));
});

Deno.test("escapes labels and keeps ids valid", () => {
  const { svg } = build("A&B:1");
  assert(svg.includes("A&amp;B:1"));
  assert(svg.includes("Vascular &amp; co"));
  assert(!svg.includes("A&B"));
  const ids = [...svg.matchAll(/\sid="([^"]*)"/g)].map((m) => m[1]);
  assert(ids.length > 0);
  for (const id of ids) assert(/^[A-Za-z][\w.-]*$/.test(id), id);
  assert(ids.includes("key-family-0"));
});

Deno.test("renders with no genes", () => {
  const karyogram = computePhenogramLayout([]);
  const svg = phenogramSvg({ karyogram, widths: new Map(), key: null });
  assert(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n'));
  assert(svg.endsWith("</svg>"));
  assert(svg.includes('id="karyogram"'));
});
