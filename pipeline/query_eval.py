"""Measure what the production PubMed query actually retrieves.

``SVD_QUERY`` is a hand-maintained constant. This module supplies the
instrument that says whether it is any good: an exact recall measurement
against a gold set of papers the query must find.

The gold set is the union of three sources. ``disease/recall_gold.csv`` is
the disease's own list (``pmid,note``), written by the maintainer and, for a
fork, by the new-disease skill's interview. The ``references`` of the
published gene table are what the dashboard already cites. The extraction
gold standard is the first disease's regression fixture and lives with the
suite that scores it; a fork deletes that tree, so it is read only when
present. ``disease/recall_baseline.json`` records the last live measurement
(``scripts/measure_recall.py --write-baseline``) and
``tests/pipeline/test_query_recall_gold.py`` replays it.
"""

import csv
import hashlib
import json
import logging
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from pipeline.config import NCBI_ESUMMARY_URL
from pipeline.disease import RECALL_BASELINE_PATH, RECALL_GOLD_PATH
from pipeline.http_client import AsyncHttpClientManager
from pipeline.ncbi_http import get_with_retry
from pipeline.pubmed_search import _configure_entrez, _run_entrez_search

logger = logging.getLogger(__name__)

_REPO_ROOT = Path(__file__).resolve().parents[1]
# The extraction gold standard is a regression fixture of the first disease and
# lives with the suite that scores it; a fork deletes that tree, so it is read
# only if present.
GOLD_STANDARD_CSV: Final[Path] = (
    _REPO_ROOT
    / "tests"
    / "pipeline"
    / "csvd"
    / "fixtures"
    / "gold_standard"
    / "gold_standard_v2.csv"
)
_TABLE1 = _REPO_ROOT / "data" / "table1.json"
RECALL_GOLD_CSV: Final[Path] = RECALL_GOLD_PATH
RECALL_BASELINE_JSON: Final[Path] = RECALL_BASELINE_PATH

# retmax is always passed explicitly. Entrez defaults it to 20, and the gold
# set is already larger than that, so relying on the default would drop
# matches and report the loss as a recall figure rather than as an error.
_DEFAULT_RETMAX: Final[int] = 500

# esummary accepts a comma-joined id list; NCBI documents no hard cap for a
# GET but URLs past a few thousand characters are refused, so titles are
# fetched in chunks.
_SUMMARY_CHUNK: Final[int] = 200

# PMIDs are numeric. Anything else in a reference list is the
# "(reference needed)" sentinel -- a preprint or in-submission paper with a
# DOI and no PMID -- which is a gap marker, not a citation, and would render
# as a malformed clause if interpolated into a [uid] disjunction.
_PMID_PATTERN: Final[re.Pattern[str]] = re.compile(r"\d{1,12}")

_client_manager = AsyncHttpClientManager()


@dataclass(frozen=True, slots=True)
class GoldRow:
    """One row of ``disease/recall_gold.csv``."""

    pmid: str
    note: str


def read_recall_gold(path: Path = RECALL_GOLD_CSV) -> tuple[GoldRow, ...]:
    """The disease's own gold list; a header-only file reads as empty."""
    with path.open(encoding="utf-8", newline="") as handle:
        rows = []
        for raw in csv.DictReader(handle):
            pmid = (raw.get("pmid") or "").strip()
            if not _PMID_PATTERN.fullmatch(pmid):
                raise ValueError(f"{path}: {pmid!r} is not a PubMed id")
            rows.append(GoldRow(pmid, (raw.get("note") or "").strip()))
    return tuple(rows)


