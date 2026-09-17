# Frontend audit findings and remediation design

Date: 2026-09-08. Scope: every route, island, component and the stylesheet,
audited for theme inconsistencies, readability, placement of elements and other
poor UI choices, plus any bug met on the way. The companion plan is
`docs/superpowers/plans/2026-09-08-frontend-audit-remediation.md`.

## Method

Three code-reading passes (the stylesheet against `assets/CLAUDE.md`; every file
under `routes/`, `components/` and `islands/`; the 2026-09-03 sweep, the
Industry import decisions and the test pins) and one rendered pass: the six
routes and the login sheet at 1440, 900 and 390px in both themes, 38
screenshots, with `getBoundingClientRect` and `getComputedStyle` probes. The
rendered pass ran against `deno task dev` with `Accept-Encoding: identity`,
because the dev server's gzip body is corrupt (B01).

Everything the 09-03 sweep fixed or the Industry import decided is excluded and
is not re-listed here: white figure plates in both themes, the family-hue
palettes, keys under the plate at every width, seven rings and the 0.15
outermost band, square geometry and the registration-mark frames, the retired
mono face, the `aria-hidden` pointer-only timeline tooltip, the
`.visually-hidden` clip technique, the touch-target sizes of the two figures'
own controls. The performance items the responsiveness spec left open stay open,
except the trivial memoisation in B07.

Three decisions were put to the owner and settled:

- The "Trials Timeline" tab is renamed **Trials Radar**. The route path stays
  `/timeline`.
- Below 900px the navbar **hides the long title** and shows the tabs as one
  horizontally scrollable row.
- Absent values in table cells render as an **em dash in muted ink** with a
  visually-hidden "not recorded"; filter choices keep their sentinel `value`s.

## What is sound

The stylesheet passes every mechanical check: no colour literal or tier-1
palette token outside the token block, the two dark blocks are byte-identical,
no dead selector among 305 class names, no `!important` outside the
reduced-motion guard, no ellipsis truncation anywhere, every transition guarded.
Heading order is correct on all six pages; every `Icon` is `aria-hidden`; both
drawers manage focus; every status colour is paired with a glyph and a word;
Leaflet's dark-mode overrides are complete. None of that changes.

## Findings

Each finding has an ID, the file and line where it lives, what a reader
experiences, and the fix the plan implements. Severity: **H** breaks a page or
hides content, **M** costs legibility or understanding, **L** polish or hygiene.

### Layout and placement

- **L01 (H) Two sticky panels keep `top` after they stop being sticky.**
  `assets/app.css:2328` resets `.sidebar-section` to `position: relative` at
  ≤900px, and `:3556` does the same for `.timeline-drawer` at ≤1100px, but
  neither resets `top: var(--svd-navbar-h)`. A relative box honours `top`.
  Measured at 390px: the filter panel starts 264px below its slot and overlaps
  the readout and table controls by 264px; at 1000px the drawer sits 152px low.
  `tests/styles_contract_test.ts:583,760` pin position, max-height and overflow
  but not `top`. Fix: `top: auto` in both resets, and extend both regexes to
  require it.
- **L02 (H) The trial drawer opens above the radar, not beside it.**
  `assets/app.css:3056` lists `.timeline-main` in the same rule as
  `.phenogram-layout`, which is `flex-direction: column`, and no later rule
  makes it a row. Activating a marker inserts a full-width record above the
  plate and pushes the figure the reader just clicked down the page; the sticky
  treatment then floats the record over the plate while scrolling.
  `flex: 0 0 20rem`, the sticky top and the ≤1100px stacking query at `:3092`
  are all dead until the row exists. Fix: give `.timeline-main` its own
  `display: flex; flex-direction: row; align-items: flex-start; gap:
  var(--svd-space-4)`
  rule and drop it from the phenogram group; the 1100px query becomes the real
  stacking switch. Pin with an e2e assertion that at 1440px an open drawer's
  right edge is left of the plate.
- **L03 (H) The mobile navbar is 234px tall and sticky.** The 79-character
  uppercase title wraps to three lines and the six tabs to three rows, so the
  bar takes 28% of an 844px screen on every page. Fix (owner decision): at
  ≤900px `.navbar-title { display: none }`; `.navbar-nav` becomes
  `flex-wrap: nowrap; overflow-x: auto; scrollbar-width: thin` with
  `scroll-snap-type: x proximity` and each `li` `scroll-snap-align: start`;
  `nav` gets `min-width: 0` so the grid track can shrink. Then re-measure the
  bar at the 900 and 600 bands and set `--svd-navbar-h` to the measured heights
  (`assets/app.css:2416,2424`), updating the literal pins at
  `tests/styles_contract_test.ts:606,610`.
