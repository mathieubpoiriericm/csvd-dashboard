"""Europe PMC full-text retrieval.

Europe PMC serves JATS XML for the large majority of open-access biomedical
literature with no key and no rate-limit registration. Unlike a PDF text
dump it preserves table structure, which is where gene-trait associations
live, and it never interleaves two-column layouts.
"""

import json
import logging
import re
from typing import Final

import httpx
from lxml import etree

from pipeline.api_telemetry import record_transport_failure
from pipeline.config import SAFE_XML_PARSER
from pipeline.http_client import AsyncHttpClientManager

logger = logging.getLogger(__name__)

# What PMC deposits for a scanned back issue: a well-formed article whose
# body is this one notice pointing at a PDF nobody parsed. Both JATS
# readers -- this one and pdf_retrieval._parse_pmc_xml -- returned it as
# the paper (it has <front> and <sec>, so neither existing guard sees it),
# the model extracted from one sentence, and the PMID was retired with
# fulltext_available = true. Anchored to the head of the extracted text:
# the notice is the body's first block, and a data-availability sentence
# deep in a real article must not cut it.
PDF_ONLY_NOTICE: Final[re.Pattern[str]] = re.compile(
    r"The Full Text of this article is available as a PDF", re.IGNORECASE
)
_NOTICE_HEAD_CHARS: Final[int] = 200


def is_pdf_only_notice(text: str) -> bool:
    """True when a JATS body is PMC's "available as a PDF" stub, not a paper."""
    return PDF_ONLY_NOTICE.search(text[:_NOTICE_HEAD_CHARS]) is not None

SEARCH_URL: Final[str] = "https://www.ebi.ac.uk/europepmc/webservices/rest/search"
FULLTEXT_URL: Final[str] = (
    "https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML"
)
_TIMEOUT: Final[httpx.Timeout] = httpx.Timeout(30.0, connect=10.0)

_client_manager = AsyncHttpClientManager(timeout=_TIMEOUT, follow_redirects=True)


async def close_http_client() -> None:
    """Close the shared client (call at shutdown)."""
    await _client_manager.close()


def parse_jats(content: bytes) -> str | None:
    """Extract readable text from a JATS document, tables included."""
    try:
        root = etree.fromstring(content, parser=SAFE_XML_PARSER)
    except etree.XMLSyntaxError:
        logger.debug("Europe PMC returned malformed XML")
        return None

    body = root.find(".//body")
    if body is None:
        return None

    # Bibliography entries are commonly rendered inside <body> rather than a
    # sibling <back> (a live survey of 9 real Europe PMC documents across
    # different publishers found 6 do this). Every publisher observed there
    # renders citation text via tags this walk never collects
    # (mixed-citation/named-content, or element-citation/article-title/
    # source) — safety by coincidence, not construction. Strip <ref-list>
    # subtrees explicitly so a publisher or a future Europe PMC rendering
    # change that puts a bare <p>/<title>/<th>/<td> inside a reference list
    # cannot leak citation text into extracted output — the same hazard
    # pdf_retrieval._BACK_MATTER_PATTERN defends against, explicitly, on the
    # PDF path.
    for ref_list in body.findall(".//ref-list"):
        parent = ref_list.getparent()
        if parent is not None:
            parent.remove(ref_list)

    # itertext() flattens descendants, so an element nested inside one
    # already emitted would send the same prose to the model twice. Real
    # JATS nests <p> inside <td> routinely, which made every table cell's
    # text appear once as part of the cell and again on its own. iter() is
    # document order, so an ancestor is always reached before its
    # descendant and this set is complete by the time it is consulted.
    emitted: set[etree._Element] = set()
    blocks = _blocks(body, emitted)

    # JATS allows <table-wrap> and <fig> to sit in a <floats-group> beside
    # <body> rather than inside it, and publishers use it: PMC12385738 (a
    # 2025 CADASIL review) has zero <tr> in its body and three in its
    # floats-group, so the whole table set and its captions were absent
    # from the text sent to the model while the paper was still recorded
    # `source: "europepmc", fulltext: True` and the PMID retired on it.
    # Table structure is the stated reason this source leads the cascade.
    # Emitted after the body, in document order within each group.
    for floats_group in root.findall(".//floats-group"):
        blocks.extend(_blocks(floats_group, emitted))

    joined = "\n".join(blocks).strip()
    if not joined:
        return None
    if is_pdf_only_notice(joined):
        logger.info("Europe PMC answered a PDF-only notice, not an article")
        return None
    return joined


