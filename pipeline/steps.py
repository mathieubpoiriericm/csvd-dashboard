"""The pipeline's step vocabulary, and the recorder that times them.

Before this module the repo carried *two* contradictory step lists: the
six ``_STAGES`` keys written to the progress file, and eight
``print("##STAGE:...##")`` markers naming six different things, read by
nothing in the repo, the e2e suite or CI. This is the one list.

``_STAGES`` was a status indicator -- ``report(i)`` stored an index and no
time -- so nothing knew how long a step took or whether it had ended
cleanly. ``StepRecorder`` adds that, and is deliberately driven by the
same index, so existing ``progress.report(n)`` call sites keep working.
"""

import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Final, Literal

from pydantic import Field

from pipeline.run_errors import RunError, RunWarning
from pipeline.wire_model import WireModel


@dataclass(frozen=True, slots=True)
class PipelineStep:
    """One main step, as the pipeline runs it and the dashboard names it."""

    key: str
    label: str


# The order is the run order, and the index is what report() takes.
PIPELINE_STEPS: Final[tuple[PipelineStep, ...]] = (
    PipelineStep("searching_pubmed", "Search PubMed"),
    PipelineStep("filtering_pmids", "Filter new papers"),
    PipelineStep("processing_papers", "Retrieve & extract"),
    PipelineStep("batch_validation", "Validate"),
    PipelineStep("merging_database", "Merge to database"),
    PipelineStep("finalizing", "Finalize"),
)

STEP_KEYS: Final[tuple[str, ...]] = tuple(step.key for step in PIPELINE_STEPS)
TOTAL_STEPS: Final[int] = len(PIPELINE_STEPS)

# Every value `pipeline_runs.run_mode` accepts. Only `standard` is written
# today -- the two offline modes publish no data, so recording one would
# point the About page's "up-to-date as of" date at a run that changed
# nothing -- but the dashboard has to be able to label any of them.
# Declared here rather than described in a docstring: the encoding
# contract test reads this, and prose is not a vocabulary.
RUN_MODES: Final[tuple[str, ...]] = ("standard", "local_pdf", "pmid_list")

# Every value `sync_runs.mode` accepts -- the reference-data refreshes,
# which record their own smaller document rather than a run report. They
# are not `RUN_MODES`: a refresh has no steps, no papers and no genes, and
# putting one in `pipeline_runs` would re-date the whole dashboard from a
# run that processed no papers. See `pipeline/sync_report.py`.
# Declared here for the reason above it: the encoding contract test reads
# this, and prose is not a vocabulary.
SYNC_MODES: Final[tuple[str, ...]] = (
    "clinical_trials",
    "external_sync",
    "annotation_sync",
)

StepStatus = Literal["ok", "warning", "failed", "skipped"]


class StepRecord(WireModel):
    """The recorded outcome of one step.

    ``actions`` is the plain-language list the widget shows when a step is
    expanded -- "Retrieved full text for 10, abstract only for 5" -- not a
    log excerpt. Steps the run never reached are still emitted, as
    ``skipped``, so the widget always renders all six and a failure shows
    what did not happen after it.
    """

    key: str
    label: str
    ordinal: int
    status: StepStatus
    started_at: str | None = None
    duration_seconds: float | None = None
    actions: list[str] = Field(default_factory=list)
    warnings: list[RunWarning] = Field(default_factory=list)
    error: RunError | None = None


@dataclass(slots=True)
class _OpenStep:
    """Mutable state for one visit to a step.

    ``ended_monotonic`` is stamped by ``close()``, so every entry in
    ``_finished`` is a closed window of its own. Re-entering a step opens
    a second window with the same index; ``records()`` sums them.
    """

    index: int
    started_at: str
    started_monotonic: float
    ended_monotonic: float | None = None
    actions: list[str] = field(default_factory=list)
    warnings: list[RunWarning] = field(default_factory=list)
    error: RunError | None = None


@dataclass(slots=True)
class _StepSummary:
    """The combined reader-facing state from every visit to one step."""

    started_at: str
    elapsed_seconds: float = 0.0
    actions: list[str] = field(default_factory=list)
    warnings: list[RunWarning] = field(default_factory=list)
    error: RunError | None = None


