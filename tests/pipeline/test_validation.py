"""Tests for pipeline.validation — multi-stage validation, NCBI cache."""

import asyncio
import json
import logging
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from pipeline.config import PipelineConfig
from pipeline.validation import (
    NcbiUnavailableError,
    _fetch_ncbi_gene_uncached,
    _fetch_official_gene_symbol,
    _ncbi_get_with_retry,
    clear_gene_cache,
    close_validation_client,
    init_validation_state,
    validate_gene_entry,
    verify_ncbi_gene,
)


class TestValidationState:
    def test_eager_initialization_is_idempotent(self):
        import pipeline.validation as val

        val._cache_lock = None
        val._ncbi_semaphore = None

        init_validation_state(PipelineConfig(ncbi_rate_limit=7))
        initialized = (val._cache_lock, val._ncbi_semaphore)

        init_validation_state(PipelineConfig(ncbi_rate_limit=2))

        assert initialized == (val._cache_lock, val._ncbi_semaphore)
        assert val._ncbi_semaphore is not None
        assert val._ncbi_semaphore._value == 7

    def test_eager_initialization_uses_default_limit(self):
        import pipeline.validation as val

        val._cache_lock = asyncio.Lock()
        val._ncbi_semaphore = None

        init_validation_state()

        assert val._ncbi_semaphore is not None
        assert val._ncbi_semaphore._value == PipelineConfig().ncbi_rate_limit

    async def test_close_validation_client(self, mocker):
        close = mocker.patch(
            "pipeline.validation._client_manager.close", new_callable=AsyncMock
        )

        await close_validation_client()

        close.assert_awaited_once_with()

# ---------------------------------------------------------------------------
# Stage 1: Confidence threshold
# ---------------------------------------------------------------------------


class TestConfidenceValidation:
    async def test_low_confidence_rejected(self, make_gene_entry):
        entry = make_gene_entry(confidence=0.30)
        result = await validate_gene_entry(entry)
        assert not result.is_valid
        assert any("confidence" in e.lower() for e in result.errors)

    async def test_the_gate_here_is_the_permissive_one(
        self, make_gene_entry, mocker
    ):
        """0.50 reaches the merge now, and that is the point of the split.

        This gate runs during validation, before merge_gene_entries calls
        get_existing_genes() and learns which genes are new -- so it cannot
        apply the strict floor without also blocking a correct reference to
        a gene already in the table. BTN3A2 scored exactly 0.50, was
        rejected here, and was later confirmed correct by independent digit
        recovery. It now passes, and the strict floor is applied at the
        insert/update split instead.
        """
        mocker.patch(
            "pipeline.validation.verify_ncbi_gene",
            return_value="NOTCH3",
        )
        entry = make_gene_entry(confidence=0.50)
        result = await validate_gene_entry(entry)
        assert result.is_valid

    async def test_at_threshold_passes_stage1(self, make_gene_entry, mocker):
        entry = make_gene_entry(confidence=0.7)
        mocker.patch(
            "pipeline.validation.verify_ncbi_gene",
            return_value="NOTCH3",
        )
        result = await validate_gene_entry(entry)
        assert result.is_valid

    async def test_below_threshold_with_strict_config(self, make_gene_entry):
        entry = make_gene_entry(confidence=0.85)
        cfg = PipelineConfig(
            confidence_threshold_update=0.9, confidence_threshold_insert=0.95
        )
        result = await validate_gene_entry(entry, config=cfg)
        assert not result.is_valid

    async def test_above_threshold_with_strict_config(self, make_gene_entry, mocker):
        entry = make_gene_entry(confidence=0.95)
        cfg = PipelineConfig(
            confidence_threshold_update=0.9, confidence_threshold_insert=0.95
        )
        mocker.patch(
            "pipeline.validation.verify_ncbi_gene",
            return_value="NOTCH3",
        )
        result = await validate_gene_entry(entry, config=cfg)
        assert result.is_valid


# ---------------------------------------------------------------------------
# Stage 2: NCBI Gene lookup
# ---------------------------------------------------------------------------


