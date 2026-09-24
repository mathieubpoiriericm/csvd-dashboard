"""PubMed citation fetching module.

Fetches citation details (authors, title, journal, DOI) from PubMed
and formats them for dashboard display.
"""

import asyncio
import html
import logging
import re
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final

from lxml import etree  # type: ignore[import-untyped]

from pipeline import ncbi_http
from pipeline.cache_utils import (
    SyncResult,
    make_log_progress,
    run_batched_fetch,
    single_flight_get,
    sync_cache_misses,
)
from pipeline.config import (
    NCBI_EFETCH_URL,
    SAFE_XML_PARSER,
    PipelineConfig,
)
from pipeline.http_client import AsyncHttpClientManager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------


# NCBI_EFETCH_URL imported from pipeline.config
# 7-digit floor avoids catching year-like tokens; 9 is the current PMID upper bound.
_PMID_EXTRACT_PATTERN: Final[re.Pattern[str]] = re.compile(r"\b(\d{7,9})\b")

# Strip DOI URLs and bare DOIs before PMID extraction — LLMs sometimes inline
# preprint DOIs (e.g., "https://doi.org/10.21203/rs.3.rs-5926137/v1") whose
# numeric fragment otherwise gets misread as a PMID.
_DOI_STRIP_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r"https?://\S+"),
    re.compile(r"\bdoi:\s*\S+", re.IGNORECASE),
    re.compile(r"\b10\.\d{4,9}/\S+"),
)


@dataclass(slots=True)
class PubMedCitation:
    """PubMed citation information."""

    pmid: str
    authors: str | None
    title: str | None
    journal: str | None
    publication_date: str | None
    doi: str | None
    formatted_ref: str


# ---------------------------------------------------------------------------
# HTTP CLIENT AND CACHE
# ---------------------------------------------------------------------------

# Module-level shared HTTP client (30s timeout for PubMed efetch XML responses)
_client_manager = AsyncHttpClientManager(timeout=30.0)
_citation_cache: OrderedDict[str, PubMedCitation | None] = OrderedDict()
_cache_lock: asyncio.Lock | None = None
_ncbi_semaphore: asyncio.Semaphore | None = None
# Single-flight registry: concurrent callers for the same PMID await the
# same task instead of issuing duplicate NCBI requests.
_in_flight: dict[str, asyncio.Task[PubMedCitation | None]] = {}


def _get_cache_lock() -> asyncio.Lock:
    """Lazy-init cache lock (avoids creating Lock before event loop exists)."""
    global _cache_lock
    if _cache_lock is None:
        _cache_lock = asyncio.Lock()
    return _cache_lock


def _get_ncbi_semaphore(config: PipelineConfig | None = None) -> asyncio.Semaphore:
    """Get or create the NCBI rate-limit semaphore."""
    global _ncbi_semaphore
    if _ncbi_semaphore is None:
        limit = (config or PipelineConfig()).ncbi_rate_limit
        _ncbi_semaphore = asyncio.Semaphore(limit)
    return _ncbi_semaphore


async def close_pubmed_client() -> None:
    """Close shared HTTP client (call at shutdown)."""
    await _client_manager.close()


def clear_pubmed_cache() -> None:
    """Clear the citation cache and any stale in-flight task references."""
    global _citation_cache
    _citation_cache = OrderedDict()
    _in_flight.clear()


# ---------------------------------------------------------------------------
# FORMATTING HELPERS
# ---------------------------------------------------------------------------


def _format_authors(author_list: list[str], max_authors: int = 3) -> str:
    """Format author list with 'et al.' for long lists."""
    if not author_list:
        return ""

    if len(author_list) <= max_authors:
        return ", ".join(author_list)

    return f"{', '.join(author_list[:max_authors])}, et al."


def _title_case(text: str) -> str:
    """Convert text to title case, handling special cases."""
    # Simple title case - capitalize first letter of each sentence
    words = text.split()
    if not words:
        return ""
    # Not str.capitalize(): that lowercases the rest of the word, and a
    # title leading with a gene symbol or acronym was published as "Ica1l"
    # and "Cadasil.".
    words[0] = words[0][0].upper() + words[0][1:]
    return " ".join(words)


def _format_citation(
    authors: str | None,
    title: str | None,
    journal: str | None,
    pub_date: str | None,
    doi: str | None,
) -> str:
    """Format citation as HTML string for display.

    Format:
    Authors. Title. Journal (Date). DOI: doi

    The text fields are escaped: this string is rendered as HTML by the
    dashboard, and a title reading "levels <40" or an author list with
    an ampersand would otherwise reach the page as markup.
    """
    parts = []

    if authors:
        parts.append(f"<b>{html.escape(authors, quote=False)}</b>")

    if title:
        # Title case the title
        formatted_title = html.escape(_title_case(title), quote=False)
        parts.append(f"<i>{formatted_title}</i>")

    if journal:
        journal = html.escape(journal, quote=False)
        parts.append(f"{journal} ({pub_date})" if pub_date else journal)

    if doi:
        parts.append(f"DOI: {doi}")

    return "<br>".join(parts)


