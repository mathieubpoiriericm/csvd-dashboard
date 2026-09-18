"""Tests for pipeline.database — sequence reset and empty-input short-circuits."""

import logging
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from pipeline.annotations import (
    AnnotationRow,
    AnnotationStatus,
    DrugAnnotationRow,
)
from pipeline.config import PipelineConfig
from pipeline.database import (
    Database,
    DatabaseConfigError,
    TrialUpsertResult,
    _append_gene_list_sql,
    get_annotation_statuses,
    get_cached_ncbi_genes,
    get_cached_pubmed_citations,
    get_cached_uniprot_info,
    get_existing_genes,
    get_existing_pmids,
    merge_genes_transactional,
    read_gene_annotations,
    read_nct_registry_ids,
    record_pipeline_run,
    record_processed_pmids_batch,
    replace_gene_annotations,
    reset_gene_sequence,
    update_trial_statuses,
    upsert_clinical_trials_batch,
    upsert_drug_annotations,
    upsert_ncbi_genes_batch,
    upsert_pubmed_citations_batch,
    upsert_uniprot_batch,
)

# ---------------------------------------------------------------------------
# Gene sequence reset
# ---------------------------------------------------------------------------


class TestResetGeneSequence:
    async def test_executes_fixed_statement(self, mocker):
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()

        # Mock Database.connection() as an async context manager
        mocker.patch.object(
            Database,
            "connection",
            return_value=AsyncMock(
                __aenter__=AsyncMock(return_value=mock_conn),
                __aexit__=AsyncMock(return_value=False),
            ),
        )

        await reset_gene_sequence()
        await_args = mock_conn.execute.await_args
        assert await_args is not None, "reset_gene_sequence executed no SQL"
        sql = await_args.args[0]
        assert "genes_id_seq" in sql
        assert "MAX(id) FROM genes" in sql


# ---------------------------------------------------------------------------
# Empty input short-circuits
# ---------------------------------------------------------------------------


class TestEmptyInputShortCircuits:
    async def test_merge_empty_both(self):
        inserted, updated = await merge_genes_transactional([], [])
        assert inserted == 0
        assert updated == 0

    async def test_record_empty_pmids(self):
        count = await record_processed_pmids_batch([])
        assert count == 0

    @pytest.mark.parametrize(
        ("operation", "args"),
        [
            (get_cached_ncbi_genes, ([],)),
            (get_cached_uniprot_info, ([],)),
            (get_cached_pubmed_citations, ([],)),
        ],
    )
    async def test_empty_cache_lookup(self, operation, args):
        assert await operation(*args) == {}

    @pytest.mark.parametrize(
        "operation",
        [
            upsert_ncbi_genes_batch,
            upsert_uniprot_batch,
            upsert_pubmed_citations_batch,
        ],
    )
    async def test_empty_upsert(self, operation):
        assert await operation([]) == 0

    async def test_empty_trial_upsert(self):
        """The trial upsert reports two counts, so it has its own case."""
        assert await upsert_clinical_trials_batch([]) == TrialUpsertResult()


# ---------------------------------------------------------------------------
# source_quote reaches the actual SQL sent to Postgres
# ---------------------------------------------------------------------------

_GENE_ROW = {
    "protein": "Notch receptor 3",
    "gene": "NOTCH3",
    "chromosomal_location": "19p13.12",
    # The two normalized columns arrive as lists, the way
    # _build_combined_gene_data now produces them.
    "gwas_trait": ["WMH"],
    "mendelian_randomization": False,
    "evidence_from_other_omics_studies": "",
    "link_to_monogenetic_disease": "",
    "brain_cell_types": "",
    "affected_pathway": "",
    "references": ["12345678"],
    "source_quote": "NOTCH3 variants were associated with WMH (p=1e-12).",
    "confidence": 0.87,
}


def _mock_merge_connection(mocker):
    """Patch Database.connection() and hand back the connection mock.

    conn.transaction() is a *sync* call (like real asyncpg) that returns
    an async context manager — not itself awaited. A bare AsyncMock()
    auto-vivifies .transaction as an AsyncMock too, whose __call__ is
    async and returns a coroutine instead of a context manager, so it
    must be overridden explicitly.
    """
    mock_conn = AsyncMock()
    mock_conn.executemany = AsyncMock()
    mock_conn.transaction = MagicMock(
        return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=None),
            __aexit__=AsyncMock(return_value=False),
        )
    )
    mocker.patch.object(
        Database,
        "connection",
        return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=False),
        ),
    )
    return mock_conn


def _mock_plain_connection(mocker):
    mock_conn = AsyncMock()
    mocker.patch.object(
        Database,
        "connection",
        return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=mock_conn),
            __aexit__=AsyncMock(return_value=False),
        ),
    )
    return mock_conn


def _squeezed(sql: str) -> str:
    """Collapse runs of whitespace so a clause can be matched as one line.

    The statements are indented literals, so a multi-line predicate would
    otherwise have to be asserted with its exact indentation -- the same
    brittleness against a re-wrap that retired inspect.getsource() below.
    """
    return " ".join(sql.split())


async def _merge_sql(mocker) -> tuple[str, str]:
    """Run one merge across both branches; return (insert_sql, update_sql).

    Reading the statement back out of executemany's call args is what
    makes an SQL text assertion worth anything: it proves the branch ran
    and handed asyncpg exactly that text. inspect.getsource() — the
    pattern this replaced — proved only that a literal appears somewhere
    in the function body, so it would pass against a function that built
    its SQL elsewhere and left the string dead, and it failed on a
    `ruff format` re-wrap that changed nothing.

    What none of these assertions prove is what PostgreSQL does with the
    statement. The gene-merge CTE has no behavioural coverage without a
    live database; every docstring below is scoped to the text.
    """
    mock_conn = _mock_merge_connection(mocker)
    await merge_genes_transactional([_GENE_ROW], [_GENE_ROW])
    # The two row statements come first; the join-table appends follow, and
    # have their own cases below.
    insert_call, update_call = mock_conn.executemany.call_args_list[:2]
    return insert_call.args[0], update_call.args[0]


