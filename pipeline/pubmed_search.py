"""PubMed search module for the disease's genetic research papers.

Uses NCBI Entrez API to search PubMed for recent publications.
Requires ENTREZ_EMAIL environment variable (NCBI policy).
"""

import asyncio
import functools
import logging
import os
import time
import urllib.parse
import urllib.request
import warnings
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from http.client import HTTPException
from typing import Any, Final, Protocol, TypedDict, cast

from Bio import Entrez

from pipeline.api_telemetry import record_service_call
from pipeline.disease import load_disease

logger = logging.getLogger(__name__)

# --- Configuration ---
_entrez_configured: bool = False

# Biopython's `_open` calls its module global `urlopen(request)` with no
# timeout, so a connection NCBI accepted and then stopped answering blocked
# the worker thread in `recv` for good: the run sat at step 1 with no
# failure row and no exit. Rebinding that global is the one seam `_open`
# offers; the timeout stays on the socket for the body `Entrez.read` reads.
# Not `socket.setdefaulttimeout`, which is process-wide. Expiry is an
# `OSError` (`URLError` on connect, `TimeoutError` on read), so it is
# already one of `_ENTREZ_FAILURES`.
_ENTREZ_TIMEOUT_S: Final[float] = 60.0
setattr(  # noqa: B010 -- the stub types the global as the bare function
    Entrez,
    "urlopen",
    functools.partial(urllib.request.urlopen, timeout=_ENTREZ_TIMEOUT_S),
)
# The backstop for a body that trickles, each read inside the socket
# timeout: every try Biopython makes, its sleeps between them, and the read.
_ENTREZ_DEADLINE_S: float = (
    _ENTREZ_TIMEOUT_S * (Entrez.max_tries + 1)
    + Entrez.sleep_between_tries * Entrez.max_tries
)


class _EntrezConfiguration(Protocol):
    """Writable Entrez globals whose upstream stubs are typed as ``None``."""

    email: str
    api_key: str | None


def _configure_entrez() -> None:
    """Configure Entrez API credentials (lazy initialization)."""
    global _entrez_configured
    if _entrez_configured:
        return

    email = os.getenv("ENTREZ_EMAIL", "")
    api_key = os.getenv("ENTREZ_KEY") or os.getenv("NCBI_API_KEY")

    if not email:
        warnings.warn(
            "ENTREZ_EMAIL not set. NCBI requires valid email for Entrez API. "
            "Set ENTREZ_EMAIL environment variable.",
            UserWarning,
            stacklevel=3,
        )

    entrez_config = cast(_EntrezConfiguration, Entrez)
    entrez_config.email = email
    entrez_config.api_key = api_key
    _entrez_configured = True


# --- Constants ---
MIN_DAYS_BACK: Final[int] = 1
MAX_DAYS_BACK: Final[int] = 365 * 10  # 10 years
DEFAULT_RETMAX: Final[int] = 500

_DISEASE = load_disease()

# The disease's anchor phrases, markers and MeSH headings come from
# disease/pipeline.json; the genetics vocabulary below is the method's and
# stays in code. Which MeSH headings were tried and dropped, and what that
# measured, is a `$comment` on `search.pubmed` in that file -- beside the
# terms it is about rather than a file away from them.
DISEASE_TERMS: Final[tuple[str, ...]] = _DISEASE.pubmed_disease_terms
MARKER_TERMS: Final[tuple[str, ...]] = _DISEASE.pubmed_marker_terms
MESH_TERMS: Final[tuple[str, ...]] = _DISEASE.pubmed_mesh_terms

# Terms to capture genetic/omics research methodologies
GENETIC_TERMS: Final[tuple[str, ...]] = (
    "gene",
    "genetic",
    "GWAS",
    "EWAS",
    "TWAS",
    "PWAS",
    "genome-wide",
    "variant",
    "mutation",
    "polymorphism",
)


class PubMedSearchError(Exception):
    """Raised when PubMed search fails."""


# What an Entrez call can raise. ValueError is Biopython's: an NCBI
# maintenance page arrives as a 200 whose body is HTML, and Entrez.read
# reports it as NotXMLError or CorruptedXMLError, both ValueError
# subclasses. Without it such a page escaped bare while the docstring
# below promised PubMedSearchError.
_ENTREZ_FAILURES: Final[tuple[type[Exception], ...]] = (
    HTTPException,
    OSError,
    RuntimeError,
    ValueError,
)


