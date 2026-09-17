"""Text-cleaning helpers ported from data-prep/utils.R.

Each helper here encodes a defect found in the real source data. The tests
name the defect; do not "simplify" a rule without checking the test first.
"""

import re
from collections.abc import Iterable
from typing import Final

_ACRONYMS: Final[dict[str, str]] = {
    acronym.lower(): acronym for acronym in ("GWAS", "SVD", "ID", "Omics")
}

# toTitleCase in R lower-cases these short words. Reproduced so column
# names — and therefore JSON keys — match the committed files exactly.
_TITLE_CASE_STOPWORDS: Final[frozenset[str]] = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "but",
        "by",
        "en",
        "for",
        "if",
        "in",
        "is",
        "nor",
        "not",
        "of",
        "on",
        "or",
        "per",
        "so",
        "the",
        "to",
        "v",
        "via",
        "vs",
        "from",
        "into",
        "than",
        "that",
        "with",
    }
)

_PUBMED_URL = re.compile(
    r"https?://(?:www\.)?(?:pubmed\.ncbi\.nlm\.nih\.gov/|"
    r"ncbi\.nlm\.nih\.gov/pubmed/)([1-9][0-9]*)",
    re.IGNORECASE,
)
_LABELLED_PMID = re.compile(r"\bPMID\s*:?\s*([1-9][0-9]*)\b", re.IGNORECASE)
_URL = re.compile(r"https?://\S+")
_DOI_LABEL = re.compile(r"\bdoi:\s*\S+", re.IGNORECASE)
_DOI_BARE = re.compile(r"\b10\.\d{4,9}/\S+")
_NUMERIC_LIST = re.compile(r"^\s*[1-9][0-9]*(?:\s*[,;]\s*[1-9][0-9]*)*\s*$")
_MARKER = "SVDPMIDTOKEN"
_MARKED_OR_LONG = re.compile(rf"{_MARKER}[1-9][0-9]*|\b[1-9][0-9]{{6,}}\b")
_ANY_NUMBER = re.compile(r"\b[1-9][0-9]*\b")
# A spreadsheet round-trip turns a comma-separated PMID list into one
# formatted number: "26063658,33773637,..." comes back as
# "2,606,365,833,773,630,000,000,..." once the cell is parsed as a float and
# re-rendered with thousands separators, the trailing zeros being float64
# precision loss. Such a cell is grammatically identical to a list of short
# PMIDs, so it is refused rather than mined for digits: a visible
# "(reference needed)" is far better than six fabricated citations, and this
# is a provenance field in a published dataset. Legitimate short-PMID lists
# are unaffected -- their groups are not all exactly three digits.
# Matched anywhere, not just as the whole cell. The whole-cell case is a
# reference list a spreadsheet destroyed outright; the embedded case appears
# the moment an extraction merges a real PMID onto such a row, because
# merge_genes_transactional unions references rather than replacing them.
# Then "1,953,923,630,859,180; 42437605" is an all-numeric list by the
# grammar below, and the short-id branch happily published "1", "953" and
# "923" as citations. Word boundaries keep a genuine short list such as
# "12345, 67890" untouched -- its groups are not comma-delimited triples.
_THOUSANDS_RUN = re.compile(r"\b[1-9][0-9]{0,2}(?:,[0-9]{3})+\b")
_TARGET_SPLIT = re.compile(r"[,;/]")
# The curated label for the collagen pair is "COL4A1/2" (data_merger.py's
# canonical map and the genes table both spell it so). Slash is a delimiter
# because "COL4A1/COL4A2" occurs too, and split alone read the shorthand as
# COL4A1 and a gene named "2". The stem is the symbol up to its trailing digits.
_PAIR_SHORTHAND = re.compile(r"\b([A-Z][A-Z0-9]*[A-Z])(\d+)/(\d+)\b")
_NA_WORD = re.compile(r"\bN\s*/\s*A\b", re.IGNORECASE)
_TARGET_SENTINELS: Final[frozenset[str]] = frozenset(
    {"", "NA", "N/A", "-", "(NONE)", "(UNKNOWN)"}
)


