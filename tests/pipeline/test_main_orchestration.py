"""Behavioral coverage for pipeline.main orchestration and CLI boundaries."""

import argparse
import asyncio
import json
import logging
import signal
from pathlib import Path
from typing import cast
from unittest.mock import AsyncMock, MagicMock

import asyncpg
import httpx
import pytest

import pipeline.main as pipeline_main
from pipeline import checkpoint
from pipeline.citations import current_tally, report_provenance, reset_tally
from pipeline.config import PipelineConfig
from pipeline.database import DatabaseConfigError
from pipeline.external_data_sync import ExternalDataSyncResult
from pipeline.extraction_models import ExtractionFailedError, GeneEntry
from pipeline.main import (
    ExtractionOutcome,
    PaperResult,
    _ProcessedBatch,
    _ProgressReporter,
)
from pipeline.quality_metrics import PipelineMetrics, TokenUsage
from pipeline.report import PipelineRunData


def _outcome(genes=None) -> ExtractionOutcome:
    return ExtractionOutcome(
        genes=[] if genes is None else genes,
        rejected_genes=[],
        extracted_count=0 if genes is None else len(genes),
        llm_time=0.2,
        validation_time=0.1,
    )


def _dispatcher_args(**overrides) -> argparse.Namespace:
    values = {
        "pubmed": False,
        "clinical_trials": False,
        "sync_external_data": False,
        "sync_annotations": False,
        "days_back": 7,
        "dry_run": False,
        "test_mode": False,
        "batch": False,
        "export": False,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


class TestProgressReporting:
    def test_report_and_terminal_states_are_persisted(self, tmp_path: Path) -> None:
        progress_file = tmp_path / "nested" / "progress.json"
        config = PipelineConfig(progress_file=str(progress_file))
        reporter = pipeline_main._ProgressReporter(config)

        reporter.report(2)
        running = json.loads(progress_file.read_text())
        assert running["status"] == "running"
        assert running["stage"] == "processing_papers"
        assert running["stage_number"] == 3

        reporter.finalize(status="completed")
        reporter.ensure_terminal_state()
        completed = json.loads(progress_file.read_text())
        assert completed["status"] == "completed"
        assert completed["stage_number"] == 3

    def test_fail_describes_interrupts_and_exceptions(self, tmp_path: Path) -> None:
        config = PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        interrupted = pipeline_main._ProgressReporter(config)
        interrupted.fail(asyncio.CancelledError())
        payload = json.loads(Path(config.progress_file).read_text())
        assert "interrupted (CancelledError)" in payload["error_message"]

        failed = pipeline_main._ProgressReporter(config)
        try:
            raise RuntimeError("pipeline broke")
        except RuntimeError as exc:
            failed.fail(exc)
        payload = json.loads(Path(config.progress_file).read_text())
        assert "RuntimeError: pipeline broke" in payload["error_message"]

        defensive = pipeline_main._ProgressReporter(config)
        defensive.ensure_terminal_state()
        payload = json.loads(Path(config.progress_file).read_text())
        assert payload["error_message"] == "Pipeline exited without finalizing progress"

    def test_progress_write_failure_does_not_abort_pipeline(
        self, tmp_path: Path, mocker
    ) -> None:
        config = PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        mocker.patch("pipeline.main.Path.write_text", side_effect=OSError("disk full"))
        debug = mocker.patch("pipeline.main.logger.debug")

        pipeline_main._write_progress(
            config,
            status="running",
            stage="searching_pubmed",
            stage_number=1,
        )

        assert "Failed to write progress file" in debug.call_args.args[0]


class TestCaBundleConfiguration:
    def test_sets_certifi_bundle_when_environment_is_empty(
        self, monkeypatch, mocker
    ) -> None:
        monkeypatch.delenv("SSL_CERT_FILE", raising=False)
        where = mocker.patch("certifi.where", return_value="/certs/ca.pem")

        pipeline_main._configure_ca_bundle()

        assert pipeline_main.os.environ["SSL_CERT_FILE"] == "/certs/ca.pem"
        where.assert_called_once_with()

    def test_preserves_an_explicit_bundle(self, monkeypatch, mocker) -> None:
        monkeypatch.setenv("SSL_CERT_FILE", "/custom/ca.pem")
        where = mocker.patch("certifi.where")

        pipeline_main._configure_ca_bundle()

        assert pipeline_main.os.environ["SSL_CERT_FILE"] == "/custom/ca.pem"
        where.assert_not_called()


class TestExtractionOrchestration:
    async def test_validation_exception_rejects_only_that_gene(
        self, make_gene_entry, mocker
    ) -> None:
        gene = make_gene_entry(gene_symbol="NOTCH3")
        mocker.patch(
            "pipeline.main.validate_gene_entry",
            new=AsyncMock(side_effect=RuntimeError("NCBI unavailable")),
        )
        metrics = PipelineMetrics()

        accepted, rejected = await pipeline_main._validate_genes(
            [gene], metrics, PipelineConfig()
        )

        assert accepted == []
        assert rejected[0].gene == gene
        assert rejected[0].reasons == ["NCBI unavailable"]
        assert metrics.genes_rejected == 1

    async def test_extract_failure_without_usage_preserves_metrics(
        self, mocker
    ) -> None:
        mocker.patch(
            "pipeline.main.extract_from_paper",
            new=AsyncMock(
                side_effect=pipeline_main.ExtractionFailedError("provider failed")
            ),
        )
        metrics = PipelineMetrics()

        with pytest.raises(
            pipeline_main.ExtractionFailedError, match="provider failed"
        ):
            await pipeline_main._extract_and_validate(
                "text", "123", metrics, PipelineConfig(), None
            )

        assert metrics.token_usage.total_tokens == 0

    async def test_extract_uses_ncbi_validation_policy(
        self, make_gene_entry, mocker
    ) -> None:
        gene = make_gene_entry()
        usage = TokenUsage(input_tokens=4, output_tokens=2)
        mocker.patch(
            "pipeline.main.extract_from_paper",
            new=AsyncMock(return_value=([gene], usage)),
        )
        validate = mocker.patch(
            "pipeline.main._validate_genes",
            new=AsyncMock(return_value=([gene], [])),
        )
        metrics = PipelineMetrics()

        outcome = await pipeline_main._extract_and_validate(
            "text", "123", metrics, PipelineConfig(), None
        )

        validate.assert_awaited_once()
        assert outcome.genes == [gene]
        assert gene.pmid == "123"
        assert metrics.genes_extracted == 1
        assert metrics.token_usage.total_tokens == 6

    def test_batch_warnings_are_logged(self, make_gene_entry, mocker, caplog) -> None:
        gene = make_gene_entry()
        mocker.patch("pipeline.main.batch_validate", return_value=["suspicious batch"])

        assert pipeline_main._run_batch_validation([gene]) == ["suspicious batch"]
        assert "Batch check: suspicious batch" in caplog.text


class TestInputBoundaries:
    def test_pdf_resolution_rejects_invalid_inputs(self, tmp_path: Path) -> None:
        text_file = tmp_path / "paper.txt"
        text_file.write_text("not a PDF")
        with pytest.raises(ValueError, match="Not a PDF"):
            pipeline_main._resolve_pdf_files(text_file)

        with pytest.raises(FileNotFoundError, match="Path not found"):
            pipeline_main._resolve_pdf_files(tmp_path / "missing")

        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()
        with pytest.raises(ValueError, match="No .pdf files"):
            pipeline_main._resolve_pdf_files(empty_dir)

    def test_pmid_loading_rejects_missing_or_empty_files(self, tmp_path: Path) -> None:
        with pytest.raises(FileNotFoundError, match="PMID file not found"):
            pipeline_main._load_pmids(tmp_path / "missing.txt")

        empty = tmp_path / "empty.txt"
        empty.write_text("# comment\ninvalid\n")
        with pytest.raises(ValueError, match="No valid PMIDs"):
            pipeline_main._load_pmids(empty)


class TestMetadataAndFinalization:
    async def test_metadata_client_manager_wrappers(self, mocker) -> None:
        client = object()
        get = mocker.patch(
            "pipeline.main._metadata_client_manager.get",
            new=AsyncMock(return_value=client),
        )
        close = mocker.patch(
            "pipeline.main._metadata_client_manager.close", new=AsyncMock()
        )

        assert await pipeline_main._get_metadata_client() is client
        await pipeline_main._close_metadata_client()

        get.assert_awaited_once_with()
        close.assert_awaited_once_with()

    async def test_metadata_adds_api_key(self, monkeypatch, mocker) -> None:
        monkeypatch.setenv("NCBI_API_KEY", "secret-key")
        response = MagicMock(status_code=503)
        client = AsyncMock()
        client.get.return_value = response
        mocker.patch(
            "pipeline.main._get_metadata_client", new=AsyncMock(return_value=client)
        )

        assert await pipeline_main.fetch_paper_metadata("123") == {"doi": None}
        assert client.get.await_args.kwargs["params"]["api_key"] == "secret-key"

    @pytest.mark.parametrize(
        "error",
        [
            httpx.RequestError("connection reset"),
            httpx.TimeoutException("timed out"),
        ],
    )
    async def test_metadata_network_errors_return_no_doi(self, error, mocker) -> None:
        client = AsyncMock()
        client.get.side_effect = error
        mocker.patch(
            "pipeline.main._get_metadata_client", new=AsyncMock(return_value=client)
        )

        assert await pipeline_main.fetch_paper_metadata("123") == {"doi": None}

    async def test_metadata_malformed_xml_returns_no_doi(self, mocker) -> None:
        response = MagicMock(status_code=200, content=b"not XML")
        client = AsyncMock()
        client.get.return_value = response
        mocker.patch(
            "pipeline.main._get_metadata_client", new=AsyncMock(return_value=client)
        )

        assert await pipeline_main.fetch_paper_metadata("123") == {"doi": None}

    async def test_record_and_notify_runs_both_side_effects(self, mocker) -> None:
        event_log = mocker.patch("pipeline.main.EventLog")
        entered_log = event_log.return_value.__enter__.return_value
        notify = mocker.patch("pipeline.main.send_pipeline_notification")
        config = PipelineConfig(event_db_path="/tmp/test-events.db")
        run_data = {"timestamp": "2026-01-01T00:00:00Z"}

        await pipeline_main._record_and_notify(config, run_data)

        entered_log.record.assert_called_once_with("pipeline_completed", run_data)
        notify.assert_called_once_with(run_data, config)


class TestTheQuoteGateNamesWhatItDropped:
    """A gene the verbatim gate removed is listed, not merely counted.

    The gate runs inside extraction, so these genes never reach
    `_validate_genes` and became no `RejectedGene`: the published report
    carried "1 gene was dropped" and the symbol existed nowhere but the
    log file.
    """

    def setup_method(self) -> None:
        reset_tally()

    @staticmethod
    def _extraction(kept: GeneEntry, dropped: GeneEntry, document: str):
        async def fake(text, pmid, *, config=None, rate_limiter=None):
            genes = report_provenance(
                [kept, dropped],
                spans=[],
                document=document,
                pmid=pmid,
                require_verified_quotes=True,
            )
            return genes, TokenUsage()

        return fake

    async def test_a_dropped_gene_is_a_rejection_with_the_reason(
        self, mocker, make_gene_entry
    ) -> None:
        document = "NOTCH3 mutations cause CADASIL."
        kept = make_gene_entry(gene_symbol="NOTCH3", source_quote=document)
        # A genomic-table row the model reassembled from cells -- the one
        # real failure on PMID 37069360.
        dropped = make_gene_entry(
            gene_symbol="CENPF", source_quote="9,033/38,008 8.20 x 10 -11"
        )
        mocker.patch(
            "pipeline.main.extract_from_paper",
            new=self._extraction(kept, dropped, document),
        )
        mocker.patch(
            "pipeline.main._validate_genes", new=AsyncMock(return_value=([kept], []))
        )

        outcome = await pipeline_main._extract_and_validate(
            document, "37069360", PipelineMetrics(), PipelineConfig(), None
        )

        assert outcome.genes == [kept]
        assert [r.gene.gene_symbol for r in outcome.rejected_genes] == ["CENPF"]
        assert outcome.rejected_genes[0].reasons == ["Quote not found in the paper"]
        # The PMID rides the gene, so the published record can point at the
        # paper the quote was supposed to come from.
        assert outcome.rejected_genes[0].gene.pmid == "37069360"

    async def test_the_gate_off_leaves_the_rejections_alone(
        self, mocker, make_gene_entry
    ) -> None:
        document = "NOTCH3 mutations cause CADASIL."
        kept = make_gene_entry(gene_symbol="NOTCH3", source_quote=document)
        unverifiable = make_gene_entry(gene_symbol="CENPF", source_quote="not here")

        async def fake(text, pmid, *, config=None, rate_limiter=None):
            genes = report_provenance(
                [kept, unverifiable],
                spans=[],
                document=document,
                pmid=pmid,
                require_verified_quotes=False,
            )
            return genes, TokenUsage()

        mocker.patch("pipeline.main.extract_from_paper", new=fake)
        mocker.patch(
            "pipeline.main._validate_genes",
            new=AsyncMock(return_value=([kept, unverifiable], [])),
        )

        outcome = await pipeline_main._extract_and_validate(
            document, "37069360", PipelineMetrics(), PipelineConfig(), None
        )

        assert outcome.rejected_genes == []
        assert len(outcome.genes) == 2

    async def test_the_batch_path_lists_them_too(self, mocker, make_gene_entry) -> None:
        kept = make_gene_entry(gene_symbol="NOTCH3")
        dropped = make_gene_entry(gene_symbol="CENPF", source_quote="not in the paper")
        current_tally().record_dropped("37069360", [dropped])
        mocker.patch(
            "pipeline.main._validate_genes", new=AsyncMock(return_value=([kept], []))
        )

        result = await pipeline_main._validate_batch_paper(
            "37069360",
            [kept],
            (True, "europepmc", False),
            PipelineMetrics(),
            PipelineConfig(),
        )

        assert [r.gene.gene_symbol for r in result.rejected_genes] == ["CENPF"]


class TestPaperProcessing:
    async def test_process_paper_skips_when_no_text(self, mocker) -> None:
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new=AsyncMock(return_value={"doi": None}),
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new=AsyncMock(
                return_value={"text": None, "fulltext": False, "source": "none"}
            ),
        )
        metrics = PipelineMetrics()

        result = await pipeline_main.process_paper("123", metrics, PipelineConfig())

        assert result == {
            "genes": [],
            "rejected_genes": [],
            "fulltext": False,
            "source": "none",
            "text_truncated": False,
        }

    async def test_process_paper_counts_fulltext_and_returns_extraction(
        self, make_gene_entry, mocker
    ) -> None:
        gene = make_gene_entry()
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new=AsyncMock(return_value={"doi": "10.1/test"}),
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new=AsyncMock(
                return_value={"text": "paper", "fulltext": True, "source": "pmc"}
            ),
        )
        mocker.patch(
            "pipeline.main._extract_and_validate",
            new=AsyncMock(return_value=_outcome([gene])),
        )
        metrics = PipelineMetrics()

        result = await pipeline_main.process_paper("123", metrics, PipelineConfig())

        assert result["genes"] == [gene]
        assert result["fulltext"] is True
        assert metrics.fulltext_retrieved == 1

    async def test_a_paper_over_the_text_limit_is_flagged(self, mocker) -> None:
        # The model saw the first max_paper_text_chars and no further, and
        # the paper is recorded as processed all the same -- so the flag is
        # the only thing that lets the report say part of it was not read.
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new=AsyncMock(return_value={"doi": None}),
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new=AsyncMock(
                return_value={"text": "x" * 50, "fulltext": True, "source": "pmc"}
            ),
        )
        mocker.patch(
            "pipeline.main.extract_from_paper",
            new=AsyncMock(return_value=([], TokenUsage())),
        )

        result = await pipeline_main.process_paper(
            "123", PipelineMetrics(), PipelineConfig(max_paper_text_chars=10)
        )

        assert result["text_truncated"] is True

    async def test_a_paper_inside_the_text_limit_is_not_flagged(self, mocker) -> None:
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new=AsyncMock(return_value={"doi": None}),
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new=AsyncMock(
                return_value={"text": "x" * 50, "fulltext": True, "source": "pmc"}
            ),
        )
        mocker.patch(
            "pipeline.main.extract_from_paper",
            new=AsyncMock(return_value=([], TokenUsage())),
        )

        result = await pipeline_main.process_paper(
            "123", PipelineMetrics(), PipelineConfig(max_paper_text_chars=5000)
        )

        assert result["text_truncated"] is False

    async def test_process_paper_safe_wraps_a_success(self, mocker) -> None:
        mocker.patch(
            "pipeline.main.process_paper",
            new=AsyncMock(
                return_value={
                    "genes": [],
                    "rejected_genes": [],
                    "fulltext": False,
                    "source": "abstract",
                    "text_truncated": False,
                }
            ),
        )

        result = await pipeline_main.process_paper_safe(
            "123",
            PipelineMetrics(),
            asyncio.Semaphore(1),
            {"current": 0, "total": 1},
            PipelineConfig(),
        )

        assert result.succeeded
        assert result.source == "abstract"


