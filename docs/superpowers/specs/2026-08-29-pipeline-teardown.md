# cSVD Pipeline Teardown — findings and recommendations

Research date 2026-08-29. Scope decisions settled with the maintainer:
report-only output; the R export layer is ported to Python; the experimentation
tooling and the PubMed query distiller are both removed; commercial API only —
no open-weight model specialization.

## The system

Two halves meeting at PostgreSQL. `pipeline/` (9,358 lines) ingests and writes
nothing to `data/`; `data-prep/` (1,629 lines) exports the nine committed JSON
files. `scripts/` (10,026) and `tests/scripts/` (4,587) are the removal set.
Output is 103 KB: 63 genes, 16 trials, 70 map sites.

## Findings

1. **The geocoding stage is deletable.** ClinicalTrials.gov API v2 returns
   `protocolSection.contactsLocationsModule.locations[].geoPoint.{lat,lon}` —
   inside the response `geocode.R:181` already fetches and discards.
   `filter.ids` fetches every trial in one request. Both CT.gov and Nominatim
   are city-level (all four New York facilities share one coordinate), so no
   precision is lost, but `jitter_duplicate_coordinates()` must stay.
2. **A live defect in the model config.** `ADAPTIVE_THINKING_MODELS` is an
   allowlist of two strings; any Claude 5 model set via `PIPELINE_LLM_MODEL`
   falls through to `budget_tokens`, which is HTTP 400 on Fable 5, Opus 5, Opus
   4.8 and Opus 4.7. `_CACHE_WRITE_MULTIPLIER = 2.0` and the pricing rows are
   correct — do not "fix" them.
3. **Europe PMC deletes most of the PDF stage.** 84.9% of a 1,000-paper sample
   of this subject area has full text as JATS XML, free and keyless, with real
   table markup. For the remainder, PyMuPDF's `get_text()` scores 0.17 table F1
   against Docling's 0.69, interleaves two-column layouts into false adjacency,
   and fuses reference superscripts onto gene symbols. Docling is MIT; PyMuPDF
   is AGPL v3.
4. **The biomedical MCP connectors are programmatically usable** — PubMed, Open
   Targets and GWAS Catalog verified live and unauthenticated. The three
   deepsense-hosted ones did not respond.
5. **No orchestrator earns its keep.** Dagster, Prefect, Airflow, Kestra,
   Windmill and Temporal are all priced against continuous execution; this runs
   a few times a year by hand.
6. **API status.** The pipeline calls five hosts: NCBI E-utilities, UniProt,
   Unpaywall, ClinicalTrials.gov, doi.org. It does _not_ call OpenAlex, Open
   Targets, GWAS Catalog or MyGene, so those services' 2026 breakages are
   prospective, not current. Unpaywall folding into OpenAlex is the one live
   risk; a free NCBI key lifts 3 → 10 req/s.

## Recommendations

1. Delete the Nominatim stage.
2. Port `export.R` to Python.
3. Fix the thinking/effort gating; move to `claude-opus-5`.
4. Europe PMC as primary retrieval; Docling for the PDF fallback.
5. Delete `llm_providers/`.
6. Record provenance in the schema (`source_quote`) — Citations and structured
   outputs cannot be combined (400).
7. Batch API plus 1-hour prompt caching.
8. Replace the deleted harness with a golden-file pytest suite.
9. Adopt nothing structural.

## Correctness hazards carried into the plan

- The 250-line gene-merge CTE is written twice and is behaviourally untested;
  `test_database.py` asserts on SQL substrings.
- PMID extraction exists three times with different rules across two languages;
  gene-symbol splitting twice.
- `data_merger.format_omics` and `clean_table1.R` are coupled by a docstring.
- `static/timeline.html` embeds a second copy of all 16 trials and is generated
  by a different repository; only registry IDs are checked.
- `static/phenogram.html` duplicated the GWAS trait vocabulary with no test —
  retired 2026-08-29; the phenogram now reads `lib/phenogram_encoding.json`,
  pinned by `tests/phenogram_encoding_test.ts`.

## Constraint

The four sentinel strings (`"(none found)"`, `"(reference needed)"`,
`"(unknown)"`, `"(none)"`) are byte-exact and matched literally by
`lib/constants.ts`. The four `Gene` list-columns are always JSON arrays.
`tests/data_contract_test.ts` asserts both against the raw committed JSON and is
the cross-language guardrail for the port.
