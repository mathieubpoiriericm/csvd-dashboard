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
the shape xdist itself produces is accepted.
"""

import re

_WORKER_ID = re.compile(r"gw\d+")


def _checked(worker: str) -> str:
    if not _WORKER_ID.fullmatch(worker):
        raise ValueError(f"not an xdist worker id: {worker!r}")
    return worker


def worker_database_name(base: str, worker: str) -> str:
    """The database `worker` uses on the server whose database is `base`."""
    return f"{base}_{_checked(worker)}"


def container_name(base: str, worker: str | None) -> str:
    """The local container a session uses: `base` itself when serial."""
    return base if worker is None else f"{base}-{_checked(worker)}"
