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

A long `--days-back` run resumes from `logs/pipeline_checkpoint.jsonl` — re-run
the same command after a crash. **`--batch` is the exception**: its batch id
lives only in the run log, so a crash inside the up-to-24h poll loses the whole
submission and a re-run pays again. The `run-long-window` skill has the rest,
`scripts.backfill_pubmed` included.

Regenerating `data/*.json` needs PostgreSQL reachable and `.env` populated; the
commands, the database setup and the print-figure and cytoband tasks are in the
`regenerate-data` skill. **After merging anything that adds a migration under
`pipeline/alembic/versions/`, run `cd pipeline && uv run alembic upgrade head`
before the next `deno task data` or pipeline run**: the export reads the newest
columns, and a PubMed run on a stale schema pays for every extraction, merges
the genes, and only then fails writing the ledger (the checkpoint keeps the
papers, so re-running after the upgrade costs nothing more).

`--export` regenerates the files at the end of a live run and **stops at the
working tree**: nothing is committed, because the curated `genes` table is a
scientific judgement and the e2e fixtures pin exact row counts. When it runs, is
refused or skipped, and the lookup-cache refresh before it, are in the
`regenerate-data` skill.

Tests never touch the production database: `tests/pipeline/conftest.py` empties
the `DB_*` credentials (so `load_dotenv` cannot refill them from `.env`) and
clears the whole `PIPELINE_*` namespace, and a test needing real SQL uses the
throwaway database `CSVD_TEST_DB_URL` names or brings up its own
`dhi.io/postgres:18-alpine3.23` container. See
`.claude/rules/pipeline/database-tests.md`.

Vite is pinned to 7.x because `@fresh/plugin-vite` requires `vite@^7.1.4`.

`deno task perf` measures every route and fourteen interactions under 4x CPU
throttling; the `perf` skill holds how to run it and how to read it.

`deno task screenshots` recaptures the README's screenshots in
`docs/screenshots/` from the committed data, on a server of its own; rerun it
after a data regeneration or a visible change to a page, and commit them with
that change.

**CI's test jobs run on `${{ vars.CI_RUNNER || 'ubuntu-latest' }}`**: the
private repository sets `CI_RUNNER=csvd-ci`, which sends them to twelve
self-hosted runners on a home mini PC; the public repository and every fork stay
on `ubuntu-latest`, and `container` and `deploy` are always hosted. Several jobs
share one host, so no job may take a fixed host port — each runner sets its own
`E2E_PORT`. A VS Code warning "Context access might be invalid: CI_RUNNER" on a
`runs-on` line is that deliberate fallback. When the machine is down,
`gh variable delete CI_RUNNER` is the fallback. The `ci-runner` skill has the
machine, the parallelism settings and why they are moderate, and the
Playwright-upgrade step.

**`compression()` in `main.ts` is the outermost middleware, and that position is
load-bearing**: nothing before it compressed the built bundles, and it must stay
outside `protectDataAssets()` to cover the protected chunk.
`.claude/rules/compression.md` loads with `main.ts` and `server/compression.ts`
and carries the measurements, the skips and why it steps aside in development
mode.

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

