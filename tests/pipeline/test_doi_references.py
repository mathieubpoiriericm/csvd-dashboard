"""DOI gene references: told apart from PMIDs, and cited from Europe PMC."""

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from pipeline.export.main import _pubmed_ids
from pipeline.export.text import is_doi
from pipeline.external_data_sync import get_all_pmids

_DOI = "10.21203/rs.3.rs-5926137/v1"

# The cases tests/citations_test.ts runs lib/citations.ts's isDoi over: one
# rule, so a reference the export keeps out of PubMed is one the page links.
_CASES = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "doi_cases.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("value", _CASES["doi"])
def test_is_doi_accepts_what_the_genes_table_links(value: str) -> None:
    assert is_doi(value) is True


@pytest.mark.parametrize("value", _CASES["notDoi"])
def test_is_doi_refuses_what_the_genes_table_does_not(value: str) -> None:
    assert is_doi(value) is False


def test_the_export_reads_a_doi_citation_beside_the_pmids() -> None:
    genes = [
        {"References": ["39298701", _DOI]},
        {"References": [f" {_DOI}", "12345678", "39298701"]},
    ]
    assert _pubmed_ids(genes) == ["39298701", _DOI, "12345678"]


async def test_sync_external_data_keeps_a_doi_reference_whole(mocker) -> None:
    conn = AsyncMock()
    conn.fetch = AsyncMock(return_value=[{"pmid": _DOI}, {"pmid": "12345678"}])
    ctx = AsyncMock()
    ctx.__aenter__ = AsyncMock(return_value=conn)
    ctx.__aexit__ = AsyncMock(return_value=None)
    mocker.patch("pipeline.external_data_sync.Database.connection", return_value=ctx)

    # Whole, not scanned for PMIDs: "5926137" is not one.
    assert await get_all_pmids() == [_DOI, "12345678"]
