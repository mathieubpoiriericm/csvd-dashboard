# Industry design import — decisions and amendments

The plan is `docs/superpowers/plans/2026-09-08-industry-design-import.md`. This
records the places the design canvas and the committed app disagreed on
substance, the call made in each, and the amendments the execution made to the
plan. It exists so that the next person to open the canvas does not re-litigate
any of it from the canvas's own defaults.

**Source:** `claude.ai/design/p/e3f86d16-4f61-400e-be8e-fea1cf37058e`, file
`cSVD Dashboard.dc.html`, with its design system at
`_ds/industry-157c90c7-6fa7-4c97-8cbc-4fd3656b1e10/`.

## What the canvas is

A complete, running recreation of this dashboard — every screen, reading the
real committed `data/*.json` — rendered on the Industry design system. It is not
a diff, and it is not authoritative about behaviour: it was captured at a point
in time and is stale in the three places below. Read it as _this is what every
surface should look like_.

Three of its files are canvas scaffolding with no counterpart here: `support.js`
(the `dc-runtime` React harness), `_ds/…/_ds_bundle.js` (the design-system
loader for the preview pages) and `_ds/…/_ds_manifest.json` (the card index).
`_ds/…/styles.css` and `readme.md` are the spec for tokens and component
grammar.

## Decision 1 — the figures keep their own palettes

The canvas exposes a `figurePalette` prop with two settings and **defaults to
`"steel"`**, which recolours all eleven mechanisms and all four populations into
tints of the one accent:

```js
mechanisms[name] = steel
  ? this.mixHex(RAMP[fi % RAMP.length], Math.min(0.45, mi * 0.11))
  : hue;
```

**Not ported.** Three reasons, in order of weight:

1. It contradicts the figure's own rationale, recorded in the root `CLAUDE.md`:
   eleven pairwise-distinct hues cannot clear a colour-vision check, so identity
   rides the drug label and the legend and **the colour says the family first**.
   Collapsing six families onto one hue deletes the only channel that says
   _family_.
2. `tests/timeline_encoding_test.ts` fails when two mechanisms share a colour,
   and `RAMP[fi % RAMP.length]` with `mi * 0.11` clamped at `0.45` collides as
   soon as two families take the same ramp step.
3. The same call was already made once, against grey wedges.

The canvas's `"source"` setting **is** the committed encoding, so this decision
means `lib/timeline_encoding.json`, `lib/phenogram_encoding.json`,
`lib/timeline.ts`, `lib/phenogram.ts` and both print scripts were not touched.
Only the figures' frames and the position of their keys changed.

## Decision 2 — the sample-size histogram and slider are not re-added

The canvas's filter rail carries a target-sample-size histogram over a
dual-thumb range slider, and the design project's snapshot of this repo still
contains `components/RangeSlider.tsx` and `components/SampleSizeHistogram.tsx`.

Both were **deliberately removed one commit before this branch** —
`24d1e45
Remove the trials table's sample-size slider`. The canvas predates it.
Re-adding them is a product decision, not a design import. The two
`input[type="range"]` rules in the canvas's `<style>` block have no destination
and were dropped with them.

## Decision 3 — white plates, seven rings

The canvas's timeline encoding is stale in two ways: it lists **five** rings
(`IV, III, II, I, (unknown)`) where the committed encoding has seven — `II/III`
and `I/II` were added in `aba0e5e` — and it draws on a 1252×1000 plate where
`lib/timeline.ts` uses `CANVAS = {width: 1072, height: 940}`. It also moves both
figure plates from white to `#f5f5f8`.

None taken. The ring set is a correction the canvas predates; the canvas plate
size is its own recreation rather than a specification; and moving the plate 3%
darker would mean editing `lib/timeline_encoding.json`,
`scripts/timeline_figure.py`, `tests/timeline_encoding_test.ts` and
`e2e/tests/timeline.spec.ts` (which pins `stroke={PLATE}` as `#ffffff`) for a
difference no reader can name. `--svd-figure-plate` stays `--svd-white`.

## Amendments made during execution

### The status ramps survived the repalette

The plan proposed re-deriving the status hues from the canvas's three inks. What
shipped keeps **red, amber and green unchanged** and extends two of them.

Red, amber, green plus a steel `completed` are the five-way trial-status
encoding — not decoration — and a mono steel ramp has no step that can say
"terminated". The canvas keeps three status inks of its own for the same reason
rather than tinting them steel. Amber gained 600/700 and green gained
400/500/800, which are the canvas's `--warnInk` and `--okInk` and their dark
counterparts; those two roles used to come off the retired teal and ember ramps.

### The warning role needed a hue of its own

