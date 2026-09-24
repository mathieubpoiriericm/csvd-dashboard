"""Tests for pipeline.pdf_retrieval — fulltext cascade, validation helpers."""

import logging
import threading
from collections.abc import AsyncIterator
from typing import cast
from unittest.mock import ANY, AsyncMock, MagicMock

import httpx
import pytest
from lxml import etree  # type: ignore[import-untyped]

from pipeline.config import PMID_PATTERN
from pipeline.pdf_retrieval import (
    DOI_PATTERN,
    MAX_PDF_BYTES,
    RetrievalError,
    _drop_citation_markers,
    _extract_abstract,
    _parse_pmc_xml,
    _read_pdf_bytes,
    _validate_doi,
    check_unpaywall,
    close_http_client,
    download_and_parse_pdf,
    fetch_abstract,
    fetch_pmc_fulltext,
    get_fulltext,
)

# ---------------------------------------------------------------------------
# _validate_doi
# ---------------------------------------------------------------------------


class TestValidateDoi:
    def test_valid_doi(self):
        assert _validate_doi("10.1234/test.123") == "10.1234/test.123"

    def test_strips_whitespace(self):
        assert _validate_doi("  10.1234/test  ") == "10.1234/test"

    def test_invalid_format(self):
        with pytest.raises(ValueError, match="Invalid DOI"):
            _validate_doi("not-a-doi")

    def test_invalid_empty(self):
        with pytest.raises(ValueError, match="Invalid DOI"):
            _validate_doi("")


# ---------------------------------------------------------------------------
# get_fulltext cascade
# ---------------------------------------------------------------------------


class TestGetFulltext:
    async def test_europepmc_first(self, mocker):
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_europepmc_fulltext",
            return_value="Full text from Europe PMC",
        )
        mock_pmc = mocker.patch("pipeline.pdf_retrieval.fetch_pmc_fulltext")
        result = await get_fulltext("12345678", "10.1234/test")
        assert result["source"] == "europepmc"
        assert result["fulltext"] is True
        assert result["text"] == "Full text from Europe PMC"
        mock_pmc.assert_not_called()

    async def test_pmc_fallback_when_europepmc_empty(self, mocker):
        """Also covers a Europe PMC outage, not just "not found there".

        The two look identical from get_fulltext's side, since
        fetch_europepmc_fulltext already swallows httpx errors internally and
        returns None either way — see test_europepmc.py's
        TestFetchEuropepmcFulltext for that guarantee at the source.
        """
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_europepmc_fulltext", return_value=None
        )
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_pmc_fulltext",
            return_value="Full text from PMC",
        )
        result = await get_fulltext("12345678", "10.1234/test")
        assert result["source"] == "pmc"
        assert result["fulltext"] is True
        assert result["text"] == "Full text from PMC"

    async def test_unpaywall_fallback(self, mocker):
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_europepmc_fulltext", return_value=None
        )
        mocker.patch("pipeline.pdf_retrieval.fetch_pmc_fulltext", return_value=None)
        mocker.patch(
            "pipeline.pdf_retrieval.check_unpaywall",
            return_value="https://example.com/paper.pdf",
        )
        mocker.patch(
            "pipeline.pdf_retrieval.download_and_parse_pdf",
            return_value="PDF text",
        )
        result = await get_fulltext("12345678", "10.1234/test")
        assert result["source"] == "unpaywall"
        assert result["fulltext"] is True

    async def test_abstract_fallback(self, mocker):
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_europepmc_fulltext", return_value=None
        )
        mocker.patch("pipeline.pdf_retrieval.fetch_pmc_fulltext", return_value=None)
        mocker.patch("pipeline.pdf_retrieval.check_unpaywall", return_value=None)
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_abstract",
            return_value="Abstract text",
        )
        result = await get_fulltext("12345678", "10.1234/test")
        assert result["source"] == "abstract"
        assert result["fulltext"] is False
        assert result["text"] == "Abstract text"

    async def test_no_doi_skips_unpaywall(self, mocker):
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_europepmc_fulltext", return_value=None
        )
        mocker.patch("pipeline.pdf_retrieval.fetch_pmc_fulltext", return_value=None)
        mock_unpaywall = mocker.patch("pipeline.pdf_retrieval.check_unpaywall")
        mocker.patch("pipeline.pdf_retrieval.fetch_abstract", return_value="Abstract")

        result = await get_fulltext("12345678", None)
        mock_unpaywall.assert_not_called()
        assert result["source"] == "abstract"

    async def test_abstract_failure_propagates_when_every_source_is_empty(
        self, mocker
    ):
        """The abstract is the last resort, so its failure cannot be swallowed.

        Europe PMC, PMC and Unpaywall each fall through on error because the
        abstract is the fallback for *them*. Nothing is the fallback for the
        abstract: a None here would be published as "no text available" and
        the paper never retried, so the error has to reach process_paper.
        """
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_europepmc_fulltext", return_value=None
        )
        mocker.patch("pipeline.pdf_retrieval.fetch_pmc_fulltext", return_value=None)
        mocker.patch("pipeline.pdf_retrieval.check_unpaywall", return_value=None)
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_abstract",
            side_effect=RetrievalError("PubMed returned 503"),
        )

        with pytest.raises(RetrievalError, match="503"):
            await get_fulltext("12345678", "10.1234/test")

    async def test_invalid_pmid_raises(self):
        with pytest.raises(ValueError, match="Invalid PMID"):
            await get_fulltext("invalid", None)

    async def test_pmc_stub_falls_through_to_the_abstract(self, mocker):
        # The ID converter finds a PMCID, PMC answers the "does not allow
        # downloading" notice, and the cascade must keep going rather than
        # publish the notice as the paper.
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_europepmc_fulltext", return_value=None
        )
        mocker.patch("pipeline.ncbi_http.throttle", new=AsyncMock())
        conversion = MagicMock(status_code=200)
        conversion.json.return_value = {"records": [{"pmcid": "PMC123"}]}
        stub = MagicMock(
            status_code=200,
            content=(
                b"<pmc-articleset><article><body><p>The publisher of this "
                b"article does not allow downloading of the full text in XML "
                b"form.</p></body></article></pmc-articleset>"
            ),
        )
        abstract = MagicMock(
            status_code=200,
            content=(
                b"<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>"
                b"<Abstract><AbstractText>The abstract.</AbstractText></Abstract>"
                b"</Article></MedlineCitation></PubmedArticle></PubmedArticleSet>"
            ),
        )
        client = AsyncMock()
        client.get.side_effect = [conversion, stub, abstract]
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )

        result = await get_fulltext("12345678", None)

        assert result == {
            "text": "The abstract.",
            "source": "abstract",
            "fulltext": False,
        }

    async def test_invalid_doi_falls_through(self, mocker):
        """Invalid DOI should not crash — falls through to abstract."""
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_europepmc_fulltext", return_value=None
        )
        mocker.patch("pipeline.pdf_retrieval.fetch_pmc_fulltext", return_value=None)
        mocker.patch(
            "pipeline.pdf_retrieval.fetch_abstract",
            return_value="Abstract",
        )
        result = await get_fulltext("12345678", "not-a-doi")
        assert result["source"] == "abstract"


