"""Span matching for API-returned citations.

`source_quote` is a sentence the model reports having copied. This module
turns that into something checked, two ways, and the two do not cover the
same ground:

`verify_quote` matches it against a span the *API* cited. That is the
stronger claim -- the API attests the model used that span -- but its
coverage is bounded by how much prose the model wrote, not by how good the
quotes are. The API returns at most a handful of spans per paper however
many genes are found, so on the ten golden cassettes it reaches 45/138.

`locate_quote` finds it in the document directly. Weaker as attestation,
but it answers the question provenance actually asks -- is this sentence
verbatim from the paper -- for every gene rather than for the few the
model narrated, and it needs no API round trip. Same cassettes: 137/138.

Both hand back offsets into the document block's bytes, which is what lets
a reviewer slice the paper and read the sentence. Everything here is pure:
the request side lives in anthropic_client, and these functions are
unit-tested without a client.

Matching is exact once runs of whitespace are collapsed, and deliberately
no looser than that. Two artifacts of the wire format would otherwise
reject genuinely verbatim quotes, and both were measured rather than
guessed at: `cited_text` is a slice of the raw document, so it keeps the
source's trailing space (which the model's quote drops) and any line break
the document wrapped the sentence with (which the model writes as a single
space). Collapsing whitespace recovered 5 of 138 quotes across the ten
golden fixtures, 29% -> 33%. Anything looser than that would start
accepting paraphrase, which is the one thing this check exists to catch.

A measured option not taken: allowing the quote to be *contained* in a
span, rather than equal to it, would reach 37%. It is sound -- a span is
verbatim document text, so a substring of one is too -- but it stops
enforcing that provenance is a single sentence, so it is left out until
something needs it.

`locate_quote` *is* containment by construction -- it looks the quote up
in the paper -- so the sentence rule has to be spelled out there instead,
and it is: `is_sentence_like` below. Without it `NOTCH3` was a verbatim
quote for NOTCH3, and so was the mid-word fragment `TCH3 variants`; both
are in the paper and neither supports anything. See that function for the
floor and what it was measured against.
"""

import logging
import re
from collections.abc import Generator, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Final, Protocol

logger = logging.getLogger(__name__)

_WHITESPACE = re.compile(r"\s+")

# The fewest words a `source_quote` may have and still be provenance.
#
# `GeneEntry.source_quote` is `min_length=1`, so nothing upstream stops the
# model answering with a bare symbol, and `locate_quote` is containment by
# construction: `NOTCH3` is in a paper about NOTCH3, so it "verified", it
# was counted in the published verbatim rate, and it satisfied the
# `require_verified_quotes` gate while supporting nothing.
#
# Four is a floor with room under every quote actually observed: across the
# 184 quotes in the committed golden cassettes the shortest is nine words,
# so the measured 137/138 verbatim rate is unchanged by this rule -- it
# rejects shapes the model has never produced, not quotes it has.
_MIN_QUOTE_WORDS: Final[int] = 4

_WORD_CHAR = re.compile(r"\w")


def _normalize(text: str) -> str:
    """Collapse whitespace runs to one space and strip the ends."""
    return _WHITESPACE.sub(" ", text).strip()


@dataclass(slots=True, frozen=True)
class CitedSpan:
    """One API-returned citation: its text and where it sits."""

    cited_text: str
    start_char_index: int
    end_char_index: int


def collect_spans(response: Any) -> list[CitedSpan]:
    """Every citation on every text block of one response.

    Citations attach to text blocks only, never to a tool_use block --
    which is why the request uses tool_choice "auto" rather than forcing
    the call: a forced call emits no text and therefore no citations.

    A citation whose offsets are missing is skipped rather than raised on.
    char_location is the shape a plain-text document produces; a PDF or a
    content-block document yields page_location or content_block_location
    instead, with different index fields. An unexpected shape should land
    as an unverified quote in the log, not as a failed paper.
    """
    spans: list[CitedSpan] = []
    for block in getattr(response, "content", None) or []:
        if getattr(block, "type", None) != "text":
            continue
        for citation in getattr(block, "citations", None) or []:
            start = getattr(citation, "start_char_index", None)
            end = getattr(citation, "end_char_index", None)
            text = getattr(citation, "cited_text", None)
            if start is None or end is None or text is None:
                continue
            spans.append(
                CitedSpan(cited_text=text, start_char_index=start, end_char_index=end)
            )
    return spans


def verify_quote(quote: str, spans: Sequence[CitedSpan]) -> CitedSpan | None:
    """The span whose text is `quote`, or None when nothing matches.

    Returns the span rather than a bool because the offsets are the point:
    they are what lets a reviewer slice the document and see the sentence.
    """
    needle = _normalize(quote)
    if not needle:
        return None
    for span in spans:
        if _normalize(span.cited_text) == needle:
            return span
    return None


