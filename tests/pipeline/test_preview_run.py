"""The preview run's database: derived from production's name, never typed."""

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