- **L04 (M) `--svd-navbar-h` is 30px off at 390px** even today (token 264px, bar
  234px). Resolved by L03's re-measurement; the plan records the method so the
  next band change repeats it.
- **L05 (M) The About hero leaves its right half empty at desktop.**
  `.about-hero h1 { max-width: 24ch }` (`assets/app.css:2069`) and the 62ch lede
  stack on the left of a 1152px card. Fix: at ≥900px the card body is a
  two-column grid, heading and badge left, lede right, the KPI row spanning
  both. The KPI row keeps its one-line contract (`e2e/tests/about.spec.ts`).
- **L06 (M) "PUBLICATIONS" breaks mid-word at 390px.**
  `.about-kpi-label { overflow-wrap: anywhere }` at ≤600px
  (`assets/app.css:3960`) produces "PUBLICATIO / NS". Fix: the label is
  "Publications" (`routes/index.tsx`, the four KPI labels); the lede already
  says peer-reviewed. Keep `overflow-wrap: anywhere` as the spill guard.
- **L07 (M) Refresh counts sit 850px from their labels.** `.pipeline-source` is
  a full-width flex row with `space-between`, so "ClinVar" and "16 fetched · 63
  written" are at opposite ends of a 1152px card. Fix: `max-width: 40rem` on the
  sources list so label and count read as a pair.
- **L08 (M) The work-in-progress banner precedes the h1.**
  `components/Page.tsx:37` renders `banner` before `header`. Only the About page
  passes one. Fix: About renders the warning as its first child after the hero;
  `Page` loses the `banner` prop.
- **L09 (M) The table controls sit above the status line they change.**
  `components/TableShell.tsx:285-322`: search and page-size, then a rule, then
  `Active Filters`, then the table. Fix: render `.table-controls` directly above
  the table, below the status line.
- **L10 (L) The two tables default to different page sizes** (Genes 10 at
  `islands/GenesView.tsx:320`, Trials 25 at `islands/TrialsView.tsx:237`). Fix:
  both 10; `PAGE_SIZES[0]` is the default. Re-pin
  `e2e/tests/trials-table.spec.ts:34,40,57`.
- **L11 (L) The phenogram's "Not drawn" diagnostic sits at the top of the
  figure** in danger ink (`islands/Phenogram.tsx:308`). Fix: render it under the
  plate beside the key, muted, with the lead "Not placed on the figure".
- **L12 (L) The map's failure message renders below the empty map box**
  (`islands/TrialsMap.tsx:436`). Fix: render `.map-error` inside `.trials-map`
  in place of the container when `loadError` is set, and include the error's
  message.
