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
the same command after a crash, `--batch` included: its batch id is written to
`logs/pipeline_batch.json` before the first poll, so a re-run retrieves what it
already paid for, and a run over another window keeps that record. The
`run-long-window` skill has the rest, `scripts.backfill_pubmed` included.

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

Tracy lives in the `third_party/tracy` git submodule, pinned to its newest
release. `deno task tracy:build` builds its tools into `.tracy/bin` and the
pipeline's client wheel, and `deno task tracy:update` moves it to a newer
release. `deno task tracy:run <cmd>` runs a pipeline command under the profiler;
`pipeline/profiling.py` does nothing in any other run. The `tracy` skill has the
workflow, and it is where the asyncio zone rule and the macOS capture-order bug
are written down.

`deno task screenshots` recaptures the README's screenshots in
`docs/screenshots/` from the committed data, on a server of its own; rerun it
after a data regeneration or a visible change to a page, and commit them with
that change.

**Several CI jobs can share one host, so no job may take a fixed host port** —
each runner sets its own `E2E_PORT`. The `ci-runner` skill has the `CI_RUNNER`
variable and its fallback, the machine and the parallelism.

`ADAPT_SESSIONS_DIR=$(mktemp -d) deno task dev` turns on the adapt guide's saved
sessions locally, in a directory outside the project that Vite does not watch;
without it the guide has no Save session. The e2e server runs with sessions on,
in a directory per port that its start command empties (a reused local server
keeps it, and so keeps counting toward `SESSION_PER_CLIENT_CAP`), and with
`ADAPT_SESSION_PER_CLIENT_LIMIT` at 1000: its workers are one client to the
session limiter, and a run creates more sessions a minute than one client may.

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
- Set `TRACY_DIR=<main checkout>/.tracy/bin` for `deno task perf` and
  `deno task tracy:run`, rather than building Tracy again; init the
  `third_party/tracy` submodule only to work on Tracy itself.
- The branch is `worktree-<name>`; push it as `git push origin HEAD:<name>` -- a
  bare `git push` refuses the mismatch.

## Architecture

One pipeline, one language, meeting the web app at a JSON file boundary.

**The disease seam is `disease/`.** Everything that names the disease lives
there and nowhere else, split across two manifests for one reason:
`server/protected_data_build.ts` lists `COL4A1/2` as a leak canary and every
island bundle embeds the web-facing manifest, so no gene symbol may live in it.
`manifest.json` holds the web-facing keys; `pipeline.json` holds the
pipeline-only keys and is read only by `pipeline/disease.py`. Each has a JSON
Schema beside it. `lib/disease/manifest.ts` imports the raw JSON, so **every key
of `disease/manifest.json` — not only the ones a page renders — ships inside a
public client chunk that is served before login**, which is why gene symbols
live in `disease/pipeline.json` and why each schema's
`additionalProperties: false` is enforced by a test on both sides of the seam.
**Three more files ship before login the same way** — `vocabulary.json` (the
filter choices, which the login route imports), `timeline.json` and
`phenogram.json` — so none of the four may name a gene: `PUBLIC_DISEASE_FILES`
in `tests/helpers/public_symbols.ts` lists them,
`tests/disease_manifest_test.ts` fails on a symbol of `pipeline.json` in any,
and the wizard's `validate()` refuses the same strings. `disease/prompt.md` is
the disease half of the extraction prompt (the methodology is the v8 template in
`pipeline/prompts.py`); it is excluded from `deno fmt` in `deno.json` because
`deno fmt` rewraps Markdown prose and every inserted newline would reach the
model; `tests/pipeline/csvd/test_csvd_prompt_assembly.py` pins the cSVD
rendering byte-identical to the v6 literals but for the omics lines v8 changed.
TypeScript reads the manifest through the narrow modules under `lib/disease/`,
and Python through `pipeline/disease.py`, which is stdlib-only so `config.py`
and `extraction_models.py` can both import it.
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
the `empty-data` CI job runs; a third, CI's `adapt-fork` job
(`deno run -A scripts/adapt_fork_check.ts`), runs every gate on two
wizard-generated `disease/` trees. The fork's own steps, removing these trees
and the upstream recall cassettes, are in the `new-disease` skill. A generic
test that reads a manifest string out of rendered HTML goes through
`tests/helpers/html.ts`'s `escapeHtml`, and one that needs two populations
builds them, because a fork's institute can hold `&` and its radar one
population.

**Nothing queries a database at request time, and nothing fetches JSON at
runtime.** The modules under `lib/data/` use `import … with { type: "json" }`,
so each file is bundled into whatever imports it. **Import the narrow module,
not the barrel** — `lib/data.ts` re-exports all of them, and an island that
reaches for it pulls the whole ~400 KB dataset into its client bundle instead of
the one table it renders. Each `lib/data/` module is a protected chunk of its
own, so a narrow import also downloads only that dataset. The barrel exists for
the tests that exercise the complete boundary. Consequences worth remembering:

- Editing `data/*.json` requires a rebuild/HMR cycle to show up.
- **`data/gene_annotations.json` is a pivot, one row per `(gene, disease)`**,
  and any island that imports it bundles it. **`relatedXrefs` names _different_
  concepts — never merge one into `omimId`**, which would publish another
  disease's OMIM number as this gene's.
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
  populations are pinned in five more places that move together; the
  `sync-clinical-trials` skill lists them.
- `tests/data_contract_test.ts` asserts against the raw committed JSON, and is
  the guardrail that proved the R-to-Python export port faithful. Keep it.

**The server holds one kind of state: the adapt guide's saved sessions.** They
are files, one per session, in the directory `ADAPT_SESSIONS_DIR` names (on Fly,
the machine's volume), reached only through the POSTs
`/adapt/session/{create,save,resume}` (`server/adapt_sessions.ts`). There is
still no database, and still nothing reads the dataset at request time. With the
variable unset, or its directory unwritable, sessions are off: the server logs
why, and the guide works as it did before, without Save session. The `deploy`
skill and `islands/CLAUDE.md` have the rest.

### Gene lists

Three `genes` columns (references, GWAS traits, monogenic links) have been join
tables since migrations 005 and 006, one value per row, after a spreadsheet
round-trip destroyed a delimited PMID list once; `.claude/rules/gene-lists.md`
has the invariants.

### The JSON contract

`pipeline/export/writer.py`'s `to_camel()` derives JSON keys from display column
names, which come from `clean_column_name()` in `pipeline/export/text.py`, so
the wire keys, the shapes in `lib/types.ts` and the labels in
`islands/*View.tsx` move together. Two invariants the TypeScript side depends
on: list-columns are always arrays, and the sentinel strings `"(none found)"`,
`"(unknown)"` and `"(none)"` are matched literally by the filter choices in
`lib/constants.ts`, so those values must stay byte-identical to what
`pipeline/export/tables.py` emits.

### Filtering

`lib/filters.ts` is the only place row selection happens; islands hold the
selection state and call it.

### Routes and islands

`routes/` is one server-rendered page per tab, listed in `TABS`
(`lib/constants.ts`) — adding a tab means adding both a route file and a `TABS`
entry with an `Icon` glyph. Every route renders into `components/Page.tsx`,
which owns the vertical rhythm through one gap token; blocks inside the shell
carry no outer margin.

Theme state, events and observers live in `lib/theme.ts` so no other island
depends on `ThemeToggle`.

`routes/adapt.tsx` is the one page that is not a tab; its title comes from
`UNTABBED_TITLES` in `routes/_app.tsx`.

### Login

The dashboard sits behind one shared passphrase and a 30-day signed cookie, with
no store and no auth library. Three things hold everywhere: the gate in
`routes/_middleware.ts` fails closed and answers 503 on every gated route while
`DASHBOARD_PASSPHRASE` or `DASHBOARD_SESSION_SECRET` is unset, in development
too; `/logout` is a POST guarded by `csrf()`, so do not turn it into a GET link;
and the e2e suite runs pre-authenticated, so a spec about the logged-out state
opts out with an empty `storageState`, as `login.spec.ts` does. The adapt
guide's three session POSTs sit behind the same gate and `csrf()`, and are
counted by a limiter of their own (`server/adapt_session_limiter.ts`), so a
resume cannot spend a visitor's sign-in attempts.

### Hosting

The app runs at `https://csvd-dashboard.fly.dev` on one always-on Fly.io
machine, and a push to `main` deploys it once every CI job passes. Because
`data/*.json` is committed and bundled at build time, regenerating data and
pushing it to `main` republishes the site — `tests/filters_test.ts`'s caveat
about regeneration now has a production consequence as well as a test one. The
adapt guide's sessions live on that machine's volume, so before a second machine
is added `ADAPT_SESSIONS_MACHINE` must name the one holding them; otherwise a
resume can reach a machine that never saw the save. The deploy's smoke test
saves and resumes a real session when the repository holds `SMOKE_PASSPHRASE`.
The `deploy` skill has the one-machine rule and the rest.

### Type graph

`@types/node` sits in `deno.json`'s import map because `deno check` cannot
resolve `@playwright/test` without it under `nodeModulesDir: "manual"`. It is
load-bearing — do not remove it — but it pulls Node's ambient globals into the
whole app's type graph, so `process` and `Buffer` type-check clean inside
browser-only islands and `ReturnType<typeof setTimeout>` resolves to
`NodeJS.Timeout` rather than `number` (see `components/Tooltip.tsx`, which
derives the ref type from `setTimeout` instead of naming either).
