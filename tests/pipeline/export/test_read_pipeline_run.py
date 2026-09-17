"""Tests for read_pipeline_run -- the run report's read side.

The About page must render whether or not a run has recorded a report, so
every way of genuinely having nothing -- an empty table, a null column, a
database below the migration that added either -- comes back as ``None``
rather than as an exception or a half-formed document. Everything else
raises: ``run_export`` stages this value unconditionally, so a swallowed
failure publishes ``null`` over the committed data/pipeline_run.json and
takes the run widget off the About page with a successful exit code.
"""

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import asyncpg
import pytest

from pipeline.export.lookups import read_pipeline_run, read_sync_runs


def _connection(mocker, row: Any) -> MagicMock:
    conn = MagicMock()
    conn.fetchrow = AsyncMock(return_value=row)
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=conn)
    ctx.__aexit__ = AsyncMock(return_value=False)
    mocker.patch("pipeline.export.lookups.Database.connection", return_value=ctx)
    return conn


def _stored(**overrides: Any) -> dict[str, Any]:
    document = {
        "runTimestamp": "2026-08-31T02:17:55+00:00",
        "status": "completed_with_warnings",
        "runMode": "standard",
        "durationSeconds": 167.0,
        "computeSeconds": 763.0,
    }
    document.update(overrides)
    return document


class TestReadPipelineRun:
    async def test_a_stored_report_comes_back_as_the_wire_document(
        self, mocker
    ) -> None:
        _connection(mocker, {"report": json.dumps(_stored())})

        result = await read_pipeline_run()

        assert result is not None
        assert result["runTimestamp"] == "2026-08-31T02:17:55+00:00"
        assert result["status"] == "completed_with_warnings"
        # Re-validated through the model, so absent blocks arrive filled
        # rather than missing -- the TypeScript side describes them.
        assert result["papers"]["processed"] == 0
        assert result["steps"] == []

    async def test_an_empty_table_is_none_not_an_error(self, mocker) -> None:
        _connection(mocker, None)
        assert await read_pipeline_run() is None

    async def test_a_null_report_column_is_none(self, mocker) -> None:
        _connection(mocker, {"report": None})
        assert await read_pipeline_run() is None

    async def test_a_database_without_migration_008_is_none(
        self, mocker, caplog
    ) -> None:
        # The expected shape of "no report yet" on a database that has not
        # taken the migration, not a fault to crash the export over.
        mocker.patch(
            "pipeline.export.lookups.Database.connection",
            side_effect=asyncpg.UndefinedColumnError(
                'column "report" does not exist'
            ),
        )
        assert await read_pipeline_run() is None
        assert "Could not read pipeline_runs.report" in caplog.text

    async def test_a_read_failure_that_is_not_migration_lag_raises(
        self, mocker
    ) -> None:
        # A dropped connection is not "no run has happened", and publishing
        # null for it would say exactly that on the public site.
        mocker.patch(
            "pipeline.export.lookups.Database.connection",
            side_effect=asyncpg.InsufficientPrivilegeError("permission denied"),
        )
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await read_pipeline_run()

    async def test_unparseable_json_fails_the_export(self, mocker) -> None:
        _connection(mocker, {"report": "{not json"})
        with pytest.raises(ValueError, match="Stored run report is not readable"):
            await read_pipeline_run()

    async def test_a_document_the_model_rejects_fails_the_export(
        self, mocker
    ) -> None:
        # A row written by an older pipeline is brought up to the current
        # shape or refused -- never handed to the dashboard half-formed, and
        # never quietly reduced to "no run", which the row itself disproves.
        _connection(mocker, {"report": json.dumps({"status": "nonsense"})})
        with pytest.raises(ValueError, match="Stored run report is not readable"):
            await read_pipeline_run()

    async def test_the_newest_run_with_a_report_is_the_one_read(
        self, mocker
    ) -> None:
        conn = _connection(mocker, {"report": json.dumps(_stored())})
        await read_pipeline_run()
        sql = conn.fetchrow.await_args[0][0]
        # Ordered, and skipping rows that predate the report column, so a
        # freshly migrated database does not report "no run" forever just
        # because its newest row was written before 008.
        assert "ORDER BY run_timestamp DESC" in sql
        assert "report IS NOT NULL" in sql
        assert "LIMIT 1" in sql

    async def test_api_labels_follow_the_registry_not_the_stored_row(
        self, mocker
    ) -> None:
        # The label is stored with the run. A rename in SERVICES has to reach
        # the committed file on the next export, not the next run.
        stored = _stored(apis=[{
            "service": "ncbi_eutils",
            "label": "NCBI E-utilities",
            "endpoint": "/entrez/eutils/esearch.fcgi",
            "method": "GET",
            "calls": 6, "ok": 6, "notFound": 0, "errors": 0,
            "retries": 0, "totalMs": 100.0, "bytes": 10,
        }, {
            "service": "journals.sagepub.com",
            "label": "journals.sagepub.com",
            "endpoint": "/doi/:id/:id",
            "method": "GET",
            "calls": 1, "ok": 0, "notFound": 0, "errors": 1,
            "retries": 0, "totalMs": 5.0, "bytes": 0,
        }])
        _connection(mocker, {"report": json.dumps(stored)})

        result = await read_pipeline_run()

        assert result is not None
        assert [row["label"] for row in result["apis"]] == [
            "E-utilities search",
            "SAGE Journals",
        ]
        assert result["apis"][0]["service"] == "ncbi_eutils"

    async def test_sync_api_labels_follow_the_registry_not_the_stored_row(
        self, mocker
    ) -> None:
        # Same correction on the reference-data refresh's read path:
        # read_sync_runs re-validates through SyncRunReport and its apis list
        # needs the same relabel_api_rows pass.
        stored = {
            "runTimestamp": "2026-08-31T02:17:55+00:00",
            "mode": "clinical_trials",
            "status": "completed",
            "durationSeconds": 12.0,
            "apis": [{
                "service": "sage",
                "label": "journals.sagepub.com",
                "endpoint": "/doi/:id/:id",
                "method": "GET",
                "calls": 1, "ok": 1, "notFound": 0, "errors": 0,
                "retries": 0, "totalMs": 5.0, "bytes": 10,
            }],
        }
        conn = MagicMock()
        conn.fetch = AsyncMock(
            return_value=[{"mode": "clinical_trials", "report": json.dumps(stored)}]
        )
        ctx = MagicMock()
        ctx.__aenter__ = AsyncMock(return_value=conn)
        ctx.__aexit__ = AsyncMock(return_value=False)
        mocker.patch("pipeline.export.lookups.Database.connection", return_value=ctx)

        result = await read_sync_runs()

        assert [row["label"] for row in result[0]["apis"]] == ["SAGE Journals"]
        assert result[0]["apis"][0]["service"] == "sage"
