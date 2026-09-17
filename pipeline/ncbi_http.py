"""One pacing rule and one 429 retry for every NCBI E-utilities call.

E-utilities bounds *rate* -- 10 requests a second with an API key, 3
without, counted across every endpoint on one key -- and a semaphore bounds
concurrency, which is a different quantity: ten in flight over calls that
return in 30 ms is roughly 300 a second, and the first full annotation run
was answered 429 on 53 of 63 requests that way (see pipeline/CLAUDE.md,
"NCBI limits requests per second, and a semaphore does not"). Validation
had the pacing and the retry; gene info, citations, the PMC and abstract
fetches and the metadata lookup each had a semaphore and nothing else, so
a burst of papers put every one of their requests out at once and read
the 429s as "not found", "citation fetch failed" and "no text".

The state is module-level on purpose: the limit is per key, not per
module, so the spacing has to be shared by every caller in the process.
"""

import asyncio
import logging
import os
import time
from typing import Any

import httpx

from pipeline.api_telemetry import current_recorder, record_transport_failure
from pipeline.config import NCBI_ESUMMARY_URL, PipelineConfig, get_ncbi_params
from pipeline.rate_limiter import compute_backoff, resolve_retry_delay

logger = logging.getLogger(__name__)

_last_request_time: float = 0.0
_throttle_lock: asyncio.Lock | None = None


def _get_throttle_lock() -> asyncio.Lock:
    # Lazy so the lock binds to the running loop; tests use one per test.
    global _throttle_lock
    if _throttle_lock is None:
        _throttle_lock = asyncio.Lock()
    return _throttle_lock


def reset_pacing() -> None:
    """Forget the last request time and the lock (test teardown)."""
    global _last_request_time, _throttle_lock
    _last_request_time = 0.0
    _throttle_lock = None


async def throttle() -> None:
    """Enforce the minimum interval between NCBI request starts.

    Sampled per call so python-dotenv can populate ``NCBI_API_KEY`` after
    module import. 0.1 s = 10 req/s (authenticated); 0.34 s = 3 req/s.
    """
    global _last_request_time
    interval = 0.1 if os.getenv("NCBI_API_KEY") else 0.34
    async with _get_throttle_lock():
        now = time.monotonic()
        elapsed = now - _last_request_time
        if elapsed < interval:
            await asyncio.sleep(interval - elapsed)
        _last_request_time = time.monotonic()


async def get_with_retry(
    client: httpx.AsyncClient,
    url: str,
    params: dict[str, str],
    *,
    config: PipelineConfig | None = None,
    context: str = "",
) -> httpx.Response | None:
    """HTTP GET with API key injection, pacing, and 429 retry.

    Args:
        client: The caller's shared client, so its telemetry hooks and
            connection pool are the ones used.
        url: NCBI E-utility URL.
        params: Query parameters (api_key added when the key is set).
        config: Pipeline config for retry settings.
        context: Description for log messages (e.g. "esearch for NOTCH3").

    Returns:
        httpx.Response on any non-429 answer, including a non-200 the
        caller must still check; None when NCBI did not answer -- a
        timeout, a connection error, or 429 on every attempt.
    """
    config = config or PipelineConfig()
    full_params = get_ncbi_params(params)

    # The setting counts *retries*, so N of them is N+1 requests and zero is
    # still one -- the reading the Anthropic client gives the same setting.
    # This loop used to count attempts, so NCBI got one request fewer than
    # Anthropic did for the same PIPELINE_MAX_RATE_LIMIT_RETRIES, and a
    # setting of 1 gave it no retry at all.
    retries = max(0, config.max_rate_limit_retries)
    retry = 0
    while True:
        await throttle()
        try:
            resp = await client.get(url, params=full_params)
        except httpx.TimeoutException:
            # A call the run made and an error it met. Nothing came back,
            # so the response hook never fired and the E-utilities row read
            # `errors: 0` through an outage that failed papers.
            record_transport_failure(url)
            logger.warning(f"Timeout on NCBI request ({context})")
            return None
        except httpx.RequestError as e:
            record_transport_failure(url)
            logger.warning(f"Request error on NCBI request ({context}): {e}")
            return None

        if resp.status_code != 429:
            return resp

        if retry >= retries:
            logger.warning(
                f"NCBI rate limit retries exhausted ({context}): "
                f"{retry}/{retries} retries after {retry + 1} attempts"
            )
            return None

        # Noted explicitly: a retry is indistinguishable from another call
        # at the transport, so the response hook cannot see one.
        request_url = httpx.URL(url)
        current_recorder().note_retry(
            host=request_url.host, path=request_url.path, method="GET"
        )

        backoff = compute_backoff(config.rate_limit_retry_delay, retry + 1)
        delay, delay_source = resolve_retry_delay(
            resp.headers.get("retry-after"), backoff
        )

        logger.warning(
            f"NCBI 429 ({context}). Waiting {delay:.1f}s ({delay_source}) "
            f"(retry {retry + 1}/{retries})..."
        )
        await asyncio.sleep(delay)
        retry += 1


# ---------------------------------------------------------------------------
# GENE LOOKUP HELPERS
# ---------------------------------------------------------------------------

