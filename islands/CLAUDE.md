# Islands

Island-specific guidance. The root `CLAUDE.md` lists all eight islands; the
tables, the timeline and the phenogram, whose contracts span `lib/` and
`scripts/` as well, are in `.claude/rules/`, which load with their files.

## Map

`islands/TrialsMap.tsx` draws the geocoded facility sites on an OpenStreetMap
raster basemap. Leaflet stays at **1.9.4** deliberately. MapLibre GL is the
actively developed alternative — Leaflet's last stable was May 2023 — but costs
288 KB gzip against the current 55 KB, and everything it adds (vector tiles, GPU
rendering, pitch/rotate, 3D terrain) is unused for static points on raster
tiles. Leaflet 2.0 drops the global `L` and every factory function; it has been
in alpha since May 2025, and `leaflet.markercluster` (last released
October 2021) reads that global as its module body evaluates. The 2.0 blocker is
the plugin, not this code.

Seven things are load-bearing:

- **Import order is not optional.** Leaflet touches `window` at import time, so
  it is `await import()`ed _inside_ the effect; hoisting it to module scope
  breaks SSR. `leaflet.markercluster` is imported _sequentially_ after it — a
  UMD bundle that reads the global `L` while evaluating but imports nothing from
  Leaflet, so the module graph does not order the two. A `Promise.all`, or a
  swapped order, breaks the map at runtime.
- **Circle-marker paths need manual accessibility.** Leaflet sets `tabIndex`
  only on `Marker` icons, never on `Path`/`CircleMarker`. Every site path is
  therefore named, made focusable, and given Enter/Space popup activation in the
  layer's `add` handler. Markercluster removes and re-adds those layers and
  Leaflet creates a fresh SVG path each time, so decorating only the first
  `getElement()` result is not enough. `LocationList` remains the complete text
  alternative — a `.visually-hidden` list built from `visibleLocations`, the
  same status-filtered set the markers draw from, so it stays in sync with
  whatever the status selection currently shows rather than the full 378.
- **That list is plain text on purpose.** `.visually-hidden` clips rather than
  hides, so anchors inside it would stay in the tab order and strand focus
  off-screen once per visible site. Registry links live in the marker popups and
  on the trials table instead. An e2e assertion pins `.visually-hidden a` at
  zero.
- **The container needs its own accessible name.** Leaflet's keyboard handler
  forces `tabIndex = 0` on the map container, so the JSX supplies
  `role="application"` and an `aria-label`; without them it is a focusable
  element with no name.
- **`detectRetina` and `maxZoom` interact.** On a retina display Leaflet halves
  `tileSize`, bumps `zoomOffset` and _decrements_ `maxZoom`, so `maxZoom: 19`
  plus `detectRetina` fetches z19 tiles at map zoom 18 — sharper, and never
  requesting the z20 OSM does not serve. Net zoom reach is unchanged, so raising
  either alone will not do what it looks like.
- **The tile URL carries no `{s}` subdomain, and `worldCopyJump` is on.** The
  OSMF tile policy discourages the a/b/c aliases now that the server speaks
  HTTP/2 and HTTP/3, where they buy no request concurrency and only fragment the
  cache. `worldCopyJump` is needed because the basemap wraps while vector
  markers are drawn once — without it, panning past the antimeridian lands in an
  empty copy of the world.
- **The cluster layer is rebuilt per status selection.** `populate(locations)`
  clears the layer, disposes every marker cleanup and re-adds the visible set;
  the per-add accessibility decoration and the popup host lifecycle run again
  for each, which is why they live inside the loop and not in a one-time setup.
  `fitBounds` runs once, on the first population.

Do not add `as any` back to the `markerClusterGroup` call, for the same reason
the `useTable` call carries that rule: `@types/leaflet.markercluster` augments
the `leaflet` module, so it type-checks without one.

## Pipeline run widget

`islands/PipelineRun.tsx` renders the last recorded run on the About page from
`data/pipeline_run.json`, replacing the four-number card that read
`data/pipeline_status.json`. Both files still exist and both are still written:
the card is the fallback, because the report is `null` until a run records one
and a database that has not taken migration 009 keeps it that way. Exactly one
of the two renders — two accounts of the same run would invite them to disagree,
which is what this replaces.

