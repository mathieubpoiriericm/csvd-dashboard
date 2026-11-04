---
paths:
  - "pipeline/export/**"
  - "tests/pipeline/export/**"
  - "lib/types.ts"
  - "lib/data.ts"
  - "lib/data/**"
  - "lib/constants.ts"
  - "islands/GenesView.tsx"
  - "islands/TrialsView.tsx"
  - "tests/data_contract_test.ts"
  - "tests/annotations_test.ts"
---

# The JSON contract

The key derivation and the layers that move with it are in the root `CLAUDE.md`,
"The JSON contract".

Two invariants the TypeScript side depends on:

1. **List-columns are always arrays.** Python lists serialise as JSON arrays
   unconditionally, so `write_rows()` needs no equivalent of R's `I()` wrapping
   — the single-element-vector unboxing it guarded against isn't possible here.
   Four `Gene` fields are always arrays. Three of them -- `gwasTrait`,
   `linkToMonogenicDisease` and `references` -- are read one row per value from
   the join tables (see "Gene lists" below) and never parsed;
   `evidenceFromOtherOmicsStudies` is still split out of prose by
   `clean_omics_value` in `pipeline/export/tables.py` -- on commas outside
   parentheses, because the extraction writes free-text elements such as
   `Proteomics (plasma, CSF)` and a split inside one left an entry no filter
   could reach. **That column is the one place the export enforces a vocabulary
   of its own**: nothing upstream constrains `omics_evidence` (the prompt only
   _suggests_ labels, so `colocalization` or `MAGMA` can arrive as free text),
   so `_OMICS_TYPES` — mirrored from `OMICS_CHOICES` in `lib/constants.ts` and
   reconciled against it by a test — is what keeps every published element
   selectable. An element carrying its detail in parentheses is rewritten to the
   wire form `Proteomics;plasma, CSF`, which keeps the detail and makes the type
   reachable; one whose leading type is outside the vocabulary is dropped and
   logged per gene, the disposition an untracked GWAS trait already gets.
   `GeneAnnotation` adds two more, `omimSeries` and `relatedXrefs`, which are
   the one place a list normalizes to **empty** rather than to a sentinel entry:
   most diseases have no related concept at all, and `textList`'s fallback would
   render as though it were an identifier. `lib/data/annotations.ts` carries its
   own `textArray` and `relatedXrefs` normalizers for that reason.
   `relatedXrefs` is also the only array of objects in the wire format, and
   `sourceVersions` the only object; `write_rows` camelCases top-level keys
   only, so `relatedXrefs`' `id` / `relation` and `sourceVersions`' source keys
   are all written verbatim.

   **`sourceVersions` is keyed by source, and that is a correction rather than a
   flourish.** A published row is assembled from ClinVar and Orphadata, which
   version themselves separately, so the single `sourceVersion` it used to carry
   could only ever name one of them — and it named whichever was read last,
   which `ORDER BY … source` makes Orphadata: 63 of the 111 rows were stamped
   with an Orphadata release date that said nothing about the ClinVar rows
   beside it. A key present with a `null` value means that source contributed
   rows and publishes no version of its own, which is ClinVar today; the shape
   therefore says which sources were read as well as when.
2. **Sentinel strings are load-bearing**: the root `CLAUDE.md`, "The JSON
   contract", states the rule and why.

`tests/data_contract_test.ts` checks both invariants against the raw committed
JSON, and `tests/annotations_test.ts` does the same for
`data/gene_annotations.json` — plus the one contract only it has: an identifier
published in `omimId`, `mondoId`, `orphacode` or `medgenId` never also appears
in the two cross-reference lists. `lib/data.ts` also normalizes text at the
public boundary so an older or partially generated file cannot crash or silently
poison the UI.

## Export files and queries

Moved from the root `CLAUDE.md`, which keeps a one-line summary of each.

