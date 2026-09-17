# UI touch-ups — design

> Approved design for `docs/ui-touch-ups.md`. The implementation plan is
> `docs/superpowers/plans/2026-09-10-ui-touch-ups.md`.

Source: `docs/ui-touch-ups.md` (12 items across About, Phenogram, Trials table,
Trials radar, Trials map).

## Context

The to-do list is a pass of presentational fixes plus one data-shaped change.
Exploration found three things that reshape the work:

- **Trial status is not published.** `data/table2.json` has 13 fields and no
  status; `pipeline/export/main.py:_read_curated_trials` strips `overall_status`
  on purpose (rationale in `pipeline/CLAUDE.md` ~L1284-1348). Only the map's
  `data/geocoded_trials.json` carries a per-facility `status`. "Remove completed
  studies but keep them in the record" therefore needs the column published and
  a filter, not a UI tweak.
- **The run widget's API labels are frozen data.** Labels are assigned by
  `SERVICES` in `pipeline/api_telemetry.py` at call time, stored verbatim inside
  the `pipeline_runs.report` JSON blob, and `read_pipeline_run`
  (`pipeline/export/lookups.py:211-249`) re-emits the stored document. Editing
  the registry changes nothing in `data/pipeline_run.json` until a new run — so
  the export has to re-resolve labels on read.
- **Keys under the plate is a documented decision** (CLAUDE.md "The key sits
  under the plate, always", and the `.timeline-layout` / `.phenogram-layout`
  comments in `assets/app.css` ~L3210-3290). Moving them above needs the docs
  rewritten, and the skip links retargeted.

Decisions taken with the user:

1. **Status filter, default excludes Completed.** Publish `overallStatus`; the
   Trials table, the radar and the map each get a "Study status" group whose
   default unticks Completed. Rows with no CT.gov record stay visible under an
   "unknown / not stated" choice.
2. **Keys move above the plate, collapsed by default** (`<details>`), on both
   figures.
3. **Web only.** `scripts/timeline_figure.py` and the About-page totals keep
   every published row; the Python count pins move only for the empty-wedge
   colour change.

## Workstream A — About page (items 1-5)

### A1. Warning card without registration marks

- The "+" corners are `.card::after` (`assets/app.css:1136-1176`), shared by the
  17-member surface recipe at `app.css:1099-1119`. `.about-warning` has no CSS;
  `.warning-card` (`app.css:2390`) is only a tint modifier used once
  (`routes/index.tsx:231`).
- Change: the notice stops being a framed surface. In `routes/index.tsx` render
  `<div class="notice notice-warning about-warning">` (keep `about-warning`:
  `e2e/tests/about.spec.ts:22` selects it). Add `.notice` / `.notice-warning` to
  `assets/app.css` outside the recipe list: tint background via `--svd-tint`,
  left stripe, `--svd-radius-md`, no `::after`. Remove `.warning-card` and its
  three `isRecipeModifier` cases in `tests/styles_contract_test.ts:455-530` (and
  the mentions at `:707`, `assets/CLAUDE.md:50`, `app.css:4480` comment). Do not
  cancel the marks with `.about-warning::after { content: none }` —
  `styles_contract_test.ts:1071-1084` states "do not drop the registration marks
  from a framed element"; an unframed element is the honest answer.

### A2. Drawer trigger reads as a button at rest

- `islands/PipelineRun.tsx:471-482`; CSS `assets/app.css:4643-4668`. Rest state
  is deliberately flat and pinned by `tests/styles_contract_test.ts:1520-1562`
  ("wears no fill or ring at rest").
- Change: give the rest state the drawer-close treatment already on the page
  (`.timeline-drawer-close, .pipeline-drawer-close`, `app.css:3628-3651`):
  `border-color: var(--svd-border)`, `background: var(--svd-bg-light)`, keep
  `color: var(--svd-link)` and the chevron; hover/focus-visible keep the accent
  fill and ring. Rewrite the F16 contract test to pin the new rest rule (visible
  border + light fill, accent only on hover/focus). Not a filled primary button:
  `.login-submit` is documented as the one filled exception to "buttons are line
  drawings".