class TestMergeGenesProvenance:
    """A field that validates but never reaches the database is worse than
    useless — it implies provenance that isn't stored. These pin that the
    SQL text and bound parameters both carry source_quote and confidence
    through, and that each keeps a first-write-wins clause rather than
    letting a later, weaker extraction clobber it.
    """

    async def test_insert_sql_and_params_carry_source_quote_and_confidence(
        self, mocker
    ):
        mock_conn = _mock_merge_connection(mocker)

        gene_row = {
            "protein": "Notch receptor 3",
            "gene": "NOTCH3",
            "chromosomal_location": "",
            "gwas_trait": ["WMH"],
            "mendelian_randomization": False,
            "evidence_from_other_omics_studies": "",
            "link_to_monogenetic_disease": "",
            "brain_cell_types": "",
            "affected_pathway": "",
            "references": ["12345678"],
            "source_quote": "NOTCH3 variants were associated with WMH (p=1e-12).",
            "confidence": 0.87,
        }
        await merge_genes_transactional([gene_row], [])

        # One row statement, then the two join-table appends.
        assert mock_conn.executemany.await_count == 3
        sql, params_list = mock_conn.executemany.call_args_list[0].args
        assert "source_quote" in sql
        assert "confidence" in sql
        params = list(params_list)[0]
        # Column list is (..., source_quote, confidence) -> confidence last.
        assert params[-1] == 0.87
        assert params[-2] == "NOTCH3 variants were associated with WMH (p=1e-12)."

    async def test_update_sql_and_params_carry_source_quote_and_confidence(
        self, mocker
    ):
        mock_conn = _mock_merge_connection(mocker)

        gene_row = {
            "protein": "Notch receptor 3",
            "gene": "NOTCH3",
            "gwas_trait": ["WMH"],
            "mendelian_randomization": False,
            "evidence_from_other_omics_studies": "",
            "references": ["12345678"],
            "source_quote": "NOTCH3 variants were associated with WMH (p=1e-12).",
            "confidence": 0.87,
        }
        await merge_genes_transactional([], [gene_row])

        # One row statement, then the two join-table appends.
        assert mock_conn.executemany.await_count == 3
        sql, params_list = mock_conn.executemany.call_args_list[0].args
        assert "source_quote" in sql
        assert "confidence" in sql
        params = list(params_list)[0]
        # WHERE UPPER(gene) = UPPER($6) puts gene last; confidence is $5,
        # source_quote is $4.
        assert params[-1] == "NOTCH3"
        assert params[-2] == 0.87
        assert params[-3] == "NOTCH3 variants were associated with WMH (p=1e-12)."

    async def test_insert_sql_fills_quote_and_confidence_on_one_condition(
        self, mocker
    ):
        """The ON CONFLICT branch guards both columns with the *same*
        predicate, which is what keeps the pair one fact: a score may only
        land beside the sentence it was scored against.

        Text only: what PostgreSQL computes from it is exercised in
        tests/pipeline/test_database_integration.py, against a real
        database.
        """
        insert_sql, _ = await _merge_sql(mocker)
        sql = _squeezed(insert_sql)
        guard = (
            "WHEN NULLIF(genes.source_quote, '') IS NULL "
            "AND NULLIF(EXCLUDED.source_quote, '') IS NOT NULL"
        )
        assert sql.count(guard) == 2
        assert f"{guard} THEN EXCLUDED.source_quote" in sql
        assert f"{guard} THEN EXCLUDED.confidence" in sql

    async def test_insert_sql_keeps_a_stored_quote_and_its_score(self, mocker):
        """The ELSE arms are the stored values, so a later, weaker
        extraction clobbers neither.
        """
        insert_sql, _ = await _merge_sql(mocker)
        assert "ELSE genes.source_quote" in insert_sql
        assert "ELSE genes.confidence" in insert_sql

    async def test_update_sql_fills_quote_and_confidence_on_one_condition(
        self, mocker
    ):
        """The UPDATE branch guards both columns on the stored quote being
        absent and this extraction carrying one, so it fills the pair or
        neither -- never a score from one paper beside another's sentence.

        Text only, as above.
        """
        _, update_sql = await _merge_sql(mocker)
        sql = _squeezed(update_sql)
        guard = (
            "WHEN NULLIF(source_quote, '') IS NULL "
            "AND NULLIF($4::text, '') IS NOT NULL"
        )
        assert sql.count(guard) == 2
        assert f"{guard} THEN $4::text" in sql
        assert f"{guard} THEN $5::double precision" in sql

    async def test_update_sql_keeps_a_stored_quote_and_its_score(self, mocker):
        """The ELSE arms read the row's own columns -- the pre-UPDATE
        values, since PostgreSQL evaluates a SET expression against the old
        row.
        """
        _, update_sql = await _merge_sql(mocker)
        assert "ELSE source_quote" in update_sql
        assert "ELSE confidence" in update_sql


# ---------------------------------------------------------------------------
# Pipeline run recording
# ---------------------------------------------------------------------------


