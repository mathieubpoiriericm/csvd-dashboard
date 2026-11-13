"""The preview run's database: derived from production's name, never typed."""

import logging
from unittest.mock import AsyncMock

import asyncpg
import pytest

from pipeline.preview_run import (
    PreviewDatabaseError,
    enter_preview_database,
    gold_connection,
    gold_database_name,
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


def test_the_gold_database_is_the_preview_name_without_its_suffix() -> None:
    assert gold_database_name("dashboard_preview") == "dashboard"


@pytest.mark.parametrize("name", ["dashboard", "", "_preview", "preview_dashboard"])
def test_a_name_that_is_not_a_preview_database_has_no_gold(name: str) -> None:
    with pytest.raises(PreviewDatabaseError, match="_preview"):
        gold_database_name(name)


_PREVIEW_ENV = {
    "DB_HOST": "db.example",
    "DB_PORT": "6543",
    "DB_NAME": "dashboard_preview",
    "DB_USER": "owner",
    "DB_PASSWORD": "secret",
}


def _gold_connect(mocker) -> tuple[AsyncMock, AsyncMock, list[str]]:
    """Patch ``asyncpg.connect`` to a connection that records its lifecycle."""
    events: list[str] = []
    conn = AsyncMock()
    transaction = AsyncMock()
    transaction.__aenter__ = AsyncMock(
        side_effect=lambda *_: events.append("begin")
    )
    transaction.__aexit__ = AsyncMock(
        side_effect=lambda *_: events.append("end") or False
    )
    conn.transaction = mocker.Mock(return_value=transaction)
    conn.close = AsyncMock(side_effect=lambda: events.append("close"))
    connect = mocker.patch(
        "pipeline.preview_run.asyncpg.connect", new=AsyncMock(return_value=conn)
    )
    return connect, conn, events


async def test_the_gold_connection_reads_gold_inside_a_read_only_transaction(
    mocker,
) -> None:
    connect, conn, events = _gold_connect(mocker)
    async with gold_connection(_PREVIEW_ENV) as yielded:
        assert yielded is conn
        events.append("body")
    connect.assert_awaited_once_with(
        host="db.example",
        port=6543,
        user="owner",
        password="secret",
        database="dashboard",
    )
    # One snapshot: the gene reader's four SELECTs see the same gold.
    conn.transaction.assert_called_once_with(
        isolation="repeatable_read", readonly=True
    )
    assert events == ["begin", "body", "end", "close"]


async def test_the_gold_connection_is_closed_when_the_read_fails(mocker) -> None:
    _connect, _conn, events = _gold_connect(mocker)
    with pytest.raises(RuntimeError, match="read failed"):
        async with gold_connection(_PREVIEW_ENV):
            raise RuntimeError("read failed")
    assert events == ["begin", "end", "close"]


async def test_the_gold_connection_needs_a_preview_database_name(mocker) -> None:
    connect, _conn, _events = _gold_connect(mocker)
    with pytest.raises(PreviewDatabaseError):
        async with gold_connection({**_PREVIEW_ENV, "DB_NAME": "dashboard"}):
            pass
    connect.assert_not_awaited()


@pytest.mark.parametrize("missing", ["DB_HOST", "DB_USER", "DB_PASSWORD"])
async def test_the_gold_connection_needs_every_credential(
    mocker, missing: str
) -> None:
    connect, _conn, _events = _gold_connect(mocker)
    with pytest.raises(PreviewDatabaseError, match=missing):
        async with gold_connection({**_PREVIEW_ENV, missing: ""}):
            pass
    connect.assert_not_awaited()


async def test_the_gold_connection_defaults_the_port(mocker) -> None:
    env = {k: v for k, v in _PREVIEW_ENV.items() if k != "DB_PORT"}
    connect, _conn, _events = _gold_connect(mocker)
    async with gold_connection(env):
        pass
    assert connect.await_args is not None
    assert connect.await_args.kwargs["port"] == 5432


@pytest.mark.parametrize(
    "error",
    [asyncpg.InvalidCatalogNameError, asyncpg.InsufficientPrivilegeError],
)
async def test_a_gold_database_that_cannot_be_read_is_a_refusal(
    mocker, error: type[Exception]
) -> None:
    mocker.patch(
        "pipeline.preview_run.asyncpg.connect",
        new=AsyncMock(side_effect=error("no")),
    )
    with pytest.raises(PreviewDatabaseError, match="dashboard"):
        async with gold_connection(_PREVIEW_ENV):
            pass


async def test_the_gold_connection_needs_an_integer_port(mocker) -> None:
    connect, _conn, _events = _gold_connect(mocker)
    with pytest.raises(PreviewDatabaseError, match="'not-a-port'"):
        async with gold_connection({**_PREVIEW_ENV, "DB_PORT": "not-a-port"}):
            pass
    connect.assert_not_awaited()
