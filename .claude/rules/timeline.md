---
paths:
  - "islands/TrialsTimeline.tsx"
  - "lib/timeline.ts"
  - "lib/timeline_encoding.json"
  - "disease/timeline.json"
  - "lib/disease/populations.ts"
  - "scripts/timeline_figure.py"
  - "tests/timeline_*.ts"
  - "tests/csvd/timeline_*.ts"
  - "tests/scripts/test_timeline_figure.py"
  - "tests/scripts/csvd/test_csvd_timeline_figure.py"
  - "e2e/tests/timeline.spec.ts"
  - "e2e/tests/csvd/timeline.spec.ts"
---

# Timeline

`islands/TrialsTimeline.tsx` draws the trials radar — population sectors × phase
rings × one marker per trial — from `data/table2.json`, the way every other
island reads its data.

The figure has two renderers and one contract:

- `lib/timeline_encoding.json` is the only place styling lives for what is a
  registry fact rather than the disease's — ring radii and opacities and the
  rim band's `gap` and `width` (all fractions of the outer radius), the
  `boundary` hairline between cells, the empty-cell style, the three
  `evidenceStates`, and the `recordFlag`. Population order, each population's
  wedge colour and the deeper `band` step of it, the mechanism palette and its
  `families` grouping are the disease's and live in `disease/timeline.json`;
  population _identity_ — key, label, order — is `populations[]` in
  `disease/manifest.json`, read on the TypeScript side through
  `lib/disease/populations.ts` and composed with the appearance file in
  `lib/timeline.ts` and `scripts/timeline_figure.py`'s `load_encoding`.
  `tests/timeline_encoding_test.ts` fails when the committed data contains a
  population, phase, mechanism or evidence value the file does not cover, when
  two mechanisms share a colour, or when a mechanism sits in no family or in
  two. Add the entry; do not widen the test. The one shared colour it admits
  is a mechanism two curated releases spell differently -- the gold sheet's
  three `Antioxidant (…)` beside the earlier `Neuroprotective, antioxidant
  (…)` -- whose spellings both stay so either release's data keeps its
  colours: one colour, one family, and never both spellings in one dataset.
  The palette is one hue per family with lightness steps inside it — eleven
  pairwise-distinct hues cannot clear a colour-vision check, so identity rides
  the drug label beside every marker and the legend, and the colour says the
  family first. Do not "fix" it back to eleven unrelated hues.
- `lib/timeline.ts` (island) and `scripts/timeline_figure.py` (print, via
  `deno task figure`) each implement the same layout rule: sector span ∝ unique
  drugs per population; markers at `(j+1)/(m+1)` of the sector in table order;
  marker radius = ring midpoint ± 18 % of the ring thickness, alternating, when
  a cell holds more than one; a rim band per populated population just outside
  the rings, with the population name anchored 24 units beyond it. Angles are
  degrees clockwise from 12 o'clock in both. One placement rule is web-only:
  `placePopulationLabel`/`slideWithinSector` in `lib/timeline.ts` (see its doc
  block) pull or slide a population label a status selection has pushed off the
  plate back onto it, and `scripts/timeline_figure.py` carries no twin of that
  rule — the print figure always draws the full, unfiltered dataset, where
  nothing falls off the plate, and the Show-All sweep in
  `e2e/tests/timeline.spec.ts` reruns the island's label layout over that same
  dataset to prove it. `tests/timeline_layout_test.ts` and
  `tests/scripts/test_timeline_figure.py` pin the same numbers (spans, empty
  cells, marker count, band radii), so a change to the rule has to be made twice
  or fails. pyCirclize refuses a track beyond radius 100, so the print band is
  filled on the polar axes, unclipped, rather than as a track.
- Text metrics belong to the renderer. The island measures every label with
  `getBBox()` after mount and again on `document.fonts.ready`, then fits the
  box; a label that still touches its marker — its evidence ring, when it has
  one — is pushed 10 units outward, up to three times, and `separateLabels()`
  then moves overlapping drug labels clear, treating the population and phase
  labels and every marker as fixed obstacles. The Python script does the same
  with `Text.get_window_extent()` and annotation offsets in points. Neither
  estimates glyph widths.
