"""Tests for pipeline.steps -- the one step vocabulary and its recorder."""

from unittest.mock import patch

from pipeline.run_errors import RunError, RunWarning
from pipeline.steps import (
    PIPELINE_STEPS,
    STEP_KEYS,
    TOTAL_STEPS,
    StepRecorder,
    _OpenStep,
    _window_of,
)


def _warning(count: int = 1) -> RunWarning:
    return RunWarning(kind="genes_rejected", title="genes rejected", count=count)


class _Clock:
    """A stand-in for `time.monotonic` the test advances by hand."""

    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class TestVocabulary:
    def test_the_six_steps_are_the_progress_file_keys(self) -> None:
        # The progress file's `stage` values are these keys, so a rename
        # here is a wire change rather than a cosmetic one.
        assert STEP_KEYS == (
            "searching_pubmed",
            "filtering_pmids",
            "processing_papers",
            "batch_validation",
            "merging_database",
            "finalizing",
        )
        assert TOTAL_STEPS == 6

    def test_every_step_has_a_reader_facing_label(self) -> None:
        for step in PIPELINE_STEPS:
            assert step.label
            assert step.label != step.key
            assert "_" not in step.label


class TestStepRecorder:
    def test_a_step_never_entered_is_reported_as_skipped(self) -> None:
        recorder = StepRecorder()
        recorder.enter(0)
        records = recorder.records()
        assert len(records) == TOTAL_STEPS
        assert records[0].status == "ok"
        assert [r.status for r in records[1:]] == ["skipped"] * 5

    def test_a_skipped_step_carries_no_timing(self) -> None:
        records = StepRecorder().records()
        assert records[0].started_at is None
        assert records[0].duration_seconds is None

    def test_warnings_make_a_step_warn_rather_than_pass(self) -> None:
        recorder = StepRecorder()
        recorder.enter(2)
        recorder.warn(_warning())
        assert recorder.records()[2].status == "warning"

    def test_an_error_outranks_a_warning(self) -> None:
        recorder = StepRecorder()
        recorder.enter(2)
        recorder.warn(_warning())
        recorder.fail(RunError(kind="timeout", title="timed out"))
        assert recorder.records()[2].status == "failed"

    def test_the_first_failure_is_the_one_kept(self) -> None:
        recorder = StepRecorder()
        recorder.enter(0)
        recorder.fail(RunError(kind="timeout", title="first"))
        recorder.fail(RunError(kind="unknown", title="second"))
        error = recorder.records()[0].error
        assert error is not None
        assert error.title == "first"

    def test_a_failure_with_no_step_open_is_attributed_to_one(self) -> None:
        """A run can die before its first step, or between two of them.

        The error used to land nowhere: every step stayed `skipped`,
        `derive_status` found nothing failed and the run was published as
        `completed` -- a green badge over a crash.
        """
        recorder = StepRecorder()
        recorder.fail(RunError(kind="unknown", title="search broke"), index=0)

        record = recorder.records()[0]
        assert record.status == "failed"
        assert record.error is not None
        assert record.error.title == "search broke"

    def test_a_failure_with_no_step_open_and_no_index_is_dropped(self) -> None:
        """Without a step to blame there is nowhere honest to put it."""
        recorder = StepRecorder()
        recorder.fail(RunError(kind="unknown", title="search broke"))
        assert [record.status for record in recorder.records()] == ["skipped"] * 6

    def test_the_first_attributed_failure_is_the_one_kept(self) -> None:
        recorder = StepRecorder()
        recorder.fail(RunError(kind="timeout", title="first"), index=1)
        recorder.fail(RunError(kind="unknown", title="second"), index=1)

        error = recorder.records()[1].error
        assert error is not None
        assert error.title == "first"

    def test_actions_are_collected_in_order(self) -> None:
        recorder = StepRecorder()
        recorder.enter(2)
        recorder.action("Fetched metadata for 16 papers")
        recorder.action("Retrieved full text for 10")
        assert recorder.records()[2].actions == [
            "Fetched metadata for 16 papers",
            "Retrieved full text for 10",
        ]

    def test_re_entering_a_step_merges_rather_than_duplicating(self) -> None:
        # The streaming path enters processing_papers once per batch; the
        # widget must still show six rows, not nine.
        recorder = StepRecorder()
        recorder.enter(2)
        recorder.action("batch one")
        recorder.enter(2)
        recorder.action("batch two")
        records = recorder.records()
        assert len(records) == TOTAL_STEPS
        assert records[2].actions == ["batch one", "batch two"]

    def test_a_re_entered_step_is_timed_across_all_its_visits(self) -> None:
        """Re-entry is the normal case, so its time has to be its own.

        The merged step kept its earliest start and ended at the earliest
        later-indexed start after it, so a second visit's time landed on
        the *next* step: enter(2) 50 ms, enter(3) 20 ms, enter(2) 50 ms
        reported processing_papers at 54 ms and batch_validation at 80.
        """
        clock = _Clock()
        recorder = StepRecorder()
        with patch("pipeline.steps.time.monotonic", clock):
            recorder.enter(2)
            clock.advance(0.050)
            recorder.enter(3)
            clock.advance(0.020)
            recorder.enter(2)
            clock.advance(0.050)
            recorder.enter(4)
            clock.advance(0.010)
            records = recorder.records()

        assert records[2].duration_seconds == 0.100
        assert records[3].duration_seconds == 0.020
        assert records[4].duration_seconds == 0.010

    def test_a_step_ends_when_the_next_one_starts(self) -> None:
        recorder = StepRecorder()
        recorder.enter(0)
        recorder.enter(1)
        records = recorder.records()
        assert records[0].duration_seconds is not None
        assert records[0].duration_seconds >= 0.0

    def test_durations_are_never_negative(self) -> None:
        recorder = StepRecorder()
        for index in range(TOTAL_STEPS):
            recorder.enter(index)
        for record in recorder.records():
            assert record.duration_seconds is not None
            assert record.duration_seconds >= 0.0

    def test_recording_outside_a_step_is_a_no_op(self) -> None:
        # close() ends the open step; anything arriving afterwards has no
        # step to attach to and must not raise.
        recorder = StepRecorder()
        recorder.action("nowhere")
        recorder.warn(_warning())
        recorder.fail(RunError(kind="unknown", title="nowhere"))
        assert all(record.status == "skipped" for record in recorder.records())

    def test_close_is_idempotent(self) -> None:
        recorder = StepRecorder()
        recorder.enter(0)
        recorder.close()
        recorder.close()
        assert len(recorder.records()) == TOTAL_STEPS

    def test_records_is_idempotent(self) -> None:
        # It merged a re-entered step into the _OpenStep still held in
        # _finished, so every extra call appended that batch again. The
        # first result looked right, which is why this hid.
        recorder = StepRecorder()
        recorder.enter(2)
        recorder.action("batch one")
        recorder.enter(3)
        recorder.enter(2)
        recorder.action("batch two")
        recorder.warn(_warning(count=3))
        recorder.enter(4)

        first = recorder.records()
        second = recorder.records()
        third = recorder.records()

        assert first[2].actions == ["batch one", "batch two"]
        assert second[2].actions == first[2].actions
        assert third[2].actions == first[2].actions
        assert second[2].warnings == first[2].warnings

    def test_ordinals_are_one_based_and_in_run_order(self) -> None:
        records = StepRecorder().records()
        assert [r.ordinal for r in records] == [1, 2, 3, 4, 5, 6]
        assert [r.key for r in records] == list(STEP_KEYS)


class TestAnOpenWindow:
    def test_a_still_open_step_is_measured_to_now(self) -> None:
        clock = _Clock()
        entry = _OpenStep(index=0, started_at="", started_monotonic=clock.now)
        clock.advance(2.5)
        with patch("pipeline.steps.time.monotonic", clock):
            assert _window_of(entry) == 2.5