class TestRecordPipelineRun:
    @staticmethod
    def _bound_timestamp(mock_conn):
        """The first bound parameter -- $1, run_timestamp."""
        return mock_conn.fetchval.call_args[0][1]

    @staticmethod
    def _patch_conn(mocker):
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=42)
        mocker.patch.object(
            Database,
            "connection",
            return_value=AsyncMock(
                __aenter__=AsyncMock(return_value=mock_conn),
                __aexit__=AsyncMock(return_value=False),
            ),
        )
        return mock_conn

    async def test_an_iso_string_is_bound_as_a_datetime(self, mocker):
        """asyncpg binds by Python type and will not coerce a string into a
        TIMESTAMP column, unlike psycopg2.

        This is the assertion that was missing. Every test here mocks the
        connection, so none of them exercised asyncpg's type checking, and
        the pipeline_runs table did not exist -- so the first live run after
        migration 003 failed with `DataError: invalid input for query
        argument $1 ... (expected a datetime.date or datetime.datetime
        instance, got 'str')`. Asserting the SQL text could never have caught
        it; asserting the bound *type* does.
        """
        mock_conn = self._patch_conn(mocker)

        await record_pipeline_run(
            run_timestamp="2026-03-24T10:00:00+00:00",
            papers_processed=5,
            fulltext_retrieved=3,
            genes_extracted=12,
            genes_validated=10,
        )

        bound = self._bound_timestamp(mock_conn)
        assert isinstance(bound, datetime)
        assert bound == datetime(2026, 3, 24, 10, 0, tzinfo=UTC)

    async def test_a_datetime_is_passed_through_unchanged(self, mocker):
        """The caller in main.py hands over the report's string, but nothing
        stops a future caller holding a real datetime."""
        mock_conn = self._patch_conn(mocker)
        moment = datetime(2026, 3, 24, 10, 0, tzinfo=UTC)

        await record_pipeline_run(
            run_timestamp=moment,
            papers_processed=5,
            fulltext_retrieved=3,
            genes_extracted=12,
            genes_validated=10,
        )

        assert self._bound_timestamp(mock_conn) is moment

    async def test_inserts_and_returns_id(self, mocker):
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=42)

        mocker.patch.object(
            Database,
            "connection",
            return_value=AsyncMock(
                __aenter__=AsyncMock(return_value=mock_conn),
                __aexit__=AsyncMock(return_value=False),
            ),
        )

        row_id = await record_pipeline_run(
            run_timestamp="2026-03-24T10:00:00+00:00",
            papers_processed=5,
            fulltext_retrieved=3,
            genes_extracted=12,
            genes_validated=10,
            run_mode="standard",
        )
        assert row_id == 42
        mock_conn.fetchval.assert_awaited_once()
        sql = mock_conn.fetchval.call_args[0][0]
        assert "pipeline_runs" in sql

    async def test_on_committed_fires_before_the_connection_is_released(
        self, mocker
    ):
        # The INSERT commits on its own, but handing the pooled connection
        # back is a further await -- and a cancellation delivered there used
        # to leave the caller believing the row had not been written, so it
        # added a second, `failed` row for a run that had merged. The hook
        # has to run while the connection is still held.
        released: list[str] = []
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=7)
        mocker.patch.object(
            Database,
            "connection",
            return_value=AsyncMock(
                __aenter__=AsyncMock(return_value=mock_conn),
                __aexit__=AsyncMock(
                    side_effect=lambda *_: released.append("released") or False
                ),
            ),
        )
        order: list[str] = []

        await record_pipeline_run(
            run_timestamp="2026-03-24T10:00:00+00:00",
            papers_processed=5,
            fulltext_retrieved=3,
            genes_extracted=12,
            genes_validated=10,
            on_committed=lambda: order.append(f"committed after {len(released)}"),
        )

        assert order == ["committed after 0"]

    async def test_rejects_missing_returned_id(self, mocker):
        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=None)

        mocker.patch.object(
            Database,
            "connection",
            return_value=AsyncMock(
                __aenter__=AsyncMock(return_value=mock_conn),
                __aexit__=AsyncMock(return_value=False),
            ),
        )

        with pytest.raises(RuntimeError, match="integer pipeline run id"):
            await record_pipeline_run(
                run_timestamp="2026-03-24T10:00:00+00:00",
                papers_processed=5,
                fulltext_retrieved=3,
                genes_extracted=12,
                genes_validated=10,
            )

    async def test_a_refresh_rejects_a_missing_returned_id(self, mocker):
        # The same guard as above, on the refresh record's own INSERT.
        # `_record_sync_summary` swallows what this raises, so without the
        # check a write that returned nothing would be logged as a warning
        # and look like an ordinary database hiccup.
        from pipeline.database import record_sync_run

        mock_conn = AsyncMock()
        mock_conn.fetchval = AsyncMock(return_value=None)

        mocker.patch.object(
            Database,
            "connection",
            return_value=AsyncMock(
                __aenter__=AsyncMock(return_value=mock_conn),
                __aexit__=AsyncMock(return_value=False),
            ),
        )

        with pytest.raises(RuntimeError, match="integer sync run id"):
            await record_sync_run(
                "annotation_sync",
                "2026-09-02T03:00:00+00:00",
                "completed",
                1.0,
                {"mode": "annotation_sync"},
            )


# ---------------------------------------------------------------------------
# DatabaseConfigError
# ---------------------------------------------------------------------------