- **`separateLabels()` is two passes, and its shifts are `{dx, dy}` for the sake
  of the second.** Its doc block in `lib/timeline.ts` records why, and
  `e2e/tests/timeline.spec.ts` pins both collision counts at zero rather than
  bounding them, with a control pair and a box count.
- **Record confidence is two channels, and both are derived — nothing is stored
  and no curator marks anything.** `resolveEvidenceState` and
  `resolveRecordFlag` in `lib/timeline.ts`, twinned in
  `scripts/timeline_figure.py`, are the rules; `lib/timeline_encoding.json`
  holds the appearance and every word.

- **A ring means somebody assessed the drug's genetics.** Solid found evidence,
  dashed looked and found none, no ring means nobody looked. The two-state
  encoding this replaced keyed straight off `geneticEvidence`, so the sweep that
  added most of the committed rows — which left `genetic_target` NULL and
  defaulted the column to `"No"` — drew 90 of 111 markers
  exactly like the nine real negative findings. `geneticTarget === "(none)"` is
  what separates them: it is the column a curator fills in to record that they
  looked. The drawer's Genetic Evidence row reads the state's `field` wording
  for the same reason.
- **A hollow centre means the record is too thin to read at face value**, on 18
  of the 111 committed rows. Three exact rules: a mechanism in the encoding's
  `uncharacterised` family (15), no stated target enrolment or a stated zero
  (3), no stated completion date (1). The hole sits inside the marker's own
  disc, so it joins no collision pass and costs the label layout nothing.

Two things it deliberately does not do. **It never claims a value is wrong** —
`pipeline/opentargets_drugs.py` measured that every textual-agreement rule it
tried flagged a pair known to agree, and refuses to emit a machine verdict; this
says thin or self-declared uncharacterised, nothing more. And **a phase of
`"(unknown)"` is not a flag**: the radar has no ring for it, so such a trial is
not on the figure to be flagged. A completion date in the past is not one
either — 69 committed rows have one, because they are completed trials.

**The radar draws four phases, and a trial in any other is left off it.** The
rings are `IV, III, II, I` outward. Both renderers place a marker by comparing
`clinicalTrialPhase` to the ring's phase for **equality**, so a seamless
`II/III` or `I/II`, an unstated phase, `Early Phase I` and the rarer joins
match no ring: Table 2 lists the trial and the radar draws nothing for it. That
is deliberate. The rings were seven for a while -- the two seamless designs and
`(unknown)` had bands of their own, so the print figure, which has no drawer,
would not show LACI-2 (NCT03451591, a phase II/III trial) on the III ring --
but the curated release has no trial in any of the three, so they drew as
empty bands, and on 2026-11-08 they were removed with the drop-off accepted
for pipeline-fetched trials. Do not fold such a trial onto a component ring
instead: that states a phase the registry does not. `_unplaceable_phases` in
`pipeline/clinical_trials_fetch.py` reports every curated row with no ring and
reads `RADAR_PHASES` off this encoding, so adding a ring back stays one edit --
though a `(unknown)` ring would need `_load_ring_phases` to fold the registry's
`N/A` onto it again, as it did before.

**The outermost band may not be narrowed to make room for a new ring**, and that
is the trap this cost. A marker sits at its ring's midpoint, so a thinner
outermost band pushes the outermost markers -- and the drug labels outside them
-- towards the plate edge, where the margin is only `CANVAS / 2 - OUTER_RADIUS`
= 120 units. Splitting `0.4..1.0` into six equal `0.1` bands moved them 6.7
units out and tipped the 22-character "Stellate ganglion block" over the right
edge under **Linux** font metrics while it still fitted on macOS -- so the local
suite passed and CI failed. The three outer bands are `0.2` each now, which
puts Phase I's staggered markers 6.7 units _inside_ where the seven-ring plate's
`(unknown)` band had them; `tests/timeline_encoding_test.ts` pins the resulting
radius rather than the width, because the radius is what the label layout has
to clear.

**A seamless trial gets no `PHASE_CHOICES` entry either**, for a different
reason. `matchesPhase` in `lib/filters.ts` reads each Roman token, so a
`II/III` trial already answers both "Phase II" and "Phase III" -- which is the
question the table is asked, _does this trial cover phase II_. A choice whose
value is the literal `"II/III"` would match nothing, because the tokens are
compared and neither is that string.