def normalize_text(value: str | None) -> str | None:
    """Trim surrounding whitespace; a blank cell becomes None."""
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def fill_missing_text(
    value: str | None,
    fallback: str,
    sentinels: tuple[str, ...] = ("NA", "N/A"),
) -> str:
    """Replace a missing or sentinel value with one display fallback."""
    if value is None:
        return fallback
    normalized = value.strip().upper()
    if not normalized or normalized in {s.upper() for s in sentinels}:
        return fallback
    return value


def normalize_yes_no(value: str) -> str:
    """Fold the database's Y/N and Yes/No variants for the binary filters."""
    normalized = value.strip().upper()
    if normalized in {"Y", "YES"}:
        return "Yes"
    if normalized in {"N", "NO"}:
        return "No"
    return value


def clean_column_name(name: str) -> str:
    """Convert a database column name to its display label.

    A single-character word is never capitalized, in any position --
    confirmed against tools::toTitleCase directly: toTitleCase("v
    something") gives "v Something", not "V Something", and toTitleCase(
    "gene v") gives "Gene v". This is a length rule, not a stopword-list
    membership rule, so it applies even to the first word and even to a
    single-character word that isn't otherwise a stopword.
    """
    words = name.replace("_", " ").split()
    titled = [
        word.lower()
        if len(word) == 1 or (i > 0 and word.lower() in _TITLE_CASE_STOPWORDS)
        else word.capitalize()
        for i, word in enumerate(words)
    ]
    return " ".join(_ACRONYMS.get(word.lower(), word) for word in titled)


def extract_matches(value: str | None, pattern: re.Pattern[str]) -> list[str]:
    """Every regex match, in source order; an empty list when there are none.

    `pattern` must have no capturing groups. Like R's regmatches() plus
    gregexpr(), this is meant to return each full match; re.Pattern.findall()
    instead returns the captured group once a pattern has one (a tuple per
    match if it has more than one), which would silently change the return
    shape. The one real caller here -- a plain six-digit OMIM pattern -- has
    no groups.
    """
    if value is None:
        return []
    return pattern.findall(value)


def extract_pmids(value: str | None) -> list[str]:
    """Extract PubMed IDs without mistaking years or DOI fragments for them.

    Short IDs are accepted only when a PubMed URL, a PMID label, or an
    all-numeric cell makes their meaning explicit. Unlabelled prose keeps a
    seven-digit floor. The marker pass preserves source order across the two
    explicit forms and the bare-number scan.

    A cell that is one thousands-separated number is refused outright: it is
    a PMID list a spreadsheet has destroyed, not a list of short PMIDs.
    Returns an empty list when nothing matches.
    """
    if value is None:
        return []
    # Drop mangled runs before anything else, so what survives is only the
    # part of the cell that was never a spreadsheet-formatted number.
    value = _THOUSANDS_RUN.sub(" ", value)

    marked = _PUBMED_URL.sub(rf" {_MARKER}\1 ", value)
    marked = _LABELLED_PMID.sub(rf" {_MARKER}\1 ", marked)

    # Strip URLs and DOIs before scanning prose: DOI suffixes often carry
    # long numeric fragments that look like modern PMIDs.
    remainder = _URL.sub(" ", marked)
    remainder = _DOI_LABEL.sub(" ", remainder)
    remainder = _DOI_BARE.sub(" ", remainder)

    pattern = _ANY_NUMBER if _NUMERIC_LIST.match(remainder) else _MARKED_OR_LONG
    return list(
        dict.fromkeys(
            candidate.removeprefix(_MARKER) for candidate in pattern.findall(remainder)
        )
    )


def split_genetic_targets(targets: Iterable[str | None]) -> list[str]:
    """Split multi-target trial cells into unique gene symbols, in order.

    The N/A sentinel is removed before splitting: slash is also a delimiter,
    so "N/A" would otherwise yield two bogus symbols. The curated pair
    shorthand ("COL4A1/2") is expanded first for the same reason.
    """
    seen: dict[str, None] = {}
    for target in targets:
        if target is None or not target.strip():
            continue
        expanded = _PAIR_SHORTHAND.sub(r"\1\2/\1\3", _NA_WORD.sub("", target))
        for gene in _TARGET_SPLIT.split(expanded):
            stripped = gene.strip()
            if stripped.upper() not in _TARGET_SENTINELS:
                seen.setdefault(stripped, None)
    return list(seen)
