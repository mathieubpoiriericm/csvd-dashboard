# Pipeline

Guidance for `pipeline/` and `tests/pipeline/`. The repo-wide contracts — the
JSON wire format, the filtering rules, the islands and the two figures — stay in
the root `CLAUDE.md`.

The pipeline's notes are path-scoped rules under `.claude/rules/pipeline/`. Each
loads when Claude reads or edits a file its `paths:` names; open one directly
when a task spans topics or touches a module none of them names.

| Rule              | Covers                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `extraction`      | pinned model and prompt version, thinking and effort, the trait enum, overload and `httpx2` retries, the effort sweep, the v7 template |
| `fallback`        | refusals and their classifier, the Opus 4.8 fallback and its cost accounting, keeping the batch path in step                           |
| `provenance`      | the two quote checks, why the tool is not `strict`, the verbatim gate, the reasoning trace                                             |
| `run-reporting`   | the two reports, per-step warnings, error classification, failed runs, the accounting decisions, quote counts                          |
| `syncs`           | refresh records, `--sync-annotations` as its own mode, the band cache                                                                  |
| `ncbi-rate`       | spacing E-utilities requests, counting retries                                                                                         |
| `api-telemetry`   | the service list and what stays out of it                                                                                              |
| `pdf`             | Docling, OCR, page limits, `ImportError`, lazy imports on 3.15                                                                         |
| `retrieval`       | the recall harness, the `edat` window, PMC papers with no genes                                                                        |
| `not-proven`      | what the recall tests pin and what they can't, the two confidence floors                                                               |
| `clinical-trials` | the condition gate, retries, curator-owned columns, the population re-curation                                                         |
| `gene-merge`      | quote and confidence written as one pair, placeholders on newly admitted genes                                                         |
| `database-tests`  | test isolation from production credentials, `database_env`, `CSVD_TEST_DB_URL`, one database per xdist worker                          |
| `long-windows`    | the preview flags, the token reservation, the pointer to `run-long-window`                                                             |
| `migrations`      | revision 009's collision, Alembic rather than Atlas                                                                                    |

`.claude/rules/json-contract.md` also carries how the provenance columns are
published and why the export's readers tolerate migration lag and nothing else;
`.claude/rules/gene-lists.md` carries the recovery of the ten corrupted
`genes.references` cells.

A new note goes in the rule whose `paths:` cover the code it warns about; a new
topic gets its own rule and a row here.
