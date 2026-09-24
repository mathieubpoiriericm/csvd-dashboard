"""ClinVar monogenic-disease annotations for the curated genes.

Rides the E-utilities the pipeline already calls -- ``db=clinvar`` is served by
the same esearch/esummary URLs in ``pipeline.config``, so ``get_ncbi_params``
key injection applies unchanged and there is no new base URL and no auth.

Two filters do the work, and both were measured against the live API rather
than assumed. Of the first 60 of HTRA1's 74 ``clinsig pathogenic`` records
(2026-08-31), 39 named more than one gene -- up to 724 of them, because a 32-Mb
10q24.1-26.3 copy-number gain lists every gene it spans. Those records carry
the CNV syndrome's traits, not the gene's, and the very first uid the API
returns is one of them. ``_describes_gene`` drops them.

**Reading every multi-gene record as a CNV was wrong**, and HTRA1 -- which
overlaps nothing -- was the one gene that could not show it. ClinVar names
every locus a variant overlaps, readthrough transcripts and antisense RNAs
included, so an ordinary SNV in TREX1 is filed under ('ATRIP', 'ATRIP-TREX1',
'TREX1'). Of TREX1's 61 pathogenic records (2026-09-02) *none* named TREX1
alone, so the gene was published with no disease at all -- RVCL-S, a monogenic
form of the disease the dashboard covers, among them. TIMP3 (Sorsby fundus
dystrophy, under 'SYN3'), VCAN (Wagner disease, under 'VCAN-AS1') and LOX
(under 'SRFBP1') were lost the same way. ``_describes_gene`` recognises a
region event from the record instead: the copy-number types ClinVar reports in
``obj_type`` and ``variation_set[].variant_type``, or a gene list longer than
any overlap plausibly is.

The three most frequent trait names in the same sample were "not provided"
(26), "See cases" (14) and "not specified" (6) -- placeholders carrying a
MedGen sentinel or no xref at all. ``_disease_xrefs`` keeps only traits
carrying an OMIM, MONDO or Orphanet identifier, which drops all three without
a hardcoded list of placeholder strings.

Both filters are needed, not either: "Distal 10q deletion syndrome" carries a
real Orphanet/MONDO/OMIM triple and is removed only by the region rule.

With both, HTRA1 returns exactly its real diseases, ranked by supporting-record
count -- CADASIL type 2 (11), CARASIL (5), two more HTRA1-related small-vessel
entries (2 each), AMD7 (1) and cerebral arterial disease (1).
"""

import asyncio
import logging
from collections import Counter, OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import Any, Final

import httpx

from pipeline.annotations import (
    AnnotationRow,
    AnnotationStatus,
    expand_lookup_symbols,
    group_key_for,
)
from pipeline.cache_utils import (
    DB_CACHE_TTL_DAYS,
    SyncResult,
    make_log_progress,
    run_batched_fetch,
    single_flight_get,
)
from pipeline.config import (
    NCBI_ESEARCH_URL,
    NCBI_ESUMMARY_URL,
    PipelineConfig,
    get_ncbi_params,
)
from pipeline.http_client import AsyncHttpClientManager
from pipeline.xrefs import canonical_xref, xref_prefix

logger = logging.getLogger(__name__)

SOURCE: Final[str] = "clinvar"

# A trait must carry one of these to be a disease rather than a placeholder.
_DISEASE_PREFIXES: Final[frozenset[str]] = frozenset({"OMIM", "MONDO", "Orphanet"})

# How ClinVar spells a copy-number event, in ``obj_type`` and in each
# ``variation_set`` entry's ``variant_type``. Compared casefolded.
_CNV_VARIANT_TYPES: Final[frozenset[str]] = frozenset(
    {"copy number gain", "copy number loss"}
)

# A record naming more than this many genes is a region event whatever it calls
# itself, and the two populations are nowhere near this line: the largest
# overlap measured on an ordinary variant is a readthrough plus its two parents
# (ATRIP, ATRIP-TREX1, TREX1), while HTRA1's 32-Mb copy-number gain names 724.
_MAX_RECORD_GENES: Final[int] = 5