# ---------------------------------------------------------------------------
# check_unpaywall
# ---------------------------------------------------------------------------


class TestCheckUnpaywall:
    async def test_no_email_returns_none(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "")
        result = await check_unpaywall("10.1234/test")
        assert result is None

    async def test_successful_oa(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "is_oa": True,
            "best_oa_location": {"url_for_pdf": "https://example.com/paper.pdf"},
        }
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )

        result = await check_unpaywall("10.1234/test")
        assert result == "https://example.com/paper.pdf"

    async def test_a_preprint_is_not_the_articles_full_text(self, mocker, caplog):
        """Unpaywall's best copy is a preprint only when nothing better exists.

        The preprint is a different document from the article of record --
        its association table is what revision changed -- so extracting it
        stored the preprint's rows under the peer-reviewed PMID and retired
        the PMID on them.
        """
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        mock_resp = MagicMock(status_code=200)
        mock_resp.json.return_value = {
            "is_oa": True,
            "doi": "10.1234/test",
            "best_oa_location": {
                "url_for_pdf": (
                    "https://www.medrxiv.org/content/10.1101/2026.01.01.12345v1"
                    ".full.pdf"
                ),
                "version": "submittedVersion",
                "host_type": "repository",
            },
        }
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )

        with caplog.at_level(logging.INFO):
            assert await check_unpaywall("10.1234/test") is None

        assert "preprint" in caplog.text

    @pytest.mark.parametrize("version", ["publishedVersion", "acceptedVersion", None])
    async def test_a_published_or_accepted_version_is_taken(self, mocker, version):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        mock_resp = MagicMock(status_code=200)
        mock_resp.json.return_value = {
            "is_oa": True,
            "best_oa_location": {
                "url_for_pdf": "https://example.com/paper.pdf",
                "version": version,
            },
        }
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )

        assert await check_unpaywall("10.1234/test") == "https://example.com/paper.pdf"

    async def test_a_location_with_no_url_at_all_is_none(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        mock_resp = MagicMock(status_code=200)
        mock_resp.json.return_value = {
            "is_oa": True,
            "best_oa_location": {"version": "publishedVersion"},
        }
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )

        assert await check_unpaywall("10.1234/test") is None

    async def test_not_oa(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {"is_oa": False}
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )

        result = await check_unpaywall("10.1234/test")
        assert result is None

    async def test_timeout(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )

        result = await check_unpaywall("10.1234/test")
        assert result is None

    async def test_not_found(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        response = MagicMock(status_code=404)
        client = AsyncMock()
        client.get.return_value = response
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )

        assert await check_unpaywall("10.1234/test") is None

    async def test_rate_limit_retries_once_and_returns_pdf(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        limited = MagicMock(status_code=429)
        success = MagicMock(status_code=200)
        success.json.return_value = {
            "is_oa": True,
            "best_oa_location": {"url": "https://example.test/landing"},
        }
        client = AsyncMock()
        client.get.side_effect = [limited, success]
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )
        sleep = mocker.patch("pipeline.pdf_retrieval.asyncio.sleep", AsyncMock())

        assert await check_unpaywall("10.1234/test") == (
            "https://example.test/landing"
        )
        sleep.assert_awaited_once_with(2.0)

    async def test_rate_limit_retry_can_still_fail(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        client = AsyncMock()
        client.get.side_effect = [
            MagicMock(status_code=429),
            MagicMock(status_code=503),
        ]
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )
        mocker.patch("pipeline.pdf_retrieval.asyncio.sleep", AsyncMock())

        assert await check_unpaywall("10.1234/test") is None

    async def test_unexpected_status_returns_none(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        client = AsyncMock()
        client.get.return_value = MagicMock(status_code=503)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )

        assert await check_unpaywall("10.1234/test") is None

    async def test_request_error_returns_none(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        client = AsyncMock()
        client.get.side_effect = httpx.RequestError("network")
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )

        assert await check_unpaywall("10.1234/test") is None

    async def test_non_json_200_body_falls_through(self, mocker):
        # A maintenance page served with a 200 is not an Unpaywall answer.
        # It has to fall through to the abstract like any other failure,
        # not escape get_fulltext and fail the paper.
        mocker.patch("pipeline.pdf_retrieval.UNPAYWALL_EMAIL", "test@test.com")
        client = AsyncMock()
        client.get.return_value = httpx.Response(
            200, text="<html><body>Down for maintenance</body></html>"
        )
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )

        assert await check_unpaywall("10.1234/test") is None


