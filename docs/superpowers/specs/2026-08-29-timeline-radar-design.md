# Trials Timeline Radar — Design Spec

Date: 2026-08-29 Status: approved. Implementation plan:
`docs/superpowers/plans/2026-08-29-timeline-radar.md`.

## Context

`scripts/python_plot.py` builds `static/timeline.html` + `static/timeline.js` by
concatenating SVG strings because no library matched the figure last year. Spike
(2026-08-29) named it: a **tech-radar layout** — rings (phase) × proportional
sectors (population, span ∝ unique drugs) × labelled blips (drugs) — with
wedge/blip tooltips, a details drawer, and keyboard/ARIA hardening.

Defects in the script and the committed artifact:

- `_CHAR_WIDTHS` estimates Raleway glyph widths to size label boxes; the
  artifact now uses IBM Plex Sans. `timeline.js` re-measures population labels
  with `getBBox()`, drug labels only when they collide with their marker.
- Manual drop shadows, `X_OFFSET`, `.render-mask`: Chromium workarounds.
- 9 marker colours cycle over 11 mechanisms: _Anti-fibrin_ and
  _Antifibrinolytic_ duplicate the red/blue of two other mechanisms (visible in
  the legend).
- Label collisions in dense cells (Edaravone ×2, Cilostazol ×2).
- The generator cannot reproduce the artifact: input
  `data/csv/table2_for_py.csv` and output `www/` do not exist here, and
  `timeline.html` was hand-hardened afterwards (Plex, `<title>/<desc>`, ARIA,
  close button). Only the registry-ID e2e check ties it to `data/table2.json`;
  the 16 trials are duplicated as `data-*` attributes.

Decision: draw the figure **in-app** (recommended path) **and** keep a
**reproducible Python drawing** for a manuscript, on pyCirclize.

## Candidate survey (verified 2026-08-29, for the record)

| Option                                                     | Sectors         | Fitted labels                | Tooltip / drawer / keyboard                                    | Payload         |
| ---------------------------------------------------------- | --------------- | ---------------------------- | -------------------------------------------------------------- | --------------- |
| In-app Preact island (sector path math ported to TS)       | yes             | `getBBox`, real font         | reuse app tooltip styling; port drawer/ARIA from `timeline.js` | ~0              |
| pyCirclize 1.10.1 (Oct 2025, matplotlib; sectors × tracks) | yes             | matplotlib metrics           | static (Jupyter-only tooltips)                                 | 0               |
| Plotly Barpolar/Scatterpolar                               | yes             | no text backgrounds in polar | hover only                                                     | 1.33–1.43 MB gz |
| Bokeh 3 `annular_wedge`                                    | yes             | yes                          | canvas, no keyboard/ARIA                                       | ~1 MB           |
| R ggplot2 `coord_radial` + ggiraph                         | yes             | yes                          | SVG hover; drawer re-bolted                                    | widget JS       |
| Vega-Lite 6.4 arc                                          | yes             | no                           | hover                                                          | ~500 KB+        |
| ECharts 6.1 polar custom series                            | yes             | yes                          | canvas/SVG, no per-element ARIA                                | ~300 KB+        |
| plotnine 0.15.8                                            | no polar coords | —                            | —                                                              | —               |

## Design: two renderers, one contract

```text
data/table2.json ──┬──> lib/timeline.ts ──> islands/TrialsTimeline.tsx (SVG, browser metrics)
                   │         ▲
lib/timeline_encoding.json ──┤  (populations, rings, palette, fills — the only styling truth)
                   │         ▼
                   └──> scripts/timeline_figure.py ──> figures/timeline.{svg,pdf,png} (pyCirclize)
```

- **Encoding is shared, computation is duplicated on purpose.** What drifted
  before was styling: colours, order, radii. Those move into one committed file,
  `lib/timeline_encoding.json`, imported by `lib/timeline.ts`
  (`with { type: "json" }`, like `lib/data.ts`) and read by the Python script.
  The ~30-line layout rule (sector span ∝ unique drugs, 12 cells, markers at
  `(j+1)/(m+1)` in table order) is written once in each language so the paper
  script stays runnable from the data table alone, with no Deno step — the same
  cross-language contract the repo already runs between `export.R` and
  `lib/data.ts`.
- **`tests/timeline_encoding_test.ts` is the guardrail** (CI, pure Deno): every
  `svdPopulation`, `clinicalTrialPhase` and `mechanismOfAction` in the committed
  `data/table2.json` has an entry; colours are valid hex and pairwise distinct
  (retires the 9-over-11 cycling bug for good); ring radii are increasing and
  end at 1. A new mechanism in the data fails this test until it is given a
  colour — the point.
