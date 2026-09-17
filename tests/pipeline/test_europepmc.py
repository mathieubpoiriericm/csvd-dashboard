"""Tests for pipeline.europepmc — Europe PMC full-text retrieval, JATS parsing."""

import json
from unittest.mock import AsyncMock, MagicMock

import httpx

from pipeline.europepmc import (
    _resolve_pmcid,
    fetch_europepmc_fulltext,
    parse_jats,
)

_JATS = b"""<?xml version="1.0"?>
<article><body>
<sec><title>Results</title><p>NOTCH3 was associated with WMH.</p></sec>
<sec><title>Methods</title><p>We genotyped 500 samples.</p></sec>
<table-wrap><table><thead><tr><th>Gene</th><th>P</th></tr></thead>
<tbody><tr><td>HTRA1</td><td>1e-8</td></tr></tbody></table></table-wrap>
</body></article>"""


def test_parse_jats_keeps_section_prose() -> None:
    text = parse_jats(_JATS)
    assert text is not None
    assert "NOTCH3 was associated with WMH." in text
    assert "We genotyped 500 samples." in text


def test_parse_jats_preserves_table_cell_content() -> None:
    """Association tables are where the gene-trait evidence lives."""
    text = parse_jats(_JATS)
    assert text is not None
    assert "HTRA1" in text
    assert "1e-8" in text


def test_parse_jats_keeps_a_table_row_on_one_line() -> None:
    # One cell per line lost the row: a gene, its trait and its p-value
    # reached the model as three unrelated lines, and which trait belonged
    # to which gene was left for it to re-infer. A row is one line, cells
    # separated by " | ", the header row included.
    text = parse_jats(_JATS)
    assert text is not None
    lines = text.splitlines()
    assert "Gene | P" in lines
    assert "HTRA1 | 1e-8" in lines


def test_parse_jats_keeps_empty_cells_so_columns_line_up() -> None:
    row = b"""<article><body><table-wrap><table><tbody>
<tr><td>A</td><td/><td>C</td></tr>
<tr><td/><td/></tr>
</tbody></table></table-wrap></body></article>"""
    assert parse_jats(row) == "A |  | C"


def test_parse_jats_collapses_whitespace_inside_a_cell() -> None:
    # A cell wrapped over several source lines must not break its row.
    row = b"""<article><body><table-wrap><table><tbody>
<tr><td>
<italic>CYP4F3</italic>
</td><td>MAF (%)<break/>GLOB/EAS</td></tr>
</tbody></table></table-wrap></body></article>"""
    assert parse_jats(row) == "CYP4F3 | MAF (%) GLOB/EAS"


def test_parse_jats_emits_nested_cell_prose_once() -> None:
    """Real JATS wraps table-cell prose in <p>, and the walk collects both
    <td> and <p>.

    itertext() on the <td> already contains the nested <p>'s text, so
    without the ancestor check every such cell reached the model twice —
    duplicated evidence in the extraction input, on the primary retrieval
    path. A <p> that is *not* inside a collected element must still be
    emitted, which is what the second sentence here pins.
    """
    nested = b"""<?xml version="1.0"?>
<article><body>
<sec><p>Standalone prose.</p></sec>
<table-wrap><table><tbody><tr>
<td><p>NOTCH3 was associated with WMH (p=1e-9).</p></td>
<td>HTRA1</td>
</tr></tbody></table></table-wrap>
</body></article>"""
    text = parse_jats(nested)
    assert text is not None
    assert text.count("NOTCH3 was associated with WMH (p=1e-9).") == 1
    assert text.count("Standalone prose.") == 1
    assert "NOTCH3 was associated with WMH (p=1e-9). | HTRA1" in text


def test_parse_jats_reads_tables_deposited_in_a_floats_group() -> None:
    """JATS lets <table-wrap> sit beside <body>, and publishers use it.

    PMC12385738 (a 2025 CADASIL review) has zero <tr> in its body and three
    in its floats-group, so the whole table set and its caption were absent
    from the text sent to the model while the paper was still recorded
    `source: "europepmc", fulltext: True` and the PMID retired on it.
    """
    floats = b"""<?xml version="1.0"?>
<article>
<body><sec><p>We tested HTRA1.</p></sec></body>
<back/>
<floats-group>
<table-wrap>
<caption><title>Main RNF213 variants in CADASIL patients.</title></caption>
<table><thead><tr><th>Variant</th><th>P</th></tr></thead>
<tbody><tr><td>COL4A1</td><td>1e-9</td></tr></tbody></table>
</table-wrap>
</floats-group>
</article>"""
    text = parse_jats(floats)
    assert text is not None
    lines = text.splitlines()
    # The body still comes first; the floats-group follows it.
    assert lines[0] == "We tested HTRA1."
    assert "Main RNF213 variants in CADASIL patients." in lines
    assert "Variant | P" in lines
    assert "COL4A1 | 1e-9" in lines


