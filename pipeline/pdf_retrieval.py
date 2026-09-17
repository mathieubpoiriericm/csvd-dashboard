"""PDF and fulltext retrieval module with async HTTP client pooling.

This module provides efficient multi-source text fetching for academic papers,
falling back through PubMed Central, an Unpaywall-sourced PDF, and finally
the abstract. Europe PMC (pipeline.europepmc) is tried before all of these —
see get_fulltext for the full cascade order.
"""

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Final, Literal, TypedDict

import httpx
from lxml import etree  # type: ignore[import-untyped]

from pipeline import ncbi_http
from pipeline.api_telemetry import record_transport_failure
from pipeline.config import (
    NCBI_EFETCH_URL,
    SAFE_XML_PARSER,
    get_ncbi_params,
    validate_pmid,
)
from pipeline.europepmc import fetch_europepmc_fulltext, is_pdf_only_notice
from pipeline.http_client import AsyncHttpClientManager
from pipeline.pdf_parse import parse_pdf_bytes, parse_pdf_file

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------

DOI_PATTERN: Final[re.Pattern[str]] = re.compile(r"^10\.\d{4,}/[^\s]+$")
# Both PDF-path callers (download_and_parse_pdf, parse_local_pdf) now route
# through pipeline.pdf_parse, which serializes via Docling's
# DoclingDocument.export_to_html(). Headings render as bare, attribute-less
# tags — f"<h{level}>{text}</h{level}>" (docling_core.types.doc.utils
# .get_html_tag_with_text_direction, docling-core 2.92.0) — never as
# newline-bounded plain text, so the pattern has to be tag-aware. Confirmed
# against a real DoclingDocument.export_to_html() call: a heading serializes
# as literally "<h2>References</h2>", not "\nReferences\n".
#
# The words are matched with the section number journals put in front of
# them and the variants they are titled with: "<h2>5. References</h2>",
# "<h2>References and Notes</h2>" and "<h2>Literature Cited</h2>" all left
# the bibliography in the text, where a cited title ("NOTCH3 mutations in
# CADASIL...") names genes the paper never studied and the quote check
# passes because the quote really is in the document.
_BIBLIOGRAPHY_WORDS: Final[str] = (
    r"References?(?:\s+and\s+Notes)?|Bibliography|Literature\s+Cited|"
    r"Works\s+Cited|Reference\s+List"
)
_BACK_MATTER_WORDS: Final[str] = (
    rf"{_BIBLIOGRAPHY_WORDS}|Methods|Online\s+content|Acknowledge?ments?|"
    r"Data\s+availability"
)
_SECTION_NUMBER: Final[str] = r"(?:\d+(?:\.\d+)*[.)]?\s+)?"
_BACK_MATTER_PATTERN: Final[re.Pattern[str]] = re.compile(
    rf"<h([1-6])[^>]*>\s*{_SECTION_NUMBER}(?:{_BACK_MATTER_WORDS})\s*:?\s*</h\1>"
    # Docling classifies a heading as body text often enough to matter, and
    # a whole paragraph that is only the word "References" is a heading
    # however it is tagged. Restricted to the bibliography words: a stray
    # <p>Methods</p> in the second half of a paper is a plausible sentence
    # fragment, and cutting there would discard the results.
    rf"|<p[^>]*>\s*{_SECTION_NUMBER}(?:{_BIBLIOGRAPHY_WORDS})\s*:?\s*</p>",
    re.IGNORECASE,
)

# Timeout configurations
DEFAULT_TIMEOUT: Final[httpx.Timeout] = httpx.Timeout(
    connect=10.0, read=30.0, write=10.0, pool=5.0
)
PDF_TIMEOUT: Final[httpx.Timeout] = httpx.Timeout(
    connect=10.0, read=120.0, write=10.0, pool=5.0
)

# Connection limits
MAX_PDF_BYTES: Final[int] = 100 * 1024 * 1024  # 100 MB

DEFAULT_LIMITS: Final[httpx.Limits] = httpx.Limits(
    max_keepalive_connections=10, max_connections=20
)

# Environment config
UNPAYWALL_EMAIL: Final[str] = os.getenv("UNPAYWALL_EMAIL", "")
ENTREZ_EMAIL: Final[str] = os.getenv("ENTREZ_EMAIL", "")

