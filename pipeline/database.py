"""Async PostgreSQL database operations for the SVD pipeline.

Provides connection pooling, batch operations, and safe SQL execution.
"""

import asyncio
import json
import logging
import os
from collections.abc import AsyncGenerator, Callable, Iterable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, ClassVar, Final, cast

import asyncpg

from pipeline.annotations import AnnotationRow
from pipeline.config import PipelineConfig

logger = logging.getLogger(__name__)


class DatabaseConfigError(Exception):
    """Raised when database configuration is invalid."""


class Database:
    """Async database connection pool manager using singleton pattern."""

    __slots__ = ()
    _pool: asyncpg.Pool | None = None
    _config: PipelineConfig | None = None
    _pool_lock: ClassVar[asyncio.Lock] = asyncio.Lock()

    @classmethod
    def set_config(cls, config: PipelineConfig) -> None:
        """Set the pipeline config for pool sizing parameters."""
        cls._config = config

    @classmethod
    async def get_pool(cls) -> asyncpg.Pool:
        """Get or create the database connection pool.

        Returns:
            The shared asyncpg connection pool.

        Raises:
            DatabaseConfigError: If required environment variables are missing.
            asyncpg.PostgresError: If connection fails.
        """
        if cls._pool is not None:
            return cls._pool
        async with cls._pool_lock:
            if cls._pool is None:
                db_host = os.getenv("DB_HOST")
                db_name = os.getenv("DB_NAME")
                db_user = os.getenv("DB_USER")
                db_password = os.getenv("DB_PASSWORD")
                db_port_raw = os.getenv("DB_PORT", "5432")
                try:
                    db_port = int(db_port_raw)
                except ValueError:
                    raise DatabaseConfigError(
                        f"DB_PORT must be an integer, got {db_port_raw!r}"
                    ) from None

                # Validate required config
                required = {
                    "DB_HOST": db_host,
                    "DB_NAME": db_name,
                    "DB_USER": db_user,
                    "DB_PASSWORD": db_password,
                }
                missing = [name for name, value in required.items() if not value]
                if missing:
                    raise DatabaseConfigError(
                        f"Missing required database environment variables: {missing}"
                    )

                cfg = cls._config or PipelineConfig()

                cls._pool = await asyncpg.create_pool(
                    host=db_host,
                    port=db_port,
                    user=db_user,
                    password=db_password,
                    database=db_name,
                    min_size=cfg.db_pool_min_size,
                    max_size=cfg.db_pool_max_size,
                    command_timeout=cfg.db_command_timeout,
                )
        return cls._pool

    @classmethod
    async def close(cls) -> None:
        """Close the connection pool."""
        if cls._pool is not None:
            await cls._pool.close()
            cls._pool = None

    @classmethod
    @asynccontextmanager
    async def connection(cls) -> AsyncGenerator[asyncpg.Connection]:
        """Acquire a connection from the pool with automatic release.

        Yields:
            An asyncpg connection that is automatically released on exit.
        """
        pool = await cls.get_pool()
        async with pool.acquire() as conn:
            # asyncpg's proxy exposes the Connection API but its inline types do
            # not model that structural relationship.
            yield cast(asyncpg.Connection, conn)


async def get_existing_genes() -> set[str]:
    """Fetch all gene symbols currently in the database.

    Returns:
        Set of uppercase gene symbols.
    """
    async with Database.connection() as conn:
        rows = await conn.fetch("SELECT UPPER(gene) as gene FROM genes")
        return {row["gene"] for row in rows}


async def get_existing_pmids() -> set[str]:
    """Fetch all PMIDs already processed.

    Returns:
        Set of PMID strings.
    """
    async with Database.connection() as conn:
        rows = await conn.fetch("SELECT pmid FROM pubmed_refs")
        return {row["pmid"] for row in rows}


async def reset_gene_sequence() -> None:
    """Reset the genes table sequence to avoid primary key conflicts."""
    async with Database.connection() as conn:
        await conn.execute("""
            SELECT setval('genes_id_seq', COALESCE(
                (SELECT MAX(id) FROM genes), 0
            ) + 1, false)
        """)


async def _execute_many(statement: str, records: list[tuple[Any, ...]]) -> int:
    """Execute a plain batch write, preserving the empty-input short circuit."""
    if not records:
        return 0
    async with Database.connection() as conn:
        await conn.executemany(statement, records)
    return len(records)


# (join table, value column, the key _build_combined_gene_data supplies).
# gene_monogenic_links is absent by design: the extraction never produces
# OMIM links, so nothing here would write it.
_GENE_LIST_APPENDS: Final[tuple[tuple[str, str, str], ...]] = (
    ("gene_references", "pmid", "references"),
    ("gene_gwas_traits", "trait", "gwas_trait"),
)