class TestNcbiValidation:
    async def test_gene_not_found(self, make_gene_entry, mocker):
        entry = make_gene_entry(confidence=0.9)
        mocker.patch("pipeline.validation.verify_ncbi_gene", return_value=None)
        result = await validate_gene_entry(entry)
        assert not result.is_valid
        assert any("not found in NCBI" in e for e in result.errors)

    async def test_gene_found(self, make_gene_entry, mocker):
        entry = make_gene_entry(confidence=0.9)
        mocker.patch(
            "pipeline.validation.verify_ncbi_gene",
            return_value="NOTCH3",
        )
        result = await validate_gene_entry(entry)
        assert result.is_valid
        assert result.normalized_data is not None

    async def test_gene_symbol_normalized(self, make_gene_entry, mocker):
        entry = make_gene_entry(gene_symbol="notch3", confidence=0.9)
        mocker.patch(
            "pipeline.validation.verify_ncbi_gene",
            return_value="NOTCH3",
        )
        result = await validate_gene_entry(entry)
        assert result.is_valid
        assert result.normalized_data is not None
        assert result.normalized_data.gene_symbol == "NOTCH3"

    async def test_a_rename_is_logged_at_info_with_both_symbols(
        self, make_gene_entry, mocker, caplog
    ):
        """The substitution has to be visible at the level a run logs at.

        `[Sym]` matches aliases, so a paper reporting ARSB can validate as
        SLURP1 and be published under that symbol beside a quote naming
        ARSB. Nothing here said so, and `select_gene_uid`'s note was DEBUG,
        so the trace ended at the row itself.
        """
        entry = make_gene_entry(gene_symbol="ARSB", confidence=0.9, pmid="42437605")
        mocker.patch(
            "pipeline.validation.verify_ncbi_gene",
            return_value="SLURP1",
        )
        with caplog.at_level(logging.INFO, logger="pipeline.validation"):
            result = await validate_gene_entry(entry)
        assert result.normalized_data is not None
        assert result.normalized_data.gene_symbol == "SLURP1"
        renames = [
            record.getMessage()
            for record in caplog.records
            if record.levelno == logging.INFO and "renamed" in record.getMessage()
        ]
        assert len(renames) == 1
        assert "ARSB" in renames[0]
        assert "SLURP1" in renames[0]
        assert "42437605" in renames[0]

    async def test_a_symbol_that_is_already_official_logs_nothing(
        self, make_gene_entry, mocker, caplog
    ):
        """No substitution, no line: the log has to stay readable."""
        entry = make_gene_entry(gene_symbol="NOTCH3", confidence=0.9, pmid="")
        mocker.patch(
            "pipeline.validation.verify_ncbi_gene",
            return_value="NOTCH3",
        )
        with caplog.at_level(logging.INFO, logger="pipeline.validation"):
            await validate_gene_entry(entry)
        assert not [
            record for record in caplog.records if "renamed" in record.getMessage()
        ]

    async def test_a_rename_with_no_pmid_still_logs_both_symbols(
        self, make_gene_entry, mocker, caplog
    ):
        """`--local-pdfs` and `--pmids` entries can carry no PMID."""
        entry = make_gene_entry(gene_symbol="ARSB", confidence=0.9, pmid="")
        mocker.patch(
            "pipeline.validation.verify_ncbi_gene",
            return_value="SLURP1",
        )
        with caplog.at_level(logging.INFO, logger="pipeline.validation"):
            await validate_gene_entry(entry)
        renames = [
            record.getMessage()
            for record in caplog.records
            if "renamed" in record.getMessage()
        ]
        assert len(renames) == 1
        assert "PMID" not in renames[0]


# ---------------------------------------------------------------------------
# verify_ncbi_gene caching
# ---------------------------------------------------------------------------


