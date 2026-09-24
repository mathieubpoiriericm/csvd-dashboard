"""Span matching for API-returned citations. No API calls here."""

import logging

import pytest

from pipeline.citations import (
    CitedSpan,
    collect_spans,
    is_sentence_like,
    locate_quote,
    report_provenance,
    reset_tally,
    verify_quote,
)


def _span(text: str, start: int = 0) -> CitedSpan:
    return CitedSpan(
        cited_text=text, start_char_index=start, end_char_index=start + len(text)
    )


def test_an_exact_quote_matches_its_span() -> None:
    spans = [_span("TWAS analysis identified ICA1L as significant.")]
    assert verify_quote("TWAS analysis identified ICA1L as significant.", spans)


def test_trailing_whitespace_in_the_span_does_not_block_a_match() -> None:
    """The API's cited_text keeps the source's trailing space.

    The probe returned "...PP4 = 0.91. " with a trailing space while the
    model's source_quote had none. Comparing raw would reject a quote
    that is in fact verbatim.
    """
    spans = [_span("TWAS analysis identified ICA1L as significant. ")]
    assert verify_quote("TWAS analysis identified ICA1L as significant.", spans)


def test_a_line_break_inside_the_span_does_not_block_a_match() -> None:
    """The document is wrapped; the model's quote is not.

    cited_text is a slice of the raw document, so a sentence crossing a
    line break carries that break. The model writes the same sentence on
    one line. Comparing raw would call a verbatim quote unverified --
    measured at 5 of 138 quotes across the ten fixtures, 29% -> 33%.
    """
    spans = [_span("TWAS analysis identified ICA1L\n   as significant.")]
    assert verify_quote("TWAS analysis identified ICA1L as significant.", spans)


def test_normalizing_whitespace_still_rejects_a_paraphrase() -> None:
    """Collapsing runs of whitespace must not become fuzzy matching."""
    spans = [_span("TWAS analysis identified ICA1L\nas significant.")]
    assert verify_quote("ICA1L was identified as significant by TWAS.", spans) is None


def test_a_quote_spanning_two_citations_does_not_match() -> None:
    """Provenance is one sentence; a stitched quote is not verbatim."""
    spans = [_span("First sentence."), _span("Second sentence.", 16)]
    assert verify_quote("First sentence. Second sentence.", spans) is None


def test_a_paraphrase_does_not_match() -> None:
    spans = [_span("TWAS analysis identified ICA1L as significant.")]
    assert verify_quote("ICA1L was found to be significant by TWAS.", spans) is None


def test_no_spans_means_no_match() -> None:
    assert verify_quote("anything", []) is None


def test_a_blank_quote_never_matches() -> None:
    """A whitespace-only quote would otherwise match a whitespace-only span.

    source_quote is min_length=1 after stripping, so this cannot arrive
    from a validated GeneEntry -- but verify_quote is a pure function with
    its own callers, and "" matching "" would report provenance for a
    quote that carries none.
    """
    assert verify_quote("   ", [_span("  ")]) is None


def test_the_matched_span_is_returned_not_just_a_flag() -> None:
    """The offsets are the point: a reviewer slices the document with them."""
    spans = [_span("ICA1L is significant.", start=10)]
    match = verify_quote("ICA1L is significant.", spans)
    assert match is not None
    assert (match.start_char_index, match.end_char_index) == (10, 31)


def test_collect_spans_reads_citations_off_text_blocks() -> None:
    class _Cite:
        type = "char_location"
        cited_text = "ICA1L is significant. "
        start_char_index = 10
        end_char_index = 32

    class _Text:
        type = "text"
        text = "ICA1L is significant."
        citations = [_Cite()]

    class _Tool:
        type = "tool_use"
        name = "report_genes"
        input = {"genes": []}

    class _Response:
        content = [_Text(), _Tool()]

    spans = collect_spans(_Response())
    assert len(spans) == 1
    assert spans[0].start_char_index == 10
    assert spans[0].cited_text == "ICA1L is significant. "


def test_collect_spans_ignores_a_text_block_with_no_citations() -> None:
    """Not every text block carries one, and `citations` may be None."""

    class _Bare:
        type = "text"
        text = "Some prose."
        citations = None

    class _Response:
        content = [_Bare()]

    assert collect_spans(_Response()) == []


def test_collect_spans_skips_a_citation_missing_its_offsets() -> None:
    """Citation objects come in several shapes.

    char_location is the one a plain-text document produces; a PDF or a
    content-block document yields page_location or content_block_location
    instead, with different index fields. Skipping rather than raising
    keeps an unexpected shape from failing a paper whose extraction is
    otherwise fine -- it lands as an unverified quote in the log.
    """

    class _PageCite:
        type = "page_location"
        cited_text = "ICA1L is significant."
        start_page_number = 3
        end_page_number = 3

    class _Text:
        type = "text"
        text = "prose"
        citations = [_PageCite()]

    class _Response:
        content = [_Text()]

    assert collect_spans(_Response()) == []


def test_collect_spans_tolerates_a_response_with_no_content() -> None:
    class _Response:
        content = None

    assert collect_spans(_Response()) == []


# ---------------------------------------------------------------------------
# locate_quote — verbatim check against the document itself
# ---------------------------------------------------------------------------


def test_locate_quote_finds_a_verbatim_sentence() -> None:
    """The document is in hand, so verbatimness needs no API round trip.

    Measured over the ten golden cassettes: 137/138 quotes are verbatim in
    the paper, against 45/138 that the API happened to cite. The citation
    rate is bounded by how much prose the model wrote, not by how good the
    quotes are, so this is the check that can actually gate.
    """
    document = "Intro text. ICA1L was significant (p = 3.1e-9). Outro."
    span = locate_quote("ICA1L was significant (p = 3.1e-9).", document)
    assert span is not None
    assert document[span.start_char_index : span.end_char_index] == (
        "ICA1L was significant (p = 3.1e-9)."
    )


