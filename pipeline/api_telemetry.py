"""Which external services a run talked to, and how it went.

Nothing recorded API traffic before this module: the run report knew how
many genes came back but not that UniProt was asked, retried once and
answered. The dashboard publishes that inventory, so it has to be
collected.

**One instrumentation point.** ``AsyncHttpClientManager`` is the lazy
client every API module already shares -- europepmc, ncbi_gene_fetch,
uniprot_fetch, pubmed_citations, validation, pdf_retrieval,
clinical_trials_fetch -- and it forwards ``**client_kwargs`` to
``httpx.AsyncClient``. Installing ``event_hooks`` there instruments all of
them without touching a single call site. Two callers bypass httpx and
record explicitly: PubMed's search (Biopython/urllib) and the Anthropic
SDK.

**Aggregated, never per call.** A 500-paper run makes thousands of
requests; the widget wants one row per service and endpoint.
"""

import re
import time
from dataclasses import dataclass, field
from typing import Any, Final
from urllib.parse import urlsplit

from pipeline.wire_model import WireModel

# Segments that are identifiers rather than route names. Collapsing them
# is what keeps the aggregate one row per endpoint instead of one row per
# PMID: /uniprotkb/P12345 and /uniprotkb/Q67890 are the same endpoint.
_VERSION_SEGMENT: Final[re.Pattern[str]] = re.compile(r"^v\d+(?:\.\d+)*$")
_HAS_DIGIT: Final[re.Pattern[str]] = re.compile(r"\d")

_START_EXTENSION: Final[str] = "_svd_started_monotonic"


@dataclass(frozen=True, slots=True)
class ApiService:
    """An external service, as the dashboard names it.

    ``endpoint_labels`` qualifies the label for named endpoints, keyed by
    the *normalised* path (``normalize_path``) so a stored row can be
    re-labelled on the way out of the database as well as on the way in.
    The service key never changes with it: the recorder aggregates by
    (service, endpoint, method) already, so one key still yields one row
    per endpoint -- the label is the only thing that differs.
    """

    key: str
    label: str
    host_suffix: str
    path_prefix: str = ""
    endpoint_labels: tuple[tuple[str, str], ...] = ()


# The first match wins, so an entry that shares a host suffix with a later,
# broader one has to be listed before it. None does today: the PMC ID
# converter moved to its own pmc.ncbi.nlm.nih.gov host (the retired
# www.ncbi.nlm.nih.gov/pmc/utils/idconv URL 301s there, which is how the
# real call ended up under an unregistered host), and it keeps a path
# prefix because that host also serves article pages.
SERVICES: Final[tuple[ApiService, ...]] = (
    ApiService(
        "ncbi_idconv",
        "NCBI PMC ID Converter",
        "pmc.ncbi.nlm.nih.gov",
        "/tools/idconv",
    ),
    ApiService(
        "ncbi_eutils",
        "NCBI E-utilities",
        "eutils.ncbi.nlm.nih.gov",
        endpoint_labels=(
            ("/entrez/eutils/esearch.fcgi", "E-utilities search"),
            ("/entrez/eutils/esummary.fcgi", "E-utilities summary"),
            ("/entrez/eutils/efetch.fcgi", "E-utilities fetch"),
        ),
    ),
    ApiService(
        "europepmc",
        "Europe PMC",
        "ebi.ac.uk",
        "/europepmc",
        endpoint_labels=(
            ("/europepmc/webservices/rest/search", "Europe PMC search"),
            ("/europepmc/webservices/rest/:id/fullTextXML", "Europe PMC full text"),
        ),
    ),
    ApiService("unpaywall", "Unpaywall", "api.unpaywall.org"),
    ApiService("uniprot", "UniProt", "uniprot.org"),
    ApiService("clinicaltrials", "ClinicalTrials.gov", "clinicaltrials.gov"),
    ApiService("opentargets", "Open Targets", "platform.opentargets.org"),
    ApiService("orphadata", "Orphadata", "api.orphadata.com"),
    ApiService("anthropic", "Anthropic", "api.anthropic.com"),
    # Publisher hosts Unpaywall hands `download_and_parse_pdf`. The set is
    # open-ended (see `resolve_service`), so only the hosts that have
    # actually appeared in a run are named; a new one labels itself.
    ApiService("elsevier", "Elsevier ScienceDirect", "linkinghub.elsevier.com"),
    ApiService("sage", "SAGE Journals", "journals.sagepub.com"),
    ApiService("jstage", "J-STAGE", "www.jstage.jst.go.jp"),
)