The pipeline half is in `pipeline/CLAUDE.md`. On this side:

- **`lib/pipeline_encoding.json` is the single source of truth for every label,
  glyph and tint**, in the pattern of the two figure encodings.
  `tests/pipeline_encoding_test.ts` reads the vocabularies out of the Python
  source — `RunStatus`, `StepStatus`, `ErrorKind`, `WarningKind`,
  `PIPELINE_STEPS`, the documented `run_mode` values — and fails when one has no
  entry here, or when a glyph it names does not resolve in
  `components/Icon.tsx`. Add the entry; do not widen the test. Restating a
  vocabulary is how `PVWMH` ended up with no filter choice and no phenogram
  entry; the same failure was available here, silently, as a fallback glyph with
  no hint.
- **`lib/pipeline_display.ts` is the only formatter.** A failure, a paper count,
  a service name and a byte count all read as one system because they all go
  through it. Two rules are load-bearing: `formatDuration` prints milliseconds
  under a second, because a step that took 40 ms and one that took 0.9 s are
  different facts; and it never emits `"2m 60s"`, which is what rounding 179.6
  the obvious way produces.
- **The island takes no props.** Fresh serialises island props for hydration and
  a run report does not survive that trip — the widget renders server-side and
  then never becomes interactive, with **nothing in the console to say so**.
  Every island here reads its own data; this one reads `pipelineRun`. The `run`
  prop exists only for `tests/pipeline_widget_test.tsx`, which is why the
  widget's contents are tested there rather than through the route.
- **`aria-expanded` is passed as a string.** Preact 10.29.8 renders an `aria-*`
  attribute whose value is boolean `false` (`props.js`'s guard admits it via
  `name[4] == '-'`), so `aria-expanded={expanded}` would work here too. The
  string form is house style, not a workaround: it keeps every `aria-expanded`
  in the codebase spelled the same way rather than mixing boolean and string
  forms case by case.
- Status is never colour alone: every badge pairs its tint with a glyph _and_ a
  word, and every drawer field is named in words beside its value. The four
  status tints resolve through semantic tokens the dark blocks already override,
  so the block adds no dark counterpart. A fifth tint, `highlight`, is
  deliberately not a status: it is the amber wash under a "Low confidence"
  rejection, drawn with the page's own ink, because a score under the floor is
  the routine outcome of a run and in ember it read as an alarm on every card.
  (`.pipeline-tint-ember` keeps its name and no longer resolves the accent: on a
  mono steel palette that would make "Passed with warnings" the same colour as
  every link on the page, so it reads `--svd-color-warn`.) "Quote not in paper"
  carries it for the same reason — the verbatim gate dropping a gene is a filter
  doing its job, not a failure.
- **A step with nothing to expand is a disabled button, not a dimmed one.** It
  is a real step that had nothing to report; greying it would read as "did not
  run", which is what `skipped` means.
- Detail lists are capped at 200 by the exporter and the UI states the
  truncation (`Showing 200 of 1,412`). `lib/data/pipeline_run.ts` recomputes
  `shown` from the items actually present rather than trusting the file, so a
  count that disagrees with its own list cannot make the UI lie.
- **"Accepted" is `acceptedGenes.total`, not `validated` less the holds.**
  `validated` counts one per paper and a hold counts one per merged gene, so
  COL4A1 and COL4A2 validated from two papers and held once as COL4A1/2 came out
  as one gene accepted when none was. The list's total is exact even when the
  list itself is capped, and it is the number the drawer's heading shows, so the
  two cannot disagree.
- **The drawer exists only when there is something in it.** A run that failed
  before it processed a paper records no papers, no genes and no API calls; the
  trigger and the `<aside>` are not rendered at all rather than opening on an
  empty panel. The services count towards that because they are _in_ the drawer:
  **External services lives there, not on the card.** Endpoint paths and HTTP
  verbs (`GET /entrez/eutils/efetch.fcgi`, `POST /v1/messages`) are a
  maintainer's register, and the card sits a few hundred pixels above a Data
  Sources panel that names the same class of thing — external sources the run
  consulted — in prose. Two registers for one concept on one page; the drawer is
  where the maintainer-facing record already was.