def _append_gene_list_sql(table: str, column: str) -> str:
    """Append a gene's new list values, preserving order and deduping.

    Three properties, each one an invariant the delimited columns carried.
    tests/pipeline/test_database.py pins their *spelling* against the
    statement asyncpg is handed; what PostgreSQL computes from it is
    pinned by the round-trip tests in
    tests/pipeline/test_database_integration.py, which merge the same gene
    twice against a real database:

    * **Idempotent.** NOT EXISTS drops any value the gene already has, so
      re-running a batch writes nothing. This is the string invariant
      "append iff the new PMID isn't already present", restated as a row.
    * **Ordinals continue.** MAX(ordinal) + 1 reads the pre-statement
      snapshot -- an INSERT ... SELECT never sees its own rows -- so every
      row of one batch offsets from the same base and ROW_NUMBER keeps them
      contiguous.
    * **First occurrence wins.** GROUP BY with MIN(ord) collapses duplicates
      inside the incoming array onto their earliest position, which is what
      string_agg(val, ', ' ORDER BY first_ord) did.

    Matching on UPPER(gene) is the UPDATE's rule, so the insert path's
    ON CONFLICT and the update path land on the same row. Both names come
    from _GENE_LIST_APPENDS, never from input.
    """
    return f"""
        INSERT INTO {table} (gene_id, ordinal, {column})
        SELECT
            g.id,
            COALESCE(
                (SELECT MAX(t.ordinal) + 1 FROM {table} t WHERE t.gene_id = g.id),
                0
            ) + ROW_NUMBER() OVER (ORDER BY incoming.first_ord) - 1,
            incoming.val
        FROM genes g
        CROSS JOIN (
            SELECT btrim(value) AS val, MIN(ord) AS first_ord
            FROM unnest($2::text[]) WITH ORDINALITY AS raw(value, ord)
            WHERE btrim(value) <> ''
            GROUP BY btrim(value)
        ) incoming
        WHERE UPPER(g.gene) = UPPER($1)
          AND NOT EXISTS (
              SELECT 1 FROM {table} existing
              WHERE existing.gene_id = g.id
                AND existing.{column} = incoming.val
          )
    """


async def merge_genes_transactional(
    to_insert: list[dict[str, Any]],
    to_update: list[dict[str, Any]],
) -> tuple[int, int]:
    """Atomically insert and update genes in a single transaction.

    If any operation fails, the entire batch is rolled back, preventing
    inconsistent state from partial writes.

    Args:
        to_insert: List of gene data dictionaries to insert.
        to_update: List of gene data dictionaries to update.

    Returns:
        Tuple of (inserted_count, updated_count).
    """
    if not to_insert and not to_update:
        return 0, 0

    async with Database.connection() as conn, conn.transaction():
        if to_insert:
            await conn.executemany(
                """
                    INSERT INTO genes (
                        protein, gene, chromosomal_location,
                        mendelian_randomization, evidence_from_other_omics_studies,
                        brain_cell_types, affected_pathway, source_quote, confidence
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (gene) DO UPDATE SET
                        protein = CASE
                            WHEN genes.protein IS NULL
                              OR genes.protein = ''
                              OR genes.protein = genes.gene
                            THEN COALESCE(NULLIF(EXCLUDED.protein, ''), genes.protein)
                            ELSE genes.protein
                        END,
                        mendelian_randomization =
                            COALESCE(genes.mendelian_randomization, FALSE)
                            OR COALESCE(EXCLUDED.mendelian_randomization, FALSE),
                        evidence_from_other_omics_studies =
                            (
                                SELECT COALESCE(
                                    string_agg(val, ';' ORDER BY first_ord), ''
                                )
                                FROM (
                                    SELECT val, MIN(ord) AS first_ord
                                    FROM (
                                        SELECT btrim(value) AS val, ord
                                        FROM unnest(
                                            string_to_array(
                                                COALESCE(
                                                    genes.evidence_from_other_omics_studies,
                                                    ''
                                                ),
                                                ';'
                                            )
                                        ) WITH ORDINALITY AS t(value, ord)
                                        UNION ALL
                                        SELECT btrim(value) AS val, ord + 100000
                                        FROM unnest(
                                            string_to_array(
                                                COALESCE(
                                                    EXCLUDED.evidence_from_other_omics_studies,
                                                    ''
                                                ),
                                                ';'
                                            )
                                        ) WITH ORDINALITY AS t(value, ord)
                                    ) raw
                                    WHERE val <> ''
                                    GROUP BY val
                                ) dedup
                        ),
                        -- The pair is written together or not at all: a
                        -- confidence scores the sentence beside it, so it
                        -- may only arrive with that sentence.
                        source_quote = CASE
                            WHEN NULLIF(genes.source_quote, '') IS NULL
                              AND NULLIF(EXCLUDED.source_quote, '') IS NOT NULL
                            THEN EXCLUDED.source_quote
                            ELSE genes.source_quote
                        END,
                        confidence = CASE
                            WHEN NULLIF(genes.source_quote, '') IS NULL
                              AND NULLIF(EXCLUDED.source_quote, '') IS NOT NULL
                            THEN EXCLUDED.confidence
                            ELSE genes.confidence
                        END,
                        updated_at = CURRENT_TIMESTAMP
                    """,
                [
                    (
                        g.get("protein"),
                        g.get("gene"),
                        g.get("chromosomal_location"),
                        g.get("mendelian_randomization"),
                        g.get("evidence_from_other_omics_studies"),
                        g.get("brain_cell_types"),
                        g.get("affected_pathway"),
                        g.get("source_quote"),
                        g.get("confidence"),
                    )
                    for g in to_insert
                ],
            )
        if to_update:
            await conn.executemany(
                """
                    UPDATE genes SET
                        protein = CASE
                            WHEN protein IS NULL OR protein = '' OR protein = gene
                            THEN COALESCE(NULLIF($1::text, ''), protein)
                            ELSE protein
                        END,
                        mendelian_randomization =
                            COALESCE(mendelian_randomization, FALSE)
                            OR COALESCE($2::boolean, FALSE),
                        evidence_from_other_omics_studies = (
                            SELECT COALESCE(string_agg(val, ';' ORDER BY first_ord), '')
                            FROM (
                                SELECT val, MIN(ord) AS first_ord
                                FROM (
                                    SELECT btrim(value) AS val, ord
                                    FROM unnest(
                                        string_to_array(
                                            COALESCE(
                                                evidence_from_other_omics_studies,
                                                ''
                                            ),
                                            ';'
                                        )
                                    ) WITH ORDINALITY AS t(value, ord)
                                    UNION ALL
                                    SELECT btrim(value) AS val, ord + 100000
                                    FROM unnest(
                                        string_to_array(COALESCE($3::text, ''), ';')
                                    ) WITH ORDINALITY AS t(value, ord)
                                ) raw
                                WHERE val <> ''
                                GROUP BY val
                            ) dedup
                        ),
                        -- As in the ON CONFLICT branch above: the quote and
                        -- the score that describes it are one fact, so a
                        -- row that already carries a quote keeps both.
                        source_quote = CASE
                            WHEN NULLIF(source_quote, '') IS NULL
                              AND NULLIF($4::text, '') IS NOT NULL
                            THEN $4::text
                            ELSE source_quote
                        END,
                        confidence = CASE
                            WHEN NULLIF(source_quote, '') IS NULL
                              AND NULLIF($4::text, '') IS NOT NULL
                            THEN $5::double precision
                            ELSE confidence
                        END,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE UPPER(gene) = UPPER($6)
                    """,
                [
                    (
                        g.get("protein"),
                        g.get("mendelian_randomization"),
                        g.get("evidence_from_other_omics_studies"),
                        g.get("source_quote"),
                        g.get("confidence"),
                        g.get("gene"),
                    )
                    for g in to_update
                ],
            )

        # Appended after both statements above, so a gene inserted in this
        # same transaction already has its id.
        merged_genes = [*to_insert, *to_update]
        for table, column, key in _GENE_LIST_APPENDS:
            await conn.executemany(
                _append_gene_list_sql(table, column),
                [(gene.get("gene"), gene.get(key) or []) for gene in merged_genes],
            )

    return len(to_insert), len(to_update)


