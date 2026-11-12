"""The preview run's database, a sibling of production named after it.

A ``--preview`` run is the one way past the gold-only refusal of ``--pubmed``:
it extracts and merges like any PubMed run, but into ``<DB_NAME>_preview``
rather than the production database. The name is derived, never passed on the
command line, so no spelling of the flag can aim a run at production.
"""

import logging
import os
from collections.abc import MutableMapping
from typing import Final

import asyncpg

from pipeline.database import Database

logger = logging.getLogger(__name__)

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
    """Prove the connection reaches the preview database, before any work.

    Asks the server which database it is connected to rather than trusting
    ``DB_NAME``, so whatever else could redirect the connection is caught
    before a paid run writes to production.

    Raises:
        PreviewDatabaseError: If the database does not exist (the message
            carries the ``createdb`` command that makes it), or if the server
            reports a database whose name does not end in ``_preview``.
    """
    try:
        async with Database.connection() as conn:
            database = await conn.fetchval("SELECT current_database()")
    except asyncpg.InvalidCatalogNameError as exc:
        name = os.environ.get("DB_NAME", "")
        user = os.environ.get("DB_USER", "")
        raise PreviewDatabaseError(
            f"the preview database {name!r} does not exist; create it with"
            f" `createdb -O {user} {name}` and fill it as the regenerate-data"
            " skill's \"The preview database\" section says"
        ) from exc
    if not isinstance(database, str) or not database.endswith(PREVIEW_SUFFIX):
        raise PreviewDatabaseError(
            f"the connection reached the database {database!r}, whose name"
            f" does not end in {PREVIEW_SUFFIX!r}; a preview run writes only"
            " to the preview database"
        )
    logger.info(f"Preview run: writing to {database}")