class TestVerifyNcbiGeneCache:
    async def test_cache_hit(self, mocker):
        import pipeline.validation as val

        val._gene_cache["NOTCH3"] = "NOTCH3"

        mock_fetch = mocker.patch("pipeline.validation._fetch_ncbi_gene_uncached")
        result = await verify_ncbi_gene("NOTCH3")

        assert result == "NOTCH3"
        mock_fetch.assert_not_called()

    async def test_cache_miss_fetches(self, mocker):
        mocker.patch(
            "pipeline.validation._fetch_ncbi_gene_uncached",
            return_value="HTRA1",
        )
        result = await verify_ncbi_gene("HTRA1")
        assert result == "HTRA1"

    async def test_case_insensitive_cache(self, mocker):
        import pipeline.validation as val

        val._gene_cache["NOTCH3"] = "NOTCH3"

        mock_fetch = mocker.patch("pipeline.validation._fetch_ncbi_gene_uncached")
        result = await verify_ncbi_gene("notch3")
        assert result is not None
        mock_fetch.assert_not_called()

    async def test_cache_stores_none(self, mocker):
        import pipeline.validation as val

        mocker.patch(
            "pipeline.validation._fetch_ncbi_gene_uncached",
            return_value=None,
        )
        result = await verify_ncbi_gene("FAKEGENE")
        assert result is None
        assert val._gene_cache.get("FAKEGENE") is None

    def test_clear_gene_cache(self):
        import pipeline.validation as val

        val._gene_cache["TEST"] = "TEST"
        clear_gene_cache()
        assert len(val._gene_cache) == 0

    async def test_concurrent_calls_fetch_once(self, mocker):
        """Concurrent callers for the same symbol must share one upstream call.

        Regression guard for the thundering-herd race: before the fix, the
        double-check-after-semaphore pattern still let up to
        ``ncbi_rate_limit`` tasks race past the cache check in parallel
        because the semaphore admitted them concurrently.
        """
        import asyncio

        import pipeline.validation as val

        clear_gene_cache()
        call_count = 0

        async def slow_fetch(symbol: str, *, config=None) -> str:
            nonlocal call_count
            call_count += 1
            # Yield so the scheduler actually races — without this, the
            # first task would finish atomically and any buggy
            # implementation would still pass.
            await asyncio.sleep(0)
            return "NOTCH3"

        mocker.patch(
            "pipeline.validation._fetch_ncbi_gene_uncached",
            side_effect=slow_fetch,
        )

        results = await asyncio.gather(*(verify_ncbi_gene("NOTCH3") for _ in range(10)))
        assert results == ["NOTCH3"] * 10
        assert call_count == 1
        assert val._gene_cache["NOTCH3"] == "NOTCH3"


# ---------------------------------------------------------------------------
# _fetch_ncbi_gene_uncached — HTTP mocking
# ---------------------------------------------------------------------------