class TestConcurrentProcessing:
    """Each paper accumulates into its own metrics before the run's."""

    @staticmethod
    def _fake_process_paper(**increments: int):
        async def fake(pmid, metrics, *, config, rate_limiter=None):
            metrics.genes_extracted += increments.get("genes_extracted", 2)
            metrics.genes_validated += 1
            metrics.genes_rejected += 1
            metrics.fulltext_retrieved += 1
            metrics.token_usage += TokenUsage(input_tokens=100, output_tokens=10)
            return {
                "genes": [],
                "rejected_genes": [],
                "fulltext": True,
                "source": "pmc",
                "text_truncated": False,
            }

        return fake

    async def test_every_paper_folds_into_the_run_total(self, mocker) -> None:
        mocker.patch("pipeline.main.process_paper", new=self._fake_process_paper())
        metrics = PipelineMetrics()

        await pipeline_main.process_papers_concurrently(
            ["1", "2", "3"], metrics, PipelineConfig()
        )

        assert metrics.genes_extracted == 6
        assert metrics.genes_validated == 3
        assert metrics.fulltext_retrieved == 3
        assert metrics.token_usage.input_tokens == 300

    async def test_the_completion_hook_sees_one_paper_at_a_time(
        self, mocker
    ) -> None:
        # The hook is what writes the checkpoint, so it has to receive what
        # *this* paper contributed. Handing it the shared accumulator would
        # checkpoint the running total and restore it once per paper.
        mocker.patch("pipeline.main.process_paper", new=self._fake_process_paper())
        seen: list[tuple[str, int, int]] = []

        await pipeline_main.process_papers_concurrently(
            ["1", "2", "3"],
            PipelineMetrics(),
            PipelineConfig(),
            on_complete=lambda result, paper_metrics: seen.append(
                (
                    result.pmid,
                    paper_metrics.genes_extracted,
                    paper_metrics.token_usage.input_tokens,
                )
            ),
        )

        assert sorted(pmid for pmid, _, _ in seen) == ["1", "2", "3"]
        assert all(extracted == 2 for _, extracted, _ in seen)
        assert all(tokens == 100 for _, _, tokens in seen)

    async def test_a_failed_paper_is_not_handed_to_the_hook(self, mocker) -> None:
        # Failures are never written to pubmed_refs, so they are retried by
        # the next run. Checkpointing one would instead make a resumed run
        # restore the failure and never retry it.
        async def boom(pmid, metrics, *, config, rate_limiter=None):
            raise RuntimeError("retrieval died")

        mocker.patch("pipeline.main.process_paper", new=boom)
        seen: list[str] = []

        results = await pipeline_main.process_papers_concurrently(
            ["1"],
            PipelineMetrics(),
            PipelineConfig(),
            on_complete=lambda result, paper_metrics: seen.append(result.pmid),
        )

        assert results[0].error == "retrieval died"
        assert seen == []