Labels have no boxes. They are ink text with a plate-coloured halo
(`paint-order: stroke` in the island); the `rect.label-bg` the e2e reads is
still there, unpainted, as the measured fit. matplotlib draws text with a path
effect as outlines, which would strip the words from the SVG, so the print
script draws each haloed label twice — a plate-coloured, pathified twin
underneath and the plain text on top.

Data colours are SVG attributes, never CSS, and the drawer, tooltip and legend
chrome use the semantic tokens. The figure sits on a white `rect` of its own, so
it is a light sheet in dark mode too, as the phenogram is; the halos, the marker
rings and the band separators are all cut from that white. Hover and focus lift
a marker and its evidence ring together through the CSS `r` property — geometry,
not colour — and an e2e assertion pins the computed radii. Keyboard access is
the drawer, not the tooltip: each `g.drug` is a `role="button"` with
`aria-expanded` and `aria-controls`, Enter and Space open the `<aside>`, the
close button takes focus, Escape closes and returns it. The tooltip is
pointer-only and `aria-hidden`, as the old one was.

The two panels divide the record deliberately: **the tooltip identifies a trial
at a glance, the drawer is the whole record.** The drawer lists all twelve
`DRUG_FIELDS` with a rule between each — drawn on both cells of the row, since
the wrapper `div`s are `display: contents` and have no box, with the grid's
column gap moved into the label's padding so the two halves meet. Two of the
twelve are not their stored value: Genetic Evidence reads the resolved evidence
state's wording, and Study Status — the field the radar's own filter selects on
— reads `resolveTrialStatus`'s label rather than the raw ClinicalTrials.gov
token, as the trials table and the map popup do. The tooltip shows the five that
carry an `icon` — the subset _is_ that field, there is no second list — with the
glyph in place of the field name and no separators at all; the seven it drops
are either already encoded in the figure (evidence is the ring, phase is the
ring the marker sits on, population is the sector) or are prose that only reads
in the drawer. A flagged record adds a sixth row ahead of them, because it
qualifies every field under it. It repeats the drawer's header exactly —
mechanism swatch, title, population-and-phase pill — so the two panels read as
one component; the difference is the body, not the head. The wedge and rim-band
tooltips keep text labels and the shared `.tooltip-row` class — they are
single-row, so a bare glyph would have nothing to be read against, and
`.tooltip-row`'s separator is scoped to `.tooltip-pop` so the table popovers
keep theirs. Because the tooltip is `aria-hidden`, dropping the field names
costs no assistive-technology user anything; the drawer's `<dt>`s are the
accessible text.

**The drawer never scrolls, in either direction.** It used to be a scrollport
(`overflow-y: auto` under a viewport-height cap), and that scrolled every record
both ways by 6px whatever its length: a scrollport clips the registration
marks' `::after` at its negative inset and counts the `--svd-mark-out` it
reaches past the edge as overflow. Now the cap is only the room a record is
fitted into. The labels sit in a 6.5rem column and wrap, the values take
`--svd-text-sm`, and the rows are `--svd-space-1` apart, which brought the
longest committed record from 826px to about 623px -- whole at 1440x900. A
record still taller than the room is zoomed down (`fitDrawer` in the island,
`fitZoom` in `lib/drawer_fit.ts`) on its `.timeline-drawer-body`, not the
drawer, so the drawer keeps its 20rem and the plate does not shift. The floor is
`DRAWER_FIT_FLOOR`, 0.85, which keeps a value near 11px; past it the drawer sets
`data-fit="page"`, drops its cap and grows, and the page scrolls instead. The
e2e opens every record at 1440x900, 1366x768 and 1280x720 and fails on a
scrollport, on any descendant past the drawer's edge, or on a record not wholly
on screen once the drawer is stuck.

Two SVG details are load-bearing: attribute names on SVG elements are
case-sensitive, so the groups carry `tabindex`, not `tabIndex` (Preact writes
the prop name verbatim, and a `tabIndex` attribute makes nothing focusable);
`.timeline-main` is a flex **row** of its own (drawer, then the framed
scroller), not a member of the phenogram's column rule -- folding it in there
put the record above the plate. And below 1100px `.timeline-main` — the
drawer-and-plate row — must `align-items: stretch`, or the scroll container
sizes itself to its content (the plate, before it had a width of its own) and
the document overflows instead of the container scrolling.
`.timeline-layout` needs the same, which it gets from being a column at every
width.