- Wording stays "View everything this run recorded"
  (`e2e/tests/about.spec.ts:105-126` opens the drawer by that name).

### A3-A5. Service names in "External services"

- Rendered rows come from `apis[]` in `data/pipeline_run.json`, one per
  `(service, endpoint, method)` (`pipeline/api_telemetry.py:163-176`). Today:
  "NCBI E-utilities" ×3 (efetch, esearch, esummary), "Europe PMC" ×2 (search,
  `:id/fullTextXML`), and three raw hostnames (`linkinghub.elsevier.com`,
  `journals.sagepub.com`, `www.jstage.jst.go.jp`) that fall through
  `resolve_service` (`api_telemetry.py:128-152`).
- Change in `pipeline/api_telemetry.py`:
  - Keep the service keys (`pubmed_search.py:192-196` hardcodes `"ncbi_eutils"`;
    `test_api_telemetry.py:93-101` pins ClinVar sharing that key). Add an
    endpoint-qualified label lookup — e.g. `ApiService` gains an optional
    `endpoint_labels: dict[str, str]`, and a new
    `display_label(service_key, endpoint)` returns the qualified label when the
    normalised endpoint matches, else the service label, else the key. Labels:
    `/entrez/eutils/esearch.fcgi` → "E-utilities search",
    `/entrez/eutils/esummary.fcgi` → "E-utilities summary",
    `/entrez/eutils/efetch.fcgi` → "E-utilities fetch";
    `/europepmc/webservices/rest/search` → "Europe PMC search",
    `/europepmc/webservices/rest/:id/fullTextXML` → "Europe PMC full text".
  - Register the three PDF hosts as ordinary entries (append; suffix match):
    `linkinghub.elsevier.com` → "Elsevier ScienceDirect", `journals.sagepub.com`
    → "SAGE Journals", `www.jstage.jst.go.jp` → "J-STAGE". Keep the
    "unregistered host labels itself" fallback (tests use `link.springer.com`).
  - `ApiRecorder._row` and `_service_label` route through `display_label`, so
    the hardcoded `pubmed_search.py` call site gets "E-utilities search" without
    editing it.
- Change in `pipeline/export/lookups.py:read_pipeline_run`: after
  `model_validate`, re-resolve every `apis[].label` through
  `display_label(service, endpoint)` before `to_wire()`. This is what makes
  `deno task data` rewrite the committed file; document in `islands/CLAUDE.md`
  ("Source labels ride the wire…", ~L193-197) that the wire label is _derived at
  export_ from the registry, so a rename reaches the file without a run. Apply
  the same re-resolution to the syncs export if `data/pipeline_syncs.json`
  carries `apis` (check `read_pipeline_syncs` /
  `components/PipelineSyncs.tsx:98-115`).
- Tests to update:
  `tests/pipeline/test_api_telemetry.py:53-71, 93-101, 265-277`;
  `tests/pipeline/test_api_inventory_wiring.py:70-87, 144-160`; add cases for
  `display_label` and for the export re-resolution (fixture blob with a stale
  label → new label on read). TS fixtures in
  `tests/pipeline_widget_test.tsx:136-150, 299-307` and
  `tests/pipeline_run_data_test.ts:146` keep passing as fixtures; update the
  literals to the new names so they stop asserting the old ones.
  `e2e/tests/about.spec.ts:213-230` (no bare hostnames in `.pipeline-sync`)
  stays; consider extending it to the run drawer now that the three hosts are
  named.
- Requires regenerating `data/pipeline_run.json` (see "Data regeneration").

## Workstream B — publish trial status and add the filter (Trials table, item 1)

### B1. Export

- `pipeline/export/main.py:_read_curated_trials` (~L184-250): stop stripping
  `overall_status`; keep the TERMINATED/WITHDRAWN gate. Rewrite the docstring
  paragraph that justifies the strip.
- `pipeline/export/tables.py`: add `"Overall Status"` to `_UNKNOWN_COLUMNS`
  (L242) so NULL → `"(unknown)"`; confirm `clean_column_name("overall_status")`
  → `"Overall Status"` → wire key `overallStatus`. Values published as CT.gov's
  upper-case tokens (`RECRUITING`, `COMPLETED`, `UNKNOWN`, …).
