"""Tests for pipeline.api_telemetry -- the run's external-service inventory."""

import httpx
import pytest

from pipeline.api_telemetry import (
    SERVICES,
    ApiRecorder,
    current_recorder,
    display_label,
    normalize_path,
    record_service_call,
    record_service_failure,
    record_transport_failure,
    relabel_api_rows,
    reset_recorder,
    resolve_service,
)
from pipeline.http_client import AsyncHttpClientManager


@pytest.fixture(autouse=True)
def _fresh_recorder() -> None:
    """Every test starts from an empty inventory."""
    reset_recorder()


class TestNormalizePath:
    @pytest.mark.parametrize(
        ("path", "expected"),
        [
            ("/uniprotkb/P12345", "/uniprotkb/:id"),
            ("/europepmc/webservices/rest/PMC3312970/fullTextXML",
             "/europepmc/webservices/rest/:id/fullTextXML"),
            ("/entrez/eutils/esearch.fcgi", "/entrez/eutils/esearch.fcgi"),
            ("/rd-cross-referencing/orphacodes/166024",
             "/rd-cross-referencing/orphacodes/:id"),
            ("/", "/"),
            ("", "/"),
        ],
    )
    def test_identifier_segments_collapse(self, path: str, expected: str) -> None:
        assert normalize_path(path) == expected

    @pytest.mark.parametrize(
        "path", ["/api/v2/studies", "/tools/idconv/api/v1/articles"]
    )
    def test_version_segments_survive(self, path: str) -> None:
        # A version marker has digits but is a route name, not an id.
        assert ":id" not in normalize_path(path)


class TestResolveService:
    @pytest.mark.parametrize(
        ("host", "path", "label"),
        [
            ("eutils.ncbi.nlm.nih.gov", "/entrez/eutils/esearch.fcgi",
             "NCBI E-utilities"),
            ("pmc.ncbi.nlm.nih.gov", "/tools/idconv/api/v1/articles/",
             "NCBI PMC ID Converter"),
            ("www.ebi.ac.uk", "/europepmc/webservices/rest/search", "Europe PMC"),
            ("api.unpaywall.org", "/v2/10.1000/x", "Unpaywall"),
            ("rest.uniprot.org", "/uniprotkb/search", "UniProt"),
            ("clinicaltrials.gov", "/api/v2/studies", "ClinicalTrials.gov"),
            ("api.platform.opentargets.org", "/api/v4/graphql", "Open Targets"),
            ("api.orphadata.com", "/rd-cross-referencing/orphacodes/166024",
             "Orphadata"),
            ("linkinghub.elsevier.com", "/retrieve/pii/S0000",
             "Elsevier ScienceDirect"),
            ("journals.sagepub.com", "/doi/10.1177/x", "SAGE Journals"),
            ("www.jstage.jst.go.jp", "/article/mrms/1/2/3/_article", "J-STAGE"),
        ],
    )
    def test_known_services_resolve_to_display_names(
        self, host: str, path: str, label: str
    ) -> None:
        assert resolve_service(host, path)[1] == label

    def test_the_id_converter_is_registered_at_its_current_host(self) -> None:
        # pdf_retrieval calls pmc.ncbi.nlm.nih.gov directly now. While the
        # retired www.ncbi.nlm.nih.gov/pmc/utils/idconv URL was in use, the
        # 301 it answers with put the real call under an unregistered host,
        # so the converter's row in the panel was empty.
        key, _ = resolve_service(
            "pmc.ncbi.nlm.nih.gov", "/tools/idconv/api/v1/articles/"
        )
        assert key == "ncbi_idconv"

    def test_an_unregistered_host_is_kept_under_its_own_name(self) -> None:
        # download_and_parse_pdf follows whatever open-access URL Unpaywall
        # reported, so the host set is the publishing world and no allow-list
        # could be written for it. The hostname is the intended label here.
        key, label = resolve_service(
            "link.springer.com", "/content/pdf/10.1007/s00415-021-10614-6.pdf"
        )
        assert key == "link.springer.com"
        assert label == "link.springer.com"

    def test_clinvar_shares_the_e_utilities_row(self) -> None:
        # clinvar_fetch calls the same endpoints on the same host as gene
        # validation; only the query parameters differ, and the recorder
        # never sees those. A ClinVar entry would have to precede
        # ncbi_eutils and would then swallow every other E-utilities call.
        key, _ = resolve_service(
            "eutils.ncbi.nlm.nih.gov", "/entrez/eutils/esummary.fcgi"
        )
        assert key == "ncbi_eutils"

    @pytest.mark.parametrize("service", SERVICES, ids=lambda s: s.key)
    def test_every_registered_service_resolves_to_itself(self, service) -> None:
        # The executable form of the first-match-wins rule: an entry added
        # above a narrower one silently empties that one's row, and nothing
        # else would fail.
        key, _ = resolve_service(service.host_suffix, service.path_prefix or "/")
        assert key == service.key

    def test_host_matching_is_case_insensitive(self) -> None:
        assert resolve_service("REST.UniProt.ORG", "/uniprotkb/x")[1] == "UniProt"


