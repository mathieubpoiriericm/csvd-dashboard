# Frontend bug audit — September 10, 2026

## Scope and method

Reviewed the route shells and authentication UI, both data tables, filtering,
sorting, pagination, tooltips, theme state, pipeline report controls, phenogram,
trials radar, and Leaflet map. Used source review alongside the existing unit
and production-build browser suites. Extended browser coverage for displayed
search values, table scroll behavior, map import failure, narrow popups, and
cluster keyboard activation. Added the 320px viewport to the existing six-route
runtime and overflow sweep.

The baseline passed 480 unit tests and 179 Chromium tests. Each of the six
findings below was reproduced with a failing browser assertion before its fix.

## Findings and fixes

| Finding                     | User-visible failure                                                                                                                    | Fix                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Displayed omics search      | Searching `TWAS (cross tissue)` returned no rows although that text appeared in cells.                                                  | The omics accessor uses the same formatter as the cell.                                                                         |
| Displayed confidence search | Searching `0.70` missed scores rendered as `0.70` because the search key was the number `0.7`.                                          | Search uses formatted scores; sorting retains the original numeric precision and places missing scores last in both directions. |
| Pagination scroll           | After scrolling a table down 1,000px, choosing Next retained that offset and hid the beginning of the next page.                        | Page and page-size changes reset vertical table scroll while retaining horizontal position.                                     |
| Map failure fallback        | A failed Leaflet chunk left sighted users with an error and an inaccessible visual fallback: the facility list remained clipped to 1px. | The error exposes the facility list and provides reload guidance. The error box no longer reserves an empty map's height.       |
| Narrow map popup            | At a 320px viewport, a popup measured approximately 347px inside a 294px map and was clipped.                                           | Popup width accounts for the viewport, wrapper, and gutters; long text can wrap.                                                |
| Cluster keyboard activation | Space on a focused cluster scrolled the page without expanding the cluster.                                                             | Space activates the cluster and focuses the map, complementing Leaflet's existing Enter behavior.                               |

Regression coverage lives in `e2e/tests/audit-regressions.spec.ts`,
`e2e/tests/map.spec.ts`, and `e2e/tests/runtime.spec.ts`.

## Verification and limits

- `deno task check`: passed formatting, linting, and TypeScript checks.
- `deno task test`: 480 passed.
- Full Chromium suite after the first five fixes: 185 passed.
- Final targeted search, sorting, pagination, and map suite: 23 passed.
- `git diff --check`: passed.

The browser runs build and serve the production application with test-only
authentication. Map interaction tests block external tiles; live tile-service
availability was not assessed. Browser execution covered Chromium, including
desktop, 390px mobile, and 320px narrow mobile layouts. Firefox, WebKit, and
manual assistive-technology testing were not performed. No pipeline data was
regenerated or changed.
