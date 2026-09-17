"""Tests for pipeline.ncbi_gene_fetch — NCBI Gene information fetching."""

import logging
from unittest.mock import AsyncMock

import httpx

from pipeline import ncbi_http
from pipeline.ncbi_gene_fetch import (
    NCBIGeneInfo,
    SyncResult,
    _fetch_gene_summary,
    _fetch_ncbi_gene_uncached,
    clear_ncbi_cache,
    close_ncbi_client,
    fetch_ncbi_gene_info,
    fetch_ncbi_genes_batch,
    sync_ncbi_gene_info,
)

# ---------------------------------------------------------------------------
# NCBIGeneInfo dataclass
# ---------------------------------------------------------------------------


class TestNCBIGeneInfo:
    def test_field_access(self):
        info = NCBIGeneInfo(
            gene_symbol="NOTCH3",
            ncbi_uid="4854",
            description="notch receptor 3",
            aliases="CADASIL, CASIL",
        )
        assert info.gene_symbol == "NOTCH3"
        assert info.ncbi_uid == "4854"
        assert info.description == "notch receptor 3"
        assert info.aliases == "CADASIL, CASIL"

    def test_map_location_is_carried(self):
        """The band the phenogram places the gene by."""
        info = NCBIGeneInfo(gene_symbol="TRIM65", map_location="17q25.1")
        assert info.map_location == "17q25.1"


    def test_none_fields(self):
        info = NCBIGeneInfo(
            gene_symbol="FAKE", ncbi_uid=None, description=None, aliases=None
        )
        assert info.ncbi_uid is None
        assert info.description is None
        assert info.aliases is None


# ---------------------------------------------------------------------------
# clear_ncbi_cache
# ---------------------------------------------------------------------------


class TestClearCache:
    def test_clears_cache(self):
        import pipeline.ncbi_gene_fetch as mod

        mod._gene_cache["TEST"] = NCBIGeneInfo("TEST", "1", None, None)
        assert "TEST" in mod._gene_cache
        clear_ncbi_cache()
        assert len(mod._gene_cache) == 0


# ---------------------------------------------------------------------------
# fetch_ncbi_gene_info (cached wrapper)
# ---------------------------------------------------------------------------


class TestFetchNCBIGeneInfo:
    async def test_cache_hit(self):
        import pipeline.ncbi_gene_fetch as mod

        cached = NCBIGeneInfo("NOTCH3", "4854", "desc", "alias")
        mod._gene_cache["NOTCH3"] = cached

        result = await fetch_ncbi_gene_info("NOTCH3")
        assert result is cached

    async def test_cache_case_insensitive(self):
        import pipeline.ncbi_gene_fetch as mod

        cached = NCBIGeneInfo("notch3", "4854", "desc", "alias")
        mod._gene_cache["NOTCH3"] = cached

        result = await fetch_ncbi_gene_info("notch3")
        assert result is cached

    async def test_cache_miss_calls_uncached(self, mocker):
        expected = NCBIGeneInfo("HTRA1", "5654", "desc", None)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._fetch_ncbi_gene_uncached",
            return_value=expected,
        )
        result = await fetch_ncbi_gene_info("HTRA1")
        assert result is expected

    async def test_none_results_are_cached(self, mocker):
        mocker.patch(
            "pipeline.ncbi_gene_fetch._fetch_ncbi_gene_uncached",
            return_value=None,
        )
        result = await fetch_ncbi_gene_info("MISSING")
        assert result is None

        import pipeline.ncbi_gene_fetch as mod

        assert "MISSING" in mod._gene_cache
        assert mod._gene_cache["MISSING"] is None

    async def test_concurrent_calls_fetch_once(self, mocker):
        """Concurrent callers for the same symbol must share one upstream call.

        Regression guard for the thundering-herd race: before the fix, the
        second cache double-check happened before acquiring the NCBI
        semaphore, so N concurrent callers for one gene issued N NCBI
        requests instead of 1.
        """
        import asyncio

        import pipeline.ncbi_gene_fetch as mod

        clear_ncbi_cache()
        expected = NCBIGeneInfo("NOTCH3", "4854", "desc", None)
        call_count = 0

        async def slow_fetch(symbol: str) -> NCBIGeneInfo:
            nonlocal call_count
            call_count += 1
            # Yield so the scheduler can actually race — without this, the
            # first task would finish atomically and no race would be
            # observable even against a buggy implementation.
            await asyncio.sleep(0)
            return expected

        mocker.patch(
            "pipeline.ncbi_gene_fetch._fetch_ncbi_gene_uncached",
            side_effect=slow_fetch,
        )

        results = await asyncio.gather(
            *(fetch_ncbi_gene_info("NOTCH3") for _ in range(10))
        )
        assert all(r is expected for r in results)
        assert call_count == 1
        assert mod._gene_cache["NOTCH3"] is expected


