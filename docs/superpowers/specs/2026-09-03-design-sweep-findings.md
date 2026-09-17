# Design Sweep — Findings (spec)

The 60 verified findings this remediation plan implements. Produced 2026-09-03
by a three-pass exploration of `assets/app.css`, the TSX surface and page
composition; a production build captured at 1440/1024/390 in both themes (38
full-page screenshots); computed-style probes for contrast, focus geometry and
the rendered type/space/radius census; a read-only diff of all 136 Figma
variables against the 151 declared CSS tokens; and a seven-surface agent fan-out
whose every finding was re-checked by an adversarial verifier instructed to
default to rejection. Five candidates were rejected that way and are not listed.

## The thesis

Every axis `tests/styles_contract_test.ts` asserts on is clean. Every axis it
does not assert on has drifted. Motion is the case that proves the mechanism
rather than the exception: it is unguarded and still clean, because it is the
one axis with a token for every value it needs. The 2026-08-27 spec (§4)
specified five scales in full and only half were built, so the assertion §11.2
called for could never be written — and the axes it would have covered are
exactly the ones that moved.

**Consequence for sequencing: extending the scales is the prerequisite for the
fix, not a tidy-up after it.**

## What holds — do not damage

- **Contrast.** Zero WCAG AA failures across all 14 page/theme combinations,
  HTML `color` and SVG `fill`, measured with a canvas resolver that handles
  `oklch()`/`color-mix()`.
- **Focus rings.** All 23 distinct interactive selectors resolve `solid 2px` at
  offset 2.
- **Motion inside `app.css`.** All 28 transition/animation declarations resolve
  tokens.
- **Figma token values.** No drift; both build checksums hold.
- **No dead CSS.** All 273 class selectors resolve to source, Leaflet, or a
  runtime name.

## Corrections carried into this spec

1. `components/FilterPanel.tsx:50`'s raw-boolean `aria-expanded` is **not** a
   rendering bug. Preact 10.29.8 stringifies `aria-*`;
   `e2e/tests/filter-collapse.spec.ts:36` asserts it renders and passes. The
   defect is that `islands/CLAUDE.md:98-100` documents a hazard that does not
   exist in the installed version.
2. "Motion is clean" is scoped to `assets/app.css`. Leaflet ships three
   off-token transitions that render on `/map`.
3. The filter label/summary mismatch is **5 of 9**, not 6.

## Scope

Defects and drift only. Every finding cites the rule it breaks. The
`cSVD-Dashboard` Figma file is an organised overview of this repo's design
tokens — **not** a source of design intent, and its screens are known to be out
of sync with the app.

---

## Global (13)

### F01 — Five scales were specified and only half-built, so the assertion that would guard them was never written

- **Severity / tier:** high / structural
- **Rule:** Design spec §4 'New scales to add' specifies space -1..-12 on a 4px
  grid, radius -xs..-full, line-height tight/normal/relaxed, z-index
  base/sticky/overlay/popover/skip. §11.2 specifies the guardrail: 'No px
  padding/margin/gap value that is not on the 4px scale'.
- **Evidence:** app.css:214-219 declares --svd-space-1..-6, stopping at 24px;
  265-268 declares four radius steps with no pill/circle step; 234 declares
  --svd-leading-tight as the only line-height token; 277-278 declares only
  --svd-z-sticky and --svd-z-skip; no letter-spacing token exists.
  tests/styles_contract_test.ts has eleven cases and none touches spacing,
  radius, z-index, line-height, letter-spacing or breakpoints. The §11.2
  assertion could not have been written: half the scale it checks against does
  not exist.
- **Fix:** Extend the scales first (space to 32/40/48/64, a radius-full,
  leading-normal/-relaxed, z-index overlay/popover), repoint the literals, and
  only then add the assertion. Land the assertion in the same commit as the fix
  so it fails before and passes after.

### F02 — 116 of 266 spacing declarations are off-scale, and two values 1/20th of a pixel apart are both in use

- **Severity / tier:** high / mechanical
- **Rule:** Design spec §4: Space on a 4px grid. assets/CLAUDE.md treats the
  token block as the single source for geometry.
- **Evidence:** Rule region (app.css:471-3975): 266 padding/margin/gap
  declarations, 100 use var(--svd-space-*) (38%), 116 carry a raw non-zero
  length across 35 distinct values. Between 0.25rem and 0.5rem sit five
  intermediates (0.3 0.35 0.4 0.45 rem). gap:0.35rem has 12 uses and gap:0.4rem
  has 8 — 0.8px apart, same job. Rendered census over 7 routes confirms 3.2px
  (202 uses) and 3.25px (51 uses) both occur. px/rem mixing has returned, the
  exact defect spec §1 called out: 8px & 0.5rem, 12px & 0.75rem, 4px & 0.25rem
  all present for one size.
- **Fix:** Collapse the 0.3/0.35/0.4/0.45 cluster onto --svd-space-1 and -2,
  extend the scale upward, then repoint. Add the §11.2 assertion.

### F03 — Ten undocumented breakpoints, including the duplicated 600px block the spec explicitly said to delete

- **Severity / tier:** high / structural
- **Rule:** Design spec §4: 'Breakpoint: documented constants; delete the
  duplicated 600px block.'
- **Evidence:** Ten distinct values — 480 600 700 900 901 980 1100 1101 1300
  1410 — none documented, with two off-by-one pairs and three near-neighbours in
  the 900-1100 band. app.css:1340 and :1980 are still both @media (max-width:
  600px). 1100px appears three times (2479,2858,3058), 1410px three times, 700px
  twice. The .about-* family is governed by three thresholds from three sections
  ~1,500 lines apart: === ABOUT === (1621-1898), === RESPONSIVE === (@1980,
  600px) and === ABOUT PAGE === (3119-3164, 980 and 700px), with eight .about-*
  selectors declared twice.
- **Fix:** Agree a documented set (e.g. 600/900/1200/1400), consolidate, and add
  an assertion that fails on an undeclared value. Note that contract-test cases
  2 and 3 assert exact media-query text and must be edited in the same commit.

### F04 — The type-scale guardrail can be satisfied by a colour token

- **Severity / tier:** high / mechanical
- **Rule:** tests/styles_contract_test.ts case 11 exists to ensure every
  font-size resolves to a step on the type scale.
- **Evidence:** Case 11 builds its `declared` set with /--svd-text-([\w-]+):/g
  over the token region. That pattern also matches the tier-3 legacy colour
  alias --svd-text-muted (app.css:292). So `font-size: var(--svd-text-muted)`
  satisfies the on-scale assertion. No current rule does this, so the hole is
  latent, not live.
- **Fix:** Anchor the pattern to the known scale suffixes, or build the set from
  an explicit list, so a colour alias cannot enter it.

### F05 — border-radius: every one of the 15 raw values is the pill/circle step the scale never got

- **Severity / tier:** medium / mechanical
- **Rule:** Design spec §4: radius scale '-xs -sm -md -lg -full (adds the two
  missing steps)'.
- **Evidence:** 49 border-radius declarations in app.css; 34 use a radius token,
  15 are raw — 999px x8 (1094,1188,1195,1679,1868,2729,3313,3734) and 50% x7
  (1164,1175,1723,2628,2717,2799,3015). There is no other off-token radius in
  the file, so the whole gap is one missing token.
- **Fix:** Add --svd-radius-full: 999px and --svd-radius-round: 50%, repoint 15
  declarations.

### F06 — line-height is 75% raw and letter-spacing is 100% raw, with values indistinguishable from each other

- **Severity / tier:** medium / mechanical
- **Rule:** Design spec §4: line-height tight/normal/relaxed. assets/CLAUDE.md:
  geometry lives in tokens, not in the rules.
- **Evidence:** line-height: 20 declarations, 15 raw, 9 distinct values —
  1.3/1.35/1.4/1.45 all occur inside a 0.15 band. letter-spacing: 8
  declarations, 8 raw, 8 distinct, no token exists; -0.01em and -0.012em both
  occur. Rendered: the 11px step (--svd-text-2xs) carries four different
  trackings (normal, 0.22px, 0.88px, 1.32px).
- **Fix:** Add --svd-leading-normal (1.5) and --svd-leading-relaxed, plus a two-
  or three-step tracking scale; collapse the 1.3/1.35/1.4/1.45 cluster.

### F07 — font-weight is 54% raw because the contract test checks renderability, not tokenization

- **Severity / tier:** medium / mechanical
- **Rule:** tests/styles_contract_test.ts case 11 asserts only that an integer
  font-weight falls inside a range some @font-face declares. assets/CLAUDE.md
  expects rules to consume tokens.
- **Evidence:** 56 font-weight declarations in the rule region; 26 use
  --svd-weight-*, 30 are raw integers (700 at
  499,942,961,998,1447,2706,3278,3535,3549,3690; 600 at sixteen sites; 500 at
  969,2397,3259). All pass the test because IBM Plex Sans Variable declares
  100-700.
- **Fix:** Repoint the 30 literals and extend case 11 to require the token,
  keeping the renderability check as a second assertion.

### F08 — The colour-literal guardrail does not know about oklch(), the notation the whole palette is authored in

- **Severity / tier:** medium / mechanical
- **Rule:** tests/styles_contract_test.ts case 7: no colour literal outside the
  token region.
- **Evidence:** Case 7 matches #hex, rgb()/rgba(), ': white' and ': black' only.
  An oklch(), hsl() or lab() literal in a rule would pass. Verified that none
  currently exists, so this is latent — but every palette entry in app.css:35-71
  is authored in oklch, making it the likeliest literal to be typed next.
- **Fix:** Extend the pattern to oklch|oklab|hsl|hwb|lab|lch|color(.

### F09 — Seven raw oklch values live in the semantic tier, one of them retyped six times

- **Severity / tier:** medium / structural
- **Rule:** app.css:16-17, the token block's own rule: 'PALETTE — raw ramps,
  authored in oklch. No rule outside this block may reference a palette token
  directly.' Tier 1 is where ramps live.
- **Evidence:** oklch(0.9390 0.0163 278.5) is written out six times across the
  two dark blocks as --svd-nav-ink, --svd-ink and --svd-tooltip-ink
  (app.css:331,333,352 and 385,387,406). Also raw in the semantic tier:
  --svd-line-strong (88), --svd-color-ok-hover (96), --svd-ink-muted and
  --svd-color-danger in both dark blocks. The two dark blocks must stay
  byte-identical, so each value is maintained in two places.
- **Fix:** Promote the six repeated values to palette steps (an indigo-100 and
  indigo-300, a red-500, a teal-300) and alias the semantic names onto them.

### F10 — The trial-status swatches are the one colour family outside the design system — 30 hand-picked hex values in four blocks

- **Severity / tier:** medium / structural
- **Rule:** Design spec §Palette: 'Trial-status swatches must be rebuilt. The
  current five are Tailwind pastels that only work on a light ground... Each
  needs a dark-surface variant.' Spec §4: dark mode is a lightness inversion,
  not a re-pick.
- **Evidence:** 15 status tokens x 2 themes = 30 raw hex values (app.css:195-209
  and both dark blocks at 364-379, 423-438). Every other colour in the file is
  an oklch ramp whose dark mode is an inversion; this family is hand-picked per
  theme and maintained in four places, since the two dark blocks are duplicated.
  The unknown-duplicates-completed half of the spec's note WAS fixed (unknown is
  now outlined); the hex half was not.
- **Fix:** Rebuild the five status hues as oklch ramp steps in tier 1 and derive
  both themes from them, as every other family already does.

### F11 — Tier 3 is mis-described: 12 of its 25 entries are not aliases and can never satisfy its own deletion rule

- **Severity / tier:** medium / structural
- **Rule:** app.css:20-22: 'LEGACY — the pre-modernization names, aliased onto
  tier 2 so the ~200 existing call sites keep resolving while rules migrate.
  Delete a name here once its last use is gone.'
- **Evidence:** Of 25 entries: 13 are pure 1:1 aliases (--svd-text→--svd-ink,
  --svd-border→--svd-line, --svd-primary, --svd-accent, --svd-danger-text,
  --svd-text-muted, --svd-bg-page, --svd-bg-card, --svd-bg-light,
  --svd-border-section, --svd-link, --svd-link-visited, --svd-font) carrying 120
  uses — the migration the block exists to enable never happened. The other 12
  are derived color-mix()/composite values with no tier-2 equivalent
  (--svd-bg-sticky-head, --svd-ring-accent, --svd-rail-accent,
  --svd-accent-subtle, --svd-bg-group, --svd-bg-row-even, --svd-bg-row-stripe,
  --svd-bg-hover-accent, --svd-bg-sticky-even, --svd-bg-tooltip-hover,
  --svd-gradient-bar, --svd-transition): the deletion rule can never fire for
  them. --svd-transition alone has 40 uses while the tier-2 tokens it wraps have
  2/1/3.
- **Fix:** Promote the 12 derived values into tier 2 where they belong, then
  either finish the 13-alias migration or restate the block as a permanent
  compatibility layer. Either way the comment should stop describing a migration
  that is not happening.

### F12 — "Skip to main content" lands the reader behind the sticky navbar, and the amount hidden grows from 101px to 255px as the viewport narrows

- **Severity / tier:** medium / mechanical
- **Rule:** WCAG 2.4.1 Bypass Blocks — the mechanism must move the reader past
  the repeated block. `.navbar` is `position:sticky; top:0` (app.css:623-634)
  and app.css already computes this clearance twice for sticky children:
  `.sidebar-section{top:6.5rem}` with "Clears the sticky navbar (101px at this
  width)" (app.css:974-981, finding cited 976-982) plus the 901-1410px override
  to 9.5rem (app.css:1975-1978), and `.timeline-drawer` carries the same pair
  (app.css:2761-2765 and 2850-2855). `#main-content` (routes/_app.tsx:164) gets
  no `scroll-margin-top`; `grep scroll-margin` over app.css returns nothing.
- **Evidence:** Re-measured after Tab + Enter on `a.skip-link`
  (routes/_app.tsx:115) on /genes:
  `document.activeElement.id === "main-content"`, `#main-content` computed
  `scroll-margin-top: 0px`, its top = 0 while `.navbar` bottom = 101 at 1440,
  149 at 1024, 176 at 768, 194 at 600, 235 at 390 and 255 at 320 — the `<h1>`
  (top 16-24, bottom 51-59) is entirely under the bar at every one. Navbar
  heights measured across the stylesheet's breakpoints are the seven the finding
  lists: 101 (≥1411), 149 (901-1410), 176 (768), 194 (480-600), 217 (601-700),
  235 (390), 255 (320) — against the two clearance values the CSS hard-codes.
- **Fix:** Publish the navbar height once as a custom property set per
  breakpoint alongside the existing `.navbar-inner` rules, then have
  `#main-content { scroll-margin-top: var(--svd-navbar-h) }` and the two sticky
  `top` values read it — one number instead of two hard-coded rems that already
  cover only two of seven navbar heights. Keep `.skip-link`'s own `:focus` rules
  (app.css:538-556) untouched.

### F13 — Two CSS sections are misfiled, and the drug-group striping is split across two of them

