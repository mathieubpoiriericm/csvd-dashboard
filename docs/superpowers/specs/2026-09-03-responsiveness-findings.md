# Dashboard responsiveness: measurements and remediation

Measured 2026-09-03 against the production build, behind the login gate, under
**4x CPU throttling**, median of 3 repetitions per scenario. Unthrottled on an
Apple-silicon laptop every surface here measures as instant, which is the
measurement failing to discriminate rather than a result.

Reproduce with `deno task perf`. The harness lives in `e2e/perf/`.

## How it is measured

Two independent channels, so a failure in one never leaves a scenario
unmeasured.

- **In-page.** A `PerformanceObserver` installed by an init script, before any
  app code evaluates: long tasks, `PerformanceEventTiming` (INP and handler
  duration), layout shift, and for loads TTFB / FCP / LCP and transferred bytes.
- **Trace.** A Chromium CDP trace per scenario, converted with
  `tracy-import-chrome` and ranked by self time with `tracy-csvexport -e`. Tracy
  is a native frame profiler and cannot instrument Preact; the capture is an
  ordinary DevTools trace, and Tracy is the analysis backend. Self times, not
  inclusive ones — `RunTask` wraps almost everything and would otherwise
  dominate every scenario.

**Read INP, not blocking time, for the interaction scenarios.** The `longtask`
API only reports tasks over 50 ms, so "blocking" and "total task" both ignore
everything below that threshold and _rise_ when the same work consolidates into
fewer, longer tasks. INP is what the person operating the UI actually waits for.

## What was fixed

### 1. Nothing was compressed _(the largest finding, and unanticipated)_

`staticFiles()` served every built bundle verbatim: `Accept-Encoding: gzip, br`
returned `content-length: 78969` and no `content-encoding` for the stylesheet.
Combined with the gate — HTML is `no-store` (`routes/_middleware.ts:54`), the
data chunk is `private, no-store` (`server/protected_data_assets.ts:98`) — and
full page navigations with no client router, **every tab click re-downloaded
every uncompressed byte.**

`server/compression.ts` gzips compressible responses as the outermost
middleware, so it also covers the protected-data chunk that
`protectDataAssets()` rewrites. Fonts and images are skipped (already
compressed), bodies under 1 KB are skipped, and a response that already carries
`Content-Encoding` is left alone so an edge that compresses cannot
double-encode. `Vary: Accept-Encoding` is appended to any existing `Vary`, and
the ETag is suffixed because the gzip body is a different representation from
the one `staticFiles()` tagged.

| Route           | Transfer before |      after |
| --------------- | --------------: | ---------: |
| About           |          999 KB | **217 KB** |
| Phenogram       |          960 KB | **234 KB** |
| Trials Map      |          914 KB | **255 KB** |
| Genes           |          819 KB | **241 KB** |
| Clinical Trials |          776 KB | **236 KB** |
| Trials Timeline |          761 KB | **204 KB** |

**Caveat, stated plainly:** this is measured against `deno serve`, which is what
`deno task start` and the e2e harness run. Deno Deploy may compress at the edge;
the hosting plan (`docs/superpowers/plans/2026-08-31-deno-deploy-hosting.md`)
does not say, and nothing here verifies it. The middleware is a no-op wherever
the edge already encoded the body.

### 2. Table search re-filtered on every keystroke

`components/TableShell.tsx` wrote `table.setGlobalFilter` from `onInput`, so
each keystroke drove TanStack's filter → sort → paginate models, an island
re-render, the per-render derivations in `GenesView`/`TrialsView`, and up to
`pageSize` rows of cells each rebuilding their tooltip content objects.

`searchInput` stays synchronous so the field never lags; the filter follows 120
ms after the last keystroke.

| Scenario                | INP before |     after | Max handler before |       after |
| ----------------------- | ---------: | --------: | -----------------: | ----------: |
| Genes — type in search  |     144 ms | **40 ms** |            52.4 ms | **18.9 ms** |
| Trials — type in search |     104 ms | **32 ms** |            46.5 ms | **14.0 ms** |

### 3. The timeline re-rendered on every measure pass

`measure()` in `islands/TrialsTimeline.tsx` stored a fresh `Map` from
`measureSvgTextBoxes` unconditionally, so every pass reconciled the whole
~700-node SVG even when no text had moved — and mount measures twice, with
`document.fonts.ready` measuring again. Everything after the measurement is a
pure function of those boxes, so a pass that measured the same boxes reaches the
same nudges and shifts and sets nothing.

`sameBoxes` (`lib/timeline.ts`) is the guard; `measure()` returns early on a
match.

|                                   | before |      after |
| --------------------------------- | -----: | ---------: |
| Timeline cold load — blocking     | 190 ms | **166 ms** |
| Timeline cold load — longest task | 240 ms | **216 ms** |
| `RunMicrotasks` self time         | 140 ms | **119 ms** |

Modest, and the remaining 166 ms is genuine mount work: the first render of the
figure plus two necessary measure passes. Reducing it further means
restructuring the figure, which is beyond what the measurements justify.

### 4. Three stale marker counts _(pre-existing, fixed regardless)_

