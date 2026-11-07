"""DOI gene references: told apart from PMIDs and kept out of PubMed lookups."""

from unittest.mock import AsyncMock

import pytest

from pipeline.export.main import _pubmed_ids
from pipeline.export.text import is_doi
from pipeline.external_data_sync import get_all_pmids

_DOI = "10.21203/rs.3.rs-5926137/v1"


def test_is_doi_accepts_a_doi_and_refuses_a_pmid() -> None:
    assert is_doi(_DOI) is True
    assert is_doi("39298701") is False


@pytest.mark.parametrize("value", ["10.1000", "(reference needed)", "", "1/2"])
def test_is_doi_needs_the_prefix_and_a_slash(value: str) -> None:
    assert is_doi(value) is False


def test_the_export_collects_no_doi_as_a_pmid() -> None:
    genes = [
        {"References": ["39298701", _DOI]},
        {"References": [_DOI, "12345678", "39298701"]},
    ]
    assert _pubmed_ids(genes) == ["39298701", "12345678"]


async def test_sync_external_data_skips_a_doi_reference(mocker) -> None:
    conn = AsyncMock()
    conn.fetch = AsyncMock(return_value=[{"pmid": _DOI}, {"pmid": "12345678"}])
    ctx = AsyncMock()
    ctx.__aenter__ = AsyncMock(return_value=conn)
    ctx.__aexit__ = AsyncMock(return_value=None)
    mocker.patch("pipeline.external_data_sync.Database.connection", return_value=ctx)

    assert await get_all_pmids() == ["12345678"]
