"""Tests for pipeline.external_data_sync — external data sync orchestrator."""

import logging
from unittest.mock import AsyncMock

import pytest

from pipeline.config import PipelineConfig
from pipeline.external_data_sync import (
    ExternalDataSyncResult,
    get_all_pmids,
    get_table1_gene_symbols,
    get_table2_gene_symbols,
    sync_all_external_data,
    sync_external_data_for,
)
from pipeline.ncbi_gene_fetch import SyncResult as NCBISyncResult
from pipeline.pubmed_citations import SyncResult as PubMedSyncResult
from pipeline.uniprot_fetch import SyncResult as UniProtSyncResult

# ---------------------------------------------------------------------------
# ExternalDataSyncResult
# ---------------------------------------------------------------------------


class TestExternalDataSyncResult:
    def test_default_values(self):
        r = ExternalDataSyncResult()
        assert r.ncbi_fetched == 0
        assert r.ncbi_cached == 0
        assert r.ncbi_failed == 0
        assert r.uniprot_fetched == 0
        assert r.uniprot_cached == 0
        assert r.uniprot_failed == 0
        assert r.pubmed_fetched == 0
        assert r.pubmed_cached == 0
        assert r.pubmed_failed == 0
        assert r.errors == []

    def test_summary_format(self):
        r = ExternalDataSyncResult(
            ncbi_fetched=5,
            ncbi_cached=10,
            ncbi_failed=1,
            uniprot_fetched=3,
            uniprot_cached=8,
            uniprot_failed=2,
            pubmed_fetched=20,
            pubmed_cached=50,
            pubmed_failed=0,
        )
        s = r.summary()
        assert "NCBI: 5 fetched" in s
        assert "UniProt: 3 fetched" in s
        assert "PubMed: 20 fetched" in s
        # Clinical trials sync lives in its own pipeline now; the external
        # data sync summary must not reference it.
        assert "ClinicalTrials" not in s


# ---------------------------------------------------------------------------
# get_table1_gene_symbols
# ---------------------------------------------------------------------------


class TestGetTable1GeneSymbols:
    async def test_returns_gene_list(self, mocker):
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[{"gene": "NOTCH3"}, {"gene": "HTRA1"}]
        )
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mocker.patch(
            "pipeline.external_data_sync.Database.connection",
            return_value=mock_ctx,
        )

        result = await get_table1_gene_symbols()
        assert result == ["NOTCH3", "HTRA1"]


# ---------------------------------------------------------------------------
# get_table2_gene_symbols
# ---------------------------------------------------------------------------


class TestGetTable2GeneSymbols:
    async def test_parses_comma_separated(self, mocker):
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[{"genetic_target": "NOTCH3, HTRA1"}])
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mocker.patch(
            "pipeline.external_data_sync.Database.connection",
            return_value=mock_ctx,
        )

        result = await get_table2_gene_symbols()
        assert "NOTCH3" in result
        assert "HTRA1" in result

    async def test_filters_na_and_dash(self, mocker):
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"genetic_target": "NOTCH3, NA, -, HTRA1"},
            ]
        )
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mocker.patch(
            "pipeline.external_data_sync.Database.connection",
            return_value=mock_ctx,
        )

        result = await get_table2_gene_symbols()
        assert "NA" not in result
        assert "-" not in result
        assert "NOTCH3" in result

    async def test_handles_none_target(self, mocker):
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[{"genetic_target": None}])
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mocker.patch(
            "pipeline.external_data_sync.Database.connection",
            return_value=mock_ctx,
        )

        result = await get_table2_gene_symbols()
        assert result == []

    async def test_returns_sorted_deduplicated(self, mocker):
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {"genetic_target": "HTRA1, NOTCH3"},
                {"genetic_target": "NOTCH3"},
            ]
        )
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mocker.patch(
            "pipeline.external_data_sync.Database.connection",
            return_value=mock_ctx,
        )

        result = await get_table2_gene_symbols()
        assert result == sorted(set(result))

    async def test_skips_non_gene_shaped_token(self, mocker, caplog):
        caplog.set_level(logging.DEBUG, logger="pipeline.external_data_sync")
        mock_conn = AsyncMock()
        mock_conn.fetch.return_value = [{"genetic_target": "not a gene"}]
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__.return_value = mock_conn
        mocker.patch(
            "pipeline.external_data_sync.Database.connection", return_value=mock_ctx
        )

        assert await get_table2_gene_symbols() == []
        assert "Skipping non-gene-shaped token" in caplog.text


# ---------------------------------------------------------------------------
# get_all_pmids
# ---------------------------------------------------------------------------


