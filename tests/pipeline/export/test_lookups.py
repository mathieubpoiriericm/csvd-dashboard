"""Tests for pipeline.export.lookups -- cache-table reads ported from
read_external_data.R.

complete_lookup is pure and its first three tests come straight from the
plan. The four async functions need a mocked Database.connection(); see
tests/pipeline/test_database.py for the mocking pattern this file follows.
"""

import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import asyncpg
import pytest

from pipeline.database import Database
from pipeline.export.lookups import (
    complete_lookup,
    pivot_disease_annotations,
    read_disease_annotations,
    read_ncbi_gene_info,
    read_pipeline_status,
    read_pubmed_refs,
    read_uniprot_info,
)
from pipeline.export.writer import to_camel

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _committed_key_order(filename: str) -> list[str]:
    """The key order of the first row of a committed data/*.json file."""
    text = (_REPO_ROOT / "data" / filename).read_text(encoding="utf-8")
    return list(json.loads(text)[0].keys())


def _mock_connection(mocker, conn: AsyncMock) -> None:
    """Patch Database.connection() to yield `conn` as an async context
    manager, mirroring tests/pipeline/test_database.py.
    """
    mocker.patch.object(
        Database,
        "connection",
        return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=conn),
            __aexit__=AsyncMock(return_value=False),
        ),
    )


# ---------------------------------------------------------------------------
# complete_lookup -- pure function (brief Step 1, verbatim)
# ---------------------------------------------------------------------------


def test_complete_lookup_returns_one_row_per_request_in_order() -> None:
    rows = [{"name": "HTRA1", "uid": "5654"}, {"name": "LAMB1", "uid": "3912"}]
    out = complete_lookup(rows, ["LAMB1", "MISSING", "HTRA1"], "name", {"uid": None})
    assert [r["name"] for r in out] == ["LAMB1", "MISSING", "HTRA1"]
    assert out[1] == {"name": "MISSING", "uid": None}


def test_complete_lookup_supports_a_computed_default() -> None:
    out = complete_lookup(
        [],
        ["12345678"],
        "pmid",
        {"formatted_ref": lambda key: f"PMID: {key} (citation not available)"},
    )
    assert out[0]["formatted_ref"] == "PMID: 12345678 (citation not available)"


def test_complete_lookup_on_empty_request_returns_empty() -> None:
    assert complete_lookup([], [], "name", {"uid": None}) == []


# ---------------------------------------------------------------------------
# complete_lookup -- extra edge cases exercised in the R cross-check
# ---------------------------------------------------------------------------


def test_complete_lookup_repeats_a_duplicate_requested_key() -> None:
    """Matches R's result[match(requested, result[[key_column]]), ]: a key
    requested twice appears twice in the output, once per requested slot.
    """
    rows = [{"name": "HTRA1", "uid": "5654"}]
    out = complete_lookup(rows, ["HTRA1", "HTRA1"], "name", {"uid": None})
    assert [r["name"] for r in out] == ["HTRA1", "HTRA1"]
    assert out[0] == out[1] == {"name": "HTRA1", "uid": "5654"}


def test_complete_lookup_all_missing_uses_fallback_for_every_row() -> None:
    out = complete_lookup([], ["A", "B"], "name", {"uid": None})
    assert out == [{"name": "A", "uid": None}, {"name": "B", "uid": None}]


def test_complete_lookup_fallback_row_key_order_matches_a_real_row() -> None:
    """A fallback row must be built with the defaults dict's own key order
    -- 'name' first, then each default in insertion order -- matching a
    real row. This is the easy detail to get wrong (see the task brief).
    """
    rows = [{"name": "HTRA1", "uid": "5654", "description": "d"}]
    out = complete_lookup(
        rows, ["HTRA1", "MISSING"], "name", {"uid": None, "description": None}
    )
    assert list(out[0].keys()) == list(out[1].keys()) == ["name", "uid", "description"]


# ---------------------------------------------------------------------------
# read_ncbi_gene_info
# ---------------------------------------------------------------------------


