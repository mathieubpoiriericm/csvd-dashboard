# Styling

Guidance for `assets/app.css` — the one stylesheet. The root `CLAUDE.md` covers
the rest of the architecture.

## Tokens

The three token tiers (palette, semantic, legacy) and the rule for which tier a
rule may read are documented at the head of `assets/app.css`, as is why the dark
block is declared twice; `tests/styles_contract_test.ts` enforces both.

**A form control's edge is `--svd-line-control`, not `--svd-border`.** An empty
field's box is all that marks where the field is, so WCAG 1.4.11 holds its
boundary to 3:1, and the divider hairline measured 1.36:1 on the light ground
and 1.78:1 on the dark one. The token is `--svd-slate-600`, the one ramp step
that clears 3:1 in both themes (3.9:1 on the light ground, 3.8:1 on the dark
surface), so the dark blocks do not override it. It draws the wizard's inputs
and the shared table and login field recipe; hover darkens (light) or lightens
(dark) it to `--svd-text-muted`, and focus is the ring. Buttons keep the
hairline: their text is what identifies them. The styles contract resolves the
token in both themes and measures it against the ground and the surface.

## Depth

Every panel is a **blueprint object**: square, transparent, hairline-bordered,
with a `+` registration mark at each corner. That is one recipe, not a pile of
per-component treatments. A surface joins by being listed in the shared rule at
the head of `=== CARDS & VALUE BOXES ===` and says what it _is_ by re-declaring
`--svd-tint`, its meaning colour; the recipe reads it back as the border colour
and as the mark ink. That is still what makes a warning read as a warning before
the words are.

Those parameters are a **fourth tier**, above the three below: unlike tiers 1-3
they are not names a rule reaches for globally, and they are absent from the
dark blocks on purpose — each resolves through a tier-2 token the dark blocks
already override. Custom properties inherit, so a tint set on an element reaches
every descendant that reads one; that is what lets the `.pipeline-badge-count`
inside a warning badge pick up the amber without being told — the badge's tint
class declares `--svd-tint` once and the count reads it back as its own wash.
Ink does not follow: `--svd-tint-ink` (`app.css` ~285) is a `color-mix()`
resolved once on `:root` from `--svd-tint`, and a custom property containing
`var()` is substituted at computed-value time on the element that declares it —
a descendant re-declaring `--svd-tint` does not make `:root`'s already-resolved
`--svd-tint-ink` re-run. A component that wants the ink re-tinted too has to
re-declare `--svd-tint-ink` itself, the way `.pipeline-tint-danger` (`app.css`
~4350) does.

Not everything boxed is a panel, and `tests/styles_contract_test.ts` pins each
exception. A **note** (`.tip-box`, `.notice`) is a rail and a wash with no
registration marks: four crosses round a one-line hint read as the frame of a
second figure. A **record in the run drawer** is a row of its list, not a framed
surface. **Chips, badges and counts** are pills, through `--svd-radius-full`,
and they are the one rounded family. The figure keys' toggle is **filled**, like
the login button, which is the only other filled control.

Six things are load-bearing:

- **The four corner marks are eight background layers on one `::after`, not four
  `<i class="corner">` children.** The design system's own recipe is the four
  elements; porting it literally would mean four decorative nodes on each framed
  surface, and a trap every time one is conditionally rendered. The overlay
  lands on the same pixels: it sits `--svd-mark-out` outside the box, which puts
  each cross centre exactly on the panel's corner, and the arms are the system's
  own 11px × 1px. `pointer-events: none` is not optional — the overlay covers
  the whole panel, and without it every click on a card lands on the decoration.
- **Geometry lives in tokens, not in the rules.** `--svd-mark-len`,
  `--svd-mark-out` and `--svd-mark-arm` are why every framed surface shares one
  definition of the mark. `tests/styles_contract_test.ts` pins that no layer
  hard-codes 11, 6 or 5 px, and that every framed surface actually draws the
  marks — the system's one "don't" about the frame is _"do not drop the
  registration marks from a framed element"_. The 1px arm thickness is a literal
  on purpose: it is one device pixel, not a scale value.
- **A scroll container cannot wear the frame.** `overflow: auto` clips a
  pseudo-element at negative inset, so `.table-scroll`, `.timeline-scroll` and
  `.phenogram-scroll` would simply lose their marks. Each is wrapped in a
  `.blueprint-frame` instead — which is what the design system does, and why its
  guide says a blueprint wrapper's frame "must win" over an overlay that clips.
  The wrapper is also the flex child now, so the growth and the `min-width: 0`
  floor moved onto it.
- **`--svd-tint-base` is `transparent`, and a surface that overrides it owes a
  reason.** A line drawing that painted a fill would hide the ground its own
  marks are drawn on. The legitimate exceptions are surfaces that float over the
  page (the two drawers, the tooltip panel) and cells that scroll under their
  own rows (the sticky table head and identity column, which a separate contract
  test already pins as opaque).
- **Nothing lifts.** The frame has no elevation to animate, so the hover
  transforms are gone rather than neutralised under `prefers-reduced-motion`.
  Hover is a border-colour and wash change now. A blanket
  `*:hover { transform: none }` would still be wrong if one came back:
  `.skip-link` carries a static `translateY` that parks it off-screen until it
  is focused.
