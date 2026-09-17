"""Tests for pipeline.pubmed_citations — PubMed citation fetching and formatting."""

from unittest.mock import AsyncMock

import httpx
import pytest

from pipeline.config import PipelineConfig
from pipeline.pubmed_citations import (
    PubMedCitation,
    SyncResult,
    _fetch_pubmed_uncached,
    _format_authors,
    _format_citation,
    _parse_pubmed_xml,
    _title_case,
    clear_pubmed_cache,
    close_pubmed_client,
    extract_pmids_from_text,
    fetch_pubmed_citation,
    fetch_pubmed_citations_batch,
    sync_pubmed_citations,
)

# ---------------------------------------------------------------------------
# extract_pmids_from_text
# ---------------------------------------------------------------------------


class TestExtractPmidsFromText:
    def test_empty_returns_empty(self):
        assert extract_pmids_from_text("") == []

    def test_none_returns_empty(self):
        assert extract_pmids_from_text(None) == []

    def test_single_8_digit(self):
        assert extract_pmids_from_text("12345678") == ["12345678"]

    def test_single_7_digit(self):
        assert extract_pmids_from_text("1234567") == ["1234567"]

    def test_multiple_comma_separated(self):
        result = extract_pmids_from_text("12345678, 23456789, 34567890")
        assert result == ["12345678", "23456789", "34567890"]

    def test_deduplicates(self):
        result = extract_pmids_from_text("12345678, 12345678, 23456789")
        assert result == ["12345678", "23456789"]

    def test_preserves_order(self):
        result = extract_pmids_from_text("99999999, 11111111, 55555555")
        assert result == ["99999999", "11111111", "55555555"]

    def test_pmid_prefix_format(self):
        result = extract_pmids_from_text("PMID: 12345678")
        assert result == ["12345678"]

    def test_ignores_6_digit(self):
        assert extract_pmids_from_text("123456") == []

    def test_accepts_9_digit(self):
        # 9-digit PMIDs are valid (config.PMID_PATTERN allows 1-9 digits)
        assert extract_pmids_from_text("123456789") == ["123456789"]

    def test_ignores_10_digit(self):
        assert extract_pmids_from_text("1234567890") == []


# ---------------------------------------------------------------------------
# _format_authors
# ---------------------------------------------------------------------------


class TestFormatAuthors:
    def test_empty_list(self):
        assert _format_authors([]) == ""

    def test_single_author(self):
        assert _format_authors(["Smith J"]) == "Smith J"

    def test_three_authors(self):
        result = _format_authors(["Smith J", "Doe A", "Lee B"])
        assert result == "Smith J, Doe A, Lee B"

    def test_four_or_more_authors(self):
        authors = ["Smith J", "Doe A", "Lee B", "Kim C"]
        result = _format_authors(authors)
        assert result == "Smith J, Doe A, Lee B, et al."

    def test_custom_max(self):
        authors = ["A", "B", "C"]
        result = _format_authors(authors, max_authors=2)
        assert result == "A, B, et al."


# ---------------------------------------------------------------------------
# _title_case
# ---------------------------------------------------------------------------


class TestTitleCase:
    def test_empty_string(self):
        assert _title_case("") == ""

    def test_capitalizes_first_word(self):
        result = _title_case("a study of genes")
        assert result[0] == "A"

    def test_preserves_rest(self):
        result = _title_case("a study")
        assert result == "A study"

    @pytest.mark.parametrize(
        ("title", "expected"),
        [
            ("ICA1L variants in SVD", "ICA1L variants in SVD"),
            ("CADASIL. A review", "CADASIL. A review"),
            ("GWAS of white matter", "GWAS of white matter"),
        ],
    )
    def test_keeps_the_rest_of_the_first_word(self, title, expected):
        # str.capitalize() lowercases everything after the first letter, so
        # a gene symbol or acronym leading the title was published as
        # "Ica1l" and "Cadasil." (committed refs.json carried both).
        assert _title_case(title) == expected


