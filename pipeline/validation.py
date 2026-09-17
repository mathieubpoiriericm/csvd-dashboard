"""Gene validation module with NCBI caching.

Validates extracted genes against NCBI Gene database with caching
to avoid redundant API calls for repeated gene symbols.
"""

import asyncio
import json
import logging
from collections import OrderedDict
from dataclasses import dataclass

import httpx

from pipeline import ncbi_http
from pipeline.cache_utils import single_flight_get
from pipeline.config import (
    NCBI_ESEARCH_URL,
    NCBI_ESUMMARY_URL,
    PipelineConfig,
)
from pipeline.extraction_models import GeneEntry
from pipeline.http_client import AsyncHttpClientManager

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------



def init_validation_state(config: PipelineConfig | None = None) -> None:
    """Eagerly initialize module-level locks and semaphores.

    Must be called once from the running event loop before concurrent use.
    Safe to call multiple times (idempotent).
    """
    # The throttle lock lives in pipeline.ncbi_http now, built lazily on
    # first use, since every E-utilities caller shares it.
    _get_cache_lock()
    _get_ncbi_semaphore(config)


class NcbiUnavailableError(RuntimeError):
    """NCBI did not answer, so nothing is known about the symbol.

    Distinct from a lookup that answered "no such gene": that answer is
    cached and turns into a rejection, while this must do neither. It was
    the same None as a miss, so one timeout on NOTCH3 rejected every later
    NOTCH3 in the run as "not found in NCBI Gene" without another request.
    """


@dataclass(slots=True)
class ValidationResult:
    """Result of gene entry validation."""

    is_valid: bool
    errors: list[str]
    normalized_data: GeneEntry | None


# ---------------------------------------------------------------------------
# HTTP CLIENT AND CACHE
# ---------------------------------------------------------------------------

_client_manager = AsyncHttpClientManager(timeout=15.0)


async def close_validation_client() -> None:
    """Close shared HTTP client (call at shutdown)."""
    await _client_manager.close()


_gene_cache: OrderedDict[str, str | None] = OrderedDict()
_cache_lock: asyncio.Lock | None = None
_ncbi_semaphore: asyncio.Semaphore | None = None
# Single-flight registry keyed by uppercase symbol; see ``single_flight_get``.
_in_flight: dict[str, asyncio.Task[str | None]] = {}


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


def clear_gene_cache() -> None:
    """Clear the gene validation cache and any in-flight task references."""
    global _gene_cache
    _gene_cache = OrderedDict()
    _in_flight.clear()


# ---------------------------------------------------------------------------
# NCBI API HELPERS
# ---------------------------------------------------------------------------


async def _ncbi_get_with_retry(
    url: str,
    params: dict[str, str],
    *,
    config: PipelineConfig | None = None,
    context: str = "",
) -> httpx.Response | None:
    """This module's client, through the shared pacing and 429 retry.

    Returns httpx.Response on success, None on exhausted retries or error
    -- see ``pipeline.ncbi_http.get_with_retry``, which used to live here
    and now serves every E-utilities caller.
    """
    client = await _client_manager.get()
    return await ncbi_http.get_with_retry(
        client, url, params, config=config, context=context
    )


# ---------------------------------------------------------------------------
# VALIDATION
# ---------------------------------------------------------------------------