def gold_pmids() -> tuple[str, ...]:
    """PMIDs the query must find, as the denominator for retrieval recall.

    The union of the disease's gold list, the ``references`` of the
    published gene table, and the extraction gold standard where it exists.
    All three are committed, so the denominator moves only when the dataset
    does -- and the baseline pins the count so that it is visible when it
    moves.
    """
    found = {row.pmid for row in read_recall_gold(RECALL_GOLD_CSV)}
    for gene in json.loads(_TABLE1.read_text(encoding="utf-8")):
        for pmid in gene.get("references") or ():
            found.add(str(pmid).strip())
    if GOLD_STANDARD_CSV.exists():
        with GOLD_STANDARD_CSV.open(encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                for pmid in row["pmid"].split(","):
                    found.add(pmid.strip())
    return tuple(sorted(p for p in found if _PMID_PATTERN.fullmatch(p)))


def uid_clause(pmids: Sequence[str]) -> str:
    """Render ``pmids`` as a PubMed ``[uid]`` disjunction.

    Empty in, empty out: a bare ``()`` is a syntax error at esearch, so the
    caller has to decide what an empty gold set means rather than send one.
    """
    return " OR ".join(f"{pmid}[uid]" for pmid in pmids)


def query_sha256(query: str) -> str:
    """The hash a baseline carries, so a changed query cannot replay it."""
    return hashlib.sha256(query.encode("utf-8")).hexdigest()


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


@dataclass(frozen=True, slots=True)
class Baseline:
    """The last live measurement, as ``disease/recall_baseline.json`` stores it."""

    total: int
    matched: int
    missed: tuple[str, ...]
    query_sha256: str
    measured_at: str


def read_baseline(path: Path = RECALL_BASELINE_JSON) -> Baseline | None:
    """The recorded baseline, or None when none has been written yet."""
    if not path.exists():
        return None
    raw = json.loads(path.read_text(encoding="utf-8"))
    return Baseline(
        total=int(raw["total"]),
        matched=int(raw["matched"]),
        missed=tuple(str(p) for p in raw["missed"]),
        query_sha256=str(raw["querySha256"]),
        measured_at=str(raw["measuredAt"]),
    )


def write_baseline(
    result: RecallResult,
    query: str,
    path: Path = RECALL_BASELINE_JSON,
    *,
    now: datetime | None = None,
) -> Baseline:
    """Record ``result`` for the replay test; returns what was written."""
    baseline = Baseline(
        total=result.total,
        matched=len(result.matched),
        missed=tuple(sorted(result.missed)),
        query_sha256=query_sha256(query),
        measured_at=(now or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ"),
    )
    payload = {
        "$comment": (
            "Written by scripts/measure_recall.py --write-baseline; replayed by "
            "tests/pipeline/test_query_recall_gold.py against its cassette."
        ),
        "measuredAt": baseline.measured_at,
        "querySha256": baseline.query_sha256,
        "total": baseline.total,
        "matched": baseline.matched,
        "missed": list(baseline.missed),
    }
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return baseline


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


async def fetch_titles(pmids: Sequence[str]) -> dict[str, str]:
    """Titles by PMID from esummary, for the measurement's printout.

    Best-effort: a chunk NCBI does not answer is logged and its PMIDs are
    simply absent from the result, so the caller prints a placeholder rather
    than losing the measurement to a title lookup.
    """
    titles: dict[str, str] = {}
    client = await _client_manager.get()
    for start in range(0, len(pmids), _SUMMARY_CHUNK):
        chunk = pmids[start : start + _SUMMARY_CHUNK]
        resp = await get_with_retry(
            client,
            NCBI_ESUMMARY_URL,
            {"db": "pubmed", "id": ",".join(chunk), "retmode": "json"},
            context=f"esummary for {len(chunk)} gold PMIDs",
        )
        if resp is None or resp.status_code != 200:
            logger.warning(
                "No titles for %d PMIDs: esummary did not answer", len(chunk)
            )
            continue
        result: dict[str, Any] = resp.json().get("result", {})
        for pmid in chunk:
            entry = result.get(pmid)
            if isinstance(entry, dict) and isinstance(entry.get("title"), str):
                titles[pmid] = entry["title"]
    return titles


async def close_http_client() -> None:
    """Release the esummary client; scripts call this before exiting."""
    await _client_manager.close()
