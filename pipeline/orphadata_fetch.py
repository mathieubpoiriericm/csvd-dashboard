"""Orphadata enrichment of the ORPHAcodes ClinVar returns.

Orphadata has no gene entry point. ``rd-associated-genes/genes/HTRA1`` is a
404 -- verified 2026-08-31 -- and every endpoint is keyed by ORPHAcode. So
ClinVar is the entry point and this is the enrichment: it reads the
``Orphanet:`` rows ``clinvar_fetch`` wrote and fetches each code.

Two endpoints, and they nest differently. Cross-references live at
``data.results.ExternalReference``; phenotypes live one level deeper at
``data.results.Disorder.HPODisorderAssociation``. Reading
``results.HPODisorderAssociation`` returns nothing and looks exactly like a
disease with no phenotypes, so both paths are pinned by test.

``rd-associated-genes`` is deliberately not stored: it returns the *gene's*
OMIM number (602194 for HTRA1) beside the disease's (600142), and putting both
in one column would give "OMIM" two meanings on one gene.

The mapping qualifier is the scientific payload. ``DisorderMappingRelation``
distinguishes "E (Exact mapping: the two concepts are equivalent)" from
"NTBT (ORPHAcode is narrower than the targeted code used to represent it)" --
it says when an OMIM number is not a synonym for the Orphanet disease. Only
the leading token is stored; the parenthetical is prose that would repeat on
every row.
"""

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Final

import httpx

from pipeline.annotations import AnnotationRow, AnnotationStatus
from pipeline.cache_utils import (
    DB_CACHE_TTL_DAYS,
    SyncResult,
    make_log_progress,
    run_batched_fetch,
    single_flight_get,
)
from pipeline.config import (
    ORPHADATA_BASE_URL,
    ORPHADATA_LICENCE,
    PipelineConfig,
)
from pipeline.http_client import AsyncHttpClientManager
from pipeline.xrefs import canonical_xref

logger = logging.getLogger(__name__)

SOURCE: Final[str] = "orphadata"
# The entry point: ORPHAcodes are read from this source's rows, and its
# status is what says a gene without any was answered rather than missed.
_CLINVAR_SOURCE: Final[str] = "clinvar"
_ORPHANET_PREFIX: Final[str] = "Orphanet:"


@dataclass(slots=True)
class OrphadataReference:
    """One cross-reference or phenotype row, before it gains a gene symbol."""

    object_id: str
    object_label: str | None
    qualifier: str | None
    relation: str


@dataclass(slots=True)
class OrphadataDisease:
    """One ORPHAcode's cross-references and phenotypes."""

    preferred_term: str
    cross_references: tuple[OrphadataReference, ...]
    phenotypes: tuple[OrphadataReference, ...]
    source_date: str | None


_client_manager = AsyncHttpClientManager(timeout=30.0)
_orphadata_cache: OrderedDict[str, OrphadataDisease | None] = OrderedDict()
_cache_lock: asyncio.Lock | None = None
_orphadata_semaphore: asyncio.Semaphore | None = None
_in_flight: dict[str, asyncio.Task[OrphadataDisease | None]] = {}


def _get_cache_lock() -> asyncio.Lock:
    """Get cache lock, initializing lazily if needed."""
    global _cache_lock
    if _cache_lock is None:
        _cache_lock = asyncio.Lock()
    return _cache_lock


def _get_orphadata_semaphore(
    config: PipelineConfig | None = None,
) -> asyncio.Semaphore:
    """Get Orphadata rate-limit semaphore, initializing lazily if needed."""
    global _orphadata_semaphore
    if _orphadata_semaphore is None:
        limit = (config or PipelineConfig()).orphadata_rate_limit
        _orphadata_semaphore = asyncio.Semaphore(limit)
    return _orphadata_semaphore


async def close_orphadata_client() -> None:
    """Close shared HTTP client (call at shutdown)."""
    await _client_manager.close()


def clear_orphadata_cache() -> None:
    """Clear the Orphadata cache, its in-flight tasks and its loop primitives.

    The lock and semaphore bind to the event loop that first awaits them; see
    clear_clinvar_cache.
    """
    global _orphadata_cache, _cache_lock, _orphadata_semaphore
    _orphadata_cache = OrderedDict()
    _in_flight.clear()
    _cache_lock = None
    _orphadata_semaphore = None


def _parse_cross_references(results: dict[str, Any]) -> list[OrphadataReference]:
    """Cross-references for one disorder, in a deterministic order."""
    references: list[OrphadataReference] = []
    for entry in results.get("ExternalReference") or []:
        xref = canonical_xref(
            str(entry.get("Source", "")), str(entry.get("Reference", ""))
        )
        if xref is None:
            continue
        relation_text = str(entry.get("DisorderMappingRelation") or "")
        references.append(
            OrphadataReference(
                object_id=xref,
                object_label=None,
                # "E (Exact mapping: ...)" -> "E". The parenthetical is prose
                # that would repeat identically on every row.
                qualifier=relation_text.split(" ", 1)[0] or None,
                relation="disease_xref",
            )
        )
    return sorted(references, key=lambda r: r.object_id)


