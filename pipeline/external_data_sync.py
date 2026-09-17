"""External data synchronization orchestrator.

Coordinates fetching of NCBI, UniProt, and PubMed data for all genes
in the database, storing results for dashboard consumption.
"""

import asyncio
import logging
import re
from dataclasses import dataclass, field

from pipeline.clinvar_fetch import (
    clear_clinvar_cache,
    close_clinvar_client,
    sync_clinvar_annotations,
)
from pipeline.config import PipelineConfig
from pipeline.database import Database, fill_missing_chromosomal_locations
from pipeline.ncbi_gene_fetch import (
    clear_ncbi_cache,
    close_ncbi_client,
    sync_ncbi_gene_info,
)
from pipeline.opentargets_drugs import sync_trial_drug_annotations
from pipeline.opentargets_fetch import (
    clear_opentargets_cache,
    close_opentargets_client,
    sync_opentargets_annotations,
)
from pipeline.orphadata_fetch import (
    clear_orphadata_cache,
    close_orphadata_client,
    sync_orphadata_annotations,
)
from pipeline.pubmed_citations import (
    clear_pubmed_cache,
    close_pubmed_client,
    extract_pmids_from_text,
    sync_pubmed_citations,
)
from pipeline.uniprot_fetch import (
    clear_uniprot_cache,
    close_uniprot_client,
    sync_uniprot_info,
)

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ExternalDataSyncResult:
    """Combined result from all external data sync operations.

    ``aborted`` says the sync stopped rather than finished, which is the
    only thing that paints the refresh red -- see ``SyncResult``.
    """

    ncbi_fetched: int = 0
    ncbi_cached: int = 0
    ncbi_failed: int = 0
    uniprot_fetched: int = 0
    uniprot_cached: int = 0
    uniprot_failed: int = 0
    pubmed_fetched: int = 0
    pubmed_cached: int = 0
    pubmed_failed: int = 0
    errors: list[str] = field(default_factory=list)
    aborted: bool = False

    def summary(self) -> str:
        """Return human-readable summary."""
        return (
            f"NCBI: {self.ncbi_fetched} fetched, "
            f"{self.ncbi_cached} cached, "
            f"{self.ncbi_failed} failed\n"
            f"UniProt: {self.uniprot_fetched} fetched, "
            f"{self.uniprot_cached} cached, "
            f"{self.uniprot_failed} failed\n"
            f"PubMed: {self.pubmed_fetched} fetched, "
            f"{self.pubmed_cached} cached, "
            f"{self.pubmed_failed} failed"
        )


async def get_table1_gene_symbols() -> list[str]:
    """Get unique gene symbols from the genes table (Table 1)."""
    async with Database.connection() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT gene FROM genes WHERE gene IS NOT NULL"
        )
        return [row["gene"] for row in rows]


_GENE_SKIP_TOKENS: frozenset[str] = frozenset(
    {"", "NA", "N/A", "NONE", "NULL", "-", "--", "UNKNOWN"}
)
# HGNC-style: leading letter, alphanumerics + hyphens, between 2 and 30 chars.
# Single letters ("A", "I") are prose artefacts from split tokens, not gene
# symbols — letting them through pollutes the NCBI cache with spurious hits.
_GENE_SHAPE = re.compile(r"^[A-Za-z][A-Za-z0-9\-]{1,29}$")


async def get_table2_gene_symbols() -> list[str]:
    """Get unique gene symbols from the clinical_trials table (Table 2).

    The genetic_target column may contain comma/semicolon/slash-separated
    gene lists. Tokens that don't look like gene symbols are skipped to
    avoid polluting downstream NCBI lookups.
    """
    async with Database.connection() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT genetic_target "
            "FROM clinical_trials "
            "WHERE genetic_target IS NOT NULL"
        )

    all_genes: set[str] = set()
    for row in rows:
        target = row["genetic_target"]
        if not target:
            continue
        for raw in re.split(r"[,;/]", target):
            gene = raw.strip()
            if gene.upper() in _GENE_SKIP_TOKENS:
                continue
            if _GENE_SHAPE.fullmatch(gene):
                all_genes.add(gene)
            else:
                logger.debug(f"Skipping non-gene-shaped token: {gene!r}")

    return sorted(all_genes)