# ---------------------------------------------------------------------------
# _format_citation
# ---------------------------------------------------------------------------


class TestFormatCitation:
    def test_all_fields_present(self):
        result = _format_citation("Smith J", "A study", "Nature", "2024", "10.1/x")
        assert "<b>Smith J</b>" in result
        assert "<i>" in result
        assert "Nature (2024)" in result
        assert "DOI: 10.1/x" in result

    def test_missing_fields(self):
        result = _format_citation(None, "A study", None, None, None)
        assert "<b>" not in result
        assert "<i>" in result

    def test_only_authors(self):
        result = _format_citation("Smith J", None, None, None, None)
        assert result == "<b>Smith J</b>"

    def test_journal_without_date(self):
        result = _format_citation(None, None, "Nature", None, None)
        assert result == "Nature"

    def test_journal_with_date(self):
        result = _format_citation(None, None, "Nature", "2024", None)
        assert "Nature (2024)" in result

    def test_text_fields_are_html_escaped(self):
        # formatted_ref is published as HTML in refs.json, so a title
        # written "A<40" or an author "Smith & Jones" must reach the page
        # as text, not as a half-open tag or a bare entity.
        result = _format_citation(
            "Smith & Jones", "Levels <40 & rising", "J <i>Rare</i>", "2024", None
        )

        assert "<b>Smith &amp; Jones</b>" in result
        assert "<i>Levels &lt;40 &amp; rising</i>" in result
        assert "J &lt;i&gt;Rare&lt;/i&gt; (2024)" in result


# ---------------------------------------------------------------------------
# _parse_pubmed_xml
# ---------------------------------------------------------------------------

_FULL_ARTICLE_XML = b"""<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <Article>
        <ArticleTitle>Gene discovery in SVD</ArticleTitle>
        <Journal>
          <Title>Nature Genetics</Title>
        </Journal>
        <AuthorList>
          <Author><LastName>Smith</LastName><Initials>J</Initials></Author>
          <Author><LastName>Doe</LastName><Initials>A</Initials></Author>
        </AuthorList>
      </Article>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="doi">10.1038/test</ArticleId>
        <ArticleId IdType="pubmed">12345678</ArticleId>
      </ArticleIdList>
      <History>
        <PubMedPubDate PubStatus="pubmed">
          <Year>2024</Year><Month>Jan</Month>
        </PubMedPubDate>
      </History>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>"""