- **`data/gene_annotations.json` is the only file whose rows are a pivot rather
  than a table dump**: one row per `(gene, disease)` rather than one per
  cross-reference, because the `gene_annotations` table `--sync-annotations`
  fills (see `pipeline/CLAUDE.md`) held ~7,700 rows on 2026-09-24, and any
  island that imports this file bundles it. None does yet — its readers are
  `scripts/reconcile_omim.py`, the contract tests and the `lib/data.ts` barrel.
  Only ClinVar's attested diseases and Orphanet's enrichment of them are
  published; Open Targets' ranked associations and GO terms stay in PostgreSQL,
  where a query that wants them can reach them. **`relatedXrefs` is not a list
  of more identifiers for the row's disease** — each entry names a _different_
  concept and carries the relation its source reported, verbatim and never
  invented. Merging one into `omimId` would publish a different disease's OMIM
  number as this gene's, which is the error the annotations exist to remove.
  `omimSeries` is separate for the same reason: a phenotypic series names a
  group of phenotypes, so `omimByNumber` can never resolve one. It is also the
  one export file that is **skipped rather than emptied** when its table has no
  rows, because only `--sync-annotations` fills it and `[]` would otherwise
  publish over the committed file atomically. Only a genuinely empty read
  reaches that rule: `read_disease_annotations` tolerates a missing table and
  nothing else, so a renamed column or a revoked `SELECT` fails the export
  rather than freezing the file at its last good read.
- **JSON output is byte-exact, and every exported file is gated on it.**
  `tests/pipeline/export/test_writer.py` parses each `data/*.json`, re-encodes
  it through the writer and compares the bytes; a companion test fails if a file
  appears in `data/` with no case, so the gate cannot quietly cover less than
  the directory. `data/cytobands_hg38.json` is the one exception, and is listed
  as such: it is not the export's output but `scripts/fetch_cytobands.py`'s, and
  `deno fmt --check .` is what gates its formatting. It needs no database and
  runs in milliseconds. This is what catches a formatting divergence before it
  turns the first regeneration into an unreviewable whole-file diff — the way
  the missing `</` → `<\/` escaping (jsonlite escapes a slash only after `<`;
  `json.dumps` never does) would have rewritten every row of `refs.json`.
  `json.loads()`-equality sees none of this.
- **Every export query needs an `ORDER BY`.** Without one PostgreSQL returns
  rows in whatever physical order it likes, so the byte-exact contract above
  cannot hold across runs. One unordered `SELECT * FROM clinical_trials`
  reordered `gene_info_table2.json` too, because `split_genetic_targets()` feeds
  the lookup request lists and `complete_lookup()` restores _request_ order.
  `_read_table` orders by `id`; the lookups inherit determinism from it.
  `_read_genes_with_lists` needs **two** -- `genes` by `id`, and each join table
  by `(gene_id, ordinal)`, because the within-gene order reaches the JSON array
  as well. `read_disease_annotations` orders by
  `(gene_symbol, group_key, source, object_id)`, and the `source` term is
  load-bearing beyond determinism: it puts ClinVar's rows before Orphadata's,
  which is what lets an exact Orphanet mapping fill only a column ClinVar left
  empty.
- **`data/table2.json` publishes only curated trial rows.** `--clinical-trials`
  writes ClinicalTrials.gov discoveries into the same table, with every curator
  column NULL; `_read_curated_trials` in `pipeline/export/main.py` skips any row
  with no `target_population` and logs the count, so a discovery no one has read
  cannot reach the dashboard as `(unknown)` mechanism, population and evidence —
  values no filter choice offers and the radar draws nowhere. See
  "ClinicalTrials.gov rows must read like the curated ones" in
  `pipeline/CLAUDE.md`.
- Facility coordinates come from ClinicalTrials.gov's `geoPoint`, which is
  computed as `GeoPoint(City, State, Country)` — city-level, not facility-level.
  `jitter_duplicate_coordinates()` fans out co-located sites. No geocoding
  service is involved. A site with no `geoPoint` is dropped rather than
  defaulted — a marker at (0, 0) is worse than no marker — and both that drop
  and a trial that ends up contributing no marker at all are logged by name: the
  trial is still in `nctIds`, and `tests/data_contract_test.ts` compares only
  that set, so nothing else would say the map is missing it.