- **L13 (L) The timeline tooltip shares `--svd-z-sticky` with the navbar**
  (`assets/app.css:3323`), so a panel near the top paints over the bar. Fix:
  `--svd-z-float: 900` (clears Leaflet's controls at 800, sits under the bar)
  and the tooltip reads it.
- **L14 (L) The Protein column is 117px wide**, wrapping "Islet cell autoantigen
  1-like protein" to four lines. Fix:
  `.data-table td.col-protein { min-width: 10rem }`.

### Readability and copy

- **R01 (H) Export sentinels are the most common cell content.** `(none)` fills
  81 of 102 Genetic Target cells, `(none found)` 52 of 79 monogenic cells;
  `(unknown)`, `(not yet extracted)` and `(reference needed)` also render raw.
  Fix (owner decision): a `lib/sentinels.ts` with `ABSENT_SENTINELS` and
  `isAbsent(value)`, and a `components/Absent.tsx` rendering
  `<span class="cell-absent">—<span class="visually-hidden">not
  recorded</span></span>`.
  Every cell renderer in both islands and `TooltippedValues` route through it.
  The data layer, the filter values and the filter choice labels are untouched.
  Re-pin `e2e/tests/trials-table.spec.ts:213`.
- **R02 (H) The Active Filters line prints wire values.** `lib/filters.ts:239`
  joins `spec.value`, so "Phase not stated" shows as
  `Clinical Trial Phase:
  (unknown)` and "MENTR" as its long name. Fix:
  `FilterSummarySpec` carries `choices`, and `buildFilterSummary` maps each
  value to its choice label. `checkboxFilterSummary` in
  `components/CheckboxFilter.tsx` already has the choices.
- **R03 (H) The omics wire form leaks.** Cells show `TWAS;cross tissue`
  (`islands/GenesView.tsx:223-230`); the semicolon is the export's device for
  keeping the type filterable. Fix: a `formatOmicsValue` in `lib/filters.ts`
  beside `omicsType` that renders `TWAS (cross tissue)`; the tooltip already
  splits on the semicolon.
- **R04 (M) The 11px type floor.** `--svd-text-2xs: 0.6875rem`
  (`assets/app.css:330`) drives 19 sites including every table column header
  (`:1705`, also uppercase, tracked 0.08em and muted) and the 11px monospace
  error dump (`:4317`). `.readout-bar-label` is 9px (`:1535`). Fix:
  `--svd-text-2xs: 0.75rem`; the bar label reads the token.
- **R05 (M) Two filled controls fail AA in light mode.** `.login-submit`
  (`assets/app.css:4889`) and `.pagination button[aria-current='page']`
  (`:2013`) put `--svd-on-primary` on `--svd-color-accent`, 3.85:1; the hover
  state is more legible than rest. `.pagination button:disabled` is
  `opacity: 0.45` (`:2020`), 2.59:1. Fix: both fills become
  `--svd-color-primary` (9.08:1, what `.skip-link` already uses); disabled
  buttons read `--svd-ink-muted` at full opacity. The current page stays the one
  different background, which is what `genes-table.spec.ts` reads.
- **R06 (M) The same result set is counted three ways** on each data page: the
  readout header's `<em>63 of 79</em>` (`components/DensityReadout.tsx:93`), the
  status line's "showing 63 of 79 rows" and the pagination's "Showing 1–10 of
  63". Fix: drop the readout header count (the bars already show the subset);
  the status line stays the announced count; pagination keeps its range and
  gains `role="status"`.
- **R07 (M) Field values are the least prominent text in the drawer.**
  `.timeline-drawer-fields dd` is `--svd-ink-muted` (`assets/app.css:3534`)
  under accent, semibold, uppercase labels. Fix: `dd` reads `--svd-ink`.
- **R08 (M) Pipeline prose runs to ~130 characters a line.**
  `.pipeline-actions`, `.pipeline-quote`, `.pipeline-syncs-lead`,
  `.pipeline-error-hint` carry no measure inside the 72rem shell. Fix:
  `max-width: 70ch` on the four.
- **R09 (M) Completion dates are the raw wire string** "7/2028"
  (`islands/TrialsView.tsx:151`, `components/MapPopup.tsx:81`). Fix:
  `formatMonthYear` in `lib/constants.ts` beside `formatLongDate`, rendering
  "Jul 2028"; sorting keeps the raw value.
- **R10 (M) The "How to Cite" template renders as if it were a citation**
  (`routes/index.tsx:33`). Fix: `pending: true`, like its neighbours.
- **R11 (M) The group header "Evidence From Omics Studies" spans Mendelian
  Randomization and Link to Monogenic Disease** (`islands/GenesView.tsx:49`).
  Fix: "Genetic and Omics Evidence". Re-pin `e2e/tests/genes-table.spec.ts:26`.
- **R12 (L) Two filter legends end in a question mark and five do not.** Fix:
  "Mendelian randomization performed" and "Genetic evidence"; the legends are
  the labels the Active Filters line prints, so `tests/components_test.tsx`
  moves with them.
- **R13 (L) Abbreviated GWAS choices carry no expansion** while the phenogram
  key does (`lib/phenogram_tooltips.ts:69`). Fix: `CheckboxFilter` accepts an
  optional `description` per choice, rendered as `title` and a visually-hidden
  suffix; `GWAS_TRAIT_CHOICES` fills it from the vocabulary's long name.
- **R14 (L) The genes tips reference a control by colour and offer no keyboard
  path** (`routes/genes.tsx:13-20`). Fix: "Hover over or activate them…" and
  "the link button in the tooltip".
- **R15 (L) "Locations resolved an unknown date"** (`islands/TrialsMap.tsx:30`)
  against "Date unavailable" elsewhere. Fix: "Locations resolved · date
  unavailable".
- **R16 (L) The disease is named four ways in prose.** Fix: page descriptions
  and the login lede say "cerebral small vessel disease (SVD)" on first use and
  "SVD" after; data labels ("SVD Population", "Extreme-cSVD") are wire values
  and stay.
- **R18 (M) The empty state is a dead end.** "No rows match the current
  filters." (`components/TableShell.tsx:401`) offers no way out, and the filter
  rail may be collapsed at that moment. Fix: `TableShell` takes an
  `onClearFilters` callback and renders a "Clear all filters" button beside the
  sentence; each island resets its selections and the search box.
- **R17 (L) The tab names a figure with no time axis.** Fix (owner decision):
  "Trials Radar" in `lib/constants.ts:54`, `routes/timeline.tsx:15`,
  `e2e/tests/navigation.spec.ts:15` and `README.md:192,257`.

### Accessibility

- **A01 (M) The tooltip trigger never says it discloses anything**
  (`components/Tooltip.tsx:195`). Fix: `aria-expanded` on the trigger, toggled
  from the existing `toggle` listener, and `aria-controls` naming the panel.
- **A02 (M) The per-group active count is `aria-hidden`**
  (`components/CheckboxFilter.tsx:76`). Fix: a visually-hidden ", N selected"
  inside the legend when the group constrains.
- **A03 (M) The pagination summary is not a live region**
  (`components/TableShell.tsx:441`). Fix: `role="status"` on the span.
- **A04 (M) Filter collapse resets on every navigation**
  (`components/FilterPanel.tsx:36`). Fix: persist in `localStorage` under
  `svd-filters-collapsed`, read in a mount effect so SSR stays deterministic.
- **A05 (M) 111 and 79 sequential tab stops with no way past** the two figures.
  Fix: a visually-hidden-until-focused "Skip the figure" link before each SVG,
  targeting the key's `id`.
- **A06 (M) Seven controls light on hover only.** `.theme-toggle`,
  `.navbar-signout`, `.sidebar-toggle`, `.filter-option`,
  `.timeline-drawer-close`, `.pipeline-step-head`, `.pipeline-apis summary`
  (`assets/app.css:1025,1067,1287,1387,3469,4192,4574`), plus
  `th.sortable:hover` (`:1718`) whose focusable child is `.sort-button`, and
  `.phenogram-genes .tooltip-box:hover` (`:3640`). Fix: add `:focus-visible` to
  each list, and `th.sortable:has(.sort-button:focus-visible)`.
- **A07 (L) The theme toggle lies before hydration**: SSR always says "Switch to
  dark theme" (`islands/ThemeToggle.tsx:35`). Fix: the server-rendered label is
  "Switch theme" and the exact label is set on mount.
- **A08 (L) `FieldIcon` sets `title` and a visually-hidden label**
  (`islands/PipelineRun.tsx:69`), read twice; the head-meta chips at `:513` use
  `title` as their only expansion. Fix: drop the `title` in `FieldIcon`; the
  chips get a visually-hidden expansion.
- **A09 (L) Refresh names are styled as headings but are spans**
  (`components/PipelineSyncs.tsx:61`). Fix: `<h3>` with the same class. The
  pipeline step labels stay spans: they sit inside a `<button>`, where a heading
  is invalid, and wrapping the whole disclosure button in one would announce the
  badge and duration as part of the heading.
- **A10 (L) The readout region is announced twice**
  (`components/DensityReadout.tsx:76,92`). Fix: `aria-labelledby` pointing at
  the visible label's `id`.
- **A11 (L) The home link is named "Paris Brain Institute"** by its logo
  (`routes/_app.tsx:120`). Fix: `aria-label="Home"` on the link; the logo inside
  is `aria-hidden`.
- **A12 (L) The tables are printed clipped.** No `@media print` exists, so the
  navbar prints as an ink block and `.table-scroll`'s `max-height` cuts the
  table to one screen. Fix: a print block hiding the bar, skip link and footer,
  un-sticking the panels and lifting the three scroll containers' `max-height`.

### Theme and token drift

- **T01 (M) `.pipeline-tint-muted` uses one token for fill and ink**
  (`assets/app.css:4019`), the failure `assets/CLAUDE.md` warns against. Fix:
  `--svd-tint-ink: var(--svd-ink)`.
- **T02 (L) `--svd-tooltip-bg` reads a tier-3 alias in light and a tier-2 token
  in dark** (`assets/app.css:188` vs both dark blocks). Fix: `var(--svd-ground)`
  in `:root`; delete the two redundant dark declarations together so the blocks
  stay byte-identical.
- **T03 (L) `.warning-card` mixes into `--svd-bg-card`** (`assets/app.css:2311`)
  where `.pipeline-step-body` uses `--svd-surface`. Fix: `--svd-surface`.
- **T04 (L) Three drawer headings, three inks, one comment saying "same
  colour"** (`assets/app.css:3348`). Fix: `.timeline-drawer-head h2` reads
  `--svd-primary` like the pipeline drawer; the figure tooltip keeps
  `--svd-figure-heading`; the comment says so.
- **T05 (L) One focus-ring override survived the sweep the doc says removed all
  of them** (`assets/app.css:3685`). Fix: delete the rule.
- **T06 (L) `1.75rem` is an invented spacing step** (`assets/app.css:2061`).
  Fix: `var(--svd-space-7)`.
- **T07 (L) `--svd-color-warn-ink` and `--svd-color-ok-ink` collapse onto their
  fills in dark** (`assets/app.css:520,580`). Fix: `assets/CLAUDE.md` states the
  one-step-further ink is light-only; no CSS change.
- **T08 (L) `.page-header h1` restates the base heading margin**
  (`assets/app.css:3971`). Fix: delete the declaration.
- **T09 (L) `THEME_COLORS` in `routes/_app.tsx:12` duplicates `--svd-nav`** by
  hand. Fix: a comment naming the two tokens; `e2e/tests/theme.spec.ts` already
  fails if they diverge.
- **T10 (L) The navbar's own face is not preloaded.** `.navbar-title` and
  `.nav-link` use Barlow Condensed 500; `routes/_app.tsx:106` preloads 600. Fix:
  preload 500 as well.
- **T11 (L) `#888888` is hardcoded twice in `lib/timeline.ts:441,508`**, the
  module whose contract says the encoding owns styling. Fix: a top-level
  `unknownMechanism` colour in `lib/timeline_encoding.json`, read by both
  renderers; `tests/timeline_encoding_test.ts` asserts it exists.

### Bugs and code smells outside the UI

- **B01 (H) The compression middleware corrupts the gzip body under the Vite dev
  server.** `server/compression.ts` pipes every compressible response through
  `CompressionStream`; under `deno task dev` the HTML arrives with
  `Content-Encoding: gzip` and a body `gunzip` rejects, so Chromium reports
  `ERR_CONTENT_DECODING_FAILED` and never reaches `load`. Production is
  unaffected (the e2e suite drives `deno serve`). Fix: return `ctx.next()`
  untouched when `ctx.config.mode !== "production"`; the unit test covers both
  modes.
- **B02 (M) The completion-date sort reads TanStack's private atom store**
  (`islands/TrialsView.tsx:155`, `rowA.table.atoms.sorting.get()`). Fix: the
  accessor returns `undefined` for `(unknown)` and the column sets
  `sortUndefined: "last"`; `compareCompletionDates` loses its direction
  parameter. `tests/table_sorting_test.ts` pins unknowns last in both
  directions.
- **B03 (M) Two islands bundle the pipeline encoding for two format helpers**
  (`islands/GenesView.tsx:41`, `islands/TrialsMap.tsx:14` import from
  `lib/pipeline_display.ts`, which imports the 9KB JSON). Fix: `lib/format.ts`
  owns `formatCount` and `formatConfidence`; `pipeline_display.ts` re-exports
  them.
- **B04 (M) The phenogram throws if no gene carries a trait**
  (`islands/Phenogram.tsx:297`, `families[0].family`). Fix: the sample pill is
  drawn in neutral tint tokens, which also removes the misleading first-family
  colouring the key teaches today.
- **B05 (L) `console.error` in an island** (`islands/TrialsMap.tsx:392`), in the
  file whose own doc records a reload loop from console output. Fix: the message
  reaches the UI via L12; the console call goes.
- **B06 (L) One unknown cell type strips every tooltip in the cell**
  (`islands/GenesView.tsx:248`). Fix: per-part fallback.
- **B07 (L) `groupParity` is recomputed every render**
  (`islands/TrialsView.tsx:255`). Fix: `useMemo` over the sorted row model.
- **B08 (L) `useEscapeKey` assigns a ref during render**
  (`components/useEscapeKey.ts:16`). Fix: assign in a `useLayoutEffect`.
- **B09 (L) Dead re-exports in `lib/tooltips.ts:34`.** Fix: remove them; the
  tests import from `lib/tooltip_content.ts`.
- **B10 (L) A stale migration number** (`routes/index.tsx:232` says 008,
  `islands/CLAUDE.md:70` says 009). Fix: whichever `pipeline/migrations` shows
  created `pipeline_runs`; the plan checks.

### Documentation drift

- **D01** `islands/TrialsTimeline.tsx:423` describes the key as a right-hand
  rail. **D02** `CLAUDE.md` "Timeline" calls the ≤1100px stacking query
  load-bearing while the row it stacks does not exist (true again after L02).
  **D03** `components/PipelineSyncs.tsx:14` and `islands/CLAUDE.md` say the
  refresh card sits "directly above" Data Sources; it sits above the grid whose
  right column is Data Sources. **D04** `assets/CLAUDE.md` claims no focus-ring
  exception is left (true after T05) and one-step-further inks in both themes
  (T07). All four are corrected in the same commits as their code.

## Deliberately not changed

- The product's three names (`SITE_TITLE`, the navbar `HEADING`, the About
  welcome heading) stay: a welcome sentence and a running head are different
  jobs, and the e2e navigation spec pins the heading.