def is_sentence_like(quote: str) -> bool:
    """Whether `quote` has the shape a piece of provenance has.

    A quote is evidence only if it says something: `_MIN_QUOTE_WORDS`
    words, which a bare gene symbol and a two-word fragment both fail. The
    check is on the quote alone, so a quote can fail this and be perfectly
    verbatim -- that is the point, and `report_provenance` reports the two
    failures apart.
    """
    return len(_normalize(quote).split(" ")) >= _MIN_QUOTE_WORDS


def locate_quote(quote: str, document: str) -> CitedSpan | None:
    """Where `quote` sits in `document`, or None when it is not there.

    The search is whitespace-insensitive in one direction only: a run of
    whitespace in the document matches a single space in the quote, since
    papers wrap sentences across lines and the model writes them on one.
    Nothing else is relaxed, so a paraphrase still fails.

    Two shapes are refused before the search, because containment alone
    would call them verbatim and they are not provenance. A quote shorter
    than `_MIN_QUOTE_WORDS` is refused outright -- `NOTCH3` occurs in
    every paper about NOTCH3. And the match is anchored on word
    boundaries, so `TCH3 variants` cannot match inside `NOTCH3 variants`:
    a fragment of a word is not a quotation of it. The anchors are added
    only at an end that is itself a word character, since a quote may
    legitimately open on `(` or close on `.`, where `\\b` would be the
    wrong assertion.

    The offsets are into `document` as given. Pass the same string that
    travels in the document block -- the *truncated* paper -- or they will
    not line up with the API's own citation offsets.
    """
    if not is_sentence_like(quote):
        return None
    words = _normalize(quote).split(" ")
    pattern = r"\s+".join(re.escape(word) for word in words)
    if _WORD_CHAR.match(words[0]):
        pattern = r"(?<!\w)" + pattern
    if _WORD_CHAR.match(words[-1][-1]):
        pattern = pattern + r"(?!\w)"
    match = re.search(pattern, document)
    if match is None:
        return None
    return CitedSpan(
        cited_text=match.group(0),
        start_char_index=match.start(),
        end_char_index=match.end(),
    )


class _ProvenanceGene(Protocol):
    """The extraction fields needed to verify one gene's provenance."""

    gene_symbol: str
    source_quote: str


def report_provenance[G: _ProvenanceGene](
    genes: Sequence[G],
    *,
    spans: Sequence[CitedSpan],
    document: str,
    pmid: str,
    require_verified_quotes: bool,
) -> list[G]:
    """Check each gene's source_quote two ways, report both, apply the gate.

    Returns the genes to keep: all of them unless `require_verified_quotes`,
    in which case only those whose quote is verbatim in `document`. Each
    gene is read for `gene_symbol` and `source_quote` only, so the
    streaming and batch paths hand in the same entries.

    `cited` is the stronger claim -- the API attests the model used that
    span -- but its coverage is bounded by how much prose the model wrote
    rather than by quote quality: the API returns a handful of spans per
    paper however many genes are found, measured at 45/138 across the ten
    golden cassettes. `verbatim` asks the question provenance actually
    asks, of every gene, by looking in the document itself: 137/138 on the
    same cassettes.

    The gate uses `verbatim`, because it is the one with the coverage to
    gate on. Gating on `cited` would discard two thirds of the genes for
    want of prose. It stays off by default all the same -- this lands as
    measurement, and a quote that fails is a finding worth seeing before
    it is a gene worth losing.

    A gene the gate removes is kept on the tally beside the count, so the
    run can name it: the count alone told a reader a gene had been thrown
    away without saying which, and the symbol existed nowhere but the log.

    Here rather than in the streaming client because both callers need
    it: `--batch` parsed its tool blocks and returned, so the gate did
    nothing there and the run report published 0/0 quotes checked over
    every gene the batch found.
    """
    if not genes:
        return list(genes)
    cited = sum(verify_quote(gene.source_quote, spans) is not None for gene in genes)
    located = {id(gene): locate_quote(gene.source_quote, document) for gene in genes}
    verbatim = sum(span is not None for span in located.values())
    logger.info(
        f"  Provenance for PMID {pmid}: {verbatim}/{len(genes)} quotes "
        f"verbatim in the paper, {cited}/{len(genes)} matched an API "
        f"citation span ({len(spans)} spans returned)"
    )
    for gene in genes:
        if located[id(gene)] is None:
            # Two different failures, and conflating them would hide the
            # one that is a prompt problem rather than a retrieval
            # artifact: a quote too short to be evidence never reached the
            # document at all, so reporting it as "not in the paper" would
            # send a reader looking for prose that was never claimed.
            fault = (
                "is not in the paper"
                if is_sentence_like(gene.source_quote)
                else f"is under {_MIN_QUOTE_WORDS} words, so it is not a quotation"
            )
            logger.warning(
                f"  Quote for {gene.gene_symbol} (PMID {pmid}) {fault}: "
                f"{gene.source_quote[:120]!r}"
            )
    kept = list(genes)
    dropped: list[G] = []
    if require_verified_quotes:
        kept = [gene for gene in genes if located[id(gene)] is not None]
        dropped = [gene for gene in genes if located[id(gene)] is None]

    # Counted for the run report as well as logged. These were computed
    # here and then discarded, so the dashboard could show a gene's quote
    # without being able to say how many of them checked out.
    current_tally().record(
        genes=len(located),
        verbatim=verbatim,
        cited=cited,
        dropped_unverified=len(dropped),
    )
    # The genes themselves, not only how many: the count alone left the
    # report saying a gene had been thrown away without being able to
    # name it, and the symbol existed nowhere but the log file.
    current_tally().record_dropped(pmid, dropped)
    return kept