async def record_processed_pmids_batch(
    records: list[tuple[str, bool, str, int]],
) -> int:
    """Batch record processed PMIDs to avoid reprocessing.

    Args:
        records: List of (pmid, fulltext_available, source, genes_extracted) tuples.

    Returns:
        Number of PMIDs recorded.
    """
    if not records:
        return 0

    async with Database.connection() as conn, conn.transaction():
        await conn.executemany(
            """
            INSERT INTO pubmed_refs (
                pmid, fulltext_available, source, genes_extracted
            ) VALUES ($1, $2, $3, $4)
            ON CONFLICT (pmid) DO UPDATE SET
                fulltext_available = EXCLUDED.fulltext_available,
                source = EXCLUDED.source,
                genes_extracted = EXCLUDED.genes_extracted,
                processed_at = CURRENT_TIMESTAMP
            """,
            records,
        )
    return len(records)


# =============================================================================
# Pipeline Run Tracking
# =============================================================================


async def record_pipeline_run(
    run_timestamp: str | datetime,
    papers_processed: int,
    fulltext_retrieved: int,
    genes_extracted: int,
    genes_validated: int,
    run_mode: str = "standard",
    status: str | None = None,
    duration_seconds: float | None = None,
    report: dict[str, Any] | None = None,
    on_committed: Callable[[], None] | None = None,
) -> int:
    """Record a pipeline run's summary statistics.

    Args:
        run_timestamp: When the run happened, as a datetime or an
            ISO-format string. asyncpg binds parameters by Python type and
            will not coerce a string into a TIMESTAMP column -- unlike
            psycopg2, which accepts the ISO text -- so a string is converted
            here, at the database boundary, rather than at each call site.
        papers_processed: Number of papers successfully processed.
        fulltext_retrieved: Number of papers with full text.
        genes_extracted: Total genes extracted by LLM.
        genes_validated: Genes passing validation.
        run_mode: One of ``pipeline.steps.RUN_MODES``. Only 'standard' is
            written today: the two offline modes publish no data, so
            recording one would point the About page's "up-to-date as of"
            date at a run that changed nothing.
        status: 'completed', 'completed_with_warnings' or 'failed'.
        duration_seconds: Wall-clock time for the whole run.
        report: The `PipelineRunReport` document the dashboard publishes.
            Serialised here rather than by the caller: asyncpg binds a
            JSON column from text, not from a dict, so passing one
            straight through fails at the driver with a type error that
            names neither this column nor the caller.
        on_committed: Called the instant the INSERT returns, with the
            connection still held. The statement runs outside an explicit
            transaction, so it is durable at that point, but releasing the
            pooled connection is a further await -- and a SIGTERM landing
            there used to leave the caller believing the row had not been
            written, so `_record_failed_run` added a second, `failed` row
            for a run whose every write had succeeded. Anything after this
            call must not be trusted to run.

    Returns:
        The id of the inserted row.
    """
    async with Database.connection() as conn:
        row_id = await conn.fetchval(
            """
            INSERT INTO pipeline_runs (
                run_timestamp, papers_processed, fulltext_retrieved,
                genes_extracted, genes_validated, run_mode,
                status, duration_seconds, report
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
            """,
            run_timestamp
            if isinstance(run_timestamp, datetime)
            else datetime.fromisoformat(run_timestamp),
            papers_processed,
            fulltext_retrieved,
            genes_extracted,
            genes_validated,
            run_mode,
            status,
            duration_seconds,
            None if report is None else json.dumps(report),
        )
        if on_committed is not None:
            on_committed()
    if not isinstance(row_id, int):
        raise RuntimeError("Database did not return an integer pipeline run id")
    logger.info("Recorded pipeline run id=%d (mode=%s)", row_id, run_mode)
    return row_id


