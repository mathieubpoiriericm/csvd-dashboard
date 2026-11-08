"""scripts/load_gold.py's write against a real PostgreSQL.

What a mocked connection cannot say: that the delete cascades to the list
tables, that the run history is left alone, that the sequences move past the
explicit ids, and that the export of what was written publishes the curated
wording -- the "*" and the second ":" of an omics entry included. Synthetic
rows only, so it holds for any disease; it lives here rather than beside the
loader's unit tests in tests/scripts/ because the `database_env` fixture is
in tests/pipeline/conftest.py. Skips unless `CSVD_TEST_DB_URL` (or the
container runtime) provides a throwaway database.
"""

from typing import Any

import pytest
from scripts.load_gold import GoldPlan, write_gold_plan
from scripts.restore_from_json import GeneRestore, stored_omics

from pipeline.data_merger import format_omics
from pipeline.database import Database, merge_genes_transactional
from pipeline.export.main import read_published_genes
from pipeline.omics import OmicsEvidence, OmicsItem

pytestmark = pytest.mark.usefixtures("database_env")

_TABLES = ("genes", "clinical_trials", "pubmed_refs", "pipeline_runs")

_ENTRIES = ["TWAS;TRAIT-A: tissue one*, (age>65): tissue two_x", "Proteomics"]


async def _truncate() -> None:
    async with Database.connection() as conn:
        await conn.execute(f"TRUNCATE {', '.join(_TABLES)} RESTART IDENTITY CASCADE")


@pytest.fixture(autouse=True)
async def _empty_tables(database_env):
    await _truncate()
    yield
    await _truncate()
    await Database.close()


def _plan() -> GoldPlan:
    return GoldPlan(
        genes=[
            GeneRestore(
                columns={
                    "protein": "ABC protein one",
                    "gene": "ABC1",
                    "chromosomal_location": "1p36.3",
                    "mendelian_randomization": True,
                    "evidence_from_other_omics_studies": stored_omics(_ENTRIES),
                    "brain_cell_types": "Mouse: EC; Human: PC > EC",
                    "affected_pathway": "angiogenesis",
                    "source_quote": None,
                    "confidence": None,
                },
                traits=[],
                links=["123456"],
                references=["11111111", "10.21203/rs.3.rs-0000000/v1"],
            )
        ],
        trials=[
            {
                "drug": "Drug A",
                "mechanism_of_action": "Inhibitor",
                "genetic_target": None,
                "genetic_evidence": "No",
                "trial_name": "TRIAL-A",
                "registry_id": "REG-0001",
                "clinical_trial_phase": "II",
                "target_population": "Population A",
                "target_population_details": "Adults",
                "target_sample_size": 120,
                "estimated_completion_date": "7/2028",
                "primary_outcome": "Outcome A",
                "sponsor_type": "Academic",
                "overall_status": None,
            }
        ],
    )


async def test_the_gold_rows_replace_what_was_there() -> None:
    async with Database.connection() as conn:
        old = await conn.fetchval(
            "INSERT INTO genes (gene) VALUES ('OLD1') RETURNING id"
        )
        await conn.execute(
            "INSERT INTO gene_references (gene_id, ordinal, pmid) "
            "VALUES ($1, 0, '22222222')",
            old,
        )
        await conn.execute(
            "INSERT INTO clinical_trials (drug, registry_id) VALUES ('Old', 'X')"
        )
        await conn.execute("INSERT INTO pubmed_refs (pmid) VALUES ('33333333')")
        await conn.execute(
            "INSERT INTO pipeline_runs (run_timestamp) VALUES (now())"
        )

    counts = await write_gold_plan(_plan())

    assert counts == {
        "genes": 1,
        "gene_gwas_traits": 0,
        "gene_monogenic_links": 1,
        "gene_references": 2,
        "clinical_trials": 1,
        "pubmed_refs": 0,
    }
    async with Database.connection() as conn:
        assert await conn.fetchval("SELECT count(*) FROM pipeline_runs") == 1
        new_gene = await conn.fetchval(
            "INSERT INTO genes (gene) VALUES ('NEW1') RETURNING id"
        )
        new_trial = await conn.fetchval(
            "INSERT INTO clinical_trials (drug) VALUES ('Drug B') RETURNING id"
        )
    assert (new_gene, new_trial) == (2, 2)


async def test_the_export_publishes_the_curated_omics_wording() -> None:
    await write_gold_plan(_plan())

    (gene,) = await read_published_genes()

    assert gene["evidenceFromOtherOmicsStudies"] == _ENTRIES
    assert gene["references"] == ["11111111", "10.21203/rs.3.rs-0000000/v1"]
    assert gene["brainCellTypes"] == "Mouse: EC; Human: PC > EC"


def _merged_row(omics: str) -> dict[str, Any]:
    """A `_build_combined_gene_data`-shaped row for the loaded gene."""
    return {
        "protein": "ABC protein one",
        "gene": "ABC1",
        "chromosomal_location": "",
        "gwas_trait": [],
        "mendelian_randomization": False,
        "evidence_from_other_omics_studies": omics,
        "brain_cell_types": "",
        "affected_pathway": "",
        "references": ["44444444"],
        "source_quote": "A sentence.",
        "confidence": 0.9,
    }


@pytest.mark.parametrize("path", ["update", "insert-on-conflict"])
async def test_a_later_merge_appends_to_a_stored_array_without_breaking_it(
    path: str,
) -> None:
    """Both merge statements split the stored omics on ";" and rejoin the
    pieces; the array's escaped semicolons keep it one piece, so the curated
    entries still publish verbatim and the extraction's prose follows them."""
    await write_gold_plan(_plan())
    row = _merged_row("PWAS:brain*;TWAS:tissue")
    if path == "update":
        await merge_genes_transactional([], [row])
    else:
        await merge_genes_transactional([row], [])

    (gene,) = await read_published_genes()

    assert gene["evidenceFromOtherOmicsStudies"] == [
        *_ENTRIES,
        "PWAS;brain",
        "TWAS;tissue",
    ]


@pytest.mark.parametrize("path", ["update", "insert-on-conflict"])
async def test_a_later_runs_array_publishes_after_the_curated_one(
    path: str,
) -> None:
    """Since prompt v8 a run stores its studies as an array too
    (`format_omics`). Merged behind the curated array, it is a second escaped
    piece, so the export reads both: the curated entries, then the run's,
    the run's `*` only where it reported a colocalization."""
    await write_gold_plan(_plan())
    run = format_omics(
        [
            OmicsEvidence(
                study_type="PWAS",
                biomarker="TRAIT-B",
                items=[OmicsItem(text="brain", colocalized=True)],
            ),
            OmicsEvidence(study_type="TWAS", items=[OmicsItem(text="tissue")]),
        ]
    )
    row = _merged_row(run)
    if path == "update":
        await merge_genes_transactional([], [row])
    else:
        await merge_genes_transactional([row], [])

    (gene,) = await read_published_genes()

    assert gene["evidenceFromOtherOmicsStudies"] == [
        *_ENTRIES,
        "PWAS;TRAIT-B: brain*",
        "TWAS;tissue",
    ]