class TestXmlParsers:
    @staticmethod
    def _abstract(xml: bytes) -> str | None:
        return _extract_abstract(etree.fromstring(xml))

    def test_pmc_body_paragraphs_preserve_nested_text(self):
        xml = (
            b"<article><body><p>NOTCH3 <italic>variant</italic>.</p>"
            b"<p>  </p></body></article>"
        )

        assert _parse_pmc_xml(xml) == "NOTCH3 variant."

    def test_pmc_drops_bibliographic_citation_markers(self):
        # JATS puts a reference number in <xref ref-type="bibr"> right after
        # the word it supports. Joined verbatim, "COL4A1" + "12" reads as the
        # gene COL4A112 -- an invented symbol handed to the extraction model.
        xml = (
            b"<article><body><p>Variants in <italic>COL4A1</italic>"
            b'<xref ref-type="bibr" rid="B12">12</xref> cause disease.</p>'
            b"</body></article>"
        )

        text = _parse_pmc_xml(xml)

        assert text is not None
        assert "COL4A1 cause" in text
        assert "COL4A112" not in text

    def test_pmc_keeps_other_cross_references(self):
        # Only bibliographic markers are dropped; a figure or table xref is
        # the sentence's own text ("see Table 1").
        xml = (
            b"<article><body><p>Results are in "
            b'<xref ref-type="table" rid="T1">Table 1</xref>.</p></body></article>'
        )

        assert _parse_pmc_xml(xml) == "Results are in Table 1."

    def test_pmc_falls_back_to_sections_without_body(self):
        xml = b"<article><sec><p>Section text</p></sec></article>"

        assert _parse_pmc_xml(xml) == "Section text"

    def test_pmc_returns_none_without_nonempty_paragraphs(self):
        assert _parse_pmc_xml(b"<article><body><p> </p></body></article>") is None

    def test_abstract_returns_none_when_element_is_absent(self):
        assert self._abstract(b"<PubmedArticle />") is None

    def test_single_abstract_preserves_inline_text(self):
        xml = (
            b"<Article><Abstract><AbstractText>A <i>nested</i> result."
            b"</AbstractText></Abstract></Article>"
        )

        assert self._abstract(xml) == "A nested result."

    def test_pmc_publisher_stub_is_not_full_text(self):
        # PMC holds the article but does not license the XML: efetch answers
        # a well-formed document whose whole body is one sentence saying so.
        # Read as full text, that sentence was what the model extracted from,
        # and the PMID was retired with fulltext_available = true.
        xml = (
            b"<pmc-articleset><article><body><p>The publisher of this article "
            b"does not allow downloading of the full text in XML form.</p>"
            b"</body></article></pmc-articleset>"
        )

        assert _parse_pmc_xml(xml) is None

    def test_pmc_short_unsectioned_article_is_not_full_text(self):
        # A real article carries <front> matter and a sectioned body. One
        # with front matter, no <sec> and a few words of body is a notice,
        # whatever it says.
        xml = (
            b"<article><front><article-meta/></front>"
            b"<body><p>Full text is not available.</p></body></article>"
        )

        assert _parse_pmc_xml(xml) is None

    def test_pmc_pdf_only_notice_is_not_full_text(self):
        # A scanned back issue (PMC3053794, PMC2116354): the deposit has
        # <front>, a <sec> and a linked reference list, so neither the
        # publisher-stub regex nor the unsectioned-length guard sees it.
        # Both JATS readers returned the notice as the paper.
        xml = (
            b"<article><front><article-meta/></front><body>"
            b"<sec><title>Full Text</title><p>The Full Text of this article "
            b"is available as a PDF (10.2 MB).</p></sec>"
            b"<sec><title>Selected References</title>"
            b"<p>These references are in PubMed. This may not be the "
            b"complete list of references from this article.</p></sec>"
            b"</body></article>"
        )

        assert _parse_pmc_xml(xml) is None

    def test_pmc_sectioned_article_with_front_matter_is_kept(self):
        xml = (
            b"<article><front><article-meta/></front>"
            b"<body><sec><p>NOTCH3 variant.</p></sec></body></article>"
        )

        assert _parse_pmc_xml(xml) == "NOTCH3 variant."

    def test_pmc_nested_paragraphs_are_emitted_once(self):
        # `.//body//p` matches the outer paragraph and the one nested in its
        # list item; itertext() on the outer already carries the inner.
        xml = (
            b"<article><body><p>Findings:<list><list-item>"
            b"<p>NOTCH3 was associated (p=1e-9).</p>"
            b"</list-item></list></p></body></article>"
        )

        text = _parse_pmc_xml(xml)

        assert text is not None
        assert text.count("NOTCH3 was associated (p=1e-9).") == 1

    def test_abstract_ignores_other_abstract_sections(self):
        # <OtherAbstract> holds a publisher's translation or a plain-language
        # summary; `.//AbstractText` matched its sections too.
        xml = (
            b"<PubmedArticle><Article><Abstract>"
            b"<AbstractText>Main finding.</AbstractText></Abstract>"
            b'<OtherAbstract Type="Publisher" Language="chi">'
            b"<AbstractText>Other text.</AbstractText></OtherAbstract>"
            b"</Article></PubmedArticle>"
        )

        assert self._abstract(xml) == "Main finding."

    def test_single_abstract_is_stripped(self):
        xml = (
            b"<Article><Abstract><AbstractText>  Padded.  </AbstractText>"
            b"</Abstract></Article>"
        )

        assert self._abstract(xml) == "Padded."

    def test_single_whitespace_abstract_is_none(self):
        xml = (
            b"<Article><Abstract><AbstractText>   </AbstractText>"
            b"</Abstract></Article>"
        )

        assert self._abstract(xml) is None


