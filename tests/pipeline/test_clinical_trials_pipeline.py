"""Tests for pipeline.main.run_clinical_trials_pipeline."""

from unittest.mock import AsyncMock

import pytest

from pipeline.cache_utils import SyncResult
from pipeline.config import PipelineConfig
from pipeline.main import run_clinical_trials_pipeline


class TestRunClinicalTrialsPipeline:
    async def test_disabled_config_returns_skipped(self, mocker):
        """ct_enabled=False short-circuits to a skipped summary."""
        mocker.patch("pipeline.main.close_ctg_client", new_callable=AsyncMock)
        mock_sync = mocker.patch(
            "pipeline.main.sync_clinical_trials", new_callable=AsyncMock
        )

        config = PipelineConfig()
        config.ct_enabled = False

        summary = await run_clinical_trials_pipeline(config=config)

        assert summary["name"] == "clinical_trials"
        assert summary["status"] == "skipped"
        assert summary["metrics"] == {"fetched": 0, "cached": 0, "failed": 0}
        mock_sync.assert_not_awaited()

    async def test_success_reports_metrics(self, mocker):
        """Successful sync returns status=ok and the underlying counts."""
        mocker.patch("pipeline.main.close_ctg_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.set_config")
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)

        mocker.patch(
            "pipeline.main.sync_clinical_trials",
            new_callable=AsyncMock,
            return_value=SyncResult(fetched=12, cached=10, failed=0, errors=[]),
        )

        config = PipelineConfig()
        config.ct_enabled = True

        summary = await run_clinical_trials_pipeline(config=config)

        assert summary["name"] == "clinical_trials"
        assert summary["status"] == "ok"
        assert summary["metrics"] == {"fetched": 12, "cached": 10, "failed": 0}
        assert summary["errors"] == []

    async def test_per_item_errors_are_warnings_not_a_failed_refresh(
        self, mocker
    ) -> None:
        """One term that failed is not a failed sync: the rest was written."""
        mocker.patch("pipeline.main.close_ctg_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.set_config")
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)

        mocker.patch(
            "pipeline.main.sync_clinical_trials",
            new_callable=AsyncMock,
            return_value=SyncResult(
                fetched=5, cached=4, failed=1, errors=["CTG term 'CADASIL': boom"]
            ),
        )

        config = PipelineConfig()
        config.ct_enabled = True

        summary = await run_clinical_trials_pipeline(config=config)

        assert summary["status"] == "warnings"
        assert summary["errors"] == ["CTG term 'CADASIL': boom"]
        # `aborted` is a status, not a count: it must not reach the metrics
        # line the notification renders as key=value pairs.
        assert summary["metrics"] == {"fetched": 5, "cached": 4, "failed": 1}

    async def test_an_aborted_sync_is_a_failure(self, mocker) -> None:
        """A sync that stopped -- upsert wrote nothing -- is red."""
        mocker.patch("pipeline.main.close_ctg_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.set_config")
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)

        mocker.patch(
            "pipeline.main.sync_clinical_trials",
            new_callable=AsyncMock,
            return_value=SyncResult(
                fetched=5,
                cached=0,
                failed=5,
                errors=["CTG upsert boom"],
                aborted=True,
            ),
        )

        config = PipelineConfig()
        config.ct_enabled = True

        summary = await run_clinical_trials_pipeline(config=config)

        assert summary["status"] == "failed"
        assert summary["errors"] == ["CTG upsert boom"]

    async def test_exception_from_sync_propagates(self, mocker):
        """Unhandled exceptions from sync_clinical_trials are re-raised."""
        mocker.patch("pipeline.main.close_ctg_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.set_config")
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)

        mocker.patch(
            "pipeline.main.sync_clinical_trials",
            new_callable=AsyncMock,
            side_effect=RuntimeError("CTG API unreachable"),
        )

        config = PipelineConfig()
        config.ct_enabled = True

        with pytest.raises(RuntimeError, match="CTG API unreachable"):
            await run_clinical_trials_pipeline(config=config)

    async def test_manage_lifecycle_false_skips_db_close(self, mocker):
        """Dispatcher path (manage_lifecycle=False) leaves the DB pool open."""
        mocker.patch("pipeline.main.close_ctg_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.set_config")
        mock_db_close = mocker.patch(
            "pipeline.main.Database.close", new_callable=AsyncMock
        )

        mocker.patch(
            "pipeline.main.sync_clinical_trials",
            new_callable=AsyncMock,
            return_value=SyncResult(fetched=1, cached=1, failed=0, errors=[]),
        )

        config = PipelineConfig()
        config.ct_enabled = True

        await run_clinical_trials_pipeline(config=config, manage_lifecycle=False)

        mock_db_close.assert_not_called()
