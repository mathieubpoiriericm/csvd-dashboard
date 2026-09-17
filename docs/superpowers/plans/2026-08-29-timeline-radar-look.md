# Timeline radar look — plan and execution notes

Restyle of the trials radar after the generation/rendering modernization
(`2026-08-29-timeline-radar.md`). Brainstormed on the bounded path: three
mockups, one pick, one implementation across both renderers.

## Context

The radar's visual treatment was carried over unchanged from the matplotlib era:
viridis used categorically for the four populations, Set1 for the eleven
mechanisms (with grey and black as "colours"), ring depth as the same hue at 1 /
0.6 / 0.35 opacity, a 40 % grey disc of empty cells, a white rounded box on all
23 labels, and web-safe `#90ee90` for genetic evidence.

Decisions taken before design:

- **Geometry additive only.** Ring radii, sector spans and marker positions stay
  where the layout rule puts them; a look may add a rim band outside the rings
  or separators between cells.
- **Print follows.** Colours flow to both renderers through
  `lib/timeline_encoding.json`; renderer-specific treatment is ported to
  `scripts/timeline_figure.py`. No hover-only meaning.

## The three looks shown

Published as a comparison page (artifact
`245615a6-f09c-4d9f-81dd-d2af5c6c015a`), drawn from the committed data with the
real layout rule and a copy of the island's fitting passes:

- **A · Journal** — muted tints, ink hairlines, empty cells white, halo labels
  with no boxes, ringed markers for genetic evidence, typographic legend.
- **B · Console** — neutral rings, population hue on a rim band, pill labels,
  chip legend above the plate, drawer with mechanism swatch and population tag.
- **C · Poster** — saturated phase-stepped wedges with white separators, hollow
  bullseye markers, population pills on a rim band.

Shared by all three: one mechanism palette, six hue families with lightness
steps inside each. The dataviz validator cannot pass eleven pairwise-distinct
hues on the all-pairs list (worst cross-family pair ΔE 5.6 protan; within a
family ≈ 10), so identity rides the drug label beside every marker and the
legend, and the colour says the family first.

## What was chosen

Console's chrome with Poster's wedge colouring ("otherwise the internal wedges
just remain grey"), then Journal's rings and text added on top: Poster's stepped
wedges inside Journal's ink hairlines with empty cells white, Journal's halo
text and ringed evidence markers, Console's rim band, chip legend and details
panel. One late request: the evidence ring lifts with its marker on hover.

## Implementation (both renderers, one contract)

Test-first: the encoding, layout, Python and e2e assertions were written and
seen failing before the code.

1. `lib/timeline_encoding.json` — wedge colours and a deeper `band` step per
   population; ring opacities 1 / 0.62 / 0.34; `rimBand` (gap 0.0125, width
   0.04375 of the outer radius); `boundary` hairline; empty cell white;
   `geneticEvidence` as a ring colour or none; family-stepped `mechanisms` plus
   a `families` list. `tests/timeline_encoding_test.ts` declares the expected
   shape and checks the raw file against it.
2. `lib/timeline.ts` — `rimBands` (one annular sector per populated population),
   population labels 24 units beyond the band, `evidenceRing` on markers,
   `familyLegend`. The pinned label radius moved from `OUTER_RADIUS + 24` to the
   band's outer edge + 24.
3. `islands/TrialsTimeline.tsx` — hairline-stroked wedges, band paths, r 8
   markers with a white ring and an r 12 evidence ring, halo text with an
   unpainted fit rect, tracked-caps phase labels, family-grouped chip legend
   above the plate, drawer header with swatch and tag, a white plate `rect` so
   the sheet stays light in dark mode. The separation pass now treats every
   marker as an obstacle too.
4. `assets/app.css` — legend row and chips, the `r` lift on hover/focus, drawer
   header and two-column fields, `--svd-on-figure` token.
5. `scripts/timeline_figure.py` — band filled on the polar axes (pyCirclize
   refuses tracks beyond r 100), hairline outline patches per cell, marker edge
   and evidence-ring scatters, halo twins (matplotlib pathifies text with path
   effects, so each haloed label is a plate-coloured twin under the plain text),
   family-ordered legend with header entries.
6. `CLAUDE.md` Timeline section updated.

Test rule loosened once: `emptyCell.opacity` may now be 1 (the empty cell is
white at full opacity, not a translucent grey).

## Verification

- `deno task check`, `deno task test` (81), `uv run --group figure pytest`
  (843), full e2e (125) — all green. `deno.json` now excludes `.claude` and
  `.venv`: `deno check` was crashing on the JS inside the Python venv and the
  worktrees, and `deno test` had been silently running the other worktrees'
  suites as well (236 "passed" where this checkout has 81).
- `deno task figure` regenerated; print and web renders compared side by side.
- Screenshots in light and dark: plate stays white, chrome switches; drawer,
  tooltip and keyboard path unchanged.
