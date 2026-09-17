# UI Modernization — Design Spec

Date: 2026-08-27 Status: direction chosen — Console (see §3). Ready to implement
§12 step 1.

## 1. Context

The dashboard is a port of an R Shiny app. The port carried the Shiny
stylesheet's habits with it, and the result is not "a few inconsistencies to
tidy" — it is **four independent design systems rendering at once**:

| System                  | Typeface                | Radii                      | Motion         | Max shadow alpha |
| ----------------------- | ----------------------- | -------------------------- | -------------- | ---------------- |
| `assets/app.css`        | Raleway                 | 8 / 12 / 16 / 999 / 50%    | `0.2s ease`    | 0.07             |
| `static/timeline.html`  | Raleway, Arial fallback | 20 / `0 20px 20px 0` / 50% | 0.3s, 0.35s ×3 | **0.55**         |
| `static/phenogram.html` | **Inter**               | 7 / 8 / 10                 | 0.2s, 0.25s    | 0.45             |
| Leaflet + markercluster | Helvetica Neue          | 4 / 5 / 12 / 15 / 20       | 0.3s           | 0.65             |

On `/timeline` a user sees a 12px iframe corner containing a 20px sidebar
containing a 20px tooltip. On `/map`, five radii in one viewport. The app's own
tooltip and the timeline's tooltip are the same UI concept rendered ~9× apart in
shadow opacity.

`assets/app.css` itself is not the villain — it is a disciplined 1413-line file
with 50 `--svd-*` tokens, all of them live and consumed. The gaps are
structural:

- **No scales.** 31 padding declarations / 29 distinct values. 33 font-size
  declarations / 24 distinct values, mixing rem and px for the same size
  (`0.88rem` and `14px` both appear; so do `0.82rem` and `13px`). Gaps use 10
  values with no 4/8px grid. z-index is five magic numbers including a leftover
  Bootstrap `1030`.
- **A broken elevation ramp.** `--svd-shadow-md` maxes at 6px blur while
  `--svd-shadow-sm` reaches 16px. `md` is the _hover_ state on `.value-box`,
  `.tip-box` and `.tooltip-box` — so "hover raises the card" visibly shrinks it.
- **Missing channel tokens.** No `--svd-primary-rgb` / `--svd-accent-rgb`,
  though `--svd-danger-rgb` exists and proves the pattern was known. The
  literals `40, 30, 120` and `250, 70, 22` are hand-retyped 11 times at 9 alpha
  values.
- **Font weights that cannot render.** Only Raleway 400 and 700 are loaded, but
  the CSS asks for 500 in 3 places and 600 in 12. All 15 are
  browser-synthesized; the 600s and 500s are visually indistinguishable from
  each other.
- **No dark mode anywhere.** `prefers-color-scheme` and `color-scheme` return
  zero matches across the whole repo.
- **Three icon systems.** Inline SVG (`components/Icon.tsx`), Unicode text
  glyphs `▲ ▼ ⇅` (`TableShell.tsx:135`), and a literal 📍 emoji
  (`MapPopup.tsx:97`).
- **No page shell.** Every route returns a bare fragment. Eight different
  top-level margin declarations compete; `.tip-row` carries both a `1.5rem`
  margin and `1rem` padding, so `/genes` and `/trials` get a 2.5rem gap under
  the header while `/map`, `/phenogram` and `/timeline` get 1rem.
  `routes/index.tsx` is the only route that skips `PageHeader` and ships a
  second, larger `h1`.

**Outcome sought:** one coherent, modern, credible visual system across every
surface — including the two sandboxed iframes and the Leaflet map — with dark
mode, a real motion vocabulary, and a guardrail that stops it rotting again.

## 2. Constraints discovered

**Build.** Vite 7's default target is Baseline Widely Available @ 2026-01-01:
Chrome 111, Edge 111, Firefox 114, Safari 16.4. Therefore `oklch()` and
`color-mix()` are safe; **`light-dark()` (needs FF 120), `:has()` (needs FF 121)
and native CSS nesting (needs FF 117 / Safari 17.2) are not.** Author flat CSS
and drive dark mode from an explicit override block.

