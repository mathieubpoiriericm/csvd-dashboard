"""Open Targets gene identity, disease associations and GO terms.

One httpx POST with a JSON body is the whole GraphQL transport; a client
library for that would be a dependency for string interpolation. ``graphql``
is shared with ``opentargets_drugs``.

The API self-describes as "Open Targets GraphQL & REST API Beta" and its schema
has already shifted once, so every row records the data version it came from
and the sync warns when the live version differs from the pinned one. Two
traps were hit live on 2026-08-31 and are pinned by test:

* ``GeneOntologyTerm`` exposes ``label``, not ``name``. ``term { id name }`` is
  a GraphQL error -- which arrives as a 200 with an ``errors`` array, not a 4xx.
* ``Target.knownDrugs`` is gone, replaced by ``drugAndClinicalCandidates``
  (row type ``ClinicalTargetFromTarget``, no ``size`` argument, no ``phase`` /
  ``status`` / ``drugType``). Neither is queried here; mechanisms come from
  ``Drug.mechanismsOfAction`` in ``opentargets_drugs``.

``dbXrefs`` is filtered rather than stored whole -- HTRA1's 30-odd entries are
mostly PDB structure accessions, which say nothing about gene identity.
"""

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass, replace
from typing import Any, Final

import httpx

from pipeline.annotations import (
    AnnotationRow,
    AnnotationStatus,
    expand_lookup_symbols,
)
from pipeline.cache_utils import (
    DB_CACHE_TTL_DAYS,
    SyncResult,
    make_log_progress,
    run_batched_fetch,
    single_flight_get,
)
from pipeline.config import OPENTARGETS_GRAPHQL_URL, PipelineConfig
from pipeline.http_client import AsyncHttpClientManager
from pipeline.xrefs import canonical_from_compact, canonical_xref

logger = logging.getLogger(__name__)

SOURCE: Final[str] = "opentargets"

# Identity authorities worth storing. Everything else dbXrefs returns for a
# human gene is structural (PDB) or redundant with Ensembl.
_IDENTITY_SOURCES: Final[frozenset[str]] = frozenset({"HGNC"})

# The "not resolved yet" default for fetch_opentargets_target's data_version.
# A None default could not tell that apart from "resolved, and the meta query
# failed", so when the sync's one meta query failed every per-gene call re-ran
# it -- 63 round trips, each outside single_flight_get and its semaphore.
_UNRESOLVED: Final = object()

_META_QUERY: Final[str] = (
    "{ meta { dataVersion { year month } } }"
)

_SEARCH_QUERY: Final[str] = """
query Resolve($q: String!) {
  search(queryString: $q, entityNames: ["target"], page: {index: 0, size: 5}) {
    hits { id object { ... on Target { approvedSymbol } } }
  }
}
"""

# term { id label } -- NOT name. GeneOntologyTerm has no name field.
_TARGET_QUERY: Final[str] = """
query Target($id: String!, $diseases: Int!) {
  target(ensemblId: $id) {
    id
    approvedSymbol
    approvedName
    biotype
    dbXrefs { id source }
    geneOntology { aspect evidence source term { id label } }
    associatedDiseases(page: {index: 0, size: $diseases}) {
      count
      rows { score disease { id name } }
    }
  }
}
"""


@dataclass(slots=True)
class OpenTargetsTarget:
    """One gene's Open Targets annotations."""

    gene_symbol: str
    ensembl_id: str | None
    rows: tuple[AnnotationRow, ...]
    data_version: str | None


_client_manager = AsyncHttpClientManager(timeout=60.0)
_target_cache: OrderedDict[str, OpenTargetsTarget | None] = OrderedDict()
_cache_lock: asyncio.Lock | None = None
_opentargets_semaphore: asyncio.Semaphore | None = None
_in_flight: dict[str, asyncio.Task[OpenTargetsTarget | None]] = {}


def _get_cache_lock() -> asyncio.Lock:
    """Get cache lock, initializing lazily if needed."""
    global _cache_lock
    if _cache_lock is None:
        _cache_lock = asyncio.Lock()
    return _cache_lock


