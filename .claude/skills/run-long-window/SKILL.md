---
name: run-long-window
description: "Use when running the pipeline over a long --days-back window: checkpoint and resume semantics, the --batch state file, backfill_pubmed, and cost estimation."
---

# Running a long window

```bash
uv run python -m pipeline.main --pubmed --days-back 365 --export
```

**Not while gold-only is on.** `pipeline.main` refuses `--pubmed` -- and so
every `--days-back` window, `--batch` included -- and `scripts.backfill_pubmed`
refuses too, before any network or database work, while `GOLD_ONLY` is true in
`lib/gold_only.ts`, because the dashboard then publishes only the
hand-curated data. The undo checklist in that file's doc comment comes first.

`--days-back 365` is one run, and `_merge_processed_batch` is step 5 of 6: genes
reach the database and `record_processed_pmids_batch` writes the PMIDs only once
every paper has been extracted. Measured on 2026-11-03, a two-year window
(`--days-back 730`) is 1,570 papers for the committed `SVD_QUERY`, and Opus 5.5
extracted them in about four hours for $116 -- $0.074 a paper -- so a year's
window is roughly half that; `--test-mode` gives the live count for free. A
crash at hour two used to discard all of it and record nothing.

**An exhausted credit balance fails every remaining paper, and the run still
exits 0.** That run ran out of API credit with 210 papers to go: each answered
`400 invalid_request_error` "Your credit balance is too low", was counted as a
failed paper, and the merge, the export and the widget went ahead over the 1,358
that had finished. Nothing is lost -- a failed paper is never written to
`pubmed_refs`, so the same command retries exactly those once the balance is
topped up, which is how that window was finished (249 papers, $18.40) -- but
until then the exported data is a partial window. Fund the run with room to
spare, and read `papers.failed` in the report before committing an export. The
window starts at `datetime.now(UTC) - days_back`, so a retry on a later UTC date
needs `--days-back` raised by the days since to start where the first run did.
**Only a run in which no paper succeeds fails outright**: once every paper has
errored, step 3 raises `NoPaperProcessedError`, the run is recorded as failed
and the process exits 1 -- so a balance that is already empty when the run
starts, or a missing API key, no longer reads as a completed run. One finished
paper is enough for the behaviour above.

**About 2.4% of papers were refused by the bio safety classifier** (37 of
1,570 on 2026-11-03, before the fallback existed). The classifier is not
deterministic: on the retry five of the first pass's 37 extracted, and five of
the papers that had failed on credit were refused instead. **A streaming run
now falls back to Claude Opus 4.8** (see "A refusal names its classifier" in
`.claude/rules/pipeline/fallback.md`), so a declined paper is extracted in the
same call and reported as a `model_fallback` warning (a refusal the fallback
never saw, because it fired with the tool call on the stream or the fallback
could not be attempted, is sent straight to Opus 4.8 as a second request); only
a paper both models decline fails, as a `paper_refused` warning per
classifier, and the next run whose window still covers it retries it.
Budget a fallback paper at about three times an ordinary one: the declined
Opus 5.5 attempt is billed (a `bio` refusal is, even before any output; a
`cyber` one is not), then Opus 4.8 extracts it at $5 / $25 per MTok and
writes more than Opus 5.5 does. Measured on 2026-11-03, the retry of the 37
refused papers (plus one new one) cost $8.38 for 38 papers, about $0.22 each
against the window's $0.074: Opus 4.8 extracted 34, Opus 5.5 took 3 itself this
time, and both models declined 1. A `--batch` entry cannot fall back -- the
Batches API rejects `fallbacks` -- so the run sends each refused entry straight
to Opus 4.8 as a streaming request once the batch is collected: the same
`model_fallback` warning, at the streaming rate rather than the batch's half.

**`pipeline/checkpoint.py` is what makes that survivable.** Each paper is
appended to `logs/pipeline_checkpoint.jsonl` as it finishes, through the
`on_complete` hook `process_papers_concurrently` calls, and a re-run restores
them rather than paying for them again. Six things about it are load-bearing:

- **Papers accumulate into their own `PipelineMetrics`, not the run's.**
  `process_papers_concurrently` gives each paper a fresh accumulator and folds
  it in with `PipelineMetrics.fold()` when the paper finishes, so the hook
  receives what _that paper_ contributed and the checkpoint can store it. Those
  contributions are stored rather than derived from the `PaperResult`, because
  they are not derivable: token usage appears nowhere in the result, and a paper
  with no text available increments `papers_processed` but neither
  `fulltext_retrieved` nor `abstract_only`. Every count is per paper, including
  `papers_processed`: it used to be added in bulk once every paper had returned,
  so a run that died in step 3 published `processed: 0` beside the full texts,
  genes and tokens of the papers that had finished, and the checkpoint stored
  `papers_processed: 0` for each of them (`_restored_paper` forces it to 1 for
  files written that way). A paper that _fails_ folds only its token usage into
  the run: its genes are counted by the run that retries it, and
  `genes_extracted` is incremented only once validation held, so an NCBI outage
  mid-validation no longer left genes in `extracted` with nothing on the
  validated or rejected side.
- **The fingerprint is the extraction method.** Model, model version, thinking
  mode, effort, prompt version, the two confidence floors,
  `require_verified_quotes` and `max_paper_text_chars` -- everything that
  changes what extraction returns for the same paper. The last two are there
  because the verbatim-quote gate drops genes _inside_ extraction
  (`report_provenance`, before validation), and the truncation limit decides how
  much of the paper the model and that check were given: a restore is not an
  extraction, so a paper checkpointed with the gate off would otherwise be
  folded whole into a run configured to refuse those genes, and replay its
  `dropped_unverified: 0` into the report. A mismatch deletes the file rather
  than resuming from it: restoring a paper extracted under different settings
  would mix methods inside one dataset, which is what pinning `EXTRACTION_MODEL`
  in code exists to prevent. `--days-back` is deliberately _not_ in it, so a
  checkpoint written by a 30-day run is valid for the 60-day run that resumes
  it.
- **Only successes are checkpointed, and the file is pruned -- not cleared --
  after the merge.** A failed paper is never written to `pubmed_refs`, so the
  next run retries it; checkpointing one would restore the failure instead and
  retire the paper without ever extracting it. Once the merge has run,
  `pubmed_refs` is the durable record _for the papers it merged_, and
  `checkpoint.remove` drops exactly those records, unlinking the file only when
  none remain. `_restore_checkpoint` restores only the PMIDs in this run's
  window, so a checkpoint written by a crashed `--days-back 365` holds hundreds
  of papers a nightly `--days-back 7` never publishes; unlinking the whole file
  there, as the merge used to, destroyed that extraction with nothing saying so.
  `--dry-run` neither writes nor prunes it -- it merges nothing, so it has not
  earned the right to delete a real run's saved work. The prune is **best
  effort**, like the append: it runs after the genes and the PMIDs are
  committed, so an OSError there is logged and the records stay rather than
  raising into `except BaseException` and recording a run whose data is in the
  database as failed. What is left behind costs nothing -- `pubmed_refs` holds
  those PMIDs and the next run filters them out.
- **One file, so it is locked.** Every run reads and writes
  `logs/pipeline_checkpoint.jsonl`, and a scheduled nightly run can fire over a
  long re-run -- the case `LOG_FILE`'s PID suffix and `_write_progress`'s
  per-process `.tmp` already anticipate. `append`, `load`, `clear` and `remove`
  each hold an exclusive `flock` on a sibling `.lock` file for the whole of
  their work, so the prune's read-filter-replace cannot rewrite away the papers
  the other run appended in between. The lock is that sibling file and not the
  checkpoint itself, because `remove` unlinks and replaces the checkpoint: a
  lock on an inode that is no longer the file at that path guards nothing.
- **The record carries the paper's quote counts.** `ProvenanceTally` keeps a
  per-paper share under `paper_scope`, a context variable `run_one` sets around
  each paper, and the checkpoint stores it as `provenance`; a restore replays
  it. A before-and-after delta would not do: papers are extracted concurrently
  into one module-level tally, so the delta around one paper carries whatever
  the others recorded meanwhile. Without this a resumed run published
  `quotesChecked` over part of the genes it counted.
- **A resumed run's cost includes the crashed run's spend**, which is also in
  that run's own failed report. `_restore_checkpoint` says so as a step action
  ("Restored N papers … counted in both runs"), so the two reports read
  correctly together; that is why the restore is visible in the widget rather
  than silent.