class _StreamResponse:
    def __init__(
        self,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        chunks: tuple[bytes, ...] = (),
    ) -> None:
        self.status_code = status_code
        self.headers = headers or {}
        self._chunks = chunks

    async def aiter_bytes(self, _chunk_size: int) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            yield chunk


def _stream_response(
    status_code: int = 200,
    headers: dict[str, str] | None = None,
    chunks: tuple[bytes, ...] = (),
) -> httpx.Response:
    return cast(httpx.Response, _StreamResponse(status_code, headers, chunks))


class TestReadPdfBytes:
    async def test_non_success_status_is_rejected(self):
        response = _stream_response(status_code=404)

        assert await _read_pdf_bytes(response, "https://example.test/p.pdf") is None

    async def test_declared_oversize_pdf_is_rejected(self):
        response = _stream_response(
            headers={"content-length": str(MAX_PDF_BYTES + 1), "content-type": "pdf"}
        )

        assert await _read_pdf_bytes(response, "https://example.test/p.pdf") is None

    async def test_pdf_bytes_are_accepted_whatever_the_content_type_says(self):
        # A repository that labels its PDF text/html still served a PDF; the
        # magic bytes are the fact, the header is the claim.
        response = _stream_response(
            headers={"content-type": "text/html"}, chunks=(b"%PDF-data",)
        )

        assert await _read_pdf_bytes(response, "https://example.test/landing") == (
            b"%PDF-data"
        )

    async def test_octet_stream_pdf_behind_a_query_string_is_accepted(self):
        # `url.endswith(".pdf")` failed on `download.pdf?token=1`, so an
        # application/octet-stream PDF was refused before a byte was read.
        response = _stream_response(
            headers={"content-type": "application/octet-stream"},
            chunks=(b"%PDF-1.7 data",),
        )

        assert await _read_pdf_bytes(
            response, "https://example.test/download.pdf?token=1"
        ) == b"%PDF-1.7 data"

    async def test_an_empty_body_is_rejected(self):
        response = _stream_response(headers={"content-type": "application/pdf"})

        assert await _read_pdf_bytes(response, "https://example.test/p.pdf") is None

    async def test_html_landing_page_is_rejected_on_its_first_chunk(self):
        response = _stream_response(
            headers={"content-type": "text/html"},
            chunks=(b"<html><body>", b"landing page</body></html>"),
        )

        assert await _read_pdf_bytes(response, "https://example.test/landing") is None

    async def test_pdf_suffix_allows_missing_content_type(self):
        response = _stream_response(headers={}, chunks=(b"%PDF-data",))

        assert await _read_pdf_bytes(response, "https://example.test/p.pdf") == (
            b"%PDF-data"
        )

    async def test_non_numeric_content_length_uses_stream_guard(self):
        response = _stream_response(
            headers={"content-length": "unknown", "content-type": "application/pdf"},
            chunks=(b"%PDF-", b"data"),
        )

        assert await _read_pdf_bytes(response, "https://example.test/p") == b"%PDF-data"

    async def test_stream_that_exceeds_limit_is_rejected(self, monkeypatch):
        monkeypatch.setattr("pipeline.pdf_retrieval.MAX_PDF_BYTES", 5)
        response = _stream_response(
            headers={"content-type": "application/pdf"}, chunks=(b"%PDF-", b"x")
        )

        assert await _read_pdf_bytes(response, "https://example.test/p") is None

    async def test_false_pdf_magic_is_rejected(self):
        response = _stream_response(
            headers={"content-type": "application/pdf"}, chunks=(b"not a pdf",)
        )

        assert await _read_pdf_bytes(response, "https://example.test/p") is None