@dataclass(slots=True)
class StepRecorder:
    """Times each step and collects what it did.

    Durations come from ``time.monotonic()`` rather than wall-clock
    subtraction: a run can straddle an NTP correction or a DST shift, and
    a step is not allowed to report a negative duration because the clock
    moved under it.
    """

    _finished: list[_OpenStep] = field(default_factory=list)
    _open: _OpenStep | None = None

    def enter(self, index: int) -> None:
        """Close the step in progress, if any, and open the one at ``index``."""
        self.close()
        self._open = _OpenStep(
            index=index,
            started_at=datetime.now(tz=UTC).isoformat(),
            started_monotonic=time.monotonic(),
        )

    def action(self, text: str) -> None:
        """Record something the current step did, in reader-facing prose."""
        if self._open is not None:
            self._open.actions.append(text)

    def warn(self, warning: RunWarning) -> None:
        """Attach a non-fatal finding to the current step."""
        if self._open is not None:
            self._open.warnings.append(warning)

    def fail(self, error: RunError, index: int | None = None) -> None:
        """Mark a step failed. The first failure is the one kept.

        ``index`` names the step to blame when none is open, which is the
        case whenever a run dies before its first step or between two of
        them. Without it the failure landed nowhere: every step stayed
        ``skipped``, `derive_status` saw nothing failed and published
        ``completed``, and a run that raised on its first call reached the
        About page wearing a green badge -- the one outcome the failure
        path exists to prevent.
        """
        if self._open is not None:
            if self._open.error is None:
                self._open.error = error
            return
        if index is None:
            return
        if any(entry.index == index and entry.error for entry in self._finished):
            return
        # The step never ran, so its window is empty: it is closed at the
        # instant it opened rather than left to absorb whatever time
        # passes before the next step.
        now = time.monotonic()
        self._finished.append(
            _OpenStep(
                index=index,
                started_at=datetime.now(tz=UTC).isoformat(),
                started_monotonic=now,
                ended_monotonic=now,
                error=error,
            )
        )

    def close(self) -> None:
        """Close the step in progress. Idempotent."""
        if self._open is not None:
            self._open.ended_monotonic = time.monotonic()
            self._finished.append(self._open)
            self._open = None

    def records(self) -> list[StepRecord]:
        """Every step in run order, including ones never reached.

        Re-entering a step merges into its first record rather than
        emitting it twice: ``processing_papers`` is entered once per batch
        on the streaming path, and the widget shows six rows, not nine.
        """
        self.close()
        # Merged into fresh summaries rather than into the stored visits.
        # Extending `existing.actions` in place mutated the _OpenStep
        # still held in self._finished, so a second call to records()
        # appended the same batch again -- and re-entering a step is the
        # documented normal case, so the first result looked right and
        # the duplication only appeared once something read it twice.
        merged: dict[int, _StepSummary] = {}
        # Each visit is its own closed window, and a step's duration is
        # the sum of them. Merging kept the earliest start and ended at
        # the earliest later-indexed start after it, so the time spent
        # in a second visit was attributed to the *next* step: enter(2)
        # 50 ms, enter(3) 20 ms, enter(2) 50 ms reported processing_papers
        # at 54 ms and batch_validation at 80.
        for entry in self._finished:
            summary = merged.get(entry.index)
            if summary is None:
                summary = _StepSummary(started_at=entry.started_at)
                merged[entry.index] = summary
            summary.elapsed_seconds += _window_of(entry)
            summary.actions.extend(entry.actions)
            summary.warnings.extend(entry.warnings)
            summary.error = summary.error or entry.error
            # The first visit keeps the start: entries are appended in
            # the order they were opened, so a later one never started
            # earlier.

        records: list[StepRecord] = []
        for index, step in enumerate(PIPELINE_STEPS):
            entry = merged.get(index)
            if entry is None:
                records.append(
                    StepRecord(
                        key=step.key,
                        label=step.label,
                        ordinal=index + 1,
                        status="skipped",
                    )
                )
                continue
            records.append(
                StepRecord(
                    key=step.key,
                    label=step.label,
                    ordinal=index + 1,
                    status=_status_of(entry),
                    started_at=entry.started_at,
                    # Rounded to milliseconds: a raw monotonic delta
                    # serialises as 6.291986210271716e-06, which is noise
                    # in a file a human reviews in `git diff`, and nothing
                    # in the widget renders below a millisecond.
                    duration_seconds=round(entry.elapsed_seconds, 3),
                    actions=entry.actions,
                    warnings=entry.warnings,
                    error=entry.error,
                )
            )
        return records


def _status_of(entry: _StepSummary) -> StepStatus:
    """A step failed, warned, or was clean -- in that precedence."""
    if entry.error is not None:
        return "failed"
    return "warning" if entry.warnings else "ok"


def _window_of(entry: _OpenStep) -> float:
    """Elapsed time in one visit: from its ``enter()`` to the next.

    A step's end is the next step's start. The recorder is advanced by
    ``enter()`` rather than by an explicit ``end()``, because that is how
    the existing ``progress.report(n)`` call sites already work -- adding
    an end call at every site would be a change this does not need, and
    one a future edit could forget at a single site without any test
    noticing. ``records()`` closes the last one, so an unstamped end only
    happens if this is called on a still-open step.
    """
    end = entry.ended_monotonic
    if end is None:
        end = time.monotonic()
    return max(0.0, end - entry.started_monotonic)