def _get_opentargets_semaphore(
    config: PipelineConfig | None = None,
) -> asyncio.Semaphore:
    """Get Open Targets rate-limit semaphore, initializing lazily if needed."""
    global _opentargets_semaphore
    if _opentargets_semaphore is None:
        limit = (config or PipelineConfig()).opentargets_rate_limit
        _opentargets_semaphore = asyncio.Semaphore(limit)
    return _opentargets_semaphore


async def close_opentargets_client() -> None:
    """Close shared HTTP client (call at shutdown)."""
    await _client_manager.close()


def clear_opentargets_cache() -> None:
    """Clear the Open Targets cache, in-flight tasks and loop primitives.

    The lock and semaphore bind to the event loop that first awaits them; see
    clear_clinvar_cache.
    """
    global _target_cache, _cache_lock, _opentargets_semaphore
    _target_cache = OrderedDict()
    _in_flight.clear()
    _cache_lock = None
    _opentargets_semaphore = None


async def graphql(query: str, variables: dict[str, Any]) -> dict[str, Any] | None:
    """POST one GraphQL query. Returns the ``data`` object, or None.

    A schema drift arrives as a **200 with an ``errors`` array**, not a 4xx, so
    the errors check is not optional -- without it a renamed field looks like
    an empty result and silently writes zero rows.
    """
    try:
        client = await _client_manager.get()
        resp = await client.post(
            OPENTARGETS_GRAPHQL_URL, json={"query": query, "variables": variables}
        )
        if resp.status_code != 200:
            logger.warning(f"Open Targets returned {resp.status_code}")
            return None
        payload = resp.json()
    except httpx.TimeoutException:
        logger.warning("Timeout querying Open Targets")
        return None
    except httpx.RequestError as e:
        logger.warning(f"Request error querying Open Targets: {e}")
        return None
    except ValueError as e:
        logger.warning(f"Failed to parse Open Targets response: {e}")
        return None

    if errors := payload.get("errors"):
        messages = "; ".join(str(e.get("message", e)) for e in errors)
        logger.error(f"Open Targets GraphQL error -- schema drift? {messages}")
        return None
    return payload.get("data")


async def fetch_data_version() -> str | None:
    """Return the live data version as ``"26.06"``, or None."""
    data = await graphql(_META_QUERY, {})
    if not data:
        return None
    version = ((data.get("meta") or {}).get("dataVersion")) or {}
    year, month = version.get("year"), version.get("month")
    if not year or not month:
        return None
    return f"{year}.{month}"


@dataclass(slots=True)
class _Resolution:
    """One search outcome, wrapped so three cases stay distinguishable.

    ``resolve_target`` returns ``None`` for a transport or GraphQL failure and
    a ``_Resolution`` otherwise, whose ``ensembl_id`` is ``None`` when the
    search succeeded and Open Targets simply has no such gene. Collapsing those
    two into a bare ``str | None`` is what let an outage be cached as "this
    gene has no annotations" for DB_CACHE_TTL_DAYS.
    """

    ensembl_id: str | None


async def resolve_target(gene_symbol: str) -> _Resolution | None:
    """Resolve a bare symbol to its Ensembl gene ID.

    Exact ``approvedSymbol`` match only. A substring search for HTRA1 also
    returns HTRA1-AS1, an antisense lncRNA that is a different gene.
    """
    data = await graphql(_SEARCH_QUERY, {"q": gene_symbol})
    if data is None:
        return None
    wanted = gene_symbol.upper()
    for hit in ((data.get("search") or {}).get("hits")) or []:
        approved = ((hit.get("object") or {}).get("approvedSymbol")) or ""
        if approved.upper() == wanted:
            # `str(...) or None` would yield the truthy string "None" for a hit
            # carrying no id, which then reaches the target query as an
            # Ensembl accession.
            ensembl_id = hit.get("id")
            return _Resolution(str(ensembl_id) if ensembl_id else None)
    return _Resolution(None)