async def get_all_pmids() -> list[str]:
    """Every unique PMID the curated genes cite.

    Reads ``gene_references``, not ``genes."references"``: migration 006
    dropped that column once the join table carried the values, so the old
    query raised UndefinedColumnError inside ``sync_all_external_data``'s
    gather -- whose only handler is for TimeoutError -- and took NCBI, UniProt
    and PubMed sync down with it on any migrated database. The suite did not
    catch it because it mocks the connection.

    The values are one PMID per row rather than a delimited string now, so
    they need no parsing; they are still filtered, because a row reaching this
    table from an older backfill can carry anything.
    """
    async with Database.connection() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT pmid FROM gene_references WHERE pmid IS NOT NULL"
        )

    all_pmids: set[str] = set()
    for row in rows:
        pmid = row["pmid"]
        if pmid:
            all_pmids.update(extract_pmids_from_text(str(pmid)))

    return sorted(all_pmids)


_MAX_ERRORS_PER_SOURCE: int = 10


def _append_errors_truncated(target: list[str], source: list[str], label: str) -> None:
    """Append errors from source to target, truncating with a message."""
    target.extend(source[:_MAX_ERRORS_PER_SOURCE])
    if len(source) > _MAX_ERRORS_PER_SOURCE:
        suppressed = len(source) - _MAX_ERRORS_PER_SOURCE
        target.append(f"... and {suppressed} more {label} errors suppressed")


async def _sync_lookup_caches(
    result: ExternalDataSyncResult,
    *,
    ncbi_genes: list[str],
    uniprot_genes: list[str],
    pmids: list[str],
    config: PipelineConfig | None,
) -> None:
    """Fill the three lookup caches for the given keys, folding counts in.

    Shared by the scheduled whole-database sync and the per-run refresh, so
    the two cannot drift on which source is asked for what.
    """
    logger.info("Syncing NCBI gene info...")
    ncbi_result = await sync_ncbi_gene_info(ncbi_genes, config=config)
    result.ncbi_fetched = ncbi_result.fetched
    result.ncbi_cached = ncbi_result.cached
    result.ncbi_failed = ncbi_result.failed
    _append_errors_truncated(result.errors, ncbi_result.errors, "NCBI")

    # A gene a run inserted has no chromosomal band -- extraction is not asked
    # for one -- so it published as "(unknown)" and reached no chromosome of
    # the phenogram. NCBI states the band in the same esummary the step above
    # just read; this copies it into the rows that carry none, and never over
    # a curated one. It sits here rather than in the export because the column
    # is `genes`', and because both sync paths run through this function.
    filled = await fill_missing_chromosomal_locations()
    if filled:
        logger.info("Filled %d chromosomal location(s) from NCBI", filled)

    logger.info("Syncing UniProt info...")
    uniprot_result = await sync_uniprot_info(uniprot_genes, config=config)
    result.uniprot_fetched = uniprot_result.fetched
    result.uniprot_cached = uniprot_result.cached
    result.uniprot_failed = uniprot_result.failed
    _append_errors_truncated(result.errors, uniprot_result.errors, "UniProt")

    if pmids:
        logger.info("Syncing PubMed citations...")
        pubmed_result = await sync_pubmed_citations(pmids, config=config)
        result.pubmed_fetched = pubmed_result.fetched
        result.pubmed_cached = pubmed_result.cached
        result.pubmed_failed = pubmed_result.failed
        _append_errors_truncated(result.errors, pubmed_result.errors, "PubMed")
    else:
        logger.info("No PMIDs to sync")


