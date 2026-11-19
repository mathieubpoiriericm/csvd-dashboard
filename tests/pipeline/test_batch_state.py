import hashlib
import json
import logging
import os
import random
import time
from pathlib import Path

import pytest

from pipeline.batch_extraction import _claim_pending
from pipeline.batch_state import (
    PRUNE_MARGIN_SECONDS,
    RESULTS_RETENTION_SECONDS,
    PendingBatch,
    _dated,
    forget,
    load,
    save,
)

FP = {"model": "m", "effort": "high"}
# A date for the records of tests that are not about age: `load` gives an
# undated record one, so only a dated record comes back as it was saved.
_RECENT = time.time()


def test_a_saved_batch_loads_under_the_same_fingerprint(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    pending = PendingBatch(
        batch_id="msgbatch_1", document_sha256={"111": "ab"}, submitted_at=_RECENT
    )
    save(path, FP, [pending])
    assert load(path, FP) == [pending]


def test_two_batches_round_trip_in_order(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    first = PendingBatch("msgbatch_1", {"111": "ab"}, _RECENT)
    second = PendingBatch("msgbatch_2", {"222": "cd", "333": "ef"}, _RECENT)
    save(path, FP, [first, second])
    assert load(path, FP) == [first, second]


def test_save_replaces_the_whole_file_and_makes_the_directory(tmp_path) -> None:
    path = str(tmp_path / "logs" / "b.json")
    save(path, FP, [PendingBatch("msgbatch_1", {"111": "ab"})])
    only = PendingBatch("msgbatch_2", {"222": "cd"}, _RECENT)
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
            PendingBatch("msgbatch_1", {"111": "ab", "222": "cd"}, _RECENT),
            PendingBatch("msgbatch_2", {"111": "ef", "333": "gh"}, _RECENT),
        ],
    )
    forget(path, FP, ["111", "333"])
    assert load(path, FP) == [PendingBatch("msgbatch_1", {"222": "cd"}, _RECENT)]


def test_forget_deletes_the_file_when_no_record_remains(tmp_path) -> None:
    path = tmp_path / "b.json"
    save(str(path), FP, [PendingBatch("msgbatch_1", {"111": "ab"})])
    forget(str(path), FP, {"111"})
    assert not path.exists()


def test_forget_leaves_a_record_it_has_nothing_to_take_from(tmp_path) -> None:
    path = str(tmp_path / "b.json")
    kept = PendingBatch("msgbatch_1", {"111": "ab"}, _RECENT)
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


def _written(path: Path, days_before_now: float) -> float:
    """Set *path*'s last write to that long before `_NOW`, and return it."""
    stamp = _NOW - days_before_now * _DAY
    os.utime(path, (stamp, stamp))
    return stamp


def _undated_file(path: Path, days_before_now: float) -> float:
    """A file as it was written before `submitted_at` existed."""
    path.write_text(
        '{"fingerprint": {"model": "m", "effort": "high"}, '
        '"pending": [{"batch_id": "msgbatch_1", "document_sha256": {"111": "ab"}}]}'
    )
    return _written(path, days_before_now)


def test_a_file_written_before_submitted_at_is_dated_from_its_last_write(
    tmp_path,
) -> None:
    path = tmp_path / "b.json"
    last_write = _undated_file(path, 3)

    dated = PendingBatch("msgbatch_1", {"111": "ab"}, submitted_at=last_write)
    assert load(str(path), FP, now=_NOW) == [dated]
    assert json.loads(path.read_text())["pending"][0]["submitted_at"] == last_write


def test_a_batch_older_than_the_api_keeps_results_is_dropped_and_gone_from_the_file(
    tmp_path, caplog
) -> None:
    path = str(tmp_path / "b.json")
    stale, fresh = _aged("msgbatch_stale", 31), _aged("msgbatch_fresh", 1, "222")
    save(path, FP, [stale, fresh])

    with caplog.at_level(logging.INFO):
        assert load(path, FP, now=_NOW) == [fresh]

    assert caplog.text.count("msgbatch_stale") == 1
    assert "msgbatch_stale" not in Path(path).read_text()
    assert load(path, FP, now=_NOW) == [fresh]


def test_a_batch_just_past_the_retention_is_kept_for_the_margin(
    tmp_path,
) -> None:
    path = str(tmp_path / "b.json")
    batch = _aged("msgbatch_1", 29.5)
    save(path, FP, [batch])
    assert load(path, FP, now=_NOW) == [batch]


def test_an_undated_batch_keeps_its_date_through_later_rewrites(tmp_path) -> None:
    # The rewrite that stores the date moves the file's last write to today,
    # and so does every later one: read again from there, the record would
    # never grow old.
    path = tmp_path / "b.json"
    last_write = _undated_file(path, 3)

    save(str(path), FP, load(str(path), FP, now=_NOW))
    _written(path, 0)

    assert load(str(path), FP, now=_NOW) == [
        PendingBatch("msgbatch_1", {"111": "ab"}, submitted_at=last_write)
    ]
    assert load(str(path), FP, now=_NOW + 40 * _DAY) == []
    assert not path.exists()


