# Biomedical Annotation APIs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the 63 curated genes machine-fetched disease, ontology and
identity annotations from ClinVar, Orphadata and Open Targets — stored in their
own tables, never written into the curated `genes` row — and verify Table 2's
curator-entered mechanisms against Open Targets. Nothing is published until the
final task, which is gated on review.

**The finding that motivates this plan.** Three of the columns this dashboard
publishes are joined by string matching against hand-maintained files, and one
of those files is corrupt in a way the repo already documents.
`link_to_monogenetic_disease` is free `TEXT`, mined at export by
`_OMIM_ID = re.compile(r"\b\d{6}\b")` (`pipeline/export/tables.py:24`) and
joined in the browser against `pipeline/export/data/omim_info.csv` — 49 rows,
**Mac Roman encoded**, 9 columns of which `pipeline/export/omim.py:13-20` reads
6. ClinVar returns the same OMIM number as a typed field, beside MONDO, Orphanet
and MedGen, with clinical significance and review status attached.

| Signal                                 | Today                             | Available                            |
| -------------------------------------- | --------------------------------- | ------------------------------------ |
| OMIM id for a gene's monogenic disease | `\b\d{6}\b` over curator prose    | ClinVar `trait_xrefs[].db_id`, typed |
| MONDO / Orphanet / MedGen ids          | absent                            | ClinVar, same field                  |
| Mapping precision (exact vs narrower)  | absent                            | Orphadata `DisorderMappingRelation`  |
| Gene → Ensembl / HGNC anchor           | absent (bare symbols)             | Open Targets `search` + `dbXrefs`    |
| GO accession + evidence code + PMID    | **discarded** by `_clean_go_term` | Open Targets `geneOntology`          |
| Trial mechanism-of-action              | curator prose, unverified         | Open Targets `mechanismsOfAction`    |

**Architecture:** Eight tasks. Task 1 is a pure identifier normaliser; Task 2 is
the migration and the database layer; Tasks 3–6 are one API client each, all
writing the same row shape; Task 7 wires them into the existing
`sync_all_external_data` orchestrator; Task 8 publishes, and is the only task
that changes `data/`. Tasks 1–7 leave `git diff data/` empty. The curated
`genes` table is never written by any of them.

**Tech Stack:** unchanged — Python 3.14, uv, ruff, ty, pytest, pytest-mock,
asyncpg, alembic, httpx; Deno 2 / Fresh 2 on the consumer side (Task 8 only). No
new runtime dependency: all three APIs are plain HTTP over the `httpx` already
pinned, and Open Targets' GraphQL is a POST with a JSON body, not a client
library.

**Spec:** none separate. This plan argues from the live API probes recorded in
each task below (all run 2026-08-31 against the production endpoints), from
CLAUDE.md's "The JSON contract" and "Known data limitation" sections, and from
the disposition recorded under "Out of scope, deliberately" in the GWAS-trait
vocabulary plan, which ranked these three **ClinVar › Open Targets › Orphadata**
and deferred them to exactly this follow-on.

---

## Context

The GWAS-trait vocabulary work evaluated five biomedical APIs and adopted none,
by explicit decision — the scope then was a single source of truth for the trait
axis, and ClinVar/Orphadata/Open Targets are disease and target resources that
say nothing about PSMD, NODDI or the PVS subtypes. That reasoning still holds:
**this plan does not touch `lib/vocabulary.json` or the trait axis.** What it
addresses is the different column the earlier evaluation identified — the
monogenic-disease link and the identifiers around it.

The intended outcome is that a gene's disease associations stop being prose
matched by regex and become typed, sourced, versioned rows that can be
regenerated, diffed and cited; that Table 2's mechanisms have an independent
check; and that the curated table is provably untouched throughout, so a
reviewer can adopt the machine annotations column by column rather than all at
once.

Three decisions were taken before writing this plan and are not revisited here:
storage is a **new set of tables**, not new columns on `genes`; publication is
**deferred to a final gated task**; and Open Targets is used for **all three**
of disease associations, identity anchoring, GO terms and drug mechanisms.

---

## Global Constraints

- **The curated `genes` table is never written.** No task issues `INSERT`,
  `UPDATE` or `ALTER` against `genes`. `pipeline/data_merger.py` and
  `merge_genes_transactional` are not touched. A curator value can be _compared_
  against a fetched one (Task 8 does), never overwritten.
- **`git diff data/` must be empty after every task except Task 8.** The
  byte-exact gate (`tests/pipeline/export/test_writer.py:324-355`) re-encodes
  every `data/*.json` through the writer and compares bytes; a hand-edited file
  fails it. Task 8 regenerates through `deno task data`.
- **`pipeline/export/main.py:51-52` allowlists `{"genes", "clinical_trials"}`.**
  A new table is invisible to `_read_table` until that set is edited, which is
  what keeps Tasks 1–7 unpublished with no `_UNPUBLISHED_COLUMNS` entry needed.
- **Python coverage floor is 99.5%** line+branch over `pipeline/` **and**
  `pipeline/alembic/` (`pyproject.toml:125-132`,
  `.github/workflows/ci.yml:62-68`). Every new branch needs a covering test, and
  every new migration needs a parametrize tuple in
  `tests/pipeline/test_alembic_migrations.py:15-20`.
- **`lib/` requires 100% coverage** (`deno.json:9`,
  `--include='/lib/' --threshold=100`). Task 8 only.
- **No live network in tests.** Every existing HTTP test patches
  `<module>._client_manager.get` with an `AsyncMock` returning a real
  `httpx.Response` (`tests/pipeline/test_uniprot_fetch.py:79-93`). Follow that;
  do not add `responses`, `respx` or a VCR cassette — cassettes here are for the
  Anthropic path only.
- **Every new module-global client and cache needs an autouse reset fixture** in
  `tests/pipeline/conftest.py`, following `_reset_uniprot_client`
  (`conftest.py:348-359`). Without it, cache state leaks between tests.
- **Ordering is deterministic everywhere.** Rows are sorted before they are
  written, as `ORDER BY id` is load-bearing in the export
  (`pipeline/export/main.py:54-60`). Rank ties break on a stable string key.
- **Attribution is a licence obligation, not a courtesy.** Orphadata returns
  `"__licence": {"identifier": "CC-BY-4.0"}` in every payload. Task 8 adds the
  attribution block; do not publish Orphadata-derived values without it.

---

## Out of Scope, Deliberately

- **The GWAS trait vocabulary is untouched.** `lib/vocabulary.json`,
  `GWAS_TRAIT_CHOICES`, both phenogram renderers and
  `tests/pipeline/test_prompt_vocabulary.py` are not edited. These three APIs
  are disease/target resources; six of the sixteen traits match nothing in any
  of the ~250 ontologies OLS4 indexes, and that finding is unchanged.
- **`pipeline/export/data/omim_info.csv` is not deleted.** Task 8 publishes the
  fetched annotations _beside_ it and emits a reconciliation report; retiring
  the curated CSV is a curation decision that needs the report in hand first.
  The Mac Roman decode at `pipeline/export/omim.py:27` stays.
- **HPO / hpo3 and the Gene Ontology REST API are not added.** HPO content
  arrives through Orphadata's `rd-phenotypes` endpoint at no dependency cost,
  and GO arrives through Open Targets with the evidence codes and PMIDs that
  `_clean_go_term` (`pipeline/uniprot_fetch.py:103-116`) discards. Neither earns
  its own client.
- **`_clean_go_term` is not changed.** Retaining the `[GO:0006915]` accession in
  the UniProt path is a good idea and a separate one; doing it here would mean
  two sources writing GO into two places in one plan.
- **No extraction-prompt or LLM change.** `pipeline/prompts.py`,
  `pipeline/anthropic_client.py` and the cassettes are untouched.
- **Open Targets `drugAndClinicalCandidates` is not queried.** It replaced
  `knownDrugs`, its row type is `ClinicalTargetFromTarget`, it takes no `size`
  argument and carries no `phase`/`status`/`drugType`. Task 6 needs only
  `Drug.mechanismsOfAction`, which is stable and verified.

---

## File Structure

| File                                                         | Responsibility                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `pipeline/xrefs.py`                                          | **Create.** Canonical `PREFIX:LOCALID` identifiers; the one place the three sources' three spellings are reconciled.                 |
| `pipeline/annotations.py`                                    | **Create.** `AnnotationRow` / `AnnotationStatus` — the row contract every client emits and the database layer consumes.              |
| `pipeline/alembic/versions/<next>_add_gene_annotations.py`   | **Create.** Three tables: `gene_annotations`, `gene_annotation_status`, `trial_drug_annotations`.                                    |
| `pipeline/database.py`                                       | **Modify.** Upsert/read accessors for the three tables, following `get_cached_uniprot_info` / `upsert_uniprot_batch` (`:566-655`).   |
| `pipeline/clinvar_fetch.py`                                  | **Create.** Gene → monogenic diseases, over the existing E-utilities.                                                                |
| `pipeline/orphadata_fetch.py`                                | **Create.** ORPHAcode → cross-references with mapping qualifiers, and HPO terms with frequency.                                      |
| `pipeline/opentargets_fetch.py`                              | **Create.** GraphQL transport + gene identity, disease associations with scores, GO terms.                                           |
| `pipeline/opentargets_drugs.py`                              | **Create.** Trial drug → ChEMBL mechanism of action and target symbols.                                                              |
| `pipeline/config.py`                                         | **Modify.** Rate limits, record caps, the pinned Open Targets data version.                                                          |
| `pipeline/external_data_sync.py`                             | **Modify.** Steps 5–8 of `sync_all_external_data`, plus the result counters.                                                         |
| `pipeline/main.py`                                           | **Modify.** `--sync-annotations` CLI flag beside `--sync-external-data`.                                                             |
| `.env.example`                                               | **Modify.** The six new `PIPELINE_*` variables, beside the ones already documented there.                                            |
| `tests/pipeline/conftest.py`                                 | **Modify.** Three autouse client/cache reset fixtures.                                                                               |
| `pipeline/CLAUDE.md`                                         | **Modify, Task 7.** The four clients, the three tables and the ClinVar→Orphadata ordering. Pipeline notes live here since `7efc974`. |
| `CLAUDE.md`                                                  | **Modify, Task 8.** The ninth export file, in the JSON-contract section.                                                             |
| `pipeline/export/lookups.py`, `pipeline/export/main.py`      | **Modify, Task 8 only.** Read the annotations into a ninth export file.                                                              |
| `lib/types.ts`, `lib/data/annotations.ts`, `lib/tooltips.ts` | **Task 8 only.** Wire key types and the tooltip lookup.                                                                              |
| `routes/index.tsx`                                           | **Task 8 only.** The data-source attribution block CC-BY-4.0 requires.                                                               |

---

### Task 1: Reconcile the three sources' identifier spellings

**Files:**

- Create: `pipeline/xrefs.py`
- Test: `tests/pipeline/test_xrefs.py`

**Interfaces:**

- Consumes: nothing. Pure functions, no I/O, no config.
- Produces: `canonical_xref(source: str, reference: str) -> str | None` and
  `canonical_from_compact(identifier: str) -> str | None`, both returning
  `"PREFIX:LOCALID"` or `None` for a prefix this pipeline does not store;
  `xref_prefix(xref: str) -> str` returning the part before the colon.

The three APIs spell the same identifier three ways, and this was verified
against all three on 2026-08-31:

| Source                          | CARASIL's MONDO id                           | CARASIL's ORPHAcode                      |
| ------------------------------- | -------------------------------------------- | ---------------------------------------- |
| ClinVar `trait_xrefs[]`         | `db_source="MONDO"`, `db_id="MONDO:0010829"` | `db_source="Orphanet"`, `db_id="199354"` |
| Orphadata `ExternalReference[]` | `Source="MONDO"`, `Reference="0010829"`      | — (it _is_ the ORPHAcode)                |
| Open Targets `disease.id`       | `MONDO_0010829`                              | `Orphanet_199354`                        |

So ClinVar prefixes MONDO but not Orphanet, Orphadata prefixes neither, and Open
Targets prefixes both with an underscore. Nothing cross-links until one spelling
wins. This module is that one spelling, and it exists before any client so no
client invents its own.

- [ ] **Step 1: Write the failing test**

```python
"""Canonical cross-reference identifiers."""

from pipeline.xrefs import canonical_from_compact, canonical_xref, xref_prefix


class TestCanonicalXref:
    def test_a_prefixed_reference_keeps_one_prefix(self) -> None:
        assert canonical_xref("MONDO", "MONDO:0010829") == "MONDO:0010829"

    def test_a_bare_reference_gains_its_prefix(self) -> None:
        assert canonical_xref("Orphanet", "199354") == "Orphanet:199354"
        assert canonical_xref("MONDO", "0010829") == "MONDO:0010829"

    def test_the_source_argument_wins_over_the_value(self) -> None:
        # ClinVar's db_source is the field the API guarantees; a prefix
        # inside db_id is decoration.
        assert canonical_xref("OMIM", "MIM:600142") == "OMIM:600142"

    def test_prefix_matching_is_case_insensitive_but_output_is_not(self) -> None:
        assert canonical_xref("medgen", "C6022615") == "MedGen:C6022615"
        assert canonical_xref("ORPHA", "199354") == "Orphanet:199354"

    def test_an_unstored_prefix_is_rejected_rather_than_guessed(self) -> None:
        # Orphadata returns ICD-10, ICD-11, MedDRA and GARD too. Storing an
        # identifier this pipeline cannot interpret would make the table look
        # richer than it is.
        assert canonical_xref("ICD-10", "I67.8") is None
        assert canonical_xref("GARD", "10424") is None

    def test_an_empty_reference_is_rejected(self) -> None:
        assert canonical_xref("OMIM", "") is None
        assert canonical_xref("OMIM", "   ") is None

    def test_the_identity_authorities_are_stored_too(self) -> None:
        # Open Targets' Ensembl and HGNC ids are identifiers like any other
        # and go through this module rather than being f-string-built at the
        # call site, so there is still exactly one place a spelling is decided.
        assert canonical_xref("Ensembl", "ENSG00000166033") == (
            "Ensembl:ENSG00000166033"
        )
        assert canonical_xref("HGNC", "9476") == "HGNC:9476"


class TestCanonicalFromCompact:
    def test_open_targets_underscore_form(self) -> None:
        assert canonical_from_compact("MONDO_0014768") == "MONDO:0014768"
        assert canonical_from_compact("Orphanet_199354") == "Orphanet:199354"
        assert canonical_from_compact("EFO_0000651") == "EFO:0000651"

    def test_a_token_with_no_separator_is_rejected(self) -> None:
        assert canonical_from_compact("ENSG00000166033") is None

    def test_an_unstored_prefix_is_rejected(self) -> None:
        assert canonical_from_compact("OTAR_0000018") is None


class TestXrefPrefix:
    def test_returns_the_part_before_the_colon(self) -> None:
        assert xref_prefix("MONDO:0010829") == "MONDO"
        assert xref_prefix("HP:0000708") == "HP"

    def test_a_string_with_no_colon_is_its_own_prefix(self) -> None:
        assert xref_prefix("") == ""


def test_all_three_sources_collapse_to_one_spelling_for_carasil() -> None:
    """The property this module exists for.

    These are the literal payload values recorded from the three APIs on
    2026-08-31 for CARASIL. If they do not intersect, nothing downstream can
    join a ClinVar disease to its Orphadata enrichment or its Open Targets
    score.
    """
    clinvar = {
        canonical_xref(source, value)
        for source, value in (
            ("Orphanet", "199354"),
            ("MedGen", "C6022615"),
            ("MONDO", "MONDO:0010829"),
            ("OMIM", "600142"),
        )
    }
    orphadata = {
        canonical_xref(source, value)
        for source, value in (
            ("MONDO", "0010829"),
            ("OMIM", "600142"),
            ("MeSH", "C563990"),
            ("UMLS", "C1838577"),
            ("ICD-10", "I67.8"),
        )
    }
    open_targets = {
        canonical_from_compact(value)
        for value in ("MONDO_0010829", "Orphanet_199354")
    }

    assert "MONDO:0010829" in clinvar & orphadata & open_targets
    assert "OMIM:600142" in clinvar & orphadata
    assert "Orphanet:199354" in clinvar & open_targets
    # Orphadata's ICD-10 row is dropped rather than stored uninterpreted.
    assert None in orphadata
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/pipeline/test_xrefs.py -v` Expected: FAIL —
`ModuleNotFoundError: No module named 'pipeline.xrefs'`.

- [ ] **Step 3: Write the module**

```python
"""Canonical cross-reference identifiers.

Three APIs spell the same identifier three ways. ClinVar returns
``db_source="MONDO"`` with ``db_id="MONDO:0010829"`` but ``db_source="Orphanet"``
with a bare ``199354``; Orphadata returns a bare ``0010829`` for MONDO; Open
Targets returns ``MONDO_0014768`` and ``Orphanet_199354``. Nothing cross-links
until one spelling wins, so every identifier is normalised on the way in and
only the canonical ``PREFIX:LOCALID`` form is stored.

A prefix this pipeline does not store returns ``None`` rather than a
pass-through. Orphadata alone returns GARD, ICD-10, ICD-11, MedDRA and MeSH
alongside the ones here; storing an identifier nothing can interpret would make
the annotations table look richer than it is.
"""

import re
from typing import Final

# Output capitalisation for each prefix this pipeline stores. Lookup is
# case-insensitive; the value is what gets written.
_PREFIXES: Final[dict[str, str]] = {
    "efo": "EFO",
    "ensembl": "Ensembl",
    "hgnc": "HGNC",
    "hp": "HP",
    "medgen": "MedGen",
    "mesh": "MeSH",
    "mondo": "MONDO",
    "omim": "OMIM",
    "orphanet": "Orphanet",
    "umls": "UMLS",
}

# Orphadata calls it an ORPHAcode, ClinVar's db_source is "Orphanet", and OMIM
# is "MIM" in some payloads. All three name the same authority.
_PREFIX_ALIASES: Final[dict[str, str]] = {
    "orpha": "orphanet",
    "orphacode": "orphanet",
    "mim": "omim",
}

# ClinVar separates with ":", Open Targets with "_".
_SEPARATOR: Final[re.Pattern[str]] = re.compile(r"[:_]")


def canonical_xref(source: str, reference: str) -> str | None:
    """Return ``PREFIX:LOCALID`` for one source/reference pair, or None.

    ``reference`` may already carry a prefix -- ClinVar's MONDO does, its
    Orphanet does not. Any prefix on the value is dropped and ``source`` wins,
    because that is the field the API guarantees.
    """
    key = source.strip().lower()
    key = _PREFIX_ALIASES.get(key, key)
    prefix = _PREFIXES.get(key)
    if prefix is None:
        return None
    local = _SEPARATOR.split(reference.strip(), maxsplit=1)[-1].strip()
    if not local:
        return None
    return f"{prefix}:{local}"


def canonical_from_compact(identifier: str) -> str | None:
    """Normalise a single-token identifier such as ``MONDO_0014768``.

    Open Targets returns disease IDs as one token with no separate source
    field, so the prefix has to be split back off before ``canonical_xref``
    can vet it.
    """
    parts = _SEPARATOR.split(identifier.strip(), maxsplit=1)
    if len(parts) != 2:
        return None
    return canonical_xref(parts[0], parts[1])


def xref_prefix(xref: str) -> str:
    """Return the authority of a canonical xref -- ``"MONDO"`` for MONDO:0010829."""
    return xref.split(":", 1)[0]
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `uv run pytest tests/pipeline/test_xrefs.py -v` Expected: PASS, 13 tests.

- [ ] **Step 5: Lint, type-check and confirm full branch coverage of the new
      module**

```bash
uv run ruff check pipeline/xrefs.py tests/pipeline/test_xrefs.py
uv run ty check pipeline/xrefs.py
uv run pytest tests/pipeline/test_xrefs.py --cov=pipeline.xrefs --cov-branch \
  --cov-report=term-missing
```

Expected: ruff and ty clean; coverage **100%** on `pipeline/xrefs.py` with no
missing branches. Do not run `ruff format` — the repo was never ruff-format
clean and running it rewrites unrelated files.

- [ ] **Step 6: Commit**

```bash
git add pipeline/xrefs.py tests/pipeline/test_xrefs.py
git commit -m "Reconcile the three sources' cross-reference spellings"
```

---

### Task 2: Add the annotation tables and their database layer

**Files:**

- Create: `pipeline/annotations.py`
- Create: `pipeline/alembic/versions/<next>_add_gene_annotations.py`
- Modify: `pipeline/database.py` (append after the PubMed cache section, which
  ends before `upsert_clinical_trials_batch` at `:740`)
- Modify: `tests/pipeline/test_alembic_migrations.py:15-20`
- Test: `tests/pipeline/test_annotations.py`

**Interfaces:**

- Consumes: `pipeline.xrefs.canonical_xref` (Task 1) — only in the row
  constructors' docstrings; this task stores whatever it is given.
- Produces:
  - `AnnotationRow` — frozen-shaped dataclass with fields `gene_symbol: str`,
    `source: str`, `relation: str`, `group_key: str`, `object_id: str`,
    `object_label: str | None`, `qualifier: str | None`, `score: float | None`,
    `evidence_count: int | None`, `source_version: str | None`.
  - `AnnotationStatus` — `gene_symbol: str`, `source: str`, `row_count: int`,
    `source_version: str | None`.
  - `DrugAnnotationRow` — `drug: str`, `chembl_id: str | None`,
    `action_type: str | None`, `mechanism_of_action: str | None`,
    `target_symbols: str | None`, `source_version: str | None`,
    `resolved: bool`.
  - `replace_gene_annotations(rows: list[AnnotationRow], statuses: list[AnnotationStatus]) -> int`
  - `get_annotation_statuses(gene_symbols: list[str], source: str, max_age_days: int | None = None) -> dict[str, dict[str, Any]]`
  - `read_gene_annotations(source: str | None = None) -> list[dict[str, Any]]`
  - `upsert_drug_annotations(rows: list[DrugAnnotationRow]) -> int`

**Why one edge table and not one table per source.** The three sources produce
the same _kind_ of fact — a gene, a relation, an object with an identifier, and
some provenance — in three different envelopes. A table per source would need
six tables (ClinVar diseases; Orphadata cross-references; Orphadata phenotypes;
Open Targets identity, diseases and GO terms) and every consumer would union
them anyway. One `(gene_symbol, source, relation, group_key, object_id)` edge
table holds all six with typed columns and no JSONB, which is what lets the
export read it with a plain `ORDER BY`.

`group_key` is what makes an enrichment joinable: every row describing the same
disease carries the same canonical identifier there, preferring MONDO, then
OMIM, then Orphanet, then MedGen. So ClinVar's four CARASIL xref rows,
Orphadata's MeSH and UMLS rows and its HPO phenotype rows, and Open Targets'
scored association all carry `group_key = "MONDO:0010829"` and group with one
`GROUP BY`. Rows that are not about a disease — GO terms, Ensembl and HGNC
identity — carry `''`, not `NULL`, because PostgreSQL treats `NULL` as distinct
from itself in a `UNIQUE` constraint and two identical GO rows would both
insert.

`gene_annotation_status` exists because a gene with no annotations has no rows,
which is indistinguishable from a gene never fetched. It is the TTL anchor and
the negative cache, exactly parallel to `ncbi_gene_info`'s one row per gene, and
it is what lets `DB_CACHE_TTL_DAYS` work at all here.

- [ ] **Step 1: Write the failing tests**

```python
"""The annotation row contract."""