- **The drawer is deliberately not a member of the surface recipe.** It sits at
  `inset: 0` inside `.pipeline-card`'s own padding box, so a frame of its own
  drew a second hairline directly on the card's — and now would draw a second
  set of registration marks 6px inside the card's, which is the same doubled
  contour. It takes the card's radius with `border-radius: inherit`, paints
  `--svd-surface`, and nothing else. Its padding is `--svd-space-5` to match
  `.card-body`, or the heading jumps 4px as it opens.
- **Inside the drawer, each kind of thing has one look.** When everything was
  the same boxed chip — field names, values, numbers, links — nothing said which
  was which. Now:
  - A field's name is a `<dt>` in an 11rem label column, beside its `<dd>`.
  - A value from a fixed vocabulary (trait, omics method, paper source) is a
    neutral pill (`ValuePill`).
  - A verdict (a rejection reason) is a tinted pill with a glyph.
  - A number or identifier is plain text that says what it is: "Confidence 0.90
    · PMID 41001161", "11 s · 2 accepted · 1 rejected" (`describePaper`).

  Records are rows ruled by hairlines, not framed surfaces, and a rejected
  record is not painted danger; its verdict pill carries the colour. The 11rem
  column is `.pipeline-api-name`'s measure too, so gene names, field names,
  PMIDs and service names all share one left edge. Below 600px each name sits
  above its value.
- **Every step header is its own grid**, so no column is shared down the list.
  Three things do the aligning and all three are load-bearing: a `min-width` on
  `.pipeline-step-time`, `justify-self: end` on the badge, and **the caret
  rendered on every step** — hidden with `visibility` when there is nothing to
  expand, never dropped. Dropping the element drops its column with it, which
  left the last row's badge and duration hanging 16px past the five above.
- Lists are keyed by position, not by text. A re-entered step merges its visits'
  actions, so two visits that did the same thing produce the same sentence, and
  two services with the same label and count produce the same warning title; a
  text-keyed list collapsed them.
- `paperSources` in the encoding is where `PaperResult.source` becomes words.
  `none` and `unknown` are the pipeline's sentinels for "retrieved nothing" and
  "never got that far", and a chip reading "Source: none" put the sentinel in
  front of the reader. `tests/pipeline_encoding_test.ts` reads the literals out
  of `pipeline/pdf_retrieval.py` and `pipeline/main.py`, so a new source fails
  the test rather than rendering raw.

## Reference data refreshes

`routes/index.tsx` passes the normalized refresh data to
`components/PipelineSyncs.tsx`, which renders it directly below the run widget.

- **A sibling block, not a section of the widget or its drawer.** "Exactly one
  of the two renders" above is about two accounts of _one run_; a refresh is a
  different event, with its own timestamp, outcome and upstreams, so it renders
  beside whichever of the two is showing. Folding it into the widget would make
  one card claim two things happened at once. It sits above the two-column grid
  whose right column is Data Sources, the panel whose names it echoes: the panel
  says what each source is, this says when it was last consulted and how that
  went.
- **Not an island**, because it holds no state — so it sidesteps the
  props-serialisation trap above, and its `runs` prop is a real prop rather than
  a test-only one. Promote it if a per-refresh drawer is ever wanted.
- **It reuses the widget's parts rather than restating them**: `.pipeline-head`,
  `.pipeline-badge`, and the same `.pipeline-apis > ul > .pipeline-api` shape
  the drawer uses, through the same `describeApi`. That is what keeps one
  service row reading identically in both places. Only the refresh rows
  themselves are new CSS.
- **`syncModes` is its own encoding vocabulary**, reconciled against
  `SYNC_MODES` in `pipeline/steps.py` by `tests/pipeline_encoding_test.ts`,
  which also fails if a key appears in both `runModes` and `syncModes`. The
  labels name what was refreshed ("Disease annotations"), not the flag that
  starts it, because that is what the reader is looking at.
