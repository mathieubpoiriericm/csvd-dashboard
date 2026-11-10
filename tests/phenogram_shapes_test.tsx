/** The shared shapes carry their own colours, so an exported file needs no stylesheet. */
import { assert } from "@std/assert";
import { renderToString } from "preact-render-to-string";

import { Block, Chromosome } from "../components/PhenogramShapes.tsx";
import { computePhenogramLayout, encoding } from "../lib/phenogram.ts";
import { sampleGene } from "./fixtures/rows.ts";

Deno.test("shapes carry literal colours", () => {
  const layout = computePhenogramLayout([
    sampleGene({
      chromosomalLocation: "1p36.32",
      gwasTrait: [encoding.traits[0].key],
    }),
  ]);
  const block = layout.blocks[0];
  const shape = layout.chromosomes.find((c) => c.name === block.chromosome)!;
  assert(block.pills.length > 0, "the sample gene carries a pill");
  const html = renderToString(<Chromosome shape={shape} />) +
    renderToString(<Block block={block} widths={new Map()} />);

  assert(!html.includes("var("), "no CSS variable in the markup");
  const texts = html.match(/<text\b[^>]*>/g) ?? [];
  assert(texts.length >= 3, "chromosome name, symbol and pill label");
  for (const tag of texts) {
    assert(tag.includes('fill="#1d1f20"'), tag);
    assert(tag.includes('font-family="Barlow, sans-serif"'), tag);
  }
  assert(
    /<line\b[^>]*class="phenogram-marker"[^>]*stroke="#1d1f20"[^>]*stroke-width="2"/
      .test(html),
    "marker stroke",
  );
  assert(
    /<path\b[^>]*class="phenogram-leader"[^>]*stroke="#1d1f20"/.test(html),
    "leader stroke",
  );
  const glyphs = html.match(/<path\b[^>]*phenogram-glyph[^>]*>/g) ?? [];
  for (const g of glyphs) assert(g.includes('fill="#1d1f20"'), g);
});
