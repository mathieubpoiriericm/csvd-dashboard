# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Commands

Tasks live in `deno.json`. Run `deno install` first — `nodeModulesDir` is
`"manual"`, so dependencies are never resolved implicitly.

A single end-to-end spec:
`cd e2e && npx playwright test
tests/genes-filters.spec.ts`.

`uv run pytest` collects only `tests/pipeline` (`testpaths` in
`pyproject.toml`), so after touching `scripts/` run
`uv run pytest tests/scripts` explicitly — CI names that path in a step of its
own for the same reason. `deno task check` (fmt, lint, `deno check`) and
`deno task test:coverage` are the TypeScript gates; `uv run ruff check .` and
`uv run ty check` the Python ones. Do not run `ruff format`.

`uv run python -m scripts.reconcile_omim` compares the curated
`gene_monogenic_links` rows against ClinVar's OMIM numbers in
`data/gene_annotations.json`. It is a report and writes nothing: the curated
column is a scientific judgement, and every disagreement it prints needs a
human.

A long `--days-back` run is resumable: every paper is checkpointed to
`logs/pipeline_checkpoint.jsonl` as it finishes, so a crash costs the papers in
flight and nothing else — re-run the same command. **`--batch` is the exception
to "and nothing else"**: every paper is in flight until the batch's results
arrive, and the batch id is held only in the run log, so a crash inside the
up-to-24h poll loses the whole submission. Re-running resubmits every paper and
pays again while the first batch completes at Anthropic unretrieved.
`uv run python -m scripts.backfill_pubmed` walks the window in committed chunks
instead, for when the database should be updated as it goes. See "Long windows"
in `pipeline/CLAUDE.md`.

Regenerating `data/*.json` needs PostgreSQL reachable and `.env` populated. The
commands, the hardened `dhi.io/postgres:18.6` container with its three
load-bearing details, and the print-figure and cytoband tasks are in the
`regenerate-data` skill (`.claude/skills/regenerate-data/SKILL.md`).

`--export` does that same work at the end of a live run, so the figures, the
About page's date and the run widget track the database without a second
command. It **stops at the working tree** — the files are left modified and
nothing is committed, because the curated `genes` table is a scientific
judgement and the e2e fixtures pin exact row counts. It is refused with
`--local-pdfs` / `--pmids`, which publish no data; it is skipped after a
`--dry-run` or `--test-mode` preview, which writes nothing; and it runs even
when a pipeline **failed**, because `_record_failed_run` persists that failure
for the widget and not exporting is what would keep it invisible. An export
failure is folded into the exit code — the database having moved while the files
did not is the condition the flag exists to remove.

**A PubMed run refreshes the three lookup caches before that export**, for its
own new gene keys and PMIDs only (`_refresh_lookup_caches`, skipped when
`--sync-external-data` ran in the same invocation, which covers them anyway).
Nothing inside a run writes `ncbi_gene_info`, `uniprot_info` or
`pubmed_citations`, and `complete_lookup` turns a key it cannot find into a row
of nulls rather than failing — so `--export` used to publish every newly
inserted gene with a null NCBI uid, description and alias list and every newly
attached reference as `"(citation not available)"`. Each source fetches only its
own cache misses, so this costs what the run added and nothing more. It is
best-effort: a source that cannot be reached is logged as an error and the
export still runs, because the database has moved and leaving the files behind
it is worse. A run that _raised_ leaves no report to read those keys out of, so
whatever it merged before it died waits for the next `--sync-external-data`.

`deno task geocode` stays separate because it calls out to clinicaltrials.gov,
so a run that adds a trial needs it too or `tests/data_contract_test.ts` fails
on the `nctIds` set. `deno task figure` stays manual as well; `figures/` is
gitignored.

Tests never touch that database. `tests/pipeline/conftest.py` clears the `DB_*`
variables — and the whole `PIPELINE_*` namespace, so a value left in `.env` for
a local experiment cannot change what the default-config tests measure — and a
test needing real SQL uses the throwaway database `CSVD_TEST_DB_URL` names (CI's
`postgres` service) or, with that unset, brings up its own container — from
`dhi.io/postgres:18-alpine3.23`, not the glibc image the skill documents for a
mounted data directory — on its own address under Apple's `container` runtime.
See "Database tests" in `pipeline/CLAUDE.md`.

