---
paths:
  - "islands/Phenogram.tsx"
  - "lib/phenogram.ts"
  - "lib/phenogram_encoding.json"
  - "lib/phenogram_font_metrics.json"
  - "scripts/phenogram_font_metrics.ts"
  - "tests/helpers/woff2.ts"
  - "disease/phenogram.json"
  - "lib/disease/citation.ts"
  - "lib/cytobands.ts"
  - "disease/vocabulary.json"
  - "scripts/phenogram_figure.py"
  - "scripts/fetch_cytobands.py"
  - "tests/phenogram_*.ts"
  - "tests/csvd/phenogram_*.ts"
  - "tests/cytobands_test.ts"
  - "tests/scripts/test_phenogram_figure.py"
  - "tests/scripts/csvd/test_csvd_phenogram_figure.py"
  - "e2e/tests/phenogram.spec.ts"
  - "e2e/tests/csvd/phenogram.spec.ts"
---

# Phenogram

`islands/Phenogram.tsx` draws the karyogram from `data/table1.json` and
`data/cytobands_hg38.json` (UCSC hg38, 862 bands, written by
`scripts/fetch_cytobands.py`). A gene is placed at the midpoint of the band its
`chromosomalLocation` names — exact bands only, in `lib/cytobands.ts`, where
NCBI's range for a gene across a band edge (`10q24.33-q25.1`) spans its two
exact ends;
`tests/cytobands_test.ts` fails if any committed location stops resolving, and
the island lists such genes instead of guessing.

Two renderers, one contract, as for the timeline:

- **`disease/vocabulary.json` is the single source of truth for the GWAS trait
  vocabulary**, and the only place a trait is defined: key, display label,
  family, long name, the STRIVE-2 definition where one exists, and an internal
  ontology `xref` (or an explicit `null` with the reason — seven of the sixteen
  have no usable term in any of the ~250 ontologies OLS4 indexes, because this
  axis is finer-grained than anything published). It also carries `synonyms`, an
  **ordered** array `pipeline/export/tables.py` reads as `_TRAIT_REWRITES`
  (substring folds, applied in sequence — so a short code like `OD` must never
  be folded: it occurs inside `NODDI`), and `untracked`, the prompt vocabulary
  the dashboard deliberately does not carry, each with a reason.
  `GWAS_TRAIT_CHOICES` in `lib/constants.ts` and both phenogram renderers derive
  from this file; nothing restates it. That restating is what let `PVWMH` — the
  second most extracted trait in `logs/json/pipeline_report_*.json`, 29 times —
  have no filter choice and no phenogram entry, and let `lacunar stroke` be
  labelled `"Lacunar Stroke"` in one file and `"Lacunar stroke"` in another.
  **Under `GOLD_ONLY` the page offers less than the file**: the GWAS filter
  (`gwasTraitChoices` in `lib/filters.ts`) and the island's key
  (`phenogramLegend`) list only the traits a published gene carries, and a
  family left with none drops out of the key, so no vocabulary term the
  curators never assigned reaches a page. `GWAS_TRAIT_CHOICES` itself stays
  the whole vocabulary, and so does the print figure's key.
- **The prompt is reconciled, not generated.** `pipeline/prompts.py`'s
  canonical-abbreviation sentence stays a frozen literal — it is recorded in
  cassettes and treated as part of the method, so generating it would let an
  edit silently change what the model is asked.
  `tests/pipeline/test_prompt_vocabulary.py` fails in both directions instead: a
  term the prompt asks for that the vocabulary does not declare, and a
  prompt-sourced vocabulary entry the prompt no longer asks for. A synonym
  records `source: "prompt"` or `"curated"`; only the first is reconciled,
  because a curated spelling comes from the source spreadsheet and the prompt
  has never asked for it.
