"""Keep .env's database credentials out of a test process altogether.

`pipeline/main.py` and `pipeline/export/main.py` call `load_dotenv()` at
import, and `load_dotenv` never overrides a variable that is already set. So
setting these to empty *before* anything imports the pipeline is what stops
the developer's production credentials entering the process at all. The
per-test `_isolate_credentials` fixture is not enough on its own: monkeypatch
restores what it cleared, so between tests -- and in fixture teardown, or in
a task still pending on the event loop -- the restored values pointed a
newly opened pool at production. An empty value reads as missing to
`Database.get_pool`, exactly as an absent one does.

`setdefault`, not assignment: a value exported in the shell is kept, and
`test_hermetic_environment.py` then fails loudly -- by design, since a
production credential exported by hand is the same hazard as one loaded from
.env. CI exports only `CSVD_TEST_DB_URL`, a different variable, which
`database_env` turns into these four inside the tests that ask for it.
`DB_PORT` is left alone -- it is no credential, and without the four below
nothing can connect anyway.
"""

import os

DATABASE_CREDENTIALS = ("DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD")


def shut_out_dotenv_database_credentials() -> None:
    for name in DATABASE_CREDENTIALS:
        os.environ.setdefault(name, "")