def test_parse_jats_emits_a_floats_group_row_once() -> None:
    """The ancestor check spans both walks, so a nested <p> is not doubled."""
    floats = b"""<?xml version="1.0"?>
<article><body><sec><p>Body.</p></sec></body>
<floats-group><table-wrap><table><tbody>
<tr><td><p>COL4A2 (p=2e-7)</p></td><td>WMH</td></tr>
</tbody></table></table-wrap></floats-group></article>"""
    text = parse_jats(floats)
    assert text is not None
    assert text.count("COL4A2 (p=2e-7)") == 1
    assert "COL4A2 (p=2e-7) | WMH" in text


def test_parse_jats_returns_none_for_a_pdf_only_notice() -> None:
    """A scanned back issue deposits a notice, not a paper.

    It carries <front> and <sec>, so neither of the guards on the other
    JATS reader sees it either; the model extracted from one sentence and
    the PMID was retired with fulltext_available = true.
    """
    notice = b"""<?xml version="1.0"?>
<article><front/><body><sec><title>Full Text</title>
<p>The Full Text of this article is available as a PDF (10.2 MB).</p>
</sec></body></article>"""
    assert parse_jats(notice) is None


def test_parse_jats_keeps_a_real_article_that_mentions_a_pdf_later() -> None:
    """The notice is the body's first block; a later sentence is prose."""
    article = (
        b"""<?xml version="1.0"?>
<article><front/><body><sec><title>Results</title>
<p>"""
        + b"NOTCH3 was associated with WMH burden in the discovery cohort. " * 6
        + b"""</p>
<p>The Full Text of this article is available as a PDF in the archive.</p>
</sec></body></article>"""
    )
    text = parse_jats(article)
    assert text is not None
    assert "NOTCH3" in text


def test_parse_jats_returns_none_for_a_body_less_document() -> None:
    assert parse_jats(b"<article><front/></article>") is None


def test_parse_jats_returns_none_for_malformed_xml() -> None:
    assert parse_jats(b"not xml at all") is None


def test_parse_jats_tolerates_a_detached_reference_list(mocker) -> None:
    root = MagicMock()
    body = MagicMock()
    ref_list = MagicMock()
    root.find.return_value = body
    root.findall.return_value = []
    body.findall.return_value = [ref_list]
    body.iter.return_value = []
    ref_list.getparent.return_value = None
    mocker.patch("pipeline.europepmc.etree.fromstring", return_value=root)

    assert parse_jats(b"<article/>") is None


# ---------------------------------------------------------------------------
# parse_jats against a real Europe PMC response
# ---------------------------------------------------------------------------

