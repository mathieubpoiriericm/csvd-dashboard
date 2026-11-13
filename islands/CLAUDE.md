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

Ten things are load-bearing:

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
- **`removeOutsideVisibleBounds` is off, because pruning closes popups.** On
  mobile, markercluster prunes markers at the bare visible bounds (desktop pads
  them by a screen in every direction). A phone's map is about as tall as a
  popup, so opening one autopans its own marker off the map; the `moveend` prune
  then removes that marker, and Leaflet closes a bound popup when its layer is
  removed. A tapped popup flashed open and vanished. The touch-screen test in
  `e2e/tests/map.spec.ts` pins it.
- **A popup is fitted to the map, never scrolled.** The committed popups run to
  463px at 320px wide, taller than a short phone's map, so the head or the
  registry link was cut off by the map's edge. `fitPopup` zooms the popup body
  as the timeline drawer does (`fitZoom` in `lib/drawer_fit.ts`, floor 0.85)
  into the map's height less the popup chrome, the marker's reach and the
  autopan padding; past the floor the map grows while the popup is open and
  `releaseMapHeight` gives the height back on close. It then calls
  `popup.update()`, because Leaflet laid the popup out and began its autopan
  before `popupopen`.
- **The phone map is `clamp(380px, 65svh, 480px)` so the fit is the exception.**
  At a flat 380px 69 of the 70 committed popups were zoomed at 393x852. At 480px
  none are at 393x852 or 430x932 and one is, to 0.98, at 360x740. A 320x568
  phone keeps 380px and the fallback (66 of 70 grow the map), because a map
  filling a touch screen pans under a one-finger drag and the page cannot be
  scrolled past it. The cost is grey under the opening world view, 224 of 480px
  rather than 124 of 380px; popups open only once the map is zoomed in, where
  tiles fill any height.

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
which is what this replaces. **Neither renders by default while `GOLD_ONLY` is
on** (`lib/gold_only.ts`): the About page shows the notice instead, rendered by
the `PipelinePreview` island. With a report present the notice adds an
invitation and a switch (`role="switch"`, disabled until the island is live);
switching on shows the widget directly beneath it, marked "Technical preview",
and writes the cookie `pipeline_preview=1` (one year, `Path=/`, `SameSite=Lax`),
which `routes/index.tsx` reads (`previewRequested`,
`lib/pipeline_preview_request.ts`, kept apart so no `@std` import reaches the
island's bundle) so the next visit renders it already open. With no report the
notice is the plain line, drawn by the route with no island at all, and the
widget's own e2e specs skip while `GOLD_ONLY` is on.

**The switch holds no data, and must not import any.** It is on the page for
every gold-only visitor, and the run report is a protected chunk that is never
cached (219 KB, 42 KB compressed, for the 365-day run), so one static import in
`PipelinePreview.tsx` puts the report and the widget on every visit. The route
hands it two serialisable props, `initialOn` and the run's `daysBack`, and the
widget reaches the page one of two ways: pressed on, the switch fetches
`PipelineRun.tsx` with a dynamic import and draws it; on already, the route
draws `PipelinePreviewWidget`, an island of its own directly after the notice,
whose chunk is fetched only by a page that shows it. The two islands hydrate
apart, so a press is announced (`announcePreview` / `observePreview` in
`lib/pipeline_preview.ts`) and the widget island follows it; neither imports the
other, and no run report crosses island props in either path.
`ON_DEMAND_ISLANDS` in `server/protected_data_build.ts` fails the build when the
switch's chunk reaches a protected one through static imports, and the About
spec watches the network: nothing of the report is requested until the first
press. A fetch that fails (offline, a deploy replacing the chunk under an open
page, an expired session) puts the switch and its cookie back off and says so in
the notice's second line, which is a live region for that reason. The sentence
asks for a reload, not another press: the same press imports the same dead
chunk, and a browser may keep a failed module for the life of the document.

It has two readers. A visiting researcher wants to know whether the data is
fresh and can be trusted; the maintainer wants to know how the run went. So the
card is a **verdict over a ledger**: when the run was and whether it completed,
three figures (papers read, genes written, source quotes verified), then one row
per step saying what came out of it. Everything else the run recorded is behind
**Run details**, a dialog.

The pipeline half is in `.claude/rules/pipeline/run-reporting.md`. On this side:

- **`lib/pipeline_encoding.json` is the single source of truth for every label,
  glyph and tint**, in the pattern of the two figure encodings.
  `tests/pipeline_encoding_test.ts` reads the vocabularies out of the Python
  source — `RunStatus`, `StepStatus`, `ErrorKind`, `WarningKind`,
  `PIPELINE_STEPS`, the documented `run_mode` values — and fails when one has no
  entry here, or when a glyph it names does not resolve in
  `components/Icon.tsx`. Add the entry; do not widen the test. The words of a
  step's row (`outcomes`), of the verdict, and of each tab of the dialog
  (`findings`, `papers`, `services`, `setup`) live there too.
- **`lib/pipeline_display.ts` is the only formatter.** Two rules are
  load-bearing: `formatDuration` prints milliseconds under a second, because a
  step that took 40 ms and one that took 0.9 s are different facts; and it never
  emits `"2m 60s"`, which is what rounding 179.6 the obvious way produces.
- **Every decision is a function in `lib/`, and the components render what it
  returns.** `lib/pipeline_ledger.ts` decides the card (what a step's row says,
  which warnings need a look, the verdict figures, the failed-run note) and
  `lib/pipeline_details.ts` the dialog (its tabs and counts, how rejections
  group, a paper's row, the services table's columns, Setup's rows).
  `jsx: "precompile"` leaves a component's branches out of a test's reach, and
  `lib/` is where the 100 % floor is. A new branch belongs there.
- **The island takes no props.** Fresh serialises island props for hydration and
  a run report does not survive that trip — the widget renders server-side and
  then never becomes interactive, with **nothing in the console to say so**.
  Every island here reads its own data; this one reads `pipelineRun`. The `run`
  prop exists only for `tests/pipeline_widget_test.tsx`, which is why the
  widget's contents are tested there rather than through the route.
- **`aria-expanded` and `aria-selected` are passed as strings, and must be.**
  Preact 10.29.8's client renderer keeps an `aria-*` attribute whose value is
  boolean `false` (`props.js`'s guard admits it via `name[4] == '-'`), but
  `preact-render-to-string` drops it, and hydration does not add it back — so
  `aria-expanded={expanded}` leaves a server-rendered control with no collapsed
  state until its first toggle. Write `aria-expanded={x ? "true" : "false"}`.
- **Two nouns, and every string uses the one it counts.** A _finding_ is one
  paper's proposal of a gene; a _gene_ is a row of the database. `genes.*`, the
  accepted and rejected lists and a paper's two counts are findings;
  `database.inserted` and `database.updated` are genes. The widget said "gene"
  for both, so ten accepted beside five written read as a contradiction where it
  is two facts. `nouns` in the encoding holds both, and the Findings tab opens
  on the line that says why its count is not the genes written.
- **Status is never colour alone.** A pill pairs its tint with a glyph and
  words; a note that needs a look carries a glyph before its title and the same
  words for a screen reader (`Note`'s `mark`); the confidence track has its
  number beside it. The four status tints resolve through semantic tokens the
  dark blocks already override. (`.pipeline-tint-ember` keeps its name and reads
  `--svd-color-warn`: on a mono steel palette the accent would make a warning
  the colour of every link on the page.) A fifth tint, `highlight`, is not a
  status: it marks a rejection reason that is a filter doing its job.
- **A warning either needs a look or is routine, and the encoding says which**
  (`warningKinds.*.review`). The fallback model serving a paper, a finding under
  a floor, a retried request that succeeded and a quote the verbatim gate
  dropped are the run working as designed: neutral notes, no flag, not counted.
  Everything else is amber and counted under "N to review" — by _notes_, not by
  what they name, which is how a healthy run once read "49". A kind the encoding
  has never seen needs a look. `tests/pipeline_encoding_test.ts` pins the
  routine set whole, so a new kind fails until someone decides.
- **"Completed with warnings" is not said.** The status pill reads "Completed"
  and the review count stands beside it; a run whose notes are all routine has
  nothing to add. A step's row carries a flag only when it has something to
  review ("1 paper declined"; "2 to review" for several) or failed. There is no
  "Passed" pill: it said the default on every row.
- **A step's row reads out the run's counts, once** (`stepOutcome`). The report
  holds one set of counts, each belonging to the step that produced it —
  per-finding validation happens inside `processing_papers`, and
  `batch_validation` is the cross-check after it. A step that recurs, a step the
  card does not know and a step whose counts the run never recorded (an offline
  run searched nothing) fall back to their own sentences, so no total is printed
  twice. The sentences themselves are in the dialog's step log. The Search row
  also says over what window it searched ("last 730 days") when the report holds
  `config.daysBack`; the export reads it back out of an older report's own
  sentence (`.claude/rules/pipeline/run-reporting.md`).
- **A row opens only on a note or an error**, and a failed step starts open. A
  row with neither is a disabled button at full contrast, not a dimmed one: it
  is a real step with nothing more to say, and greying it would read as "did not
  run", which is what `skipped` means. Rows open independently.
- **A note is a rail and a wash, never a frame**
  (`components/pipeline/Note.tsx`). An opened step used to be a framed box
  holding framed notes inside the card's frame: three sets of registration marks
  round a sentence. A warning's explanation is prose in the page's face; its
  subjects are links when they are PMIDs, and past the eighth they sit behind a
  native disclosure rather than becoming "and 26 more".
- **Nothing on the card is separated by a glyph.** A character drawn between
  wrapping flex items stays at the end of the line it wrapped from. The when
  line uses the gap alone; the parts of a step's outcome use a rule that every
  part draws on its own left edge, with the line pulled left by that edge so the
  rule of whichever part starts a line is clipped.
  `tests/styles_contract_test.ts` fails on a `·` in any `.pipeline-` rule but
  the refresh rows'.
- **Every step row is its own grid**, so no column is shared down the list. The
  fixed tracks do the aligning, with `justify-self: end` on the flag and **the
  caret rendered on every row** — hidden with `visibility` when the row does not
  open, never dropped. Below 900px a row is three lines (name, duration and
  caret; outcome; flag): beside the label column and a flag the outcome had
  170px at 768. The duration is shown at every width. A rejected finding's row
  in the dialog stacks at the same width: its four columns needed 534px of the
  529 the dialog gave them at 601px.
- **The verdict is one block** (`.pipeline-verdict`) that holds the figures, or
  on a failed run the note that stands in for them, and the space under it is
  the block's. The figures are a named list, `<ul aria-label>` of three `<li>`:
  as bare spans they reached a screen reader as one sentence. Their grid is
  `grid-auto-columns: minmax(0, 1fr)`, a column a figure;
  `repeat(auto-fit, minmax(0, 1fr))` has no minimum to fit to and made a track a
  pixel.
- **Run details is a native `<dialog>`**, opened with `showModal()` through
  `useModal` (`components/useModal.ts`, shared with the adapt guide's session
  windows). The browser supplies the top layer, the focus trap, the inert page
  and the return of focus to the trigger; Escape is reported, not obeyed, so the
  state closes it. It replaces a drawer at `inset: 0` inside the card, which
  made the card's height the window onto the whole record. `.pipeline-details`
  sets `display` only on `[open]`: on the bare selector it would outrank the
  user agent's `display: none` and draw the closed dialog into the page.
- **The dialog's content mounts on first opening and stays** (`RunDetails`), and
  so does each tab's panel once shown. `e2e/tests/performance-behavior.spec.ts`
  holds the first record's identity across a close, a reopen and a change of
  tab. The trigger is always there: every run has a method, so Setup is never
  empty, and a tab with nothing in it is not offered (`detailTabs`).
- **The tabs are a real tablist**: one tab stop, the arrows, Home and End move
  the selection (`nextTab`), and each panel is its own scroller. One scroller
  for all of them carried a tab's scroll position into the next. At 480px and
  below the tabs step down in size so the four fit a 320px screen. A tab names
  its panel in `aria-controls` only once that panel is in the page, since a
  panel mounts when its tab is first selected. The dialog's width is a
  percentage, never `vw`, which counts a classic scrollbar's width.
- **Findings** are the accepted ones as full records, then the rest grouped by
  why (`rejectionGroups`) under a heading that says it once. A group's count is
  absent when the report's list is capped: the groups are cut from the items it
  holds, and a count of those would read as a total. One "Showing 200 of N" line
  covers the set. "Accepted" is `acceptedGenes.total`, exact even when the list
  is capped; with `database: null` the heading is "Validated, not written", and
  the Papers column "Validated". A citation-only finding says "Written as:
  Citation only". **A pill in a record wraps**
  (`.pipeline-pills >
  .pipeline-chip`): a status pill is a few words and never
  does, but a record's values are whatever the run extracted, and an omics entry
  can run to hundreds of characters.
- **Confidence is a number in words beside a track** marked at the floors the
  run recorded (`confidenceMarks`), so a held finding reads as just short or
  nowhere near. The track is `aria-hidden`; the number is the value.
- **Papers and Services are tables**, with their roles spelled out because the
  phone layout changes their `display`. The run's own notes about its fallback
  model and its unread papers stand above the Papers table, once (`paperNotes`);
  a row says "Primary", "Fallback" or "Not read", and who declined it as plain
  text. Nothing in a table is a pill. A cell is never addressed by
  `:first-child` (see `.col-identity`); the first cell carries `is-lead`.
  `paperSources` in the encoding is where `PaperResult.source` becomes words,
  and `tests/pipeline_encoding_test.ts` reads the literals out of
  `pipeline/pdf_retrieval.py` and `pipeline/main.py`.
- **Setup holds the method and the usage**: mode, model and effort (and "Batch
  API" when `config.batch === true`), fallback model, prompt version with the
  disease and the whole hash, the two floors; duration, tokens, the two quote
  numbers. The estimated cost is published and not shown.
- Detail lists are capped at 200 by the exporter and the UI states the
  truncation. `lib/data/pipeline_run.ts` recomputes `shown` from the items
  actually present rather than trusting the file, so a count that disagrees with
  its own list cannot make the UI lie.
- Lists are keyed by position, not by text. A re-entered step merges its visits'
  actions, so two visits that did the same thing produce the same sentence; a
  text-keyed list collapsed them.

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
  `.pipeline-badge`, and `ApiList` (`components/ApiList.tsx`), the services
  table the run details' Services tab draws. That is what keeps one service row
  reading identically in both places; the `.pipeline-api` row lives in that file
  alone. Only the refresh rows themselves are new CSS.
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
costs several requests a row (four or more for a gene) and a burst over the
limit is a 429. The draft is kept in `localStorage` under `svd-adapt-draft`
(`lib/adapt/draft_storage.ts`); the literal scan matches the short form as
written, so the lower-case `svd-` keys need no allow-list entry. `fflate` is the
zip writer and is imported only by `lib/adapt/bundle.ts`. The step forms under
`components/adapt/steps/` take props because they render inside the island, not
as islands. The island loads nothing of the dataset: `lib/adapt/validate.ts` and
the manifest reach their shared helpers through public modules
(`lib/normalize.ts`, `lib/sentinels.ts`, the `shared` chunk), and
`server/protected_data_build.ts` fails the build if the island's chunk reaches
any protected one, directly or through another chunk. A saved session is the one
thing the island keeps on the server (the root `CLAUDE.md`); the browser holds
only its link, under `svd-adapt-session`.

Eleven things are load-bearing:

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
  (`beforeunload`). Both sit in `.adapt-messages`, under the action bar in
  `.adapt-pinned`, pinned under the navbar while the step scrolls, because the
  button that caused them is usually far down the step or in the bar itself. The
  new step's heading takes focus in a _layout_ effect: a passive one ran a frame
  late and took focus from a field clicked in the meantime. Pressing the current
  step's own segment does nothing: it would clear the step's line and refold the
  open card.
- **The buttons are one bar, and the bar is one row at every width.**
  `ActionBar` (`components/adapt/ActionBar.tsx`) heads `.adapt-pinned`, above
  the stepper, so Save session, Export, Import, Start over and Download work
  from every step, and the messages sit under it in the same pinned box. From
  1100px the four action buttons are inline and a `Session` button opens the
  session's details -- the resume code, Copy code, "kept until" and "I have a
  resume code" -- in a popover; below 1100px Save session, its indicator and
  `More` are the row, and the details head the `More` panel. The code was meant
  to stay on the row, but with a session attached the full row measured 1,431px
  and the bar never gets more than 1,152px (the page is contained), so it
  wrapped to three rows, 118px pinned under the navbar, at every viewport
  measured from 900 to 1920px. Without the details the wide row is 897px, one
  row from a 937px viewport, so it waits for 1100px, the next breakpoint of the
  closed set `tests/styles_contract_test.ts` holds; that set was not widened for
  the bar, nor for the welcome-back panels, which stack at 600px. Both panels
  are native `[popover]`s placed under their button by Floating UI
  (`usePlacedPopover`), with `flip` to open above it when there is more room
  there and `size` to cap the height to the room left, so the panel's own scroll
  reaches its last button on a short screen; a fixed panel past the viewport's
  edge could never be scrolled to. `SessionDetails` renders in both and holds no
  id, and the stylesheet shows one of the two.
- **A saved session's every decision is `sessionReducer`'s.** The island's
  handlers are closures a test cannot reach (below), so they only call the
  client, `confirm()` and storage, and dispatch what happened to
  `lib/adapt/session_state.ts`. The link under `svd-adapt-session` holds the
  code, the revision, when it was saved and `dirty`, which says the answers
  changed since; it drives "Unsaved changes" and the leave warning, and survives
  a reload. A Start over, or another tab's link replacing this one's, moves the
  state to a new `epoch`, and a result from an earlier one is dropped: a save
  that landed after Start over re-attached the browser to the session it had
  left. The link is written before the draft, so another tab hears a detach or a
  resume before the answers that follow it. The three windows are native
  `<dialog>`s rendered outside the fieldset, which is disabled until the draft
  is read and would disable them too. Escape is reported, not obeyed, so every
  callback has to flip `open` itself, and `useModal` catches Chrome closing the
  element on a second Escape without `cancel`. The API parses the answers once
  with `parseExport()`, and the store writes them through `exportableAnswers()`,
  so the NCBI email and key are blanked whatever the browser sent, and a resume
  keeps this browser's own pair (`importText()`). A session is deleted 14 days
  after its last save (`SESSION_TTL_MS`), and a save after that saves it again
  under the same code. That revival, like a forced save over a damaged file,
  continues past the highest revision it can know of (the old file's, while it
  is still there, and the saving browser's), never restarting at 1. Once the
  sweep has removed the file its revision is gone, so a save names the copy it
  was made over by its revision and its `savedAt` both, and a mismatch in either
  is a conflict: by revision alone, a browser that missed a revival could meet
  its own number again and overwrite newer saves without being asked.
- **The stored draft is never lost to another version or another tab.** A draft
  `parseDraft()` cannot read -- another `DRAFT_VERSION`, damaged JSON -- is
  copied to `svd-adapt-draft-unreadable` before the first save and offered for
  download; bump `DRAFT_VERSION` only for a shape `STEPS_SHAPE` cannot rebuild,
  since every older draft then takes that path. A second one is kept beside the
  first (`-unreadable-2`), never instead of it, and the notice reads
  `keptDrafts()` on every load, not only the one that found a draft unreadable:
  the copies stay, offered, until the researcher discards them. The logos live
  under keys of their own (`-logo-light`, `-logo-dark`), written only when their
  bytes change, so a keystroke does not rewrite a megabyte. A save from another
  tab is merged, not adopted wholesale (`mergeDrafts()`: three-way against the
  draft both last agreed on, this tab winning a leaf both changed), so two tabs
  stay one draft and a tab whose saves are refused keeps its answers. `synced`,
  that agreed draft, follows the draft key and not the save: `saveDraft()`
  writes the key before the logos, so a refused logo still leaves the tab
  holding what the key holds, and `adoptDraft()` ignores a storage event the key
  has moved past, which this tab's own save had merged already. Start over and
  an import write `svd-adapt-draft-replaced`, and a tab seeing it drops what it
  had revealed.
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
  why only the key-at-a-time spec in `e2e/tests/adapt.spec.ts` sees it. That
  spec types into a row an Add press has just drawn, and `AddButton` moves focus
  to the new row's first control a task after the click, so the spec's `press()`
  waits for the move before typing: on a loaded runner it landed mid-word, and
  "0.75" left "0." in Confidence and "75" in the PMID. It finds the new row
  through the list root's `adapt-list` class, because `adapt-lookup` also wraps
  a trait's ontology search inside a row.
- **The NCBI credentials leave the browser in nothing.** Both the archive entry
  and "Export answers" write `exportableAnswers()`, which blanks `search.ncbi`;
  the archive is committed to a repository and the export is mailed around. The
  third download, a kept unreadable draft, goes through `unreadableDownload()`,
  which blanks every `ncbi` record in a text no shape can be assumed of; the
  copy in storage stays as it was stored.
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
  lost. The press is `mousedown` to `mouseup` as well as the pointer's events,
  because a touch tap sends `pointerup` before the `mousedown` that moves focus.
  The stepper keeps the same rule from the other side: `focusInView()` centres a
  segment only for focus that draws a ring, since a press focuses it before the
  release, and a row scrolled then slides out from under it and the click is
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

## Review control

`islands/ReviewMenu.tsx` is the way into the scientific review area: a "Review"
menu button first in `.navbar-actions`, before the theme toggle. It is not the
site's Sign out beside it, which ends the passphrase session; this touches only
its own cookie, and it carries a glyph and a caret so the two do not read alike.
The shell draws it only while a review exists (`ReviewControl` in
`routes/_app.tsx`, called with `REVIEW !== null`, so both branches are tested
while the committed round is `null`), and never on the login page.

**It holds no data and imports none.** It is in the navbar of every page while a
review exists, so it imports `lib/review/copy.ts` and `lib/review/access.ts`
(both import nothing), hooks and components, and never `lib/data/`,
`lib/review/current.ts` or `lib/review/simulate.ts`. Its one prop is `entered`.
`DATA_FREE_ISLANDS` in `server/protected_data_build.ts` fails the build if its
chunk reaches a protected one.

- **The cookie is `review_observer=1`** (one year, `Path=/`, `SameSite=Lax`,
  `observerCookie`), with no identity in it: observing needs no account. The
  shell reads it with `observerEntered` (`lib/review/access_request.ts`, kept
  apart so no `@std` import reaches the island), which also counts any page
  under `/review` as entered, so a deep link renders entered; the island then
  writes the cookie if it is missing. "Leave review" clears it.
- Signed out, the menu opens two native dialogs through `useModal`: the log-in
  dialog, whose one action is "Enter as observer", and the account request. The
  request form has no `action` and no `method`; its submit is stopped in script
  once the browser's own validation passes, and the form gives way to the
  notice. Nothing is stored and no request leaves the page. Closing the dialog
  resets the form.
- The button is disabled until the island is live, carries
  `aria-haspopup="menu"` and `aria-expanded` as a string. The menu takes focus
  on its first item, moves with the arrows, Home and End, and closes on Escape
  (`useEscapeKey`, focus back to the button), on Tab and on a press outside. The
  outside-press listener and both focus moves run in layout effects: a passive
  one subscribed a frame late and missed a press that quick.
- **Below 600px the button is its glyph alone**, named by `aria-label`. At 390px
  the bar had 62px to spare beside the logo, the toggle and Sign out, and the
  labelled button is 129px. At 320px even the glyph leaves the logo less than
  its width, and the logo gives way: below 1410px its grid track is what the
  actions leave, the logo is capped at it, and `object-fit: contain` draws the
  mark scaled down and undistorted in the narrower box
  (`.navbar-brand
  .institute-logo` in `assets/app.css`). Nothing in that rule
  knows the logo's or the buttons' sizes, so where the row has room, with or
  without the control, the logo is its full size and the bar is unchanged.
