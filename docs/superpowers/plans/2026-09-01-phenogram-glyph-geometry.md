# Phenogram evidence glyphs — plan and execution notes

Optical matching of the three evidence marks across both renderers. Brainstormed
on the bounded path, implemented in `04d29ff`. The plan is preserved as written;
where the implementation diverged from it, the divergence is recorded inline and
summarised under "As implemented".

## Context

The phenogram marks each gene's non-GWAS evidence with three filled shapes —
triangle (other omics), square (monogenic disease), star (Mendelian
randomization) — drawn at `GLYPH_SIZE = 9` in a 1600×920 viewBox, about 2.3 mm
on the printed page. They are a symbol set, so they should carry comparable
visual weight. They do not:

| glyph    | geometry today          | area (units²) | relative |
| -------- | ----------------------- | ------------- | -------- |
| square   | side 9                  | 81.0          | **1.00** |
| triangle | base 9, height 9        | 40.5          | 0.50     |
| star     | R 4.5, inner ratio 0.42 | 25.0          | **0.31** |

The square carries **3.24× the star's ink**. (Star area = 5·R·r·sin 36°.)

Two related defects surfaced while measuring:

- **The star already differs between the two renderers.** The island uses inner
  ratio 0.42 (`islands/Phenogram.tsx:55`). matplotlib's `*` is hard-coded
  `Path.unit_regular_star(5, innerCircle=0.381966)`
  (`.venv/.../matplotlib/markers.py:652`) — spikier and ~9 % lighter. Nothing
  catches it: `tests/phenogram_encoding_test.ts:141` only asserts `shape` is one
  of the three strings.
- **`scripts/phenogram_figure.py:540` multiplies markersize by an uncommented
  `1.1`**, inflating all three print marks 10 % linearly (21 % by area) over the
  island's. `git log -S` shows it arrived in `22355f7`, the commit that added
  the renderer, and was never revisited — a uniform fudge for a non-uniform
  problem.

Not in scope, because they already agree: matplotlib's `^` is
`[[0,1],[-1,-1],[1,-1]]` scaled 0.5 — base = height = markersize, identical to
the island's isoceles — and `s` is a unit rectangle of side markersize.

## Target

Split the difference between equal-area and equal-bounding-box: exact area
equality makes the square look too small, because a compact silhouette reads
heavier than the same ink dispersed into points.

| glyph    | scale | geometry                      | area  | relative |
| -------- | ----- | ----------------------------- | ----- | -------- |
| square   | 0.80  | side 7.2                      | 51.84 | 1.58     |
| triangle | 0.95  | base/height 8.55, lifted 0.75 | 36.55 | 1.12     |
| star     | 1.00  | R 4.5, inner ratio **0.55**   | 32.73 | 1.00     |

3.24× → 1.58×. The star fills its box and gets the ratio raise that both
de-spikes it and adds the ink it was short of; the other two come down to meet
it. The triangle's lift is half its centroid offset (h/6 = 1.5, so 0.75), enough
to stop an apex-up triangle reading low beside the bold gene symbol.

**The advance box stays 9 units**, so no glyph _position_ changes and
`tests/phenogram_layout_test.ts` / `tests/scripts/test_phenogram_figure.py`
should be untouched. Assert that rather than assume it.

## Changes

### 1. `lib/phenogram_encoding.json` — geometry keyed by shape

Geometry belongs to the shape, not to the evidence category, so it goes in its
own block rather than onto the three `evidence` entries (which keep naming a
`shape` exactly as they do now):

```json
"glyphs": {
  "triangle": { "scale": 0.95, "lift": 0.75 },
  "square":   { "scale": 0.8 },
  "star":     { "scale": 1, "innerRatio": 0.55 }
}
```

This is the house pattern — the encoding file "holds appearance only … and the
geometry constants", and both renderers read it.

### 2. `islands/Phenogram.tsx` — `glyphPath` reads the geometry

`glyphPath(shape, x, y, size)` at `:43-67` gains a geometry lookup from
`encoding` (already imported at `:9-14`). Centre each scaled shape in the 9-unit
box so `x` advance is unchanged:

- square: inset `(9 − 9·scale)/2 = 0.9` on both axes, side 7.2
- triangle: apex `(x+4.5, y+0.225−lift)`, base `(x+0.225, y+8.025)` →
  `(x+8.775, y+8.025)`
- star: unchanged loop, `inner = outer * geometry.innerRatio`

**The legend needs its viewBox widened.** `:333` renders each glyph in
`viewBox="0 0 9 9"` and calls the same `glyphPath`; the lifted triangle's apex
lands at y = −0.525 and would clip. Use `0 -1 9 10` (or drop the lift in the
legend — but then the two disagree, so widen it).

