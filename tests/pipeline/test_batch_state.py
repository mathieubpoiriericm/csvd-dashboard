import logging
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