class TestDisplayLabel:
    @pytest.mark.parametrize(
        ("key", "endpoint", "label"),
        [
            ("ncbi_eutils", "/entrez/eutils/esearch.fcgi", "E-utilities search"),
            ("ncbi_eutils", "/entrez/eutils/esummary.fcgi", "E-utilities summary"),
            ("ncbi_eutils", "/entrez/eutils/efetch.fcgi", "E-utilities fetch"),
            ("ncbi_eutils", "/entrez/eutils/elink.fcgi", "NCBI E-utilities"),
            ("europepmc", "/europepmc/webservices/rest/search", "Europe PMC search"),
            ("europepmc", "/europepmc/webservices/rest/:id/fullTextXML",
             "Europe PMC full text"),
            ("anthropic", "/v1/messages", "Anthropic"),
            ("mystery", "/x", "mystery"),
            # A host recorded before it was registered keeps its hostname as
            # its key; the registry can still name it on the way out.
            ("linkinghub.elsevier.com", "/retrieve/pii/:id", "Elsevier ScienceDirect"),
            ("link.springer.com", "/content/pdf/:id.pdf", "link.springer.com"),
        ],
    )
    def test_labels_are_qualified_by_endpoint(
        self, key: str, endpoint: str, label: str
    ) -> None:
        assert display_label(key, endpoint) == label

    def test_relabel_api_rows_rewrites_only_the_label(self) -> None:
        rows = [
            {"service": "ncbi_eutils", "label": "NCBI E-utilities",
             "endpoint": "/entrez/eutils/esearch.fcgi", "method": "GET", "calls": 6},
            {"service": "journals.sagepub.com", "label": "journals.sagepub.com",
             "endpoint": "/doi/:id/:id", "method": "GET", "calls": 1},
        ]
        assert relabel_api_rows(rows) == [
            {**rows[0], "label": "E-utilities search"},
            {**rows[1], "label": "SAGE Journals"},
        ]


