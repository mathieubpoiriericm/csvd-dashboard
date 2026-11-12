---
name: perf
description: Use when measuring or interpreting the dashboard's responsiveness with `deno task perf` - the 4x CPU throttling, the two recorded channels, where the Tracy tools come from and TRACY_DIR in a worktree, where the numbers live, and why INP rather than blocking time is the figure to read.
---

# Responsiveness measurement

`deno task perf` builds, brings up the gated production server and measures
responsiveness: every route's cold load, fourteen interactions, and a layout
sweep over five viewports. It runs under **4x CPU throttling** — unthrottled on
an Apple-silicon laptop every surface measures as instant, which is the
measurement failing to discriminate rather than a result — and reports the
median of five untraced repetitions, plus one traced run kept for attribution
only. Two channels are recorded per scenario: in-page `PerformanceObserver`
metrics (long tasks, INP, layout shift, TTFB/FCP/LCP, transferred bytes) and a
Chromium CDP trace converted by `tracy-import-chrome` and ranked by self time
with `tracy-csvexport -e`. **Tracy cannot instrument Preact** — the capture is
an ordinary DevTools trace and Tracy is only the analysis backend. The tools
are built from the `third_party/tracy` submodule (always its newest release)
into the gitignored `.tracy/bin` by `deno task tracy:build`, so a worktree points
`TRACY_DIR` at the main checkout's `.tracy/bin`. Building, updating and reading
captures are the `tracy` skill. A missing binary fails the run's preflight, and
so does a failed conversion;
`node e2e/perf/run.mjs --no-trace` records the in-page metrics alone. Each run
writes its numbers to a timestamped directory under `e2e/perf/artifacts/`,
gitignored too. A scenario that `needs` an element the page does not render is
reported as skipped, with the reason, rather than failed on a timeout: while
`GOLD_ONLY` is on the About page has no run widget, so `about/toggle-step` and
`about/drawer` (lifecycle included) skip and the run still exits 0. A scenario
whose input the data cannot supply carries `unavailable` instead and is skipped
the same way without a page load: on the empty export, the two searches of a
table with no query and the genes filter-toggle with no trait.
**Read INP, not blocking time, for the interaction scenarios** —
the `longtask` API only reports tasks over 50 ms, so blocking time ignores
everything below that and rises when the same work consolidates into fewer,
longer tasks.
