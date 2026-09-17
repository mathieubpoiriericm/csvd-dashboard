# De-emphasise trials whose record never names small vessel disease

## Context

The trials radar draws all 111 curated rows of `data/table2.json` as equal
markers. Nothing on the plate says how firmly a given trial is anchored to
cerebral small vessel disease: a CADASIL trial and a general vascular-dementia
trial read identically, even though the second one's record never mentions small
vessel disease at all.

This adds a third derived confidence channel beside the two the figure already
has — the evidence ring (did anyone assess the drug's genetics) and the hollow
centre (is the record too thin to read at face value). The new one asks: **does
the published record name a small-vessel-disease term anywhere?** When it does
not, the marker is drawn at 50 % opacity and its tooltip and drawer carry a red
warning that the trial's relevance is undocumented and may be contested.

### Why not the literal phrase

The request was "no mention of _small vessel disease_ anywhere in their entry".
Taken as a literal substring that dims **63 of 111** markers — including all 8
CAA trials, all 7 CADASIL trials in the SVD sector, and every lacunar-stroke
trial. Those are the paradigmatic cSVD entries on the plate; they name their
subtype rather than the umbrella term. Confirmed with the user: the rule matches
a **cSVD vocabulary**, not one phrase.

Measured against the committed data, that dims **28 of 111**:

| Population           | Dimmed | Of |
| -------------------- | ------ | -- |
| Cognitive Impairment | 23     | 44 |
| Stroke               | 5      | 28 |
| CAA                  | 0      | 8  |
| SVD                  | 0      | 31 |

Almost all 28 are vascular-dementia trials, where cSVD is presumed rather than
documented; the 5 stroke rows are 4 Covert Brain Infarction and 1 mixed
ischemic-stroke/MCI trial. That is the population the channel exists to mark.

### What the warning may claim

`resolveRecordFlag` is documented to say "thin or self-declared uncharacterised,
nothing more" — the figure emits no machine verdict, because
`pipeline/opentargets_drugs.py` measured that every textual-agreement rule it
tried flagged a pair known to agree. A relevance verdict from a keyword scan, on
28 rows a curator deliberately included, is the same class of claim. Confirmed
with the user: the warning is red and invites challenge, but states what the
scan found rather than asserting the trial is irrelevant.

> ⚠ **Relevance not documented** — No small-vessel-disease term appears anywhere
> in this record. Inclusion may be contested — see the source registry.

No new contest UI; the registry ID is already a drawer field.

### Out of scope

A red chip beside the drug names in the trials table was considered and
**dropped**. Recorded because the reason is worth keeping: the Drug cell is
row-merged by `spanWithinDrug` (along with Genetic Target, Phase and SVD
Population), and 5 drugs mix documented and undocumented trials — Butylphthalide
(5 documented, 1 not), Atorvastatin (3/1), Galantamine (1/2), Cerebrolysin
(1/1), Clopidogrel (1/1). A chip on those merged cells would qualify trials it
does not apply to. Carrying it properly means either splitting the merged block
on the flag, or accepting that 5 of the 28 rows go unflagged in the table while
staying faded on the radar. Neither is decided; this change is the radar only.

## The rule

### Vocabulary lives in the encoding, not in either renderer

`lib/timeline_encoding.json` gains a sibling block to `recordFlag`:

```json
"svdMention": {
  "opacity": 0.5,
  "label": "Relevance not documented",
  "legend": "Faded marker — no small-vessel-disease term in the record",
  "warning": "No small-vessel-disease term appears anywhere in this record. Inclusion may be contested — see the source registry.",
  "terms": [
    "small vessel disease", "small-vessel disease", "svd", "csvd",
    "cadasil", "carasil", "lacun", "leukoaraiosis",
    "white matter hyperintensit", "white matter lesion",
    "amyloid angiopathy", "caa", "microbleed", "perivascular space",
    "binswanger", "microangiopathy", "vascular cognitive", "vci", "wmh"
  ]
}
```

Both renderers already read this file, so the word list is defined **once** —
unlike `FLAG_REASONS`, which is twinned because its keys are code. Only the
matching function is twinned.

Six terms (`carasil`, `leukoaraiosis`, `perivascular space`, `binswanger`,
`microangiopathy`, `small-vessel disease`) match nothing in today's data. Keep
them: `--clinical-trials` sweeps add rows from ClinicalTrials.gov, and the
vocabulary is forward-looking. **Do not write a test asserting every term hits a
row.**

### Matching

Case-insensitive, over the concatenation of all 13 `Trial` fields, with a
**leading word boundary only** on each term. Leading `\b` is what stops the
`OD`-inside-`NODDI` class of error that `lib/vocabulary.json` warns about for
the trait folds; no trailing `\b`, so `hyperintensit` catches both
`hyperintensity` and `hyperintensities`, `lacun` catches `lacunar`/`lacune`, and
`caa` catches `CAA-related`. Verified against the committed data: zero rows
differ between full word-boundary and leading-only matching, and no term
false-positives inside a longer word.

### Where it goes

`lib/timeline.ts`, directly beside `resolveRecordFlag`, in the same shape:

```ts
/**
 * Whether this record names cerebral small vessel disease anywhere.
 *
 * A keyword scan over every published field, never a judgement about whether
 * the trial *is* relevant: a curator put every row in this table, and the
 * vocabulary is a floor rather than a definition. This says the record does not
 * name the disease, nothing more -- the disposition `resolveRecordFlag` already
 * takes for a thin record.
 */
export function resolveSvdMention(
  trial: Trial,
  enc: TimelineEncoding = encoding,
): boolean;
```

`computeTimelineLayout` calls it in the marker loop beside
`flagReasons: resolveRecordFlag(trial, enc)` and freezes the result onto a new
`Marker` field:

```ts
/** Whether the record names a small-vessel-disease term; false fades the marker. */
mentionsSvd: boolean;
```

The layout also gains an `svdLegend` entry beside the existing `flagLegend`
(`{ legend, count }`), so the key can print "28 of 111" without recounting.

## Changes by file

### `lib/timeline_encoding.json`

Add the `svdMention` block above. Nothing else moves.

### `lib/timeline.ts`

- `TimelineEncoding` gains `svdMention`.
- `Marker` gains `mentionsSvd`.
- `resolveSvdMention` as above, compiling the terms into one regex at module
  scope rather than per call (111 rows × 19 terms otherwise).
- `computeTimelineLayout` sets the field and builds `svdLegend`.

### `islands/TrialsTimeline.tsx`

- **The marker group** carries the opacity and a semantic hook:

  ```tsx
  <g
    class={marker.mentionsSvd ? "drug" : "drug undocumented"}
    opacity={marker.mentionsSvd ? undefined : encoding.svdMention.opacity}
    …
  ```

  Group `opacity` composites the whole group once, so the disc, the white
  plate-cut stroke, the hollow centre, the evidence ring and the drug label all
  fade together as one unit — which is what "50 % opacity" means for a marker.
  It is an SVG attribute driven by the encoding, so the print twin shares the
  number and the theme rules still touch nothing.

- **The leader line is not inside `g.drug`.** Leaders live in a single
  `<g class="leaders">` drawn before the marker groups. The same predicate has
  to reach that map or a dimmed marker keeps a full-strength leader pointing at
  it — add `class={marker.mentionsSvd ? "leader" : "leader undocumented"}` and
  the matching `opacity` there.

- **`aria-label`** appends `encoding.svdMention.label` the way it already
  appends `encoding.recordFlag.label`.

- **The tooltip** gains a warning row ahead of the record-flag row, so the two
  qualifiers sit above the fields they qualify, most-severe first:

  ```tsx
  ...(marker.mentionsSvd ? [] : [{
    icon: "exclamationTriangle" as IconName,
    label: encoding.svdMention.label,
    value: encoding.svdMention.warning,
    tone: "danger" as const,
  }]),
  ```

  `tone` is a new optional field on the tooltip row type in `lib/tooltips.ts`,
  rendered by `components/Tooltip.tsx` as a class on the row. It is optional and
  absent everywhere else, so no other tooltip changes.

- **The drawer** gains a red sibling to the existing `.timeline-drawer-flag`
  block, above it, reusing its markup shape:

  ```tsx
  {
    !marker.mentionsSvd && (
      <div class="timeline-drawer-flag timeline-drawer-warning">
        <p class="timeline-drawer-flag-head">
          <Icon name="exclamationTriangle" />
          {encoding.svdMention.label}
        </p>
        <p>{encoding.svdMention.warning}</p>
      </div>
    );
  }
  ```

  The drawer is the accessible text — the tooltip is `aria-hidden` and
  pointer-only — so a tooltip-only warning would reach no keyboard or
  screen-reader user. This is the reach the record flag already has.

- **The key** gains a fourth panel between "Record completeness" and "Mechanism
  of action": one row, a 50 %-opacity swatch, `LAYOUT.svdLegend.legend` and its
  `28 of 111` count, in the shape the flag panel already uses.

### `assets/app.css`

- `.timeline-figure .drug.undocumented:hover`, `:focus-visible` and the matching
  leader rule restore `opacity: 1`, next to the existing `r` lift rules and for
  the same reason — opacity is not a colour, so this stays consistent with "data
  colours are SVG attributes, chrome is CSS". A CSS rule beats the presentation
  attribute on specificity, so no `!important`. Add `opacity` to the existing
  `transition` on those selectors.
- `.timeline-drawer-warning` overrides the flag block's tint with
  `--svd-color-danger`, the way `.warning-card` re-declares three recipe
  parameters rather than copying the gradient. The drawer is chrome beside the
  plate, so it follows the theme.
- **The tooltip red must be a fixed token.** The tooltip floats over the white
  plate and cannot follow the theme — that is why `--svd-figure-surface`,
  `--svd-figure-heading` and `--svd-figure-line` exist and are never overridden
  by the dark blocks. Add `--svd-figure-danger` and `--svd-figure-danger-wash`
  to the token block in the same way, declared once and absent from **both**
  dark blocks. `--svd-color-danger` would resolve to `--svd-red-400` in dark
  mode on a permanently-white panel. Start from `--svd-red-800`, the step
  already used as light-theme terminated-status text.

### `scripts/timeline_figure.py`

The strict twin. `resolve_svd_mention(trial, encoding)` beside
`resolve_record_flag`, a `mentions_svd` field on the marker dataclass, and
`alpha=` on the three `track.scatter` calls plus the two label artists for a
dimmed marker. Reuse the existing
`SVD_ALPHA = encoding["svdMention"]["opacity"]` read rather than a literal.

Two known asymmetries, worth a comment rather than a fix:

- matplotlib's per-artist `alpha` fades face **and** edge together, which the
  file already notes for the wedge hairline. The island's group opacity
  composites once. Visually equivalent at 0.5; not identical maths.
- No hover in print, so the CSS restore has no twin — as with the `r` lift.

The legend needs a fourth `_Swatch` entry drawing a dot at `alpha=0.5`.

## Tests

| File                                    | What to add                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/timeline_encoding_test.ts`       | `svdMention` in the local `ExpectedEncoding` interface; `opacity > 0 && <= 1`; `label`, `legend` and `warning` non-empty; `terms` non-empty, all lowercase, no duplicates.                                                                                                    |
| `tests/timeline_layout_test.ts`         | `markers.filter((m) => !m.mentionsSvd).length === 28`; `svdLegend.count` agrees; every CADASIL and every CAA row has `mentionsSvd === true`; a named Vascular Dementia row has it false.                                                                                      |
| `tests/scripts/test_timeline_figure.py` | The same 28 from the Python twin, so the two rules cannot diverge — this is the test that catches a one-sided edit.                                                                                                                                                           |
| `e2e/tests/timeline.spec.ts`            | `g.drug[opacity="0.5"]` count is 28; computed opacity of a known dimmed marker is `0.5` and a known full one is `1`; hover restores it to `1`; the key's fourth panel renders; opening a dimmed marker's drawer shows the warning block and a full-opacity marker's does not. |

The 28 is a committed-data number, so it joins the trial populations already
pinned in six places — note it in the root `CLAUDE.md` list.

## Docs

Root `CLAUDE.md`, the "Timeline" section: a third bullet beside the ring and the
hollow centre, stating the rule, the count, that the vocabulary lives in the
encoding and is deliberately broader than the literal phrase, and — the reason
this is worth writing down — that the warning says the record does not name the
disease and never that the trial is irrelevant.

`assets/CLAUDE.md`: `--svd-figure-danger` in the list of tokens fixed against
the dark blocks, with its reason.

## Verification

```
deno task check
deno task test:coverage
uv run pytest tests/scripts/test_timeline_figure.py
npx --prefix e2e playwright test -c e2e/playwright.config.ts tests/timeline.spec.ts
```

Then look at it, which is what the numbers cannot settle:

1. `deno task dev`, open `/trials-timeline`. The 28 faded markers should read as
   de-emphasised, not erased. **The specific thing to check is the white
   separator ring**: every marker is cut from the plate with a 2 px white
   stroke, and that ring — not marker-versus-wedge contrast — is what separates
   a marker from its ground. Marker-versus-wedge is already under 3:1 for 68 of
   the 83 undimmed markers, so it is not the mechanism at risk; the ring going
   translucent is. If separation is lost on the inner phase-IV wedges, raise the
   encoding's `opacity` rather than special-casing.
2. Hover and Tab to a dimmed marker: it should return to full strength, and the
   red warning should appear in the tooltip on hover and in the drawer on Enter.
3. Measure the tooltip warning's red on a **screenshot**, not against white — it
   sits on its own wash inside the panel. ≥ 4.5:1 for the text. Check both
   themes; the tooltip must look identical in each.
4. `deno task figure` and open the SVG: the same 28 faded, the fourth legend
   entry present, and the words still selectable in the labels.
