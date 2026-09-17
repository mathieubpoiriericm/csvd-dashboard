# Remediate the measured performance bottlenecks

## Findings and scope

Completed **69 Tracy captures**, covering 59 browser timing scenarios, seven
lifecycle scenarios, and three offline Python workloads, plus 30 viewport
checks.

Profiled production build of commit `47f031b414a0af866c4720292c1d6d5c7bf9728f`
on macOS 27.0 arm64, Deno 2.9.6, Node 26.8.1, Chromium 151.0.7922.34, and Tracy
0.14.1.

The [profiling report](../../../e2e/perf/artifacts/baseline/findings.md) links
measurements and captures. Those artifacts are gitignored and local to the
profiling workspace; the findings below preserve the evidence needed to
understand this plan in a fresh checkout. Production build passed; the
investigation changed no application source.

| Finding                   | Measurement                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Timeline layout stalls    | 460 ms longest task cold; 442 ms with warm cache                                                |
| Large gene-table search   | 126 ms longest task; tooltip cleanup dominates sampled work                                     |
| Eager hidden content      | About HTML: 381 KB decoded; phenogram: 327 KB                                                   |
| Uncacheable font preloads | Approximately 19 KB downloaded again on every warm navigation                                   |
| Profiling inaccuracies    | Incorrect Tracy path, misleading metric names, disabled caching, incomplete scenario assertions |

All browser timings above use **4× CPU throttling**. No document overflow or
growing DOM/listener counts was detected. Map interactions, local HTTP handling,
and tested offline text transformations do not currently warrant restructuring.

Expanded and corrected-cache timing results use three untraced repetitions and a
separate attribution trace. Historical baseline medians include a traced
repetition; do not use those medians as the sole acceptance baseline. Blocking
means cumulative task time beyond 50 ms within the scenario observation window,
not standardized TBT. Maximum observed event duration is a lab measurement, not
field INP.

## Implementation changes

### 1. Make profiling reproducible and trustworthy

- Correct Tracy discovery in `e2e/perf/tracy.mjs`: the default path must resolve
  to the repository-root installation. Require successful conversion when Tracy
  profiling is requested.
- Preserve individual runs, environment/build metadata, failures, skips, and
  incremental results in separate run directories.
- Collect five untraced repetitions and one separate attribution trace. Exclude
  traced runs from timing summaries.
- Label maximum observed event duration accurately; preserve missing
  measurements instead of converting them to zero. Define the observation window
  for blocking measurements.
- Assert interaction outcomes and island readiness. Replace arbitrary settling
  waits where observable completion exists.
- Preserve HTTP caching during tile blocking using CDP URL blocking, classify
  resources using URL pathnames, and distinguish renderer CPU work from
  asynchronous spans and other threads.
- Incorporate the expanded scenarios and publish updated findings alongside the
  historical report. The initial six extended warm scenarios used interception
  that disabled caching; use the corrected warm-cache pass as cache evidence.

### 2. Reduce timeline collision-solving work

- Reuse private working rectangles instead of allocating them repeatedly in
  `lib/timeline.ts`.
- Index fixed and settled obstacles in a spatial grid using four times the
  median label height as cell size. Retain exact overlap predicates and
  deterministic candidate ordering.
- Preserve existing behavior for degenerate or non-finite geometry through
  bounded fallback checks.
- Cache solutions against normalized, unshifted geometry; use the existing 0.01
  SVG-unit convergence tolerance to avoid repeat solves caused by insignificant
  measurement differences. Invalidate when text dimensions, obstacles, or
  legitimate nudges change.
- Preserve label spacing, search reach, tie-breaking, leader lines, and
  scientific encoding.

The instrumented load made 678 `getBBox` calls in six passes of 113 texts. CPU
samples identify current-rectangle allocation and candidate collision checks as
substantial costs. An in-memory prototype produced identical shifts for the
captured geometry of 102 movable labels and 113 obstacles and ran **2.1×
faster** (11.29 ms to 5.31 ms in hot interleaved Deno measurements). Browser
validation remains required.

### 3. Reduce tooltip and table rendering costs

- Keep stable native popover shells and IDs; mount detailed tooltip content only
  while open.
- Replace per-tooltip bulk listener registration/abortion with a shared document
  controller and lightweight registration cleanup.
