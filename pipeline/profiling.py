"""Tracy instrumentation, inert unless Tracy's profiling client is installed.

`deno task tracy:run CMD` runs CMD with ``tracy_client`` layered on the
environment: Tracy's own Python package, built from the ``third_party/tracy``
submodule with ``TRACY_ENABLE`` by `deno task tracy:build`. That is the
"separate build configuration" of the Tracy manual's §2.1. No other run has the
module, so every function here is a no-op that costs one branch, and
production runs collect nothing.

**Zones and asyncio.** Tracy keeps one zone stack per thread, and a zone must
close before the zone opened above it does (manual §3.4.2). Coroutines that
interleave on the event loop thread break that order the moment two of them
hold zones across an ``await``. The Python client has no fibers or sections to
untangle them. So:

- open a zone only where nothing else can open one on the same thread while it
  is held: around the pipeline's sequential stages, around synchronous code,
  or on a worker thread (``asyncio.to_thread``), which has its own stack;
- inside concurrent work (``process_papers_concurrently`` and the like), use
  ``plot`` and ``message``, which carry no ordering rule.
"""

import atexit
import importlib
import sys
import time
from types import FrameType, ModuleType, TracebackType
from typing import Any

# On macOS, Tracy drops whatever its client has not sent by the time the
# process exits (manual §2.1.10.3), and TRACY_NO_EXIT is not supported there.
# Measured on the spike: without a pause the last zone before exit is lost,
# and with 0.25 s it arrived in three runs out of three.
_EXIT_GRACE_S = 0.25


def _load() -> ModuleType | None:
    try:
        client = importlib.import_module("tracy_client")
    except ImportError:
        return None
    if not client.is_enabled():
        return None
    atexit.register(time.sleep, _EXIT_GRACE_S)
    return client


_client = _load()
_plot_ids: dict[str, int] = {}
_totals: dict[str, float] = {}


class _NullZone:
    def __enter__(self) -> _NullZone:
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        return None

    def text(self, text: str) -> None:
        return None


_NULL_ZONE = _NullZone()


class _Zone(_NullZone):
    def __init__(self, zone: Any) -> None:
        self._zone = zone

    def __enter__(self) -> _Zone:
        self._zone.enter()
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        self._zone.exit()

    def text(self, text: str) -> None:
        self._zone.text(text)


def _open(name: str, caller: FrameType) -> _Zone:
    # tracy_client.ScopedZone reads its *own* caller's frame, which would put
    # every zone at this module's line; the binding's base class takes the
    # source location as arguments instead.
    assert _client is not None
    return _Zone(
        _client.TracyClientBindings._ScopedZone(
            name,
            0,
            None,
            True,
            caller.f_code.co_name,
            caller.f_code.co_filename,
            caller.f_lineno,
        )
    )


class Stages:
    """Consecutive zones: each call ends the previous stage and starts the next.

    For a sequence of steps that would otherwise each need a ``with`` block.
    Use it as a context manager, so the last stage ends even on an exception.
    """

    def __init__(self) -> None:
        self._current: _Zone | None = None

    def __call__(self, name: str) -> None:
        self._end()
        if _client is not None:
            self._current = _open(name, sys._getframe(1)).__enter__()

    def _end(self) -> None:
        if self._current is not None:
            self._current.__exit__(None, None, None)
            self._current = None

    def __enter__(self) -> Stages:
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        self._end()


def enabled() -> bool:
    """Whether a profiling client is recording this process."""
    return _client is not None


def start(program: str, info: str) -> None:
    """Name the program and describe the run in the trace.

    Args:
        program: Shown in the profiler's client list and title bar. Keep it
            generic: no disease names (test_no_disease_literals.py).
        info: Free text for the trace's information window, such as the
            CLI flags.
    """
    if _client is None:
        return
    _client.program_name(program)
    _client.app_info(info)
    _client.thread_name("main")


def zone(name: str) -> _NullZone:
    """A context manager timing its body as a Tracy zone named ``name``.

    The zone is attributed to the caller's function, file and line. Mind the
    asyncio rule in the module docstring.
    """
    if _client is None:
        return _NULL_ZONE
    return _open(name, sys._getframe(1))


def stages() -> Stages:
    """Consecutive zones; see ``Stages``."""
    return Stages()


def plot(name: str, value: float) -> None:
    """Add a point to the plot ``name``; safe inside concurrent work."""
    if _client is None:
        return
    plot_id = _plot_ids.get(name)
    if plot_id is None:
        plot_id = _plot_ids[name] = _client.plot_config(
            name, _client.PlotFormatType.Number
        )
    _client.plot(plot_id, value)


def adjust(name: str, delta: float) -> None:
    """Add ``delta`` to a running total and plot it; safe in concurrent work.

    For a level rather than an event, such as how many papers are in flight.
    """
    if _client is None:
        return
    _totals[name] = total = _totals.get(name, 0) + delta
    plot(name, total)


def message(text: str) -> None:
    """Log ``text`` on the trace's timeline; safe inside concurrent work."""
    if _client is None:
        return
    _client.message(text)