def _parse_phenotypes(results: dict[str, Any]) -> list[OrphadataReference]:
    """HPO terms with frequency.

    Note the extra ``Disorder`` level -- this endpoint nests one deeper than
    ``rd-cross-referencing`` does, and reading ``results`` directly silently
    yields nothing.
    """
    disorder = results.get("Disorder") or {}
    phenotypes: list[OrphadataReference] = []
    for entry in disorder.get("HPODisorderAssociation") or []:
        hpo = entry.get("HPO") or {}
        # Through canonical_xref like every other identifier, rather than
        # trusting the payload's own spelling.
        hpo_id = canonical_xref("HP", str(hpo.get("HPOId") or ""))
        if hpo_id is None:
            continue
        phenotypes.append(
            OrphadataReference(
                object_id=hpo_id,
                object_label=str(hpo.get("HPOTerm") or "") or None,
                qualifier=str(entry.get("HPOFrequency") or "") or None,
                relation="phenotype",
            )
        )
    return phenotypes


@dataclass(slots=True)
class _Fetched:
    """One endpoint's outcome, wrapped so the three cases stay distinguishable.

    ``_get_results`` returns ``None`` for a transport failure and a ``_Fetched``
    otherwise, whose ``results`` is ``None`` for a confirmed 404. A bare
    ``dict | bool | None`` union does not narrow -- after the ``is None`` and
    ``is False`` guards a type checker still sees ``bool`` in the union and
    rejects ``.get()`` on it.
    """

    results: dict[str, Any] | None


async def _get_results(path: str, orphacode: str) -> _Fetched | None:
    """Fetch one endpoint. None is a failure; ``_Fetched(None)`` is a 404.

    **A 200 that does not carry the envelope is a failure, not an empty
    answer.** ``data.results`` absent used to read as "this disease has no
    cross-references": the disease was built empty, a zero-count status row was
    written, and ``replace_gene_annotations`` deleted the enrichment the gene
    already had -- negative-cached for DB_CACHE_TTL_DAYS while the run reported
    success. An in-band error document (`{"message": "service degraded"}`) and
    a renamed field both arrive in that shape, so only the *key* being present
    counts as an answer; a present-but-empty ``results`` still does.
    """
    url = f"{ORPHADATA_BASE_URL}/{path}/orphacodes/{orphacode}"
    try:
        client = await _client_manager.get()
        resp = await client.get(url, headers={"accept": "application/json"})
        if resp.status_code == 404:
            return _Fetched(None)
        if resp.status_code != 200:
            logger.warning(
                f"Orphadata {path} failed for {orphacode}: {resp.status_code}"
            )
            return None
        payload = resp.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, dict) or "results" not in data:
            logger.warning(
                f"Orphadata {path} answered 200 with no data.results for "
                f"{orphacode}; treating it as a failure rather than as a "
                "disease with no cross-references"
            )
            return None
    except httpx.TimeoutException:
        logger.warning(f"Timeout querying Orphadata {path} for {orphacode}")
        return None
    except httpx.RequestError as e:
        logger.warning(f"Request error on Orphadata {path} for {orphacode}: {e}")
        return None
    except ValueError as e:
        logger.warning(f"Failed to parse Orphadata {path} for {orphacode}: {e}")
        return None

    licence = (data.get("__licence") or {}).get("identifier")
    if licence and licence != ORPHADATA_LICENCE:
        logger.error(
            f"Orphadata now reports licence {licence!r}, not {ORPHADATA_LICENCE!r}. "
            "The attribution published on the About page is tied to that value -- "
            "review it before publishing this run."
        )
    return _Fetched(data.get("results") or {})


async def fetch_orphadata_disease(
    orphacode: str, config: PipelineConfig | None = None
) -> OrphadataDisease | None:
    """Fetch one ORPHAcode's cross-references and phenotypes.

    Two ORPHAcodes can reach the same disease from different genes, so this
    goes through ``single_flight_get`` like every other fetcher here.
    """
    return await single_flight_get(
        orphacode,
        cache=_orphadata_cache,
        cache_lock=_get_cache_lock(),
        in_flight=_in_flight,
        semaphore=_get_orphadata_semaphore(config),
        fetch_fn=lambda: _fetch_orphadata_uncached(orphacode),
        label="Orphadata cache",
    )


