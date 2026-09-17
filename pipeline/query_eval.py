"""Measure what the production PubMed query actually retrieves.

``SVD_QUERY`` is a hand-maintained constant. This module supplies the
instrument that says whether it is any good: an exact recall measurement
against the papers the dashboard itself cites.
"""

import csv
import json
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from pipeline.pubmed_search import _configure_entrez, _run_entrez_search

_REPO_ROOT = Path(__file__).resolve().parents[1]
_GOLD_CSV = _REPO_ROOT / "data" / "test_data" / "gold_standard" / "gold_standard_v2.csv"
_TABLE1 = _REPO_ROOT / "data" / "table1.json"

# retmax is always passed explicitly. Entrez defaults it to 20, and the gold
# set is already larger than that, so relying on the default would drop
# matches and report the loss as a recall figure rather than as an error.
_DEFAULT_RETMAX: Final[int] = 500

# PMIDs are numeric. Anything else in a reference list is the
# "(reference needed)" sentinel -- a preprint or in-submission paper with a
# DOI and no PMID -- which is a gap marker, not a citation, and would render
# as a malformed clause if interpolated into a [uid] disjunction.
_PMID_PATTERN: Final[re.Pattern[str]] = re.compile(r"\d{1,12}")


def gold_pmids() -> tuple[str, ...]:
    """PMIDs the dashboard cites, as the denominator for retrieval recall.

    The union of the extraction gold standard and the ``references`` of the
    published gene table. Both are committed, so the denominator moves only
    when the dataset does -- and a test pins the count so that it is visible
    when it moves.
    """
    found: set[str] = set()
    with _GOLD_CSV.open(encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            for pmid in row["pmid"].split(","):
                found.add(pmid.strip())
    for gene in json.loads(_TABLE1.read_text(encoding="utf-8")):
        for pmid in gene.get("references") or ():
            found.add(str(pmid).strip())
    return tuple(sorted(p for p in found if _PMID_PATTERN.fullmatch(p)))


def uid_clause(pmids: Sequence[str]) -> str:
    """Render ``pmids`` as a PubMed ``[uid]`` disjunction.

    Empty in, empty out: a bare ``()`` is a syntax error at esearch, so the
    caller has to decide what an empty gold set means rather than send one.
    """
    return " OR ".join(f"{pmid}[uid]" for pmid in pmids)


@dataclass(frozen=True, slots=True)
class RecallResult:
    """Which of a known set of PMIDs a query retrieved, and which it did not."""

    matched: frozenset[str]
    missed: frozenset[str]

    @classmethod
    def of(cls, gold: Iterable[str], matched: Iterable[str]) -> RecallResult:
        """Build a result, keeping only hits that were actually asked for."""
        wanted = frozenset(gold)
        hit = wanted & frozenset(matched)
        return cls(matched=hit, missed=wanted - hit)

    @property
    def total(self) -> int:
        return len(self.matched) + len(self.missed)

    @property
    def recall(self) -> float:
        """Matched fraction of the gold set; 0.0 when there is nothing to find."""
        return len(self.matched) / self.total if self.total else 0.0


async def esearch_pmids(term: str, *, retmax: int = _DEFAULT_RETMAX) -> frozenset[str]:
    """PMIDs matching ``term``, as a set.

    Thin wrapper over the ingestion module's Entrez plumbing so credential
    handling and the off-loop threading live in exactly one place.
    """
    _configure_entrez()
    results = await _run_entrez_search(
        db="pubmed", term=term, retmax=retmax, retmode="xml"
    )
    return frozenset(results.get("IdList", []))


async def measure_recall(query: str, pmids: Sequence[str]) -> RecallResult:
    """Which of ``pmids`` ``query`` retrieves, measured exactly.

    Intersects the query with a ``[uid]`` disjunction of the gold set, so
    PubMed does the set arithmetic and returns at most ``len(pmids)`` records.
    The 9,999-record esearch cap is unreachable by construction: it bounds the
    *result set*, and this result set can never exceed the gold set.
    """
    if not pmids:
        return RecallResult.of(gold=(), matched=())
    matched = await esearch_pmids(
        f"({query}) AND ({uid_clause(pmids)})", retmax=len(pmids)
    )
    return RecallResult.of(gold=pmids, matched=matched)
