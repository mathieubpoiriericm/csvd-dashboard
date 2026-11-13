"""The preview run's database, a sibling of production named after it.

A ``--preview`` run is the one way past the gold-only refusal of ``--pubmed``:
it extracts and merges like any PubMed run, but into ``<DB_NAME>_preview``
rather than the production database. The name is derived, never passed on the
command line, so no spelling of the flag can aim a run at production.

The preview export reads production too, as the *gold* database a review
round is diffed against -- through `gold_connection`, which is read-only.
"""

import logging
import os
from collections.abc import AsyncGenerator, Mapping, MutableMapping
from contextlib import asynccontextmanager
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


def gold_database_name(preview: str) -> str:
    """Return the production (gold) database's name for a preview database's.

    The inverse of `preview_database_name`, and as strict: only a name that
    ends in the suffix after something has a gold sibling.

    Raises:
        PreviewDatabaseError: If ``preview`` is not a preview database's name.
    """
    gold = preview.removesuffix(PREVIEW_SUFFIX)
    if gold == preview or not gold:
        raise PreviewDatabaseError(
            f"{preview!r} is not a preview database's name: it does not end in"
            f" {PREVIEW_SUFFIX!r} after a production database's name"
        )
    return gold


@asynccontextmanager
async def gold_connection(
    environ: Mapping[str, str] = os.environ,
) -> AsyncGenerator[asyncpg.Connection]:
    """A read-only connection to the gold database beside the preview one.

    Opened with the preview's own ``DB_HOST``, ``DB_PORT``, ``DB_USER`` and
    ``DB_PASSWORD`` -- the two databases are siblings on one server -- and
    with the name `gold_database_name` derives from ``DB_NAME``, so it is
    reachable only from a process that has entered the preview database.
    A connection of its own rather than the shared pool, which is the
    preview's. Everything runs inside one read-only, repeatable-read
    transaction, so the server refuses any write to production and every
    read sees the same snapshot, and the connection is closed on the way out
    however the body ends.

    Raises:
        PreviewDatabaseError: If ``DB_NAME`` is not a preview database's
            name, a credential is unset or empty, or the gold database does
            not exist or this role may not connect to it.
    """
    database = gold_database_name(environ.get("DB_NAME", ""))
    required = ("DB_HOST", "DB_USER", "DB_PASSWORD")
    if missing := [name for name in required if not environ.get(name)]:
        raise PreviewDatabaseError(
            f"the gold database needs {', '.join(missing)}, which is unset"
        )
    port_raw = environ.get("DB_PORT") or "5432"
    try:
        port = int(port_raw)
    except ValueError:
        raise PreviewDatabaseError(
            f"DB_PORT must be an integer, got {port_raw!r}"
        ) from None
    try:
        conn = await asyncpg.connect(
            host=environ["DB_HOST"],
            port=port,
            user=environ["DB_USER"],
            password=environ["DB_PASSWORD"],
            database=database,
        )
    except (asyncpg.InvalidCatalogNameError, asyncpg.InsufficientPrivilegeError) as e:
        # A refusal like the others, so `main` prints it and exits 1 rather
        # than ending the export in a traceback.
        raise PreviewDatabaseError(
            f"the gold database {database} could not be read: {e}"
        ) from e
    try:
        # Repeatable read, so the gene reader's several SELECTs see one
        # snapshot of gold even if it is written to meanwhile.
        async with conn.transaction(isolation="repeatable_read", readonly=True):
            yield conn
    finally:
        await conn.close()


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
