# Publish the export at the end of a pipeline run — plan

**Status: not implemented.** Investigated on 2026-09-01 alongside
`2026-09-01-phenogram-glyph-geometry.md`, agreed in shape, and paused before any
code was written. Recorded so the findings are not re-derived.

**Goal:** a live pipeline run can publish its own export, so the figures and the
About page track the database without a separate manual step. Opt-in, and
stopping at the working tree — no git, no deploy.

## Context

The phenogram and the trials radar are already database-derived. The chain
exists and works:

```text
PostgreSQL → deno task data → data/table1.json, table2.json → vite build → islands
```

`islands/Phenogram.tsx:8` and `islands/TrialsTimeline.tsx:9` read `genes` /
`trials` from `lib/data/genes.ts:3` and `lib/data/trials.ts:3`, which import the
committed JSON with `with { type: "json" }`, and both compute their layout at
module scope. `scripts/phenogram_figure.py:30` and
`scripts/timeline_figure.py:28` read the same two files off disk.

**What breaks the chain is that nothing triggers it.** `pipeline/main.py`'s six
steps end at `finalizing` (`pipeline/steps.py:34-41`), and `_finalize_run`
(`pipeline/main.py:742`) writes the `pipeline_runs` row and returns. Nothing
under `pipeline/` imports or calls `run_export`. After a run the database has
new genes and `data/*.json` is byte-identical to before — including
`pipeline_status.json`, so the About page's "up-to-date as of" date goes stale,
and `pipeline_run.json`, so the run widget never sees the run that just
happened.

**A runtime database query is excluded, three times over**, so this is the only
shape the goal can take:

1. The JSON is bundled into the client island bundle by the import attribute —
   there is no fetch to redirect.
2. Deno Deploy hosts the app and has no route to the local `csvd-pg` container.
3. `tests/filters_test.ts`, `tests/data_contract_test.ts` and both encoding
   tests assert against the _committed_ rows. A runtime source makes those
   unwritable.

## Why this is small

- `run_export()` is already an awaitable taking an optional target dir
  (`pipeline/export/main.py:144`).
- **It is a pure database read.** Every lookup in `pipeline/export/lookups.py`
  is a `conn.fetch`; the NCBI/UniProt/PubMed data comes from cache tables. No
  network. (`deno task geocode` is the exception —
  `pipeline/export/geocode.py:99` calls clinicaltrials.gov — and stays a
  separate, deliberate step.)
- It is already crash-safe: staging tempdir plus `publish_atomically`
  (`pipeline/export/publish.py:12`), which snapshots and rolls back, so a
  failure can never leave a mixed generation.
- Determinism is already gated. Every query carries an `ORDER BY`, and
  `tests/pipeline/export/test_writer.py:311,327` re-encodes every committed
  `data/*.json` byte-for-byte. The result is a reviewable diff, not churn.

## Changes

### 1. `pipeline/main.py` — the flag

Add to `_build_parser()`, near the other pipeline selectors (~`:102`):

```text
--export   After the selected pipelines finish, regenerate data/*.json from
           the database (the same work as `deno task data`). Leaves the files
           in the working tree; nothing is committed.
```

### 2. `pipeline/main.py` — `_prepare_cli_args` (`:2489`)

`--local-pdfs` / `--pmids` bypass `_run_selected_pipelines` entirely
(`main.py:2542-2557`) and deliberately publish no data, so `--export` there
would be silently ignored. Follow the existing precedent in this function and
`parser.error(...)` on the combination rather than warn — unlike the PubMed-only
flags, this one would leave the user believing the export ran.

### 3. `pipeline/main.py` — `_run_selected_pipelines` (`:2386`)

The right seam: it already owns the once-per-invocation coalescing and already
computes `any_failed` (`:2459`). Insert the export inside the `try`, after the
notification block and before `return` — the `finally` at `:2484` calls
`Database.close()`, so the export must run ahead of it and reuses the open pool.

Two rules:

- **Skip a pure preview.** If pubmed was the only selected pipeline and
  `args.dry_run or args.test_mode`, nothing was written; exporting would
  republish the committed files unchanged for no reason. Log the skip.