class TestCheckpointResume:
    """A crash after hours of extraction must not discard the extraction."""

    @staticmethod
    def _gene(symbol: str = "NOTCH3") -> GeneEntry:
        return GeneEntry(
            gene_symbol=symbol,
            confidence=0.9,
            source_quote="NOTCH3 mutations cause CADASIL.",
            pmid="111",
        )

    def _config(self, tmp_path: Path) -> PipelineConfig:
        return PipelineConfig(
            checkpoint_file=str(tmp_path / "checkpoint.jsonl"),
            progress_file=str(tmp_path / "progress.json"),
        )

    def _checkpoint_one(self, config: PipelineConfig, pmid: str) -> None:
        result = PaperResult(
            pmid=pmid,
            genes=[self._gene()],
            rejected_genes=[
                pipeline_main.RejectedGene(gene=self._gene("APOE"), reasons=["low"])
            ],
            fulltext=True,
            source="pmc",
            llm_time=12.5,
        )
        metrics = PipelineMetrics(
            fulltext_retrieved=1,
            genes_extracted=2,
            genes_validated=1,
            genes_rejected=1,
            token_usage=TokenUsage(input_tokens=9000, output_tokens=800),
        )
        checkpoint.append(
            config.checkpoint_file,
            checkpoint.fingerprint(config),
            pipeline_main._checkpoint_record(result, metrics),
        )

    async def test_a_checkpointed_paper_is_not_extracted_again(
        self, mocker, tmp_path: Path
    ) -> None:
        config = self._config(tmp_path)
        self._checkpoint_one(config, "111")
        concurrent = mocker.patch(
            "pipeline.main.process_papers_concurrently",
            new=AsyncMock(return_value=[PaperResult(pmid="222", source="abstract")]),
        )

        batch = await pipeline_main._process_new_pmids(
            ["111", "222"], PipelineMetrics(), config, AsyncMock(), MagicMock()
        )

        assert concurrent.await_args.args[0] == ["222"]
        assert [r.pmid for r in batch.results] == ["111", "222"]

    async def test_a_resumed_run_merges_in_the_window_s_order(
        self, mocker, tmp_path: Path
    ) -> None:
        # Restored papers used to be prepended to the pending ones, so a
        # crash reordered the batch: the merge keeps the *first*
        # occurrence's quote, confidence and protein, and inserts rows in
        # that order, so the resumed run published a different quote and a
        # different row order than the same run without the crash.
        config = self._config(tmp_path)
        self._checkpoint_one(config, "222")
        mocker.patch(
            "pipeline.main.process_papers_concurrently",
            new=AsyncMock(return_value=[PaperResult(pmid="111", source="abstract")]),
        )

        batch = await pipeline_main._process_new_pmids(
            ["111", "222"], PipelineMetrics(), config, AsyncMock(), MagicMock()
        )

        assert [r.pmid for r in batch.results] == ["111", "222"]

    async def test_a_restored_paper_keeps_its_genes_and_its_cost(
        self, mocker, tmp_path: Path
    ) -> None:
        # The genes are what the merge publishes, and the tokens are what the
        # run report says the dataset cost. Dropping either would make the
        # resumed run cheaper and emptier than the work it actually did.
        config = self._config(tmp_path)
        self._checkpoint_one(config, "111")
        mocker.patch(
            "pipeline.main.process_papers_concurrently", new=AsyncMock(return_value=[])
        )
        metrics = PipelineMetrics()

        batch = await pipeline_main._process_new_pmids(
            ["111"], metrics, config, AsyncMock(), MagicMock()
        )

        restored = batch.results[0]
        assert [g.gene_symbol for g in restored.genes] == ["NOTCH3"]
        assert [r.gene.gene_symbol for r in restored.rejected_genes] == ["APOE"]
        assert restored.fulltext is True
        assert restored.source == "pmc"
        assert restored.llm_time == 12.5
        assert metrics.genes_extracted == 2
        assert metrics.genes_validated == 1
        assert metrics.fulltext_retrieved == 1
        assert metrics.token_usage.input_tokens == 9000

    async def test_the_restore_is_named_in_the_run_report(
        self, mocker, tmp_path: Path
    ) -> None:
        # The resumed run's cost includes the crashed run's spend, which is
        # also in that run's own failed report. Saying so is what keeps the
        # two reports readable together.
        config = self._config(tmp_path)
        self._checkpoint_one(config, "111")
        mocker.patch(
            "pipeline.main.process_papers_concurrently", new=AsyncMock(return_value=[])
        )
        progress = MagicMock()

        await pipeline_main._process_new_pmids(
            ["111"], PipelineMetrics(), config, AsyncMock(), progress
        )

        assert any(
            "Restored 1" in call.args[0] for call in progress.action.call_args_list
        )

    async def test_a_completed_paper_is_written_to_the_checkpoint(
        self, mocker, tmp_path: Path
    ) -> None:
        config = self._config(tmp_path)
        finished = PaperResult(
            pmid="222", genes=[self._gene()], fulltext=True, source="pmc"
        )

        async def fake(pmids, metrics, *, config, rate_limiter, on_complete=None):
            assert on_complete is not None, "checkpointing was not wired up"
            on_complete(finished, PipelineMetrics(genes_extracted=1))
            return [finished]

        mocker.patch("pipeline.main.process_papers_concurrently", new=fake)

        await pipeline_main._process_new_pmids(
            ["222"], PipelineMetrics(), config, AsyncMock(), MagicMock()
        )

        records = checkpoint.load(
            config.checkpoint_file, checkpoint.fingerprint(config)
        )
        assert [r["result"]["pmid"] for r in records] == ["222"]

    async def test_checkpointing_off_writes_nothing(
        self, mocker, tmp_path: Path
    ) -> None:
        # The hook is still wired up -- it is what hands each finished paper
        # to the run's own list, which a failed report reads -- but with
        # checkpointing off it must leave no file behind.
        config = self._config(tmp_path)
        finished = PaperResult(
            pmid="111", genes=[self._gene()], fulltext=True, source="pmc"
        )
        collected: list[PaperResult] = []

        async def fake(pmids, metrics, *, config, rate_limiter, on_complete=None):
            assert on_complete is not None
            on_complete(finished, PipelineMetrics(genes_extracted=1))
            return [finished]

        mocker.patch("pipeline.main.process_papers_concurrently", new=fake)

        await pipeline_main._process_new_pmids(
            ["111"],
            PipelineMetrics(),
            config,
            AsyncMock(),
            MagicMock(),
            use_checkpoint=False,
            collected=collected,
        )

        assert [r.pmid for r in collected] == ["111"]
        assert not Path(config.checkpoint_file).exists()

    def _batch_fakes(self, mocker, genes_by_pmid: dict[str, list[GeneEntry]]):
        mocker.patch(
            "pipeline.main._fetch_paper_text_for_batch",
            new=AsyncMock(return_value=("text", True, "europepmc")),
        )
        mocker.patch(
            "pipeline.main.submit_and_collect",
            new=AsyncMock(return_value=genes_by_pmid),
        )

        async def _validate(genes, metrics, config):
            metrics.genes_validated += len(genes)
            return genes, []

        mocker.patch("pipeline.main._validate_genes", new=_validate)

    async def test_a_batch_run_checkpoints_each_validated_paper(
        self, mocker, tmp_path: Path
    ) -> None:
        # The batch was paid for when it was collected; a crash at the merge
        # used to lose all of it, because the batch path wrote no checkpoint
        # and the next run resubmitted every paper.
        config = self._config(tmp_path)
        self._batch_fakes(
            mocker, {"111": [self._gene()], "222": [self._gene("HTRA1")]}
        )

        await pipeline_main._process_new_pmids_via_batch(
            ["111", "222"], PipelineMetrics(), config, MagicMock()
        )

        records = {
            r["result"]["pmid"]: r
            for r in checkpoint.load(
                config.checkpoint_file, checkpoint.fingerprint(config)
            )
        }
        assert set(records) == {"111", "222"}
        assert [g["gene_symbol"] for g in records["222"]["result"]["genes"]] == [
            "HTRA1"
        ]
        assert records["222"]["result"]["source"] == "europepmc"
        # The paper's own contribution, not the run's running total.
        assert records["222"]["metrics"]["papers_processed"] == 1
        assert records["222"]["metrics"]["fulltext_retrieved"] == 1
        assert records["222"]["metrics"]["genes_extracted"] == 1
        assert records["222"]["metrics"]["genes_validated"] == 1

    async def test_a_batch_paper_with_no_text_is_checkpointed_too(
        self, mocker, tmp_path: Path
    ) -> None:
        # Processed with source "none" is a stable fact the merge records;
        # the streaming path checkpoints it, so a resumed batch run must not
        # fetch it again either.
        config = self._config(tmp_path)
        self._batch_fakes(mocker, {})
        mocker.patch(
            "pipeline.main._fetch_paper_text_for_batch",
            new=AsyncMock(return_value=("", False, "none")),
        )

        await pipeline_main._process_new_pmids_via_batch(
            ["111"], PipelineMetrics(), config, MagicMock()
        )

        records = checkpoint.load(
            config.checkpoint_file, checkpoint.fingerprint(config)
        )
        assert [r["result"]["pmid"] for r in records] == ["111"]
        assert records[0]["result"]["source"] == "none"
        assert records[0]["metrics"]["papers_processed"] == 1

    async def test_a_batch_paper_that_failed_validation_is_not_checkpointed(
        self, mocker, tmp_path: Path
    ) -> None:
        from pipeline.validation import NcbiUnavailableError

        config = self._config(tmp_path)
        self._batch_fakes(
            mocker, {"111": [self._gene()], "222": [self._gene("HTRA1")]}
        )

        async def _validate(genes, metrics, config):
            if genes[0].gene_symbol == "NOTCH3":
                raise NcbiUnavailableError("NCBI down")
            return genes, []

        mocker.patch("pipeline.main._validate_genes", new=_validate)

        await pipeline_main._process_new_pmids_via_batch(
            ["111", "222"], PipelineMetrics(), config, MagicMock()
        )

        records = checkpoint.load(
            config.checkpoint_file, checkpoint.fingerprint(config)
        )
        assert [r["result"]["pmid"] for r in records] == ["222"]

    async def test_a_batch_run_with_checkpointing_off_writes_nothing(
        self, mocker, tmp_path: Path
    ) -> None:
        config = self._config(tmp_path)
        self._batch_fakes(mocker, {"111": [self._gene()]})

        async def fetch(pmid, semaphore):
            # One validated paper and one with no text: neither is written.
            return ("text", True, "europepmc") if pmid == "111" else ("", False, "none")

        mocker.patch("pipeline.main._fetch_paper_text_for_batch", new=fetch)

        await pipeline_main._process_new_pmids_via_batch(
            ["111", "222"],
            PipelineMetrics(),
            config,
            MagicMock(),
            use_checkpoint=False,
        )

        assert not Path(config.checkpoint_file).exists()

    async def test_a_batch_checkpoint_that_cannot_be_written_does_not_end_the_run(
        self, mocker, tmp_path: Path
    ) -> None:
        config = self._config(tmp_path)
        self._batch_fakes(mocker, {"111": [self._gene()]})
        mocker.patch("pipeline.main.checkpoint.append", side_effect=OSError("full"))

        batch = await pipeline_main._process_new_pmids_via_batch(
            ["111"], PipelineMetrics(), config, MagicMock()
        )

        assert [r.pmid for r in batch.successful_results] == ["111"]

    async def test_a_checkpoint_that_cannot_be_written_does_not_end_the_run(
        self, mocker, tmp_path: Path
    ) -> None:
        # Losing the safety net is not worse than never having had one, so a
        # full disk must not take the extraction down with it.
        config = self._config(tmp_path)
        mocker.patch(
            "pipeline.main.checkpoint.append", side_effect=OSError("disk full")
        )
        warning = mocker.patch("pipeline.main.logger.warning")
        finished = PaperResult(pmid="222", source="pmc", fulltext=True)

        async def fake(pmids, metrics, *, config, rate_limiter, on_complete=None):
            assert on_complete is not None, "checkpointing was not wired up"
            on_complete(finished, PipelineMetrics())
            return [finished]

        mocker.patch("pipeline.main.process_papers_concurrently", new=fake)

        batch = await pipeline_main._process_new_pmids(
            ["222"], PipelineMetrics(), config, AsyncMock(), MagicMock()
        )

        assert [r.pmid for r in batch.results] == ["222"]
        assert any("Could not checkpoint" in c.args[0] for c in warning.call_args_list)

    async def _run(
        self,
        mocker,
        config: PipelineConfig,
        *,
        dry_run: bool,
        batch: _ProcessedBatch | None = None,
    ):
        mocker.patch(
            "pipeline.main._discover_new_pmids",
            new=AsyncMock(return_value=(["111"], ["111"])),
        )
        process = mocker.patch(
            "pipeline.main._process_new_pmids",
            new=AsyncMock(return_value=batch or _ProcessedBatch([], [])),
        )
        mocker.patch(
            "pipeline.main._merge_processed_batch",
            new=AsyncMock(return_value={"inserted": 0, "updated": 0}),
        )
        mocker.patch("pipeline.main._build_pubmed_report", return_value={})
        mocker.patch("pipeline.main._complete_pubmed_run", new=AsyncMock())
        for name in (
            "_close_metadata_client",
            "close_http_client",
            "close_validation_client",
            "close_async_client",
        ):
            mocker.patch(f"pipeline.main.{name}", new=AsyncMock())
        mocker.patch("pipeline.main.europepmc.close_http_client", new=AsyncMock())
        mocker.patch("pipeline.main.Database.close", new=AsyncMock())
        mocker.patch("pipeline.main.clear_gene_cache")

        await pipeline_main.run_pipeline(
            days_back=7, dry_run=dry_run, config=config, manage_lifecycle=False
        )
        return process

    async def test_the_checkpoint_is_pruned_of_the_papers_recorded(
        self, mocker, tmp_path: Path
    ) -> None:
        # After the merge the PMIDs are in pubmed_refs, which is the durable
        # record, so their records go. Only theirs: the file is not cleared
        # outright, because a wider run's papers may still be waiting in it
        # (see tests/pipeline/test_run_accounting.py).
        config = self._config(tmp_path)
        self._checkpoint_one(config, "111")
        merged = PaperResult(pmid="111", genes=[self._gene()], source="pmc")

        process = await self._run(
            mocker,
            config,
            dry_run=False,
            batch=_ProcessedBatch([merged], []),
        )

        assert process.await_args.kwargs["use_checkpoint"] is True
        assert not Path(config.checkpoint_file).exists()

    async def test_a_dry_run_neither_writes_nor_clears_the_checkpoint(
        self, mocker, tmp_path: Path
    ) -> None:
        # A dry run merges nothing, so it never earns the right to delete a
        # real run's saved work -- and must not leave its own behind either.
        config = self._config(tmp_path)
        self._checkpoint_one(config, "111")

        process = await self._run(mocker, config, dry_run=True)

        assert process.await_args.kwargs["use_checkpoint"] is False
        assert Path(config.checkpoint_file).exists()

    async def test_an_undecodable_record_is_dropped_and_the_paper_retried(
        self, mocker, tmp_path: Path
    ) -> None:
        # The fingerprint pins the extraction method, not the shape of
        # GeneEntry, so a schema change can leave records this build cannot
        # read. Re-extracting one paper beats failing the run.
        config = self._config(tmp_path)
        checkpoint.append(
            config.checkpoint_file,
            checkpoint.fingerprint(config),
            {"result": {"pmid": "111", "genes": [{"nonsense": True}]}, "metrics": {}},
        )
        concurrent = mocker.patch(
            "pipeline.main.process_papers_concurrently",
            new=AsyncMock(return_value=[PaperResult(pmid="111", source="abstract")]),
        )

        batch = await pipeline_main._process_new_pmids(
            ["111"], PipelineMetrics(), config, AsyncMock(), MagicMock()
        )

        assert concurrent.await_args.args[0] == ["111"]
        assert [r.pmid for r in batch.results] == ["111"]