`.pipeline-tint-ember` read `--svd-color-accent`, which was correct on a two-hue
palette because ember was not the primary. On a mono palette it would make
"Passed with warnings" the same colour as every link on the page, so tier 2
gained `--svd-color-warn` / `--svd-color-warn-ink`. The class keeps its name:
the encoding, the island and two test files all spell it, and renaming a tint
across all four is a separate change from repointing what it resolves to.

### The canvas's status inks fail AA on their own washes

Measured on a 22% wash of each ink over the ground — the shape the badges
actually take:

| Canvas ink       | On ground | On its own 22% wash |
| ---------------- | --------- | ------------------- |
| `#1a7f5a` ok     | 4.44:1    | **3.34:1**          |
| `#b3261e` danger | 5.84:1    | **4.07:1**          |
| `#8a6100` warn   | 4.95:1    | **3.69:1**          |

This is exactly the failure the repo's `--svd-color-*-ink` tokens exist to fix,
so each role ships with an ink one step darker than its fill. Measured on the
rendered pixels through a canvas — computed styles come back as `oklab()`, which
a naive parse turns into nonsense — every chip clears AA in both themes. The
tightest are the muted tint at 5.36:1 light and 4.56:1 dark, then the warning
badge at 5.77:1 and ok at 6.62:1.

### The corner marks are eight background layers, not four elements

The design system's own recipe is `.blueprint` plus four
`<i class="corner tl|tr|bl|br">` children. Porting it literally would mean four
decorative nodes on each of seventeen surfaces across nine components, and a
trap every time one is conditionally rendered. They are drawn instead as eight
background layers on one `::after` overlay, landing on the same pixels. See
`assets/CLAUDE.md` for the geometry and the two rules that keep it honest.

## What the frame broke, and what it taught

Four defects the import introduced, all found by the suite or by a breakpoint
sweep rather than by reading:

- **A framed surface must never be `position: static`.** The marks are an
  absolutely positioned `::after`, so `static` hands them to the initial
  containing block instead of the panel. At 390px with a trial record open,
  `.timeline-drawer`'s marks measured 402px against a 390px viewport.
  `position: relative` with no offsets lays out identically and keeps the
  containing block; a contract test now refuses `static` on any recipe member.
- **A scroll container cannot wear the frame.** `overflow: auto` clips a
  pseudo-element at negative inset. `.table-scroll`, `.timeline-scroll` and
  `.phenogram-scroll` are wrapped in a `.blueprint-frame` instead — which is
  what the design system does. `.sidebar-section` was a fourth case in disguise:
  uncapped and still `overflow-y: auto`, it grew a 6px scrollbar from the marks
  alone.
- **`auto-fit` needs `min(…, 100%)`.** `minmax(19rem, 1fr)` makes 19rem a hard
  floor, so below that much container the tracks overflow rather than
  collapsing. Both figure pages grew a 1px horizontal scrollbar at 320px.
- **A drawn grid costs more horizontal chrome than a gap-and-rule row.** Four
  cells of padding plus four hairlines against three rules and three gaps is
  ~50px at 380px, which pushed the About page's four totals out of their own
  hero.

## Tests that moved from a literal to the invariant

Five assertions pinned a value where the property that mattered was a
relationship. Each now asserts the relationship, which is why the change that
kept the invariant stopped failing them:

| Test                        | Was                                                                 | Is                                                                      |
| --------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `styles_contract` F25       | the three headline figures are `var(--svd-font-mono)`               | they resolve the **same** family as `.about-kpi-value`                  |
| `styles_contract` halo ramp | `--svd-halo-lift` > `--svd-halo`                                    | no mark layer hard-codes 11/6/5px, and every framed surface draws marks |
| `tooltips.spec`             | the label is `font-weight: 700`                                     | the label out-weighs the row it labels                                  |
| `genes-table.spec`          | the current page is `font-weight: 700`                              | it carries `aria-current` and is the one filled button                  |
| `filter-collapse.spec`      | the panel is `position: static` and `clientHeight === scrollHeight` | it is un-stuck, unclipped, and overflows by at most the mark inset      |

One more was over-specified rather than over-literal: `timeline.spec`'s
"activating a hovered trial replaces its tooltip" asserted **no** tooltip, which
made it depend on the drawer's height leaving empty plate under an unmoved
pointer. It now asserts that the _drug's_ tooltip is gone, and that moving the
pointer off the figure clears the rest.

## One latent bug fixed on the way

`declarationsOf()` in `tests/styles_contract_test.ts` required `:\s` to
recognise a declaration, so a declaration `deno fmt` wrapped onto the line after
its property — a bare `background-size:` — was invisible to **every** check
built on it, including both colour-leak scans. `grid-template-columns:` at
`app.css:883` was already in that shape before the frame's three multi-line
background layers joined it.
