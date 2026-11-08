---
paths:
  - "pipeline/database.py"
  - "pipeline/data_merger.py"
  - "pipeline/export/tables.py"
  - "scripts/reset_to_baseline.py"
  - "tests/pipeline/test_database.py"
  - "tests/pipeline/test_database_integration.py"
  - "tests/pipeline/test_data_merger.py"
  - "tests/pipeline/export/test_tables.py"
  - "tests/pipeline/csvd/test_csvd_data_merger.py"
  - "tests/pipeline/test_reset_to_baseline_integration.py"
  - "tests/scripts/test_reset_to_baseline.py"
---

# Gene merge: the `source_quote` and `confidence` columns, and placeholders

**The two columns are filled as one pair, or not at all.** A confidence scores
the sentence it was extracted with, so `merge_genes_transactional` guards both
on the same predicate -- the stored quote being absent and this extraction
carrying one -- in the `UPDATE` and in the `ON CONFLICT` branch alike. Filling
them independently (two `COALESCE`s, as they were) would put the next paper's
score beside this paper's sentence the first time a run touched a row that
carries a quote and no confidence: a number describing an extraction the reader
cannot see. The consequence is that such a row is **not** backfilled by a run;
its score has to be read off the log of the run that produced its quote and
written by hand, or left null.

`NOTCH3` and `COL4A1/2` were the two such rows, and on 2026-09-02 they were
resolved differently, which is the rule working. `NOTCH3` was set to 0.9 by
hand, because run 7's stored report carried that score for PMID 42650130 beside
the byte-identical quote; `COL4A1/2` was left null, because the run that quoted
PMID 42437605 had been pruned and re-extracting the paper would have put a
_different_ extraction's number beside that sentence. Neither stands now. On
2026-11-03 the table was reset to its curated 31 August baseline, which carries
no quote and no confidence (`scripts/reset_to_baseline.py` refuses a baseline
row that does), and the 730-day re-extraction under Opus 5.5 filled each pair
from one extraction: `NOTCH3` with PMID 41895274's sentence at 1.0, `COL4A1/2`
with PMID 42607872's at 0.95. No pair in the table was written by hand.
`tests/pipeline/test_database_integration.py` merges the pair both ways round
against a real database.

**A gene the pipeline admits carries two placeholders, and the export
sentinels only the band.** `_build_combined_gene_data` stores `chromosomal_location`
as `""` -- nothing in `pipeline/` derives a cytogenetic band, the curators write
it -- and stores the gene symbol in `protein` when no paper named a protein.
`clean_gene_row` fills the first with `"(unknown)"`, because a string-typed,
sentinel-typed column publishing JSON `null` fails `tests/data_contract_test.ts`
and `lib/data/genes.ts` would rewrite it to `"(unknown)"` at runtime anyway,
hiding the gap instead of reporting it; the phenogram then lists the gene as
unplaced rather than guessing a band. The second it publishes as stored.
It used to map a protein equal to the gene symbol to `"(unknown)"`, the test
both write paths in `pipeline/database.py` still use to decide the protein is
missing; it stopped when the curated gold table became the published data,
because gold names most proteins by their gene symbol and gold is published
verbatim. A gene a run admits with no protein named therefore shows its symbol
in the Protein column until a later run fills it.
