"""The names a pytest-xdist worker's throwaway database and container take."""

import pytest
from tests.xdist_databases import (
    container_name,
    quote_identifier,
    quote_literal,
    session_database,
    worker_database_name,
)


def test_a_worker_database_is_the_base_name_with_the_worker_suffix() -> None:
    assert worker_database_name("csvd_ci", "gw0") == "csvd_ci_gw0"
    assert worker_database_name("csvd_ci", "gw11") == "csvd_ci_gw11"


@pytest.mark.parametrize("worker", ["gw", "0", "gw0;", 'gw0" OR 1', "../gw0", ""])
def test_a_worker_id_that_is_not_gw_digits_is_refused(worker: str) -> None:
    with pytest.raises(ValueError, match="xdist worker"):
        worker_database_name("csvd_ci", worker)


def test_a_serial_run_keeps_the_container_name() -> None:
    assert container_name("csvd-pg-pytest", None) == "csvd-pg-pytest"
    assert container_name("csvd-pg-pytest", "gw3") == "csvd-pg-pytest-gw3"
    with pytest.raises(ValueError, match="xdist worker"):
        container_name("csvd-pg-pytest", "x")


def test_a_name_past_the_63_byte_identifier_limit_is_refused() -> None:
    # PostgreSQL truncates a longer identifier silently, which would give
    # every worker the same database -- and each would drop the others'.
    assert worker_database_name("x" * 59, "gw0") == "x" * 59 + "_gw0"
    with pytest.raises(ValueError, match="63-byte"):
        worker_database_name("x" * 60, "gw0")


def test_an_identifier_is_quoted_with_its_quotes_doubled() -> None:
    assert quote_identifier("csvd_ci_gw0") == '"csvd_ci_gw0"'
    assert quote_identifier('a"b') == '"a""b"'


_BASE = {
    "DB_HOST": "localhost",
    "DB_PORT": "5432",
    "DB_NAME": "csvd_ci",
    "DB_USER": "csvd_ci",
    "DB_PASSWORD": "csvd_ci",
}
_TERMINATE = (
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity"
    " WHERE datname = 'csvd_ci_gw1' AND usename = current_user"
    " AND pid <> pg_backend_pid()"
)
_DROP = 'DROP DATABASE IF EXISTS "csvd_ci_gw1"'
_CREATE = 'CREATE DATABASE "csvd_ci_gw1"'


class _Recorder:
    def __init__(self, *, failing_upgrade: bool = False) -> None:
        self.admin: list[tuple[str, tuple[str, ...]]] = []
        self.upgraded: list[str] = []
        self.failing_upgrade = failing_upgrade

    def run_admin(self, settings: dict[str, str], *statements: str) -> None:
        self.admin.append((settings["DB_NAME"], statements))

    def upgrade(self, settings: dict[str, str]) -> None:
        self.upgraded.append(settings["DB_NAME"])
        if self.failing_upgrade:
            raise RuntimeError("migration failed")

    def session(self, worker: str | None = "gw1"):
        return session_database(
            _BASE, worker, admin=self.run_admin, upgrade=self.upgrade
        )


def test_a_serial_session_migrates_the_configured_database_and_drops_nothing() -> None:
    calls = _Recorder()
    session = calls.session(None)
    assert next(session) == _BASE
    with pytest.raises(StopIteration):
        next(session)
    assert calls.upgraded == ["csvd_ci"]
    assert calls.admin == []


def test_a_worker_session_recreates_its_database_and_drops_it_after() -> None:
    calls = _Recorder()
    session = calls.session()
    assert next(session) == {**_BASE, "DB_NAME": "csvd_ci_gw1"}
    assert calls.admin == [("csvd_ci", (_TERMINATE, _DROP, _CREATE))]
    assert calls.upgraded == ["csvd_ci_gw1"]
    with pytest.raises(StopIteration):
        next(session)
    assert calls.admin[-1] == ("csvd_ci", (_TERMINATE, _DROP))


def test_no_drop_uses_force() -> None:
    # WITH (FORCE) terminates every session, and terminating an autovacuum
    # worker -- it carries no role -- needs superuser or pg_signal_backend,
    # which the mini PC's CREATEDB-only role lacks: autovacuum on a worker
    # database failed runner-11's setup on 2026-11-05. Our own role's sessions
    # are terminated explicitly instead, which needs no privilege, and the
    # plain DROP that follows stops autovacuum by itself.
    calls = _Recorder()
    session = calls.session()
    next(session)
    with pytest.raises(StopIteration):
        next(session)
    assert not any("FORCE" in s for _, stmts in calls.admin for s in stmts)


def test_only_our_own_sessions_on_the_worker_database_are_terminated() -> None:
    calls = _Recorder()
    next(calls.session())
    terminate = calls.admin[0][1][0]
    assert "datname = 'csvd_ci_gw1'" in terminate
    assert "usename = current_user" in terminate
    assert "pid <> pg_backend_pid()" in terminate


def test_a_literal_is_quoted_with_its_quotes_doubled() -> None:
    assert quote_literal("csvd_ci_gw0") == "'csvd_ci_gw0'"
    assert quote_literal("a'b") == "'a''b'"


def test_the_worker_database_is_dropped_even_when_migrating_it_fails() -> None:
    calls = _Recorder(failing_upgrade=True)
    session = calls.session()
    with pytest.raises(RuntimeError, match="migration failed"):
        next(session)
    assert calls.admin[-1] == ("csvd_ci", (_TERMINATE, _DROP))
