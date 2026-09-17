# Performance remediation results — 2026-09-08

Implemented the
[remediation plan](../plans/2026-09-08-performance-remediation.md) in the
isolated `perf/tracy-remediation` worktree, based on commit
`47f031b414a0af866c4720292c1d6d5c7bf9728f`.

## Measured outcomes

Production Chromium, macOS 27 arm64, Deno 2.9.6, Node 26.8.1, Tracy 0.14.1, and
4× CPU throttling. Each timing scenario has **five untraced repetitions** and a
separate attribution capture. The following are medians; ranges show individual
untraced longest-task observations where relevant.

| Measure                                                        |                                           Before |                             After | Acceptance                               |
| -------------------------------------------------------------- | -----------------------------------------------: | --------------------------------: | ---------------------------------------- |
| Timeline cold longest task                                     |                                           460 ms |                   104 ms (99–109) | ≤200 ms: pass                            |
| Timeline cold observed blocking                                |                                           410 ms |                             54 ms | 86.8% reduction; ≥60%: pass              |
| Timeline warm longest task                                     |                                           442 ms |                     90 ms (88–91) | ≤200 ms: pass                            |
| Timeline warm observed blocking                                |                                           392 ms |                             40 ms | 89.8% reduction; ≥60%: pass              |
| 100-row gene search longest task                               |                                           126 ms | No tasks ≥50 ms in any repetition | ≤75 ms: pass                             |
| Phenogram cold longest task                                    |                                                — |                     70 ms (68–73) | ≤100 ms: pass                            |
| First pipeline drawer opening, maximum observed event duration |                                                — |                  120 ms (112–136) | ≤200 ms: pass                            |
| Warm font transfer                                             | 19,468 bytes per navigation for the two preloads |                           0 bytes | Pass on all 30 untraced warm navigations |

Mobile longest-task medians were 106 ms for timeline and 88 ms for phenogram.
There was no document overflow in the 30 route/viewport combinations.

These are lab measurements. Blocking sums time beyond 50 ms per long task within
an explicit scenario window; it is not standardized TBT. Maximum observed
EventTiming duration is not field INP. An absent qualifying event remains
missing; for example, one gene-search repetition had no event entry, while all
five had valid long-task observations. “No long tasks” does not mean zero CPU
work.

Initial decoded HTML fell from 380,770 to **83,704 bytes** on About (78.0%), and
from 326,519 to **263,390 bytes** on phenogram (19.3%). All inspected pages had
zero mounted tooltip detail bodies while closed.

## Changes delivered

- Timeline collision solving reuses private rectangles, indexes fixed/settled
  obstacles, and avoids solving unchanged normalized geometry. A committed
  captured-geometry fixture reproduces the original solver's exact shifts.
  Degenerate and unindexable boxes use bounded fallback checks.
- Tooltip shells and native invoker IDs stay stable; detail bodies mount only
  while open. A document controller replaces per-instance listener bundles.
  Closing waits for the native popover algorithm to restore focus before
  removing its focused link. Position observers and timers are cleaned up.
- Search draft state lives in the input component and retains the 120 ms
  debounce. Phenogram skips unchanged width updates. Pipeline details mount on
  first opening and remain memoized for reuse.
- All six fonts are Vite-managed, hashed public assets. CSS and preload URLs
  agree; login availability, immutable caching and preload/CSS reuse are tested.
  Authenticated data retains its private/no-store policy.
- The profiler saves individual runs, failures, environment/build metadata and
  incremental reports in separate directories. It separates attribution traces
  from medians, preserves missing metrics, flushes observer records, uses
  cache-preserving tile blocking, checks actual interaction outcomes and
  hydration, and clearly labels aggregate Tracy zones. Metric contract tests run
  in CI.

## Verification and measurement corrections

The main sweep covered **52 distinct timing scenarios**, with 30 viewport
checks. Three harness assertions needed correction: SVG hover points could hit
another shape or a clipped region, and Leaflet's positioning pane has no visible
box of its own. The failed attempts remain in their original report; focused
reruns use hit-tested SVG coordinates and observable zoom outcomes.

The initial lifecycle sweep kept nodes/listeners stable on six paths. Map popup
reuse retained one additional DOM node on its first repetition, then stayed at
2,002 nodes and 176 listeners for the remaining 19 repetitions. The follow-up
records five warm-up cycles before the 20 comparison cycles on every path; it
does not discard that earlier observation or equate stable DOM counts with proof
that all JavaScript memory is leak-free.