Vite is pinned to 7.x because `@fresh/plugin-vite` requires `vite@^7.1.4`.

`deno task perf` builds, brings up the gated production server and measures
responsiveness: every route's cold load, fourteen interactions, and a layout
sweep over five viewports. It runs under **4x CPU throttling** — unthrottled on
an Apple-silicon laptop every surface measures as instant, which is the
measurement failing to discriminate rather than a result — and reports the
median of three repetitions. Two channels are recorded per scenario, so a
failure in one never leaves a surface unmeasured: in-page `PerformanceObserver`
metrics (long tasks, INP, layout shift, TTFB/FCP/LCP, transferred bytes) and a
Chromium CDP trace converted by `tracy-import-chrome` and ranked by self time
with `tracy-csvexport -e`. **Tracy cannot instrument Preact** — the capture is
an ordinary DevTools trace and Tracy is only the analysis backend, so a missing
binary degrades the run rather than failing it. The binaries and the artifacts
are gitignored — they are expected at the repository root, so a worktree needs
`TRACY_DIR` pointed at the main checkout's copy or it records in-page metrics
only. The numbers live in
`docs/superpowers/specs/2026-09-03-responsiveness-findings.md`. **Read INP, not
blocking time, for the interaction scenarios** — the `longtask` API only reports
tasks over 50 ms, so blocking time ignores everything below that and rises when
the same work consolidates into fewer, longer tasks.

**`compression()` in `main.ts` is the outermost middleware, and that position is
load-bearing.** Nothing compressed before it: `staticFiles()` serves the built
bundles verbatim, so `deno task start` shipped the 409 KB protected-data chunk,
the 79 KB stylesheet and the 152 KB Leaflet bundle at full size — and because
the gate makes both the HTML and that chunk `no-store`, every navigation paid
again. Compressing outside `protectDataAssets()` is what lets it cover the
protected chunk that middleware rewrites. It skips anything already carrying
`Content-Encoding`, so an edge that compresses cannot double-encode; it skips
fonts and images, which are already compressed containers; and it suffixes the
`ETag`, because the gzip body is a different representation from the one
`staticFiles()` tagged. Measured, every route dropped from 760–1000 KB to
204–255 KB. It steps aside in development mode: under Vite the gzip body arrived
corrupt and Chromium never reached `load`. `ctx.config.mode` alone cannot tell
it that: `@fresh/plugin-vite`'s generated server entry hardcodes `"production"`
into `setBuildCache` for `deno task dev` as well as the build, so
`server/compression.ts` also reads Vite's own `import.meta.env.DEV`, which
`deno task start` -- outside Vite entirely -- never sets.

**Playwright writes into `.playwright-mcp/` inside the project, and Vite watches
the project.** `vite.config.ts` ignores that directory and `logs/` for exactly
this reason. Before it did, screenshotting or logging during `deno task dev` put
the page into a reload loop — every write triggered a full reload, and a
`console.log` in an island made it self-sustaining. It looks exactly like an
island that will not hydrate. It is not.

## Worktrees

`.venv`, `.env` and `node_modules` live in the main checkout only. In a
`.claude/worktrees/*` checkout:

- Run every uv command with `UV_PROJECT_ENVIRONMENT=<main checkout>/.venv`, the
  absolute path of the main checkout's `.venv`. Without it `uv run` builds a
  second venv (torch included) inside the worktree, and its auto-sync can drop
  the `figure` group from the shared one -- `uv sync --group dev --group figure`
  restores it, and until then `tests/scripts` skips and `ty` warns about
  matplotlib.
- `deno install` once per worktree, and `npm ci --prefix e2e` for Playwright.
  The whole suite runs from the repo root:
  `npx --prefix e2e playwright test -c e2e/playwright.config.ts [tests/x.spec.ts]`.
- Copy `.env` in before `deno task data` or a live run; it is gitignored.
- The branch is `worktree-<name>`; push it as `git push origin HEAD:<name>` -- a
  bare `git push` refuses the mismatch.