**No CSS tooling at all.** No PostCSS, no autoprefixer, no Sass, no CSS modules.
`deno fmt` does not format `.css`, so `deno task check` never reads `app.css`.
Nothing today can catch a raw hex or an off-scale padding.

**33 app-owned class names are load-bearing for e2e.** In descending risk:

1. The eight names reached through `e2e/helpers.ts` — `.filter-count`,
   `.data-table`, `.table-control`, `.tooltip-pop`, `.is-placed`,
   `.empty-state`, `.filter-none`, `.filter-active`. Each breaks up to five spec
   files at once.
2. `group-even` / `group-odd` — `trials-table.spec.ts:66` asserts
   `new Set(classes)` equals exactly those two strings, and :136-137 use
   `toHaveClass` with exact strings. **Trial rows cannot take an additional
   class.**
3. `.visually-hidden` — `map.spec.ts:156-161` guards that it _clips_ rather than
   `display:none`, and contains zero anchors. It is the screen-reader route to
   all 70 map sites.

**DOM-structure assumptions that survive class renames but not restructuring:**
positional `td:nth-child(3)` (genes-table:179), `td:nth-child(10)` and `(11)`
(trials-table:157,171); the two-row grouped `thead` with `colspan [3,4,2,1]` and
9 leaf `th`; the 13-column trials `thead`; `.pagination span` first child being
the range text; `.leaflet-popup-content > .map-popup`; `.marker-cluster > span`.

**`runtime.spec.ts` is the redesign tripwire.** It loads all six routes at
1440×900 and 390×844 and asserts `documentElement.scrollWidth <= innerWidth`,
zero `pageerror`, zero 4xx/5xx. Any overflow introduced by new layout fails it —
and it helpfully dumps the offending elements with computed
`position`/`overflowX`.

**`embeds.spec.ts:265,275-276` is the only `toHaveCSS` in the suite.** It pins
the timeline tooltip to `rgb(40,30,120)` bg / white text and `rgb(53,183,121)` /
black. Restyling `static/timeline.html` must preserve those computed values or
update the spec in the same commit.

**`map.spec.ts:66-70` scrolls to top because the navbar is sticky** and would
otherwise intercept clicks on Leaflet's zoom controls. Navbar position/z-index
changes can break it.

**No visual regression testing exists.** Zero `toHaveScreenshot`, zero snapshot
dirs. A CSS redesign cannot break a baseline — only selectors and structure.

## 3. Aesthetic direction — Console (chosen)

Dark-first analytics. Deep indigo ground, luminous accents, monospace for data.
Chosen 2026-08-27 from three directions presented as live mocks.

**Signature element: the density readout.** Three tiles above each table, plus a
bar per bucket — genes by chromosome, trials by phase. Each bar is drawn to its
unfiltered count and filled to the part still showing, so narrowing reads as the
fill draining rather than as a number changing. Summary before detail; it
answers "how much have I narrowed this, and where did it go" without reading a
row.

### Palette

Authored in `oklch()`; hex shown as the human-readable reference.

| Semantic token                | Dark (design intent) | Light (inversion) |
| ----------------------------- | -------------------- | ----------------- |
| `--svd-ground`                | `#0B0D17`            | `#F2F3F9`         |
| `--svd-surface`               | `#141829`            | `#FFFFFF`         |
| `--svd-surface-raised`        | `#1C2138`            | `#F7F8FC`         |
| `--svd-nav`                   | `#0F1220`            | `#14172B`         |
| `--svd-ink`                   | `#E8EAF6`            | `#14172B`         |
| `--svd-ink-muted`             | `#8990B5`            | `#5B6180`         |
| `--svd-line`                  | `#242942`            | `#DCDFEC`         |
| `--svd-line-soft`             | `#1A1E31`            | `#E9EBF3`         |
| `--svd-primary`               | `#8B8FF5`            | `#4B4FD6`         |
| `--svd-primary-soft`          | `#1C1F3D`            | `#EBECFB`         |
| `--svd-accent` (display only) | `#FF7A45`            | `#DE5A22`         |
| `--svd-accent-text`           | `#FF9166`            | `#B84718`         |
| `--svd-accent-soft`           | `#2C1A14`            | `#FBEBE3`         |
| `--svd-ok`                    | `#3DD9C8`            | `#0E8F80`         |