`islands/TrialsMap.tsx:60`, `:245` said the map draws **70** sites and
`islands/CLAUDE.md` said **57**. `data/geocoded_trials.json` holds **431**
records, each with `lat`/`lon`/`facilityName`, and
`e2e/fixtures/expected-data.ts` already pinned `mapSites: 431`. Only the prose
was wrong; all four places now say 431.

## Measured and deliberately not changed

Each of these was a predicted problem that the numbers dismissed. They are
recorded so the next person does not re-derive them.

- **The sample-size slider.** `components/RangeSlider.tsx` fires `onChange` from
  `onInput`, so a drag is ~40 events, each invalidating the `filtered` memo and
  re-running `filterTrials` over 111 rows plus the histogram re-bin. Measured
  INP **24 ms**, max handler **0.2 ms**. 111 rows is simply too few to matter;
  debouncing it would add latency and buy nothing.
- **`lib/filters.ts` per-row work.** `normalize`'s `trim().toLowerCase()` per
  comparison, `registryOf`'s `Object.keys` allocation per row, `matchesPhase`'s
  regex per row, and `parseSampleSize` running unconditionally even at full
  range. Real, and invisible at 79 and 111 rows.
- **Tooltip instances.** ~700 `Tooltip` components at `pageSize: 100` on /genes,
  each with a `useId`, an effect and five listeners, with content built eagerly
  during render. Hovering one measures INP **32 ms**, max handler **0.2 ms**.
  `autoUpdate` is correctly scoped to the one open popover (`Tooltip.tsx:142`)
  and needed no change.
- **The phenogram's measure passes.** 442 `getBBox()` calls, but in exactly two
  passes with empty dependency arrays, so it cannot re-enter. Its cold load is
  79 ms blocking, against the timeline's 166 ms with the same technique — the
  difference is the loop, not the measuring.
- **Memoization in the table islands.** Already correct: `GenesView.tsx:304` and
  `TrialsView.tsx:234` both `useMemo` their filtered rows.
- **The map has no filters.** `TrialsMap` holds only `loadError` and never
  intersects locations with the trials filters, so there is no
  marker-rebuild-on-filter path to fix.

## Still open, with numbers

Not fixed here: each needs a structural change rather than a local one, and the
brief was measured wins plus low-risk hygiene.

| Surface                |                                 Measurement | Cause                                                  |
| ---------------------- | ------------------------------------------: | ------------------------------------------------------ |
| Timeline cold load     |        166 ms blocking, 216 ms longest task | First render of ~700 SVG nodes plus two measure passes |
| Genes, page size 100   |                             106 ms blocking | ~700 `Tooltip` instances mounted at once               |
| Genes, toggle a filter |                   INP 136 ms, handler 59 ms | Unmemoized per-render derivations (below)              |
| About, expand a step   |              `RasterTask` 679 ms across 230 | 83 drawer records mounted before the drawer opens      |
| Map, zoom              | `AnimationFrame` 335 ms, `Animation` 182 ms | 431 markers re-decorated as they cross clusters        |

The unmemoized derivations behind the filter-toggle number are
`GenesView.tsx:321-365` (two full `visibleGenes.filter(hasRealValues)` passes, a
`countBy` with an anchored regex per row, `filterControls.map` twice) and
`TrialsView.tsx:262-303` (`groupParity` walking all sorted rows every render
though only the ≤25 on the page read it). Memoizing them is safe in principle
but `tests/filters_test.ts` asserts exact row counts against real committed
data, so it wants its own measured change.

The About drawer (`islands/PipelineRun.tsx:631-702`) renders 6 accepted-gene
cards, 11 rejected, 55 paper rows and 11 API rows whenever a run is recorded,
merely `hidden`/`inert`. Gating that subtree on the drawer being open is the
obvious fix; it was left alone because the drawer's `aria-controls` relationship
and the e2e assertions around it need checking first.

## Layout, across five viewports

390x844, 768x1024, 1024x768, 1440x900 and 1920x1080, all six routes.

**No route overflows at any width.** `runtime.spec.ts`'s tripwire holds at three
widths beyond the two it tests.

Two classes of finding, neither fixed here:

- **Touch targets below 24x24 px**: 66 on /phenogram and 34 on /timeline at 390
  px, 29 on /genes, 22 on /trials, 8 on /map, 7 on /. The phenogram's are its
  per-gene buttons, which are sized by the figure's geometry rather than by a
  token.
- **Containers whose content exceeds them but which cannot scroll**: the
  `.visually-hidden` lists on /map and /genes (clipped by design — these are
  false positives the audit should learn to exclude), and SVG `text` on /trials
  and /timeline.

Both are design questions rather than latency ones, and the touch-target sizes
in particular overlap the unmerged `design-sweep-remediation` branch, whose Task
6 consolidates the ten breakpoints in `assets/app.css`. **They are reported here
for that branch to consume, deliberately not fixed**, so the two branches cannot
conflict over the same media queries.

## Verification

`deno task check`, 429 unit tests, the `lib/` 100 % coverage floor, and all 153
e2e tests pass with every change above.
