"""Shared async HTTP client manager for external API modules.

Encapsulates the get-or-create / close / reset pattern used by
europepmc, ncbi_gene_fetch, uniprot_fetch, pubmed_citations, validation,
and pdf_retrieval.
"""

import asyncio
from typing import Any

import httpx

from pipeline.api_telemetry import event_hooks


class AsyncHttpClientManager:
    """Lazy singleton manager for an httpx.AsyncClient."""

    def __init__(
        self,
        timeout: float | httpx.Timeout = 15.0,
        limits: httpx.Limits | None = None,
        *,
        instrument: bool = True,
        **client_kwargs: Any,
    ) -> None:
        self._client: httpx.AsyncClient | None = None
        self._timeout = timeout
        self._limits = limits or httpx.Limits(
            max_connections=10, max_keepalive_connections=5
        )
        self._client_kwargs = client_kwargs
        self._lock: asyncio.Lock | None = None
        self._instrument = instrument

    def _get_lock(self) -> asyncio.Lock:
        # Lazy so the lock binds to whichever event loop is actually running
        # when the first caller arrives (tests re-use the manager across loops).
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    async def get(self) -> httpx.AsyncClient:
        """Get or create the shared HTTP client."""
        if self._client is not None:
            return self._client
        async with self._get_lock():
            if self._client is None:
                kwargs = dict(self._client_kwargs)
                # Every API module in the pipeline shares this manager, so
                # installing the telemetry hooks here is what gives the
                # dashboard its API inventory without a change at a single
                # call site.
                #
                # Merged rather than assigned: a caller passing its own
                # event_hooks would otherwise drop that module out of the
                # inventory with nothing saying so, and the widget would
                # under-report the run. `instrument=False` is the explicit
                # opt-out.
                if self._instrument:
                    hooks: dict[str, list[Any]] = {
                        name: list(handlers)
                        for name, handlers in kwargs.get("event_hooks", {}).items()
                    }
                    # The response hook has to know whether this client
                    # follows redirects: httpx runs it once per hop, and a
                    # hop the client will follow is not a call of its own.
                    instrumentation = event_hooks(
                        follow_redirects=bool(kwargs.get("follow_redirects", False))
                    )
                    for name, handlers in instrumentation.items():
                        hooks.setdefault(name, []).extend(handlers)
                    kwargs["event_hooks"] = hooks
                self._client = httpx.AsyncClient(
                    timeout=self._timeout,
                    limits=self._limits,
                    **kwargs,
                )
            return self._client

    async def close(self) -> None:
        """Close the HTTP client (call at shutdown)."""
        async with self._get_lock():
            if self._client is not None:
                await self._client.aclose()
                self._client = None

    def reset(self) -> None:
        """Reset client reference without closing (for test teardown)."""
        self._client = None
        self._lock = None