> **As implemented: this was not needed, and the viewBox is unchanged.** Writing
> it made clear the lift is a _placement_ correction rather than a property of
> the shape — it decides where a mark sits against the bold gene symbol. So
> `glyphPath` draws box-centred and the lift is applied at the call site
> (`glyphY - glyphLift(shape)`, and `glyph_y - glyph_lift(...)` in Python). The
> legend reuses the same path unlifted, nothing clips, and `viewBox` stays
> `0 0 9 9`. Server-rendering the island confirms it: the legend triangle emits
> `M 0.23 8.77 L 8.77 8.77 L 4.50 0.23 Z`, comfortably inside the box.

The main figure needs no headroom change: `glyphY` centres the 9-unit box on a
16-unit `symbolLine`, leaving 3.5 units clear above.

### 3. `scripts/phenogram_figure.py` — per-shape markers

- Replace `MARKERS = {...}` (`:56`) with the geometry read from the encoding, so
  the constant stops being a second source of truth.
- **Star:** `marker=MarkerPath.unit_regular_star(5, innerCircle=ratio)`.
  `_set_custom_marker` (`markers.py:451-454`) rescales by
  `0.5 / max(|vertices|)` and `unit_regular_star` has max |vertex| = 1, so a
  custom path is sized identically to the built-in `*` — a drop-in, and it fixes
  the 0.42/0.382 divergence. Import as
  `from matplotlib.path import Path as MarkerPath`: `Path` at `:26` is already
  `pathlib.Path`.
- **markersize:** `GLYPH_UNITS * PT_PER_UNIT * scale`, per shape. **Drop the
  `1.1`** — with per-shape scales the two renderers then agree exactly at 9
  units. This visibly shrinks the print marks ~10 % from today; eyeball it.
- **Triangle lift:** `glyph_y - lift`. The axes are inverted, so data
  coordinates are viewBox units and subtracting raises it, as on the island.

### 4. `tests/phenogram_encoding_test.ts`

Extend `"evidence glyphs, the citation and the stains are complete"` (`:134`):

- every `shape` named in `evidence` has a `glyphs` entry (the "Add the entry; do
  not widen the test" rule, which is exactly what was missing here)
- `scale` in `(0, 1]` for each
- `star.innerRatio` present and within `0.3–0.7` — outside that it stops reading
  as a star

Add a case pinning that both renderers derive the same star ratio, since that is
the divergence this fixes and the existing suite could not see it.

## Verification

```bash
deno task check                      # fmt gates the encoding JSON
deno task test                       # encoding + layout tests
uv run pytest tests/scripts          # NOT run by CI — must be explicit
uv run ruff check . && uv run ty check
```

Layout tests are expected to pass **unchanged** — if
`tests/phenogram_layout_test.ts` or `tests/scripts/test_phenogram_figure.py`
fails, a glyph position moved and the advance box was not held at 9.

Then look at both renderers, since this is a visual change and the tests only
pin geometry:

```bash
deno task figure                     # figures/phenogram.{svg,pdf,png}
deno task dev                        # the island, and the legend
```

Compare `figures/phenogram.svg` against the current one (it is gitignored, so
copy it aside first). Check three things: the three marks read as one set at
print size; the star still reads as a star at ratio 0.55; and the print marks
have not become too light after dropping the `1.1`.

## As implemented

Shipped in `04d29ff`; six files, 272 insertions. Three deltas against the plan
above, none of which changed the target geometry:

- **The legend viewBox was left alone** — see the note under Changes §2. The
  lift moved to the call site instead, which is the better boundary.
- **`MARKERS` was narrowed rather than deleted.** `_BUILTIN_MARKERS` still holds
  `^` and `s`, because matplotlib draws those exactly as the island does; only
  the star is built from the encoding, which is the one that diverged.
- **The legend marks are scaled too.** `LEGEND_GLYPH_PT` is the base size the
  per-shape scale multiplies, so the legend carries the same relative weights as
  the figure. The plan did not mention the legend's own marks.

The test coverage also landed wider than planned: the encoding test gained the
two cases described in §4, and `tests/scripts/test_phenogram_figure.py` gained a
`TestGlyphGeometry` class of five, because the star divergence is a property of
the _print_ renderer and is best pinned there. Both new gates were
mutation-checked rather than trusted green — the ink test reports `3.24x` and
fails at the old geometry, and the star test detects `innerRatio 0.381966` as
matplotlib's own.

`figures/phenogram.{svg,pdf,png}` were regenerated and eyeballed at true print
size. One open judgement: at high magnification the star at `innerRatio 0.55`
reads blunt. It is correct at print size, and `0.48–0.50` is the knob if it ever
needs to read crisper; the encoding test admits `0.3–0.7`.

## Follow-up, not done here

Publishing the export at the end of a pipeline run — so the figures track the
database without a manual `deno task data` — was investigated in the same
session and is written up separately in `2026-09-01-pipeline-export-on-run.md`.