async def _fetch_orphadata_uncached(orphacode: str) -> OrphadataDisease | None:
    """Internal: fetch both endpoints without caching.

    A 404 is a confirmed absence and returns an empty disease; a 5xx or a
    transport error returns None so the caller does not cache it.
    """
    fetched_xrefs = await _get_results("rd-cross-referencing", orphacode)
    if fetched_xrefs is None:
        return None
    if fetched_xrefs.results is None:
        return OrphadataDisease(
            preferred_term="",
            cross_references=(),
            phenotypes=(),
            source_date=None,
        )
    xref_results = fetched_xrefs.results

    fetched_phenotypes = await _get_results("rd-phenotypes", orphacode)
    if fetched_phenotypes is None:
        return None
    phenotype_results = fetched_phenotypes.results or {}

    return OrphadataDisease(
        preferred_term=str(xref_results.get("Preferred term") or ""),
        cross_references=tuple(_parse_cross_references(xref_results)),
        phenotypes=tuple(_parse_phenotypes(phenotype_results)),
        source_date=str(xref_results.get("Date") or "") or None,
    )


async def orphacodes_by_gene() -> dict[str, list[tuple[str, str]]]:
    """Map each gene to the (orphacode, group_key) pairs ClinVar found for it."""
    from pipeline.database import read_gene_annotations

    rows = await read_gene_annotations(source=_CLINVAR_SOURCE)
    found: dict[str, list[tuple[str, str]]] = {}
    for row in rows:
        object_id = str(row["object_id"])
        if not object_id.startswith(_ORPHANET_PREFIX):
            continue
        pair = (object_id.removeprefix(_ORPHANET_PREFIX), str(row["group_key"]))
        codes = found.setdefault(str(row["gene_symbol"]), [])
        if pair not in codes:
            codes.append(pair)
    return found


def _clinvar_moved_since(
    clinvar: dict[str, Any] | None, orphadata: dict[str, Any]
) -> bool:
    """True when ClinVar's status for a gene was written after Orphadata's.

    A missing timestamp on either side answers False: this invalidates a cache
    on evidence, and "unknown" is not evidence.
    """
    if clinvar is None:
        return False
    clinvar_at = clinvar.get("updated_at")
    orphadata_at = orphadata.get("updated_at")
    if clinvar_at is None or orphadata_at is None:
        return False
    return bool(clinvar_at > orphadata_at)


# "E (Exact mapping: the two concepts are equivalent)" -- the only qualifier
# the export can act on, which is what makes it the tie-break below.
_EXACT_MAPPING: Final[str] = "E"


def _resolve_code_collisions(
    gene_symbol: str, coded_rows: list[tuple[str, AnnotationRow]]
) -> list[AnnotationRow]:
    """One row per UNIQUE key, deciding between ORPHAcodes out loud.

    ClinVar can attach several ORPHAcodes to one disease group -- LAMC2 carries
    four under MONDO:0009180 -- and each code reports its own
    ``DisorderMappingRelation`` for a shared target. Those rows land on the
    same ``(gene, source, relation, group_key, object_id)`` key, so
    ``ON CONFLICT DO UPDATE`` kept whichever the sort happened to write last
    and the other mapping vanished from the database and the export with no
    log line. The relation is the scientific payload -- it says whether an
    OMIM number is a synonym for the Orphanet disease -- so the choice is made
    here instead: an exact mapping wins, otherwise the first code in ClinVar's
    order does, and a conflict is always logged.
    """
    chosen: dict[tuple[str, str, str], tuple[str, AnnotationRow]] = {}
    for code, row in coded_rows:
        key = (row.relation, row.group_key, row.object_id)
        held = chosen.get(key)
        if held is None:
            chosen[key] = (code, row)
            continue
        held_code, held_row = held
        if held_row.qualifier == row.qualifier:
            continue
        keeper = (code, row) if row.qualifier == _EXACT_MAPPING else held
        logger.warning(
            f"Orphadata mapping conflict for {gene_symbol} on {row.object_id} "
            f"under {row.group_key}: ORPHA:{held_code} reports "
            f"{held_row.qualifier!r}, ORPHA:{code} reports {row.qualifier!r}; "
            f"keeping ORPHA:{keeper[0]}'s"
        )
        chosen[key] = keeper
    return [row for _, row in chosen.values()]