# ---------------------------------------------------------------------------
# Shared NCBI gene-summary helpers
# ---------------------------------------------------------------------------


def _summary_client(response: httpx.Response) -> AsyncMock:
    mock_client = AsyncMock()
    mock_client.get = AsyncMock(return_value=response)
    return mock_client


class TestSelectUid:
    async def test_a_single_hit_costs_no_extra_request(self):
        """The common case must not pay for a candidate lookup."""
        client = _summary_client(httpx.Response(200, json={}))

        assert await ncbi_http.select_gene_uid(client, "NOTCH3", ["4854"]) == "4854"
        client.get.assert_not_called()

    async def test_the_first_hit_is_kept_when_it_already_matches(self):
        client = _summary_client(
            httpx.Response(
                200,
                json={
                    "result": {
                        "uids": ["79800", "387521"],
                        "79800": {"name": "CARF"},
                        "387521": {"name": "PEDS1"},
                    }
                },
            ),
        )

        assert (
            await ncbi_http.select_gene_uid(client, "CARF", ["79800", "387521"])
            == "79800"
        )

    async def test_no_matching_symbol_falls_back_to_the_first_hit(self):
        """Every hit is an alias match, so position is all there is to go on."""
        client = _summary_client(
            httpx.Response(
                200,
                json={
                    "result": {
                        "uids": ["111", "222"],
                        "111": {"name": "AAA"},
                        "222": {"name": "BBB"},
                    }
                },
            ),
        )

        assert await ncbi_http.select_gene_uid(client, "ZZZ", ["111", "222"]) == "111"

    async def test_the_fallback_warns_and_names_the_record_it_guessed(self, caplog):
        """The one branch that answers with an unverified name says so.

        Validation renames the extracted symbol to this record's name and
        publishes the gene under it, so at DEBUG the substitution reached
        `data/table1.json` with nothing in the run's log to show for it.
        """
        client = _summary_client(
            httpx.Response(
                200,
                json={
                    "result": {
                        "uids": ["111", "222"],
                        "111": {"name": "AAA"},
                        "222": {"name": "BBB"},
                    }
                },
            ),
        )

        with caplog.at_level(logging.WARNING, logger="pipeline.ncbi_http"):
            await ncbi_http.select_gene_uid(client, "ZZZ", ["111", "222"])

        warnings = [
            record.getMessage()
            for record in caplog.records
            if record.levelno == logging.WARNING
        ]
        assert len(warnings) == 1
        assert "ZZZ" in warnings[0]
        assert "AAA" in warnings[0]

    async def test_a_failed_candidate_lookup_refuses_to_guess(self):
        """A 500 leaves us unable to tell the hits apart, so we publish none.

        Returning the first hit would republish SLURP1 as ARSB, and
        `sync_ncbi_gene_info` stores anything with a uid as a success -- so
        one transient failure would pin the wrong gene for the 30-day
        `DB_CACHE_TTL_DAYS`.
        """
        client = _summary_client(httpx.Response(500))

        assert await ncbi_http.select_gene_uid(client, "ARSB", ["57152", "411"]) is None

    async def test_malformed_candidate_json_refuses_to_guess(self):
        resp = httpx.Response(200, content=b"not json")
        client = _summary_client(resp)

        assert await ncbi_http.select_gene_uid(client, "ARSB", ["57152", "411"]) is None

    async def test_summaries_describing_none_of_the_uids_still_falls_back(self):
        """An answer naming no candidate is not the same as no answer.

        NCBI replied, so we know the hits are all alias matches; the first
        is as good as any. Only an unanswered call blocks the row.
        """
        client = _summary_client(httpx.Response(200, json={"result": {}}))

        assert (
            await ncbi_http.select_gene_uid(client, "ARSB", ["57152", "411"]) == "57152"
        )

    async def test_summaries_drop_the_non_dict_uids_key(self):
        """esummary's `result.uids` is a list beside the per-uid dicts."""
        client = _summary_client(
            httpx.Response(
                200,
                json={"result": {"uids": ["411"], "411": {"name": "ARSB"}}},
            ),
        )

        summaries = await ncbi_http.fetch_gene_summaries(client, ["411"])

        assert summaries == {"411": {"name": "ARSB"}}


