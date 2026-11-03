"""No test process may hold the developer's database credentials.

`_isolate_credentials` clears the `DB_*` variables for the length of each
test, and monkeypatch puts back afterwards whatever was there -- which, with
.env populated, is production: `pipeline/main.py` calls `load_dotenv()` at
import. So between tests, in fixture setup and teardown and in work still
pending on the event loop, a pool opened against production could and did
write to it: on 2026-11-03 a suite run left a zero-filled `external_sync` row
in production's `sync_runs`, which the export publishes as the newest refresh.
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
