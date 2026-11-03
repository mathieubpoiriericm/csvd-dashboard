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


def test_a_dotenv_load_inside_a_test_cannot_restore_the_credentials() -> None:
    """What a lazy import does: `_publish_export` imports pipeline.export.main
    inside a test, and that module calls `load_dotenv()` at import.

    `load_dotenv` fills any variable that is *absent*. `_isolate_credentials`
    used to delete these four, so the import put production's values back
    mid-test, and the dispatcher test that ran next recorded its sync row in
    production: rows 21-24 of `sync_runs` on 2026-11-03, from partial runs of
    test_main_orchestration.py (a full run imports the module at collection,
    under the hermetic guard, which is why it never showed there).
    """
    from dotenv import load_dotenv

    from pipeline.config import PROJECT_ROOT

    load_dotenv(PROJECT_ROOT / ".env")
    leaked = sorted(name for name in _CREDENTIALS if os.environ.get(name))
    assert leaked == [], f"{', '.join(leaked)} refilled from .env inside a test"
