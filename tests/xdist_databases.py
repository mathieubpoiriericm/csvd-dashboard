"""Names for the throwaway database a pytest-xdist worker uses.

Under `-n` every worker is its own pytest session, so the session-scoped
`throwaway_postgres` fixture runs once per worker -- and four test files
migrate and write the same tables. Sharing one database, two workers collide
on primary keys. pytest-xdist's own answer, `xdist_group` with
`--dist loadgroup`, keeps a group on one worker by suffixing node ids, and on
pytest 9.2.0 it does not: grouped tests spread across workers on xdist 3.6.1,
3.7.0 and 3.8.0 alike, reproduced on a minimal suite outside this repository.
So isolation is per worker instead of per group: each worker gets a database
(or, without `CSVD_TEST_DB_URL`, a container) of its own, and a database test
added later is isolated without anyone marking it.

The worker id becomes part of an SQL identifier and a container name, so only
the shape xdist itself produces is accepted, and a name longer than
PostgreSQL's 63-byte identifier limit is refused rather than truncated:
truncation would give every worker one database, and each would drop the
others'. `session_database` is the per-session logic itself, with the two
calls that need a server passed in so a test can record them.
"""

import re
from collections.abc import Callable, Iterator

_WORKER_ID = re.compile(r"gw\d+")
_MAX_IDENTIFIER_BYTES = 63


def _checked(worker: str) -> str:
    if not _WORKER_ID.fullmatch(worker):
        raise ValueError(f"not an xdist worker id: {worker!r}")
    return worker


def worker_database_name(base: str, worker: str) -> str:
    """The database `worker` uses on the server whose database is `base`."""
    name = f"{base}_{_checked(worker)}"
    if len(name.encode()) > _MAX_IDENTIFIER_BYTES:
        raise ValueError(
            f"{name!r} is longer than PostgreSQL's 63-byte identifier limit;"
            " give CSVD_TEST_DB_URL a shorter database name"
        )
    return name


def quote_identifier(name: str) -> str:
    """`name` as an SQL identifier, its own double quotes doubled."""
    return '"' + name.replace('"', '""') + '"'


def session_database(
    settings: dict[str, str],
    worker: str | None,
    *,
    admin: Callable[..., None],
    upgrade: Callable[[dict[str, str]], None],
) -> Iterator[dict[str, str]]:
    """The database one pytest session uses on the server `settings` names.

    Serial, it is that database itself, migrated, and nothing is created or
    dropped. Under xdist it is the worker's own: dropped first (a crashed
    run's leftover), created, migrated, yielded, and dropped again even when
    the migration fails. `admin(settings, *statements)` runs statements
    connected to the base database; `upgrade(settings)` migrates to head.
    """
    if worker is None:
        upgrade(settings)
        yield settings
        return
    worker_settings = {
        **settings,
        "DB_NAME": worker_database_name(settings["DB_NAME"], worker),
    }
    name = quote_identifier(worker_settings["DB_NAME"])
    drop = f"DROP DATABASE IF EXISTS {name} WITH (FORCE)"
    admin(settings, drop, f"CREATE DATABASE {name}")
    try:
        upgrade(worker_settings)
        yield worker_settings
    finally:
        admin(settings, drop)


def container_name(base: str, worker: str | None) -> str:
    """The local container a session uses: `base` itself when serial."""
    return base if worker is None else f"{base}-{_checked(worker)}"
