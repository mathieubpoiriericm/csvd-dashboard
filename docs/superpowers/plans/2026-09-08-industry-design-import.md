# Industry Design Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the dashboard onto the "Industry" design system from the
Claude Design project — steel-blue on a light technical ground, Barlow Condensed
over Barlow, and every panel redrawn as a square, hairline-bordered blueprint
object with corner registration marks — without changing what any figure encodes
or what any table publishes.

**Architecture:** The change is almost entirely inside `assets/app.css`. The
stylesheet already funnels every panel in the app through **one shared surface
rule** at the head of `=== CARDS & VALUE BOXES ===` (22 selectors) and every
colour through **one three-tier token block**. Swapping the tier-1 ramps, the
geometry scales and that single surface recipe converts the whole app at once;
the per-surface tasks that follow are corrections where a rule hard-codes
something the recipe cannot reach. Markup changes are confined to three figure
scroll wrappers, the navbar grid and the font preloads.

**Tech Stack:** Fresh 2 / Preact / Deno, plain CSS with custom properties,
Playwright for e2e. No new runtime dependency — the design system's `styles.css`
is a _reference_, not a file to vendor.

**Status:** Executed. The decisions, the amendments made while executing, and
the defects the frame introduced are recorded in
`docs/superpowers/specs/2026-09-08-industry-design-import-decisions.md` — read
that alongside this. Two amendments worth knowing before reading Task 2: the
red, amber and green ramps survived the repalette rather than being re-derived,
and the warning role gained a tier-2 hue of its own.

**Spec:** The design canvas itself,
`claude.ai/design/p/e3f86d16-4f61-400e-be8e-fea1cf37058e?file=cSVD+Dashboard.dc.html`,
plus its design-system guide at
`_ds/industry-157c90c7-6fa7-4c97-8cbc-4fd3656b1e10/readme.md`. A local copy of
the canvas markup used while writing this plan is quoted inline wherever a task
depends on it, so no task requires re-fetching the project.

---

## What the design is, and what it is not

The design canvas is a **complete, running recreation of this dashboard** —
every screen, reading the real committed `data/*.json` — rendered on the
Industry design system. It is not a diff. Read it as: _this is what every
surface should look like_, and take the delta from the current app.

Three of its files are canvas scaffolding with no counterpart here and nothing
to port:

| File                      | What it is                                                                                                       | Action |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| `support.js`              | `dc-runtime`, the generated React harness that parses `<x-dc>` and evaluates the `<script data-dc-script>` block | Ignore |
| `_ds/…/_ds_bundle.js`     | The design-system loader for the canvas preview pages                                                            | Ignore |
| `_ds/…/_ds_manifest.json` | The card index for the Design System pane                                                                        | Ignore |

`_ds/…/styles.css` and `readme.md` **are** the spec for tokens and component
grammar. `cSVD Dashboard.dc.html` is the spec for every screen.

---

## Global Constraints

Copied verbatim from the design system's `readme.md` and from this repo's
existing guardrails. Every task's requirements implicitly include this section.

**From the Industry design system:**

- Ground `--color-bg` **#f2f2f3**, ink `--color-text` **#1d1f20**, one accent
  **#5980a6**. Mono scheme: `--color-accent-2-*` is a machine-derived stand-in,
  _"treat them as one role"_ — do **not** port it as a second accent.
- Type: **Barlow Condensed** headings over **Barlow** body. Heading weight 600.
- _"Do not round cards, figures or buttons, and do not give cards or figures a
  surface fill — they are line drawings (the solid accent primary button is the
  one deliberate exception)."_
- _"Do not drop the registration marks from a framed element."_ The frame is
  `.blueprint` plus four corner `+` crosshairs.
- Icons at **stroke-width 1.5**. (The repo's Heroicons v2 outline set is already
  1.5 — nothing to change. The design system nominally names Lucide; the canvas
  itself ships the _Heroicons_ paths this repo already has, so keep
  `components/Icon.tsx` as it is.)
- _"the accent-to-ground pair is tuned to at least 3:1 — enough for icons, large
  text and interface chrome, not for body copy — so for paragraph-size text in
  the accent use a deep ramp step (`--color-accent-700`)."_ Measured: `#5980a6`
  on `#f2f2f3` is **3.71:1**; `#416180` is **5.78:1**.
- Focus is `2px solid var(--color-accent)` at `outline-offset: 2px`. The repo's
  `--svd-focus-width: 2px` / `--svd-focus-offset: 2px` already match; only
  `--svd-focus-color` moves.

**From this repo (non-negotiable, `assets/CLAUDE.md` +
`tests/styles_contract_test.ts`):**

- The token block keeps its **three tiers**. Palette ramps stay authored in
  `oklch()`; no rule outside the token block may reference a palette token or a
  colour literal. Hex from the design system must be **converted** (Task 2 ships
  the converter).
- Dark mode is declared **twice** — under `@media (prefers-color-scheme: dark)`
  and under `[data-theme='dark']` — and the two blocks must stay byte-identical
  in their declarations.
- Every palette ramp must be **monotonic in lightness**. Both Industry ramps
  already are (verified in Task 2).
- Every `font-size` on the type scale, `line-height` on the leading scale,
  `letter-spacing` on the tracking scale, `font-weight` on the weight scale,
  spacing on the 4px scale, `border-radius` on the radius scale, breakpoints in
  `BREAKPOINTS = {480, 600, 900, 1100, 1410, 1453, 1482}`.
- **No `font-weight` may be used that no `@font-face` declares.** Barlow ships
  as _static_ faces, not a variable one — Task 1 must ship a face per weight the
  stylesheet asks for.
- Gates: `deno task check`, `deno task test:coverage`, and the Playwright suite
  from the repo root
  (`npx --prefix e2e playwright test -c e2e/playwright.config.ts`).

---

## Three decisions this plan makes, and why

These are the places the design canvas and the committed app disagree on
substance rather than on looks. Each is called out here so a reviewer can reject
the call without reading the tasks.

### 1. The timeline mechanism palette stays as committed (`figurePalette: "source"`)

The canvas exposes a `figurePalette` prop with two settings and **defaults to
`"steel"`**, which recolours all eleven mechanisms and all four populations into
tints of the one accent:

```js
mechanisms[name] = steel
  ? this.mixHex(RAMP[fi % RAMP.length], Math.min(0.45, mi * 0.11))
  : hue;
```

**Do not port `"steel"`.** Three reasons, in order of weight:

1. It contradicts the figure's own documented rationale. The root `CLAUDE.md`:
   _"The palette is one hue per family with lightness steps inside it — eleven
   pairwise-distinct hues cannot clear a colour-vision check, so identity rides
   the drug label beside every marker and the legend, and the colour says the
   family first."_ Collapsing six families onto one hue removes the only channel
   that says _family_, which is the thing the palette was rebuilt to say.
2. `tests/timeline_encoding_test.ts` fails when two mechanisms share a colour.
   `RAMP[fi % RAMP.length]` with `mi * 0.11` clamped at `0.45` produces
   collisions between families as soon as two families take the same ramp step.
3. The same call was already made and recorded once, against grey wedges.

The canvas's `"source"` setting **is** the committed encoding, so choosing it
means `lib/timeline_encoding.json` and `scripts/timeline_figure.py` are not
touched at all. Both figures' internal colours — wedges, bands, markers, rings,
pills, plate — are out of scope for this plan. Only their **frames** change.

### 2. The target-sample-size histogram and range slider are not re-added

The canvas's filter rail carries a sample-size histogram over a dual-thumb range
slider (`sc-if value="{{ sampleOn }}"`, canvas lines 536-561), and the design
project snapshot still contains `components/RangeSlider.tsx` and
`components/SampleSizeHistogram.tsx`.

Both were **deliberately removed one commit before this branch** —
`24d1e45
Remove the trials table's sample-size slider`. The canvas was captured
before that. Re-adding it is a product decision, not a design import; it is out
of scope here. Task 7 therefore ports the rail's _frame, counts and legend
treatment_ and skips the sample-size fieldset. The two `input[type="range"]`
rules in the canvas's `<style>` block have no destination and are dropped.

### 3. The figures keep white plates and the seven rings they have

The canvas's timeline encoding is **stale in two ways**: it lists five rings
(`IV, III, II, I, (unknown)`) where the committed encoding has seven — the
`II/III` and `I/II` seamless rings added in `aba0e5e` — and it draws on a
1252×1000 plate where `lib/timeline.ts` uses
`CANVAS = {width: 1072, height:
940}`. It also moves both figure plates from
white to `#f5f5f8`.

Take none of it. The ring set is a correction the canvas predates; the canvas
plate size is its own recreation, not a specification; and moving the plate 3%
darker would mean editing `lib/timeline_encoding.json`,
`scripts/timeline_figure.py`, `tests/timeline_encoding_test.ts` and
`e2e/tests/timeline.spec.ts` (which pins `stroke={PLATE}` as `#ffffff`) for a
difference no reader can name. `--svd-figure-plate` stays `--svd-white`.

---

## File Structure