class TestGetAllPmids:
    @staticmethod
    def _mock_rows(mocker, rows):
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=rows)
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mocker.patch(
            "pipeline.external_data_sync.Database.connection",
            return_value=mock_ctx,
        )
        return mock_conn

    async def test_extracts_pmids(self, mocker):
        self._mock_rows(
            mocker,
            [{"pmid": "12345678"}, {"pmid": "23456789"}, {"pmid": "34567890"}],
        )

        result = await get_all_pmids()
        assert "12345678" in result
        assert "23456789" in result
        assert "34567890" in result

    async def test_skips_empty_reference_rows_and_keeps_scanning(self, mocker):
        self._mock_rows(mocker, [{"pmid": None}, {"pmid": "12345678"}])

        assert await get_all_pmids() == ["12345678"]

    async def test_reads_the_join_table_not_the_dropped_column(self, mocker):
        """Migration 006 dropped genes."references".

        The old query raised UndefinedColumnError inside sync_all_external_data's
        gather -- whose only handler is for TimeoutError -- so NCBI, UniProt and
        PubMed sync never ran on any migrated database. Mocking the connection
        is what hid it, so the SQL itself is asserted here.
        """
        conn = self._mock_rows(mocker, [])

        await get_all_pmids()

        sql = conn.fetch.await_args.args[0]
        assert "gene_references" in sql
        assert '"references"' not in sql


# ---------------------------------------------------------------------------
# sync_all_external_data
# ---------------------------------------------------------------------------


def _mock_cleanup(mocker):
    """Stub the calls these orchestration tests do not exercise.

    The close/clear pair from the finally block, plus
    `fill_missing_chromosomal_locations` -- which opens a connection, and
    `_isolate_credentials` clears the DB_* variables for every test in this
    suite. What it does with real SQL is covered in
    `test_database_integration.py`; here it would only assert that a
    database is absent.
    """
    _mod = "pipeline.external_data_sync"
    mocker.patch(f"{_mod}.close_ncbi_client", new_callable=AsyncMock)
    mocker.patch(f"{_mod}.close_uniprot_client", new_callable=AsyncMock)
    mocker.patch(f"{_mod}.close_pubmed_client", new_callable=AsyncMock)
    mocker.patch(f"{_mod}.clear_ncbi_cache")
    mocker.patch(f"{_mod}.clear_uniprot_cache")
    mocker.patch(f"{_mod}.clear_pubmed_cache")
    mocker.patch(
        f"{_mod}.fill_missing_chromosomal_locations",
        new_callable=AsyncMock,
        return_value=0,
    )