class TestApiRecorder:
    def test_calls_to_one_endpoint_aggregate(self) -> None:
        recorder = ApiRecorder()
        for accession in ("P12345", "Q67890"):
            recorder.record(
                host="rest.uniprot.org",
                path=f"/uniprotkb/{accession}",
                method="GET",
                status=200,
            )
        rows = recorder.records()
        assert len(rows) == 1
        assert rows[0].calls == 2
        assert rows[0].endpoint == "/uniprotkb/:id"

    def test_methods_are_separate_rows(self) -> None:
        recorder = ApiRecorder()
        recorder.record(host="x.org", path="/a", method="GET", status=200)
        recorder.record(host="x.org", path="/a", method="POST", status=200)
        assert len(recorder.records()) == 2

    def test_a_non_2xx_counts_as_an_error(self) -> None:
        recorder = ApiRecorder()
        recorder.record(host="x.org", path="/a", method="GET", status=503)
        row = recorder.records()[0]
        assert (row.ok, row.errors) == (0, 1)
        assert row.had_trouble

    def test_a_404_is_not_found_rather_than_an_error(self) -> None:
        # europepmc.get_fulltext and pdf_retrieval.check_unpaywall both
        # treat a 404 as the normal "no open-access copy" answer and fall
        # back to the abstract. Counting it as an error made the run's
        # green badge unreachable.
        recorder = ApiRecorder()
        recorder.record(
            host="www.ebi.ac.uk",
            path="/europepmc/webservices/rest/PMC1/fullTextXML",
            method="GET",
            status=404,
        )
        row = recorder.records()[0]
        assert (row.ok, row.not_found, row.errors) == (0, 1, 0)
        assert not row.had_trouble
        assert recorder.trouble() == []

    def test_a_3xx_is_not_an_error(self) -> None:
        recorder = ApiRecorder()
        recorder.record(host="x.org", path="/a", method="GET", status=301)
        assert recorder.records()[0].errors == 0

    def test_retries_are_noted_separately_from_calls(self) -> None:
        recorder = ApiRecorder()
        recorder.record(host="x.org", path="/a", method="GET", status=200)
        recorder.note_retry(host="x.org", path="/a", method="GET")
        row = recorder.records()[0]
        assert (row.calls, row.retries) == (1, 1)
        assert row.had_trouble

    def test_a_retry_on_an_unseen_endpoint_still_records(self) -> None:
        recorder = ApiRecorder()
        recorder.note_retry(host="x.org", path="/a", method="GET")
        assert recorder.records()[0].retries == 1

    def test_a_clean_row_is_not_trouble(self) -> None:
        recorder = ApiRecorder()
        recorder.record(host="x.org", path="/a", method="GET", status=200)
        assert recorder.trouble() == []

    def test_rows_are_ordered_by_traffic_for_stable_output(self) -> None:
        recorder = ApiRecorder()
        recorder.record(host="quiet.org", path="/a", method="GET", status=200)
        for _ in range(3):
            recorder.record(host="busy.org", path="/b", method="GET", status=200)
        assert [row.service for row in recorder.records()] == ["busy.org", "quiet.org"]

    def test_totals_span_every_service(self) -> None:
        recorder = ApiRecorder()
        recorder.record(host="a.org", path="/x", method="GET", status=200)
        recorder.record(host="b.org", path="/y", method="GET", status=200)
        assert recorder.total_calls() == 2

    def test_timing_and_payload_accumulate(self) -> None:
        recorder = ApiRecorder()
        for _ in range(2):
            recorder.record(
                host="x.org",
                path="/a",
                method="GET",
                status=200,
                elapsed_ms=10.0,
                payload_bytes=100,
            )
        row = recorder.records()[0]
        assert row.total_ms == 20.0
        assert row.bytes == 200

    def test_timing_is_rounded_on_the_way_out(self) -> None:
        # A sum of monotonic deltas serialises as 3042.086376051884, which
        # is noise in a byte-gated file. The accumulator keeps its
        # precision; only the published row is rounded.
        recorder = ApiRecorder()
        for elapsed in (0.123456, 0.654321, 1000.000049):
            recorder.record(
                host="x.org", path="/a", method="GET", status=200, elapsed_ms=elapsed
            )
        assert recorder.records()[0].total_ms == 1000.8
        # Rounding never leaks back into the accumulator: a further call
        # still sums the exact figure.
        recorder.record(
            host="x.org", path="/a", method="GET", status=200, elapsed_ms=0.04
        )
        assert recorder.records()[0].total_ms == 1000.8

    def test_method_case_is_normalised(self) -> None:
        recorder = ApiRecorder()
        recorder.record(host="x.org", path="/a", method="get", status=200)
        recorder.note_retry(host="x.org", path="/a", method="GET")
        rows = recorder.records()
        assert len(rows) == 1
        assert (rows[0].method, rows[0].retries) == ("GET", 1)


