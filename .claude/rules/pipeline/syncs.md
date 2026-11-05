---
paths:
  - "pipeline/sync_report.py"
  - "pipeline/main.py"
  - "pipeline/cache_utils.py"
  - "pipeline/external_data_sync.py"
  - "pipeline/annotations.py"
  - "pipeline/ncbi_gene_fetch.py"
  - "pipeline/database.py"
  - "tests/pipeline/test_sync_report.py"
  - "tests/pipeline/test_external_data_sync.py"
  - "tests/pipeline/test_annotations.py"
  - "tests/pipeline/test_ncbi_gene_fetch.py"
  - "tests/pipeline/export/test_read_sync_runs.py"
---

# Reference-data refreshes

## The refreshes record their own runs

`build_run_report` is reachable only from inside `run_pipeline`, so for a long
while **no published report could contain a ClinVar, Orphadata, Open Targets,
UniProt or ClinicalTrials.gov row at all**: the three sync modes go through
`_run_summary_pipeline`, which returned a summary dict and wrote no
`pipeline_runs` row, and everything their clients recorded was dropped when the
process ended. `pipeline/sync_report.py` and migration 011's `sync_runs` table
are what publish it.

- **`_run_summary_pipeline` is the single instrumentation point**, because all
  three modes already pass through it and it already knows the mode name.
  `--clinical-trials` was fixed by the same edit without being mentioned in it.
- **`reset_recorder()` there is load-bearing and not obvious.** The recorder is
  module-level and reset only at the top of `run_pipeline`, so without it a
  `--pubmed --sync-annotations` invocation would publish the PubMed run's rows
  as the refresh's own. It is safe because `_finalize_run` snapshots the
  recorder _inside_ `run_pipeline`, before the dispatcher reaches the syncs —
  which is also why a refresh can never pollute the run report in the other
  direction.
- **The record is stored in its own table, and that is not tidiness.**
  `PipelineRunReport` requires three fields and defaults the rest, so a refresh
  document written to `pipeline_runs.report` would _validate_ in
  `read_pipeline_run` rather than be rejected, and the About page would publish
  a zero-filled PubMed run over the real one — no exception, no log line. And
  `read_pipeline_status` dates the whole dataset from that table's newest
  non-failed row, so the refresh would also re-date the dashboard. Sharing the
  table would put a `WHERE run_mode = 'standard'` clause in two readers that
  each swallow their own errors; a separate table removes the mistake instead of
  fencing it.
- **A refresh derives its own status.** `derive_status([])` returns `completed`,
  so reusing it on a step-less document would publish a green badge over a
  refresh that failed outright. `derive_sync_status` reads the summary's own
  status and the per-source failure counts instead; a per-source failure is
  amber, not red, because the sync carried on and wrote what it could.

  **That amber branch was unreachable until `aborted` existed.** Every sync
  appends one error string for each gene, ORPHAcode or study it could not fetch,
  and both `_result_summary` and `derive_sync_status` read `failed` off a
  non-empty `errors` list — so ClinVar timing out on 1 of 63 genes published a
  red badge over a refresh that wrote the other 62, exited the process 1 and
  logged "Exporting despite failures". The two facts are now separate: `errors`
  is per item and turns the badge amber, while `SyncResult.aborted` (and
  `ExternalDataSyncResult` / `AnnotationSyncResult`) is set only where a sync
  **stops** — the 3600 s timeout, a CTG search that raised, a CTG upsert that
  wrote none of its records — and is the only thing `_result_summary` reports as
  `failed`. An exception escaping the sync is the other red path, through
  `_failure_summary`. A summary with per-item errors and no abort reports
  `status: "warnings"`, which is neither the exit code's `failed` nor a silent
  `ok`.
- A `skipped` clinical-trials summary (`ct_enabled=False`) records **no row**:
  it made no calls and changed nothing, which is the reasoning that also keeps
  the offline run modes out of `pipeline_runs`. The write is otherwise
  best-effort and swallowed on failure, as `_record_failed_run` is — the
  database is often the thing that just failed, and raising there would replace
  the refresh's real error on its way up.

## Machine-fetched annotations

`--sync-annotations` fetches disease, ontology and identity annotations for the
curated genes from ClinVar, Orphadata and Open Targets into `gene_annotations`
and never writes `genes`. Running or debugging it -- the ClinVar-then-Orphadata
dependency order, the delete-before-insert trap and the 30-day status rows that
stand in the way of a re-sync, `_LOOKUP_ALIASES` for `COL4A1/2` and `C6orf195`
-- is the `sync-annotations` skill (`.claude/skills/sync-annotations/SKILL.md`).

**`--sync-annotations` is deliberately a separate entry point from
`--sync-external-data`.** The existing sync feeds the NCBI/UniProt/PubMed caches
every consumer already reads; folding four more APIs into it would make every
existing run several times longer for data nothing reads yet.
`deno task geocode` and `deno task cytobands` are the house precedent for a
deliberate, separately-invoked refresh. It is a full mode rather than a bare
call — a `run_*` wrapper returning a summary dict plus a `_run_summary_pipeline`
dispatch — because that list is what drives the process exit code and the run
record, **and it is named in `online_modes`**: `_prepare_cli_args` turns on
`--pubmed` whenever no mode is selected, so a flag missing from that tuple does
not merely fail to run, it silently runs the LLM extraction instead.

## A discovered gene needs a band, and the cache must admit it lacks one

Extraction is not asked for a chromosomal location and nothing else in the
schema carried one, so the sixteen genes the year-long run inserted published as
`(unknown)` and reached no chromosome of the phenogram. NCBI states
`maplocation` ("17q25.1") in the same esummary `_fetch_gene_summary` already
read `description` and `otheraliases` out of. Migration 012 caches it, and
`fill_missing_chromosomal_locations` copies it into `genes` **only where the
column is empty**, so curated rows keep the source spreadsheet's spelling.

**A cached row written before a column existed is not a complete answer.** The
fix filled 3 of 16 on its first run: the other 13 had `ncbi_gene_info` rows
whose `map_location` was NULL, and a cache hit skips the fetch, so they would
have stayed unplaceable for as long as the row stayed fresh.
`get_cached_ncbi_genes` now withholds a NULL `map_location` the way it withholds
a stale row -- NULL means "written before migration 012", an empty string means
"fetched, NCBI states no band" -- so each row heals exactly once rather than
re-fetching forever. Any column added to a lookup cache later needs the same
treatment.