## Architecture

One pipeline, one language, meeting the web app at a JSON file boundary.

```text
PubMed / Europe PMC / CT.gov ──> pipeline/ ──> PostgreSQL ──> pipeline/export/ ──> data/*.json ──> islands
```

**The disease seam is `disease/`.** Everything that names the disease lives
there and nowhere else, split across two manifests for one reason:
`server/protected_data_build.ts` lists `COL4A1/2` as a leak canary and every
island bundle embeds the web-facing manifest, so no gene symbol may live in it.
`manifest.json` holds the web-facing keys (prose, institute, contact, about,
hosting, populations, populationField, cell-type glossary, citation standard);
`pipeline.json` holds the pipeline-only keys (search terms, monogenic genes,
gene aliases, run label, gene cap) and is read only by `pipeline/disease.py`.
Both have a JSON Schema beside them (`manifest.schema.json`,
`pipeline.schema.json`). Also in `disease/`: `vocabulary.json`, `prompt.md` (the
disease half of the extraction prompt; the methodology is the v7 template in
`pipeline/prompts.py`), `phenogram.json` (families), `timeline.json`
(populations, mechanisms, families) and `omim_info.csv`. `prompt.md` is excluded
from `deno fmt` in `deno.json` because `deno fmt` rewraps Markdown prose and
every inserted newline would reach the model;
`tests/pipeline/test_prompt_assembly.py` pins the cSVD rendering byte-identical
to the v6 literals. TypeScript reads the manifest through the narrow modules
under `lib/disease/` — `site.ts`, `populations.ts`, `cell_types.ts`,
`citation.ts` — and Python through `pipeline/disease.py`, which is stdlib-only
so `config.py` and `extraction_models.py` can both import it.
`tests/no_disease_literals_test.ts` and
`tests/pipeline/test_no_disease_literals.py` scan the code for the manifest's
own terms and fail on any hit outside a reasoned allow-list. Every measurement
in this file and in `pipeline/CLAUDE.md` is of the cSVD dataset this repository
was built on. The design is
`docs/superpowers/specs/2026-09-17-disease-reuse-design.md`.

**Nothing queries a database at request time, and nothing fetches JSON at
runtime.** The modules under `lib/data/` use `import … with { type: "json" }`,
so each file is bundled into whatever imports it. **Import the narrow module,
not the barrel** — `lib/data.ts` re-exports all of them, and an island that
reaches for it pulls the whole ~350 KB dataset into its client bundle instead of
the one table it renders. The barrel exists for the tests that exercise the
complete boundary. Consequences worth remembering:

- Editing `data/*.json` requires a rebuild/HMR cycle to show up.
- **`data/gene_annotations.json` is the one machine-fetched file among them**,
  and the only one whose rows are a pivot rather than a table dump. It is
  written from the `gene_annotations` table by `--sync-annotations` (see
  `pipeline/CLAUDE.md`), one row per `(gene, disease)` rather than one per
  cross-reference, because the raw table is ~4700 rows and this file is bundled
  like every other. Only ClinVar's attested diseases and Orphanet's enrichment
  of them are published; Open Targets' ranked associations and GO terms stay in
  PostgreSQL, where a query that wants them can reach them. **`relatedXrefs` is
  not a list of more identifiers for the row's disease** — each entry names a
  _different_ concept and carries the relation its source reported, verbatim and
  never invented. Merging one into `omimId` would publish a different disease's
  OMIM number as this gene's, which is the error the annotations exist to
  remove. `omimSeries` is separate for the same reason: a phenotypic series
  names a group of phenotypes, so `omimByNumber` can never resolve one. It is
  also the one export file that is **skipped rather than emptied** when its
  table has no rows, because only `--sync-annotations` fills it and `[]` would
  otherwise publish over the committed file atomically. Only a genuinely empty
  read reaches that rule: `read_disease_annotations` tolerates a missing table
  and nothing else, so a renamed column or a revoked `SELECT` fails the export
  rather than freezing the file at its last good read.
- `data/pipeline_run.json` is committed as a bare `null` until a run records a
  report, exactly as `data/pipeline_status.json` was. Both states are covered;
  the About page falls back to the summary card for the null one.