async def record_sync_run(
    mode: str,
    run_timestamp: str | datetime,
    status: str,
    duration_seconds: float,
    report: dict[str, Any],
) -> int:
    """Record one reference-data refresh.

    Deliberately not a `pipeline_runs` row: a sync has no papers, genes or
    steps, and `read_pipeline_status` dates the whole dashboard from that
    table's newest row. See `pipeline/alembic/versions/011_add_sync_runs.py`.

    Args:
        mode: One of ``pipeline.steps.SYNC_MODES``.
        run_timestamp: When the sync started, as a datetime or an
            ISO-format string. Converted here for the reason
            ``record_pipeline_run`` converts: asyncpg binds by Python type
            and will not coerce a string into a TIMESTAMP column.
        status: 'completed', 'completed_with_warnings' or 'failed'.
        duration_seconds: Wall-clock time for the sync.
        report: The ``SyncRunReport`` document the dashboard publishes.
            Serialised here rather than by the caller, again as
            ``record_pipeline_run`` does: asyncpg binds a JSON column from
            text, not from a dict.

    Returns:
        The id of the inserted row.
    """
    async with Database.connection() as conn:
        row_id = await conn.fetchval(
            """
            INSERT INTO sync_runs (
                mode, run_timestamp, status, duration_seconds, report
            ) VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            """,
            mode,
            run_timestamp
            if isinstance(run_timestamp, datetime)
            else datetime.fromisoformat(run_timestamp),
            status,
            duration_seconds,
            json.dumps(report),
        )
    if not isinstance(row_id, int):
        raise RuntimeError("Database did not return an integer sync run id")
    logger.info("Recorded sync run id=%d (mode=%s)", row_id, mode)
    return row_id


# =============================================================================
# NCBI Gene Info Cache Operations
# =============================================================================


def _rows_by_key(
    rows: Iterable[Mapping[str, Any]],
    key: str,
    fields: tuple[str, ...],
) -> dict[str, dict[str, Any]]:
    """Index selected database columns without leaking the key into each value."""
    return {
        cast(str, row[key]): {field: row[field] for field in fields} for row in rows
    }


async def get_cached_ncbi_genes(
    gene_symbols: list[str],
    max_age_days: int | None = None,
) -> dict[str, dict[str, Any]]:
    """Get cached NCBI gene info for given symbols.

    Args:
        gene_symbols: List of gene symbols to look up.
        max_age_days: If set, only return rows updated within this many days;
            older rows are treated as stale and re-fetched by the caller.

    Returns:
        Dict mapping gene_symbol -> {ncbi_uid, description, aliases}.

    A row whose ``map_location`` is NULL is withheld the same way a stale one
    is. NULL means the row was written before migration 012 added the column,
    so it is not a complete answer -- and because a cache hit skips the fetch,
    those rows would never acquire a band and the genes they cover would stay
    unplaceable on the phenogram forever. The first live sync after the
    migration filled 3 of 16 for exactly that reason. An empty string is a
    complete answer (NCBI states no band for that gene) and stays cached, so
    this heals each row once rather than re-fetching it every run.
    """
    if not gene_symbols:
        return {}

    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol, ncbi_uid, description, aliases
            FROM ncbi_gene_info
            WHERE gene_symbol = ANY($1::text[])
              AND map_location IS NOT NULL
              AND ($2::int IS NULL
                   OR updated_at > NOW() - make_interval(days => $2::int))
            """,
            gene_symbols,
            max_age_days,
        )
        return _rows_by_key(
            rows,
            "gene_symbol",
            ("ncbi_uid", "description", "aliases"),
        )


async def upsert_ncbi_genes_batch(genes: list[Any]) -> int:
    """Batch upsert NCBI gene info.

    Args:
        genes: List of NCBIGeneInfo objects.

    Returns:
        Number of genes upserted.
    """
    return await _execute_many(
        """
        INSERT INTO ncbi_gene_info
            (gene_symbol, ncbi_uid, description, aliases, map_location)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (gene_symbol) DO UPDATE SET
            ncbi_uid = EXCLUDED.ncbi_uid,
            description = EXCLUDED.description,
            aliases = EXCLUDED.aliases,
            map_location = EXCLUDED.map_location,
            updated_at = CURRENT_TIMESTAMP
        """,
        [
            (
                gene.gene_symbol,
                gene.ncbi_uid,
                gene.description,
                gene.aliases,
                gene.map_location,
            )
            for gene in genes
        ],
    )


async def fill_missing_chromosomal_locations() -> int:
    """Copy NCBI's band into `genes` for rows that carry none.

    **Only where the column is empty.** The curated rows' locations came from
    the source spreadsheet and are the published spelling; NCBI is the filler
    for genes a run inserted, which arrive with nothing in the column because
    extraction is not asked for a band and no other source carried one. That
    is the `sponsor_type` polarity -- an existing value always wins -- and the
    reason this is not a curation write: it fills a gap rather than revising a
    judgement.

    Matching is on `upper(gene)`, the index migration 002 added, because the
    sync fetched each symbol under the spelling `genes.gene` holds. A curated
    row like "COL4A1/2" names two genes and matches no NCBI symbol; it already
    has a location, so the empty-only guard excludes it before that matters.

    Returns:
        The number of rows filled.
    """
    async with Database.connection() as conn:
        result = await conn.execute(
            """
            UPDATE genes g
            SET chromosomal_location = n.map_location,
                updated_at = CURRENT_TIMESTAMP
            FROM ncbi_gene_info n
            WHERE upper(n.gene_symbol) = upper(g.gene)
              AND coalesce(btrim(g.chromosomal_location), '') = ''
              AND coalesce(btrim(n.map_location), '') <> ''
            """
        )
    # asyncpg returns the tag, e.g. "UPDATE 16".
    return int(result.split()[-1]) if result else 0


# =============================================================================
# UniProt Info Cache Operations
# =============================================================================


async def get_cached_uniprot_info(
    gene_symbols: list[str],
    max_age_days: int | None = None,
) -> dict[str, dict[str, Any]]:
    """Get cached UniProt info for given gene symbols.

    Args:
        gene_symbols: List of gene symbols to look up.
        max_age_days: If set, only return rows updated within this many days;
            older rows are treated as stale and re-fetched by the caller.

    Returns:
        Dict mapping gene_symbol -> UniProt info dict.
    """
    if not gene_symbols:
        return {}

    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol, accession, protein_name,
                   biological_process, molecular_function, cellular_component, url
            FROM uniprot_info
            WHERE gene_symbol = ANY($1::text[])
              AND ($2::int IS NULL
                   OR updated_at > NOW() - make_interval(days => $2::int))
            """,
            gene_symbols,
            max_age_days,
        )
        return _rows_by_key(
            rows,
            "gene_symbol",
            (
                "accession",
                "protein_name",
                "biological_process",
                "molecular_function",
                "cellular_component",
                "url",
            ),
        )