# The PMC ID converter moved: www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/
# now answers 301 to this URL, and following the redirect recorded the real
# call under a host api_telemetry.SERVICES did not know. The new endpoint
# asks for `tool` and `email` and returns a warnings array when they are
# missing.
PMC_IDCONV_URL: Final[str] = "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/"
PMC_IDCONV_TOOL: Final[str] = "csvd-dashboard"


# What PMC's efetch answers for an article it holds but does not license
# for XML download: a well-formed document whose whole body is this one
# sentence. Europe PMC serves the OA subset first, so this branch is reached
# mostly for exactly those articles, and the notice was being read as the
# paper -- the model extracted from one sentence and the PMID was retired
# with fulltext_available = true.
_PMC_UNAVAILABLE_NOTICE: Final[re.Pattern[str]] = re.compile(
    r"does not allow downloading of the full text", re.IGNORECASE
)
# A real article carries <front> matter and a sectioned body. One with front
# matter, no <sec> at all and a few words of body is a notice of some kind,
# whatever it says; fixtures without <front> are left alone.
_PMC_MIN_UNSECTIONED_CHARS: Final[int] = 500


class RetrievalError(RuntimeError):
    """The last-resort source could not answer.

    Raised by fetch_abstract when PubMed itself cannot be reached or answers
    with an error status. The three sources before it swallow their own
    failures and fall through, because the abstract is the fallback for
    them; nothing is the fallback for the abstract. A None here would be
    published by process_paper as "no text available", stored in
    pubmed_refs with source="none", and never retried, so a transient 503
    or timeout must surface as an error the caller marks retryable instead.
    """


class FulltextResult(TypedDict):
    """Result from fulltext retrieval attempt."""

    text: str | None
    source: Literal["europepmc", "pmc", "unpaywall", "abstract"]
    fulltext: bool


# ---------------------------------------------------------------------------
# HTTP CLIENT
# ---------------------------------------------------------------------------

_client_manager = AsyncHttpClientManager(
    timeout=DEFAULT_TIMEOUT,
    limits=DEFAULT_LIMITS,
    follow_redirects=True,
)


async def close_http_client() -> None:
    """Close shared HTTP client (call at shutdown)."""
    await _client_manager.close()


def _unpaywall_oa_url(data: dict[str, Any]) -> str | None:
    """Pick a best-available OA URL from an Unpaywall v2 payload, if any.

    Falls back to the landing page ``url`` when ``url_for_pdf`` is null
    (common for HTML-only OA locations); the PDF magic-byte check downstream
    rejects non-PDF responses.

    A ``submittedVersion`` is refused. Unpaywall ranks
    ``publishedVersion > acceptedVersion > submittedVersion``, so
    ``best_oa_location`` is a preprint exactly when nothing better exists:
    a paywalled article whose only open copy is its medRxiv or bioRxiv
    deposit. That preprint is a different document -- its association table
    is the one revision changed -- and extracting it stored the preprint's
    rows under the peer-reviewed PMID, with quotes that appear nowhere in
    the article of record, and retired the PMID so the published version
    was never read. The abstract of the article itself is the honest
    fallback.
    """
    if not (data.get("is_oa") and data.get("best_oa_location")):
        return None
    loc = data["best_oa_location"]
    version = loc.get("version")
    if version == "submittedVersion":
        logger.info(
            "Unpaywall's only open copy of %s is a preprint (%s); falling "
            "through to the abstract rather than extracting it",
            data.get("doi", "this DOI"),
            loc.get("host_type") or "unknown host",
        )
        return None
    if url := loc.get("url_for_pdf") or loc.get("url"):
        logger.debug("Unpaywall OA copy is %s", version or "an unstated version")
        return url
    return None


def _validate_doi(doi: str) -> str:
    """Validate and normalize a DOI.

    Args:
        doi: The DOI to validate.

    Returns:
        The validated DOI string.

    Raises:
        ValueError: If the DOI format is invalid.
    """
    doi = doi.strip()
    if not DOI_PATTERN.fullmatch(doi):
        raise ValueError(f"Invalid DOI format: {doi!r}")
    return doi


