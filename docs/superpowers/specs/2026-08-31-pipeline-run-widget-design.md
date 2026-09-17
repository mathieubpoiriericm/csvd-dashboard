# Pipeline Run Widget

## Context

> **Recorded after the fact.** Three things in this design turned out
> differently once built, and the code is the authority where they disagree:
>
> - Two of the four "pre-existing gaps" were not bugs. The offline modes write
>   no `pipeline_runs` row **correctly** — they publish no data — and a paper
>   with no retrievable text is recorded as _processed_ on the online paths
>   **deliberately**, so it is not retried forever. The first was left alone;
>   the second was fixed by making the offline path agree with the online ones
>   and counting the condition separately.
> - The island takes **no props**. Fresh serialises island props for hydration
>   and a run report does not survive that trip.
> - Provenance quote counts were dropped from scope and then restored, collected
>   through a module-level tally rather than threaded through the extraction
>   signatures.

The About page (`routes/index.tsx`) shows a "Last Pipeline Run" card with four
numbers and a date, read from `data/pipeline_status.json` — five fields exported
from the six-column `pipeline_runs` table.

Meanwhile the pipeline already builds a far richer report: papers
processed/fulltext/abstract/failed, genes extracted/validated/**rejected with
structured reasons** (`"Low confidence: 0.60 < 0.65"`), token usage, cost, and
per-paper timings. It writes it to `logs/json/pipeline_report_*.json` — and
`logs/` is **gitignored**, so none of it ever reaches the site. The pipeline
captures more than it keeps, and keeps more than it publishes.

This replaces the static card with a widget that renders a full run: six steps
with pass/warn/fail badges and expandable action lists, papers and genes fetched
vs accepted, an inventory of every external API the run touched, timings, and a
drawer holding everything the run wrote to the database. Every value is
formatted through one presentation layer, so a failure reads as prose with a
glyph rather than as a dumped traceback.

**Decisions taken** (asked and answered during planning):

| Question        | Decision                                                                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| "Real-time"     | Last-run **snapshot**, bundled at build time. The repo's rule — nothing queries a DB at request time, nothing fetches JSON at runtime — holds. |
| Step scope      | The **ingest run only** (the six existing `_STAGES`). Export, geocode and external-sync stay out.                                              |
| History         | **Latest run only.**                                                                                                                           |
| Overview button | A **drawer** on the About page, in the timeline drawer's pattern.                                                                              |
| Drawer contents | **What this run wrote** — accepted genes with provenance, rejected genes with reasons, papers with retrieval source.                           |
| Size cap        | Counts always exact; detail lists capped at 200 with an explicit "showing N of M".                                                             |
| Warning rule    | Paper retrieval failures, gene rejections, API errors/retries, truncated or refused model responses.                                           |
| Report storage  | One `report JSON` column on `pipeline_runs` + a Pydantic model that owns the shape.                                                            |
| Step names      | Reconcile to one `PIPELINE_STEPS` list; delete the dead `##STAGE:...##` markers.                                                               |

## Four pre-existing gaps this fixes

The widget would publish these as truth, so they are repaired rather than worked
around:

1. **`record_pipeline_run` is called only for `--pubmed`** (`pipeline/main.py`
   `_finalize_run`, reached from `_complete_pubmed_run`). `--pmids` and
   `--local-pdfs` never write a `pipeline_runs` row, despite
   `database.py:record_pipeline_run` documenting `run_mode` values `'local_pdf'`
   and `'pmid_list'`.
2. **Insert-floor rejections are counted nowhere.** The 0.65 insert floor drops
   new genes in `pipeline/data_merger.py`, _after_ validation. They are logged
   by symbol but are absent from `genes.rejected` and from
   `papers_detail[].rejected_genes`, so the acceptance rate overstates.
3. **`papers.failed` means two things.** A paper with no retrievable text is
   recorded as processed with `source: "none"` in the streaming path (`main.py`
   `process_paper`) but as an **error** in `--pmids` mode
   (`_process_pmid_item`).
4. **Provenance quote checks never reach the report.** `_report_provenance`
   (`pipeline/anthropic_client.py`) computes verbatim/cited counts and logs
   them; and when `require_verified_quotes` is on it filters genes without
   creating a `RejectedGene`, so those losses are invisible.

## Architecture

```text
run  ──> StepRecorder ─┐
     ──> ApiRecorder  ─┼─> PipelineRunReport (pydantic)
     ──> PipelineMetrics ─┘        │
                                   ├─> logs/json/pipeline_report_*.json  (as today)
                                   └─> pipeline_runs.report JSON
                                              │
                                   pipeline/export/main.py
                                              │
                                   data/pipeline_run.json
                                              │
                          lib/data/pipeline_run.ts  (normalize)
                                              │
                    lib/pipeline_display.ts + lib/pipeline_encoding.json
                                              │
                                   islands/PipelineRun.tsx
```

One model owns the shape on both sides of the database. One encoding file owns
every label, glyph and tint. Nothing restates either.

---

## Phase 1 — Instrumentation (Python)

### 1a. One step vocabulary

`pipeline/steps.py` (new). Replaces `_STAGES` (`pipeline/main.py:285`):

```python
PIPELINE_STEPS: Final[tuple[PipelineStep, ...]] = (
    PipelineStep("searching_pubmed",  "Search PubMed"),
    PipelineStep("filtering_pmids",   "Filter new papers"),
    PipelineStep("processing_papers", "Retrieve & extract"),
    PipelineStep("batch_validation",  "Validate"),
    PipelineStep("merging_database",  "Merge to database"),
    PipelineStep("finalizing",        "Finalize"),
)
```

Delete the eight orphaned `print("##STAGE:...##")` calls in `pipeline/main.py`
(lines ~850, 858, 899, 911, 953, 1029, 1053, 1070). Nothing in the repo, the e2e
suite or CI reads them, and their six labels contradict `_STAGES`.

`StepRecorder` wraps the existing `_ProgressReporter` rather than replacing it —
the progress file keeps its current shape and gains nothing. The recorder adds,
per step: `started_at`, `duration_seconds`, `status` (`ok` / `warning` /
`failed`), `actions: list[str]`, `warnings: list[RunWarning]`,
`error:
RunError | None`. This is the only new timing in the codebase; today
`_ProgressReporter.report(i)` stores no start time.

### 1b. Structured failures

`pipeline/run_errors.py` (new).

```python
class RunError(BaseModel):
    kind: ErrorKind   # http_error | timeout | rate_limited | no_text_available
                      # | model_refusal | model_truncated | validation_failed
                      # | database_error | unknown
    title: str        # "Europe PMC returned 503"
    detail: str | None
    subject: str | None   # the PMID, gene symbol or service it concerns
```

`classify(exc) -> RunError` is the single mapping from exception to kind.
`_ProgressReporter.fail()` currently stores the last 500 characters of a
traceback; it classifies instead and keeps the tail as `detail`, so the
traceback stays in the log and never becomes the widget's headline. **This is
what makes "reasons for failure formatted consistently with the theme" true at
the source rather than papered over in the UI.**

`RunWarning` has the same shape with a `count`, so "3 papers had no retrievable
text" is one warning, not three.

### 1c. API telemetry

`pipeline/api_telemetry.py` (new).

`AsyncHttpClientManager` (`pipeline/http_client.py`) already takes
`**client_kwargs` and is used by `europepmc`, `ncbi_gene_fetch`,
`uniprot_fetch`, `pubmed_citations`, `validation`, `pdf_retrieval`,
`clinical_trials_fetch` and `main`. Installing httpx `event_hooks` in its
`__init__` instruments **every one of them with no call-site change**.

Two calls bypass httpx and need explicit recording:

- **PubMed esearch** — Biopython/urllib inside `pipeline/pubmed_search.py`.
- **Anthropic** — the SDK; `pipeline/anthropic_client.py` already measures
  `stream_elapsed`, so it records from there.

A `SERVICES` registry maps host + path prefix to a display name:

| Host                                    | Service               |
| --------------------------------------- | --------------------- |
| `eutils.ncbi.nlm.nih.gov`               | NCBI E-utilities      |
| `www.ncbi.nlm.nih.gov/pmc/utils/idconv` | NCBI PMC ID Converter |
| `www.ebi.ac.uk/europepmc`               | Europe PMC            |
| `api.unpaywall.org`                     | Unpaywall             |
| `rest.uniprot.org`                      | UniProt               |
| `clinicaltrials.gov`                    | ClinicalTrials.gov    |
| (SDK)                                   | Anthropic             |

**Aggregated per `(service, endpoint, method)`** — calls, ok, errors, retries,
total_ms, bytes — never one record per call: a 500-paper run makes thousands. An
unknown host records under its bare hostname rather than being dropped, so a new
API appears in the widget the day it is called. That matters: **Open Targets is
not called anywhere today** — it is proposed in the unexecuted
`docs/superpowers/plans/2026-08-31-biomedical-annotation-apis.md`, alongside
ClinVar and Orphadata. When that plan lands, those services appear here with no
change to the widget.

### 1d. The report model

`pipeline/run_report.py` (new) — `PipelineRunReport`, a Pydantic model whose
**field order is the wire order**. Nested: `RunConfig`, `StepRecord`,
`ApiServiceRecord`, `PaperRecord`, `GeneRecord`, `RejectedGeneRecord`, `Counts`,
`TokenUsageRecord`.

`pipeline/report.py` keeps building `PipelineRunData` for the three existing
sinks (`write_comprehensive_report`, `print_rich_summary`,
`send_pipeline_notification` / `EventLog`) — only the first is field-agnostic,
so nothing there needs to change. A new `build_run_report(...)` produces the
`PipelineRunReport` beside it from the same inputs.

### 1e. The four fixes

- Call `record_pipeline_run` from all three extraction modes.
- `data_merger.py` returns insert-floor drops; they land in `genes.rejected` and
  in the rejected list with reason
  `"Below insert floor: 0.60 < 0.65 (new
  gene)"`, distinguishable from the
  validation floor.
- One rule for a paper with no retrievable text: a failure with kind
  `no_text_available`, in both paths.
- Provenance counts (`verbatim`, `cited`, and any `require_verified_quotes`
  drops) carried into the report.

---

## Phase 2 — Persistence and export

**Migration `pipeline/alembic/versions/008_add_run_report.py`:**

```sql
ALTER TABLE pipeline_runs
  ADD COLUMN status           TEXT,
  ADD COLUMN duration_seconds DOUBLE PRECISION,
  ADD COLUMN report           JSON;
```

**`json`, not `jsonb`.** jsonb normalizes key order; this repo gates every
exported file on **bytes** (`tests/pipeline/export/test_writer.py`). The export
re-derives order from the Pydantic model anyway, so `json` is belt and braces —
but storing the document as authored is the honest choice for a write-once audit
record that is never queried by value.

`database.py:record_pipeline_run` gains the three parameters.

**Export** — `pipeline/export/lookups.py:read_pipeline_run()`, beside the
existing `read_pipeline_status()` and swallowing errors the same way: read the
newest row, validate through `PipelineRunReport`, cap `papers` and `genes`
detail at 200 each with `shown`/`total` counters, emit camelCase. Then in
`pipeline/export/main.py`, a ninth step:

```python
logger.info("[9/9] Latest pipeline run report")
write_value(await read_pipeline_run(), stage("pipeline_run.json"))
```

Renumber the `[n/8]` log labels and the module docstring's "eight files".

**`data/pipeline_status.json` stays exactly as it is.** It is a tested contract,
the `.date-label` line at the top of the page reads it, and keeping it means the
About page degrades to today's card if the new file is `null`. The widget
prefers `pipeline_run.json` and falls back.

`tests/pipeline/export/test_writer.py` needs `"pipeline_run.json": "value"`
added to `_COMMITTED_FILES` —
`test_every_committed_data_file_has_a_round_trip_case` fails otherwise, by
design.

> **Bootstrapping.** `data/pipeline_run.json` cannot be generated without a live
> PostgreSQL and a real run. Commit it as bare `null` first — the byte-exact
> gate accepts that, exactly as `pipeline_status.json` was `null` until the
> first run — and build the UI against a fixture under `data/test_data/`.

---

## Phase 3 — The presentation contract (TypeScript)

Follows the `timeline_encoding.json` / `phenogram_encoding.json` pattern
precisely: **one file holds every label, glyph and tint; a test fails when the
committed data carries a key the file does not cover.** Add the entry; do not
widen the test.

**`lib/pipeline_encoding.json`** — the single source of truth for presentation:

- step key → display label + icon name
- status (`ok` / `warning` / `failed`) → badge label, icon, tint token
- error `kind` → human title template, icon, and a `hint` where one helps
  (`rate_limited` → "The service asked us to slow down; the run retried and
  continued.")
- API service key → display name + icon; HTTP method → chip label
- **field key → icon name**, for every field rendered in the widget and drawer

**`lib/pipeline_display.ts`** — pure formatters, no JSX: `formatDuration`,
`formatBytes`, `formatCost`, `describeError`, `describeWarning`, `serviceLabel`,
`stepStatus`. This is the layer that guarantees a failure, a paper count, an API
name and a piece of API metadata are all formatted one way.

**`lib/types.ts`** — `PipelineRun` and its nested interfaces, mirroring the
Pydantic model.

**`lib/data/pipeline_run.ts`** — static JSON import, `normalizePipelineRun()`
returning `PipelineRun | null`, all-or-nothing in the shape of
`normalizePipelineStatus` (`lib/data/pipeline.ts`), reusing `nullableText` /
`nonnegativeInteger` from `lib/data/normalize.ts`. Re-export from `lib/data.ts`.
**`lib/` is gated at 100% coverage** (`deno task test:coverage`).

**`components/Icon.tsx`** — add the Heroicons v2 outline glyphs the encoding
names, drawn on the same 24×24 grid at the same stroke width as the existing
`info` / `dna` / `molecule` / `beaker` / `clock` / `calendar` / `identification`
/ `map` / `funnel` set:

| Field          | Glyph              | Field           | Glyph                            |
| -------------- | ------------------ | --------------- | -------------------------------- |
| Run date       | `calendar` *       | Duration        | `clock` *                        |
| Papers fetched | `document-text`    | Papers accepted | `document-check`                 |
| Papers failed  | `document-minus`   | Full text       | `document-magnifying-glass`      |
| Genes fetched  | `dna` *            | Genes accepted  | `check-badge`                    |
| Genes rejected | `x-circle`         | Confidence      | `chart-bar`                      |
| GWAS trait     | `tag`              | Source quote    | `chat-bubble-bottom-center-text` |
| PMID           | `identification` * | Mechanism       | `molecule` *                     |
| API service    | `server-stack`     | Retries         | `arrow-path`                     |
| Payload        | `arrow-down-tray`  | Cost            | `banknotes`                      |
| Tokens         | `cube`             | Database write  | `circle-stack`                   |
| Model          | `cpu-chip`         | Run mode        | `beaker` *                       |
| Success        | `check-circle`     | Warning         | `exclamation-triangle`           |
| Expand         | `chevron-right`    | External link   | `arrow-top-right-on-square`      |

`*` already exists. The precedent for glyph-in-place-of-field-name is the
timeline tooltip's `TOOLTIP_FIELDS`, which already does this with `molecule` for
mechanism-of-action.

---

## Phase 4 — The widget

**`islands/PipelineRun.tsx`** (new, the seventh island).

```text
┌─ Last Pipeline Run ──────────────────────────────────────────┐
│ 🗓 31 August 2026, 02:17 UTC   ✓ Completed   🕐 2m 47s   🧪 PubMed │
├──────────────────────────────────────────────────────────────┤
│ › 1 Search PubMed        ✓        0.9 s                       │
│ › 2 Filter new papers    ✓        0.1 s                       │
│ ⌄ 3 Retrieve & extract   ⚠ 2      2m 11s                      │
│     • Fetched metadata for 16 papers                          │
│     • Retrieved full text for 10, abstract only for 5         │
│     ⚠ 1 paper had no retrievable text (PMID 19539236)         │
│     ⚠ 24 genes below the validation floor                     │
│ › 4 Validate             ✓        18 s                        │
│ › 5 Merge to database    ✓        2.4 s                       │
│ › 6 Finalize             ✓        0.3 s                       │
├──────────────────────────────────────────────────────────────┤
│ 📄 Papers   16 fetched → 15 processed → 10 full text          │
│ 🧬 Genes    50 extracted → 26 accepted → 24 rejected          │
├──────────────────────────────────────────────────────────────┤
│ 🖧 NCBI E-utilities    [GET]  32 calls · 1 retried · 4.1 s     │
│ 🖧 Europe PMC          [GET]  16 calls · 12.7 s                │
│ 🖧 Unpaywall           [GET]   6 calls · 1.9 s                 │
│ 🖧 Anthropic          [POST]  15 calls · 175,584 tokens · $1.38│
├──────────────────────────────────────────────────────────────┤
│         [ View everything this run recorded  → ]              │
└──────────────────────────────────────────────────────────────┘
```

Each step is a `role="button"` with `aria-expanded` / `aria-controls`, Enter and
Space to toggle — the pattern `islands/TrialsTimeline.tsx` already uses for
`g.drug`. The drawer is an `<aside>` in the timeline drawer's shape: the close
button takes focus on open, Escape closes and returns focus to the trigger.

**`routes/index.tsx`** — replace the `{status && ...}` "Last Pipeline Run" card
with `<PipelineRun run={pipelineRun} status={pipelineStatus} />`. The
`.date-label` paragraph above stays. `AboutContent` keeps its injectable-props
shape so `tests/routes_test.tsx` can render against a fixture.

**`assets/app.css`** — new surfaces join the shared depth recipe by being listed
in the rule at the head of `=== CARDS & VALUE BOXES ===` and re-declaring
`--svd-tint` / `--svd-tint-wash` / `--svd-tint-base`; new chips join the chip
selector list (currently `.filter-count, .date-badge, .timeline-legend-chip`).
Status tints resolve through existing semantic tokens — `--svd-color-accent` for
ok, ember for warning, `--svd-color-danger` for failed.
`tests/styles_contract_test.ts` forbids colour literals and palette tokens
outside the token block, so **no new colour may be written inline**. Icons need
`flex: none` (`.icon` already carries it).

---

## Phase 5 — Tests

**Python** — `tests/pipeline/test_run_report.py` (model round-trip, caps),
`tests/pipeline/test_steps.py` (recorder status/duration),
`tests/pipeline/test_run_errors.py` (`classify` per kind),
`tests/pipeline/test_api_telemetry.py` (hook aggregation, unknown-host
fallback), plus the four regression tests for the Phase 1e fixes.
`tests/pipeline/export/test_writer.py` gains the `_COMMITTED_FILES` entry.
Python floor is **99.5%** line+branch.

**Deno** — `tests/pipeline_run_data_test.ts` (normalizer, all-or-nothing),
`tests/pipeline_display_test.ts` (formatters), `tests/pipeline_encoding_test.ts`
(**every step key, error kind, service and field in the committed data has an
entry; every icon name resolves in `components/Icon.tsx`**), extend
`tests/data_contract_test.ts` and `tests/routes_test.tsx`. `lib/` is gated at
**100%**.

**e2e** — extend `e2e/tests/about.spec.ts`: a step expands and collapses by
click and by keyboard, the drawer opens with focus on its close button and
Escape returns focus, and the existing `.date-unavailable` count-zero assertion
still holds.

---

## Verification

```bash
deno task check                      # fmt + lint + type-check
deno task test                       # unit
deno task test:coverage              # lib/ at 100%
uv run pytest                        # tests/pipeline (CI's testpaths)
uv run pytest tests/scripts          # not run by CI — run explicitly
deno task test:e2e                   # production-build harness
```

Then, against a live database with `.env` populated:

```bash
uv run alembic upgrade head
uv run python -m pipeline.main --pmids logs/seven_gene_candidates.txt
deno task data                       # writes data/pipeline_run.json
git diff data/                       # only pipeline_run.json + pipeline_status.json should move
deno task dev                        # inspect the widget at /
```

The byte-exact gate is the real check: `deno task data` twice in a row must
leave `git diff data/` empty the second time.

## Out of scope

- Live streaming of a run in progress. `logs/json/pipeline_progress.json` still
  gets written and would support it behind a Fresh route handler, but that needs
  the app served from the pipeline's machine and breaks the no-runtime-fetch
  rule.
- Run history / trends. One run, fully expanded.
- Telemetry for the export, geocode, clinical-trials and external-sync
  invocations. They have no run record at all today; `--clinical-trials` and
  `--sync-external-data` do not even write a `pipeline_report_*.json`.
- Open Targets, ClinVar and Orphadata clients. They belong to
  `docs/superpowers/plans/2026-08-31-biomedical-annotation-apis.md`; the service
  registry here is built so they need no widget change when they land.
