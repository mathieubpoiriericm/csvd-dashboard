---
paths:
  - "pipeline/report.py"
  - "pipeline/run_report.py"
  - "pipeline/steps.py"
  - "pipeline/run_errors.py"
  - "pipeline/main.py"
  - "pipeline/citations.py"
  - "pipeline/pdf_retrieval.py"
  - "pipeline/validation.py"
  - "pipeline/export/lookups.py"
  - "tests/pipeline/test_report.py"
  - "tests/pipeline/test_run_report.py"
  - "tests/pipeline/test_steps.py"
  - "tests/pipeline/test_step_warnings.py"
  - "tests/pipeline/test_run_errors.py"
  - "tests/pipeline/test_run_accounting.py"
  - "tests/pipeline/export/test_read_pipeline_run.py"
  - "tests/pipeline/test_citations.py"
  - "tests/pipeline/export/test_lookups.py"
  - "tests/pipeline/test_main.py"
  - "tests/pipeline/test_main_orchestration.py"
  - "tests/pipeline/test_pdf_retrieval.py"
  - "tests/pipeline/test_validation.py"
---

# Run reporting

The pipeline builds two reports from one run. `pipeline/report.py` still builds
`PipelineRunData` for the three sinks it always had -- the JSON log file, the
rich console summary, and the notification plus SQLite event log.
`pipeline/run_report.py` builds `PipelineRunReport` beside it, from the same
inputs, and that one is published: it is stored in `pipeline_runs.report` and
exported to `data/pipeline_run.json` for the About page's widget. Nothing in the
second recomputes a metric the first computed.

- **`PipelineRunReport` is the schema on both sides of the database.** The
  export re-validates the stored document through it rather than passing it
  through, so a row written by an older pipeline is either brought up to the
  current shape or refused — the dashboard never receives a document its
  TypeScript does not describe. Field order in the model _is_ wire order, and
  the export is byte-gated, so a reordering is a visible diff.
- **The column is `JSON`, not `JSONB`.** jsonb normalises key order and this
  repo gates every exported file on bytes. A write-once audit record that is
  never queried by value has no use for jsonb's indexing either.
- **Detail lists are capped at 200 (`DETAIL_CAP`) and carry `shown` beside
  `total`.** Counts above them are never capped. A 500-paper run would otherwise
  turn a reviewed file into an unreviewable diff, and a truncated list that did
  not say so would read as the whole record.

## One step vocabulary, and it is timed now

`pipeline/steps.py` holds `PIPELINE_STEPS` -- the six keys the progress file
writes, each with the label the dashboard shows -- and `StepRecorder`, which
times them off the same `progress.report(n)` index.

**A run is only `completed` when nothing warned.** The widget exists to make
losses visible, and a green badge over 24 rejected genes would be the silence it
replaces. Warnings are raised as one row carrying a count, never one row per
occurrence, and from three steps rather than one:

| Step                | Warns on                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `processing_papers` | papers with no retrievable text, papers that failed outright, papers a safety classifier declined (`paper_refused`, one warning per classifier), papers the fallback model extracted (`model_fallback`), papers cut short at `max_paper_text_chars`, genes below the validation floor, genes dropped for an unverifiable quote, truncated model responses, services that errored or were retried |
| `batch_validation`  | anything `batch_validate` flagged (over-extraction, say)                                                                                                                                                                                                                                                                                                                                         |
| `merging_database`  | new genes the insert floor refused                                                                                                                                                                                                                                                                                                                                                               |

Two of those are easy to lose. Genes removed for an unverifiable quote
(`require_verified_quotes`) are dropped _inside_ extraction, so `extracted`
never saw them and the validation gate never scored them; `_quote_rejections`
turns them into `RejectedGene(reasons=["Quote not found in the paper"])` and
`_record_processing_actions` raises `quote_unverified` naming them. They are
deliberately _not_ added to `genes_rejected`, which is the validation floor's
number. A paper cut short at `max_paper_text_chars` (400,000 characters; the
Docling PDF path in practice) still goes into `pubmed_refs` as processed with
full text, so no later run revisits it; `paper_text_truncated` carries that
through `ExtractionOutcome`, `PaperResult` and the checkpoint to a
`paper_truncated` warning naming the PMIDs. Warning titles agree with their
counts through `_count` / `_were`, and a failure carries no `subject`.

**A failed run persists its report too.** `_record_failed_run` writes the
`pipeline_runs` row -- `status: "failed"`, every classified `RunError`, the
report built through `build_run_data` exactly as a completed run's is -- from
whatever the run had in hand: the search counts once step 1 has answered, every
finished paper as `_paper_finished_hook` appends it to `processed_so_far`
(collected whether or not the run is checkpointing), and the `MergeResult` the
instant `merge_gene_entries` returns, before `record_processed_pmids_batch`
opens its own transaction. So a cancellation inside step 3 or a failure after
the merge publishes real papers, real counts and the genes the insert floor
refused, and the funnel adds up. It is best-effort by construction -- the
database is often the thing that just failed -- and so are `_record_and_notify`
(the event-log write sits in its own `try`) and `_publish_export`, which catches
`Exception` because asyncpg, `DB_*` and pydantic errors all escaped a narrower
clause without the "behind the database" diagnostic.

