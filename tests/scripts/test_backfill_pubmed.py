"""Coverage for the chunked PubMed backfill.

`testpaths` is `["tests/pipeline"]`, so nothing collects this file -- in CI
either -- unless it is named: `uv run pytest tests/scripts`.
"""

from unittest.mock import AsyncMock, call

import pytest
from scripts.backfill_pubmed import plan_windows, run_backfill

from pipeline.quality_metrics import PipelineMetrics


class TestPlanWindows:
    def test_windows_are_cumulative_and_end_on_the_target(self) -> None:
        # --days-back always means "the last N days from now", so the windows
        # grow rather than tile. Each run deduplicates against the PMIDs its
        # predecessors committed, which is what stops the overlap costing
        # anything.
        assert plan_windows(365, 30) == [
            30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360, 365
        ]

    def test_an_exact_multiple_does_not_repeat_the_final_window(self) -> None:
        assert plan_windows(60, 30) == [30, 60]

    def test_a_target_shorter_than_one_step_is_a_single_run(self) -> None:
        assert plan_windows(20, 30) == [20]

    @pytest.mark.parametrize(
        ("days_back", "step"), [(0, 30), (-1, 30), (365, 0), (365, -1)]
    )
    def test_a_non_positive_bound_is_rejected(self, days_back: int, step: int) -> None:
        with pytest.raises(ValueError):
            plan_windows(days_back, step)


class TestRunBackfill:
    async def test_each_window_runs_in_order_on_one_connection_pool(
        self, mocker
    ) -> None:
        # manage_lifecycle=False keeps the pool open between windows and
        # suppresses a per-window completion notification; the backfill closes
        # the pool once, at the end.
        run_pipeline = mocker.patch(
            "scripts.backfill_pubmed.run_pipeline",
            new=AsyncMock(return_value=(PipelineMetrics(), None)),
        )
        close = mocker.patch(
            "scripts.backfill_pubmed.Database.close", new=AsyncMock()
        )

        await run_backfill([30, 60, 90])

        assert run_pipeline.await_args_list == [
            call(days_back=w, use_batch_api=False, config=None, manage_lifecycle=False)
            for w in (30, 60, 90)
        ]
        close.assert_awaited_once()

    async def test_papers_processed_is_reported_per_window(self, mocker) -> None:
        metrics = PipelineMetrics()
        metrics.papers_processed = 7
        mocker.patch(
            "scripts.backfill_pubmed.run_pipeline",
            new=AsyncMock(return_value=(metrics, None)),
        )
        mocker.patch("scripts.backfill_pubmed.Database.close", new=AsyncMock())

        # run_pipeline builds a fresh PipelineMetrics per call, so the counter
        # it returns is already scoped to that window.
        assert await run_backfill([30, 60]) == [7, 7]

    async def test_a_failed_window_stops_the_backfill(self, mocker) -> None:
        # Windows already finished have committed their PMIDs, so re-running
        # the backfill resumes rather than repeats. The ones after the failure
        # must not be attempted on a database that just refused a write.
        run_pipeline = mocker.patch(
            "scripts.backfill_pubmed.run_pipeline",
            new=AsyncMock(
                side_effect=[(PipelineMetrics(), None), ConnectionResetError("gone")]
            ),
        )
        close = mocker.patch(
            "scripts.backfill_pubmed.Database.close", new=AsyncMock()
        )

        with pytest.raises(ConnectionResetError):
            await run_backfill([30, 60, 90])

        assert run_pipeline.await_count == 2
        close.assert_awaited_once()