class TestParsePubmedXml:
    def test_full_article(self):
        result = _parse_pubmed_xml("12345678", _FULL_ARTICLE_XML)
        assert result is not None
        assert result.pmid == "12345678"
        assert result.title == "Gene discovery in SVD"
        assert result.journal == "Nature Genetics"
        assert result.doi == "10.1038/test"
        assert result.authors is not None
        assert "Smith" in result.authors

    def test_no_pubmed_article(self):
        xml = b"<PubmedArticleSet></PubmedArticleSet>"
        result = _parse_pubmed_xml("99999999", xml)
        assert result is not None
        assert result.title is None
        assert "citation not available" in result.formatted_ref

    def test_no_authors(self):
        xml = b"""<?xml version="1.0"?>
        <PubmedArticleSet>
          <PubmedArticle>
            <MedlineCitation>
              <Article>
                <ArticleTitle>Test</ArticleTitle>
                <Journal><Title>J Test</Title></Journal>
              </Article>
            </MedlineCitation>
            <PubmedData><ArticleIdList></ArticleIdList></PubmedData>
          </PubmedArticle>
        </PubmedArticleSet>"""
        result = _parse_pubmed_xml("11111111", xml)
        assert result is not None
        assert result.authors is None

    def test_no_doi(self):
        xml = b"""<?xml version="1.0"?>
        <PubmedArticleSet>
          <PubmedArticle>
            <MedlineCitation>
              <Article>
                <ArticleTitle>No DOI study</ArticleTitle>
                <Journal><Title>Some Journal</Title></Journal>
              </Article>
            </MedlineCitation>
            <PubmedData><ArticleIdList></ArticleIdList></PubmedData>
          </PubmedArticle>
        </PubmedArticleSet>"""
        result = _parse_pubmed_xml("22222222", xml)
        assert result is not None
        assert result.doi is None

    def test_xml_syntax_error(self):
        result = _parse_pubmed_xml("33333333", b"<not valid xml")
        assert result is None

    def test_a_cited_references_doi_is_not_the_articles(self):
        # PubmedData carries the article's own ArticleIdList, followed by a
        # ReferenceList whose entries use the same <ArticleId IdType="doi">.
        # `.//ArticleId` read the first DOI anywhere, so a record without
        # one of its own was published (and handed to Unpaywall) under a
        # paper it cites.
        xml = b"""<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>
        <ArticleTitle>No DOI</ArticleTitle><Journal><Title>J</Title></Journal>
        </Article></MedlineCitation>
        <PubmedData>
          <ArticleIdList><ArticleId IdType="pubmed">1</ArticleId></ArticleIdList>
          <ReferenceList><Reference><ArticleIdList>
            <ArticleId IdType="doi">10.9999/other-paper</ArticleId>
          </ArticleIdList></Reference></ReferenceList>
        </PubmedData></PubmedArticle></PubmedArticleSet>"""

        result = _parse_pubmed_xml("1", xml)

        assert result is not None
        assert result.doi is None
        assert "10.9999" not in result.formatted_ref

    def test_the_articles_own_doi_wins_over_a_references(self):
        xml = b"""<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>
        <ArticleTitle>T</ArticleTitle></Article></MedlineCitation>
        <PubmedData>
          <ArticleIdList><ArticleId IdType="doi">10.1000/own</ArticleId></ArticleIdList>
          <ReferenceList><Reference><ArticleIdList>
            <ArticleId IdType="doi">10.9999/other-paper</ArticleId>
          </ArticleIdList></Reference></ReferenceList>
        </PubmedData></PubmedArticle></PubmedArticleSet>"""

        result = _parse_pubmed_xml("1", xml)

        assert result is not None
        assert result.doi == "10.1000/own"

    def test_elocation_doi_is_the_fallback(self):
        # Some records carry the DOI only as an ELocationID on the article.
        xml = b"""<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>
        <ArticleTitle>T</ArticleTitle>
        <ELocationID EIdType="doi">10.1000/eloc</ELocationID>
        </Article></MedlineCitation>
        <PubmedData><ArticleIdList/></PubmedData></PubmedArticle></PubmedArticleSet>"""

        result = _parse_pubmed_xml("1", xml)

        assert result is not None
        assert result.doi == "10.1000/eloc"

    def test_a_book_chapters_doi_comes_from_its_own_id_list(self):
        xml = b"""<PubmedArticleSet><PubmedBookArticle><BookDocument>
        <ArticleIdList>
          <ArticleId IdType="doi">10.1000/chapter</ArticleId>
        </ArticleIdList>
        <Book><BookTitle>GeneReviews</BookTitle></Book>
        <ArticleTitle>CADASIL</ArticleTitle>
        </BookDocument></PubmedBookArticle></PubmedArticleSet>"""

        result = _parse_pubmed_xml("1", xml)

        assert result is not None
        assert result.doi == "10.1000/chapter"

    def test_medline_date_stands_in_for_a_missing_year(self):
        # Ranges and irregular issues carry <MedlineDate>2019 Nov-Dec</MedlineDate>
        # in place of Year/Month; the citation published with no date at all.
        xml = b"""<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>
        <Journal><Title>J Neurol Sci</Title><JournalIssue><PubDate>
          <MedlineDate>2019 Nov-Dec</MedlineDate>
        </PubDate></JournalIssue></Journal>
        </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>"""

        result = _parse_pubmed_xml("1", xml)

        assert result is not None
        assert result.publication_date == "2019 Nov-Dec"
        assert "J Neurol Sci (2019 Nov-Dec)" in result.formatted_ref

    def test_title_and_journal_keep_text_after_inline_markup(self):
        # PubMed marks gene symbols up as <i> inside ArticleTitle. findtext()
        # stops at the first child element, so the committed refs.json held
        # "Extension of the ... End-Truncating" with the gene cut off.
        xml = b"""<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>
        <ArticleTitle>Spectrum of end-truncating <i>NOTCH3</i> variants.</ArticleTitle>
        <Journal><Title>Journal of <i>Rare</i> Diseases</Title></Journal>
        </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>"""

        result = _parse_pubmed_xml("44444444", xml)

        assert result is not None
        assert result.title == "Spectrum of end-truncating NOTCH3 variants."
        assert result.journal == "Journal of Rare Diseases"

    def test_book_chapter_is_a_citation(self):
        # GeneReviews chapters come back as PubmedBookArticle, not
        # PubmedArticle; without this branch they were recorded as
        # "(citation not available)" -- a final answer for a real record.
        xml = b"""<PubmedArticleSet><PubmedBookArticle><BookDocument>
        <PMID>20301673</PMID>
        <ArticleIdList>
          <ArticleId IdType="bookaccession">NBK1500</ArticleId>
        </ArticleIdList>
        <Book>
          <BookTitle>GeneReviews</BookTitle>
          <PubDate><Year>1993</Year></PubDate>
          <AuthorList Type="editors">
            <Author><LastName>Adam</LastName><Initials>MP</Initials></Author>
          </AuthorList>
        </Book>
        <ArticleTitle>CADASIL</ArticleTitle>
        <AuthorList Type="authors">
          <Author><LastName>Hack</LastName><Initials>RJ</Initials></Author>
          <Author><LastName>Rutten</LastName><Initials>J</Initials></Author>
        </AuthorList>
        </BookDocument></PubmedBookArticle></PubmedArticleSet>"""

        result = _parse_pubmed_xml("20301673", xml)

        assert result is not None
        assert result.title == "CADASIL"
        assert result.journal == "GeneReviews"
        assert result.authors == "Hack RJ, Rutten J"
        assert result.publication_date == "1993"
        assert result.doi is None
        assert "citation not available" not in result.formatted_ref
        assert "GeneReviews (1993)" in result.formatted_ref

    def test_book_without_chapter_title_falls_back_to_the_book(self):
        xml = b"""<PubmedArticleSet><PubmedBookArticle><BookDocument>
        <Book><BookTitle>GeneReviews</BookTitle>
          <AuthorList><Author><LastName>Adam</LastName><Initials>MP</Initials></Author></AuthorList>
        </Book>
        </BookDocument></PubmedBookArticle></PubmedArticleSet>"""

        result = _parse_pubmed_xml("1", xml)

        assert result is not None
        assert result.title == "GeneReviews"
        assert result.authors == "Adam MP"
        assert result.publication_date is None

    def test_pub_date_and_author_without_last_name(self):
        xml = b"""<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>
        <AuthorList>
          <Author><Initials>X</Initials></Author>
          <Author><LastName>Smith</LastName><Initials>J</Initials></Author>
        </AuthorList>
        <Journal><Title>Journal</Title><JournalIssue><PubDate>
          <Year>2024</Year><Month>Jan</Month>
        </PubDate></JournalIssue></Journal>
        </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>"""

        result = _parse_pubmed_xml("123", xml)

        assert result is not None
        assert result.authors == "Smith J"
        assert result.publication_date == "Jan 2024"

    def test_pub_date_without_month_or_year(self):
        year_only = b"""<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>
        <Journal><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal>
        </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>"""
        no_year = b"""<PubmedArticleSet><PubmedArticle><MedlineCitation><Article>
        <Journal><JournalIssue><PubDate><Month>Jan</Month></PubDate></JournalIssue></Journal>
        </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>"""

        year_result = _parse_pubmed_xml("1", year_only)
        no_year_result = _parse_pubmed_xml("2", no_year)

        assert year_result is not None
        assert no_year_result is not None
        assert year_result.publication_date == "2024"
        assert no_year_result.publication_date is None