import pytest

from pipeline.annotations import (
    AnnotationRow,
    AnnotationStatus,
    DrugAnnotationRow,
    group_key_for,
)


class TestGroupKeyFor:
    def test_prefers_mondo(self) -> None:
        assert group_key_for(
            ["OMIM:600142", "Orphanet:199354", "MONDO:0010829", "MedGen:C6022615"]
        ) == "MONDO:0010829"

    def test_falls_back_through_omim_then_orphanet_then_medgen(self) -> None:
        assert group_key_for(["OMIM:616779", "MedGen:C4225211"]) == "OMIM:616779"
        assert group_key_for(["Orphanet:482072", "MedGen:C5680099"]) == (
            "Orphanet:482072"
        )
        assert group_key_for(["MedGen:C0007774"]) == "MedGen:C0007774"

    def test_an_unrankable_set_groups_under_the_empty_string(self) -> None:
        # A GO term or an Ensembl id is not a disease and groups with nothing.
        assert group_key_for(["GO:0005515"]) == ""
        assert group_key_for([]) == ""

    def test_the_choice_is_deterministic_across_input_order(self) -> None:
        forward = group_key_for(["MONDO:0010829", "MONDO:0014768"])
        reverse = group_key_for(["MONDO:0014768", "MONDO:0010829"])
        assert forward == reverse == "MONDO:0010829"


class TestAnnotationRow:
    def test_carries_every_field_the_table_stores(self) -> None:
        row = AnnotationRow(
            gene_symbol="HTRA1",
            source="clinvar",
            relation="disease",
            group_key="MONDO:0010829",
            object_id="Orphanet:199354",
            object_label="CARASIL syndrome",
            qualifier="Pathogenic/Likely pathogenic",
            score=None,
            evidence_count=5,
            source_version=None,
        )
        assert row.gene_symbol == "HTRA1"
        assert row.evidence_count == 5

    def test_sorts_deterministically(self) -> None:
        """Rows are written in sorted order so the export stays reproducible."""
        rows = [
            AnnotationRow("HTRA1", "clinvar", "disease", "MONDO:0010829",
                          "OMIM:600142", None, None, None, None, None),
            AnnotationRow("HTRA1", "clinvar", "disease", "MONDO:0010829",
                          "MONDO:0010829", None, None, None, None, None),
        ]
        assert [r.object_id for r in sorted(rows, key=AnnotationRow.sort_key)] == [
            "MONDO:0010829",
            "OMIM:600142",
        ]


class TestAnnotationStatus:
    def test_records_a_zero_row_fetch(self) -> None:
        status = AnnotationStatus(
            gene_symbol="C6orf195", source="clinvar", row_count=0, source_version=None
        )
        assert status.row_count == 0


class TestDrugAnnotationRow:
    def test_records_an_unresolved_drug(self) -> None:
        row = DrugAnnotationRow(
            drug="THN391",
            chembl_id=None,
            action_type=None,
            mechanism_of_action=None,
            target_symbols=None,
            source_version="26.06",
            resolved=False,
        )
        assert row.resolved is False
        assert row.chembl_id is None
```

And the migration case, appended to the existing parametrize list in
`tests/pipeline/test_alembic_migrations.py:15-20` — read the file first and add
one tuple in the established `(filename, upgrade_marker, downgrade_marker)`
shape, using the filename chosen in Step 3:

```python
("<next>_add_gene_annotations.py", "CREATE TABLE", "DROP TABLE"),
```

- [ ] **Step 2: Run them to verify they fail**

Run:
`uv run pytest tests/pipeline/test_annotations.py tests/pipeline/test_alembic_migrations.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'pipeline.annotations'`,
and the migration case failing on a missing file.

- [ ] **Step 3: Choose the revision number, then write the migration**

**Determine the next free revision first.**
`docs/superpowers/plans/2026-08-31-schema-normalization.md` reserves `005`,
`006` and `007` in its File Structure table but none exist on disk. Run:

```bash
ls pipeline/alembic/versions/
uv run alembic -c pipeline/alembic.ini heads
```

Take the next unused three-digit number and set `down_revision` to the head that
command prints. The snippet below assumes `005`; if `005` is taken, rename the
file and change both `revision` and `down_revision` to match, and use the same
name in the parametrize tuple from Step 1.

```python
"""Add machine-fetched gene annotations.

ClinVar, Orphadata and Open Targets produce the same kind of fact -- a gene, a
relation, an object with an identifier, and provenance -- in three envelopes.
One edge table holds all of them with typed columns, so the curated genes row
is never written by an API client and a reviewer can adopt the machine
annotations column by column.

group_key is what makes an enrichment joinable: every row describing one
disease repeats that disease's canonical identifier there. It defaults to ''
rather than NULL because PostgreSQL treats NULL as distinct from itself in a
UNIQUE constraint, so two identical GO rows would both insert.

gene_annotation_status is the TTL anchor and the negative cache: a gene with no
annotations has no rows in gene_annotations, which is otherwise
indistinguishable from a gene never fetched.

Revision ID: 005
Revises: 004
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "005"
down_revision: str | None = "004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS gene_annotations (
            id SERIAL PRIMARY KEY,
            gene_symbol VARCHAR(100) NOT NULL,
            source VARCHAR(20) NOT NULL,
            relation VARCHAR(20) NOT NULL,
            group_key TEXT NOT NULL DEFAULT '',
            object_id TEXT NOT NULL,
            object_label TEXT,
            qualifier TEXT,
            score DOUBLE PRECISION,
            evidence_count INTEGER,
            source_version TEXT,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (gene_symbol, source, relation, group_key, object_id)
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS gene_annotation_status (
            id SERIAL PRIMARY KEY,
            gene_symbol VARCHAR(100) NOT NULL,
            source VARCHAR(20) NOT NULL,
            row_count INTEGER NOT NULL DEFAULT 0,
            source_version TEXT,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (gene_symbol, source)
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS trial_drug_annotations (
            id SERIAL PRIMARY KEY,
            drug VARCHAR(255) NOT NULL UNIQUE,
            chembl_id VARCHAR(30),
            action_type TEXT,
            mechanism_of_action TEXT,
            target_symbols TEXT,
            source_version TEXT,
            resolved BOOLEAN NOT NULL DEFAULT FALSE,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gene_annotations_symbol "
        "ON gene_annotations(gene_symbol)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gene_annotations_group "
        "ON gene_annotations(group_key)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gene_annotation_status_symbol "
        "ON gene_annotation_status(gene_symbol)"
    )

    for table in (
        "gene_annotations",
        "gene_annotation_status",
        "trial_drug_annotations",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_updated ON {table}")
        op.execute(f"""
            CREATE TRIGGER {table}_updated
                BEFORE UPDATE ON {table}
                FOR EACH ROW EXECUTE FUNCTION update_timestamp()
        """)


def downgrade() -> None:
    for table in (
        "trial_drug_annotations",
        "gene_annotation_status",
        "gene_annotations",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_updated ON {table}")
    op.execute("DROP TABLE IF EXISTS trial_drug_annotations")
    op.execute("DROP TABLE IF EXISTS gene_annotation_status")
    op.execute("DROP TABLE IF EXISTS gene_annotations")
```

- [ ] **Step 4: Write `pipeline/annotations.py`**

```python
"""The row contract every annotation client emits.

One shape covers all three sources because they produce the same kind of fact:
a gene, a relation, an object with a canonical identifier, and provenance.
``pipeline.database`` consumes exactly these dataclasses, so a client never
writes SQL and the database layer never learns an API's envelope.
"""

from dataclasses import dataclass
from collections.abc import Sequence
from typing import Final

# Which authority names a disease group, best first. MONDO is the integrating
# ontology and is preferred wherever it exists; MedGen is last because ClinVar
# emits a MedGen id even for its placeholder traits.
_GROUP_KEY_PREFERENCE: Final[tuple[str, ...]] = (
    "MONDO",
    "OMIM",
    "Orphanet",
    "MedGen",
)


def group_key_for(xrefs: Sequence[str]) -> str:
    """Pick the canonical identifier that names this disease group.

    Returns ``""`` for a set naming no disease authority -- a GO term or an
    Ensembl accession -- because those rows group with nothing. The empty
    string rather than ``None``: PostgreSQL treats NULL as distinct from
    itself in a UNIQUE constraint, so NULL would let duplicates insert.
    """
    for prefix in _GROUP_KEY_PREFERENCE:
        matches = sorted(x for x in xrefs if x.startswith(f"{prefix}:"))
        if matches:
            return matches[0]
    return ""


@dataclass(slots=True)
class AnnotationRow:
    """One gene -> object edge, with its provenance."""

    gene_symbol: str
    source: str
    relation: str
    group_key: str
    object_id: str
    object_label: str | None
    qualifier: str | None
    score: float | None
    evidence_count: int | None
    source_version: str | None

    @staticmethod
    def sort_key(row: "AnnotationRow") -> tuple[str, ...]:
        """Total order over the UNIQUE key, so writes are reproducible."""
        return (
            row.gene_symbol,
            row.source,
            row.relation,
            row.group_key,
            row.object_id,
        )


@dataclass(slots=True)
class AnnotationStatus:
    """That a gene was fetched from a source, and how many rows it yielded.

    Written even when ``row_count`` is 0 -- that is the negative cache, and
    without it a gene with no annotations looks like a gene never fetched.
    """

    gene_symbol: str
    source: str
    row_count: int
    source_version: str | None


@dataclass(slots=True)
class DrugAnnotationRow:
    """One trial drug's mechanism of action, as Open Targets reports it.

    ``resolved`` is False when the drug name matched nothing, which is a real
    and expected outcome -- 5 of the 11 drugs in ``data/table2.json`` are
    unregistered agents or trade-named combinations ChEMBL does not carry.
    """

    drug: str
    chembl_id: str | None
    action_type: str | None
    mechanism_of_action: str | None
    target_symbols: str | None
    source_version: str | None
    resolved: bool
```

- [ ] **Step 5: Add the database accessors**

Append to `pipeline/database.py`, after the PubMed cache section and before
`upsert_clinical_trials_batch` (`:740`), following the parameter-binding and
docstring shape of `get_cached_uniprot_info` / `upsert_uniprot_batch`
(`:566-655`):

```python
# =============================================================================
# Gene Annotation Operations
# =============================================================================


async def get_annotation_statuses(
    gene_symbols: list[str],
    source: str,
    max_age_days: int | None = None,
) -> dict[str, dict[str, Any]]:
    """Get fetch status for given symbols from one annotation source.

    Args:
        gene_symbols: List of gene symbols to look up.
        source: Annotation source key ("clinvar", "orphadata", "opentargets").
        max_age_days: If set, only return rows updated within this many days;
            older rows are treated as stale and re-fetched by the caller.

    Returns:
        Dict mapping gene_symbol -> {row_count, source_version}. A gene that
        was fetched and yielded nothing is present with row_count 0; that is
        the negative cache.
    """
    if not gene_symbols:
        return {}

    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol, row_count, source_version
            FROM gene_annotation_status
            WHERE gene_symbol = ANY($1::text[])
              AND source = $2
              AND ($3::int IS NULL
                   OR updated_at > NOW() - make_interval(days => $3::int))
            """,
            gene_symbols,
            source,
            max_age_days,
        )
        return {
            row["gene_symbol"]: {
                "row_count": row["row_count"],
                "source_version": row["source_version"],
            }
            for row in rows
        }


async def replace_gene_annotations(
    rows: list[Any],
    statuses: list[Any],
) -> int:
    """Replace one source's annotations for the genes named in *statuses*.

    Delete-then-insert rather than upsert, inside one transaction: a re-fetch
    that returns fewer diseases than last time must not leave the dropped ones
    behind. The delete is scoped to (gene_symbol, source) pairs that were
    actually fetched, so one source never disturbs another's rows.

    Args:
        rows: List of AnnotationRow objects.
        statuses: List of AnnotationStatus objects, one per fetched gene.

    Returns:
        Number of annotation rows written.
    """
    if not statuses:
        return 0

    ordered = sorted(rows, key=lambda r: AnnotationRow.sort_key(r))

    async with Database.connection() as conn, conn.transaction():
        await conn.executemany(
            "DELETE FROM gene_annotations WHERE gene_symbol = $1 AND source = $2",
            [(s.gene_symbol, s.source) for s in statuses],
        )
        if ordered:
            await conn.executemany(
                """
                INSERT INTO gene_annotations (
                    gene_symbol, source, relation, group_key, object_id,
                    object_label, qualifier, score, evidence_count, source_version
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (gene_symbol, source, relation, group_key, object_id)
                DO UPDATE SET
                    object_label = EXCLUDED.object_label,
                    qualifier = EXCLUDED.qualifier,
                    score = EXCLUDED.score,
                    evidence_count = EXCLUDED.evidence_count,
                    source_version = EXCLUDED.source_version,
                    updated_at = CURRENT_TIMESTAMP
                """,
                [
                    (
                        r.gene_symbol,
                        r.source,
                        r.relation,
                        r.group_key,
                        r.object_id,
                        r.object_label,
                        r.qualifier,
                        r.score,
                        r.evidence_count,
                        r.source_version,
                    )
                    for r in ordered
                ],
            )
        await conn.executemany(
            """
            INSERT INTO gene_annotation_status (
                gene_symbol, source, row_count, source_version
            ) VALUES ($1, $2, $3, $4)
            ON CONFLICT (gene_symbol, source) DO UPDATE SET
                row_count = EXCLUDED.row_count,
                source_version = EXCLUDED.source_version,
                updated_at = CURRENT_TIMESTAMP
            """,
            [
                (s.gene_symbol, s.source, s.row_count, s.source_version)
                for s in statuses
            ],
        )
    return len(ordered)