- Source labels ride the wire rather than the encoding, as `ApiServiceRecord`'s
  label does: which database was consulted is data, not appearance. They are
  **re-derived at export**, though: `read_pipeline_run` and `read_sync_runs`
  pass every api row through `relabel_api_rows` in `pipeline/api_telemetry.py`,
  so a rename in `SERVICES` (or a newly registered publisher host) reaches
  `data/pipeline_run.json` at the next `deno task data` rather than the next
  run. The cost is unchanged: a new upstream renders whatever Python calls it
  with no contract test failing.

## The adapt wizard

`AdaptWizard.tsx` is the one island that imports no data file. Everything it
computes lives in `lib/adapt/` under the 100 % floor: the `Answers` model,
`validate()`, the lookups (every function takes the fetch to use, so the island
passes its own and the tests pass a stub), the generators and `bundle()`. The
island's fetch is `spaced()` (`lib/adapt/edits.ts`): requests to NCBI start 350
ms apart, 110 ms with an API key, across every lookup at once, because a lookup
costs several requests a row (four for a gene) and a burst over the limit is a
429. The draft is kept in `localStorage` under `svd-adapt-draft`
(`lib/adapt/draft_storage.ts`); the literal scan matches the short form as
written, so the lower-case `svd-` keys need no allow-list entry. `fflate` is the
zip writer and is imported only by `lib/adapt/bundle.ts`. The step forms under
`components/adapt/steps/` take props because they render inside the island, not
as islands. The island loads nothing of the dataset: `lib/adapt/validate.ts` and
the manifest reach their shared helpers through public modules
(`lib/normalize.ts`, `lib/sentinels.ts`, the `shared` chunk), and
`server/protected_data_build.ts` fails the build if the island's chunk reaches
the protected one, directly or through another chunk.

Nine things are load-bearing:

- **The island guards its own form.** It is a `<fieldset>` disabled until the
  stored draft has been read, because text typed into the server's HTML before
  hydration reaches no state and vanishes; until then it is faded with a
  progress cursor and a "Loading the wizard…" note says it needs JavaScript
  (`routes/adapt.tsx` adds a `<noscript>` pointing at the guide). Every lookup
  runs through `lookup()`, one at a time, and each step keeps its own status
  line (`statuses`): a result lands on the step it ran for, stays there while
  the researcher is elsewhere, and the one live region shows the current step's.
  A refused save is its own `role="alert"` notice rather than a status line,
  which every lookup rewrites, and while it stands closing the tab asks first
  (`beforeunload`). Both sit in `.adapt-messages`, pinned under the navbar while
  the step scrolls, because the button that caused them is usually far down the
  step. The new step's heading takes focus in a _layout_ effect: a passive one
  ran a frame late and took focus from a field clicked in the meantime. Pressing
  the current step's own segment does nothing: it would clear the step's line
  and refold the open card.
- **The stored draft is never lost to another version or another tab.** A draft
  `parseDraft()` cannot read -- another `DRAFT_VERSION`, damaged JSON -- is
  copied to `svd-adapt-draft-unreadable` before the first save and offered for
  download; bump `DRAFT_VERSION` only for a shape `STEPS_SHAPE` cannot rebuild,
  since every older draft then takes that path. The logos live under keys of
  their own (`-logo-light`, `-logo-dark`), written only when their bytes change,
  so a keystroke does not rewrite a megabyte. A save from another tab is merged,
  not adopted wholesale (`mergeDrafts()`: three-way against the draft both last
  agreed on, this tab winning a leaf both changed), so two tabs stay one draft
  and a tab whose saves are refused keeps its answers. Start over and an import
  write `svd-adapt-draft-replaced`, and a tab seeing it drops what it had
  revealed.
- **Every entry of a list a step iterates is an object.** A lookup that writes a
  row back by index must go through `alignMeshTerms()` rather than stretch the
  array: a hole serialises as `null`, `validate()` then throws on the reload
  before anything renders, and the page that would have held "Start over" is
  blank. The stand-in it adds names no phrase, because a MeSH row answers only
  the phrase it names: one naming its phrase with no heading means "MeSH has no
  heading for this", which is an accepted answer, and a phrase whose lookup
  failed or never ran must not read as one. `parseDraft()` rebuilds a draft
  against `STEPS_SHAPE` for the same reason: a mistyped field takes its empty
  value, a mistyped list entry is dropped, and a logo whose base64 does not
  decode is no logo, since `bundle()` decodes it on every render of the Review
  step. A field added to `Answers` needs its line there, or a reload drops it.