- **`data/pipeline_syncs.json` is the reference-data refreshes**, one entry per
  sync mode, committed as `[]` until one is recorded. It is a separate file
  because a refresh is a separate event from a run — and a separate table, so
  that no query feeding the run widget or the About page's date badge can see
  one. It is what publishes the upstreams only the syncs touch: ClinVar,
  Orphadata, Open Targets, UniProt and ClinicalTrials.gov reached no committed
  file before it, because `build_run_report` is reachable only from inside
  `run_pipeline`. See "The refreshes record their own runs" in
  `pipeline/CLAUDE.md`.
- `tests/filters_test.ts` asserts against the _real committed rows_ (e.g. exact
  row counts for a trait filter). Regenerating data can legitimately break tests
  — check whether the data changed before "fixing" the filter. The trial
  populations are pinned in five more places, all of which move together:
  `tests/timeline_layout_test.ts` and `tests/scripts/test_timeline_figure.py`
  (sector drug counts, empty cells, the shared-cell pair and its ring
  thickness), `e2e/tests/trials-filters.spec.ts` (per-population counts),
  `e2e/tests/timeline.spec.ts` (the first marker drawn, and accessible names
  that use the population _label_ -- "Any SVD (including monogenic)", not "SVD")
  and the "CADASIL" search counts in `e2e/tests/readout.spec.ts` and
  `e2e/tests/trials-table.spec.ts`.
- `tests/data_contract_test.ts` asserts against the raw committed JSON, and is
  the guardrail that proved the R-to-Python export port faithful. Keep it.
- The export itself is covered by `tests/pipeline/export/` and runs in CI,
  against fixtures rather than a live database.
- **JSON output is byte-exact, and every exported file is gated on it.**
  `tests/pipeline/export/test_writer.py` parses each `data/*.json`, re-encodes
  it through the writer and compares the bytes; a companion test fails if a file
  appears in `data/` with no case, so the gate cannot quietly cover less than
  the directory. `data/cytobands_hg38.json` is the one exception, and is listed
  as such: it is not the export's output but `scripts/fetch_cytobands.py`'s, and
  `deno fmt --check .` is what gates its formatting. It needs no database and
  runs in milliseconds. This is what catches a formatting divergence before it
  turns the first regeneration into an unreviewable whole-file diff — the way
  the missing `</` → `<\/` escaping (jsonlite escapes a slash only after `<`;
  `json.dumps` never does) would have rewritten every row of `refs.json`.
  `json.loads()`-equality sees none of this.
- **Every export query needs an `ORDER BY`.** Without one PostgreSQL returns
  rows in whatever physical order it likes, so the byte-exact contract above
  cannot hold across runs. One unordered `SELECT * FROM clinical_trials`
  reordered `gene_info_table2.json` too, because `split_genetic_targets()` feeds
  the lookup request lists and `complete_lookup()` restores _request_ order.
  `_read_table` orders by `id`; the lookups inherit determinism from it.
  `_read_genes_with_lists` needs **two** -- `genes` by `id`, and each join table
  by `(gene_id, ordinal)`, because the within-gene order reaches the JSON array
  as well. `read_disease_annotations` orders by
  `(gene_symbol, group_key, source, object_id)`, and the `source` term is
  load-bearing beyond determinism: it puts ClinVar's rows before Orphadata's,
  which is what lets an exact Orphanet mapping fill only a column ClinVar left
  empty.
- **`data/table2.json` publishes only curated trial rows.** `--clinical-trials`
  writes ClinicalTrials.gov discoveries into the same table, with every curator
  column NULL; `_read_curated_trials` in `pipeline/export/main.py` skips any row
  with no `target_population` and logs the count, so a discovery no one has read
  cannot reach the dashboard as `(unknown)` mechanism, population and evidence —
  values no filter choice offers and the radar draws nowhere. See
  "ClinicalTrials.gov rows must read like the curated ones" in
  `pipeline/CLAUDE.md`.