_BY_KEY: Final[dict[str, ApiService]] = {service.key: service for service in SERVICES}


def display_label(service_key: str, endpoint: str) -> str:
    """The label a row shows for this service at this (normalised) endpoint.

    A key the registry does not know is either a genuinely unregistered
    host -- which labels itself, as ``resolve_service`` records it -- or a
    host that was unregistered when the row was stored and has been
    registered since. The second case is tried through ``resolve_service``
    so the export can name it without a new run.
    """
    service = _BY_KEY.get(service_key)
    if service is None:
        service = _BY_KEY.get(resolve_service(service_key, endpoint)[0])
    if service is None:
        return service_key
    for path, label in service.endpoint_labels:
        if endpoint == path:
            return label
    return service.label


def relabel_api_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Re-derive ``label`` on wire-form api rows from the registry.

    The stored run and sync reports carry the label a service had when the
    run happened. This is what lets a rename in ``SERVICES`` reach
    ``data/pipeline_run.json`` and ``data/pipeline_syncs.json`` on the next
    export rather than on the next run.
    """
    return [
        {**row, "label": display_label(str(row["service"]), str(row["endpoint"]))}
        for row in rows
    ]


class ApiServiceRecord(WireModel):
    """One service+endpoint+method, aggregated over the run."""

    service: str
    label: str
    endpoint: str
    method: str
    calls: int = 0
    ok: int = 0
    not_found: int = 0
    errors: int = 0
    retries: int = 0
    total_ms: float = 0.0
    bytes: int = 0

    @property
    def had_trouble(self) -> bool:
        """Whether this row should raise a warning on its step.

        A 404 is not trouble. Both lookups that can return one --
        `europepmc.get_fulltext` and `pdf_retrieval.check_unpaywall` --
        treat it as the normal "no open-access copy" answer and fall back
        to the abstract, so counting it as an error made the green badge
        unreachable: a run with any abstract-only paper would publish
        `completed_with_warnings` over a row reading "8 failed".
        """
        return self.errors > 0 or self.retries > 0


def normalize_path(path: str) -> str:
    """Collapse identifier segments so an endpoint aggregates.

    A segment is an identifier when it contains a digit and is not a
    version marker: ``/uniprotkb/P12345`` becomes ``/uniprotkb/:id`` while
    ``/api/v2/studies`` and ``/tools/idconv/api/v1/articles`` keep their
    shape. Without this the API panel would grow a row per PMID.
    """
    segments = []
    for segment in path.split("/"):
        if not segment:
            continue
        if _HAS_DIGIT.search(segment) and not _VERSION_SEGMENT.match(segment):
            segments.append(":id")
        else:
            segments.append(segment)
    return "/" + "/".join(segments) if segments else "/"


def resolve_service(host: str, path: str) -> tuple[str, str]:
    """Map a host and path to a service key and display label.

    An unrecognised host is recorded under its own hostname rather than
    dropped, and the case that needs it is concrete rather than a
    placeholder for services not yet written: ``download_and_parse_pdf``
    is handed whatever open-access URL Unpaywall reported, so the host set
    is the publishing world and no allow-list could be written for it. A
    row reading ``link.springer.com`` is the intended answer there, not a
    missing entry.

    **ClinVar is deliberately not its own key.** ``clinvar_fetch`` calls
    the same ``esearch.fcgi`` and ``esummary.fcgi`` on the same
    ``eutils.ncbi.nlm.nih.gov`` that gene validation, gene info and
    citations call; only the query parameters differ, and the recorder
    never sees those -- ``normalize_path`` drops them anyway. An entry for
    it would have to precede ``ncbi_eutils``, and would then swallow every
    other E-utilities call rather than distinguishing its own. It is one
    service at the URL, so it is one key; ``display_label`` names the
    endpoint.
    """
    host = host.lower()
    for service in SERVICES:
        if host.endswith(service.host_suffix) and path.startswith(service.path_prefix):
            return service.key, service.label
    return host, host


@dataclass(slots=True)
class ApiRecorder:
    """Accumulates API traffic for one run.

    Not locked: the pipeline is one process on one event loop, and the
    hooks run inside it, so the increments below are never interleaved.
    """

    _rows: dict[tuple[str, str, str], ApiServiceRecord] = field(default_factory=dict)

    def _row(self, service: str, endpoint: str, method: str) -> ApiServiceRecord:
        method = method.upper()
        key = (service, endpoint, method)
        row = self._rows.get(key)
        if row is None:
            row = ApiServiceRecord(
                service=service,
                label=display_label(service, endpoint),
                endpoint=endpoint,
                method=method,
            )
            self._rows[key] = row
        return row

    def record_endpoint(
        self,
        *,
        service: str,
        endpoint: str,
        method: str,
        status: int | None,
        elapsed_ms: float = 0.0,
        payload_bytes: int = 0,
    ) -> None:
        """Record one completed call against an already-named endpoint.

        A ``status`` of ``None`` means the caller had no HTTP status to
        report -- an SDK that raises typed errors rather than exposing a
        code -- and counts as success; a failure there arrives as an
        explicit non-2xx or through the step's own error.
        """
        row = self._row(service, endpoint, method)
        row.calls += 1
        if status is None or 200 <= status < 400:
            row.ok += 1
        elif status == 404:
            # An answer, not a failure -- see `had_trouble`. Counted so the
            # panel can still say how many lookups came back empty.
            row.not_found += 1
        else:
            row.errors += 1
        row.total_ms += elapsed_ms
        row.bytes += payload_bytes

    def record(
        self,
        *,
        host: str,
        path: str,
        method: str,
        status: int | None,
        elapsed_ms: float = 0.0,
        payload_bytes: int = 0,
    ) -> None:
        """Record one completed call, naming its service from the URL."""
        service, _ = resolve_service(host, path)
        self.record_endpoint(
            service=service,
            endpoint=normalize_path(path),
            method=method,
            status=status,
            elapsed_ms=elapsed_ms,
            payload_bytes=payload_bytes,
        )

    def note_retry(self, *, host: str, path: str, method: str) -> None:
        """Record that a call to this endpoint had to be retried.

        Retries are noted by the two retry helpers rather than inferred
        from the hook: a retry looks exactly like another call from the
        transport's point of view, so counting it there would either
        double-count every request or miss every retry.
        """
        service, _ = resolve_service(host, path)
        self._row(service, normalize_path(path), method).retries += 1

    def records(self) -> list[ApiServiceRecord]:
        """Every row, busiest service first, then endpoint, for stable output.

        ``total_ms`` is rounded on the way out, for the reason the run
        report rounds its durations: a sum of monotonic deltas serialises
        as ``3042.086376051884``, which is noise in a byte-gated file a
        human reviews in ``git diff``, and nothing renders below a tenth
        of a millisecond. Copies are returned so the accumulator keeps
        its full precision for the next call.
        """
        return sorted(
            (
                row.model_copy(update={"total_ms": round(row.total_ms, 1)})
                for row in self._rows.values()
            ),
            key=lambda row: (-row.calls, row.label, row.endpoint, row.method),
        )

    def total_calls(self) -> int:
        """Every call the run made, across all services."""
        return sum(row.calls for row in self._rows.values())

    def trouble(self) -> list[ApiServiceRecord]:
        """Rows that errored or retried, for the step warning."""
        return [row for row in self.records() if row.had_trouble]


_recorder = ApiRecorder()


def current_recorder() -> ApiRecorder:
    """The recorder this run is filling."""
    return _recorder


def reset_recorder() -> ApiRecorder:
    """Start a fresh recorder. Returns it, for tests and for a new run."""
    global _recorder
    _recorder = ApiRecorder()
    return _recorder


async def _on_request(request: Any) -> None:
    """Stamp the request so the response hook can measure it.

    ``response.elapsed`` is unavailable here -- httpx sets it when the
    body is read, which happens after these hooks run, and reading it
    early raises. Stamping the request's own extensions dict is the
    supported way to carry state between the two hooks.
    """
    request.extensions[_START_EXTENSION] = time.monotonic()


async def _on_response(response: Any) -> None:
    """Record a completed call.

    Only responses reach this hook -- a connection error or DNS failure
    raises before it, so the module that met it calls
    ``record_transport_failure``. The body is not read here: for a
    streamed response that would consume it out from under the caller, so
    the size comes from Content-Length when the server sent one and is
    otherwise left at zero.
    """
    request = response.request
    started = request.extensions.get(_START_EXTENSION)
    elapsed_ms = (time.monotonic() - started) * 1000.0 if started else 0.0
    try:
        payload_bytes = int(response.headers.get("content-length", 0))
    except (TypeError, ValueError):
        payload_bytes = 0
    _recorder.record(
        host=request.url.host,
        path=request.url.path,
        method=request.method,
        status=response.status_code,
        elapsed_ms=elapsed_ms,
        payload_bytes=payload_bytes,
    )


async def _on_final_response(response: Any) -> None:
    """Record a completed call, ignoring the hops of a redirect chain.

    httpx runs the response hook once per hop, inside its redirect loop and
    before it sets either ``response.history`` or ``response.next_request``
    -- so neither is visible from in here, and the hop has to be recognised
    by its own redirect location. A followed redirect is not a call the run
    chose to make: one Unpaywall PDF fetch that 302s to a CDN published
    ``calls: 2, ok: 2`` (two rows of one when the hop crosses hosts), with
    the 3xx itself counted in the ``ok`` bucket because that bucket is
    ``200 <= status < 400``, overstating both the endpoint's call count and
    its ``totalMs``. Only a client built with ``follow_redirects=True`` gets
    this hook; for one that does not follow, the 3xx is the answer it got
    and is recorded as such.
    """
    if response.has_redirect_location:
        return
    await _on_response(response)


def event_hooks(*, follow_redirects: bool = False) -> dict[str, list[Any]]:
    """The httpx ``event_hooks`` mapping that instruments a client."""
    return {
        "request": [_on_request],
        "response": [_on_final_response if follow_redirects else _on_response],
    }


def record_transport_failure(url: str, *, method: str = "GET") -> None:
    """Record a call that never produced a response.

    A timeout, a refused connection or a DNS failure raises before the
    response hook, so it left no row at all: an NCBI outage that failed
    eight papers mid-run published ``calls: 40, ok: 40, errors: 0`` for
    E-utilities and raised no ``api_errored`` warning, because
    ``trouble()`` only sees rows that errored or retried. The retry
    helpers were documented as counting these and only ever counted
    retries. Status 0 is the same "the transport carried no status"
    marker ``pubmed_search`` already records for a failed esearch, and
    counts as an error.
    """
    parsed = urlsplit(url)
    _recorder.record(
        host=parsed.hostname or "", path=parsed.path, method=method, status=0
    )


def record_service_call(
    service_key: str,
    *,
    endpoint: str,
    method: str,
    status: int | None,
    elapsed_ms: float = 0.0,
    payload_bytes: int = 0,
) -> None:
    """Record a call that did not go through an instrumented httpx client.

    PubMed's search runs through Biopython's urllib and the extraction
    calls through the Anthropic SDK, so neither passes the hooks. They
    name their service directly instead.
    """
    _recorder.record_endpoint(
        service=service_key,
        endpoint=endpoint,
        method=method,
        status=status,
        elapsed_ms=elapsed_ms,
        payload_bytes=payload_bytes,
    )


def record_service_failure(service_key: str, *, endpoint: str, method: str) -> None:
    """Record a call that failed with no HTTP status to show for it.

    A connection that never opened, or a stream that broke off, is a call
    the run made and an error it met. `record_service_call(status=None)`
    is the wrong tool for it: None means "the SDK exposed no code on the
    happy path" and counts as success, so the extraction client's
    connection retries published every failed attempt as a clean call.
    """
    row = _recorder._row(service_key, endpoint, method)
    row.calls += 1
    row.errors += 1


def note_service_retry(service_key: str, *, endpoint: str, method: str) -> None:
    """Note a retry against a service that names itself, as above.

    The SDK's own retries are invisible to the hooks for the same reason
    its calls are, so the extraction client reports them here; without
    this the Anthropic row could never show trouble, and the step warning
    for "services that errored or were retried" was unreachable for the
    one service every run depends on.
    """
    _recorder._row(service_key, endpoint, method).retries += 1