# ---------------------------------------------------------------------------
# _fetch_ncbi_gene_uncached
# ---------------------------------------------------------------------------


class TestFetchNCBIGeneUncached:
    async def test_successful_2step_flow(self, mocker):
        """esearch finds gene ID, esummary returns details."""
        search_resp = httpx.Response(
            200,
            json={"esearchresult": {"count": "1", "idlist": ["4854"]}},
        )
        summary_info = NCBIGeneInfo("NOTCH3", "4854", "notch receptor 3", "CADASIL")

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search_resp)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )
        mocker.patch(
            "pipeline.ncbi_gene_fetch._fetch_gene_summary",
            return_value=summary_info,
        )

        result = await _fetch_ncbi_gene_uncached("NOTCH3")
        assert result is summary_info

    async def test_the_search_asks_for_every_candidate(self, mocker):
        """retmax is raised above NCBI's default page of 20.

        `select_gene_uid` can only choose among the hits it is shown; a symbol
        that is an alias of more than twenty genes would otherwise have its
        own record past the window, and the fallback would publish the
        first alias hit as the gene.
        """
        search_resp = httpx.Response(
            200, json={"esearchresult": {"count": "0", "idlist": []}}
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search_resp)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        await _fetch_ncbi_gene_uncached("ARSB")

        params = mock_client.get.call_args.kwargs["params"]
        assert params["retmax"] == "100"
        assert params["term"] == "ARSB[Sym] AND Homo sapiens[Organism]"

    async def test_an_alias_hit_never_beats_the_official_symbol(self, mocker):
        """`ARSB[Sym]` returns SLURP1 first, because SLURP1 is aliased ArsB.

        Measured against the live API on 2026-09-01: the search returns
        ['57152', '411', '91526'], so taking idlist[0] filed arylsulfatase B
        under SLURP1's record and published it in data/gene_info.json. The
        ordering is NCBI's and is not stable -- CARF was wrong the same way
        in May and is correct today -- so the official symbol has to be
        checked rather than the position trusted.
        """
        responses = {
            "esearch": httpx.Response(
                200,
                json={
                    "esearchresult": {
                        "count": "3",
                        "idlist": ["57152", "411", "91526"],
                    }
                },
            ),
            "esummary": httpx.Response(
                200,
                json={
                    "result": {
                        "uids": ["57152", "411", "91526"],
                        "57152": {
                            "name": "SLURP1",
                            "description": "secreted LY6/PLAUR domain containing 1",
                            "otheraliases": "ANUP, ARS, ArsB",
                        },
                        "411": {
                            "name": "ARSB",
                            "description": "arylsulfatase B",
                            "otheraliases": "ASB, G4S, MPS6",
                        },
                        "91526": {
                            "name": "ANKRD44",
                            "description": "ankyrin repeat domain 44",
                            "otheraliases": "",
                        },
                    }
                },
            ),
        }

        def _route(url, *args, **kwargs):
            key = "esearch" if "esearch" in str(url) else "esummary"
            return responses[key]

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=_route)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_ncbi_gene_uncached("ARSB")

        assert result is not None
        assert result.ncbi_uid == "411"
        assert result.description == "arylsulfatase B"

    async def test_a_renamed_symbol_still_resolves(self, mocker):
        """C6orf195 is obsolete and NCBI answers with LINC01600.

        No returned record carries the searched symbol, so requiring an exact
        match would lose the gene entirely. The first hit is the right answer
        here -- the guard above must not turn a rename into a miss.
        """
        responses = {
            "esearch": httpx.Response(
                200,
                json={"esearchresult": {"count": "1", "idlist": ["154386"]}},
            ),
            "esummary": httpx.Response(
                200,
                json={
                    "result": {
                        "uids": ["154386"],
                        "154386": {
                            "name": "LINC01600",
                            "description": (
                                "long independently transcribed non-coding RNA 1600"
                            ),
                            "otheraliases": "C6orf195",
                        },
                    }
                },
            ),
        }

        def _route(url, *args, **kwargs):
            key = "esearch" if "esearch" in str(url) else "esummary"
            return responses[key]

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=_route)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_ncbi_gene_uncached("C6orf195")

        assert result is not None
        assert result.ncbi_uid == "154386"

    async def test_an_unverifiable_hit_is_never_published(self, mocker):
        """A failed candidate lookup must not publish a guess.

        `select_gene_uid` cannot tell which of several alias hits is the gene
        when the candidate esummary fails, and `sync_ncbi_gene_info` stores
        anything carrying a uid as a success -- so returning the first hit
        here would republish SLURP1 as ARSB and the 30-day
        `DB_CACHE_TTL_DAYS` would hold it there. `cacheable_miss=False` is
        the existing machinery for exactly this: the row is not written and
        the next sync retries it.
        """
        # Only the *candidate* lookup fails -- the one carrying several ids.
        # The per-gene summary that follows would succeed, so without the
        # guard this publishes SLURP1 under ARSB rather than failing.
        def _route(url, *args, **kwargs):
            if "esearch" in str(url):
                return httpx.Response(
                    200,
                    json={
                        "esearchresult": {"count": "2", "idlist": ["57152", "411"]}
                    },
                )
            if "," in kwargs["params"]["id"]:
                return httpx.Response(500)
            return httpx.Response(
                200,
                json={
                    "result": {
                        "uids": ["57152"],
                        "57152": {
                            "name": "SLURP1",
                            "description": "secreted LY6/PLAUR domain containing 1",
                            "otheraliases": "ArsB",
                        },
                    }
                },
            )

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=_route)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_ncbi_gene_uncached("ARSB")

        assert result is not None
        assert result.ncbi_uid is None
        assert result.cacheable_miss is False

    async def test_gene_not_found_count_zero(self, mocker):
        """esearch returns count=0 → NCBIGeneInfo with None uid."""
        resp = httpx.Response(
            200,
            json={"esearchresult": {"count": "0", "idlist": []}},
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=resp)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_ncbi_gene_uncached("FAKEGENE")
        assert result is not None
        assert result.gene_symbol == "FAKEGENE"
        assert result.ncbi_uid is None

    async def test_non_200_returns_none(self, mocker):
        resp = httpx.Response(500)
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=resp)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_ncbi_gene_uncached("NOTCH3")
        assert result is None

    async def test_timeout_returns_none(self, mocker):
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_ncbi_gene_uncached("NOTCH3")
        assert result is None

    async def test_request_error_returns_none(self, mocker):
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.RequestError("connection failed"))
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_ncbi_gene_uncached("NOTCH3")
        assert result is None

    async def test_key_error_in_json_returns_none(self, mocker):
        resp = httpx.Response(200, json={"unexpected": "format"})
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=resp)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_ncbi_gene_uncached("NOTCH3")
        assert result is None