class TestDatabaseConfigError:
    async def test_missing_env_vars_raises(self, monkeypatch):
        """Missing DB env vars should raise DatabaseConfigError."""
        # Clear all DB env vars
        for var in ("DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"):
            monkeypatch.delenv(var, raising=False)

        Database._pool = None  # Force re-creation
        with pytest.raises(DatabaseConfigError, match="Missing required"):
            await Database.get_pool()

    async def test_partial_env_vars_raises(self, monkeypatch):
        monkeypatch.setenv("DB_HOST", "localhost")
        monkeypatch.delenv("DB_NAME", raising=False)
        monkeypatch.delenv("DB_USER", raising=False)
        monkeypatch.delenv("DB_PASSWORD", raising=False)

        Database._pool = None
        with pytest.raises(DatabaseConfigError, match="Missing required"):
            await Database.get_pool()

    async def test_error_message_lists_missing(self, monkeypatch):
        monkeypatch.setenv("DB_HOST", "localhost")
        monkeypatch.setenv("DB_NAME", "testdb")
        monkeypatch.delenv("DB_USER", raising=False)
        monkeypatch.delenv("DB_PASSWORD", raising=False)

        Database._pool = None
        with pytest.raises(DatabaseConfigError, match="DB_USER"):
            await Database.get_pool()

    async def test_non_integer_port_raises_before_connecting(self, monkeypatch):
        for name, value in {
            "DB_HOST": "localhost",
            "DB_NAME": "testdb",
            "DB_USER": "testuser",
            "DB_PASSWORD": "secret",
            "DB_PORT": "not-a-port",
        }.items():
            monkeypatch.setenv(name, value)

        with pytest.raises(DatabaseConfigError, match="DB_PORT must be an integer"):
            await Database.get_pool()


# ---------------------------------------------------------------------------
# Database singleton behavior
# ---------------------------------------------------------------------------


class TestDatabaseSingleton:
    def test_set_config(self):
        from pipeline.config import PipelineConfig

        cfg = PipelineConfig()
        Database.set_config(cfg)
        assert Database._config is cfg

    async def test_close_when_no_pool(self):
        """close() should not error when pool is None."""
        Database._pool = None
        await Database.close()
        assert Database._pool is None

    async def test_close_calls_pool_close(self):
        mock_pool = AsyncMock()
        Database._pool = mock_pool
        await Database.close()
        mock_pool.close.assert_awaited_once()
        assert Database._pool is None

    async def test_get_pool_returns_cached_pool(self):
        pool = MagicMock()
        Database._pool = pool

        assert await Database.get_pool() is pool

    async def test_get_pool_creates_pool_from_environment(
        self, mocker, monkeypatch
    ):
        for name, value in {
            "DB_HOST": "db.example",
            "DB_NAME": "csvd",
            "DB_USER": "pipeline",
            "DB_PASSWORD": "secret",
            "DB_PORT": "6543",
        }.items():
            monkeypatch.setenv(name, value)
        config = PipelineConfig(
            db_pool_min_size=2,
            db_pool_max_size=7,
            db_command_timeout=42,
        )
        Database.set_config(config)
        pool = MagicMock()
        create_pool = mocker.patch(
            "pipeline.database.asyncpg.create_pool",
            AsyncMock(return_value=pool),
        )

        assert await Database.get_pool() is pool
        create_pool.assert_awaited_once_with(
            host="db.example",
            port=6543,
            user="pipeline",
            password="secret",
            database="csvd",
            min_size=2,
            max_size=7,
            command_timeout=42,
        )

    async def test_get_pool_uses_pool_created_by_lock_peer(self, monkeypatch):
        pool = MagicMock()

        class PeerCompletesCreation:
            async def __aenter__(self):
                Database._pool = pool

            async def __aexit__(self, *_args):
                return False

        monkeypatch.setattr(Database, "_pool_lock", PeerCompletesCreation())

        assert await Database.get_pool() is pool

    async def test_connection_acquires_and_releases_pool_connection(self, mocker):
        conn = MagicMock()
        acquire_context = AsyncMock(
            __aenter__=AsyncMock(return_value=conn),
            __aexit__=AsyncMock(return_value=False),
        )
        pool = MagicMock()
        pool.acquire.return_value = acquire_context
        mocker.patch.object(Database, "get_pool", AsyncMock(return_value=pool))

        async with Database.connection() as acquired:
            assert acquired is conn

        pool.acquire.assert_called_once_with()
        acquire_context.__aexit__.assert_awaited_once()


class TestReadHelpers:
    async def test_get_existing_genes_uppercases_at_sql_boundary(self, mocker):
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [{"gene": "NOTCH3"}, {"gene": "HTRA1"}]

        assert await get_existing_genes() == {"NOTCH3", "HTRA1"}
        assert "UPPER(gene)" in conn.fetch.await_args.args[0]

    async def test_get_existing_pmids(self, mocker):
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [{"pmid": "1"}, {"pmid": "2"}]

        assert await get_existing_pmids() == {"1", "2"}


class TestRecordProcessedPmids:
    async def test_records_batch_transactionally(self, mocker):
        conn = _mock_merge_connection(mocker)
        records = [("1", True, "pmc", 3), ("2", False, "abstract", 0)]

        assert await record_processed_pmids_batch(records) == 2

        conn.transaction.assert_called_once_with()
        conn.executemany.assert_awaited_once()
        assert conn.executemany.await_args.args[1] == records