- Facility coordinates come from ClinicalTrials.gov's `geoPoint`, which is
  computed as `GeoPoint(City, State, Country)` — city-level, not facility-level.
  `jitter_duplicate_coordinates()` fans out co-located sites. No geocoding
  service is involved. A site with no `geoPoint` is dropped rather than
  defaulted — a marker at (0, 0) is worse than no marker — and both that drop
  and a trial that ends up contributing no marker at all are logged by name: the
  trial is still in `nctIds`, and `tests/data_contract_test.ts` compares only
  that set, so nothing else would say the map is missing it.

### Gene lists

Three `genes` columns held delimited lists inside TEXT until migration 005 moved
them into join tables -- `gene_references(gene_id, ordinal, pmid)`,
`gene_gwas_traits(… trait)`, `gene_monogenic_links(… omim_id)` -- and 006
dropped the columns. `references` had already been destroyed once by a
spreadsheet round-trip that read the whole PMID list as one number; one value
per row makes that impossible rather than merely detectable.

Three things about the arrangement are load-bearing:

- **`_GENE_COLUMNS` in `pipeline/export/main.py` is what holds the JSON key
  order.** `clean_gene_row` derives its output order from the incoming row, so a
  `SELECT *` would drop the three names from the projection and
  `published.update()` would re-append them at the _end_ of every row. They are
  named in the projection and selected as `NULL` placeholders instead, which
  holds their position and makes the reader behave identically either side of
  the drop. `tests/pipeline/export/test_export_main.py` pins the constant
  against the committed `data/table1.json`.
- **Sentinels are never stored.** `"(none found)"` and `"(reference needed)"`
  are produced by `clean_gene_row` from an empty list or a `NULL` placeholder. A
  gene with no references gets zero rows. `split_gwas_traits` routes through
  `fill_missing_text` for the same reason in the other direction, so a stored
  `"NA"` cannot become the trait `"NA"`. **Untracked traits are never stored
  either.** The extraction schema admits the vocabulary's `untracked` terms so
  the model can name a phenotype the dashboard does not carry, and
  `_build_combined_gene_data` in `pipeline/data_merger.py` is where they are
  dropped -- logged per gene, so the signal survives in the run log. Nothing
  used to drop them, and `ICH-non-lobar` was one merge away from
  `data/table1.json`, where no filter choice or phenogram pill exists for it.
  `clean_gene_row` applies the same disposition on the way out, plus the
  `synonyms` fold, so a row stored before the merge learned to cannot publish
  one.
- **`_append_gene_list_sql` in `pipeline/database.py` carries the merge
  invariants the delimited strings used to.** `NOT EXISTS` makes a re-run write
  nothing, `MAX(ordinal) + 1` continues the ordinals off the pre-statement
  snapshot, and `GROUP BY btrim(value)` with `MIN(ord)` collapses in-batch
  duplicates onto their first position -- what
  `string_agg(… ORDER BY
  first_ord)` did. `evidence_from_other_omics_studies`
  is deliberately _not_ normalized: `clean_omics_value` coerces free-text prose
  into a list, so what counts as one entry is a curation judgment.

`scripts/backfill_gene_lists.py` populated the tables from the old columns using
the export's own parsers. It is run as a module
(`uv run python -m scripts.backfill_gene_lists`), not as a path, and on a
database past migration 006 it exits with a message rather than failing on the
first `SELECT`: the columns it reads are gone, so there is nothing to backfill.

### The JSON contract

`pipeline/export/writer.py`'s `to_camel()` derives JSON keys from display column
names, which themselves come from `pipeline/export/text.py`'s
`clean_column_name()` applied to each database column name. `"Registry ID"` →
`registryId`. Keep these layers in sync:

| Concern               | Lives in                                 |
| --------------------- | ---------------------------------------- |
| Wire keys             | `pipeline/export/writer.py` (`to_camel`) |
| TypeScript shapes     | `lib/types.ts`                           |
| Human-readable labels | `islands/*View.tsx` column definitions   |

Two invariants the TypeScript side depends on:

