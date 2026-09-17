# Islands

Island-specific guidance. The root `CLAUDE.md` lists all seven islands; the
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

`MAP_DEFAULT_CENTER`, `MAP_DEFAULT_ZOOM` and `MAP_CLUSTER_RADIUS_PX` stay next
to the Leaflet setup in `TrialsMap.tsx`. `maxClusterRadius` is the only
markercluster option that is a real override (the default is 80); anything else
passed there is restating a default.

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
  word, and every drawer field pairs its glyph with a `.visually-hidden` label.
  The four status tints resolve through semantic tokens the dark blocks already
  override, so the block adds no dark counterpart. A fifth tint, `highlight`, is
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
It exists because the upstreams only the refreshes touch — ClinVar, Orphadata,
Open Targets, UniProt, ClinicalTrials.gov — reached no published file at all:
`build_run_report` is reachable only from inside `run_pipeline`, so the API rows
`--sync-annotations` recorded were discarded when the process ended.

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