# How far a *multi-gene* record may reach and still be an overlap rather than a
# span. The gene count alone does not separate them: a deletion typed
# ``Deletion`` rather than ``copy number loss`` escapes _CNV_VARIANT_TYPES, and
# one naming two or three genes escapes _MAX_RECORD_GENES, so FDFT1's 120-kb
# 8p23.1 deletion published squalene synthase deficiency as CTSB's disease --
# CTSB is merely the neighbouring locus the deletion happens to remove.
#
# Measured over the 330 multi-gene records the gate admits across all 63 Table 1
# genes (2026-09-02), the two populations separate by a factor of 270 with
# nothing in between: every genuine overlap spans at most 152 bp (TREX1's
# readthrough 22, LOX/SRFBP1 13, ADAMTSL4/ADAMTSL4-AS2 19), while every span
# event starts at 40,877 bp (PCSK9+BSND) and runs to 750,052 (ARSB). 1 kb sits
# in the middle of that gap.
#
# This is deliberately not applied to the single-gene branch above: a whole-gene
# deletion is megabases wide and is still that gene's own variant.
_MAX_OVERLAP_SPAN: Final[int] = 1_000

# esummary accepts a POST body, which is what makes a 248-uid request possible
# at all; 200 per call keeps each body small enough to debug.
_ESUMMARY_BATCH: Final[int] = 200

# A 429 survives correct pacing when another process shares the API key, so it
# is retried rather than counted as a transient miss. Three attempts at a
# widening delay covers a collision without turning a real outage into a
# minutes-long hang.
_RATE_LIMIT_RETRIES: Final[int] = 3
_RATE_LIMIT_BACKOFF: Final[float] = 1.0

# The esearch field the clinical-significance filter is written against. Named
# so that _search_uids can tell its own token in errorlist.phrasesnotfound
# apart from the gene term's.
_PROPERTIES_FIELD: Final[str] = "[Properties]"

# E-utilities allows 3 requests a second without an API key.
_UNKEYED_RATE_LIMIT: Final[int] = 3


# ---------------------------------------------------------------------------
# MODELS
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ClinVarDisease:
    """One disease a gene's pathogenic variants are classified against."""

    trait_name: str
    group_key: str
    xrefs: tuple[str, ...]
    classification: str | None
    record_count: int


@dataclass(slots=True)
class ClinVarGeneResult:
    """Every disease ClinVar associates with one gene."""

    gene_symbol: str
    diseases: tuple[ClinVarDisease, ...]

    def to_annotation_rows(self) -> list[AnnotationRow]:
        """One row per (disease, xref), all sharing the disease's group_key."""
        return [
            AnnotationRow(
                gene_symbol=self.gene_symbol,
                source=SOURCE,
                relation="disease",
                group_key=disease.group_key,
                object_id=xref,
                object_label=disease.trait_name,
                qualifier=disease.classification,
                score=None,
                evidence_count=disease.record_count,
                source_version=None,
            )
            for disease in self.diseases
            for xref in disease.xrefs
        ]


@dataclass(slots=True)
class _TraitAccumulator:
    xrefs: set[str] = field(default_factory=set)
    classifications: Counter[str] = field(default_factory=Counter)
    record_count: int = 0


# ---------------------------------------------------------------------------
# HTTP CLIENT AND CACHE
# ---------------------------------------------------------------------------

_client_manager = AsyncHttpClientManager(timeout=30.0)
_clinvar_cache: OrderedDict[str, ClinVarGeneResult | None] = OrderedDict()
_cache_lock: asyncio.Lock | None = None
_clinvar_semaphore: asyncio.Semaphore | None = None
_in_flight: dict[str, asyncio.Task[ClinVarGeneResult | None]] = {}
_rate_lock: asyncio.Lock | None = None
_next_request_at: float = 0.0
_pace_logged: bool = False


def _get_cache_lock() -> asyncio.Lock:
    """Get cache lock, initializing lazily if needed."""
    global _cache_lock
    if _cache_lock is None:
        _cache_lock = asyncio.Lock()
    return _cache_lock


def _get_rate_lock() -> asyncio.Lock:
    """Get the request-pacing lock, initializing lazily if needed."""
    global _rate_lock
    if _rate_lock is None:
        _rate_lock = asyncio.Lock()
    return _rate_lock


def _get_clinvar_semaphore(config: PipelineConfig | None = None) -> asyncio.Semaphore:
    """Get ClinVar rate-limit semaphore, initializing lazily if needed."""
    global _clinvar_semaphore
    if _clinvar_semaphore is None:
        limit = (config or PipelineConfig()).clinvar_rate_limit
        _clinvar_semaphore = asyncio.Semaphore(limit)
    return _clinvar_semaphore