class TestCacheOperations:
    async def test_get_cached_ncbi_genes(self, mocker):
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [
            {
                "gene_symbol": "NOTCH3",
                "ncbi_uid": "4854",
                "description": "notch receptor 3",
                "aliases": ["CADASIL"],
            }
        ]

        result = await get_cached_ncbi_genes(["NOTCH3"], max_age_days=30)

        assert result == {
            "NOTCH3": {
                "ncbi_uid": "4854",
                "description": "notch receptor 3",
                "aliases": ["CADASIL"],
            }
        }
        assert conn.fetch.await_args.args[1:] == (["NOTCH3"], 30)

    async def test_upsert_ncbi_genes(self, mocker):
        conn = _mock_plain_connection(mocker)
        genes = [
            SimpleNamespace(
                gene_symbol="NOTCH3",
                ncbi_uid="4854",
                description="notch receptor 3",
                aliases=["CADASIL"],
                map_location="19p13.12",
            )
        ]

        assert await upsert_ncbi_genes_batch(genes) == 1
        # map_location rides along because nothing else in the schema carries
        # a chromosomal band, and the phenogram places a gene by it.
        assert conn.executemany.await_args.args[1] == [
            ("NOTCH3", "4854", "notch receptor 3", ["CADASIL"], "19p13.12")
        ]

    async def test_get_cached_uniprot_info(self, mocker):
        conn = _mock_plain_connection(mocker)
        row = {
            "gene_symbol": "HTRA1",
            "accession": "Q92743",
            "protein_name": "Serine protease HTRA1",
            "biological_process": ["proteolysis"],
            "molecular_function": ["serine-type peptidase activity"],
            "cellular_component": ["extracellular space"],
            "url": "https://www.uniprot.org/uniprotkb/Q92743",
        }
        conn.fetch.return_value = [row]

        result = await get_cached_uniprot_info(["HTRA1"], max_age_days=7)

        assert result["HTRA1"] == {k: v for k, v in row.items() if k != "gene_symbol"}
        assert conn.fetch.await_args.args[1:] == (["HTRA1"], 7)

    async def test_upsert_uniprot_info(self, mocker):
        conn = _mock_plain_connection(mocker)
        info = SimpleNamespace(
            gene_symbol="HTRA1",
            accession="Q92743",
            protein_name="Serine protease HTRA1",
            biological_process=["proteolysis"],
            molecular_function=["peptidase"],
            cellular_component=["extracellular"],
            url="https://example.test/Q92743",
        )

        assert await upsert_uniprot_batch([info]) == 1
        assert conn.executemany.await_args.args[1] == [
            (
                "HTRA1",
                "Q92743",
                "Serine protease HTRA1",
                ["proteolysis"],
                ["peptidase"],
                ["extracellular"],
                "https://example.test/Q92743",
            )
        ]

    async def test_get_cached_pubmed_citations(self, mocker):
        conn = _mock_plain_connection(mocker)
        row = {
            "pmid": "123",
            "authors": "Smith J",
            "title": "Title",
            "journal": "Journal",
            "publication_date": "2025",
            "doi": "10.1234/test",
            "formatted_ref": "Smith J. Title.",
        }
        conn.fetch.return_value = [row]

        result = await get_cached_pubmed_citations(["123"])

        assert result["123"] == {k: v for k, v in row.items() if k != "pmid"}

    async def test_upsert_pubmed_citations(self, mocker):
        conn = _mock_plain_connection(mocker)
        citation = SimpleNamespace(
            pmid="123",
            authors="Smith J",
            title="Title",
            journal="Journal",
            publication_date="2025",
            doi="10.1234/test",
            formatted_ref="Smith J. Title.",
        )

        assert await upsert_pubmed_citations_batch([citation]) == 1
        assert conn.executemany.await_args.args[1] == [
            (
                "123",
                "Smith J",
                "Title",
                "Journal",
                "2025",
                "10.1234/test",
                "Smith J. Title.",
            )
        ]


def _stored(
    drug: str, *, registry_id: str = "NCT123", target_population: str | None = "CAA"
) -> dict[str, object]:
    """One row as the upsert's own SELECT returns it.

    `target_population` is read alongside the drug because it is what tells a
    curated row from a discovery the sync has already written once, and
    "refreshed" stops meaning "curated" on the second run.
    """
    return {
        "registry_id": registry_id,
        "drug": drug,
        "target_population": target_population,
    }