# ---------------------------------------------------------------------------
# RUN TALLY
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ProvenanceTally:
    """How many quotes a run could verify, and how.

    The two numbers are not the same claim and are kept apart for that
    reason. `verbatim` asks whether the quote is in the paper -- of every
    gene, which is the question provenance actually asks. `cited` asks
    whether the API attested to that span, which is the stronger claim
    where it exists but is bounded by how much prose the model wrote, not
    by quote quality.

    Accumulated here rather than threaded out through `extract_from_paper`
    and `_extract_and_validate`: those are the hottest and most carefully
    tested signatures in the pipeline, and this is a measurement, not a
    result any of them acts on. The API recorder collects its inventory
    the same way.
    """

    genes: int = 0
    verbatim: int = 0
    cited: int = 0
    # The same counts, per paper, for the checkpoint to store: a resumed run
    # restores a paper's genes and cost, and has to restore its quote counts
    # with them or publish a provenance rate over part of the genes it
    # counts. Filled only inside `paper_scope`.
    by_paper: dict[str, dict[str, int]] = field(default_factory=dict)
    # The gene objects `require_verified_quotes` removed, per paper, so the
    # run can name them rather than publish a bare count. `Any` for the
    # reason `report_provenance` is generic: this module reads a gene for
    # `gene_symbol` and `source_quote` and stays clear of the extraction
    # models. Keyed on the pmid the caller passed, not on `paper_scope`,
    # because the offline modes extract outside one.
    dropped_by_paper: dict[str, list[Any]] = field(default_factory=dict)

    def record(
        self,
        *,
        genes: int,
        verbatim: int,
        cited: int,
        dropped_unverified: int = 0,
    ) -> None:
        """Add one paper's counts."""
        self.genes += genes
        self.verbatim += verbatim
        self.cited += cited
        pmid = _current_paper.get()
        if pmid is not None:
            paper = self.by_paper.setdefault(pmid, dict(_NO_QUOTES))
            paper["genes"] += genes
            paper["verbatim"] += verbatim
            paper["cited"] += cited
            paper["dropped_unverified"] += dropped_unverified

    def record_dropped(self, pmid: str, genes: Sequence[Any]) -> None:
        """Keep the genes the verbatim gate removed from *pmid*."""
        if genes:
            self.dropped_by_paper.setdefault(pmid, []).extend(genes)

    def paper(self, pmid: str) -> dict[str, int]:
        """What one paper contributed; zeros for a paper that recorded nothing."""
        return dict(self.by_paper.get(pmid, _NO_QUOTES))

    def dropped(self, pmid: str) -> list[Any]:
        """The genes the gate removed from one paper; empty when it removed none."""
        return list(self.dropped_by_paper.get(pmid, ()))

    def discard(self, pmid: str) -> None:
        """Un-count a paper the run did not keep.

        A paper whose validation failed is retried by a later run, which
        counts its genes then -- `genes_extracted` is incremented only
        once validation held, for exactly that reason. Its quotes were
        recorded during extraction, before that was known, so leaving
        them in published a verbatim rate over genes the report lists in
        neither `extracted`, `validated` nor `rejected`, and the retrying
        run counted them a second time.
        """
        paper = self.by_paper.pop(pmid, None)
        if paper is not None:
            self.genes -= paper["genes"]
            self.verbatim -= paper["verbatim"]
            self.cited -= paper["cited"]
        self.dropped_by_paper.pop(pmid, None)


_NO_QUOTES: dict[str, int] = {
    "genes": 0,
    "verbatim": 0,
    "cited": 0,
    "dropped_unverified": 0,
}

_current_paper: ContextVar[str | None] = ContextVar("provenance_paper", default=None)

_tally = ProvenanceTally()


@contextmanager
def paper_scope(pmid: str) -> Generator[None]:
    """Attribute every count recorded inside to *pmid*.

    The tally is one accumulator for the whole run and papers are extracted
    concurrently, so a before-and-after delta around one paper would carry
    whatever the others recorded meanwhile. A context variable is task-local,
    and a paper is a task.
    """
    token = _current_paper.set(pmid)
    try:
        yield
    finally:
        _current_paper.reset(token)


def current_tally() -> ProvenanceTally:
    """The tally this run is filling."""
    return _tally


def reset_tally() -> ProvenanceTally:
    """Start a fresh tally. Returns it, for tests and for a new run."""
    global _tally
    _tally = ProvenanceTally()
    return _tally