class TestPmcFulltext:
    @staticmethod
    def _client(mocker, *responses):
        client = AsyncMock()
        client.get.side_effect = list(responses)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )
        return client

    async def test_conversion_http_failure(self, mocker):
        self._client(mocker, MagicMock(status_code=503))

        assert await fetch_pmc_fulltext("123") is None

    @pytest.mark.parametrize("records", [[], [{}]])
    async def test_conversion_without_pmcid(self, mocker, records):
        response = MagicMock(status_code=200)
        response.json.return_value = {"records": records}
        self._client(mocker, response)

        assert await fetch_pmc_fulltext("123") is None

    async def test_pmc_http_failure(self, mocker):
        conversion = MagicMock(status_code=200)
        conversion.json.return_value = {"records": [{"pmcid": "PMC123"}]}
        self._client(mocker, conversion, MagicMock(status_code=404))

        assert await fetch_pmc_fulltext("123") is None

    async def test_success(self, mocker):
        conversion = MagicMock(status_code=200)
        conversion.json.return_value = {"records": [{"pmcid": "PMC123"}]}
        fulltext = MagicMock(
            status_code=200,
            content=b"<article><body><p>Gene result</p></body></article>",
        )
        client = self._client(mocker, conversion, fulltext)

        assert await fetch_pmc_fulltext("123") == "Gene result"
        assert client.get.await_count == 2

    async def test_conversion_omits_the_email_when_none_is_configured(self, mocker):
        mocker.patch("pipeline.pdf_retrieval.ENTREZ_EMAIL", "")
        conversion = MagicMock(status_code=200)
        conversion.json.return_value = {"records": []}
        client = self._client(mocker, conversion)

        await fetch_pmc_fulltext("123")

        assert "email" not in client.get.await_args_list[0].kwargs["params"]

    async def test_pmc_transport_failure_returns_none(self, mocker):
        conversion = MagicMock(status_code=200)
        conversion.json.return_value = {"records": [{"pmcid": "PMC123"}]}
        self._client(mocker, conversion, httpx.ReadTimeout("slow"))
        mocker.patch("pipeline.ncbi_http.throttle", new=AsyncMock())

        assert await fetch_pmc_fulltext("123") is None

    async def test_conversion_asks_the_current_id_converter(self, mocker):
        # The www.ncbi.nlm.nih.gov/pmc/utils/idconv URL is retired: it 301s
        # to pmc.ncbi.nlm.nih.gov, and the redirected hop was being recorded
        # under an unregistered host. The new endpoint also asks for `tool`
        # and `email`, and answers with a warnings array when they are
        # missing.
        mocker.patch("pipeline.pdf_retrieval.ENTREZ_EMAIL", "curator@example.org")
        conversion = MagicMock(status_code=200)
        conversion.json.return_value = {"records": []}
        client = self._client(mocker, conversion)

        await fetch_pmc_fulltext("123")

        url = client.get.await_args_list[0].args[0]
        params = client.get.await_args_list[0].kwargs["params"]
        assert url == "https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/"
        assert params["ids"] == "123"
        assert params["format"] == "json"
        assert params["tool"] == "csvd-dashboard"
        assert params["email"] == "curator@example.org"

    @pytest.mark.parametrize(
        "error",
        [
            httpx.TimeoutException("timeout"),
            httpx.RequestError("network"),
        ],
    )
    async def test_network_errors_return_none(self, mocker, error):
        client = AsyncMock()
        client.get.side_effect = error
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )

        assert await fetch_pmc_fulltext("123") is None

    async def test_invalid_xml_returns_none(self, mocker):
        conversion = MagicMock(status_code=200)
        conversion.json.return_value = {"records": [{"pmcid": "PMC123"}]}
        fulltext = MagicMock(status_code=200, content=b"<broken")
        self._client(mocker, conversion, fulltext)

        assert await fetch_pmc_fulltext("123") is None

    async def test_non_json_conversion_body_returns_none(self, mocker):
        # The ID converter answering a 200 with HTML is a failure of this
        # source, not of the paper: fall through to the next one.
        self._client(
            mocker,
            httpx.Response(200, text="<html><body>Down for maintenance</body></html>"),
        )

        assert await fetch_pmc_fulltext("123") is None


# ---------------------------------------------------------------------------
# PMID/DOI regex patterns
# ---------------------------------------------------------------------------


class TestPatterns:
    def test_pmid_pattern_valid(self):
        assert PMID_PATTERN.match("12345678")
        assert PMID_PATTERN.match("123456789")
        assert PMID_PATTERN.match("1")

    def test_pmid_pattern_invalid(self):
        assert not PMID_PATTERN.match("1234567890")  # 10 digits
        assert not PMID_PATTERN.match("abc")
        assert not PMID_PATTERN.match("")

    def test_doi_pattern_valid(self):
        assert DOI_PATTERN.match("10.1234/test")
        assert DOI_PATTERN.match("10.12345/test.v1")

    def test_doi_pattern_invalid(self):
        assert not DOI_PATTERN.match("not-a-doi")
        assert not DOI_PATTERN.match("")


# ---------------------------------------------------------------------------
# Back-matter truncation
#
# Docling (pipeline.pdf_parse) replaced PyMuPDF as the extraction engine, so
# the old margin-based header/footer filtering and block-type skipping this
# class used to pin (y-coordinate heuristics, PyMuPDF block tuples) no
# longer exist anywhere in this codebase — that layout cleanup is now
# Docling's own responsibility, internal to its model pipeline, and isn't a
# seam this test suite can exercise without constructing a real
# DocumentConverter (a ~15s one-time model-loading cost unfit for this
# suite). What *did* survive the swap verbatim is _BACK_MATTER_PATTERN and
# the truncation it drives — the load-bearing rule that keeps bibliography
# gene mentions out of the LLM's input — so that is what stays under test,
# repointed at its new home, _truncate_back_matter.
# ---------------------------------------------------------------------------