class TestDiscoveryAndCompletion:
    async def test_missing_pubmed_table_is_treated_as_first_run(self, mocker) -> None:
        progress = MagicMock()
        mocker.patch(
            "pipeline.main.search_recent_papers",
            new=AsyncMock(return_value=["123"]),
        )
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new=AsyncMock(side_effect=asyncpg.UndefinedTableError("missing")),
        )

        all_pmids, new_pmids = await pipeline_main._discover_new_pmids(
            7, dry_run=False, test_mode=False, progress=progress
        )

        assert all_pmids == ["123"]
        assert new_pmids == ["123"]

    @pytest.mark.parametrize("mode", ["dry_run", "test_mode"])
    async def test_a_preview_filters_already_processed_papers(
        self, mocker, mode: str
    ) -> None:
        # Both flags used to skip deduplication outright, so --test-mode
        # reported every paper in the window as new and --dry-run re-extracted
        # papers already in pubmed_refs at full price. Neither writes to the
        # database; reading from it is not a write.
        progress = MagicMock()
        mocker.patch(
            "pipeline.main.search_recent_papers",
            new=AsyncMock(return_value=["111", "222"]),
        )
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new=AsyncMock(return_value={"111"}),
        )

        all_pmids, new_pmids = await pipeline_main._discover_new_pmids(
            7,
            dry_run=mode == "dry_run",
            test_mode=mode == "test_mode",
            progress=progress,
        )

        assert all_pmids == ["111", "222"]
        assert new_pmids == ["222"]

    @pytest.mark.parametrize("mode", ["dry_run", "test_mode"])
    async def test_a_preview_survives_an_unreachable_database(
        self, mocker, mode: str
    ) -> None:
        # A preview has to keep working with no database at all -- that is
        # what it was for -- so a connection failure degrades to "nothing is
        # known to have been processed" rather than ending the run.
        progress = MagicMock()
        warning = mocker.patch("pipeline.main.logger.warning")
        mocker.patch(
            "pipeline.main.search_recent_papers",
            new=AsyncMock(return_value=["111"]),
        )
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new=AsyncMock(side_effect=ConnectionRefusedError("no server")),
        )

        all_pmids, new_pmids = await pipeline_main._discover_new_pmids(
            7,
            dry_run=mode == "dry_run",
            test_mode=mode == "test_mode",
            progress=progress,
        )

        assert new_pmids == ["111"]
        assert any("deduplication" in call.args[0] for call in warning.call_args_list)

    async def test_a_live_run_propagates_a_database_failure(self, mocker) -> None:
        # The tolerance above is scoped to previews. Swallowing this on a real
        # run would silently reprocess the entire window at full price.
        progress = MagicMock()
        mocker.patch(
            "pipeline.main.search_recent_papers",
            new=AsyncMock(return_value=["111"]),
        )
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new=AsyncMock(side_effect=ConnectionRefusedError("no server")),
        )

        with pytest.raises(ConnectionRefusedError):
            await pipeline_main._discover_new_pmids(
                7, dry_run=False, test_mode=False, progress=progress
            )

    def test_test_preview_reports_remaining_count(self, mocker) -> None:
        info = mocker.patch("pipeline.main.logger.info")
        pipeline_main._log_test_preview(
            ["1", "2", "3"], PipelineConfig(test_mode_preview_count=2)
        )

        assert any("... and 1 more" in call.args[0] for call in info.call_args_list)

    async def test_dry_completion_skips_persistence_and_notification(
        self, mocker
    ) -> None:
        finalize = mocker.patch("pipeline.main._finalize_run", new=AsyncMock())
        notify = mocker.patch("pipeline.main._record_and_notify", new=AsyncMock())
        progress = MagicMock()

        await pipeline_main._complete_pubmed_run(
            PipelineMetrics(),
            cast(PipelineRunData, {"timestamp": "now"}),
            PipelineConfig(),
            progress,
            dry_run=True,
            manage_lifecycle=False,
        )

        finalize.assert_not_awaited()
        notify.assert_not_awaited()
        progress.finalize.assert_not_called()

    async def test_empty_merge_reports_zeroed_counts_not_the_dry_run_sentinel(
        self, mocker
    ) -> None:
        """A real run that merges nothing is not a dry run.

        ``None`` is the report's dry-run sentinel (see
        ``report._print_database_panel``), so returning it when every gene
        was rejected made the summary print "no database writes" for a run
        that had just recorded its processed PMIDs.
        """
        mocker.patch("pipeline.main.reset_gene_sequence", new=AsyncMock())
        mocker.patch(
            "pipeline.main.record_processed_pmids_batch",
            new=AsyncMock(return_value=0),
        )
        batch = _ProcessedBatch(results=[], warnings=[])

        result = await pipeline_main._merge_processed_batch(
            batch, MagicMock(), PipelineConfig()
        )

        assert result is not None
        assert (result["inserted"], result["updated"]) == (0, 0)
        assert result.get("held_below_insert_floor") == []

    async def test_batch_prefetch_counts_fulltext(self, mocker) -> None:
        mocker.patch(
            "pipeline.main._fetch_paper_text_for_batch",
            new=AsyncMock(return_value=("paper text", True, "pmc")),
        )
        mocker.patch(
            "pipeline.main.submit_and_collect",
            new=AsyncMock(return_value={"123": []}),
        )
        metrics = PipelineMetrics()

        batch = await pipeline_main._process_new_pmids_via_batch(
            ["123"], metrics, PipelineConfig(), MagicMock()
        )

        assert metrics.fulltext_retrieved == 1
        assert batch.successful_results[0].source == "pmc"


class TestOfflineItemProcessing:
    async def test_local_pdf_empty_text_is_a_failed_result(
        self, tmp_path: Path, mocker
    ) -> None:
        pdf = tmp_path / "empty.pdf"
        pdf.touch()
        mocker.patch("pipeline.main.parse_local_pdf", return_value="")

        result = await pipeline_main._process_local_pdf_file(
            pdf,
            PipelineMetrics(),
            PipelineConfig(),
            MagicMock(),
            skip_validation=False,
        )

        assert result.error == "empty or corrupt PDF"
        assert result.pdf_parse_time >= 0

    async def test_local_pdf_success_updates_metrics(
        self, tmp_path: Path, make_gene_entry, mocker
    ) -> None:
        pdf = tmp_path / "paper.pdf"
        pdf.touch()
        gene = make_gene_entry()
        mocker.patch("pipeline.main.parse_local_pdf", return_value="paper text")
        extract = mocker.patch(
            "pipeline.main._extract_and_validate",
            new=AsyncMock(return_value=_outcome([gene])),
        )
        metrics = PipelineMetrics()

        result = await pipeline_main._process_local_pdf_file(
            pdf,
            metrics,
            PipelineConfig(),
            MagicMock(),
            skip_validation=True,
        )

        assert result.succeeded
        assert result.genes == [gene]
        assert result.source == "local_pdf"
        assert metrics.papers_processed == 1
        assert metrics.fulltext_retrieved == 1
        assert extract.await_args.kwargs["skip_validation"] is True

    async def test_local_pdf_exception_is_isolated(
        self, tmp_path: Path, mocker
    ) -> None:
        pdf = tmp_path / "broken.pdf"
        pdf.touch()
        mocker.patch(
            "pipeline.main.parse_local_pdf", side_effect=RuntimeError("bad PDF")
        )

        result = await pipeline_main._process_local_pdf_file(
            pdf,
            PipelineMetrics(),
            PipelineConfig(),
            MagicMock(),
            skip_validation=False,
        )

        assert result.error == "bad PDF"

    async def test_local_pdf_broken_docling_install_is_not_isolated(
        self, tmp_path: Path, mocker
    ) -> None:
        """parse_pdf_bytes re-raises ImportError; the caller must not eat it.

        Docling is a hard requirement, so a failed import is a broken
        environment and not a bad PDF -- every file in the directory would
        fail it, and recording one per-file error apiece reported a broken
        install as a corpus of unreadable papers.
        """
        pdf = tmp_path / "paper.pdf"
        pdf.touch()
        mocker.patch(
            "pipeline.main.parse_local_pdf",
            side_effect=ModuleNotFoundError("No module named 'docling'"),
        )

        with pytest.raises(ModuleNotFoundError, match="docling"):
            await pipeline_main._process_local_pdf_file(
                pdf,
                PipelineMetrics(),
                PipelineConfig(),
                MagicMock(),
                skip_validation=False,
            )

    async def test_pmid_without_text_is_processed_not_failed(self, mocker) -> None:
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new=AsyncMock(return_value={"doi": None}),
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new=AsyncMock(
                return_value={"text": None, "fulltext": False, "source": "none"}
            ),
        )

        metrics = PipelineMetrics()
        result = await pipeline_main._process_pmid_item(
            "123",
            metrics,
            PipelineConfig(),
            MagicMock(),
            skip_validation=False,
        )

        # Processed with source "none", as --pubmed's streaming and batch
        # paths already recorded it. This mode used to call it an error,
        # so `papers.failed` meant two different things depending on which
        # mode had run; `papers.noTextAvailable` counts the condition.
        assert result.error is None
        assert result.succeeded
        assert result.source == "none"
        assert result.fulltext is False
        assert metrics.papers_processed == 1
        assert metrics.fulltext_retrieved == 0
        assert metrics.abstract_only == 0

    @pytest.mark.parametrize("is_fulltext", [True, False])
    async def test_pmid_success_tracks_retrieval_mode(
        self, is_fulltext, make_gene_entry, mocker
    ) -> None:
        gene = make_gene_entry()
        source = "pmc" if is_fulltext else "abstract"
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new=AsyncMock(return_value={"doi": None}),
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new=AsyncMock(
                return_value={
                    "text": "paper text",
                    "fulltext": is_fulltext,
                    "source": source,
                }
            ),
        )
        mocker.patch(
            "pipeline.main._extract_and_validate",
            new=AsyncMock(return_value=_outcome([gene])),
        )
        metrics = PipelineMetrics()

        result = await pipeline_main._process_pmid_item(
            "123",
            metrics,
            PipelineConfig(),
            MagicMock(),
            skip_validation=True,
        )

        assert result.succeeded
        assert result.fulltext is is_fulltext
        assert metrics.fulltext_retrieved == int(is_fulltext)
        assert metrics.abstract_only == int(not is_fulltext)
        assert metrics.papers_processed == 1

    async def test_pmid_exception_is_isolated(self, mocker) -> None:
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new=AsyncMock(side_effect=RuntimeError("metadata broke")),
        )

        result = await pipeline_main._process_pmid_item(
            "123",
            PipelineMetrics(),
            PipelineConfig(),
            MagicMock(),
            skip_validation=False,
        )

        assert result.error == "metadata broke"


class TestSignalHandling:
    def test_handlers_cancel_the_pipeline_task(self, monkeypatch) -> None:
        loop = MagicMock()
        task = MagicMock()
        monkeypatch.setattr(pipeline_main.asyncio, "get_running_loop", lambda: loop)

        returned_loop, installed = pipeline_main._install_termination_handlers(task)

        assert returned_loop is loop
        assert signal.SIGTERM in installed
        _, callback, callback_signal = loop.add_signal_handler.call_args_list[0].args
        callback(callback_signal)
        task.cancel.assert_called_once_with()

    def test_unsupported_signal_handlers_are_skipped(
        self, monkeypatch
    ) -> None:
        loop = MagicMock()
        loop.add_signal_handler.side_effect = NotImplementedError
        monkeypatch.setattr(pipeline_main.asyncio, "get_running_loop", lambda: loop)
        monkeypatch.delattr(pipeline_main.signal, "SIGHUP")

        _, installed = pipeline_main._install_termination_handlers(MagicMock())

        assert installed == []

    def test_remove_signal_handlers_suppresses_platform_errors(self) -> None:
        loop = MagicMock()
        loop.remove_signal_handler.side_effect = NotImplementedError

        pipeline_main._remove_signal_handlers(loop, [signal.SIGTERM])

        loop.remove_signal_handler.assert_called_once_with(signal.SIGTERM)


