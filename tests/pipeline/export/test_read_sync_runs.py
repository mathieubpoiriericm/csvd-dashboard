"""Tests for read_sync_runs -- the refresh record's read side.

Mirrors `test_read_pipeline_run.py`: the About page has to render whether
or not a refresh has been recorded, so genuinely having nothing -- an empty
table, or a database below the migration that adds it -- comes back as `[]`
rather than as an exception. Every other failure raises. `[]` is a claim
("no refresh has ever run") that `run_export` publishes over the committed
data/pipeline_syncs.json, so it must only ever be made when it is true.
"""

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import asyncpg
import pytest

from pipeline.export.lookups import read_sync_runs


def _connection(mocker, rows: list[Any]) -> MagicMock:
    conn = MagicMock()
    conn.fetch = AsyncMock(return_value=rows)
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=conn)
    ctx.__aexit__ = AsyncMock(return_value=False)
    mocker.patch("pipeline.export.lookups.Database.connection", return_value=ctx)
    return conn


def _stored(**overrides: Any) -> dict[str, Any]:
    document = {
        "runTimestamp": "2026-09-02T03:00:00Z",
        "mode": "annotation_sync",
        "status": "completed",
        "durationSeconds": 91.2,
        "apis": [
            {
                "service": "opentargets",
                "label": "Open Targets",
                "endpoint": "/api/v4/graphql",
                "method": "POST",
                "calls": 63,
            }
        ],
    }
    document.update(overrides)
    return document


def _row(
    document: dict[str, Any] | str, mode: str = "annotation_sync"
) -> dict[str, Any]:
    report = document if isinstance(document, str) else json.dumps(document)
    return {"mode": mode, "report": report}


class TestReadSyncRuns:
    async def test_a_stored_record_comes_back_as_the_wire_document(
        self, mocker
    ) -> None:
        _connection(mocker, [_row(_stored())])

        result = await read_sync_runs()

        assert len(result) == 1
        assert result[0]["mode"] == "annotation_sync"
        assert result[0]["status"] == "completed"
        # The whole point: the provider is named, not a bare hostname.
        assert result[0]["apis"][0]["label"] == "Open Targets"
        # Re-validated through the model, so absent blocks arrive filled
        # rather than missing -- the TypeScript side describes them.
        assert result[0]["sources"] == []
        assert result[0]["errors"] == {"shown": 0, "total": 0, "items": []}

    async def test_an_empty_table_is_an_empty_list(self, mocker) -> None:
        _connection(mocker, [])
        assert await read_sync_runs() == []

    async def test_a_database_without_migration_011_is_empty_and_logged(
        self, mocker, caplog
    ) -> None:
        # The expected shape of "no refresh yet" on a database that has not
        # taken the migration, not a fault to crash the export over.
        mocker.patch(
            "pipeline.export.lookups.Database.connection",
            side_effect=asyncpg.UndefinedTableError(
                'relation "sync_runs" does not exist'
            ),
        )
        assert await read_sync_runs() == []
        assert "Could not read sync_runs" in caplog.text

    async def test_a_read_failure_that_is_not_migration_lag_raises(
        self, mocker
    ) -> None:
        mocker.patch(
            "pipeline.export.lookups.Database.connection",
            side_effect=asyncpg.InsufficientPrivilegeError("permission denied"),
        )
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            await read_sync_runs()

    async def test_an_unreadable_row_fails_the_read(self, mocker) -> None:
        # Skipping it would publish a list missing one mode, which the About
        # page renders as a refresh that never happened -- a quieter and
        # worse failure than not publishing at all. The message names the
        # mode, because that is what has to be re-recorded or migrated.
        _connection(
            mocker,
            [
                _row(_stored(mode="external_sync"), mode="external_sync"),
                _row({"status": "nonsense"}, mode="annotation_sync"),
            ],
        )

        with pytest.raises(
            ValueError, match="annotation_sync refresh record is not readable"
        ):
            await read_sync_runs()

    async def test_an_unparseable_row_fails_the_read(self, mocker) -> None:
        _connection(mocker, [_row("{not json", mode="clinical_trials")])

        with pytest.raises(
            ValueError, match="clinical_trials refresh record is not readable"
        ):
            await read_sync_runs()

    async def test_the_newest_row_per_mode_is_read_deterministically(
        self, mocker
    ) -> None:
        conn = _connection(mocker, [_row(_stored())])
        await read_sync_runs()
        sql = conn.fetch.await_args[0][0]
        # One row per mode, newest first -- and ORDER BY mode is what makes
        # the byte-exact export reproducible, not only what DISTINCT ON
        # happens to require.
        assert "DISTINCT ON (mode)" in sql
        assert "ORDER BY mode, run_timestamp DESC" in sql