1. **List-columns are always arrays.** Python lists serialise as JSON arrays
   unconditionally, so `write_rows()` needs no equivalent of R's `I()` wrapping
   — the single-element-vector unboxing it guarded against isn't possible here.
   Four `Gene` fields are always arrays. Three of them -- `gwasTrait`,
   `linkToMonogenicDisease` and `references` -- are read one row per value from
   the join tables (see "Gene lists" below) and never parsed;
   `evidenceFromOtherOmicsStudies` is still split out of prose by
   `clean_omics_value` in `pipeline/export/tables.py` -- on commas outside
   parentheses, because the extraction writes free-text elements such as
   `Proteomics (plasma, CSF)` and a split inside one left an entry no filter
   could reach. **That column is the one place the export enforces a vocabulary
   of its own**: nothing upstream constrains `omics_evidence` (the prompt only
   _suggests_ labels, so `colocalization` or `MAGMA` can arrive as free text),
   so `_OMICS_TYPES` — mirrored from `OMICS_CHOICES` in `lib/constants.ts` and
   reconciled against it by a test — is what keeps every published element
   selectable. An element carrying its detail in parentheses is rewritten to the
   wire form `Proteomics;plasma, CSF`, which keeps the detail and makes the type
   reachable; one whose leading type is outside the vocabulary is dropped and
   logged per gene, the disposition an untracked GWAS trait already gets.
   `GeneAnnotation` adds two more, `omimSeries` and `relatedXrefs`, which are
   the one place a list normalizes to **empty** rather than to a sentinel entry:
   most diseases have no related concept at all, and `textList`'s fallback would
   render as though it were an identifier. `lib/data/annotations.ts` carries its
   own `textArray` and `relatedXrefs` normalizers for that reason.
   `relatedXrefs` is also the only array of objects in the wire format, and
   `sourceVersions` the only object; `write_rows` camelCases top-level keys
   only, so `relatedXrefs`' `id` / `relation` and `sourceVersions`' source keys
   are all written verbatim.

   **`sourceVersions` is keyed by source, and that is a correction rather than a
   flourish.** A published row is assembled from ClinVar and Orphadata, which
   version themselves separately, so the single `sourceVersion` it used to carry
   could only ever name one of them — and it named whichever was read last,
   which `ORDER BY … source` makes Orphadata: 63 of the 111 rows were stamped
   with an Orphadata release date that said nothing about the ClinVar rows
   beside it. A key present with a `null` value means that source contributed
   rows and publishes no version of its own, which is ClinVar today; the shape
   therefore says which sources were read as well as when.
2. **Sentinel strings are load-bearing.** Absent values become `"(none found)"`,
   `"(unknown)"`, `"(none)"` and are matched literally by the filter choices in
   `lib/constants.ts`. Those choice `value`s must stay byte-identical to what
   `pipeline/export/tables.py` emits.

`tests/data_contract_test.ts` checks both invariants against the raw committed
JSON, and `tests/annotations_test.ts` does the same for
`data/gene_annotations.json` — plus the one contract only it has: an identifier
published in `omimId`, `mondoId`, `orphacode` or `medgenId` never also appears
in the two cross-reference lists. `lib/data.ts` also normalizes text at the
public boundary so an older or partially generated file cannot crash or silently
poison the UI.

### Pipeline internals

Extraction (the pinned model, the effort and prompt sweeps, provenance), the
Docling PDF fallback, what the measurements do and do not prove, and the known
data limitations live in `pipeline/CLAUDE.md`, which loads when working under
`pipeline/` — and, by import, under `tests/pipeline/`.

### Filtering

`lib/filters.ts` is the only place row selection happens; islands hold the
selection state and call it. It deliberately diverges from the Shiny original by
normalizing case and surrounding whitespace on both sides of every comparison —
the R version compared raw strings and silently hid rows (`"Proteomics"` vs
`"proteomics"`, traits stored as `"PSMD "`). The data boundary also trims
display strings, while the raw-JSON contract test keeps generator regressions
visible.

Two matching rules are non-obvious: a binary group (Yes/No) only constrains when
exactly one option is selected, and a `SHOW_ALL` selection means "no filter".
The same rules are enforced in the UI by `nextSelection()` in
`components/CheckboxFilter.tsx`, which can never leave a group matching nothing.