class TestFetchNcbiGene:
    async def test_successful_lookup(self, mocker):
        mock_client = AsyncMock()

        # Mock esearch response (use MagicMock so .json() is sync)
        search_response = MagicMock()
        search_response.status_code = 200
        search_response.json.return_value = {
            "esearchresult": {"count": "1", "idlist": ["4854"]}
        }

        # Mock esummary response
        summary_response = MagicMock()
        summary_response.status_code = 200
        summary_response.json.return_value = {
            "result": {
                "4854": {
                    "name": "NOTCH3",
                    "description": "notch receptor 3",
                    "chromosome": "19",
                    "otheraliases": "CADASIL",
                }
            }
        }

        mock_client.get = AsyncMock(side_effect=[search_response, summary_response])
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_ncbi_gene_uncached("NOTCH3")
        assert result == "NOTCH3"

    async def test_gene_not_found(self, mocker):
        mock_client = AsyncMock()
        search_response = MagicMock()
        search_response.status_code = 200
        search_response.json.return_value = {
            "esearchresult": {"count": "0", "idlist": []}
        }
        mock_client.get = AsyncMock(return_value=search_response)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_ncbi_gene_uncached("FAKEGENE")
        assert result is None

    # A transport failure is not "gene not found". None is what the cache
    # stores and what validate_gene_entry reports as a missing gene, so a
    # timeout returning None was remembered for the rest of the run and
    # every later mention of the same symbol was rejected with a reason
    # that was simply untrue.
    async def test_timeout_is_unavailable_not_absent(self, mocker):
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_ncbi_gene_uncached("NOTCH3")

    async def test_request_error_is_unavailable_not_absent(self, mocker):
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.RequestError("connection failed"))
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_ncbi_gene_uncached("NOTCH3")

    async def test_http_error_is_unavailable_not_absent(self, mocker):
        mock_client = AsyncMock()
        response = MagicMock()
        response.status_code = 500
        mock_client.get = AsyncMock(return_value=response)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_ncbi_gene_uncached("NOTCH3")

    async def test_non_json_body_is_unavailable_not_absent(self, mocker):
        # A 200 carrying an HTML maintenance page. The sibling esummary
        # call already caught this; the esearch call let the parser error
        # escape to every waiter as a rejection with a JSON message.
        response = MagicMock(status_code=200)
        response.json.side_effect = json.JSONDecodeError("bad JSON", "", 0)
        mocker.patch(
            "pipeline.validation._ncbi_get_with_retry",
            return_value=response,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_ncbi_gene_uncached("NOTCH3")

    async def test_unavailable_is_not_cached(self, mocker):
        clear_gene_cache()
        fetch = mocker.patch(
            "pipeline.validation._fetch_ncbi_gene_uncached",
            new=AsyncMock(side_effect=[NcbiUnavailableError("down"), "NOTCH3"]),
        )

        with pytest.raises(NcbiUnavailableError):
            await verify_ncbi_gene("NOTCH3")
        assert await verify_ncbi_gene("NOTCH3") == "NOTCH3"
        assert fetch.await_count == 2

    async def test_malformed_search_response_is_unavailable(self, mocker):
        # A body with no idlist is not an answer about the gene. It used to
        # return None, which single_flight_get cached as "not found" for
        # the rest of the run.
        response = MagicMock(status_code=200)
        response.json.return_value = {"esearchresult": {"count": "1"}}
        mocker.patch(
            "pipeline.validation._ncbi_get_with_retry",
            return_value=response,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_ncbi_gene_uncached("NOTCH3")

    async def test_a_top_level_error_body_is_unavailable(self, mocker):
        # E-utilities reports a failed query inside a 200 as {"error": ...}.
        response = MagicMock(status_code=200)
        response.json.return_value = {"error": "Search Backend failed"}
        mocker.patch(
            "pipeline.validation._ncbi_get_with_retry",
            return_value=response,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_ncbi_gene_uncached("NOTCH3")

    async def test_the_search_asks_for_every_candidate(self, mocker):
        """retmax is raised above NCBI's default page of 20.

        [Sym] matches aliases, so a short symbol can return more hits than
        the default page holds, and the gene's own record could sit past
        the window where the symbol check cannot see it.
        """
        search_response = MagicMock(status_code=200)
        search_response.json.return_value = {
            "esearchresult": {"count": "0", "idlist": []}
        }
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search_response)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        await _fetch_ncbi_gene_uncached("ARSB")

        params = mock_client.get.call_args.kwargs["params"]
        assert params["retmax"] == "100"
        assert params["term"] == "ARSB[Sym] AND Homo sapiens[Organism]"

    async def test_an_alias_hit_never_renames_the_gene(self, mocker):
        """`ARSB[Sym]` returns SLURP1 (aliased ArsB) first.

        Validation rewrites the extracted symbol to the chosen record's
        name, so taking idlist[0] stored a paper's ARSB as SLURP1 -- the
        collision the gene-info sync was already fixed for. The record
        whose own symbol is the one searched for wins.
        """

        def _route(url, *args, **kwargs):
            params = kwargs["params"]
            if "esearch" in str(url):
                response = MagicMock(status_code=200)
                response.json.return_value = {
                    "esearchresult": {"count": "2", "idlist": ["57152", "411"]}
                }
                return response
            if "," in params["id"]:
                response = MagicMock(status_code=200)
                response.json.return_value = {
                    "result": {
                        "uids": ["57152", "411"],
                        "57152": {"name": "SLURP1", "otheraliases": "ArsB"},
                        "411": {"name": "ARSB", "otheraliases": "ASB"},
                    }
                }
                return response
            response = MagicMock(status_code=200)
            response.json.return_value = {
                "result": {params["id"]: {"name": "ARSB"}}
            }
            return response

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=_route)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        assert await _fetch_ncbi_gene_uncached("ARSB") == "ARSB"
        single = mock_client.get.call_args.kwargs["params"]["id"]
        assert single == "411"

    async def test_an_unverifiable_candidate_lookup_is_unavailable(self, mocker):
        """When the candidates cannot be told apart, nothing is answered.

        Guessing the first hit would validate -- and cache -- a different
        gene's symbol for the run.
        """

        def _route(url, *args, **kwargs):
            if "esearch" in str(url):
                response = MagicMock(status_code=200)
                response.json.return_value = {
                    "esearchresult": {"count": "2", "idlist": ["57152", "411"]}
                }
                return response
            return MagicMock(status_code=500)

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=_route)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_ncbi_gene_uncached("ARSB")