| File                            | Responsibility in this change                                                                                                        | Tasks |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `assets/app.css`                | Everything. Token block (tiers 1-2 + both dark blocks), geometry scales, the shared surface recipe, and the per-section corrections. | 1-9   |
| `assets/CLAUDE.md`              | The styling guide. Rewrite the **Depth** section — the aurora recipe it documents is what Task 4 replaces.                           | 4, 10 |
| `static/fonts/`                 | Six new `.woff2` faces; the three IBM Plex files are deleted.                                                                        | 1     |
| `routes/_app.tsx`               | Font preloads (`href`), `THEME_COLORS` meta hex.                                                                                     | 1, 2  |
| `islands/TrialsTimeline.tsx`    | One `.blueprint-frame` wrapper around `.timeline-scroll`; legend rail → below-plate grid.                                            | 4, 9  |
| `islands/Phenogram.tsx`         | One `.blueprint-frame` wrapper around `.phenogram-scroll`; legend rail → below-plate grid.                                           | 4, 9  |
| `components/TableShell.tsx`     | One `.blueprint-frame` wrapper around `.table-scroll`.                                                                               | 4     |
| `tests/styles_contract_test.ts` | Scale membership sets (type, leading, tracking, radius) move with the scales. Assertions, not the guardrail itself.                  | 3, 10 |
| `e2e/tests/theme.spec.ts`       | Reads `--svd-nav` against the meta hex; both move together.                                                                          | 2     |

Nothing under `lib/`, `pipeline/`, `data/` or `scripts/` is touched.

---

## Task 1: Vendor Barlow and Barlow Condensed

**Files:**

- Create: `static/fonts/Barlow-{400,500,600,700}-latin.woff2`,
  `static/fonts/BarlowCondensed-{500,600}-latin.woff2`
- Delete: `static/fonts/IBMPlexSans-Var-latin.woff2`,
  `static/fonts/IBMPlexMono-400-latin.woff2`,
  `static/fonts/IBMPlexMono-500-latin.woff2`
- Modify: `assets/app.css` (`=== @FONT-FACE ===`, lines 546-576; the
  `--svd-font-sans` / `--svd-font-mono` tokens, lines 310-311)
- Modify: `routes/_app.tsx:99-111` (the two `<link rel="preload">` blocks)
- Test: `tests/styles_contract_test.ts` (existing
  `"no font-weight is used that the shipped font cannot render"`)

**Interfaces:**

- Produces: `--svd-font-sans` (Barlow), `--svd-font-heading` (Barlow Condensed),
  `--svd-font-mono` (unchanged fallback stack). Tasks 2-9 read
  `--svd-font-heading` on every heading, eyebrow, table header, tag and numeral.

**Why six faces and not a variable one.** IBM Plex Sans ships one variable file
covering 100-700, which is why the current stylesheet can ask for 500 and 600
freely. Barlow does **not** have a variable release on Google Fonts — it is
static weights. The contract test
`"no font-weight is used that the shipped font cannot render"` reads the
`@font-face` blocks and fails on any weight no face declares, so each weight the
stylesheet uses needs its own file. The stylesheet uses 400/500/600/700. Barlow
Condensed is only ever a heading face here: 500 (nav tabs, small eyebrows) and
600 (everything else).

Latin-subset Barlow is ~21 KB/face and Barlow Condensed ~19 KB/face, so this
lands near 122 KB against the 74 KB Plex bundle. That is the cost of a static
family; note it in the commit message rather than trying to subset further.

- [ ] **Step 1: Download the six faces**

Google Fonts serves the `latin` subset URLs from the CSS API. Run from the repo
root:

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

fetch_face() {  # $1 family-query  $2 output basename
  css=$(curl -sfL -A "$UA" "https://fonts.googleapis.com/css2?family=$1&display=swap")
  url=$(printf '%s' "$css" | awk '/latin/{f=1} f && /src:/{print; exit}' | grep -o 'https://[^)]*\.woff2')
  test -n "$url" || { echo "no woff2 for $1" >&2; return 1; }
  curl -sfL -A "$UA" "$url" -o "static/fonts/$2.woff2"
}

fetch_face 'Barlow:wght@400' Barlow-400-latin
fetch_face 'Barlow:wght@500' Barlow-500-latin
fetch_face 'Barlow:wght@600' Barlow-600-latin
fetch_face 'Barlow:wght@700' Barlow-700-latin
fetch_face 'Barlow+Condensed:wght@500' BarlowCondensed-500-latin
fetch_face 'Barlow+Condensed:wght@600' BarlowCondensed-600-latin
```

The `awk` step matters: the API emits several `@font-face` blocks per family
(`latin-ext`, `vietnamese`, `latin`), each preceded by a `/* subset */` comment.
Taking the first `src:` after the `latin` marker is what gets the Latin file
rather than Vietnamese.

- [ ] **Step 2: Verify the six files landed and are real woff2**

```bash
ls -l static/fonts/
file static/fonts/*.woff2   # each must report "Web Open Font Format (Version 2)"
```

Expected: six files, each 15-25 KB. If `fetch_face` printed `no woff2`, the API
shape changed — open the `css2` URL in a browser and copy the `latin` block's
URL by hand rather than looping on the script.

- [ ] **Step 3: Delete the IBM Plex faces**

```bash
git rm static/fonts/IBMPlexSans-Var-latin.woff2 \
       static/fonts/IBMPlexMono-400-latin.woff2 \
       static/fonts/IBMPlexMono-500-latin.woff2
```

- [ ] **Step 4: Replace the `@font-face` block**

In `assets/app.css`, replace the whole `/* === @FONT-FACE === */` section (lines
546-576) with:

```css
/* === @FONT-FACE === */

/*
 * Barlow has no variable release, so every weight the stylesheet asks for
 * needs its own file — tests/styles_contract_test.ts reads these blocks and
 * fails on a weight no face declares. Four body weights and two condensed
 * heading weights, latin subsets: ~122 KB, against 74 KB for the IBM Plex
 * variable face plus its two mono statics. That is what a static family
 * costs; do not close the gap by dropping a weight the rules use.
 */