def test_an_undated_batch_in_a_file_last_written_past_the_retention_is_dropped(
    tmp_path, caplog
) -> None:
    path = tmp_path / "b.json"
    _undated_file(path, 31)

    with caplog.at_level(logging.INFO):
        assert load(str(path), FP, now=_NOW) == []

    assert caplog.text.count("msgbatch_1") == 1
    assert not path.exists()


def test_an_undated_batch_is_dated_beside_a_dated_one_that_keeps_its_own(
    tmp_path,
) -> None:
    path = tmp_path / "b.json"
    fresh = _aged("msgbatch_fresh", 1, "222")
    save(str(path), FP, [PendingBatch("msgbatch_old", {"111": "ab"}), fresh])
    last_write = _written(path, 5)

    assert load(str(path), FP, now=_NOW) == [
        PendingBatch("msgbatch_old", {"111": "ab"}, submitted_at=last_write),
        fresh,
    ]


def test_a_last_write_in_the_future_dates_the_batch_now(tmp_path) -> None:
    path = tmp_path / "b.json"
    _undated_file(path, -2)

    assert load(str(path), FP, now=_NOW) == [
        PendingBatch("msgbatch_1", {"111": "ab"}, submitted_at=_NOW)
    ]


def test_a_file_whose_last_write_cannot_be_read_dates_the_batch_now(tmp_path) -> None:
    undated = PendingBatch("msgbatch_1", {"111": "ab"})
    assert _dated(tmp_path / "gone.json", [undated], _NOW) == [
        PendingBatch("msgbatch_1", {"111": "ab"}, submitted_at=_NOW)
    ]


def test_a_file_that_cannot_be_rewritten_dates_its_batch_the_same_every_load(
    tmp_path, monkeypatch
) -> None:
    path = tmp_path / "b.json"
    last_write = _undated_file(path, 3)

    def refuse(*args, **kwargs):
        raise PermissionError("read-only")

    monkeypatch.setattr("pipeline.batch_state.os.replace", refuse)
    dated = [PendingBatch("msgbatch_1", {"111": "ab"}, submitted_at=last_write)]
    assert load(str(path), FP, now=_NOW) == dated
    assert load(str(path), FP, now=_NOW + _DAY) == dated
    assert list(tmp_path.iterdir()) == [path]


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
    save(path, FP, [_aged("msgbatch_stale", 31), fresh])

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


def test_a_failed_save_whose_temporary_file_cannot_be_deleted_raises_the_first_error(
    tmp_path, monkeypatch, caplog
) -> None:
    """The caller is told why the record was not written, not why the
    clean-up after it failed."""
    path = tmp_path / "b.json"

    def refuse_replace(*args, **kwargs):
        raise PermissionError("the record is read-only")

    def refuse_unlink(self, missing_ok=False):
        raise OSError("the directory is read-only")

    monkeypatch.setattr("pipeline.batch_state.os.replace", refuse_replace)
    monkeypatch.setattr(Path, "unlink", refuse_unlink)
    with (
        caplog.at_level(logging.WARNING),
        pytest.raises(PermissionError, match="the record is read-only"),
    ):
        save(str(path), FP, [PendingBatch("msgbatch_1", {"111": "ab"})])

    assert "Could not delete" in caplog.text
    assert "b.json.tmp" in caplog.text


_ENTRY = {"batch_id": "msgbatch_1", "document_sha256": {"111": "ab"}}