class TestSyncAllExternalData:
    async def test_orchestrates_all_syncs(self, mocker):
        config = PipelineConfig()
        mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
            return_value=["NOTCH3"],
        )
        mocker.patch(
            "pipeline.external_data_sync.get_table2_gene_symbols",
            return_value=["HTRA1"],
        )
        mocker.patch(
            "pipeline.external_data_sync.get_all_pmids",
            return_value=["12345678"],
        )
        mock_ncbi = mocker.patch(
            "pipeline.external_data_sync.sync_ncbi_gene_info",
            return_value=NCBISyncResult(fetched=2, cached=0, failed=0, errors=[]),
        )
        mock_uniprot = mocker.patch(
            "pipeline.external_data_sync.sync_uniprot_info",
            return_value=UniProtSyncResult(fetched=1, cached=0, failed=0, errors=[]),
        )
        mock_pubmed = mocker.patch(
            "pipeline.external_data_sync.sync_pubmed_citations",
            return_value=PubMedSyncResult(fetched=1, cached=0, failed=0, errors=[]),
        )
        _mock_cleanup(mocker)

        result = await sync_all_external_data(config=config)
        assert result.ncbi_fetched == 2
        assert result.uniprot_fetched == 1
        assert result.pubmed_fetched == 1
        mock_ncbi.assert_called_once_with(["NOTCH3", "HTRA1"], config=config)
        mock_uniprot.assert_called_once_with(["NOTCH3"], config=config)
        mock_pubmed.assert_called_once_with(["12345678"], config=config)

    async def test_deduplicates_genes(self, mocker):
        mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
            return_value=["NOTCH3", "HTRA1"],
        )
        mocker.patch(
            "pipeline.external_data_sync.get_table2_gene_symbols",
            return_value=["NOTCH3"],  # Duplicate
        )
        mocker.patch(
            "pipeline.external_data_sync.get_all_pmids",
            return_value=[],
        )
        mock_ncbi = mocker.patch(
            "pipeline.external_data_sync.sync_ncbi_gene_info",
            return_value=NCBISyncResult(fetched=2, cached=0, failed=0, errors=[]),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_uniprot_info",
            return_value=UniProtSyncResult(fetched=0, cached=0, failed=0, errors=[]),
        )
        _mock_cleanup(mocker)

        await sync_all_external_data()
        # NCBI sync receives deduplicated: [NOTCH3, HTRA1]
        call_args = mock_ncbi.call_args[0][0]
        assert len(call_args) == 2

    async def test_skips_pubmed_when_no_pmids(self, mocker):
        mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
            return_value=["NOTCH3"],
        )
        mocker.patch(
            "pipeline.external_data_sync.get_table2_gene_symbols",
            return_value=[],
        )
        mocker.patch(
            "pipeline.external_data_sync.get_all_pmids",
            return_value=[],
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_ncbi_gene_info",
            return_value=NCBISyncResult(fetched=0, cached=1, failed=0, errors=[]),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_uniprot_info",
            return_value=UniProtSyncResult(fetched=0, cached=1, failed=0, errors=[]),
        )
        mock_pubmed = mocker.patch(
            "pipeline.external_data_sync.sync_pubmed_citations",
        )
        _mock_cleanup(mocker)

        result = await sync_all_external_data()
        mock_pubmed.assert_not_called()
        assert result.pubmed_fetched == 0

    async def test_does_not_call_clinical_trials_sync(self):
        """sync_all_external_data must not pull in the CT pipeline.

        Clinical trial discovery is its own top-level pipeline
        (``run_clinical_trials_pipeline``); importing or calling
        ``sync_clinical_trials`` from this orchestrator would re-couple
        them.
        """
        import pipeline.external_data_sync as mod

        assert not hasattr(mod, "sync_clinical_trials")
        assert not hasattr(mod, "close_ctg_client")

    async def test_errors_limited_with_truncation_message(self, mocker):
        mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
            return_value=["A"],
        )
        mocker.patch(
            "pipeline.external_data_sync.get_table2_gene_symbols",
            return_value=[],
        )
        mocker.patch(
            "pipeline.external_data_sync.get_all_pmids",
            return_value=[],
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_ncbi_gene_info",
            return_value=NCBISyncResult(
                fetched=0,
                cached=0,
                failed=15,
                errors=[f"err{i}" for i in range(15)],
            ),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_uniprot_info",
            return_value=UniProtSyncResult(fetched=0, cached=0, failed=0, errors=[]),
        )
        _mock_cleanup(mocker)

        result = await sync_all_external_data()
        # 10 errors + 1 suppression message
        assert len(result.errors) == 11
        assert "5 more NCBI errors suppressed" in result.errors[-1]

    async def test_cleanup_called_on_exception(self, mocker):
        mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
            side_effect=RuntimeError("boom"),
        )
        _mod = "pipeline.external_data_sync"
        mock_close_ncbi = mocker.patch(
            f"{_mod}.close_ncbi_client",
            new_callable=AsyncMock,
        )
        mock_close_uniprot = mocker.patch(
            f"{_mod}.close_uniprot_client",
            new_callable=AsyncMock,
        )
        mock_close_pubmed = mocker.patch(
            f"{_mod}.close_pubmed_client",
            new_callable=AsyncMock,
        )
        mocker.patch(f"{_mod}.clear_ncbi_cache")
        mocker.patch(f"{_mod}.clear_uniprot_cache")
        mocker.patch(f"{_mod}.clear_pubmed_cache")

        with pytest.raises(RuntimeError, match="boom"):
            await sync_all_external_data()

        mock_close_ncbi.assert_called_once()
        mock_close_uniprot.assert_called_once()
        mock_close_pubmed.assert_called_once()

    async def test_timeout_returns_error_and_still_cleans_up(self, mocker):
        class ImmediateTimeout:
            async def __aenter__(self):
                raise TimeoutError

            async def __aexit__(self, *_args):
                return False

        mocker.patch(
            "pipeline.external_data_sync.asyncio.timeout",
            return_value=ImmediateTimeout(),
        )
        _mock_cleanup(mocker)

        result = await sync_all_external_data()

        assert result.errors == ["Sync timed out after 3600s"]


