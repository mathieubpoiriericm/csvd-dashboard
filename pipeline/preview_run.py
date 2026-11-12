"""The preview run's database, a sibling of production named after it.

A ``--preview`` run is the one way past the gold-only refusal of ``--pubmed``:
it extracts and merges like any PubMed run, but into ``<DB_NAME>_preview``
rather than the production database. The name is derived, never passed on the
command line, so no spelling of the flag can aim a run at production.
"""

import os
from collections.abc import MutableMapping
from typing import Final

import asyncpg

from pipeline.database import Database

PREVIEW_SUFFIX: Final = "_preview"


class PreviewDatabaseError(ValueError):
    """The preview database cannot be named or does not exist."""


def preview_database_name(name: str) -> str:
    """Return the preview database's name for a production database name."""
    return f"{name}{PREVIEW_SUFFIX}"


def enter_preview_database(
    environ: MutableMapping[str, str] = os.environ,
) -> str:
    """Point this process at the preview database and return its name.

    Rewrites ``DB_NAME`` in place, so everything that connects afterwards
    reaches the preview database.

    Raises:
        PreviewDatabaseError: If ``DB_NAME`` is unset or empty.
    """
    name = environ.get("DB_NAME")
    if not name:
        raise PreviewDatabaseError(
            "--preview derives its database from DB_NAME, which is unset"
        )
    preview = preview_database_name(name)
    environ["DB_NAME"] = preview
    return preview


async def require_preview_database() -> None:
    """Open one connection, so a missing preview database fails up front.

    Raises:
        PreviewDatabaseError: If the database does not exist; the message
            carries the ``createdb`` command that makes it.
    """
    try:
        async with Database.connection():
            pass
    except asyncpg.InvalidCatalogNameError as exc:
        name = os.environ.get("DB_NAME", "")
        user = os.environ.get("DB_USER", "")
        raise PreviewDatabaseError(
            f"the preview database {name!r} does not exist; create it with"
            f" `createdb -O {user} {name}` and run the migrations against it"
            " (`cd pipeline && uv run alembic upgrade head`)"
        ) from exc
