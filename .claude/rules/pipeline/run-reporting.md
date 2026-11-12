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
occurrence, and from three steps rather than one. A service that was retried and
still failed raises two, `api_retried` and `api_errored`; one warning chosen by
`retries or errors` said nothing about the calls that failed anyway.

| Step                | Warns on                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processing_papers` | papers with no retrievable text, papers that failed outright, papers a safety classifier declined (`paper_refused`, one warning per classifier), papers the fallback model extracted (`model_fallback`), papers cut short at `max_paper_text_chars`, findings below the validation floor, findings dropped for an unverifiable quote, truncated model responses, a citation rate below 20% (`citations_missing`), services that errored or were retried |
| `batch_validation`  | anything `batch_validate` flagged (over-extraction, say)                                                                                                                                                                                                                                                                                                                                                                                                |
| `merging_database`  | new genes the insert floor refused                                                                                                                                                                                                                                                                                                                                                                                                                      |

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
refused, and the funnel adds up. The hook is handed failed papers as well as
finished ones and checkpoints only the successes: the streaming path used to
call it for successes alone, so a paper that failed before a kill was in no list
and not in `failed`, with only its token spend published. The search count
leaves `_discover_new_pmids` through `on_searched` as step 1 answers, because
steps 1 and 2 return together and a dedup read the database refused threw it
away; `newlySeen` and `alreadySeen` stay null there, since step 2 never said. It
is best-effort by construction -- the database is often the thing that just
failed -- and so are `_record_and_notify` (the event-log write sits in its own
`try`) and `_publish_export`, which catches `Exception` because asyncpg, `DB_*`
and pydantic errors all escaped a narrower clause without the "behind the
database" diagnostic.

**A failed run does not date the data.** `read_pipeline_status`, behind
`data/pipeline_status.json` and the About page's "up-to-date as of", skips
`status = 'failed'` rows; `read_pipeline_run` still returns them, so the widget
shows the failure while the date stays on the last run that finished as a whole.
**Nor does a run that processed no paper** (`papers_processed > 0` in
`_STATUS_QUERY`): one whose papers were all declined is recorded as completed
with warnings, not failed, and it changed no more than a run that found nothing
new, which writes no row at all. That is **not** the offline modes' reasoning:
`--local-pdfs` and `--pmids` write no row because they publish nothing, whereas
a failed run may well have changed the data -- the merge commits before the run
is anywhere near done, and `--export` ships those rows.

**A run in which every paper errored is a failed run.** A paper that fails is
caught on its own and the run carries on, which is right for one paper in forty
and wrong for forty in forty: with no API key, exhausted credit or NCBI down,
nothing raised, and the run was recorded as completed with warnings and exited 0
having processed nothing. `_fail_if_no_paper_was_processed` raises
`NoPaperProcessedError` inside step 3, after its warnings are recorded, so the
failure lands on that step with what it found under it and steps 4 to 6 read as
not reached. It needs a paper that errored and none that succeeded: a paper a
classifier declined is a filter doing its job, so a run of refusals alone still
completes with its warnings. `classify()` gives it its own kind,
`no_paper_processed`, and the first paper's error as the detail.

**"Accepted" is a claim about the database, and a run that never merged cannot
make it.** A run that failed before its merge publishes `database: null` and
still lists the genes its papers validated under `acceptedGenes`, because they
are what it has to show;
`test_a_run_killed_inside_step_3_still_lists_its_papers` pins that. The widget
reads the null and says "Validated" in the run details: the Findings heading
and the Papers table's column.

**The export brings an older stored report up to date** (`published_run_report`
in `pipeline/export/lookups.py`): re-validation fills what the report lacks,
`bring_up_to_date` corrects what a default cannot, `recover_search_window` and
`reword_findings` read back and reword what the report's own sentences say (both
below), and `relabel_api_rows` re-derives labels and folds an endpoint an older
normalisation split. A paper's
`geneCount` and a gene's `citationOnly` are both read back from the accepted
list, so both need it complete; a capped list, or a gene with no PMID, leaves
the report as stored. An older report's holds stay one record per gene with no
paper named, because which papers proposed a gene held from two is not in the
document. `test_the_committed_run_report_is_what_the_export_writes` holds
`data/pipeline_run.json` to that pass: a committed file it would change is one
the next export rewrites.

**The search window is a field, `config.daysBack`.** It was in
`PipelineRunData` all along and dropped by the model, so the run card's Search
row could say "1,571 papers matched" and not over what; the number lived only in
the step's sentence. It is null on an offline run, which searched nothing.
`recover_search_window` gives a report stored before it the number back from
that sentence ("Searched PubMed over the last 730 days: ..."), which this
pipeline wrote, and leaves a report alone when it stored the window or its
search step holds no such sentence.

**A sentence that counts findings says "findings".** A finding is one paper's
proposal of a gene and a gene is a row of the database, so a gene two papers
proposed is two findings. The dashboard's rows use the two nouns, and four of
the pipeline's sentences counted proposals as genes beside them: "Extracted N
genes, of which M passed validation", "Cross-checked N genes against the rest of
the batch", "N genes did not clear the validation floor" and "N genes were
dropped because the quoted sentence was not found in the paper". They are
written with `_count(n, "finding")` now, and `reword_findings` brings a stored
report into line, whole sentence by whole sentence (`_FINDING_SENTENCES`), so
anything it does not recognise is left as stored. **The merge's sentences keep
"gene"**: it writes rows and holds genes, so "Inserted 1 gene and updated 4" and
"8 new genes were held below the insert floor" are right as they stand.

**A failed invocation's digest says why and how long.** A run that raises
reaches the notifier as a summary, not as run data, and the digest read
"Combined (0.0s)" over "pubmed: failed (1 error)". `_run_selected_pipelines`
times the invocation, `_failure_summary` keeps an error's `detail` in its one
string, the template prints a failed mode's first error, a single mode is
labelled by its name rather than "Combined", a digest of refreshes alone names
no model, and Apprise is sent `FAILURE` when any mode failed.

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
- **A paper's `geneCount` is what the accepted list holds for it.** The run
  details print it under "Accepted", and a held gene passes validation, so the paper's
  own count included it: PMID 42957517 read "2 accepted" on 2026-11-03 with
  neither gene in `acceptedGenes`, and the rows summed to 19 under a headline of
  10. `_paper_records` moves a paper's held genes to its `rejectedCount`, the
  side of the run details they are listed on. **A hold is one record per paper that
  proposed the gene** (`_hold_records`), under the paper's spelling and the
  score that mention carried, and `rejectedAtInsertFloor` counts those records.
  The merge returns one hold per gene, and counting those left the funnel one
  short whenever two papers proposed a held gene: that run validated 19,
  accepted 10 and held 8. Now `validated` is the accepted list's total plus the
  holds. The step-5 warning counts the same mentions, and says so when they
  differ from the genes ("8 new genes, extracted 9 times, were held"):
  `HeldGene.mentions` carries the number out of the merge.
- **A citation-only update says so.** An existing gene whose best score sat
  below the insert floor takes its PMID, quote and score and no claim
  (`_citation_only`). `MergeResult.citation_only` returns those keys, and the
  gene's accepted record carries `citationOnly: true` with its trait, omics and
  Mendelian fields empty, as the row's contribution is; it used to carry what
  the model extracted, so the run details showed claims the table never took. Step 5
  names the count as an action, not a warning: the floor is doing its job.
- **The report says how it was run and what it cached.** `config.batch` and
  `tokens.cacheCreationInputTokens` were in `PipelineRunData` all along and
  dropped by the model, so a halved `--batch` cost and the cache writes, billed
  above the input rate and counted in neither `inputTokens` nor `totalTokens`,
  could not be reconciled from the published document. Both are null, not false
  or 0, on a report stored before them.
- **A `--batch` run prices the papers it restored at the rate they were paid.**
  A batch entry's checkpoint record carries no tokens, so every token a batch
  run restores came from a streaming request at the full rate: a streaming run's
  paper, or a batch paper the fallback model rescued.
  `_restore_checkpoint(batched=True)` counts them in
  `PipelineMetrics.streamed_token_usage` as well, and `_build_common_run_data`
  takes the batch discount back off that share. A refused entry the run sends to
  the fallback model (`_rescue_refused_batch_paper`) is a streaming request too,
  so its tokens join the same share, whether or not the paper is kept.
- **`processingSeconds` is null for a paper nobody timed.** A `--batch` entry
  keeps `PaperResult.processing_time`'s default of 0.0, which published "0 ms"
  on every row of a day-long poll.
- **`cacheHitRate` is cache reads over all input**: uncached, cache writes and
  cache reads, the three counts the API reports apart. It left the writes out,
  so two abstract-only papers, one writing an 18k-token prefix and one reading
  it, published 90% where 18k of 38k was cached. `totalTokens` is still the
  uncached input plus the output, which is why the widget says "of input".
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

  **A paid answer outlives an NCBI outage.** Retrying used to mean extracting
  again: on the default path every paper is a full-rate request, the answer
  lived only in memory, and an outage fails every validation that reaches it.
  `_extract_and_validate` now re-raises the outage as `_AnswerNotValidatedError`,
  a subclass with the same message that carries the genes and the `ServedBy`,
  and `process_paper` appends them to the checkpoint as an `unvalidated` record
  before the paper fails as it always did (reported, not checkpointed as
  finished, its quotes un-counted, its tokens counted in this run). The next run
  whose fetched text hashes the same makes no request for that paper: no
  limiter reservation, zero tokens, the quote counts put back, the stored genes
  validated, and the step says "Validated N papers that were
  extracted in an earlier run whose validation NCBI did not answer; their
  tokens are in that run's report". The stored answers reach `process_paper`
  through a context variable (`_stored_answers`, set in `_process_new_pmids`)
  rather than a parameter, as the quote tally does, so the three streaming
  signatures and their forty-odd test fakes did not change; a dry run leaves it
  unset and so neither writes nor reads. The cache warm-up counts only the
  papers that will make a request. `_StoredAnswers` is shared with the `--batch`
  path, whose rescues write the same record (`fallback.md`), and either path
  replays the other's. The offline modes are untouched: they meet the subclass
  where they met the plain outage.

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

**A collapsed citation rate is a warning.** `_record_processing_actions` raises
`citations_missing` on `processing_papers` when the tally holds at least 10
quotes (`_CITATION_RATE_MIN_QUOTES`) and fewer than 20% matched an API citation
(`_CITATION_RATE_FLOOR`; the measured rate has ranged 33-79%). The model writes
cited prose before its tool call and a model change could silently stop that;
the warning reads the same tally as `quotesChecked` / `quotesCited`, and the
streaming and `--batch` paths both end in that function. It is a review flag in
`lib/pipeline_encoding.json`, and its count is the quotes no citation matched,
so the flag reads "9 quotes without a citation"; worded as a collapsed rate it
read "9 citation rates collapsed" over one rate.

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