# `[Sym]` indexes aliases as well as official symbols, and NCBI's default
# page is 20 hits. A short symbol that is an alias of many genes could push
# its own record past that window, where `select_gene_uid` cannot see it
# and falls back to the first hit. 100 is well above any alias fan-out seen
# and costs nothing when the answer is one record.
ESEARCH_RETMAX: str = "100"


def gene_search_params(gene_symbol: str) -> dict[str, str]:
    """The esearch query every gene lookup sends for one symbol.

    [Sym] indexes both the official HGNC symbol and the aliases list, so a
    paper that mentions a gene by its alias (e.g. "MFS2" for TGFBR2) still
    resolves. [Gene Name] indexes the gene title only and silently misses
    those.
    """
    return {
        "db": "gene",
        "term": f"{gene_symbol}[Sym] AND Homo sapiens[Organism]",
        "retmax": ESEARCH_RETMAX,
        "retmode": "json",
    }


async def fetch_gene_summaries(
    client: httpx.AsyncClient,
    gene_ids: list[str],
    *,
    config: PipelineConfig | None = None,
) -> dict[str, dict[str, Any]] | None:
    """esummary for several uids in one request. None if the call failed.

    None and an empty result are deliberately different answers, as they are
    in `clinvar_fetch`: an empty dict means NCBI described none of these
    uids, while None means we never heard back and know nothing. Only the
    second must stop a row being written.
    """
    params = {"db": "gene", "id": ",".join(gene_ids), "retmode": "json"}
    try:
        resp = await get_with_retry(
            client,
            NCBI_ESUMMARY_URL,
            params,
            config=config,
            context=f"esummary for {len(gene_ids)} candidate uids",
        )
        if resp is None or resp.status_code != 200:
            return None
        result = resp.json().get("result", {})
        return {k: v for k, v in result.items() if isinstance(v, dict)}
    except ValueError as e:
        logger.warning(f"Failed to parse NCBI candidate summaries: {e}")
        return None


async def select_gene_uid(
    client: httpx.AsyncClient,
    gene_symbol: str,
    idlist: list[str],
    *,
    config: PipelineConfig | None = None,
) -> str | None:
    """Pick the uid whose official symbol is the one searched for.

    `[Sym]` indexes aliases as well as official symbols, so a search returns
    every gene carrying the term either way, ordered by NCBI rather than by
    exactness. Taking `idlist[0]` therefore files a gene under whichever
    record NCBI happened to list first: `ARSB[Sym]` returns SLURP1 (aliased
    `ArsB`) ahead of arylsulfatase B, and `CARF[Sym]` returned PEDS1
    (aliased `CarF`) ahead of CARF until some time after May 2026. That
    ordering is not ours and not stable, which is why this checks the name
    rather than trusting the position -- the same rule `_matching_hit` and
    `resolve_target` apply to Open Targets' fuzzy search.

    Shared by the gene-info sync and by extraction validation: validation
    still took `idlist[0]` after the sync was fixed, and it *renames* the
    extracted symbol to that record's name, so a paper reporting ARSB was
    stored as SLURP1.

    Falls back to the first hit when no record carries the searched symbol,
    and says so at WARNING. An obsolete symbol is answered under its current
    name -- `C6orf195` comes back as `LINC01600` -- and requiring an exact
    match would lose the gene rather than rename it, so the fallback stays;
    but it is the one branch that answers with a record whose name was not
    checked, and validation renames a published gene on the strength of it.
    Returns None when the candidates could not be fetched: a guess would be
    published, and cached, as an answer.
    """
    if len(idlist) < 2:
        return idlist[0]

    summaries = await fetch_gene_summaries(client, idlist, config=config)
    if summaries is None:
        # Cannot tell which hit is the gene. Returning the first would
        # publish an unverified guess that `sync_ncbi_gene_info` stores as a
        # success and `DB_CACHE_TTL_DAYS` then holds for 30 days -- the
        # failure mode this whole function exists to remove. The caller
        # turns this into a non-cacheable miss instead, so the next sync
        # retries it.
        logger.warning(
            f"NCBI {gene_symbol}: could not verify {len(idlist)} candidate "
            f"hits; skipping rather than guessing"
        )
        return None
    wanted = gene_symbol.upper()
    for uid in idlist:
        name = summaries.get(uid, {}).get("name", "")
        if name.upper() == wanted:
            if uid != idlist[0]:
                logger.info(
                    f"NCBI {gene_symbol}: chose uid {uid} ({name}) over the "
                    f"first hit {idlist[0]} "
                    f"({summaries.get(idlist[0], {}).get('name', '?')})"
                )
            return uid

    # WARNING, not DEBUG. Every other branch here either verified the name
    # or refused to answer; this one picks a record NCBI ordered first and
    # renames the gene to it, which is a guess with a published
    # consequence. A run logs at INFO, so at DEBUG the substitution
    # happened with nothing in the log to show for it.
    logger.warning(
        f"NCBI {gene_symbol}: no hit carries the searched symbol; using the "
        f"first of {len(idlist)} "
        f"({summaries.get(idlist[0], {}).get('name', '?')})"
    )
    return idlist[0]