- **`--svd-tint-ink` is a parameter, not a formula.** The 82% mix that gives
  chips their ink is calibrated for the primary; warn or danger at that step
  falls to ~3.9:1 on its own wash. A component that re-tints a chip has to
  re-declare the ink with its own step — and **the `-text` steps are not always
  that step.** They are calibrated against white; a chip's 14% wash is its own
  hue, so the ground darkens under the ink and the same colour measures lower
  there. `--svd-color-ok-ink` and `--svd-color-warn-ink` are the
  one-step-further inks for exactly that case, and the pipeline status badges
  are what needs them: measured on the rendered pixels they are 6.44:1 (ok) and
  5.57:1 (warn), where the design system's own inks measure 3.34 and 3.69.
  Measure a new tint on a screenshot rather than against white. That is the
  light theme. In dark, `--svd-color-warn-ink` and `--svd-color-ok-ink` resolve
  to the same step as their fills (amber-300, green-400), which already clear AA
  on the dark ground; the distinction is light-only.
- **Focus reads `--svd-focus-*`, with no exceptions left.** Every
  `:focus-visible` rule resolves `var(--svd-focus-width)`,
  `var(--svd-focus-offset)` and `var(--svd-focus-color)`. There used to be one
  override — `.tooltip-pop .tooltip-link-btn` swapped in `--svd-tooltip-ink`
  because it sat on a filled indigo panel where the indigo ring vanished. The
  panel is a page-ground box now, so the ring is visible on it and the override
  is gone. `--svd-ring-accent` is not a candidate for a new one: it is a
  _rest-state_ border tint at 30% alpha, and as an outline it measured 1.46:1
  against the card where WCAG 1.4.11 wants 3:1. The accent tokens mark "this
  control responds to you"; they do not mark where the keyboard is.
  `tests/styles_contract_test.ts` also requires every control that lights on
  `:hover` to light on `:focus-visible`. `.phenogram-canvas` and
  `.timeline-figure` re-declare `--svd-focus-color` to `--svd-figure-ink` for
  the same reason the old tooltip override existed — the figures paint a fixed
  white plate in both themes, and dark mode's light-steel focus colour measured
  1.99:1 there — but every `:focus-visible` rule underneath still resolves
  `var(--svd-focus-color)` unchanged, so this is a scoped parameter rather than
  a second exception.

No `backdrop-filter` anywhere, deliberately. The navbar and the timeline drawer
are translucent, but a blur of a flat field returns that same flat field — over
this page's ground it would cost a backdrop snapshot per scroll frame to change
nothing, and the drawer sits _beside_ the plate with nothing behind it at all.
`--svd-surface-translucent` is the one translucent-surface token, derived by
`color-mix` from `--svd-surface` so it needs no dark override.

The interaction accent has tier-2 names of its own — `--svd-bg-hover-accent`,
`--svd-ring-accent`, `--svd-rail-accent`. Those mark _this control responds to
you_, which is not what `--svd-tint` means, so filter rows, table row rails and
pagination read them rather than the surface's tint.

`deno fmt` does format `.css`, but nothing in the toolchain checks it
semantically, so `tests/styles_contract_test.ts` is the guardrail for every rule
above — keep it that way.

Two things are load-bearing beyond the tokens:

- **Icons need `flex: none`.** `img, svg { max-width: 100% }` resolves against a
  flex parent that is itself sized by its content, so the measurement is
  circular and the glyph collapses to zero width. `.icon` carries the reset.
- **`--svd-z-sticky` must clear 1000.** Leaflet puts `.leaflet-top` at 1000 and
  `.leaflet-container` creates no stacking context, so those values compete at
  the root. A lower navbar gets painted over by the map controls.

## Typography and figure colour

Typography is **Barlow Condensed over Barlow**, self-hosted as static faces
because Barlow has no variable release; the `@font-face` blocks in `app.css` are
the inventory and `tests/styles_contract_test.ts` fails on a weight none of them
declares.

**No mono face ships.** Nine rules read `--svd-font-mono` and they were two
different intentions: seven wanted tabular figures, which the design draws in
the condensed face with `font-variant-numeric`, and four wanted real monospacing
— the HTTP method, the API path, the note subjects and the endpoint box in the
run widget, all of which are code. The first group reads `--svd-font-heading`;
`--svd-font-mono` survives for the second as the platform's own stack.

Both figures keep their data colours out of the theme: wedge, band, marker,
ring, pill and label colours are SVG attributes or inline styles from the two
encoding files, never CSS, so the dark blocks cannot reach them. The tokens
fixed for that reason — declared once and never overridden by the dark blocks —
are `--svd-figure-ink` (text on the plate), `--svd-figure-plate` (the
phenogram's plate; the timeline paints its own inline), `--svd-on-figure` (text
on a data-coloured fill), and `--svd-figure-surface` + `--svd-figure-heading` +
`--svd-figure-line`, the white panel, heading steel and swatch ring of the
timeline's hover tooltip, which floats over the plate and so cannot follow the
theme either.

Both plates stay **white**, and both figures keep the palettes they have. The
Industry import deliberately did not take the design canvas's `figurePalette`
default, which recolours all eleven mechanisms and all four populations into
tints of the one accent: that removes the only channel saying _family_, and
`tests/timeline_encoding_test.ts` fails when two mechanisms share a colour.