def _element_text(element: Any) -> str:
    """Join the string fragments yielded by an lxml element."""
    return "".join(part for part in element.itertext() if isinstance(part, str))


def _drop_citation_markers(paragraph: Any) -> None:
    """Remove JATS bibliographic reference markers from a paragraph, in place.

    A citation is ``<xref ref-type="bibr">12</xref>`` placed directly after
    the word it supports, so joining the paragraph's text verbatim turns
    ``<italic>COL4A1</italic><xref …>12</xref>`` into ``COL4A112`` -- an
    invented gene symbol handed to the extraction model. Only bibliographic
    markers go; a figure or table xref is the sentence's own text. The
    tail after each removed element is the prose that follows it, so it is
    reattached to whatever precedes the marker.
    """
    for xref in paragraph.findall(".//{*}xref[@ref-type='bibr']"):
        parent = xref.getparent()
        if xref.tail:
            previous = xref.getprevious()
            if previous is not None:
                previous.tail = (previous.tail or "") + xref.tail
            else:
                parent.text = (parent.text or "") + xref.tail
        parent.remove(xref)


def _parse_pmc_xml(content: bytes) -> str | None:
    """Extract body paragraphs from a PMC JATS document.

    Returns None for PMC's "does not allow downloading" notice and for a
    front-mattered article with no sections and almost no body, so the
    cascade falls through to the next source instead of publishing the
    notice as the paper.
    """
    root = etree.fromstring(content, parser=SAFE_XML_PARSER)
    paragraphs = root.findall(".//{*}body//{*}p") or root.findall(".//{*}sec//{*}p")
    text_parts: list[str] = []
    # `.//body//p` matches a paragraph nested inside another (a list item's,
    # a boxed text's) as well as the outer one, and itertext() on the outer
    # already carries the inner, so the same prose reached the model twice.
    # Document order guarantees an ancestor is seen before its descendant.
    emitted: set[Any] = set()
    for paragraph in paragraphs:
        if not emitted.isdisjoint(paragraph.iterancestors()):
            continue
        _drop_citation_markers(paragraph)
        if text := _element_text(paragraph).strip():
            text_parts.append(text)
            emitted.add(paragraph)
    if not text_parts:
        return None
    joined = "\n\n".join(text_parts)
    if _PMC_UNAVAILABLE_NOTICE.search(joined):
        logger.info("PMC holds this article but does not serve its full text")
        return None
    if is_pdf_only_notice(joined):
        # A scanned back issue: the deposit is a <front>, a <sec> and this
        # one sentence, so neither of the two guards around it sees it.
        logger.info("PMC answered a PDF-only notice, not an article")
        return None
    if (
        root.find(".//{*}front") is not None
        and root.find(".//{*}sec") is None
        and len(joined) < _PMC_MIN_UNSECTIONED_CHARS
    ):
        logger.info("PMC answered an unsectioned notice, not an article")
        return None
    return joined


def _extract_abstract(root: etree._Element) -> str | None:
    """Extract either a plain or structured abstract from parsed PubMed XML.

    Only ``<Abstract>`` is read: ``<OtherAbstract>`` holds a publisher's
    translation or a plain-language summary, and its sections were being
    appended to the abstract as unlabeled prose.
    """
    abstract_parts = root.findall(".//Abstract/AbstractText")
    if not abstract_parts:
        return None
    if len(abstract_parts) == 1:
        return _element_text(abstract_parts[0]).strip() or None

    sections: list[str] = []
    for part in abstract_parts:
        text = _element_text(part).strip()
        if text:
            label = part.get("Label", "")
            sections.append(f"{label}: {text}" if label else text)
    return "\n\n".join(sections) if sections else None