# ---------------------------------------------------------------------------
# CITATION FETCHING
# ---------------------------------------------------------------------------


async def fetch_pubmed_citation(
    pmid: str, config: PipelineConfig | None = None
) -> PubMedCitation | None:
    """Fetch citation details for a single PMID.

    Results are cached; concurrent callers for the same PMID share one
    in-flight fetch via ``single_flight_get``.
    """
    pmid = pmid.strip()
    return await single_flight_get(
        pmid,
        cache=_citation_cache,
        cache_lock=_get_cache_lock(),
        in_flight=_in_flight,
        semaphore=_get_ncbi_semaphore(config),
        fetch_fn=lambda: _fetch_pubmed_uncached(pmid),
        label="PubMed citation cache",
    )


async def _fetch_pubmed_uncached(pmid: str) -> PubMedCitation | None:
    """Internal: fetch PubMed citation without caching.

    Transport failures are absorbed by the shared NCBI helper, which
    returns None for them; only an answer is parsed.
    """
    params = {"db": "pubmed", "id": pmid, "retmode": "xml"}

    client = await _client_manager.get()
    resp = await ncbi_http.get_with_retry(
        client, NCBI_EFETCH_URL, params, context=f"efetch citation {pmid}"
    )
    if resp is None:
        return None
    if resp.status_code != 200:
        logger.warning(f"PubMed efetch failed for PMID {pmid}: {resp.status_code}")
        return None

    return _parse_pubmed_xml(pmid, resp.content)


def _joined_text(parent: Any, path: str) -> str:
    """The whole text of the first element at ``path``, or ``""``.

    Not ``findtext``: lxml's returns only the text before the first child
    element, and PubMed marks gene symbols up as ``<i>`` inside titles, so
    a title was cut off at the gene it was about (the committed refs.json
    carried "Extension of the Clinicoradiologic Spectrum of Newly Described
    End-Truncating" with the gene name that followed missing).
    """
    element = parent.find(path)
    return "".join(element.itertext()) if element is not None else ""


def _author_names(authors: list[Any]) -> list[str]:
    """``LastName Initials`` for each author element that has a last name."""
    names: list[str] = []
    for author in authors:
        last_name = author.findtext("LastName", "")
        initials = author.findtext("Initials", "")
        if last_name:
            names.append(f"{last_name} {initials}".strip())
    return names


def _pub_date(pub_date_elem: Any) -> str | None:
    """``Month Year`` or ``Year`` from a PubDate element; None without a date.

    A range or an irregular issue carries ``<MedlineDate>2019 Nov-Dec``
    in place of Year and Month, and that is the date then.
    """
    if pub_date_elem is None:
        return None
    year = pub_date_elem.findtext("Year", "")
    month = pub_date_elem.findtext("Month", "")
    if not year:
        return pub_date_elem.findtext("MedlineDate", "").strip() or None
    return f"{month} {year}".strip() if month else year


# Where a record's own DOI lives. Not `.//ArticleId`: PubmedData carries the
# article's ArticleIdList and then a ReferenceList whose entries use the
# same <ArticleId IdType="doi">, so a record with no DOI of its own was
# published -- and handed to Unpaywall -- under the first paper it cites.
_ARTICLE_DOI_PATHS: Final[tuple[str, ...]] = (
    "PubmedData/ArticleIdList/ArticleId[@IdType='doi']",
    "MedlineCitation/Article/ELocationID[@EIdType='doi']",
)
_BOOK_DOI_PATHS: Final[tuple[str, ...]] = ("ArticleIdList/ArticleId[@IdType='doi']",)


def _doi(record: Any, paths: tuple[str, ...]) -> str | None:
    """The record's own DOI, from the first of ``paths`` that carries one."""
    for path in paths:
        element = record.find(path)
        if element is not None and isinstance(element.text, str) and element.text:
            return element.text.strip()
    return None