One group starts constrained: the trials pages' "Study status" seeds
`DEFAULT_TRIAL_STATUSES` (every status but Completed) through the `initial`
field on a `useCheckboxFilters` definition, and `reset()` returns to it rather
than to Show All. The `Active Filters:` line therefore reports it on first
paint, which is intended -- it is what tells a viewer completed trials are
hidden. `visibleTrials()` in `lib/filters.ts` is the same default as a function,
for the SSR tests and any count that has to agree with the page.

`components/FilterPanel.tsx` owns the sidebar-and-table layout both data pages
render, and the collapse state with it -- the `is-collapsed` class has to reach
the grid wrapper as well as the panel, so the panel cannot hold it alone.
Collapsing folds the sidebar to a rail rather than unmounting it: the toggle
stays one button in one place, so the press keeps focus and the pointer. Hiding
the controls hides no information, because `TableShell` prints the
`Active Filters:` line above the table either way -- keep that true if the
readout ever moves.

### Routes and islands

`routes/` is one server-rendered page per tab, listed in `TABS`
(`lib/constants.ts`) — adding a tab means adding both a route file and a `TABS`
entry with an `Icon` glyph. Every route renders into `components/Page.tsx`,
which owns the vertical rhythm through one gap token. The About page opts into a
fixed measure with `contained`; data tables, the map and the two figures use the
full width. Blocks inside the shell carry no outer margin. `Page` also takes an
optional `header`, which replaces the default `.page-header` block — the About
page passes its hero card, which carries the heading, the lead and the four
totals on one surface, so `title`/`description` go unused there.

Interactivity lives in seven islands:

- `islands/GenesView.tsx` — Table 1, grouped two-row header.
- `islands/TrialsView.tsx` — Table 2, row-merged by drug.
- `islands/TrialsMap.tsx` — Leaflet map, clustered facility markers.
- `islands/TrialsTimeline.tsx` — the trials radar: population sectors × phase
  rings × one marker per trial, drawn as SVG from `lib/timeline.ts`. See
  "Timeline" below.
- `islands/ThemeToggle.tsx` — the theme switch; shared state, events and
  observers live in `lib/theme.ts` so other islands do not depend on it.
- `islands/Phenogram.tsx` — the karyogram: chromosomes from the hg38 cytobands,
  one label block per gene, drawn as SVG from `lib/phenogram.ts` under an HTML
  layer of gene buttons. See "Phenogram" below.
- `islands/PipelineRun.tsx` — the About page's run report: six steps with
  badges, the funnel from papers fetched to genes accepted, the external
  services the run called, and a drawer holding everything it wrote. See
  "Pipeline run widget" below.

Both figures are drawn in-app from the committed JSON.

### Login

The dashboard sits behind one shared passphrase and a 30-day signed cookie — no
store, no Deno KV, no auth library. The design and its reasons are in
`docs/superpowers/plans/2026-08-31-deno-deploy-hosting.md` under "Login". Four
things are load-bearing:

- **The gate is `routes/_middleware.ts`, and it fails closed.** It runs for
  every file route, exempts only `/login` and `/logout`, and answers 503 on
  every route while `DASHBOARD_PASSPHRASE` or `DASHBOARD_SESSION_SECRET` is
  unset — in development too. There is no environment-sniffing bypass; put both
  in `.env`, which `deno task dev` and `deno task start` both load; an exported
  variable beats the file, so a host that injects secrets is unaffected. Static
  assets never reach the gate because `main.ts` registers `staticFiles()` first,
  which is what keeps the login page styled.
- **`deno task start` binds to `127.0.0.1`, and that flag is load-bearing.** The
  cookie is `Secure` on every hostname but `localhost` and `127.0.0.1`, and
  `deno serve` prints its bind address as the URL to open. Without the flag it
  prints `http://0.0.0.0:8000/`, where a browser drops the Secure cookie over
  plain HTTP: the login succeeds, the redirect back arrives with no session, and
  the form reappears with no error — which reads as a rejected passphrase.
  `e2e/tests/login.spec.ts` reads the task and signs in on the host it names.