The accent split is load-bearing: `--svd-accent` at `#DE5A22` is ~3.6:1 on white
and **fails AA as text**, so it is reserved for marks, markers, chart fills and
the lit sparkline. Text and links take `--svd-accent-text`.

**Trial-status swatches must be rebuilt.** The current five
(`recruiting`/`active`/`completed`/`terminated`/`unknown`) are Tailwind pastels
that only work on a light ground, and `unknown` duplicates `completed`'s values
exactly under a different name. Each needs a dark-surface variant, and the two
duplicates should either diverge or collapse to one token.

### Shape and elevation

Radius `8 / 12 / 16` plus `xs` and `full`. Elevation is the direction's
strongest device: a deep shadow **plus an inner top highlight** on raised
surfaces, which is what makes cards read as lit from above on a dark ground.

```css
--svd-shadow-sm: inset 0 1px 0 rgb(255 255 255 / .06), 0 4px 14px rgb(0 0 0 / .5);
--svd-shadow-lg: inset 0 1px 0 rgb(255 255 255 / .08), 0 18px 40px -10px rgb(0 0 0 / .75);
```

The inner highlight must **drop to zero in the light theme** — on a white card
it reads as a rendering artefact rather than a light source.

### Type

IBM Plex Sans for UI and prose; **IBM Plex Mono for every data cell** — gene
symbols, chromosomal locations, registry IDs, sample sizes, completion dates,
reference counts, the pagination range. This is what makes columns align without
effort and is the direction's second signature after the readout.

Motion runs slightly faster than the other directions (`140ms`), which suits the
tighter, more instrument-like feel.

## 4. Token architecture

Replace the flat 50-token block with a two-tier system in `assets/app.css`.

**Tier 1 — palette primitives**, authored in `oklch()` so lightness ramps are
perceptually even and dark mode is a lightness inversion rather than a re-pick:

```css
:root {
  --svd-indigo-50: oklch(0.97 0.012 285);
  /* … 100 200 300 400 500 600 700 800 … */
  --svd-indigo-900: oklch(0.22 0.055 285);
  --svd-ember-500: oklch(0.66 0.19 42); /* display accent */
  --svd-ember-700: oklch(0.52 0.16 42); /* text-safe accent */
}
```

**Tier 2 — semantic aliases.** Every rule consumes these, never Tier 1:

```css
:root {
  --svd-color-text: var(--svd-indigo-900);
  --svd-color-text-muted: var(--svd-indigo-600);
  --svd-surface-page: var(--svd-indigo-50);
  --svd-surface-card: #fff;
  --svd-line: var(--svd-indigo-200);
  --svd-color-accent: var(--svd-ember-500);
  --svd-color-accent-text: var(--svd-ember-700);
}
```

This split is what makes dark mode a swap of ~25 Tier-2 lines instead of a
rewrite of 1400 rules.

**Kill the hand-typed rgb triples with `color-mix()`.** All nine alpha variants
of primary become derived, and `--svd-primary-rgb`-style tokens stop being
needed:

```css
--svd-bg-row-stripe: color-mix(in oklab, var(--svd-color-primary) 3%, transparent);
--svd-bg-group: color-mix(in oklab, var(--svd-color-primary) 6%, transparent);
```

**New scales to add** (none exist today):