- **The merge sees the window's order, not the resume's.** Both extraction paths
  end at `_in_request_order(pmids, results)`, which reorders the batch by the
  run's own PMID list. `results` used to be `restored + pending`, so a resumed
  run merged the same two papers in the opposite order — and the merge keeps the
  _first_ occurrence's quote, confidence and protein
  (`_build_combined_gene_data`) and inserts rows in that order, so the crash
  changed the published `sourceQuote`, the published `confidence` and the `id`s
  `data/table1.json` is ordered by. The streaming path was already in request
  order without a restore (`process_papers_concurrently` returns
  `[task.result() …]`), so this is parity rather than a new rule; `--batch`,
  which assembled its results by arrival stage, gains the same determinism.

`--batch` checkpoints too, through the same `_paper_finished_hook`. Its results
arrive together, but they are paid for the moment they do, and validation and
the merge still stand between them and `pubmed_refs`: a crash at either step
used to lose the whole batch and the next run resubmitted every paper. Each
paper is written as its validation finishes, from its own `PipelineMetrics`,
with its share of the quote tally (`results_by_custom_id` runs
`report_provenance` under `paper_scope`). One difference from the streaming path
is deliberate: the batch's tokens are one figure for the whole batch, not per
paper, so a restored batch paper carries none of them -- the crashed run's own
failed report holds the spend. A paper the fallback model rescued after the
batch declined it is the exception: its record carries that streamed request's
tokens, and the restoring run counts them at the full rate. The batch path used
to write nothing and also reached the unconditional clear without restoring a
streaming run's papers.

**The poll window of a `--batch` run is covered by a state file.**
`submit_and_collect` writes the batch id to `logs/pipeline_batch.json`
(`PIPELINE_BATCH_STATE_FILE`) right after `batches.create`, before the first
poll, so a crash inside the up-to-24h wait costs nothing: a re-run with the same
method fingerprint retrieves the recorded batch instead of submitting it again.
Only papers whose text is unchanged are reused (the file keeps a hash of each
document block); the rest go out as a new batch, and a changed fingerprint
discards the file. Anthropic keeps batch results for 29 days; after that, or if
the API no longer knows the batch, the papers are resubmitted with a warning.
Each record carries the time its batch was created, and reading the file drops
(and logs at info level) any record more than a day older than those 29 days, so
a window that is never re-run does not leave its record behind for ever; a
record written before that field is kept.
Which report holds a resumed batch's tokens depends on where the first run
stopped. After a crash in the poll the batch was never collected, so its tokens
are counted only by the run that collects it. After a crash in validation or in
a rescue the crashed run had already collected the batch, so its failed report
holds the batch's tokens, and the resuming run counts the tokens of the papers
it collects again: paid once, reported in both. The resuming run names the reuse
as a step action ("Collected N papers from a batch an earlier run submitted; if
that run had already collected it, their tokens are in both reports"), as a
checkpoint restore is named. An entry of a recorded batch that expired or was
canceled comes back as a failed paper on the resuming run, is taken off the
record, and is resubmitted by the run after it. A run takes its own papers off
the record (`batch_state.forget`) only once every batch paper has been validated
and every refused one rescued, so a crash in validation can still retrieve the
results. It takes off what it stored, what was rescued or declined twice, and
every entry with no usable result (so that one is resubmitted rather than
replayed as a failure), and a paper whose validation failed for any reason but
an NCBI outage (the same answer would fail the same way until the batch
expired). A paper whose fetch failed, or whose validation hit an NCBI outage,
stays on record for the next run to collect. Every other batch on record is kept
untouched, because `scripts.backfill_pubmed --batch` re-runs from its first
window after a crash in a later one, and a later window's record erased by the
first would be paid for twice. A record goes only when all its papers are forgotten or the API no longer
has its results. A dry run or `--test-mode` neither writes nor forgets.
`--test-mode` counts what a window would process before paying for it, and
`scripts.backfill_pubmed` walks it in committed chunks so the database is
updated as it goes; both are described in
`.claude/rules/pipeline/long-windows.md`.

```bash
uv run python -m pipeline.main --test-mode --days-back 365
uv run python -m scripts.backfill_pubmed --days-back 365 --step 30
```