# Trimmed excerpt of the real fullTextXML served for PMC13239414 (PMID
# 42224635, "Identification of Novel Genetic Risk Variants Associated With
# Early-Onset Ischemic Stroke", Neurology), fetched live from
# https://www.ebi.ac.uk/europepmc/webservices/rest/PMC13239414/fullTextXML
# while verifying this task. Trimmed to most of Table 1's rows, one
# reference, and the table's caption/label — dropped the footnote and
# ext-links (not needed by any assertion below) and shortened the citation
# text; long text runs are re-wrapped at word boundaries to respect this
# project's line length, which does not change any word. Two real-world
# quirks it carries that the synthetic fixture above does not: this
# publisher tags header cells <td>, not <th>, and its bibliography lives
# inside <body> (under sec[@sec-type='ref-list']) rather than in a sibling
# <back>.
_REAL_JATS_EXCERPT = """<?xml version='1.0' encoding='UTF-8'?>
<article>
  <body>
    <sec id="s2-1" disp-level="2">
      <title>
Sources of the Cohorts, Standard Protocol Approvals,
Registrations, and Patient Consents
</title>
      <p>
For the TPMI, a total of 565,390 Taiwanese residents were
included from general outpatient clinics across 16
participating medical centers.
<sup><xref rid="R21" ref-type="bibr">21</xref></sup>
The inclusion criteria were broad, encompassing all
individuals who agreed to provide DNA samples for genetic
profiling and to permit access to their electronic medical
records for research. For the independent IS patient cohort
used for genotype-phenotype correlation and whole-exome
sequencing of rare pathogenic variants, consecutive
inpatients with IS who provided consent were enrolled at the
Taipei Veterans General Hospital.
</p>
    </sec>
    <table-wrap id="T1" position="float">
      <?disp-level 3?>
      <label>Table 1</label>
      <caption>
        <p>
Summary of Credible Variants Identified in the GWAS of
Early-Onset and All IS
</p>
      </caption>
      <table frame="hsides" rules="groups">
        <thead>
          <tr>
            <td rowspan="1" colspan="1">ID</td>
            <td rowspan="1" colspan="1">rsID</td>
            <td rowspan="1" colspan="1">OR (95% CI)</td>
            <td rowspan="1" colspan="1"><italic>p</italic> Value</td>
            <td rowspan="1" colspan="1">MAF (%)<break/>GLOB/EAS/TPMI</td>
            <td rowspan="1" colspan="1">Nearest gene</td>
            <td rowspan="1" colspan="1">SO</td>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td rowspan="1" colspan="1">Early-onset IS</td>
            <td rowspan="1" colspan="1"/>
            <td rowspan="1" colspan="1"/>
            <td rowspan="1" colspan="1"/>
            <td rowspan="1" colspan="1"/>
            <td rowspan="1" colspan="1"/>
            <td rowspan="1" colspan="1"/>
          </tr>
          <tr>
            <td rowspan="1" colspan="1"> 19:15658680:CG:C</td>
            <td rowspan="1" colspan="1">rs541118668</td>
            <td rowspan="1" colspan="1">1.69 (1.44–1.98)</td>
            <td rowspan="1" colspan="1">6.86 × 10<sup>−11</sup></td>
            <td rowspan="1" colspan="1">0.08/0.4/1.41</td>
            <td rowspan="1" colspan="1">
<italic>CYP4F3</italic>
</td>
            <td rowspan="1" colspan="1">Intron</td>
          </tr>
          <tr>
            <td rowspan="1" colspan="1">All IS</td>
            <td rowspan="1" colspan="1"/>
            <td rowspan="1" colspan="1"/>
            <td rowspan="1" colspan="1"/>
            <td rowspan="1" colspan="1"/>
            <td rowspan="1" colspan="1"/>
            <td rowspan="1" colspan="1"/>
          </tr>
          <tr>
            <td rowspan="1" colspan="1"> 19:15450126:A:T</td>
            <td rowspan="1" colspan="1">rs552786035</td>
            <td rowspan="1" colspan="1">1.69 (1.56–1.84)</td>
            <td rowspan="1" colspan="1">5.17 × 10<sup>−36</sup></td>
            <td rowspan="1" colspan="1">0.08/0.4/1.46</td>
            <td rowspan="1" colspan="1">
<italic>WIZ</italic>
</td>
            <td rowspan="1" colspan="1">Upstream</td>
          </tr>
        </tbody>
      </table>
    </table-wrap>
    <sec sec-type="ref-list">
      <title>References</title>
      <ref-list>
        <ref id="R1">
          <label>1.</label>
          <mixed-citation>
            <named-content content-type="citation-string">
Nehme A, Li L. The rising incidence of stroke in the young:
epidemiology, causes and global impact.
</named-content>
          </mixed-citation>
        </ref>
      </ref-list>
    </sec>
  </body>
</article>
""".encode()


def test_parse_jats_survives_real_document_with_td_only_headers() -> None:
    """Real Europe PMC JATS: this publisher tags header cells <td>, not <th>."""
    text = parse_jats(_REAL_JATS_EXCERPT)
    assert text is not None
    assert "CYP4F3" in text
    assert "WIZ" in text
    assert "6.86" in text  # the p-value survives despite the nested <sup>
    # The row survives as a row: the variant, its p-value and its nearest
    # gene stay on one line, in the header's column order.
    lines = text.splitlines()
    assert (
        "ID | rsID | OR (95% CI) | p Value | MAF (%) GLOB/EAS/TPMI | "
        "Nearest gene | SO"
    ) in lines
    assert (
        "19:15658680:CG:C | rs541118668 | 1.69 (1.44–1.98) | 6.86 × 10 −11 | "
        "0.08/0.4/1.41 | CYP4F3 | Intron"
    ) in lines


