# The cSVD regression tests

This tree holds the Deno tests that name cSVD content or pin a number only the
committed cSVD data produces: 114 placed genes on 22 chromosomes, CENPF's row,
HTRA1's CARASIL identifiers, the radar's four sectors and 21 empty cells, the
PubMed citation of PMID 37063705, and that the tables publish exactly the gold
CSVs' genes and trials. `main` keeps them because they are the recorded method;
everything outside this tree holds for any disease and passes on
`deno task data:empty`.

A repository generated for another disease deletes the four trees in one go:

```bash
git rm -r tests/csvd e2e/tests/csvd tests/pipeline/csvd tests/scripts/csvd
```