def _run_recorder(row_id: int = 1) -> AsyncMock:
    """A `record_pipeline_run` stub that honours its `on_committed` contract.

    The real one calls the hook the instant the INSERT returns, which is
    what tells the run its row exists; a stub that only returns an id would
    let a test pass while the production flag was never set.
    """

    async def record(*_args, on_committed=None, **_kwargs) -> int:
        if on_committed is not None:
            on_committed()
        return row_id

    return AsyncMock(side_effect=record)


def _mock_pubmed_cleanup(mocker) -> dict[str, MagicMock]:
    return {
        "metadata": mocker.patch(
            "pipeline.main._close_metadata_client", new=AsyncMock()
        ),
        "europepmc": mocker.patch(
            "pipeline.main.europepmc.close_http_client", new=AsyncMock()
        ),
        "pdf": mocker.patch("pipeline.main.close_http_client", new=AsyncMock()),
        "validation": mocker.patch(
            "pipeline.main.close_validation_client", new=AsyncMock()
        ),
        "llm": mocker.patch("pipeline.main.close_async_client", new=AsyncMock()),
        "database": mocker.patch("pipeline.main.Database.close", new=AsyncMock()),
        "cache": mocker.patch("pipeline.main.clear_gene_cache"),
    }


class TestRunPipelineBranches:
    async def test_dry_run_builds_report_without_merging(self, mocker) -> None:
        _mock_pubmed_cleanup(mocker)
        mocker.patch(
            "pipeline.main._install_termination_handlers",
            return_value=(MagicMock(), []),
        )
        mocker.patch("pipeline.main._remove_signal_handlers")
        mocker.patch(
            "pipeline.main._discover_new_pmids",
            new=AsyncMock(return_value=(["123"], ["123"])),
        )
        batch = _ProcessedBatch(
            results=[PaperResult(pmid="123")],
            warnings=[],
        )
        mocker.patch(
            "pipeline.main._process_new_pmids", new=AsyncMock(return_value=batch)
        )
        merge = mocker.patch(
            "pipeline.main._merge_processed_batch", new=AsyncMock()
        )
        run_data = {"timestamp": "now"}
        mocker.patch("pipeline.main._build_pubmed_report", return_value=run_data)
        complete = mocker.patch(
            "pipeline.main._complete_pubmed_run", new=AsyncMock()
        )

        _, returned_data = await pipeline_main.run_pipeline(
            dry_run=True, manage_lifecycle=False
        )

        assert returned_data is run_data
        merge.assert_not_awaited()
        assert complete.await_args.kwargs["dry_run"] is True

    async def test_pipeline_failure_writes_error_and_cleans_up(
        self, tmp_path: Path, mocker
    ) -> None:
        cleanup = _mock_pubmed_cleanup(mocker)
        mocker.patch(
            "pipeline.main._install_termination_handlers",
            return_value=(MagicMock(), []),
        )
        mocker.patch("pipeline.main._remove_signal_handlers")
        mocker.patch(
            "pipeline.main._discover_new_pmids",
            new=AsyncMock(side_effect=RuntimeError("search broke")),
        )
        # The failure path calls _record_failed_run, which reaches
        # record_pipeline_run for real. Left unmocked it opened whatever
        # database DB_* named and inserted a row of zeros -- silently, since
        # _record_failed_run swallows. See test_database_integration.py for
        # the same path against a container.
        record = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )
        config = PipelineConfig(progress_file=str(tmp_path / "progress.json"))

        with pytest.raises(RuntimeError, match="search broke"):
            await pipeline_main.run_pipeline(
                config=config, manage_lifecycle=False
            )

        payload = json.loads(Path(config.progress_file).read_text())
        assert payload["status"] == "error"
        assert "search broke" in payload["error_message"]
        cleanup["database"].assert_not_awaited()
        cleanup["cache"].assert_called_once_with()
        assert record.await_args.kwargs["status"] == "failed"


class TestOfflinePipelineRunners:
    async def test_local_pdf_runner_reports_and_cleans_up(
        self, tmp_path: Path, mocker
    ) -> None:
        pdf = tmp_path / "paper.pdf"
        pdf.touch()
        result = PaperResult(pmid="paper", fulltext=True, source="local_pdf")
        process = mocker.patch(
            "pipeline.main._process_local_pdf_file",
            new=AsyncMock(return_value=result),
        )
        build = mocker.patch(
            "pipeline.main.build_local_pdf_run_data",
            return_value={"timestamp": "now"},
        )
        emit = mocker.patch("pipeline.main._emit_report")
        notify = mocker.patch("pipeline.main._record_and_notify", new=AsyncMock())
        close_validation = mocker.patch(
            "pipeline.main.close_validation_client", new=AsyncMock()
        )
        close_llm = mocker.patch("pipeline.main.close_async_client", new=AsyncMock())
        close_db = mocker.patch("pipeline.main.Database.close", new=AsyncMock())
        clear = mocker.patch("pipeline.main.clear_gene_cache")

        await pipeline_main.run_local_pdf_pipeline(pdf, skip_validation=True)

        process.assert_awaited_once()
        assert process.await_args.kwargs["skip_validation"] is True
        build.assert_called_once()
        emit.assert_called_once_with({"timestamp": "now"})
        notify.assert_awaited_once()
        close_validation.assert_awaited_once()
        close_llm.assert_awaited_once()
        close_db.assert_awaited_once()
        clear.assert_called_once_with()

    async def test_pmid_runner_reports_and_cleans_up(
        self, tmp_path: Path, mocker
    ) -> None:
        pmid_file = tmp_path / "pmids.txt"
        pmid_file.write_text("123\n456\n")
        process = mocker.patch(
            "pipeline.main._process_pmid_item",
            new=AsyncMock(
                side_effect=[PaperResult(pmid="123"), PaperResult(pmid="456")]
            ),
        )
        build = mocker.patch(
            "pipeline.main.build_pmid_run_data",
            return_value={"timestamp": "now"},
        )
        emit = mocker.patch("pipeline.main._emit_report")
        notify = mocker.patch("pipeline.main._record_and_notify", new=AsyncMock())
        cleanup = _mock_pubmed_cleanup(mocker)

        await pipeline_main.run_pmid_pipeline(pmid_file, skip_validation=False)

        assert process.await_count == 2
        build.assert_called_once()
        emit.assert_called_once_with({"timestamp": "now"})
        notify.assert_awaited_once()
        for name in ("metadata", "europepmc", "pdf", "validation", "llm", "database"):
            cleanup[name].assert_awaited_once()
        cleanup["cache"].assert_called_once_with()


class TestExternalSyncAndDispatcher:
    async def test_external_sync_summarizes_errors_and_manages_pool(
        self, mocker
    ) -> None:
        result = ExternalDataSyncResult(
            ncbi_fetched=1,
            uniprot_cached=2,
            pubmed_failed=1,
            errors=["PubMed failed"],
        )
        sync = mocker.patch(
            "pipeline.external_data_sync.sync_all_external_data",
            new=AsyncMock(return_value=result),
        )
        close = mocker.patch("pipeline.main.Database.close", new=AsyncMock())

        summary = await pipeline_main.run_external_data_sync()

        # One PMID that would not fetch is not a failed refresh: the sync
        # carried on and wrote the rest. Only `aborted` is red.
        assert summary["status"] == "warnings"
        assert summary["metrics"]["ncbi_fetched"] == 1
        assert "aborted" not in summary["metrics"]
        assert summary["errors"] == ["PubMed failed"]
        sync.assert_awaited_once()
        close.assert_awaited_once()

    async def test_external_sync_can_leave_pool_open(self, mocker) -> None:
        mocker.patch(
            "pipeline.external_data_sync.sync_all_external_data",
            new=AsyncMock(return_value=ExternalDataSyncResult()),
        )
        close = mocker.patch("pipeline.main.Database.close", new=AsyncMock())

        summary = await pipeline_main.run_external_data_sync(
            PipelineConfig(), manage_lifecycle=False
        )

        assert summary["status"] == "ok"
        close.assert_not_awaited()

    async def test_summary_pipeline_converts_exception_to_failure(self) -> None:
        async def fail() -> dict:
            raise RuntimeError("sync exploded")

        summary = await pipeline_main._run_summary_pipeline(
            fail(), "external_sync", "External sync"
        )

        assert summary == {
            "name": "external_sync",
            "status": "failed",
            "metrics": {},
            "errors": ["sync exploded"],
        }

    async def test_dispatcher_runs_external_sync_and_notifies(self, mocker) -> None:
        external = mocker.patch(
            "pipeline.main.run_external_data_sync",
            new=AsyncMock(
                return_value={
                    "name": "external_sync",
                    "status": "ok",
                    "metrics": {},
                    "errors": [],
                }
            ),
        )
        notify = mocker.patch(
            "pipeline.main._record_and_notify", new=AsyncMock()
        )
        mocker.patch("pipeline.main.close_async_client", new=AsyncMock())
        mocker.patch("pipeline.main.Database.close", new=AsyncMock())

        exit_code = await pipeline_main._run_selected_pipelines(
            _dispatcher_args(sync_external_data=True), PipelineConfig()
        )

        assert exit_code == 0
        external.assert_awaited_once()
        assert external.await_args.kwargs["manage_lifecycle"] is False
        notify.assert_awaited_once()

    async def test_pubmed_early_exit_emits_no_notification(self, mocker) -> None:
        mocker.patch(
            "pipeline.main.run_pipeline",
            new=AsyncMock(return_value=(PipelineMetrics(), None)),
        )
        notify = mocker.patch(
            "pipeline.main._record_and_notify", new=AsyncMock()
        )
        mocker.patch("pipeline.main.close_async_client", new=AsyncMock())
        mocker.patch("pipeline.main.Database.close", new=AsyncMock())

        exit_code = await pipeline_main._run_selected_pipelines(
            _dispatcher_args(pubmed=True), PipelineConfig()
        )

        assert exit_code == 0
        notify.assert_not_awaited()


class TestMainCli:
    def test_local_pdf_mode_dispatches(
        self, tmp_path: Path, monkeypatch, mocker
    ) -> None:
        pdf = tmp_path / "paper.pdf"
        pdf.touch()
        run = mocker.patch(
            "pipeline.main.run_local_pdf_pipeline", new=AsyncMock()
        )
        monkeypatch.setattr(
            pipeline_main.sys, "argv", ["pipeline", "--local-pdfs", str(pdf)]
        )

        pipeline_main.main()

        run.assert_awaited_once()
        assert run.await_args.kwargs["pdf_dir"] == pdf

    def test_pmid_mode_dispatches(self, tmp_path: Path, monkeypatch, mocker) -> None:
        pmids = tmp_path / "pmids.txt"
        pmids.write_text("123\n")
        run = mocker.patch("pipeline.main.run_pmid_pipeline", new=AsyncMock())
        monkeypatch.setattr(
            pipeline_main.sys,
            "argv",
            ["pipeline", "--pmids", str(pmids), "--skip-validation"],
        )

        pipeline_main.main()

        run.assert_awaited_once()
        assert run.await_args.kwargs["pmid_file"] == pmids
        assert run.await_args.kwargs["skip_validation"] is True

    def test_online_failure_uses_nonzero_exit(self, monkeypatch, mocker) -> None:
        mocker.patch(
            "pipeline.main._run_selected_pipelines",
            new=AsyncMock(return_value=1),
        )
        monkeypatch.setattr(
            pipeline_main.sys, "argv", ["pipeline", "--clinical-trials"]
        )

        with pytest.raises(SystemExit) as exc_info:
            pipeline_main.main()

        assert exc_info.value.code == 1

    def test_online_success_returns_normally(self, monkeypatch, mocker) -> None:
        run = mocker.patch(
            "pipeline.main._run_selected_pipelines",
            new=AsyncMock(return_value=0),
        )
        monkeypatch.setattr(
            pipeline_main.sys, "argv", ["pipeline", "--clinical-trials"]
        )

        pipeline_main.main()

        run.assert_awaited_once()

    def test_argument_error_uses_exit_one(
        self, tmp_path: Path, monkeypatch, mocker
    ) -> None:
        pdf = tmp_path / "paper.pdf"
        run = mocker.patch(
            "pipeline.main.run_local_pdf_pipeline",
            new=AsyncMock(side_effect=ValueError("not a PDF")),
        )
        monkeypatch.setattr(
            pipeline_main.sys, "argv", ["pipeline", "--local-pdfs", str(pdf)]
        )

        with pytest.raises(SystemExit) as exc_info:
            pipeline_main.main()

        assert exc_info.value.code == 1
        run.assert_awaited_once()

    def test_keyboard_interrupt_uses_exit_130(self, monkeypatch, mocker) -> None:
        mocker.patch(
            "pipeline.main._run_selected_pipelines",
            new=AsyncMock(side_effect=KeyboardInterrupt),
        )
        monkeypatch.setattr(pipeline_main.sys, "argv", ["pipeline"])

        with pytest.raises(SystemExit) as exc_info:
            pipeline_main.main()

        assert exc_info.value.code == 130