async def upsert_uniprot_batch(infos: list[Any]) -> int:
    """Batch upsert UniProt info.

    Args:
        infos: List of UniProtInfo objects.

    Returns:
        Number of entries upserted.
    """
    return await _execute_many(
        """
        INSERT INTO uniprot_info (
            gene_symbol, accession, protein_name,
            biological_process, molecular_function, cellular_component, url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (gene_symbol) DO UPDATE SET
            accession = EXCLUDED.accession,
            protein_name = EXCLUDED.protein_name,
            biological_process = EXCLUDED.biological_process,
            molecular_function = EXCLUDED.molecular_function,
            cellular_component = EXCLUDED.cellular_component,
            url = EXCLUDED.url,
            updated_at = CURRENT_TIMESTAMP
        """,
        [
            (
                info.gene_symbol,
                info.accession,
                info.protein_name,
                info.biological_process,
                info.molecular_function,
                info.cellular_component,
                info.url,
            )
            for info in infos
        ],
    )


# =============================================================================
# PubMed Citations Cache Operations
# =============================================================================


async def get_cached_pubmed_citations(pmids: list[str]) -> dict[str, dict[str, Any]]:
    """Get cached PubMed citations for given PMIDs.

    Args:
        pmids: List of PubMed IDs to look up.

    Returns:
        Dict mapping pmid -> citation info dict.
    """
    if not pmids:
        return {}

    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT pmid, authors, title, journal, publication_date, doi, formatted_ref
            FROM pubmed_citations
            WHERE pmid = ANY($1::text[])
            """,
            pmids,
        )
        return _rows_by_key(
            rows,
            "pmid",
            (
                "authors",
                "title",
                "journal",
                "publication_date",
                "doi",
                "formatted_ref",
            ),
        )


async def upsert_pubmed_citations_batch(citations: list[Any]) -> int:
    """Batch upsert PubMed citations.

    Args:
        citations: List of PubMedCitation objects.

    Returns:
        Number of citations upserted.
    """
    return await _execute_many(
        """
        INSERT INTO pubmed_citations (
            pmid, authors, title, journal, publication_date, doi, formatted_ref
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (pmid) DO UPDATE SET
            authors = EXCLUDED.authors,
            title = EXCLUDED.title,
            journal = EXCLUDED.journal,
            publication_date = EXCLUDED.publication_date,
            doi = EXCLUDED.doi,
            formatted_ref = EXCLUDED.formatted_ref,
            updated_at = CURRENT_TIMESTAMP
        """,
        [
            (
                citation.pmid,
                citation.authors,
                citation.title,
                citation.journal,
                citation.publication_date,
                citation.doi,
                citation.formatted_ref,
            )
            for citation in citations
        ],
    )


# =============================================================================
# Gene Annotation Operations
# =============================================================================


async def get_annotation_statuses(
    gene_symbols: list[str],
    source: str,
    max_age_days: int | None = None,
) -> dict[str, dict[str, Any]]:
    """Get fetch status for given symbols from one annotation source.

    Args:
        gene_symbols: List of gene symbols to look up.
        source: Annotation source key ("clinvar", "orphadata", "opentargets").
        max_age_days: If set, only return rows updated within this many days;
            older rows are treated as stale and re-fetched by the caller.

    Returns:
        Dict mapping gene_symbol -> {row_count, source_version, updated_at}. A
        gene that was fetched and yielded nothing is present with row_count 0;
        that is the negative cache. ``updated_at`` is what lets one source
        compare its own freshness with another's -- Orphadata's rows are keyed
        on ClinVar's ORPHAcodes, so a newer ClinVar status invalidates them.
    """
    if not gene_symbols:
        return {}

    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol, row_count, source_version, updated_at
            FROM gene_annotation_status
            WHERE gene_symbol = ANY($1::text[])
              AND source = $2
              AND ($3::int IS NULL
                   OR updated_at > NOW() - make_interval(days => $3::int))
            """,
            gene_symbols,
            source,
            max_age_days,
        )
        return _rows_by_key(
            rows,
            "gene_symbol",
            ("row_count", "source_version", "updated_at"),
        )


