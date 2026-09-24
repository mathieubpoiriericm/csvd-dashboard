---
paths:
  - "pipeline/export/main.py"
  - "pipeline/export/tables.py"
  - "pipeline/database.py"
  - "pipeline/data_merger.py"
  - "scripts/backfill_gene_lists.py"
  - "tests/pipeline/export/test_export_main.py"
---

# Gene lists

Three `genes` columns held delimited lists inside TEXT until migration 005 moved
them into join tables -- `gene_references(gene_id, ordinal, pmid)`,
`gene_gwas_traits(… trait)`, `gene_monogenic_links(… omim_id)` -- and 006
dropped the columns. `references` had already been destroyed once by a
spreadsheet round-trip that read the whole PMID list as one number; one value
per row makes that impossible rather than merely detectable.

Three things about the arrangement are load-bearing:

- **`_GENE_COLUMNS` in `pipeline/export/main.py` is what holds the JSON key
  order.** `clean_gene_row` derives its output order from the incoming row, so a
  `SELECT *` would drop the three names from the projection and
  `published.update()` would re-append them at the _end_ of every row. They are
  named in the projection and selected as `NULL` placeholders instead, which
  holds their position and makes the reader behave identically either side of
  the drop. `tests/pipeline/export/test_export_main.py` pins the constant
  against the committed `data/table1.json`.
- **Sentinels are never stored.** `"(none found)"` and `"(reference needed)"`
  are produced by `clean_gene_row` from an empty list or a `NULL` placeholder. A
  gene with no references gets zero rows. `split_gwas_traits` routes through
  `fill_missing_text` for the same reason in the other direction, so a stored
  `"NA"` cannot become the trait `"NA"`. **Untracked traits are never stored
  either.** The extraction schema admits the vocabulary's `untracked` terms so
  the model can name a phenotype the dashboard does not carry, and
  `_build_combined_gene_data` in `pipeline/data_merger.py` is where they are
  dropped -- logged per gene, so the signal survives in the run log. Nothing
  used to drop them, and `ICH-non-lobar` was one merge away from
  `data/table1.json`, where no filter choice or phenogram pill exists for it.
  `clean_gene_row` applies the same disposition on the way out, plus the
  `synonyms` fold, so a row stored before the merge learned to cannot publish
  one.
- **`_append_gene_list_sql` in `pipeline/database.py` carries the merge
  invariants the delimited strings used to.** `NOT EXISTS` makes a re-run write
  nothing, `MAX(ordinal) + 1` continues the ordinals off the pre-statement
  snapshot, and `GROUP BY btrim(value)` with `MIN(ord)` collapses in-batch
  duplicates onto their first position -- what
  `string_agg(… ORDER BY
  first_ord)` did. `evidence_from_other_omics_studies`
  is deliberately _not_ normalized: `clean_omics_value` coerces free-text prose
  into a list, so what counts as one entry is a curation judgment.

`scripts/backfill_gene_lists.py` populated the tables from the old columns using
the export's own parsers. It is run as a module
(`uv run python -m scripts.backfill_gene_lists`), not as a path, and on a
database past migration 006 it exits with a message rather than failing on the
first `SELECT`: the columns it reads are gone, so there is nothing to backfill.
