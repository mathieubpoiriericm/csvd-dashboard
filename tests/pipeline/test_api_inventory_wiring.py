"""The inventory is only true if every caller actually records.

`record_service_call` and `note_retry` existed with no production call
site at all: the module docstring promised the Anthropic SDK and PubMed's
search recorded explicitly, and `pipeline/CLAUDE.md` said retries were
noted, and neither was true. The External services panel silently omitted
the extraction calls -- the dominant cost of a run -- and `retries` was
structurally always zero.

These tests fail if any of those wires is cut again.

The last two classes guard the *static* half of the same claim. A provider
can drop out of the inventory two ways no runtime test sees: by arriving
at a host `SERVICES` does not name, so its rows read as a bare hostname;
or by getting a client of its own, so its rows never exist at all. Both
are read off the source with `ast` rather than restated in a list here --
a hand-written inventory only fails when someone remembers to update it,
and that is the same person who would have remembered `SERVICES`.
"""

import ast
from pathlib import Path
from unittest.mock import MagicMock
from urllib.parse import urlsplit

import httpx
import pytest

import pipeline
from pipeline.api_telemetry import (
    _BY_KEY,
    current_recorder,
    reset_recorder,
    resolve_service,
)


@pytest.fixture(autouse=True)
def _fresh_recorder() -> None:
    reset_recorder()


class TestAnthropicIsInTheInventory:
    async def test_an_extraction_call_is_recorded(
        self, mocker, mock_anthropic_response
    ) -> None:
        from tests.pipeline.test_anthropic_client import _make_mock_client

        from pipeline.anthropic_client import AnthropicClient
        from pipeline.config import PipelineConfig

        client = AnthropicClient()
        mocker.patch.object(
            client,
            "_get_client",
            return_value=_make_mock_client(mock_anthropic_response()),
        )

        await client.extract("text", "12345678", PipelineConfig(), None)

        rows = current_recorder().records()
        assert [row.label for row in rows] == ["Anthropic"]
        assert rows[0].method == "POST"
        assert rows[0].calls == 1
        # The SDK owns its transport, so no event hook fires for it; the
        # timing has to come from the caller.
        assert rows[0].total_ms >= 0.0


class TestPubMedSearchIsInTheInventory:
    async def test_the_search_is_recorded(self, mocker) -> None:
        from pipeline.pubmed_search import search_recent_papers

        mocker.patch(
            "pipeline.pubmed_search.Entrez.esearch", return_value=MagicMock()
        )
        mocker.patch(
            "pipeline.pubmed_search.Entrez.read",
            return_value={"IdList": ["12345678"], "Count": "1"},
        )

        assert await search_recent_papers(7) == ["12345678"]

        rows = current_recorder().records()
        assert [row.label for row in rows] == ["E-utilities search"]
        assert rows[0].endpoint == "/entrez/eutils/esearch.fcgi"
        assert rows[0].calls == 1


class TestRetriesAreNoted:
    async def test_an_ncbi_429_records_a_retry(self, mocker) -> None:
        import pipeline.validation as validation
        from pipeline.config import NCBI_ESEARCH_URL, PipelineConfig

        responses = [
            httpx.Response(
                429,
                headers={"retry-after": "0"},
                request=httpx.Request("GET", NCBI_ESEARCH_URL),
            ),
            httpx.Response(200, request=httpx.Request("GET", NCBI_ESEARCH_URL)),
        ]

        class _Client:
            async def get(self, url: str, params: dict[str, str]) -> httpx.Response:
                return responses.pop(0)

        mocker.patch.object(
            validation._client_manager, "get", return_value=_Client()
        )
        mocker.patch("pipeline.ncbi_http.throttle", return_value=None)
        mocker.patch("asyncio.sleep", return_value=None)

        resp = await validation._ncbi_get_with_retry(
            NCBI_ESEARCH_URL, {}, config=PipelineConfig(), context="test"
        )

        assert resp is not None and resp.status_code == 200
        # A retry is indistinguishable from another call at the transport,
        # so the response hook cannot see one; the helper notes it.
        rows = current_recorder().records()
        assert sum(row.retries for row in rows) == 1


