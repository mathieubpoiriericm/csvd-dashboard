# Production performance profiling

Run `deno task perf` after installing the Deno and E2E dependencies. The harness
starts an authenticated production server using the suite's disposable
credentials and runs Chromium serially. Tracy 0.14.1's `tracy-import-chrome` and
`tracy-csvexport` must be executable in the repository-root
`tracy-profiler-0.14.1` directory, or in `TRACY_DIR`.

Each invocation writes a new timestamped directory under `e2e/perf/artifacts/`.
These local artifacts are ignored by Git. Commit a summarized findings document,
not raw recordings. Individual runs and failures are saved as they complete.

Useful invocations after `deno task build`:

```sh
node e2e/perf/run.mjs
node e2e/perf/run.mjs --only timeline
node e2e/perf/run.mjs --only genes/search-100
node e2e/perf/run.mjs --only warm-cache
node e2e/perf/run.mjs --lifecycle-only
node e2e/perf/run.mjs --no-trace --reps 5 --throttle 4
```

`PERF_BASE_URL` selects the server address (default `http://localhost:8000`). An
existing server is reused and must have the E2E credentials and the build being
measured. Use a free local port for an isolated worktree. The correctness suite
likewise accepts `E2E_PORT`, for example `E2E_PORT=8128 deno task test:e2e`. Do
not run correctness suites, builds, or other profiling jobs during timing
measurements.

Five untraced repetitions produce each timing median. One additional trace is
for attribution only and is excluded from medians. `--reps` changes only the
number of untraced repetitions. `sampleCounts` reports how many finite
observations contribute to each median; unavailable values remain visible in
individual runs. Tracing failures fail the run; `--no-trace` explicitly opts
out. No matching scenario is an error. Required interaction outcomes are
asserted; a failed scenario stays in the report and the process exits
unsuccessfully.

The full run covers cold/mobile/network/warm loads, login, table search and
controls, tooltips, drawers, map interactions, 30 viewport pairs, and seven
20-cycle lifecycle checks. Filtered runs omit the viewport and lifecycle sweeps;
`--lifecycle-only` runs only the latter. HTTP caching remains enabled when CDP
blocks map tiles. Network scenarios use 1.6 Mbps download, 0.8 Mbps upload and
150 ms latency.

Island readiness is an explicit DOM marker set after a layout-effect commit;
Leaflet readiness requires its initialized markers. Visual settlement waits for
fonts, finite CSS animations, a 100 ms DOM-quiet window, and two animation
frames. A continuously mutating page fails after five seconds. These lab
boundaries are reported, rather than claimed to represent field vitals.

- Blocking is the sum of each long task's time beyond 50 ms within the recorded
  scenario window. It is not standardized TBT.
- Maximum observed event duration comes from EventTiming entries of at least 16
  ms. It is not field INP. Missing events and unsupported measurements remain
  `null`.
- Tracy CSV rankings aggregate zones from all threads and asynchronous spans;
  they are not renderer CPU time. Use the raw trace's renderer thread and V8 CPU
  samples for attribution. Lifecycle traces include explicit garbage collection
  and must not be used as interaction timing evidence.
- Resource sizes include navigation and per-resource transfer/body sizes. A zero
  cross-origin transfer can reflect missing Timing-Allow-Origin, not a cache
  hit.
- Layout candidates include hidden content and decorative marks. Document
  overflow is distinct from internal overflow candidates or validated
  accessibility issues.
- Lifecycle checks compare DOM/listeners after warm-up and collection. Heap
  trends are retained for inspection; stable counters do not prove absence of
  every leak.

Run `deno task test:perf` to check metric flushing, missing-data semantics,
window boundaries, and resource classification without launching a browser.