- Byte-exact gate: `tests/pipeline/export/test_writer.py` re-encodes the
  regenerated file; `tests/pipeline/export/test_export_main.py` fixtures gain
  the column. Rewrite the "not published because…" section of
  `pipeline/CLAUDE.md` (~L1284-1348) and the CLAUDE.md bullet
  "`data/table2.json` publishes only curated trial rows".
- Before regenerating, check coverage read-only:
  `SELECT overall_status, count(*) FROM clinical_trials WHERE svd_population IS NOT NULL GROUP BY 1`.
  If NCT rows are largely NULL, run the status refresh (`update_trial_statuses`,
  reached from `pipeline/clinical_trials_fetch.py:993` via the
  `--clinical-trials` sync) first — otherwise the default filter hides nothing.

### B2. Types, data boundary, contract

- `lib/types.ts:35-50` `Trial` gains `overallStatus: string`.
  `lib/data/trials.ts` normalises it like the other text fields.
- `tests/data_contract_test.ts`: add to `TRIAL_STRING_FIELDS` (L42-56); add the
  status dimension to `trialDefaults`/`dimensions` (L457-470) so every published
  value is reachable through a choice; the `nctIds` check (L487-522) is
  unaffected because no row is dropped.

### B3. Filter vocabulary and matching

- `lib/constants.ts`: `STATUS_CHOICES`, **derived from `TRIAL_STATUSES` in
  `lib/trials.ts`** (export it) minus the `terminated` kind (never published),
  plus the sentinel folded into the UNKNOWN choice. Labels as in `lib/trials.ts`
  ("Recruiting", "Enrolling by Invitation", "Active, Not Recruiting", "Not Yet
  Recruiting", "Completed", "Unknown / not stated"). Includes `SHOW_ALL` like
  the other `showAll` groups.
- `lib/filters.ts`: `TrialFilters` gains `statuses`; `filterTrials` adds
  `matchesStatus` (case/whitespace-normalised; `"(unknown)"` and `UNKNOWN` both
  satisfy the UNKNOWN choice). `tests/filters_test.ts:20-26` `NO_TRIAL_FILTERS`
  gains the key; add unit cases.
- **Default that is not Show-All** — first in the codebase.
  `components/useCheckboxFilters.ts:17-26` decides defaults; add an optional
  `initial: string[]` on `FilterDefinition`, used by `initialValues()` (and so
  by `reset()`). `nextSelection` in `components/CheckboxFilter.tsx:41-64`
  already handles a partial selection. Export a `DEFAULT_TRIAL_STATUSES` (all
  choices except `COMPLETED`) from `lib/constants.ts` so the three islands and
  the tests share it. The `Active Filters:` readout will print the status group
  on first paint; that is intended — it tells the viewer Completed is hidden.
- `islands/TrialsView.tsx:197-219` `FILTERS`: add the "Study status" group with
  `initial: DEFAULT_TRIAL_STATUSES`. Add a `lib/filters.ts` helper
  `defaultTrialFilters()` / `visibleTrials(trials)` so
  `tests/routes_test.tsx:207-250` and `lib/data/summary.ts` consumers can
  compute counts rather than hardcode them.

### B4. Table column

- Add an "Overall Status" column definition in `TrialsView` (13 → 14 columns;
  `e2e/tests/trials-table.spec.ts:133-139` pins 13). Display via
  `resolveTrialStatus(...).label`. Include it in `DRUG_FIELDS` for the radar
  drawer/tooltip only if it earns a row — the drawer lists all fields with a
  rule between each; a twelfth `<dt>` moves `e2e/tests/timeline.spec.ts:290-348`
  (11 `dt`s). Recommended: add it to the drawer (whole record), not the tooltip.

## Workstream C — Trials radar (items 1-3)

### C1. Status filter on the radar

- `islands/TrialsTimeline.tsx:36` computes `LAYOUT` once at module scope from
  all `trials`; ~15 sites read it. Change: a `useCheckboxFilters` instance with
  the single "Study status" group (same `initial`),
  `filtered = filterTrials(trials, …)`,
  `layout = useMemo(() => computeTimelineLayout(filtered))`, threaded into every
  `LAYOUT.` read and into the measurement/`separateLabels` effects (re-run when
  `layout` changes — key the label-metrics effect on the marker id set). Sector
  widths follow the rule (span ∝ unique drugs), so sectors reshape as rows hide;
  that is the layout contract, not a bug.
- Render the group as a compact `.timeline-controls` strip (a `CheckboxFilter`
  without the sidebar `FilterPanel`) placed inside the new `<details>` key or
  directly above `.timeline-main`; the `Active Filters:` line is not available
  here, so include the "n of 102 trials shown" count in the strip.
- SSR: `tests/routes_test.tsx:231-250` pins `class="drug"` count ==
  `trials.length`; switch to `visibleTrials(trials).length`.

### C2. Empty wedges take the population colour

- Today `lib/timeline_encoding.json:92-95`
  `emptyCell: { color: "#ffffff", opacity: 1 }`; per-cell colour chosen in
  `lib/timeline.ts:404-419` and `scripts/timeline_figure.py:236-250`.
- Change the encoding to `emptyCell: { opacity: <faint, e.g. 0.12> }` (drop
  `color`); both renderers use `sector.color` for every cell, with
  `ring.opacity` when filled and `emptyCell.opacity` when empty; keep `filled`
  on the cell. Rim bands stay gated on `drugCount > 0`. Verify contrast of the
  `boundary` hairline against the faint tint in light and dark plate (plate is
  white in both).
- Tests: `tests/timeline_layout_test.ts:87-103` and
  `tests/scripts/test_timeline_figure.py:78-94` (cell colour assertions),
  `tests/timeline_encoding_test.ts` if it reads `emptyCell.color`.
  `e2e/tests/timeline.spec.ts:222-243` fills are for `rect.label-bg`,
  unaffected. Print figure counts otherwise unchanged (web-only decision).

### C3. Key above the plate, collapsed

- `islands/TrialsTimeline.tsx:1019-1028, 1267`: wrap `<TimelineLegend />` in
  `<details class="figure-key" id="timeline-key">` with a `<summary>` ("Key"),
  placed after the skip link and before `.timeline-main`. Retarget the skip link
  to a `tabIndex={-1}` landmark after `.timeline-main` (e.g. `#timeline-end`,
  visually-hidden "End of figure"); `e2e/tests/timeline.spec.ts:731-739`
  retargets with it. Dark-mode contrast test `:600-649` selects inside
  `.timeline-legend`; open the details in the test before asserting.
- CSS `assets/app.css:3283-3303`: `.timeline-layout` stays a column; add
  `details.figure-key` styling (summary as a control matching
  `.pipeline-apis summary`, panel grid unchanged). Delete the "Plate first, key
  under it — always" comment block and write the new rule.

## Workstream D — Phenogram key above the plate (item 1)

- Same treatment: `islands/Phenogram.tsx:309-316, 367` —
  `<details class="figure-key" id="phenogram-key">` before `.blueprint-frame`;
  skip link → `#phenogram-end`; `e2e/tests/phenogram.spec.ts:196-204` retargets.
  Shared `.figure-key` CSS. Comment block at `app.css:3210-3222` rewritten.
  `e2e/tests/runtime.spec.ts` (no horizontal overflow at three widths) is the
  regression net for the reflow.

## Workstream E — Trials map (items 1-2)

- Status is already per-facility in `lib/data/locations.ts`
  (`TrialLocation.status`, `lib/types.ts:137-147`) and resolved by
  `resolveTrialStatus`; no join needed. `islands/TrialsMap.tsx` has no filter
  state (`:152` only `loadError`).
- Change: the same "Study status" `CheckboxFilter` group (same `STATUS_CHOICES`
  / `DEFAULT_TRIAL_STATUSES`, matched against `location.status` with null →
  UNKNOWN choice) rendered as a `.map-controls` strip above `.map-container`. On
  selection change, clear and re-add the cluster layer from the filtered
  locations inside the existing Leaflet effect (keep the sequential import order
  and per-add a11y decoration from `islands/CLAUDE.md`). The visually-hidden
  `LocationList` follows the filter. `.map-stats` keeps the whole-file
  provenance numbers but adds "showing n of 378 sites".
- Tests: `e2e/tests/map.spec.ts:19-36, 203-219` (378 `li`),
  `e2e/fixtures/expected-data.ts:26-33`; popup status regex at `:113-129` keeps
  `completed` reachable by ticking it. `tests/routes_test.tsx:253-262` (`<li>`
  count == `trialLocations.length`) → filtered count. Fix the stale "8 of 16
  trials" comments in `routes/map.tsx:16-19`, `e2e/tests/map.spec.ts:293-298`,
  `e2e/CLAUDE.md:53-55`.

## Data regeneration (prerequisite for B/C/E pins and A3-A5)

- Follow the `regenerate-data` skill: PostgreSQL reachable, `.env` populated.
  Order: (1) status coverage check and refresh if needed, (2) `deno task data`
  (rewrites `table2.json` with `overallStatus` and `pipeline_run.json` with
  re-resolved labels), (3) `deno task geocode` only if the `nctIds` set changed
  (it should not).
- Re-pin every count that moves and record the new numbers in the commit
  message. Files: `e2e/tests/trials-filters.spec.ts` (TOTAL, per-group counts,
  choice counts L185-197 gain the status group, the `for` loops at L39/L172),
  `trials-table.spec.ts` (page counts, Aspirin rowspan, CADASIL 5, Academic 82,
  13 columns), `readout.spec.ts` (102/102, CADASIL 5, seven phase labels — an
  emptied bucket shrinks the list), `timeline.spec.ts` (102 `g.drug`, 28 wedges,
  21/16 rings, 113/102 boxes, first CAA marker "Jiedu Huayu", 9/12 rings),
  `performance-behavior.spec.ts:96-125`, `tooltips.spec.ts:345-392` (NCT05755997
  and the four gene rows must still be visible or the search cases retargeted),
  `tests/timeline_layout_test.ts` (only C2's colour assertion moves — the layout
  test reads the raw `trials`), `tests/scripts/test_timeline_figure.py` (same).
- The timeline collision pin (`timeline.spec.ts:106-220`, zero collisions over
  the box count) must be **re-verified at zero** after the marker set changes,
  not renumbered.

## Docs to update

- `CLAUDE.md`: table2 "publishes only curated trial rows" bullet; the two "key
  sits under the plate" paragraphs (Timeline and Phenogram); filters section
  (first non-Show-All default; `initial`); map section pointer.
- `pipeline/CLAUDE.md` ~L1284-1348: status is now published; why the sentinel
  and the UNKNOWN fold.
- `islands/CLAUDE.md`: labels derived at export from the registry; map filter
  and cluster rebuild.
- `assets/CLAUDE.md:50` (`.warning-card` gone; `.notice` is not a framed
  surface).
- `e2e/CLAUDE.md` stale counts.

## Order of work

1. A1, A2 (pure CSS/markup + contract test) — independent, ship first.
2. A3-A5 Python registry + export re-resolution + tests (no data yet).
3. B1-B3 export + types + filter vocabulary + hook `initial` + unit tests,
   against fixtures.
4. Regenerate data; B4, C1, E islands; re-pin e2e.
5. C2 empty-wedge colour (both renderers + pins).
6. C3, D keys above + skip-link retarget + CSS + e2e.
7. Docs.

## Verification

- `deno task check`, `deno task test:coverage` (100 % floor under `lib/`),
  `uv run pytest`, `uv run pytest tests/scripts`, `uv run ruff check .`,
  `uv run ty check`.
- `npx --prefix e2e playwright test -c e2e/playwright.config.ts` — full suite
  (production build; pre-authenticated harness).
- Manual pass on `deno task start` at 1440 / 900 / 390 px: About (notice
  unframed, trigger visibly a button, service names in the drawer), Trials
  (status group defaulted, readout line, Completed returns when ticked), Radar
  (key collapsed above, empty wedges tinted, filter reshapes sectors, drawer
  opens, no label collisions), Phenogram (key collapsed above, skip link lands
  after the plate), Map (status strip, cluster rebuild, hidden list count).
- `deno task figure` still renders (empty cells tinted; counts unchanged).