| Family      | Steps                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| Space       | `--svd-space-1` … `-12`, on a 4px grid (4 8 12 16 20 24 32 40 48 64 80 96)                      |
| Font size   | `--svd-text-xs` … `-3xl`, all rem, one ratio, **no px**                                         |
| Weight      | `-regular` / `-medium` / `-semibold` / `-bold` — every value must exist in the shipped font     |
| Line height | `-tight` / `-normal` / `-relaxed`                                                               |
| Radius      | `-xs -sm -md -lg -full` (adds the two missing steps)                                            |
| Shadow      | `-xs -sm -md -lg -xl`, **strictly monotonic**, tinted with the brand hue rather than pure black |
| Motion      | `--svd-duration-fast/base/slow` + `--svd-ease-out/spring` as separate tokens                    |
| Z-index     | `--svd-z-base/sticky/overlay/popover/skip`, replacing 2000 / 1030 / 3 / 2 / 1                   |
| Breakpoint  | documented constants; delete the duplicated 600px block                                         |

**Fix the elevation ramp** so `md` > `sm` > `xs`, then repoint the three hover
states that currently shrink.

## 5. Typography

Replace Raleway. It is loaded at only two weights while the CSS asks for four,
and 252 KB of `Raleway-{Regular,Bold}.woff2` buys two static instances.

Self-host **IBM Plex Sans** (variable `wght`, or static 400/500/600/700) and
**IBM Plex Mono** (400/500), Latin-subset. Two families is more than the single
variable file a one-typeface direction would need, but still lands under
Raleway's 252 KB once subset — and it makes the 500/600 weights real for the
first time. Confirm the actual byte count at implementation time rather than
assuming the win. Add `<link rel="preload" as="font" crossorigin>` for the two
faces used above the fold — absent today.

Set `font-variant-numeric: tabular-nums` on every numeric table column, the
pagination range, and the value boxes. Chromosome positions, sample sizes and
NCT IDs currently shift width between rows.