# ---------------------------------------------------------------------------
# _fetch_official_gene_symbol
# ---------------------------------------------------------------------------


class TestFetchOfficialGeneSymbol:
    async def test_successful_fetch(self, mocker):
        mock_client = AsyncMock()
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {
            "result": {
                "4854": {
                    "name": "NOTCH3",
                    "description": "notch receptor 3",
                    "chromosome": "19",
                    "otheraliases": "CADASIL, CASIL",
                }
            }
        }
        mock_client.get = AsyncMock(return_value=response)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_official_gene_symbol("4854")
        assert result == "NOTCH3"

    async def test_missing_name_field_is_unavailable(self, mocker):
        """A record with no symbol is a malformed answer, not a missing gene."""
        mock_client = AsyncMock()
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {
            "result": {
                "4854": {
                    "description": "notch receptor 3",
                    "chromosome": "19",
                }
            }
        }
        mock_client.get = AsyncMock(return_value=response)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_official_gene_symbol("4854")

    async def test_empty_name_field_is_unavailable(self, mocker):
        """Same as a missing name: esearch returned this uid, so it has one."""
        mock_client = AsyncMock()
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {
            "result": {
                "4854": {
                    "name": "",
                    "description": "notch receptor 3",
                    "chromosome": "19",
                }
            }
        }
        mock_client.get = AsyncMock(return_value=response)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_official_gene_symbol("4854")

    async def test_an_inband_error_is_unavailable_not_absent(self, mocker):
        """{"uid": ..., "error": "cannot get document summary"} is a failure.

        It is the in-band shape clinvar_fetch treats as a failed batch. Here
        it returned None, which single_flight_get cached under the symbol,
        so one hiccup on NOTCH3's summary rejected NOTCH3 on every later
        paper in the run without another request.
        """
        mock_client = AsyncMock()
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {
            "result": {"4854": {"uid": "4854", "error": "cannot get gene info"}}
        }
        mock_client.get = AsyncMock(return_value=response)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        with pytest.raises(NcbiUnavailableError, match="cannot get gene info"):
            await _fetch_official_gene_symbol("4854")

    async def test_a_summary_that_is_not_a_record_is_unavailable(self, mocker):
        response = MagicMock(status_code=200)
        response.json.return_value = {"result": {"4854": "not a record"}}
        mocker.patch(
            "pipeline.validation._ncbi_get_with_retry",
            return_value=response,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_official_gene_symbol("4854")

    async def test_a_summary_missing_the_uid_is_unavailable(self, mocker):
        response = MagicMock(status_code=200)
        response.json.return_value = {"result": {"uids": []}}
        mocker.patch(
            "pipeline.validation._ncbi_get_with_retry",
            return_value=response,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_official_gene_symbol("4854")

    async def test_http_error_is_unavailable(self, mocker):
        response = MagicMock(status_code=503)
        mocker.patch(
            "pipeline.validation._ncbi_get_with_retry",
            return_value=response,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_official_gene_symbol("4854")

    async def test_no_response_is_unavailable(self, mocker):
        mocker.patch(
            "pipeline.validation._ncbi_get_with_retry",
            return_value=None,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_official_gene_symbol("4854")

    async def test_invalid_json_is_unavailable(self, mocker):
        response = MagicMock(status_code=200)
        response.json.side_effect = json.JSONDecodeError("bad JSON", "", 0)
        mocker.patch(
            "pipeline.validation._ncbi_get_with_retry",
            return_value=response,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_official_gene_symbol("4854")


# ---------------------------------------------------------------------------
# _ncbi_get_with_retry — 429 retry behavior
# ---------------------------------------------------------------------------


class TestNcbiRetryOn429:
    async def test_zero_retries_still_makes_the_one_request(self, mocker):
        # The setting counts *retries*, but it bounded total attempts, so
        # PIPELINE_MAX_RATE_LIMIT_RETRIES=0 -- the obvious way to switch
        # backoff off -- made no request at all and every gene in the run
        # came back "not found".
        response = MagicMock(status_code=200)
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=response)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )

        result = await _ncbi_get_with_retry(
            "https://example.test",
            {},
            config=PipelineConfig(max_rate_limit_retries=0),
        )

        assert result is response
        mock_client.get.assert_awaited_once()

    async def test_429_then_200_succeeds(self, mocker):
        """First request returns 429, retry returns 200 — success."""
        mock_client = AsyncMock()

        resp_429 = MagicMock()
        resp_429.status_code = 429
        resp_429.headers = {"retry-after": "0.01"}

        resp_200 = MagicMock()
        resp_200.status_code = 200
        resp_200.json.return_value = {"ok": True}

        mock_client.get = AsyncMock(side_effect=[resp_429, resp_200])
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )
        mocker.patch("pipeline.validation.asyncio.sleep", new_callable=AsyncMock)

        cfg = PipelineConfig(max_rate_limit_retries=3, rate_limit_retry_delay=0.01)
        result = await _ncbi_get_with_retry(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
            {"db": "gene", "term": "test", "retmode": "json"},
            config=cfg,
            context="test",
        )

        assert result is not None
        assert result.status_code == 200
        assert mock_client.get.call_count == 2

    async def test_all_retries_exhausted_returns_none(self, mocker):
        """Every request returns 429 -- two retries is three requests, then None."""
        mock_client = AsyncMock()

        resp_429 = MagicMock()
        resp_429.status_code = 429
        resp_429.headers = {}

        mock_client.get = AsyncMock(return_value=resp_429)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )
        mocker.patch("pipeline.validation.asyncio.sleep", new_callable=AsyncMock)

        cfg = PipelineConfig(max_rate_limit_retries=2, rate_limit_retry_delay=0.01)
        result = await _ncbi_get_with_retry(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
            {"db": "gene", "term": "test", "retmode": "json"},
            config=cfg,
            context="test",
        )

        assert result is None
        assert mock_client.get.call_count == 3

    async def test_api_key_included_in_params(self, mocker):
        """When NCBI_API_KEY is set, api_key is injected into request params."""
        mock_client = AsyncMock()

        resp_200 = MagicMock()
        resp_200.status_code = 200

        mock_client.get = AsyncMock(return_value=resp_200)
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )
        mocker.patch.dict("os.environ", {"NCBI_API_KEY": "test-key-123"})

        await _ncbi_get_with_retry(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
            {"db": "gene", "term": "test", "retmode": "json"},
            context="test",
        )

        call_kwargs = mock_client.get.call_args
        params = call_kwargs.kwargs.get("params") or call_kwargs[1].get("params")
        assert params["api_key"] == "test-key-123"

    async def test_retry_after_header_respected(self, mocker):
        """Retry-after header value is used as the sleep duration."""
        mock_client = AsyncMock()

        resp_429 = MagicMock()
        resp_429.status_code = 429
        resp_429.headers = {"retry-after": "2.5"}

        resp_200 = MagicMock()
        resp_200.status_code = 200

        mock_client.get = AsyncMock(side_effect=[resp_429, resp_200])
        mocker.patch(
            "pipeline.validation._client_manager.get",
            return_value=mock_client,
        )
        mock_sleep = mocker.patch(
            "pipeline.validation.asyncio.sleep", new_callable=AsyncMock
        )

        cfg = PipelineConfig(max_rate_limit_retries=3, rate_limit_retry_delay=1.0)
        await _ncbi_get_with_retry(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
            {"db": "gene", "term": "test", "retmode": "json"},
            config=cfg,
            context="test",
        )

        # asyncio.sleep is called by both _throttle and the retry logic.
        # Find the retry sleep call (2.5s from retry-after header).
        retry_sleep_calls = [
            c for c in mock_sleep.call_args_list if c.args[0] == pytest.approx(2.5)
        ]
        assert len(retry_sleep_calls) == 1


class TestEsummaryShapes:
    async def test_a_non_object_body_is_a_format_problem_not_a_gene(self, mocker):
        response = MagicMock(status_code=200)
        response.json.return_value = []
        mocker.patch(
            "pipeline.validation._ncbi_get_with_retry",
            return_value=response,
        )

        with pytest.raises(NcbiUnavailableError):
            await _fetch_official_gene_symbol("4854")