class TestTransportFailuresAreCounted:
    """A call that never got a response is still a call, and an error.

    Only responses reach the httpx hook, so every module that swallows its
    own timeout left no row at all: an outage that failed papers published
    `errors: 0` for the service that caused it, and `trouble()` -- which
    only sees rows that errored or retried -- raised no step warning.
    """

    @staticmethod
    def _raising_client() -> MagicMock:
        client = MagicMock()

        async def boom(*args: object, **kwargs: object) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        client.get = boom
        return client

    async def _assert_one_error(self, expected_label: str) -> None:
        rows = current_recorder().records()
        assert [(row.label, row.calls, row.ok, row.errors) for row in rows] == [
            (expected_label, 1, 0, 1)
        ]
        assert current_recorder().trouble() == rows

    async def test_a_europepmc_outage_is_in_the_inventory(self, mocker) -> None:
        from pipeline import europepmc

        mocker.patch.object(
            europepmc._client_manager, "get", return_value=self._raising_client()
        )

        assert await europepmc.fetch_europepmc_fulltext("12345678") is None

        # The mocked client raises on every call, so the outage lands on
        # `_resolve_pmcid`'s search request -- `endpoint` is only
        # reassigned to the fullTextXML URL once that call has already
        # succeeded (see the comment in `fetch_europepmc_fulltext`).
        await self._assert_one_error("Europe PMC search")

    async def test_a_uniprot_search_outage_is_in_the_inventory(self, mocker) -> None:
        from pipeline import uniprot_fetch

        mocker.patch.object(
            uniprot_fetch._client_manager, "get", return_value=self._raising_client()
        )

        info = await uniprot_fetch.fetch_uniprot_info("NOTCH3")
        assert info is not None
        assert info.accession is None and info.cacheable_miss is False

        await self._assert_one_error("UniProt")

    async def test_a_uniprot_go_outage_is_in_the_inventory(self, mocker) -> None:
        from pipeline import uniprot_fetch

        mocker.patch.object(
            uniprot_fetch._client_manager, "get", return_value=self._raising_client()
        )

        assert await uniprot_fetch.fetch_uniprot_go_info("P46531") is None

        await self._assert_one_error("UniProt")

    async def test_an_unpaywall_outage_is_in_the_inventory(self, mocker) -> None:
        from pipeline import pdf_retrieval

        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        mocker.patch.object(
            pdf_retrieval._client_manager, "get", return_value=self._raising_client()
        )

        assert await pdf_retrieval.check_unpaywall("10.1234/test") is None

        await self._assert_one_error("Unpaywall")

    async def test_a_pmc_id_converter_outage_is_in_the_inventory(
        self, mocker
    ) -> None:
        from pipeline import pdf_retrieval

        mocker.patch.object(
            pdf_retrieval._client_manager, "get", return_value=self._raising_client()
        )

        assert await pdf_retrieval.fetch_pmc_fulltext("12345678") is None

        await self._assert_one_error("NCBI PMC ID Converter")

    async def test_a_publisher_pdf_outage_is_in_the_inventory(self, mocker) -> None:
        from pipeline import pdf_retrieval

        client = MagicMock()
        client.stream = MagicMock(side_effect=httpx.ReadTimeout("slow"))
        mocker.patch.object(
            pdf_retrieval._client_manager, "get", return_value=client
        )

        url = "https://link.springer.com/content/pdf/paper.pdf"
        assert await pdf_retrieval.download_and_parse_pdf(url) is None

        await self._assert_one_error("link.springer.com")


_PIPELINE_ROOT = Path(pipeline.__file__).parent

# Hosts reached from `pipeline/` that are deliberately not in `SERVICES`.
# Declared and empty on purpose: an established place to hold something out,
# so that doing so is a visible edit carrying a reason rather than a silent
# omission. (The export used to carry the same pattern in
# `_UNPUBLISHED_COLUMNS`; that one was removed, and a `genes` column is now
# held out by leaving it out of `_GENE_COLUMNS`.)
_UNREGISTERED_BY_DESIGN: frozenset[str] = frozenset()

# The one module allowed to construct a client, because it is the manager
# that installs the telemetry hooks on every other module's behalf.
_MAY_BUILD_A_CLIENT: frozenset[str] = frozenset({"http_client.py"})


def _docstring_ids(tree: ast.Module) -> set[int]:
    """Node ids of every docstring, so prose is not mistaken for a URL."""
    ids: set[int] = set()
    for node in ast.walk(tree):
        if not isinstance(
            node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef
        ):
            continue
        body = node.body
        if (
            body
            and isinstance(body[0], ast.Expr)
            and isinstance(body[0].value, ast.Constant)
            and isinstance(body[0].value.value, str)
        ):
            ids.add(id(body[0].value))
    return ids