async def _close_lookup_clients() -> None:
    """Close the three lookup-cache HTTP clients and drop their memo caches."""
    await close_ncbi_client()
    await close_uniprot_client()
    await close_pubmed_client()
    clear_ncbi_cache()
    clear_uniprot_cache()
    clear_pubmed_cache()


async def sync_external_data_for(
    gene_symbols: list[str],
    pmids: list[str],
    config: PipelineConfig | None = None,
) -> ExternalDataSyncResult:
    """Fill the three lookup caches for one run's own genes and PMIDs.

    `ncbi_gene_info`, `uniprot_info` and `pubmed_citations` have no writer
    inside a PubMed run -- only `--sync-external-data` fills them -- and
    `complete_lookup` turns a key it cannot find into a row of nulls rather
    than failing. So `--pubmed --export` published every gene the run had
    just inserted with a null NCBI uid, description and alias list, a null
    UniProt accession, and every PMID it had just attached as
    "PMID: n (citation not available)", until someone separately ran
    `--sync-external-data` and exported again.

    Only the run's own keys are asked for, and each source fetches only its
    own cache misses, so nothing already cached is re-fetched.

    Args:
        gene_symbols: The curated keys the merge stored, as
            ``genes.gene`` holds them.
        pmids: The PMIDs the run attached to those genes.
        config: Pipeline config (rate-limit semaphore sizing).
    """
    result = ExternalDataSyncResult()
    try:
        await _sync_lookup_caches(
            result,
            ncbi_genes=gene_symbols,
            uniprot_genes=gene_symbols,
            pmids=pmids,
            config=config,
        )
    finally:
        await _close_lookup_clients()
    logger.info(result.summary())
    return result


async def sync_all_external_data(
    config: PipelineConfig | None = None,
) -> ExternalDataSyncResult:
    """Sync external metadata sources for dashboard refresh.

    This function:
    1. Collects gene symbols from genes and clinical_trials tables
    2. Extracts PMIDs from genes.references column
    3. Syncs NCBI gene info for all genes
    4. Syncs UniProt info for Table 1 genes
    5. Syncs PubMed citations for all PMIDs

    Clinical trials discovery is handled by a separate pipeline
    (``run_clinical_trials_pipeline``); this function reads whatever rows
    the most recent CT sync wrote to the ``clinical_trials`` table.

    Args:
        config: Pipeline config (needed for rate-limit semaphore sizing).

    Returns:
        ExternalDataSyncResult with sync statistics.
    """
    result = ExternalDataSyncResult()

    try:
        async with asyncio.timeout(3600):
            # Step 1: Get gene symbols and PMIDs concurrently
            logger.info("Collecting gene symbols and PMIDs from database...")
            table1_genes, table2_genes, pmids = await asyncio.gather(
                get_table1_gene_symbols(),
                get_table2_gene_symbols(),
                get_all_pmids(),
            )
            all_genes = list(dict.fromkeys(table1_genes + table2_genes))  # Deduplicate

            logger.info(f"Found {len(table1_genes)} genes in Table 1")
            logger.info(f"Found {len(table2_genes)} genes in Table 2")
            logger.info(f"Total unique genes: {len(all_genes)}")
            logger.info(f"Found {len(pmids)} unique PMIDs")

            # Steps 2-4: NCBI for every gene, UniProt for Table 1 only,
            # PubMed for every cited PMID.
            await _sync_lookup_caches(
                result,
                ncbi_genes=all_genes,
                uniprot_genes=table1_genes,
                pmids=pmids,
                config=config,
            )

            logger.info("External data sync complete")
            logger.info(result.summary())

            return result

    except TimeoutError:
        logger.error("External data sync timed out after 1 hour")
        result.errors.append("Sync timed out after 3600s")
        # The sync stopped, so the refresh is red rather than amber: the
        # sources after the one that hung were never consulted at all.
        result.aborted = True
        return result

    finally:
        await _close_lookup_clients()