class TestTruncateBackMatter:
    def test_truncation_at_references(self):
        from pipeline.pdf_retrieval import _truncate_back_matter

        result = _truncate_back_matter(_HTML_WITH_BACK_MATTER)

        assert "HTRA1" in result
        # A recognised heading is tag-bounded ("<h2>References</h2>"), never
        # newline-bounded plain text — Docling never emits the latter.
        # HTRA2 only appears in the reference list, so this also confirms
        # the bibliography gene is the thing actually being cut.
        assert "References" not in result
        assert "HTRA2" not in result

    def test_no_back_matter_header_returns_text_unchanged(self):
        from pipeline.pdf_retrieval import _truncate_back_matter

        text = "<p>This is the main body of the paper with no back matter at all.</p>"
        assert _truncate_back_matter(text) == text

    def test_early_mention_is_not_truncated(self):
        """A paper mentioning "Methods" in its abstract must not be cut

        there — only a match past the document's midpoint counts.
        """
        from pipeline.pdf_retrieval import _truncate_back_matter

        assert _truncate_back_matter(_HTML_WITH_EARLY_METHODS_MENTION) == (
            _HTML_WITH_EARLY_METHODS_MENTION
        )

    @pytest.mark.parametrize(
        "heading",
        [
            "<h2>References</h2>",
            "<h2>5. References</h2>",
            "<h2>5.2 References</h2>",
            "<h1>REFERENCES AND NOTES</h1>",
            "<h2>Literature Cited</h2>",
            "<h2>Works Cited</h2>",
            "<h2>Reference List</h2>",
            "<h2>References:</h2>",
            "<h3>Bibliography</h3>",
            "<p>References</p>",
            "<p>6. Bibliography</p>",
            "<h2>Acknowledgments</h2>",
        ],
    )
    def test_numbered_and_variant_bibliography_headings_are_cut(self, heading):
        """A journal's own section numbering left the bibliography in.

        Only a bare six-word heading matched, so "5. References" and
        "Literature Cited" fed 80 citation titles to the model — cited genes
        this paper never studied, with a source_quote that really is in the
        document, so the quote check passes.
        """
        from pipeline.pdf_retrieval import _truncate_back_matter

        text = (
            "<p>Filler sentence describing cohort recruitment.</p>\n" * 20
            + f"{heading}\n"
            + "<p>1. Smith J et al. HTRA2 in disease. 2020.</p>"
        )

        assert "HTRA2" not in _truncate_back_matter(text)

    @pytest.mark.parametrize(
        "line",
        [
            # A sentence that merely begins with the word is not a heading.
            "<p>References to the discovery cohort are listed in HTRA2.</p>",
            # Restricted to the bibliography words: a stray body paragraph
            # naming a section must not cut the results away.
            "<p>Methods</p>",
            "<h2>Results</h2>",
        ],
    )
    def test_body_text_that_only_resembles_a_heading_is_kept(self, line):
        from pipeline.pdf_retrieval import _truncate_back_matter

        text = (
            "<p>Filler sentence describing cohort recruitment.</p>\n" * 20
            + f"{line}\n"
            + "<p>Genetic variants in HTRA2 were associated with WMH.</p>"
        )

        assert "HTRA2" in _truncate_back_matter(text)


# ---------------------------------------------------------------------------
# Back-matter truncation wiring — both PDF entry points must apply it, not
# just _truncate_back_matter in isolation.
#
# These fixtures reproduce the *actual* shape pipeline.pdf_parse hands to
# _truncate_back_matter: Docling's HTMLDocSerializer renders a recognised
# heading as a bare f"<h{level}>{text}</h{level}>" — no attributes — and
# joins block elements with "\n" (docling_core.types.doc.utils
# .get_html_tag_with_text_direction; docling-core 2.92.0). Confirmed by
# building a real DoclingDocument and calling .export_to_html() on it:
#
#     doc = DoclingDocument(name="paper")
#     doc.add_text(label="text", text="...")
#     doc.add_heading(text="References", level=1)
#     doc.add_text(label="text", text="...")
#     doc.export_to_html()
#
# produced, verbatim, "<p>...</p>\n<h2>References</h2>\n<p>...</p>". The
# repeated filler line below is byte-identical to 20/40 real "<p>...</p>"
# lines from that call; only the boilerplate <!DOCTYPE>/<head>/<style>/
# <div class='page'> wrapper around them was trimmed for readability — the
# regex matches by substring search and does not see that wrapper either
# way, and the wrapping-included form was checked too (see the round-2 fix
# report for that transcript).
# ---------------------------------------------------------------------------

_HTML_WITH_BACK_MATTER = (
    "<p>Filler sentence describing cohort recruitment and methodology.</p>\n"
    * 20
    + "<p>Genetic variants in HTRA1 were significantly associated with WMH "
    "burden.</p>\n"
    + "<h2>References</h2>\n"
    + "<p>1. Smith J et al. HTRA2 in disease. 2020.</p>"
)

_HTML_WITH_EARLY_METHODS_MENTION = (
    "<h2>Methods</h2>\n"
    "<p>We describe our genotyping approach for NOTCH3.</p>\n"
    + "<p>Filler sentence padding the document well past the midpoint.</p>\n"
    * 40
)


class TestParseLocalPdf:
    def test_truncates_back_matter(self, tmp_path, mocker):
        from pipeline.pdf_retrieval import parse_local_pdf

        pdf_path = tmp_path / "paper.pdf"
        pdf_path.write_bytes(b"%PDF-1.7 fake")
        mocker.patch(
            "pipeline.pdf_retrieval.parse_pdf_file",
            return_value=_HTML_WITH_BACK_MATTER,
        )

        result = parse_local_pdf(pdf_path)

        assert result is not None
        assert "HTRA1" in result
        assert "References" not in result
        assert "HTRA2" not in result

    def test_missing_file_raises(self, tmp_path):
        from pipeline.pdf_retrieval import parse_local_pdf

        with pytest.raises(FileNotFoundError):
            parse_local_pdf(tmp_path / "missing.pdf")

    def test_none_from_parser_propagates(self, tmp_path, mocker):
        """A corrupt/empty PDF must not crash the run — it returns None."""
        from pipeline.pdf_retrieval import parse_local_pdf

        pdf_path = tmp_path / "paper.pdf"
        pdf_path.write_bytes(b"%PDF-1.7 fake")
        mocker.patch("pipeline.pdf_retrieval.parse_pdf_file", return_value=None)

        assert parse_local_pdf(pdf_path) is None


