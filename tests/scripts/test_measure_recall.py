"""scripts/measure_recall.py: the live recall printout and the baseline write."""

import json
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from scripts import measure_recall

from pipeline.query_eval import RecallResult


@dataclass
class _FakePubmed:
    root: Path
    closed: list[bool] = field(default_factory=list)


@pytest.fixture
def fake_pubmed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> _FakePubmed:
    fake = _FakePubmed(tmp_path)

    async def fake_measure(query: str, pmids: tuple[str, ...]) -> RecallResult:
        assert query
        return RecallResult.of(gold=pmids, matched=("1",))

    async def fake_titles(pmids: tuple[str, ...]) -> dict[str, str]:
        return {"1": "Found paper", "2": "Missed paper"}

    async def fake_close() -> None:
        fake.closed.append(True)

    monkeypatch.setattr(measure_recall, "measure_recall", fake_measure)
    monkeypatch.setattr(measure_recall, "fetch_titles", fake_titles)
    monkeypatch.setattr(measure_recall, "close_http_client", fake_close)
    monkeypatch.setattr(measure_recall, "gold_pmids", lambda: ("1", "2", "3"))
    monkeypatch.setattr(measure_recall, "RECALL_BASELINE_JSON", tmp_path / "b.json")
    monkeypatch.setattr(measure_recall, "PROJECT_ROOT", tmp_path)
    return fake


def test_prints_matched_and_missed_with_titles(
    fake_pubmed: _FakePubmed, capsys: pytest.CaptureFixture[str]
) -> None:
    assert measure_recall.main([]) == 0
    out = capsys.readouterr().out
    assert "Recall: 1 of 3" in out
    assert "Matched (1):" in out
    assert "  1  Found paper" in out
    assert "Missed (2):" in out
    assert "  2  Missed paper" in out
    assert "  3  (title unavailable)" in out
    assert not (fake_pubmed.root / "b.json").exists()
    assert fake_pubmed.closed == [True]


def test_write_baseline_writes_the_json(
    fake_pubmed: _FakePubmed, capsys: pytest.CaptureFixture[str]
) -> None:
    assert measure_recall.main(["--write-baseline"]) == 0
    written = json.loads((fake_pubmed.root / "b.json").read_text(encoding="utf-8"))
    assert written["total"] == 3
    assert written["matched"] == 1
    assert written["missed"] == ["2", "3"]
    assert "Wrote b.json" in capsys.readouterr().out


def test_an_empty_gold_set_is_reported_not_measured(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(measure_recall, "gold_pmids", lambda: ())
    assert measure_recall.main([]) == 1
    assert "recall_gold.csv" in capsys.readouterr().err
