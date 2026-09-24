import json
import sqlite3
from unittest.mock import MagicMock

from pipeline.event_log import EventLog


def _read_events(db_path: str) -> list[tuple[str, dict, str]]:
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT event_type, payload, created_at FROM events ORDER BY id"
        ).fetchall()
    finally:
        conn.close()
    return [
        (event_type, json.loads(payload), created_at)
        for event_type, payload, created_at in rows
    ]


def test_record_persists_event(tmp_path):
    db_path = str(tmp_path / "events.db")

    with EventLog(db_path) as log:
        log.record("pipeline_completed", {"genes": 5})

    events = _read_events(db_path)
    assert len(events) == 1
    assert events[0][0] == "pipeline_completed"
    assert events[0][1] == {"genes": 5}
    assert events[0][2]


def test_multiple_events_preserve_order(tmp_path):
    db_path = str(tmp_path / "events.db")

    with EventLog(db_path) as log:
        log.record("pipeline_completed", {"run": 1})
        log.record("pipeline_completed", {"run": 2})

    assert [payload for _, payload, _ in _read_events(db_path)] == [
        {"run": 1},
        {"run": 2},
    ]


def test_close_failure_is_logged_without_masking_error(caplog):
    log = object.__new__(EventLog)
    log._conn = MagicMock()
    log._conn.close.side_effect = RuntimeError("locked")

    log.close()

    assert "Error closing event log: locked" in caplog.text