def _blocks(container: etree._Element, emitted: set[etree._Element]) -> list[str]:
    """The readable blocks of one subtree, skipping already-emitted nesting.

    A table row is one block, not one per cell: emitted cell by cell, a
    gene, its trait and its p-value reached the model as three unrelated
    lines, and the association the table stated was left for it to
    re-infer. Cells are joined with " | " in column order, empty ones kept
    so the columns still line up with the header row.
    """
    blocks: list[str] = []
    for element in container.iter("p", "title", "tr"):
        if not emitted.isdisjoint(element.iterancestors()):
            continue
        text = _row_text(element) if element.tag == "tr" else _text(element)
        if text:
            blocks.append(text)
            emitted.add(element)
    return blocks


def _text(element: etree._Element) -> str:
    """An element's whole text, whitespace collapsed."""
    # itertext() is typed Iterator[str | bytes] in lxml-stubs even though
    # it only ever yields str for a tree parsed from bytes; narrow with
    # isinstance rather than ignore, matching pdf_retrieval._element_text.
    fragments = (part for part in element.itertext() if isinstance(part, str))
    return " ".join(" ".join(fragments).split())


def _row_text(row: etree._Element) -> str:
    """A table row on one line, cells separated by ``" | "``."""
    cells = [_text(cell) for cell in row if cell.tag in ("th", "td")]
    return " | ".join(cells) if any(cells) else ""


async def _resolve_pmcid(pmid: str) -> str | None:
    """Find the PMCID for a PMID, and whether full text is available."""
    client = await _client_manager.get()
    response = await client.get(
        SEARCH_URL,
        params={
            "query": f"EXT_ID:{pmid} AND SRC:MED",
            "resultType": "core",
            "format": "json",
            "pageSize": "1",
        },
    )
    response.raise_for_status()
    results = response.json().get("resultList", {}).get("result", [])
    if not results:
        return None
    record = results[0]
    if record.get("inEPMC") != "Y":
        return None
    return record.get("pmcid")


async def fetch_europepmc_fulltext(pmid: str) -> str | None:
    """Return Europe PMC full text for a PMID, or None if unavailable."""
    # Which of the two endpoints is in flight, so a transport failure --
    # which produces no response and so never reaches the telemetry hook --
    # is recorded against the one that met it.
    endpoint = SEARCH_URL
    try:
        pmcid = await _resolve_pmcid(pmid)
        if not pmcid:
            return None
        client = await _client_manager.get()
        endpoint = FULLTEXT_URL.format(pmcid=pmcid)
        response = await client.get(endpoint)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return parse_jats(response.content)
    except httpx.RequestError as exc:
        record_transport_failure(endpoint)
        logger.warning("Europe PMC lookup failed for PMID %s: %s", pmid, exc)
        return None
    except (httpx.HTTPError, json.JSONDecodeError) as exc:
        # What is left after httpx.RequestError above: an HTTPStatusError
        # from raise_for_status, whose response the telemetry hook already
        # recorded, and json.JSONDecodeError -- the search endpoint's
        # response.json() call in _resolve_pmcid raises that (a ValueError)
        # on a 200 with a non-JSON body, which httpx.HTTPError alone would
        # not catch. httpx.TimeoutException needs no entry in either list:
        # it is an httpx.RequestError, so it is recorded above.
        logger.warning("Europe PMC lookup failed for PMID %s: %s", pmid, exc)
        return None