# ---------------------------------------------------------------------------
# _fetch_gene_summary
# ---------------------------------------------------------------------------


class TestFetchGeneSummary:
    async def test_successful_fetch(self, mocker):
        resp = httpx.Response(
            200,
            json={
                "result": {
                    "4854": {
                        "description": "notch receptor 3",
                        "otheraliases": "CADASIL, CASIL",
                    }
                }
            },
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=resp)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_gene_summary("NOTCH3", "4854")
        assert result is not None
        assert result.ncbi_uid == "4854"
        assert result.description == "notch receptor 3"
        assert result.aliases == "CADASIL, CASIL"

    async def test_error_field_in_response(self, mocker):
        resp = httpx.Response(
            200,
            json={"result": {"4854": {"error": "gene not found"}}},
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=resp)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_gene_summary("NOTCH3", "4854")
        assert result is None

    async def test_missing_gene_data(self, mocker):
        resp = httpx.Response(200, json={"result": {}})
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=resp)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_gene_summary("NOTCH3", "4854")
        assert result is None

    async def test_timeout(self, mocker):
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_gene_summary("NOTCH3", "4854")
        assert result is None

    async def test_non_200_returns_none(self, mocker):
        client = AsyncMock()
        client.get.return_value = httpx.Response(503)
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get", return_value=client
        )

        assert await _fetch_gene_summary("NOTCH3", "4854") is None

    async def test_request_error_returns_none(self, mocker):
        client = AsyncMock()
        client.get.side_effect = httpx.RequestError("network")
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get", return_value=client
        )

        assert await _fetch_gene_summary("NOTCH3", "4854") is None

    async def test_invalid_json_returns_none(self, mocker):
        client = AsyncMock()
        client.get.return_value = httpx.Response(200, content=b"not-json")
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get", return_value=client
        )

        assert await _fetch_gene_summary("NOTCH3", "4854") is None