async def _throttle(config: PipelineConfig) -> None:
    """Space request starts to the configured requests-per-second.

    The semaphore above bounds *concurrency*, which is not what NCBI limits.
    E-utilities allows 10 requests a second with an API key and 3 without,
    counted across every endpoint, and a 10-deep semaphore over calls that
    return in 30 ms issues roughly 300 a second: the first full 63-gene run
    put all of them out in under half a second and NCBI answered 429 to 53.
    Spacing the starts is what the documented limit actually constrains.
    """
    global _next_request_at, _pace_logged

    # The configured rate (10/s by default) assumes a key, but get_ncbi_params
    # adds one only when NCBI_API_KEY is set; without it NCBI allows 3/s, and
    # pacing at 10 is what the 429s look like. Asked of get_ncbi_params rather
    # than the environment so the variable's name lives in one place.
    rate = config.clinvar_rate_limit
    if "api_key" not in get_ncbi_params({}):
        rate = min(rate, _UNKEYED_RATE_LIMIT)
        if not _pace_logged:
            logger.info(
                f"NCBI_API_KEY is not set: pacing ClinVar at {rate}/s, not "
                f"the configured {config.clinvar_rate_limit}/s"
            )
            _pace_logged = True
    # PipelineConfig.__post_init__ rejects a rate limit below 1, so this is a
    # plain divide rather than a guarded one.
    interval = 1.0 / rate
    async with _get_rate_lock():
        now = asyncio.get_running_loop().time()
        wait = max(0.0, _next_request_at - now)
        _next_request_at = max(now, _next_request_at) + interval
    if wait:
        await asyncio.sleep(wait)


async def _send_throttled(
    send: Callable[[], Awaitable[httpx.Response]],
    config: PipelineConfig,
    label: str,
) -> httpx.Response:
    """Send one paced request, retrying a 429 with widening backoff.

    Pacing alone cannot guarantee no 429: the limit is per API key, so another
    process on the same key -- or the NCBI-side clock not agreeing with ours
    about where a second begins -- can still bounce a request that we spaced
    correctly. A 429 is explicitly retryable, unlike the 500s the callers
    treat as a transient miss.
    """
    response = await send()
    for attempt in range(_RATE_LIMIT_RETRIES):
        if response.status_code != 429:
            return response
        delay = _RATE_LIMIT_BACKOFF * (attempt + 1)
        logger.debug(f"ClinVar {label} rate-limited, retrying in {delay:.1f}s")
        await asyncio.sleep(delay)
        await _throttle(config)
        response = await send()
    return response


async def close_clinvar_client() -> None:
    """Close shared HTTP client (call at shutdown)."""
    await _client_manager.close()


def clear_clinvar_cache() -> None:
    """Clear the ClinVar cache, its in-flight tasks and its loop primitives.

    The lock and semaphore bind to the event loop that first awaits them, so
    leaving them set makes a second asyncio.run() in one process raise
    "bound to a different event loop". They are rebuilt lazily on next use.
    """
    global _clinvar_cache, _cache_lock, _clinvar_semaphore, _rate_lock
    global _next_request_at, _pace_logged
    _clinvar_cache = OrderedDict()
    _in_flight.clear()
    _cache_lock = None
    _clinvar_semaphore = None
    _rate_lock = None
    _next_request_at = 0.0
    _pace_logged = False


# ---------------------------------------------------------------------------
# PARSING
# ---------------------------------------------------------------------------


def _describes_gene(record: dict[str, Any], gene_symbol: str) -> bool:
    """True when the record's traits are this gene's rather than a region's.

    A record naming exactly one gene is that gene's whatever its variant type:
    a single-gene copy-number loss is a whole-gene deletion and its traits are
    the gene's own. The symbol is not required to match there either, because
    ClinVar can answer under the current name of an obsolete symbol, the way
    NCBI Gene answers ``C6orf195`` as ``LINC01600``.

    Beyond one gene the record has to earn its place: the searched symbol must
    be among the genes named, the record must not be typed as a copy-number
    event, the gene list must be short enough to be an overlap rather than a
    span, and the variant must not *reach* like a span either. Reading
    *every* multi-gene record as a CNV is what published TREX1, TIMP3, VCAN
    and LOX with no disease at all -- see the module docstring. Reading none
    of them as one is what published squalene synthase deficiency as CTSB's
    disease: FDFT1's 120-kb deletion is typed ``Deletion``, names two genes,
    and clears every rule but the span -- see ``_MAX_OVERLAP_SPAN``.
    """
    symbols = [str(gene.get("symbol") or "") for gene in record.get("genes") or []]
    if not symbols:
        return False
    if len(symbols) == 1:
        return True
    if len(symbols) > _MAX_RECORD_GENES:
        return False
    if gene_symbol.upper() not in {symbol.upper() for symbol in symbols}:
        return False
    types = {str(record.get("obj_type") or "").casefold()}
    types.update(
        str(variation.get("variant_type") or "").casefold()
        for variation in record.get("variation_set") or []
    )
    if types & _CNV_VARIANT_TYPES:
        return False
    return _record_span(record) <= _MAX_OVERLAP_SPAN


