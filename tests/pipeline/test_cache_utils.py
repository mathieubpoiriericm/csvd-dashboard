"""Tests for shared cache and batch-fetch helpers."""

import asyncio
from collections import OrderedDict
from unittest.mock import AsyncMock, call

import pytest

from pipeline.cache_utils import (
    SyncResult,
    evict_lru,
    make_log_progress,
    run_batched_fetch,
    single_flight_get,
    sync_cache_misses,
)


def test_sync_result_has_independent_empty_defaults():
    first = SyncResult()
    second = SyncResult()

    first.errors.append("failed")

    assert (first.fetched, first.cached, first.failed) == (0, 0, 0)
    assert second.errors == []


async def test_run_batched_fetch_preserves_order_and_reports_each_completion():
    progress: list[tuple[int, int]] = []

    async def fetch_one(value: int) -> int:
        await asyncio.sleep(0)
        return value * 2

    results = await run_batched_fetch(
        [1, 2, 3, 4, 5],
        fetch_one,
        progress_callback=lambda current, total: progress.append((current, total)),
        chunk_size=2,
    )

    assert results == [2, 4, 6, 8, 10]
    assert progress == [(1, 5), (2, 5), (3, 5), (4, 5), (5, 5)]


async def test_run_batched_fetch_handles_empty_input_without_callback():
    fetch_one = AsyncMock()

    assert await run_batched_fetch([], fetch_one) == []

    fetch_one.assert_not_awaited()


async def test_run_batched_fetch_works_without_progress_callback():
    async def fetch_one(value: int) -> int:
        return value + 1

    assert await run_batched_fetch([1], fetch_one, chunk_size=1) == [2]


async def test_sync_cache_misses_skips_fetch_when_every_key_is_cached():
    fetch = AsyncMock()
    upsert = AsyncMock()

    result = await sync_cache_misses(
        [],
        cached_count=2,
        fetch_batch=fetch,
        upsert_batch=upsert,
        is_success=lambda value: value > 0,
        error_for=lambda value: f"failed: {value}",
    )

    assert result == SyncResult(fetched=0, cached=2, failed=0, errors=[])
    fetch.assert_not_awaited()
    upsert.assert_not_awaited()


async def test_sync_cache_misses_stores_confirmed_misses_but_not_failures():
    fetch = AsyncMock(return_value=[1, -1, -2])
    upsert = AsyncMock()

    result = await sync_cache_misses(
        ["success", "absent", "failed"],
        cached_count=3,
        fetch_batch=fetch,
        upsert_batch=upsert,
        is_success=lambda value: value > 0,
        is_cacheable_miss=lambda value: value == -1,
        error_for=lambda value: f"failed: {value}",
    )

    assert result == SyncResult(
        fetched=1,
        cached=3,
        failed=2,
        errors=["failed: -1", "failed: -2"],
    )
    assert upsert.await_args_list == [call([1]), call([-1])]


def test_make_log_progress_logs_interval_and_final_item(mocker):
    info = mocker.patch("pipeline.cache_utils.logger.info")
    progress = make_log_progress("NCBI", interval=3)

    progress(1, 5)
    progress(3, 5)
    progress(5, 5)

    assert [call.args[0] for call in info.call_args_list] == [
        "  NCBI progress: 3/5",
        "  NCBI progress: 5/5",
    ]


def test_evict_lru_is_noop_below_limit():
    # Annotated: OrderedDict is invariant in its key type, so an inferred
    # OrderedDict[Literal["a", "b"], ...] is not an OrderedDict[str, Any].
    cache: OrderedDict[str, str] = OrderedDict((key, key) for key in ("a", "b"))

    assert evict_lru(cache, max_size=3, evict_fraction=0.5) == 0
    assert list(cache) == ["a", "b"]


def test_evict_lru_removes_oldest_fraction_at_limit():
    cache: OrderedDict[str, str] = OrderedDict(
        (key, key) for key in ("a", "b", "c", "d")
    )

    assert evict_lru(cache, max_size=4, evict_fraction=0.5, label="test") == 2
    assert list(cache) == ["c", "d"]


def _single_flight_state():
    return OrderedDict(), asyncio.Lock(), {}, asyncio.Semaphore(1)


async def test_single_flight_warm_hit_refreshes_lru_order():
    cache, lock, in_flight, semaphore = _single_flight_state()
    cache.update((("hot", 1), ("cold", 2)))
    fetch = AsyncMock()

    result = await single_flight_get(
        "hot",
        cache=cache,
        cache_lock=lock,
        in_flight=in_flight,
        semaphore=semaphore,
        fetch_fn=fetch,
        label="test",
    )

    assert result == 1
    assert list(cache) == ["cold", "hot"]
    fetch.assert_not_awaited()


async def test_single_flight_deduplicates_concurrent_misses():
    cache, lock, in_flight, semaphore = _single_flight_state()
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def fetch() -> int:
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return 7

    async def get() -> int | None:
        return await single_flight_get(
            "key",
            cache=cache,
            cache_lock=lock,
            in_flight=in_flight,
            semaphore=semaphore,
            fetch_fn=fetch,
            label="test",
        )

    first = asyncio.create_task(get())
    await started.wait()
    second = asyncio.create_task(get())
    await asyncio.sleep(0)
    release.set()

    assert await asyncio.gather(first, second) == [7, 7]
    assert calls == 1
    assert cache["key"] == 7
    assert in_flight == {}


async def test_single_flight_clears_failed_task_for_retry():
    cache, lock, in_flight, semaphore = _single_flight_state()
    fetch = AsyncMock(side_effect=RuntimeError("upstream failed"))

    with pytest.raises(RuntimeError, match="upstream failed"):
        await single_flight_get(
            "key",
            cache=cache,
            cache_lock=lock,
            in_flight=in_flight,
            semaphore=semaphore,
            fetch_fn=fetch,
            label="test",
        )

    assert in_flight == {}
    assert "key" not in cache