def test_parse_jats_does_not_leak_bibliography_text() -> None:
    """The reference list sits inside <body> for this publisher, but citation
    text lives in <mixed-citation>/<named-content> — tags parse_jats does not
    collect — so it stays out even though the section heading is kept.
    """
    text = parse_jats(_REAL_JATS_EXCERPT)
    assert text is not None
    assert "References" in text
    assert "Nehme A" not in text


# A synthetic (not real-document-derived) fixture: a live survey of 9 real
# Europe PMC documents across different publishers found 6 embed the
# reference list inside <body> rather than a sibling <back>, and none of them
# leaked into extracted text — but only because every publisher observed
# renders citations via tags this walk never collects (mixed-citation/
# named-content, or element-citation/article-title/source). No real document
# with a bare <p>/<title> inside a ref-list was found, so this fixture is
# deliberately hypothetical: it exercises the explicit <ref-list> guard for a
# shape that would otherwise leak, as defense in depth against a publisher or
# a future Europe PMC rendering change doing this.
_JATS_WITH_LEAKY_REFLIST = b"""<?xml version="1.0"?>
<article><body>
<sec><title>Results</title><p>NOTCH3 was associated with WMH.</p></sec>
<sec sec-type="ref-list"><title>References</title>
<ref-list>
<ref id="R1"><title>Suspicious Title</title>
<p>A gene called HTRA2 appears here.</p></ref>
</ref-list>
</sec>
</body></article>"""


def test_parse_jats_excludes_bare_tags_inside_ref_list() -> None:
    """Explicit defense in depth, not just coincidental tag-shape avoidance.

    Without stripping <ref-list> subtrees, the bare <title>/<p> inside the
    <ref> below would be indistinguishable from real body content to the tag
    walk, and "HTRA2"/"Suspicious Title" would leak into extracted text.
    """
    text = parse_jats(_JATS_WITH_LEAKY_REFLIST)
    assert text is not None
    assert "NOTCH3 was associated with WMH." in text
    assert "References" in text
    assert "HTRA2" not in text
    assert "Suspicious Title" not in text


# A minimal internal-entity-expansion payload ("&c;" expands to 1,000 "A"s
# through two levels of nesting: 10 x 10 x 10). Not fetched from a real
# response — this is a security probe, not a fulltext fixture.
_ENTITY_BOMB = b"""<?xml version="1.0"?>
<!DOCTYPE article [
<!ENTITY a "AAAAAAAAAA">
<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">
<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">
]>
<article><body><sec><title>Results</title><p>&c;</p></sec></body></article>
"""


def test_parse_jats_does_not_expand_internal_entities() -> None:
    """Defense in depth against entity-expansion amplification.

    resolve_entities=False keeps the &c; reference unresolved rather than
    substituting its 1,000-character expansion into the tree. Confirmed live
    against lxml: the default parser (no parser= argument) does expand this
    to 1,000 "A"s; the hardened parser leaves it as the 4-character literal
    "&c;".
    """
    text = parse_jats(_ENTITY_BOMB)
    assert text is not None
    assert "Results" in text
    assert "AAAAAAAAAA" not in text


# ---------------------------------------------------------------------------
# _resolve_pmcid
# ---------------------------------------------------------------------------


def _search_response(payload: dict) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = payload
    resp.raise_for_status = MagicMock()
    return resp