async def _read_pdf_bytes(response: httpx.Response, url: str) -> bytes | None:
    """Validate and read a streamed PDF response within the size limit."""
    if response.status_code != 200:
        logger.debug(f"PDF download failed: {response.status_code} for {url}")
        return None

    raw_content_length = response.headers.get("content-length", "0")
    try:
        content_length = int(raw_content_length)
    except ValueError:
        logger.debug(
            "Non-numeric content-length %r for %s; relying on streaming guard",
            raw_content_length,
            url,
        )
        content_length = 0
    if content_length > MAX_PDF_BYTES:
        logger.warning(f"PDF too large ({content_length} bytes), skipping: {url}")
        return None

    # The bytes decide, not the header or the URL: repositories serve PDFs
    # as application/octet-stream behind `download.pdf?token=...`, which
    # `url.endswith(".pdf")` refused, and label real PDFs text/html. A
    # landing page is rejected on its first chunk, so nothing more of it is
    # read than a content-type gate would have saved.
    chunks: list[bytes] = []
    total = 0
    async for chunk in response.aiter_bytes(65536):
        if not chunks and not chunk.startswith(b"%PDF-"):
            content_type = response.headers.get("content-type", "")
            logger.debug(
                f"Not a PDF (content-type: {content_type}, first bytes: "
                f"{chunk[:16]!r}): {url}"
            )
            return None
        total += len(chunk)
        if total > MAX_PDF_BYTES:
            logger.warning(
                f"PDF exceeded {MAX_PDF_BYTES} bytes during download, skipping: {url}"
            )
            return None
        chunks.append(chunk)

    if not chunks:
        logger.debug(f"Empty response body for {url}")
        return None
    return b"".join(chunks)


def _truncate_back_matter(text: str) -> str:
    """Cut the bibliography so its gene names are not read as findings.

    Only matches in the latter half of the document: a paper that mentions
    "Methods" in its abstract must not be truncated at the abstract.
    """
    midpoint = len(text) // 2
    match = _BACK_MATTER_PATTERN.search(text, midpoint)
    return text[: match.start()] if match else text


# ---------------------------------------------------------------------------
# FULLTEXT RETRIEVAL
# ---------------------------------------------------------------------------


async def get_fulltext(pmid: str, doi: str | None) -> FulltextResult:
    """Attempt full-text retrieval from multiple sources.

    Order: Europe PMC (JATS XML, tables preserved) -> PMC -> Unpaywall PDF
    -> abstract. Europe PMC leads because it is the only source that keeps
    table structure, and it covers ~85% of this corpus.

    Args:
        pmid: PubMed ID of the paper.
        doi: Digital Object Identifier (optional).

    Returns:
        FulltextResult with text content and source information.

    Raises:
        RetrievalError: When every full-text source came back empty and
            PubMed could not be asked for the abstract either.
    """
    pmid = validate_pmid(pmid)

    if epmc_text := await fetch_europepmc_fulltext(pmid):
        return {"text": epmc_text, "source": "europepmc", "fulltext": True}

    # Fall back to PubMed Central
    if pmc_text := await fetch_pmc_fulltext(pmid):
        return {"text": pmc_text, "source": "pmc", "fulltext": True}

    # Try Unpaywall for OA PDF
    if doi:
        try:
            doi = _validate_doi(doi)
            if (oa_url := await check_unpaywall(doi)) and (
                pdf_text := await download_and_parse_pdf(oa_url)
            ):
                return {"text": pdf_text, "source": "unpaywall", "fulltext": True}
        except ValueError:
            logger.debug(f"Invalid DOI format for PMID {pmid}: {doi}")

    # Fallback to abstract only. A RetrievalError propagates from here: the
    # sources above fall through on failure because this is their fallback,
    # but a None from this one would be recorded as a final answer.
    abstract = await fetch_abstract(pmid)
    return {"text": abstract, "source": "abstract", "fulltext": False}