class TestRecordServiceCall:
    def test_an_sdk_call_names_its_own_service(self) -> None:
        record_service_call(
            "anthropic", endpoint="/v1/messages", method="POST", status=200
        )
        row = current_recorder().records()[0]
        assert row.label == "Anthropic"
        assert row.endpoint == "/v1/messages"

    def test_a_missing_status_counts_as_success(self) -> None:
        # An SDK that raises typed errors exposes no code on the happy path.
        record_service_call(
            "anthropic", endpoint="/v1/messages", method="POST", status=None
        )
        assert current_recorder().records()[0].ok == 1

    def test_an_unregistered_key_labels_itself(self) -> None:
        record_service_call("mystery", endpoint="/x", method="GET", status=200)
        assert current_recorder().records()[0].label == "mystery"

    def test_a_failure_with_no_status_is_a_call_and_an_error(self) -> None:
        # A connection that never opened has no code, and status=None
        # reads as success -- so the extraction client's connection
        # retries published four failed attempts as four clean calls.
        record_service_failure("anthropic", endpoint="/v1/messages", method="post")
        row = current_recorder().records()[0]
        assert (row.calls, row.ok, row.errors, row.method) == (1, 0, 1, "POST")
        assert row.had_trouble

    def test_a_transport_failure_names_its_service_from_the_url(self) -> None:
        # Only responses reach the hook, so a timeout or a refused
        # connection left no row at all: an NCBI outage that failed eight
        # papers published `calls: 40, ok: 40, errors: 0` for E-utilities.
        record_transport_failure(
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed"
        )
        row = current_recorder().records()[0]
        assert row.label == "E-utilities fetch"
        assert (row.calls, row.ok, row.errors, row.method) == (1, 0, 1, "GET")
        assert row.endpoint == "/entrez/eutils/efetch.fcgi"
        assert row.had_trouble

    def test_a_transport_failure_without_a_host_still_records(self) -> None:
        record_transport_failure("/entrez/eutils/efetch.fcgi", method="POST")
        row = current_recorder().records()[0]
        assert (row.calls, row.errors, row.method) == (1, 1, "POST")