**The disease seam is `disease/`.** Everything that names the disease lives
there and nowhere else, split across two manifests for one reason:
`server/protected_data_build.ts` lists `COL4A1/2` as a leak canary and every
island bundle embeds the web-facing manifest, so no gene symbol may live in it.
`manifest.json` holds the web-facing keys (prose, institute, contact, about,
hosting, populations, populationField, cell-type glossary, citation standard);
`pipeline.json` holds the pipeline-only keys (search terms, monogenic genes,
gene aliases, run label, gene cap) and is read only by `pipeline/disease.py`.
Both have a JSON Schema beside them (`manifest.schema.json`,
`pipeline.schema.json`). `lib/disease/manifest.ts` imports the raw JSON, so
**every key of `disease/manifest.json` — not only the ones a page renders —
ships inside a public client chunk that is served before login**, which is why
gene symbols live in `disease/pipeline.json` and why each schema's
`additionalProperties: false` is enforced by a test on both sides of the seam
(`tests/pipeline/test_disease.py`'s `Draft202012Validator` pass,
`tests/disease_manifest_test.ts`'s structural checker). Also in `disease/`:
`vocabulary.json`, `prompt.md` (the disease half of the extraction prompt; the
methodology is the v7 template in `pipeline/prompts.py`), `phenogram.json`
(families), `timeline.json` (populations, mechanisms, families) and
`omim_info.csv`. `prompt.md` is excluded from `deno fmt` in `deno.json` because
`deno fmt` rewraps Markdown prose and every inserted newline would reach the
model; `tests/pipeline/csvd/test_csvd_prompt_assembly.py` pins the cSVD
rendering byte-identical to the v6 literals. TypeScript reads the manifest
through the narrow modules under `lib/disease/` — `site.ts`, `populations.ts`,
`cell_types.ts`, `citation.ts` — and Python through `pipeline/disease.py`, which
is stdlib-only so `config.py` and `extraction_models.py` can both import it.
`tests/no_disease_literals_test.ts` and
`tests/pipeline/test_no_disease_literals.py` scan the code for the manifest's
own terms and fail on any hit outside a reasoned allow-list. Every measurement
in this file and in `.claude/rules/pipeline/` is of the cSVD dataset this
repository was built on.

**The tests that name the disease live in four `csvd/` trees** — `tests/csvd`,
`tests/pipeline/csvd`, `tests/scripts/csvd` and `e2e/tests/csvd` — and nowhere
else. A test goes there when it names cSVD content (a gene, a trait, a
population, a search term) or pins a cSVD number (a row count, a recall figure,
the first marker the radar draws). Everything outside them holds for any
disease: an invariant stays where it is, and a test that used to pin a
committed-data number now derives it at test time —
`e2e/fixtures/expected.deno.ts` under Deno so the counts come from the app's own
`lib/`, the `committed_rows` fixture in `tests/pipeline/conftest.py`,
`tests/fixtures/rows.ts` for synthetic rows — or skips with a reason naming the
empty file. Both modes must stay green: the committed data with the trees
present, and `deno task data:empty` with the four trees removed, which is what
the `empty-data` CI job runs. A fork removes the trees with one `git rm -r` of
the four paths, and the upstream recall cassettes in
`tests/pipeline/cassettes/test_query_recall_gold` with another (they sit beside
the generic replay test, and `--record-mode=once` would replay them instead of
recording the fork's), and starts from the empty export; the `new-disease` skill
walks that. The `empty-data` job keeps this repository's `disease/`, so a third
mode runs a fork's own: `deno run -A scripts/adapt_fork_check.ts` (CI's
`adapt-fork` job) unpacks two wizard bundles over copies of the tree, follows
the adaptation checklist and runs every gate on each. A generic test that reads
a manifest string out of rendered HTML goes through `tests/helpers/html.ts`'s
`escapeHtml`, and one that needs two populations builds them, because a fork's
institute can hold `&` and its radar one population.

**Nothing queries a database at request time, and nothing fetches JSON at
runtime.** The modules under `lib/data/` use `import … with { type: "json" }`,
so each file is bundled into whatever imports it. **Import the narrow module,
not the barrel** — `lib/data.ts` re-exports all of them, and an island that
reaches for it pulls the whole ~400 KB dataset into its client bundle instead of
the one table it renders. The barrel exists for the tests that exercise the
complete boundary. Consequences worth remembering:

- Editing `data/*.json` requires a rebuild/HMR cycle to show up.
- **`data/gene_annotations.json` is a pivot, one row per `(gene, disease)`**,
  and any island that imports it bundles it. **`relatedXrefs` names _different_
  concepts — never merge one into `omimId`**, which would publish another
  disease's OMIM number as this gene's. It is the one export file skipped rather
  than emptied when its table has no rows. `.claude/rules/json-contract.md` has
  the rest.
- `data/pipeline_run.json` is committed as a bare `null` until a run records a
  report, exactly as `data/pipeline_status.json` was. Both states are covered;
  the About page falls back to the summary card for the null one.
- **`data/pipeline_syncs.json` is the reference-data refreshes**, one entry per
  sync mode, committed as `[]` until one is recorded — a separate file and table
  from the runs, so nothing feeding the run widget or the About page's date can
  see one. See "The refreshes record their own runs" in
  `.claude/rules/pipeline/syncs.md`.
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
- **The export is byte-exact and ordered**: every `data/*.json` is gated
  byte-for-byte against the writer, every export query needs an `ORDER BY`,
  `data/table2.json` publishes only curated trial rows, and a facility with no
  `geoPoint` is dropped rather than defaulted. `.claude/rules/json-contract.md`,
  which loads with `pipeline/export/**`, has why each holds.

### Gene lists

Three `genes` columns (references, GWAS traits, monogenic links) have been join
tables since migrations 005 and 006, one value per row, after a spreadsheet
round-trip destroyed a delimited PMID list once. `.claude/rules/gene-lists.md`
loads with `pipeline/export/main.py`, `pipeline/export/tables.py`,
`pipeline/database.py`, `pipeline/data_merger.py` and
`scripts/backfill_gene_lists.py`, and carries the three load-bearing invariants:
`_GENE_COLUMNS` holds the JSON key order, sentinels and untracked traits are
never stored, and `_append_gene_list_sql` carries the merge invariants the
delimited strings used to.

### The JSON contract

`pipeline/export/writer.py`'s `to_camel()` derives JSON keys from display column
names, which come from `clean_column_name()` in `pipeline/export/text.py`, so
the wire keys, the shapes in `lib/types.ts` and the labels in
`islands/*View.tsx` move together. Two invariants the TypeScript side depends
on: list-columns are always arrays, and the sentinel strings `"(none found)"`,
`"(unknown)"` and `"(none)"` are matched literally by the filter choices in
`lib/constants.ts`, so those values must stay byte-identical to what
`pipeline/export/tables.py` emits. `.claude/rules/json-contract.md` loads with
the export, `lib/types.ts`, `lib/data/`, `lib/constants.ts`, the two table
islands and the contract tests, and carries the rest: the omics vocabulary,
`relatedXrefs`, `sourceVersions`, and why each is shaped as it is.

### Pipeline internals

Extraction (the pinned model, the effort and prompt sweeps, provenance), the
Docling PDF fallback, what the measurements do and do not prove, and the known
data limitations live in fifteen path-scoped rules under
`.claude/rules/pipeline/`, each loading with the modules and tests it names.
`pipeline/CLAUDE.md` indexes them and loads when working under `pipeline/` —
and, by import, under `tests/pipeline/`.

### Filtering

`lib/filters.ts` is the only place row selection happens; islands hold the
selection state and call it. `.claude/rules/filters.md` loads with it and
carries the case-normalizing comparison, the two non-obvious matching rules, the
constrained "Study status" default and the collapsible panel.

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

Interactivity lives in the eight islands under `islands/`; theme state, events
and observers live in `lib/theme.ts` so no other island depends on
`ThemeToggle`. Both figures are drawn in-app from the committed JSON.

`routes/adapt.tsx` is the one page that is not a tab: it mounts
`islands/AdaptWizard.tsx`, which collects the `new-disease` interview and
downloads a generated `disease/`. Its logic is pure in `lib/adapt/` and its
title comes from `UNTABBED_TITLES` in `routes/_app.tsx`.

### Login

The dashboard sits behind one shared passphrase and a 30-day signed cookie, with
no store and no auth library. Three things hold everywhere: the gate in
`routes/_middleware.ts` fails closed and answers 503 on every gated route while
`DASHBOARD_PASSPHRASE` or `DASHBOARD_SESSION_SECRET` is unset, in development
too; `/logout` is a POST guarded by `csrf()`, so do not turn it into a GET link;
and the e2e suite runs pre-authenticated, so a spec about the logged-out state
opts out with an empty `storageState`, as `login.spec.ts` does.
`.claude/rules/login.md` loads with the auth routes, `lib/auth.ts`, `main.ts`
and `e2e/`, and carries the rest.

### Hosting

The app runs at `https://csvd-dashboard.fly.dev` on Fly.io, one always-on
machine built from the root `Dockerfile`; on a push to `main`, CI's `container`
job pushes the smoke-tested image and the `deploy` job releases it once every
other job has passed. The `deploy` skill has the one-machine rule, the
`Fly-Client-IP` header, the allowlist `.dockerignore` and the 503 diagnosis.

Because `data/*.json` is committed and bundled at build time, regenerating data
and pushing it to `main` republishes the site — `tests/filters_test.ts`'s caveat
about regeneration now has a production consequence as well as a test one.

### Scoped notes

Nine rules files load by path from `.claude/rules/`: `tables.md` (`TableShell`
and the two table islands), `timeline.md` (the trials radar), `phenogram.md`
(the karyogram), `tooltips.md`, `compression.md`, `gene-lists.md`,
`json-contract.md`, `login.md` and `filters.md`. Fifteen more under
`.claude/rules/pipeline/` carry the pipeline's notes, indexed in
`pipeline/CLAUDE.md`. Four directories carry their own `CLAUDE.md`: `islands/`
(the map, the run widget and the adapt wizard, whose notes cover `lib/adapt/`
too), `assets/` (tokens, depth, typography), `e2e/` (npm isolation, the
production-build harness, the selector traps) and `tests/pipeline/`, which
imports `pipeline/CLAUDE.md`.

### Typography and type graph

The fixed figure-colour tokens and the no-mono-face decision are in
`assets/CLAUDE.md` under "Typography and figure colour"; the font faces are the
`@font-face` blocks in `assets/app.css` and the icons are `components/Icon.tsx`.

`@types/node` sits in `deno.json`'s import map because `deno check` cannot
resolve `@playwright/test` without it under `nodeModulesDir: "manual"`. It is
load-bearing — do not remove it — but it pulls Node's ambient globals into the
whole app's type graph, so `process` and `Buffer` type-check clean inside
browser-only islands and `ReturnType<typeof setTimeout>` resolves to
`NodeJS.Timeout` rather than `number` (see `components/Tooltip.tsx`, which
derives the ref type from `setTimeout` instead of naming either).