async def check_unpaywall(doi: str) -> str | None:
    """Query Unpaywall API for open-access PDF URL.

    Args:
        doi: Digital Object Identifier.

    Returns:
        URL to PDF if available, None otherwise.
    """
    if not UNPAYWALL_EMAIL:
        logger.warning("UNPAYWALL_EMAIL not set, skipping Unpaywall lookup")
        return None

    url = f"https://api.unpaywall.org/v2/{doi}"
    params = {"email": UNPAYWALL_EMAIL}

    try:
        client = await _client_manager.get()
        resp = await client.get(url, params=params)

        match resp.status_code:
            case 200:
                return _unpaywall_oa_url(resp.json())
            case 404:
                logger.debug(f"DOI not found in Unpaywall: {doi}")
            case 429:
                # Single retry — Unpaywall isn't critical-path; one attempt
                # is enough before falling back to abstract-only extraction.
                logger.warning("Unpaywall rate limit exceeded, retrying once in 2s")
                await asyncio.sleep(2.0)
                resp = await client.get(url, params=params)
                if resp.status_code == 200:
                    return _unpaywall_oa_url(resp.json())
            case status:
                logger.debug(f"Unpaywall returned status {status} for DOI {doi}")

    except httpx.TimeoutException:
        record_transport_failure(url)
        logger.warning(f"Timeout checking Unpaywall for DOI {doi}")
    except httpx.RequestError as e:
        record_transport_failure(url)
        logger.warning(f"Request error checking Unpaywall for DOI {doi}: {e}")
    except json.JSONDecodeError as e:
        # A 200 carrying HTML (a maintenance page, a proxy error) is this
        # source failing, not the paper: fall through to the abstract as
        # for any other failure, rather than escaping get_fulltext.
        logger.warning(f"Unpaywall returned non-JSON for DOI {doi}: {e}")

    return None


async def fetch_pmc_fulltext(pmid: str) -> str | None:
    """Fetch full text from PubMed Central.

    First checks if the PMID has a corresponding PMC article,
    then fetches the full text in XML format and extracts the body.

    Args:
        pmid: PubMed ID.

    Returns:
        Full text content if available, None otherwise.
    """
    # Step 1: Convert PMID to PMCID
    convert_params = {"ids": pmid, "format": "json", "tool": PMC_IDCONV_TOOL}
    if ENTREZ_EMAIL:
        convert_params["email"] = ENTREZ_EMAIL
    params = get_ncbi_params(convert_params)

    try:
        client = await _client_manager.get()
        resp = await client.get(PMC_IDCONV_URL, params=params)

        if resp.status_code != 200:
            logger.debug(
                f"PMC ID conversion failed for PMID {pmid}: {resp.status_code}"
            )
            return None

        data = resp.json()
        records = data.get("records", [])
        if not records or "pmcid" not in records[0]:
            return None  # No PMC article for this PMID

        pmcid = records[0]["pmcid"]

        # Step 2: Fetch full text from PMC
        pmc_params = get_ncbi_params({"db": "pmc", "id": pmcid, "rettype": "xml"})

        pmc_resp = await ncbi_http.get_with_retry(
            client, NCBI_EFETCH_URL, pmc_params, context=f"efetch {pmcid}"
        )
        if pmc_resp is None:
            return None
        if pmc_resp.status_code != 200:
            logger.debug(f"PMC fetch failed for {pmcid}: {pmc_resp.status_code}")
            return None

        return _parse_pmc_xml(pmc_resp.content)

    except httpx.TimeoutException:
        # The efetch call goes through ncbi_http.get_with_retry, which
        # records its own transport failures; only the ID converter's call
        # can raise here.
        record_transport_failure(PMC_IDCONV_URL)
        logger.warning(f"Timeout fetching PMC fulltext for PMID {pmid}")
    except httpx.RequestError as e:
        record_transport_failure(PMC_IDCONV_URL)
        logger.warning(f"Request error fetching PMC fulltext for PMID {pmid}: {e}")
    except json.JSONDecodeError as e:
        # Same reasoning as in check_unpaywall: a non-JSON 200 from the ID
        # converter is a source failure that must fall through.
        logger.warning(f"PMC ID conversion returned non-JSON for PMID {pmid}: {e}")
    except etree.XMLSyntaxError as e:
        logger.error(f"XML parsing failed for PMID {pmid}: {e}")

    return None


# ---------------------------------------------------------------------------
# PDF PARSING
# ---------------------------------------------------------------------------