class TestDownloadAndParsePdf:
    async def test_truncates_back_matter(self, mocker):
        from pipeline.pdf_retrieval import download_and_parse_pdf

        mock_stream_cm = MagicMock()
        mock_stream_cm.__aenter__ = AsyncMock(return_value=MagicMock())
        mock_stream_cm.__aexit__ = AsyncMock(return_value=False)
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=mock_stream_cm)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )
        mocker.patch(
            "pipeline.pdf_retrieval._read_pdf_bytes",
            return_value=b"%PDF-1.7 fake",
        )
        mocker.patch(
            "pipeline.pdf_retrieval.parse_pdf_bytes",
            return_value=_HTML_WITH_BACK_MATTER,
        )

        result = await download_and_parse_pdf("https://example.com/paper.pdf")

        assert result is not None
        assert "HTRA1" in result
        assert "References" not in result
        assert "HTRA2" not in result

    async def test_none_from_parser_propagates(self, mocker):
        """A corrupt/empty PDF must not crash the run — it returns None."""
        from pipeline.pdf_retrieval import download_and_parse_pdf

        mock_stream_cm = MagicMock()
        mock_stream_cm.__aenter__ = AsyncMock(return_value=MagicMock())
        mock_stream_cm.__aexit__ = AsyncMock(return_value=False)
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=mock_stream_cm)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )
        mocker.patch(
            "pipeline.pdf_retrieval._read_pdf_bytes",
            return_value=b"%PDF-1.7 fake",
        )
        mocker.patch("pipeline.pdf_retrieval.parse_pdf_bytes", return_value=None)

        result = await download_and_parse_pdf("https://example.com/paper.pdf")

        assert result is None

    async def test_a_broken_docling_install_is_not_swallowed(self, mocker):
        """parse_pdf_bytes re-raises ImportError; the caller must not eat it.

        Caught here it degraded every Unpaywall paper in the run to its
        abstract with one warning apiece -- each PMID retired in
        pubmed_refs with source="abstract" and never re-fetched, under a
        `completed` run report whose low fulltextRetrieved reads like an
        ordinary short window.
        """
        from pipeline.pdf_retrieval import download_and_parse_pdf

        mock_stream_cm = MagicMock()
        mock_stream_cm.__aenter__ = AsyncMock(return_value=MagicMock())
        mock_stream_cm.__aexit__ = AsyncMock(return_value=False)
        mock_client = AsyncMock()
        mock_client.stream = MagicMock(return_value=mock_stream_cm)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )
        mocker.patch(
            "pipeline.pdf_retrieval._read_pdf_bytes",
            return_value=b"%PDF-1.7 fake",
        )
        mocker.patch(
            "pipeline.pdf_retrieval.parse_pdf_bytes",
            side_effect=ModuleNotFoundError("No module named 'docling'"),
        )

        with pytest.raises(ModuleNotFoundError, match="docling"):
            await download_and_parse_pdf("https://example.com/paper.pdf")

    async def test_parser_runs_off_the_event_loop_thread(self, mocker):
        # Docling is a 5-120 s CPU-bound call. Run inline it freezes the loop
        # for every other in-flight paper; main.py already hands local PDFs
        # to a worker thread, and the downloaded path has to do the same.
        mock_stream_cm = MagicMock()
        mock_stream_cm.__aenter__ = AsyncMock(return_value=MagicMock())
        mock_stream_cm.__aexit__ = AsyncMock(return_value=False)
        client = MagicMock()
        client.stream.return_value = mock_stream_cm
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )
        mocker.patch(
            "pipeline.pdf_retrieval._read_pdf_bytes", return_value=b"%PDF-1.7 fake"
        )
        parser_thread: list[int] = []

        def record_thread(_pdf_bytes: bytes) -> str:
            parser_thread.append(threading.get_ident())
            return "<p>Body text</p>"

        mocker.patch("pipeline.pdf_retrieval.parse_pdf_bytes", record_thread)

        assert await download_and_parse_pdf("https://example.test/p.pdf") == (
            "<p>Body text</p>"
        )
        assert parser_thread == [ANY]
        assert parser_thread[0] != threading.get_ident()

    async def test_rejected_download_returns_none_before_parser(self, mocker):
        mock_stream_cm = MagicMock()
        mock_stream_cm.__aenter__ = AsyncMock(return_value=MagicMock())
        mock_stream_cm.__aexit__ = AsyncMock(return_value=False)
        client = MagicMock()
        client.stream.return_value = mock_stream_cm
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )
        mocker.patch("pipeline.pdf_retrieval._read_pdf_bytes", return_value=None)
        parser = mocker.patch("pipeline.pdf_retrieval.parse_pdf_bytes")

        assert await download_and_parse_pdf("https://example.test/p.pdf") is None
        parser.assert_not_called()

    @pytest.mark.parametrize(
        "error",
        [
            httpx.TimeoutException("timeout"),
            httpx.RequestError("network"),
            RuntimeError("parser exploded"),
        ],
    )
    async def test_errors_return_none(self, mocker, error):
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", side_effect=error
        )

        assert await download_and_parse_pdf("https://example.test/p.pdf") is None