class _EntrezSearchResult(TypedDict, total=False):
    """Subset of Entrez ``esearch`` fields consumed by this module."""

    IdList: list[str]
    Count: str | int
    WebEnv: str
    QueryKey: str
    ErrorList: dict[str, list[str]]
    WarningList: dict[str, list[str]]


# Called with (retrieved, total) when pagination fails part-way. The search
# returns what it has rather than raising -- the papers retrieved are real
# and processing them is the right thing -- but a log line was the only
# record, and the run ended `completed` over a window it had only partly
# retrieved. The caller raises it where the run report will show it.
OnTruncated = Callable[[int, int], None]


def _build_query() -> str:
    """Build the PubMed query for the disease's genetic research."""
    disease_clause = " OR ".join(f'"{t}"[Title/Abstract]' for t in DISEASE_TERMS)
    research_clause = " OR ".join(f'"{t}"[Title/Abstract]' for t in GENETIC_TERMS)
    main_query = f"(({disease_clause}) AND ({research_clause}))"

    marker_clause = " OR ".join(f'"{t}"[Title/Abstract]' for t in MARKER_TERMS)
    marker_query = f"(({marker_clause}) AND ({disease_clause}))"

    # The genetics gate on this branch is load-bearing, not decoration.
    # "White Matter"[MeSH] is an anatomical heading: left as a bare OR it
    # pulls in the multiple-sclerosis and neuroimaging literature wholesale,
    # measured at 615 -> 2,354 papers a year against 615 -> 878 gated. That
    # buys exactly one more gold paper (23649698, a CADASIL paper carrying no
    # genetic term) for roughly 1,476 extra extraction calls a year.
    # Do not "simplify" this to `OR ({mesh_clause})`.
    mesh_clause = " OR ".join(f'"{t}"[MeSH Terms]' for t in MESH_TERMS)
    mesh_query = f"(({mesh_clause}) AND ({research_clause}))"

    return f"{main_query} OR {marker_query} OR {mesh_query}"


SVD_QUERY: Final[str] = _build_query()


MAX_TOTAL_RESULTS: Final[int] = 5000


async def _run_entrez_search(**params: Any) -> _EntrezSearchResult:
    """Run blocking Entrez search/read calls off the event loop.

    Recorded explicitly: Biopython owns the transport here, so none of the
    httpx event hooks that instrument every other API module fires for it.
    Without this the run's own search was missing from the External
    services panel it heads.

    ``_check_error_list`` runs here, so every caller -- each page of the
    walk and ``query_eval``'s recall harness included -- refuses a query
    NCBI rejected inside a 200 rather than reading its empty ``IdList`` as
    "matches nothing".
    """
    started = time.monotonic()
    # 0 until NCBI answers: a cancellation (SIGTERM, SIGHUP and Ctrl-C all
    # become one) or an exception outside `_ENTREZ_FAILURES` leaves the
    # call through the `finally` alone, and was recorded as a clean 200 on
    # the report of a run that failed in step 1.
    status = 0

    async def search() -> _EntrezSearchResult:
        handle = await asyncio.to_thread(Entrez.esearch, **params)
        return cast(
            _EntrezSearchResult,
            await asyncio.to_thread(Entrez.read, handle),
        )

    try:
        # TimeoutError is an OSError, so the clause below records it.
        results = await asyncio.wait_for(search(), timeout=_ENTREZ_DEADLINE_S)
        status = 200
    except _ENTREZ_FAILURES as e:
        # A failed call is a call. urllib's HTTPError carries the status;
        # a transport failure carries none, and is recorded as 0 so the
        # panel counts it as an error rather than -- as None would -- a
        # success.
        code = getattr(e, "code", None)
        status = code if isinstance(code, int) and 100 <= code <= 599 else 0
        raise
    finally:
        record_service_call(
            "ncbi_eutils",
            endpoint="/entrez/eutils/esearch.fcgi",
            method=_entrez_method(params),
            status=status,
            elapsed_ms=(time.monotonic() - started) * 1000.0,
        )
    # Outside the try: a rejected query is an answered call, recorded 200.
    _check_error_list(results)
    return results


# Biopython's own rule (`Entrez._build_request`): parameters that encode
# past this many characters go as a POST. The search query alone is past
# it, so every esearch here is a POST, and recording it as a GET filed its
# calls, errors and timings under gene validation's GET row.
_ENTREZ_POST_THRESHOLD: Final[int] = 1000