def _parse_target(
    gene_symbol: str, target: dict[str, Any], data_version: str | None
) -> list[AnnotationRow]:
    """Turn one target payload into annotation rows, deduplicated and sorted."""
    biotype = str(target.get("biotype") or "") or None
    approved_name = str(target.get("approvedName") or "") or None
    rows: dict[tuple[str, str, str], AnnotationRow] = {}

    def add(
        relation: str,
        group_key: str,
        object_id: str,
        label: str | None,
        qualifier: str | None,
        score: float | None,
    ) -> None:
        rows.setdefault(
            (relation, group_key, object_id),
            AnnotationRow(
                gene_symbol=gene_symbol,
                source=SOURCE,
                relation=relation,
                group_key=group_key,
                object_id=object_id,
                object_label=label,
                qualifier=qualifier,
                score=score,
                evidence_count=None,
                source_version=data_version,
            ),
        )

    # Through canonical_xref, not an f-string: pipeline/xrefs.py is the one
    # place a prefix spelling is decided, identity included.
    if ensembl := canonical_xref("Ensembl", str(target.get("id") or "")):
        add("identity", "", ensembl, approved_name, biotype, None)
    for xref in target.get("dbXrefs") or []:
        source = str(xref.get("source") or "")
        if source not in _IDENTITY_SOURCES:
            continue
        identity = canonical_xref(source, str(xref.get("id") or ""))
        if identity is None:
            continue
        add("identity", "", identity, approved_name, biotype, None)

    for entry in target.get("geneOntology") or []:
        term = entry.get("term") or {}
        # Through canonical_xref like every other identifier: pipeline/xrefs.py
        # is the one place a spelling is decided, and a GO accession is no
        # exception just because Open Targets already writes it prefixed.
        go_id = canonical_xref("GO", str(term.get("id") or ""))
        if go_id is None:
            continue
        aspect = str(entry.get("aspect") or "")
        evidence = str(entry.get("evidence") or "")
        add(
            "gene_ontology",
            "",
            go_id,
            str(term.get("label") or "") or None,
            f"{aspect}/{evidence}".strip("/") or None,
            None,
        )

    associated = target.get("associatedDiseases") or {}
    for row in associated.get("rows") or []:
        disease = row.get("disease") or {}
        # OTAR_ ids are Open Targets' own therapeutic-area buckets, not
        # disease-ontology terms, and canonical_from_compact rejects them.
        xref = canonical_from_compact(str(disease.get("id") or ""))
        if xref is None:
            continue
        score = row.get("score")
        add(
            "disease",
            xref,
            xref,
            str(disease.get("name") or "") or None,
            None,
            float(score) if score is not None else None,
        )

    return sorted(rows.values(), key=AnnotationRow.sort_key)


def _warn_on_version_drift(data_version: str | None, config: PipelineConfig) -> None:
    """Log once when the live data version is not the pinned one."""
    if data_version and data_version != config.opentargets_data_version:
        logger.warning(
            f"Open Targets data version is {data_version}, pinned at "
            f"{config.opentargets_data_version} -- review "
            "PIPELINE_OPENTARGETS_DATA_VERSION before trusting this run"
        )


async def _fetch_target_uncached(
    gene_symbol: str, config: PipelineConfig, data_version: str | None
) -> OpenTargetsTarget | None:
    """Internal: resolve, fetch and parse one gene without caching.

    ``data_version`` is passed in rather than fetched here: the meta query is
    one round trip per *sync*, not one per gene, and the drift warning is one
    line in the log rather than 63 identical ones.
    """
    resolution = await resolve_target(gene_symbol)
    if resolution is None:
        return None
    ensembl_id = resolution.ensembl_id
    if ensembl_id is None:
        logger.info(f"Open Targets has no target for {gene_symbol}")
        return OpenTargetsTarget(
            gene_symbol=gene_symbol,
            ensembl_id=None,
            rows=(),
            data_version=data_version,
        )

    data = await graphql(
        _TARGET_QUERY,
        {"id": ensembl_id, "diseases": config.opentargets_max_diseases},
    )
    if not data or not data.get("target"):
        return None

    return OpenTargetsTarget(
        gene_symbol=gene_symbol,
        ensembl_id=ensembl_id,
        rows=tuple(_parse_target(gene_symbol, data["target"], data_version)),
        data_version=data_version,
    )


