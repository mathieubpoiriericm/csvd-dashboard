from pathlib import Path

from pipeline.batch_state import PendingBatch, clear, load, save

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


def test_clear_is_silent_when_nothing_is_there(tmp_path) -> None:
    clear(str(tmp_path / "absent.json"))


def test_clear_removes_a_saved_file(tmp_path) -> None:
    path = tmp_path / "b.json"
    save(str(path), FP, [PendingBatch("msgbatch_1", {})])
    clear(str(path))
    assert not path.exists()