class TestReadNcbiGeneInfo:
    async def test_empty_input_short_circuits(self, mocker) -> None:
        spy = mocker.patch.object(Database, "connection")
        assert await read_ncbi_gene_info([]) == []
        spy.assert_not_called()

    async def test_hit_returns_the_cached_row(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {
                    "name": "LAMB1",
                    "uid": 3912,
                    "description": "laminin subunit beta 1",
                    "otheraliases": "CLM, LIS5",
                }
            ]
        )
        _mock_connection(mocker, mock_conn)

        out = await read_ncbi_gene_info(["LAMB1"])

        assert out == [
            {
                "name": "LAMB1",
                "uid": "3912",
                "description": "laminin subunit beta 1",
                "otheraliases": "CLM, LIS5",
            }
        ]
        await_args = mock_conn.fetch.await_args
        assert await_args is not None, "read_ncbi_gene_info executed no SQL"
        assert "ncbi_gene_info" in await_args.args[0]
        assert await_args.args[1] == ["LAMB1"]

    async def test_miss_gets_a_null_fallback_row(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        _mock_connection(mocker, mock_conn)

        out = await read_ncbi_gene_info(["MISSING"])

        assert out == [
            {"name": "MISSING", "uid": None, "description": None, "otheraliases": None}
        ]

    async def test_preserves_request_order_across_hit_and_miss(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {
                    "name": "HTRA1",
                    "uid": 5654,
                    "description": "d",
                    "otheraliases": "a",
                }
            ]
        )
        _mock_connection(mocker, mock_conn)

        out = await read_ncbi_gene_info(["LAMB1", "HTRA1"])

        assert [r["name"] for r in out] == ["LAMB1", "HTRA1"]
        assert out[0]["uid"] is None
        assert out[1]["uid"] == "5654"

    async def test_integer_uid_is_coerced_to_string(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"name": "X", "uid": 42, "description": None, "otheraliases": None}
            ]
        )
        _mock_connection(mocker, mock_conn)

        out = await read_ncbi_gene_info(["X"])
        assert out[0]["uid"] == "42"
        assert isinstance(out[0]["uid"], str)

    async def test_null_uid_from_db_stays_none(self, mocker) -> None:
        """A NULL ncbi_uid must not become the string "None"."""
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"name": "X", "uid": None, "description": None, "otheraliases": None}
            ]
        )
        _mock_connection(mocker, mock_conn)

        out = await read_ncbi_gene_info(["X"])
        assert out[0]["uid"] is None

    async def test_key_order_matches_gene_info_json_for_hit_and_fallback(
        self, mocker
    ) -> None:
        """gene_info.json and gene_info_table2.json share this row shape.
        writer.write_rows preserves dict insertion order verbatim, so a
        fallback row that comes out in a different order than a real row
        would reorder fields on the next regeneration.
        """
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {
                    "name": "LAMB1",
                    "uid": 3912,
                    "description": "laminin subunit beta 1",
                    "otheraliases": "CLM, LIS5",
                }
            ]
        )
        _mock_connection(mocker, mock_conn)

        out = await read_ncbi_gene_info(["LAMB1", "MISSING"])
        expected = _committed_key_order("gene_info.json")

        assert [to_camel(k) for k in out[0]] == expected  # hit
        assert [to_camel(k) for k in out[1]] == expected  # fallback


# ---------------------------------------------------------------------------
# read_uniprot_info
# ---------------------------------------------------------------------------


class TestReadUniprotInfo:
    async def test_empty_input_short_circuits(self, mocker) -> None:
        spy = mocker.patch.object(Database, "connection")
        assert await read_uniprot_info([]) == []
        spy.assert_not_called()

    async def test_hit_returns_the_cached_row(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {
                    "gene": "LAMB1",
                    "accession": "P07942",
                    "url": "https://www.uniprot.org/uniprotkb/P07942/entry",
                }
            ]
        )
        _mock_connection(mocker, mock_conn)

        out = await read_uniprot_info(["LAMB1"])

        assert out == [
            {
                "gene": "LAMB1",
                "accession": "P07942",
                "url": "https://www.uniprot.org/uniprotkb/P07942/entry",
            }
        ]
        await_args = mock_conn.fetch.await_args
        assert await_args is not None, "read_uniprot_info executed no SQL"
        assert "uniprot_info" in await_args.args[0]
        assert await_args.args[1] == ["LAMB1"]

    async def test_miss_gets_a_null_fallback_row(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        _mock_connection(mocker, mock_conn)

        out = await read_uniprot_info(["MISSING"])

        assert out == [{"gene": "MISSING", "accession": None, "url": None}]

    async def test_key_order_matches_protein_info_json_for_hit_and_fallback(
        self, mocker
    ) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {
                    "gene": "LAMB1",
                    "accession": "P07942",
                    "url": "https://www.uniprot.org/uniprotkb/P07942/entry",
                }
            ]
        )
        _mock_connection(mocker, mock_conn)

        out = await read_uniprot_info(["LAMB1", "MISSING"])
        expected = _committed_key_order("protein_info.json")

        assert [to_camel(k) for k in out[0]] == expected  # hit
        assert [to_camel(k) for k in out[1]] == expected  # fallback