async def test_close_http_client(mocker):
    close = mocker.patch("pipeline.pdf_retrieval._client_manager.close", AsyncMock())

    await close_http_client()

    close.assert_awaited_once_with()


# ---------------------------------------------------------------------------
# fetch_abstract structured-section handling
# ---------------------------------------------------------------------------


def _abstract_response(xml: bytes) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.content = xml
    return resp


class TestFetchAbstractStructured:
    """Guard the skip-empty-section behaviour in pdf_retrieval.fetch_abstract.

    A structured abstract with a labelled-but-empty section would otherwise
    emit "Label: " lines that eat LLM context budget without adding content.
    """

    async def test_parses_the_response_once(self, mocker):
        xml = (
            b"<PubmedArticleSet><Abstract><AbstractText>Text.</AbstractText>"
            b"</Abstract></PubmedArticleSet>"
        )
        client = AsyncMock()
        client.get.return_value = _abstract_response(xml)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )
        parse_xml = etree.fromstring
        parser = mocker.patch(
            "pipeline.pdf_retrieval.etree.fromstring", side_effect=parse_xml
        )

        assert await fetch_abstract("12345678") == "Text."
        parser.assert_called_once()

    async def test_skips_labeled_empty_section(self, mocker):
        xml = (
            b"<?xml version='1.0'?>"
            b"<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>"
            b"<Abstract>"
            b'<AbstractText Label="BACKGROUND">Real background text.</AbstractText>'
            b'<AbstractText Label="METHODS">   </AbstractText>'
            b'<AbstractText Label="RESULTS">Significant results here.</AbstractText>'
            b"</Abstract>"
            b"</Article></MedlineCitation></PubmedArticle></PubmedArticleSet>"
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_abstract_response(xml))
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )
        result = await fetch_abstract("12345678")
        assert result is not None
        assert "BACKGROUND: Real background text." in result
        assert "RESULTS: Significant results here." in result
        # The whitespace-only METHODS section must not leak through.
        assert "METHODS:" not in result
        assert "METHODS: " not in result

    async def test_returns_none_when_all_sections_empty(self, mocker):
        xml = (
            b"<?xml version='1.0'?>"
            b"<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>"
            b"<Abstract>"
            b'<AbstractText Label="BACKGROUND">   </AbstractText>'
            b'<AbstractText Label="METHODS"></AbstractText>'
            b"</Abstract>"
            b"</Article></MedlineCitation></PubmedArticle></PubmedArticleSet>"
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_abstract_response(xml))
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get",
            return_value=mock_client,
        )
        assert await fetch_abstract("12345678") is None

    async def test_http_failure_raises_retrieval_error(self, mocker):
        # A 503 says nothing about whether PubMed holds an abstract. Returning
        # None here would let process_paper record the PMID as "no text" and
        # never look again, so the failure has to surface as an error.
        client = AsyncMock()
        client.get.return_value = MagicMock(status_code=503)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )

        with pytest.raises(RetrievalError, match="503"):
            await fetch_abstract("12345678")

    @pytest.mark.parametrize(
        "error",
        [
            httpx.TimeoutException("timeout"),
            httpx.RequestError("network"),
        ],
    )
    async def test_network_errors_raise_retrieval_error(self, mocker, error):
        client = AsyncMock()
        client.get.side_effect = error
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )

        with pytest.raises(RetrievalError):
            await fetch_abstract("12345678")

    @pytest.mark.parametrize(
        "body",
        [
            b"<broken",
            b"<html><body>Down for maintenance</body></html>",
            b"<eFetchResult><ERROR>Empty id list - nothing todo</ERROR></eFetchResult>",
        ],
        ids=["malformed", "html-maintenance-page", "efetch-error"],
    )
    async def test_a_200_that_is_not_a_pubmed_document_raises(self, mocker, body):
        # NCBI's maintenance page and its in-band errors both arrive as a
        # 200. Neither says whether PubMed holds an abstract, so a None here
        # would retire the PMID as "no text" for good, exactly what
        # RetrievalError exists to prevent.
        client = AsyncMock()
        client.get.return_value = MagicMock(status_code=200, content=body)
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )

        with pytest.raises(RetrievalError):
            await fetch_abstract("12345678")

    async def test_an_empty_pubmed_document_is_pubmeds_final_answer(self, mocker):
        client = AsyncMock()
        client.get.return_value = MagicMock(
            status_code=200, content=b"<PubmedArticleSet/>"
        )
        mocker.patch(
            "pipeline.pdf_retrieval._client_manager.get", return_value=client
        )

        assert await fetch_abstract("12345678") is None


class TestCitationMarkerRemoval:
    @pytest.mark.parametrize(
        ("xml", "expected"),
        [
            # The marker leads the paragraph: its tail joins the parent's text.
            (b"<p><xref ref-type='bibr'>1</xref> later text</p>", " later text"),
            # No tail at all: nothing to reattach.
            (b"<p>text<xref ref-type='bibr'>1</xref></p>", "text"),
        ],
    )
    def test_tails_are_kept_wherever_the_marker_sat(self, xml, expected):
        paragraph = etree.fromstring(xml)
        _drop_citation_markers(paragraph)
        assert "".join(cast(list[str], list(paragraph.itertext()))) == expected
