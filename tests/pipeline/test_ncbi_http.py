"""Tests for pipeline.ncbi_http -- the one pacing rule for E-utilities."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

import pipeline.main as pipeline_main
from pipeline import ncbi_gene_fetch, ncbi_http, pdf_retrieval, pubmed_citations
from pipeline.api_telemetry import current_recorder, reset_recorder
from pipeline.config import NCBI_ESEARCH_URL, PipelineConfig


def _client(*responses):
    client = MagicMock()
    client.get = AsyncMock(side_effect=list(responses))
    return client


class TestGetWithRetry:
    async def test_a_429_is_retried_and_noted(self, mocker) -> None:
        reset_recorder()
        mocker.patch("pipeline.ncbi_http.throttle", new=AsyncMock())
        mocker.patch("asyncio.sleep", new=AsyncMock())
        limited = httpx.Response(
            429,
            headers={"retry-after": "0"},
            request=httpx.Request("GET", NCBI_ESEARCH_URL),
        )
        ok = httpx.Response(200, request=httpx.Request("GET", NCBI_ESEARCH_URL))

        resp = await ncbi_http.get_with_retry(
            _client(limited, ok), NCBI_ESEARCH_URL, {}, config=PipelineConfig()
        )

        assert resp is ok
        assert sum(row.retries for row in current_recorder().records()) == 1

    @pytest.mark.parametrize(("retries", "requests"), [(0, 1), (1, 2), (3, 4)])
    async def test_the_setting_counts_retries_not_attempts(
        self, mocker, retries: int, requests: int
    ) -> None:
        """N retries is N+1 requests, as it is for the Anthropic client.

        The loop used to make N *attempts* and give up on the Nth, so
        PIPELINE_MAX_RATE_LIMIT_RETRIES=1 gave NCBI one request and no
        retry at all while Anthropic got its one retry -- one setting with
        two meanings. Zero retries is still one request.
        """
        mocker.patch("pipeline.ncbi_http.throttle", new=AsyncMock())
        mocker.patch("asyncio.sleep", new=AsyncMock())
        limited = httpx.Response(
            429,
            headers={"retry-after": "0"},
            request=httpx.Request("GET", NCBI_ESEARCH_URL),
        )
        client = _client(*([limited] * (requests + 1)))

        resp = await ncbi_http.get_with_retry(
            client,
            NCBI_ESEARCH_URL,
            {},
            config=PipelineConfig(max_rate_limit_retries=retries),
        )

        assert resp is None
        assert client.get.await_count == requests

    async def test_transport_failures_return_none(self, mocker) -> None:
        mocker.patch("pipeline.ncbi_http.throttle", new=AsyncMock())
        client = _client(httpx.ReadTimeout("slow"))
        resp = await ncbi_http.get_with_retry(client, NCBI_ESEARCH_URL, {})
        assert resp is None

    @pytest.mark.parametrize(
        "failure",
        [httpx.ReadTimeout("slow"), httpx.ConnectError("refused")],
    )
    async def test_a_transport_failure_is_counted_as_an_error(
        self, mocker, failure
    ) -> None:
        """Nothing comes back, so the response hook never fires.

        An NCBI outage that failed eight papers published `calls: 40,
        ok: 40, errors: 0` for E-utilities and raised no api_errored
        warning, because trouble() only sees rows that errored or retried.
        """
        reset_recorder()
        mocker.patch("pipeline.ncbi_http.throttle", new=AsyncMock())

        assert (
            await ncbi_http.get_with_retry(_client(failure), NCBI_ESEARCH_URL, {})
            is None
        )

        rows = current_recorder().records()
        assert len(rows) == 1
        assert (rows[0].calls, rows[0].ok, rows[0].errors) == (1, 0, 1)
        assert rows[0].endpoint == "/entrez/eutils/esearch.fcgi"
        assert current_recorder().trouble() == rows

    async def test_a_non_429_answer_is_returned_for_the_caller_to_judge(
        self, mocker
    ) -> None:
        mocker.patch("pipeline.ncbi_http.throttle", new=AsyncMock())
        gone = httpx.Response(500, request=httpx.Request("GET", NCBI_ESEARCH_URL))
        resp = await ncbi_http.get_with_retry(_client(gone), NCBI_ESEARCH_URL, {})
        assert resp is gone


class TestThrottle:
    async def test_request_starts_are_spaced(self, mocker, monkeypatch) -> None:
        monkeypatch.delenv("NCBI_API_KEY", raising=False)
        ncbi_http.reset_pacing()
        # Two reads per throttle(): before the wait and after it.
        readings = [100.0, 100.0, 100.1, 100.34]
        clock = SimpleNamespace(monotonic=lambda: readings.pop(0))
        mocker.patch.object(ncbi_http, "time", clock)
        sleep = mocker.patch.object(ncbi_http.asyncio, "sleep", new=AsyncMock())

        await ncbi_http.throttle()
        await ncbi_http.throttle()

        # The second start came 0.1 s after the first; without a key the
        # interval is 0.34 s, so it waited the remaining 0.24.
        assert sleep.await_count == 1
        assert sleep.await_args.args[0] == pytest.approx(0.24)


class TestEveryEutilitiesCallerIsPaced:
    """The pacing only works if every caller shares it.

    Validation had the throttle and the 429 retry; the gene, citation,
    retrieval and metadata lookups each had a semaphore and nothing else,
    which bounds concurrency rather than rate -- the quantity NCBI limits.
    """

    @pytest.fixture(autouse=True)
    def _paced(self, mocker):
        self.throttle = mocker.patch("pipeline.ncbi_http.throttle", new=AsyncMock())
        self.ok = httpx.Response(
            200,
            request=httpx.Request("GET", NCBI_ESEARCH_URL),
            json={"esearchresult": {"count": "0"}},
        )

    async def test_gene_info(self, mocker) -> None:
        mocker.patch.object(
            ncbi_gene_fetch._client_manager, "get", return_value=_client(self.ok)
        )
        await ncbi_gene_fetch._fetch_ncbi_gene_uncached("NOTCH3")
        self.throttle.assert_awaited()

    async def test_citations(self, mocker) -> None:
        mocker.patch.object(
            pubmed_citations._client_manager, "get", return_value=_client(self.ok)
        )
        await pubmed_citations._fetch_pubmed_uncached("12345678")
        self.throttle.assert_awaited()

    async def test_abstract(self, mocker) -> None:
        mocker.patch.object(
            pdf_retrieval._client_manager, "get", return_value=_client(self.ok)
        )
        # The shared body is an esearch answer, which the abstract fetch
        # rightly refuses as not a PubMed record; pacing happened first.
        with pytest.raises(pdf_retrieval.RetrievalError):
            await pdf_retrieval.fetch_abstract("12345678")
        self.throttle.assert_awaited()

    async def test_metadata(self, mocker) -> None:
        mocker.patch.object(
            pipeline_main._metadata_client_manager, "get", return_value=_client(self.ok)
        )
        await pipeline_main.fetch_paper_metadata("12345678")
        self.throttle.assert_awaited()