async def read_gene_annotations(source: str | None = None) -> list[dict[str, Any]]:
    """Read annotation rows for export, in a deterministic order.

    The ORDER BY is load-bearing: the export's byte-exact contract cannot hold
    across runs if PostgreSQL is free to choose a physical order.
    """
    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol, source, relation, group_key, object_id,
                   object_label, qualifier, score, evidence_count, source_version
            FROM gene_annotations
            WHERE ($1::text IS NULL OR source = $1)
            ORDER BY gene_symbol, source, relation, group_key, object_id
            """,
            source,
        )
        return [dict(row) for row in rows]


async def upsert_drug_annotations(rows: list[Any]) -> int:
    """Batch upsert trial drug mechanisms.

    Args:
        rows: List of DrugAnnotationRow objects.

    Returns:
        Number of drugs upserted.
    """
    if not rows:
        return 0

    async with Database.connection() as conn:
        await conn.executemany(
            """
            INSERT INTO trial_drug_annotations (
                drug, chembl_id, action_type, mechanism_of_action,
                target_symbols, source_version, resolved
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (drug) DO UPDATE SET
                chembl_id = EXCLUDED.chembl_id,
                action_type = EXCLUDED.action_type,
                mechanism_of_action = EXCLUDED.mechanism_of_action,
                target_symbols = EXCLUDED.target_symbols,
                source_version = EXCLUDED.source_version,
                resolved = EXCLUDED.resolved,
                updated_at = CURRENT_TIMESTAMP
            """,
            [
                (
                    r.drug,
                    r.chembl_id,
                    r.action_type,
                    r.mechanism_of_action,
                    r.target_symbols,
                    r.source_version,
                    r.resolved,
                )
                for r in rows
            ],
        )
    return len(rows)
```

Add `from pipeline.annotations import AnnotationRow` to the imports at the top
of `pipeline/database.py`.

- [ ] **Step 6: Run the tests to verify they pass**

Run:
`uv run pytest tests/pipeline/test_annotations.py tests/pipeline/test_alembic_migrations.py -v`
Expected: PASS — 8 annotation tests, and the migration parametrize now covering
five revisions.

- [ ] **Step 7: Prove the migration applies to a real database**

Use a throwaway container, never the real server. **Point it there with the
`DB_*` variables, not `DATABASE_URL`** — `pipeline/alembic/env.py:32-36` builds
the URL from `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` and never
reads `DATABASE_URL`, so a `DATABASE_URL=…` prefix is silently ignored and the
migration runs against whatever `.env` points at. `load_dotenv` does not
override variables already set in the environment, which is what makes the
prefix below win over `.env`.

```bash
docker run --rm -d --name csvd-migrate-test \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=csvd -p 55432:5432 postgres:18.6
sleep 5
DB_HOST=localhost DB_PORT=55432 DB_NAME=csvd DB_USER=postgres DB_PASSWORD=test \
  uv run alembic -c pipeline/alembic.ini upgrade head
DB_HOST=localhost DB_PORT=55432 DB_NAME=csvd DB_USER=postgres DB_PASSWORD=test \
  uv run alembic -c pipeline/alembic.ini downgrade -1
DB_HOST=localhost DB_PORT=55432 DB_NAME=csvd DB_USER=postgres DB_PASSWORD=test \
  uv run alembic -c pipeline/alembic.ini upgrade head
docker exec csvd-migrate-test psql -U postgres -d csvd -c '\d gene_annotations'
docker rm -f csvd-migrate-test
```

Expected: upgrade from empty succeeds, downgrade drops the three tables cleanly,
re-upgrade succeeds, and `\d` shows the UNIQUE constraint on
`(gene_symbol, source, relation, group_key, object_id)` plus the two indexes.
**Tear the container down** — the last line is not optional.

- [ ] **Step 8: Commit**

```bash
git add pipeline/annotations.py pipeline/alembic/versions/ pipeline/database.py \
  tests/pipeline/test_annotations.py tests/pipeline/test_alembic_migrations.py
git commit -m "Add gene annotation tables and their database layer"
```

---

### Task 3: Fetch monogenic diseases from ClinVar

**Files:**

- Create: `pipeline/clinvar_fetch.py`
- Modify: `pipeline/config.py` (add fields beside `ncbi_rate_limit` at
  `:339-346`)
- Modify: `tests/pipeline/conftest.py` (autouse reset fixture, after
  `_reset_uniprot_client` at `:348-359`)
- Test: `tests/pipeline/test_clinvar_fetch.py`

**Interfaces:**

- Consumes: `pipeline.xrefs.canonical_xref` (Task 1);
  `pipeline.annotations.AnnotationRow`, `AnnotationStatus`, `group_key_for`
  (Task 2); `pipeline.database.get_annotation_statuses`,
  `replace_gene_annotations` (Task 2); `pipeline.config.NCBI_ESEARCH_URL`,
  `NCBI_ESUMMARY_URL`, `get_ncbi_params`;
  `pipeline.http_client.AsyncHttpClientManager`;
  `pipeline.cache_utils.SyncResult`, `DB_CACHE_TTL_DAYS`, `make_log_progress`,
  `run_batched_fetch`, `single_flight_get`.
- Produces:
  `fetch_clinvar_diseases(gene_symbol: str, config: PipelineConfig | None = None) -> ClinVarGeneResult | None`;
  `sync_clinvar_annotations(gene_symbols: list[str], config: PipelineConfig | None = None) -> SyncResult`;
  `close_clinvar_client() -> None`; `clear_clinvar_cache() -> None`; dataclasses
  `ClinVarDisease` and `ClinVarGeneResult` with
  `to_annotation_rows() -> list[AnnotationRow]`.

**This rides infrastructure that already exists.** `db=clinvar` is served by the
same `esearch.fcgi` / `esummary.fcgi` URLs already in
`pipeline/config.py:137-146`, so `get_ncbi_params` key injection applies
unchanged and there is no new base URL, no auth and no new client library.

**Two filters do the work, and both were measured rather than assumed.** Probing
the live API on 2026-08-31 for
`HTRA1[gene] AND "clinsig pathogenic"[Properties]` returned 74 records; the
first 60 broke down as:

| `obj_type`                | records |
| ------------------------- | ------- |
| copy number gain          | 20      |
| copy number loss          | 17      |
| single nucleotide variant | 15      |
| Deletion                  | 7       |
| Duplication               | 1       |

and **39 of the 60 named more than one gene** — up to 724 of them, because a
32-Mb 10q24.1-26.3 copy-number gain lists every gene it spans. Those records
carry the CNV syndrome's traits ("Distal 10q deletion syndrome", "Deficiency of
2-methylbutyryl-CoA dehydrogenase"), not HTRA1's. **The very first uid returned
is one of them**, so a naive take-the-top-hit design returns a 32-Mb duplication
whose only xref is MedGen `CN169374`, "not specified".

The three most frequent trait names across the same 60 were `"not provided"`
(26), `"See cases"` (14) and `"not specified"` (6) — placeholders carrying a
MedGen sentinel or, for `"See cases"`, no xref at all. So ranking traits by
frequency without dropping those returns noise three deep before it returns a
disease.

With `len(genes) == 1` **and** "the trait carries an OMIM, MONDO or Orphanet
xref", HTRA1 returns exactly its real diseases, ranked by supporting-record
count:

| records | trait                                 | xrefs                                                                   |
| ------- | ------------------------------------- | ----------------------------------------------------------------------- |
| 11      | CADASIL type 2                        | `MONDO:0014768` · `OMIM:616779` · `MedGen:C4225211`                     |
| 5       | CARASIL syndrome                      | `MONDO:0010829` · `OMIM:600142` · `Orphanet:199354` · `MedGen:C6022615` |
| 2       | HTRA1-related autosomal dominant cSVD | `MONDO:0018832` · `Orphanet:482077`                                     |
| 2       | HTRA1-related cSVD                    | `Orphanet:482072` · `MedGen:C5680099`                                   |
| 1       | Age related macular degeneration 7    | `MONDO:0012419` · `OMIM:610149`                                         |
| 1       | Cerebral arterial disease             | `MONDO:0006693` · `MedGen:C0007774`                                     |

Both filters are needed. "Distal 10q deletion syndrome" carries a real
`Orphanet:96148` / `MONDO:0012315` / `OMIM:609625` triple, so the xref filter
alone keeps it; it is a CNV artefact that only the single-gene filter removes.

**No sampling cap is needed.** Every one of the 63 committed genes was counted
against the live API on 2026-08-31: 61 have at least one pathogenic record,
median 27, **maximum 248** (`NOTCH3`; `COL6A1` 230 is the only other above 200),
2795 in total. `clinvar_max_records` therefore defaults to 500 — headroom of 2×
over the largest real gene, so `record_total` is a census rather than a sample.
When a gene does exceed it the result is flagged `truncated` and logged, because
a ranked count over a truncated set is a floor, not a total.

**Two genes return zero, and both are findings rather than failures.**
`C6orf195` is an obsolete symbol, and `COL4A1/2` is a compound curator label,
not a gene symbol at all. `sync_clinvar_annotations` writes a zero-count status
row for each — that is the negative cache — and logs them by name.

- [ ] **Step 1: Write the failing tests**

```python
"""ClinVar monogenic-disease annotations."""

import json
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from pipeline.clinvar_fetch import (
    _aggregate_records,
    fetch_clinvar_diseases,
    sync_clinvar_annotations,
)


def _record(
    genes: list[str],
    trait_name: str,
    xrefs: list[tuple[str, str]],
    description: str = "Pathogenic",
    review: str = "criteria provided, single submitter",
) -> dict[str, Any]:
    """One esummary record in the shape the live API returns."""
    return {
        "obj_type": "single nucleotide variant",
        "genes": [{"symbol": s, "geneid": "1"} for s in genes],
        "germline_classification": {
            "description": description,
            "review_status": review,
            "trait_set": [
                {
                    "trait_name": trait_name,
                    "trait_xrefs": [
                        {"db_source": s, "db_id": i} for s, i in xrefs
                    ],
                }
            ],
        },
    }


_CARASIL_XREFS = [
    ("Orphanet", "199354"),
    ("MedGen", "C6022615"),
    ("MONDO", "MONDO:0010829"),
    ("OMIM", "600142"),
]


class TestAggregateRecords:
    def test_a_multi_gene_cnv_is_dropped(self) -> None:
        """The first live hit for HTRA1 is a 32-Mb CNV listing 724 genes."""
        records = [
            _record(
                ["ABCC2", "ABLIM1", "HTRA1"],
                "Distal 10q deletion syndrome",
                [("Orphanet", "96148"), ("MONDO", "MONDO:0012315")],
            )
        ]
        result = _aggregate_records("HTRA1", records, record_total=1, truncated=False)
        assert result.diseases == ()

    def test_a_placeholder_trait_is_dropped(self) -> None:
        """"not provided" is the most frequent trait name in the real data."""
        records = [
            _record(["HTRA1"], "not provided", [("MedGen", "C3661900")]),
            _record(["HTRA1"], "See cases", []),
            _record(["HTRA1"], "not specified", [("MedGen", "CN169374")]),
        ]
        result = _aggregate_records("HTRA1", records, record_total=3, truncated=False)
        assert result.diseases == ()

    def test_a_real_disease_survives_both_filters(self) -> None:
        records = [_record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS)]
        result = _aggregate_records("HTRA1", records, record_total=1, truncated=False)
        assert len(result.diseases) == 1
        disease = result.diseases[0]
        assert disease.trait_name == "CARASIL syndrome"
        assert disease.group_key == "MONDO:0010829"
        assert disease.xrefs == (
            "MONDO:0010829",
            "MedGen:C6022615",
            "OMIM:600142",
            "Orphanet:199354",
        )
        assert disease.record_count == 1

    def test_diseases_rank_by_supporting_record_count(self) -> None:
        records = [
            _record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS),
            *[
                _record(
                    ["HTRA1"],
                    "Cerebral arteriopathy, autosomal dominant, type 2",
                    [("MONDO", "MONDO:0014768"), ("OMIM", "616779")],
                )
                for _ in range(3)
            ],
        ]
        result = _aggregate_records("HTRA1", records, record_total=4, truncated=False)
        assert [d.record_count for d in result.diseases] == [3, 1]
        assert result.diseases[0].group_key == "MONDO:0014768"

    def test_ties_break_on_trait_name_so_the_order_is_reproducible(self) -> None:
        records = [
            _record(["HTRA1"], "Zeta disease", [("OMIM", "600001")]),
            _record(["HTRA1"], "Alpha disease", [("OMIM", "600002")]),
        ]
        result = _aggregate_records("HTRA1", records, record_total=2, truncated=False)
        assert [d.trait_name for d in result.diseases] == [
            "Alpha disease",
            "Zeta disease",
        ]

    def test_the_most_common_classification_wins(self) -> None:
        records = [
            _record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS, "Pathogenic"),
            _record(
                ["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS,
                "Pathogenic/Likely pathogenic",
            ),
            _record(
                ["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS,
                "Pathogenic/Likely pathogenic",
            ),
        ]
        result = _aggregate_records("HTRA1", records, record_total=3, truncated=False)
        assert result.diseases[0].classification == "Pathogenic/Likely pathogenic"

    def test_one_row_per_xref_all_sharing_a_group_key(self) -> None:
        records = [_record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS)]
        result = _aggregate_records("HTRA1", records, record_total=1, truncated=False)
        rows = result.to_annotation_rows()
        assert len(rows) == 4
        assert {r.group_key for r in rows} == {"MONDO:0010829"}
        assert {r.object_id for r in rows} == {
            "MONDO:0010829",
            "MedGen:C6022615",
            "OMIM:600142",
            "Orphanet:199354",
        }
        assert all(r.source == "clinvar" for r in rows)
        assert all(r.relation == "disease" for r in rows)
        assert all(r.object_label == "CARASIL syndrome" for r in rows)
        assert all(r.evidence_count == 1 for r in rows)


class TestFetchClinVarDiseases:
    async def test_an_empty_search_yields_no_diseases_and_no_summary_call(
        self, mocker
    ) -> None:
        search = httpx.Response(
            200, text=json.dumps({"esearchresult": {"count": "0", "idlist": []}})
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        mock_client.post = AsyncMock()
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        result = await fetch_clinvar_diseases("COL4A1/2")

        assert result is not None
        assert result.diseases == ()
        assert result.record_total == 0
        mock_client.post.assert_not_awaited()

    async def test_a_non_200_search_is_a_transient_miss(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=httpx.Response(500))
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_clinvar_diseases("HTRA1") is None

    async def test_a_timeout_is_a_transient_miss(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("slow"))
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_clinvar_diseases("HTRA1") is None

    async def test_the_api_key_reaches_the_search_params(self, mocker) -> None:
        mocker.patch.dict("os.environ", {"NCBI_API_KEY": "test-key-123"})
        search = httpx.Response(
            200, text=json.dumps({"esearchresult": {"count": "0", "idlist": []}})
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        await fetch_clinvar_diseases("HTRA1")

        params = mock_client.get.call_args.kwargs["params"]
        assert params["api_key"] == "test-key-123"
        assert params["db"] == "clinvar"

    async def test_uids_are_summarised_by_post_in_batches(self, mocker) -> None:
        """A 248-record gene exceeds any sane URL length, so esummary is POSTed."""
        uids = [str(n) for n in range(450)]
        search = httpx.Response(
            200,
            text=json.dumps({"esearchresult": {"count": "450", "idlist": uids}}),
        )
        summary = httpx.Response(
            200, text=json.dumps({"result": {"uids": []}})
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        mock_client.post = AsyncMock(return_value=summary)
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        result = await fetch_clinvar_diseases("NOTCH3")

        assert result is not None
        assert mock_client.post.await_count == 3  # 200 + 200 + 50
        assert result.truncated is False

    async def test_exceeding_the_cap_flags_the_result_as_truncated(
        self, mocker
    ) -> None:
        from pipeline.config import PipelineConfig

        config = PipelineConfig()
        config.clinvar_max_records = 2
        uids = ["1", "2"]
        search = httpx.Response(
            200,
            text=json.dumps({"esearchresult": {"count": "500", "idlist": uids}}),
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        mock_client.post = AsyncMock(
            return_value=httpx.Response(200, text=json.dumps({"result": {"uids": []}}))
        )
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        result = await fetch_clinvar_diseases("NOTCH3", config=config)

        assert result is not None
        assert result.truncated is True


class TestSyncClinVarAnnotations:
    async def test_a_fresh_cache_skips_the_fetch(self, mocker) -> None:
        mocker.patch(
            "pipeline.database.get_annotation_statuses",
            AsyncMock(return_value={"HTRA1": {"row_count": 4, "source_version": None}}),
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )
        fetch = mocker.patch("pipeline.clinvar_fetch.fetch_clinvar_diseases")

        result = await sync_clinvar_annotations(["HTRA1"])

        assert result.cached == 1
        assert result.fetched == 0
        fetch.assert_not_called()
        replace.assert_not_awaited()

    async def test_a_gene_with_no_diseases_still_writes_a_status_row(
        self, mocker
    ) -> None:
        """The negative cache: zero rows and never-fetched must be distinct."""
        from pipeline.clinvar_fetch import ClinVarGeneResult

        mocker.patch(
            "pipeline.database.get_annotation_statuses", AsyncMock(return_value={})
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )
        mocker.patch(
            "pipeline.clinvar_fetch.fetch_clinvar_diseases",
            AsyncMock(
                return_value=ClinVarGeneResult(
                    gene_symbol="C6orf195",
                    diseases=(),
                    record_total=0,
                    truncated=False,
                )
            ),
        )

        result = await sync_clinvar_annotations(["C6orf195"])

        statuses = replace.await_args.args[1]
        assert [s.gene_symbol for s in statuses] == ["C6orf195"]
        assert statuses[0].row_count == 0
        assert result.failed == 0

    async def test_a_transient_failure_writes_no_status_row(self, mocker) -> None:
        """A 500 must not be cached as "this gene has no diseases" for 30 days."""
        mocker.patch(
            "pipeline.database.get_annotation_statuses", AsyncMock(return_value={})
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )
        mocker.patch(
            "pipeline.clinvar_fetch.fetch_clinvar_diseases",
            AsyncMock(return_value=None),
        )

        result = await sync_clinvar_annotations(["HTRA1"])

        assert result.failed == 1
        assert replace.await_args.args[1] == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/pipeline/test_clinvar_fetch.py -v` Expected: FAIL —
`ModuleNotFoundError: No module named 'pipeline.clinvar_fetch'`.

- [ ] **Step 3: Add the config fields**

In `pipeline/config.py`, beside `ncbi_rate_limit` / `uniprot_rate_limit`
(`:339-346`), add:

```python
clinvar_rate_limit: int = field(
    default_factory=lambda: _env_int("PIPELINE_CLINVAR_RATE_LIMIT", 10)
)
# Measured against the live API on 2026-08-31 over all 63 committed genes:
# 61 return at least one pathogenic record, median 27, max 248 (NOTCH3).
# 500 is 2x headroom over the largest real gene, so record_total is a
# census rather than a sample; a gene that exceeds it is flagged truncated.
clinvar_max_records: int = field(
    default_factory=lambda: _env_int("PIPELINE_CLINVAR_MAX_RECORDS", 500)
)
```

Document both in `.env.example`, commented out with their defaults, the way
every other `PIPELINE_*` variable is.

- [ ] **Step 4: Write the module**

```python
"""ClinVar monogenic-disease annotations for the curated genes.

Rides the E-utilities the pipeline already calls -- ``db=clinvar`` is served by
the same esearch/esummary URLs in ``pipeline.config``, so ``get_ncbi_params``
key injection applies unchanged and there is no new base URL and no auth.

Two filters do the work, and both were measured against the live API on
2026-08-31 rather than assumed. Of the first 60 of HTRA1's 74 ``clinsig
pathogenic`` records, 39 named more than one gene -- up to 724 of them, because
a 32-Mb 10q24.1-26.3 copy-number gain lists every gene it spans. Those records
carry the CNV syndrome's traits, not the gene's, and the very first uid the API
returns is one of them. ``_is_single_gene`` drops them.

The three most frequent trait names in the same sample were "not provided"
(26), "See cases" (14) and "not specified" (6) -- placeholders carrying a
MedGen sentinel or no xref at all. ``_disease_xrefs`` keeps only traits
carrying an OMIM, MONDO or Orphanet identifier, which drops all three without
a hardcoded list of placeholder strings.

Both filters are needed, not either: "Distal 10q deletion syndrome" carries a
real Orphanet/MONDO/OMIM triple and is removed only by the single-gene rule.

With both, HTRA1 returns exactly its real diseases, ranked by supporting-record
count -- CADASIL type 2 (11), CARASIL (5), the two HTRA1-related cSVD entries
(2 each), AMD7 (1) and cerebral arterial disease (1).
"""

import asyncio
import json
import logging
from collections import Counter, OrderedDict
from dataclasses import dataclass, field
from typing import Any, Final

import httpx

from pipeline.annotations import AnnotationRow, AnnotationStatus, group_key_for
from pipeline.cache_utils import (
    DB_CACHE_TTL_DAYS,
    SyncResult,
    make_log_progress,
    run_batched_fetch,
    single_flight_get,
)
from pipeline.config import (
    NCBI_ESEARCH_URL,
    NCBI_ESUMMARY_URL,
    PipelineConfig,
    get_ncbi_params,
)
from pipeline.http_client import AsyncHttpClientManager
from pipeline.xrefs import canonical_xref, xref_prefix

logger = logging.getLogger(__name__)

SOURCE: Final[str] = "clinvar"

# A trait must carry one of these to be a disease rather than a placeholder.
_DISEASE_PREFIXES: Final[frozenset[str]] = frozenset({"OMIM", "MONDO", "Orphanet"})

# esummary accepts a POST body, which is what makes a 248-uid request possible
# at all; 200 per call keeps each body small enough to debug.
_ESUMMARY_BATCH: Final[int] = 200


# ---------------------------------------------------------------------------
# MODELS
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ClinVarDisease:
    """One disease a gene's pathogenic variants are classified against."""

    trait_name: str
    group_key: str
    xrefs: tuple[str, ...]
    classification: str | None
    review_status: str | None
    record_count: int


@dataclass(slots=True)
class ClinVarGeneResult:
    """Every disease ClinVar associates with one gene."""

    gene_symbol: str
    diseases: tuple[ClinVarDisease, ...]
    record_total: int
    truncated: bool

    def to_annotation_rows(self) -> list[AnnotationRow]:
        """One row per (disease, xref), all sharing the disease's group_key."""
        return [
            AnnotationRow(
                gene_symbol=self.gene_symbol,
                source=SOURCE,
                relation="disease",
                group_key=disease.group_key,
                object_id=xref,
                object_label=disease.trait_name,
                qualifier=disease.classification,
                score=None,
                evidence_count=disease.record_count,
                source_version=None,
            )
            for disease in self.diseases
            for xref in disease.xrefs
        ]


@dataclass(slots=True)
class _TraitAccumulator:
    xrefs: set[str] = field(default_factory=set)
    classifications: Counter[str] = field(default_factory=Counter)
    review_statuses: Counter[str] = field(default_factory=Counter)
    record_count: int = 0


# ---------------------------------------------------------------------------
# HTTP CLIENT AND CACHE
# ---------------------------------------------------------------------------

_client_manager = AsyncHttpClientManager(timeout=30.0)
_clinvar_cache: OrderedDict[str, ClinVarGeneResult | None] = OrderedDict()
_cache_lock: asyncio.Lock | None = None
_clinvar_semaphore: asyncio.Semaphore | None = None
_in_flight: dict[str, asyncio.Task[ClinVarGeneResult | None]] = {}


def _get_cache_lock() -> asyncio.Lock:
    """Get cache lock, initializing lazily if needed."""
    global _cache_lock
    if _cache_lock is None:
        _cache_lock = asyncio.Lock()
    return _cache_lock


def _get_clinvar_semaphore(config: PipelineConfig | None = None) -> asyncio.Semaphore:
    """Get ClinVar rate-limit semaphore, initializing lazily if needed."""
    global _clinvar_semaphore
    if _clinvar_semaphore is None:
        limit = (
            config.clinvar_rate_limit if config else PipelineConfig().clinvar_rate_limit
        )
        _clinvar_semaphore = asyncio.Semaphore(limit)
    return _clinvar_semaphore


async def close_clinvar_client() -> None:
    """Close shared HTTP client (call at shutdown)."""
    await _client_manager.close()


def clear_clinvar_cache() -> None:
    """Clear the ClinVar cache and any in-flight task references."""
    global _clinvar_cache
    _clinvar_cache = OrderedDict()
    _in_flight.clear()


# ---------------------------------------------------------------------------
# PARSING
# ---------------------------------------------------------------------------


def _is_single_gene(record: dict[str, Any]) -> bool:
    """True when the record names exactly one gene.

    A multi-gene record is a copy-number event spanning a region; its traits
    describe the CNV syndrome, not the gene being annotated.
    """
    return len(record.get("genes") or []) == 1


def _disease_xrefs(trait: dict[str, Any]) -> set[str]:
    """Canonical xrefs for one trait, or an empty set if it names no disease."""
    xrefs = {
        canonical_xref(str(x.get("db_source", "")), str(x.get("db_id", "")))
        for x in trait.get("trait_xrefs") or []
    }
    resolved = {x for x in xrefs if x is not None}
    if not any(xref_prefix(x) in _DISEASE_PREFIXES for x in resolved):
        return set()
    return resolved


def _aggregate_records(
    gene_symbol: str,
    records: list[dict[str, Any]],
    record_total: int,
    truncated: bool,
) -> ClinVarGeneResult:
    """Group surviving records by trait and rank by supporting-record count."""
    by_trait: dict[str, _TraitAccumulator] = {}

    for record in records:
        if not _is_single_gene(record):
            continue
        classification = record.get("germline_classification") or {}
        for trait in classification.get("trait_set") or []:
            xrefs = _disease_xrefs(trait)
            if not xrefs:
                continue
            name = str(trait.get("trait_name") or "").strip()
            if not name:
                continue
            accumulator = by_trait.setdefault(name, _TraitAccumulator())
            accumulator.xrefs |= xrefs
            accumulator.record_count += 1
            if description := classification.get("description"):
                accumulator.classifications[str(description)] += 1
            if review := classification.get("review_status"):
                accumulator.review_statuses[str(review)] += 1

    # Rank by evidence, then by name -- the tiebreak is what makes two runs
    # over the same data produce byte-identical rows.
    ranked = sorted(by_trait.items(), key=lambda item: (-item[1].record_count, item[0]))

    diseases = tuple(
        ClinVarDisease(
            trait_name=name,
            group_key=group_key_for(sorted(accumulator.xrefs)),
            xrefs=tuple(sorted(accumulator.xrefs)),
            classification=_most_common(accumulator.classifications),
            review_status=_most_common(accumulator.review_statuses),
            record_count=accumulator.record_count,
        )
        for name, accumulator in ranked
    )
    return ClinVarGeneResult(
        gene_symbol=gene_symbol,
        diseases=diseases,
        record_total=record_total,
        truncated=truncated,
    )


def _most_common(counter: Counter[str]) -> str | None:
    """Most frequent value, ties broken alphabetically for reproducibility."""
    if not counter:
        return None
    return min(counter.items(), key=lambda item: (-item[1], item[0]))[0]


# ---------------------------------------------------------------------------
# FETCH FUNCTIONS
# ---------------------------------------------------------------------------


async def _search_uids(
    gene_symbol: str, config: PipelineConfig
) -> tuple[list[str], int] | None:
    """Return (uids, total_count) for a gene's pathogenic records, or None.

    None means a transient failure -- the caller must not cache that as
    "this gene has no diseases".
    """
    params = get_ncbi_params(
        {
            "db": "clinvar",
            "term": f'{gene_symbol}[gene] AND "clinsig pathogenic"[Properties]',
            "retmode": "json",
            "retmax": str(config.clinvar_max_records),
        }
    )
    try:
        client = await _client_manager.get()
        resp = await client.get(NCBI_ESEARCH_URL, params=params)
        if resp.status_code != 200:
            logger.warning(
                f"ClinVar esearch failed for {gene_symbol}: {resp.status_code}"
            )
            return None
        result = resp.json()["esearchresult"]
        return list(result.get("idlist") or []), int(result.get("count") or 0)
    except httpx.TimeoutException:
        logger.warning(f"Timeout querying ClinVar for {gene_symbol}")
    except httpx.RequestError as e:
        logger.warning(f"Request error querying ClinVar for {gene_symbol}: {e}")
    except (KeyError, ValueError, json.JSONDecodeError) as e:
        logger.warning(f"Unexpected ClinVar esearch response for {gene_symbol}: {e}")
    return None


async def _fetch_summaries(uids: list[str], gene_symbol: str) -> list[dict[str, Any]]:
    """Fetch esummary records in POSTed batches.

    POST rather than GET: NOTCH3 returns 248 uids, which is past any sane URL
    length, and E-utilities accepts the same parameters as a form body.
    """
    records: list[dict[str, Any]] = []
    client = await _client_manager.get()
    for start in range(0, len(uids), _ESUMMARY_BATCH):
        chunk = uids[start : start + _ESUMMARY_BATCH]
        params = get_ncbi_params(
            {"db": "clinvar", "retmode": "json", "id": ",".join(chunk)}
        )
        try:
            resp = await client.post(NCBI_ESUMMARY_URL, data=params)
            if resp.status_code != 200:
                logger.warning(
                    f"ClinVar esummary failed for {gene_symbol}: {resp.status_code}"
                )
                continue
            result = resp.json().get("result", {})
        except httpx.TimeoutException:
            logger.warning(f"Timeout fetching ClinVar summaries for {gene_symbol}")
            continue
        except httpx.RequestError as e:
            logger.warning(f"Request error on ClinVar summaries for {gene_symbol}: {e}")
            continue
        except (ValueError, json.JSONDecodeError) as e:
            logger.warning(f"Failed to parse ClinVar summaries for {gene_symbol}: {e}")
            continue
        for uid in result.get("uids") or []:
            record = result.get(uid)
            if isinstance(record, dict):
                records.append(record)
    return records


async def _fetch_clinvar_uncached(
    gene_symbol: str, config: PipelineConfig
) -> ClinVarGeneResult | None:
    """Internal: fetch and aggregate one gene without caching."""
    searched = await _search_uids(gene_symbol, config)
    if searched is None:
        return None
    uids, total = searched
    if not uids:
        logger.debug(f"No pathogenic ClinVar records for {gene_symbol}")
        return ClinVarGeneResult(
            gene_symbol=gene_symbol, diseases=(), record_total=0, truncated=False
        )
    truncated = total > len(uids)
    if truncated:
        logger.info(
            f"ClinVar returned {total} records for {gene_symbol}, capped at "
            f"{len(uids)} -- record counts are a floor, not a total"
        )
    records = await _fetch_summaries(uids, gene_symbol)
    return _aggregate_records(gene_symbol, records, len(uids), truncated)


async def fetch_clinvar_diseases(
    gene_symbol: str,
    config: PipelineConfig | None = None,
) -> ClinVarGeneResult | None:
    """Fetch every disease ClinVar associates with one gene symbol.

    Results are cached; concurrent callers for the same symbol share one
    in-flight fetch via ``single_flight_get``. None means a transient failure.
    """
    resolved = config or PipelineConfig()
    return await single_flight_get(
        gene_symbol.upper(),
        cache=_clinvar_cache,
        cache_lock=_get_cache_lock(),
        in_flight=_in_flight,
        semaphore=_get_clinvar_semaphore(resolved),
        fetch_fn=lambda: _fetch_clinvar_uncached(gene_symbol, resolved),
        label="ClinVar cache",
    )


# ---------------------------------------------------------------------------
# DATABASE SYNC
# ---------------------------------------------------------------------------


async def sync_clinvar_annotations(
    gene_symbols: list[str],
    config: PipelineConfig | None = None,
) -> SyncResult:
    """Sync ClinVar disease annotations for the given gene symbols.

    A gene that resolves to nothing gets a zero-count status row -- that is the
    negative cache. A gene whose fetch failed transiently gets no row at all,
    so a 500 is never remembered as "this gene has no diseases" for 30 days.
    """
    from pipeline.database import get_annotation_statuses, replace_gene_annotations

    cached = await get_annotation_statuses(
        gene_symbols, SOURCE, max_age_days=DB_CACHE_TTL_DAYS
    )
    to_fetch = [s for s in gene_symbols if s not in cached]

    logger.info(f"ClinVar sync: {len(cached)} cached, {len(to_fetch)} to fetch")

    if not to_fetch:
        return SyncResult(fetched=0, cached=len(cached), failed=0, errors=[])

    results = await run_batched_fetch(
        to_fetch,
        lambda symbol: fetch_clinvar_diseases(symbol, config=config),
        make_log_progress("ClinVar fetch"),
    )

    rows: list[AnnotationRow] = []
    statuses: list[AnnotationStatus] = []
    errors: list[str] = []
    empty: list[str] = []

    for symbol, result in zip(to_fetch, results, strict=True):
        if result is None:
            errors.append(f"ClinVar fetch failed: {symbol}")
            continue
        gene_rows = result.to_annotation_rows()
        rows.extend(gene_rows)
        statuses.append(
            AnnotationStatus(
                gene_symbol=symbol,
                source=SOURCE,
                row_count=len(gene_rows),
                source_version=None,
            )
        )
        if not gene_rows:
            empty.append(symbol)

    if empty:
        logger.info(f"No ClinVar disease for {len(empty)} genes: {', '.join(empty)}")

    await replace_gene_annotations(rows, statuses)

    return SyncResult(
        fetched=len(statuses),
        cached=len(cached),
        failed=len(errors),
        errors=errors,
    )
```

- [ ] **Step 5: Add the autouse reset fixture**

In `tests/pipeline/conftest.py`, after `_reset_uniprot_client` (`:348-359`):

```python
@pytest.fixture(autouse=True)
def _reset_clinvar_client():
    """Clear the shared clinvar_fetch HTTP client and cache after each test."""
    from collections import OrderedDict

    yield
    import pipeline.clinvar_fetch as cv

    cv._client_manager.reset()
    cv._clinvar_cache = OrderedDict()
    cv._clinvar_semaphore = None
    cv._cache_lock = None
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/test_clinvar_fetch.py -v` Expected: PASS, 16
tests.

- [ ] **Step 7: Prove the parser against the real API once, by hand**

This is a one-off check that the recorded shapes are still the live shapes — not
a committed test, because no test here touches the network.

```bash
uv run python -c "
import asyncio, os
from dotenv import load_dotenv
load_dotenv()
from pipeline.clinvar_fetch import fetch_clinvar_diseases, close_clinvar_client

async def main():
    for symbol in ('HTRA1', 'NOTCH3', 'COL4A1/2'):
        r = await fetch_clinvar_diseases(symbol)
        print(symbol, '->', 'FAILED' if r is None else
              f'{len(r.diseases)} diseases over {r.record_total} records')
        if r:
            for d in r.diseases[:3]:
                print('   ', d.record_count, d.trait_name, '|', ' . '.join(d.xrefs))
    await close_clinvar_client()

asyncio.run(main())
"
```

Expected: `HTRA1` returns CADASIL type 2 first with
`MONDO:0014768 . MedGen:C4225211 . OMIM:616779`, then CARASIL syndrome; `NOTCH3`
returns CADASIL (`MONDO:0007076` / `OMIM:125310`) at the top; `COL4A1/2` returns
**0 diseases over 0 records**, because it is a compound curator label rather
than a gene symbol. If HTRA1's top disease is a copy-number syndrome,
`_is_single_gene` is not being applied.

- [ ] **Step 8: Lint, type-check and commit**

```bash
uv run ruff check pipeline/clinvar_fetch.py pipeline/config.py tests/pipeline/
uv run ty check pipeline/clinvar_fetch.py
uv run pytest tests/pipeline/test_clinvar_fetch.py --cov=pipeline.clinvar_fetch \
  --cov-branch --cov-report=term-missing
git add pipeline/clinvar_fetch.py pipeline/config.py tests/pipeline/conftest.py \
  tests/pipeline/test_clinvar_fetch.py
git commit -m "Fetch monogenic diseases from ClinVar"
```

Expected: ruff and ty clean, `pipeline/clinvar_fetch.py` at 100% with no missing
branches.

---

### Task 4: Enrich ClinVar's ORPHAcodes from Orphadata

**Files:**

- Create: `pipeline/orphadata_fetch.py`
- Modify: `pipeline/config.py` (beside the ClinVar fields added in Task 3)
- Modify: `tests/pipeline/conftest.py` (autouse reset fixture)
- Test: `tests/pipeline/test_orphadata_fetch.py`

**Interfaces:**

- Consumes: `pipeline.xrefs.canonical_xref` (Task 1);
  `pipeline.annotations.AnnotationRow`, `AnnotationStatus` (Task 2);
  `pipeline.database.get_annotation_statuses`, `replace_gene_annotations`,
  `read_gene_annotations` (Task 2). **Depends on Task 3 having run** — the
  ORPHAcodes it fetches come from ClinVar's rows.
- Produces: `orphacodes_by_gene() -> dict[str, list[tuple[str, str]]]`;
  `fetch_orphadata_disease(orphacode: str) -> OrphadataDisease | None`;
  `sync_orphadata_annotations(gene_symbols: list[str], config: PipelineConfig | None = None) -> SyncResult`;
  `close_orphadata_client() -> None`; `clear_orphadata_cache() -> None`.

**Orphadata has no gene entry point, and that is a measured fact, not a guess.**
`GET https://api.orphadata.com/rd-associated-genes/genes/HTRA1` returns:

```json
{
  "detail": "The requested URL was not found on the server. ...",
  "status": 404,
  "title": "Not Found",
  "type": "about:blank"
}
```

Every endpoint is keyed by ORPHAcode. So **ClinVar is the entry point and
Orphadata is the enrichment**: this module reads the `Orphanet:` rows Task 3
wrote, strips the prefix, and fetches each code. A gene with no ORPHAcode in
ClinVar is skipped with a zero-count status row, which is correct — there is no
other way in.

**Two endpoints, and they nest differently.** Verified live on 2026-08-31:

| endpoint                                 | payload path                                     |
| ---------------------------------------- | ------------------------------------------------ |
| `rd-cross-referencing/orphacodes/{code}` | `data.results.ExternalReference[]`               |
| `rd-phenotypes/orphacodes/{code}`        | `data.results.Disorder.HPODisorderAssociation[]` |

The extra `Disorder` level on the phenotypes response is real and easy to miss —
reading `results.HPODisorderAssociation` returns nothing and looks like a
disease with no phenotypes. A test pins both shapes.

**`rd-associated-genes` is fetched but not stored.** It returns the _gene's_
OMIM number (`602194` for HTRA1) beside the disease's (`600142`), and storing
both under one gene would put two different meanings of "OMIM" in one column.
The endpoint's value here is the `DisorderGeneAssociationType` string
(`"Disease-causing germline mutation(s) in"`), which is recorded as the
qualifier on the cross-reference rows rather than as rows of its own.

**The mapping qualifier is the scientific payload.** `DisorderMappingRelation`
distinguishes `"E (Exact mapping: the two concepts are equivalent)"` from
`"NTBT (ORPHAcode is narrower than the targeted code used to represent it)"` —
it tells a reader when an OMIM number is _not_ a synonym for the Orphanet
disease. Only the leading token is stored (`E`, `NTBT`); the parenthetical is
prose that would repeat on every row.

**CC-BY-4.0 is asserted in the payload itself**, as `data.__licence.identifier`.
The client asserts it matches what the code was written against and logs loudly
if it changes, because the attribution obligation Task 8 discharges is tied to
that value.

- [ ] **Step 1: Write the failing tests**

```python
"""Orphadata cross-reference and phenotype enrichment."""

import json
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from pipeline.orphadata_fetch import (
    _parse_cross_references,
    _parse_phenotypes,
    fetch_orphadata_disease,
    orphacodes_by_gene,
    sync_orphadata_annotations,
)

_LICENCE = {
    "identifier": "CC-BY-4.0",
    "link": "https://creativecommons.org/licenses/by/4.0",
    "name": "Creative Commons Attribution 4.0 International",
}


def _xref_payload() -> dict[str, Any]:
    """The live rd-cross-referencing shape for ORPHAcode 199354."""
    return {
        "data": {
            "__count": 1,
            "__licence": _LICENCE,
            "results": {
                "Date": "2026-06-23 07:53:50",
                "ORPHAcode": 199354,
                "Preferred term": (
                    "Cerebral autosomal recessive arteriopathy-subcortical "
                    "infarcts-leukoencephalopathy"
                ),
                "ExternalReference": [
                    {
                        "DisorderMappingRelation": (
                            "E (Exact mapping: the two concepts are equivalent)"
                        ),
                        "Reference": "0010829",
                        "Source": "MONDO",
                    },
                    {
                        "DisorderMappingRelation": (
                            "E (Exact mapping: the two concepts are equivalent)"
                        ),
                        "Reference": "600142",
                        "Source": "OMIM",
                    },
                    {
                        "DisorderMappingRelation": (
                            "NTBT (ORPHAcode is narrower than the targeted code "
                            "used to represent it)"
                        ),
                        "Reference": "I67.8",
                        "Source": "ICD-10",
                    },
                    {
                        "DisorderMappingRelation": (
                            "E (Exact mapping: the two concepts are equivalent)"
                        ),
                        "Reference": "C563990",
                        "Source": "MeSH",
                    },
                ],
            },
        }
    }


def _phenotype_payload() -> dict[str, Any]:
    """The live rd-phenotypes shape -- note the extra Disorder level."""
    return {
        "data": {
            "__count": 1,
            "__licence": _LICENCE,
            "results": {
                "Date": "2026-06-23 07:57:18",
                "Disorder": {
                    "DisorderGroup": "Disorder",
                    "HPODisorderAssociation": [
                        {
                            "DiagnosticCriteria": None,
                            "HPO": {
                                "HPOId": "HP:0000708",
                                "HPOTerm": "Atypical behavior",
                            },
                            "HPOFrequency": "Frequent (79-30%)",
                        },
                        {
                            "DiagnosticCriteria": None,
                            "HPO": {
                                "HPOId": "HP:0001257",
                                "HPOTerm": "Spasticity",
                            },
                            "HPOFrequency": "Frequent (79-30%)",
                        },
                    ],
                },
            },
        }
    }


class TestParseCrossReferences:
    def test_keeps_only_prefixes_this_pipeline_stores(self) -> None:
        refs = _parse_cross_references(_xref_payload()["data"]["results"])
        assert [r.object_id for r in refs] == [
            "MONDO:0010829",
            "MeSH:C563990",
            "OMIM:600142",
        ]

    def test_records_only_the_leading_qualifier_token(self) -> None:
        refs = _parse_cross_references(_xref_payload()["data"]["results"])
        assert {r.qualifier for r in refs} == {"E"}

    def test_an_icd_row_is_dropped_rather_than_stored_uninterpreted(self) -> None:
        refs = _parse_cross_references(_xref_payload()["data"]["results"])
        assert not any("I67.8" in r.object_id for r in refs)

    def test_a_narrower_than_mapping_keeps_its_ntbt_token(self) -> None:
        results = _xref_payload()["data"]["results"]
        results["ExternalReference"][1]["DisorderMappingRelation"] = (
            "NTBT (ORPHAcode is narrower than the targeted code used to represent it)"
        )
        refs = _parse_cross_references(results)
        by_id = {r.object_id: r.qualifier for r in refs}
        assert by_id["OMIM:600142"] == "NTBT"


class TestParsePhenotypes:
    def test_reads_through_the_extra_disorder_level(self) -> None:
        """results.HPODisorderAssociation is empty; the data is one level down."""
        phenotypes = _parse_phenotypes(_phenotype_payload()["data"]["results"])
        assert [p.object_id for p in phenotypes] == ["HP:0000708", "HP:0001257"]
        assert phenotypes[0].object_label == "Atypical behavior"
        assert phenotypes[0].qualifier == "Frequent (79-30%)"

    def test_a_disorder_with_no_phenotypes_yields_nothing(self) -> None:
        assert _parse_phenotypes({"Disorder": {}}) == []
        assert _parse_phenotypes({}) == []


class TestFetchOrphadataDisease:
    async def test_combines_both_endpoints(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[
                httpx.Response(200, text=json.dumps(_xref_payload())),
                httpx.Response(200, text=json.dumps(_phenotype_payload())),
            ]
        )
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        disease = await fetch_orphadata_disease("199354")

        assert disease is not None
        assert disease.orphacode == "199354"
        assert len(disease.cross_references) == 3
        assert len(disease.phenotypes) == 2
        assert disease.preferred_term.startswith("Cerebral autosomal recessive")

    async def test_a_404_is_a_confirmed_absence_not_a_failure(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=httpx.Response(404))
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        disease = await fetch_orphadata_disease("999999")

        assert disease is not None
        assert disease.cross_references == ()
        assert disease.phenotypes == ()

    async def test_a_500_is_a_transient_miss(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=httpx.Response(500))
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_orphadata_disease("199354") is None

    async def test_an_unexpected_licence_is_logged_loudly(self, mocker, caplog) -> None:
        payload = _xref_payload()
        payload["data"]["__licence"]["identifier"] = "CC-BY-NC-4.0"
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[
                httpx.Response(200, text=json.dumps(payload)),
                httpx.Response(200, text=json.dumps(_phenotype_payload())),
            ]
        )
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        await fetch_orphadata_disease("199354")

        assert "CC-BY-NC-4.0" in caplog.text
        assert "attribution" in caplog.text.lower()


class TestOrphacodesByGene:
    async def test_reads_the_orphanet_rows_clinvar_wrote(self, mocker) -> None:
        mocker.patch(
            "pipeline.database.read_gene_annotations",
            AsyncMock(
                return_value=[
                    {
                        "gene_symbol": "HTRA1",
                        "object_id": "Orphanet:199354",
                        "group_key": "MONDO:0010829",
                    },
                    {
                        "gene_symbol": "HTRA1",
                        "object_id": "OMIM:600142",
                        "group_key": "MONDO:0010829",
                    },
                    {
                        "gene_symbol": "HTRA1",
                        "object_id": "Orphanet:482072",
                        "group_key": "Orphanet:482072",
                    },
                ]
            ),
        )

        found = await orphacodes_by_gene()

        assert found == {
            "HTRA1": [("199354", "MONDO:0010829"), ("482072", "Orphanet:482072")]
        }


class TestSyncOrphadataAnnotations:
    async def test_a_gene_with_no_orphacode_gets_a_zero_status_row(
        self, mocker
    ) -> None:
        """There is no gene entry point, so no ORPHAcode means no enrichment."""
        mocker.patch(
            "pipeline.database.get_annotation_statuses", AsyncMock(return_value={})
        )
        mocker.patch(
            "pipeline.orphadata_fetch.orphacodes_by_gene", AsyncMock(return_value={})
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )

        result = await sync_orphadata_annotations(["FOXF2"])

        statuses = replace.await_args.args[1]
        assert [(s.gene_symbol, s.row_count) for s in statuses] == [("FOXF2", 0)]
        assert result.failed == 0
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/pipeline/test_orphadata_fetch.py -v` Expected: FAIL —
`ModuleNotFoundError: No module named 'pipeline.orphadata_fetch'`.

- [ ] **Step 3: Add the config fields**

In `pipeline/config.py`, beside the ClinVar fields from Task 3:

```python
ORPHADATA_BASE_URL: Final[str] = "https://api.orphadata.com"
# Orphadata asserts its own licence in every payload. The client compares
# against this and logs loudly on a change, because the attribution block on
# the About page is tied to this exact value.
ORPHADATA_LICENCE: Final[str] = "CC-BY-4.0"
```

and, on `PipelineConfig`:

```python
orphadata_rate_limit: int = field(
    default_factory=lambda: _env_int("PIPELINE_ORPHADATA_RATE_LIMIT", 5)
)
```

Document it in `.env.example` beside the ClinVar variables from Task 3.

- [ ] **Step 4: Write the module**

```python
"""Orphadata enrichment of the ORPHAcodes ClinVar returns.

Orphadata has no gene entry point. ``rd-associated-genes/genes/HTRA1`` is a
404 -- verified 2026-08-31 -- and every endpoint is keyed by ORPHAcode. So
ClinVar is the entry point and this is the enrichment: it reads the
``Orphanet:`` rows ``clinvar_fetch`` wrote and fetches each code.

Two endpoints, and they nest differently. Cross-references live at
``data.results.ExternalReference``; phenotypes live one level deeper at
``data.results.Disorder.HPODisorderAssociation``. Reading
``results.HPODisorderAssociation`` returns nothing and looks exactly like a
disease with no phenotypes, so both paths are pinned by test.

``rd-associated-genes`` is deliberately not stored: it returns the *gene's*
OMIM number (602194 for HTRA1) beside the disease's (600142), and putting both
in one column would give "OMIM" two meanings on one gene.

The mapping qualifier is the scientific payload. ``DisorderMappingRelation``
distinguishes "E (Exact mapping: the two concepts are equivalent)" from
"NTBT (ORPHAcode is narrower than the targeted code used to represent it)" --
it says when an OMIM number is not a synonym for the Orphanet disease. Only
the leading token is stored; the parenthetical is prose that would repeat on
every row.
"""

import asyncio
import json
import logging
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Final

import httpx

from pipeline.annotations import AnnotationRow, AnnotationStatus
from pipeline.cache_utils import (
    DB_CACHE_TTL_DAYS,
    SyncResult,
    make_log_progress,
    run_batched_fetch,
    single_flight_get,
)
from pipeline.config import (
    ORPHADATA_BASE_URL,
    ORPHADATA_LICENCE,
    PipelineConfig,
)
from pipeline.http_client import AsyncHttpClientManager
from pipeline.xrefs import canonical_xref

logger = logging.getLogger(__name__)

SOURCE: Final[str] = "orphadata"
_ORPHANET_PREFIX: Final[str] = "Orphanet:"


@dataclass(slots=True)
class OrphadataReference:
    """One cross-reference or phenotype row, before it gains a gene symbol."""

    object_id: str
    object_label: str | None
    qualifier: str | None
    relation: str


@dataclass(slots=True)
class OrphadataDisease:
    """One ORPHAcode's cross-references and phenotypes."""

    orphacode: str
    preferred_term: str
    cross_references: tuple[OrphadataReference, ...]
    phenotypes: tuple[OrphadataReference, ...]
    source_date: str | None


_client_manager = AsyncHttpClientManager(timeout=30.0)
_orphadata_cache: OrderedDict[str, OrphadataDisease | None] = OrderedDict()
_cache_lock: asyncio.Lock | None = None
_orphadata_semaphore: asyncio.Semaphore | None = None
_in_flight: dict[str, asyncio.Task[OrphadataDisease | None]] = {}


def _get_cache_lock() -> asyncio.Lock:
    """Get cache lock, initializing lazily if needed."""
    global _cache_lock
    if _cache_lock is None:
        _cache_lock = asyncio.Lock()
    return _cache_lock


def _get_orphadata_semaphore(
    config: PipelineConfig | None = None,
) -> asyncio.Semaphore:
    """Get Orphadata rate-limit semaphore, initializing lazily if needed."""
    global _orphadata_semaphore
    if _orphadata_semaphore is None:
        limit = (
            config.orphadata_rate_limit
            if config
            else PipelineConfig().orphadata_rate_limit
        )
        _orphadata_semaphore = asyncio.Semaphore(limit)
    return _orphadata_semaphore


async def close_orphadata_client() -> None:
    """Close shared HTTP client (call at shutdown)."""
    await _client_manager.close()


def clear_orphadata_cache() -> None:
    """Clear the Orphadata cache and any in-flight task references."""
    global _orphadata_cache
    _orphadata_cache = OrderedDict()
    _in_flight.clear()


def _parse_cross_references(results: dict[str, Any]) -> list[OrphadataReference]:
    """Cross-references for one disorder, in a deterministic order."""
    references: list[OrphadataReference] = []
    for entry in results.get("ExternalReference") or []:
        xref = canonical_xref(
            str(entry.get("Source", "")), str(entry.get("Reference", ""))
        )
        if xref is None:
            continue
        relation_text = str(entry.get("DisorderMappingRelation") or "")
        references.append(
            OrphadataReference(
                object_id=xref,
                object_label=None,
                # "E (Exact mapping: ...)" -> "E". The parenthetical is prose
                # that would repeat identically on every row.
                qualifier=relation_text.split(" ", 1)[0] or None,
                relation="disease_xref",
            )
        )
    return sorted(references, key=lambda r: r.object_id)


def _parse_phenotypes(results: dict[str, Any]) -> list[OrphadataReference]:
    """HPO terms with frequency.

    Note the extra ``Disorder`` level -- this endpoint nests one deeper than
    ``rd-cross-referencing`` does, and reading ``results`` directly silently
    yields nothing.
    """
    disorder = results.get("Disorder") or {}
    phenotypes: list[OrphadataReference] = []
    for entry in disorder.get("HPODisorderAssociation") or []:
        hpo = entry.get("HPO") or {}
        hpo_id = str(hpo.get("HPOId") or "").strip()
        if not hpo_id:
            continue
        phenotypes.append(
            OrphadataReference(
                object_id=hpo_id,
                object_label=str(hpo.get("HPOTerm") or "") or None,
                qualifier=str(entry.get("HPOFrequency") or "") or None,
                relation="phenotype",
            )
        )
    return phenotypes


@dataclass(slots=True)
class _Fetched:
    """One endpoint's outcome, wrapped so the three cases stay distinguishable.

    ``_get_results`` returns ``None`` for a transport failure and a ``_Fetched``
    otherwise, whose ``results`` is ``None`` for a confirmed 404. A bare
    ``dict | bool | None`` union does not narrow -- after the ``is None`` and
    ``is False`` guards a type checker still sees ``bool`` in the union and
    rejects ``.get()`` on it.
    """

    results: dict[str, Any] | None


async def _get_results(path: str, orphacode: str) -> _Fetched | None:
    """Fetch one endpoint. None is a failure; ``_Fetched(None)`` is a 404."""
    url = f"{ORPHADATA_BASE_URL}/{path}/orphacodes/{orphacode}"
    try:
        client = await _client_manager.get()
        resp = await client.get(url, headers={"accept": "application/json"})
        if resp.status_code == 404:
            return _Fetched(None)
        if resp.status_code != 200:
            logger.warning(
                f"Orphadata {path} failed for {orphacode}: {resp.status_code}"
            )
            return None
        data = resp.json().get("data") or {}
    except httpx.TimeoutException:
        logger.warning(f"Timeout querying Orphadata {path} for {orphacode}")
        return None
    except httpx.RequestError as e:
        logger.warning(f"Request error on Orphadata {path} for {orphacode}: {e}")
        return None
    except (ValueError, json.JSONDecodeError) as e:
        logger.warning(f"Failed to parse Orphadata {path} for {orphacode}: {e}")
        return None

    licence = (data.get("__licence") or {}).get("identifier")
    if licence and licence != ORPHADATA_LICENCE:
        logger.error(
            f"Orphadata now reports licence {licence!r}, not {ORPHADATA_LICENCE!r}. "
            "The attribution published on the About page is tied to that value -- "
            "review it before publishing this run."
        )
    return _Fetched(data.get("results") or {})


async def fetch_orphadata_disease(
    orphacode: str, config: PipelineConfig | None = None
) -> OrphadataDisease | None:
    """Fetch one ORPHAcode's cross-references and phenotypes.

    Two ORPHAcodes can reach the same disease from different genes, so this
    goes through ``single_flight_get`` like every other fetcher here.
    """
    return await single_flight_get(
        orphacode,
        cache=_orphadata_cache,
        cache_lock=_get_cache_lock(),
        in_flight=_in_flight,
        semaphore=_get_orphadata_semaphore(config),
        fetch_fn=lambda: _fetch_orphadata_uncached(orphacode),
        label="Orphadata cache",
    )


async def _fetch_orphadata_uncached(orphacode: str) -> OrphadataDisease | None:
    """Internal: fetch both endpoints without caching.

    A 404 is a confirmed absence and returns an empty disease; a 5xx or a
    transport error returns None so the caller does not cache it.
    """
    fetched_xrefs = await _get_results("rd-cross-referencing", orphacode)
    if fetched_xrefs is None:
        return None
    if fetched_xrefs.results is None:
        return OrphadataDisease(
            orphacode=orphacode,
            preferred_term="",
            cross_references=(),
            phenotypes=(),
            source_date=None,
        )
    xref_results = fetched_xrefs.results

    fetched_phenotypes = await _get_results("rd-phenotypes", orphacode)
    if fetched_phenotypes is None:
        return None
    phenotype_results = fetched_phenotypes.results or {}

    return OrphadataDisease(
        orphacode=orphacode,
        preferred_term=str(xref_results.get("Preferred term") or ""),
        cross_references=tuple(_parse_cross_references(xref_results)),
        phenotypes=tuple(_parse_phenotypes(phenotype_results)),
        source_date=str(xref_results.get("Date") or "") or None,
    )


async def orphacodes_by_gene() -> dict[str, list[tuple[str, str]]]:
    """Map each gene to the (orphacode, group_key) pairs ClinVar found for it."""
    from pipeline.database import read_gene_annotations

    rows = await read_gene_annotations(source="clinvar")
    found: dict[str, list[tuple[str, str]]] = {}
    for row in rows:
        object_id = str(row["object_id"])
        if not object_id.startswith(_ORPHANET_PREFIX):
            continue
        pair = (object_id.removeprefix(_ORPHANET_PREFIX), str(row["group_key"]))
        codes = found.setdefault(str(row["gene_symbol"]), [])
        if pair not in codes:
            codes.append(pair)
    return found


async def sync_orphadata_annotations(
    gene_symbols: list[str],
    config: PipelineConfig | None = None,
) -> SyncResult:
    """Sync Orphadata enrichment for genes that have an ORPHAcode.

    A gene with no ORPHAcode gets a zero-count status row rather than being
    skipped: there is no gene entry point, so "no ORPHAcode" is the final
    answer for this source, not a reason to retry every run.
    """
    from pipeline.database import get_annotation_statuses, replace_gene_annotations

    cached = await get_annotation_statuses(
        gene_symbols, SOURCE, max_age_days=DB_CACHE_TTL_DAYS
    )
    to_fetch = [s for s in gene_symbols if s not in cached]

    logger.info(f"Orphadata sync: {len(cached)} cached, {len(to_fetch)} to fetch")

    if not to_fetch:
        return SyncResult(fetched=0, cached=len(cached), failed=0, errors=[])

    by_gene = await orphacodes_by_gene()
    wanted = sorted(
        {code for symbol in to_fetch for code, _ in by_gene.get(symbol, [])}
    )

    results = await run_batched_fetch(
        wanted, fetch_orphadata_disease, make_log_progress("Orphadata fetch")
    )
    diseases = {
        code: disease
        for code, disease in zip(wanted, results, strict=True)
        if disease is not None
    }

    rows: list[AnnotationRow] = []
    statuses: list[AnnotationStatus] = []
    errors = [f"Orphadata fetch failed: {c}" for c in wanted if c not in diseases]

    for symbol in to_fetch:
        gene_rows: list[AnnotationRow] = []
        for code, group_key in by_gene.get(symbol, []):
            disease = diseases.get(code)
            if disease is None:
                continue
            for reference in (*disease.cross_references, *disease.phenotypes):
                gene_rows.append(
                    AnnotationRow(
                        gene_symbol=symbol,
                        source=SOURCE,
                        relation=reference.relation,
                        group_key=group_key,
                        object_id=reference.object_id,
                        object_label=reference.object_label or disease.preferred_term,
                        qualifier=reference.qualifier,
                        score=None,
                        evidence_count=None,
                        source_version=disease.source_date,
                    )
                )
        rows.extend(gene_rows)
        statuses.append(
            AnnotationStatus(
                gene_symbol=symbol,
                source=SOURCE,
                row_count=len(gene_rows),
                source_version=None,
            )
        )

    await replace_gene_annotations(rows, statuses)

    return SyncResult(
        fetched=len(statuses),
        cached=len(cached),
        failed=len(errors),
        errors=errors,
    )
```

- [ ] **Step 5: Add the autouse reset fixture**

In `tests/pipeline/conftest.py`, beside `_reset_clinvar_client`:

```python
@pytest.fixture(autouse=True)
def _reset_orphadata_client():
    """Clear the shared orphadata_fetch HTTP client and cache after each test."""
    from collections import OrderedDict

    yield
    import pipeline.orphadata_fetch as od

    od._client_manager.reset()
    od._orphadata_cache = OrderedDict()
    od._orphadata_semaphore = None
    od._cache_lock = None
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/test_orphadata_fetch.py -v` Expected: PASS,
12 tests.

- [ ] **Step 7: Prove the two nesting paths against the real API once**

```bash
uv run python -c "
import asyncio
from pipeline.orphadata_fetch import fetch_orphadata_disease, close_orphadata_client

async def main():
    d = await fetch_orphadata_disease('199354')
    print(d.preferred_term)
    print('xrefs:', [(r.object_id, r.qualifier) for r in d.cross_references])
    print('phenotypes:', len(d.phenotypes), d.phenotypes[:2])
    await close_orphadata_client()

asyncio.run(main())
"
```

Expected: the preferred term is the CARASIL long name; the cross-references
include `('MONDO:0010829', 'E')`, `('OMIM:600142', 'E')`,
`('MeSH:C563990', 'E')` and **no ICD row**; the phenotype list is **non-empty**
and starts with `HP:0000708` / "Atypical behavior" / "Frequent (79-30%)". An
empty phenotype list means the `Disorder` level is being skipped.

- [ ] **Step 8: Lint, type-check and commit**

```bash
uv run ruff check pipeline/orphadata_fetch.py pipeline/config.py tests/pipeline/
uv run ty check pipeline/orphadata_fetch.py
uv run pytest tests/pipeline/test_orphadata_fetch.py --cov=pipeline.orphadata_fetch \
  --cov-branch --cov-report=term-missing
git add pipeline/orphadata_fetch.py pipeline/config.py tests/pipeline/conftest.py \
  tests/pipeline/test_orphadata_fetch.py
git commit -m "Enrich ClinVar's ORPHAcodes from Orphadata"
```

Expected: ruff and ty clean, module at 100% with no missing branches.

---

### Task 5: Anchor genes and score diseases with Open Targets

**Files:**

- Create: `pipeline/opentargets_fetch.py`
- Modify: `pipeline/config.py`
- Modify: `tests/pipeline/conftest.py`
- Test: `tests/pipeline/test_opentargets_fetch.py`

**Interfaces:**

- Consumes: `pipeline.xrefs.canonical_from_compact`, `canonical_xref` (Task 1) —
  identity ids included, so no client builds a prefix with an f-string;
  `pipeline.annotations.AnnotationRow`, `AnnotationStatus` (Task 2);
  `pipeline.database.get_annotation_statuses`, `replace_gene_annotations` (Task
  2). Independent of Tasks 3 and 4.
- Produces:
  `graphql(query: str, variables: dict[str, Any]) -> dict[str, Any] | None` —
  **the shared transport Task 6 imports**; `fetch_data_version() -> str | None`;
  `resolve_target(gene_symbol: str) -> str | None`;
  `fetch_opentargets_target(gene_symbol: str, config: PipelineConfig | None = None) -> OpenTargetsTarget | None`;
  `sync_opentargets_annotations(gene_symbols: list[str], config: PipelineConfig | None = None) -> SyncResult`;
  `close_opentargets_client() -> None`; `clear_opentargets_cache() -> None`.

**This is the one new protocol in the plan** — a GraphQL POST — and it is
deliberately not a client library. One `httpx` POST with a JSON body of
`{"query": ..., "variables": ...}` is the whole transport; adding `gql` or
`httpx-graphql` for that would be a dependency for string interpolation.

**The version is read, pinned and recorded, because the API says it is Beta.**
`{ meta { name apiVersion { x y z } dataVersion { year month iteration } } }`
returned on 2026-08-31:

```json
{
  "meta": {
    "name": "Open Targets GraphQL & REST API Beta",
    "apiVersion": { "x": "26", "y": "6", "z": "3" },
    "dataVersion": { "year": "26", "month": "06", "iteration": null }
  }
}
```

Every row this module writes carries `source_version = "26.06"`, and the sync
warns when the live version differs from `opentargets_data_version`. That is the
contract test the earlier evaluation asked for, done without a network call in
CI: the assertion lives in the run, not in pytest.

**Two schema traps, both hit live and both pinned by test.** `GeneOntologyTerm`
exposes `label`, **not** `name` — `term { id name }` is a GraphQL error, not an
empty field. And `Target.knownDrugs` no longer exists; it was replaced by
`drugAndClinicalCandidates`, whose row type is `ClinicalTargetFromTarget`, which
takes no `size` argument and carries no `phase`, `status` or `drugType`. **This
task queries neither** — Task 6 gets mechanisms from `Drug.mechanismsOfAction`,
which is stable.

**What each relation stores**, from the verified HTRA1 response:

| relation        | object_id                              | label             | qualifier | score  |
| --------------- | -------------------------------------- | ----------------- | --------- | ------ |
| `identity`      | `Ensembl:ENSG00000166033`, `HGNC:9476` | approved name     | biotype   | —      |
| `disease`       | `MONDO:0014768`                        | disease name      | —         | 0.7588 |
| `gene_ontology` | `GO:0005515`                           | `protein binding` | `F/IPI`   | —      |

`dbXrefs` is filtered rather than stored whole: HTRA1's 30-odd entries are
mostly PDB structure accessions, which say nothing about gene identity.
`associatedDiseases` returns **490 rows** for HTRA1, so it is paged at
`opentargets_max_diseases` (default 25) — unlike ClinVar's records, these are
ranked by the API itself, so taking the top N is a documented ranking rather
than an arbitrary sample. The GO aspect and evidence code are joined into one
qualifier (`"F/IPI"`) rather than adding a column used by one source.

- [ ] **Step 1: Write the failing tests**

```python
"""Open Targets gene identity, disease associations and GO terms."""

import json
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from pipeline.opentargets_fetch import (
    _parse_target,
    fetch_data_version,
    fetch_opentargets_target,
    graphql,
    resolve_target,
)


def _ok(payload: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, text=json.dumps({"data": payload}))


class TestGraphql:
    async def test_posts_query_and_variables_as_json(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_ok({"meta": {}}))
        mocker.patch(
            "pipeline.opentargets_fetch._client_manager.get", return_value=mock_client
        )

        await graphql("query Q($x: String!) { a }", {"x": "HTRA1"})

        body = mock_client.post.call_args.kwargs["json"]
        assert body["query"].startswith("query Q")
        assert body["variables"] == {"x": "HTRA1"}

    async def test_graphql_errors_are_logged_and_return_none(
        self, mocker, caplog
    ) -> None:
        """A schema drift arrives as a 200 with an errors array, not a 4xx."""
        resp = httpx.Response(
            200,
            text=json.dumps(
                {
                    "errors": [
                        {"message": "Cannot query field 'name' on type "
                                    "'GeneOntologyTerm'."}
                    ]
                }
            ),
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=resp)
        mocker.patch(
            "pipeline.opentargets_fetch._client_manager.get", return_value=mock_client
        )

        assert await graphql("{ x }", {}) is None
        assert "GeneOntologyTerm" in caplog.text

    async def test_a_timeout_returns_none(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.TimeoutException("slow"))
        mocker.patch(
            "pipeline.opentargets_fetch._client_manager.get", return_value=mock_client
        )

        assert await graphql("{ x }", {}) is None


class TestFetchDataVersion:
    async def test_joins_year_and_month(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_fetch.graphql",
            AsyncMock(
                return_value={
                    "meta": {"dataVersion": {"year": "26", "month": "06"}}
                }
            ),
        )
        assert await fetch_data_version() == "26.06"

    async def test_a_failed_meta_query_is_none_not_a_crash(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_fetch.graphql", AsyncMock(return_value=None)
        )
        assert await fetch_data_version() is None


class TestResolveTarget:
    async def test_returns_the_first_exact_symbol_match(self, mocker) -> None:
        """HTRA1 and HTRA1-AS1 both hit; only the exact symbol is the target."""
        mocker.patch(
            "pipeline.opentargets_fetch.graphql",
            AsyncMock(
                return_value={
                    "search": {
                        "hits": [
                            {
                                "id": "ENSG00000285955",
                                "object": {"approvedSymbol": "HTRA1-AS1"},
                            },
                            {
                                "id": "ENSG00000166033",
                                "object": {"approvedSymbol": "HTRA1"},
                            },
                        ]
                    }
                }
            ),
        )
        assert await resolve_target("HTRA1") == "ENSG00000166033"

    async def test_no_exact_match_resolves_to_nothing(self, mocker) -> None:
        """COL4A1/2 is a compound curator label, not a gene symbol."""
        mocker.patch(
            "pipeline.opentargets_fetch.graphql",
            AsyncMock(return_value={"search": {"hits": []}}),
        )
        assert await resolve_target("COL4A1/2") is None


class TestParseTarget:
    def _payload(self) -> dict[str, Any]:
        return {
            "id": "ENSG00000166033",
            "approvedSymbol": "HTRA1",
            "approvedName": "HtrA serine peptidase 1",
            "biotype": "protein_coding",
            "dbXrefs": [
                {"id": "9476", "source": "HGNC"},
                {"id": "2JOA", "source": "PDB"},
                {"id": "3NUM", "source": "PDB"},
            ],
            "geneOntology": [
                {
                    "aspect": "F",
                    "evidence": "IPI",
                    "source": "PMID:25002585",
                    "term": {"id": "GO:0005515", "label": "protein binding"},
                },
                {
                    "aspect": "C",
                    "evidence": "IEA",
                    "source": "GO_REF:0000044",
                    "term": {"id": "GO:0005576", "label": "extracellular region"},
                },
            ],
            "associatedDiseases": {
                "count": 490,
                "rows": [
                    {
                        "score": 0.7588060448267118,
                        "disease": {
                            "id": "MONDO_0014768",
                            "name": "cerebral arteriopathy, type 2",
                        },
                    },
                    {
                        "score": 0.7525744067902492,
                        "disease": {"id": "Orphanet_199354", "name": "CARASIL"},
                    },
                    {
                        "score": 0.5,
                        "disease": {"id": "OTAR_0000018", "name": "genetic disease"},
                    },
                ],
            },
        }

    def test_identity_rows_drop_the_pdb_noise(self) -> None:
        rows = _parse_target("HTRA1", self._payload(), "26.06")
        identity = [r for r in rows if r.relation == "identity"]
        assert {r.object_id for r in identity} == {
            "Ensembl:ENSG00000166033",
            "HGNC:9476",
        }
        assert all(r.qualifier == "protein_coding" for r in identity)

    def test_disease_rows_carry_the_score_and_a_canonical_id(self) -> None:
        rows = _parse_target("HTRA1", self._payload(), "26.06")
        diseases = {r.object_id: r for r in rows if r.relation == "disease"}
        assert set(diseases) == {"MONDO:0014768", "Orphanet:199354"}
        assert diseases["MONDO:0014768"].score == pytest.approx(0.7588060448267118)
        assert diseases["MONDO:0014768"].group_key == "MONDO:0014768"

    def test_a_therapeutic_area_id_is_not_stored_as_a_disease(self) -> None:
        """OTAR_ is Open Targets' own bucket, not a disease ontology."""
        rows = _parse_target("HTRA1", self._payload(), "26.06")
        assert not any("OTAR" in r.object_id for r in rows)

    def test_go_rows_join_aspect_and_evidence_into_one_qualifier(self) -> None:
        rows = _parse_target("HTRA1", self._payload(), "26.06")
        go = {r.object_id: r for r in rows if r.relation == "gene_ontology"}
        assert go["GO:0005515"].qualifier == "F/IPI"
        assert go["GO:0005515"].object_label == "protein binding"
        assert go["GO:0005515"].group_key == ""

    def test_every_row_carries_the_data_version(self) -> None:
        rows = _parse_target("HTRA1", self._payload(), "26.06")
        assert {r.source_version for r in rows} == {"26.06"}

    def test_rows_are_deduplicated(self) -> None:
        """GO returns 43 rows for HTRA1 and repeats GO:0005515 with two PMIDs."""
        payload = self._payload()
        payload["geneOntology"].append(
            {
                "aspect": "F",
                "evidence": "IPI",
                "source": "PMID:21622153",
                "term": {"id": "GO:0005515", "label": "protein binding"},
            }
        )
        rows = _parse_target("HTRA1", payload, "26.06")
        go_ids = [r.object_id for r in rows if r.relation == "gene_ontology"]
        assert len(go_ids) == len(set(go_ids))


class TestFetchOpenTargetsTarget:
    async def test_an_unresolvable_symbol_yields_an_empty_target(
        self, mocker
    ) -> None:
        mocker.patch(
            "pipeline.opentargets_fetch.resolve_target", AsyncMock(return_value=None)
        )
        mocker.patch(
            "pipeline.opentargets_fetch.fetch_data_version",
            AsyncMock(return_value="26.06"),
        )

        target = await fetch_opentargets_target("COL4A1/2")

        assert target is not None
        assert target.rows == ()
        assert target.ensembl_id is None
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/pipeline/test_opentargets_fetch.py -v` Expected: FAIL
— `ModuleNotFoundError: No module named 'pipeline.opentargets_fetch'`.

- [ ] **Step 3: Add the config fields**

```python
OPENTARGETS_GRAPHQL_URL: Final[str] = (
    "https://api.platform.opentargets.org/api/v4/graphql"
)
```

and, on `PipelineConfig`:

```python
opentargets_rate_limit: int = field(
    default_factory=lambda: _env_int("PIPELINE_OPENTARGETS_RATE_LIMIT", 5)
)
# The API self-describes as Beta and its schema has already shifted once
# (knownDrugs -> drugAndClinicalCandidates). Every row records the version
# it came from, and the sync warns when the live one differs from this.
opentargets_data_version: str = field(
    default_factory=lambda: _env_str("PIPELINE_OPENTARGETS_DATA_VERSION", "26.06")
)
# associatedDiseases returns 490 rows for HTRA1, ranked by the API. Taking
# the top N is a documented ranking, not an arbitrary sample.
opentargets_max_diseases: int = field(
    default_factory=lambda: _env_int("PIPELINE_OPENTARGETS_MAX_DISEASES", 25)
)
```

Document all three in `.env.example`, which completes the six new variables this
plan adds.

- [ ] **Step 4: Write the module**

```python
"""Open Targets gene identity, disease associations and GO terms.

One httpx POST with a JSON body is the whole GraphQL transport; a client
library for that would be a dependency for string interpolation. ``graphql``
is shared with ``opentargets_drugs``.

The API self-describes as "Open Targets GraphQL & REST API Beta" and its schema
has already shifted once, so every row records the data version it came from
and the sync warns when the live version differs from the pinned one. Two
traps were hit live on 2026-08-31 and are pinned by test:

* ``GeneOntologyTerm`` exposes ``label``, not ``name``. ``term { id name }`` is
  a GraphQL error -- which arrives as a 200 with an ``errors`` array, not a 4xx.
* ``Target.knownDrugs`` is gone, replaced by ``drugAndClinicalCandidates``
  (row type ``ClinicalTargetFromTarget``, no ``size`` argument, no ``phase`` /
  ``status`` / ``drugType``). Neither is queried here; mechanisms come from
  ``Drug.mechanismsOfAction`` in ``opentargets_drugs``.

``dbXrefs`` is filtered rather than stored whole -- HTRA1's 30-odd entries are
mostly PDB structure accessions, which say nothing about gene identity.
"""

import asyncio
import json
import logging
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Final

import httpx

from pipeline.annotations import AnnotationRow, AnnotationStatus
from pipeline.cache_utils import (
    DB_CACHE_TTL_DAYS,
    SyncResult,
    make_log_progress,
    run_batched_fetch,
    single_flight_get,
)
from pipeline.config import OPENTARGETS_GRAPHQL_URL, PipelineConfig
from pipeline.http_client import AsyncHttpClientManager
from pipeline.xrefs import canonical_from_compact, canonical_xref

logger = logging.getLogger(__name__)

SOURCE: Final[str] = "opentargets"

# Identity authorities worth storing. Everything else dbXrefs returns for a
# human gene is structural (PDB) or redundant with Ensembl.
_IDENTITY_SOURCES: Final[frozenset[str]] = frozenset({"HGNC"})

_META_QUERY: Final[str] = (
    "{ meta { dataVersion { year month } } }"
)

_SEARCH_QUERY: Final[str] = """
query Resolve($q: String!) {
  search(queryString: $q, entityNames: ["target"], page: {index: 0, size: 5}) {
    hits { id object { ... on Target { approvedSymbol } } }
  }
}
"""

# term { id label } -- NOT name. GeneOntologyTerm has no name field.
_TARGET_QUERY: Final[str] = """
query Target($id: String!, $diseases: Int!) {
  target(ensemblId: $id) {
    id
    approvedSymbol
    approvedName
    biotype
    dbXrefs { id source }
    geneOntology { aspect evidence source term { id label } }
    associatedDiseases(page: {index: 0, size: $diseases}) {
      count
      rows { score disease { id name } }
    }
  }
}
"""


@dataclass(slots=True)
class OpenTargetsTarget:
    """One gene's Open Targets annotations."""

    gene_symbol: str
    ensembl_id: str | None
    rows: tuple[AnnotationRow, ...]
    data_version: str | None


_client_manager = AsyncHttpClientManager(timeout=60.0)
_target_cache: OrderedDict[str, OpenTargetsTarget | None] = OrderedDict()
_cache_lock: asyncio.Lock | None = None
_opentargets_semaphore: asyncio.Semaphore | None = None
_in_flight: dict[str, asyncio.Task[OpenTargetsTarget | None]] = {}


def _get_cache_lock() -> asyncio.Lock:
    """Get cache lock, initializing lazily if needed."""
    global _cache_lock
    if _cache_lock is None:
        _cache_lock = asyncio.Lock()
    return _cache_lock


def _get_opentargets_semaphore(
    config: PipelineConfig | None = None,
) -> asyncio.Semaphore:
    """Get Open Targets rate-limit semaphore, initializing lazily if needed."""
    global _opentargets_semaphore
    if _opentargets_semaphore is None:
        limit = (
            config.opentargets_rate_limit
            if config
            else PipelineConfig().opentargets_rate_limit
        )
        _opentargets_semaphore = asyncio.Semaphore(limit)
    return _opentargets_semaphore


async def close_opentargets_client() -> None:
    """Close shared HTTP client (call at shutdown)."""
    await _client_manager.close()


def clear_opentargets_cache() -> None:
    """Clear the Open Targets cache and any in-flight task references."""
    global _target_cache
    _target_cache = OrderedDict()
    _in_flight.clear()


async def graphql(query: str, variables: dict[str, Any]) -> dict[str, Any] | None:
    """POST one GraphQL query. Returns the ``data`` object, or None.

    A schema drift arrives as a **200 with an ``errors`` array**, not a 4xx, so
    the errors check is not optional -- without it a renamed field looks like
    an empty result and silently writes zero rows.
    """
    try:
        client = await _client_manager.get()
        resp = await client.post(
            OPENTARGETS_GRAPHQL_URL, json={"query": query, "variables": variables}
        )
        if resp.status_code != 200:
            logger.warning(f"Open Targets returned {resp.status_code}")
            return None
        payload = resp.json()
    except httpx.TimeoutException:
        logger.warning("Timeout querying Open Targets")
        return None
    except httpx.RequestError as e:
        logger.warning(f"Request error querying Open Targets: {e}")
        return None
    except (ValueError, json.JSONDecodeError) as e:
        logger.warning(f"Failed to parse Open Targets response: {e}")
        return None

    if errors := payload.get("errors"):
        messages = "; ".join(str(e.get("message", e)) for e in errors)
        logger.error(f"Open Targets GraphQL error -- schema drift? {messages}")
        return None
    return payload.get("data")


async def fetch_data_version() -> str | None:
    """Return the live data version as ``"26.06"``, or None."""
    data = await graphql(_META_QUERY, {})
    if not data:
        return None
    version = ((data.get("meta") or {}).get("dataVersion")) or {}
    year, month = version.get("year"), version.get("month")
    if not year or not month:
        return None
    return f"{year}.{month}"


async def resolve_target(gene_symbol: str) -> str | None:
    """Resolve a bare symbol to its Ensembl gene ID.

    Exact ``approvedSymbol`` match only. A substring search for HTRA1 also
    returns HTRA1-AS1, an antisense lncRNA that is a different gene.
    """
    data = await graphql(_SEARCH_QUERY, {"q": gene_symbol})
    if not data:
        return None
    for hit in ((data.get("search") or {}).get("hits")) or []:
        approved = ((hit.get("object") or {}).get("approvedSymbol")) or ""
        if approved.upper() == gene_symbol.upper():
            return str(hit.get("id")) or None
    return None


def _parse_target(
    gene_symbol: str, target: dict[str, Any], data_version: str | None
) -> list[AnnotationRow]:
    """Turn one target payload into annotation rows, deduplicated and sorted."""
    biotype = str(target.get("biotype") or "") or None
    approved_name = str(target.get("approvedName") or "") or None
    rows: dict[tuple[str, str, str], AnnotationRow] = {}

    def add(
        relation: str,
        group_key: str,
        object_id: str,
        label: str | None,
        qualifier: str | None,
        score: float | None,
    ) -> None:
        rows.setdefault(
            (relation, group_key, object_id),
            AnnotationRow(
                gene_symbol=gene_symbol,
                source=SOURCE,
                relation=relation,
                group_key=group_key,
                object_id=object_id,
                object_label=label,
                qualifier=qualifier,
                score=score,
                evidence_count=None,
                source_version=data_version,
            ),
        )

    # Through canonical_xref, not an f-string: pipeline/xrefs.py is the one
    # place a prefix spelling is decided, identity included.
    if ensembl := canonical_xref("Ensembl", str(target.get("id") or "")):
        add("identity", "", ensembl, approved_name, biotype, None)
    for xref in target.get("dbXrefs") or []:
        source = str(xref.get("source") or "")
        if source not in _IDENTITY_SOURCES:
            continue
        identity = canonical_xref(source, str(xref.get("id") or ""))
        if identity is None:
            continue
        add("identity", "", identity, approved_name, biotype, None)

    for entry in target.get("geneOntology") or []:
        term = entry.get("term") or {}
        go_id = str(term.get("id") or "")
        if not go_id:
            continue
        aspect = str(entry.get("aspect") or "")
        evidence = str(entry.get("evidence") or "")
        add(
            "gene_ontology",
            "",
            go_id,
            str(term.get("label") or "") or None,
            f"{aspect}/{evidence}".strip("/") or None,
            None,
        )

    associated = target.get("associatedDiseases") or {}
    for row in associated.get("rows") or []:
        disease = row.get("disease") or {}
        # OTAR_ ids are Open Targets' own therapeutic-area buckets, not
        # disease-ontology terms, and canonical_from_compact rejects them.
        xref = canonical_from_compact(str(disease.get("id") or ""))
        if xref is None:
            continue
        score = row.get("score")
        add(
            "disease",
            xref,
            xref,
            str(disease.get("name") or "") or None,
            None,
            float(score) if score is not None else None,
        )

    return sorted(rows.values(), key=AnnotationRow.sort_key)


def _warn_on_version_drift(data_version: str | None, config: PipelineConfig) -> None:
    """Log once when the live data version is not the pinned one."""
    if data_version and data_version != config.opentargets_data_version:
        logger.warning(
            f"Open Targets data version is {data_version}, pinned at "
            f"{config.opentargets_data_version} -- review "
            "PIPELINE_OPENTARGETS_DATA_VERSION before trusting this run"
        )


async def _fetch_target_uncached(
    gene_symbol: str, config: PipelineConfig, data_version: str | None
) -> OpenTargetsTarget | None:
    """Internal: resolve, fetch and parse one gene without caching.

    ``data_version`` is passed in rather than fetched here: the meta query is
    one round trip per *sync*, not one per gene, and the drift warning is one
    line in the log rather than 63 identical ones.
    """
    ensembl_id = await resolve_target(gene_symbol)
    if ensembl_id is None:
        logger.info(f"Open Targets has no target for {gene_symbol}")
        return OpenTargetsTarget(
            gene_symbol=gene_symbol,
            ensembl_id=None,
            rows=(),
            data_version=data_version,
        )

    data = await graphql(
        _TARGET_QUERY,
        {"id": ensembl_id, "diseases": config.opentargets_max_diseases},
    )
    if not data or not data.get("target"):
        return None

    return OpenTargetsTarget(
        gene_symbol=gene_symbol,
        ensembl_id=ensembl_id,
        rows=tuple(_parse_target(gene_symbol, data["target"], data_version)),
        data_version=data_version,
    )


async def fetch_opentargets_target(
    gene_symbol: str,
    config: PipelineConfig | None = None,
    data_version: str | None = None,
) -> OpenTargetsTarget | None:
    """Fetch one gene's identity, disease associations and GO terms.

    ``data_version`` is resolved here only when the caller has not already
    done so -- ``sync_opentargets_annotations`` fetches it once for the whole
    run, and a single-gene probe can omit it.
    """
    resolved = config or PipelineConfig()
    if data_version is None:
        data_version = await fetch_data_version()
        _warn_on_version_drift(data_version, resolved)
    return await single_flight_get(
        gene_symbol.upper(),
        cache=_target_cache,
        cache_lock=_get_cache_lock(),
        in_flight=_in_flight,
        semaphore=_get_opentargets_semaphore(resolved),
        fetch_fn=lambda: _fetch_target_uncached(gene_symbol, resolved, data_version),
        label="Open Targets cache",
    )


async def sync_opentargets_annotations(
    gene_symbols: list[str],
    config: PipelineConfig | None = None,
) -> SyncResult:
    """Sync Open Targets annotations for the given gene symbols."""
    from pipeline.database import get_annotation_statuses, replace_gene_annotations

    cached = await get_annotation_statuses(
        gene_symbols, SOURCE, max_age_days=DB_CACHE_TTL_DAYS
    )
    to_fetch = [s for s in gene_symbols if s not in cached]

    logger.info(f"Open Targets sync: {len(cached)} cached, {len(to_fetch)} to fetch")

    if not to_fetch:
        return SyncResult(fetched=0, cached=len(cached), failed=0, errors=[])

    # One meta query for the run. Inside the per-gene fetch this would be 63
    # round trips and 63 copies of the same drift warning.
    resolved_config = config or PipelineConfig()
    data_version = await fetch_data_version()
    _warn_on_version_drift(data_version, resolved_config)

    results = await run_batched_fetch(
        to_fetch,
        lambda symbol: fetch_opentargets_target(
            symbol, config=resolved_config, data_version=data_version
        ),
        make_log_progress("Open Targets fetch"),
    )

    rows: list[AnnotationRow] = []
    statuses: list[AnnotationStatus] = []
    errors: list[str] = []
    unresolved: list[str] = []

    for symbol, target in zip(to_fetch, results, strict=True):
        if target is None:
            errors.append(f"Open Targets fetch failed: {symbol}")
            continue
        rows.extend(target.rows)
        statuses.append(
            AnnotationStatus(
                gene_symbol=symbol,
                source=SOURCE,
                row_count=len(target.rows),
                source_version=target.data_version,
            )
        )
        if target.ensembl_id is None:
            unresolved.append(symbol)

    if unresolved:
        logger.info(
            f"No Open Targets target for {len(unresolved)} symbols: "
            f"{', '.join(unresolved)}"
        )

    await replace_gene_annotations(rows, statuses)

    return SyncResult(
        fetched=len(statuses),
        cached=len(cached),
        failed=len(errors),
        errors=errors,
    )
```

- [ ] **Step 5: Add the autouse reset fixture**

```python
@pytest.fixture(autouse=True)
def _reset_opentargets_client():
    """Clear the shared opentargets_fetch HTTP client and cache after each test."""
    from collections import OrderedDict

    yield
    import pipeline.opentargets_fetch as ot

    ot._client_manager.reset()
    ot._target_cache = OrderedDict()
    ot._opentargets_semaphore = None
    ot._cache_lock = None
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/test_opentargets_fetch.py -v` Expected: PASS,
14 tests.

- [ ] **Step 7: Prove the queries against the live schema once**

```bash
uv run python -c "
import asyncio
from pipeline.opentargets_fetch import (
    fetch_data_version, fetch_opentargets_target, close_opentargets_client)

async def main():
    print('data version:', await fetch_data_version())
    t = await fetch_opentargets_target('HTRA1')
    print('ensembl:', t.ensembl_id, 'rows:', len(t.rows))
    for relation in ('identity', 'disease', 'gene_ontology'):
        sample = [r for r in t.rows if r.relation == relation][:3]
        print(' ', relation, [(r.object_id, r.qualifier, r.score) for r in sample])
    await close_opentargets_client()

asyncio.run(main())
"
```

Expected: data version `26.06`; `ENSG00000166033`; identity rows for
`Ensembl:ENSG00000166033` and `HGNC:9476` with qualifier `protein_coding`;
disease rows including `MONDO:0014768` and `Orphanet:199354` with scores near
0.76 and 0.75; GO rows with qualifiers like `F/IPI` and `C/IEA`. **A GraphQL
error logged here means the schema moved** — read the message, fix the query,
and re-run; do not proceed with zero rows.

- [ ] **Step 8: Lint, type-check and commit**

```bash
uv run ruff check pipeline/opentargets_fetch.py pipeline/config.py tests/pipeline/
uv run ty check pipeline/opentargets_fetch.py
uv run pytest tests/pipeline/test_opentargets_fetch.py \
  --cov=pipeline.opentargets_fetch --cov-branch --cov-report=term-missing
git add pipeline/opentargets_fetch.py pipeline/config.py tests/pipeline/conftest.py \
  tests/pipeline/test_opentargets_fetch.py
git commit -m "Anchor genes and score diseases with Open Targets"
```

Expected: ruff and ty clean, module at 100% with no missing branches.

---

### Task 6: Verify Table 2's mechanisms against Open Targets

**Files:**

- Create: `pipeline/opentargets_drugs.py`
- Test: `tests/pipeline/test_opentargets_drugs.py`

**Interfaces:**

- Consumes: `pipeline.opentargets_fetch.graphql`, `fetch_data_version` (Task 5);
  `pipeline.annotations.DrugAnnotationRow` (Task 2);
  `pipeline.database.upsert_drug_annotations` (Task 2).
- Produces: `strip_trade_suffix(name: str) -> str`;
  `fetch_drug_mechanism(drug: str, data_version: str | None) -> DrugAnnotationRow | None`
  — `None` for a transport failure, a `resolved=False` row for a drug ChEMBL
  genuinely does not index;
  `sync_trial_drug_annotations(config: PipelineConfig | None = None) -> SyncResult`.

**This is a verification task, and the measurement says so.** All 11 drugs in
`data/table2.json` were resolved against the live API on 2026-08-31:

| drug                                  | resolves       | Open Targets mechanism                             | curator's parenthetical       |
| ------------------------------------- | -------------- | -------------------------------------------------- | ----------------------------- |
| Cilostazol                            | `CHEMBL799`    | INHIBITOR · Phosphodiesterase 3A inhibitor         | phosphodiesterase 3 inhibitor |
| Colchicine                            | `CHEMBL107`    | INHIBITOR · Tubulin inhibitor                      | tubulin beta chain inhibitor  |
| Exenatide                             | `CHEMBL414357` | AGONIST · Glucagon-like peptide 1 receptor agonist | GLP-1 agonist                 |
| Isosorbide mononitrate                | `CHEMBL1311`   | ACTIVATOR · Soluble guanylate cyclase activator    | nitrate                       |
| Tranexamic acid                       | `CHEMBL877`    | INHIBITOR · Plasminogen inhibitor                  | plasminogen inhibitor         |
| Edaravone                             | `CHEMBL290916` | _(resolves, no mechanism rows)_                    | free radical scavenger        |
| Butylphthalide (NBP)                  | —              | —                                                  | —                             |
| Cerebrolysin                          | —              | —                                                  | —                             |
| Mivelsiran (ALN-APP)                  | —              | —                                                  | —                             |
| Palm tocotrienols complex (HOV-12020) | —              | —                                                  | —                             |
| THN391                                | —              | —                                                  | —                             |

**6 of 11 resolve, 5 carry a mechanism, and every one of the 5 agrees with the
curator.** The five that do not resolve are unregistered agents, a peptide
preparation and a trade-named complex that ChEMBL does not carry — that is a
coverage limit of the reference database, not an error in the curated column.

So this task cannot and must not _replace_
`clinical_trials.mechanism_of_action`. It records what Open Targets says beside
it, `resolved` flag included, so the agreement is on the record and a future
divergence is visible. The curator's strings are richer anyway: "Antiplatelet,
vasodilator (phosphodiesterase 3 inhibitor)" carries a clinical class ChEMBL's
action type does not.

**Unresolved is not failed, and the counters must say so.** Five of eleven drugs
are expected to be absent from ChEMBL on every healthy run, so counting them in
`SyncResult.failed` would set `status: "failed"` on the sync forever and train a
reader to ignore it. `failed` and `errors` carry transport failures only —
`fetch_drug_mechanism` returns `None` for those, the way every other fetcher in
this plan does, and a `resolved=False` row for a drug the API answered about and
does not have. The 6-of-11 resolution rate is the measurement this task exists
to produce; it is reported in the run log and by the `trial_drug_annotations`
query in Task 7 Step 6, not as a failure count.

**The `targets` field is a second, free cross-check.** Open Targets returns
`targets[].approvedSymbol` per mechanism, and those match `geneticTarget` in
`data/table2.json` — `PDE3A`, `PLG`, `GLP1R`, the `GUCY1*` family for the
guanylate cyclase activator, the `TUBB*` family for tubulin. Storing them lets a
test compare the curated target list against the reference one.

**Trade suffixes must be stripped before searching.** `"Mivelsiran (ALN-APP)"`
and `"Palm tocotrienols complex (HOV-12020)"` carry a development code in
parentheses; the search takes the part before it. That is why
`strip_trade_suffix` exists and is tested separately — it is the difference
between 6 hits and 4.

- [ ] **Step 1: Write the failing tests**

```python
"""Open Targets verification of the trial drug mechanisms."""

from typing import Any
from unittest.mock import AsyncMock

import pytest

from pipeline.opentargets_drugs import (
    fetch_drug_mechanism,
    strip_trade_suffix,
    sync_trial_drug_annotations,
)


class TestStripTradeSuffix:
    def test_removes_a_development_code(self) -> None:
        assert strip_trade_suffix("Mivelsiran (ALN-APP)") == "Mivelsiran"
        assert strip_trade_suffix("Butylphthalide (NBP)") == "Butylphthalide"
        assert (
            strip_trade_suffix("Palm tocotrienols complex (HOV-12020)")
            == "Palm tocotrienols complex"
        )

    def test_leaves_a_bare_name_alone(self) -> None:
        assert strip_trade_suffix("Cilostazol") == "Cilostazol"
        assert strip_trade_suffix("Tranexamic acid") == "Tranexamic acid"
        assert strip_trade_suffix("THN391") == "THN391"


class TestFetchDrugMechanism:
    def _hit(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "search": {
                "hits": [
                    {
                        "object": {
                            "id": "CHEMBL799",
                            "name": "CILOSTAZOL",
                            "mechanismsOfAction": {"rows": rows},
                        }
                    }
                ]
            }
        }

    async def test_records_action_type_mechanism_and_targets(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_drugs.graphql",
            AsyncMock(
                return_value=self._hit(
                    [
                        {
                            "actionType": "INHIBITOR",
                            "mechanismOfAction": "Phosphodiesterase 3A inhibitor",
                            "targets": [{"approvedSymbol": "PDE3A"}],
                        }
                    ]
                )
            ),
        )

        row = await fetch_drug_mechanism("Cilostazol", "26.06")

        assert row.resolved is True
        assert row.chembl_id == "CHEMBL799"
        assert row.action_type == "INHIBITOR"
        assert row.mechanism_of_action == "Phosphodiesterase 3A inhibitor"
        assert row.target_symbols == "PDE3A"
        assert row.source_version == "26.06"

    async def test_multiple_targets_join_in_sorted_order(self, mocker) -> None:
        """The guanylate cyclase activator hits four GUCY1 subunits."""
        mocker.patch(
            "pipeline.opentargets_drugs.graphql",
            AsyncMock(
                return_value=self._hit(
                    [
                        {
                            "actionType": "ACTIVATOR",
                            "mechanismOfAction": "Soluble guanylate cyclase activator",
                            "targets": [
                                {"approvedSymbol": "GUCY1B1"},
                                {"approvedSymbol": "GUCY1A1"},
                            ],
                        }
                    ]
                )
            ),
        )

        row = await fetch_drug_mechanism("Isosorbide mononitrate", "26.06")

        assert row.target_symbols == "GUCY1A1, GUCY1B1"

    async def test_a_resolved_drug_with_no_mechanism_is_still_resolved(
        self, mocker
    ) -> None:
        """Edaravone resolves to CHEMBL290916 and carries no mechanism rows."""
        mocker.patch(
            "pipeline.opentargets_drugs.graphql", AsyncMock(return_value=self._hit([]))
        )

        row = await fetch_drug_mechanism("Edaravone", "26.06")

        assert row.resolved is True
        assert row.action_type is None
        assert row.mechanism_of_action is None

    async def test_an_unresolvable_drug_is_recorded_as_unresolved(
        self, mocker
    ) -> None:
        """5 of 11 trial drugs are not in ChEMBL. That is data, not an error."""
        mocker.patch(
            "pipeline.opentargets_drugs.graphql",
            AsyncMock(return_value={"search": {"hits": []}}),
        )

        row = await fetch_drug_mechanism("THN391", "26.06")

        assert row.resolved is False
        assert row.chembl_id is None
        assert row.drug == "THN391"

    async def test_a_transport_failure_is_none_not_an_unresolved_row(
        self, mocker
    ) -> None:
        """A 500 must not be recorded as "ChEMBL does not have this drug"."""
        mocker.patch(
            "pipeline.opentargets_drugs.graphql", AsyncMock(return_value=None)
        )

        assert await fetch_drug_mechanism("Cilostazol", "26.06") is None


class TestSyncTrialDrugAnnotations:
    async def test_reads_distinct_drugs_and_reports_the_resolution_rate(
        self, mocker
    ) -> None:
        from pipeline.annotations import DrugAnnotationRow

        mocker.patch(
            "pipeline.opentargets_drugs.get_trial_drugs",
            AsyncMock(return_value=["Cilostazol", "THN391"]),
        )
        # Patch where it is used, not where it is defined -- opentargets_drugs
        # imports fetch_data_version into its own namespace at module load.
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_data_version",
            AsyncMock(return_value="26.06"),
        )
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_drug_mechanism",
            AsyncMock(
                side_effect=[
                    DrugAnnotationRow(
                        "Cilostazol", "CHEMBL799", "INHIBITOR",
                        "Phosphodiesterase 3A inhibitor", "PDE3A", "26.06", True,
                    ),
                    DrugAnnotationRow(
                        "THN391", None, None, None, None, "26.06", False
                    ),
                ]
            ),
        )
        upsert = mocker.patch(
            "pipeline.database.upsert_drug_annotations", AsyncMock(return_value=2)
        )

        result = await sync_trial_drug_annotations()

        # Both drugs were answered for, so both are written and neither is a
        # failure -- THN391 is simply not in ChEMBL.
        assert result.fetched == 2
        assert result.failed == 0
        assert result.errors == []
        assert upsert.await_args.args[0][0].drug == "Cilostazol"

    async def test_a_transport_failure_is_counted_and_not_written(
        self, mocker
    ) -> None:
        mocker.patch(
            "pipeline.opentargets_drugs.get_trial_drugs",
            AsyncMock(return_value=["Cilostazol"]),
        )
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_data_version",
            AsyncMock(return_value="26.06"),
        )
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_drug_mechanism",
            AsyncMock(return_value=None),
        )
        upsert = mocker.patch(
            "pipeline.database.upsert_drug_annotations", AsyncMock(return_value=0)
        )

        result = await sync_trial_drug_annotations()

        assert result.fetched == 0
        assert result.failed == 1
        assert upsert.await_args.args[0] == []
```

- [ ] **Step 2: Run them to verify they fail**

Run: `uv run pytest tests/pipeline/test_opentargets_drugs.py -v` Expected: FAIL
— `ModuleNotFoundError: No module named 'pipeline.opentargets_drugs'`.

- [ ] **Step 3: Write the module**

```python
"""Open Targets verification of the curated trial mechanisms.

This does not replace ``clinical_trials.mechanism_of_action``. Measured against
the live API on 2026-08-31, 6 of the 11 drugs in the curated table resolve, 5
carry a mechanism, and **every one of those 5 agrees with the curator's
parenthetical** -- Cilostazol/PDE3A, Colchicine/tubulin, Exenatide/GLP1R,
Isosorbide mononitrate/soluble guanylate cyclase, Tranexamic acid/plasminogen.
The 5 that do not resolve are unregistered agents, a peptide preparation and a
trade-named complex ChEMBL does not carry; that is a coverage limit of the
reference database, not an error in the curated column. The curator strings are
also richer -- they carry a clinical class ("Antiplatelet, vasodilator") that
an action type does not.

So Open Targets is recorded beside the curated value, ``resolved`` flag
included, and a divergence becomes visible rather than being silently
overwritten.

``resolved=False`` and a failure are different things and are counted
differently: the first is a drug the API answered about and does not carry,
the second is a transport error, which ``fetch_drug_mechanism`` reports as
``None``. Counting the five expected absences as failures would mark every
healthy run failed.
"""

import logging
import re
from typing import Any, Final

from pipeline.annotations import DrugAnnotationRow
from pipeline.cache_utils import SyncResult, make_log_progress, run_batched_fetch
from pipeline.config import PipelineConfig
from pipeline.opentargets_fetch import fetch_data_version, graphql

logger = logging.getLogger(__name__)

# "Mivelsiran (ALN-APP)" -> "Mivelsiran". The development code in parentheses
# is what ChEMBL does not index; stripping it is the difference between 6 hits
# and 4.
_TRADE_SUFFIX: Final[re.Pattern[str]] = re.compile(r"\s*\(.*?\)")

_DRUG_QUERY: Final[str] = """
query Drug($q: String!) {
  search(queryString: $q, entityNames: ["drug"], page: {index: 0, size: 1}) {
    hits {
      object {
        ... on Drug {
          id
          name
          mechanismsOfAction {
            rows { actionType mechanismOfAction targets { approvedSymbol } }
          }
        }
      }
    }
  }
}
"""


def strip_trade_suffix(name: str) -> str:
    """Drop a parenthesised development code or trade name."""
    return _TRADE_SUFFIX.sub("", name).strip()


async def get_trial_drugs() -> list[str]:
    """Distinct drug names from the clinical_trials table, in a stable order."""
    from pipeline.database import Database

    async with Database.connection() as conn:
        # No IS NOT NULL guard: clinical_trials.drug is VARCHAR(255) NOT NULL
        # (001_baseline_schema.py:47). ORDER BY is what makes the run
        # reproducible.
        rows = await conn.fetch(
            "SELECT DISTINCT drug FROM clinical_trials ORDER BY drug"
        )
        return [row["drug"] for row in rows]


async def fetch_drug_mechanism(
    drug: str, data_version: str | None
) -> DrugAnnotationRow | None:
    """Look one drug up in Open Targets. Never raises.

    Two different outcomes, deliberately distinguished. A drug the API answered
    about and does not carry is a row with ``resolved=False`` -- 5 of the 11
    curated drugs are legitimately absent from ChEMBL, and that is data. A
    transport failure returns ``None``, as every other fetcher in this plan
    does, so a 500 is never written as "ChEMBL does not have this drug".
    """
    data = await graphql(_DRUG_QUERY, {"q": strip_trade_suffix(drug)})
    if data is None:
        return None

    hits = ((data.get("search") or {}).get("hits")) or []
    if not hits:
        logger.info(f"Open Targets has no drug record for {drug!r}")
        return DrugAnnotationRow(
            drug=drug,
            chembl_id=None,
            action_type=None,
            mechanism_of_action=None,
            target_symbols=None,
            source_version=data_version,
            resolved=False,
        )

    obj: dict[str, Any] = hits[0].get("object") or {}
    rows = ((obj.get("mechanismsOfAction") or {}).get("rows")) or []
    first = rows[0] if rows else {}
    targets = sorted(
        str(t.get("approvedSymbol"))
        for t in (first.get("targets") or [])
        if t.get("approvedSymbol")
    )

    return DrugAnnotationRow(
        drug=drug,
        chembl_id=str(obj.get("id") or "") or None,
        action_type=str(first.get("actionType") or "") or None,
        mechanism_of_action=str(first.get("mechanismOfAction") or "") or None,
        target_symbols=", ".join(targets) or None,
        source_version=data_version,
        resolved=True,
    )


async def sync_trial_drug_annotations(
    config: PipelineConfig | None = None,
) -> SyncResult:
    """Fetch and store an Open Targets mechanism for every curated trial drug."""
    from pipeline.database import upsert_drug_annotations

    drugs = await get_trial_drugs()
    if not drugs:
        return SyncResult(fetched=0, cached=0, failed=0, errors=[])

    data_version = await fetch_data_version()
    results = await run_batched_fetch(
        drugs,
        lambda drug: fetch_drug_mechanism(drug, data_version),
        make_log_progress("Open Targets drugs"),
    )

    rows = [row for row in results if row is not None]
    errors = [
        f"Open Targets drug lookup failed: {drug}"
        for drug, row in zip(drugs, results, strict=True)
        if row is None
    ]

    # Reported, not counted as a failure: five of eleven are expected to be
    # absent from ChEMBL on every healthy run.
    unresolved = [r.drug for r in rows if not r.resolved]
    if unresolved:
        logger.info(
            f"{len(unresolved)} of {len(rows)} trial drugs are not in ChEMBL: "
            f"{', '.join(unresolved)}"
        )

    await upsert_drug_annotations(rows)

    return SyncResult(
        fetched=len(rows),
        cached=0,
        failed=len(errors),
        errors=errors,
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/pipeline/test_opentargets_drugs.py -v` Expected: PASS,
9 tests.

- [ ] **Step 5: Reproduce the 6-of-11 measurement against the live API**

```bash
uv run python -c "
import asyncio, json
from pipeline.opentargets_fetch import fetch_data_version, close_opentargets_client
from pipeline.opentargets_drugs import fetch_drug_mechanism

drugs = sorted({r['drug'] for r in json.load(open('data/table2.json')) if r.get('drug')})

async def main():
    v = await fetch_data_version()
    hits = 0
    for d in drugs:
        row = await fetch_drug_mechanism(d, v)
        if row is None:
            print(f'{d:42s} LOOKUP FAILED -- transport error, not a ChEMBL gap')
            continue
        hits += row.resolved
        print(f'{d:42s} {row.chembl_id or \"-\":14s} {row.action_type or \"\"} '
              f'{row.mechanism_of_action or \"\"} [{row.target_symbols or \"\"}]')
    print(f'resolved {hits}/{len(drugs)}')
    await close_opentargets_client()

asyncio.run(main())
"
```

Expected: **`resolved 6/11`**, with the five mechanism strings matching the
table in this task's preamble. A materially different number means either the
trade-suffix strip regressed or ChEMBL's coverage moved — check which before
adjusting anything.

- [ ] **Step 6: Lint, type-check and commit**

```bash
uv run ruff check pipeline/opentargets_drugs.py tests/pipeline/test_opentargets_drugs.py
uv run ty check pipeline/opentargets_drugs.py
uv run pytest tests/pipeline/test_opentargets_drugs.py \
  --cov=pipeline.opentargets_drugs --cov-branch --cov-report=term-missing
git add pipeline/opentargets_drugs.py tests/pipeline/test_opentargets_drugs.py
git commit -m "Verify Table 2's mechanisms against Open Targets"
```

---

### Task 7: Wire the four sources into the external-data sync

**Files:**

- Modify: `pipeline/external_data_sync.py` (imports at `:12-30`, the
  `ExternalDataSyncResult` dataclass at `:36-63`, `sync_all_external_data` at
  `:140-224`)
- Modify: `pipeline/main.py` (argument parser near `:77`, dispatch near `:1800`)
- Test: `tests/pipeline/test_external_data_sync.py` (extend the existing file)

**Interfaces:**

- Consumes: `sync_clinvar_annotations` / `close_clinvar_client` /
  `clear_clinvar_cache` (Task 3); the Orphadata trio (Task 4); the Open Targets
  trio (Task 5); `sync_trial_drug_annotations` (Task 6);
  `get_table1_gene_symbols` (`external_data_sync.py:64-70`, existing).
- Produces:
  `sync_all_annotations(config: PipelineConfig | None = None) -> AnnotationSyncResult`;
  a `--sync-annotations` CLI flag.

**Order is a dependency, not a preference.** Orphadata reads the `Orphanet:`
rows ClinVar wrote, so ClinVar must complete first. ClinVar and Open Targets are
independent of each other, and the drug sync is independent of all three. The
sequence is therefore ClinVar → Orphadata, with Open Targets and drugs free to
follow.

**This is a separate entry point, not a fifth step inside
`sync_all_external_data`.** The existing sync is what `--sync-external-data`
runs and what the NCBI/UniProt/PubMed caches feed; folding four more APIs into
it would make every existing run three times longer for data no existing
consumer reads. `deno task geocode` and `deno task cytobands` are the house
precedent for a deliberate, separately-invoked refresh.

**Table 1 symbols only.** `get_table1_gene_symbols()` reads
`SELECT DISTINCT gene FROM genes` — the 63 curated genes. The Table 2 genetic
targets that `get_table2_gene_symbols()` splits out are drug targets, already
covered by Task 6's `targets[].approvedSymbol`.

- [ ] **Step 1: Write the failing test**

```python
class TestSyncAllAnnotations:
    async def test_clinvar_runs_before_orphadata(self, mocker) -> None:
        """Orphadata reads the ORPHAcodes ClinVar wrote; order is a dependency."""
        from pipeline.cache_utils import SyncResult
        from pipeline.external_data_sync import sync_all_annotations

        calls: list[str] = []

        def _record(name: str):
            async def _fn(*args, **kwargs):
                calls.append(name)
                return SyncResult(fetched=1, cached=0, failed=0, errors=[])
            return _fn

        mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
            AsyncMock(return_value=["HTRA1"]),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_clinvar_annotations",
            side_effect=_record("clinvar"),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_orphadata_annotations",
            side_effect=_record("orphadata"),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_opentargets_annotations",
            side_effect=_record("opentargets"),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_trial_drug_annotations",
            side_effect=_record("drugs"),
        )

        result = await sync_all_annotations()

        assert calls.index("clinvar") < calls.index("orphadata")
        assert result.clinvar_fetched == 1
        assert result.orphadata_fetched == 1
        assert result.opentargets_fetched == 1
        assert result.drugs_written == 1

    async def test_every_client_is_closed_even_when_a_source_raises(
        self, mocker
    ) -> None:
        from pipeline.external_data_sync import sync_all_annotations

        mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
            AsyncMock(return_value=["HTRA1"]),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_clinvar_annotations",
            AsyncMock(side_effect=RuntimeError("boom")),
        )
        closers = {
            name: mocker.patch(f"pipeline.external_data_sync.{name}", AsyncMock())
            for name in (
                "close_clinvar_client",
                "close_orphadata_client",
                "close_opentargets_client",
            )
        }

        with pytest.raises(RuntimeError):
            await sync_all_annotations()

        for closer in closers.values():
            closer.assert_awaited()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/pipeline/test_external_data_sync.py -k Annotations -v`
Expected: FAIL — `ImportError: cannot import name 'sync_all_annotations'`.

- [ ] **Step 3: Add the orchestrator**

Append to `pipeline/external_data_sync.py`, alongside the existing imports and
`ExternalDataSyncResult`:

```python
from pipeline.clinvar_fetch import (
    clear_clinvar_cache,
    close_clinvar_client,
    sync_clinvar_annotations,
)
from pipeline.opentargets_drugs import sync_trial_drug_annotations
from pipeline.opentargets_fetch import (
    clear_opentargets_cache,
    close_opentargets_client,
    sync_opentargets_annotations,
)
from pipeline.orphadata_fetch import (
    clear_orphadata_cache,
    close_orphadata_client,
    sync_orphadata_annotations,
)


@dataclass(slots=True)
class AnnotationSyncResult:
    """Combined result from the four annotation sources."""

    clinvar_fetched: int = 0
    clinvar_cached: int = 0
    clinvar_failed: int = 0
    orphadata_fetched: int = 0
    orphadata_cached: int = 0
    orphadata_failed: int = 0
    opentargets_fetched: int = 0
    opentargets_cached: int = 0
    opentargets_failed: int = 0
    drugs_written: int = 0
    drugs_failed: int = 0
    errors: list[str] = field(default_factory=list)

    def summary(self) -> str:
        """Return human-readable summary."""
        return (
            f"ClinVar: {self.clinvar_fetched} fetched, "
            f"{self.clinvar_cached} cached, {self.clinvar_failed} failed\n"
            f"Orphadata: {self.orphadata_fetched} fetched, "
            f"{self.orphadata_cached} cached, {self.orphadata_failed} failed\n"
            f"Open Targets: {self.opentargets_fetched} fetched, "
            f"{self.opentargets_cached} cached, {self.opentargets_failed} failed\n"
            f"Trial drugs: {self.drugs_written} looked up, "
            f"{self.drugs_failed} failed"
        )


async def sync_all_annotations(
    config: PipelineConfig | None = None,
) -> AnnotationSyncResult:
    """Sync ClinVar, Orphadata and Open Targets annotations for Table 1 genes.

    ClinVar runs before Orphadata because Orphadata has no gene entry point --
    it is reached through the ORPHAcodes ClinVar returns. Open Targets and the
    drug sync are independent of both.

    None of this touches the curated ``genes`` row; every write lands in
    ``gene_annotations``, ``gene_annotation_status`` or
    ``trial_drug_annotations``.
    """
    result = AnnotationSyncResult()

    try:
        async with asyncio.timeout(3600):
            genes = await get_table1_gene_symbols()
            logger.info(f"Annotating {len(genes)} Table 1 genes")

            logger.info("Syncing ClinVar disease annotations...")
            clinvar = await sync_clinvar_annotations(genes, config=config)
            result.clinvar_fetched = clinvar.fetched
            result.clinvar_cached = clinvar.cached
            result.clinvar_failed = clinvar.failed
            _append_errors_truncated(result.errors, clinvar.errors, "ClinVar")

            # Must follow ClinVar: Orphadata is keyed by ORPHAcode and the
            # gene->disease direction is a 404.
            logger.info("Syncing Orphadata enrichment...")
            orphadata = await sync_orphadata_annotations(genes, config=config)
            result.orphadata_fetched = orphadata.fetched
            result.orphadata_cached = orphadata.cached
            result.orphadata_failed = orphadata.failed
            _append_errors_truncated(result.errors, orphadata.errors, "Orphadata")

            logger.info("Syncing Open Targets annotations...")
            opentargets = await sync_opentargets_annotations(genes, config=config)
            result.opentargets_fetched = opentargets.fetched
            result.opentargets_cached = opentargets.cached
            result.opentargets_failed = opentargets.failed
            _append_errors_truncated(
                result.errors, opentargets.errors, "Open Targets"
            )

            logger.info("Verifying trial drug mechanisms...")
            drugs = await sync_trial_drug_annotations(config=config)
            result.drugs_written = drugs.fetched
            result.drugs_failed = drugs.failed
            _append_errors_truncated(result.errors, drugs.errors, "drug")

            logger.info("Annotation sync complete")
            logger.info(result.summary())
            return result

    except TimeoutError:
        logger.error("Annotation sync timed out after 1 hour")
        result.errors.append("Annotation sync timed out after 3600s")
        return result

    finally:
        await close_clinvar_client()
        await close_orphadata_client()
        await close_opentargets_client()
        clear_clinvar_cache()
        clear_orphadata_cache()
        clear_opentargets_cache()
```

- [ ] **Step 4: Add the CLI flag**

In `pipeline/main.py`, beside `--sync-external-data` (`:77`):

```python
parser.add_argument(
    "--sync-annotations",
    action="store_true",
    help=(
        "Fetch ClinVar, Orphadata and Open Targets annotations for the "
        "curated genes. Writes only the annotation tables; the genes table "
        "is never touched."
    ),
)
```

**A mode is a `run_*` function plus a `_run_summary_pipeline` dispatch, not a
bare call.** Every existing mode in `_run_selected_pipelines` appends a summary
dict to `summaries`, and that list is what drives `any_failed` (the process exit
code) and `_record_and_notify`. A bare `await sync_all_annotations(config)`
would run the sync, log it, and then neither fail the exit code on an error nor
appear in the run record. Follow `run_external_data_sync` (`:1615-1662`) exactly
— a wrapper returning the summary dict:

```python
async def run_annotation_sync(
    config: PipelineConfig | None = None,
    manage_lifecycle: bool = True,
) -> dict[str, Any]:
    """Fetch ClinVar, Orphadata and Open Targets annotations for Table 1.

    Writes only the three annotation tables; the curated ``genes`` row is
    never touched.

    Args:
        config: Pipeline configuration (uses defaults if None).
        manage_lifecycle: When True, close the database pool on exit.
            Set to False by the dispatcher when coalescing multiple pipelines.

    Returns:
        Per-pipeline summary dict suitable for combined notification rendering.
    """
    from pipeline.external_data_sync import sync_all_annotations

    config = config or PipelineConfig()

    logger.info("Starting annotation sync...")
    try:
        result = await sync_all_annotations(config=config)
        logger.info(LOG_SEPARATOR)
        logger.info("Annotation Sync Summary:")
        logger.info(result.summary())
        logger.info(LOG_SEPARATOR)
        return {
            "name": "annotation_sync",
            "status": "failed" if result.errors else "ok",
            "metrics": {
                "clinvar_fetched": result.clinvar_fetched,
                "clinvar_cached": result.clinvar_cached,
                "clinvar_failed": result.clinvar_failed,
                "orphadata_fetched": result.orphadata_fetched,
                "orphadata_cached": result.orphadata_cached,
                "orphadata_failed": result.orphadata_failed,
                "opentargets_fetched": result.opentargets_fetched,
                "opentargets_cached": result.opentargets_cached,
                "opentargets_failed": result.opentargets_failed,
                "drugs_written": result.drugs_written,
                "drugs_failed": result.drugs_failed,
            },
            "errors": result.errors,
        }
    finally:
        if manage_lifecycle:
            await Database.close()
```

and beside the `args.sync_external_data` dispatch (`:1800`):

```python
if args.sync_annotations:
    summaries.append(
        await _run_summary_pipeline(
            run_annotation_sync(config=config, manage_lifecycle=False),
            "annotation_sync",
            "Annotation sync",
        )
    )
```

Add `args.sync_annotations` to the `online_modes` tuple at `:1842` and to the
error message at `:1852`, so running with no mode still reports every mode. The
module docstring lists the modes at `:11` and `:20` — add it there too.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
`uv run pytest tests/pipeline/test_external_data_sync.py tests/pipeline/test_main.py -v`
Expected: PASS, including the two new orchestration cases.

- [ ] **Step 6: Run the whole thing against the live database and confirm the
      curated table is untouched**

```bash
git rev-parse HEAD:data > /tmp/data-tree-before
uv run python -m pipeline.main --sync-annotations
git diff --stat data/
git diff --stat -- pipeline/export/data/
psql "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME" -c \
  "SELECT source, relation, count(*) FROM gene_annotations
   GROUP BY 1,2 ORDER BY 1,2"
psql "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME" -c \
  "SELECT count(*) FILTER (WHERE resolved) AS resolved, count(*) AS total
   FROM trial_drug_annotations"
psql "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME" -c "SELECT max(updated_at) FROM genes"
```

Expected: **`git diff data/` is empty** and so is the export data directory —
nothing published yet. `gene_annotations` holds rows for all three sources
across the relations `disease`, `disease_xref`, `phenotype`, `identity` and
`gene_ontology`. `trial_drug_annotations` shows **6 resolved of 11**.
`max(updated_at)` on `genes` is **unchanged from before the run** — that is the
proof the curated table was not written.

- [ ] **Step 7: Document the four clients in `pipeline/CLAUDE.md`**

Pipeline notes moved out of the always-loaded root `CLAUDE.md` into
`pipeline/CLAUDE.md` in commit `7efc974`, which loads when working under
`pipeline/` and, by import, under `tests/pipeline/`. That is where these belong.
Add a section covering, briefly and with the reason rather than the restatement:

- The three tables, and why one edge table rather than six (`group_key` is what
  makes an enrichment joinable; `''` rather than `NULL` because PostgreSQL lets
  two `NULL`s through a `UNIQUE` constraint).
- **ClinVar is the entry point, Orphadata is the enrichment** — Orphadata has no
  gene endpoint, so the order in `sync_all_annotations` is a dependency and not
  a preference.
- `pipeline/xrefs.py` as the one place the three spellings are reconciled.
- That `--sync-annotations` is deliberately a separate entry point from
  `--sync-external-data`, and why.
- That the curated `genes` table is never written by any of it.

- [ ] **Step 8: Commit**

```bash
git add pipeline/external_data_sync.py pipeline/main.py pipeline/CLAUDE.md \
  tests/pipeline/test_external_data_sync.py
git commit -m "Wire the annotation sources into a separate sync entry point"
```

---

### Task 8: Publish the disease annotations — gated on review

**Do not start this task until Task 7's `git diff data/` was empty and the
annotation tables hold real rows.** This is the only task that changes `data/`,
and it is the point of no return for the wire contract.

**Files:**

- Modify: `pipeline/export/lookups.py` (add a reader beside `read_uniprot_info`
  at `:71-85`)
- Modify: `pipeline/export/main.py` (a ninth staged file in `run_export`,
  `:74-132`, staged through the local `stage()` helper; the `[N/8]` step labels
  and the docstring's file count are renumbered with it)
- Modify: `tests/pipeline/export/test_writer.py:19-29` (`_COMMITTED_FILES`)
- Create: `lib/data/annotations.ts`
- Modify: `lib/types.ts`, `lib/data.ts`, `lib/tooltips.ts`
- Modify: `routes/index.tsx` (the attribution block)
- Create: `scripts/reconcile_omim.py`
- Test: `tests/scripts/test_reconcile_omim.py` — `tests/scripts/` is where the
  other three scripts are covered, and `testpaths = ["tests/pipeline"]` means
  **nothing collects it unless it is run explicitly**
- Test: `tests/pipeline/export/test_lookups.py`, `tests/data_contract_test.ts`,
  `tests/tooltips_test.ts`

**Interfaces:**

- Consumes: everything Tasks 1–7 wrote.
- Produces: `data/gene_annotations.json`; `GeneAnnotation` in `lib/types.ts`;
  `geneAnnotations` and `annotationsByGene` from `lib/data/annotations.ts`;
  `diseaseTooltip(groupKey: string) -> TooltipContent | null`.

**One row per disease, not per cross-reference — and that is a size decision,
not a style one.** `lib/data.ts` uses `import … with { type: "json" }`, so the
whole file is **bundled into every island that reads it**; CLAUDE.md puts the
current dataset at ~100 KB. The raw table is far too big for that: 25 Open
Targets diseases and ~43 GO terms per gene across 63 genes is several thousand
rows. So the export pivots — one row per `(gene_symbol, group_key)` with the
cross-references as columns — and publishes **only the disease relations**. GO
terms, identity rows and the Open Targets association scores stay in PostgreSQL,
where the follow-on that needs them can read them.

Check the size before wiring anything to it:

```bash
psql "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME" -c \
  "SELECT count(*) FROM (SELECT DISTINCT gene_symbol, group_key
   FROM gene_annotations
   WHERE relation IN ('disease','disease_xref') AND group_key <> '') g"
```

Expect a few hundred. If it is over ~1500, narrow to ClinVar's `disease`
relation alone before continuing — a megabyte in the island bundle is not worth
a tooltip.

**The wire keys were checked against the round-trip inverter.**
`tests/pipeline/export/test_writer.py:345-350` asserts
`to_camel(_CAMEL_BOUNDARY.sub(" ", key)) == key` for every key in the file, and
a key with consecutive capitals does not survive it — `clinvarID` inverts to
`clinvar ID` and comes back `clinvarId`. Every key below is single-capital
camelCase and inverts cleanly: `geneSymbol`, `groupKey`, `diseaseName`,
`omimId`, `mondoId`, `orphacode`, `medgenId`, `classification`, `recordCount`,
`mappingRelation`, `sourceVersion`.

**The attribution is required, not decorative.** Orphadata is CC-BY-4.0 and
asserts it in every payload. `routes/index.tsx` currently has **no data-source
section at all** — this task adds one, covering ClinVar, Orphadata (with the
licence and a link) and Open Targets (CC0 1.0, whose team asks to be cited).

- [ ] **Step 1: Write the failing export test**

```python
def test_disease_annotations_pivot_to_one_row_per_disease() -> None:
    """The bundle is imported into every island, so one row per xref is too many."""
    rows = [
        {"gene_symbol": "HTRA1", "source": "clinvar", "relation": "disease",
         "group_key": "MONDO:0010829", "object_id": "MONDO:0010829",
         "object_label": "CARASIL syndrome", "qualifier": "Pathogenic",
         "score": None, "evidence_count": 5, "source_version": None},
        {"gene_symbol": "HTRA1", "source": "clinvar", "relation": "disease",
         "group_key": "MONDO:0010829", "object_id": "OMIM:600142",
         "object_label": "CARASIL syndrome", "qualifier": "Pathogenic",
         "score": None, "evidence_count": 5, "source_version": None},
        {"gene_symbol": "HTRA1", "source": "clinvar", "relation": "disease",
         "group_key": "MONDO:0010829", "object_id": "Orphanet:199354",
         "object_label": "CARASIL syndrome", "qualifier": "Pathogenic",
         "score": None, "evidence_count": 5, "source_version": None},
        {"gene_symbol": "HTRA1", "source": "orphadata", "relation": "disease_xref",
         "group_key": "MONDO:0010829", "object_id": "MeSH:C563990",
         "object_label": "CARASIL", "qualifier": "E",
         "score": None, "evidence_count": None, "source_version": None},
    ]

    pivoted = pivot_disease_annotations(rows)

    assert len(pivoted) == 1
    row = pivoted[0]
    assert row["gene_symbol"] == "HTRA1"
    assert row["group_key"] == "MONDO:0010829"
    assert row["disease_name"] == "CARASIL syndrome"
    assert row["omim_id"] == "600142"
    assert row["mondo_id"] == "MONDO:0010829"
    assert row["orphacode"] == "199354"
    assert row["record_count"] == 5
    assert row["mapping_relation"] == "E"


def test_the_pivot_is_ordered_for_the_byte_exact_contract() -> None:
    rows = [
        {"gene_symbol": "NOTCH3", "source": "clinvar", "relation": "disease",
         "group_key": "OMIM:125310", "object_id": "OMIM:125310",
         "object_label": "CADASIL", "qualifier": None, "score": None,
         "evidence_count": 9, "source_version": None},
        {"gene_symbol": "HTRA1", "source": "clinvar", "relation": "disease",
         "group_key": "MONDO:0014768", "object_id": "MONDO:0014768",
         "object_label": "CADASIL type 2", "qualifier": None, "score": None,
         "evidence_count": 11, "source_version": None},
    ]
    pivoted = pivot_disease_annotations(rows)
    assert [r["gene_symbol"] for r in pivoted] == ["HTRA1", "NOTCH3"]


def test_a_row_with_no_disease_group_is_excluded() -> None:
    """GO terms and identity rows carry group_key '' and are not published."""
    rows = [
        {"gene_symbol": "HTRA1", "source": "opentargets", "relation": "gene_ontology",
         "group_key": "", "object_id": "GO:0005515", "object_label": "protein binding",
         "qualifier": "F/IPI", "score": None, "evidence_count": None,
         "source_version": "26.06"},
    ]
    assert pivot_disease_annotations(rows) == []
```

- [ ] **Step 2: Run it to verify it fails**

Run: `uv run pytest tests/pipeline/export/test_lookups.py -k pivot -v` Expected:
FAIL — `ImportError: cannot import name 'pivot_disease_annotations'`.

- [ ] **Step 3: Add the export reader and the pivot**

In `pipeline/export/lookups.py`, beside `read_uniprot_info` (`:71-85`):

```python
_XREF_COLUMNS: Final[dict[str, str]] = {
    "OMIM": "omim_id",
    "MONDO": "mondo_id",
    "Orphanet": "orphacode",
    "MedGen": "medgen_id",
}


def pivot_disease_annotations(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse cross-reference rows into one row per (gene, disease).

    The published file is bundled into every island that imports it, so one row
    per cross-reference -- let alone per GO term -- is the wrong shape. Rows
    with no disease group (GO terms, identity) are dropped entirely.

    OMIM and Orphanet lose their prefix here: the wire format has carried bare
    six-digit OMIM numbers since the R original, and lib/tooltips.ts keys
    data/omim_info.json on exactly that.
    """
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        group_key = str(row.get("group_key") or "")
        if not group_key:
            continue
        key = (str(row["gene_symbol"]), group_key)
        entry = grouped.setdefault(
            key,
            {
                "gene_symbol": key[0],
                "group_key": group_key,
                "disease_name": "",
                "omim_id": None,
                "mondo_id": None,
                "orphacode": None,
                "medgen_id": None,
                "classification": None,
                "record_count": None,
                "mapping_relation": None,
                "source_version": None,
            },
        )
        prefix, _, local = str(row["object_id"]).partition(":")
        if column := _XREF_COLUMNS.get(prefix):
            # MONDO keeps its prefix -- "MONDO:0010829" is how MONDO is written
            # everywhere. OMIM and Orphanet are bare numbers on the wire.
            entry[column] = row["object_id"] if prefix == "MONDO" else local
        if row["source"] == "clinvar":
            entry["disease_name"] = str(row.get("object_label") or "")
            entry["classification"] = row.get("qualifier")
            entry["record_count"] = row.get("evidence_count")
        elif row["source"] == "orphadata" and entry["mapping_relation"] is None:
            entry["mapping_relation"] = row.get("qualifier")
        if row.get("source_version"):
            entry["source_version"] = row["source_version"]

    # Sorted: the byte-exact contract cannot hold without a total order.
    return [grouped[key] for key in sorted(grouped)]


async def read_disease_annotations() -> list[dict[str, Any]]:
    """Read the published slice of the annotation table."""
    from pipeline.database import Database

    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol, source, relation, group_key, object_id,
                   object_label, qualifier, score, evidence_count, source_version
            FROM gene_annotations
            WHERE relation IN ('disease', 'disease_xref')
            ORDER BY gene_symbol, group_key, source, object_id
            """
        )
    return pivot_disease_annotations([dict(row) for row in rows])
```

In `pipeline/export/main.py`'s `run_export` (`:74-132`), add a ninth staged file
after the `[8/8]` `write_value` call and before `publish_atomically` (`:130`):

```python
logger.info("[9/9] Machine-fetched disease annotations")
# Pivoted to one row per (gene, disease) -- this file is bundled into
# the islands that import it, so the raw cross-reference rows would
# multiply the payload.
annotations = await read_disease_annotations()
write_rows(annotations, stage("gene_annotations.json"))
```

**`stage(name)`, not a bare path.** `staged` is the `dict[str, Path]` that
`publish_atomically(staged, target)` consumes (`main.py:87`); the local
`stage()` helper is what registers a file in it. Writing straight to
`staging / name` type-errors on the dict and, if it did not, would leave the
file unpublished in the temporary directory.

Three surrounding edits go with it, because the step labels are load-bearing
progress output rather than decoration:

- Renumber the eight existing `logger.info("[N/8] ...")` calls to `[N/9]`.
- `run_export`'s docstring says "Generate all eight files" — make it nine.
- The same docstring calls `data/geocoded_trials.json` "A ninth committed file";
  it becomes the tenth.

Add `from pipeline.export.lookups import read_disease_annotations` to the
imports at the top of the file.

In `tests/pipeline/export/test_writer.py:19-29`, add the entry to
`_COMMITTED_FILES`:

```python
"gene_annotations.json": "rows",
```

Without it `test_every_committed_data_file_has_a_round_trip_case`
(`test_writer.py:309-321`) fails the moment the file appears in `data/` — which
is the gate working as designed, not a problem to route around.

- [ ] **Step 4: Regenerate and inspect the diff before trusting it**

```bash
deno task data
git diff --stat data/
ls -l data/gene_annotations.json
python3 -c "
import json
rows = json.load(open('data/gene_annotations.json'))
print('rows:', len(rows))
print('keys:', list(rows[0]))
print('genes with a disease:', len({r['geneSymbol'] for r in rows}))
"
uv run pytest tests/pipeline/export -v
```

Expected: `data/gene_annotations.json` is the **only** new file and the only
change under `data/` — if `table1.json` or any other file also moved, stop and
find out why before committing. The file is a few tens of KB. The writer's
byte-exact round-trip passes, which it can only do because the file was
generated by the writer rather than hand-edited.

- [ ] **Step 5: Wire the TypeScript side**

`lib/types.ts` — add beside `OmimEntry` (`:68-75`):

```typescript
/** One gene's association with one disease, as ClinVar and Orphadata report it. */
export interface GeneAnnotation {
  geneSymbol: string;
  groupKey: string;
  diseaseName: string;
  omimId: string | null;
  mondoId: string | null;
  orphacode: string | null;
  medgenId: string | null;
  classification: string | null;
  recordCount: number | null;
  mappingRelation: string | null;
  sourceVersion: string | null;
}
```

`lib/data/annotations.ts` — a new narrow module, normalizing every field
explicitly the way `lib/data/genes.ts:12-39` does. An unlisted key is dropped,
which is the point: the wire format can gain a field without the UI silently
inheriting it.

```typescript
import type { GeneAnnotation } from "../types.ts";
import annotationJson from "../../data/gene_annotations.json" with {
  type: "json",
};
import { nonnegativeInteger, nullableText, text } from "./normalize.ts";

function normalizeAnnotation(row: Partial<GeneAnnotation>): GeneAnnotation {
  return {
    geneSymbol: text(row.geneSymbol, "(unknown)"),
    groupKey: text(row.groupKey, "(unknown)"),
    diseaseName: text(row.diseaseName, "(unknown)"),
    omimId: nullableText(row.omimId),
    mondoId: nullableText(row.mondoId),
    orphacode: nullableText(row.orphacode),
    medgenId: nullableText(row.medgenId),
    classification: nullableText(row.classification),
    recordCount: nonnegativeInteger(row.recordCount),
    mappingRelation: nullableText(row.mappingRelation),
    sourceVersion: nullableText(row.sourceVersion),
  };
}

export const geneAnnotations: GeneAnnotation[] = (
  annotationJson as Partial<GeneAnnotation>[]
).map(normalizeAnnotation);

export const annotationsByGene: Map<string, GeneAnnotation[]> = geneAnnotations
  .reduce((map, annotation) => {
    const existing = map.get(annotation.geneSymbol);
    if (existing) existing.push(annotation);
    else map.set(annotation.geneSymbol, [annotation]);
    return map;
  }, new Map<string, GeneAnnotation[]>());

/**
 * Keyed on gene *and* disease, not on the disease alone. The export writes one
 * row per (gene, group_key), and two genes legitimately share a disease --
 * `indexBy` (`lib/collections.ts:31`) documents that later values replace
 * earlier duplicate keys, so a `groupKey`-only index would silently keep one
 * gene and drop the other.
 */
export const annotationsByGeneAndDisease: Map<string, GeneAnnotation> = indexBy(
  geneAnnotations,
  (row) => `${row.geneSymbol}\u0000${row.groupKey}`,
);
```

`indexBy` comes from `lib/collections.ts`; add it to the imports. The index
lives here rather than in `lib/tooltips.ts` because that is where every other
lookup Map is built — `omimByNumber` in `lib/data/omim.ts`, `geneInfoByName` in
`lib/data/gene_info.ts`.

Re-export all three from `lib/data.ts` beside the existing ten modules.

`lib/tooltips.ts` — add the lookup, in the shape of the existing `omimTooltip`
(`:53-56`):

```typescript
/**
 * The mapping relation is the load-bearing part. Orphanet's `NTBT` means the
 * OMIM number is *narrower* than the Orphanet concept, not a synonym for it --
 * a distinction the bare six-digit number on the row cannot carry.
 */
export function diseaseTooltip(
  geneSymbol: string,
  groupKey: string,
): TooltipContent | null {
  const row = annotationsByGeneAndDisease.get(`${geneSymbol}\u0000${groupKey}`);
  if (!row) return null;
  return {
    rows: [
      { label: "Disease", value: row.diseaseName },
      ...(row.classification
        ? [{ label: "ClinVar", value: row.classification }]
        : []),
      ...(row.mappingRelation === "NTBT"
        ? [{ label: "Mapping", value: "Orphanet concept is narrower" }]
        : []),
      ...(row.omimId ? [{ label: "OMIM", value: row.omimId }] : []),
    ],
  };
}
```

**`TooltipContent` has no `title`.** It is declared in
`lib/tooltip_content.ts:11` — not `lib/types.ts` — as
`{ rows: TooltipRow[]; link?: { href: string; label: string } }`, and
`components/Tooltip.tsx` renders exactly that as JSX. The disease name is
therefore a row like every other field. No `link` is set: the OMIM anchor
already exists on `omimTooltip`, whose `omimLink` column comes from the curated
CSV, and inventing a URL from a bare identifier here would be a second source of
truth for it.

Extend `tests/data_contract_test.ts` with a case asserting every `geneSymbol` in
the new file exists in `data/table1.json`, and `tests/tooltips_test.ts` with
cases for `diseaseTooltip` — a hit, a miss, and **two genes that share one
`groupKey` both resolving to their own row**, which is the case a
`groupKey`-only index silently loses. Every branch of the three conditional row
spreads needs a case too, or the 100% `lib/` gate fails.

- [ ] **Step 6: Add the attribution block**

`routes/index.tsx` has no data-source section today. Add one listing:

- **ClinVar** — NCBI, public domain; cite the ClinVar paper.
- **Orphadata / Orphanet** — **CC-BY-4.0**, linking
  `https://creativecommons.org/licenses/by/4.0`, naming Orphanet as the source
  of the cross-references and HPO frequencies.
- **Open Targets Platform** — CC0 1.0, data version from `sourceVersion` in the
  published file, with the request to cite their latest publication.

- [ ] **Step 7: Produce the reconciliation report against the curated CSV**

`scripts/reconcile_omim.py` reads `pipeline/export/data/omim_info.csv` through
the existing `read_omim_csv` (`pipeline/export/omim.py:25`) and
`data/gene_annotations.json`, and prints three lists: OMIM numbers in the CSV
that ClinVar did not return for that gene; OMIM numbers ClinVar returned that
the CSV lacks; and rows where both have a number but they differ.

```bash
uv run scripts/reconcile_omim.py
uv run pytest tests/scripts/test_reconcile_omim.py -v
```

**The test run is not optional and not automatic.** `testpaths` is
`["tests/pipeline"]` (`pyproject.toml:111`), so a bare `uv run pytest` -- in CI
too -- collects nothing under `tests/scripts/`. Cover the three comparison
branches against a fixture CSV and a fixture annotations file, the way
`tests/scripts/test_fetch_cytobands.py` covers its script.

**This is a report, not a migration.** The CSV is curated data, so nothing is
deleted or rewritten here — the earlier `genes.references` corruption is exactly
what happens when curated values are transformed without review. Attach the
report to the review; retiring the CSV and the `\b\d{6}\b` regex is a follow-on
that starts from it.

- [ ] **Step 8: Stop and get review before committing the data change**

Show the reviewer: `git diff --stat data/`, the row count and file size, the
reconciliation report from Step 7, and the confirmation from Task 7 Step 6 that
`genes.updated_at` never moved. **Wait for approval.** `data/*.json` is
published scientific output and this is the first machine-generated file among
them.

- [ ] **Step 9: Document the ninth export file in the root `CLAUDE.md`**

The root file is the always-loaded one and owns the export and JSON-contract
notes. Three places need the new file, and each is a statement that becomes
false without it:

- The `data/*.json` bundling note — `gene_annotations.json` is the first
  machine-fetched file among them, and the only one whose rows are a pivot
  rather than a table dump.
- The byte-exact gate paragraph, which enumerates what
  `tests/pipeline/export/test_writer.py` covers and names
  `data/cytobands_hg38.json` as the one exception.
- The wire-contract table, if `GeneAnnotation` needs a row beside the existing
  TypeScript shapes.

- [ ] **Step 10: Run the full suite and commit**

```bash
deno task check
deno task test
deno task test:coverage
uv run pytest
uv run pytest tests/scripts        # not collected by the line above
deno task build && deno task test:e2e
git add data/gene_annotations.json pipeline/export/ lib/ routes/index.tsx \
  scripts/reconcile_omim.py tests/ CLAUDE.md
git commit -m "Publish the ClinVar and Orphadata disease annotations"
```

---

## Verification

End to end, after Task 7 (and Task 8 if taken):

```bash
# Python: lint, types, tests, coverage floor
uv run ruff check .
uv run ty check
uv run pytest --cov=pipeline --cov=pipeline/alembic --cov-branch \
  --cov-report=term-missing:skip-covered

# testpaths is ["tests/pipeline"], so the scripts suite needs naming (Task 8)
uv run pytest tests/scripts

# The export gate -- byte-exact, and exhaustive over data/
uv run pytest tests/pipeline/export -v

# Deno: format, lint, types, unit tests, both coverage gates
deno task check
deno task test:coverage

# End to end
deno task build && deno task test:e2e
```

Then the one that actually proves the separation held:

```bash
git diff data/            # empty after Tasks 1-7; only gene_annotations.json after Task 8
psql "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME" -c "SELECT max(updated_at) FROM genes"
```

**The curated `genes` table having the same `max(updated_at)` before and after a
full `--sync-annotations` run is the acceptance criterion.** Every other check
here can pass while an API client quietly writes into a curated column; this one
cannot.

Manual checks no test can make:

1. **The three sources actually agree on a gene.** Pick HTRA1 and confirm that
   ClinVar's `Orphanet:199354`, Orphadata's enrichment of ORPHAcode 199354, and
   Open Targets' `Orphanet_199354` association all carry
   `group_key =
   MONDO:0010829` in `gene_annotations`. If they do not,
   `pipeline/xrefs.py` is not doing its job and every downstream join is
   silently empty.
2. **The two unresolvable symbols are still visible as findings.** `C6orf195`
   and `COL4A1/2` should have zero-count status rows for all three sources and
   appear by name in the run log. They are a data-quality signal about the
   curated table — `COL4A1/2` is a compound label, not a gene — and must not be
   silently swallowed.
3. **The Orphadata licence line still says CC-BY-4.0.** The client logs an error
   if it changes. If it has, the attribution block in `routes/index.tsx` is
   wrong and publishing is blocked until it is fixed.

---

## Rollback

Tasks 1–7 write nothing outside three new tables and touch no committed file
that any consumer reads, so rolling back is `git revert` plus:

```bash
uv run alembic -c pipeline/alembic.ini downgrade -1
```

which drops `gene_annotations`, `gene_annotation_status` and
`trial_drug_annotations` with their triggers. Nothing else in the schema
references them — there is no foreign key to `genes`, deliberately, so the
curated table cannot be locked or cascaded by an annotation run.

**Task 8 is the point of no return**, in one specific sense: reverting the code
is easy, but `data/gene_annotations.json` becomes part of the byte-exact
contract the moment it is committed, and `_COMMITTED_FILES` will fail if the
file disappears without that entry being removed in the same commit. Revert both
together, or neither.