# ---------------------------------------------------------------------------
# read_pubmed_refs
# ---------------------------------------------------------------------------


# One `pubmed_citations` row as asyncpg hands it back: an integer PMID, and
# every column the widened query selects.
_CITATION_ROW = {
    "pmid": 37063705,
    "authors": "Morel H, Bailly L, Urbanczyk C, et al.",
    "title": "Extension of the Clinicoradiologic Spectrum",
    "journal": "Neurology. Genetics",
    "publication_date": "Jun 2023",
    "doi": "10.1212/NXG.0000000000200069",
    "formatted_ref": "Morel H, et al.",
}


class TestReadPubmedRefs:
    async def test_empty_input_short_circuits(self, mocker) -> None:
        spy = mocker.patch.object(Database, "connection")
        assert await read_pubmed_refs([]) == []
        spy.assert_not_called()

    async def test_hit_returns_the_whole_cached_citation(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[_CITATION_ROW])
        _mock_connection(mocker, mock_conn)

        out = await read_pubmed_refs(["37063705"])

        # The discrete fields go out beside the fragment, not instead of it:
        # the tooltip composes from the fields, and the fragment is what a row
        # with no fields falls back to.
        assert out == [
            {
                "pmid": "37063705",
                "authors": "Morel H, Bailly L, Urbanczyk C, et al.",
                "title": "Extension of the Clinicoradiologic Spectrum",
                "journal": "Neurology. Genetics",
                "publication_date": "Jun 2023",
                "doi": "10.1212/NXG.0000000000200069",
                "formatted_ref": "Morel H, et al.",
            }
        ]
        await_args = mock_conn.fetch.await_args
        assert await_args is not None, "read_pubmed_refs executed no SQL"
        assert "pubmed_citations" in await_args.args[0]
        assert await_args.args[1] == ["37063705"]

    async def test_miss_gets_the_computed_fallback_citation(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        _mock_connection(mocker, mock_conn)

        out = await read_pubmed_refs(["99999999"])

        # The fragment keeps its sentinel; the discrete fields go out null
        # rather than sentinel-valued, because "(none found)" is not an author
        # and the dashboard falls back to the bare PMID when it sees null.
        assert out == [
            {
                "pmid": "99999999",
                "authors": None,
                "title": None,
                "journal": None,
                "publication_date": None,
                "doi": None,
                "formatted_ref": "PMID: 99999999 (citation not available)",
            }
        ]

    async def test_integer_pmid_is_coerced_to_string(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[{**_CITATION_ROW, "pmid": 12345678}]
        )
        _mock_connection(mocker, mock_conn)

        out = await read_pubmed_refs(["12345678"])
        assert out[0]["pmid"] == "12345678"
        assert isinstance(out[0]["pmid"], str)

    async def test_key_order_matches_refs_json_for_hit_and_fallback(
        self, mocker
    ) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[_CITATION_ROW])
        _mock_connection(mocker, mock_conn)

        out = await read_pubmed_refs(["37063705", "99999999"])
        expected = _committed_key_order("refs.json")

        assert [to_camel(k) for k in out[0]] == expected  # hit
        assert [to_camel(k) for k in out[1]] == expected  # fallback


# ---------------------------------------------------------------------------
# read_pipeline_status
# ---------------------------------------------------------------------------