class TestClinicalTrialUpsert:
    @staticmethod
    def _trial(registry_id, drug="Drug A"):
        return SimpleNamespace(
            drug=drug,
            trial_name="Trial A",
            registry_id=registry_id,
            clinical_trial_phase="Phase 2",
            target_sample_size=100,
            estimated_completion_date="2027-01-01",
            primary_outcome="WMH volume",
            sponsor_type="Academic",
            overall_status="RECRUITING",
        )

    async def test_skips_missing_registry_ids_and_inserts_valid_rows(
        self, mocker, caplog
    ):
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = []

        result = await upsert_clinical_trials_batch(
            [self._trial(None), self._trial("NCT123")]
        )

        assert result == TrialUpsertResult(discovered=1)
        assert "Skipping 1 clinical trial" in caplog.text
        assert conn.executemany.await_args.args[1][0][2] == "NCT123"

    async def test_all_missing_registry_ids_short_circuits(self, mocker):
        connection = mocker.patch.object(Database, "connection")

        assert await upsert_clinical_trials_batch([self._trial("")]) == (
            TrialUpsertResult()
        )
        connection.assert_not_called()

    async def test_valid_rows_need_no_skip_warning(self, mocker, caplog):
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = []

        result = await upsert_clinical_trials_batch([self._trial("NCT123")])

        assert result.discovered == 1
        assert result.written == 1
        assert "Skipping" not in caplog.text
        conn.executemany.assert_awaited_once()

    async def test_a_known_registry_id_refreshes_and_inserts_nothing(
        self, mocker, caplog
    ):
        """The curated row names the agent; CT.gov names the intervention.

        Five of the eight curated NCT trials spell the two differently, so
        keying the write on (registry_id, drug) inserted a second, wholly
        uncurated row per trial and refreshed the curated one never.
        """
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [
            _stored("Mivelsiran (ALN-APP)"),
            _stored("Second curated arm"),
        ]

        result = await upsert_clinical_trials_batch(
            [self._trial("NCT123", drug="ALN-APP")]
        )

        assert result == TrialUpsertResult(
            refreshed=2,
            discovered=0,
            curated_ids=frozenset({"NCT123"}),
        )
        conn.executemany.assert_awaited_once()
        statement, rows = conn.executemany.await_args.args
        assert statement.lstrip().startswith("UPDATE clinical_trials")
        assert rows == [
            (
                "Trial A",
                "Phase 2",
                100,
                "2027-01-01",
                "WMH volume",
                "Academic",
                "RECRUITING",
                "NCT123",
            )
        ]
        assert "another drug name" in caplog.text

    async def test_one_refresh_statement_per_registry_id(self, mocker):
        """The API columns are the study's, identical across its arms."""
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [_stored("Drug A")]

        result = await upsert_clinical_trials_batch(
            [
                self._trial("NCT123", drug="Drug A"),
                self._trial("NCT123", drug="Drug B"),
            ]
        )

        assert result.refreshed == 1
        rows = conn.executemany.await_args.args[1]
        assert len(rows) == 1

    async def test_a_matching_drug_name_raises_no_warning(self, mocker, caplog):
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [_stored("Drug A")]

        await upsert_clinical_trials_batch([self._trial("NCT123")])

        assert "another drug name" not in caplog.text

    async def test_known_and_new_registries_take_both_statements(self, mocker):
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [_stored("Drug A")]

        result = await upsert_clinical_trials_batch(
            [self._trial("NCT123"), self._trial("NCT999")]
        )

        assert result.refreshed == 1
        assert result.discovered == 1
        assert result.written == 2
        statements = [call.args[0] for call in conn.executemany.await_args_list]
        assert statements[0].lstrip().startswith("UPDATE clinical_trials")
        assert statements[1].lstrip().startswith("INSERT INTO clinical_trials")

    async def test_a_curated_completion_date_that_is_not_a_month_survives(
        self, mocker
    ):
        """"Completed (unpublished)" is a curated fact CT.gov cannot express."""
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [_stored("Drug A")]

        await upsert_clinical_trials_batch([self._trial("NCT123")])

        statement = " ".join(conn.executemany.await_args.args[0].split())
        assert (
            "estimated_completion_date = CASE WHEN "
            "clinical_trials.estimated_completion_date IS NOT NULL AND "
            "clinical_trials.estimated_completion_date !~ '^[0-9]{1,2}/[0-9]{4}$' "
            "THEN clinical_trials.estimated_completion_date "
            "ELSE COALESCE($4, clinical_trials.estimated_completion_date) END"
        ) in statement

    async def test_a_refresh_never_erases_a_column_the_registry_stopped_stating(
        self, mocker
    ):
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [_stored("Drug A")]

        await upsert_clinical_trials_batch([self._trial("NCT123")])

        statement = " ".join(conn.executemany.await_args.args[0].split())
        for column, placeholder in (
            ("clinical_trial_phase", "$2"),
            ("target_sample_size", "$3"),
        ):
            assert (
                f"{column} = COALESCE({placeholder}, clinical_trials.{column})"
                in statement
            )
        # trial_name and primary_outcome keep the COALESCE, inside the
        # curation gate: an uncurated row still tracks the registry, a
        # curated one keeps the curator's wording.
        for column, placeholder in (("trial_name", "$1"), ("primary_outcome", "$5")):
            assert (
                f"{column} = CASE WHEN clinical_trials.target_population IS NOT NULL "
                f"THEN clinical_trials.{column} "
                f"ELSE COALESCE({placeholder}, clinical_trials.{column}) END"
                in statement
            )
        # Curator columns are assigned in neither write. `target_population` is
        # read as the gate above, so this asks whether the column is written
        # rather than whether it is mentioned.
        for curator_column in (
            "mechanism_of_action",
            "genetic_target",
            "genetic_evidence",
            "target_population",
            "target_population_details",
        ):
            assert f"{curator_column} =" not in statement


# ---------------------------------------------------------------------------
# SQL correctness: PMID reference matching
# ---------------------------------------------------------------------------


