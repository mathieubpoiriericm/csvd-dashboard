"""pipeline.query_eval: the gold set, the uid clause, recall, the baseline.

Every test here is disease-neutral. The cSVD measurement itself -- 106 of
111, the five misses and the anchor ceiling -- is
tests/pipeline/csvd/test_query_recall.py.
"""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from pipeline import query_eval
from pipeline.query_eval import (
    Baseline,
    GoldRow,
    RecallResult,
    esearch_pmids,
    fetch_titles,
    gold_pmids,
    measure_recall,
    query_sha256,
    read_baseline,
    read_recall_gold,
    uid_clause,
    write_baseline,
)

_NOW = datetime(2026, 9, 20, 12, 0, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# The gold set
# ---------------------------------------------------------------------------


def test_read_recall_gold_parses_pmid_and_note(tmp_path: Path) -> None:
    path = tmp_path / "recall_gold.csv"
    path.write_text("pmid,note\n12345678,anchor paper\n 87654321 ,\n", encoding="utf-8")
    assert read_recall_gold(path) == (
        GoldRow("12345678", "anchor paper"),
        GoldRow("87654321", ""),
    )


def test_read_recall_gold_rejects_a_non_numeric_pmid(tmp_path: Path) -> None:
    path = tmp_path / "recall_gold.csv"
    path.write_text("pmid,note\nPMC123,\n", encoding="utf-8")
    with pytest.raises(ValueError, match="PMC123"):
        read_recall_gold(path)


def test_read_recall_gold_of_a_header_only_file_is_empty(tmp_path: Path) -> None:
    path = tmp_path / "recall_gold.csv"
    path.write_text("pmid,note\n", encoding="utf-8")
    assert read_recall_gold(path) == ()


def test_the_committed_recall_gold_is_well_formed() -> None:
    rows = read_recall_gold()
    assert len({r.pmid for r in rows}) == len(rows)


def test_gold_pmids_is_the_union_of_the_three_sources(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    gold = tmp_path / "recall_gold.csv"
    gold.write_text("pmid,note\n1,\n", encoding="utf-8")
    table1 = tmp_path / "table1.json"
    table1.write_text('[{"references": ["2", "(reference needed)"]}]', encoding="utf-8")
    standard = tmp_path / "gold_standard_v2.csv"
    standard.write_text('"gene","pmid"\n"X","3, 1"\n', encoding="utf-8")
    monkeypatch.setattr(query_eval, "RECALL_GOLD_CSV", gold)
    monkeypatch.setattr(query_eval, "_TABLE1", table1)
    monkeypatch.setattr(query_eval, "GOLD_STANDARD_CSV", standard)
    assert gold_pmids() == ("1", "2", "3")


def test_gold_pmids_tolerates_a_missing_gold_standard_csv(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A fork deletes the csvd/ tree the gold standard lives in."""
    gold = tmp_path / "recall_gold.csv"
    gold.write_text("pmid,note\n5,\n", encoding="utf-8")
    table1 = tmp_path / "table1.json"
    table1.write_text("[]", encoding="utf-8")
    monkeypatch.setattr(query_eval, "RECALL_GOLD_CSV", gold)
    monkeypatch.setattr(query_eval, "_TABLE1", table1)
    monkeypatch.setattr(query_eval, "GOLD_STANDARD_CSV", tmp_path / "absent.csv")
    assert gold_pmids() == ("5",)


def test_gold_pmids_are_all_numeric_pmids() -> None:
    """A "(reference needed)" sentinel in a reference list never reaches the
    uid clause, where it would render as a malformed term."""
    assert all(pmid.isdigit() for pmid in gold_pmids())


# ---------------------------------------------------------------------------
# The uid clause and the result
# ---------------------------------------------------------------------------


def test_uid_clause_renders_a_pubmed_uid_disjunction() -> None:
    """``[uid]`` is what makes the recall measurement exact.

    Intersecting a query with this clause asks PubMed to report which of a
    known set the query matches, in one request -- instead of paging the whole
    result set and hoping it fits under the 9,999-record cap.
    """
    assert uid_clause(["123", "456"]) == "123[uid] OR 456[uid]"


def test_uid_clause_of_no_pmids_is_empty() -> None:
    """An empty clause must not render as ``()``, which PubMed rejects."""
    assert uid_clause([]) == ""


def test_recall_result_splits_the_gold_set_into_matched_and_missed() -> None:
    result = RecallResult.of(gold=["1", "2", "3", "4"], matched=["1", "3"])
    assert result.matched == frozenset({"1", "3"})
    assert result.missed == frozenset({"2", "4"})
    assert result.total == 4
    assert result.recall == 0.5


def test_recall_result_ignores_pmids_returned_that_were_not_asked_for() -> None:
    """Recall is a fraction of the gold set, so a stray hit cannot exceed 1.0.

    PubMed will not invent a PMID outside the ``[uid]`` clause, but a caller
    passing a mismatched pair should get a wrong-looking number rather than a
    recall above 1.0 that reads as success.
    """
    result = RecallResult.of(gold=["1", "2"], matched=["1", "999"])
    assert result.matched == frozenset({"1"})
    assert result.recall == 0.5


def test_recall_of_an_empty_gold_set_is_zero_not_an_error() -> None:
    """Nothing to find is not the same as everything found."""
    assert RecallResult.of(gold=[], matched=[]).recall == 0.0


async def test_measuring_recall_over_no_pmids_asks_pubmed_nothing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty gold set is answered locally, not by a malformed query.

    ``uid_clause(())`` is the empty string, so the term would render as
    ``(query) AND ()`` -- a syntax error at esearch. Short-circuiting also
    keeps the function honest offline: no cassette, no network, no request.
    """

    async def _fail_if_called(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("measure_recall contacted PubMed for an empty set")

    monkeypatch.setattr(query_eval, "esearch_pmids", _fail_if_called)
    result = await measure_recall("anything", [])
    assert result.total == 0
    assert result.recall == 0.0


async def test_measure_recall_intersects_the_query_with_the_uid_clause(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: list[tuple[str, int]] = []

    async def fake(term: str, *, retmax: int) -> frozenset[str]:
        seen.append((term, retmax))
        return frozenset({"1", "9"})

    monkeypatch.setattr(query_eval, "esearch_pmids", fake)
    result = await measure_recall("disease[tiab]", ("1", "2"))
    assert seen == [("(disease[tiab]) AND (1[uid] OR 2[uid])", 2)]
    assert result.matched == {"1"}
    assert result.missed == {"2"}


async def test_esearch_pmids_returns_the_id_list_as_a_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_search(**kwargs: object) -> dict[str, list[str]]:
        assert kwargs == {"db": "pubmed", "term": "x", "retmax": 7, "retmode": "xml"}
        return {"IdList": ["1", "2", "2"]}

    monkeypatch.setattr(query_eval, "_configure_entrez", lambda: None)
    monkeypatch.setattr(query_eval, "_run_entrez_search", fake_search)
    assert await esearch_pmids("x", retmax=7) == frozenset({"1", "2"})


# ---------------------------------------------------------------------------
# The baseline
# ---------------------------------------------------------------------------


def test_baseline_round_trips_through_json(tmp_path: Path) -> None:
    result = RecallResult.of(gold=("1", "2", "3"), matched=("1", "3"))
    written = write_baseline(result, "q", tmp_path / "b.json", now=_NOW)
    assert written == Baseline(
        total=3,
        matched=2,
        missed=("2",),
        query_sha256=query_sha256("q"),
        measured_at="2026-09-20T12:00:00Z",
    )
    assert read_baseline(tmp_path / "b.json") == written


def test_read_baseline_is_none_when_nothing_was_written(tmp_path: Path) -> None:
    assert read_baseline(tmp_path / "absent.json") is None


def test_write_baseline_stamps_now_by_default(tmp_path: Path) -> None:
    before = datetime.now(UTC).replace(microsecond=0)
    written = write_baseline(RecallResult.of(gold=(), matched=()), "q", tmp_path / "b")
    stamped = datetime.strptime(written.measured_at, "%Y-%m-%dT%H:%M:%SZ")
    assert stamped.replace(tzinfo=UTC) >= before


# ---------------------------------------------------------------------------
# Titles
# ---------------------------------------------------------------------------


class _Response:
    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> dict:
        return self._payload


async def test_fetch_titles_reads_esummary_in_chunks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, str]] = []

    async def fake_get(client, url, params, *, config=None, context=""):  # noqa: ANN001
        calls.append(params)
        ids = params["id"].split(",")
        return _Response(200, {"result": {i: {"title": f"T{i}"} for i in ids}})

    async def fake_client() -> object:
        return object()

    monkeypatch.setattr(query_eval, "get_with_retry", fake_get)
    monkeypatch.setattr(query_eval._client_manager, "get", fake_client)
    monkeypatch.setattr(query_eval, "_SUMMARY_CHUNK", 2)

    titles = await fetch_titles(("1", "2", "3"))

    assert titles == {"1": "T1", "2": "T2", "3": "T3"}
    assert [c["id"] for c in calls] == ["1,2", "3"]
    assert all(c["db"] == "pubmed" and c["retmode"] == "json" for c in calls)


async def test_fetch_titles_skips_a_chunk_ncbi_did_not_answer(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    answers = iter(
        [None, _Response(503, {}), _Response(200, {"result": {"5": {"title": "T5"}}})]
    )

    async def fake_get(client, url, params, *, config=None, context=""):  # noqa: ANN001
        return next(answers)

    async def fake_client() -> object:
        return object()

    monkeypatch.setattr(query_eval, "get_with_retry", fake_get)
    monkeypatch.setattr(query_eval._client_manager, "get", fake_client)
    monkeypatch.setattr(query_eval, "_SUMMARY_CHUNK", 1)

    with caplog.at_level("WARNING", logger="pipeline.query_eval"):
        titles = await fetch_titles(("3", "4", "5"))

    assert titles == {"5": "T5"}
    assert caplog.text.count("esummary did not answer") == 2


async def test_fetch_titles_ignores_an_entry_without_a_title(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_get(client, url, params, *, config=None, context=""):  # noqa: ANN001
        return _Response(200, {"result": {"1": {"error": "gone"}, "uids": ["1"]}})

    async def fake_client() -> object:
        return object()

    monkeypatch.setattr(query_eval, "get_with_retry", fake_get)
    monkeypatch.setattr(query_eval._client_manager, "get", fake_client)
    assert await fetch_titles(("1",)) == {}


async def test_close_http_client_closes_the_shared_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed = []

    async def fake_close() -> None:
        closed.append(True)

    monkeypatch.setattr(query_eval._client_manager, "close", fake_close)
    await query_eval.close_http_client()
    assert closed == [True]
