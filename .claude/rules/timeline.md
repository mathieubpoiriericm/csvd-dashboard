---
paths:
  - "islands/TrialsTimeline.tsx"
  - "lib/timeline.ts"
  - "lib/timeline_encoding.json"
  - "scripts/timeline_figure.py"
  - "tests/timeline_*.ts"
  - "tests/scripts/test_timeline_figure.py"
  - "e2e/tests/timeline.spec.ts"
---

# Timeline

`islands/TrialsTimeline.tsx` draws the trials radar — population sectors × phase
rings × one marker per trial — from `data/table2.json`, the way every other
island reads its data.

The figure has two renderers and one contract:

- `lib/timeline_encoding.json` is the only place styling lives — population
  order, each population's wedge colour and the deeper `band` step of it, ring
  radii and opacities and the rim band's `gap` and `width` (all fractions of the
  outer radius), the `boundary` hairline between cells, the empty-cell style,
  the three `evidenceStates`, the `recordFlag`, and the mechanism palette with
  its `families` grouping. `tests/timeline_encoding_test.ts` fails when the
  committed data contains a population, phase, mechanism or evidence value the
  file does not cover, when two mechanisms share a colour, or when a mechanism
  sits in no family or in two. Add the entry; do not widen the test. The palette
  is one hue per family with lightness steps inside it — eleven
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
  of the second.** The first relaxes the boxes vertically. That deadlocks
  against the markers — it leaves 63 pairs of the committed labels touching and
  53 labels lying across a marker they do not belong to, and 12 passes and 1000
  reach the same count — so the second re-places every label still caught in an
  overlap at the nearest free offset on a grid of vertical _and radial_ steps,
  radial meaning along the box's own `outward` unit vector. Both counts go to
  zero, and `e2e/tests/timeline.spec.ts` pins them there rather than bounding
  them, with a control pair and a box count in place of the lower bound the old
  ceiling carried. Any label left further from its marker than its own height
  gets a leader line back to it, which is what keeps the label attributable: 55
  of the 111 do. The enlarged plate (`CANVAS`/`OUTER_RADIUS`, 1.3x the retired
  figure's radius) is what makes that cheap rather than what clears the labels —
  it takes the relaxed figure from 123 collisions to 63, and the median
  displacement from 68 units to 18.
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
`"(unknown)"` is not a flag**: the encoding gives it a first-class outermost
ring and `PHASE_CHOICES` calls it "Phase not stated", so the geometry already
says it. A completion date in the past is not one either — 69 committed rows
have one, because they are completed trials.

**A seamless trial gets a ring of its own, and that is a correction rather than
a flourish.** The rings are seven now --
`IV, III, II/III, II, I/II, I,
(unknown)` outward -- because both renderers
place a marker by comparing `clinicalTrialPhase` to the ring's phase for
**equality**, so the `II/III` and `I/II` ClinicalTrials.gov registers for a
seamless design matched no ring and was drawn nowhere while Table 2 listed it.
Collapsing one onto a component ring was the cheaper fix and is wrong for the
artifact that matters most: the print figure has no drawer, so a reader of
`deno task figure` output would have no way to recover that NCT03451591 is
LACI-2, a phase II/III trial, from a marker sitting on the III ring.
`_unplaceable_phases` in `pipeline/clinical_trials_fetch.py` reports what is
left -- `Early Phase I` and the rarer joins -- and reads `RADAR_PHASES` off this
encoding, so adding a ring stays one edit.

**The outermost band may not be narrowed to make room for a new ring**, and that
is the trap this cost. A marker sits at its ring's midpoint, so a thinner
outermost band pushes the outermost markers -- and the drug labels outside them
-- towards the plate edge, where the margin is only `CANVAS / 2 - OUTER_RADIUS`
= 120 units. Splitting `0.4..1.0` into six equal `0.1` bands moved them 6.7
units out and tipped the 22-character "Stellate ganglion block" over the right
edge under **Linux** font metrics while it still fitted on macOS -- so the local
suite passed and CI failed. The five inner bands are `0.09` and `(unknown)`
keeps its `0.15`; `tests/timeline_encoding_test.ts` pins the resulting radius
rather than the width, because the radius is what the label layout has to clear.

**It gets no `PHASE_CHOICES` entry, though**, and the asymmetry is deliberate.
`matchesPhase` in `lib/filters.ts` reads each Roman token, so a `II/III` trial
already answers both "Phase II" and "Phase III" -- which is the question the
table is asked, _does this trial cover phase II_. A choice whose value is the
literal `"II/III"` would match nothing, because the tokens are compared and
neither is that string. The figure is asked a different question, _where does
this marker go_, and only there does a band of its own make sense.

`FLAG_REASONS` is exported rather than restated, and
`tests/timeline_encoding_test.ts` reconciles it against `recordFlag.reasons`, so
a rule added without its wording fails the suite instead of rendering a bare key
in the drawer.

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

Two SVG details are load-bearing: attribute names on SVG elements are
case-sensitive, so the groups carry `tabindex`, not `tabIndex` (Preact writes
the prop name verbatim, and a `tabIndex` attribute makes nothing focusable);
`.timeline-main` is a flex **row** of its own (drawer, then the framed
scroller), not a member of the phenogram's column rule -- folding it in there
put the record above the plate. And below 1100px `.timeline-main` — the
drawer-and-plate row — must `align-items: stretch`, or the scroll container
sizes itself to the 1072px plate and the document overflows instead of the
container scrolling. `.timeline-layout` needs the same, which it gets from being
a column at every width.

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