def _record_span(record: dict[str, Any]) -> int:
    """The widest genomic interval the record's variants cover, in bases.

    Zero when no location carries a usable start and stop -- an unplaced
    record is judged by the other rules alone rather than discarded, since
    the absent coordinate is ClinVar's omission and not evidence of a span.
    """
    widest = 0
    for variation in record.get("variation_set") or []:
        for loc in variation.get("variation_loc") or []:
            try:
                start = int(loc.get("start") or 0)
                stop = int(loc.get("stop") or 0)
            except (TypeError, ValueError):
                continue
            if start and stop:
                widest = max(widest, abs(stop - start))
    return widest


def _disease_xrefs(trait: dict[str, Any]) -> set[str]:
    """Canonical xrefs for one trait, or an empty set if it names no disease."""
    xrefs = {
        canonical_xref(str(x.get("db_source", "")), str(x.get("db_id", "")))
        for x in trait.get("trait_xrefs") or []
    }
    resolved = {x for x in xrefs if x is not None}
    if not any(xref_prefix(x) in _DISEASE_PREFIXES for x in resolved):
        return set()
    return resolved


def _aggregate_records(
    gene_symbol: str,
    records: list[dict[str, Any]],
) -> ClinVarGeneResult:
    """Group surviving records by trait and rank by supporting-record count."""
    by_trait: dict[str, _TraitAccumulator] = {}

    for record in records:
        if not _describes_gene(record, gene_symbol):
            continue
        classification = record.get("germline_classification") or {}
        for trait in classification.get("trait_set") or []:
            xrefs = _disease_xrefs(trait)
            if not xrefs:
                continue
            name = str(trait.get("trait_name") or "").strip()
            if not name:
                continue
            accumulator = by_trait.setdefault(name, _TraitAccumulator())
            accumulator.xrefs |= xrefs
            accumulator.record_count += 1
            if description := classification.get("description"):
                accumulator.classifications[str(description)] += 1

    # Different trait names can resolve to one disease. Group them before
    # reducing so evidence is summed and the UNIQUE annotation key cannot
    # overwrite one label with another.
    grouped: dict[str, list[tuple[str, _TraitAccumulator]]] = {}
    for name, accumulator in by_trait.items():
        group_key = group_key_for(accumulator.xrefs)
        grouped.setdefault(group_key, []).append((name, accumulator))

    diseases = sorted(
        (
            _merge_trait_group(group_key, traits)
            for group_key, traits in grouped.items()
        ),
        key=lambda disease: (-disease.record_count, disease.trait_name),
    )
    return ClinVarGeneResult(
        gene_symbol=gene_symbol,
        diseases=tuple(diseases),
    )


def _most_common(counter: Counter[str]) -> str | None:
    """Most frequent value, ties broken alphabetically for reproducibility."""
    if not counter:
        return None
    return min(counter.items(), key=lambda item: (-item[1], item[0]))[0]


def _merge_trait_group(
    group_key: str,
    traits: list[tuple[str, _TraitAccumulator]],
) -> ClinVarDisease:
    """Reduce alternate names for one disease to one deterministic result."""
    # Choose on each name's own evidence, not the growing group total. Ties
    # break alphabetically so payload order cannot change the published label.
    trait_name, _ = min(
        traits,
        key=lambda item: (-item[1].record_count, item[0]),
    )
    merged = _TraitAccumulator()
    for _, accumulator in traits:
        merged.xrefs.update(accumulator.xrefs)
        merged.classifications += accumulator.classifications
        merged.record_count += accumulator.record_count
    return ClinVarDisease(
        trait_name=trait_name,
        group_key=group_key,
        xrefs=tuple(sorted(merged.xrefs)),
        classification=_most_common(merged.classifications),
        record_count=merged.record_count,
    )


# ---------------------------------------------------------------------------
# FETCH FUNCTIONS
# ---------------------------------------------------------------------------