class TestAnnotationSyncWrapperAndDispatcher:
    async def test_annotation_sync_summarizes_errors_and_manages_pool(
        self, mocker
    ) -> None:
        from pipeline.external_data_sync import AnnotationSyncResult

        result = AnnotationSyncResult(
            clinvar_fetched=61,
            orphadata_cached=2,
            opentargets_failed=1,
            drugs_written=11,
            errors=["Open Targets fetch failed: FOXF2"],
        )
        sync = mocker.patch(
            "pipeline.external_data_sync.sync_all_annotations",
            new=AsyncMock(return_value=result),
        )
        close = mocker.patch("pipeline.main.Database.close", new=AsyncMock())

        summary = await pipeline_main.run_annotation_sync()

        assert summary["name"] == "annotation_sync"
        assert summary["status"] == "warnings"
        assert summary["metrics"]["clinvar_fetched"] == 61
        assert summary["metrics"]["drugs_written"] == 11
        assert summary["errors"] == ["Open Targets fetch failed: FOXF2"]
        sync.assert_awaited_once()
        close.assert_awaited_once()

    async def test_annotation_sync_can_leave_pool_open(self, mocker) -> None:
        from pipeline.external_data_sync import AnnotationSyncResult

        mocker.patch(
            "pipeline.external_data_sync.sync_all_annotations",
            new=AsyncMock(return_value=AnnotationSyncResult()),
        )
        close = mocker.patch("pipeline.main.Database.close", new=AsyncMock())

        summary = await pipeline_main.run_annotation_sync(
            PipelineConfig(), manage_lifecycle=False
        )

        assert summary["status"] == "ok"
        close.assert_not_awaited()

    async def test_dispatcher_runs_annotation_sync_and_notifies(self, mocker) -> None:
        annotations = mocker.patch(
            "pipeline.main.run_annotation_sync",
            new=AsyncMock(
                return_value={
                    "name": "annotation_sync",
                    "status": "ok",
                    "metrics": {},
                    "errors": [],
                }
            ),
        )
        notify = mocker.patch("pipeline.main._record_and_notify", new=AsyncMock())
        mocker.patch("pipeline.main.close_async_client", new=AsyncMock())
        mocker.patch("pipeline.main.Database.close", new=AsyncMock())

        exit_code = await pipeline_main._run_selected_pipelines(
            _dispatcher_args(sync_annotations=True), PipelineConfig()
        )

        assert exit_code == 0
        annotations.assert_awaited_once()
        assert annotations.await_args.kwargs["manage_lifecycle"] is False
        notify.assert_awaited_once()

    def test_the_flag_is_an_online_mode(self) -> None:
        """Without this, --sync-annotations alone falls through to --pubmed.

        _prepare_cli_args turns on the PubMed extraction whenever no mode is
        selected, so a flag missing from online_modes does not merely fail to
        run -- it silently runs the LLM pipeline instead.
        """
        parser = pipeline_main._build_parser()
        args = pipeline_main._prepare_cli_args(
            parser, parser.parse_args(["--sync-annotations"])
        )

        assert args.sync_annotations is True
        assert args.pubmed is False


class TestTransientFailuresAreRetryable:
    """A paper is recorded as processed only when it was actually processed.

    `pubmed_refs` is what stops a paper from being looked at again, so a
    transient failure must never reach it. Two did: a retrieval failure on
    the abstract fallback read as "no text available", and an NCBI outage
    during validation read as every gene being unknown.
    """

    async def test_an_ncbi_outage_fails_the_paper_rather_than_its_genes(
        self, make_gene_entry, mocker
    ) -> None:
        from pipeline.validation import NcbiUnavailableError

        genes = [make_gene_entry(gene_symbol="NOTCH3"), make_gene_entry()]
        mocker.patch(
            "pipeline.main.validate_gene_entry",
            new=AsyncMock(side_effect=NcbiUnavailableError("NCBI down")),
        )
        with pytest.raises(NcbiUnavailableError):
            await pipeline_main._validate_genes(
                genes, PipelineMetrics(), PipelineConfig()
            )

    async def test_an_ordinary_validation_error_still_rejects_only_that_gene(
        self, make_gene_entry, mocker
    ) -> None:
        genes = [make_gene_entry(gene_symbol="NOTCH3")]
        mocker.patch(
            "pipeline.main.validate_gene_entry",
            new=AsyncMock(side_effect=RuntimeError("parser broke")),
        )
        validated, rejected = await pipeline_main._validate_genes(
            genes, PipelineMetrics(), PipelineConfig()
        )
        assert validated == []
        assert rejected[0].reasons == ["parser broke"]

    async def test_batch_mode_isolates_an_ncbi_outage_to_the_paper(
        self, make_gene_entry, mocker, tmp_path
    ) -> None:
        from pipeline.validation import NcbiUnavailableError

        mocker.patch(
            "pipeline.main._fetch_paper_text_for_batch",
            new=AsyncMock(return_value=("text", True, "europepmc")),
        )
        mocker.patch(
            "pipeline.main.submit_and_collect",
            new=AsyncMock(
                return_value={
                    "111": [make_gene_entry(gene_symbol="NOTCH3")],
                    "222": [make_gene_entry(gene_symbol="HTRA1")],
                }
            ),
        )
        async def _validate(genes, metrics, config):
            if genes[0].gene_symbol == "NOTCH3":
                raise NcbiUnavailableError("NCBI down")
            return genes, []

        mocker.patch("pipeline.main._validate_genes", new=_validate)
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )

        batch = await pipeline_main._process_new_pmids_via_batch(
            ["111", "222"], PipelineMetrics(), PipelineConfig(), reporter
        )

        by_pmid = {r.pmid: r for r in batch.results}
        assert by_pmid["111"].error == "NCBI down"
        assert by_pmid["222"].succeeded
        assert [r.pmid for r in batch.successful_results] == ["222"]


class TestMetricsCountWhatHappened:
    async def test_fulltext_is_counted_only_when_the_paper_was_processed(
        self, mocker
    ) -> None:
        # Retrieval was counted before extraction ran, so three full texts
        # and two extraction failures published a "300%" full-text rate.
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new=AsyncMock(return_value={"doi": None}),
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new=AsyncMock(
                return_value={"text": "t", "source": "europepmc", "fulltext": True}
            ),
        )
        mocker.patch(
            "pipeline.main._extract_and_validate",
            new=AsyncMock(side_effect=ExtractionFailedError("provider failed")),
        )
        metrics = PipelineMetrics()
        with pytest.raises(ExtractionFailedError):
            await pipeline_main.process_paper("111", metrics, PipelineConfig())
        assert metrics.fulltext_retrieved == 0
        assert metrics.abstract_only == 0

    async def test_batch_mode_counts_retrieval_only_for_papers_with_a_result(
        self, mocker, tmp_path
    ) -> None:
        mocker.patch(
            "pipeline.main._fetch_paper_text_for_batch",
            new=AsyncMock(return_value=("text", True, "europepmc")),
        )
        mocker.patch(
            "pipeline.main.submit_and_collect",
            new=AsyncMock(return_value={"222": []}),
        )
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        metrics = PipelineMetrics()

        await pipeline_main._process_new_pmids_via_batch(
            ["111", "222"], metrics, PipelineConfig(), reporter
        )

        assert metrics.papers_processed == 1
        assert metrics.fulltext_retrieved == 1

    async def test_batch_mode_accounts_token_usage(self, mocker, tmp_path) -> None:
        # The batch path never touched metrics.token_usage, so a --batch
        # run published zero tokens and $0.00 for real spend.
        mocker.patch(
            "pipeline.main._fetch_paper_text_for_batch",
            new=AsyncMock(return_value=("text", True, "europepmc")),
        )

        async def _collect(papers, config, *, usage):
            usage.input_tokens += 1000
            usage.output_tokens += 200
            usage.truncated_responses += 1
            return {"111": []}

        mocker.patch("pipeline.main.submit_and_collect", new=_collect)
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        metrics = PipelineMetrics()

        await pipeline_main._process_new_pmids_via_batch(
            ["111"], metrics, PipelineConfig(), reporter
        )

        assert metrics.token_usage.total_tokens == 1200
        step = reporter.steps()[2]
        assert any(w.kind == "model_truncated" for w in step.warnings)

    async def test_the_merge_applies_the_run_config(self, mocker) -> None:
        # The insert floor came from a fresh PipelineConfig() while the
        # report named the run's own, so a programmatic override was
        # reported but not applied.
        mocker.patch("pipeline.main.reset_gene_sequence", new=AsyncMock())
        merge = mocker.patch(
            "pipeline.main.merge_gene_entries",
            new=AsyncMock(return_value={"inserted": 0, "updated": 0}),
        )
        mocker.patch(
            "pipeline.main.record_processed_pmids_batch",
            new=AsyncMock(return_value=0),
        )
        config = PipelineConfig(confidence_threshold_insert=0.8)
        batch = _ProcessedBatch(results=[], warnings=[])

        await pipeline_main._merge_processed_batch(batch, MagicMock(), config)

        assert merge.await_args.args[1] is config