**A failed run does not date the data.** `read_pipeline_status`, behind
`data/pipeline_status.json` and the About page's "up-to-date as of", skips
`status = 'failed'` rows; `read_pipeline_run` still returns them, so the widget
shows the failure while the date stays on the last run that finished as a whole.
That is **not** the offline modes' reasoning: `--local-pdfs` and `--pmids` write
no row because they publish nothing, whereas a failed run may well have changed
the data -- the merge commits before the run is anywhere near done, and
`--export` ships those rows.

## Failures are classified, not dumped

`pipeline/run_errors.py`'s `classify()` is the one place an exception becomes a
reader-facing reason; the matching rules and their reasons are commented there.
One trap worth repeating: **a bare `"429"` is deliberately not a rate-limit
phrase** -- PMIDs are eight digits, so `"Error processing PMID 34291234"`
matches it, and phrases are whole-word matches on the message alone, never on
the class name.

## Two accounting decisions this surfaced

- **Insert-floor rejections are counted, and counted once.** A held gene passes
  validation, so it is in `papers_detail[*].genes`; it is refused at the merge,
  so it is in `held`. It was published in _both_ `acceptedGenes` and
  `rejectedGenes` — two answers to the same question — and
  `rejectedAtInsertFloor` was rendered nowhere, so nothing on the page
  reconciled them. Accepted now means what reached the database, and the holds
  are their own stat. `_rejected_records` also lists them **first**: the list
  caps at `DETAIL_CAP`, holds are always few and validation rejections are many,
  so appending them last truncated the whole category away on a large run while
  still publishing its count.
- **`papers.noTextAvailable` is its own count, not part of `failed`.** A paper
  with no retrievable text is a stable fact rather than a transient failure, so
  all three paths now record it as _processed_ with `source: "none"` — which is
  what stops the pipeline retrying that paper on every future run. The offline
  PMID path used to call it an error, so `papers.failed` meant two different
  things depending on which mode had run; it now agrees with the other two, and
  `noTextAvailable` counts the condition.

  That rule rests on retrieval telling the two apart, and two places did not.
  `pdf_retrieval.fetch_abstract` is the last resort, so unlike the sources
  before it, which swallow their own failures and fall through, it raises
  `RetrievalError` on a non-200 or a transport failure: a 429 on the abstract
  call used to read as "no text", and the paper went into `pubmed_refs` for
  good. `validation` raises `NcbiUnavailableError` the same way -- a lookup NCBI
  did not answer is not a gene it does not know, and `None` for both meant one
  timeout on `NOTCH3` was cached as "not found" for the rest of the run.
  `_validate_genes` re-raises it so the _paper_ fails and is retried, rather
  than being recorded as processed with the gene missing; the batch path catches
  it per paper.

The offline `--pmids` and `--local-pdfs` modes write no `pipeline_runs` row, and
that is correct rather than an oversight: they publish no data, so recording one
would point the About page's "up-to-date as of" date at a run that changed
nothing. `RUN_MODES` in `pipeline/steps.py` is the vocabulary the column
accepts, declared as a constant because the encoding contract test reads it — it
used to parse `run_mode: One of '…'` out of a docstring, and rewording that
sentence silently broke the check.

## Quote provenance reaches the report

Provenance reporting (now `report_provenance` in `pipeline/citations.py`)
computed how many quotes were verbatim in the paper and how many matched an API
citation span, logged both, and discarded them — so the dashboard could show a
gene's quote without being able to say how many checked out.
`citations.ProvenanceTally` accumulates them for the run.

It is a module-level tally reset per run, like the API recorder, rather than a
return value threaded through `extract_from_paper` and `_extract_and_validate`:
those are the hottest and most carefully tested signatures here, and this is a
measurement none of them acts on.

**The two numbers are published as two numbers.** `quotesVerbatim` asks whether
the sentence is in the paper, of every gene. `quotesCited` asks whether the API
attested to that span — the stronger claim, but bounded by how much prose the
model wrote rather than by quote quality, which is why it sits at 98/124 while
verbatim sits at 122/124. One averaged rate would report a quality figure the
second number cannot carry.

**A failed paper's quotes are un-counted, by the rule its genes already
follow.** `report_provenance` runs inside extraction, before NCBI validation, so
the counts are in the tally by the time `_validate_genes` re-raises an
`NcbiUnavailableError` and the paper is recorded as failed. `genes_extracted` is
incremented only once validation held, and folding the tally on the same terms
was missed: a run of two papers where the second yielded 5 genes and then failed
published `genes.extracted: 2` beside `quotesChecked: 7`, so the About page read
"7 of 7 quotes found in the paper" under a funnel of 2 genes — and the run that
retried the paper counted the same 7 again. `ProvenanceTally.discard(pmid)`
subtracts the paper's `by_paper` share, and both concurrent paths call it in the
branch that already folds only the token usage (`run_one` in
`process_papers_concurrently`, `validate_one` in
`_process_new_pmids_via_batch`). A subtraction rather than a fold-on-success
because the tally is also filled from paths that never enter `paper_scope` — the
offline `--pmids` and `--local-pdfs` modes — where nothing would ever fold it
in.
