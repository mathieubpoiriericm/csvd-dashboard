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

import atexit
import os
import shutil
import tempfile

DATABASE_CREDENTIALS = ("DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD")


def shut_out_dotenv_database_credentials() -> None:
    for name in DATABASE_CREDENTIALS:
        os.environ.setdefault(name, "")


def keep_pipeline_logs_out_of_the_project() -> None:
    """Send `pipeline/main.py`'s log directory to a temp directory.

    `pipeline.main` reads `PIPELINE_LOG_DIR` once, at import, falling back to
    the project's `logs/`, opens a log file in `logs/log/` there, and writes
    every run report into `logs/json/`. A test that drove `run_pipeline`
    without mocking `_emit_report` left a report in the developer's
    `logs/json/` -- 69 of them by 2026-11-13 -- that
    `scripts.restore_from_json.ledger_from_logs` reads as production history,
    and each test process left a log file beside the real runs'. Set before
    anything imports the pipeline, so the import-time log file lands here too;
    `_isolate_log_dir` then points each test at its own `tmp_path`.
    As above, a value exported in the shell is kept.
    """
    if "PIPELINE_LOG_DIR" in os.environ:
        return
    log_dir = tempfile.mkdtemp(prefix="csvd-test-logs-")
    atexit.register(shutil.rmtree, log_dir, ignore_errors=True)
    os.environ["PIPELINE_LOG_DIR"] = log_dir