async def validate_gene_entry(
    entry: GeneEntry,
    config: PipelineConfig | None = None,
) -> ValidationResult:
    """Multi-stage gene validation.

    Validation stages (fail-fast on critical errors):
    1. Confidence threshold - reject low-confidence LLM extractions
    2. NCBI Gene lookup - verify gene exists in human genome
    Note: Required field validation (Stage 0 in prior versions) is now
    handled by Pydantic at extraction time.

    Args:
        entry: Gene entry from LLM extraction (Pydantic-validated).
        config: Pipeline configuration (uses defaults if None).

    Returns:
        ValidationResult with validation status and normalized data.
    """
    config = config or PipelineConfig()

    # Stage 1: Confidence threshold - filters out LLM hallucinations
    # The permissive floor: this runs before merge_gene_entries learns which
    # genes are new, so it cannot apply the strict one. A gene between the
    # two floors passes here and is dropped at the insert/update split if it
    # turns out to be a new row.
    if entry.confidence < config.confidence_threshold_update:
        return ValidationResult(
            False,
            [
                f"Low confidence: {entry.confidence:.2f} < "
                f"{config.confidence_threshold_update}"
            ],
            None,
        )

    # Stage 2: NCBI Gene validation - ensures gene symbol is real
    official_symbol = await verify_ncbi_gene(entry.gene_symbol, config=config)

    if not official_symbol:
        return ValidationResult(
            False,
            [f"Gene '{entry.gene_symbol}' not found in NCBI Gene"],
            None,
        )

    # Normalize gene symbol to official NCBI symbol (handles aliases). Use
    # model_copy so we don't mutate the caller's GeneEntry — other observers
    # (batch_validation, the report) may still be holding the original.
    if official_symbol != entry.gene_symbol:
        # At INFO, because this is a substitution and not a formatting
        # tidy-up: what the paper reported, and what the quote beside the
        # row names, is no longer what the row is filed under. `ARSB`
        # stored as `SLURP1` is the failure mode, and it used to leave no
        # trace at the level a run logs at -- `select_gene_uid`'s note is
        # DEBUG, and nothing here said anything at all, so a reader of the
        # log could not tell a rename had happened.
        logger.info(
            f"  NCBI renamed {entry.gene_symbol} to its official symbol "
            f"{official_symbol}"
            + (f" (PMID {entry.pmid})" if entry.pmid else "")
        )
        normalized = entry.model_copy(update={"gene_symbol": official_symbol})
    else:
        normalized = entry

    return ValidationResult(True, [], normalized)


async def verify_ncbi_gene(
    symbol: str, *, config: PipelineConfig | None = None
) -> str | None:
    """Query NCBI Gene database to verify gene symbol.

    Results are cached; concurrent callers for the same symbol share one
    in-flight fetch via ``single_flight_get``.
    """
    return await single_flight_get(
        symbol.upper(),
        cache=_gene_cache,
        cache_lock=_get_cache_lock(),
        in_flight=_in_flight,
        semaphore=_get_ncbi_semaphore(config),
        fetch_fn=lambda: _fetch_ncbi_gene_uncached(symbol, config=config),
        label="gene validation cache",
    )