class TestFailedRunsAreRecordedHonestly:
    async def test_a_test_mode_failure_records_nothing(self, tmp_path, mocker):
        # --test-mode is documented as touching no database, and its
        # discovery step skips even the read of pubmed_refs; but the failure
        # path gated on dry_run only, so a smoke test with the network down
        # inserted a real failed row, which the export publishes.
        _mock_pubmed_cleanup(mocker)
        mocker.patch(
            "pipeline.main._install_termination_handlers",
            return_value=(MagicMock(), []),
        )
        mocker.patch("pipeline.main._remove_signal_handlers")
        mocker.patch(
            "pipeline.main.search_recent_papers",
            new=AsyncMock(side_effect=RuntimeError("no network")),
        )
        record = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )
        config = PipelineConfig(progress_file=str(tmp_path / "progress.json"))

        with pytest.raises(RuntimeError, match="no network"):
            await pipeline_main.run_pipeline(
                config=config, test_mode=True, manage_lifecycle=False
            )

        record.assert_not_awaited()

    async def test_a_failed_run_carries_its_duration_and_spend(
        self, tmp_path, mocker
    ) -> None:
        from pipeline.api_telemetry import reset_recorder

        reset_recorder()
        recorded = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        reporter.report(4)
        metrics = PipelineMetrics(papers_processed=9)
        metrics.token_usage.input_tokens = 1_000_000
        metrics.token_usage.output_tokens = 100_000
        mocker.patch("pipeline.main.time.monotonic", return_value=1_000.0)

        await pipeline_main._record_failed_run(
            metrics, reporter, dry_run=False, started_at=400.0, config=PipelineConfig()
        )

        kwargs = recorded.await_args.kwargs
        assert kwargs["duration_seconds"] == 600.0
        tokens = kwargs["report"]["tokens"]
        assert tokens["inputTokens"] == 1_000_000
        assert tokens["estimatedCostUsd"] > 0

    async def test_a_failure_after_the_run_was_recorded_adds_no_second_row(
        self, tmp_path, mocker
    ) -> None:
        # With manage_lifecycle=True the notification runs after the
        # completed row is written; a notification error then wrote a
        # second, failed, row for the same run, and the export publishes
        # the newest.
        _mock_pubmed_cleanup(mocker)
        mocker.patch(
            "pipeline.main._install_termination_handlers",
            return_value=(MagicMock(), []),
        )
        mocker.patch("pipeline.main._remove_signal_handlers")
        mocker.patch(
            "pipeline.main._discover_new_pmids",
            new=AsyncMock(return_value=(["123"], ["123"])),
        )
        batch = _ProcessedBatch(
            results=[PaperResult(pmid="123")],
            warnings=[],
        )
        mocker.patch(
            "pipeline.main._process_new_pmids", new=AsyncMock(return_value=batch)
        )
        mocker.patch(
            "pipeline.main._merge_processed_batch",
            new=AsyncMock(return_value={"inserted": 0, "updated": 0}),
        )
        mocker.patch(
            "pipeline.main._build_pubmed_report",
            return_value={"timestamp": "2026-09-01T00:00:00+00:00"},
        )
        mocker.patch("pipeline.main.build_run_report")
        record = mocker.patch(
            "pipeline.main.record_pipeline_run", new=_run_recorder()
        )
        mocker.patch(
            "pipeline.main._record_and_notify",
            new=AsyncMock(side_effect=RuntimeError("sqlite locked")),
        )
        config = PipelineConfig(progress_file=str(tmp_path / "progress.json"))

        with pytest.raises(RuntimeError, match="sqlite locked"):
            await pipeline_main.run_pipeline(config=config, manage_lifecycle=True)

        record.assert_awaited_once()

    async def test_a_cancellation_releasing_the_connection_adds_no_second_row(
        self, tmp_path, mocker
    ) -> None:
        # The INSERT commits inside record_pipeline_run, but handing the
        # pooled connection back is a further await: a SIGTERM landing there
        # used to leave `run_recorded` False, so a run whose every write had
        # succeeded published a second, `failed` row -- and --export
        # publishes the newest, so the widget called the run failed and the
        # About page's date stayed put.
        _mock_pubmed_cleanup(mocker)
        mocker.patch(
            "pipeline.main._install_termination_handlers",
            return_value=(MagicMock(), []),
        )
        mocker.patch("pipeline.main._remove_signal_handlers")
        mocker.patch(
            "pipeline.main._discover_new_pmids",
            new=AsyncMock(return_value=(["123"], ["123"])),
        )
        mocker.patch(
            "pipeline.main._process_new_pmids",
            new=AsyncMock(
                return_value=_ProcessedBatch(
                    results=[PaperResult(pmid="123")], warnings=[]
                )
            ),
        )
        mocker.patch(
            "pipeline.main._merge_processed_batch",
            new=AsyncMock(return_value={"inserted": 1, "updated": 0}),
        )
        mocker.patch(
            "pipeline.main._build_pubmed_report",
            return_value={"timestamp": "2026-09-01T00:00:00+00:00"},
        )
        mocker.patch("pipeline.main.build_run_report")

        async def record(*_args, on_committed=None, **_kwargs) -> int:
            assert on_committed is not None, "the INSERT reports nothing"
            on_committed()
            raise asyncio.CancelledError

        record_mock = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(side_effect=record)
        )
        config = PipelineConfig(progress_file=str(tmp_path / "progress.json"))

        with pytest.raises(asyncio.CancelledError):
            await pipeline_main.run_pipeline(config=config, manage_lifecycle=True)

        record_mock.assert_awaited_once()


class TestDispatcherNotifiesOnFailure:
    async def test_a_failed_pubmed_only_run_is_notified(self, mocker) -> None:
        # The early-exit guard keyed on run_data being None, which is also
        # what a raised run leaves behind -- so the default, unattended
        # invocation was the one shape that reported its failure nowhere.
        mocker.patch(
            "pipeline.main.run_pipeline",
            new=AsyncMock(side_effect=RuntimeError("merge broke")),
        )
        notify = mocker.patch("pipeline.main._record_and_notify", new=AsyncMock())
        mocker.patch("pipeline.main.close_async_client", new=AsyncMock())
        mocker.patch("pipeline.main.Database.close", new=AsyncMock())

        exit_code = await pipeline_main._run_selected_pipelines(
            _dispatcher_args(pubmed=True), PipelineConfig()
        )

        assert exit_code == 1
        notify.assert_awaited_once()
        combined = notify.await_args.args[1]
        assert combined["pipelines"][0]["status"] == "failed"


class TestExportOnRun:
    """--export republishes data/*.json from the database after a run.

    Without it the database moves and the committed JSON does not, so the
    figures, the About page's date and the run widget all go stale until
    someone runs `deno task data` by hand.
    """

    @staticmethod
    def _ok_summary() -> dict:
        return {
            "name": "external_sync",
            "status": "ok",
            "metrics": {},
            "errors": [],
        }

    @pytest.fixture
    def dispatcher(self, mocker):
        """Patch the dispatcher's lifecycle and notification edges."""
        mocker.patch("pipeline.main._record_and_notify", new=AsyncMock())
        mocker.patch("pipeline.main.close_async_client", new=AsyncMock())
        mocker.patch("pipeline.main.Database.close", new=AsyncMock())
        return mocker.patch(
            "pipeline.export.main.run_export", new=AsyncMock()
        )

    async def test_a_successful_run_publishes_the_export(
        self, dispatcher, mocker
    ) -> None:
        mocker.patch(
            "pipeline.main.run_external_data_sync",
            new=AsyncMock(return_value=self._ok_summary()),
        )

        exit_code = await pipeline_main._run_selected_pipelines(
            _dispatcher_args(sync_external_data=True, export=True),
            PipelineConfig(),
        )

        assert exit_code == 0
        dispatcher.assert_awaited_once()

    async def test_the_export_is_off_by_default(self, dispatcher, mocker) -> None:
        mocker.patch(
            "pipeline.main.run_external_data_sync",
            new=AsyncMock(return_value=self._ok_summary()),
        )

        exit_code = await pipeline_main._run_selected_pipelines(
            _dispatcher_args(sync_external_data=True), PipelineConfig()
        )

        assert exit_code == 0
        dispatcher.assert_not_awaited()

    @pytest.mark.parametrize("preview", ["dry_run", "test_mode"])
    async def test_a_pubmed_preview_publishes_nothing(
        self, dispatcher, mocker, caplog, preview: str
    ) -> None:
        # A preview writes nothing to the database, so exporting would
        # republish the committed files unchanged.
        mocker.patch(
            "pipeline.main.run_pipeline",
            new=AsyncMock(return_value=(PipelineMetrics(), None)),
        )

        with caplog.at_level(logging.INFO):
            exit_code = await pipeline_main._run_selected_pipelines(
                _dispatcher_args(pubmed=True, export=True, **{preview: True}),
                PipelineConfig(),
            )

        assert exit_code == 0
        dispatcher.assert_not_awaited()
        assert "Skipping --export" in caplog.text

    async def test_a_failed_pipeline_still_publishes_the_export(
        self, dispatcher, mocker, caplog
    ) -> None:
        # _record_failed_run persists the failed run so the About page's
        # widget can report it. Skipping the export on failure is what would
        # keep that feature invisible.
        mocker.patch(
            "pipeline.main.run_pipeline",
            new=AsyncMock(side_effect=RuntimeError("merge broke")),
        )

        with caplog.at_level(logging.INFO):
            exit_code = await pipeline_main._run_selected_pipelines(
                _dispatcher_args(pubmed=True, export=True), PipelineConfig()
            )

        assert exit_code == 1
        dispatcher.assert_awaited_once()
        assert "Exporting despite failures in: pubmed" in caplog.text

    @pytest.mark.parametrize(
        "failure",
        [
            RuntimeError("Could not publish the export"),
            asyncpg.UndefinedColumnError("no such column"),
            DatabaseConfigError("Missing DB_HOST"),
            ValueError("1 validation error for PipelineRunReport"),
        ],
        ids=["runtime", "asyncpg", "config", "validation"],
    )
    async def test_a_failed_export_fails_an_otherwise_clean_run(
        self, dispatcher, mocker, caplog, failure: Exception
    ) -> None:
        # The database moved and the files did not -- the exact condition the
        # flag exists to remove -- so it must not pass silently, whatever
        # raised: only OSError and RuntimeError were caught, so a database
        # or validation error escaped without the diagnostic.
        mocker.patch(
            "pipeline.main.run_external_data_sync",
            new=AsyncMock(return_value=self._ok_summary()),
        )
        dispatcher.side_effect = failure

        with caplog.at_level(logging.ERROR):
            exit_code = await pipeline_main._run_selected_pipelines(
                _dispatcher_args(sync_external_data=True, export=True),
                PipelineConfig(),
            )

        assert exit_code == 1
        assert "behind the database" in caplog.text

    @staticmethod
    def _pubmed_run_data(genes: list[dict] | None = None) -> PipelineRunData:
        return cast(
            PipelineRunData,
            {
                "timestamp": "2026-09-01T00:00:00+00:00",
                "papers_detail": [
                    {
                        "pmid": "42999999",
                        "genes": (
                            [{"gene_symbol": "FOO"}] if genes is None else genes
                        ),
                    },
                    # A paper that yielded nothing attaches no reference, so
                    # the export never asks the citation cache about it.
                    {"pmid": "11111111", "genes": []},
                ],
            },
        )

    async def test_a_pubmed_export_caches_the_new_genes_and_references(
        self, dispatcher, mocker
    ) -> None:
        # Nothing in a PubMed run writes ncbi_gene_info, uniprot_info or
        # pubmed_citations, and the export completes a missing key into a
        # row of nulls -- so `--export` published the gene it had just
        # inserted with an empty tooltip and its reference as
        # "(citation not available)".
        mocker.patch(
            "pipeline.main.run_pipeline",
            new=AsyncMock(return_value=(PipelineMetrics(), self._pubmed_run_data())),
        )
        refresh = mocker.patch(
            "pipeline.external_data_sync.sync_external_data_for",
            new=AsyncMock(return_value=ExternalDataSyncResult()),
        )
        config = PipelineConfig()

        exit_code = await pipeline_main._run_selected_pipelines(
            _dispatcher_args(pubmed=True, export=True), config
        )

        assert exit_code == 0
        refresh.assert_awaited_once_with(["FOO"], ["42999999"], config=config)
        dispatcher.assert_awaited_once()

    async def test_the_curated_key_is_what_gets_cached(
        self, dispatcher, mocker, gene_aliases
    ) -> None:
        # The merge stores canonical_gene_symbol(...), so that is the key the
        # export asks the caches about; caching the extracted spelling would
        # leave the published row looking up nothing.
        mocker.patch(
            "pipeline.main.run_pipeline",
            new=AsyncMock(
                return_value=(
                    PipelineMetrics(),
                    self._pubmed_run_data(
                        [{"gene_symbol": "GENEA"}, {"gene_symbol": "GENEB"}]
                    ),
                )
            ),
        )
        refresh = mocker.patch(
            "pipeline.external_data_sync.sync_external_data_for",
            new=AsyncMock(return_value=ExternalDataSyncResult()),
        )

        await pipeline_main._run_selected_pipelines(
            _dispatcher_args(pubmed=True, export=True), PipelineConfig()
        )

        assert refresh.await_args.args[0] == ["GENEA/B"]

    async def test_a_run_that_added_no_gene_asks_for_nothing(
        self, dispatcher, mocker, caplog
    ) -> None:
        mocker.patch(
            "pipeline.main.run_pipeline",
            new=AsyncMock(
                return_value=(
                    PipelineMetrics(),
                    cast(
                        PipelineRunData,
                        {
                            "timestamp": "2026-09-01T00:00:00+00:00",
                            "papers_detail": [{"pmid": "1", "genes": []}],
                        },
                    ),
                )
            ),
        )
        refresh = mocker.patch(
            "pipeline.external_data_sync.sync_external_data_for",
            new=AsyncMock(return_value=ExternalDataSyncResult()),
        )

        with caplog.at_level(logging.INFO):
            await pipeline_main._run_selected_pipelines(
                _dispatcher_args(pubmed=True, export=True), PipelineConfig()
            )

        refresh.assert_not_awaited()
        assert "No new genes for the lookup caches" in caplog.text
        dispatcher.assert_awaited_once()

    async def test_the_full_sync_makes_the_keyed_refresh_redundant(
        self, dispatcher, mocker
    ) -> None:
        # --sync-external-data covers every row in the database, these
        # included; running the keyed refresh as well would fetch twice.
        mocker.patch(
            "pipeline.main.run_pipeline",
            new=AsyncMock(return_value=(PipelineMetrics(), self._pubmed_run_data())),
        )
        mocker.patch(
            "pipeline.main.run_external_data_sync",
            new=AsyncMock(return_value=self._ok_summary()),
        )
        refresh = mocker.patch(
            "pipeline.external_data_sync.sync_external_data_for",
            new=AsyncMock(return_value=ExternalDataSyncResult()),
        )

        await pipeline_main._run_selected_pipelines(
            _dispatcher_args(pubmed=True, sync_external_data=True, export=True),
            PipelineConfig(),
        )

        refresh.assert_not_awaited()
        dispatcher.assert_awaited_once()

    async def test_a_refresh_failure_is_reported_and_the_export_still_runs(
        self, dispatcher, mocker, caplog
    ) -> None:
        # The database has moved and the files have not, so the export has
        # to run -- but the rows it publishes for these genes carry nulls,
        # and that must not pass silently.
        mocker.patch(
            "pipeline.main.run_pipeline",
            new=AsyncMock(return_value=(PipelineMetrics(), self._pubmed_run_data())),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_external_data_for",
            new=AsyncMock(side_effect=RuntimeError("NCBI down")),
        )

        with caplog.at_level(logging.ERROR):
            exit_code = await pipeline_main._run_selected_pipelines(
                _dispatcher_args(pubmed=True, export=True), PipelineConfig()
            )

        assert exit_code == 0
        assert "without their metadata" in caplog.text
        dispatcher.assert_awaited_once()

    async def test_per_source_errors_name_what_is_missing(
        self, dispatcher, mocker, caplog
    ) -> None:
        mocker.patch(
            "pipeline.main.run_pipeline",
            new=AsyncMock(return_value=(PipelineMetrics(), self._pubmed_run_data())),
        )
        mocker.patch(
            "pipeline.external_data_sync.sync_external_data_for",
            new=AsyncMock(
                return_value=ExternalDataSyncResult(errors=["Gene not found: FOO"])
            ),
        )

        with caplog.at_level(logging.ERROR):
            await pipeline_main._run_selected_pipelines(
                _dispatcher_args(pubmed=True, export=True), PipelineConfig()
            )

        assert "Gene not found: FOO" in caplog.text

    @pytest.mark.parametrize("mode", ["--pmids", "--local-pdfs"])
    def test_the_offline_modes_reject_the_flag(self, tmp_path, mode: str) -> None:
        # They bypass _run_selected_pipelines entirely and publish no data, so
        # a warning would leave the caller believing the export ran.
        target = tmp_path / "input.txt"
        target.write_text("1\n")
        parser = pipeline_main._build_parser()

        with pytest.raises(SystemExit):
            pipeline_main._prepare_cli_args(
                parser, parser.parse_args([mode, str(target), "--export"])
            )


