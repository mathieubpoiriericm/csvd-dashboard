"""The preview run's database: derived from production's name, never typed."""

import logging
from unittest.mock import AsyncMock

import asyncpg
import pytest

from pipeline.preview_run import (
    PreviewDatabaseError,
    enter_preview_database,
    preview_database_name,
    require_preview_database,
)


def test_the_preview_database_is_named_after_production() -> None:
    assert preview_database_name("dashboard") == "dashboard_preview"


def test_entering_rewrites_db_name() -> None:
    env = {"DB_NAME": "dashboard"}
    assert enter_preview_database(env) == "dashboard_preview"
    assert env == {"DB_NAME": "dashboard_preview"}


@pytest.mark.parametrize("env", [{}, {"DB_NAME": ""}])
def test_entering_without_a_database_name_is_refused(env: dict[str, str]) -> None:
    with pytest.raises(PreviewDatabaseError, match="DB_NAME"):
        enter_preview_database(env)


async def test_a_missing_preview_database_says_how_to_create_it(
    monkeypatch: pytest.MonkeyPatch, mocker
) -> None:
    monkeypatch.setenv("DB_NAME", "dashboard_preview")
    monkeypatch.setenv("DB_USER", "owner")
    mocker.patch(
        "pipeline.preview_run.Database.connection",
        side_effect=asyncpg.InvalidCatalogNameError("no such database"),
    )
    with pytest.raises(PreviewDatabaseError, match="createdb -O owner") as info:
        await require_preview_database()
    assert "dashboard_preview" in str(info.value)
    assert "regenerate-data" in str(info.value)
    assert "alembic" not in str(info.value)


def _connection_to(mocker, database: str) -> AsyncMock:
    """Patch ``Database.connection`` to one whose server reports ``database``."""
    conn = AsyncMock()
    conn.fetchval = AsyncMock(return_value=database)
    ctx = AsyncMock()
    ctx.__aenter__ = AsyncMock(return_value=conn)
    ctx.__aexit__ = AsyncMock(return_value=None)
    mocker.patch("pipeline.preview_run.Database.connection", return_value=ctx)
    return conn


async def test_the_preview_database_is_accepted_and_named_in_the_log(
    mocker, caplog: pytest.LogCaptureFixture
) -> None:
    conn = _connection_to(mocker, "dashboard_preview")
    with caplog.at_level(logging.INFO, logger="pipeline.preview_run"):
        await require_preview_database()
    conn.fetchval.assert_awaited_once_with("SELECT current_database()")
    assert "Preview run: writing to dashboard_preview" in caplog.text


async def test_a_connection_to_another_database_is_refused(mocker) -> None:
    # DB_NAME says preview, but the server says otherwise (a PGDATABASE
    # override, a pooler, a stale pool): believe the server.
    _connection_to(mocker, "dashboard")
    with pytest.raises(PreviewDatabaseError, match="'dashboard'"):
        await require_preview_database()