@pytest.mark.parametrize(
    "entry",
    [
        "msgbatch_1",
        {"batch_id": 7, "document_sha256": {"111": "ab"}},
        {"batch_id": "msgbatch_1", "document_sha256": ["111"]},
        {**_ENTRY, "submitted_at": "x"},
        {**_ENTRY, "submitted_at": True},
        {"batch_id": "msgbatch_1", "document_sha256": {"111": 5}},
    ],
    ids=[
        "an entry that is not an object",
        "a batch id that is not a string",
        "hashes that are not an object",
        "a date that is not a number",
        "a date that is a boolean",
        "a hash that is not a string",
    ],
)
def test_one_malformed_entry_discards_the_whole_file(tmp_path, entry) -> None:
    """A record that cannot be trusted in one place is not half-used: a
    good entry beside the bad one is not resumed either."""
    path = tmp_path / "b.json"
    good = {
        "batch_id": "msgbatch_0",
        "document_sha256": {"000": "ff"},
        "submitted_at": _RECENT,
    }
    path.write_text(json.dumps({"fingerprint": FP, "pending": [good, entry]}))

    assert load(str(path), FP) == []
    assert not path.exists()


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_batch_state_forgets_and_claims_like_a_model(tmp_path) -> None:
    """`forget` is set difference per batch, and a batch left with no paper goes.

    The model is a list of (batch id, {pmid: digest}) the test keeps from the
    operations it applies. `_claim_pending` is checked against the rule that a
    paper belongs to the first recorded batch that holds it with the digest of
    the text this run would send, and a batch owning none is left out.
    """
    tally = {
        "forget_trimmed_a_batch": 0,
        "forget_emptied_a_batch": 0,
        "forget_emptied_the_file": 0,
        "forget_changed_nothing": 0,
        "pmid_in_two_batches": 0,
        "claim_first_wins_on_a_shared_paper": 0,
        "claim_passed_over_a_stale_digest": 0,
        "claim_left_a_batch_out": 0,
        "claim_ignored_a_paper_not_in_the_run": 0,
    }
    for seed in range(50):
        rng = random.Random(seed)
        path = str(tmp_path / f"b{seed}.json")
        model: list[tuple[str, dict[str, str]]] = []
        history: list[str] = []
        for step in range(30):
            where = f"seed {seed} step {step}; history {history}"
            if not model or rng.random() < 0.25:
                batch_id = f"msgbatch_{seed}_{step}"
                papers = {
                    str(p): _digest(f"text-{p}-{rng.randint(0, 1)}")
                    for p in rng.sample(range(1, 11), rng.randint(1, 5))
                }
                model.append((batch_id, papers))
                history.append(f"record {batch_id} {sorted(papers)}")
                save(
                    path,
                    FP,
                    [PendingBatch(b, dict(d), _RECENT) for b, d in model],
                )
                if any(set(papers) & set(d) for _, d in model[:-1]):
                    tally["pmid_in_two_batches"] += 1
            elif rng.random() < 0.6:
                done = {str(p) for p in rng.sample(range(1, 11), rng.randint(1, 6))}
                history.append(f"forget {sorted(done)}")
                before = model
                model = [
                    (b, {k: v for k, v in d.items() if k not in done})
                    for b, d in model
                ]
                trimmed = any(
                    0 < len(d) < len(bd)
                    for (_, d), (_, bd) in zip(model, before, strict=True)
                )
                model = [(b, d) for b, d in model if d]
                if model == before:
                    tally["forget_changed_nothing"] += 1
                if len(model) < len(before):
                    tally["forget_emptied_a_batch"] += 1
                if trimmed:
                    tally["forget_trimmed_a_batch"] += 1
                forget(path, FP, done)
                if not model:
                    tally["forget_emptied_the_file"] += 1
                    assert not Path(path).exists(), where
                    break
            else:
                documents = {
                    str(p): f"text-{p}-{rng.randint(0, 1)}"
                    for p in rng.sample(range(1, 13), rng.randint(0, 9))
                }
                history.append(f"claim over {sorted(documents)}")
                loaded = load(path, FP)
                got = _claim_pending(loaded, documents)
                # The rule, from the paper's side: its owner is the first batch
                # holding it with the digest of the text of this run.
                owner: dict[str, str] = {}
                for batch_id, held in model:
                    for pmid, digest in held.items():
                        if pmid in documents and pmid not in owner:
                            if digest == _digest(documents[pmid]):
                                owner[pmid] = batch_id
                            else:
                                tally["claim_passed_over_a_stale_digest"] += 1
                        elif pmid in documents and owner.get(pmid) != batch_id:
                            if digest == _digest(documents[pmid]):
                                tally["claim_first_wins_on_a_shared_paper"] += 1
                        elif pmid not in documents:
                            tally["claim_ignored_a_paper_not_in_the_run"] += 1
                expected = [
                    (b, {p for p, o in owner.items() if o == b})
                    for b, _ in model
                    if any(o == b for o in owner.values())
                ]
                assert [(b.batch_id, s) for b, s in got] == expected, where
                claimed = [p for _, s in got for p in s]
                assert len(claimed) == len(set(claimed)), f"overlap; {where}"
                if len(got) < len(model):
                    tally["claim_left_a_batch_out"] += 1
            assert [(b.batch_id, b.document_sha256) for b in load(path, FP)] == model, (
                where
            )

    # `forget` on a file that is not there is a no-op, not an error.
    forget(str(tmp_path / "none.json"), FP, ["1"])
    assert not (tmp_path / "none.json").exists()

    unreached = [name for name, count in tally.items() if count == 0]
    assert not unreached, f"cases never reached: {unreached}; tallies {tally}"


@pytest.mark.parametrize(
    ("age_offset", "kept"),
    [(-1.0, True), (-0.5, True), (0.0, True), (0.5, False), (1.0, False)],
)
def test_the_prune_edge_is_inclusive_at_29_days_plus_1(
    tmp_path, age_offset: float, kept: bool
) -> None:
    # The API keeps results for 29 days; the margin adds a day. A batch exactly
    # 30 days old is still held, and one a moment older is dropped.
    now = 2_000_000_000.0
    thirty_days = 30 * 24 * 60 * 60
    assert thirty_days == RESULTS_RETENTION_SECONDS + PRUNE_MARGIN_SECONDS
    path = str(tmp_path / "b.json")
    batch = PendingBatch("msgbatch_1", {"111": "ab"}, now - thirty_days - age_offset)
    save(path, FP, [batch])

    assert load(path, FP, now=now) == ([batch] if kept else [])
    assert Path(path).exists() is kept