async def _fetch_ncbi_gene_uncached(
    symbol: str, *, config: PipelineConfig | None = None
) -> str | None:
    """Internal: fetch gene from NCBI without caching.

    Args:
        symbol: Gene symbol to look up.
        config: Pipeline configuration for retry settings.

    Returns:
        The official symbol of the matching record, or None when NCBI
        answered that no gene carries the symbol.

    Raises:
        NcbiUnavailableError: NCBI did not answer, or answered with an
            error or a body this cannot read -- never cached as a miss.
    """
    # The shared query -- [Sym] over official symbols and aliases alike, so
    # a paper naming a gene by its alias still resolves -- with retmax
    # raised so every candidate record is in view.
    resp = await _ncbi_get_with_retry(
        NCBI_ESEARCH_URL,
        ncbi_http.gene_search_params(symbol),
        config=config,
        context=f"esearch for {symbol}",
    )
    if resp is None or resp.status_code != 200:
        if resp is not None:
            logger.warning(f"NCBI esearch failed for {symbol}: {resp.status_code}")
        raise NcbiUnavailableError(f"NCBI esearch did not answer for {symbol}")

    try:
        data = resp.json()
    except json.JSONDecodeError as e:
        # A 200 carrying a maintenance page is NCBI not answering, not a
        # gene that does not exist.
        raise NcbiUnavailableError(
            f"NCBI esearch returned a non-JSON body for {symbol}: {e}"
        ) from e

    # Only a well-formed answer counting zero hits means "no such gene".
    # E-utilities reports its own failures inside a 200 -- a top-level
    # {"error": ...} body, or a result with no esearchresult at all -- and
    # every one of those used to fall through to None, which the cache then
    # held as "not found" for the rest of the run. That is the failure
    # NcbiUnavailableError exists to keep out of the cache.
    if not isinstance(data, dict) or "error" in data:
        raise NcbiUnavailableError(f"NCBI esearch reported an error for {symbol}")
    try:
        count = data["esearchresult"]["count"]
        idlist = data["esearchresult"]["idlist"]
    except (KeyError, TypeError) as e:
        raise NcbiUnavailableError(
            f"NCBI esearch returned an unexpected body for {symbol}: {e}"
        ) from e
    if count == "0" or not idlist:
        return None

    # [Sym] matches aliases, so the first hit is not the gene: the record
    # whose own symbol is the one searched for is. Validation *renames* the
    # extracted symbol to the chosen record's name, so trusting the position
    # here stored ARSB as SLURP1 -- the same collision the gene-info sync was
    # fixed for, one module over.
    client = await _client_manager.get()
    gene_id = await ncbi_http.select_gene_uid(client, symbol, idlist, config=config)
    if gene_id is None:
        raise NcbiUnavailableError(
            f"NCBI could not say which of {len(idlist)} records is {symbol}"
        )
    return await _fetch_official_gene_symbol(gene_id, config=config)


async def _fetch_official_gene_symbol(
    gene_id: str, *, config: PipelineConfig | None = None
) -> str | None:
    """Fetch the official gene symbol from NCBI using esummary.

    Args:
        gene_id: NCBI Gene ID.
        config: Pipeline configuration for retry settings.

    Returns:
        The official gene symbol.

    Raises:
        NcbiUnavailableError: NCBI did not answer, or answered with an
            error or a body that does not describe the uid.
    """
    params = {"db": "gene", "id": gene_id, "retmode": "json"}

    resp = await _ncbi_get_with_retry(
        NCBI_ESUMMARY_URL,
        params,
        config=config,
        context=f"esummary for gene_id {gene_id}",
    )
    if resp is None or resp.status_code != 200:
        if resp is not None:
            logger.warning(
                f"NCBI esummary failed for gene_id {gene_id}: {resp.status_code}"
            )
        raise NcbiUnavailableError(
            f"NCBI esummary did not answer for gene_id {gene_id}"
        )

    try:
        data = resp.json()
    except json.JSONDecodeError as e:
        raise NcbiUnavailableError(
            f"NCBI esummary returned a non-JSON body for gene_id {gene_id}: {e}"
        ) from e
    # esearch just returned this uid, so a summary that does not describe
    # it is NCBI failing to answer, not a gene that does not exist. The
    # in-band shape is {"uid": ..., "error": "cannot get document summary"}
    # -- the one clinvar_fetch treats as a failed batch -- and it used to
    # return None here, which the cache held as "not found" for the run.
    try:
        gene_data = data["result"][gene_id]
    except (KeyError, TypeError, AttributeError) as e:
        raise NcbiUnavailableError(
            f"NCBI esummary did not describe gene_id {gene_id}: {e}"
        ) from e
    if not isinstance(gene_data, dict):
        raise NcbiUnavailableError(
            f"NCBI esummary returned an unexpected shape for gene_id {gene_id}"
        )
    if "error" in gene_data:
        raise NcbiUnavailableError(
            f"NCBI esummary reported an error for gene_id {gene_id}: "
            f"{gene_data['error']}"
        )
    symbol = gene_data.get("name")
    if not isinstance(symbol, str) or not symbol:
        raise NcbiUnavailableError(
            f"NCBI gene_id {gene_id} has no symbol (name field missing or empty)"
        )
    return symbol
