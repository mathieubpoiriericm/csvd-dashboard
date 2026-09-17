"""Tests for the shared async HTTP client manager."""

import asyncio
from typing import Any, cast
from unittest.mock import MagicMock

import httpx

from pipeline.http_client import AsyncHttpClientManager


async def test_get_creates_the_client_once_and_reuses_it():
    manager = AsyncHttpClientManager()

    first = await manager.get()
    second = await manager.get()

    assert first is second
    await manager.close()


async def test_concurrent_get_calls_all_share_one_client():
    manager = AsyncHttpClientManager()

    clients = await asyncio.gather(*(manager.get() for _ in range(20)))

    assert len({id(c) for c in clients}) == 1
    await manager.close()


async def test_get_reuses_client_created_by_caller_holding_lock():
    manager = AsyncHttpClientManager()
    peer_client = MagicMock(spec=httpx.AsyncClient)

    class PeerCompletesCreation:
        async def __aenter__(self):
            manager._client = peer_client

        async def __aexit__(self, *_args):
            return False

    manager._lock = cast(Any, PeerCompletesCreation())

    assert await manager.get() is peer_client


async def test_get_applies_timeout_and_extra_client_kwargs():
    manager = AsyncHttpClientManager(
        timeout=42.0, headers={"User-Agent": "csvd-pipeline-test"}
    )

    client = await manager.get()

    assert client.timeout.connect == 42.0
    assert client.headers["User-Agent"] == "csvd-pipeline-test"
    await manager.close()


async def test_close_closes_the_client_and_the_next_get_builds_a_fresh_one():
    manager = AsyncHttpClientManager()
    first = await manager.get()

    await manager.close()

    assert first.is_closed
    second = await manager.get()
    assert second is not first
    assert not second.is_closed
    await manager.close()


async def test_close_without_a_client_is_a_noop():
    manager = AsyncHttpClientManager()

    await manager.close()  # must not raise

    assert not (await manager.get()).is_closed
    await manager.close()


async def test_reset_drops_the_reference_without_closing_the_client():
    manager = AsyncHttpClientManager()
    client = await manager.get()

    manager.reset()

    assert not client.is_closed
    assert await manager.get() is not client
    await client.aclose()
    await manager.close()


def test_reset_rebinds_the_lock_so_the_manager_survives_a_new_event_loop():
    # The lock is created lazily precisely so it binds to whichever loop is
    # running on first use. Without the reset, the second asyncio.run() would
    # reuse a lock still bound to the first loop.
    manager = AsyncHttpClientManager()

    async def use_once() -> None:
        client = await manager.get()
        assert not client.is_closed
        await manager.close()

    asyncio.run(use_once())
    manager.reset()
    asyncio.run(use_once())