class TestReadPipelineStatus:
    async def test_missing_table_returns_none(self, mocker, caplog) -> None:
        """pipeline_runs arrives with migration 003, so a database below that
        revision has no table to read. That must not fail the export.
        """
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(
            side_effect=asyncpg.exceptions.UndefinedTableError(
                'relation "pipeline_runs" does not exist'
            )
        )
        _mock_connection(mocker, mock_conn)

        with caplog.at_level(logging.WARNING):
            result = await read_pipeline_status()

        assert result is None
        assert "pipeline_runs" in caplog.text

    async def test_anything_but_migration_lag_fails_the_export(
        self, mocker
    ) -> None:
        """A dropped connection, a revoked SELECT or a programming bug must
        not come back as "no run has ever happened": run_export stages this
        value unconditionally, so a swallowed error publishes `null` over the
        committed pipeline_status.json and still exits 0.
        """
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(
            side_effect=asyncpg.exceptions.InsufficientPrivilegeError(
                "permission denied for table pipeline_runs"
            )
        )
        _mock_connection(mocker, mock_conn)

        with pytest.raises(asyncpg.exceptions.InsufficientPrivilegeError):
            await read_pipeline_status()

    async def test_no_rows_returns_none(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        _mock_connection(mocker, mock_conn)

        assert await read_pipeline_status() is None

    async def test_failed_runs_do_not_date_the_data(self, mocker) -> None:
        """A failed run writes a row so the widget can show it, but it
        changed nothing, so it must not move "up-to-date as of"."""
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        _mock_connection(mocker, mock_conn)

        await read_pipeline_status()

        assert mock_conn.fetchrow.await_args is not None
        (sql,) = mock_conn.fetchrow.await_args.args
        assert "status IS DISTINCT FROM 'failed'" in sql
        assert "ORDER BY run_timestamp DESC" in sql

    async def test_a_database_without_migration_009_still_dates_the_data(
        self, mocker
    ) -> None:
        """No status column means no failed rows either -- only the
        report-writing pipeline records those -- so the unfiltered query
        is the right answer there, not a missing date."""
        stamp = datetime(2026, 8, 31, 2, 17, 55)
        row = {
            "run_timestamp": stamp,
            "papers_processed": 9,
            "fulltext_retrieved": 4,
            "genes_extracted": 2,
            "genes_validated": 1,
        }
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(
            side_effect=[
                asyncpg.exceptions.UndefinedColumnError(
                    'column "status" does not exist'
                ),
                row,
            ]
        )
        _mock_connection(mocker, mock_conn)

        result = await read_pipeline_status()

        assert result == {
            "runTimestamp": "2026-08-31T02:17:55Z",
            "papersProcessed": 9,
            "fulltextRetrieved": 4,
            "genesExtracted": 2,
            "genesValidated": 1,
        }
        (sql,) = mock_conn.fetchrow.await_args_list[1].args
        assert "status" not in sql

    async def test_hit_returns_the_camel_cased_summary(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(
            return_value={
                "run_timestamp": datetime(2026, 3, 24, 10, 0, 0),
                "papers_processed": 5,
                "fulltext_retrieved": 3,
                "genes_extracted": 12,
                "genes_validated": 10,
            }
        )
        _mock_connection(mocker, mock_conn)

        result = await read_pipeline_status()

        assert result is not None
        assert result == {
            "runTimestamp": "2026-03-24T10:00:00Z",
            "papersProcessed": 5,
            "fulltextRetrieved": 3,
            "genesExtracted": 12,
            "genesValidated": 10,
        }
        assert list(result.keys()) == [
            "runTimestamp",
            "papersProcessed",
            "fulltextRetrieved",
            "genesExtracted",
            "genesValidated",
        ]
        await_args = mock_conn.fetchrow.await_args
        assert await_args is not None, "read_pipeline_status executed no SQL"
        assert "pipeline_runs" in await_args.args[0]


# ---------------------------------------------------------------------------
# Disease annotations (machine-fetched)
# ---------------------------------------------------------------------------


def _clinvar(object_id: str, **overrides) -> dict[str, Any]:
    row = {
        "gene_symbol": "HTRA1",
        "source": "clinvar",
        "relation": "disease",
        "group_key": "MONDO:0010829",
        "object_id": object_id,
        "object_label": "CARASIL syndrome",
        "qualifier": "Pathogenic",
        "score": None,
        "evidence_count": 5,
        "source_version": None,
    }
    row.update(overrides)
    return row


def _orphadata(object_id: str, qualifier: str | None, **overrides) -> dict[str, Any]:
    row = {
        "gene_symbol": "HTRA1",
        "source": "orphadata",
        "relation": "disease_xref",
        "group_key": "MONDO:0010829",
        "object_id": object_id,
        "object_label": "CARASIL",
        "qualifier": qualifier,
        "score": None,
        "evidence_count": None,
        "source_version": None,
    }
    row.update(overrides)
    return row


def test_disease_annotations_pivot_to_one_row_per_disease() -> None:
    """The bundle is imported into every island, so one row per xref is too many."""
    rows = [
        _clinvar("MONDO:0010829"),
        _clinvar("OMIM:600142"),
        _clinvar("Orphanet:199354"),
        _orphadata("MeSH:C563990", "E"),
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


def test_a_group_no_clinvar_row_attests_is_not_published(caplog) -> None:
    """Only ClinVar attests a gene-disease pair; Orphadata enriches one.

    Orphadata rows carry the group_key ClinVar had when Orphadata last
    synced, and the two sources are replaced independently. A ClinVar
    refresh that re-keys a disease leaves Orphadata's old group behind for
    its own TTL, and publishing it would put the same disease on the page
    twice -- once with no name and no provenance.
    """
    rows = [
        _orphadata("OMIM:600142", "E", group_key="OMIM:600142"),
        _orphadata("MONDO:0010829", "E", group_key="OMIM:600142"),
        _clinvar("MONDO:0010829"),
        _orphadata("Orphanet:199354", "E"),
    ]

    with caplog.at_level("WARNING", logger="pipeline.export.lookups"):
        pivoted = pivot_disease_annotations(rows)

    assert [row["group_key"] for row in pivoted] == ["MONDO:0010829"]
    assert pivoted[0]["orphacode"] == "199354"
    assert "HTRA1" in caplog.text
    assert "OMIM:600142" in caplog.text


def test_the_pivot_is_ordered_for_the_byte_exact_contract() -> None:
    rows = [
        _clinvar("OMIM:125310", gene_symbol="NOTCH3", group_key="OMIM:125310",
                 object_label="CADASIL", qualifier=None, evidence_count=9),
        _clinvar("MONDO:0014768", group_key="MONDO:0014768",
                 object_label="CADASIL type 2", qualifier=None, evidence_count=11),
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


class TestOnlyThisDiseasesIdentifiersFillAColumn:
    """The failure this separation exists to prevent.

    Orphanet:1885 ("Ectopia lentis") is broader than the OMIM subtypes it maps
    to, so Orphadata returns OMIM:129600 / 225100 / 225200 for it, all marked
    BTNT. ClinVar attests only OMIM:225100 for ADAMTSL4's MONDO:0009152. A
    pivot that let any cross-reference fill omim_id would publish 225200 --
    a different disease -- as this gene's OMIM number, which is precisely the
    class of error the machine annotations exist to remove.
    """

    def _adamtsl4(self) -> list[dict[str, Any]]:
        return [
            _clinvar("MONDO:0009152", gene_symbol="ADAMTSL4",
                     group_key="MONDO:0009152",
                     object_label="Ectopia lentis 2", evidence_count=8),
            _clinvar("OMIM:225100", gene_symbol="ADAMTSL4",
                     group_key="MONDO:0009152",
                     object_label="Ectopia lentis 2", evidence_count=8),
            _clinvar("Orphanet:1885", gene_symbol="ADAMTSL4",
                     group_key="MONDO:0009152",
                     object_label="Ectopia lentis 2", evidence_count=8),
            _orphadata("OMIM:129600", "BTNT", gene_symbol="ADAMTSL4",
                       group_key="MONDO:0009152"),
            _orphadata("OMIM:225200", "BTNT", gene_symbol="ADAMTSL4",
                       group_key="MONDO:0009152"),
            _orphadata("MeSH:D004479", "E", gene_symbol="ADAMTSL4",
                       group_key="MONDO:0009152"),
        ]

    def test_a_broader_codes_omim_never_overwrites_the_attested_one(self) -> None:
        row = pivot_disease_annotations(self._adamtsl4())[0]
        assert row["omim_id"] == "225100"

    def test_the_subtypes_are_published_with_the_relation_orphanet_reported(
        self,
    ) -> None:
        row = pivot_disease_annotations(self._adamtsl4())[0]
        assert row["related_xrefs"] == [
            {"id": "MeSH:D004479", "relation": "E"},
            {"id": "OMIM:129600", "relation": "BTNT"},
            {"id": "OMIM:225200", "relation": "BTNT"},
        ]

    def test_an_identifier_already_published_is_not_repeated_as_related(
        self,
    ) -> None:
        """Orphanet:1885 maps BTNT to the very OMIM number ClinVar attests."""
        rows = [
            *self._adamtsl4(),
            _orphadata("OMIM:225100", "BTNT", gene_symbol="ADAMTSL4",
                       group_key="MONDO:0009152"),
        ]
        row = pivot_disease_annotations(rows)[0]
        assert row["omim_id"] == "225100"
        assert "OMIM:225100" not in [x["id"] for x in row["related_xrefs"]]

    def test_an_exact_mapping_may_fill_a_column_clinvar_left_empty(self) -> None:
        rows = [_clinvar("MONDO:0010829"), _orphadata("OMIM:600142", "E")]
        row = pivot_disease_annotations(rows)[0]
        assert row["omim_id"] == "600142"
        assert row["related_xrefs"] == []

    def test_an_exact_mapping_disagreeing_with_clinvar_is_published_not_dropped(
        self,
    ) -> None:
        """24 real disagreements were previously written nowhere at all.

        Orphanet calls OMIM:100300 an exact mapping of NOTCH3's ORPHAcode while
        ClinVar attests OMIM:616028 for the same disease group. Both are
        assertions by a reference database; the reader gets to see both.
        """
        rows = [_clinvar("OMIM:616028"), _orphadata("OMIM:100300", "E")]
        row = pivot_disease_annotations(rows)[0]
        assert row["omim_id"] == "616028"
        assert row["related_xrefs"] == [{"id": "OMIM:100300", "relation": "E"}]

    def test_an_authority_with_no_column_still_reaches_the_reader(self) -> None:
        """MeSH and UMLS were previously invisible in the published file."""
        rows = [_clinvar("MONDO:0010829"), _orphadata("UMLS:C1838577", "E")]
        row = pivot_disease_annotations(rows)[0]
        assert row["related_xrefs"] == [{"id": "UMLS:C1838577", "relation": "E"}]


class TestASecondIdOfOneAuthorityIsPublishedNotLost:
    """ClinVar can attest two OMIM numbers for one disease group.

    Each ClinVar row of a prefix wrote the same column, so only the last
    id in ORDER BY survived -- and the overwritten one had already been
    added to the published set, which is exactly what `related_xrefs`
    excludes. It appeared in no column and no list.
    """

    def _rows(self) -> list[dict[str, Any]]:
        # ORDER BY object_id, as read_disease_annotations delivers them.
        return [
            _clinvar("MONDO:0010829"),
            _clinvar("MedGen:C0001"),
            _clinvar("MedGen:C0002"),
            _clinvar("OMIM:100000"),
            _clinvar("OMIM:200000"),
        ]

    def test_the_first_id_keeps_the_column(self) -> None:
        row = pivot_disease_annotations(self._rows())[0]
        assert row["omim_id"] == "100000"
        assert row["medgen_id"] == "C0001"

    def test_the_second_id_reaches_related_xrefs_with_no_relation(self) -> None:
        """ClinVar reports no mapping relation, and none is invented."""
        row = pivot_disease_annotations(self._rows())[0]
        assert row["related_xrefs"] == [
            {"id": "MedGen:C0002", "relation": None},
            {"id": "OMIM:200000", "relation": None},
        ]

    def test_the_group_key_wins_the_column_whatever_the_order(self) -> None:
        """A group keyed on an OMIM number must publish that number as
        omim_id, so a consumer can join the two -- but ORDER BY object_id
        can deliver another OMIM number first."""
        rows = [
            _clinvar("OMIM:100300", group_key="OMIM:125310"),
            _clinvar("OMIM:125310", group_key="OMIM:125310"),
        ]
        row = pivot_disease_annotations(rows)[0]
        assert row["omim_id"] == "125310"
        assert row["related_xrefs"] == [{"id": "OMIM:100300", "relation": None}]


class TestNoRelationIsInvented:
    """`side = "narrower" if q == "BTNT" else "broader"` was an else-catch-all.

    An absent relation, Orphanet's "ND" (not yet decided) and "W" (wrong
    mapping) were all published as an affirmative "broader" claim, and the
    compound "BTNT/E" -- which means the target is narrower -- was inverted.
    """

    def test_a_missing_relation_stays_missing(self) -> None:
        rows = [_clinvar("MONDO:0010829"), _orphadata("OMIM:600142", None)]
        row = pivot_disease_annotations(rows)[0]
        assert row["omim_id"] is None
        assert row["related_xrefs"] == [{"id": "OMIM:600142", "relation": None}]

    @pytest.mark.parametrize("relation", ["ND", "W", "BTNT/E", "NTBT"])
    def test_every_other_relation_is_reported_verbatim(self, relation: str) -> None:
        rows = [_clinvar("MONDO:0010829"), _orphadata("OMIM:600142", relation)]
        row = pivot_disease_annotations(rows)[0]
        assert row["related_xrefs"] == [
            {"id": "OMIM:600142", "relation": relation}
        ]


class TestOmimPhenotypicSeries:
    def test_a_series_is_not_the_diseases_own_omim_number(self) -> None:
        """PS143890 names a group of phenotypes; omimByNumber cannot resolve it."""
        rows = [_clinvar("OMIM:PS143890"), _clinvar("OMIM:143890")]
        row = pivot_disease_annotations(rows)[0]
        assert row["omim_id"] == "143890"
        assert row["omim_series"] == ["PS143890"]

    def test_a_disease_with_no_series_carries_an_empty_list(self) -> None:
        row = pivot_disease_annotations([_clinvar("OMIM:600142")])[0]
        assert row["omim_series"] == []

    def test_a_series_orphanet_maps_exactly_is_still_a_series(self) -> None:
        """The check sat on the ClinVar branch only, so an exact Orphadata
        mapping to a series filled omim_id with PS143890 -- the very value
        tests/annotations_test.ts asserts omimId never holds."""
        rows = [_clinvar("MONDO:0010829"), _orphadata("OMIM:PS143890", "E")]
        row = pivot_disease_annotations(rows)[0]
        assert row["omim_id"] is None
        assert row["omim_series"] == ["PS143890"]
        assert row["related_xrefs"] == []

    def test_a_series_orphanet_maps_loosely_is_still_a_series(self) -> None:
        rows = [_clinvar("MONDO:0010829"), _orphadata("OMIM:PS143890", "BTNT")]
        row = pivot_disease_annotations(rows)[0]
        assert row["omim_series"] == ["PS143890"]
        assert row["related_xrefs"] == []


def test_a_clinvar_xref_with_no_column_reaches_related_xrefs() -> None:
    """The same identifier used to be visible or invisible by source alone.

    A ClinVar row sets the group's disease name, classification and record
    count, but if its prefix has no published column -- MeSH and UMLS --
    it matched neither inner branch and was recorded nowhere, while
    Orphadata's MeSH and UMLS rows fell through to `related_xrefs` and
    were published. Five ClinVar MeSH cross-references were being dropped.

    The relation is absent rather than borrowed from `qualifier`, which on
    a ClinVar row is the clinical significance ("Pathogenic"), not a
    mapping relation.
    """
    rows = [_clinvar("MeSH:D000544"), _clinvar("MONDO:0010829")]
    row = pivot_disease_annotations(rows)[0]

    assert row["disease_name"] == "CARASIL syndrome"
    assert row["mondo_id"] == "MONDO:0010829"
    assert row["related_xrefs"] == [{"id": "MeSH:D000544", "relation": None}]


def test_a_clinvar_xref_promoted_to_a_column_is_not_also_related() -> None:
    """The published-id invariant still holds for the new branch."""
    rows = [_clinvar("MeSH:D000544"), _clinvar("OMIM:600142")]
    row = pivot_disease_annotations(rows)[0]

    assert row["omim_id"] == "600142"
    assert [xref["id"] for xref in row["related_xrefs"]] == ["MeSH:D000544"]


def test_orphanets_relation_survives_a_clinvar_row_for_the_same_id() -> None:
    """ClinVar's placeholder must not outrank a relation Orphanet reported.

    Both sources cross-reference `MeSH:D001606`, and `read_disease_annotations`
    orders ClinVar first. ClinVar has no relation to give -- its qualifier is a
    clinical significance -- so it records `None`; keeping that as "the first
    relation seen" threw away Orphanet's exact mapping.
    """
    rows = [
        _clinvar("MONDO:0010829"),
        _clinvar("MeSH:D001606"),
        _orphadata("MeSH:D001606", "E"),
    ]
    row = pivot_disease_annotations(rows)[0]

    assert row["related_xrefs"] == [{"id": "MeSH:D001606", "relation": "E"}]


def test_a_reported_relation_is_never_replaced_by_a_later_one() -> None:
    """The first relation an ORDER BY reaches is the published one.

    The complement of the ClinVar case above: once a source has actually
    reported a relation, a later row for the same identifier leaves it
    alone, so the result stays a function of the ORDER BY rather than of
    which row happened to arrive last.
    """
    rows = [
        _clinvar("MONDO:0010829"),
        _orphadata("MeSH:D001606", "E"),
        _orphadata("MeSH:D001606", "NTBT"),
    ]
    row = pivot_disease_annotations(rows)[0]

    assert row["related_xrefs"] == [{"id": "MeSH:D001606", "relation": "E"}]


def test_a_source_version_is_carried_onto_the_published_row() -> None:
    """The version is written under the source that reported it.

    Every fixture passed `source_version: None`, so the branch that
    copies it never ran -- the published row would have silently lost the
    release the annotation came from.
    """
    row = pivot_disease_annotations(
        [_clinvar("MONDO:0010829", source_version="2026-08")]
    )[0]
    assert row["source_versions"] == {"clinvar": "2026-08"}


def test_no_source_version_leaves_the_source_null() -> None:
    # The source's key is present whenever it contributed a row -- that is
    # the provenance -- and its value is null when it names no release.
    row = pivot_disease_annotations([_clinvar("MONDO:0010829")])[0]
    assert row["source_versions"] == {"clinvar": None}


def test_each_source_keeps_its_own_version() -> None:
    """The whole point: one field could only ever name one source.

    ``ORDER BY … source`` reads clinvar first and orphadata last, so a
    single overwritten field published Orphadata's release date as the
    provenance of a row ClinVar attested.
    """
    row = pivot_disease_annotations(
        [
            _clinvar("MONDO:0010829"),
            _orphadata("OMIM:600142", "E", source_version="26.06"),
        ]
    )[0]
    assert row["source_versions"] == {"clinvar": None, "orphadata": "26.06"}


class TestPublishedScope:
    def test_open_targets_associations_are_not_published(self) -> None:
        """Its 1513 ranked associations are 20x the ClinVar set and are not
        monogenic-disease claims; they stay in PostgreSQL."""
        rows = [
            _clinvar("MONDO:0010829"),
            {"gene_symbol": "HTRA1", "source": "opentargets", "relation": "disease",
             "group_key": "MONDO:0005150", "object_id": "MONDO:0005150",
             "object_label": "age-related macular degeneration", "qualifier": None,
             "score": 0.635, "evidence_count": None, "source_version": "26.06"},
        ]
        pivoted = pivot_disease_annotations(rows)
        assert [r["group_key"] for r in pivoted] == ["MONDO:0010829"]


class TestReadDiseaseAnnotations:
    async def test_a_missing_table_publishes_nothing_rather_than_aborting(
        self, mocker, caplog
    ) -> None:
        """gene_annotations arrives with migration 008 and is filled separately.

        Without this the whole export is discarded at step [9/9], after the
        four network lookup stages have already run.
        """
        import asyncpg

        conn = AsyncMock()
        conn.fetch = AsyncMock(
            side_effect=asyncpg.UndefinedTableError("relation does not exist")
        )
        _mock_connection(mocker, conn)

        with caplog.at_level(logging.WARNING):
            assert await read_disease_annotations() == []

        assert "gene_annotations" in caplog.text
        assert "--sync-annotations" in caplog.text

    @pytest.mark.parametrize(
        "failure",
        [
            asyncpg.UndefinedColumnError('column "qualifier" does not exist'),
            asyncpg.InsufficientPrivilegeError("permission denied"),
            RuntimeError("the pool connection dropped"),
        ],
    )
    async def test_any_other_failure_fails_the_export(
        self, mocker, failure: Exception
    ) -> None:
        """run_export reads `[]` as "not synced yet" and keeps the committed
        data/gene_annotations.json -- so an error swallowed here freezes that
        file at its last good read, shipping stale annotations beside freshly
        regenerated tables with a successful exit code. Only the missing
        table is "not synced yet"; everything else has to abort.
        """
        conn = AsyncMock()
        conn.fetch = AsyncMock(side_effect=failure)
        _mock_connection(mocker, conn)

        with pytest.raises(type(failure)):
            await read_disease_annotations()

    async def test_rows_are_read_in_the_order_the_pivot_depends_on(
        self, mocker
    ) -> None:
        conn = AsyncMock()
        conn.fetch = AsyncMock(return_value=[])
        _mock_connection(mocker, conn)

        await read_disease_annotations()

        await_args = conn.fetch.await_args
        assert await_args is not None, "read_disease_annotations executed no SQL"
        assert (
            "ORDER BY gene_symbol, group_key, source, object_id" in await_args.args[0]
        )
        assert await_args.args[1] == ["clinvar", "orphadata"]