Unify the four competing font stacks (`app.css:74`, `timeline.html:60/93/126`,
`phenogram.html:31`, Leaflet's Helvetica) onto one, including an explicit
override for `.leaflet-container`.

## 6. Icon system — Heroicons

Collapse the three icon systems into one. Adopt **Heroicons v2 outline (24×24,
stroke 1.5, round caps)**, MIT-licensed, paths inlined into
`components/Icon.tsx` — no runtime dependency, same approach as today.

| Use                                    | Icon                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| About tab                              | `information-circle`                                                           |
| Phenogram tab                          | `chart-bar-square`                                                             |
| Trials tab                             | `beaker`                                                                       |
| Timeline tab                           | `clock`                                                                        |
| Map tab                                | `map`                                                                          |
| Filters header                         | `funnel`                                                                       |
| Table search                           | `magnifying-glass`                                                             |
| Sort indicator (replaces `▲ ▼ ⇅` text) | `chevron-up-down`, `chevron-up`, `chevron-down`                                |
| Pagination (replaces text buttons)     | `chevron-double-left`, `chevron-left`, `chevron-right`, `chevron-double-right` |
| Theme toggle                           | `sun` / `moon`                                                                 |
| Facility (replaces the 📍 emoji)       | `map-pin`                                                                      |
| Registry / external links              | `arrow-top-right-on-square`                                                    |
| TipBox                                 | `light-bulb`                                                                   |
| Warning card                           | `exclamation-triangle`                                                         |

Pagination keeps its `Previous`/`Next` text: `trials-table.spec.ts:28` asserts
`toHaveText(["Previous", "1", "2", "Next"])`, and an icon-only control would
break it. The chevrons sit beside the labels, which is better anyway.

**Every glyph needs `flex: none`.** `img, svg { max-width: 100% }` resolves
against a flex parent that is itself sized by its content, so the measurement is
circular and the glyph collapses to zero width. All ten table sort indicators
rendered at `width: 0` until `.icon { flex: none }` was added — they were in the
DOM and invisible.

**Heroicons has no DNA or gene glyph.** Draw one custom path on the same 24×24
grid at stroke 1.5 with round caps and joins so it sits in the set without
reading as foreign. This is the only non-Heroicons glyph.

**Fix `Icon.tsx`'s missing intrinsic size** (`Icon.tsx:32-39`). It renders no
`width`/`height`; sizing exists only in `app.css:314-319` scoped to
`.nav-link svg, .sidebar-header svg`, so using `<Icon>` anywhere else renders at
the UA default 300×150. Give it a `size` prop defaulting to `1em` and switch to
`stroke="currentColor" fill="none"`.

## 7. Layout primitives

Add a `components/Page.tsx` shell so per-page spacing stops being ad hoc:

```tsx
<Page narrow={boolean} title={…} description={…}>
```

- `narrow` — measured line length for the About page (`/`)
- omitted — full width for tables, the map, and embeds

Then:

- Migrate `routes/index.tsx` onto it, deleting the duplicate `h1` treatment
  (`app.css:1297` vs `:1376`).
- Collapse `routes/phenogram.tsx` and `routes/timeline.tsx` — byte-identical
  apart from the deliberate `sandbox` token — into one `EmbedPage` component
  taking `sandbox` as a prop. Keep the comment at `phenogram.tsx:9-22`
  explaining why phenogram needs `allow-same-origin`.
- Fix `TrialsView.tsx:265-266`, which hand-rolls a fieldset and puts the _inner_
  `.filter-group-label` class directly on the `<legend>`, skipping
  `.filter-group-header`. That legend loses `display:flex`,
  `justify-content:space-between` and its count badge, and visibly misaligns
  against the five sibling groups. Route it through `CheckboxFilter`'s header
  markup.

Delete the two inert classes `.range-input-low` / `.range-input-high`
(`RangeSlider.tsx:38,53`), which have no rule in `app.css`.

## 8. Dark mode

**Default: follow the OS.** `prefers-color-scheme` decides the first load; the
toggle overrides and persists. Both themes get an independent design and
contrast pass — light is not an inversion of dark. Decided 2026-08-27.

`light-dark()` is below the build target, so the swap is explicit:

```css
:root {
  color-scheme: light; /* Tier-2 light aliases */
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark; /* dark aliases */
  }
}
:root[data-theme="dark"] {
  color-scheme: dark; /* same dark aliases */
}
```

- Toggle in the navbar (`sun`/`moon`), persisted to `localStorage`.
- **No-flash inline script** in `routes/_app.tsx` `<head>`, before any paint,
  reading `localStorage` and stamping `data-theme` on `<html>`.
- Add `<meta name="theme-color">` with light/dark variants — absent today.
- **Leaflet tiles:** filter the tile pane only
  (`filter: invert(1) hue-rotate(180deg) brightness(.92) contrast(.9)` on
  `.leaflet-tile-pane`), never `.leaflet-map-pane`, so vector markers and popups
  are untouched and `map.spec.ts` keeps passing.
- **The ICM logo goes dark-on-dark.** The original ICM SVG paints its wordmark
  in `#2d2678`, which all but vanishes on the dark navbar (confirmed by
  screenshot). Either ship a light variant and swap on theme, or set the two
  fills to `currentColor` and inline the SVG so it inherits `--svd-nav-ink`.
- **Marker colors** are hardcoded in JS at `TrialsMap.tsx:148,150` because
  Leaflet `circleMarker` options cannot read CSS vars. Read them from
  `getComputedStyle(document.documentElement)` at layer-build time and rebuild
  on theme change.

## 9. The two iframes

Both are same-origin static files with their own `<style>` blocks that cannot
see `app.css`. `phenogram.html` even duplicates `.visually-hidden` verbatim from
`app.css:181-192`, and re-types `--svd-danger` / `--svd-status-terminated-*` as
raw hex.

Give each a small shared token preamble (duplicated by necessity, but reduced to
one block per file and marked as generated-from-app.css), then:

- Normalize radii to the scale — phenogram's 7/8/10 and timeline's 20 both move.
- Normalize motion to the shared duration/easing tokens, replacing the eight
  distinct signatures.
- Bring the tooltip shadows down from 0.45 / 0.55 alpha onto the shared ramp.
- Switch `phenogram.html` from Inter to the app typeface. `timeline.html` was
  already done in step 2: deleting the Raleway files forced it, and its relative
  `fonts/…woff2` URLs were made absolute at the same time.
- **Theme:** each frame handles the OS case itself with `prefers-color-scheme`.
  The manual override arrives by **`postMessage`** — the assumption that
  `allow-scripts` alone rules that out was wrong: an opaque-origin frame cannot
  read its parent, but it still _receives_ messages posted to it. Verified
  against the timeline, which has no `allow-same-origin`.
- **Preserve the computed colors `embeds.spec.ts` pins**, or update that spec in
  the same commit.

## 10. Motion

One duration token and one easing token replace the eight signatures. Hover on
raised surfaces = `translateY(-1px)` plus exactly one elevation step (today
`.value-box`/`.tip-box` lift 2px and `.date-badge` lifts 1px for the same
gesture). Focus-visible rings become a token, applied to every interactive
element. The existing blanket `*` reset in `app.css:1238` with its three
`!important` special-cases collapses to a token-driven block once the transforms
are tokenized.

## 11. Guardrail

`tests/styles_contract_test.ts` runs under the existing `deno task test` with no
new tooling. It reads `assets/app.css` as text and asserts:

1. No raw hex or `rgb(`/`rgba(` literal outside the `DESIGN TOKENS` block — with
   a small allowlist for `#fff` in slider thumb borders and similar.
2. No `px` padding/margin/gap value that is not on the 4px scale.
3. Every `font-weight` used is one the shipped font actually provides.
4. Shadow tokens are monotonic (parse the blur radii, assert ascending).
5. Each `--svd-*` token declared is referenced at least once.

This is the piece that stops the file drifting back, given `deno fmt` will never
read it.

## 12. Sequencing

Each step ends green on `deno task check`, `deno task test`,
`deno task test:e2e`.

1. **Tokens.** Rebuild the token block; mechanically repoint existing rules. No
   visual change intended beyond the shadow-ramp fix. Add the guardrail test.
2. **Typography + icons.** Swap the font, add the preload, adopt Heroicons, fix
   `Icon.tsx` sizing. Update the `▲▼⇅` and 📍 assertions if any spec reads them.
3. **Layout primitives.** `Page.tsx`, `EmbedPage`, About migration, the
   `TrialsView` fieldset fix. Highest structural risk — `runtime.spec.ts` at
   both viewports is the smoke test.
4. **Component language.** Cards, filter rail, table surface, pagination,
   tooltips, map popups. Keep all 33 load-bearing class names; **add no class to
   trial rows.**
5. **Dark mode.** Token swap, toggle, no-flash script, Leaflet tile filter,
   marker recolor.
6. **Iframes.** Token preamble, radius/motion/shadow normalization, theme param.
   Update `embeds.spec.ts` in the same commit if computed colors move.
7. **Signature element** — the density readout (§3).

## 13. Verification

- `deno task check` — fmt, lint, types. Will not read `app.css`; the guardrail
  test covers it.
- `deno task test` — includes the new `styles_contract_test.ts`.
- `deno task test:e2e` — the full suite against the production build.
  `runtime.spec.ts` is the layout smoke test at 1440×900 and 390×844.
- Manual: every route at 1440 / 768 / 390, in light and dark, with
  `prefers-reduced-motion` forced on; full keyboard pass (skip link → nav →
  filters → table → tooltip → popover → map); the three `toHaveCSS`-pinned
  timeline tooltip states.
- Contrast: every text/background pair to WCAG AA in both themes. Note the
  current `--svd-accent: #FA4616` is ~3.4:1 on white and fails AA as text — the
  codebase already half-knows this, having introduced `--svd-link: #b8320c` as a
  darkened variant. The two-token accent split in §4 makes that explicit.