- **Severity / tier:** low / mechanical
- **Rule:** The file is organised by === SECTION === banners; a selector should
  sit under the banner that names it.
- **Evidence:** === ABOUT PAGE === (app.css:3119) opens with
  .pipeline-status-timestamp, a pipeline-widget selector. === PAGE HEADINGS ===
  (app.css:3165) holds .data-table td { max-width: 28ch } and the entire
  drug-group striping block (3181-3202) — four .data-table rules under a
  headings banner, 1,700 lines from === DATA TABLE === (1421-1538), which
  already contains a 'Merged drug-group cells' block at 1528-1537.
- **Fix:** Move .pipeline-status-timestamp into the pipeline section and the
  four .data-table rules into === DATA TABLE ===, beside the block they belong
  with.

---

## Tables (9)

### F14 — On /trials the sticky identity-column treatment lands on Mechanism of Action in every merged drug block and overlaps the pinned Drug cell

- **Severity / tier:** high / structural
- **Rule:** assets/app.css:1503-1511 — comment "Sticky first column — opaque so
  scrolled cells pass underneath it." — pins
  `.data-table tbody td:first-child:not([colspan])` with
  `position: sticky; left: 0; font-weight: 600; border-right: 1px`. It keys off
  DOM position, not column identity. components/TableShell.tsx:353-356 returns
  `null` for any covered cell, and islands/TrialsView.tsx:116-119 gives only
  `drug` (plus geneticTarget, clinicalTrialPhase, svdPopulation)
  `spanRows: spanWithinDrug`, so on every covered row the first rendered `<td>`
  is `mechanismOfAction` (TrialsView.tsx:120-122). SIBLING SURFACE holds: on
  /genes no column spans rows, so `td:first-child` is always the Gene cell and
  the rule does the right thing there.
- **Evidence:** REPRODUCED live at 1440x900 on /trials with `.table-scroll`
  scrollLeft=420. Aspirin block: the anchor row's first cell is `Aspirin`
  (rowspan=2/3, w=129, x=21, sticky, left 0px, fw 600); both covered rows' first
  cells are `Antiplatelet (cyclooxygenase inhibitor)` — also `position: sticky`,
  `left: 0px`, `font-weight: 600`, w=183, x=21, i.e. pinned on top of the Drug
  cell. Same for the Amlodipine block
  (`Blood pressure lowering (calcium channel blocker)`, sticky, left 0px, w=183,
  x=21). /tmp/ts-amlo.png shows the collision rendered: bold "Antipl**No**telet
  (cyclooxygenase inhibitor)" at left:0 with "Aspirin" underneath it.
  CORRECTION: the cited `shots/trials-light-wide.png` does not exist anywhere on
  this machine; the /tmp screenshots do.
- **Fix:** Stop keying the sticky/identity treatment off `td:first-child`.
  TableShell's `columnClass()` (TableShell.tsx:230-231) currently emits only
  `col-group-start`, so add an `identityColumn` prop and have it also emit e.g.
  `col-identity` on that column's `<td>` and leaf `<th>`, then repoint
  app.css:1503-1526 from `td:first-child` / `thead tr:last-child th:first-child`
  to `td.col-identity` / `th.col-identity`. Covered rows then carry no identity
  cell, which is correct — the merged Drug cell already labels them. Safe
  against the e2e suite: this is additive on the `<td>` class list, so
  `td.group-cell` (trials-table.spec.ts:62,65,81,89,99,104), the
  `group-even`/`group-odd` row classes (74,144-145) and every `td:nth-child(N)`
  selector (genes-table.spec.ts:191, trials-table.spec.ts:165,191,199) are
  untouched.

### F15 — The sticky first column is 3% translucent on every odd drug block, so scrolled columns read through the drug name

- **Severity / tier:** high / mechanical
- **Rule:** assets/app.css:1503 states the invariant in its own comment: "Sticky
  first column — opaque so scrolled cells pass underneath it."
  `--svd-bg-sticky-even` (app.css:304) =
  `color-mix(in oklab, var(--svd-color-primary) 3%, var(--svd-surface))` is the
  opaque 3% tint that exists for exactly this cell, and
  `.data-table tbody tr:nth-child(even) td:first-child` (1519-1521) uses it. But
  `.data-table tbody tr.group-odd, .data-table tbody tr.group-odd td:first-child`
  (3186-3189) reaches for `--svd-bg-row-stripe` (298) =
  `color-mix(in oklab, var(--svd-color-primary) 3%, transparent)` — same tint,
  no ground. SIBLING SURFACE holds: /genes' even rows use the opaque token and
  do not bleed.
- **Evidence:** REPRODUCED live at 1440x900 on /trials: computed background of
  `.group-odd td:first-child` = `oklab(0.5088 0.0183441 -0.201567 / 0.03)`
  (alpha 0.03); `.group-even td:first-child` = `rgb(255, 255, 255)`.
  /tmp/trials-overlap.png at scrollLeft 420 shows it: the group-even row reads
  "Acetylcysteine" cleanly on white, the group-odd row directly below reads
  "Acetyl**No**salicyclic acid" — the "No" from Genetic Evidence showing through
  the pinned cell.
- **Fix:** Split app.css:3186-3189 so the `<tr>` keeps `--svd-bg-row-stripe` and
  the sticky cell gets `--svd-bg-sticky-even` — the same split
  `tr:nth-child(even)` (1496-1498) / `tr:nth-child(even) td:first-child`
  (1519-1521) already uses. Dark-safe: `--svd-bg-sticky-even` mixes into
  `--svd-surface`, which the dark blocks override (app.css:327), so it needs no
  dark counterpart. If finding 1's `col-identity` fix lands first, apply this to
  `.group-odd td.col-identity` instead; the two are independent — a group-odd
  block's own anchor Drug cell bleeds today either way.

### F16 — The drawer trigger wears the hover skin at rest — the only rule in the sheet that does — so it reads as a filled ember chip beside the ember warning badges

- **Severity / tier:** medium / judgment
- **Rule:** Rewritten. The original rule citation (assets/CLAUDE.md:108-111,
  "Those mark _this control responds to you_, which is not what `--svd-tint`
  means") governs which token a rule reads, not hue distinctness, and cannot be
  violated by ember-on-ember: `--svd-color-accent` IS ember-600 (app.css:91),
  there is no separate warning token in the system, and `.pipeline-tint-ember`
  deliberately resolves to the accent (app.css:3225-3228). The reproducible
  defect is a mechanical one — every other rule in app.css paints
  `--svd-bg-hover-accent` / `--svd-ring-accent` in a `:hover` selector; this one
  paints them at rest.
- **Evidence:** Reproduced with corrected framing. `.pipeline-drawer-trigger`
  (app.css:3598-3612) paints `background: var(--svd-bg-hover-accent)` (10%
  accent, app.css:300) and `border: 1px solid var(--svd-ring-accent)` (30%
  accent, app.css:301) in its REST state. Every other occurrence of those two
  tokens in the sheet is a hover selector: 1023-1026 `.sidebar-toggle:hover`,
  1117-1120 `.filter-option:hover`, 1499-1500 `.data-table tbody tr:hover`,
  1593-1598 `.pagination button:hover`, 2810-2814
  `.pipeline-drawer-close:hover`, 3196-3200 group-row hover, 3377-3379
  `.pipeline-step-head:hover` — the last carrying a comment stating the accent
  is the hover register. The consequence the original finding measured also
  holds: `.pipeline-tint-ember` badges paint 14% wash / 28% border from the
  shared chip rule (app.css:906-916) against the trigger's 10% / 30% — same hue,
  4pp and 2pp apart — so in the crop of about-light-wide.png y=600-1320 (and the
  dark equivalent) the three "Passed with warnings" badges and the "View
  everything this run recorded" button read as one family of ember objects on a
  card whose status is "Completed with warnings".
- **Fix:** Rewritten — do NOT switch the trigger to indigo. The accent is the
  app-wide interaction hue (assets/CLAUDE.md:108-111 sends filter rows, table
  row rails and pagination to it), so an indigo control would diverge from every
  other affordance in the app. Instead give the trigger a rest state of its own:
  text and chevron at `--svd-text-sm` in `--svd-link`, no fill and no ring, and
  move `background: var(--svd-bg-hover-accent)` /
  `border-color: var(--svd-ring-accent)` into
  `.pipeline-drawer-trigger:hover, :focus-visible` beside the existing `:hover`
  rule at app.css:3614-3617 — which is where every sibling control already keeps
  them. The ember then means "warning" at rest and "you are touching this" on
  interaction.

### F17 — Column widths are allocated by header-label length, not by content, so the widest columns hold the least data and rows run 62-434px tall

- **Severity / tier:** medium / structural
- **Rule:** This is an internal-consistency argument, not a quoted rule —
  flagged as such. Two rules in the same stylesheet pull against each other
  under the table's default `table-layout: auto` (verified computed):
  `.data-table thead th { white-space: nowrap }` (assets/app.css:1448) lets a
  header label set an unbounded column minimum, while
  `.data-table td { max-width: 28ch }` (app.css:3181-3183) caps every body
  column at one identical measure regardless of what it holds. The label wins.
  The placement sub-claim also checks out: 3181-3200 (the `max-width` and the
  drug-group striping) sit under `/* === PAGE HEADINGS === */` (3165), 1,744
  lines from `/* === DATA TABLE === */` (1421); assets/CLAUDE.md:25 treats the
  `=== … ===` sections as the stylesheet's organising unit.
- **Evidence:** REPRODUCED live at 1440x900. /genes: table 1951px inside a
  1060px scrollport (54% visible); computed `td` max-width 235.2px (28ch).
  Header width vs the value it holds, first row: Mendelian Randomization 217px
  for "No"; Chromosomal Location 196px for "7q31.1"; Link to Monogenic Disease
  219px for "(none found)"; Evidence From Other Omics Studies 281px for "(none
  found)" — against Source Quote 136px and References 140px, the two prose
  columns. Row heights page 1: min 62px, median 296px, max 434px (7x spread),
  tbody 2222px for 10 rows. /trials: table 2121px in a 1060px scrollport, rows
  104-272px, tbody 4369px for 25 rows. /tmp/gs-a.png shows the NBEAL1 row.
  CORRECTIONS: scrollport is 1060px not 1058px; `shots/genes-light-wide.png`
  does not exist; the "19% at 390px" figure was not re-measured and should be
  dropped.
- **Fix:** Move `max-width` and the group-striping rules from 3181-3200 into
  `=== DATA TABLE ===`, then replace the single 28ch cap with per-column
  measures. Note the finding's premise is slightly wrong — TableShell does NOT
  emit a class per `cell.column.id` today (`columnClass()` at
  TableShell.tsx:230-231 emits only `col-group-start`), so this needs the same
  new class hook finding 1 proposes; land them together. Narrow set (`gene`,
  `chromosomalLocation`, `mendelianRandomization`, `confidence`,
  `clinicalTrialPhase`, `geneticEvidence`) gets `white-space: normal` on the
  header plus a small `min-width`; wide-prose set (`sourceQuote`,
  `primaryOutcome`, `trialName`, `references`) gets a larger `max-width`. Column
  order and per-row cell counts must not change — genes-table.spec.ts:191 and
  trials-table.spec.ts:165,191,199 index columns by `td:nth-child(N)`.

### F18 — Column headers never stick vertically, so 11-13 column labels leave the screen after the first row or two

- **Severity / tier:** medium / structural
- **Rule:** `.data-table thead th` (assets/app.css:1443-1450) is
  `position: relative` and sets no `top`; the only `position: sticky` in the
  table block is `thead tr:last-child th:first-child` / `tbody td:first-child`
  at 1503-1511, which pins horizontally (`left: 0`) only. `--svd-bg-sticky-head`
  (app.css:303) already names an opaque head background for a stickiness the
  rule never implements. SIBLING SURFACE holds: on these same two pages
  `.sidebar-section` is `position: sticky` (app.css:974-981) and the navbar is
  sticky (app.css:623-626; design spec
  2026-08-27-ui-modernization-design.md:103). CORRECTION: the sidebar's offset
  is `top: 6.5rem` (104px computed), not the 9.5rem claimed.
- **Evidence:** REPRODUCED live at 1440x900: every `.data-table thead th`
  computes `top: "auto"` or `"0px"` with `position: relative`; zero `th` on
  either page is both sticky and offset. /genes tbody 2222px for 10 rows,
  /trials tbody 4369px for 25 rows, against a 900px viewport — the labels are
  off-screen for most of the body while the table is also scrolled horizontally
  (1951px / 2121px in a 1060px scrollport). /tmp/gs-a.png shows the header
  disappearing under the navbar mid-table.
- **Fix:** THE PROPOSED FIX DOES NOT WORK — I injected
  `.data-table thead th { position: sticky; top: 104px }` live and the header
  still scrolled away (th top went from 694px to -506px after a 1200px page
  scroll). `.table-scroll { overflow-x: auto }` (app.css:1443-1445) makes
  `overflow-y` compute to `auto` (verified), so the thead's nearest scroll
  container is `.table-scroll` itself, whose height equals its content and
  therefore never scrolls. Correct fix: bound the container first —
  `.table-scroll { max-height: calc(100vh - 8rem) }`, the same measure
  `.sidebar-section` (979) and `.timeline-drawer` (2766) already use — then
  `.data-table thead th { position: sticky; top: 0 }`, with /genes' second
  header row offset by row 1's height, keeping `--svd-bg-sticky-head` opaque and
  leaving `thead tr:last-child th:first-child`'s existing `z-index: 3` above the
  body's sticky column. Safe: runtime.spec.ts:33-49's guard measures horizontal
  overflow only, and tooltips stay unclipped because they are top-layer popovers
  (tooltips.spec.ts:6).

### F19 — Data cells are not IBM Plex Mono — the chosen direction's second signature is unbuilt in both tables

- **Severity / tier:** medium / structural
- **Rule:** VERIFIED VERBATIM.
  docs/superpowers/specs/2026-08-27-ui-modernization-design.md:169-172, under
  "## 3. Aesthetic direction — Console (chosen)" (line 110; status line 3 reads
  "direction chosen — Console"): "IBM Plex Sans for UI and prose; **IBM Plex
  Mono for every data cell** — gene symbols, chromosomal locations, registry
  IDs, sample sizes, completion dates, reference counts, the pagination range.
  This is what makes columns align without effort and is the direction's second
  signature after the readout." assets/app.css:1541-1546 records the deferral in
  a comment: "Column-level mono … needs per-column classes that do not exist
  yet, so it lands with the table work."
