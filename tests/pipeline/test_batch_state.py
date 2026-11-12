import logging
import time
from pathlib import Path

import pytest

from pipeline.batch_state import PendingBatch, forget, load, save

FP = {"model": "m", "effort": "high"}


def test_a_saved_batch_loads_under_the_same_fingerprint(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    pending = PendingBatch(batch_id="msgbatch_1", document_sha256={"111": "ab"})
    save(path, FP, [pending])
    assert load(path, FP) == [pending]


def test_two_batches_round_trip_in_order(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    first = PendingBatch("msgbatch_1", {"111": "ab"})
    second = PendingBatch("msgbatch_2", {"222": "cd", "333": "ef"})
    save(path, FP, [first, second])
    assert load(path, FP) == [first, second]


def test_save_replaces_the_whole_file_and_makes_the_directory(tmp_path) -> None:
    path = str(tmp_path / "logs" / "b.json")
    save(path, FP, [PendingBatch("msgbatch_1", {"111": "ab"})])
    only = PendingBatch("msgbatch_2", {"222": "cd"})
    save(path, FP, [only])
    assert load(path, FP) == [only]
    assert [p.name for p in Path(path).parent.iterdir()] == ["b.json"]


def test_a_different_fingerprint_discards_the_file(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    save(path, FP, [PendingBatch("msgbatch_1", {"111": "ab"})])
    assert load(path, {**FP, "effort": "medium"}) == []
    assert not Path(path).exists()


def test_a_corrupt_file_is_discarded_not_raised(tmp_path) -> None:
    path = tmp_path / "b.json"
    path.write_text("{not json")
    assert load(str(path), FP) == []
    assert not path.exists()


def test_a_well_formed_file_of_the_wrong_shape_is_discarded(tmp_path) -> None:
    path = tmp_path / "b.json"
    path.write_text('{"fingerprint": {"model": "m", "effort": "high"}, "pending": 3}')
    assert load(str(path), FP) == []
    assert not path.exists()


def test_a_missing_file_loads_as_nothing(tmp_path) -> None:
    assert load(str(tmp_path / "absent.json"), FP) == []


def test_a_discarded_file_names_the_batches_it_held(tmp_path, caplog) -> None:
    """The papers of a discarded batch will be paid for again; the log has
    to say which batch that was, or nobody can retrieve it by hand."""
    path = str(tmp_path / "b.json")
    save(path, FP, [PendingBatch("msgbatch_1", {"111": "ab"})])
    with caplog.at_level(logging.WARNING):
        assert load(path, {**FP, "effort": "medium"}) == []
    assert "msgbatch_1" in caplog.text


def test_a_file_that_cannot_be_deleted_still_loads_as_nothing(
    tmp_path, monkeypatch
) -> None:
    path = tmp_path / "b.json"
    path.write_text("{not json")

    def refuse(self, missing_ok=False):
        raise PermissionError("read-only")

    monkeypatch.setattr(Path, "unlink", refuse)
    assert load(str(path), FP) == []


def test_forget_removes_the_papers_from_every_record(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    save(
        path,
        FP,
        [
            PendingBatch("msgbatch_1", {"111": "ab", "222": "cd"}),
            PendingBatch("msgbatch_2", {"111": "ef", "333": "gh"}),
        ],
    )
    forget(path, FP, ["111", "333"])
    assert load(path, FP) == [PendingBatch("msgbatch_1", {"222": "cd"})]


def test_forget_deletes_the_file_when_no_record_remains(tmp_path) -> None:
    path = tmp_path / "b.json"
    save(str(path), FP, [PendingBatch("msgbatch_1", {"111": "ab"})])
    forget(str(path), FP, {"111"})
    assert not path.exists()


def test_forget_leaves_a_record_it_has_nothing_to_take_from(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    kept = PendingBatch("msgbatch_1", {"111": "ab"})
    save(path, FP, [kept])
    forget(path, FP, ["999"])
    assert load(path, FP) == [kept]


def test_forget_is_silent_when_nothing_is_there(tmp_path) -> None:
    forget(str(tmp_path / "absent.json"), FP, ["111"])


def test_forget_is_silent_over_a_corrupt_file(tmp_path) -> None:
    path = tmp_path / "b.json"
    path.write_text("{not json")
    forget(str(path), FP, ["111"])
    assert not path.exists()


@pytest.mark.parametrize("operation", ["unlink", "replace"])
def test_forget_never_raises_when_it_cannot_write(
    tmp_path, monkeypatch, operation
) -> None:
    path = str(tmp_path / "b.json")
    save(path, FP, [PendingBatch("msgbatch_1", {"111": "ab", "222": "cd"})])

    def refuse(*args, **kwargs):
        raise PermissionError("read-only")

    if operation == "unlink":
        monkeypatch.setattr(Path, "unlink", refuse)
        forget(path, FP, ["111", "222"])
    else:
        monkeypatch.setattr("pipeline.batch_state.os.replace", refuse)
        forget(path, FP, ["111"])


_DAY = 24 * 60 * 60
_NOW = 1_800_000_000.0


def _aged(batch_id: str, days: float, pmid: str = "111") -> PendingBatch:
    return PendingBatch(batch_id, {pmid: "ab"}, submitted_at=_NOW - days * _DAY)


def test_submitted_at_round_trips_through_save_and_load(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    batch = PendingBatch("msgbatch_1", {"111": "ab"}, submitted_at=_NOW - 5.5)
    save(path, FP, [batch])
    assert load(path, FP, now=_NOW) == [batch]


def test_a_file_written_before_submitted_at_still_loads(tmp_path) -> None:
    path = tmp_path / "b.json"
    path.write_text(
        '{"fingerprint": {"model": "m", "effort": "high"}, '
        '"pending": [{"batch_id": "msgbatch_1", "document_sha256": {"111": "ab"}}]}'
    )
    assert load(str(path), FP, now=_NOW) == [PendingBatch("msgbatch_1", {"111": "ab"})]


def test_a_batch_older_than_the_api_keeps_results_is_dropped_and_gone_from_the_file(
    tmp_path, caplog
) -> None:
    path = str(tmp_path / "b.json")
    stale, fresh = _aged("msgbatch_stale", 30), _aged("msgbatch_fresh", 1, "222")
    save(path, FP, [stale, fresh])

    with caplog.at_level(logging.INFO):
        assert load(path, FP, now=_NOW) == [fresh]

    assert caplog.text.count("msgbatch_stale") == 1
    assert "msgbatch_stale" not in Path(path).read_text()
    assert load(path, FP, now=_NOW) == [fresh]


def test_a_batch_of_28_days_is_still_returned(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    batch = _aged("msgbatch_1", 28)
    save(path, FP, [batch])
    assert load(path, FP, now=_NOW) == [batch]


def test_a_batch_with_no_submitted_at_is_kept_however_old_the_clock_says(
    tmp_path,
) -> None:
    path = str(tmp_path / "b.json")
    batch = PendingBatch("msgbatch_1", {"111": "ab"})
    save(path, FP, [batch])
    assert load(path, FP, now=_NOW + 400 * _DAY) == [batch]


def test_a_file_whose_every_batch_is_stale_is_deleted(tmp_path) -> None:
    path = tmp_path / "b.json"
    save(str(path), FP, [_aged("msgbatch_1", 40), _aged("msgbatch_2", 31, "222")])
    assert load(str(path), FP, now=_NOW) == []
    assert not path.exists()


def test_a_file_that_cannot_be_rewritten_still_loads_without_the_stale_batch(
    tmp_path, monkeypatch
) -> None:
    path = str(tmp_path / "b.json")
    fresh = _aged("msgbatch_fresh", 1, "222")
    save(path, FP, [_aged("msgbatch_stale", 30), fresh])

    def refuse(*args, **kwargs):
        raise PermissionError("read-only")

    monkeypatch.setattr("pipeline.batch_state.os.replace", refuse)
    assert load(path, FP, now=_NOW) == [fresh]


def test_forget_keeps_submitted_at_on_the_records_it_writes_back(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    stamp = time.time() - 3 * _DAY
    save(
        path,
        FP,
        [PendingBatch("msgbatch_1", {"111": "ab", "222": "cd"}, submitted_at=stamp)],
    )
    forget(path, FP, ["111"])
    assert load(path, FP) == [PendingBatch("msgbatch_1", {"222": "cd"}, stamp)]


def test_a_save_that_fails_leaves_no_temporary_file_and_raises(
    tmp_path, monkeypatch
) -> None:
    path = tmp_path / "b.json"

    def refuse(*args, **kwargs):
        raise PermissionError("read-only")

    monkeypatch.setattr("pipeline.batch_state.os.replace", refuse)
    with pytest.raises(PermissionError):
        save(str(path), FP, [PendingBatch("msgbatch_1", {"111": "ab"})])

    assert list(tmp_path.iterdir()) == []
