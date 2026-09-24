"""Replay the recorded recall measurement against disease/recall_baseline.json.

Generic twin of tests/pipeline/csvd/test_query_recall.py, which pins the
first disease's numbers. A fork records its own cassette on the first live
measurement (see the new-disease skill):

    uv run python -m scripts.measure_recall --write-baseline
    uv run pytest tests/pipeline/test_query_recall_gold.py --record-mode=once

Until disease/recall_gold.csv has rows, or the baseline is written, the
replay tests skip and say which of the two is missing.
"""

import re
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
import yaml

import pipeline.pubmed_search as pubmed_search
from pipeline.pubmed_search import SVD_QUERY
from pipeline.query_eval import (
    RECALL_BASELINE_JSON,
    Baseline,
    esearch_pmids,
    gold_pmids,
    measure_recall,
    query_sha256,
    read_baseline,
    read_recall_gold,
    uid_clause,
)

_HERE = Path(__file__).parent
_CASSETTE = (
    _HERE
    / "cassettes"
    / "test_query_recall_gold"
    / "test_the_query_recall_matches_the_recorded_baseline.yaml"
)
# "email=" / "api_key=" followed by anything that is not the redaction
# placeholder and not the end of the value.
_CREDENTIAL_LEAK = re.compile(r"(?:email|api_key)=(?!REDACTED\b)([^&\s\"']+)")


@pytest.fixture(autouse=True)
def _entrez_contact(monkeypatch: pytest.MonkeyPatch) -> None:
    """Supply the contact address NCBI policy requires; the conftest clears it."""
    monkeypatch.setenv("ENTREZ_EMAIL", "pipeline-tests@example.org")
    monkeypatch.setattr(pubmed_search, "_entrez_configured", False)


def _gold_and_baseline() -> tuple[tuple[str, ...], Baseline]:
    if not read_recall_gold():
        pytest.skip("disease/recall_gold.csv has no rows yet")
    baseline = read_baseline(RECALL_BASELINE_JSON)
    if baseline is None:
        pytest.skip(
            "disease/recall_baseline.json not written yet -- run "
            "`uv run python -m scripts.measure_recall --write-baseline`"
        )
    return gold_pmids(), baseline


def test_no_committed_cassette_carries_an_entrez_credential() -> None:
    """Scrubbing has to cover request *bodies*, not just query strings.

    Biopython posts instead of getting once a query grows past a length
    threshold, and the recall request is long enough to cross it.
    `filter_query_parameters` rewrites a URL and never looks at a body, so
    it silently protects the short request and not the long ones -- the
    failure mode being that the guard appears to work.

    Scans every cassette under tests/pipeline, the csvd/ tree's included, so
    any future Entrez recording inherits the check.
    """
    leaked = {
        f"{path.relative_to(_HERE)}: {match.group(0)}"
        for path in sorted(_HERE.rglob("cassettes/**/*.yaml"))
        for match in _CREDENTIAL_LEAK.finditer(path.read_text(encoding="utf-8"))
    }
    assert not leaked, f"credentials in committed cassettes: {sorted(leaked)}"


def test_the_baseline_was_measured_against_the_current_query() -> None:
    """A widened query cannot replay the old answer as its own."""
    _, baseline = _gold_and_baseline()
    assert baseline.query_sha256 == query_sha256(SVD_QUERY), (
        "the query changed since the baseline was measured -- re-run "
        "`scripts.measure_recall --write-baseline`, then rm the cassette and "
        "re-record with --record-mode=once"
    )


def _assert_same_gold_set(gold: tuple[str, ...], baseline: Baseline) -> None:
    assert baseline.total == len(gold), (
        f"the gold set changed: the baseline was measured over {baseline.total} "
        f"PMIDs and gold_pmids() now yields {len(gold)}. It counts every PMID "
        "data/table1.json cites, so an export that adds a reference moves it; "
        "measure again and record the cassettes afresh: "
        "`uv run python -m scripts.measure_recall --write-baseline`, "
        "`rm -r tests/pipeline/cassettes/test_query_recall_gold`, then "
        "`uv run pytest tests/pipeline/test_query_recall_gold.py "
        "--record-mode=once`"
    )
    assert set(baseline.missed) <= set(gold)


def test_the_baseline_denominator_is_the_current_gold_set() -> None:
    _assert_same_gold_set(*_gold_and_baseline())


def test_a_moved_denominator_says_how_to_measure_it_again() -> None:
    """gold_pmids() counts every PMID data/table1.json cites, so the first
    export after a fork's measurement moves it -- and so can any run after.
    Nothing else says it has moved, so the failure carries the remedy
    rather than only the two counts."""
    baseline = Baseline(total=2, matched=2, missed=(), query_sha256="", measured_at="")
    with pytest.raises(AssertionError) as failure:
        _assert_same_gold_set(("1", "2", "3"), baseline)
    message = str(failure.value)
    assert "measured over 2 PMIDs and gold_pmids() now yields 3" in message
    assert "data/table1.json" in message
    assert "uv run python -m scripts.measure_recall --write-baseline" in message
    assert "rm -r tests/pipeline/cassettes/test_query_recall_gold" in message
    assert (
        "uv run pytest tests/pipeline/test_query_recall_gold.py "
        "--record-mode=once" in message
    )


@pytest.mark.vcr
async def test_the_query_recall_matches_the_recorded_baseline() -> None:
    gold, baseline = _gold_and_baseline()
    result = await measure_recall(SVD_QUERY, gold)
    assert result.total == baseline.total
    assert len(result.matched) == baseline.matched
    assert result.missed == frozenset(baseline.missed)


@pytest.mark.vcr
async def test_pubmed_returns_every_gold_pmid_when_asked_by_uid() -> None:
    """The control: PubMed knows every gold PMID, so a miss is the query's."""
    gold, _ = _gold_and_baseline()
    returned = await esearch_pmids(uid_clause(gold), retmax=len(gold))
    assert returned == frozenset(gold)


def _recorded_terms(cassette: Path) -> list[str]:
    """The ``term`` of each request in a cassette, from body or query string.

    Biopython POSTs a long query and GETs a short one; both forms are read.
    """
    data = yaml.safe_load(cassette.read_text(encoding="utf-8"))
    terms = []
    for interaction in data["interactions"]:
        request = interaction["request"]
        raw = request["body"] or urlsplit(request["uri"]).query
        text = raw.decode() if isinstance(raw, bytes) else raw
        terms.append(parse_qs(text)["term"][0])
    return terms


def test_the_recorded_recall_request_carries_the_current_query() -> None:
    """VCR matches on method and URI, never on a POST body, so a widened
    query would replay the old answer. This pins the recorded term to the
    request the code sends today."""
    gold, _ = _gold_and_baseline()
    if not _CASSETTE.exists():
        pytest.skip("the recall cassette is not recorded yet")
    (term,) = _recorded_terms(_CASSETTE)
    assert term == f"({SVD_QUERY}) AND ({uid_clause(gold)})", (
        "rm the cassette and re-run with --record-mode=once"
    )