- **Evidence:** REPRODUCED live at 1440x900. Computed `font-family`: `LAMB1`
  (Gene cell and its tooltip `<button>`) = "IBM Plex Sans Variable"; `7q31.1`
  (Chromosomal Location) = "IBM Plex Sans Variable"; `NCT03306979` (Registry ID
  button on /trials) = "IBM Plex Sans Variable". A whole-document scan of /genes
  found ZERO elements resolving to IBM Plex Mono inside the table — only
  `.pagination span` ("Showing 1–10 of 79") and `.readout-stat-value` ("79 /
  79") outside it. The tabular-nums half of the finding also holds:
  `.data-table` (app.css:1550-1553) inherits
  `font-variant-numeric: tabular-nums` to every measured `th`/`td` and survives
  into the tooltip `<button>`s. CORRECTION: the cited `data/measurements.json`
  does not exist; this is my own measurement.
- **Fix:** Same per-column class hook as findings 1 and 3 — note TableShell does
  not emit a class per `cell.column.id` today, so it has to be added. Set
  `font-family: var(--svd-font-mono)` on the identifier columns the spec
  actually names: `gene`, `chromosomalLocation` on /genes and `registryId`,
  `targetSampleSize`, `estimatedCompletionDate`, `clinicalTrialPhase` on
  /trials. Drop `references` from the finding's list — that column holds
  citation prose ("Morel, H., et al. (2023)"), not the "reference counts" the
  spec names — and drop `confidence`, which renders "—" or a decimal and is
  already tabular.

### F20 — Below 600px the density readout — the spec's named signature element — is deleted from both table pages, taking its screen-reader text alternative with it

- **Severity / tier:** medium / structural
- **Rule:** Design spec §3
  (docs/superpowers/specs/2026-08-27-ui-modernization-design.md:115): "Signature
  element: the density readout. Three tiles above each table, plus a bar per
  bucket — genes by chromosome, trials by phase"; §13 (:447) requires the manual
  pass at 1440 / 768 / 390. The same spec (:82-84) states the accessibility
  principle at issue: ".visually-hidden — map.spec.ts:156-161 guards that it
  clips rather than display:none … It is the screen-reader route to all 70 map
  sites." components/DensityReadout.tsx:25 states "The bars are the point."
- **Evidence:** assets/app.css:1340-1344 (finding said 1340-1345)
  `@media (max-width:600px){.readout-dist{display:none}}`. Re-measured in
  Chromium against the production build: /genes at 390px — `.readout-dist`
  computed `display:none`; `section.readout` keeps
  `aria-label="Genes by chromosome"` and its innerText is exactly "GENES SHOWN
  79/ 79 GWAS-SUPPORTED 58 MONOGENIC LINK 27"; the 21-item `ul.visually-hidden`
  (DensityReadout.tsx:63) has 0 client rects and `offsetParent === null`, i.e.
  out of the accessibility tree. At 601px the same 21 bars measure 23.6px each
  with 0 clipped `.readout-bar-label`s; /trials has 5 phase buckets at 105.4px
  each at 601px and is hidden at 390px too, with its region still named "Trials
  by phase" over "TRIALS SHOWN 111/ 111 …". Committed data confirms the bucket
  counts (21 chromosomes over 79 genes; 5 phases over 111 trials). One
  correction: the "nothing forces this" argument was measured at 601px, where
  the bars are still shown — it is unproven for the 21-bucket /genes strip at
  390px (≈13px per bar), and holds only for the 5-bucket /trials strip.
- **Fix:** Lift `ul.visually-hidden` out of `.readout-dist` so the per-bucket
  counts survive the hide (or move the hide to `.readout-bars`), which also
  stops a region named after chromosomes from containing none; and drop the hide
  for the 5-bucket /trials histogram, which has no fit problem at any width.
  Keep `.readout-bars[aria-hidden="true"]` and
  `.readout-dist .readout-stat-label em` intact — e2e/tests/readout.spec.ts:66
  and :70-79 pin both.

### F21 — The above-table row count is the only one of three readouts of the same number rendered in proportional figures

- **Severity / tier:** low / mechanical
- **Rule:** CORRECTED — spec line 250 asks for tabular figures on "every numeric
  table column, the pagination range, and the value boxes" and does not name the
  filter message, so the finding's rule citation overreaches. The real basis is
  internal inconsistency, and the sibling comparison does hold: on the same page
  and about the same number, `.readout-stat-value` (app.css:1275-1282, above the
  table) and `.pagination span` (app.css:1554-1557, below it) are both
  `--svd-font-mono` + `tabular-nums`, `.filter-count` (app.css:1550-1553) is
  tabular-nums, and `.filter-message` (app.css:1401-1411), sitting between them,
  is neither.
- **Evidence:** REPRODUCED live on /genes at 1440x900: `.filter-message` "Active
  Filters: None — showing 79 of 79 rows" → font-family "IBM Plex Sans Variable",
  `font-variant-numeric: normal`. `.pagination span` "Showing 1–10 of 79" → "IBM
  Plex Mono", `tabular-nums`. `.readout-stat-value` "79 / 79" → "IBM Plex Mono",
  `tabular-nums`. The message re-renders on every keystroke
  (TableShell.tsx:255-262 calls `table.setGlobalFilter` on input) while
  `TableShell` prints it above the table on both pages regardless of sidebar
  collapse.
- **Fix:** Add `font-variant-numeric: tabular-nums` to `.filter-message`
  (app.css:1401). Selector-only additions; `.filter-message`, `.filter-active`
  and `.filter-none` are e2e-load-bearing class names and none of them change.

### F22 — "main-content" names two different regions on the same page: the <main> landmark's id and a nested div's class

- **Severity / tier:** low / mechanical
- **Rule:** Sibling surface named on both sides: routes/_app.tsx's
  `<main id="main-content">` (skip-link target and focus landmark) versus
  components/FilterPanel.tsx's `<div class="main-content">` (the table column
  inside the sidebar grid). Both render on /genes and /trials, one nested inside
  the other.
- **Evidence:** VERIFIED. routes/_app.tsx:115
  `<a class="skip-link" href="#main-content">Skip to main content</a>` and :164
  `<main id="main-content" class="page-main" tabIndex={-1}>`;
  components/FilterPanel.tsx:66 `<div class="main-content">{children}</div>`,
  styled at assets/app.css:617-619 (`min-width: 0` — its only declaration, and
  the only `main-content` match in the stylesheet). The test suite already
  disambiguates: e2e/tests/navigation.spec.ts:83 uses
  `page.locator("main#main-content")` with the tag qualifier doing real work,
  while e2e/tests/filter-collapse.spec.ts:27 uses bare `.main-content` for the
  table column. A whole-repo grep returns exactly those five hits.
- **Fix:** Rename the inner one to `.layout-main`, matching its
  `.layout-sidebar` parent (components/FilterPanel.tsx:40, assets/app.css:610).
  Three edits: FilterPanel.tsx:66, assets/app.css:617,
  e2e/tests/filter-collapse.spec.ts:27. It is not on the protected list (the
  eight in e2e/helpers.ts are .filter-count, .data-table, .table-control,
  .tooltip-pop, .is-placed, .empty-state, .filter-none, .filter-active). Leave
  the `<main id="main-content">` landmark alone — the skip link and
  navigation.spec.ts depend on it.

---

## About (8)

### F23 — The three refresh entries declare the depth recipe's parameters but never join it, so they paint no surface at all

- **Severity / tier:** high / mechanical
- **Rule:** assets/CLAUDE.md:24-27 § Depth: "A surface joins by being listed in
  the shared rule at the head of `=== CARDS & VALUE BOXES ===` and says what it
  _is_ by re-declaring three recipe parameters on itself". `.pipeline-sync` does
  only the second half.