- **Export even when a pipeline failed.** `_record_failed_run` (`main.py:1543`)
  deliberately persists a failed run so the About page widget can show it;
  skipping the export on failure is what keeps that feature invisible today. The
  database is a consistent snapshot whichever pipeline failed, and
  `publish_atomically` is all-or-nothing. Log which pipelines failed alongside
  the export.

Import `run_export` **locally inside the function**, not at module top:
`pipeline/export/main.py:38` calls `load_dotenv` at import time, and
`main.py:107-117` has an argcomplete fast path that exists to keep heavy imports
out of the graph. `pipeline/pdf_parse.py` is the house precedent for a local
import held for startup cost.

### 4. Exit code

`_run_selected_pipelines` returns `int(any_failed)` (`:2482`). A failed export
means the database moved and the files did not — exactly the condition this flag
exists to remove — so it must not pass silently on an unattended run. Catch
`OSError` and the `RuntimeError` `publish_atomically` raises, log at `error`,
and fold it into the return: `int(any_failed or export_failed)`.

### 5. Docs

One paragraph in the root `CLAUDE.md`, beside the existing "Regenerating
`data/*.json` needs PostgreSQL reachable and `.env` populated" note: that
`--export` does the same work at the end of a live run, that it stops at the
working tree, and that `deno task geocode` is still separate because it calls
out to clinicaltrials.gov.

## Tests

`tests/pipeline/test_main_orchestration.py` is where `_run_selected_pipelines`
is covered; follow its existing patching style. `pyproject.toml` enforces a 99.5
% line+branch floor on `pipeline/`, so every new branch needs a case:

- `--export` with a successful pipeline calls `run_export` once.
- `--export` with `--pubmed --dry-run` (pubmed only) does not call it.
- `--export` with `--pubmed --test-mode` (pubmed only) does not call it.
- A failed pipeline still exports, and the exit code stays 1.
- `run_export` raising `RuntimeError` logs an error and returns exit code 1 from
  an otherwise-successful invocation.
- Without `--export`, `run_export` is never called (pins the default).
- `_prepare_cli_args` errors on `--export --pmids` and `--export --local-pdfs`.

## Verification

```bash
uv run ruff check .
uv run ty check
uv run pytest --cov=pipeline --cov=pipeline/alembic --cov-branch   # 99.5% floor
```

Then end-to-end against the live container (see the `regenerate-data` skill for
bringing it up):

```bash
# 1. No-op preview: must log the skip and touch nothing.
uv run python -m pipeline.main --pubmed --test-mode --export
git status --porcelain data/          # expect empty

# 2. A real run that writes: expect a data/ diff and no manual `deno task data`.
uv run python -m pipeline.main --clinical-trials --export
git diff --stat data/

# 3. The committed contract still holds over whatever came out.
deno task test
```

Step 3 matters: `tests/data_contract_test.ts`, `tests/filters_test.ts` (exact
row counts), `tests/timeline_encoding_test.ts` and
`tests/phenogram_encoding_test.ts` assert against the committed rows. A real
regeneration can legitimately fail them — a new GWAS trait, mechanism,
population, or an unresolvable `chromosomalLocation` — and that failure is the
designed guardrail ("Add the entry; do not widen the test"), not a regression in
this change. Confirm the data changed before touching a test.

## Known consequences, stated rather than fixed

- **`data/gene_annotations.json` is skipped, not emptied, when its table is
  empty** (`pipeline/export/main.py:207-219`). On a machine that has never run
  `--sync-annotations`, an automated export preserves a stale annotations file
  and logs a warning. Correct as written, but it will now appear in ordinary run
  logs.
- **`data/cytobands_hg38.json` is not from the database** — it is
  `scripts/fetch_cytobands.py`'s output from UCSC, and the phenogram needs it.
  `--export` does not refresh it, and should not.
- **`figures/` stays stale.** It is gitignored and referenced by no route,
  component or asset; `deno task figure` remains manual.

## Deliberately out of scope

Committing, pushing, opening PRs, and regenerating `figures/`. Three tiers were
considered — export only, export plus print figures, export plus an automated
PR, export plus a push to `main`. The first was chosen: an automated push would
deploy scientific data unreviewed, against a repo whose curated `genes` table is
a scientific judgement and whose filter tests pin exact row counts. If that ever
changes, the PR route is the one to take, so CI runs before the data goes live.