@dataclass(slots=True)
class AnnotationSyncResult:
    """Combined result from the four annotation sources.

    ``aborted`` says the sync stopped rather than finished, which is the
    only thing that paints the refresh red -- see ``SyncResult``.
    """

    clinvar_fetched: int = 0
    clinvar_cached: int = 0
    clinvar_failed: int = 0
    orphadata_fetched: int = 0
    orphadata_cached: int = 0
    orphadata_failed: int = 0
    opentargets_fetched: int = 0
    opentargets_cached: int = 0
    opentargets_failed: int = 0
    drugs_written: int = 0
    drugs_failed: int = 0
    errors: list[str] = field(default_factory=list)
    aborted: bool = False

    def summary(self) -> str:
        """Return human-readable summary."""
        return (
            f"ClinVar: {self.clinvar_fetched} fetched, "
            f"{self.clinvar_cached} cached, {self.clinvar_failed} failed\n"
            f"Orphadata: {self.orphadata_fetched} fetched, "
            f"{self.orphadata_cached} cached, {self.orphadata_failed} failed\n"
            f"Open Targets: {self.opentargets_fetched} fetched, "
            f"{self.opentargets_cached} cached, {self.opentargets_failed} failed\n"
            f"Trial drugs: {self.drugs_written} looked up, "
            f"{self.drugs_failed} failed"
        )


async def sync_all_annotations(
    config: PipelineConfig | None = None,
) -> AnnotationSyncResult:
    """Sync ClinVar, Orphadata and Open Targets annotations for Table 1 genes.

    ClinVar runs before Orphadata because Orphadata has no gene entry point --
    it is reached through the ORPHAcodes ClinVar returns. Open Targets and the
    drug sync are independent of both.

    None of this touches the curated ``genes`` row; every write lands in
    ``gene_annotations``, ``gene_annotation_status`` or
    ``trial_drug_annotations``.
    """
    result = AnnotationSyncResult()

    try:
        async with asyncio.timeout(3600):
            genes = await get_table1_gene_symbols()
            logger.info(f"Annotating {len(genes)} Table 1 genes")

            logger.info("Syncing ClinVar disease annotations...")
            clinvar = await sync_clinvar_annotations(genes, config=config)
            result.clinvar_fetched = clinvar.fetched
            result.clinvar_cached = clinvar.cached
            result.clinvar_failed = clinvar.failed
            _append_errors_truncated(result.errors, clinvar.errors, "ClinVar")

            # Must follow ClinVar: Orphadata is keyed by ORPHAcode and the
            # gene->disease direction is a 404.
            logger.info("Syncing Orphadata enrichment...")
            orphadata = await sync_orphadata_annotations(genes, config=config)
            result.orphadata_fetched = orphadata.fetched
            result.orphadata_cached = orphadata.cached
            result.orphadata_failed = orphadata.failed
            _append_errors_truncated(result.errors, orphadata.errors, "Orphadata")

            logger.info("Syncing Open Targets annotations...")
            opentargets = await sync_opentargets_annotations(genes, config=config)
            result.opentargets_fetched = opentargets.fetched
            result.opentargets_cached = opentargets.cached
            result.opentargets_failed = opentargets.failed
            _append_errors_truncated(
                result.errors, opentargets.errors, "Open Targets"
            )

            logger.info("Verifying trial drug mechanisms...")
            drugs = await sync_trial_drug_annotations(config=config)
            result.drugs_written = drugs.fetched
            result.drugs_failed = drugs.failed
            _append_errors_truncated(result.errors, drugs.errors, "drug")

            logger.info("Annotation sync complete")
            logger.info(result.summary())
            return result

    except TimeoutError:
        logger.error("Annotation sync timed out after 1 hour")
        result.errors.append("Annotation sync timed out after 3600s")
        result.aborted = True
        return result

    finally:
        await close_clinvar_client()
        await close_orphadata_client()
        await close_opentargets_client()
        clear_clinvar_cache()
        clear_orphadata_cache()
        clear_opentargets_cache()