- **Evidence:** Reproduced. app.css:3682-3687 `.pipeline-sync` sets
  `--svd-tint-wash: 4%`, `--svd-tint-base: var(--svd-surface-translucent)`,
  `padding: var(--svd-space-3)`, `border-radius: var(--svd-radius-sm)` —
  identical to `.pipeline-record` (app.css:3762-3768) minus the `--svd-stripe`
  rail. The recipe's selector list is app.css:854-870 (declarations 871-881); it
  names `.pipeline-record` at 867 and does NOT name `.pipeline-sync`, so no
  background, border or box-shadow is ever applied and both custom properties
  are dead — nothing inside a `.pipeline-sync` reads them. Its own comment
  (app.css:3680-3681) claims "A surface on the same recipe `.pipeline-record`
  uses, minus the rail", which the CSS contradicts. Verified visually by
  cropping about-light-wide.png y=1350-2200 and about-dark-wide.png y=1380-1800:
  the three refreshes ("Disease annotations", "Clinical trials", "Gene &
  citation metadata") have no box, no border and no wash in either theme; only
  whitespace separates one event from the next. Card bounds measured by pixel
  scan at x=1285: the syncs card runs y=1319→2145. Corollary confirmed:
  `.about-source-card` (app.css:1824-1829) hand-rolls
  `border: 1px solid var(--svd-border)` + `border-radius` + a 3% tint background
  instead of joining, so the page draws "an entry inside a card" three ways —
  recipe, hand-roll, and nothing. No test pins the recipe list
  (`tests/styles_contract_test.ts` does not mention it).
- **Fix:** Add `.pipeline-sync` to the recipe selector list at
  assets/app.css:854-870, beside `.pipeline-record`. Its existing parameter
  block then resolves: `--svd-tint` inherits `var(--svd-color-primary)` from
  `:root` (app.css:173), and its later `border-radius: var(--svd-radius-sm)`
  (3686) still wins over the recipe's `md` because it is declared further down
  the sheet at equal specificity. Optionally fold `.about-source-card` onto the
  recipe too — but that requires deleting its `border` and `background`
  declarations (1826, 1828), not just adding the selector, since a later rule at
  equal specificity would otherwise override the recipe's gradient and border.

### F24 — PipelineSyncs prints the maintainer's endpoint register on the card, directly above the Data Sources panel — the exact arrangement the drawer exists to prevent

- **Severity / tier:** high / structural
- **Rule:** islands/CLAUDE.md:127-132: "**External services lives there, not on
  the card.** Endpoint paths and HTTP verbs … are a maintainer's register, and
  the card sits a few hundred pixels above a Data Sources panel that names the
  same class of thing — external sources the run consulted — in prose. Two
  registers for one concept on one page; the drawer is where the
  maintainer-facing record already was."
- **Evidence:** Rule text verified verbatim at islands/CLAUDE.md:127-132, and
  restated in code at islands/PipelineRun.tsx:673-679. PipelineRun obeys it: its
  `.pipeline-apis` section is inside `<aside class="pipeline-drawer">`
  (PipelineRun.tsx:681-700). components/PipelineSyncs.tsx:89-107 renders the
  identical `.pipeline-apis > ul > .pipeline-api` markup — `.pipeline-method`
  verb chips and `<code class="pipeline-api-endpoint">` — inline on the card,
  and its own comment (PipelineSyncs.tsx:84-87) acknowledges it is reusing the
  drawer's list shape. Correction to the original evidence: the card carries
  EIGHT endpoint rows, not nine — data/pipeline_syncs.json has 5
  (annotation_sync: POST /api/v4/graphql, GET
  /rd-cross-referencing/orphacodes/:id, GET /rd-phenotypes/orphacodes/:id,
  POST + GET /entrez/eutils/*) + 1 (clinical_trials: GET /api/v2/studies) + 2
  (external_sync) — and measurements.json confirms n=8 for
  `.pipeline-api-endpoint` on about-light. routes/index.tsx:84-130 confirms the
  Data Sources panel names ClinVar, Orphanet/Orphadata and Open Targets in
  prose. Corrected geometry (pixel scan at x=1285 of the 1440x2795
  about-light-wide.png): the syncs card runs y=1319→2145 (826px, 30% of page
  height), and the reader-facing Citation & Contact / Data Sources cards do not
  start until y=2173, i.e. 78% down the page.
- **Fix:** Give each `.pipeline-sync` the treatment PipelineRun already has:
  keep the mode name, status badge, timestamp, duration and the
  `.pipeline-sources` fetched/written counts on the card, and put the
  `.pipeline-apis` list behind a per-refresh disclosure. Prefer a native
  `<details>/<summary>` over promoting the component to an island: PipelineSyncs
  holds no state (its own comment, PipelineSyncs.tsx:20-23, says "Not an island"
  and only sanctions promotion "if a per-refresh drawer is ever wanted"), and
  `<details>` keeps the eight `.pipeline-api-name` elements in the DOM, which is
  what `e2e/tests/about.spec.ts:224-228` asserts over. That removes eight rows
  of verbs and paths and lifts Citation & Contact / Data Sources several hundred
  pixels.

### F25 — The pipeline funnel's ten figures are the only headline numerals in the app not set in --svd-font-mono, and render as the identical computed type as bold body copy

- **Severity / tier:** medium / mechanical
- **Rule:** Sibling-surface inconsistency plus the rule's own stated intent.
  Three of the app's four headline-numeral rules pair `--svd-font-mono` with
  `font-variant-numeric: tabular-nums` — app.css:1553-1557
  (`.pagination span, .value-box-value`), 1734-1742 (`.about-kpi-value`),
  1275-1282 (`.readout-stat-value`). `.pipeline-stat-value`'s own comment
  (app.css:3528-3532) claims parity with `.value-box-value`: it matched the
  indigo and not the family. Spec §5
  (docs/superpowers/specs/2026-08-27-ui-modernization-design.md:250-252)
  mandates tabular-nums on the value boxes but does not itself mandate the mono
  family — the family is a de facto pattern, not a written rule.
- **Evidence:** Reproduced. app.css:3533-3538 `.pipeline-stat-value` sets
  `font-size: var(--svd-text-md)` (=1rem, app.css:224), `font-weight: 700`,
  `font-variant-numeric: tabular-nums`, `color: var(--svd-primary)` and no
  `font-family`, so it inherits IBM Plex Sans Variable. measurements.json
  `about-light.type` holds exactly three IBM Plex Mono buckets — 32px|500
  (`.about-kpi-value`, n=4) and two 11px buckets (`.pipeline-method` n=8,
  `.pipeline-api-endpoint` n=8) — and none is the funnel. The funnel falls in
  `16px|700|24px|normal|IBM Plex Sans Variable`, n=18, whose recorded sample is
  `div.card.warning-card > div.card-body > strong`; the crop of
  about-light-wide.png y=600-1320 shows the ten figures
  798/55/35/20/17/6/10/1/0/3 reading as bold sans body copy against the mono KPI
  row 600px above. Line-number corrections: the pagination/value-box rule is
  1553-1557 (not 1552-1555), `.about-kpi-value` is 1734-1742 (not 1734-1739).
  Second drift verified: `.about-kpi-value` is `--svd-weight-medium` (500) while
  `.value-box-value` — the fallback rendered in its place when `pipelineRun` is
  null (routes/index.tsx:236-243) — is a raw `700` (app.css:960); `.value-box`
  is used nowhere else in the app. Third drift verified: `.about-kpi` is
  value-then-label (routes/index.tsx:216-221), `.pipeline-stat` is
  label-then-value (islands/PipelineRun.tsx:128-139). Note `.readout-stat-value`
  uses `--svd-weight-semibold`, so the app's mono numerals already run
  500/600/700 — the weight-parity ask is scoped to the About page's two states
  of one slot.
- **Fix:** Add `font-family: var(--svd-font-mono)` to `.pipeline-stat-value`
  (app.css:3533-3538) and set its weight from `--svd-weight-medium`, matching
  `.about-kpi-value`; change `.value-box-value`'s raw `700` (app.css:960) to
  `var(--svd-weight-medium)` so the two states of the same page agree. Leave the
  16px scale — the comment's reason (a dense readout, not four hero figures) is
  sound. Do not reorder `.pipeline-stat` to value-first; at 390px it is already
  a ten-row single column.

### F26 — The drawer's open control is at the card's bottom-left and its close control at the top-right of the same box, ~600px apart

- **Severity / tier:** medium / judgment
- **Rule:** A standing user request, not an inferred rule: docs/to-do-list.md:26
  — "Move the button used to view more info on the last pipeline run to the
  top-right of the box". Reinforced by the geometry: `.pipeline-drawer` is
  `position: absolute; inset: 0` over `.pipeline-card` (app.css:3628-3637), so
  the panel replaces the card in place.
- **Evidence:** Reproduced, and independently corroborated by the user's own
  to-do item. islands/PipelineRun.tsx:616-628 renders the trigger after every
  other child of `.card-body`; PipelineRun.tsx:640-651 puts the close button in
  `.pipeline-drawer-head`, which is `justify-content: space-between`
  (app.css:3639-3645) inside `padding: var(--svd-space-5)`. Corrected geometry
  by pixel scan of about-light-wide.png: `.pipeline-card` spans y=636→1288
  (652px, not 644); `h2.card-title` ink is x=166-294 at y≈658-672; the trigger's
  ink runs x=181→447 at y≈1232-1266 (the original x=156-330 understates it — the
  button box starts at x≈165 and the ink includes the chevron out to 447).
  Pointer travel from press to dismiss is the card's full diagonal. The keyboard
  path is already correct (PipelineRun.tsx:412-420 moves focus to the close
  button and back), which is why only the pointer path shows it. The finding's
  targeting analysis also holds: `.pipeline-head` (app.css:3266-3272) is a
  wrapping flex strip carrying seven meta items, and it wraps to two lines at
  1024 (verified in about-light-mid.png y=600-900, "Prompt v6" alone on line
  two) and to four lines at 390 (about-light-narrow.png y=900-1300), so a button
  dropped there lands mid-strip at some widths. The `h2.card-title` row's right
  side is free at all three widths.
- **Fix:** Put the trigger on the `.card-title` row — heading left, button right
  — not in `.pipeline-head`. It is the only row on the card whose right side is
  free at 1440, 1024 and 390, and it puts open and close at the same point. Two
  constraints: the trigger is conditional on `recorded`
  (PipelineRun.tsx:437-438), so the title row must not depend on it for its own
  alignment; and at 390 the title ink ends at x≈180 of 390, leaving ~185px, so
  the 300px label "View everything this run recorded" must shorten or wrap below
  the heading at that width.

### F27 — About page: `.pipeline-source-detail` orphans its count on a right-aligned second line below ~450px, while the sibling row type in the same stylesheet already has the fix

- **Severity / tier:** medium / mechanical
- **Rule:** In-stylesheet sibling: `.pipeline-api` (app.css:3553-3559) and
  `.pipeline-source` (app.css:3703-3709) are the same recipe —
  `display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem; font-size:var(--svd-text-sm)`
  — and both push their trailing detail with `margin-left:auto`
  (`.pipeline-api-detail` 3575-3579, `.pipeline-source-detail` 3718-3722). Only
  the API row gets the narrow-width reset `margin-left:0; width:100%` inside
  `@media (max-width:700px)` (app.css:3835-3838). The adjacent block already
  reasons about this exact band (app.css:3843 "Below ~413px the status badge
  stops fitting beside the label"). Correction: the islands/CLAUDE.md sentence
  the finding quoted ("That is what keeps one service row reading identically in
  both places", islands/CLAUDE.md:176-179) is about the `.pipeline-api` rows,
  which do get the fix — the same bullet says "Only the refresh rows themselves
  are new CSS" — so the basis is the stylesheet sibling, not that quote.
- **Evidence:** Re-measured on / (components/PipelineSyncs.tsx:45-50) at 390px:
  5 of the 8 `.pipeline-source` rows wrap — row height 20px → 47px, detail flush
  right (detailRight = 0, detailLeft 113-166px) sitting directly above the next
  source's name — while ClinVar/Orphadata/Open Targets/ClinicalTrials.gov/NCBI
  Gene wrap and "Open Targets drug records", UniProt and "PubMed citations" do
  not, so one list renders in two shapes. The original said "5 of 6"; it is 5
  of 8. Wrapping persists past the quoted ~410px — 2 rows still wrap at 414px —
  and is gone by 480px. At 390px every `.pipeline-api-detail` computes
  `margin-left:0px; width:100%`, confirming the sibling already has the rule.
  Visible in about-light-narrow.png.
- **Fix:** Add `.pipeline-source-detail { margin-left: 0; width: 100% }` to the
  same `@media (max-width: 700px)` block that already carries
  `.pipeline-api-detail` (app.css:3835-3838), so the two identically-built row
  types wrap the same way.

### F28 — The .pipeline-api <li> is copied verbatim into two files, contradicting the comment above the copy that says it is not a copy

- **Severity / tier:** medium / structural
- **Rule:** components/PipelineSyncs.tsx:84-87 in-file comment: "The same
  `.pipeline-apis > ul > .pipeline-api` shape the run widget's drawer uses, so
  the two lists are one component with one set of styles rather than a copy that
  drifts." islands/CLAUDE.md:176-180 makes the same promise: "**It reuses the
  widget's parts rather than restating them**… That is what keeps one service
  row reading identically in both places."
- **Evidence:** VERIFIED. The two `<li>` bodies are token-for-token identical
  apart from indentation — islands/PipelineRun.tsx:686-696 (class at :687) and
  components/PipelineSyncs.tsx:93-103 (class at :94), both `<li key={`
  ${api.service}-${api.method}-${api.endpoint}`} class="pipeline-api">` wrapping
  `.pipeline-api-name` with `<Icon name="arrowsRightLeft" />`,
  `.pipeline-method`, `<code class="pipeline-api-endpoint">` and
  `.pipeline-api-detail` with `{describeApi(api)}`. What is actually shared is
  the CSS and `describeApi`, not the markup. The wrappers also differ:
  `<section class="pipeline-apis pipeline-drawer-section">` with
  `<h3>External services</h3>` at PipelineRun.tsx:681-683 vs a bare
  `<div class="pipeline-apis">` at PipelineSyncs.tsx:89, so the syncs list
  renders with no heading.
- **Fix:** Extract the list into one exported `ApiList({ apis })` in components/
  and call it from both sites, leaving each caller its own wrapper and heading.
  The doc and the in-file comment already promise it is one component, so make
  the code match rather than relaxing the prose. Claim 8 is the drift this
  comment predicted, already arrived in the same two files.

### F29 — PipelineSyncs hand-writes the truncation sentence that PipelineRun gets from describeTruncation(), so one class renders two different sentences on one page

- **Severity / tier:** medium / judgment
- **Rule:** islands/CLAUDE.md:176-180 ("reuses the widget's parts rather than
  restating them… what keeps one service row reading identically in both
  places"), plus the sibling surface named on both sides:
  `<p class="pipeline-truncation">` in each file, one class, two sentences, both
  rendered on /about.
- **Evidence:** VERIFIED. lib/pipeline_display.ts:291-293 is the shared
  formatter, `return`Showing ${formatCount(shown)} of ${formatCount(total)}`;`,
  pinned by tests/pipeline_display_test.tsx:324 as "Showing 200 of 1,412".
  islands/PipelineRun.tsx:384-386 renders it inside
  `<p class="pipeline-truncation">`. components/PipelineSyncs.tsx:109-113
  restates it under the same class as
  `Showing {formatCount(run.errors.shown)} of{" "}{formatCount(run.errors.total)} errors.`
  — a trailing noun and a full stop the shared formatter never emits.
  `grep -rn describeTruncation` over lib/ islands/ components/ tests/ shows the
  import only at islands/PipelineRun.tsx:27 and lib/pipeline_display.ts:291;
  PipelineSyncs.tsx is the one consumer that does not import it. Both elements
  carry `.pipeline-truncation`, styled once at assets/app.css:3741.
- **Fix:** Move the sentence into lib/pipeline_display.ts — either give
  `describeTruncation` an optional noun and terminal period, or add a sibling
  `describeTruncatedErrors` — and call it from
  components/PipelineSyncs.tsx:110-112. tests/pipeline_display_test.tsx then
  keeps pinning every spelling. Decide the punctuation once: today one
  `.pipeline-truncation` ends with a period and the other does not, on the same
  page.

### F30 — The arrowDownTray glyph is unreachable; it is retained only by the test that validates the encoding file that names it

- **Severity / tier:** low / mechanical
- **Rule:** Sibling surface / dead code: every other entry in
  `lib/pipeline_encoding.json` `fields` is reached through `field()` via
  `<Stat>`, `<FieldIcon>` or `<FieldLabel>` in islands/PipelineRun.tsx.
  `payload` alone is not.
- **Evidence:** VERIFIED. components/Icon.tsx:83 defines `arrowDownTray`; its
  only other repo reference (node_modules excluded) is
  lib/pipeline_encoding.json:257, inside `fields.payload` at :255-258. Every
  `field()` consumer names a literal — islands/PipelineRun.tsx:105, :120, :259,
  :265, :273, :285, :291, :297, :336, :341, :346, :351, :358, :429, :430, :518,
  :545, :564, :580, :581 — and none names `payload`; there is no dynamic key
  path into `field()`. The bytes the label was presumably for reach the UI as
  prose instead, through lib/pipeline_display.ts:282
  `if (api.bytes > 0) parts.push(formatBytes(api.bytes))` inside `describeApi`,
  not through a `<Stat>`. Retention is circular:
  tests/pipeline_encoding_test.ts:54 asserts every encoding icon resolves in
  Icon.tsx and :232-240 asserts every field entry has a non-empty label and
  glyph; neither checks a field is ever rendered.
- **Fix:** Drop `fields.payload` from lib/pipeline_encoding.json:255-258 and the
  `arrowDownTray` path from components/Icon.tsx:83 — both tests keep passing,
  and nothing else in the repo names either. If a payload stat is planned, add
  the `<Stat name="payload">` that renders it instead of leaving the pair
  asserted-but-unseen.

---

## Timeline (13)

### F31 — Timeline drug labels collide illegibly — 144 overlapping pairs, and the label is the marker's only identity channel

- **Severity / tier:** high / structural
- **Rule:** Root CLAUDE.md, Timeline: "eleven pairwise-distinct hues cannot
  clear a colour-vision check, so identity rides the drug label beside every
  marker and the legend, and the colour says the family first" — the label is
  load-bearing identity, not decoration. Sibling surface: the phenogram's
  parallel figure asserts zero label-block overlaps exactly
  (e2e/tests/phenogram.spec.ts:96 →
  `{misfit: [], overlapping: [], blocks: 79}`), while the timeline only bounds
  them.
- **Evidence:** VERIFIED. e2e/tests/timeline.spec.ts:113-114 is
  `expect(overlaps).toBeGreaterThan(0); expect(overlaps).toBeLessThanOrEqual(170);`,
  and the test's own header comment (lines 41-56, quotes at 50 and 54) records
  "144 colliding pairs on macOS and 127 on CI's Linux chromium" and "Lower the
  ceiling when the UI work lands; it is what that work has to move" — the repo
  classes this as debt, not as an invariant. Line 92 pins `boxes: 120`, so all
  120 labels render. Reproduced visually in timeline-light-wide.png (plate
  cropped to /tmp/v_tl_full.png): in the Any-SVD and Stroke sectors
  "Amlodipine", "Amlodipine folic acid", "Telmisartan, amlodipi…", "Rosuva…",
  "Isosorbide mononitrate and c…eate" and four instances of "Cilostazol" print
  over one another; in Cognitive Impairment "Butylphthalide 1", "Galantamine",
  "BAC" and "Donepezil" are one block of ink. CORRECTION to the evidence: the
  "~90px of unused white margin" does not hold — measuring the ink bounding box
  against the plate on timeline-light-wide.png gives left 52px, right 47px, top
  51px, bottom 80px (~42-47 SVG units per side at the 1.11x display scale), and
  that margin is occupied by the outermost labels ("Stellate ganglion block",
  "Telmisartan, amlodipine and indapamide"), not dead white.
- **Fix:** Rewritten, because the original fix rested on a margin that is half
  the size claimed and already holds labels. Enlarging OUTER_RADIUS alone would
  push every marker — and its label — further out and clip them; the canvas must
  grow first. So: raise `CANVAS` (lib/timeline.ts:75) and `OUTER_RADIUS` (:77)
  together, keeping the ~45-unit label gutter, and raise
  `.timeline-figure { min-width: 960px }` (assets/app.css) to the new native
  width so the plate still scrolls sideways rather than squashing. Then extend
  `separateLabels()` (lib/timeline.ts:429), which today returns only vertical
  `dy` shifts, to also displace tangentially with a leader line back to its
  marker. Both changes must land in `lib/timeline.ts` and
  `scripts/timeline_figure.py` together and re-pin tests/timeline_layout_test.ts
  and tests/scripts/test_timeline_figure.py; keep `boxes: 120` intact (no hiding
  labels) and lower the 170 ceiling in e2e/tests/timeline.spec.ts:114 in the
  same commit. Note this interacts with the page-height finding: a wider plate
  raises the 1300px breakpoint where the key drops below the figure.

### F32 — The "Genetic evidence" key is unreadable in dark mode: its two samples are indistinguishable and the ring measures 1.04:1

- **Severity / tier:** high / mechanical
- **Rule:** WCAG 2.2 SC 1.4.11 Non-text Contrast — 3:1 for graphical objects
  required to understand the content; this key is the only thing that tells a
  reader what the evidence ring means. Also assets/app.css:2548, the rule's own
  comment: "Dots and rings are data colours; everything else is chrome" — the
  ring here is a plate-calibrated data colour painted on theme chrome. Sibling
  surface: `.phenogram-legend-glyph { color: var(--svd-ink) }`
  (app.css:2991-2996) with `fill="currentColor"`
  (islands/Phenogram.tsx:373-375), so the phenogram's legend glyphs follow the
  theme.
- **Evidence:** VERIFIED, with the contrast figure corrected. Pixels sampled
  from the scratchpad's timeline-dark-wide.png along y=404 through the ringed
  sample: card ground rgb(24,28,48); the evidence ring at x=1155-1156 and
  1173-1174 is rgb(20,24,44) → contrast 1.04:1 (the finding said 1.06:1; same
  conclusion). The ring colour is `"#14172b"` (lib/timeline_encoding.json,
  `geneticEvidence.Yes.ring`), fixed for the white plate.
  islands/TrialsTimeline.tsx:414 gives the legend's inner circle
  `stroke={PLATE}` (`#ffffff`, :52), so on the dark card a bright white collar
  at rgb(234,235,241)/rgb(167,168,176) is the dominant feature of BOTH samples.
  Side-by-side crops confirm it: in dark (/tmp/v_tl_evd.png) "Ringed marker" and
  "Plain marker" are visually identical; in light (/tmp/v_tl_evl.png) one is
  obviously ringed and the other plain. Nothing in tests/ or e2e/ asserts on
  `.timeline-legend-sample`, so the fix is unpinned
  (e2e/tests/timeline.spec.ts:33 touches only `.timeline-legend-dot`).
- **Fix:** The legend sample is chrome, not plate ink, so it must not reuse
  plate-relative colours. Preferred: give `.timeline-legend-sample`
  (app.css:2632-2637) its own fixed white ground —
  `background: var(--svd-figure-surface); border-radius: var(--svd-radius-xs)` —
  so the plate colours stay valid inside it, exactly as `.timeline-tooltip`
  does, and the sample keeps showing the ring's real appearance. Alternative:
  drop `stroke={PLATE}` from the legend circle at islands/TrialsTimeline.tsx:414
  (keep it at :964, where it cuts the figure's marker from the plate) and draw
  the ring with `stroke="currentColor"` — but note the dot fill is already
  `currentColor`, so ring and dot become one colour, separated only by the
  r=6→r=9 gap, and the sample stops depicting the ring as drawn. Do not change
  `PLATE` itself; the halos, marker rings and band separators are all cut from
  that white.

### F33 — Timeline "Genetic evidence" key: in dark the ring the key exists to teach is invisible and both swatches render as pale disc + white ring

- **Severity / tier:** high / judgment
- **Rule:** Spec
  docs/superpowers/specs/2026-08-27-ui-modernization-design.md:334 (§8 Dark
  mode): "Both themes get an independent design and contrast pass — light is not
  an inversion of dark." Plus root CLAUDE.md §Timeline: the genetic-evidence
  `ring` is a pinned member of `lib/timeline_encoding.json` guarded by
  `tests/timeline_encoding_test.ts`, and WCAG 1.4.11 (3:1 non-text) for a
  graphical object needed to read the figure.
- **Evidence:** VERIFIED. islands/TrialsTimeline.tsx:404-426 draws each swatch
  as `fill="currentColor"` (resolved by
  `.timeline-legend-sample { color: var(--svd-ink-muted) }`,
  assets/app.css:2632-2637 — a theme-following token overridden at app.css:332
  and 391) plus `stroke={PLATE}` (`const PLATE = "#ffffff"`,
  TrialsTimeline.tsx:52 — fixed) plus, for the "Yes" entry only,
  `stroke={entry.ring}` = `#14172b` from lib/timeline_encoding.json
  `geneticEvidence.Yes.ring` (confirmed present) — also fixed. CORRECTION to the
  original evidence: there is no `--svd-legend-panel` token; the panel ground is
  `.timeline-legend-panel` (app.css:862, 2562) drawing the shared card recipe
  over `--svd-tint-base`, which does follow the theme. Scanline re-run on the
  cited screenshots (scratchpad/shots/timeline-{light,dark}-wide.png, x
  1145-1190): LIGHT y=404 (ringed) panel f8f8fd → ring 848592/5a5c6c → gap
  f8f8fd/fdfdff/e6e7ec → disc 5b6180; LIGHT y=447 (plain) panel fefefe → 606684
  → disc 5b6180, no ring. DARK y=404 panel 181c30 → 15182e/14182c (the #14172b
  ring, indistinguishable from the panel) → a7a8b0/eaebf1 (the white PLATE
  stroke) → disc 8990b5; DARK y=447 panel 161a2c → 6a6c78/fefefe (white PLATE
  stroke) → disc 8990b5. Recomputed contrast of `#14172b` against the panel:
  16.93:1 light, 1.06:1 dark; of `#ffffff` against the panel: 1.05:1 light,
  16.90:1 dark. The two roles swap exactly, so in dark the ringed and plain
  entries both read as "pale disc + white ring" and the encoding the key teaches
  is gone.
- **Fix:** Give the swatch the fixed light ground the plate-cut colours were
  drawn for:
  `.timeline-legend-sample { background: var(--svd-figure-plate); border-radius: var(--svd-radius-xs) }`
  (app.css:2632). `--svd-figure-plate` is declared once at app.css:147 and never
  overridden by the dark blocks, exactly like `--svd-figure-ink` beside it, so
  both the `#ffffff` disc stroke and the `#14172b` ring recover their meaning in
  both themes. Leave `fill="currentColor"` alone — `--svd-ink-muted` resolves to
  a mid indigo in both themes and stays legible on white; do NOT switch it to
  `var(--svd-figure-ink)`, which is near-black and would collide with the
  near-black ring. Do not simply delete `stroke={PLATE}`: that removes the false
  ring but leaves the real one at 1.06:1. Safe against the e2e:
  timeline.spec.ts:27-33 asserts `.timeline-legend-family` count 14,
  `.timeline-legend-item` count 53 and `.timeline-legend-dot` colours — none of
  which this touches.

### F34 — The mechanism key rail runs 2,696px beside a 966px figure — 1,749px of empty ground at 1440

- **Severity / tier:** medium / structural
- **Rule:** assets/app.css:2496-2498 states the arrangement's own purpose — the
  key "used to run full-width above the plate, where six families of long
  mechanism names pushed the radar itself below the fold" — and app.css:2545
  names the model, "The key is the phenogram's rail at the same 18rem measure."
  Note the model is asserted for the _measure_, not the proportions; the
  load-bearing part of this finding is the measured imbalance, not a rule that
  the two rails must be the same height.
- **Evidence:** VERIFIED, measurements corrected. Column scans against the dark
  ground rgb(11,13,23) on the scratchpad screenshots. timeline-dark-wide.png
  (1440x3113): figure card y 322→1288 (966px, measured at x=400); legend rail y
  341→3037 (2,696px, measured at x=1200/1300/1380) — a 1,749px overhang with
  nothing beside it, and the radar occupies the top ~31% of the page.
  phenogram-dark-wide.png (1440x1200) at the same width: figure card y 303→1124
  (821px); rail y 319→1019 (700px) — the rail is shorter than its figure. The
  downscaled page (/tmp/v_tl_page.png) shows the imbalance plainly: one 18rem
  column of ~60 stacked mechanism rows running two thirds of the document with
  empty ground to its left. The same key at 1024 (timeline-light-mid.png,
  1024x2536), where the `@container (min-width: 34rem)` rule at
  app.css:2583-2592 lets the panels lie down, is roughly 1,180px tall — ~2.3x
  more compact with identical content (the finding said ~800px / 3.3x;
  corrected).
- **Fix:** Fix partly rewritten — the second half of the original would break a
  documented rule. Keep the first half: `.timeline-drawer`
  (assets/app.css:2761-2774, NOT 2712-2726 as cited — 2712 is
  `.timeline-tooltip-swatch`) already solves this in the same column with
  `position: sticky; top: 6.5rem; max-height: calc(100vh - 8rem); overflow-y: auto`;
  give the mechanism panel the same treatment so the key scrolls within the
  viewport instead of running 1,749px past the figure, and scope it to the rail
  case (above the 1300px breakpoint at app.css:2648-2659) so the stacked layout
  below 1300px is untouched. DROP the `column-count: 2` alternative: at an 18rem
  rail that gives ~9rem columns, and root CLAUDE.md plus app.css:2547 record
  that "every mechanism name wraps at 18rem" — halving it would wreck the long
  names the rail exists to hold. If a scrolling key is unwanted, the other safe
  lever is widening the rail's flex-basis (app.css:2554) past 34rem so the
  existing container query lays the panels down in the rail too.

### F35 — The two figure keys are declared parallel but diverge in body size, family-heading treatment, and whether the family hue is shown at all

- **Severity / tier:** medium / judgment
- **Rule:** Sibling surface, named on the timeline's own side:
  `.timeline-legend` carries the comment "The key is the phenogram's rail at the
  same 18rem measure" (assets/app.css:2545). Both are the same component role —
  a figure key in an 18rem rail on the same page shell — and each already uses
  the size token the other picked. No comment in app.css or CLAUDE.md gives a
  reason for the divergent heading treatment.
- **Evidence:** VERIFIED. measurements.json: `timeline-light` legend items
  render at `13px|400|18.2px` (n=53, sample
  `ul.timeline-legend-list.timeline-legend-evidence > li.timeline-legend-item`;
  `--svd-text-sm` = 0.8125rem, app.css:222, set at :2612), `phenogram-light`
  legend items at `14px|400|21px` (n=7, sample
  `ul.phenogram-legend-list > li.phenogram-legend-item`; `--svd-text-base` =
  0.875rem, app.css:223, set at :2984). Family headings:
  `.timeline-legend-family-title` (app.css:2595-2602) is
  `--svd-text-sm`/semibold/uppercase/0.04em in `--svd-ink-muted` with no swatch
  — measured `13px|600|15.6px|0.52px`, n=14; `.phenogram-legend-family-name`
  (app.css:3004-3009) is base-size semibold sentence-case in full ink preceded
  by `.phenogram-legend-swatch` (3011-3016) carrying the family hue. Confirmed
  in crops: /tmp/v_keys.png shows "CHOLINERGIC" as a muted uppercase eyebrow;
  /tmp/v_phkey2.png shows "● Perivascular spaces", "● Diffusion MRI" as
  hued-swatch sentence-case names. The timeline's encoding is also one hue per
  family (root CLAUDE.md: "one hue per family with lightness steps inside it…
  the colour says the family first"), yet only the individual mechanism dots
  carry it.
- **Fix:** Fix rewritten to the cheap direction, because the original's
  preferred half is more invasive than stated: `lib/timeline_encoding.json`'s
  `families` entries carry only `key`, `label` and `mechanisms` — no colour — so
  putting a family-hue swatch on `.timeline-legend-family-title` means adding a
  `color` field to the encoding, updating `FamilyEncoding` in lib/timeline.ts,
  mirroring it in scripts/timeline_figure.py, and re-pinning
  tests/timeline_encoding_test.ts. Prefer instead: unify the two lists on one
  size token (set `.phenogram-legend-list` at app.css:2984 to `--svd-text-sm`,
  which also shortens the timeline rail rather than lengthening it — note that
  raising the timeline to `--svd-text-base` would worsen the 2,696px rail
  measured separately), and pick one family-heading treatment for both rails —
  applying the timeline's uppercase-eyebrow treatment to
  `.phenogram-legend-family-name` costs nothing and leaves the phenogram's
  swatch in place, since the phenogram's family hue already exists in
  lib/phenogram_encoding.json. Whichever direction, it must be one treatment,
  not two.

### F36 — /timeline: widening the window from 1300px to 1301px shrinks the radar and adds a horizontal scroll it did not have — a 41px band between two designs

- **Severity / tier:** medium / structural
- **Rule:** assets/app.css:2639-2641 comment: "1300px is where the 960px plate
  and the rail stop fitting side by side." The number is the content-box sum
  (960 figure + 32 `.timeline-scroll` padding + 20 `--svd-space-5` + 288 rail
  = 1300) and omits the 40px `.page-main` gutters, so the real crossover is
  1342px.
- **Evidence:** Re-measured `.timeline-scroll` clientWidth / overflow: 1299 →
  1257 / 0; 1300 → 1258 / 0; 1301 → 951 / 41; 1310 → 960 / 32; 1341 → 991 / 1;
  1342 → 992 / 0; 1440 → 1090 / 0. `.timeline-figure` renders 1226px wide at
  1300 and 960px (its `min-width`) at 1301. Every number in the original finding
  matched. /tmp/tl_1301b.png and /tmp/tl_1300.png confirm it visually: at 1301
  the radar's right rim band and the right-hand population labels are cut at the
  container edge; at 1300 the plate is complete.
- **Fix:** Change the query to `max-width: 1341px` and extend the comment with
  the term it dropped — 960 + 2×`--svd-space-4` + `--svd-space-5` + 18rem +
  2×1.25rem page gutters = 1342 — so the number and its derivation cannot drift
  apart again.

### F37 — Two structurally identical drawers, only one announced: TrialsTimeline's has aria-live="polite", PipelineRun's does not

- **Severity / tier:** medium / judgment
- **Rule:** Sibling-surface consistency between islands/TrialsTimeline.tsx
  `TrialDrawer` and islands/PipelineRun.tsx's run drawer. NOTE — the finding's
  citation of islands/CLAUDE.md:177-180 does not support it: those lines are
  about components/PipelineSyncs.tsx reusing the widget's parts, not about the
  two drawers. islands/CLAUDE.md:124-131 ("**The drawer exists only when there
  is something in it**") likewise says nothing about announcement. The argument
  rests on the sibling comparison alone, which does hold.
- **Evidence:** VERIFIED. islands/TrialsTimeline.tsx:467-474 and
  islands/PipelineRun.tsx:632-639 are the same `<aside>` with the same
  `id={DRAWER_ID}`, `role="region"`, `aria-label`, `hidden` and `inert`,
  differing by exactly one line: `aria-live="polite"` at TrialsTimeline.tsx:472.
  `grep -rn "aria-live"` across components/ islands/ routes/ lib/ returns that
  single hit. Both drawers move focus into themselves on open —
  islands/TrialsTimeline.tsx:711
  `closeRef.current?.focus({ preventScroll: true })` and
  islands/PipelineRun.tsx:416 `closeRef.current?.focus()` — so the live region
  duplicates what the focus move already announces.
- **Fix:** Pick one and apply it to both; the argument runs toward removal.
  Delete islands/TrialsTimeline.tsx:472 — focus already lands inside the drawer,
  and a polite live region on the timeline re-reads the whole eleven-field
  record every time the user moves between markers. If the announcement is
  wanted instead, add the identical line at islands/PipelineRun.tsx:636. No test
  asserts aria-live, so either direction is safe.

### F38 — --svd-nav's value is hardcoded again in routes/_app.tsx and twice more in lib/timeline_encoding.json, with tests pinning the copies to each other rather than to the token

- **Severity / tier:** medium / structural
- **Rule:** An existing --svd-* token already says the thing: assets/app.css:82
  `--svd-nav: var(--svd-indigo-925)` (light) and :328/:387
  `--svd-nav: var(--svd-indigo-950)` (dark). routes/_app.tsx:72 states the
  invariant in a comment — "The navbar is dark in both themes, so this matches
  it" — immediately above the literal that has to match it.
- **Evidence:** VERIFIED, including the colour maths. routes/_app.tsx:12-15
  `const THEME_COLORS = { light: "#14172b", dark: "#0f1220" } as const;`,
  consumed at :77 and :84. Converting the tokens myself:
  `oklch(0.2127 0.0397 276.0)` (--svd-indigo-925, assets/app.css:43) → rgb(20,
  23, 43) = #14172b; `oklch(0.1867 0.0290 274.0)` (--svd-indigo-950, :44) →
  rgb(15, 18, 32) = #0f1220. Exact, both. Two further copies of the light value:
  lib/timeline_encoding.json:75 `"color": "#14172b"` (the boundary hairline) and
  :85 `"ring": "#14172b"` (the genetic-evidence ring) — the same value as
  `--svd-figure-ink: var(--svd-indigo-925)` at assets/app.css:130. Nothing links
  any copy to the token: e2e/tests/theme.spec.ts:46 asserts
  `toEqual(["#0f1220", "#0f1220"])` against a literal, and
  tests/timeline_layout_test.ts:216 pins `["Yes", "#14172b"]` the same way.
  Change --svd-indigo-925 and the navbar moves while the meta tag, the timeline
  boundary and both tests stay green and stale.
- **Fix:** The meta tag genuinely cannot read a custom property, so the hex must
  exist — but the equality has to be tested rather than asserted in a comment.
  Add a check that resolves `--svd-nav` in each theme from computed styles and
  compares it to THEME_COLORS, replacing the literal at
  e2e/tests/theme.spec.ts:46. For the timeline, an encoding file holding its own
  hex is sanctioned by the root CLAUDE.md ("data colours are SVG attributes…
  from the two encoding files, never CSS") — but `boundary.color` and
  `geneticEvidence.Yes.ring` are chrome cut from the plate, not data colours, so
  at minimum record in lib/timeline_encoding.json that #14172b is
  --svd-figure-ink and must move with it.

### F39 — The timeline's white plate has square corners; the phenogram's plate is rounded to --svd-radius-sm inside the identical card

- **Severity / tier:** low / mechanical
- **Rule:** Sibling surface: `.phenogram-canvas` (assets/app.css:2882-2888)
  paints
  `background: var(--svd-figure-plate); border-radius: var(--svd-radius-sm)`,
  while the timeline's plate is a bare SVG `<rect>` with no `rx`. Both sit
  inside the same scroll card (`.timeline-scroll, .phenogram-scroll` share the
  card recipe at app.css:855-882, `border-radius: var(--svd-radius-md)`,
  `padding: var(--svd-space-4)`), and root CLAUDE.md describes the timeline
  plate as "a light sheet in dark mode too, as the phenogram is." The radius
  scale (app.css:256-259) has no 0 step.
- **Evidence:** VERIFIED, with one correction to the description.
  islands/TrialsTimeline.tsx:829-836 renders
  `<rect class="plate" x={0} y={0} width={CANVAS.width} height={CANVAS.height} fill={PLATE} />`
  with no `rx`; nothing else in tests/, e2e/ or scripts/ references that rect,
  so the change is unpinned. Corner crops of both figures at 1440 dark
  (/tmp/v_corners.png) show it directly: the timeline plate's top-left is a hard
  90° step, the phenogram's is a clean 8px arc. CORRECTION: the plate does not
  "meet the card's rounded dark mat" — row scans at y=500/600 show an identical
  structure on both pages (card border at x=20, 16px of card padding, plate
  white beginning at x=37), so the plate is inset from the card corner on both;
  the defect is the plate's own corner, not a collision with the card.
- **Fix:** Downgraded from medium — it is a one-property cosmetic inconsistency
  on an inset rectangle, not a legibility or comprehension failure. Cheapest:
  add `rx={9}` to the plate rect at islands/TrialsTimeline.tsx:829 (SVG user
  units scale ~1.11x at 1440, so 9 units ≈ the 8px the phenogram gets; the
  corners are empty white, no data reaches them). Cleaner and exact: move the
  plate off the SVG — give the SVG's wrapper
  `background: var(--svd-figure-plate); border-radius: var(--svd-radius-sm)` as
  `.phenogram-canvas` does, which also lets the timeline read the token whose
  comment (app.css:144-147, not 130-134 as cited) currently records "The
  timeline paints its own plate inline instead of reading this token." Either
  way the JS `PLATE` constant (TrialsTimeline.tsx:52) must stay — the halos,
  marker rings and band separators are cut from it — and
  `scripts/timeline_figure.py` needs no change, since the print figure has no
  card around it.

### F40 — Hovering a data mark gives two different tooltip languages on the two figures, both floating over the same fixed white plate

- **Severity / tier:** low / judgment
- **Rule:** Corrected framing. The token comment at assets/app.css:134-139 (not
  126-131) defines `--svd-figure-surface` as "A fixed light panel floating over
  the figure: the timeline tooltip…" — the phenogram's gene tooltip also floats
  over a figure and does not read it. This is a consistency observation, not a
  hard invariant: the phenogram deliberately reuses `components/Tooltip.tsx` so
  that "hover, Enter, Tab-to-link and Escape are the tables' behaviour with no
  new tooltip code" (root CLAUDE.md), and the timeline's bespoke panel exists
  because SVG groups cannot be `<button popovertarget>`. So the divergence in
  _component_ is documented and justified; only the divergence in _visual
  treatment_ — ground, ink, separators, max-width, viewport gutter — is
  unexplained anywhere.
- **Evidence:** VERIFIED, line numbers corrected. `.timeline-tooltip`
  (app.css:2671-2690, not 2666-2681) paints
  `background: var(--svd-figure-surface); color: var(--svd-figure-ink)` with
  `max-width: min(360px, calc(100vw - 20px))`, icon-labelled rows and no
  separators. The phenogram's gene tooltips (islands/Phenogram.tsx:341,
  `<Tooltip content={phenogramTooltip(block.gene)}>` inside `.phenogram-canvas`)
  open `.tooltip-pop` (app.css:2110-2133) on
  `background: var(--svd-tooltip-bg)`, which the dark blocks override to
  `var(--svd-indigo-800)` at app.css:352 and :411 (not 351/408), with ruled row
  separators and `max-width: min(400px, calc(100vw - 16px))`. So in dark mode,
  hovering a marker on the white radar returns a white card and hovering a gene
  on the white karyogram returns a near-black one, at different widths and
  different viewport gutters (20px vs 16px).
- **Fix:** Keep `.tooltip-pop`'s markup, focus behaviour and arrow — the
  phenogram's reuse of `components/Tooltip.tsx` is the documented source of its
  Enter/Tab/Escape handling and must not be replaced. This is a CSS-only change:
  scope a `.phenogram-canvas .tooltip-pop` variant onto `--svd-figure-surface` /
  `--svd-figure-ink` / `--svd-figure-line` to match `.timeline-tooltip`, and
  align the two `max-width` values and viewport gutters at the same time (pick
  one of 360/20 or 400/16 and use it in both). Do not touch `.tooltip-pop`
  globally — `e2e/helpers.ts` reaches it and the tables depend on the filled
  indigo panel. Lowest-risk subset if only one change is wanted: align the
  max-width and gutter, which is unambiguously arbitrary today.

### F41 — FilterPanel.tsx:50 is the only aria-expanded raw boolean, and the rule's stated failure mode is false for Preact 10.29.8

- **Severity / tier:** low / mechanical
- **Rule:** islands/CLAUDE.md:98-100 — "**`aria-expanded` is passed as a
  string.** Preact omits an `aria-*` attribute whose value is boolean `false`,
  so `aria-expanded={expanded}` renders nothing at all on a collapsed step and
  the control advertises no expandable state." Verified verbatim at those lines.
- **Evidence:** VERIFIED. components/FilterPanel.tsx:50
  `aria-expanded={!collapsed}` is the only raw boolean; the other four sites
  pass strings (islands/PipelineRun.tsx:168, :621;
  islands/TrialsTimeline.tsx:943; islands/TrialsMap.tsx:94, :107 via
  setAttribute). The rule's premise is refuted for the installed version:
  node_modules/.deno/preact@10.29.8/node_modules/preact/src/diff/props.js:137-149
  carries the comment "aria- and data- attributes have no boolean
  representation… other frameworks generally stringify `false`" and guards
  `value != NULL && (value !== false || name[4] == '-')` — `aria-expanded`[4] is
  '-', so setAttribute runs; preact-render-to-string@6.7.0/src/index.js:665-670
  does `v = v + EMPTY_STR` when `name[4] === '-'`.
  e2e/tests/filter-collapse.spec.ts:36 asserts
  `toHaveAttribute("aria-expanded", "false")` on this exact toggle and is a
  committed spec, which is direct proof it renders.
- **Fix:** (a) components/FilterPanel.tsx:50 →
  `aria-expanded={collapsed ? "false" : "true"}`, matching its four siblings.
  This is behaviour-neutral, so e2e/tests/filter-collapse.spec.ts stays green.
  (b) Correct islands/CLAUDE.md:98-100: keep the one-spelling convention but
  restate its justification as house style, not as a rendering hazard — as
  written it will send the next reader hunting a bug that Preact 10.29.8 does
  not have.

### F42 — The timeline tooltip sets role="tooltip" on an element it also removes from the accessibility tree with aria-hidden="true"

- **Severity / tier:** low / mechanical
- **Rule:** Root CLAUDE.md, Timeline section: "The tooltip is pointer-only and
  `aria-hidden`, as the old one was." Sibling surface: components/Tooltip.tsx's
  `.tooltip-pop` (the tables' tooltip) carries no `role` at all.
- **Evidence:** VERIFIED, line numbers corrected.
  islands/TrialsTimeline.tsx:531-533 reads `class="timeline-tooltip"` /
  `role="tooltip"` / `aria-hidden="true"` (role is on 532, aria-hidden on 533).
  `aria-hidden="true"` prunes the node and subtree, so the role can never be
  exposed. Sibling confirmed: `grep -n "role=" components/Tooltip.tsx` returns
  nothing, and components/Tooltip.tsx:194 is
  `<span ref={panel} id={popoverId} popover="auto" class="tooltip-pop">`. No
  test depends on the role — e2e/tests/timeline.spec.ts locates the panel by
  `.timeline-tooltip` at :248, :281, :285, :295, :310.
- **Fix:** Delete `role="tooltip"` at islands/TrialsTimeline.tsx:532.
  `aria-hidden` is the deliberate contract (the drawer is the accessible path);
  the role is inert and only misinforms the next reader. No test or CSS selector
  touches it.

### F43 — .plate and .timeline-legend-evidence have no CSS rule and no test reference, unlike the rule-less classes that are protected e2e selectors

- **Severity / tier:** low / mechanical
- **Rule:** Sibling surface:
  docs/superpowers/specs/2026-08-27-ui-modernization-design.md lists the
  app-owned class names that are load-bearing for e2e (the eight in
  e2e/helpers.ts, `group-even`/`group-odd`, `.visually-hidden`). Rule-less
  classes are justified when a spec locates them; these two are located by
  nothing.
- **Evidence:** VERIFIED. `.plate`: islands/TrialsTimeline.tsx:831
  `class="plate"` on the white background `<rect>`, filled inline with
  `fill={PLATE}`. A repo-wide grep for `.plate` / `"plate"` across *.ts, *.tsx,
  *.css, *.py, *.json (node_modules excluded) returns that one hit and nothing
  else — no rule in assets/app.css, no e2e locator. The only "plate" in e2e is
  e2e/tests/phenogram.spec.ts:166, a local variable bound to
  `.phenogram-canvas`. `.timeline-legend-evidence`:
  islands/TrialsTimeline.tsx:401
  `<ul class="timeline-legend-list timeline-legend-evidence">`, the sole hit
  repo-wide; `grep -n "timeline-legend" assets/app.css` returns rules only for
  the bare class and `-panel` (862, 2562), `-title` (2568), `-families` (2573),
  `-family-title` (2595), `-list` (2604), `-item` (2616), `-dot` (2623),
  `-sample` (2632).
- **Fix:** `.timeline-legend-evidence` is the actionable half: it is a second
  class on an element that already carries `.timeline-legend-list`, so it reads
  as a styling hook that was lost — drop it at islands/TrialsTimeline.tsx:401,
  or add the rule that earns it. `.plate` is defensible as self-documenting
  markup (a comment above the rect explains the white sheet), so leaving it is
  fine; if it stays, the comment is what keeps the next reader from grepping
  app.css for a rule that never existed. Neither appears in any spec or
  stylesheet, so both edits are safe.

---

## Map (12)

### F44 — Leaflet's own container ground (#ddd) is never themed — at 390px it is 59% of the map box, a light-grey slab on a dark page

- **Severity / tier:** high / structural
- **Rule:** Design spec §1
  (docs/superpowers/specs/2026-08-27-ui-modernization-design.md:57-59) states
  the outcome as "one coherent, modern, credible visual system across every
  surface — including the two sandboxed iframes and the Leaflet map"; §8
  (:356-359) scopes the dark-mode filter to `.leaflet-tile-pane` only, so the
  container's own background was never covered. `--svd-surface`
  (assets/app.css:78, redeclared dark at :327 and :386) is the token that says
  this. Sibling holds: `.leaflet-popup-content-wrapper` at
  assets/app.css:2408-2412 IS repainted with `--svd-surface`; the container it
  floats over is not.
- **Evidence:** REPRODUCED EXACTLY. leaflet.css:260-262
  `.leaflet-container { background: #ddd }`
  (node_modules/.deno/leaflet@1.9.4/node_modules/leaflet/dist/leaflet.css).
  map-dark-narrow.png: pixel (200,800) and (200,1250) both (221,221,221); crop
  (14,690)-(376,1410) = 260,640 px, of which #DDDDDD = 153,331 = 58.8%;
  byte-identical count in map-light-narrow.png. Tiles did load (dark: 52,254 px
  of inverted ocean (32,61,70); light: 52,254 px of (170,211,223)), so the grey
  is the void beyond the world, not a load failure. assets/app.css:2231
  `.map-container { min-height: 700px }` and :2238
  `.trials-map { min-height: 700px !important }` confirmed — the bands are
  structural. app.css:2241-2244 `.map-container .leaflet-container` sets only
  `border-radius` and `font-family`.
- **Fix:** Add one declaration to the rule that already exists:
  `background: var(--svd-surface);` inside `.map-container .leaflet-container`
  at assets/app.css:2241-2244. Specificity is safe — (0,2,0) beats
  leaflet.css:260's (0,1,0), and client.ts:7-10 loads app.css after leaflet.css.
  Nothing in e2e/tests/map.spec.ts asserts the container background.

### F45 — Leaflet's control chrome — zoom bar, scale bar, attribution — renders as hardcoded white plates with black ink in dark mode

- **Severity / tier:** high / structural
- **Rule:** assets/CLAUDE.md:12-13 — tier 2 is "what rules actually ask for
  (`--svd-surface`, `--svd-ink`)" and "the only tier the dark blocks override";
  none of these three controls reads one. Design spec §1 (:17) names "Leaflet +
  markercluster | Helvetica Neue | 4 / 5 / 12 / 15 / 20 | 0.3s | 0.65" as the
  fourth competing system by its chrome. Sibling holds: the popup chrome in the
  same CSS section (app.css:2408-2421) is repainted with `--svd-surface`,
  `--svd-text`, `--svd-radius-md`, `--svd-shadow-lg`.
- **Evidence:** REPRODUCED, with two line-number corrections. map-dark-wide.png:
  zoom button (47,405) = #FFFFFF, glyph (47,412) = #000000; attribution plate
  (1200,1075) = (210,216,218) = #D2D8DA — exactly 0.8·255 + 0.2·(32,61,70), i.e.
  Leaflet's 80% white over the inverted tile; scale plate (100,1069) = #D2D8DA
  with a #777777 rule at (25,1069). Sources: leaflet.css:284-298
  (`.leaflet-bar { box-shadow: 0 1px 5px rgba(0,0,0,0.65); border-radius: 4px }`,
  `.leaflet-bar a { background-color:#fff; border-bottom:1px solid #ccc; color:black }`)
  — correct as cited. Attribution is at leaflet.css:413-421, NOT :381-395
  (`.leaflet-container .leaflet-control-attribution { background: rgba(255,255,255,0.8) }`
  at :413-416; `color: #333` at :418-421). Scale is at leaflet.css:443-452, NOT
  :445-460 (`background: rgba(255,255,255,0.8)`, `text-shadow: 1px 1px #fff`,
  `border: 2px solid #777`). `grep -ni leaflet assets/app.css` returns 272, 273,
  2241, 2407, 2408, 2409, 2414, 2419, 2423 — no rule for the bar, the
  attribution or the scale, as claimed.
- **Fix:** Extend the "Leaflet popup overrides" block at assets/app.css:2407 —
  but the selectors must match Leaflet's specificity, which client.ts:3-6
  already documents as the trap ("app.css recolours Leaflet and markercluster at
  the same specificity as their own rules, so it only wins if it comes after
  them"). Use `.leaflet-container .leaflet-control-attribution` (0,2,0) — a bare
  `.leaflet-control-attribution` (0,1,0) LOSES to leaflet.css:413 and the plate
  would stay white. `.leaflet-bar a` and `.leaflet-control-scale-line` match
  Leaflet's own selectors and win on order. Add
  `.leaflet-bar a.leaflet-disabled` separately: leaflet.css:318-322 is (0,1,2)
  and keeps `#f4f4f4` / `#bbb` — and e2e/tests/map.spec.ts:76-110 drives the
  zoom-out button to its disabled state, so that state must stay legible. Take
  `background: var(--svd-surface)` / `color: var(--svd-text)` /
  `border-color: var(--svd-border)`, swap `.leaflet-bar`'s 4px+0.65-alpha pair
  for `--svd-radius-xs` and `--svd-shadow-sm`, and drop the scale line's
  `text-shadow` (a white halo for black-on-white).

### F46 — The popup close button keeps Leaflet's white-panel greys after the app repainted the panel dark — 3.82:1 at rest, 2.48:1 on hover

- **Severity / tier:** high / mechanical
- **Rule:** WCAG 2.1 SC 1.4.3 (4.5:1 for the "×" as text) and SC 1.4.11 (3:1 for
  a UI component); the hover state is less visible than rest, which no other
  control in this app does. The app itself created the mismatch:
  assets/app.css:2408-2412 repaints `.leaflet-popup-content-wrapper` with
  `--svd-surface` but leaves the ink Leaflet calibrated for #fff (where #757575
  measures 4.61:1 and passes).
- **Evidence:** REPRODUCED, with one evidence correction. leaflet.css:527-542
  (not :527-543):
  `.leaflet-container a.leaflet-popup-close-button { font: 16px/24px Tahoma, Verdana, sans-serif; color: #757575 }`,
  and `:hover, :focus { color: #585858 }` at :540-542.
  `grep -n close-button assets/app.css` returns nothing, so no app rule
  competes. `--svd-indigo-900` = oklch(0.2140 0.0342 273.1) resolves to #141829;
  computed ratios there: #757575 = 3.82:1, #585858 = 2.48:1 — both exactly as
  claimed. CORRECTION: the finding's claim that 16px is off the type scale is
  wrong — `--svd-text-md: 1rem` exists at app.css:224 (the scale is 2xs 11 / sm
  13 / base 14 / md 16 / xl 22 / 2xl 28 / 3xl 32). What is genuinely off-system
  is the hardcoded `Tahoma, Verdana` family (a fourth typeface on the page,
  against `--svd-font` at :310) and the `24px` line-height baked into the
  `font:` shorthand; the size itself is on-scale.
- **Fix:** In the Leaflet override block at assets/app.css:2407 add
  `.leaflet-container a.leaflet-popup-close-button { font: var(--svd-weight-regular) var(--svd-text-md)/1.5 var(--svd-font); color: var(--svd-ink-muted); }`
  and
  `.leaflet-container a.leaflet-popup-close-button:hover, …:focus { color: var(--svd-ink); }`
  so hover moves toward the ink rather than away. Use the tier-2 names
  (`--svd-ink`, `--svd-ink-muted`), not the tier-3 `--svd-text*` aliases at
  :291-292. Specificity matches Leaflet's (0,2,1) and app.css loads last, so it
  wins. Safe for e2e/tests/map.spec.ts:134, which clicks
  `a.leaflet-popup-close-button` — the 24×24 hit box comes from separate
  `width`/`height` declarations that this leaves untouched.

### F47 — Seven corner radii render in one viewport on /map — the spec's original complaint, now worse

- **Severity / tier:** medium / structural
- **Rule:** Design spec §1: 'On /map, five radii in one viewport.' The pass
  exists to collapse that. Radius scale is 4/8/12/16.
- **Evidence:** Measured on the rendered page at 1440x900: 2px
  (a.leaflet-control-zoom-in), 4px (.leaflet-bar), 8px (app chrome), 15px
  (marker-cluster inner div), 16px (.map-container/.trials-map), 20px
  (.marker-cluster), 999px (.date-badge). 2, 15 and 20 come from Leaflet's own
  stylesheet. app.css itself contains no off-token radius, so the whole excess
  is unoverridden third-party CSS.
- **Fix:** Extend the existing Leaflet override block (app.css:2407) to repoint
  .marker-cluster, its inner div and the zoom control onto the radius scale.

### F48 — Three typefaces render, not two: Leaflet's zoom control and marker clusters escape the .leaflet-container override

- **Severity / tier:** medium / mechanical
- **Rule:** Design spec §5: 'Unify the four competing font stacks... including
  an explicit override for .leaflet-container.'
- **Evidence:** Rendered type census on /map: Lucida Console at 22px/700 on
  a.leaflet-control-zoom-in and -out, and Helvetica Neue at 12px with
  line-height 30px on .marker-cluster > span. The override does exist and works
  for the attribution, which renders IBM Plex Sans — these two surfaces set
  their own family and win.
- **Fix:** Add both selectors to the Leaflet override with font-family:
  var(--svd-font-sans).

### F49 — Attribution link measures 3.43:1 in dark mode — below AA at 12px, and it moves with whatever tile is underneath

- **Severity / tier:** medium / mechanical
- **Rule:** WCAG 2.1 SC 1.4.3: 4.5:1 for text below 18.66px bold / 24px; the
  link renders at 12px/400 (leaflet.css:274-279 sets
  `.leaflet-container { font-size: 12px }`). `--svd-link` (assets/app.css:307 →
  `--svd-color-accent-text`, ember-700 light at :92, ember-400 dark at
  :338/:397) is theme-aware and already says the thing; Leaflet's hex is not.
- **Evidence:** REPRODUCED EXACTLY. Pixel census of map-dark-wide.png over crop
  (1180,1066)-(1424,1084): plate (210,216,218) = 2,690 px; link ink (0,120,168)
  = 68 px — byte-identical count in map-light-wide.png over the same crop, where
  the plate is (238,246,249). That byte-identity confirms the source is
  leaflet.css:264-266 `.leaflet-container a { color:#0078A8 }` at (0,1,1),
  beating app.css:508-509 `a { color: var(--svd-link) }` at (0,0,1);
  leaflet.css:424-429 `.leaflet-control-attribution a` sets only
  `text-decoration`, so it does not intervene. Computed: #0078A8 on #D2D8DA =
  3.43:1; on #EEF6F9 = 4.51:1 (passing by 0.01). The plate is
  `rgba(255,255,255,0.8)` (leaflet.css:413-416), so the ratio tracks the tiles.
  measurements.json confirms the gap: `contrast` is `[]` for all 14 page/theme
  entries, so nothing was recorded for this pair.
- **Fix:** Add `.leaflet-control-attribution a { color: var(--svd-link); }`
  alongside the control-chrome fix. Specificity (0,1,1) ties leaflet.css:264 and
  app.css loads last (client.ts:7-10), so it applies. Once that fix makes the
  plate an opaque `--svd-surface`, the ratio also stops depending on the map
  contents.

### F50 — .map-container is the one page-level plate outside the depth recipe, and it paints no background at all

- **Severity / tier:** medium / structural
- **Rule:** assets/CLAUDE.md:24-26: "Elevation is one recipe, not a pile of
  per-component shadows. A surface joins by being listed in the shared rule at
  the head of `=== CARDS & VALUE BOXES ===`." Siblings verified in that rule at
  assets/app.css:854-870: `.table-scroll` (:857), `.readout-stat` (:858),
  `.timeline-scroll` (:860), `.phenogram-scroll` (:861), and `.map-error` (:870)
  — a child of `.map-container`. All take `--svd-radius-md`, a 1px tinted
  border, `--svd-sheen` and `--svd-halo` (:871-881).
- **Evidence:** REPRODUCED EXACTLY. assets/app.css:2229-2235:
  `.map-container { width: 100%; min-height: 700px; border-radius: var(--svd-radius-lg); overflow: hidden; box-shadow: var(--svd-shadow-md); }`
  — a raw per-component shadow at :2234, `--svd-radius-lg` (16px, :259) at :2232
  where every recipe member takes `--svd-radius-md` (12px, :258), no border, no
  background. Measured: the `.map-stats` strip at (700,335) and (700,345) =
  (242,243,249) light and (11,13,23) dark; (11,13,23) is exactly
  `--svd-indigo-975` = oklch(0.1623 0.0214 275.1), i.e. `--svd-ground` itself —
  the strip is literally page ground with a drop shadow around it. Radius census
  in measurements.json for map-light: 16px n=2 against 8px n=11, as claimed.
- **Fix:** Add `.map-container` to the shared surface rule at
  assets/app.css:854-870 and delete its `border-radius` (:2232) and `box-shadow`
  (:2234) — the recipe supplies both. No extra `--svd-tint-base` declaration is
  needed: the default at :179 is `var(--svd-bg-card)`, which is
  `var(--svd-surface)` at :294. Keep `overflow: hidden`, which clips the map's
  corners. Note the radius intentionally drops 16px → 12px; nothing in
  e2e/tests/map.spec.ts asserts a map radius.

### F51 — Leaflet control chrome (zoom, scale bar, attribution) never flips theme — the only surface on /map that stays white-on-black in dark

- **Severity / tier:** medium / mechanical
- **Rule:** Spec
  docs/superpowers/specs/2026-08-27-ui-modernization-design.md:334 (§8): "Both
  themes get an independent design and contrast pass"; §8 themes only the tile
  pane and is silent on controls. Sibling inconsistency in the same control
  layer: assets/app.css:2407-2421 already themes
  `.leaflet-popup-content-wrapper` / `.leaflet-popup-tip` with `--svd-surface` /
  `--svd-text` / `--svd-shadow-lg`.
- **Evidence:** VERIFIED in full. `grep -n leaflet assets/app.css` returns only
  lines 272-273 (a z-index comment), 2241 (`.map-container .leaflet-container`),
  2408-2421 (the popup block) and 2423
  (`.leaflet-tile-pane { filter: var(--svd-tile-filter) }`) — no rule for
  `.leaflet-bar`, `.leaflet-control-scale-line` or
  `.leaflet-control-attribution`. Pixel samples on
  scratchpad/shots/map-{light,dark}-wide.png reproduce every cited value: zoom
  plate (60,412) = `#ffffff` in BOTH themes, zoom glyph (46,412) = `#000000` in
  BOTH; scale bar (70,1069) `f5f4f3` light / `cbcbca` dark and attribution
  (1380,1075) `e7eff1` light / `ccd2d3` dark — both Leaflet's
  `rgba(255,255,255,.8)` letting the filtered tile show through, not a themed
  surface. Crops (/tmp/vf_zoom.png light beside dark, /tmp/vf_attr.png light
  above dark) show byte-identical white plates with black glyphs and `#0078A8`
  links sitting over the dark-filtered map.
- **Fix:** Add dark-aware rules beside the popup block at assets/app.css:2421:
  `.leaflet-bar a, .leaflet-control-scale-line, .leaflet-control-attribution { background: var(--svd-surface); color: var(--svd-ink); border-color: var(--svd-line) }`,
  `.leaflet-bar a:hover { background: var(--svd-bg-tooltip-hover) }`, and
  `.leaflet-control-attribution a { color: var(--svd-link) }` (the attribution's
  hard-coded `#0078A8` is a fourth link colour on top of the parity gap). All
  five tokens exist and are tier-2 semantic, the tier a rule may read per
  assets/CLAUDE.md §Tokens: `--svd-surface` (app.css:78, overridden 327/386),
  `--svd-ink` (85, overridden 331/390), `--svd-line` (87),
  `--svd-bg-tooltip-hover` (305), `--svd-link` (307). Prefer `--svd-ink` over
  the popup block's `--svd-text` (app.css:291), which is the legacy tier. Safe
  against the e2e: map.spec.ts:83-99 asserts the zoom buttons by accessible
  name, visibility and `aria-disabled`, never colour. Severity lowered from
  high: the gap is real and visible but costs no information — the controls stay
  fully legible.

### F52 — /map: the 700px map box has no responsive height, so at 390px 69% of the box is empty out-of-tile grey

- **Severity / tier:** medium / structural
- **Rule:** Sibling surfaces: `.timeline-scroll` and `.phenogram-scroll` size
  their figure to the width available and each owns a breakpoint (app.css:2643,
  3060). `.map-container` (`min-height:700px`, app.css:2229-2235) and
  `.trials-map` (`min-height:700px !important`, app.css:2237-2239) appear in
  none of the stylesheet's breakpoints — the only full-width visual surface in
  the app with a width-independent pixel height. Spec §13 (:447) names 390 as a
  manual pass width.
- **Evidence:** Re-measured tile coverage: 390px → `.map-container` 366×825
  (`.trials-map` 366×700), tile band 256px tall = 36.6% of the map box, 69.0% of
  the container is grey; 768px → 728×762 box, band 512px = 73.1% covered, 32.8%
  grey; 1024px and 1440px → band 1024px, map box fully covered. Confirmed
  visually in map-light-narrow.png (blank grey above and below the world). The
  navbar measures 235px at 390×844, so the 700px box cannot be seen at once
  there. Mechanism correction: the zoom is not the `MAP_DEFAULT_ZOOM = 2`
  constant but
  `map.fitBounds(cluster.getBounds(), {padding:[40,40], maxZoom:6})` at
  islands/TrialsMap.tsx:325-328, which lands on zoom 0 (a 256px world) once the
  container is this narrow.
- **Fix:** Give the map box a height that follows its width below ~900px —
  `aspect-ratio: 4 / 3`, or `min-height: min(700px, 75vh)` on both
  `.map-container` and `.trials-map` (the latter needs `!important` to beat the
  existing rule). Do not try to fix it by raising the initial zoom: `fitBounds`
  runs after init and would overwrite it. Keep `.map-container`'s
  `overflow:hidden` and the `.map-stats` padding — app.css:2246-2251 records
  that margin collapsing there was already fixed once.

### F53 — .map-stats is the only per-page summary that is centred, leaving a 388px gutter between the plate edge and its first number

- **Severity / tier:** low / judgment
- **Rule:** Inconsistency with a named sibling surface: `/map`'s `.map-stats`
  sets `justify-content: center` (assets/app.css:2256) while `/genes` and
  `/trials` render the per-page summary above the main data surface through
  `.readout` (assets/app.css:1231-1236), a plain wrapping flex row with no
  `justify-content`, so it starts at its content edge. No repo document forbids
  centring, so this is a composition judgement, not a rule violation — and the
  app.css comment at :2246-2251 shows the strip was deliberately reworked (and
  left centred) during the modernization pass.
- **Evidence:** MEASUREMENTS REPRODUCE. map-light-wide.png: strip ink spans
  x=408..1033 inside a plate spanning x=20..1420, while the `Trials Map` h1
  spans x=21..394 — a 388px left gutter. `.map-stats` is nested inside
  `.map-container` (islands/TrialsMap.tsx:346-347) rather than being a sibling
  block, and it has no ground of its own, unlike `.readout-stat`, which is a
  recipe member (app.css:858). `justify-content: center` appears exactly 4 times
  in app.css: :739 `.navbar-nav`, :1493 a table-header sort button, :2256
  `.map-stats`, :3108 `.page-footer-inner` — so no other per-page summary is
  centred. Weakening the sibling comparison slightly: on /genes the `.readout`
  sits in the content column beside the filter sidebar, so its stats also begin
  around x=360 — the difference is that they fill the column as recipe-surface
  cards rather than floating as inline text.
- **Fix:** Drop `justify-content: center` at assets/app.css:2256 so the strip
  starts at the content edge. Do NOT delete
  `.map-stats .date-badge { margin-bottom: 0 }` at :2276 as the original fix
  proposed — `.date-badge` carries `margin-bottom: var(--svd-space-4)` at :1676,
  so that reset is load-bearing and joining the depth recipe does not replace
  it. The comment at :2246-2251 documents the strip's history and should stay.

### F54 — .marker-cluster div names the wrong ink token — --svd-on-accent over a --svd-color-primary fill

- **Severity / tier:** low / mechanical
- **Rule:** assets/app.css:112-115 defines the `-on-` family as "Ink for text
  sitting ON a filled surface", one per fill (`--svd-on-primary` :114,
  `--svd-on-accent` :115). The cluster's inner disc is filled with
  `--svd-color-primary`, so `--svd-on-primary` is the token that says the thing;
  `--svd-on-accent` names the ink for the accent fill, which here is the outer
  ring the digits do not sit on.
- **Evidence:** REPRODUCED EXACTLY. assets/app.css:2458-2460
  `.marker-cluster div { color: var(--svd-on-accent); }` against
  `.marker-cluster-small div` (:2433-2436), `-medium div` (:2443-2446) and
  `-large div` (:2453-2456), each
  `background-color: color-mix(in oklab, var(--svd-color-primary) 80/85/90%, transparent)`;
  the outer `.marker-cluster-{small,medium,large}` rules at :2428/:2438/:2448
  are the accent-filled ring. Latent today only because the two tokens resolve
  identically in both themes (`--svd-white` light at :114-115,
  `--svd-indigo-975` dark at :348-349 and :407-408). Measured from
  crops/cluster-light.png and cluster-dark.png: inner disc (97,86,195) light and
  (146,136,216) dark; ink contrast 5.79:1 and 6.21:1 — both exactly as claimed,
  both passing. Re-tinting either `-on-` token independently silently breaks the
  digits.
- **Fix:** Change `--svd-on-accent` to `--svd-on-primary` at
  assets/app.css:2459. No rendered change today; e2e/tests/map.spec.ts:69-73
  asserts only the badge text and class, not its colour.

### F55 — Three off-token transitions render on /map — 0.3s, 0.25s and 0.2s — which contradicts "motion is clean"

- **Severity / tier:** low / mechanical
- **Rule:** Design spec §1 (:17) lists "Leaflet + markercluster … 0.3s" as one
  of the four competing systems the pass exists to collapse, and §1's outcome
  (:57-59) covers the Leaflet map. `--svd-duration-base: 140ms`,
  `--svd-duration-slow: 220ms` and `--svd-ease-out: cubic-bezier(0.2, 0, 0, 1)`
  (assets/app.css:267-269) already say the thing.
- **Evidence:** REPRODUCED, with one line-number correction.
  MarkerCluster.css:1-6
  `transition: transform 0.3s ease-out, opacity 0.3s ease-in` on
  `.leaflet-cluster-anim .leaflet-marker-icon` (fires on every cluster zoom, not
  only spiderfy) and the same 0.3s pair on `.leaflet-cluster-spider-leg` at
  :8-13; leaflet.css:181-183 `transition: opacity 0.2s linear` on
  `.leaflet-fade-anim .leaflet-popup`; leaflet.css:198-200
  `transition: transform 0.25s cubic-bezier(0,0,0.25,1)` on
  `.leaflet-zoom-anim .leaflet-zoom-animated`. All three files are loaded
  (client.ts:7-10). The "all transitions use tokens" baseline was measured over
  assets/app.css only — `tests/styles_contract_test.ts:4,11-12` reads exactly
  that one file. CORRECTION: the reduced-motion neutraliser is at
  assets/app.css:3069-3076, not :3080-3085; it does cover these
  (`*, *::before, *::after { transition-duration: 0.01ms !important }`).
- **Fix:** Add the selectors to the Leaflet override block at
  assets/app.css:2407 with `transition-duration: var(--svd-duration-slow)` and
  `transition-timing-function: var(--svd-ease-out)`, keeping the properties
  Leaflet animates. `.leaflet-cluster-anim .leaflet-marker-icon` and
  `.leaflet-cluster-spider-leg` must take the SAME values — MarkerCluster.css:9
  states the leg's stroke-dashoffset duration and function have to match the
  marker transform to track it. Shortening the zoom animation from 0.25s to
  220ms is safe for e2e/tests/map.spec.ts:104, which waits on
  `.leaflet-zoom-anim` reaching count 0. If the zoom animation is deliberately
  left alone, say so in a comment beside it, the way the tile-filter scoping is
  documented at app.css:120-122.

---

## Phenogram (1)

### F56 — /phenogram: the karyogram scrolls sideways at every viewport below ~1482px and loses visible gene labels below ~1410px — the legend-stacking breakpoint sits ~380px too low

- **Severity / tier:** medium / structural
- **Rule:** Sibling surface inside the same stylesheet: `.timeline-layout`
  (plate + 18rem key) stacks at ≤1300px (assets/app.css:2643) and its comment
  derives that number — "1300px is where the 960px plate and the rail stop
  fitting side by side" = 960 figure + 32 scroll padding + 20 gap + 288 rail.
  `.phenogram-layout` (plate + the same 18rem key) stacks at ≤1100px
  (app.css:3060) — the plate's own `min-width`
  (`.phenogram-canvas{min-width:1100px}`, app.css:2882-2888, finding cited
  2879-2881 for the comment), not the plate-plus-rail sum, which is
  1100+32+20+288 = 1440 plus the 40px `.page-main` gutters = 1482.
- **Evidence:** Re-measured `.phenogram-scroll` scrollWidth − clientWidth:
  1101px → 381 (16 gene blocks past the edge); 1280px → 202 (6 blocks: SH3PXD2A,
  VWA2, HTRA1, ADA2, TIMP3, GLA — and 29 SVG `text` nodes genuinely cut,
  including the "X" chromosome label and the WMH/PSMD/SVS/BG-PVS/Stroke pills);
  1366px → 116 (GLA); 1440px → 42; 1482px → 0. Two corrections to the original
  evidence: exact fit is 1482px, not 1512px (1512 was merely also clear); and at
  1440px **no visible ink is clipped** — the rightmost SVG ink ends at x=1082.9
  against a scroller right edge of 1112, so the 42px is right-hand whitespace
  and the "GLA clipped" reading came from the `li` hit box overhanging by 6px.
  Visible clipping stops between 1400px (1 pill cut) and 1420px (0).
  `documentElement.scrollWidth <= innerWidth` holds at every width, so
  runtime.spec.ts is not violated.
- **Fix:** Derive the phenogram's stacking query the way the timeline's comment
  derives its own — 1100 canvas + 32 `.phenogram-scroll` padding + 20
  `--svd-space-5` + 288 rail + 40 page gutters = 1482px — and note the trade in
  the comment: at ≤1482 the key drops under the figure, so the documented
  right-hand-rail arrangement no longer appears at the spec's named 1440 manual
  width. If keeping the rail at 1440 matters more, lower `.phenogram-canvas`'s
  `min-width` instead; do not shrink the rail below 18rem, which is the measure
  the timeline key is documented to share.

---

## Filters (2)

### F57 — Five of nine filter groups name themselves differently in the sidebar and in the Active Filters line

- **Severity / tier:** medium / judgment
- **Rule:** Sibling surface named on both sides: the sidebar heading (`label`,
  rendered at components/CheckboxFilter.tsx:72 into `.filter-group-label`) and
  the readout (`name`, joined at lib/filters.ts:278 as `${spec.name}: …`). Root
  CLAUDE.md, Filtering: "Hiding the controls hides no information, because
  `TableShell` prints the `Active Filters:` line above the table either way" —
  which holds only if a summary term traces back to its control.
- **Evidence:** VERIFIED, and the corrected count of 5/9 is right. `name` never
  reaches the DOM: islands/TrialsView.tsx:309-311 destructures it away
  (`filtersBeforeSample.map(({ name, ...props }) => <CheckboxFilter key={name} {...props} />)`),
  and lib/filters.ts:277-278 is the only consumer. The five that disagree:
  GenesView.tsx:281/282 "Mendelian Randomization" vs "Mendelian Randomization
  Performed?"; GenesView.tsx:296/297 "Omics Studies" vs "Evidence From Other
  Omics Studies"; TrialsView.tsx:197/198 "Genetic Evidence" vs "Genetic
  Evidence?"; TrialsView.tsx:205/206 "Registry" vs "Clinical Trial Registry";
  TrialsView.tsx:212/213 "Phase" vs "Clinical Trial Phase". The four that agree:
  GWAS Traits (GenesView.tsx:289/290), SVD Population (TrialsView.tsx:219/220),
  Sponsor Type (TrialsView.tsx:227/228), and Target Sample Size — summary name
  at TrialsView.tsx:286 matches the legend at :316 exactly. TrialsView.tsx:324
  `label="Target sample size"` is the RangeSlider's own accessible label on the
  control inside the fieldset, not the group heading, so counting it as a sixth
  mismatch was the earlier error.
- **Fix:** Correct the count to 5/9 before the report ships. Then collapse the
  pair into one field per group: keep the fuller sidebar wording as the single
  source and have `checkboxFilterSummary` read `label`, dropping `name` from
  `CheckboxFilterConfig` — "Clinical Trial Registry: NCT" reads no worse than
  "Registry: NCT" and is traceable. Separately align TrialsView.tsx:324 to Title
  Case so the slider's accessible name matches the legend directly above it.
  Check e2e specs that assert on the readout text before landing the rename.

### F58 — Two REGISTRY_CHOICES labels carry a literal newline, and .filter-option's white-space: pre-line makes the browser honour it

- **Severity / tier:** medium / mechanical
- **Rule:** Sibling surface: no other choice list in lib/constants.ts hard-codes
  a break — PHASE_CHOICES (:132-139), POPULATION_CHOICES (:141-147),
  SPONSOR/YES_NO/OMICS all let the label wrap. Layout is the stylesheet's job; a
  fixed break point cannot respond to the 390px narrow viewport.
- **Evidence:** VERIFIED, every line number correct. lib/constants.ts:120-124
  and :125-128 hold
  `"International Standard Randomised\nControlled Trial Number (ISRCTN)"` (the
  literal is on :122) and
  `"Australian New Zealand Clinical\nTrials Registry (ANZCTR)"` (on :126). They
  are not inert: assets/app.css:1103-1115 sets `white-space: pre-line` on
  `.filter-option` at :1112, so the break is forced at every rail width — the
  20rem sidebar, the collapsed rail, and 390px. The two neighbours in the same
  array wrap naturally (`"ClinicalTrials.gov (NCT)"` :119,
  `"Chinese Clinical Trial Register (ChiCTR)"` :129), so one group's five
  options use two different wrapping mechanisms. The readout is unaffected —
  lib/filters.ts:278 joins `spec.value`, i.e. "ISRCTN".
- **Fix:** Remove both `\n` from lib/constants.ts:122 and :126 and let the
  labels wrap. If the two-line shape is genuinely wanted for these registry
  names, get it from the stylesheet rather than the data, then reconsider
  `white-space: pre-line` at assets/app.css:1112 — it is the only pre-line rule
  outside `.pipeline`-scoped prose at :3505, and today it exists solely to serve
  these two strings while handing every future label a hidden formatting
  channel.

---

## Figma (2)

### F59 — 19 of 136 Figma variables carry no usable CSS name, contradicting the file's own status banner

- **Severity / tier:** medium / mechanical
- **Rule:** The file exists to be an organised, checkable overview of the repo's
  design tokens. Its own STATUS frame (node 64:218) states: 'Every variable
  carries its CSS custom property name in codeSyntax (WEB), so any row can be
  checked by hand against the repo.'
- **Evidence:** 14 recipe/* variables have codeSyntax.WEB empty (chip-fill,
  chip-fill-hover, chip-fill-ok/-ember/-danger, chip-border and its four
  variants, surface-border and its four variants). Five nav/* variables carry
  strings that are not property names and cannot be pasted into CSS:
  '--svd-nav-ink 24%', '... 40%', '... 74%', '... 16%', '... 12%' — these are
  color-mix results encoded as if they were names. Seven of the nineteen are
  live rather than theoretical: on page 02 Components they are bound 98 times
  between them, and nav/ink-dim alone is bound 70 times — so the invalid string
  is the most-used mapping in the file.
- **Fix:** Leave WEB empty for a derived value and put the derivation in the
  variable description, which is what the recipe/* rows already do.

### F60 — Three token pairs are split across the Figma boundary, and one token is documented under its deprecated name

- **Severity / tier:** low / mechanical
- **Rule:** The file exists to be an organised, checkable overview of the repo's
  design tokens, so a token present in the stylesheet and absent here is a gap
  in that overview. assets/CLAUDE.md: 'Delete a name once its last use is gone.'
- **Evidence:** 34 of 151 CSS tokens have no Figma counterpart; most are
  explained (effect styles, z-index, easing, the disclosed --svd-tint cascade,
  tier-3 aliases). Three are not, and each is half a pair: --svd-focus-color is
  missing while --svd-focus-width and --svd-focus-offset are present;
  --svd-highlight-wash is missing while --svd-color-highlight is present;
  --svd-font-sans/-mono are missing. Separately, alias/surface-translucent maps
  to '--svd-bg-light' — the tier-3 alias marked for deletion — rather than to
  the tier-2 name --svd-surface-translucent.
- **Fix:** Add the three missing halves; repoint alias/surface-translucent's WEB
  name to --svd-surface-translucent.