def test_locate_quote_survives_a_line_break_in_the_document() -> None:
    """Papers are wrapped; the model writes the sentence on one line."""
    document = "Intro. ICA1L was\n    significant here. Outro."
    span = locate_quote("ICA1L was significant here.", document)
    assert span is not None
    assert "ICA1L was" in document[span.start_char_index : span.end_char_index]


def test_locate_quote_rejects_a_paraphrase() -> None:
    document = "ICA1L was significant (p = 3.1e-9)."
    assert locate_quote("ICA1L was found to be significant.", document) is None


def test_locate_quote_rejects_a_blank_quote() -> None:
    assert locate_quote("   ", "some document") is None


def test_locate_quote_offsets_index_the_document_given_to_it() -> None:
    """The offsets are only meaningful against the bytes actually sent.

    document_text is the truncated paper -- exactly what travels in the
    document block -- so slicing it with these offsets reproduces the
    sentence, which is what a reviewer does by hand.
    """
    document = "A. B. ICA1L was clearly significant. C."
    span = locate_quote("ICA1L was clearly significant.", document)
    assert span is not None
    assert span.start_char_index == 6
    assert document[span.start_char_index : span.end_char_index] == (
        "ICA1L was clearly significant."
    )


# ---------------------------------------------------------------------------
# locate_quote — the sentence-shape floor
# ---------------------------------------------------------------------------


def test_a_bare_gene_symbol_is_not_provenance() -> None:
    """Containment alone made every gene its own evidence.

    `source_quote` is min_length=1, so nothing upstream stops the model
    answering with the symbol it was asked about -- and the symbol is in
    the paper by definition, so it counted as verbatim and satisfied the
    gate while supporting nothing.
    """
    document = "Rare NOTCH3 variants raise WMH burden in the discovery cohort."
    assert locate_quote("NOTCH3", document) is None


def test_a_mid_word_fragment_is_not_provenance() -> None:
    """A fragment of a word is not a quotation of it.

    'TCH3 variants' is a substring of 'NOTCH3 variants' and was located
    happily. Anchoring on word boundaries is what rejects it; the word
    count alone would not, since a long enough fragment clears that.
    """
    document = "Rare NOTCH3 variants raise WMH burden in the discovery cohort."
    assert locate_quote("TCH3 variants raise WMH burden", document) is None


def test_a_quote_that_ends_mid_word_is_not_provenance() -> None:
    """The tail is anchored as well as the head."""
    document = "Rare NOTCH3 variants raise WMH burden in the discovery cohort."
    assert locate_quote("variants raise WMH burd", document) is None


def test_a_quote_may_open_on_punctuation() -> None:
    """`\\b` would be the wrong assertion at an end that is not a word.

    The anchors are added only where the quote itself starts or ends on a
    word character, so a quote opening on a bracket still matches even
    when the document runs it straight onto the previous token.
    """
    document = "expression in ITGB5(chr3q21.2) was lower in whole blood."
    span = locate_quote("(chr3q21.2) was lower in whole blood.", document)
    assert span is not None
    assert span.start_char_index == 19


def test_a_three_word_quote_is_under_the_floor() -> None:
    """Four words is the floor, and it is checked on the quote alone."""
    document = "The variant was strongly associated with WMH volume."
    assert locate_quote("was strongly associated", document) is None
    assert locate_quote("variant was strongly associated", document) is not None


def test_is_sentence_like_is_the_shape_check_on_its_own() -> None:
    """Exported because the failures are reported apart from paraphrases."""
    assert not is_sentence_like("NOTCH3")
    assert not is_sentence_like("   ")
    assert is_sentence_like("NOTCH3 raises WMH burden.")


class _Gene:
    def __init__(self, symbol: str, quote: str) -> None:
        self.gene_symbol = symbol
        self.source_quote = quote


def test_a_short_quote_is_reported_as_a_shape_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The two failures are different findings and read differently.

    A quote that is prose but absent from the paper sends a reviewer to
    the paper; a quote that is one word never claimed to be prose. Saying
    "is not in the paper" of the second would send them looking for
    something the model never wrote.
    """
    reset_tally()
    document = "Rare NOTCH3 variants raise WMH burden in the discovery cohort."
    with caplog.at_level(logging.WARNING, logger="pipeline.citations"):
        report_provenance(
            [_Gene("NOTCH3", "NOTCH3"), _Gene("HTRA1", "HTRA1 was not measured.")],
            spans=[],
            document=document,
            pmid="1",
            require_verified_quotes=False,
        )
    messages = [record.getMessage() for record in caplog.records]
    assert any("NOTCH3" in m and "not a quotation" in m for m in messages)
    assert any("HTRA1" in m and "is not in the paper" in m for m in messages)


def test_the_gate_drops_a_gene_whose_quote_is_only_its_symbol() -> None:
    """The verbatim gate is what `require_verified_quotes` turns on.

    Before the shape floor this kept the gene: the symbol is in the paper,
    so it passed the check that exists to make provenance mean something.
    """
    reset_tally()
    document = "Rare NOTCH3 variants raise WMH burden in the discovery cohort."
    kept = report_provenance(
        [
            _Gene("NOTCH3", "NOTCH3"),
            _Gene("WMH", "Rare NOTCH3 variants raise WMH burden"),
        ],
        spans=[],
        document=document,
        pmid="1",
        require_verified_quotes=True,
    )
    assert [gene.gene_symbol for gene in kept] == ["WMH"]