async def sync_orphadata_annotations(
    gene_symbols: list[str],
    config: PipelineConfig | None = None,
) -> SyncResult:
    """Sync Orphadata enrichment for genes that have an ORPHAcode.

    A gene with no ORPHAcode gets a zero-count status row rather than being
    skipped: there is no gene entry point, so "no ORPHAcode" is the final
    answer for this source, not a reason to retry every run.

    That is only a final answer once ClinVar has given one. The ORPHAcodes
    are read from the rows ClinVar wrote, and a gene whose ClinVar fetch
    failed has no rows and no status -- the same shape as a gene ClinVar
    answered with no Orphanet identifier. Writing the zero-count row for the
    first would negative-cache ClinVar's outage here for DB_CACHE_TTL_DAYS,
    so a gene with no ClinVar status of any age is skipped as a failure and
    retried on the next sync.

    **This source's TTL is not its own.** The rows are keyed on the ORPHAcodes
    and `group_key`s ClinVar chose, so a ClinVar refresh that adds a code or
    moves a group leaves enrichment behind that no longer joins -- the export
    drops the group with a warning, or the added code simply has none, for the
    rest of the 30 days while both syncs report success. A gene whose ClinVar
    status is newer than its Orphadata status is therefore re-fetched whatever
    its own age says. Under one `--sync-annotations` the two expire together
    and nothing is re-fetched; it is the manual ClinVar purge, and any run in
    which ClinVar fetched and Orphadata did not, that this covers.
    """
    from pipeline.database import get_annotation_statuses, replace_gene_annotations

    cached = await get_annotation_statuses(
        gene_symbols, SOURCE, max_age_days=DB_CACHE_TTL_DAYS
    )
    clinvar_answered = await get_annotation_statuses(
        gene_symbols, _CLINVAR_SOURCE, max_age_days=None
    )
    invalidated = {
        symbol
        for symbol, status in cached.items()
        if _clinvar_moved_since(clinvar_answered.get(symbol), status)
    }
    for symbol in sorted(invalidated):
        logger.info(
            f"Orphadata cache for {symbol} invalidated: ClinVar was refreshed "
            "after it, so its ORPHAcodes may have moved"
        )
    still_cached = [s for s in cached if s not in invalidated]
    to_fetch = [s for s in gene_symbols if s not in cached or s in invalidated]

    logger.info(
        f"Orphadata sync: {len(still_cached)} cached, {len(to_fetch)} to fetch"
    )

    if not to_fetch:
        return SyncResult(cached=len(still_cached))

    unanswered = [s for s in to_fetch if s not in clinvar_answered]
    to_fetch = [s for s in to_fetch if s in clinvar_answered]

    by_gene = await orphacodes_by_gene()
    wanted = sorted(
        {code for symbol in to_fetch for code, _ in by_gene.get(symbol, [])}
    )

    results = await run_batched_fetch(
        wanted,
        # run_batched_fetch calls fetch_one(item) with one positional argument,
        # so passing the bare callable silently dropped the caller's config and
        # every run used a fresh PipelineConfig()'s rate limit.
        lambda code: fetch_orphadata_disease(code, config=config),
        make_log_progress("Orphadata fetch"),
    )
    diseases = {
        code: disease
        for code, disease in zip(wanted, results, strict=True)
        if disease is not None
    }

    rows: list[AnnotationRow] = []
    statuses: list[AnnotationStatus] = []
    errors = [f"Orphadata skipped {s}: no ClinVar answer yet" for s in unanswered]
    errors.extend(f"Orphadata fetch failed: {c}" for c in wanted if c not in diseases)

    for symbol in to_fetch:
        wanted_here = by_gene.get(symbol, [])
        # A gene with any failed ORPHAcode must not be written at all -- not
        # merely one whose every code failed. replace_gene_annotations deletes
        # before it inserts, so writing the codes that did answer plus a status
        # row drops the failed code's rows from the previous run and then
        # suppresses the retry for DB_CACHE_TTL_DAYS while the run reports
        # success: a partial answer cached as a complete one. A gene with no
        # ORPHAcode is a different case: that is a final answer, not a
        # failure, and does get a zero-count row.
        if any(diseases.get(code) is None for code, _ in wanted_here):
            continue

        gene_rows = _resolve_code_collisions(
            symbol,
            [
                (
                    code,
                    AnnotationRow(
                        gene_symbol=symbol,
                        source=SOURCE,
                        relation=reference.relation,
                        group_key=group_key,
                        object_id=reference.object_id,
                        object_label=reference.object_label
                        or diseases[code].preferred_term,
                        qualifier=reference.qualifier,
                        score=None,
                        evidence_count=None,
                        source_version=diseases[code].source_date,
                    ),
                )
                for code, group_key in wanted_here
                for reference in (
                    *diseases[code].cross_references,
                    *diseases[code].phenotypes,
                )
            ],
        )
        rows.extend(gene_rows)
        statuses.append(
            AnnotationStatus(
                gene_symbol=symbol,
                source=SOURCE,
                row_count=len(gene_rows),
                source_version=None,
            )
        )

    await replace_gene_annotations(rows, statuses)

    return SyncResult(
        fetched=len(statuses),
        cached=len(still_cached),
        failed=len(errors),
        errors=errors,
    )