@font-face {
  font-family: 'Barlow';
  src: url('/fonts/Barlow-400-latin.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Barlow';
  src: url('/fonts/Barlow-500-latin.woff2') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Barlow';
  src: url('/fonts/Barlow-600-latin.woff2') format('woff2');
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Barlow';
  src: url('/fonts/Barlow-700-latin.woff2') format('woff2');
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Barlow Condensed';
  src: url('/fonts/BarlowCondensed-500-latin.woff2') format('woff2');
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}

@font-face {
  font-family: 'Barlow Condensed';
  src: url('/fonts/BarlowCondensed-600-latin.woff2') format('woff2');
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
```

- [ ] **Step 5: Repoint the font tokens**

In `assets/app.css`, replace lines 310-311:

```css
--svd-font-sans: 'Barlow', system-ui, -apple-system, BlinkMacSystemFont,
    'Segoe UI', sans-serif;
/* Barlow Condensed. Headings, eyebrows, table headers, tags and every
   figure numeral: the condensed face is what carries the system's voice,
   so it is a token rather than a per-rule font-family. */
--svd-font-heading: 'Barlow Condensed', 'Barlow', system-ui, sans-serif;
/* No mono face ships any more — Barlow has no monospaced sibling and the
   three places that asked for one (the API path, the funnel figures, the
   numeric columns) get `font-variant-numeric: tabular-nums` from the body
   face instead, which is what the design canvas does. The stack is kept so
   the two `code` rules resolve to the platform's own mono. */
--svd-font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
```

- [ ] **Step 6: Repoint the preloads**

In `routes/_app.tsx`, replace the two `<link rel="preload">` blocks (lines
99-111) with the two faces that render above the fold — the body regular and the
condensed heading weight:

```tsx
<link
  rel="preload"
  as="font"
  type="font/woff2"
  href="/fonts/Barlow-400-latin.woff2"
  crossOrigin="anonymous"
/>
<link
  rel="preload"
  as="font"
  type="font/woff2"
  href="/fonts/BarlowCondensed-600-latin.woff2"
  crossOrigin="anonymous"
/>
```

- [ ] **Step 7: Run the gates**

```bash
deno task check
deno task test:coverage
```

Expected: **the font-weight test passes** (400/500/600/700 are all declared).
Other failures are expected at this point only if a rule used a weight outside
that set — if `"no font-weight is used that the shipped font cannot render"`
reports one, add the face rather than changing the rule.

- [ ] **Step 8: Commit**

```bash
git add static/fonts assets/app.css routes/_app.tsx
git commit -m "Ship Barlow and Barlow Condensed in place of IBM Plex"
```

---

## Task 2: Repalette the token block

**Files:**

- Modify: `assets/app.css` (tier 1, lines ~34-105; tier 2 light, lines ~107-245;
  both dark blocks under `=== DARK THEME ===`, from line 426)
- Modify: `routes/_app.tsx:12-15` (`THEME_COLORS`)
- Test: `tests/styles_contract_test.ts` (existing colour tests),
  `e2e/tests/theme.spec.ts` (existing)

**Interfaces:**

- Consumes: nothing.
- Produces: tier-1 ramps `--svd-steel-{100..900}` and `--svd-slate-{100..900}`;
  tier-2 names keep every one of their current spellings (`--svd-ground`,
  `--svd-surface`, `--svd-ink`, `--svd-line`, `--svd-color-primary`,
  `--svd-color-accent`, …) so no rule outside the token block changes in this
  task. Tasks 3-9 read tier 2 only.

**The shape of this task.** The repo's tier-2 names are the API; the Industry
system's names are not. Do **not** rename `--svd-color-primary` to
`--svd-color-accent-600` — that would touch every one of the 100+ call sites for
no gain and would break the legacy alias tier. Instead: replace the tier-1 ramps
with Industry's, and repoint tier 2 onto the new steps. Every rule in the file
then changes colour without being edited.

Industry is a **mono** scheme with one accent. This repo's tier 2 has two roles
— `--svd-color-primary` (indigo: nav, focus, sticky heads, tooltips) and
`--svd-color-accent` (ember: links, rails, hovers). Map both onto the steel ramp
at **different steps** rather than collapsing them: primary takes the deep step
the nav field wants, accent the mid step the rails want. That preserves every
existing rule's intent under a mono palette.

- [ ] **Step 1: Convert the Industry hex ramps to oklch**

The contract test `"no raw oklch value appears outside the palette ramps"` and
`"no colour literal appears outside the token region"` mean the ramps must be
authored in `oklch()`. Write the converter to a scratch file and run it — no
dependency, and it is reproducible for whoever retunes the ramp later:

```bash
mkdir -p /tmp/industry && cat > /tmp/industry/hex2oklch.py <<'PY'
import math

def srgb_to_lin(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def hex_to_oklch(h):
    h = h.lstrip('#')
    r, g, b = (srgb_to_lin(int(h[i:i + 2], 16)) for i in (0, 2, 4))
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = (math.copysign(abs(v) ** (1 / 3), v) for v in (l, m, s))
    L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    return L, math.hypot(a, bb), math.degrees(math.atan2(bb, a)) % 360

RAMPS = {
    "steel": ["#eef6ff", "#d6ebff", "#b5d9fd", "#94bce3", "#749dc4",
              "#597ea3", "#416180", "#2c455d", "#1d2d3d"],
    "slate": ["#f5f5f8", "#e7e7ea", "#d4d4d7", "#b7b7ba", "#98989b",
              "#7a7a7d", "#5d5d60", "#424244", "#2b2b2d"],
}
for name, ramp in RAMPS.items():
    prev = None
    for i, hx in enumerate(ramp):
        L, C, H = hex_to_oklch(hx)
        assert prev is None or L < prev, f"{name} not monotonic at {hx}"
        prev = L
        print(f"  --svd-{name}-{(i + 1) * 100}: "
              f"oklch({L:.4f} {C:.4f} {H:.1f}); /* {hx} */")
PY
python3 /tmp/industry/hex2oklch.py
```

Expected output — paste this verbatim into tier 1:

```css
--svd-steel-100: oklch(0.9697 0.0148 251.2); /* #eef6ff */
--svd-steel-200: oklch(0.9307 0.0352 246.9); /* #d6ebff */
--svd-steel-300: oklch(0.8713 0.0630 248.6); /* #b5d9fd */
--svd-steel-400: oklch(0.7801 0.0706 248.1); /* #94bce3 */
--svd-steel-500: oklch(0.6808 0.0733 247.7); /* #749dc4 */
--svd-steel-600: oklch(0.5804 0.0709 249.1); /* #597ea3 */
--svd-steel-700: oklch(0.4812 0.0627 248.5); /* #416180 */
--svd-steel-800: oklch(0.3811 0.0515 248.3); /* #2c455d */
--svd-steel-900: oklch(0.2907 0.0364 249.2); /* #1d2d3d */
--svd-slate-100: oklch(0.9710 0.0040 286.3); /* #f5f5f8 */
--svd-slate-200: oklch(0.9288 0.0040 286.3); /* #e7e7ea */
--svd-slate-300: oklch(0.8708 0.0041 286.3); /* #d4d4d7 */
--svd-slate-400: oklch(0.7803 0.0042 286.3); /* #b7b7ba */
--svd-slate-500: oklch(0.6806 0.0043 286.3); /* #98989b */
--svd-slate-600: oklch(0.5805 0.0045 286.3); /* #7a7a7d */
--svd-slate-700: oklch(0.4794 0.0048 286.2); /* #5d5d60 */
--svd-slate-800: oklch(0.3798 0.0034 286.2); /* #424244 */
--svd-slate-900: oklch(0.2899 0.0036 286.2); /* #2b2b2d */
```

Both ramps assert monotonic — the script raises rather than printing if they are
not, which is the same property `"every palette ramp is monotonic in
lightness"`
checks in CSS.

- [ ] **Step 2: Replace tier 1**

Delete the indigo, ember, teal, red, amber and green ramps from tier 1 and put
the two ramps above in their place, then re-add **only** the status hues that
carry meaning no steel step can: the four trial-status families and the three
run-status inks. Those are data encodings, not decoration. The design canvas
keeps them for the same reason — it declares `--okInk`, `--dangerInk`,
`--warnInk` in its own `<style>` block rather than tinting them steel.

The design's inks fail AA on their own washes, which is exactly the failure the
repo's `--svd-color-*-ink` tokens exist to fix. Measured on the rendered pixels
against a 22% wash of the ink on `#f2f2f3`:

| Design ink           | On ground | On its own 22% wash | Ships as     |
| -------------------- | --------- | ------------------- | ------------ |
| `#1a7f5a` ok         | 4.44:1    | **3.34:1**          | fill only    |
| `#b3261e` danger     | 5.84:1    | **4.07:1**          | fill only    |
| `#8a6100` warn       | 4.95:1    | **3.69:1**          | fill only    |
| `#12563d` ok ink     | 7.74:1    | 5.43:1              | text on wash |
| `#8f1e18` danger ink | 7.93:1    | 5.34:1              | text on wash |
| `#6f4e00` warn ink   | 6.79:1    | 4.85:1              | text on wash |

Run them through the same converter (add them to `RAMPS` as one-entry lists and
drop the monotonic assert) and add:

```css
/* Status hues. Not decoration — a badge's colour is the run's outcome, and
   no step of a mono steel ramp can say "failed". Kept from the design
   canvas's own [data-theme] block, which declares them for the same reason.
   Each has a *-ink step one stop darker than its fill: the fill sits on a
   22% wash of itself, which darkens its own ground, and every one of the
   three design inks measures under AA there (3.34, 4.07, 3.69). The ink
   steps measure 5.43, 5.34 and 4.85 on the same pixels. */
--svd-ok-500: oklch(0.5314 0.1066 162.9); /* #1a7f5a */
--svd-ok-700: oklch(0.4049 0.0785 163.6); /* #12563d */
--svd-danger-500: oklch(0.5013 0.1783 28.7); /* #b3261e */
--svd-danger-700: oklch(0.4266 0.1496 28.4); /* #8f1e18 */
--svd-warn-500: oklch(0.5221 0.1082 79.7); /* #8a6100 */
--svd-warn-700: oklch(0.4481 0.0927 80.5); /* #6f4e00 */
```

Keep the four trial-status families (`recruiting`, `active`, `completed`,
`terminated`) as they are — they are a five-way categorical encoding read in
`.trial-status-*` and nothing in the design touches them. Rename nothing.

- [ ] **Step 3: Repoint tier 2 (light)**

Every name keeps its spelling. Only the right-hand side moves:

```css
--svd-ground: var(--svd-slate-100); /* #f5f5f8 — the ground the
canvas draws figures on; the
page ground is a hair below */
--svd-surface: var(--svd-white);
--svd-nav: var(--svd-steel-900); /* #1d2d3d, the steel field */
--svd-nav-ink: var(--svd-slate-100); /* #f5f5f8 — 12.56:1 on the nav */

--svd-ink: var(--svd-slate-900);
--svd-ink-muted: var(--svd-slate-700);
--svd-line: var(--svd-slate-300);
--svd-line-strong: var(--svd-slate-400);

/* Mono scheme: both roles come off the one steel ramp at different steps,
   rather than collapsing into one token. Primary is the deep step the nav
   field, focus ring and sticky heads want; accent the mid step the rails,
   links and hovers want. Keeping them separate is what lets ~120 existing
   rules keep their intent under a palette with one hue. */
--svd-color-primary: var(--svd-steel-800);
--svd-color-accent: var(--svd-steel-600);
--svd-color-accent-text: var(--svd-steel-700); /* 5.78:1 on the ground */
--svd-color-ok: var(--svd-ok-500);
--svd-color-danger: var(--svd-danger-500);
--svd-color-danger-text: var(--svd-danger-700);
--svd-color-ok-hover: var(--svd-ok-700);
--svd-color-ok-ink: var(--svd-ok-700);
--svd-color-accent-ink: var(--svd-steel-800);
```

`--svd-icm-mark` stays `#e94e14` — it is the institute's own orange and the
design canvas keeps it too (the logo's first `<g fill="#e94e14">`).

The five fixed figure tokens (`--svd-figure-ink`, `--svd-figure-plate`,
`--svd-on-figure`, `--svd-figure-surface`, `--svd-figure-heading`,
`--svd-figure-line`, `--svd-figure-ok`, `--svd-figure-ok-hover`) keep their
current values by decision 3 — retarget only `--svd-figure-heading` onto
`--svd-steel-800` so the timeline tooltip's heading reads as steel rather than
as a leftover indigo, and `--svd-figure-line` onto `--svd-slate-300`.

- [ ] **Step 4: Repoint both dark blocks, identically**

The design canvas's dark theme is (canvas `<style>`, lines 37-46):

```
--color-bg: #14181b; --color-surface: #1c2126; --color-text: #e6eaee;
--color-accent: #94bce3;  links: --color-accent-300 (#b5d9fd)
```

Converted and mapped onto tier 2, in **both** the
`@media
(prefers-color-scheme: dark)` block and the `[data-theme='dark']` block,
with byte-identical declarations:

```css
--svd-ground: oklch(0.2061 0.0086 240.3); /* #14181b */
--svd-surface: oklch(0.2449 0.0121 248.3); /* #1c2126 */
--svd-nav: oklch(0.2061 0.0086 240.3); /* the ground: on a dark page the
steel field and the page are
one surface, as the canvas
draws it */
--svd-ink: oklch(0.9351 0.0069 247.9); /* #e6eaee — 14.77:1 */
--svd-ink-muted: var(--svd-slate-500);
--svd-line: color-mix(in oklab, var(--svd-ink) 20%, transparent);
--svd-line-strong: color-mix(in oklab, var(--svd-ink) 34%, transparent);
--svd-color-primary: var(--svd-steel-400); /* #94bce3 — 8.98:1 */
--svd-color-accent: var(--svd-steel-400);
--svd-color-accent-text: var(--svd-steel-300); /* #b5d9fd — 12.16:1 */
--svd-color-ok: oklch(0.7420 0.1234 166.4); /* #4ec49a */
--svd-color-danger: oklch(0.7391 0.1249 26.5); /* #ef8a80 */
```

Those three dark raw values go through the converter in Step 1 as well; do not
hand-type them.

**The ground and surface swap roles in dark.** Industry's light theme has a grey
ground under white cards; its dark theme has a near-black ground under a
_lighter_ surface. That is the same inversion the current dark block already
performs, so the existing rules need no change — only the values.

- [ ] **Step 5: Move the meta theme-colour with the nav**

`e2e/tests/theme.spec.ts` resolves `--svd-nav` and compares it to the
`<meta name="theme-color">` value, deliberately through two different helpers.
In `routes/_app.tsx`:

```tsx
const THEME_COLORS = {
  light: "#1d2d3d",
  dark: "#14181b",
} as const;
```

- [ ] **Step 6: Run the colour gates**

```bash
deno task test:coverage -- --filter "styles contract"
```

Expected to pass: `"every palette ramp is monotonic in lightness"`,
`"palette tokens are never referenced outside the token region"`,
`"no colour literal appears outside the token region"`,
`"the two dark-theme blocks declare exactly the same values"`,
`"every --svd- token referenced is also declared"`.

Expected to **fail** here: `"every declared --svd- token is used"`, because the
retired indigo/ember/teal steps are gone but some `--svd-*` names that aliased
them may now be orphaned. Delete the orphans the test names; do not add a use
for them.

- [ ] **Step 7: Full gate, then eyeball both themes**

```bash
deno task check
deno task test:coverage
npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/theme.spec.ts
```

- [ ] **Step 8: Commit**

```bash
git add assets/app.css routes/_app.tsx
git commit -m "Repalette onto the Industry steel ramp"
```

---

## Task 3: Square the geometry

**Files:**

- Modify: `assets/app.css` (radius scale, lines ~364-368; shadow tokens, lines
  ~192-196 and the dark ramp; tracking scale, lines ~304-308; type scale, lines
  ~283-290)
- Modify: `tests/styles_contract_test.ts` (the declared scale sets these tests
  read)

**Interfaces:**

- Consumes: Task 2's tier 2.
- Produces: `--svd-radius-*` all at `0` except `--svd-radius-round`; the three
  `--svd-shadow-*` steps retuned to Industry's; a `--svd-tracking-caps` at
  `0.08em` (unchanged) that every eyebrow in Tasks 5-9 reads.

**Why the radius names survive at zero.** The contract test
`"every border-radius is on the radius scale"` requires every declaration to
read a `--svd-radius-*` token. Deleting the scale would mean editing all 49
declarations; setting the scale to zero converts them all at once and leaves the
guardrail intact. The names stop meaning "how round" and start meaning "which
corner family", which is worth a comment.

- [ ] **Step 1: Zero the radius scale**

```css
/*
 * Industry draws every object square: "Do not round cards, figures or
 * buttons … they are line drawings." The scale is kept at three names
 * rather than deleted so the 49 border-radius declarations across this
 * file keep resolving a token — tests/styles_contract_test.ts requires
 * one, and repointing every call site would be a mechanical diff over the
 * whole stylesheet for no reviewable gain. The names now say which corner
 * family a rule belongs to, not how round it is; if the system ever
 * softens again, the three values are the only edit.
 */
--svd-radius-xs: 0;
--svd-radius-sm: 0;
--svd-radius-md: 0;
/* Was the pill step. Chips, badges and the range track are square objects
   in this system, so it resolves to the same zero — kept as a distinct name
   because a pill is a deliberate shape decision, not an accident of scale. */
--svd-radius-full: 0;
/* The one genuine curve left: marker dots, glyph wells and the radio dot
   are circles, not rounded rectangles. */
--svd-radius-round: 50%;
```

- [ ] **Step 2: Retune the shadow ramp**

Industry's elevation is _"soft ink-tinted shadows on a light theme, a hairline
edge + ambient darkness on a dark one"_, at three steps. Converted from
`color-mix(in srgb, #2b2b2d N%, transparent)` — `#2b2b2d` is `--svd-slate-900`,
so it can be expressed as a token mix rather than a literal:

```css
--svd-shadow-xs: 0 1px 2px
    color-mix(in oklab, var(--svd-slate-900) 10%, transparent);
--svd-shadow-sm: 0 1px 2px
    color-mix(in oklab, var(--svd-slate-900) 14%, transparent);
--svd-shadow-md: 0 3px 10px
    color-mix(in oklab, var(--svd-slate-900) 16%, transparent);
--svd-shadow-lg: 0 12px 32px
    color-mix(in oklab, var(--svd-slate-900) 22%, transparent);
```

The contract test `"shadow tokens form a monotonic ramp in both themes"` reads
blur radius and alpha; 2 → 2 → 10 → 32 px and 10 → 14 → 16 → 22 % are both
monotonic. The dark blocks take the same geometry at the canvas's own alphas
(45/50/55 %, per its `<style>` block lines 41-44) against `#000`, expressed as a
mix on `--svd-slate-900`.

- [ ] **Step 3: Adjust the type scale for the condensed face**

Barlow Condensed is narrower than IBM Plex Sans at the same size, and the canvas
compensates by setting headings larger. Its display sizes, mapped onto the
existing scale names:

| Canvas | Where                             | Scale name                            |
| ------ | --------------------------------- | ------------------------------------- |
| 44px   | About hero `h1`                   | `--svd-text-4xl` (new)                |
| 38px   | Every other page `h1`             | `--svd-text-3xl` (2rem → 2.375rem)    |
| 26px   | `h2` section heads, drawer titles | `--svd-text-2xl` (1.75rem → 1.625rem) |
| 24px   | About card `h2`                   | folds into `--svd-text-2xl`           |
| 40px   | KPI numerals                      | `--svd-text-4xl`                      |
| 11px   | Eyebrows, table headers           | `--svd-text-2xs` (unchanged)          |

Add one step and retune two:

```css
--svd-text-2xl: 1.625rem;
--svd-text-3xl: 2.375rem;
--svd-text-4xl: 2.75rem;
```

Then add `"2.75rem"` and the retuned values to the `SCALE` set in
`tests/styles_contract_test.ts`'s
`"every font-size resolves to a step on the type scale"` — the test reads the
declared set out of the token block, so confirm which by running it before
hand-editing anything.

- [ ] **Step 4: Run the geometry gates**

```bash
deno task test:coverage -- --filter "styles contract"
```

Expected to pass: `"every border-radius is on the radius scale"`,
`"shadow tokens form a monotonic ramp in both themes"`,
`"every font-size resolves to a step on the type scale"`,
`"every letter-spacing is on the tracking scale"`,
`"every spacing value is on the 4px scale"`.

Expected to **fail**: `"the aurora halos grow with the interaction they mark"`.
That test guards a recipe Task 4 replaces — leave it failing and fix it there,
noting the expected failure in the commit message.

- [ ] **Step 5: Commit**

```bash
git add assets/app.css tests/styles_contract_test.ts
git commit -m "Square the radius scale and retune shadows and display sizes

The aurora halo ramp test fails until the surface recipe is replaced."
```

---

## Task 4: Replace the aurora recipe with the blueprint frame

This is the task the whole change turns on. Everything after it is correction.

**Files:**

- Modify: `assets/app.css` (`=== CARDS & VALUE BOXES ===`, lines 961-1010 and
  the hover/lift rules that follow; the recipe-parameter block, lines ~218-245)
- Modify: `assets/CLAUDE.md` (rewrite the **Depth** section)
- Modify: `components/TableShell.tsx`, `islands/TrialsTimeline.tsx`,
  `islands/Phenogram.tsx` (one wrapper each)
- Modify: `tests/styles_contract_test.ts`
  (`"the aurora halos grow with the
  interaction they mark"`,
  `"every surface that declares recipe parameters
  joins the recipe"`)

**Interfaces:**

- Consumes: Task 2's tier 2, Task 3's zeroed radius scale.
- Produces: the class `.blueprint-frame` (a wrapper that carries the marks for a
  scroll container) and the recipe parameters `--svd-mark-ink`,
  `--svd-mark-len`, `--svd-mark-out`. Tasks 5-9 assume every panel is already a
  square hairline box with marks and only correct what the recipe cannot reach.

**How the marks are drawn, and why not as four `<i>` children.** The design
system's own recipe is `.blueprint` plus four `<i class="corner tl|tr|bl|br">`
elements, each drawing a `+` from its `::before` and `::after`. Porting that
literally means adding four elements to twenty-two surfaces across nine
components — a large, repetitive markup diff whose only content is decoration,
and a trap the moment a surface is conditionally rendered.

Draw them instead as **eight background layers on one `::after` overlay**,
positioned to land on exactly the same pixels. The design system's geometry: the
corner box is `11×11` at `-6px`, its vertical arm is `1px` wide at `left: 5px`,
its horizontal arm `1px` tall at `top: 5px`. An overlay at `inset: -6px` puts
each cross centre at `(5.5, 5.5)` from its own corner — identical.

- [ ] **Step 1: Replace the recipe parameters**

In tier 4, replace the aurora parameters (`--svd-tint-wash`, `--svd-sheen`,
`--svd-sheen-lift`, `--svd-halo`, `--svd-halo-lift`, `--svd-halo-sm-lift`) with
the blueprint's. Keep `--svd-tint`, `--svd-tint-base`, `--svd-tint-ink` and
`--svd-stripe`: they carry meaning (a note reads as a note) that the blueprint
frame expresses through its border colour instead of a gradient.

```css
/* ---- 4. RECIPE PARAMS ------------------------------------------- */

/*
 * The blueprint frame. Industry draws every panel as a wireframe object:
 * square, transparent, hairline-bordered, with a "+" registration mark at
 * each corner. A surface joins by being listed in the shared rule at the
 * head of === CARDS & VALUE BOXES === and says what it *is* by re-declaring
 * --svd-tint; the recipe reads it back as the border colour and the mark
 * ink, which is what still makes a note read as a note and a warning as a
 * warning before the words are.
 *
 * What this replaced: a gradient wash, an inset white sheen and a
 * tint-coloured halo, cast at three scales. None of them survive contact
 * with "do not give cards or figures a surface fill — they are line
 * drawings". --svd-tint-wash, --svd-sheen, --svd-sheen-lift and the three
 * --svd-halo* steps are gone with it; --svd-shadow-* is the only elevation
 * left, and only the two floating surfaces (drawers, popovers) read it.
 */
--svd-tint: var(--svd-color-primary);
--svd-tint-base: transparent;
--svd-tint-ink: color-mix(in oklab, var(--svd-tint) 82%, var(--svd-ink));
--svd-stripe: 0 0 transparent;

/* Mark geometry, so the eight background layers below cannot drift apart.
   The arms are 11px and the overlay sits 6px outside the box, which puts
   each cross centre exactly on the panel's own corner. */
--svd-mark-ink: color-mix(in oklab, var(--svd-ink) 55%, transparent);
--svd-mark-len: 11px;
--svd-mark-out: 6px;
```

- [ ] **Step 2: Replace the shared surface rule**

```css
/* === CARDS & VALUE BOXES === */

/* Every panel in the app. A surface joins by being listed here and says what
   it is by re-declaring --svd-tint; nothing restates the geometry. The frame
   is a line drawing: no fill, no radius, one hairline, and four registration
   marks drawn just outside it. */
.card,
.value-box,
.sidebar-section,
.readout-stat,
.readout-dist,
.timeline-legend-panel,
.phenogram-legend-panel,
.timeline-drawer,
.pipeline-step-body,
.pipeline-note,
.pipeline-record,
.pipeline-sync,
.tip-box,
.login-card,
.map-error,
.map-container,
.blueprint-frame {
  position: relative;
  background: var(--svd-tint-base);
  border: 1px solid color-mix(in oklab, var(--svd-tint) 24%, var(--svd-border));
  border-radius: var(--svd-radius-md);
  box-shadow: var(--svd-stripe);
}

/*
 * The four "+" registration marks, as eight background layers on one overlay
 * rather than as four <i class="corner"> children.
 *
 * Porting the design system's own markup recipe would mean four decorative
 * elements on each of the seventeen surfaces above, in nine components. This
 * lands on the same pixels: the overlay sits --svd-mark-out outside the box,
 * so each cross centre falls exactly on the panel corner, and the arms are
 * the system's own 11px x 1px.
 *
 * pointer-events: none matters — the overlay covers the panel, and without
 * it every click on a card would land on the decoration.
 */
.card::after,
.value-box::after,
.sidebar-section::after,
.readout-stat::after,
.readout-dist::after,
.timeline-legend-panel::after,
.phenogram-legend-panel::after,
.timeline-drawer::after,
.pipeline-step-body::after,
.pipeline-note::after,
.pipeline-record::after,
.pipeline-sync::after,
.tip-box::after,
.login-card::after,
.map-error::after,
.map-container::after,
.blueprint-frame::after {
  content: '';
  position: absolute;
  inset: calc(var(--svd-mark-out) * -1);
  pointer-events: none;
  background-repeat: no-repeat;
  background-image:
    linear-gradient(var(--svd-mark-ink), var(--svd-mark-ink)),
    linear-gradient(var(--svd-mark-ink), var(--svd-mark-ink)),
    linear-gradient(var(--svd-mark-ink), var(--svd-mark-ink)),
    linear-gradient(var(--svd-mark-ink), var(--svd-mark-ink)),
    linear-gradient(var(--svd-mark-ink), var(--svd-mark-ink)),
    linear-gradient(var(--svd-mark-ink), var(--svd-mark-ink)),
    linear-gradient(var(--svd-mark-ink), var(--svd-mark-ink)),
    linear-gradient(var(--svd-mark-ink), var(--svd-mark-ink));
  background-size:
    var(--svd-mark-len) 1px, 1px var(--svd-mark-len),
    var(--svd-mark-len) 1px, 1px var(--svd-mark-len),
    var(--svd-mark-len) 1px, 1px var(--svd-mark-len),
    var(--svd-mark-len) 1px, 1px var(--svd-mark-len);
  background-position:
    left 0 top 5px, left 5px top 0,
    right 0 top 5px, right 5px top 0,
    left 0 bottom 5px, left 5px bottom 0,
    right 0 bottom 5px, right 5px bottom 0;
}
```

- [ ] **Step 3: Delete the hover-lift block**

The rules that follow the old recipe — the `transition` on `.card`,
`.value-box`, `.readout-stat`, `.tip-box`, and their `:hover` halo swaps — have
nothing left to animate: there is no halo, no sheen and no fill. Delete them,
and delete `--svd-lift` / `--svd-lift-sm` and the `prefers-reduced-motion` block
that neutralises them **only if** nothing else reads those tokens. Check first:

```bash
grep -n 'svd-lift' assets/app.css
```

If the pagination buttons or the skip link still read them, keep the tokens and
the reduced-motion block exactly as they are.

- [ ] **Step 4: Wrap the three scroll containers**

`.table-scroll`, `.timeline-scroll` and `.phenogram-scroll` are
`overflow:
auto`, which clips a pseudo-element at negative inset — the marks
would disappear. The design system hits the same problem and answers it the same
way: _"a blueprint wrapper draws its registration marks outside the box … the
frame must win."_ They are therefore **not** in the recipe list above; a wrapper
is.

In `components/TableShell.tsx`, wrap the existing scroll div:

```tsx
<div class="blueprint-frame">
  <div class="table-scroll">
    {/* unchanged */}
  </div>
</div>;
```

Do the same in `islands/TrialsTimeline.tsx` around `.timeline-scroll` and in
`islands/Phenogram.tsx` around `.phenogram-scroll`. Then remove the three
selectors' now-dead border/radius/background declarations from their own
sections, so the frame is drawn once by the wrapper:

```bash
grep -n 'table-scroll\|timeline-scroll\|phenogram-scroll' assets/app.css
```

- [ ] **Step 5: Fix the two contract tests this task invalidates**

`"the aurora halos grow with the interaction they mark"` asserts a ramp that no
longer exists. Replace it with the property that now matters — the mark geometry
is one definition, not seventeen:

```ts
Deno.test("the registration marks are drawn from the mark tokens", () => {
  // Eight background layers on one overlay, positioned from --svd-mark-len
  // and --svd-mark-out, is what lets seventeen surfaces share one definition.
  // A rule that hard-codes 11px or 6px has forked the geometry the way ten
  // hand-tuned halo copies once had.
  const marks = declarationsOf(/background-(?:size|position)/)
    .filter(({ selector }) => selector.includes("::after"));
  assert(marks.length > 0, "no registration-mark layers found");
  const forked = marks.filter(({ value }) => /\b(?:11|6)px\b/.test(value));
  assertEquals(
    forked.map((d) => `${d.line}: ${d.selector}`),
    [],
    "a mark layer hard-codes geometry instead of reading --svd-mark-*",
  );
});
```

Note: `background-size` legitimately carries the literal `1px` for the arm
thickness — the pattern above only rejects `11px` and `6px`, the two values that
are tokens.

`"every surface that declares recipe parameters joins the recipe"` still holds;
run it and fix any surface that declares `--svd-tint` without appearing in the
new list.

- [ ] **Step 6: Rewrite the Depth section of `assets/CLAUDE.md`**

The section documents the aurora recipe in detail — the sheen, the halo ramp,
the two-shadow-layer rule, `--svd-tint-wash`. All of it is gone. Replace it with
the blueprint recipe: the shared rule, the four surviving parameters, the
`::after` overlay and why it is not four `<i>` children, the wrapper for scroll
containers, and the one thing that carried over unchanged — `--svd-tint-ink` is
a parameter, not a formula, and a re-tinted chip must re-declare its own ink
step.

Keep the last three bullets of the section verbatim (icons need `flex: none`,
`--svd-z-sticky` must clear 1000, the ICM logo is inlined). None of them depend
on the recipe.

- [ ] **Step 7: Run the gates and look at the app**

```bash
deno task check
deno task test:coverage
deno task dev   # then open every tab in both themes
```

Every panel should now be a square, transparent, hairline box with four `+`
marks. Expect the _layout_ to look correct and the _detail_ to be wrong in
places — that is what Tasks 5-9 fix.

- [ ] **Step 8: Commit**

```bash
git add assets/app.css assets/CLAUDE.md components/TableShell.tsx \
        islands/TrialsTimeline.tsx islands/Phenogram.tsx \
        tests/styles_contract_test.ts
git commit -m "Replace the aurora surface recipe with the blueprint frame"
```

---

## Task 5: Navbar, footer and login

**Files:**

- Modify: `assets/app.css` (`=== NAVBAR ===` 734-960, `=== FOOTER ===` 3658,
  `=== LOGIN ===` 4528)
- Test: `e2e/tests/navigation.spec.ts`, `e2e/tests/login.spec.ts` (existing)

**Interfaces:**

- Consumes: Tasks 2-4.
- Produces: nothing later tasks read.

The navbar's grid is already what the canvas draws — brand spanning both rows in
the left track, title centred on row 1, tabs centred on row 2, actions right.
Only the treatment changes.

- [ ] **Step 1: Drop the gradient bar**

`--svd-gradient-bar` is a two-hue linear gradient across the bar's bottom edge.
Under a mono palette it is a gradient from steel to steel. Delete
`.navbar::after` and the `--svd-gradient-bar` token — and check nothing else
reads it:

```bash
grep -n 'gradient-bar' assets/app.css
```

- [ ] **Step 2: Restyle the bar and the tabs**

```css
.navbar {
  position: sticky;
  top: 0;
  z-index: var(--svd-z-sticky);
  /* Opaque: on a square, hairline system a translucent bar reads as a
     rendering artefact where page content passes under a card's marks. */
  background: var(--svd-nav);
  color: var(--svd-nav-ink);
  border-bottom: 1px solid var(--svd-border);
}
```

The tabs take the canvas's `.navtab` treatment (canvas `<style>` lines 79-83) —
a bordered box rather than a filled pill, with the border in the bar's own ink
so it reads as a drawn frame:

```css
.nav-link {
  display: flex;
  align-items: center;
  gap: var(--svd-space-1);
  padding: var(--svd-space-1) var(--svd-space-2);
  white-space: nowrap;
  text-decoration: none;
  font-family: var(--svd-font-heading);
  font-weight: var(--svd-weight-medium);
  font-size: var(--svd-text-base);
  letter-spacing: var(--svd-tracking-normal);
  border: 1px solid transparent;
  border-radius: var(--svd-radius-xs);
  color: inherit;
}

.nav-link:hover {
  border-color: color-mix(in oklab, var(--svd-nav-ink) 34%, transparent);
}

.nav-link[aria-current='page'] {
  border-color: var(--svd-nav-ink);
  background: color-mix(in oklab, var(--svd-nav-ink) 12%, transparent);
}
```

The canvas's title is `17px`, weight 500, `letter-spacing: 0.06em`, uppercase,
`opacity: 0.86` — map to `--svd-text-md`, `--svd-weight-medium`,
`--svd-tracking-caps`, and express the opacity as a `color-mix` on
`--svd-nav-ink` so it does not fade the descenders differently from the tabs.

- [ ] **Step 3: Restyle the sign-out and theme buttons**

Both take the canvas's `.btn` — square, hairline, condensed face, border in
`color-mix(in srgb, currentColor 34%, transparent)`. Keep the existing
`.navbar-signout` and `ThemeToggle` selectors; change only the declarations.

- [ ] **Step 4: The footer**

Canvas: `border-top: 1px solid var(--color-divider)`, `12px` text at 58% ink,
`© {year} Paris Brain Institute (ICM). All rights reserved.` then a `|` then the
MIT link. That is what `routes/_app.tsx` already renders — the CSS only needs
the hairline top border and the muted size. No markup change.

- [ ] **Step 5: The login card**

Canvas login (lines 1009-1057): a `min-height: 100vh` grid with the card
centred, the theme toggle absolutely positioned top-right, and inside the card
in order — the ICM logo at `height: 40px`, `h1` "ICM Cerebral SVD Dashboard", a
lede paragraph, a `.field` with a `<label for>` and `.input`, the error
`<p role="alert">` when present, and a full-width `.btn-primary` "Sign in".

`routes/login.tsx` already renders that structure. Restyle `.login-card` and its
input to the blueprint grammar; the **primary button is the one solid object in
the system**, so:

```css
.login-submit {
  width: 100%;
  margin-top: var(--svd-space-2);
  padding: var(--svd-space-2) var(--svd-space-3);
  font-family: var(--svd-font-heading);
  font-weight: var(--svd-weight-semibold);
  font-size: var(--svd-text-base);
  color: var(--svd-on-primary);
  background: var(--svd-color-accent);
  border: 1px solid var(--svd-color-accent);
  border-radius: var(--svd-radius-xs);
}

.login-submit:hover {
  background: var(--svd-steel-700);
}
.login-submit:active {
  background: var(--svd-steel-800);
}
```

Confirm the real class names first — `grep -n 'login' assets/app.css` — and keep
whatever `routes/login.tsx` emits rather than renaming.

- [ ] **Step 6: Run the chrome e2e**

```bash
npx --prefix e2e playwright test -c e2e/playwright.config.ts \
  tests/navigation.spec.ts tests/login.spec.ts tests/theme.spec.ts
```

- [ ] **Step 7: Commit**

```bash
git add assets/app.css
git commit -m "Restyle the navbar, footer and login card as blueprint objects"
```

---

## Task 6: The About page

**Files:**

- Modify: `assets/app.css` (`=== ABOUT ===` 1822-2099, `=== ABOUT PAGE ===`
  3682-3728, `=== PIPELINE RUN WIDGET ===` 3744-4527)
- Test: `e2e/tests/about.spec.ts` (existing)

**Interfaces:**

- Consumes: Tasks 2-4.

The About page's structure is already what the canvas draws. Every change here
is a declaration, not an element. Work top to bottom against the canvas (lines
195-486).

- [ ] **Step 1: The preview banner**

Canvas line 197: a `.blueprint` box with
`border-left: 2px solid
var(--dangerInk)`, a 10% wash of the same, a 14px
warning glyph and bold danger-ink copy at `12.5px`. The repo's banner reads
`--svd-tint: var(--svd-color-danger)` already — set its `--svd-stripe` to the
2px rail and let the recipe do the border.

- [ ] **Step 2: The hero card**

Canvas lines 203-222. In order: a date eyebrow (`11px`, `0.1em`, uppercase,
`--color-accent-700`, with a calendar glyph and the date on a 22% accent wash),
an `h1` at `44px` / `line-height: 1.02` / `letter-spacing: -0.02em` /
`max-width: 22ch` / `text-wrap: balance`, a `16px` lede at `max-width: 68ch` and
80% ink, then the totals.

Map: `--svd-text-4xl`, `--svd-leading-tight`, `--svd-tracking-tight`.

- [ ] **Step 3: The four totals**

This is the sharpest visual change on the page. The canvas draws them as a
**four-cell grid with shared hairlines** — `border-top` and `border-left` on the
container, `border-right` and `border-bottom` on each cell — with a **40px
accent glyph** beside a **40px condensed numeral** and an `12px` uppercase label
under it. No card per figure, no gap: one drawn table.

```css
.about-totals {
  margin-top: var(--svd-space-4);
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border: 0;
  border-top: 1px solid var(--svd-border);
  border-left: 1px solid var(--svd-border);
}

.about-totals > * {
  padding: var(--svd-space-4) var(--svd-space-3) var(--svd-space-3);
  display: flex;
  align-items: flex-start;
  gap: var(--svd-space-3);
  border-right: 1px solid var(--svd-border);
  border-bottom: 1px solid var(--svd-border);
}
```

The numeral: `font-family: var(--svd-font-heading)`, `--svd-weight-semibold`,
`--svd-text-4xl`, `line-height: 1`, `--svd-tracking-tight`,
`font-variant-numeric: tabular-nums`. The glyph:
`width: 40px; height: 40px;
color: var(--svd-color-accent); flex: none`.

Confirm the class names `routes/index.tsx` actually emits before writing the
rules.

- [ ] **Step 4: The pipeline run widget**

783 lines of CSS, and almost all of it survives the recipe unchanged. Four
corrections, from the canvas (lines 225-350):

1. **Section eyebrows** — every panel heading in the widget becomes `11px`,
   `letter-spacing: 0.1em`, uppercase, `55%` ink, condensed face.
   (`--svd-text-2xs`, `--svd-tracking-caps`.)
2. **The funnel** — the same shared-hairline grid as the totals, at
   `minmax(132px, 1fr)`, with a 26px accent glyph and a 26px condensed numeral.
   Not cards.
3. **The status badges** — square, `border: 1px solid color-mix(… 45%)`,
   background `color-mix(… 22%)`, ink from the `*-ink` step. This is where Task
   2's ink tokens are spent; check the rendered pixels, not the token values.
4. **The step rows** — the ordinal is a 16px-wide condensed numeral at 45% ink;
   the accent glyph, the condensed label, the badge, the duration
   (`min-width: 62px`, right-aligned, tabular) and the caret sit on one flex
   row.

- [ ] **Step 5: Reference-data refreshes and Data Sources**

Canvas lines 371-486. Both become **1px-gap stacks over a divider ground** —
`display: flex; flex-direction: column; gap: 1px; background:
var(--svd-border)`
with each row painting `background: var(--svd-bg-page)`. That draws the
separators without a border per row, and it is the same device the run drawer
uses. The licence chips are `.tag-neutral`: a `--svd-slate-100` fill with
`--svd-slate-800` ink, square.

- [ ] **Step 6: Verify the badge contrast on rendered pixels**

`assets/CLAUDE.md`: _"Measure a new tint on a screenshot rather than against
white."_ With `deno task dev` running, in the browser console on `/`:

```js
// For each status badge: its computed colour against its computed background.
[...document.querySelectorAll(".pipeline-status, .sync-status")].map((el) => {
  const s = getComputedStyle(el);
  return [el.textContent.trim(), s.color, s.backgroundColor];
});
```

Feed the pairs through the same contrast helper the plan used in Task 2. Every
badge must clear 4.5:1 in both themes. If one does not, take its ink one step
further — do not lighten the wash.

- [ ] **Step 7: Run the About e2e**

```bash
npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/about.spec.ts
```

- [ ] **Step 8: Commit**

```bash
git add assets/app.css
git commit -m "Redraw the About page's totals, funnel and refresh list as drawn grids"
```

---

## Task 7: The data pages

**Files:**

- Modify: `assets/app.css` (`=== SIDEBAR ===` 1087-1243,
  `=== DENSITY READOUT ===` 1244-1359, `=== TABLE CONTROLS ===` 1360-1412,
  `=== FILTER MESSAGES ===` 1413-1439, `=== DATA TABLE ===` 1440-1702,
  `=== PAGINATION ===` 1760-1813, `=== TIP BOXES ===` 2237-2283)
- Test: `e2e/tests/genes-table.spec.ts`, `tests/trials-table.spec.ts`,
  `e2e/tests/readout.spec.ts`, `e2e/tests/filter-collapse.spec.ts` (existing)

**Interfaces:**

- Consumes: Tasks 2-4.

**Scope note.** Per decision 2, the canvas's sample-size histogram and range
slider (canvas lines 536-561, and the two `input[type="range"]` rules in its
`<style>` block) are **not** ported. `components/RangeSlider.tsx` and
`components/SampleSizeHistogram.tsx` do not exist in this repo and are not
recreated.

- [ ] **Step 1: Page heads and tip boxes**

Canvas lines 490-502. `h1` at `38px` / `--svd-tracking-tight`; lede at `14.5px`
/ `max-width: 78ch` / 72% ink. Tips become a
`repeat(auto-fit, minmax(300px, 1fr))` grid of blueprint boxes with
`border-left: 2px solid var(--color-accent)` over a 10% accent wash, and the
`Tip:` prefix in the condensed face at `11px` uppercase `--color-accent-700`.

`components/TipBox.tsx` already renders `<strong>{label}</strong> {children}`
inside `.tip-box` — CSS only.

- [ ] **Step 2: The filter rail**

Canvas lines 505-575. Three changes worth naming:

1. Each group's `<legend>` becomes a full-width flex row: the label left in the
   condensed face at `12px` / `0.06em` / uppercase, and **a tabular count right
   in `--color-accent-700`**. `components/CheckboxFilter.tsx` already emits it
   as `<span class="filter-count" aria-hidden="true">` — this is a restyle of an
   existing element, not a new one. Do not add a second count.
2. The checkboxes take `accent-color: var(--svd-color-accent)` and
   `border-radius: 0`, at `14px`.
3. The rail header keeps its collapse button. `components/FilterPanel.tsx` owns
   the `is-collapsed` class on both the panel and the grid wrapper — that
   arrangement is load-bearing and does not change.

- [ ] **Step 3: The readout**

`components/DensityReadout.tsx` already renders exactly what the canvas draws: a
stats column beside a bar chart, each bar a full-height track filled to the
shown fraction, with a visually-hidden list carrying the same counts. CSS only:

- The section becomes one blueprint panel at
  `grid-template-columns: minmax(180px, 260px) 1fr` with `align-items: end`.
  Currently `.readout-stat` and `.readout-dist` are each their own surface —
  remove them from the recipe list (Task 4) and put `.readout` in instead, so
  the page reads one drawn box rather than two.
- Each stat is a baseline flex row with a hairline under it: label left at
  `11px` uppercase 60% ink, value right in the condensed face at `19px` tabular.
- Bars: `height: 62px`, `gap: 3px`, track
  `border: 1px solid
  var(--svd-border)` with `min-height: 2px`, fill
  `background:
  var(--svd-color-accent)`. Labels `9px`, centred, ellipsised.

Keep `COMPACT_BUCKET_CEILING` and the `--compact` modifier exactly as they are —
`e2e/tests/readout.spec.ts` asserts on them against live data.

- [ ] **Step 4: The table**

Canvas `<style>` lines 50-71 is the whole specification. Port it onto the
existing `.data-table` selectors:

- `border-collapse: separate; border-spacing: 0`.
- Cells `padding: 8px 10px`, `text-align: left`, `vertical-align: top`,
  `border-bottom: 1px solid color-mix(in oklab, var(--svd-ink) 10%,
  transparent)`.
- `thead th` sticky at `top: 0`, background `--svd-bg-page`, condensed face,
  `--svd-weight-semibold`, `11px`, `--svd-tracking-caps`, uppercase, 62% ink,
  `white-space: nowrap`. The second header row sticks at `top: 29px` — the first
  row's own height. **Do not hard-code 29px**: the existing rule already derives
  the two-row sticky offset, and
  `"the table header sticks as one unit, and its scrollport has a height
  floor"`
  guards it. Keep the derivation and change only the appearance.
- The group row (`th.grp`) takes `--svd-color-accent-text` in light and
  `--svd-steel-300` in dark.
- The sticky identity column keeps its `.col-identity` keying — two contract
  tests pin that it is never `:first-child` and that every background on it
  stays opaque. Its face becomes condensed `--svd-weight-semibold` at `14px`.
- Row hover:
  `background: color-mix(in oklab, var(--svd-color-accent) 7%,
  transparent)`,
  and on `.col-identity` the same mix over `--svd-bg-page` so it stays opaque.
- The tooltip trigger (`.tbox` in the canvas) becomes a 12% accent wash with
  `border-bottom: 1px dotted var(--svd-color-accent)`, no radius.

- [ ] **Step 5: The controls row and the active-filter readout**

Canvas lines 613-635. `Show [select] entries` left, search right with a
magnifying-glass glyph; both `.input`s square, `min-height: 30px`. The
`Active Filters:` line sits between a hairline top and bottom border, its prefix
in the condensed face at `11px` uppercase, and the summary in
`--svd-color-accent-text` at `--svd-weight-medium` when a filter is active or at
60% opacity when it is not.

`components/TableShell.tsx` prints that line whether or not the rail is
collapsed. Keep that true.

- [ ] **Step 6: Pagination**

Canvas lines 692-708. Previous/Next are `.btn-secondary` — square, hairline,
condensed, with a chevron — and the numbered buttons are the same at
`min-width: 32px`, the current one taking the primary fill. Remove whatever
lift/halo the old rules had; the recipe no longer provides one.

- [ ] **Step 7: Run the data-page e2e**

```bash
npx --prefix e2e playwright test -c e2e/playwright.config.ts \
  tests/genes-table.spec.ts tests/genes-filters.spec.ts \
  tests/trials-table.spec.ts tests/trials-filters.spec.ts \
  tests/readout.spec.ts tests/filter-collapse.spec.ts
```

- [ ] **Step 8: Commit**

```bash
git add assets/app.css components/CheckboxFilter.tsx
git commit -m "Restyle the data pages' rail, readout, table and pagination"
```

---

## Task 8: Tooltips and drawers

**Files:**

- Modify: `assets/app.css` (`=== TOOLTIP TRIGGERS ===` 2284-2322,
  `=== TOOLTIP POPOVER ===` 2323-2456, and the timeline drawer rules inside
  `=== TRIALS TIMELINE ===`)
- Test: `e2e/tests/tooltips.spec.ts`, `e2e/tests/timeline.spec.ts` (existing)

**Interfaces:**

- Consumes: Tasks 2-4.

The canvas's popover (lines 1131-1150) and both drawers (1070-1130) are
blueprint boxes on `--color-bg` with `--shadow-lg` — floating surfaces are the
**only** places elevation survives this design.

- [ ] **Step 1: The tooltip popover**

The current panel is a filled indigo card with white ink (`--svd-tooltip-bg` /
`--svd-tooltip-ink`). The canvas makes it a page-ground box with ordinary ink
and an accent-ink label per row. Repoint:

```css
--svd-tooltip-bg: var(--svd-bg-page);
--svd-tooltip-ink: var(--svd-ink);
```

Each row: a `12.5px` value under a condensed `10.5px` uppercase
`--svd-color-accent-text` label, with a hairline between rows and none after the
last. The panel keeps `box-shadow: var(--svd-shadow-lg)` and gains the
registration marks by joining the recipe list.

**Two things must not move.** The trigger stays a `<button popovertarget>` —
that invoker relationship is what puts the panel in the keyboard focus order.
And `display` is still only ever set under `:popover-open`; setting it on
`.tooltip-pop` outright beats the UA's `[popover]:not(:popover-open)` rule and
renders every panel on the page at once.

- [ ] **Step 2: The focus-ring exception**

`assets/CLAUDE.md` records one deliberate focus override:
`.tooltip-pop .tooltip-link-btn` swaps in `--svd-tooltip-ink` because the panel
was a filled indigo field where an indigo ring would vanish. **The panel is no
longer filled.** Delete the override so the button takes `--svd-focus-color`
like everything else, and delete the paragraph in `assets/CLAUDE.md` that
documents it. Re-check the contrast of the ring on the new ground before
committing.

- [ ] **Step 3: The two drawers**

Canvas lines 1070-1130. Both are `position: fixed` right-edge panels over a
`color-mix(in srgb, var(--color-neutral-900) 32%, transparent)` scrim, at
`min(520px, 100%)` (run records) and `min(430px, 100%)` (trial record), with
`--shadow-lg` and the blueprint frame.

Inside the trial drawer: an `h2` at `26px`, a Close `.btn-secondary`, an
optional "Incomplete record" box (`border: 1px solid var(--color-accent)`, a
condensed `11px` uppercase accent-700 head, then the reasons), the `<dl>` of all
eleven fields as a 1px-gap stack over the divider ground with each `<dt>` in
condensed `10.5px` uppercase accent-700, and a full-width `.btn-primary`
registry link.

The eleven `DRUG_FIELDS` and the tooltip's five-icon subset are unchanged — the
subset _is_ the field's `icon`, and there is no second list.

`.timeline-drawer` keeps its sticky `top` derived from `--svd-navbar-h`, and
below 1100px `.timeline-main` keeps `align-items: stretch` or the document
overflows instead of the container scrolling. Neither is cosmetic.

- [ ] **Step 4: Run the tooltip and drawer e2e**

```bash
npx --prefix e2e playwright test -c e2e/playwright.config.ts \
  tests/tooltips.spec.ts tests/timeline.spec.ts
```

`timeline.spec.ts` is the largest spec in the suite and pins the drawer's
keyboard contract (Enter/Space open, close button takes focus, Escape closes and
returns it). None of that changes; if it fails, the CSS broke focus order.

- [ ] **Step 5: Commit**

```bash
git add assets/app.css assets/CLAUDE.md
git commit -m "Redraw tooltips and drawers as blueprint panels on the page ground"
```

---

## Task 9: The figures' frames and legends

**Files:**

- Modify: `assets/app.css` (`=== INTERACTIVE FIGURES ===` 2816-2844,
  `=== TRIALS TIMELINE ===` 2845-3341, `=== PHENOGRAM ===` 3342-3629)
- Modify: `islands/TrialsTimeline.tsx`, `islands/Phenogram.tsx` (legend
  placement only)
- Test: `e2e/tests/timeline.spec.ts`, `e2e/tests/phenogram.spec.ts` (existing)

**Interfaces:**

- Consumes: Task 4's `.blueprint-frame` wrappers.

**Nothing inside either SVG changes.** Per decision 1 and 3:
`lib/timeline_encoding.json`, `lib/phenogram_encoding.json`, `lib/timeline.ts`,
`lib/phenogram.ts`, `scripts/timeline_figure.py` and
`scripts/phenogram_figure.py` are not touched. Wedge, band, marker, ring, pill
and label colours are SVG attributes from those encodings and stay where they
are.

- [ ] **Step 1: Move both legends below their plate**

The canvas puts the key **under** the figure in a
`repeat(auto-fit, minmax(300px, 1fr))` grid, with the narrow panel (evidence /
supporting evidence) in one cell and the wide one (mechanism / GWAS phenotypes)
spanning two — canvas lines 780-820 (phenogram) and 903-936 (timeline).

Today both are right-hand rails at an 18rem measure that drop below the plate at
1453px. The canvas's arrangement is the _always_ case. That simplifies the CSS
considerably: the rail rules, the `.timeline-legend` size-container declaration
and the `.timeline-layout:has(.timeline-drawer:not([hidden]))` wrap rule all
exist to manage a rail that no longer competes with the plate.

Before deleting any of them, confirm what each does:

```bash
grep -n 'timeline-legend\|timeline-layout\|timeline-main\|phenogram-legend' \
  assets/app.css
```

Keep `.timeline-legend` as a **size container** even after the move — the two
legend panels lay out by the width the key actually has, and that is still what
lets one set of rules serve every width.

In the islands, this is a wrapper move: the legend element leaves the row that
holds the plate and becomes the next sibling of that row. Do not change what
either legend renders.

- [ ] **Step 2: Frame the plates**

The `.blueprint-frame` wrappers from Task 4 already carry the marks. Add the
canvas's plate padding (`14px`) and keep each scroller's own background:
`--svd-figure-plate` for the phenogram, and for the timeline the white `rect`
the SVG paints itself. Per decision 3 neither moves off white.

- [ ] **Step 3: The legend panels**

Both take the blueprint frame from the recipe. Headings become condensed `13px`
/ `--svd-tracking-caps` / uppercase / 62% ink. Family heads in the mechanism
legend are condensed `12px` / `0.05em` / uppercase with a swatch; entries are
`12px` with `overflow-wrap: anywhere`.

The mechanism rows are **not chips** — every mechanism name wraps at the
legend's measure, and a wrapped pill is a box with round ends. That was true of
the rail and is still true here.

- [ ] **Step 4: The timeline hover tooltip**

It floats over the plate, so it cannot follow the theme: `--svd-figure-surface`,
`--svd-figure-heading` and `--svd-figure-line` stay fixed (Task 2 retargeted the
latter two onto steel steps but did **not** add dark overrides — confirm that is
still true). Give it the blueprint frame and the mark overlay by adding it to
the recipe list, and keep it `aria-hidden` and pointer-only.

- [ ] **Step 5: Run the figure e2e**

```bash
npx --prefix e2e playwright test -c e2e/playwright.config.ts \
  tests/timeline.spec.ts tests/phenogram.spec.ts
```

`timeline.spec.ts` pins the collision counts at **zero** for both label passes,
a control pair, a box count, and the computed hover/focus radii. None of those
depend on the legend's position — if one fails, the legend move changed the
plate's layout width, which it must not.

- [ ] **Step 6: Commit**

```bash
git add assets/app.css islands/TrialsTimeline.tsx islands/Phenogram.tsx
git commit -m "Frame both figures as blueprint plates and move their keys below"
```

---

## Task 10: Full gate and documentation

**Files:**

- Modify: `assets/CLAUDE.md`, `CLAUDE.md` (root), `islands/CLAUDE.md`
- Test: everything

**Interfaces:**

- Consumes: Tasks 1-9.

- [ ] **Step 1: Run every gate**

```bash
deno task check
deno task test:coverage
npx --prefix e2e playwright test -c e2e/playwright.config.ts
uv run ruff check .
uv run ty check
```

The two Python gates should be untouched by this branch — run them to prove it.
Do **not** run `ruff format`.

- [ ] **Step 2: Sweep both themes at every documented breakpoint**

With `deno task start` running (it binds `127.0.0.1`, and that flag is
load-bearing — the session cookie is `Secure` on every hostname but localhost),
open each of the six tabs at 480, 600, 900, 1100, 1410, 1453 and 1482 px in both
themes. Look for: a registration mark clipped by a scroll container, a panel
that kept a fill, a heading still in the body face, and a badge whose ink lost
its ground.

- [ ] **Step 3: Update the root `CLAUDE.md`**

Three passages describe things this branch changed:

- **Typography and type graph** — "Typography is IBM Plex Sans Variable
  (100–700) plus IBM Plex Mono, self-hosted and preloaded in `routes/_app.tsx`".
  Replace with Barlow / Barlow Condensed, six static faces, and the reason there
  is no variable option.
- **Timeline** — the key is described as "a right-hand rail, the phenogram's
  arrangement at the same 18rem measure" that "drops back under the figure … at
  1453px". It is now always below. Rewrite that paragraph and say why the size
  container survives the move.
- **Phenogram** — the same, for its own key.

Leave everything else in the file alone. In particular do not touch the passages
about the encodings, the ring set, `_unplaceable_phases`, or the figure palettes
— this branch deliberately changed none of them.

- [ ] **Step 4: Update `islands/CLAUDE.md`**

Check whether its notes on the map and the run widget name any colour or
elevation this branch moved:

```bash
grep -n 'indigo\|ember\|halo\|sheen\|radius\|IBM Plex' islands/CLAUDE.md
```

Fix what it names; leave the load-bearing behavioural notes as they are.

- [ ] **Step 5: Record the decisions**

Add a short section to this plan file (or a sibling under
`docs/superpowers/specs/`) recording the three decisions above with their
measurements, so the next person to open the design canvas does not re-litigate
them from the canvas's defaults.

- [ ] **Step 6: Commit and open the PR**

```bash
git add -u
git commit -m "Document the Industry design import"
git push origin HEAD:industry-design-import
gh pr create --title "Import the Industry design system" --body "..."
```

---

## Self-review notes

**Spec coverage.** Every screen in the canvas maps to a task: About → 6,
Genes/Trials → 7, Phenogram → 9, Trials Timeline → 8 (drawer) + 9 (plate,
legend), Trials Map → 6 (`.map-container` joins the recipe in Task 4; its own
section needs only the popup and cluster rules, folded into Task 4's sweep),
Login → 5, the chrome → 5, the drawers and tooltip → 8. The "Not yet recreated"
screen (canvas lines 991-1006) is a canvas-only placeholder for figures the
mockup did not rebuild and has no counterpart here.

**Known gaps, deliberately.** The canvas's `density`, `tableRules`,
`navTreatment` and `figurePalette` props are **design-canvas variant switches**,
not features to port: they exist so a reviewer can compare treatments inside the
canvas. This plan takes one setting of each — `comfortable`, `hairline`, `steel`
nav, and `source` figures — and hard-codes it, as the canvas's own defaults do
for the first three.

**One thing to watch during Task 4.** `grep -n '::after' assets/app.css` before
adding the mark overlay: if any recipe member already uses its own `::after`,
the overlay will clobber it. `.navbar::after` is the one known case and Task 5
deletes it, but the sweep is cheap and the failure is silent.