class TestResolvePmcid:
    async def test_returns_pmcid_when_in_epmc(self, mocker) -> None:
        payload = {
            "resultList": {
                "result": [{"pmid": "42224635", "inEPMC": "Y", "pmcid": "PMC13239414"}]
            }
        }
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_search_response(payload))
        mocker.patch("pipeline.europepmc._client_manager.get", return_value=mock_client)
        assert await _resolve_pmcid("42224635") == "PMC13239414"

    async def test_returns_none_when_not_in_epmc(self, mocker) -> None:
        """Live check against PMID 42236108 confirmed this exact shape: inEPMC
        is present as the string "N" and pmcid is absent from the record
        entirely (not null — the key doesn't exist).
        """
        payload = {"resultList": {"result": [{"pmid": "42236108", "inEPMC": "N"}]}}
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_search_response(payload))
        mocker.patch("pipeline.europepmc._client_manager.get", return_value=mock_client)
        assert await _resolve_pmcid("42236108") is None

    async def test_returns_none_when_no_results(self, mocker) -> None:
        """Live check against a nonexistent PMID returned hitCount 0 and an
        empty result list — not an error.
        """
        payload = {"resultList": {"result": []}}
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_search_response(payload))
        mocker.patch("pipeline.europepmc._client_manager.get", return_value=mock_client)
        assert await _resolve_pmcid("99999999999") is None


# ---------------------------------------------------------------------------
# fetch_europepmc_fulltext
# ---------------------------------------------------------------------------


class TestFetchEuropepmcFulltext:
    async def test_returns_none_when_not_in_epmc(self, mocker) -> None:
        payload = {"resultList": {"result": [{"pmid": "1", "inEPMC": "N"}]}}
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_search_response(payload))
        mocker.patch("pipeline.europepmc._client_manager.get", return_value=mock_client)
        assert await fetch_europepmc_fulltext("1") is None
        mock_client.get.assert_called_once()  # never reaches fullTextXML

    async def test_success_returns_parsed_text(self, mocker) -> None:
        search_payload = {
            "resultList": {"result": [{"pmid": "1", "inEPMC": "Y", "pmcid": "PMC1"}]}
        }
        fulltext_resp = MagicMock()
        fulltext_resp.status_code = 200
        fulltext_resp.content = _JATS
        fulltext_resp.raise_for_status = MagicMock()
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[_search_response(search_payload), fulltext_resp]
        )
        mocker.patch("pipeline.europepmc._client_manager.get", return_value=mock_client)
        result = await fetch_europepmc_fulltext("1")
        assert result is not None
        assert "NOTCH3 was associated with WMH." in result

    async def test_returns_none_on_404(self, mocker) -> None:
        """A missing fullTextXML is a clean 404 with an empty body (confirmed
        live against a bogus PMCID) — not an exception, not an HTML page.
        """
        search_payload = {
            "resultList": {"result": [{"pmid": "1", "inEPMC": "Y", "pmcid": "PMC1"}]}
        }
        fulltext_resp = MagicMock()
        fulltext_resp.status_code = 404
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[_search_response(search_payload), fulltext_resp]
        )
        mocker.patch("pipeline.europepmc._client_manager.get", return_value=mock_client)
        assert await fetch_europepmc_fulltext("1") is None

    async def test_falls_through_cleanly_on_timeout(self, mocker) -> None:
        """A Europe PMC outage must not raise — the cascade depends on this."""
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
        mocker.patch("pipeline.europepmc._client_manager.get", return_value=mock_client)
        assert await fetch_europepmc_fulltext("1") is None

    async def test_falls_through_cleanly_on_http_status_error(self, mocker) -> None:
        """A 5xx from Europe PMC's search endpoint must not propagate either."""
        error_resp = MagicMock()
        error_resp.raise_for_status = MagicMock(
            side_effect=httpx.HTTPStatusError(
                "server error", request=MagicMock(), response=MagicMock()
            )
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=error_resp)
        mocker.patch("pipeline.europepmc._client_manager.get", return_value=mock_client)
        assert await fetch_europepmc_fulltext("1") is None

    async def test_falls_through_cleanly_on_invalid_json(self, mocker) -> None:
        """A 200 response with a non-JSON body must not propagate either.

        json.JSONDecodeError is a ValueError, not an httpx.HTTPError subclass
        — a bare `except httpx.HTTPError` would miss it and this PMID would
        fall through to nothing instead of continuing to PMC/Unpaywall/
        abstract like every other Europe PMC failure mode.
        """
        bad_resp = MagicMock()
        bad_resp.raise_for_status = MagicMock()
        bad_resp.json.side_effect = json.JSONDecodeError("Expecting value", "", 0)
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=bad_resp)
        mocker.patch("pipeline.europepmc._client_manager.get", return_value=mock_client)
        assert await fetch_europepmc_fulltext("1") is None