- `lib/phenogram_encoding.json` holds appearance only: the evidence glyphs, the
  band-stain greys and the geometry constants. The seven phenotype families and
  their hues and tints are the disease's and live in `disease/phenogram.json`;
  the citation standard the STRIVE-2 definitions are quoted from is
  `citationStandard` in `disease/manifest.json`, read on the TypeScript side
  through `lib/disease/citation.ts`. `tests/phenogram_encoding_test.ts` fails
  when the data carries a GWAS trait the vocabulary does not, when the filter
  choices stop being derived from it, when the two renderers stop composing the
  same identity, or when a family hue leaves the lightness band or sits within
  OKLab ΔE 15 of its legend neighbour. Add the entry; do not widen the test.

  **The canvas is derived, never configured.** Both dimensions of a fixed
  `viewBox` overflowed as the data grew -- the last fixed plate was 1732x1640
  split after chromosome 10, and on the gold table its second row needed
  1,884 units, so X's CHRDL1 fell off the right edge while ~400 units under
  that row stayed empty, and the "MTAG (…)" pills (~180 units) crossed the
  next chromosome from a 128-unit column. Now, in both renderers:
  - a gene's label width is the wider of its first line (the symbol at
    `symbolFont`, weight 600, then `2*glyphGap + n*glyphSize + (n-1)*glyphGap`
    for n glyphs, where `Block` draws them) and each pill (`pillFont`, weight
    400, plus `2*pillPaddingX`). Text is measured from
    `lib/phenogram_font_metrics.json` -- the advance of every code point the
    shipped `Barlow-400/600-latin.woff2` map, read by `tests/helpers/woff2.ts`
    -- summed and scaled; kerning is ignored and `labelSlack` absorbs it, and
    an unknown character takes the face's widest advance. `labelSlack` is 10,
    not the 6 kerning alone needs: Chrome rounds glyph advances to device
    pixels at some page scales, and at a 1600px viewport the 36-character
    MTAG pill measured 7.07 units wider than the table, which a slack of 6
    let run 0.82 units into the next chromosome. **After changing
    either font file, run `deno task phenogram:metrics`**;
    `tests/phenogram_font_metrics_test.ts` fails until the table matches.
    Python has no Brotli, so it only reads the JSON;
  - a chromosome's column is `max(labelColumn, ceil(widest label +
    labelSlack))`, its pitch `chromosomeWidth + leaderGap + column`, and a
    block is as wide as its column;
  - the present chromosomes, in karyotype order, split into two rows at the
    cut that makes the wider row narrowest (the later cut on a tie); row 1
    stays at `margin + rowHeight + rowGap`, and may be empty;
  - the canvas is `ceil(2*margin + widest row)` by `ceil(lowest chromosome
    name or block + margin)`, or one empty column with no chromosome.
  The drawing constants (`SYMBOL_FONT_SIZE` …, `SYMBOL_FONT_UNITS` …) equal
  the encoding's; the island reads them from it and a Python test pins the
  print twin's. `rowHeight` is still fixed at 760: chromosome 17's thirteen
  genes need 736. The layout tests assert every block inside the canvas and
  its own column, the split minimal, and the e2e suite measures every label's
  `getBBox()` against its column in a real browser. The print figure is set
  in matplotlib's default face unless `--font` is given, and DejaVu Sans is
  wider than Barlow, so its widest pills can still cross a column there.

  A band range such as `10q24.33-q25.1`, which NCBI writes for a gene across
  a band edge, is placed at the middle of its span in both renderers,
  provided both ends are on one arm: a p-to-q range (`1p36.33-q44`) would put
  the gene at the centromere, so it is unplaced, as is any other inexact
  band.
- `lib/phenogram.ts` (island) and `scripts/phenogram_figure.py` (print)
  implement the same rule: chromosomes that carry a gene, to scale, in two
  balanced rows, each in a column as wide as its widest label; a label block
  per gene — symbol and evidence glyphs
  on the first line, then one pill per GWAS trait — stacked by
  `resolveCollisions` (sweep down to enforce the gap, sweep back up at the row's
  bottom). `tests/phenogram_layout_test.ts` and
  `tests/scripts/test_phenogram_figure.py` run the same cases, and the two
  `csvd/` suites pin the same canvas, row split, column widths and summed
  block rects on the committed data.

Its key sits above the plate too, in the same collapsed `<details>` and for the
same reasons — supporting evidence in one cell, the phenotype key spanning two,
both on `auto-fit` grids guarded with `min(…, 100%)`. The skip link targets
`#phenogram-end` after the plate.

Trait identity is text, not colour: each trait is a pill with its label on the
family tint, because no seven-hue palette is pairwise distinguishable under
colour-blindness simulation and the printed figure has no tooltip. The hues are
the dataviz reference palette minus yellow, in the one legend order (of 720)
that clears both adjacent gates; the gates and the OKLab distances are recorded
in `tests/phenogram_encoding_test.ts`.

The SVG is `aria-hidden` decoration. Over it, `ul.phenogram-genes` holds one
absolutely positioned `<li>` per block, in percent of the viewBox, each wrapping
`components/Tooltip.tsx` around a visually-hidden name — so hover, Enter,
Tab-to-link and Escape are the tables' behaviour with no new tooltip code, and
screen readers get every placed gene in chromosome order. Pill backgrounds and
the glyph positions after each symbol are the only geometry measured in the
browser (`getBBox()` on mount and on `document.fonts.ready`); block positions
and column widths depend only on the committed metric table, so the server,
the island and the print figure agree on them before any font loads.