- Column headers and card titles stay Title Case; figure keys and readout stats
  stay sentence case. The convention is by surface and is consistent within
  each.
- The rim-band and wedge tooltips remain pointer-only; putting per-sector drug
  counts in the key needs the print twin to follow and is a figure change, not
  an audit fix.
- The label-fitting effect chain in `TrialsTimeline.tsx:708-808` is not
  refactored; it is correct and pinned, and a `useMemo` rewrite is a performance
  change the responsiveness spec already scoped.
- `shortCitation` duplicated in JSX for the italic _et al._ stays.
- The fallback summary card's labels on About (`PIPELINE_COUNTS`) are not
  derived from the encoding; it renders only while `pipeline_run.json` is
  `null`.
- "written" for the `cached` count in `PipelineSyncs` is a pipeline vocabulary
  question, not a UI one, and is left for `pipeline/CLAUDE.md`.

## Verification

Every phase ends green on `deno task check`, `deno task test:coverage` (the 100%
floor under `lib/` means every new branch in `lib/filters.ts`,
`lib/constants.ts`, `lib/sentinels.ts`, `lib/format.ts` and `lib/timeline.ts`
ships with a unit test) and the e2e specs the phase touches. The final gate is
the full e2e suite plus a repeat of the rendered pass: six routes at 1440, 900
and 390px in both themes, with the probes for horizontal overflow, text under
12px, and the bounding boxes of `.sidebar-section`, `.timeline-drawer` and
`.navbar`.