async def download_and_parse_pdf(url: str) -> str | None:
    """Download a PDF and extract its text.

    Args:
        url: URL to the PDF file.

    Returns:
        Extracted text content if successful, None otherwise.
    """
    try:
        client = await _client_manager.get()

        # Stream the response to avoid loading oversized PDFs into memory
        async with client.stream("GET", url, timeout=PDF_TIMEOUT) as resp:
            pdf_bytes = await _read_pdf_bytes(resp, url)
        if pdf_bytes is None:
            return None

        # Docling is a 5-120 s CPU-bound call; run inline it would freeze the
        # loop for every other in-flight paper. main.py hands local PDFs to
        # a worker thread the same way.
        if (text := await asyncio.to_thread(parse_pdf_bytes, pdf_bytes)) is None:
            return None
        return _truncate_back_matter(text)

    except httpx.TimeoutException:
        record_transport_failure(url)
        logger.warning(f"Timeout downloading PDF from {url}")
    except httpx.RequestError as e:
        record_transport_failure(url)
        logger.warning(f"Request error downloading PDF from {url}: {e}")
    except ImportError:
        # parse_pdf_bytes re-raises this deliberately: Docling is a hard
        # requirement, and a broken install is not a bad PDF. Swallowed
        # here it sent every Unpaywall paper in the run to its abstract
        # with one warning apiece, each retired in pubmed_refs with
        # source="abstract" and never re-fetched, while the run report
        # read `completed` with a low fulltextRetrieved that looks like
        # an ordinary short window.
        raise
    except Exception as e:
        # Intentionally broad: a corrupt download or parser failure must
        # not kill the run.
        logger.warning(f"PDF parsing failed for {url}: {e}")

    return None


def parse_local_pdf(path: Path) -> str | None:
    """Extract text from a PDF on disk (used by the --pdf run mode).

    Args:
        path: Path to the PDF file.

    Returns:
        Extracted text content if successful, None for empty/corrupt PDFs.

    Raises:
        FileNotFoundError: If the file does not exist.
    """
    if not path.exists():
        raise FileNotFoundError(f"PDF not found: {path}")

    if (text := parse_pdf_file(path)) is None:
        return None
    return _truncate_back_matter(text)


async def fetch_abstract(pmid: str) -> str | None:
    """Fetch abstract for a given PMID from PubMed.

    Args:
        pmid: PubMed ID.

    Returns:
        Abstract text if PubMed holds one, None when it does not. Only a
        ``<PubmedArticleSet>`` is allowed to say "none": a document
        without an ``<AbstractText>`` is PubMed's final answer for this
        PMID.

    Raises:
        RetrievalError: On a non-200 status, a timeout or a transport
            error -- the cases where PubMed did not answer at all -- and
            on a 200 whose body is not a PubMed document: NCBI's
            maintenance page and its in-band ``<ERROR>`` both arrive as
            a 200, and neither says whether an abstract exists.
    """
    params = get_ncbi_params(
        {
            "db": "pubmed",
            "id": pmid,
            "rettype": "abstract",
            "retmode": "xml",
        }
    )

    client = await _client_manager.get()
    resp = await ncbi_http.get_with_retry(
        client, NCBI_EFETCH_URL, params, context=f"efetch abstract {pmid}"
    )
    if resp is None:
        raise RetrievalError(f"PubMed did not answer the abstract fetch for {pmid}")

    if resp.status_code != 200:
        raise RetrievalError(
            f"Abstract fetch failed for PMID {pmid}: {resp.status_code}"
        )

    try:
        root = etree.fromstring(resp.content, parser=SAFE_XML_PARSER)
    except etree.XMLSyntaxError as e:
        raise RetrievalError(
            f"PubMed answered the abstract fetch for {pmid} with a body that "
            f"is not XML: {e}"
        ) from e
    if (problem := _not_a_pubmed_document(root)) is not None:
        raise RetrievalError(
            f"PubMed answered the abstract fetch for {pmid} with {problem}"
        )
    return _extract_abstract(root)


def _not_a_pubmed_document(root: Any) -> str | None:
    """Why a parsed efetch body is not PubMed's answer about a record.

    Returns None for a ``<PubmedArticleSet>`` -- the one root that can
    answer "no abstract" -- and a short description otherwise: the HTML
    maintenance page that parses as XML, or E-utilities' in-band
    ``<eFetchResult><ERROR>`` envelope.
    """
    if (error := root.find(".//ERROR")) is not None:
        return f"an error: {(error.text or '').strip() or 'unspecified'}"
    if root.tag != "PubmedArticleSet":
        return f"a document that is not a PubmedArticleSet (<{root.tag}>)"
    return None