## The radar resizes with the window

The plate used to be `width: 100%; min-width: 1072px`: 1.11x at 1440px, taller
than a 900px window, and a sideways scroller below 1072px. Neither the 1072px
`min-width` nor any other `min-width` is on it now, and the plate never scrolls
sideways -- only the phenogram's fixed 1100px plate does. The decisions, with
their reasons:

- **The width is `min(100%, 1072px, max(var(--timeline-floor, 0px), (100svh -
  navbar - space-6) * 1072/940))`** (`.timeline-figure`): the container, the
  design size, and the width at which the plate's height fits under the sticky
  navbar. `svh`, not `dvh`: `dvh` moves with a phone's collapsing address bar
  and would re-solve the labels on every scroll. `--timeline-floor` is set on
  `.timeline-layout` by the island and holds the plate up against the _height
  fit only_. It is `max()` inside the width and not a `min-width` on purpose: a
  `min-width` keeps the plate at its floor in a row narrower than the floor,
  the scroller scrolls sideways, the plate never faults, and the phone views
  would be reached only below `RADAR_MIN_ROOM`. Readability outranks fitting
  the window (the user's ranking), so on a wide, short window the plate stops
  at its floor and the page scrolls down; a short window alone never causes the
  phone views.
- **Text keeps its on-screen size; the picture does not.** `scale =
  renderedWidth / CANVAS.width`, read by a `ResizeObserver` and
  `plateScale()` (`lib/timeline_scale.ts`), and every drug (12px), population
  (14px) and phase (11px) font size and the halo width is divided by it, so
  labels read the same at every plate width. The observer is debounced to one
  whole frame with no tick, not one rAF per tick: rAF callbacks run before
  ResizeObserver delivery within a frame, so re-arming a rAF per tick still
  committed a scale on every frame of a drag. A 21-step sweep re-solved once.
  A scale change clears `boxes`, `nudges`, `shifts`, `popShifts`,
  `nudgePasses` and `solvedGeometry` and the usual measure → nudge →
  `separateLabels()` pass runs again; a new selection or a scale change never
  closes the drawer (the reset effect keys on `baseLayout`, the rest layout of
  the selection).
- **Markers grow to keep their size, up to a cap.** `markerGrowth(scale, cap)`
  is `max(1, min(1/scale, cap))`, `cap = markerGrowthCap()` is half the
  closest pair's centre distance over the evidence ring's radius, so two
  markers never touch however far the plate shrinks. The factor `k` multiplies
  marker, ring and gap radii and is published as `--radar-k` on the svg; the
  hover lift is `calc(12px * var(--radar-k, 1))`, so a test reads the lifted
  radius divided by `--radar-k`. The drug-label offset grows with it
  (`computeTimelineLayout`'s `labelOffset` option), which changes no shared
  number at its default, so the print figure and both layout tests stand. For
  the committed data the cap is a little over 2, not the ~15 units apart the
  spec guessed; `k` was about 1.73 at 0.63 scale.
- **Where the radar gives way is decided at runtime, from the data on screen.**
  A hard-coded width is wrong after a data regeneration, in a fork and under
  `empty-data`, because where labels stop colliding depends on the drug-name
  lengths and how crowded each sector is. `nextRadarState()` is one pure
  reducer (state `{mode, floor, stacked}`, observation `{room, plateWidth,
  heightLimited, drawerBeside, drawerSpace, clean}`) and its first matching
  rule wins: a room under `RADAR_MIN_ROOM` (480) is phone; in phone mode the
  radar returns only at `floor + HYSTERESIS` (32); no settled solve (`clean:
  null`) changes nothing; a clean solve may unstack the drawer once it fits
  beside the plate with the same margin; a fault while height-limited raises the
  floor to the plate's width plus `FLOOR_STEP` (48) -- the floor never drops
  while the selection stands; a fault that is not height-limited raises it to
  `plateWidth + 1` and stacks the drawer if it was beside, else switches to the
  phone views. A solve is clean when `countFaults()` finds no label pair, no
  label clipped by the plate, no label touching a marker and no two markers
  overlapping. `reportSettled` feeds it at every exit of `measure()` where no
  further pass is scheduled, and drops a report that is stale (the svg's scale
  is not the state's) or made while `document.fonts` is loading. A status
  selection resets the state to `initialRadarState(room)`, so the floor is
  learnt per selection. Every `setRadar` bails out when nothing changed, so a
  `ResizeObserver` tick costs no render.
- **Observations are measured, not assumed.** `room` is the `.timeline-main`
  width less the frame's chrome and the scroller's padding. `heightLimited`
  compares the plate with the scroller's _actual_ content width, not with
  `room`: beside the drawer the plate is narrower than `room`, and comparing
  with `room` would call every drawer-beside plate height-limited and raise the
  floor where the drawer should stack. `drawerSpace` is the drawer's computed
  `flex-basis` (320px) plus the column gap, not its `offsetWidth`: a closed
  drawer is `hidden` (0), a stacked one is full width, and neither says what it
  takes beside the plate -- a 0 would unstack on every close and re-stack on
  every open.
- **Opening a record never swaps the radar for the list.** Above 1100px the
  drawer sits beside the plate; if that leaves the plate below its floor the
  drawer stacks instead (`data-stack="true"` on `.timeline-main`, which carries
  the same declarations as the 1100px query -- a selector list cannot span an
  `@media` boundary, so they are written twice, each pointing at its twin).
- **The phone views** (`components/timeline/MiniRadar.tsx`, `PhaseList.tsx`),
  rendered _instead of_ the radar, never both, so the phone branch mounts no
  marker buttons: a small radar with no drug or population names (the same
  `computeTimelineLayout`, markers with their rings and holes, a population
  legend under it, `role="img"` with a pluralised summary label) and a list of
  the same status-filtered trials grouped by `parentPhase()` in ring order,
  most advanced first, rows alphabetical, a sub-phase printed beside the name,
  a trial with no ring left out as it is off the radar. Rows are buttons with
  `aria-expanded`/`aria-controls`, at least 44px, and open the same drawer
  element, which survives the switch. `data-mode`, `data-floor` and
  `data-stack` are on the layout and are what the generic e2e reads
  (`e2e/tests/helpers/timeline.ts`: `settleRadar` waits for two equal reads
  250ms apart). Focus restore on close resolves `(mode === "phone" ? rowRefs :
  markerRefs)[restore]` at the moment of restore, so a trial opened in one mode
  and closed in the other returns focus to its counterpart.
- **The tip says tap on a touch screen.** Both wordings are in the first
  `TipBox`; `@media (hover: none)` / `(hover: hover)` shows one and
  `display: none` hides the other. Hover capability, not width, is what makes
  "Hover over..." wrong: a narrow desktop window still hovers.
- **Observed floor for the committed data, Chromium on Linux, 2026-11-09**
  (`data-floor` after `settleRadar`): 0 at 1440x900, where the plate is 880px
  and clean at the height fit; 716 at 1280x720, where the height fit alone
  faulted and the floor was learnt at 716px, so the page scrolls vertically.
  These are observations of this dataset, not constants; the specs derive
  their widths from `data-floor` and pin neither.

**The key sits above the plate, collapsed** -- a `<details class="figure-key">`
closed on load, the phenogram's arrangement too; open, six families of long mechanism names pushed the radar below the fold. The skip link
targets `#timeline-end`, a focusable `.figure-end` line after the plate, not the
key: "skip the figure" has to land past the 100-odd marker buttons.

`.timeline-legend` stays a **size container**, so its panels lay out by the
width the key actually has rather than by the viewport's — one set of rules for
every width. Both it and the mechanism families inside it are `auto-fit` grids
written `minmax(min(19rem, 100%), 1fr)`: a bare `minmax(19rem, 1fr)` makes that
a hard floor, and below 19rem of container the tracks overflow rather than
collapsing to one column, which is a 1px horizontal scrollbar at 320px. The
mechanism rows are not chips — every mechanism name wraps at this measure, and a
wrapped pill is a box with round ends.