class TestReferenceSqlPatterns:
    """Assert the shape of the merge SQL actually sent to asyncpg.

    Every assertion in this class is a substring match on the statement
    executemany was handed — enough to prove the branch ran and passed
    that text, and nothing more. None of it exercises what PostgreSQL
    computes; the merge CTE stays behaviourally untested until there is
    a database to run it against.
    """

    async def test_the_append_is_idempotent_and_continues_the_ordinals(self, mocker):
        """Both properties are the delimited columns' invariants, restated:
        'append iff not already present' becomes NOT EXISTS, and
        string_agg's first-occurrence order becomes MAX(ordinal) + 1."""
        sql = _append_gene_list_sql("gene_references", "pmid")
        assert "NOT EXISTS" in sql
        assert "MAX(t.ordinal) + 1" in sql
        assert "ROW_NUMBER() OVER (ORDER BY incoming.first_ord)" in sql

    async def test_the_append_collapses_in_array_duplicates_and_blanks(self, mocker):
        """GROUP BY with MIN(ord) is what string_agg's first_ord ordering
        did; the btrim guard is what WHERE val <> '' did."""
        sql = _append_gene_list_sql("gene_gwas_traits", "trait")
        assert "MIN(ord) AS first_ord" in sql
        assert "GROUP BY btrim(value)" in sql
        assert "WHERE btrim(value) <> ''" in sql
        assert "UPPER(g.gene) = UPPER($1)" in sql

    async def test_both_join_tables_are_appended_after_the_row_upsert(self, mocker):
        """The append must run on the same connection, inside the same
        transaction, and after both row statements -- a gene inserted in
        this batch has no id until the INSERT has run."""
        mock_conn = _mock_merge_connection(mocker)
        await merge_genes_transactional([_GENE_ROW], [_GENE_ROW])

        statements = [call.args[0] for call in mock_conn.executemany.call_args_list]
        assert len(statements) == 4
        assert "INSERT INTO genes" in statements[0]
        assert "UPDATE genes SET" in statements[1]
        assert "INSERT INTO gene_references" in statements[2]
        assert "INSERT INTO gene_gwas_traits" in statements[3]

    async def test_the_append_is_passed_the_lists_for_every_merged_gene(self, mocker):
        """One parameter tuple per gene across both branches, each carrying
        the list itself -- never a joined string."""
        mock_conn = _mock_merge_connection(mocker)
        await merge_genes_transactional([_GENE_ROW], [_GENE_ROW])

        refs_params = mock_conn.executemany.call_args_list[2].args[1]
        assert refs_params == [
            (_GENE_ROW["gene"], _GENE_ROW["references"]),
            (_GENE_ROW["gene"], _GENE_ROW["references"]),
        ]

    async def test_no_statement_uses_like_for_reference_matching(self, mocker):
        """Row equality, not substring matching. This was the delimited
        columns' rule and it survives them: the append compares a stored
        value to an incoming one, so LIKE appears in no branch.
        """
        insert_sql, update_sql = await _merge_sql(mocker)
        assert " LIKE " not in insert_sql
        assert " LIKE " not in update_sql
        assert " LIKE " not in _append_gene_list_sql("gene_references", "pmid")

    async def test_non_reference_evidence_columns_are_unioned_too(self, mocker):
        """The same preserve-and-union shape covers the columns migration
        006 left behind — the sticky OR on mendelian_randomization in both
        branches, the INSERT's protein guard, and the omics union, which is
        deliberately not normalized.

        Migration 007 replaced a CASE testing = 'Y' with the boolean OR it
        was emulating. That CASE never matched a curated 'Yes', so the OR
        silently did not stick for those rows; the COALESCEs are what keep
        a NULL from swallowing a TRUE.
        """
        insert_sql, update_sql = await _merge_sql(mocker)
        assert "COALESCE(genes.mendelian_randomization, FALSE)" in insert_sql
        assert "OR COALESCE(EXCLUDED.mendelian_randomization, FALSE)" in insert_sql
        assert "COALESCE(mendelian_randomization, FALSE)" in update_sql
        assert "OR COALESCE($2::boolean, FALSE)" in update_sql
        assert "genes.protein IS NULL" in insert_sql
        assert "genes.evidence_from_other_omics_studies" in insert_sql
        assert "string_agg(val, ';' ORDER BY first_ord)" in update_sql

    async def test_insert_sql_has_on_conflict(self, mocker):
        """INSERT statement carries ON CONFLICT, for concurrent-run
        safety."""
        insert_sql, _ = await _merge_sql(mocker)
        assert "ON CONFLICT" in insert_sql


# ---------------------------------------------------------------------------
# Gene annotation operations
# ---------------------------------------------------------------------------


def _annotation_row(object_id: str, **overrides) -> AnnotationRow:
    fields = {
        "gene_symbol": "HTRA1",
        "source": "clinvar",
        "relation": "disease",
        "group_key": "MONDO:0010829",
        "object_id": object_id,
        "object_label": "CARASIL syndrome",
        "qualifier": "Pathogenic",
        "score": None,
        "evidence_count": 5,
        "source_version": None,
    }
    fields.update(overrides)
    return AnnotationRow(**fields)


class TestAnnotationOperations:
    async def test_empty_symbols_short_circuit(self):
        assert await get_annotation_statuses([], "clinvar") == {}

    async def test_get_annotation_statuses_binds_source_and_age(self, mocker):
        conn = _mock_plain_connection(mocker)
        fetched_at = datetime(2026, 9, 2, 12, 0, 0)
        conn.fetch.return_value = [
            {
                "gene_symbol": "HTRA1",
                "row_count": 4,
                "source_version": None,
                "updated_at": fetched_at,
            }
        ]

        result = await get_annotation_statuses(["HTRA1"], "clinvar", max_age_days=30)

        # ``updated_at`` rides along so one source can compare its freshness
        # with another's: Orphadata's rows are keyed on ClinVar's ORPHAcodes.
        assert result == {
            "HTRA1": {
                "row_count": 4,
                "source_version": None,
                "updated_at": fetched_at,
            }
        }
        assert conn.fetch.await_args.args[1:] == (["HTRA1"], "clinvar", 30)

    async def test_replace_with_no_statuses_writes_nothing(self, mocker):
        conn = _mock_merge_connection(mocker)

        assert await replace_gene_annotations([_annotation_row("OMIM:600142")], []) == 0
        conn.executemany.assert_not_awaited()

    async def test_replace_deletes_then_inserts_in_sorted_order(self, mocker):
        """The delete is scoped to what was fetched, and rows go in sorted.

        A re-fetch returning fewer diseases than last time must not leave the
        dropped ones behind, and the export's byte-exact contract needs the
        insert order to be reproducible.
        """
        conn = _mock_merge_connection(mocker)
        rows = [
            _annotation_row("OMIM:600142"),
            _annotation_row("MONDO:0010829"),
        ]
        statuses = [
            AnnotationStatus(
                gene_symbol="HTRA1",
                source="clinvar",
                row_count=2,
                source_version=None,
            )
        ]

        assert await replace_gene_annotations(rows, statuses) == 2

        delete_call, insert_call, status_call = conn.executemany.await_args_list
        assert "DELETE FROM gene_annotations" in delete_call.args[0]
        assert delete_call.args[1] == [("HTRA1", "clinvar")]
        assert [params[4] for params in insert_call.args[1]] == [
            "MONDO:0010829",
            "OMIM:600142",
        ]
        assert "INSERT INTO gene_annotation_status" in status_call.args[0]
        assert status_call.args[1] == [("HTRA1", "clinvar", 2, None)]

    async def test_replace_with_zero_rows_still_writes_the_status(self, mocker):
        """The negative cache: a gene with no diseases is not a gene unfetched."""
        conn = _mock_merge_connection(mocker)
        statuses = [
            AnnotationStatus(
                gene_symbol="C6orf195",
                source="clinvar",
                row_count=0,
                source_version=None,
            )
        ]

        assert await replace_gene_annotations([], statuses) == 0

        statements = [call.args[0] for call in conn.executemany.await_args_list]
        assert not any("INSERT INTO gene_annotations" in sql for sql in statements)
        assert any("INSERT INTO gene_annotation_status" in sql for sql in statements)

    async def test_read_gene_annotations_orders_by_the_unique_key(self, mocker):
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [{"gene_symbol": "HTRA1", "object_id": "OMIM:600142"}]

        result = await read_gene_annotations(source="clinvar")

        assert result == [{"gene_symbol": "HTRA1", "object_id": "OMIM:600142"}]
        sql = conn.fetch.await_args.args[0]
        assert "ORDER BY gene_symbol, source, relation, group_key, object_id" in sql
        assert conn.fetch.await_args.args[1:] == ("clinvar",)

    async def test_empty_drug_upsert(self):
        assert await upsert_drug_annotations([]) == 0

    async def test_upsert_drug_annotations_binds_every_column(self, mocker):
        conn = _mock_plain_connection(mocker)
        row = DrugAnnotationRow(
            drug="THN391",
            chembl_id=None,
            action_type=None,
            mechanism_of_action=None,
            target_symbols=None,
            source_version="26.06",
            resolved=False,
        )

        assert await upsert_drug_annotations([row]) == 1
        assert conn.executemany.await_args.args[1] == [
            ("THN391", None, None, None, None, "26.06", False)
        ]