async def replace_gene_annotations(
    rows: list[Any],
    statuses: list[Any],
) -> int:
    """Replace one source's annotations for the genes named in *statuses*.

    Delete-then-insert rather than upsert, inside one transaction: a re-fetch
    that returns fewer diseases than last time must not leave the dropped ones
    behind. The delete is scoped to (gene_symbol, source) pairs that were
    actually fetched, so one source never disturbs another's rows.

    Args:
        rows: List of AnnotationRow objects.
        statuses: List of AnnotationStatus objects, one per fetched gene.

    Returns:
        Number of annotation rows written.
    """
    if not statuses:
        return 0

    ordered = sorted(rows, key=lambda r: AnnotationRow.sort_key(r))

    async with Database.connection() as conn, conn.transaction():
        await conn.executemany(
            "DELETE FROM gene_annotations WHERE gene_symbol = $1 AND source = $2",
            [(s.gene_symbol, s.source) for s in statuses],
        )
        if ordered:
            await conn.executemany(
                """
                INSERT INTO gene_annotations (
                    gene_symbol, source, relation, group_key, object_id,
                    object_label, qualifier, score, evidence_count, source_version
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (gene_symbol, source, relation, group_key, object_id)
                DO UPDATE SET
                    object_label = EXCLUDED.object_label,
                    qualifier = EXCLUDED.qualifier,
                    score = EXCLUDED.score,
                    evidence_count = EXCLUDED.evidence_count,
                    source_version = EXCLUDED.source_version,
                    updated_at = CURRENT_TIMESTAMP
                """,
                [
                    (
                        r.gene_symbol,
                        r.source,
                        r.relation,
                        r.group_key,
                        r.object_id,
                        r.object_label,
                        r.qualifier,
                        r.score,
                        r.evidence_count,
                        r.source_version,
                    )
                    for r in ordered
                ],
            )
        await conn.executemany(
            """
            INSERT INTO gene_annotation_status (
                gene_symbol, source, row_count, source_version
            ) VALUES ($1, $2, $3, $4)
            ON CONFLICT (gene_symbol, source) DO UPDATE SET
                row_count = EXCLUDED.row_count,
                source_version = EXCLUDED.source_version,
                updated_at = CURRENT_TIMESTAMP
            """,
            [
                (s.gene_symbol, s.source, s.row_count, s.source_version)
                for s in statuses
            ],
        )
    return len(ordered)