The earlier plan incorrectly diagnosed Tracy's default relative path. Direct
file URL resolution showed that `../../tracy-profiler-0.14.1` already points to
the repository root. That path is retained, with decoded filesystem URLs,
executable preflight checks and mandatory conversion success when tracing is
requested.

The original baseline mixed a traced repetition into some medians and used
request interception in six purported warm-cache scenarios. The before values
above use the separate untraced attribution/expanded results and corrected
warm-cache pass. The new sweep replaces the six invalid cache scenarios and
drops the redundant attribution-only timing scenario, rather than counting them
as extra coverage.

## Final checks

- `deno task check`: formatting, lint and type checks passed.
- `deno task test:coverage`: **458 tests passed**. Coverage was 85.8% lines,
  95.0% branches and 91.1% functions overall; `lib/` was 100% in all three.
- `deno task test:perf`: **4 metric contract tests passed**.
- Production build and `E2E_PORT=8128 deno task test:e2e`: **173 tests passed**,
  including delayed fonts, scientific figure geometry, tooltip keyboard/focus
  behavior, filtering an open row away, fast large-table search, retained drawer
  content, both themes, mobile layouts, authentication and font caching.
- All **52 timing scenarios** passed after the three documented harness repairs;
  every accepted scenario has five untraced runs and a successful Tracy capture.
- All **seven lifecycle paths** passed 20 comparison cycles after five recorded
  warm-up cycles, with zero retained-node and listener deltas.
- All **30 viewport checks** passed the document-overflow check. Eight
  light/dark screenshots were captured; timeline and gene-table rendering were
  inspected.

An earlier browser-suite invocation encountered connection refusals when a
server on the shared default port disappeared during startup. The suite now
accepts `E2E_PORT`; its local-resource audit follows that configured origin. The
full final suite passed on the worktree's dedicated port 8128.

## Local evidence

Raw reports, per-run metrics, screenshots and Tracy captures are ignored by Git.
The measurements above remain available in this committed document without them.

- [Historical investigation](../../../e2e/perf/artifacts/baseline/findings.md)
- [Full timing and viewport sweep](../../../e2e/perf/artifacts/2026-09-08T21-38-50.086Z/report.json)
- [Corrected SVG hover runs](../../../e2e/perf/artifacts/2026-09-08T21-46-15.621Z/report.json)
- [Corrected map zoom runs](../../../e2e/perf/artifacts/2026-09-08T21-47-25.235Z/report.json)
- [Final lifecycle sweep](../../../e2e/perf/artifacts/2026-09-08T21-47-36.485Z/lifecycle.json)
- [Acceptance checks](../../../e2e/perf/artifacts/acceptance.json)
- [Final HTML sizes](../../../e2e/perf/artifacts/final-inspection/report.json)
- [Timeline, light theme](../../../e2e/perf/artifacts/final-inspection/timeline-light.png)
- [Gene table, dark theme](../../../e2e/perf/artifacts/final-inspection/genes-dark.png)
- [Harness usage and metric definitions](../../../e2e/perf/README.md)

The profiled server entry's SHA-256 is
`58f62adfd3bc0080504fb2d5580153d008a5928e00d1fe77e16c3593a7947c8a`. No
application changes were made between the main timing sweep and its focused
hover/zoom reruns.

No Python pipeline or figure-generation changes were required. Live database,
LLM, provider sync, PDF/OCR, deployed-host, Firefox/WebKit and real-device field
performance remain outside this validation, as documented in the original plan.

## Integration with the frontend audit

On 2026-09-09, integrated `origin/main` at `d02e296`, preserving its filter
status, clear-and-focus behavior, tooltip ARIA state, figure skip links, and
navigation font preload. All three preloaded fonts now use the same hashed asset
URLs as the stylesheet. Pending search cancellation has dedicated unit coverage;
deferred tooltip detail markup has a direct rendering contract.

After integration, production build and `deno task check` passed, as did all 179
Chromium browser tests, 479 Deno unit tests, and four profiling-harness contract
tests. Overall coverage is 85.9% lines, 95.1% branches, and 90.2% functions;
`lib/` remains 100% across all three measures. Browser tests used isolated
port 8128.

The timing and lifecycle measurements above precede this integration; the full
Tracy sweep was not repeated after incorporating the frontend audit.

CI subsequently exposed a tooltip event-ordering defect: a queued toggle could
cancel the close timer after focus left. Only the synchronous popover transition
now cancels tooltip timers, and the regression test forces a delayed toggle. The
search striping test had expected the unfiltered drug-group parity and could
pass before the debounced search committed. It now waits for the search banner
and all 82 matching rows before checking the filtered parity, with 4× CPU
throttling to exercise that boundary. The stripe implementation is unchanged.