## Status

Implemented on branch `worktree-frontend-audit` at `d13b498`. Every gate is
green: `deno task check`; `deno task test:coverage` (470 passed, `lib/` at 100%
line, branch and function coverage across every file);
`uv run pytest
tests/scripts` (76 passed); `uv run ruff check .`;
`uv run ty check`; and the full e2e suite,
`npx --prefix e2e playwright test -c e2e/playwright.config.ts` (173 passed). The
Task 3 navbar bands measure 7rem from a 108px bar at 900px and 6.5rem from a
100px bar at 600px, and `ctx.config.mode` reads `"production"` under
`@fresh/plugin-vite`, which is why `compression()` in `main.ts` detects the dev
server through an injectable `isDev`, defaulting to `import.meta.env.DEV`,
rather than trusting `ctx.config.mode` alone.

The horizontal overflow this section previously recorded as open on `/genes` and
`/trials` is fixed. It was root-caused to `.table-scroll` never establishing a
CSS containing block for its absolutely positioned `.visually-hidden`
accessible-label spans: once the fixed-width table columns widened past the
viewport under the 12px type floor, those spans' static position sat off-screen,
and with no positioned ancestor closer than `.blueprint-frame`, their geometry
inflated every ancestor's scrollable-overflow area up to the document instead of
being absorbed by the scroll container that already clipped them visually.
Adding `position: relative` to `.table-scroll` makes it its own containing
block, which is what the fix does.

The rendered-pass probe was re-run against the final branch head and confirms
it: `overflow` is `false` on every route, at every width (1440, 900, 390) and in
both themes; `small` (rendered text under 12px outside SVG) is `0` everywhere;
and `navbar` height at 390px is 100px, under the 120px ceiling. Screenshot
inspection separately confirmed the filter panel sits directly under the tips
with no gap or overlap on `/genes` and `/trials` at 390px, the timeline drawer
opens to the left of the plate at 1440px, the About page renders correctly in
dark mode at 390px, and `/genes` at 1440px shows legible column headers with em
dashes for absent values.