class TestHooksOnTheSharedClient:
    """The whole point: no call site changes, yet every module records."""

    @pytest.mark.asyncio
    async def test_the_shared_manager_records_without_call_site_changes(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-length": "42"}, text="x" * 42)

        manager = AsyncHttpClientManager(transport=httpx.MockTransport(handler))
        client = await manager.get()
        await client.get("https://rest.uniprot.org/uniprotkb/P12345")
        await manager.close()

        row = current_recorder().records()[0]
        assert row.label == "UniProt"
        assert row.calls == 1
        assert row.bytes == 42
        # Measured from a request-extensions stamp: response.elapsed is
        # not yet set when the response hook runs.
        assert row.total_ms > 0.0

    @pytest.mark.asyncio
    async def test_a_failing_response_is_recorded_as_an_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(503)

        manager = AsyncHttpClientManager(transport=httpx.MockTransport(handler))
        client = await manager.get()
        await client.get("https://api.unpaywall.org/v2/10.1000/x")
        await manager.close()
        assert current_recorder().records()[0].errors == 1

    @pytest.mark.asyncio
    async def test_a_missing_content_length_leaves_bytes_at_zero(self) -> None:
        # The body is deliberately not read in the hook: doing so would
        # consume a streamed response out from under the caller.
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, stream=httpx.ByteStream(b"payload"))

        manager = AsyncHttpClientManager(transport=httpx.MockTransport(handler))
        client = await manager.get()
        response = await client.get("https://x.org/a")
        await response.aread()
        await manager.close()
        assert current_recorder().records()[0].bytes == 0

    @pytest.mark.asyncio
    async def test_a_malformed_content_length_is_survived(self) -> None:
        # A header is whatever the server sent. int() on it must not be
        # allowed to take down a run over a byte count nothing depends on.
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, headers={"content-length": "not-a-number"})

        manager = AsyncHttpClientManager(transport=httpx.MockTransport(handler))
        client = await manager.get()
        await client.get("https://x.org/a")
        await manager.close()
        row = current_recorder().records()[0]
        assert row.bytes == 0
        assert row.calls == 1

    @pytest.mark.asyncio
    async def test_a_followed_redirect_is_one_call_not_two(self) -> None:
        """httpx runs the response hook once per hop of a redirect chain.

        It runs it inside the redirect loop, before setting `history` or
        `next_request`, so a hop is only recognisable by its own redirect
        location. One Unpaywall PDF fetch that 302s to a CDN published two
        calls -- and the 3xx landed in the `ok` bucket, which is
        `200 <= status < 400`.
        """

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "link.springer.com":
                return httpx.Response(
                    302, headers={"location": "https://cdn.springer.com/paper.pdf"}
                )
            return httpx.Response(200)

        manager = AsyncHttpClientManager(
            transport=httpx.MockTransport(handler), follow_redirects=True
        )
        client = await manager.get()
        response = await client.get("https://link.springer.com/content/paper.pdf")
        await manager.close()

        assert response.status_code == 200
        assert current_recorder().total_calls() == 1
        row = current_recorder().records()[0]
        assert (row.label, row.calls, row.ok) == ("cdn.springer.com", 1, 1)

    @pytest.mark.asyncio
    async def test_a_redirect_a_client_will_not_follow_is_still_an_answer(
        self,
    ) -> None:
        """For a non-following client the 3xx is the response it got."""

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(301, headers={"location": "https://x.org/b"})

        manager = AsyncHttpClientManager(transport=httpx.MockTransport(handler))
        client = await manager.get()
        await client.get("https://x.org/a")
        await manager.close()

        assert current_recorder().total_calls() == 1

    @pytest.mark.asyncio
    async def test_instrumentation_can_be_switched_off(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200)

        manager = AsyncHttpClientManager(
            transport=httpx.MockTransport(handler), instrument=False
        )
        client = await manager.get()
        await client.get("https://rest.uniprot.org/uniprotkb/P12345")
        await manager.close()
        assert current_recorder().records() == []

    @pytest.mark.asyncio
    async def test_a_caller_hook_runs_and_telemetry_still_records(self) -> None:
        # Assigning rather than merging would drop that module out of the
        # inventory with nothing saying so, and the widget would silently
        # under-report the run.
        seen: list[str] = []

        async def spy(response: httpx.Response) -> None:
            seen.append(str(response.request.url))

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200)

        manager = AsyncHttpClientManager(
            transport=httpx.MockTransport(handler),
            event_hooks={"response": [spy]},
        )
        client = await manager.get()
        await client.get("https://x.org/a")
        await manager.close()
        assert seen == ["https://x.org/a"]
        assert current_recorder().total_calls() == 1

    @pytest.mark.asyncio
    async def test_a_caller_request_hook_survives_the_merge(self) -> None:
        seen: list[str] = []

        async def spy(request: httpx.Request) -> None:
            seen.append(request.method)

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200)

        manager = AsyncHttpClientManager(
            transport=httpx.MockTransport(handler),
            event_hooks={"request": [spy]},
        )
        client = await manager.get()
        await client.get("https://x.org/a")
        await manager.close()
        assert seen == ["GET"]
        assert current_recorder().total_calls() == 1


class TestResetRecorder:
    def test_reset_starts_a_fresh_inventory(self) -> None:
        record_service_call("anthropic", endpoint="/x", method="POST", status=200)
        assert current_recorder().total_calls() == 1
        reset_recorder()
        assert current_recorder().total_calls() == 0
