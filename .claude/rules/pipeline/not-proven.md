---
paths:
  - "pipeline/data_merger.py"
  - "pipeline/config.py"
  - "pipeline/llm_extraction.py"
  - "disease/pipeline.json"
  - "tests/pipeline/test_data_merger.py"
  - "tests/pipeline/csvd/test_extraction_golden.py"
  - "tests/pipeline/csvd/test_query_recall.py"
  - "tests/pipeline/test_config.py"
  - "tests/pipeline/csvd/test_csvd_data_merger.py"
  - "tests/pipeline/test_llm_extraction.py"
---

# What is not proven

Retrieval recall and extraction recall are both measured and pinned.
`tests/pipeline/csvd/test_query_recall.py` intersects `SVD_QUERY` with a gold
set of 183 PMIDs, every one the dashboard cites among them (178 retrieved; the
five misses and the reason for each are in `_MISSED`, and the anchor-only and
MeSH-branch figures are pinned so widening a term list in the belief that it
helps recall fails loudly). `tests/pipeline/csvd/test_extraction_golden.py`
replays ten cassettes and asserts recall over the gold genes a paper's retrieved
text actually names, reported apart for the 13 gold genes the prompt itself
names -- **quote the clean 85%, not the pooled 87%** (prompt v8, re-recorded
2026-11-11; the three v8 recordings before it measured a clean 81% and a pooled
85% to 87%, and v7 81% and 85% -- one or two genes the prompt never names come
and go between recordings with nothing changed, so the clean figure is 81% to
85%, not a point). Its `_RECALL_BASELINE` is raised when the prompt is widened,
never to turn a red run green; three floors came down with the move to Opus 5.5,
to what that re-record measured, and the module records the genes they lost.
Every one of those was a gene Opus 5 reported below the update floor, bar one:
scored after the floor, Opus 5 and Opus 5.5 recover 38/46 and 39/46. An effort
arm is measured with `--golden-effort=<level>`, which records into
`cassettes/test_extraction_golden-<level>/` beside the baseline, skips the
floors and prints one summary line scored by the same code (the module
docstring has the commands); replayed over a copy of the baseline as `high` it
reproduced pooled 40/46, clean 22/26, 133/133 verbatim and $2.58. An arm that
is not an effort level -- a prompt revision -- takes `--golden-label=<name>`
instead (directory `-<name>`, at `--golden-effort`'s level or the default); a
label that is an effort level is refused without that effort, so `-high` always
holds `high`. `--golden-fallback`, with a label only, sends each paper straight
to the fallback model, checks the cassettes against that direct request and
scores only answers the fallback model gave. A copy of `-high` replayed as
`--golden-label=check` printed the same figures. What neither proves:

- **Precision, anywhere.** The gold standard is a curated table, not a per-paper
  answer key, so a gene absent from it is unreviewed rather than wrong (the
  recorded cassette holds 43 genes against 17 gold rows on PMID 37069360,
  missing the one not in the retrieved text and FOXF2, which that text names
  only in a GWAS table row); precision is reported, never asserted. The MeSH
  branch of `SVD_QUERY` is likewise a volume argument, and nothing says what
  fraction of the extra papers a year is signal.
- **The Docling PDF path.** No golden fixture takes it -- all 22 gold PMIDs
  resolve through Europe PMC or an abstract.
- **Negative cases.** Every gold row reports at least one gene, and inventing
  one is an editorial act.
- **What survives the gates.** `extract_from_paper` is pre-gate, so the harness
  measures raw extraction, not what clears the confidence floors and NCBI
  validation.

**The confidence floor is two numbers.** `confidence_threshold_update` (0.45)
and `confidence_threshold_insert` (0.65) decide two things with opposite risk
profiles: adding a reference to a gene already in the table is cheap, reversible
and visible in `git diff data/`, while creating a _new_ row is a scientific
claim in a published dataset. The update floor was swept post-hoc over the
committed cassettes; 0.45 is the highest floor that still recovers every
reachable gold gene the model finds, and the old single 0.65 sat on the mode of
the confidence distribution (30 extractions score exactly 0.60) and discarded
seven of them. `test_the_update_floor_is_set_where_gold_recall_saturates` in
`tests/pipeline/csvd/test_extraction_golden.py` prints the whole sweep when it
fails. **The insert floor is deliberately not swept**, and stays at 0.65 as a
curation policy: the gold standard cannot tell an incorrect new gene from an
unreviewed one, so a number tuned against it would look measured without being
so -- the confound that keeps precision unasserted above.

Three consequences of the split are load-bearing. **The permissive floor buys a
citation, and nothing else**: `_citation_only` in `pipeline/data_merger.py`
empties `mendelian_randomization`, the trait list and the omics list on any
update below the insert floor, because all three are OR-accumulated or
append-only and no later run can withdraw them; the PMID, `source_quote` and
`confidence` still land. **The gate runs during validation**, before the merge
learns which genes are new, so the permissive floor stays at the gate and the
strict one is applied at the insert/update split in `data_merger.py`; a gene
held there loses the PMID that proposed it (accepted rather than fixed --
`gene_references` has no row to hang it on), is listed first in `rejectedGenes`
as "Held below the insert floor", and raises a `merging_database` warning. And
**the row publishes the entry the floor was decided on**: `deciding_entry`
supplies both `confidence` and `source_quote`, so the number a reader checks
against the floor and the evidence beside it are one extraction.