- Stricter alternative, not chosen: have TS emit `data/timeline_layout.json` and
  let Python only draw. One computation, but the paper figure would then depend
  on a Deno regen step. Revisit only if the two layouts ever diverge.
- Same encoding, different dress: the app keeps tooltips, drawer, focus rings
  and shadows; the paper figure drops interactivity and shadows and takes print
  options (font, size, dpi). Geometry, colours and labels match.

### Encoding file shape (`lib/timeline_encoding.json`)

```json
{
  "populations": [
    { "key": "CAA", "label": "CAA", "color": "#440154", "ink": "#fff" },
    {
      "key": "Cognitive Impairment",
      "label": ["Cognitive", "Impairment"],
      "color": "#31688e",
      "ink": "#fff"
    },
    { "key": "Stroke", "label": "Stroke", "color": "#35b779", "ink": "#000" },
    {
      "key": "SVD",
      "label": ["Any SVD", "(including monogenic)"],
      "color": "#fde725",
      "ink": "#000"
    }
  ],
  "rings": [
    { "phase": "III", "innerRadius": 0, "outerRadius": 0.5625, "opacity": 1 },
    {
      "phase": "II",
      "innerRadius": 0.5625,
      "outerRadius": 0.78125,
      "opacity": 0.6
    },
    { "phase": "I", "innerRadius": 0.78125, "outerRadius": 1, "opacity": 0.35 }
  ],
  "emptyCell": { "color": "#c8c8c8", "opacity": 0.4 },
  "geneticEvidenceFill": { "Yes": "#90ee90", "No": "#ffffff" },
  "mechanisms": {
    "Neuroprotective, antioxidant (multiple mechanisms)": "#…",
    "…": "#…"
  }
}
```

Radii are fractions of the outer radius (180/250/320 of 320 today) so each
renderer scales to its own canvas. `key` is the raw `svdPopulation` value
(`"SVD"` is the data's name for the last population; the display label lives
here, replacing `pop_name_mapping`). Palette: ≥ 11 distinct, print-safe colours
(e.g. ColorBrewer Paired/Tableau 12); replace `#ffff33`, which has no contrast
on the light plate.

## Part 1 — in-app island

- `lib/timeline.ts` — pure, DOM-free layout: reads `trials` from `lib/data.ts`
  and the encoding; returns sectors (start/end angle from 12 o'clock,
  clockwise), 12 cells (colour, opacity, path `d`), 16 markers (θ, r, anchor
  side, mechanism colour, label fill, trial fields), population/phase label
  anchors, legend entries. Port `annular_sector_path` from the script — the
  geometry there is correct; the hack was string-building the document and
  faking text metrics around it. No d3 dependency needed.
- `islands/TrialsTimeline.tsx` — renders the SVG (`viewBox` kept at
  `0 0 1600 800` so the figure keeps its proportions), fits label boxes with
  `getBBox()` in a layout effect (port of `fitPopLabel` /
  `adjustMarkerLabelOverlap` from `static/timeline.js`, including the tspan
  shift fix), pointer tooltips (`aria-hidden`, styled on the app's tooltip
  tokens; SVG groups cannot be `<button popovertarget>`, so hover is
  pointer-only as today and the keyboard path is the drawer), and the drawer as
  an in-page `<aside role="region" aria-live="polite">` with the current
  semantics: `g.drug` gets
  `role="button" tabindex="0" aria-expanded
  aria-controls`, Enter/Space/click
  open, close button takes focus, Escape closes, focus returns, `inert` while
  closed.
- `routes/timeline.tsx` — `Page` + tips row (keep both `TipBox`es; the e2e
  "embed tips" test pins them) + island, instead of `EmbedPage`.
  `components/EmbedPage.tsx` / `islands/EmbedFrame.tsx` stay for the phenogram.
  Superseded: the phenogram spec of the same day removes them.
- `assets/app.css` — timeline rules on semantic tokens only (the styles contract
  test forbids literals). The plate stays light in dark mode: hue encodes
  meaning, same rule as the embeds. `.timeline-plate` background, drawer,
  tooltip, `:focus-visible` ring.
- Delete `static/timeline.html`, `static/timeline.js`, `scripts/python_plot.py`;
  remove `static/timeline.js` from `deno.json` `exclude`; the `THEME_MESSAGE`
  handoff stays for the phenogram only (superseded 2026-08-29: the phenogram
  island removed it).