- **A field whose answer is stored parsed is a `ParsedTextField`.** The comma
  lists and the confidence render their stored value back, which rewrote the
  field under the cursor (a trailing comma or a half-typed "0." vanished), so
  only a paste could enter a second item. Playwright's `fill()` pastes, which is
  why only the key-at-a-time spec in `e2e/tests/adapt.spec.ts` sees it.
- **The NCBI credentials leave the browser in nothing.** Both the archive entry
  and "Export answers" write `exportableAnswers()`, which blanks `search.ncbi`;
  the archive is committed to a repository and the export is mailed around.
- **A key is compared trimmed on both sides.** The generators write keys,
  labels, symbols and mechanism names through `clean()` and `validate()`
  compares them with the same trim, so a trailing space cannot make a family
  trait-less in one file and full in the next.
- **A step's own handler cannot be reached from a test.** `jsx: "precompile"`
  renders an element's `onClick` as an attribute, so it never lands in the vnode
  tree: logic worth testing belongs in `lib/adapt/` (`meshRow()`,
  `alignMeshTerms()`), which is where the 100 % floor is anyway. The same
  compilation drops the `key` of an intrinsic element it turns into a template,
  so a keyed list row is a component (`ListRow` in `ListEditor.tsx`), or the row
  that takes a removed one's place inherits its typed value.
- **The lookups parse what the live APIs return, not the interview's trimmed
  samples**, and the stubs in `tests/adapt/lookups_test.ts` and
  `e2e/tests/adapt.spec.ts` copy the live shapes. Three differ from what a
  sample suggests: ClinVar files a record's traits under
  `germline_classification` (a top-level `trait_set` is gone, and reading it
  found nothing for every gene); `efetch` answers a PMID with no record with a
  200 holding only `1.`; and NCBI Gene's `[sym]` matches aliases and former
  symbols, so `officialSymbol()` reads each hit's `name` back and stores the
  spelling HGNC writes.
- **A field speaks on a timetable, and the timetable is
  `lib/adapt/feedback.ts`.** An offending character (`lib/adapt/characters.ts`)
  is red at once; what an incomplete value still needs is a muted note while it
  is typed; red otherwise waits until the field is left after an edit, or its
  card (Continue) or step (Next, "Show what's left", Go to) is revealed. Back
  and the stepper reveal nothing. A field left by a press on a button waits for
  the pointer's release: the message it shows moves what is below it, and shown
  on the press it moved the button out from under the pointer and the click was
  lost. The touched state is "step:path" keys in the island, never saved;
  `forgetRemoved()` shifts them when a row goes. The fields, notes and cards
  read it through `WizardContext`, so no step renders a new function prop and
  the steps and `ListEditor` stay hook-free — `tests/adapt/steps_test.tsx` calls
  each step as a function and walks into `Card` rather than calling it. A folded
  card's body stays in the page with `hidden`: the e2e helpers open the card
  holding a field, and focus can land in it the moment it opens.
  `.adapt-card-body` sets its own `display`, which outranks the user agent's
  `[hidden]` rule, so `.adapt-card-body[hidden]` puts the fold back; without it
  every card drew open. A step's open card is decided once, as the step is
  entered (`entryCard()` in `lib/adapt/cards.ts`, for the answers it is entered
  with), and then held: only opening, folding or Continue moves it. Worked out
  on every render, typing a card's last required key folded it and left focus in
  a hidden field. Continue, "Show what's left" and Go to open the step's first
  unfinished card and focus the first open control _as the page orders it_
  (`firstInPage()` in `lib/adapt/feedback.ts`), not validate()'s emission order,
  which checks the key before the name. Tabbing from a field to its own fix
  button is not leaving it; tabbing off the fix button is (`targetField()`).
  Every path `validate()` emits belongs to exactly one card
  (`tests/adapt/cards_test.ts`), which is what stands in for the step-level
  issue list this replaced.
