"""NCBI Gene information fetching module.

Fetches gene metadata (uid, description, aliases) from NCBI Gene database
and stores results in PostgreSQL for dashboard consumption.
"""

import asyncio
import logging
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass

from pipeline import ncbi_http
from pipeline.cache_utils import (
    DB_CACHE_TTL_DAYS,
    SyncResult,
    make_log_progress,
    run_batched_fetch,
    single_flight_get,
    sync_cache_misses,
)
from pipeline.config import (
    NCBI_ESEARCH_URL,
    PipelineConfig,
)
from pipeline.http_client import AsyncHttpClientManager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# MODELS
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class NCBIGeneInfo:
    """NCBI Gene information for a single gene."""

    gene_symbol: str
    ncbi_uid: str | None = None
    description: str | None = None
    aliases: str | None = None
    # The chromosomal band, as esummary states it ("17q25.1"). It is the one
    # field here the dashboard *draws* with rather than displays: `placeGene`
    # matches it against the hg38 ideogram exactly, so a gene missing one is
    # listed as unplaced instead of guessed at.
    map_location: str | None = None
    cacheable_miss: bool = True


# ---------------------------------------------------------------------------
# HTTP CLIENT AND CACHE
# ---------------------------------------------------------------------------

# Module-level shared HTTP client
_client_manager = AsyncHttpClientManager(timeout=15.0)
_gene_cache: OrderedDict[str, NCBIGeneInfo | None] = OrderedDict()
_cache_lock: asyncio.Lock | None = None
_ncbi_semaphore: asyncio.Semaphore | None = None
# Single-flight registry keyed by uppercase symbol; see ``single_flight_get``.
_in_flight: dict[str, asyncio.Task[NCBIGeneInfo | None]] = {}


def _get_cache_lock() -> asyncio.Lock:
    """Get cache lock, initializing lazily if needed."""
    global _cache_lock
    if _cache_lock is None:
        _cache_lock = asyncio.Lock()
    return _cache_lock


def _get_ncbi_semaphore(config: PipelineConfig | None = None) -> asyncio.Semaphore:
    """Get NCBI rate-limit semaphore, initializing lazily if needed."""
    global _ncbi_semaphore
    if _ncbi_semaphore is None:
        limit = (config or PipelineConfig()).ncbi_rate_limit
        _ncbi_semaphore = asyncio.Semaphore(limit)
    return _ncbi_semaphore


async def close_ncbi_client() -> None:
    """Close shared HTTP client (call at shutdown)."""
    await _client_manager.close()


def clear_ncbi_cache() -> None:
    """Clear the gene info cache and any in-flight task references."""
    global _gene_cache
    _gene_cache = OrderedDict()
    _in_flight.clear()


# ---------------------------------------------------------------------------
# FETCH FUNCTIONS
# ---------------------------------------------------------------------------


async def fetch_ncbi_gene_info(
    gene_symbol: str,
    config: PipelineConfig | None = None,
) -> NCBIGeneInfo | None:
    """Fetch NCBI gene information for a single gene symbol.

    Results are cached; concurrent callers for the same symbol share one
    in-flight fetch via ``single_flight_get``.
    """
    return await single_flight_get(
        gene_symbol.upper(),
        cache=_gene_cache,
        cache_lock=_get_cache_lock(),
        in_flight=_in_flight,
        semaphore=_get_ncbi_semaphore(config),
        fetch_fn=lambda: _fetch_ncbi_gene_uncached(gene_symbol),
        label="NCBI gene cache",
    )


