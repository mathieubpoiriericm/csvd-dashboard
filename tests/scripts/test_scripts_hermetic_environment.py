"""No scripts test may run with the developer's database credentials.

The scripts import the pipeline, which loads .env at import, and this tree
has no per-test isolation fixture of its own -- so before tests/scripts/
conftest.py called `shut_out_dotenv_database_credentials()`, every test here
ran with production's `DB_*` in `os.environ`. The twin in tests/pipeline is
`test_hermetic_environment.py`; the basenames differ because the two trees
carry no `__init__.py`, and pytest refuses two test modules of one name when
both trees are collected together.
"""

import os

import pipeline.main  # noqa: F401 -- loads .env, the way every suite run does

_CREDENTIALS = ("DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD")
# Read at collection, outside any test, where the fixture cannot help.
_AT_COLLECTION = {name: os.environ.get(name) for name in _CREDENTIALS}


def test_the_process_holds_no_database_credentials_from_dotenv() -> None:
    leaked = sorted(name for name, value in _AT_COLLECTION.items() if value)
    assert leaked == [], (
        f"{', '.join(leaked)} came into the test process from .env; a pool "
        "opened outside a test would reach that database"
    )