# ---------------------------------------------------------------------------
# The ClinicalTrials.gov status sweep
# ---------------------------------------------------------------------------


class TestReadNctRegistryIds:
    async def test_only_nct_shaped_ids_are_asked_for(self, mocker):
        """CT.gov speaks only for its own registry.

        The ISRCTN, ChiCTR and ANZCTR rows in the curated table are left
        NULL by this pattern, deliberately and forever: a status nobody can
        fetch is not a reason to stop publishing a trial.
        """
        conn = _mock_plain_connection(mocker)
        conn.fetch.return_value = [{"registry_id": "NCT00000001"}]

        assert await read_nct_registry_ids() == ["NCT00000001"]

        statement = _squeezed(conn.fetch.await_args.args[0])
        assert "SELECT DISTINCT registry_id FROM clinical_trials" in statement
        assert "WHERE registry_id ~ '^NCT[0-9]{8}$'" in statement
        assert statement.endswith("ORDER BY registry_id")


class TestUpdateTrialStatuses:
    @staticmethod
    def _stored(conn, *rows: tuple[str, str | None]) -> None:
        conn.fetch.return_value = [
            {"registry_id": registry, "overall_status": status}
            for registry, status in rows
        ]

    async def test_no_statuses_touches_no_database(self, mocker):
        connection = mocker.patch.object(Database, "connection")

        assert await update_trial_statuses({}) == 0
        connection.assert_not_called()

    async def test_a_changed_status_is_written_and_named(self, mocker, caplog):
        """This is the one write that can remove a row from Table 2.

        It should never do so silently, so the transition is logged.
        """
        conn = _mock_plain_connection(mocker)
        self._stored(conn, ("NCT00000001", "RECRUITING"))

        with caplog.at_level(logging.INFO, logger="pipeline.database"):
            assert await update_trial_statuses({"NCT00000001": "TERMINATED"}) == 1

        statement, rows = conn.executemany.await_args.args
        assert _squeezed(statement).startswith(
            "UPDATE clinical_trials SET overall_status = $1"
        )
        assert rows == [("TERMINATED", "NCT00000001")]
        assert "NCT00000001: RECRUITING -> TERMINATED" in caplog.text

    async def test_every_row_of_a_trial_is_written_by_one_statement(
        self, mocker
    ):
        """NCT03082014 carries three drug rows; the status is the trial's."""
        conn = _mock_plain_connection(mocker)
        self._stored(
            conn,
            ("NCT03082014", None),
            ("NCT03082014", None),
            ("NCT03082014", None),
        )

        assert await update_trial_statuses({"NCT03082014": "TERMINATED"}) == 1

        _statement, rows = conn.executemany.await_args.args
        assert rows == [("TERMINATED", "NCT03082014")]

    async def test_an_unchanged_status_is_not_rewritten(self, mocker):
        """`updated_at` must not churn across the whole table every sync."""
        conn = _mock_plain_connection(mocker)
        self._stored(conn, ("NCT00000001", "COMPLETED"))

        assert await update_trial_statuses({"NCT00000001": "COMPLETED"}) == 0
        conn.executemany.assert_not_awaited()

    async def test_a_trial_the_table_does_not_hold_is_not_written(self, mocker):
        conn = _mock_plain_connection(mocker)
        self._stored(conn)

        assert await update_trial_statuses({"NCT00000001": "TERMINATED"}) == 0
        conn.executemany.assert_not_awaited()

    async def test_the_statement_carries_no_coalesce(self, mocker):
        """Unlike every other API column on this table, and deliberately.

        "Never erase what the registry stopped stating" is right for a fact
        a curator may also hold. A status is the registry's own current
        answer and has to be able to move when a trial is terminated.
        """
        conn = _mock_plain_connection(mocker)
        self._stored(conn, ("NCT00000001", "RECRUITING"))

        await update_trial_statuses({"NCT00000001": "TERMINATED"})

        assert "COALESCE" not in conn.executemany.await_args.args[0]