def _pipeline_modules() -> list[tuple[Path, ast.Module]]:
    """Every module under `pipeline/`, parsed.

    `scripts/` is deliberately outside this walk: `SERVICES` describes what
    a pipeline *run* talked to, and `scripts/fetch_cytobands.py` is its own
    process, building no run report for a service row to reach.
    """
    return [
        (path, ast.parse(path.read_text(encoding="utf-8")))
        for path in sorted(_PIPELINE_ROOT.rglob("*.py"))
    ]


def _literal_urls() -> list[tuple[Path, int, str]]:
    """Every URL literal in `pipeline/`, outside docstrings.

    An f-string needs no special case: `ast.JoinedStr` holds its literal
    parts as `Constant` children, so `f"https://host/{id}"` is found by
    this walk with the interpolation simply absent from the path.
    """
    found: list[tuple[Path, int, str]] = []
    for path, tree in _pipeline_modules():
        skip = _docstring_ids(tree)
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and id(node) not in skip
                and node.value.startswith(("http://", "https://"))
            ):
                found.append((path, node.lineno, node.value))
    return found


class TestEveryReachableProviderIsRegistered:
    """A new base URL must not reach the panel as a bare hostname.

    Two limits, so a pass is not over-read. This proves a host is *known*,
    not that it is called -- `uniprot_fetch`'s stored display link passes
    on that basis. And it sees only literal URLs, so a base URL arriving in
    a payload is invisible to it: the open-access PDF URL comes from
    Unpaywall's response, and the hostname fallback in `resolve_service` is
    what covers that case rather than this test.
    """

    def test_no_module_reaches_an_unnamed_service(self) -> None:
        unknown = []
        for path, lineno, url in _literal_urls():
            parts = urlsplit(url)
            key, _ = resolve_service(parts.netloc, parts.path)
            if key in _BY_KEY or parts.netloc in _UNREGISTERED_BY_DESIGN:
                continue
            unknown.append(
                f"{path.relative_to(_PIPELINE_ROOT.parent)}:{lineno} {parts.netloc}"
            )
        assert not unknown, (
            "These hosts would appear in the External services panel under "
            "their own hostname rather than a display name:\n  "
            + "\n  ".join(unknown)
            + "\nAdd an ApiService to pipeline.api_telemetry.SERVICES, or add "
            "the host to _UNREGISTERED_BY_DESIGN with the reason."
        )

    def test_the_scan_finds_the_urls_it_is_supposed_to(self) -> None:
        # A walk that quietly matched nothing would pass the test above for
        # the wrong reason -- which is the failure this whole file exists to
        # prevent, one layer down.
        hosts = {urlsplit(url).netloc for _, _, url in _literal_urls()}
        assert "eutils.ncbi.nlm.nih.gov" in hosts
        assert "api.platform.opentargets.org" in hosts

    def test_prose_and_regexes_are_not_read_as_urls(self) -> None:
        # `export/writer.py` documents slash escaping with `http://a/b` in a
        # docstring, and `export/text.py` holds `https?://` as a scrubbing
        # pattern. Neither is a call, and both are excluded structurally --
        # by the docstring rule and by the prefix test -- rather than by an
        # allow-list, which would hide a real hit just as readily.
        urls = {url for _, _, url in _literal_urls()}
        assert "http://a/b" not in urls
        assert not any(url.startswith("https?") for url in urls)


class TestNoModuleBuildsItsOwnClient:
    """Telemetry rides `AsyncHttpClientManager`, so a client built anywhere
    else is traffic the inventory cannot see.

    This is the half the URL scan cannot do. `pipeline/export/geocode.py`
    called a *registered* host, ClinicalTrials.gov, on its own
    `httpx.AsyncClient`: every host it touched was named, and not one of
    its calls was recorded.
    """

    def test_only_the_manager_constructs_a_client(self) -> None:
        offenders = []
        for path, tree in _pipeline_modules():
            if path.name in _MAY_BUILD_A_CLIENT:
                continue
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                func = node.func
                if isinstance(func, ast.Attribute):
                    name = func.attr
                elif isinstance(func, ast.Name):
                    name = func.id
                else:
                    continue
                if name in {"AsyncClient", "Client"}:
                    offenders.append(
                        f"{path.relative_to(_PIPELINE_ROOT.parent)}:{node.lineno}"
                    )
        assert not offenders, (
            "These build their own HTTP client, so their calls never reach "
            "the telemetry hooks:\n  "
            + "\n  ".join(offenders)
            + "\nBuild it through AsyncHttpClientManager, or pass "
            "instrument=False and say why."
        )