def _parse_pubmed_xml(pmid: str, xml_content: bytes) -> PubMedCitation | None:
    """Parse PubMed XML response to extract citation details."""
    try:
        root = etree.fromstring(xml_content, parser=SAFE_XML_PARSER)
    except etree.XMLSyntaxError as e:
        logger.error(f"XML parsing failed for PMID {pmid}: {e}")
        return None

    if (article := root.find(".//PubmedArticle")) is not None:
        authors = _format_authors(_author_names(article.findall(".//Author")))
        title = _joined_text(article, ".//ArticleTitle")
        journal = _joined_text(article, ".//Journal/Title") or _joined_text(
            article, ".//Journal/ISOAbbreviation"
        )
        pub_date = _pub_date(article.find(".//PubDate"))
        doi = _doi(article, _ARTICLE_DOI_PATHS)
    elif (book := root.find(".//PubmedBookArticle/BookDocument")) is not None:
        # A book chapter -- GeneReviews, for this corpus -- is a different
        # record shape: the chapter's title and authors sit on BookDocument,
        # the book's title, date and editors on Book. The book title stands
        # in for the journal, and the editors for the authors when the
        # chapter lists none.
        author_list = book.find("AuthorList")
        if author_list is None:
            author_list = book.find("Book/AuthorList")
        author_elems = author_list.findall("Author") if author_list is not None else []
        authors = _format_authors(_author_names(author_elems))
        journal = _joined_text(book, "Book/BookTitle")
        title = _joined_text(book, "ArticleTitle") or journal
        pub_date = _pub_date(book.find("Book/PubDate"))
        doi = _doi(book, _BOOK_DOI_PATHS)
    else:
        logger.warning(f"No PubmedArticle found for PMID {pmid}")
        return PubMedCitation(
            pmid=pmid,
            authors=None,
            title=None,
            journal=None,
            publication_date=None,
            doi=None,
            formatted_ref=f"PMID: {pmid} (citation not available)",
        )

    formatted_ref = _format_citation(authors, title, journal, pub_date, doi)

    return PubMedCitation(
        pmid=pmid,
        authors=authors or None,
        title=title or None,
        journal=journal or None,
        publication_date=pub_date,
        doi=doi,
        formatted_ref=formatted_ref,
    )


async def fetch_pubmed_citations_batch(
    pmids: list[str],
    progress_callback: Callable[[int, int], None] | None = None,
    config: PipelineConfig | None = None,
) -> list[PubMedCitation]:
    """Fetch citations for multiple PMIDs concurrently.

    Uses the module-level semaphore (via fetch_pubmed_citation) to rate-limit
    concurrent requests.
    """

    async def _fetch_one(pmid: str) -> PubMedCitation:
        citation = await fetch_pubmed_citation(pmid, config=config)
        return citation or PubMedCitation(
            pmid=pmid,
            authors=None,
            title=None,
            journal=None,
            publication_date=None,
            doi=None,
            formatted_ref=f"PMID: {pmid} (citation fetch failed)",
        )

    return await run_batched_fetch(
        pmids, _fetch_one, progress_callback=progress_callback
    )


def extract_pmids_from_text(text: str | None) -> list[str]:
    """Extract unique PMIDs from text containing references.

    Handles formats like:
    - "PMID: 12345678"
    - "12345678, 23456789"
    - Semicolon or comma separated lists

    Args:
        text: Text containing PMID references. None/empty returns [].

    Returns:
        List of unique PMIDs.
    """
    if not text:
        return []

    for pattern in _DOI_STRIP_PATTERNS:
        text = pattern.sub(" ", text)
    pmids = _PMID_EXTRACT_PATTERN.findall(text)
    return list(dict.fromkeys(pmids))


# ---------------------------------------------------------------------------
# DATABASE SYNC
# ---------------------------------------------------------------------------


async def sync_pubmed_citations(
    pmids: list[str],
    config: PipelineConfig | None = None,
) -> SyncResult:
    """Sync PubMed citations to database for given PMIDs.

    Args:
        pmids: List of PubMed IDs to sync.
        config: Pipeline config (for ncbi_rate_limit semaphore sizing).

    Returns:
        SyncResult with counts of fetched, cached, and failed citations.
    """
    from pipeline.database import (
        get_cached_pubmed_citations,
        upsert_pubmed_citations_batch,
    )

    unique_pmids = list(dict.fromkeys(pmids))

    # Check what's already cached in database
    cached_citations = await get_cached_pubmed_citations(unique_pmids)
    pmids_to_fetch = [p for p in unique_pmids if p not in cached_citations]

    logger.info(
        f"PubMed sync: {len(cached_citations)} cached, {len(pmids_to_fetch)} to fetch"
    )

    # Only citations with a title are stored. get_cached_pubmed_citations
    # has no TTL and no title filter, so a stored placeholder would count as
    # cached on every later run and refs.json would publish "(citation
    # fetch failed)" forever; a 429 or timeout is not a fact about the PMID.
    return await sync_cache_misses(
        pmids_to_fetch,
        cached_count=len(cached_citations),
        fetch_batch=lambda missing: fetch_pubmed_citations_batch(
            missing,
            make_log_progress("PubMed fetch"),
            config=config,
        ),
        upsert_batch=upsert_pubmed_citations_batch,
        is_success=lambda citation: citation.title is not None,
        error_for=lambda citation: f"Citation fetch failed: PMID {citation.pmid}",
    )