async def _fetch_ncbi_gene_uncached(gene_symbol: str) -> NCBIGeneInfo | None:
    """Internal: fetch gene from NCBI without caching."""
    # The shared query: [Sym] over official symbols and aliases alike, with
    # retmax raised above NCBI's default page so select_gene_uid can see every
    # candidate. get_with_retry adds the API key.
    try:
        client = await _client_manager.get()
        resp = await ncbi_http.get_with_retry(
            client,
            NCBI_ESEARCH_URL,
            ncbi_http.gene_search_params(gene_symbol),
            context=f"esearch for {gene_symbol}",
        )
        if resp is None:
            return None
        if resp.status_code != 200:
            logger.warning(f"NCBI esearch failed for {gene_symbol}: {resp.status_code}")
            return None

        data = resp.json()
        if data["esearchresult"]["count"] == "0":
            logger.debug(f"Gene {gene_symbol} not found in NCBI")
            return NCBIGeneInfo(gene_symbol=gene_symbol)

        gene_id = await ncbi_http.select_gene_uid(
            client, gene_symbol, data["esearchresult"]["idlist"]
        )
        if gene_id is None:
            return NCBIGeneInfo(
                gene_symbol=gene_symbol,
                cacheable_miss=False,
            )

        # Step 2: Get gene summary
        return await _fetch_gene_summary(gene_symbol, gene_id)

    except (KeyError, IndexError, ValueError) as e:
        logger.warning(f"Unexpected NCBI response format for gene {gene_symbol}: {e}")

    return None


async def _fetch_gene_summary(gene_symbol: str, gene_id: str) -> NCBIGeneInfo | None:
    """Fetch gene summary details from NCBI esummary."""
    client = await _client_manager.get()
    summaries = await ncbi_http.fetch_gene_summaries(client, [gene_id])
    if summaries is None:
        return None
    gene_data = summaries.get(gene_id, {})
    if not gene_data or "error" in gene_data:
        return None
    return NCBIGeneInfo(
        gene_symbol=gene_symbol,
        ncbi_uid=gene_id,
        description=gene_data.get("description", ""),
        aliases=gene_data.get("otheraliases", ""),
        map_location=gene_data.get("maplocation", ""),
    )


async def fetch_ncbi_genes_batch(
    gene_symbols: list[str],
    progress_callback: Callable[[int, int], None] | None = None,
    config: PipelineConfig | None = None,
) -> list[NCBIGeneInfo]:
    """Fetch NCBI gene info for multiple genes concurrently.

    Uses the module-level semaphore (via fetch_ncbi_gene_info) to
    rate-limit concurrent requests.
    """

    async def _fetch_one(symbol: str) -> NCBIGeneInfo:
        info = await fetch_ncbi_gene_info(symbol, config=config)
        return info or NCBIGeneInfo(gene_symbol=symbol, cacheable_miss=False)

    return await run_batched_fetch(
        gene_symbols, _fetch_one, progress_callback=progress_callback
    )


# ---------------------------------------------------------------------------
# DATABASE SYNC
# ---------------------------------------------------------------------------


async def sync_ncbi_gene_info(
    gene_symbols: list[str],
    config: PipelineConfig | None = None,
) -> SyncResult:
    """Sync NCBI gene info to database for given gene symbols.

    Args:
        gene_symbols: List of gene symbols to sync.
        config: Pipeline config for NCBI semaphore sizing.

    Returns:
        SyncResult with counts of fetched, cached, and failed genes.
    """
    from pipeline.database import get_cached_ncbi_genes, upsert_ncbi_genes_batch

    # Fresh rows only — stale rows fall through to a re-fetch.
    cached_genes = await get_cached_ncbi_genes(
        gene_symbols, max_age_days=DB_CACHE_TTL_DAYS
    )
    symbols_to_fetch = [s for s in gene_symbols if s not in cached_genes]

    logger.info(
        f"NCBI sync: {len(cached_genes)} cached, {len(symbols_to_fetch)} to fetch"
    )

    return await sync_cache_misses(
        symbols_to_fetch,
        cached_count=len(cached_genes),
        fetch_batch=lambda symbols: fetch_ncbi_genes_batch(
            symbols,
            make_log_progress("NCBI fetch"),
            config=config,
        ),
        upsert_batch=upsert_ncbi_genes_batch,
        is_success=lambda gene: gene.ncbi_uid is not None,
        is_cacheable_miss=lambda gene: gene.cacheable_miss,
        error_for=lambda gene: f"Gene not found: {gene.gene_symbol}",
    )
