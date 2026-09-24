---
paths:
  - "pipeline/export/**"
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

`pipeline/export/writer.py`'s `to_camel()` derives JSON keys from display column
names, which themselves come from `pipeline/export/text.py`'s
`clean_column_name()` applied to each database column name. `"Registry ID"` →
`registryId`. Keep these layers in sync:

| Concern               | Lives in                                 |
| --------------------- | ---------------------------------------- |
| Wire keys             | `pipeline/export/writer.py` (`to_camel`) |
| TypeScript shapes     | `lib/types.ts`                           |
| Human-readable labels | `islands/*View.tsx` column definitions   |

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
2. **Sentinel strings are load-bearing.** Absent values become `"(none found)"`,
   `"(unknown)"`, `"(none)"` and are matched literally by the filter choices in
   `lib/constants.ts`. Those choice `value`s must stay byte-identical to what
   `pipeline/export/tables.py` emits.

`tests/data_contract_test.ts` checks both invariants against the raw committed
JSON, and `tests/annotations_test.ts` does the same for
`data/gene_annotations.json` — plus the one contract only it has: an identifier
published in `omimId`, `mondoId`, `orphacode` or `medgenId` never also appears
in the two cross-reference lists. `lib/data.ts` also normalizes text at the
public boundary so an older or partially generated file cannot crash or silently
poison the UI.
