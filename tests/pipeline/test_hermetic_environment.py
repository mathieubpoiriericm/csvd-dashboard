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

import pipeline.main  # loads .env, the way every suite run does

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


def test_the_import_time_log_file_is_outside_the_project() -> None:
    """`pipeline.main` opens its log file at import, in `PIPELINE_LOG_DIR`
    or the project's `logs/`; the conftest sets the variable first, so a
    suite run leaves no log file beside the real runs'."""
    from pipeline.config import PROJECT_ROOT

    project_logs = (PROJECT_ROOT / "logs").resolve()
    assert not pipeline.main.LOG_FILE.resolve().is_relative_to(project_logs)


def test_run_reports_go_to_the_test_s_own_directory(tmp_path) -> None:
    """`_emit_report` writes to `LOG_DIR / "json"`, read at call time: a test
    that runs the pipeline unmocked left synthetic reports in `logs/json/`,
    which `scripts.restore_from_json` reads back as production history. The
    directory is the test's own, and not inside its `tmp_path`, which a test
    may list."""
    from pipeline.config import PROJECT_ROOT

    log_dir = pipeline.main.LOG_DIR
    assert os.environ["PIPELINE_LOG_DIR"] == str(log_dir)
    assert log_dir.is_dir()
    assert not log_dir.resolve().is_relative_to(PROJECT_ROOT.resolve())
    assert not log_dir.resolve().is_relative_to(tmp_path.resolve())
    assert list(tmp_path.iterdir()) == []