async def test_close_ncbi_client(mocker):
    close = mocker.patch(
        "pipeline.ncbi_gene_fetch._client_manager.close", AsyncMock()
    )

    await close_ncbi_client()

    close.assert_awaited_once_with()


# ---------------------------------------------------------------------------
# fetch_ncbi_genes_batch
# ---------------------------------------------------------------------------


class TestFetchNCBIGenesBatch:
    async def test_empty_list(self):
        result = await fetch_ncbi_genes_batch([])
        assert result == []

    async def test_placeholder_for_failed(self, mocker):
        mocker.patch(
            "pipeline.ncbi_gene_fetch.fetch_ncbi_gene_info",
            return_value=None,
        )
        result = await fetch_ncbi_genes_batch(["FAKE"])
        assert len(result) == 1
        assert result[0].gene_symbol == "FAKE"
        assert result[0].ncbi_uid is None

    async def test_progress_callback(self, mocker):
        info = NCBIGeneInfo("A", "1", None, None)
        mocker.patch(
            "pipeline.ncbi_gene_fetch.fetch_ncbi_gene_info",
            return_value=info,
        )
        calls = []
        await fetch_ncbi_genes_batch(
            ["A", "B"],
            progress_callback=lambda cur, tot: calls.append((cur, tot)),
        )
        assert len(calls) == 2
        assert calls[-1] == (2, 2)


# ---------------------------------------------------------------------------
# sync_ncbi_gene_info
# ---------------------------------------------------------------------------