async def fetch_opentargets_target(
    gene_symbol: str,
    config: PipelineConfig | None = None,
    data_version: object = _UNRESOLVED,
) -> OpenTargetsTarget | None:
    """Fetch one gene's identity, disease associations and GO terms.

    ``data_version`` is resolved here only when the caller has not already
    done so -- ``sync_opentargets_annotations`` fetches it once for the whole
    run and passes the result through, ``None`` included, and a single-gene
    probe can omit it.
    """
    resolved = config or PipelineConfig()
    if data_version is _UNRESOLVED:
        data_version = await fetch_data_version()
        _warn_on_version_drift(data_version, resolved)
    version = data_version if isinstance(data_version, str) else None
    return await single_flight_get(
        gene_symbol.upper(),
        cache=_target_cache,
        cache_lock=_get_cache_lock(),
        in_flight=_in_flight,
        semaphore=_get_opentargets_semaphore(resolved),
        fetch_fn=lambda: _fetch_target_uncached(gene_symbol, resolved, version),
        label="Open Targets cache",
    )


async def sync_opentargets_annotations(
    gene_symbols: list[str],
    config: PipelineConfig | None = None,
) -> SyncResult:
    """Sync Open Targets annotations for the given gene symbols."""
    from pipeline.database import get_annotation_statuses, replace_gene_annotations

    cached = await get_annotation_statuses(
        gene_symbols, SOURCE, max_age_days=DB_CACHE_TTL_DAYS
    )
    stale = [s for s in gene_symbols if s not in cached]
    # As in the ClinVar sync: a curated key that is not a gene symbol is
    # queried by the symbols it stands for -- see `expand_lookup_symbols`.
    to_fetch, curated_by_query = expand_lookup_symbols(stale)

    logger.info(f"Open Targets sync: {len(cached)} cached, {len(stale)} to fetch")

    if not to_fetch:
        return SyncResult(cached=len(cached))

    # One meta query for the run. Inside the per-gene fetch this would be 63
    # round trips and 63 copies of the same drift warning.
    resolved_config = config or PipelineConfig()
    data_version = await fetch_data_version()
    _warn_on_version_drift(data_version, resolved_config)

    results = await run_batched_fetch(
        to_fetch,
        lambda symbol: fetch_opentargets_target(
            symbol, config=resolved_config, data_version=data_version
        ),
        make_log_progress("Open Targets fetch"),
    )

    rows: list[AnnotationRow] = []
    errors: list[str] = []
    unresolved: list[str] = []
    # Per curated key, so one alias failing cannot let the other write the
    # status row that suppresses the retry -- see the ClinVar sync.
    row_counts: dict[str, int] = {}
    versions: dict[str, str | None] = {}
    failed_curated: set[str] = set()

    for symbol, target in zip(to_fetch, results, strict=True):
        curated = curated_by_query[symbol]
        if target is None:
            errors.append(f"Open Targets fetch failed: {symbol}")
            failed_curated.add(curated)
            continue
        rows.extend(
            replace(row, gene_symbol=curated) if row.gene_symbol != curated else row
            for row in target.rows
        )
        row_counts[curated] = row_counts.get(curated, 0) + len(target.rows)
        versions[curated] = target.data_version
        if target.ensembl_id is None:
            unresolved.append(symbol)

    statuses = [
        AnnotationStatus(
            gene_symbol=curated,
            source=SOURCE,
            row_count=count,
            source_version=versions.get(curated),
        )
        for curated, count in row_counts.items()
        if curated not in failed_curated
    ]
    written = {status.gene_symbol for status in statuses}
    rows = [row for row in rows if row.gene_symbol in written]

    if unresolved:
        logger.info(
            f"No Open Targets target for {len(unresolved)} symbols: "
            f"{', '.join(unresolved)}"
        )

    await replace_gene_annotations(rows, statuses)

    return SyncResult(
        fetched=len(statuses),
        cached=len(cached),
        failed=len(failed_curated),
        errors=errors,
    )