- **`lib/auth.ts` is pure and takes the secret as an argument.** It never reads
  `Deno.env` except through the injectable reader in `loginConfig`, so the 100 %
  floor under `lib/` holds without touching the process environment. The token
  is `"<expiresMs>.<base64url HMAC-SHA256>"`, verified with
  `crypto.subtle.verify` (constant time); the passphrase compare goes through
  `timingSafeEqual` on two digests. The routes are thin: `routes/login.tsx` and
  `routes/logout.tsx` call `loginResponse` / `logoutResponse` and render the
  card.
- **`csrf()` in `main.ts` is what protects the two POSTs.** Both forms are
  same-origin; the plugin rejects a cross-site `Origin` or `Sec-Fetch-Site`. Do
  not turn `/logout` into a GET link — that is the request it guards.
- **The e2e suite runs pre-authenticated.** `playwright.config.ts` starts the
  server with the suite's own two values, the `setup` project signs in once and
  saves `storageState`, and `chromium` depends on it. A spec that asserts on the
  logged-out state has to opt out with
  `test.use({ storageState: { cookies: [], origins: [] } })`, as `login.spec.ts`
  does.

`_app.tsx` renders `/login` as a bare sheet (no navbar) and, for a verified
session, a "Sign out" form beside the theme toggle; the flag it reads is
`ctx.state.authenticated`, the one field in `State` (`utils.ts`).

### Hosting

The app runs on Deno Deploy at
`https://csvd-dashboard.mathieubpoiriericm.deno.net`, built from `main` through
the native GitHub integration. The build-config fields, the four non-obvious
settings and the wholly-503 diagnosis are in the `deploy` skill
(`.claude/skills/deploy/SKILL.md`).

Because `data/*.json` is committed and bundled at build time, regenerating data
and pushing it to `main` republishes the site — `tests/filters_test.ts`'s caveat
about regeneration now has a production consequence as well as a test one.

### Tables

`.claude/rules/tables.md` loads with `components/TableShell.tsx`, the two table
islands and their tests — the one shared TanStack v9 feature registry and its
three load-bearing entries, why `as any` must stay out of `useTable`, and the
row-merging rule in `TrialsView`.

### Map

`islands/` has its own `CLAUDE.md` — why Leaflet stays at 1.9.4, the
non-optional import order, and the six load-bearing details of
`islands/TrialsMap.tsx`.

### Timeline

`.claude/rules/timeline.md` loads with `islands/TrialsTimeline.tsx`,
`lib/timeline*`, `scripts/timeline_figure.py` and their tests — the encoding
contract, the two renderers and their shared layout rule, label separation, the
derived record-confidence channels, the seven rings and the key.

### Phenogram

`.claude/rules/phenogram.md` loads with `islands/Phenogram.tsx`,
`lib/phenogram*`, `disease/vocabulary.json`, `lib/cytobands.ts`,
`scripts/phenogram_figure.py` and their tests — the vocabulary as single source
of truth, the reconciled prompt, the non-derived `viewBox`, and the two
renderers.

### Pipeline run widget

`islands/` has its own `CLAUDE.md` — the encoding contract, why the island takes
no props, and the four details that make the widget report a run honestly.

### Tooltips

`.claude/rules/tooltips.md` loads with `components/Tooltip.tsx`,
`lib/tooltips.ts` and their tests — the native `[popover]` arrangement and its
three load-bearing details.

### Styling and depth

`assets/` has its own `CLAUDE.md` — the three token tiers and what each rule may
read, the twice-declared dark blocks, and the one elevation recipe with its
fourth parameter tier.

### Typography and type graph

Fonts, icons and the fixed figure-colour tokens are in `assets/CLAUDE.md` under
"Typography and figure colour".

`@types/node` sits in `deno.json`'s import map because `deno check` cannot
resolve `@playwright/test` without it under `nodeModulesDir: "manual"`. It is
load-bearing — do not remove it — but it pulls Node's ambient globals into the
whole app's type graph, so `process` and `Buffer` type-check clean inside
browser-only islands and `ReturnType<typeof setTimeout>` resolves to
`NodeJS.Timeout` rather than `number` (see `components/Tooltip.tsx`, which
derives the ref type from `setTimeout` instead of naming either).

### End-to-end tests

`e2e/` has its own `CLAUDE.md` — npm isolation, the production-build harness,
and the selector traps.