async def _search_uids(
    gene_symbol: str, config: PipelineConfig
) -> tuple[list[str], int] | None:
    """Return (uids, total_count) for a gene's pathogenic records, or None.

    None means a transient failure -- the caller must not cache that as
    "this gene has no diseases".
    """
    params = get_ncbi_params(
        {
            "db": "clinvar",
            "term": f'{gene_symbol}[gene] AND "clinsig pathogenic"{_PROPERTIES_FIELD}',
            "retmode": "json",
            "retmax": str(config.clinvar_max_records),
        }
    )
    try:
        client = await _client_manager.get()
        await _throttle(config)
        resp = await _send_throttled(
            lambda: client.get(NCBI_ESEARCH_URL, params=params), config, "esearch"
        )
        if resp.status_code != 200:
            logger.warning(
                f"ClinVar esearch failed for {gene_symbol}: {resp.status_code}"
            )
            return None
        result = resp.json()["esearchresult"]
        # A phrase esearch could not parse is reported in-band, as a 200
        # with count "0" and errorlist.phrasesnotfound. The property token
        # is a frozen literal, so its failing to parse is NCBI's side, and
        # treating the zero as genuine would negative-cache every gene as
        # "no pathogenic records" for DB_CACHE_TTL_DAYS. The gene term alone
        # not being found is the genuine zero: a curated alias key is not a
        # symbol.
        not_found = (result.get("errorlist") or {}).get("phrasesnotfound") or []
        unparsed = [p for p in not_found if _PROPERTIES_FIELD in str(p)]
        if unparsed:
            logger.warning(
                f"ClinVar esearch could not parse the property term for "
                f"{gene_symbol}: {unparsed}"
            )
            return None
        return list(result.get("idlist") or []), int(result.get("count") or 0)
    except httpx.TimeoutException:
        logger.warning(f"Timeout querying ClinVar for {gene_symbol}")
    except httpx.RequestError as e:
        logger.warning(f"Request error querying ClinVar for {gene_symbol}: {e}")
    except (KeyError, ValueError) as e:
        logger.warning(f"Unexpected ClinVar esearch response for {gene_symbol}: {e}")
    return None


async def _fetch_summaries(
    uids: list[str], gene_symbol: str, config: PipelineConfig
) -> list[dict[str, Any]] | None:
    """Fetch esummary records in POSTed batches, or None if any batch failed.

    POST rather than GET: NOTCH3 returns 248 uids, which is past any sane URL
    length, and E-utilities accepts the same parameters as a form body.

    **A failed batch fails the whole gene.** NOTCH3's 248 uids are two batches;
    skipping one would publish a truncated disease set, and skipping both would
    publish none -- either way as a fresh status row that suppresses the retry
    for DB_CACHE_TTL_DAYS. Returning None keeps the caller from caching a
    partial answer as a complete one.
    """
    records: list[dict[str, Any]] = []
    client = await _client_manager.get()
    for start in range(0, len(uids), _ESUMMARY_BATCH):
        chunk = uids[start : start + _ESUMMARY_BATCH]
        params = get_ncbi_params(
            {"db": "clinvar", "retmode": "json", "id": ",".join(chunk)}
        )
        try:
            await _throttle(config)
            resp = await _send_throttled(
                # Bound rather than closed over: the retry re-invokes this,
                # and a bare closure would read whatever the loop reached.
                lambda body=params: client.post(NCBI_ESUMMARY_URL, data=body),
                config,
                "esummary",
            )
            if resp.status_code != 200:
                logger.warning(
                    f"ClinVar esummary failed for {gene_symbol}: {resp.status_code}"
                )
                return None
            result = resp.json().get("result", {})
        except httpx.TimeoutException:
            logger.warning(f"Timeout fetching ClinVar summaries for {gene_symbol}")
            return None
        except httpx.RequestError as e:
            logger.warning(f"Request error on ClinVar summaries for {gene_symbol}: {e}")
            return None
        except ValueError as e:
            logger.warning(f"Failed to parse ClinVar summaries for {gene_symbol}: {e}")
            return None
        for uid in result.get("uids") or []:
            record = result.get(uid)
            if not isinstance(record, dict):
                continue
            # NCBI reports a failed uid in-band, as a dict inside the 200:
            # {"uid": "...", "error": "cannot get document summary"}. It has
            # no "genes" key, so left in it would pass for a CNV and be
            # dropped silently -- the gene's status row then records fewer
            # diseases than it has, as a complete answer.
            if "error" in record:
                logger.warning(
                    f"ClinVar esummary could not return uid {uid} for "
                    f"{gene_symbol}: {record['error']}"
                )
                return None
            records.append(record)
    return records