class TestCliEdges:
    @pytest.mark.parametrize(
        "argv",
        [["--dry-run"], ["--test-mode"], ["--batch"], ["--days-back", "30"]],
        ids=["dry-run", "test-mode", "batch", "days-back"],
    )
    def test_a_bare_pubmed_option_selects_pubmed_without_a_warning(
        self, caplog, argv: list[str]
    ) -> None:
        # The default selection used to be applied *after* the warning, so
        # `main.py --test-mode` announced that the preview was being ignored
        # and then previewed, and `main.py --batch` announced that --batch
        # was ignored and then submitted the window to the Batch API.
        parser = pipeline_main._build_parser()

        with caplog.at_level(logging.WARNING):
            args = pipeline_main._prepare_cli_args(parser, parser.parse_args(argv))

        assert args.pubmed is True
        assert "PubMed-only" not in caplog.text

    def test_another_online_pipeline_alone_still_warns(self, caplog) -> None:
        # --clinical-trials selects a pipeline, so --batch really is ignored.
        parser = pipeline_main._build_parser()

        with caplog.at_level(logging.WARNING):
            args = pipeline_main._prepare_cli_args(
                parser, parser.parse_args(["--clinical-trials", "--batch"])
            )

        assert args.pubmed is False
        assert "PubMed-only" in caplog.text

    def test_offline_modes_warn_about_pubmed_only_flags(self, tmp_path, caplog):
        parser = pipeline_main._build_parser()
        pmids = tmp_path / "p.txt"
        pmids.write_text("1\n")
        with caplog.at_level(logging.WARNING):
            pipeline_main._prepare_cli_args(
                parser, parser.parse_args(["--pmids", str(pmids), "--batch"])
            )
        assert "PubMed-only" in caplog.text

    def test_termination_exits_143_without_a_traceback(self, monkeypatch, mocker):
        # SIGTERM cancels the main task; asyncio.run re-raises the
        # CancelledError and nothing caught it, so a clean `systemctl stop`
        # printed a traceback and exited 1.
        mocker.patch(
            "pipeline.main._run_selected_pipelines",
            new=AsyncMock(side_effect=asyncio.CancelledError),
        )
        monkeypatch.setattr(pipeline_main.sys, "argv", ["pipeline"])

        with pytest.raises(SystemExit) as exc_info:
            pipeline_main.main()

        assert exc_info.value.code == 143

    def test_a_directory_of_upper_case_pdfs_is_found(self, tmp_path):
        (tmp_path / "SCAN.PDF").touch()
        _, files = pipeline_main._resolve_pdf_files(tmp_path)
        assert [f.name for f in files] == ["SCAN.PDF"]

    def test_progress_tmp_file_is_per_process(self, tmp_path):
        config = PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        pipeline_main._write_progress(
            config, status="running", stage="searching_pubmed", stage_number=1
        )
        assert not (tmp_path / "progress.tmp").exists()


class TestSmallBranches:
    async def test_process_paper_counts_an_abstract_only_success(
        self, make_gene_entry, mocker
    ) -> None:
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new=AsyncMock(return_value={"doi": None}),
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new=AsyncMock(
                return_value={"text": "paper", "fulltext": False, "source": "abstract"}
            ),
        )
        mocker.patch(
            "pipeline.main._extract_and_validate",
            new=AsyncMock(return_value=_outcome([make_gene_entry()])),
        )
        metrics = PipelineMetrics()

        await pipeline_main.process_paper("123", metrics, PipelineConfig())

        assert metrics.abstract_only == 1
        assert metrics.fulltext_retrieved == 0

    async def test_finalize_run_without_a_reporter(self, mocker) -> None:
        from pipeline.api_telemetry import reset_recorder

        reset_recorder()
        mocker.patch("pipeline.main.record_pipeline_run", new=_run_recorder())
        run_data = cast(
            PipelineRunData,
            {
                "timestamp": "2026-09-01T00:00:00+00:00",
                "total_processing_time": 1.0,
                "papers": {},
                "genes": {},
                "token_usage": {},
                "papers_detail": [],
            },
        )
        await pipeline_main._finalize_run(PipelineMetrics(), run_data, "standard")


class TestRefreshesAreRecorded:
    """`_run_summary_pipeline` is where all three syncs pass through, so it
    is where the refresh record is written.

    Until it was, the upstreams only the syncs touch reached no published
    file at all: `build_run_report` is reachable only from inside
    `run_pipeline`, so the API rows ClinVar, Orphadata and Open Targets
    recorded were dropped when the process ended.
    """

    async def test_a_refresh_writes_its_record(self, mocker) -> None:
        record = mocker.patch(
            "pipeline.main.record_sync_run", new=AsyncMock(return_value=1)
        )

        async def sync() -> dict:
            from pipeline.api_telemetry import current_recorder

            current_recorder().record(
                host="api.platform.opentargets.org",
                path="/api/v4/graphql",
                method="POST",
                status=200,
            )
            return {
                "name": "annotation_sync",
                "status": "ok",
                "metrics": {"clinvar_fetched": 3},
                "errors": [],
            }

        await pipeline_main._run_summary_pipeline(
            sync(), "annotation_sync", "Annotation sync"
        )

        record.assert_awaited_once()
        mode, _stamp, status, _duration, report = record.await_args[0]
        assert mode == "annotation_sync"
        assert status == "completed"
        # The whole point of the record: the provider is named.
        assert [row["label"] for row in report["apis"]] == ["Open Targets"]
        clinvar = next(s for s in report["sources"] if s["key"] == "clinvar")
        assert clinvar["fetched"] == 3

    async def test_a_skipped_refresh_records_nothing(self, mocker) -> None:
        # ct_enabled=False makes no calls and changes nothing, so there is
        # no refresh to report -- the reasoning that also keeps the offline
        # run modes out of pipeline_runs.
        record = mocker.patch("pipeline.main.record_sync_run", new=AsyncMock())

        async def skipped() -> dict:
            return {
                "name": "clinical_trials",
                "status": "skipped",
                "metrics": {"fetched": 0, "cached": 0, "failed": 0},
                "errors": [],
            }

        await pipeline_main._run_summary_pipeline(
            skipped(), "clinical_trials", "Clinical trials"
        )

        record.assert_not_awaited()

    async def test_the_recorder_is_reset_per_refresh(self, mocker) -> None:
        """The subtle one. The API recorder is module-level and reset only
        at the top of `run_pipeline`, so a `--pubmed --sync-annotations`
        invocation would otherwise publish the PubMed run's rows as the
        refresh's own.
        """
        from pipeline.api_telemetry import current_recorder, reset_recorder

        reset_recorder()
        current_recorder().record(
            host="api.anthropic.com",
            path="/v1/messages",
            method="POST",
            status=200,
        )
        record = mocker.patch(
            "pipeline.main.record_sync_run", new=AsyncMock(return_value=1)
        )

        async def sync() -> dict:
            from pipeline.api_telemetry import current_recorder as recorder

            recorder().record(
                host="api.orphadata.com",
                path="/rd-cross-referencing/orphacodes/166024",
                method="GET",
                status=200,
            )
            return {
                "name": "annotation_sync",
                "status": "ok",
                "metrics": {},
                "errors": [],
            }

        await pipeline_main._run_summary_pipeline(
            sync(), "annotation_sync", "Annotation sync"
        )

        report = record.await_args[0][4]
        assert [row["label"] for row in report["apis"]] == ["Orphadata"]

    async def test_a_failed_write_does_not_replace_the_refreshs_own_error(
        self, mocker, caplog
    ) -> None:
        # The database is often the thing that just failed; raising here
        # would swap the real error for one about recording it.
        mocker.patch(
            "pipeline.main.record_sync_run",
            new=AsyncMock(side_effect=RuntimeError("no such table")),
        )

        async def fail() -> dict:
            raise RuntimeError("orphadata exploded")

        summary = await pipeline_main._run_summary_pipeline(
            fail(), "annotation_sync", "Annotation sync"
        )

        assert summary["errors"] == ["orphadata exploded"]
        assert "Could not record the annotation_sync refresh" in caplog.text