def _entrez_method(params: dict[str, Any]) -> str:
    """The HTTP method Biopython sends ``params`` with."""
    entrez_config = cast(_EntrezConfiguration, Entrez)
    sent = {**params, "tool": Entrez.tool, "email": entrez_config.email}
    if entrez_config.api_key:
        sent["api_key"] = entrez_config.api_key
    encoded = urllib.parse.urlencode(
        {k: v for k, v in sent.items() if v is not None}, doseq=True
    )
    return "POST" if len(encoded) > _ENTREZ_POST_THRESHOLD else "GET"


def _check_error_list(results: _EntrezSearchResult) -> None:
    """Refuse a search NCBI rejected inside a 200, and name the dead branches.

    ``ErrorList`` holds ``FieldNotFound`` -- a field tag the index does not
    know, which is the query itself being wrong -- and ``PhraseNotFound``,
    one unquoted OR-branch matching nothing while the rest of the query
    answers. The first arrived with ``Count`` 0, which read as "no new
    papers" and a green run for as long as the tag stayed wrong; it raises.

    Every term ``_build_query`` writes is quoted, and NCBI files a quoted
    phrase that matches nothing under ``WarningList`` as
    ``QuotedPhraseNotFound``, not under ``ErrorList``: read only there, a
    typo or a retired heading retrieved nothing on a green run with no log
    line. Those, ``PhraseNotFound`` and ``PhraseIgnored`` (a term the index
    dropped) are logged; ``OutputMessage`` is NCBI's commentary and is not.
    """
    errors = results.get("ErrorList") or {}
    if fields := errors.get("FieldNotFound"):
        raise PubMedSearchError(
            f"PubMed rejected the query (FieldNotFound: {', '.join(fields)})"
        )
    if phrases := errors.get("PhraseNotFound"):
        logger.warning(f"PubMed found no records for: {', '.join(phrases)}")
    warnings = results.get("WarningList") or {}
    if phrases := warnings.get("QuotedPhraseNotFound"):
        logger.warning(f"PubMed found no records for: {', '.join(phrases)}")
    if ignored := warnings.get("PhraseIgnored"):
        logger.warning(f"PubMed ignored part of the query: {', '.join(ignored)}")