# ---------------------------------------------------------------------------
# clear_pubmed_cache
# ---------------------------------------------------------------------------


class TestClearCache:
    def test_clears_cache(self):
        import pipeline.pubmed_citations as mod

        mod._citation_cache["12345678"] = PubMedCitation(
            "12345678", None, None, None, None, None, ""
        )
        assert "12345678" in mod._citation_cache
        clear_pubmed_cache()
        assert mod._citation_cache == {}


# ---------------------------------------------------------------------------
# fetch_pubmed_citation (cached wrapper)
# ---------------------------------------------------------------------------


class TestFetchPubmedCitation:
    async def test_cache_hit(self):
        import pipeline.pubmed_citations as mod

        cached = PubMedCitation("12345678", "auth", "title", "j", None, None, "ref")
        mod._citation_cache["12345678"] = cached

        result = await fetch_pubmed_citation("12345678")
        assert result is cached

    async def test_cache_miss_fetches(self, mocker):
        expected = PubMedCitation("12345678", "auth", "t", "j", None, None, "ref")
        mocker.patch(
            "pipeline.pubmed_citations._fetch_pubmed_uncached",
            return_value=expected,
        )
        result = await fetch_pubmed_citation("12345678")
        assert result is expected

    async def test_second_lookup_reuses_initialized_state(self, mocker):
        expected = PubMedCitation("12345678", "auth", "t", "j", None, None, "ref")
        fetch = mocker.patch(
            "pipeline.pubmed_citations._fetch_pubmed_uncached",
            return_value=expected,
        )

        assert await fetch_pubmed_citation("12345678") is expected
        assert await fetch_pubmed_citation("12345678") is expected
        fetch.assert_awaited_once()