- Preserve native keyboard activation, hover delays, focus restoration, and link
  navigation. Start positioning after content commits; stop observers and timers
  on close or removal.
- Move search draft state into a small input component, retaining the existing
  120 ms debounce. Typing should not rerender the full table before the filter
  commits.
- Add an unchanged-width guard to phenogram measurements.

The 100-row gene search trace sampled 102.6 ms in tooltip effect cleanup. Closed
About and phenogram lifecycle snapshots retained 9,166 and 15,581 DOM nodes,
respectively, including text nodes. These observations motivate reducing both
per-instance listener cleanup and eager hidden content.

### 4. Defer pipeline drawer details

- Keep the drawer container, accessibility relationships, and focus behavior
  stable.
- Mount its detailed records on first opening, then retain a memoized body so
  subsequent openings and step toggles avoid rebuilding those records.

### 5. Make public fonts cacheable

- Move the six font assets into Vite-managed assets.
- Use identical emitted, hashed URLs in CSS and preload links.
- Verify immutable caching, single downloads, and public availability before
  login.
- Update the stale font assertions to inspect the fonts actually served.

Both preloaded Barlow faces currently return `no-store` on warm navigation,
transferring 19,468 bytes again. Updating preload URLs alone would leave CSS
pointing at different assets and risk duplicate downloads; update both consumers
together.

Application routes, data schemas, tooltip props, and the collision-solver
signature remain unchanged. Profiling interfaces and public font URLs change.

## Validation and acceptance

- Run formatting, linting, TypeScript checks, Deno tests and required coverage,
  production build, and relevant Playwright suites.
- Test collision results against captured geometry and existing placement cases,
  including dense layouts, degenerate boxes, immutable inputs, font changes, and
  repeated measurement.
- Exercise tooltip pointer/keyboard behavior, filtering an open tooltip away,
  rapid typing, drawer focus restoration, both themes, and mobile layouts.
- Repeat lifecycle checks; DOM/listener counts must remain stable.
- Repeat performance measurements serially on the same host and configuration.
  Apply the following targets to medians of the five untraced repetitions;
  retain all individual observations and investigate regressions on other
  covered routes.

| Scenario or measure         | Acceptance target                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| Timeline cold and warm load | Longest task ≤200 ms; observed blocking reduced by at least 60% against the corresponding baseline |
| 100-row gene-table search   | Longest task ≤75 ms                                                                                |
| Phenogram load              | Longest task ≤100 ms                                                                               |
| Pipeline drawer opening     | Maximum observed event duration ≤200 ms                                                            |
| Warm navigation             | No font response bodies transferred                                                                |

- Preserve authenticated data's private/no-store policy and verify
  unauthenticated asset protection. Only intended public assets, including
  fonts, should be public.
- Treat an unavailable event measurement as missing, not a passing zero. If a
  target fails, retain the new trace and continue attribution and remediation
  before declaring that item complete.

## Assumptions and limits

Preserve the existing visual design and scientific meaning. Implement
measurement fixes first, followed by separate, measured remediation commits.
Implementation and validation are complete; see the
[results report](../specs/2026-09-08-performance-remediation-results.md).

Figure generation was not profiled because the installed Python environment
lacks `matplotlib`. Live database, LLM, provider-sync, PDF/OCR, deployed-host,
Firefox/WebKit, and real-device field performance remain unmeasured. No
remediation for those paths is inferred from these results. The full functional
and coverage suites were not rerun for the source-unchanged profiling
investigation.

## Execution notes

Implementation runs in the isolated `perf/tracy-remediation` worktree.
Historical artifacts are linked locally under `e2e/perf/artifacts/baseline`; the
summary above remains available in a fresh checkout without those ignored
recordings.

Direct execution verified that the original `../../tracy-profiler-0.14.1` URL
already resolves to the repository root. The earlier path diagnosis was
incorrect; retain that path and instead enforce executable preflight and
conversion failures.

The expanded sweep contains 52 distinct timing scenarios: it replaces the six
invalid warm-cache cases with corrected cache-preserving scenarios and omits the
redundant attribution-only timing scenario. Each has five untraced repetitions
and one separate attribution capture, followed by seven lifecycle captures.

All remediation acceptance targets passed. The results report records the final
52-scenario sweep, lifecycle checks, tests, and measurement corrections.