class TestSyncNCBIGeneInfo:
    async def test_all_cached(self, mocker):
        mocker.patch(
            "pipeline.database.get_cached_ncbi_genes",
            return_value={"NOTCH3": {}, "HTRA1": {}},
        )
        result = await sync_ncbi_gene_info(["NOTCH3", "HTRA1"])
        assert isinstance(result, SyncResult)
        assert result.fetched == 0
        assert result.cached == 2

    async def test_mix_cached_and_new(self, mocker):
        mocker.patch(
            "pipeline.database.get_cached_ncbi_genes",
            return_value={"NOTCH3": {}},
        )
        fetched = NCBIGeneInfo("HTRA1", "5654", "desc", None)
        mocker.patch(
            "pipeline.ncbi_gene_fetch.fetch_ncbi_genes_batch",
            return_value=[fetched],
        )
        mock_upsert = mocker.patch(
            "pipeline.database.upsert_ncbi_genes_batch",
            return_value=1,
        )

        result = await sync_ncbi_gene_info(["NOTCH3", "HTRA1"])
        assert result.cached == 1
        assert result.fetched == 1
        assert result.failed == 0
        mock_upsert.assert_called_once()

    async def test_failed_lookups_stored(self, mocker):
        mocker.patch(
            "pipeline.database.get_cached_ncbi_genes",
            return_value={},
        )
        failed = NCBIGeneInfo("FAKE", None, None, None)
        mocker.patch(
            "pipeline.ncbi_gene_fetch.fetch_ncbi_genes_batch",
            return_value=[failed],
        )
        mock_upsert = mocker.patch(
            "pipeline.database.upsert_ncbi_genes_batch",
            return_value=1,
        )

        result = await sync_ncbi_gene_info(["FAKE"])
        assert result.failed == 1
        assert result.fetched == 0
        assert any("FAKE" in e for e in result.errors)
        # Failed lookups are also upserted
        mock_upsert.assert_called_once()

    async def test_transient_failures_not_stored(self, mocker):
        mocker.patch(
            "pipeline.database.get_cached_ncbi_genes",
            return_value={},
        )
        transient = NCBIGeneInfo("HTRA1", None, None, None, cacheable_miss=False)
        mocker.patch(
            "pipeline.ncbi_gene_fetch.fetch_ncbi_genes_batch",
            return_value=[transient],
        )
        mock_upsert = mocker.patch(
            "pipeline.database.upsert_ncbi_genes_batch",
            return_value=0,
        )

        result = await sync_ncbi_gene_info(["HTRA1"])
        assert result.failed == 1
        mock_upsert.assert_not_called()


class TestFetchGeneSummaryMapLocation:
    """esummary already states the band; it used to be dropped on the floor.

    Nothing else in the schema carried a chromosomal location, so a gene a
    run inserted published as "(unknown)" and reached no chromosome of the
    phenogram -- sixteen of them on the first year-long run.
    """

    async def test_the_summary_carries_the_map_location(self, mocker):
        mocker.patch.object(
            ncbi_http,
            "fetch_gene_summaries",
            AsyncMock(
                return_value={
                    "201292": {
                        "description": "tripartite motif containing 65",
                        "otheraliases": "C17orf39",
                        "maplocation": "17q25.1",
                    }
                }
            ),
        )
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=AsyncMock(),
        )

        info = await _fetch_gene_summary("TRIM65", "201292")

        assert info is not None
        assert info.map_location == "17q25.1"

    async def test_a_summary_stating_no_band_is_empty_not_missing(self, mocker):
        """A gene NCBI has no band for stores "", and the fill skips it."""
        mocker.patch.object(
            ncbi_http,
            "fetch_gene_summaries",
            AsyncMock(return_value={"1": {"description": "d", "otheraliases": ""}}),
        )
        mocker.patch(
            "pipeline.ncbi_gene_fetch._client_manager.get",
            return_value=AsyncMock(),
        )

        info = await _fetch_gene_summary("X", "1")

        assert info is not None
        assert info.map_location == ""
