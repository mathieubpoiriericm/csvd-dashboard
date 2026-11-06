"""pipeline.profiling: inert without Tracy's client, a thin delegate with it.

The real client (a native wheel built by `deno task tracy:build`) never exists
in the test environment, so the delegating path runs against a fake
``tracy_client`` module that records what it is asked to do.
"""

import importlib
import sys
import types
from collections.abc import Iterator

import pytest

from pipeline import profiling


class _FakeZone:
    def __init__(self, calls: list, *args: object) -> None:
        self._calls = calls
        name, color, depth, active, function, file, line = args
        calls.append(("zone", name, color, depth, active, function, file, line))

    def enter(self) -> None:
        self._calls.append(("enter",))

    def exit(self) -> None:
        self._calls.append(("exit",))

    def text(self, text: str) -> bool:
        self._calls.append(("text", text))
        return True


def _fake_client(calls: list, *, enabled: bool = True) -> types.ModuleType:
    client = types.ModuleType("tracy_client")
    bindings = types.ModuleType("tracy_client.TracyClientBindings")

    def scoped_zone(*args: object) -> _FakeZone:
        return _FakeZone(calls, *args)

    def plot_config(name: str, type: int) -> int:
        calls.append(("plot_config", name, type))
        return 100 + len([c for c in calls if c[0] == "plot_config"])

    def record(kind: str):
        def call(*args: object) -> bool:
            calls.append((kind, *args))
            return True

        return call

    # setattr, because a type checker cannot see attributes added to a module.
    setattr(bindings, "_ScopedZone", scoped_zone)  # noqa: B010
    attributes = {
        "TracyClientBindings": bindings,
        "PlotFormatType": types.SimpleNamespace(Number=0),
        "is_enabled": lambda: enabled,
        "plot_config": plot_config,
    }
    for kind in ("plot", "message", "program_name", "app_info", "thread_name"):
        attributes[kind] = record(kind)
    for name, value in attributes.items():
        setattr(client, name, value)
    return client


@pytest.fixture
def with_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[list]:
    """Reload pipeline.profiling against a fake, enabled tracy_client."""
    calls: list = []
    monkeypatch.setitem(sys.modules, "tracy_client", _fake_client(calls))
    monkeypatch.setattr(
        profiling.atexit, "register", lambda *a: calls.append(("atexit", *a))
    )
    importlib.reload(profiling)
    yield calls
    monkeypatch.undo()
    importlib.reload(profiling)


def test_inert_without_the_client(monkeypatch: pytest.MonkeyPatch) -> None:
    # None in sys.modules makes `import tracy_client` raise ImportError, as in
    # every run that does not go through `deno task tracy:run`.
    monkeypatch.setitem(sys.modules, "tracy_client", None)
    importlib.reload(profiling)
    try:
        assert profiling.enabled() is False
        with profiling.zone("stage") as zone:
            zone.text("ignored")
        profiling.plot("papers in flight", 3)
        profiling.message("ignored")
        profiling.start("pipeline", "ignored")
    finally:
        monkeypatch.undo()
        importlib.reload(profiling)


def test_a_built_but_disabled_client_is_inert(monkeypatch: pytest.MonkeyPatch) -> None:
    # A wheel built without TRACY_ENABLE imports fine but records nothing.
    calls: list = []
    monkeypatch.setitem(sys.modules, "tracy_client", _fake_client(calls, enabled=False))
    monkeypatch.setattr(
        profiling.atexit, "register", lambda *a: calls.append(("atexit", *a))
    )
    importlib.reload(profiling)
    try:
        assert profiling.enabled() is False
        with profiling.zone("stage"):
            pass
        profiling.message("ignored")
        assert calls == []
    finally:
        monkeypatch.undo()
        importlib.reload(profiling)


def test_enabled_client_registers_the_exit_grace(with_client: list) -> None:
    assert profiling.enabled() is True
    assert with_client == [("atexit", profiling.time.sleep, profiling._EXIT_GRACE_S)]


def test_zone_is_attributed_to_the_caller(with_client: list) -> None:
    with_client.clear()
    line = sys._getframe().f_lineno + 1
    with profiling.zone("merge genes") as zone:
        zone.text("42 genes")

    function = "test_zone_is_attributed_to_the_caller"
    assert with_client == [
        ("zone", "merge genes", 0, None, True, function, __file__, line),
        ("enter",),
        ("text", "42 genes"),
        ("exit",),
    ]


def test_zone_exits_when_the_body_raises(with_client: list) -> None:
    with_client.clear()
    with pytest.raises(RuntimeError), profiling.zone("stage"):
        raise RuntimeError("boom")
    assert with_client[-1] == ("exit",)


def test_plot_configures_each_name_once(with_client: list) -> None:
    with_client.clear()
    profiling.plot("papers in flight", 1)
    profiling.plot("papers in flight", 2)
    profiling.plot("papers done", 5)

    assert with_client == [
        ("plot_config", "papers in flight", 0),
        ("plot", 101, 1),
        ("plot", 101, 2),
        ("plot_config", "papers done", 0),
        ("plot", 102, 5),
    ]


def test_adjust_plots_a_running_total(with_client: list) -> None:
    with_client.clear()
    profiling.adjust("papers in flight", 1)
    profiling.adjust("papers in flight", 1)
    profiling.adjust("papers in flight", -1)

    assert [call for call in with_client if call[0] == "plot"] == [
        ("plot", 101, 1),
        ("plot", 101, 2),
        ("plot", 101, 1),
    ]


def test_stages_close_each_zone_before_opening_the_next(with_client: list) -> None:
    with_client.clear()
    with profiling.stages() as stage:
        stage("read genes")
        stage("write files")

    names = [call[1] for call in with_client if call[0] == "zone"]
    order = [call[0] for call in with_client]
    assert names == ["read genes", "write files"]
    assert order == ["zone", "enter", "exit", "zone", "enter", "exit"]


def test_stages_close_the_open_zone_on_an_exception(with_client: list) -> None:
    with_client.clear()
    with pytest.raises(RuntimeError), profiling.stages() as stage:
        stage("read genes")
        raise RuntimeError("database gone")
    assert with_client[-1] == ("exit",)


def test_stages_without_the_client_do_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "tracy_client", None)
    importlib.reload(profiling)
    try:
        with profiling.stages() as stage:
            stage("read genes")
        profiling.adjust("papers in flight", 1)
    finally:
        monkeypatch.undo()
        importlib.reload(profiling)


def test_start_names_the_program_and_its_thread(with_client: list) -> None:
    with_client.clear()
    profiling.start("pipeline", "--days-back 7")
    profiling.message("PMID 1 done")

    assert with_client == [
        ("program_name", "pipeline"),
        ("app_info", "--days-back 7"),
        ("thread_name", "main"),
        ("message", "PMID 1 done"),
    ]
