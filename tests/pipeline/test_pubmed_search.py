"""Tests for pipeline.pubmed_search — query building, filtering, search."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from pipeline.pubmed_search import (
    DISEASE_TERMS,
    GENETIC_TERMS,
    MARKER_TERMS,
    SVD_QUERY,
    PubMedSearchError,
    _build_query,
    _configure_entrez,
    filter_new_pmids,
    search_recent_papers,
)

# ---------------------------------------------------------------------------
# SVD_QUERY structure
# ---------------------------------------------------------------------------


class TestQueryStructure:
    def test_query_contains_disease_terms(self):
        for term in DISEASE_TERMS:
            assert term in SVD_QUERY

    def test_query_contains_genetic_terms(self):
        for term in GENETIC_TERMS:
            assert term in SVD_QUERY

    def test_query_contains_marker_terms(self):
        for term in MARKER_TERMS:
            assert term in SVD_QUERY

    def test_query_uses_title_abstract(self):
        assert "[Title/Abstract]" in SVD_QUERY

    def test_query_uses_boolean_operators(self):
        assert " AND " in SVD_QUERY
        assert " OR " in SVD_QUERY

    def test_build_query_returns_string(self):
        query = _build_query()
        assert isinstance(query, str)
        assert len(query) > 100

    def test_query_is_deterministic(self):
        assert _build_query() == _build_query()


# ---------------------------------------------------------------------------
# filter_new_pmids
# ---------------------------------------------------------------------------


class TestFilterNewPmids:
    def test_empty_inputs(self):
        assert filter_new_pmids([], set()) == []

    def test_all_new(self):
        result = filter_new_pmids(["1", "2", "3"], set())
        assert result == ["1", "2", "3"]

    def test_all_existing(self):
        result = filter_new_pmids(["1", "2"], {"1", "2"})
        assert result == []

    def test_mixed(self):
        result = filter_new_pmids(["1", "2", "3"], {"2"})
        assert result == ["1", "3"]

    def test_preserves_order(self):
        result = filter_new_pmids(["3", "1", "2"], {"2"})
        assert result == ["3", "1"]

    def test_deduplicates(self):
        result = filter_new_pmids(["1", "1", "2", "2"], set())
        assert result == ["1", "2"]

    def test_dedup_and_filter(self):
        result = filter_new_pmids(["1", "2", "1", "3"], {"2"})
        assert result == ["1", "3"]


# ---------------------------------------------------------------------------
# search_recent_papers
# ---------------------------------------------------------------------------


class TestSearchRecentPapers:
    def test_configure_entrez_is_idempotent(self, monkeypatch):
        monkeypatch.setenv("ENTREZ_EMAIL", "test@example.com")

        _configure_entrez()
        _configure_entrez()

        from Bio import Entrez

        assert Entrez.email == "test@example.com"

    async def test_invalid_days_back_zero(self):
        with pytest.raises(ValueError, match="days_back"):
            await search_recent_papers(0)

    async def test_invalid_days_back_negative(self):
        with pytest.raises(ValueError, match="days_back"):
            await search_recent_papers(-1)

    async def test_invalid_days_back_too_high(self):
        with pytest.raises(ValueError, match="days_back"):
            await search_recent_papers(365 * 10 + 1)

    async def test_valid_days_back_boundary_low(self, mocker):
        mock_handle = MagicMock()
        mocker.patch("pipeline.pubmed_search.Entrez.esearch", return_value=mock_handle)
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            return_value={"IdList": [], "Count": "0"},
        )
        result = await search_recent_papers(1)
        assert result == []

    async def test_valid_days_back_boundary_high(self, mocker):
        mock_handle = MagicMock()
        mocker.patch("pipeline.pubmed_search.Entrez.esearch", return_value=mock_handle)
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            return_value={"IdList": [], "Count": "0"},
        )
        result = await search_recent_papers(365 * 10)
        assert result == []

    async def test_returns_pmid_list(self, mocker):
        mock_handle = MagicMock()
        mocker.patch("pipeline.pubmed_search.Entrez.esearch", return_value=mock_handle)
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            return_value={"IdList": ["111", "222", "333"], "Count": "3"},
        )
        result = await search_recent_papers(7)
        assert result == ["111", "222", "333"]

    async def test_entrez_error_raises(self, mocker):
        from urllib.error import URLError

        mocker.patch(
            "pipeline.pubmed_search.Entrez.esearch",
            side_effect=URLError("Network error"),
        )
        with pytest.raises(PubMedSearchError, match="Entrez API"):
            await search_recent_papers(7)

    async def test_html_on_a_200_raises_pubmed_search_error(self, mocker):
        # An NCBI maintenance page arrives as a 200 whose body is not XML.
        # Biopython reports that as NotXMLError, a ValueError subclass that
        # the transport-error tuple did not cover, so it escaped bare while
        # the docstring promised PubMedSearchError.
        from Bio.Entrez.Parser import NotXMLError

        mocker.patch("pipeline.pubmed_search.Entrez.esearch", return_value=MagicMock())
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            side_effect=NotXMLError("Failed to parse the XML data"),
        )

        with pytest.raises(PubMedSearchError, match="Entrez API"):
            await search_recent_papers(7)

    async def test_html_during_pagination_truncates_instead_of_raising(
        self, mocker, caplog
    ):
        from Bio.Entrez.Parser import CorruptedXMLError

        mocker.patch("pipeline.pubmed_search.Entrez.esearch", return_value=MagicMock())
        first_batch = {
            "IdList": [str(i) for i in range(500)],
            "Count": "1000",
            "WebEnv": "WEBENV123",
            "QueryKey": "1",
        }
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            side_effect=[first_batch, CorruptedXMLError("truncated")],
        )

        import logging

        with caplog.at_level(logging.WARNING):
            result = await search_recent_papers(7)

        assert len(result) == 500
        assert any("TRUNCATED" in record.message for record in caplog.records)

    async def test_window_is_over_entrez_date_not_publication_date(self, mocker):
        # A record enters PubMed days to weeks after its publication date.
        # Searching on pdat, a weekly window misses every paper indexed
        # after the run whose pdat fell inside it -- permanently, since the
        # next window has moved on. edat is the date the record was added,
        # NCBI's own "what is new since" idiom; the overlap it produces is
        # deduped through pubmed_refs.
        search = mocker.patch(
            "pipeline.pubmed_search._run_entrez_search",
            new_callable=AsyncMock,
            return_value={"IdList": [], "Count": "0"},
        )

        await search_recent_papers(7)

        assert search.await_args.kwargs["datetype"] == "edat"

    async def test_missing_id_list_key(self, mocker):
        mock_handle = MagicMock()
        mocker.patch("pipeline.pubmed_search.Entrez.esearch", return_value=mock_handle)
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            return_value={"Count": "0"},
        )
        result = await search_recent_papers(7)
        assert result == []

    async def test_pagination_fetches_all_results(self, mocker):
        """When total > retmax, pagination fetches remaining results."""
        mock_handle = MagicMock()
        mocker.patch("pipeline.pubmed_search.Entrez.esearch", return_value=mock_handle)
        # First call returns initial batch with WebEnv/QueryKey
        first_batch = {
            "IdList": [str(i) for i in range(500)],
            "Count": "700",
            "WebEnv": "WEBENV123",
            "QueryKey": "1",
        }
        # Pagination call returns remaining
        second_batch = {
            "IdList": [str(i) for i in range(500, 700)],
            "Count": "700",
        }
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            side_effect=[first_batch, second_batch],
        )
        result = await search_recent_papers(7)
        assert len(result) == 700

    async def test_every_page_repeats_the_date_filter(self, mocker):
        """The window has to survive pagination, and it did not.

        esearch re-runs `term` even with a WebEnv and query_key supplied, so
        a page naming only the term searched the unfiltered index. Against
        the live API a 365-day window (795 papers) came back from page 2
        with Count=8265 and 205 of its 500 ids outside the window, and the
        truncation guard stayed silent because 500 + 500 exceeds 795.
        """
        mock_handle = MagicMock()
        esearch = mocker.patch(
            "pipeline.pubmed_search.Entrez.esearch", return_value=mock_handle
        )
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            side_effect=[
                {
                    "IdList": [str(i) for i in range(500)],
                    "Count": "700",
                    "WebEnv": "WEBENV123",
                    "QueryKey": "1",
                },
                {"IdList": [str(i) for i in range(500, 700)], "Count": "700"},
            ],
        )

        await search_recent_papers(365)

        assert esearch.call_count == 2
        first, second = (call.kwargs for call in esearch.call_args_list)
        for key in ("datetype", "mindate", "maxdate"):
            assert second[key] == first[key], (
                f"page 2 dropped {key}, so it searched outside the window"
            )
        assert second["retstart"] == 500

    async def test_pagination_error_logs_truncation_warning(self, mocker, caplog):
        """Bug 4: pagination failure logs a clear truncation warning."""
        from urllib.error import URLError

        mock_handle = MagicMock()
        mocker.patch("pipeline.pubmed_search.Entrez.esearch", return_value=mock_handle)
        # First call returns initial batch with WebEnv/QueryKey
        first_batch = {
            "IdList": [str(i) for i in range(500)],
            "Count": "1000",
            "WebEnv": "WEBENV123",
            "QueryKey": "1",
        }
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            side_effect=[first_batch, URLError("Network error")],
        )

        import logging

        with caplog.at_level(logging.WARNING):
            result = await search_recent_papers(7)

        # Should return partial results
        assert len(result) == 500
        # Should log a clear truncation warning
        assert any("TRUNCATED" in record.message for record in caplog.records)

    async def test_large_result_without_history_cannot_paginate(self, mocker):
        mocker.patch(
            "pipeline.pubmed_search._run_entrez_search",
            new_callable=AsyncMock,
            return_value={"IdList": ["1"], "Count": "600"},
        )

        assert await search_recent_papers(7) == ["1"]

    async def test_empty_pagination_batch_stops_loop(self, mocker):
        search = mocker.patch(
            "pipeline.pubmed_search._run_entrez_search",
            new_callable=AsyncMock,
        )
        search.side_effect = [
            {
                "IdList": [str(i) for i in range(500)],
                "Count": "600",
                "WebEnv": "env",
                "QueryKey": "1",
            },
            {"IdList": []},
        ]

        assert len(await search_recent_papers(7)) == 500

    async def test_a_rejected_field_tag_raises(self, mocker):
        # A field NCBI does not know is reported inside a 200 as
        # ErrorList/FieldNotFound with Count 0 -- which read as "no new
        # papers" and a green run, indefinitely.
        mocker.patch(
            "pipeline.pubmed_search._run_entrez_search",
            new_callable=AsyncMock,
            return_value={
                "IdList": [],
                "Count": "0",
                "ErrorList": {"FieldNotFound": ["Title/Abstrct"], "PhraseNotFound": []},
            },
        )

        with pytest.raises(PubMedSearchError, match="FieldNotFound"):
            await search_recent_papers(7)

    async def test_an_unindexed_phrase_is_logged_not_fatal(self, mocker, caplog):
        # PhraseNotFound is NCBI saying one OR-branch matched nothing; the
        # rest of the query still answers.
        mocker.patch(
            "pipeline.pubmed_search._run_entrez_search",
            new_callable=AsyncMock,
            return_value={
                "IdList": ["1"],
                "Count": "1",
                "ErrorList": {"PhraseNotFound": ["nonesuch"], "FieldNotFound": []},
            },
        )

        import logging

        with caplog.at_level(logging.WARNING):
            assert await search_recent_papers(7) == ["1"]

        assert "nonesuch" in caplog.text

    async def test_a_pagination_failure_is_reported_to_the_caller(self, mocker):
        # A log line is not a report: the run ended `completed` over a
        # window it had only partly retrieved.
        from urllib.error import URLError

        mocker.patch("pipeline.pubmed_search.Entrez.esearch", return_value=MagicMock())
        first_batch = {
            "IdList": [str(i) for i in range(500)],
            "Count": "1000",
            "WebEnv": "WEBENV123",
            "QueryKey": "1",
        }
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            side_effect=[first_batch, URLError("Network error")],
        )
        on_truncated = MagicMock()

        result = await search_recent_papers(7, on_truncated=on_truncated)

        assert len(result) == 500
        on_truncated.assert_called_once_with(500, 1000)

    async def test_the_result_cap_is_reported_to_the_caller(
        self, mocker, monkeypatch
    ):
        # A 10-year window matches ~8000 papers; the cap dropped the tail
        # with a log line, and every later window ends at now, so those
        # papers were never in any run.
        monkeypatch.setattr("pipeline.pubmed_search.MAX_TOTAL_RESULTS", 2)
        mocker.patch(
            "pipeline.pubmed_search._run_entrez_search",
            new_callable=AsyncMock,
            return_value={
                "IdList": ["1", "2"],
                "Count": "600",
                "WebEnv": "env",
                "QueryKey": "1",
            },
        )
        on_truncated = MagicMock()

        result = await search_recent_papers(7, on_truncated=on_truncated)

        assert len(result) == 2
        on_truncated.assert_called_once_with(2, 600)

    async def test_a_window_without_history_is_reported_to_the_caller(self, mocker):
        # No WebEnv/QueryKey means nothing to page through: the first 500
        # of the window were returned with no log line at all.
        mocker.patch(
            "pipeline.pubmed_search._run_entrez_search",
            new_callable=AsyncMock,
            return_value={"IdList": [str(i) for i in range(500)], "Count": "1000"},
        )
        on_truncated = MagicMock()

        result = await search_recent_papers(7, on_truncated=on_truncated)

        assert len(result) == 500
        on_truncated.assert_called_once_with(500, 1000)

    async def test_an_empty_pagination_batch_is_reported_to_the_caller(self, mocker):
        search = mocker.patch(
            "pipeline.pubmed_search._run_entrez_search",
            new_callable=AsyncMock,
        )
        search.side_effect = [
            {
                "IdList": [str(i) for i in range(500)],
                "Count": "1000",
                "WebEnv": "env",
                "QueryKey": "1",
            },
            {"IdList": []},
        ]
        on_truncated = MagicMock()

        result = await search_recent_papers(7, on_truncated=on_truncated)

        assert len(result) == 500
        on_truncated.assert_called_once_with(500, 1000)

    async def test_a_complete_search_reports_no_truncation(self, mocker):
        mocker.patch(
            "pipeline.pubmed_search._run_entrez_search",
            new_callable=AsyncMock,
            return_value={"IdList": ["1"], "Count": "1"},
        )
        on_truncated = MagicMock()

        await search_recent_papers(7, on_truncated=on_truncated)

        on_truncated.assert_not_called()

    async def test_a_failed_search_call_is_recorded_as_an_error(self, mocker):
        # Only a successful esearch was recorded, so the services panel
        # could never show the search step's own failure.
        from email.message import Message
        from urllib.error import HTTPError

        from pipeline.api_telemetry import current_recorder, reset_recorder

        reset_recorder()
        mocker.patch(
            "pipeline.pubmed_search.Entrez.esearch",
            side_effect=HTTPError("u", 503, "Service Unavailable", Message(), None),
        )

        with pytest.raises(PubMedSearchError):
            await search_recent_papers(7)

        rows = current_recorder().records()
        assert [row.endpoint for row in rows] == ["/entrez/eutils/esearch.fcgi"]
        assert (rows[0].calls, rows[0].ok, rows[0].errors) == (1, 0, 1)

    async def test_a_transport_failure_without_a_status_is_still_an_error(
        self, mocker
    ):
        from urllib.error import URLError

        from pipeline.api_telemetry import current_recorder, reset_recorder

        reset_recorder()
        mocker.patch(
            "pipeline.pubmed_search.Entrez.esearch",
            side_effect=URLError("connection reset"),
        )

        with pytest.raises(PubMedSearchError):
            await search_recent_papers(7)

        rows = current_recorder().records()
        assert (rows[0].calls, rows[0].ok, rows[0].errors) == (1, 0, 1)

    async def test_result_cap_emits_warning(self, mocker, monkeypatch, caplog):
        monkeypatch.setattr("pipeline.pubmed_search.MAX_TOTAL_RESULTS", 2)
        mocker.patch(
            "pipeline.pubmed_search._run_entrez_search",
            new_callable=AsyncMock,
            return_value={
                "IdList": ["1", "2"],
                "Count": "600",
                "WebEnv": "env",
                "QueryKey": "1",
            },
        )

        await search_recent_papers(7)

        assert "PubMed results capped at 2" in caplog.text
