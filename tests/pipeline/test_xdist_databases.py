"""The names a pytest-xdist worker's throwaway database and container take."""

import pytest
from tests.xdist_databases import (
    container_name,
    quote_identifier,
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
_DROP = 'DROP DATABASE IF EXISTS "csvd_ci_gw1"'
_FORCE = f"{_DROP} WITH (FORCE)"
_CREATE = 'CREATE DATABASE "csvd_ci_gw1"'


class _InUse(Exception):
    """Stands in for asyncpg's ObjectInUseError: another session is connected."""


class _Recorder:
    def __init__(
        self,
        *,
        failing_upgrade: bool = False,
        in_use_on: frozenset[int] = frozenset(),
        drop_error: Exception | None = None,
    ) -> None:
        self.admin: list[tuple[str, tuple[str, ...]]] = []
        self.upgraded: list[str] = []
        self.failing_upgrade = failing_upgrade
        # Which plain drops (0 = at the start, 1 = at the end) find the
        # database still in use, as a crashed run's own session leaves it.
        self.in_use_on = in_use_on
        self.drop_error = drop_error
        self._plain_drops = 0

    def run_admin(self, settings: dict[str, str], *statements: str) -> None:
        self.admin.append((settings["DB_NAME"], statements))
        if statements == (_DROP,):
            index, self._plain_drops = self._plain_drops, self._plain_drops + 1
            if self.drop_error is not None:
                raise self.drop_error
            if index in self.in_use_on:
                raise _InUse('database "csvd_ci_gw1" is being accessed by other users')

    def upgrade(self, settings: dict[str, str]) -> None:
        self.upgraded.append(settings["DB_NAME"])
        if self.failing_upgrade:
            raise RuntimeError("migration failed")

    def session(self, worker: str | None = "gw1"):
        return session_database(
            _BASE, worker, admin=self.run_admin, upgrade=self.upgrade, in_use=_InUse
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
    # Plain drops, not WITH (FORCE): PostgreSQL stops an autovacuum worker on
    # the database itself for a plain DROP, while FORCE needs superuser or
    # pg_signal_backend to terminate one -- which the mini PC's CREATEDB-only
    # role lacks, and which failed runner-11's setup on 2026-11-05.
    calls = _Recorder()
    session = calls.session()
    assert next(session) == {**_BASE, "DB_NAME": "csvd_ci_gw1"}
    assert calls.admin == [("csvd_ci", (_DROP,)), ("csvd_ci", (_CREATE,))]
    assert calls.upgraded == ["csvd_ci_gw1"]
    with pytest.raises(StopIteration):
        next(session)
    assert calls.admin[-1] == ("csvd_ci", (_DROP,))
    assert not any("FORCE" in s for _, stmts in calls.admin for s in stmts)


def test_a_leftover_still_in_use_is_dropped_with_force() -> None:
    # A crashed run can leave a session of our own role connected, which a
    # plain DROP refuses; FORCE may terminate it.
    calls = _Recorder(in_use_on=frozenset({0}))
    session = calls.session()
    next(session)
    assert calls.admin == [
        ("csvd_ci", (_DROP,)),
        ("csvd_ci", (_FORCE,)),
        ("csvd_ci", (_CREATE,)),
    ]


def test_the_drop_after_the_session_falls_back_to_force_too() -> None:
    calls = _Recorder(in_use_on=frozenset({1}))
    session = calls.session()
    next(session)
    with pytest.raises(StopIteration):
        next(session)
    assert calls.admin[-2:] == [("csvd_ci", (_DROP,)), ("csvd_ci", (_FORCE,))]


def test_a_drop_that_fails_for_another_reason_raises_without_trying_force() -> None:
    calls = _Recorder(drop_error=RuntimeError("could not connect"))
    session = calls.session()
    with pytest.raises(RuntimeError, match="could not connect"):
        next(session)
    assert calls.admin == [("csvd_ci", (_DROP,))]


def test_the_worker_database_is_dropped_even_when_migrating_it_fails() -> None:
    calls = _Recorder(failing_upgrade=True)
    session = calls.session()
    with pytest.raises(RuntimeError, match="migration failed"):
        next(session)
    assert calls.admin[-1] == ("csvd_ci", (_DROP,))