async def search_recent_papers(
    days_back: int = 7, *, on_truncated: OnTruncated | None = None
) -> list[str]:
    """Return PMIDs of papers added to PubMed in the last N days.

    The window is over the Entrez date (``edat``, when the record entered
    PubMed), not the publication date. A record enters PubMed days to
    weeks after its publication date, so a weekly ``pdat`` window missed
    every paper indexed after the run whose pdat fell inside it --
    permanently, because the next window had moved on. ``edat`` is NCBI's
    own "what is new since" idiom; the overlap it produces costs nothing,
    since ``_discover_new_pmids`` dedupes through ``pubmed_refs``.

    Uses asyncio.to_thread to avoid blocking the event loop with
    synchronous BioPython Entrez calls. Paginates through results
    using WebEnv/QueryKey when more than DEFAULT_RETMAX are available.

    Args:
        days_back: Number of days to look back (1 to 3650).
        on_truncated: Called once with ``(retrieved, total)`` whenever the
            list returned is short of ``Count`` -- a pagination failure, an
            empty batch mid-walk, a window with no ``WebEnv``/``QueryKey``
            to page through, the ``MAX_TOTAL_RESULTS`` cap, or a window
            that changed while it was paged. ``Count`` is the largest any
            page reported, and the list holds each PMID once.

    Returns:
        List of PMID strings.

    Raises:
        ValueError: If days_back is not in valid range.
        PubMedSearchError: If the Entrez API call fails, or if NCBI
            rejected the query inside a 200 (``FieldNotFound``) on any
            page.
    """
    _configure_entrez()

    if not MIN_DAYS_BACK <= days_back <= MAX_DAYS_BACK:
        raise ValueError(
            f"days_back must be between {MIN_DAYS_BACK} and {MAX_DAYS_BACK}, "
            f"got {days_back}"
        )

    # UTC so the window is stable regardless of host timezone and DST —
    # PubMed's index timestamps are UTC-based.
    mindate = (datetime.now(UTC) - timedelta(days=days_back)).strftime("%Y/%m/%d")

    logger.info(f"PubMed query (last {days_back}d): {SVD_QUERY[:120]}...")

    try:
        results = await _run_entrez_search(
            db="pubmed",
            term=SVD_QUERY,
            datetype="edat",
            mindate=mindate,
            maxdate="3000",
            retmax=DEFAULT_RETMAX,
            usehistory="y",
        )
    except _ENTREZ_FAILURES as e:
        raise PubMedSearchError(f"Entrez API call failed: {e}") from e

    # Each page re-runs the search (see below) over a window still open at
    # the top, so a record indexed mid-walk shifts every later offset by
    # one: the next page repeats the id that ended this one, and the oldest
    # id in the window is never reached. Counting that repeat as a paper
    # stopped the walk one short with `len == Count`, so the loss was
    # silent and the duplicate inflated "papers matched". So: ids are kept
    # ordered and unique, `retstart` is the raw number of ids received,
    # and `Count` is the largest any page reported -- a grown window is
    # paged to its end, and a short unique list is reported as truncation.
    first_ids = results.get("IdList", [])
    seen: dict[str, None] = dict.fromkeys(first_ids)
    offset = len(first_ids)
    total_count = int(results.get("Count", 0))

    # Paginate if there are more results than the initial batch
    if total_count > offset:
        web_env = results.get("WebEnv")
        query_key = results.get("QueryKey")

        if web_env and query_key:
            while offset < total_count and len(seen) < MAX_TOTAL_RESULTS:
                try:
                    # The date filter is repeated on every page, and that
                    # is not redundant. esearch re-runs `term` even when a
                    # WebEnv and query_key are supplied, so a page that
                    # named only the term searched the *unfiltered* index:
                    # for a 365-day window (795 papers) page 2 came back
                    # with Count=8265 -- the all-time set -- and 205 of its
                    # 500 ids were outside the window. It went unreported
                    # because 500 + 500 exceeds 795, so `len(pmids) <
                    # total_count` was false and the truncation guard below
                    # never fired. Measured against the live API, repeating
                    # the filter returns the window's remaining 295 and
                    # Count=795, and the two pages union to exactly the set
                    # a single unpaged search returns.
                    batch = await _run_entrez_search(
                        db="pubmed",
                        term=SVD_QUERY,
                        datetype="edat",
                        mindate=mindate,
                        maxdate="3000",
                        retstart=offset,
                        retmax=DEFAULT_RETMAX,
                        webenv=web_env,
                        query_key=query_key,
                    )
                except _ENTREZ_FAILURES as e:
                    logger.warning(f"PubMed pagination failed at offset {offset}: {e}")
                    break

                batch_ids = batch.get("IdList", [])
                if not batch_ids:
                    break
                offset += len(batch_ids)
                seen.update(dict.fromkeys(batch_ids))
                batch_count = int(batch.get("Count", total_count))
                if batch_count != total_count:
                    logger.warning(
                        f"PubMed window changed while paging: Count "
                        f"{total_count} -> {batch_count} at offset {offset}"
                    )
                    total_count = max(total_count, batch_count)

            if len(seen) >= MAX_TOTAL_RESULTS:
                logger.warning(
                    f"PubMed results capped at {MAX_TOTAL_RESULTS} "
                    f"(total available: {total_count})"
                )

    pmids = list(seen)

    # Every way of coming up short reports the same way. A pagination
    # failure was the only one that reached the run report; the
    # MAX_TOTAL_RESULTS cap (a 10-year window matches ~8000 papers), a
    # window NCBI answered without WebEnv/QueryKey, and an empty batch
    # mid-walk all returned a short list with at most a log line, so the
    # widget badged step 1 clean and published the truncated number as
    # "papers matched". The papers past the cut are not in this run and no
    # later window contains them either -- every window ends at now.
    if len(pmids) < total_count:
        logger.warning(
            f"PubMed results TRUNCATED: retrieved {len(pmids)} of "
            f"{total_count} total available. "
            f"Some papers are missing from this pipeline run."
        )
        if on_truncated is not None:
            on_truncated(len(pmids), total_count)

    logger.info(f"PubMed search returned {len(pmids)} result(s)")
    return pmids


def filter_new_pmids(pmids: list[str], existing: set[str]) -> list[str]:
    """Remove PMIDs already in the dashboard (preserves order, dedupes).

    Args:
        pmids: List of PMIDs to filter.
        existing: Set of PMIDs already processed.

    Returns:
        List of new, unique PMIDs in original order.
    """
    return list(dict.fromkeys(pmid for pmid in pmids if pmid not in existing))