class TestSyncExternalDataForOneRun:
    """The keyed refresh a PubMed run runs before `--export`.

    Nothing inside a PubMed run writes `ncbi_gene_info`, `uniprot_info` or
    `pubmed_citations`, and the export completes a key it cannot find into
    a row of nulls -- so without this every newly inserted gene went out
    with an empty tooltip and every new reference as "(citation not
    available)".
    """

    async def test_it_asks_each_source_for_the_run_s_own_keys(self, mocker):
        config = PipelineConfig()
        table1 = mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
        )
        ncbi = mocker.patch(
            "pipeline.external_data_sync.sync_ncbi_gene_info",
            return_value=NCBISyncResult(fetched=1, cached=0, failed=0, errors=[]),
        )
        uniprot = mocker.patch(
            "pipeline.external_data_sync.sync_uniprot_info",
            return_value=UniProtSyncResult(fetched=1, cached=0, failed=0, errors=[]),
        )
        pubmed = mocker.patch(
            "pipeline.external_data_sync.sync_pubmed_citations",
            return_value=PubMedSyncResult(fetched=1, cached=0, failed=0, errors=[]),
        )
        _mock_cleanup(mocker)

        result = await sync_external_data_for(
            ["NOTCH3"], ["12345678"], config=config
        )

        # The whole-database collectors are not touched: this refresh is
        # exactly the run's own keys, so it costs what the run added.
        table1.assert_not_called()
        ncbi.assert_called_once_with(["NOTCH3"], config=config)
        uniprot.assert_called_once_with(["NOTCH3"], config=config)
        pubmed.assert_called_once_with(["12345678"], config=config)
        assert result.ncbi_fetched == 1
        assert result.uniprot_fetched == 1
        assert result.pubmed_fetched == 1

    async def test_a_source_failure_closes_the_clients_and_propagates(
        self, mocker
    ):
        mocker.patch(
            "pipeline.external_data_sync.sync_ncbi_gene_info",
            side_effect=RuntimeError("NCBI down"),
        )
        _mod = "pipeline.external_data_sync"
        close_ncbi = mocker.patch(f"{_mod}.close_ncbi_client", new_callable=AsyncMock)
        mocker.patch(f"{_mod}.close_uniprot_client", new_callable=AsyncMock)
        mocker.patch(f"{_mod}.close_pubmed_client", new_callable=AsyncMock)
        mocker.patch(f"{_mod}.clear_ncbi_cache")
        mocker.patch(f"{_mod}.clear_uniprot_cache")
        mocker.patch(f"{_mod}.clear_pubmed_cache")

        with pytest.raises(RuntimeError, match="NCBI down"):
            await sync_external_data_for(["NOTCH3"], ["12345678"])

        close_ncbi.assert_called_once()


class TestSyncAllAnnotations:
    async def test_clinvar_runs_before_orphadata(self, mocker) -> None:
        """Orphadata reads the ORPHAcodes ClinVar wrote; order is a dependency."""
        from pipeline.cache_utils import SyncResult
        from pipeline.external_data_sync import sync_all_annotations

        calls: list[str] = []

        def _record(name: str):
            async def _fn(*args, **kwargs):
                calls.append(name)
                return SyncResult(fetched=1, cached=0, failed=0, errors=[])
            return _fn

        mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
            AsyncMock(return_value=["HTRA1"]),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_clinvar_annotations",
            side_effect=_record("clinvar"),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_orphadata_annotations",
            side_effect=_record("orphadata"),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_opentargets_annotations",
            side_effect=_record("opentargets"),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_trial_drug_annotations",
            side_effect=_record("drugs"),
        )

        result = await sync_all_annotations()

        assert calls.index("clinvar") < calls.index("orphadata")
        assert result.clinvar_fetched == 1
        assert result.orphadata_fetched == 1
        assert result.opentargets_fetched == 1
        assert result.drugs_written == 1

    async def test_every_client_is_closed_even_when_a_source_raises(
        self, mocker
    ) -> None:
        from pipeline.external_data_sync import sync_all_annotations

        mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
            AsyncMock(return_value=["HTRA1"]),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_clinvar_annotations",
            AsyncMock(side_effect=RuntimeError("boom")),
        )
        closers = {
            name: mocker.patch(f"pipeline.external_data_sync.{name}", AsyncMock())
            for name in (
                "close_clinvar_client",
                "close_orphadata_client",
                "close_opentargets_client",
            )
        }

        with pytest.raises(RuntimeError):
            await sync_all_annotations()

        for closer in closers.values():
            closer.assert_awaited()


class TestAnnotationSyncTimeout:
    async def test_a_timeout_is_recorded_and_the_clients_still_close(
        self, mocker
    ) -> None:
        """An hour-long sync that hangs must not leak three HTTP clients."""
        from pipeline.external_data_sync import sync_all_annotations

        mocker.patch(
            "pipeline.external_data_sync.get_table1_gene_symbols",
            AsyncMock(side_effect=TimeoutError),
        )
        closers = {
            name: mocker.patch(f"pipeline.external_data_sync.{name}", AsyncMock())
            for name in (
                "close_clinvar_client",
                "close_orphadata_client",
                "close_opentargets_client",
            )
        }

        result = await sync_all_annotations()

        assert result.errors == ["Annotation sync timed out after 3600s"]
        for closer in closers.values():
            closer.assert_awaited()