async def read_gene_annotations(source: str | None = None) -> list[dict[str, Any]]:
    """Read annotation rows for export, in a deterministic order.

    The ORDER BY is load-bearing: the export's byte-exact contract cannot hold
    across runs if PostgreSQL is free to choose a physical order.
    """
    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol, source, relation, group_key, object_id,
                   object_label, qualifier, score, evidence_count, source_version
            FROM gene_annotations
            WHERE ($1::text IS NULL OR source = $1)
            ORDER BY gene_symbol, source, relation, group_key, object_id
            """,
            source,
        )
        return [dict(row) for row in rows]


async def upsert_drug_annotations(rows: list[Any]) -> int:
    """Batch upsert trial drug mechanisms.

    Args:
        rows: List of DrugAnnotationRow objects.

    Returns:
        Number of drugs upserted.
    """
    return await _execute_many(
        """
        INSERT INTO trial_drug_annotations (
            drug, chembl_id, action_type, mechanism_of_action,
            target_symbols, source_version, resolved
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (drug) DO UPDATE SET
            chembl_id = EXCLUDED.chembl_id,
            action_type = EXCLUDED.action_type,
            mechanism_of_action = EXCLUDED.mechanism_of_action,
            target_symbols = EXCLUDED.target_symbols,
            source_version = EXCLUDED.source_version,
            resolved = EXCLUDED.resolved,
            updated_at = CURRENT_TIMESTAMP
        """,
        [
            (
                row.drug,
                row.chembl_id,
                row.action_type,
                row.mechanism_of_action,
                row.target_symbols,
                row.source_version,
                row.resolved,
            )
            for row in rows
        ],
    )


# =============================================================================
# Clinical Trials Operations (ClinicalTrials.gov sync)
# =============================================================================


@dataclass(frozen=True, slots=True)
class TrialUpsertResult:
    """What one ClinicalTrials.gov batch did to the curated table.

    ``refreshed`` and ``discovered`` are both row counts, and they are
    counted separately because they are different events: the first is the
    registry refreshing rows a curator wrote, the second is a trial the
    curated table has never held, which stays unpublished until someone
    curates it (see the export's curation gate).

    ``curated_ids`` names the registry ids that already carry an
    ``svd_population``. A discovery is an insert on the run that finds it
    and a refresh on every run after, so refresh status does not imply
    curation.
    """

    refreshed: int = 0
    discovered: int = 0
    curated_ids: frozenset[str] = frozenset()

    @property
    def written(self) -> int:
        """Rows the batch wrote, refreshed and discovered together."""
        return self.refreshed + self.discovered


# A completion date the curator wrote that is not a month and year is not a
# date at all -- "Completed (unpublished)" is the one in the committed data,
# and clean_trial_row matches it literally. CT.gov has no way to express it,
# so a refresh that overwrote it would delete a curated fact and publish an
# already-finished trial's real end date as a forecast.
_CURATED_MONTH_YEAR: Final[str] = r"^[0-9]{1,2}/[0-9]{4}$"

# Refresh, not replace: every API column keeps its existing value when
# CT.gov has none. The sync exists to move these columns forward, and a
# field the registry stopped stating is not a reason to erase what the
# curated row already says.
_REFRESH_TRIAL_SQL: Final[str] = f"""
    UPDATE clinical_trials SET
        trial_name = CASE
            WHEN clinical_trials.svd_population IS NOT NULL
            THEN clinical_trials.trial_name
            ELSE COALESCE($1, clinical_trials.trial_name)
        END,
        clinical_trial_phase = COALESCE($2, clinical_trials.clinical_trial_phase),
        target_sample_size = COALESCE($3, clinical_trials.target_sample_size),
        estimated_completion_date = CASE
            WHEN clinical_trials.estimated_completion_date IS NOT NULL
             AND clinical_trials.estimated_completion_date !~ '{_CURATED_MONTH_YEAR}'
            THEN clinical_trials.estimated_completion_date
            ELSE COALESCE($4, clinical_trials.estimated_completion_date)
        END,
        primary_outcome = CASE
            WHEN clinical_trials.svd_population IS NOT NULL
            THEN clinical_trials.primary_outcome
            ELSE COALESCE($5, clinical_trials.primary_outcome)
        END,
        sponsor_type = COALESCE(clinical_trials.sponsor_type, $6),
        overall_status = COALESCE($7, clinical_trials.overall_status),
        updated_at = CURRENT_TIMESTAMP
    WHERE registry_id = $8
"""

_INSERT_TRIAL_SQL: Final[str] = f"""
    INSERT INTO clinical_trials (
        drug, trial_name, registry_id, clinical_trial_phase,
        target_sample_size, estimated_completion_date,
        primary_outcome, sponsor_type, overall_status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (registry_id, drug) DO UPDATE SET
        trial_name = EXCLUDED.trial_name,
        clinical_trial_phase = EXCLUDED.clinical_trial_phase,
        target_sample_size = EXCLUDED.target_sample_size,
        estimated_completion_date = CASE
            WHEN clinical_trials.estimated_completion_date IS NOT NULL
             AND clinical_trials.estimated_completion_date !~ '{_CURATED_MONTH_YEAR}'
            THEN clinical_trials.estimated_completion_date
            ELSE EXCLUDED.estimated_completion_date
        END,
        primary_outcome = EXCLUDED.primary_outcome,
        sponsor_type = COALESCE(
            clinical_trials.sponsor_type, EXCLUDED.sponsor_type
        ),
        overall_status = COALESCE(
            EXCLUDED.overall_status, clinical_trials.overall_status
        ),
        updated_at = CURRENT_TIMESTAMP
"""


async def upsert_clinical_trials_batch(trials: list[Any]) -> TrialUpsertResult:
    """Refresh or discover clinical trial rows from ClinicalTrials.gov.

    **The registry id is the key, not (registry_id, drug).** A curated row
    names the agent under study ("Mivelsiran (ALN-APP)", "Exenatide"); CT.gov
    names the intervention its sponsor registered ("ALN-APP", "GLP-1 receptor
    agonist"), and for five of the eight curated NCT trials the two spellings
    differ. Keying the write on the pair inserted a *second* row for the same
    trial -- with every curator column NULL, published beside the curated one
    as "(unknown)" -- while the curated row's completion date and enrolment
    were never refreshed, which is the whole point of the sync. So:

    * a registry id the table already holds refreshes the API columns of
      **every** row that carries it, and adds none;
    * an intervention name no row of that trial carries is reported, not
      inserted -- whether the agent belongs in Table 2 is a curation
      judgement, and the drug column is what the row is about;
    * a registry id new to the table is inserted, curator columns NULL.

    Curator-owned columns (``mechanism_of_action``, ``genetic_target``,
    ``genetic_evidence``, ``svd_population``, ``svd_population_details``)
    appear in neither write. On INSERT they default to NULL; a refresh never
    names them.

    ``trial_name`` and ``primary_outcome`` are API-sourced on INSERT and on
    a refresh of an *uncurated* row, and curator-owned once ``svd_population``
    is filled in. The curated rows normalize both: the registry's brief title
    drops the trial acronym the curator keeps ("CERebrolysin In CADASIL"
    against "CERebrolysin In CADASIL (CERICA)"), and every curated outcome
    reads "<what> at <when>" ("New lobar cerebral microbleeds on MRI at 24
    months") where CT.gov states its own, up to 200 characters of registry
    boilerplate. Refreshing them replaced curator prose with that text on
    five of the eight curated NCT trials the first time this sync ran. The
    curation gate is the same one ``_read_curated_trials`` publishes on, so a
    discovery's title still tracks the registry until a curator adopts it.

    ``sponsor_type`` is API-sourced on INSERT and curator-owned on refresh:
    CT.gov knows only the sponsor's class, which the fetch folds to
    "Industry" or "Academic", while the curated rows carry the sponsor's
    name beside it ("Industry (Ever Neuro Pharma GmbH)"). The existing
    value wins whenever there is one.

    Args:
        trials: List of ClinicalTrialRecord objects (from
            ``pipeline.clinical_trials_fetch``).

    Returns:
        A TrialUpsertResult with refreshed and discovered row counts plus the
        registry ids whose stored rows are curated.
    """
    if not trials:
        return TrialUpsertResult()

    # Postgres treats NULLs as distinct in UNIQUE constraints, so rows with
    # a NULL registry_id bypass ON CONFLICT and duplicate on every run.
    # Skip (with a warning) rather than insert duplicates.
    filtered = [t for t in trials if t.registry_id]
    skipped = len(trials) - len(filtered)
    if skipped:
        logger.warning(
            "Skipping %d clinical trial(s) with NULL/empty registry_id "
            "(would bypass ON CONFLICT and duplicate)",
            skipped,
        )
    if not filtered:
        return TrialUpsertResult()

    registry_ids = list(dict.fromkeys(t.registry_id for t in filtered))
    async with Database.connection() as conn:
        existing = await conn.fetch(
            "SELECT registry_id, drug, svd_population FROM clinical_trials "
            "WHERE registry_id = ANY($1::text[])",
            registry_ids,
        )
        known: dict[str, set[str]] = {}
        curated: set[str] = set()
        for row in existing:
            known.setdefault(row["registry_id"], set()).add(row["drug"])
            if row["svd_population"] is not None:
                curated.add(row["registry_id"])

        refreshes: list[tuple[Any, ...]] = []
        inserts: list[tuple[Any, ...]] = []
        unmatched: list[str] = []
        refreshed_ids: set[str] = set()
        for trial in filtered:
            stored_drugs = known.get(trial.registry_id)
            if stored_drugs is None:
                inserts.append(
                    (
                        trial.drug,
                        trial.trial_name,
                        trial.registry_id,
                        trial.clinical_trial_phase,
                        trial.target_sample_size,
                        trial.estimated_completion_date,
                        trial.primary_outcome,
                        trial.sponsor_type,
                        trial.overall_status,
                    )
                )
                continue
            if trial.drug not in stored_drugs:
                unmatched.append(f"{trial.registry_id}: {trial.drug}")
            # The API columns are properties of the study, identical across
            # its interventions, so one statement per registry id refreshes
            # every row of that trial exactly once.
            if trial.registry_id not in refreshed_ids:
                refreshed_ids.add(trial.registry_id)
                refreshes.append(
                    (
                        trial.trial_name,
                        trial.clinical_trial_phase,
                        trial.target_sample_size,
                        trial.estimated_completion_date,
                        trial.primary_outcome,
                        trial.sponsor_type,
                        trial.overall_status,
                        trial.registry_id,
                    )
                )

        if refreshes:
            await conn.executemany(_REFRESH_TRIAL_SQL, refreshes)
        if inserts:
            await conn.executemany(_INSERT_TRIAL_SQL, inserts)

    if unmatched:
        logger.warning(
            "CT.gov named %d intervention(s) on trials the curated table "
            "already holds under another drug name; refreshed the existing "
            "row(s) and inserted nothing: %s",
            len(unmatched),
            "; ".join(unmatched),
        )
    return TrialUpsertResult(
        refreshed=sum(len(known[registry]) for registry in refreshed_ids),
        discovered=len(inserts),
        curated_ids=frozenset(curated),
    )


# ClinicalTrials.gov speaks only for its own registry, so the sweep asks only
# about NCT-shaped ids. The ISRCTN, ChiCTR and ANZCTR rows in the curated
# table are left NULL by this pattern, deliberately and forever: a status
# nobody can fetch is not a reason to stop publishing a trial.
_NCT_REGISTRY_ID: Final[str] = r"^NCT[0-9]{8}$"

_READ_NCT_IDS_SQL: Final[str] = f"""
    SELECT DISTINCT registry_id
      FROM clinical_trials
     WHERE registry_id ~ '{_NCT_REGISTRY_ID}'
     ORDER BY registry_id
"""

# No COALESCE, unlike every other API column on this table. "Never erase what
# the registry stopped stating" is the right rule for a fact a curator may
# also hold; it is the wrong one for a status, which is the registry's own
# current answer and has to be able to move when a trial is terminated. The
# erase case cannot arise anyway -- an id CT.gov did not answer for is absent
# from the mapping and no statement is issued for it.
_UPDATE_TRIAL_STATUS_SQL: Final[str] = """
    UPDATE clinical_trials
       SET overall_status = $1, updated_at = CURRENT_TIMESTAMP
     WHERE registry_id = $2
"""


async def read_nct_registry_ids() -> list[str]:
    """Every distinct ClinicalTrials.gov id the trials table holds.

    Uncurated discoveries are included. Gating on ``svd_population`` would
    save a request or two and cost the status of every trial a curator
    publishes tomorrow, which would then ship NULL until the next sync.
    """
    async with Database.connection() as conn:
        rows = await conn.fetch(_READ_NCT_IDS_SQL)
    return [row["registry_id"] for row in rows]


async def update_trial_statuses(statuses: Mapping[str, str]) -> int:
    """Write CT.gov's overall status onto the rows of each registry id.

    Returns the number of trials whose stored status actually moved. The
    stored values are read first so that number is real rather than the
    count of statements issued, and so a trial that has just been terminated
    can be named in the log: this is the one write in the pipeline that can
    remove a row from Table 2, and it should never do so silently.
    """
    if not statuses:
        return 0

    registry_ids = sorted(statuses)
    async with Database.connection() as conn:
        rows = await conn.fetch(
            "SELECT registry_id, overall_status FROM clinical_trials "
            "WHERE registry_id = ANY($1::text[])",
            registry_ids,
        )
        stored: dict[str, set[str | None]] = {}
        for row in rows:
            stored.setdefault(row["registry_id"], set()).add(row["overall_status"])

        # A trial with no row is not written; a trial whose rows already all
        # carry the fetched status is skipped, so updated_at does not churn
        # across the whole table on every sync.
        changed = [
            registry
            for registry in registry_ids
            if registry in stored and stored[registry] != {statuses[registry]}
        ]
        if not changed:
            return 0

        await conn.executemany(
            _UPDATE_TRIAL_STATUS_SQL,
            [(statuses[registry], registry) for registry in changed],
        )

    for registry in changed:
        was = ", ".join(sorted(str(v) for v in stored[registry]))
        logger.info(
            "CT.gov status %s: %s -> %s", registry, was, statuses[registry]
        )
    return len(changed)