async def _fetch_clinvar_uncached(
    gene_symbol: str, config: PipelineConfig
) -> ClinVarGeneResult | None:
    """Internal: fetch and aggregate one gene without caching."""
    searched = await _search_uids(gene_symbol, config)
    if searched is None:
        return None
    uids, total = searched
    if not uids:
        logger.debug(f"No pathogenic ClinVar records for {gene_symbol}")
        return ClinVarGeneResult(gene_symbol=gene_symbol, diseases=())
    truncated = total > len(uids)
    if truncated:
        logger.info(
            f"ClinVar returned {total} records for {gene_symbol}, capped at "
            f"{len(uids)} -- record counts are a floor, not a total"
        )
    records = await _fetch_summaries(uids, gene_symbol, config)
    if records is None:
        return None
    return _aggregate_records(gene_symbol, records)


async def fetch_clinvar_diseases(
    gene_symbol: str,
    config: PipelineConfig | None = None,
) -> ClinVarGeneResult | None:
    """Fetch every disease ClinVar associates with one gene symbol.

    Results are cached; concurrent callers for the same symbol share one
    in-flight fetch via ``single_flight_get``. None means a transient failure.
    """
    resolved = config or PipelineConfig()
    return await single_flight_get(
        gene_symbol.upper(),
        cache=_clinvar_cache,
        cache_lock=_get_cache_lock(),
        in_flight=_in_flight,
        semaphore=_get_clinvar_semaphore(resolved),
        fetch_fn=lambda: _fetch_clinvar_uncached(gene_symbol, resolved),
        label="ClinVar cache",
    )


# ---------------------------------------------------------------------------
# DATABASE SYNC
# ---------------------------------------------------------------------------


async def sync_clinvar_annotations(
    gene_symbols: list[str],
    config: PipelineConfig | None = None,
) -> SyncResult:
    """Sync ClinVar disease annotations for the given gene symbols.

    A gene that resolves to nothing gets a zero-count status row -- that is the
    negative cache. A gene whose fetch failed transiently gets no row at all,
    so a 500 is never remembered as "this gene has no diseases" for 30 days.
    """
    from pipeline.database import get_annotation_statuses, replace_gene_annotations

    cached = await get_annotation_statuses(
        gene_symbols, SOURCE, max_age_days=DB_CACHE_TTL_DAYS
    )
    stale = [s for s in gene_symbols if s not in cached]
    # A curated key that is not a gene symbol is queried by the symbols it
    # stands for and filed back under itself -- see `expand_lookup_symbols`.
    to_fetch, curated_by_query = expand_lookup_symbols(stale)

    logger.info(f"ClinVar sync: {len(cached)} cached, {len(stale)} to fetch")

    if not to_fetch:
        return SyncResult(cached=len(cached))

    results = await run_batched_fetch(
        to_fetch,
        lambda symbol: fetch_clinvar_diseases(symbol, config=config),
        make_log_progress("ClinVar fetch"),
    )

    rows: list[AnnotationRow] = []
    errors: list[str] = []
    # Keyed by curated symbol, because that is the unit a status row and the
    # negative cache are about: one alias failing must not let the other
    # alias write a status that suppresses the retry for 30 days.
    row_counts: dict[str, int] = {}
    failed_curated: set[str] = set()

    for symbol, result in zip(to_fetch, results, strict=True):
        curated = curated_by_query[symbol]
        if result is None:
            errors.append(f"ClinVar fetch failed: {symbol}")
            failed_curated.add(curated)
            continue
        gene_rows = [
            replace(row, gene_symbol=curated) if row.gene_symbol != curated else row
            for row in result.to_annotation_rows()
        ]
        rows.extend(gene_rows)
        row_counts[curated] = row_counts.get(curated, 0) + len(gene_rows)

    statuses = [
        AnnotationStatus(
            gene_symbol=curated,
            source=SOURCE,
            row_count=count,
            source_version=None,
        )
        for curated, count in row_counts.items()
        if curated not in failed_curated
    ]
    written = {status.gene_symbol for status in statuses}
    rows = [row for row in rows if row.gene_symbol in written]
    empty = sorted(status.gene_symbol for status in statuses if not status.row_count)

    if empty:
        logger.info(f"No ClinVar disease for {len(empty)} genes: {', '.join(empty)}")

    await replace_gene_annotations(rows, statuses)

    return SyncResult(
        fetched=len(statuses),
        cached=len(cached),
        failed=len(failed_curated),
        errors=errors,
    )