- Tests: `tests/timeline_layout_test.ts` (spans sum to 2π, 4 sectors ordered as
  the encoding, 12 cells, 16 markers, each marker inside its cell, greyed cells
  exactly where no trial exists, path strings for a known cell).
  `tests/timeline_encoding_test.ts` as above. e2e: replace the timeline block of
  `e2e/tests/embeds.spec.ts` and all of `e2e/tests/timeline-layout.spec.ts` with
  `e2e/tests/timeline.spec.ts` (counts 16/13/12/4/3, drawer pointer + keyboard,
  tooltip contrast, no label box overlapping its own marker,
  `.visually-hidden a` style rules not needed here); update the `/timeline`
  branch of `e2e/tests/theme.spec.ts` (no iframe any more). The registry-ID
  drift test is deleted — the island reads the table.

## Part 2 — pyCirclize paper figure

- `scripts/timeline_figure.py` — same docstring/argparse style as
  `scripts/validate_pipeline.py`. Reads `data/table2.json` and
  `lib/timeline_encoding.json` (no CSV step). Layout module-level functions
  mirror `lib/timeline.ts` names (`sector_spans`, `cells`, `markers`) so the two
  can be read side by side.
  - `Circos(sectors={pop: n_unique_drugs}, start=0, end=360, space=0)`; confirm
    at implementation that 0° is 12 o'clock/clockwise, else set `start` so the
    first population begins at the top as in the app.
  - Per sector, one `add_track(r_lim=(inner*100, outer*100))` per ring;
    `track.rect(...)` for the cell fill/opacity (grey when empty).
  - Markers: `track.scatter(x, [0.5], vmin=0, vmax=1, color=mech)`; labels:
    `track.text(drug, x, r_mid, bbox=dict(boxstyle="round,pad=0.3",
    fc=evidence_fill, ec="none"), adjust_rotation=False)`
    — kwargs reach matplotlib, so boxes are measured by the real font renderer.
  - Population labels via `sector.text(label, r=108, bbox=…)`; phase labels via
    `circos.text("Phase …", r=r_mid, deg=boundary, bbox=white)`.
  - Legends: `fig = circos.plotfig()`, then two `ax.legend(...)` on `circos.ax`
    (`Line2D` marker handles for mechanisms, `Patch` handles for genetic
    evidence; `ax.add_artist` keeps both).
  - Collisions: deterministic stagger for same-cell rows (alternate the label
    radius) plus a measured pass after `fig.canvas.draw()` using
    `Text.get_window_extent()` — the print-side twin of `timeline.js`'s radial
    nudge.
  - Options: `--out figures/`, `--format svg pdf png` (default all),
    `--dpi 300`, `--font PATH.ttf` (default matplotlib sans-serif; journals
    usually want Arial/Helvetica, and IBM Plex only ships here as woff2, which
    matplotlib cannot load). rcParams `svg.fonttype = "none"` (editable text),
    `pdf.fonttype = 42`.
- Packaging: `pyproject.toml`
  `[dependency-groups] figure = ["pycirclize>=1.10.1"]`
  (matplotlib/pandas/biopython are already base deps; `uv.lock` pins it — that
  lock is the reproducibility claim for the paper). `deno task figure` →
  `uv run --group figure scripts/timeline_figure.py`. Add `figures/` to
  `.gitignore`; outputs are regenerated, not committed (override if co-authors
  need them in git).
- Tests: `tests/scripts/test_timeline_figure.py` — layout functions against the
  committed table (4 spans summing to 360, 12 cells, 16 markers, same greyed
  cells as the TS test lists), and a render smoke test to `tmp_path` asserting
  the SVG contains 16 marker `gid`s and both legends. `ruff` and `ty` clean.

## Part 3 — docs

- `CLAUDE.md`: islands list (six), the "static artifact"/embed paragraphs, the
  fmt/lint exclude note, a short "Timeline" section describing the shared
  encoding contract and the two renderers.
- `README.md` lines ~158–161;
  `docs/superpowers/specs/2026-08-29-pipeline-teardown.md` hazard line about
  `timeline.html`.

## Verification

- `deno task check`, `deno task test` (new layout + encoding tests pass; the
  styles contract test stays green), `deno task test:e2e` (new timeline spec,
  updated theme spec, navigation/runtime unchanged).
- `uv sync --group figure && uv run pytest tests/scripts/test_timeline_figure.py`,
  `uv run ruff check .`, `uv run ty check`.
- `deno task figure` writes `figures/timeline.svg|pdf|png`; compare side by side
  with `/timeline` in `deno task dev`: same sector order and spans, same cell
  colours/greys, 16 markers in the same cells, distinct legend swatches, no
  label overlapping its marker.