async def test_close_pubmed_client(mocker):
    close = mocker.patch(
        "pipeline.pubmed_citations._client_manager.close", AsyncMock()
    )

    await close_pubmed_client()

    close.assert_awaited_once_with()


# ---------------------------------------------------------------------------
# _fetch_pubmed_uncached
# ---------------------------------------------------------------------------


class TestFetchPubmedUncached:
    async def test_non_200_returns_none(self, mocker):
        resp = httpx.Response(500)
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=resp)
        mocker.patch(
            "pipeline.pubmed_citations._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_pubmed_uncached("12345678")
        assert result is None

    async def test_timeout_returns_none(self, mocker):
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
        mocker.patch(
            "pipeline.pubmed_citations._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_pubmed_uncached("12345678")
        assert result is None

    async def test_request_error_returns_none(self, mocker):
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.RequestError("connection reset"))
        mocker.patch(
            "pipeline.pubmed_citations._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_pubmed_uncached("12345678")
        assert result is None

    async def test_successful_fetch_parses_xml(self, mocker):
        resp = httpx.Response(200, content=_FULL_ARTICLE_XML)
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=resp)
        mocker.patch(
            "pipeline.pubmed_citations._client_manager.get",
            return_value=mock_client,
        )

        result = await _fetch_pubmed_uncached("12345678")
        assert result is not None
        assert result.pmid == "12345678"
        assert result.title == "Gene discovery in SVD"


# ---------------------------------------------------------------------------
# fetch_pubmed_citations_batch
# ---------------------------------------------------------------------------


class TestFetchPubmedCitationsBatch:
    async def test_placeholder_for_failed(self, mocker):
        mocker.patch(
            "pipeline.pubmed_citations.fetch_pubmed_citation",
            return_value=None,
        )
        result = await fetch_pubmed_citations_batch(["12345678"])
        assert len(result) == 1
        assert result[0].pmid == "12345678"
        assert "fetch failed" in result[0].formatted_ref

    async def test_progress_callback(self, mocker):
        citation = PubMedCitation("1", None, None, None, None, None, "")
        mocker.patch(
            "pipeline.pubmed_citations.fetch_pubmed_citation",
            return_value=citation,
        )
        calls = []
        await fetch_pubmed_citations_batch(
            ["1", "2"],
            progress_callback=lambda cur, tot: calls.append((cur, tot)),
        )
        assert len(calls) == 2
        assert calls[-1] == (2, 2)

    async def test_passes_config_to_each_fetch(self, mocker):
        config = PipelineConfig(ncbi_rate_limit=7)
        citation = PubMedCitation("1", None, None, None, None, None, "")
        fetch = mocker.patch(
            "pipeline.pubmed_citations.fetch_pubmed_citation",
            return_value=citation,
        )

        await fetch_pubmed_citations_batch(["1"], config=config)

        fetch.assert_awaited_once_with("1", config=config)


# ---------------------------------------------------------------------------
# sync_pubmed_citations
# ---------------------------------------------------------------------------


class TestSyncPubmedCitations:
    async def test_all_cached(self, mocker):
        mocker.patch(
            "pipeline.database.get_cached_pubmed_citations",
            return_value={"12345678": {}, "23456789": {}},
        )

        result = await sync_pubmed_citations(["12345678", "23456789"])
        assert isinstance(result, SyncResult)
        assert result.fetched == 0
        assert result.cached == 2

    async def test_deduplicates_pmids(self, mocker):
        mocker.patch(
            "pipeline.database.get_cached_pubmed_citations",
            return_value={"12345678": {}},
        )

        # Even though "12345678" appears twice, it should be deduplicated
        result = await sync_pubmed_citations(["12345678", "12345678", "12345678"])
        assert result.cached == 1

    async def test_successful_vs_failed_counting(self, mocker):
        mocker.patch(
            "pipeline.database.get_cached_pubmed_citations",
            return_value={},
        )
        success = PubMedCitation("1", "auth", "A Title", "j", None, None, "ref")
        failed = PubMedCitation("2", None, None, None, None, None, "PMID: 2 (failed)")
        mocker.patch(
            "pipeline.pubmed_citations.fetch_pubmed_citations_batch",
            return_value=[success, failed],
        )
        mocker.patch(
            "pipeline.database.upsert_pubmed_citations_batch",
            return_value=2,
        )

        result = await sync_pubmed_citations(["1111111", "2222222"])
        assert result.fetched == 1  # title is not None
        assert result.failed == 1  # title is None
        assert any("PMID 2" in e for e in result.errors)

    async def test_failed_fetches_are_not_stored(self, mocker):
        # get_cached_pubmed_citations has no TTL and no title filter, so a
        # stored placeholder is "cached" on every later run and refs.json
        # publishes "(citation fetch failed)" forever. A transport failure
        # is not a fact about the PMID and must not be written.
        mocker.patch(
            "pipeline.database.get_cached_pubmed_citations",
            return_value={},
        )
        success = PubMedCitation("1", "auth", "A Title", "j", None, None, "ref")
        failed = PubMedCitation(
            "2", None, None, None, None, None, "PMID: 2 (citation fetch failed)"
        )
        mocker.patch(
            "pipeline.pubmed_citations.fetch_pubmed_citations_batch",
            return_value=[success, failed],
        )
        upsert = mocker.patch(
            "pipeline.database.upsert_pubmed_citations_batch",
            return_value=1,
        )

        result = await sync_pubmed_citations(["1", "2"])

        upsert.assert_awaited_once_with([success])
        assert result.failed == 1

    async def test_nothing_to_store_skips_the_upsert(self, mocker):
        mocker.patch(
            "pipeline.database.get_cached_pubmed_citations",
            return_value={},
        )
        failed = PubMedCitation(
            "2", None, None, None, None, None, "PMID: 2 (citation fetch failed)"
        )
        mocker.patch(
            "pipeline.pubmed_citations.fetch_pubmed_citations_batch",
            return_value=[failed],
        )
        upsert = mocker.patch("pipeline.database.upsert_pubmed_citations_batch")

        result = await sync_pubmed_citations(["2"])

        upsert.assert_not_called()
        assert result.failed == 1
