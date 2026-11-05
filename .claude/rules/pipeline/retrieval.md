---
paths:
  - "pipeline/query_eval.py"
  - "pipeline/pubmed_search.py"
  - "pipeline/pdf_retrieval.py"
  - "scripts/measure_recall.py"
  - "disease/recall_gold.csv"
  - "disease/recall_baseline.json"
  - "tests/pipeline/test_query_eval.py"
  - "tests/pipeline/test_query_recall_gold.py"
  - "tests/pipeline/test_pubmed_search.py"
  - "tests/pipeline/csvd/test_query_recall.py"
  - "tests/scripts/test_measure_recall.py"
---

# Retrieval

**The query's recall is measured by a harness that knows no disease.**
`pipeline/query_eval.py` reads `disease/recall_gold.csv` (`pmid,note`, one paper
the query is expected to retrieve per row), unions it with the PMIDs
`data/table1.json` cites and, when the gitignored gold-standard CSV is present,
the golden suite's papers, and intersects `SVD_QUERY` with a `[uid]` disjunction
over the set — exact, and never near the 9,999-record `esearch` cap because the
result can never exceed the gold set. `uv run python -m scripts.measure_recall`
runs it, and `--write-baseline` records the figure in
`disease/recall_baseline.json`; the baseline it writes carries the query's
sha256, so it says which query it measured, and the replay test skips, with a
reason, when the gold file is empty or no baseline is recorded — which is where
a fork starts. The cSVD-specific recall suite, with its five pinned misses and
the per-branch figures, is `tests/pipeline/csvd/test_query_recall.py`.

The traps in what reaches the model -- esearch paging, PMC's "does not allow
downloading" notice, DOIs read from the wrong list, JATS tables and
floats-groups, back-matter headings, Unpaywall preprints, Docling
`PARTIAL_SUCCESS` -- and what each looks like in the run log are in the
`debug-paper-retrieval` skill (`.claude/skills/debug-paper-retrieval/SKILL.md`).

A short `--days-back` window is mostly an abstract-only run: papers added to
PubMed in the last week are largely not yet in Europe PMC's open-access set, so
`fulltextRetrieved` runs low. The window is over the Entrez date (`edat`), the
day the record entered PubMed, not the publication date: a paper indexed a
fortnight after it was published falls in the `edat` window of the run that
follows, while under `pdat` it fell between two windows and was never seen. That
is what the number means, not a fault to fix.

In a short window most full text comes from PMC rather than Europe PMC, because
Europe PMC indexes the OA subset days later. Nine `source: "pmc"` papers with
zero genes in one run were re-processed on suspicion of the "does not allow
downloading" notice and all nine were real articles that name no cSVD gene -- a
`pmc` source with zero genes is not evidence of the stub. The guard's log line
("PMC holds this article but does not serve its full text") is.
