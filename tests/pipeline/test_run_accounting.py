"""A run's numbers reconcile, and a crash costs only the papers in flight.

The counts a failed run publishes have to add up the way a completed run's
do, a paper is either processed or it is not, and a checkpoint written by a
wider window survives a narrower run that merges only part of it.
"""

import asyncio
import sqlite3
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

import pipeline.main as pipeline_main
from pipeline import checkpoint
from pipeline.api_telemetry import reset_recorder
from pipeline.citations import current_tally, reset_tally
from pipeline.config import PipelineConfig
from pipeline.database import DatabaseConfigError
from pipeline.extraction_models import ExtractionFailedError, GeneEntry
from pipeline.main import PaperResult, _ProcessedBatch, _ProgressReporter
from pipeline.quality_metrics import PipelineMetrics, TokenUsage
from pipeline.validation import NcbiUnavailableError


def _gene(symbol: str = "NOTCH3", pmid: str = "111") -> GeneEntry:
    return GeneEntry(
        gene_symbol=symbol,
        confidence=0.9,
        source_quote="NOTCH3 mutations cause CADASIL.",
        pmid=pmid,
    )


def _config(tmp_path: Path) -> PipelineConfig:
    return PipelineConfig(
        checkpoint_file=str(tmp_path / "checkpoint.jsonl"),
        progress_file=str(tmp_path / "progress.json"),
    )


def _no_text(mocker) -> None:
    mocker.patch(
        "pipeline.main.fetch_paper_metadata", new=AsyncMock(return_value={"doi": None})
    )
    mocker.patch(
        "pipeline.main.get_fulltext",
        new=AsyncMock(return_value={"text": None, "fulltext": False, "source": "none"}),
    )


def _fulltext(mocker) -> None:
    mocker.patch(
        "pipeline.main.fetch_paper_metadata", new=AsyncMock(return_value={"doi": None})
    )
    mocker.patch(
        "pipeline.main.get_fulltext",
        new=AsyncMock(return_value={"text": "t", "fulltext": True, "source": "pmc"}),
    )


def _mock_lifecycle(mocker) -> None:
    mocker.patch(
        "pipeline.main._install_termination_handlers",
        return_value=(MagicMock(), []),
    )
    mocker.patch("pipeline.main._remove_signal_handlers")
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


def _checkpoint_paper(config: PipelineConfig, pmid: str, **provenance: int) -> None:
    result = PaperResult(
        pmid=pmid, genes=[_gene(pmid=pmid)], fulltext=True, source="pmc"
    )
    metrics = PipelineMetrics(
        papers_processed=1,
        fulltext_retrieved=1,
        genes_extracted=1,
        genes_validated=1,
        token_usage=TokenUsage(input_tokens=1000, output_tokens=100),
    )
    checkpoint.append(
        config.checkpoint_file,
        checkpoint.fingerprint(config),
        pipeline_main._checkpoint_record(result, metrics, provenance=provenance),
    )


class TestPapersAreCountedAsTheyFinish:
    """`papers_processed` is a per-paper count, like every other metric.

    It was added in bulk after every paper had returned, so a run that died
    in step 3 published `processed: 0` beside the full texts, abstracts,
    genes and tokens of the papers that had finished -- and a checkpoint
    restored those papers while the crashed run's report said it had
    processed none.
    """

    async def test_a_paper_with_no_text_counts_as_processed(self, mocker) -> None:
        _no_text(mocker)
        metrics = PipelineMetrics()

        await pipeline_main.process_paper("123", metrics, PipelineConfig())

        assert metrics.papers_processed == 1

    async def test_an_extracted_paper_counts_as_processed(self, mocker) -> None:
        _fulltext(mocker)
        mocker.patch(
            "pipeline.main._extract_and_validate",
            new=AsyncMock(
                return_value=pipeline_main.ExtractionOutcome(
                    genes=[], rejected_genes=[], extracted_count=0,
                    llm_time=0.0, validation_time=0.0,
                )
            ),
        )
        metrics = PipelineMetrics()

        await pipeline_main.process_paper("123", metrics, PipelineConfig())

        assert metrics.papers_processed == 1

    async def test_a_paper_that_fails_does_not_count(self, mocker) -> None:
        _fulltext(mocker)
        mocker.patch(
            "pipeline.main._extract_and_validate",
            new=AsyncMock(side_effect=ExtractionFailedError("provider failed")),
        )
        metrics = PipelineMetrics()

        with pytest.raises(ExtractionFailedError):
            await pipeline_main.process_paper("123", metrics, PipelineConfig())

        assert metrics.papers_processed == 0

    async def test_the_batch_total_is_not_added_a_second_time(
        self, mocker, tmp_path: Path
    ) -> None:
        async def fake(pmid, metrics, *, config, rate_limiter=None):
            metrics.papers_processed += 1
            return {
                "genes": [],
                "rejected_genes": [],
                "fulltext": True,
                "source": "pmc",
                "text_truncated": False,
            }

        mocker.patch("pipeline.main.process_paper", new=fake)
        metrics = PipelineMetrics()

        await pipeline_main._process_new_pmids(
            ["1", "2"],
            metrics,
            _config(tmp_path),
            AsyncMock(),
            MagicMock(),
            use_checkpoint=False,
        )

        assert metrics.papers_processed == 2

    async def test_batch_mode_counts_each_paper_once_as_it_is_validated(
        self, mocker, tmp_path: Path
    ) -> None:
        # Three papers: one with no text, one the batch answered, one it did
        # not. Two are processed, and neither is counted twice.
        texts = {"111": ("", False, "none"), "222": ("t", True, "pmc")}
        texts["333"] = ("t", False, "abstract")

        async def fetch(pmid, semaphore):
            return texts[pmid]

        mocker.patch("pipeline.main._fetch_paper_text_for_batch", new=fetch)
        mocker.patch(
            "pipeline.main.submit_and_collect",
            new=AsyncMock(return_value={"222": []}),
        )
        reporter = _ProgressReporter(_config(tmp_path))
        metrics = PipelineMetrics()

        batch = await pipeline_main._process_new_pmids_via_batch(
            ["111", "222", "333"], metrics, PipelineConfig(), reporter
        )

        assert metrics.papers_processed == 2
        assert sorted(r.pmid for r in batch.successful_results) == ["111", "222"]

    def test_a_record_written_before_the_count_moved_still_counts(self) -> None:
        # Checkpoints from before this change carry `papers_processed: 0`
        # for every paper, because the run added the count in bulk after
        # the checkpoint hook had already seen the paper's metrics.
        record = {
            "result": {"pmid": "111", "source": "pmc", "fulltext": True},
            "metrics": {"papers_processed": 0, "fulltext_retrieved": 1},
        }

        _, metrics, _ = pipeline_main._restored_paper(record)

        assert metrics.papers_processed == 1
        assert metrics.fulltext_retrieved == 1


class TestAFailedRunPublishesWhatItProcessed:
    """A run that dies at the merge has every paper in hand and says so."""

    async def test_the_batch_reaches_the_failed_report(self, tmp_path, mocker):
        reset_recorder()
        recorded = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )
        reporter = _ProgressReporter(_config(tmp_path))
        reporter.report(4)
        processed = PaperResult(pmid="3", source="pmc", fulltext=True, genes=[_gene()])
        batch = _ProcessedBatch(
            results=[
                PaperResult(pmid="1", error="boom"),
                PaperResult(pmid="2", source="none"),
                processed,
            ],
            warnings=["Possible over-extraction"],
        )
        metrics = PipelineMetrics(papers_processed=2, fulltext_retrieved=1)

        await pipeline_main._record_failed_run(
            metrics,
            reporter,
            dry_run=False,
            started_at=0.0,
            config=PipelineConfig(),
            batch=batch,
            days_back=30,
            total_pmids_found=5,
            new_pmids_count=3,
        )

        report = recorded.await_args.kwargs["report"]
        assert report["papers"]["processed"] == 2
        assert report["papers"]["failed"] == 1
        assert report["papers"]["noTextAvailable"] == 1
        assert [p["pmid"] for p in report["papersDetail"]["items"]] == ["1", "2", "3"]
        assert report["papers"]["found"] == 5
        assert report["papers"]["newlySeen"] == 3
        assert report["papers"]["alreadySeen"] == 2

    async def test_a_run_that_dies_before_step_3_returns_still_reports(
        self, tmp_path, mocker
    ) -> None:
        # No batch yet: the metrics folded so far are what is known, and the
        # report is built the same way with nothing in the paper lists.
        reset_recorder()
        recorded = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )
        reporter = _ProgressReporter(_config(tmp_path))
        reporter.report(2)
        metrics = PipelineMetrics(papers_processed=4, fulltext_retrieved=3)

        await pipeline_main._record_failed_run(
            metrics, reporter, dry_run=False, started_at=0.0, config=PipelineConfig()
        )

        report = recorded.await_args.kwargs["report"]
        assert report["papers"]["processed"] == 4
        assert report["papers"]["fulltext"] == 3
        assert report["papers"]["failed"] == 0
        assert report["papers"]["found"] is None
        assert report["papersDetail"]["items"] == []
        assert report["config"]["model"]

    async def test_a_cancellation_during_step_3_reconciles(
        self, tmp_path, mocker
    ) -> None:
        # The scenario the checkpoint exists for: one paper finished, the
        # next was cancelled. The failed row and report count the finished
        # paper as processed, so `fulltext <= processed` holds.
        reset_recorder()
        _mock_lifecycle(mocker)
        config = _config(tmp_path)
        mocker.patch(
            "pipeline.main._discover_new_pmids",
            new=AsyncMock(return_value=(["111", "222"], ["111", "222"])),
        )
        _fulltext(mocker)

        async def extract(text, pmid, metrics, config, rate_limiter, **kwargs):
            if pmid == "222":
                raise RuntimeError("killed")
            metrics.genes_extracted += 1
            metrics.genes_validated += 1
            return pipeline_main.ExtractionOutcome(
                genes=[_gene()], rejected_genes=[], extracted_count=1,
                llm_time=0.0, validation_time=0.0,
            )

        mocker.patch("pipeline.main._extract_and_validate", new=extract)
        mocker.patch(
            "pipeline.main._merge_processed_batch",
            new=AsyncMock(side_effect=ConnectionRefusedError("db gone")),
        )
        recorded = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )

        with pytest.raises(ConnectionRefusedError):
            await pipeline_main.run_pipeline(config=config, manage_lifecycle=False)

        kwargs = recorded.await_args.kwargs
        assert kwargs["papers_processed"] == 1
        assert kwargs["fulltext_retrieved"] == 1
        report = kwargs["report"]
        assert report["papers"]["processed"] == 1
        assert report["papers"]["failed"] == 1
        assert report["papers"]["fulltext"] <= report["papers"]["processed"]
        assert {p["pmid"] for p in report["papersDetail"]["items"]} == {"111", "222"}

    async def test_a_failure_after_the_merge_owns_the_rows_it_wrote(
        self, tmp_path, mocker
    ) -> None:
        # `merge_gene_entries` commits in a transaction of its own, so a
        # failure in `record_processed_pmids_batch` -- or the checkpoint
        # prune, or the report -- leaves new rows in `genes` that --export
        # then publishes. The failed report used to say `database: null`
        # and `rejectedAtInsertFloor: 0`, and the gene the insert floor had
        # refused was listed as accepted.
        reset_recorder()
        reset_tally()
        _mock_lifecycle(mocker)
        config = _config(tmp_path)
        mocker.patch(
            "pipeline.main._discover_new_pmids",
            new=AsyncMock(return_value=(["111"], ["111"])),
        )
        held = GeneEntry(
            gene_symbol="HTRA1",
            confidence=0.5,
            source_quote="HTRA1 variants segregate with CARASIL.",
            pmid="111",
        )
        batch = _ProcessedBatch(
            results=[
                PaperResult(
                    pmid="111", genes=[_gene(), held], fulltext=True, source="pmc"
                )
            ],
            warnings=[],
        )
        mocker.patch(
            "pipeline.main._process_new_pmids", new=AsyncMock(return_value=batch)
        )
        mocker.patch("pipeline.main.reset_gene_sequence", new=AsyncMock())
        mocker.patch(
            "pipeline.main.merge_gene_entries",
            new=AsyncMock(
                return_value={
                    "inserted": 1,
                    "updated": 0,
                    "held_below_insert_floor": [
                        {"gene_symbol": "HTRA1", "confidence": 0.5}
                    ],
                }
            ),
        )
        mocker.patch(
            "pipeline.main.record_processed_pmids_batch",
            new=AsyncMock(side_effect=ConnectionResetError("db gone")),
        )
        recorded = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )

        with pytest.raises(ConnectionResetError):
            await pipeline_main.run_pipeline(config=config, manage_lifecycle=False)

        report = recorded.await_args.kwargs["report"]
        assert report["status"] == "failed"
        assert report["database"]["inserted"] == 1
        assert report["genes"]["rejectedAtInsertFloor"] == 1
        assert [g["symbol"] for g in report["acceptedGenes"]["items"]] == ["NOTCH3"]
        assert "HTRA1" in [g["symbol"] for g in report["rejectedGenes"]["items"]]

    async def test_a_run_killed_inside_step_3_still_lists_its_papers(
        self, tmp_path, mocker
    ) -> None:
        # `batch` exists only once step 3 *returns*, so a SIGTERM or Ctrl+C
        # while papers were still in flight published the finished papers'
        # metrics -- processed, fulltext, genes -- beside an empty
        # papersDetail, an empty acceptedGenes and failed: 0. The funnel did
        # not add up, and the one paper the run did pay for was invisible.
        reset_recorder()
        reset_tally()
        _mock_lifecycle(mocker)
        config = _config(tmp_path)
        mocker.patch(
            "pipeline.main._discover_new_pmids",
            new=AsyncMock(return_value=(["111", "222"], ["111", "222"])),
        )
        _fulltext(mocker)
        finished = asyncio.Event()

        async def extract(text, pmid, metrics, config, rate_limiter, **kwargs):
            if pmid == "222":
                await finished.wait()
                raise asyncio.CancelledError
            metrics.genes_extracted += 1
            metrics.genes_validated += 1
            outcome = pipeline_main.ExtractionOutcome(
                genes=[_gene()], rejected_genes=[], extracted_count=1,
                llm_time=0.0, validation_time=0.0,
            )
            finished.set()
            return outcome

        mocker.patch("pipeline.main._extract_and_validate", new=extract)
        recorded = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )

        with pytest.raises(asyncio.CancelledError):
            await pipeline_main.run_pipeline(config=config, manage_lifecycle=False)

        report = recorded.await_args.kwargs["report"]
        assert report["papers"]["processed"] == 1
        assert [p["pmid"] for p in report["papersDetail"]["items"]] == ["111"]
        assert [g["symbol"] for g in report["acceptedGenes"]["items"]] == ["NOTCH3"]
        assert report["genes"]["validated"] == 1


class TestTheCheckpointOutlivesANarrowerRun:
    """Only the papers a run merged leave the checkpoint."""

    async def _run(self, mocker, config: PipelineConfig, window: list[str]):
        _mock_lifecycle(mocker)
        mocker.patch(
            "pipeline.main._discover_new_pmids",
            new=AsyncMock(return_value=(window, window)),
        )
        mocker.patch(
            "pipeline.main.process_papers_concurrently",
            new=AsyncMock(return_value=[]),
        )
        mocker.patch(
            "pipeline.main._merge_processed_batch",
            new=AsyncMock(return_value={"inserted": 0, "updated": 0}),
        )
        mocker.patch("pipeline.main._build_pubmed_report", return_value={})
        mocker.patch("pipeline.main._complete_pubmed_run", new=AsyncMock())
        await pipeline_main.run_pipeline(
            days_back=7, config=config, manage_lifecycle=False
        )

    async def test_papers_outside_the_window_stay_checkpointed(
        self, mocker, tmp_path: Path
    ) -> None:
        # A 365-day run crashed with 111 and 999 checkpointed; the nightly
        # 7-day run merges 111. 999 was paid for and is still waiting for
        # the run that publishes it.
        config = _config(tmp_path)
        _checkpoint_paper(config, "111")
        _checkpoint_paper(config, "999")

        await self._run(mocker, config, ["111"])

        remaining = checkpoint.load(
            config.checkpoint_file, checkpoint.fingerprint(config)
        )
        assert [r["result"]["pmid"] for r in remaining] == ["999"]

    async def test_the_file_goes_once_every_paper_is_merged(
        self, mocker, tmp_path: Path
    ) -> None:
        config = _config(tmp_path)
        _checkpoint_paper(config, "111")

        await self._run(mocker, config, ["111"])

        assert not Path(config.checkpoint_file).exists()

    async def test_a_prune_that_cannot_be_written_still_completes_the_run(
        self, mocker, tmp_path: Path
    ) -> None:
        # The prune is the last thing after the merge. logs/ going read-only
        # there used to raise into run_pipeline's `except BaseException`, so
        # a run whose genes and PMIDs are already committed was recorded --
        # and published on the About page -- as failed.
        config = _config(tmp_path)
        _checkpoint_paper(config, "111")
        _checkpoint_paper(config, "999")
        mocker.patch(
            "pipeline.checkpoint.os.replace",
            side_effect=OSError("read-only file system"),
        )
        failed = mocker.patch("pipeline.main._record_failed_run", new=AsyncMock())

        await self._run(mocker, config, ["111"])

        failed.assert_not_awaited()
        remaining = checkpoint.load(
            config.checkpoint_file, checkpoint.fingerprint(config)
        )
        assert [r["result"]["pmid"] for r in remaining] == ["111", "999"]

    async def test_a_batch_run_restores_the_checkpoint(
        self, mocker, tmp_path: Path
    ) -> None:
        # --batch reached the same unconditional clear without ever
        # restoring, so a streaming run's saved papers were deleted unmerged.
        config = _config(tmp_path)
        _checkpoint_paper(config, "111")
        fetch = mocker.patch(
            "pipeline.main._fetch_paper_text_for_batch",
            new=AsyncMock(return_value=("t", True, "pmc")),
        )
        mocker.patch(
            "pipeline.main.submit_and_collect", new=AsyncMock(return_value={"222": []})
        )
        metrics = PipelineMetrics()

        batch = await pipeline_main._process_new_pmids_via_batch(
            ["111", "222"], metrics, config, _ProgressReporter(config)
        )

        assert fetch.await_args.args[0] == "222"
        assert [r.pmid for r in batch.results] == ["111", "222"]
        assert [g.gene_symbol for g in batch.genes] == ["NOTCH3"]
        assert metrics.token_usage.input_tokens == 1000

    async def test_a_dry_batch_run_does_not_restore(self, mocker, tmp_path: Path):
        config = _config(tmp_path)
        _checkpoint_paper(config, "111")
        fetch = mocker.patch(
            "pipeline.main._fetch_paper_text_for_batch",
            new=AsyncMock(return_value=("t", True, "pmc")),
        )
        mocker.patch(
            "pipeline.main.submit_and_collect", new=AsyncMock(return_value={"111": []})
        )

        await pipeline_main._process_new_pmids_via_batch(
            ["111"],
            PipelineMetrics(),
            config,
            _ProgressReporter(config),
            use_checkpoint=False,
        )

        assert fetch.await_args.args[0] == "111"


class TestAPreviewNeedsNoDatabaseAtAll:
    @pytest.mark.parametrize("mode", ["dry_run", "test_mode"])
    async def test_missing_db_configuration_is_tolerated(self, mocker, mode: str):
        # "No database at all" includes no DB_* variables, which raises
        # before any socket is opened -- a preview on a fresh clone, or in
        # CI, died there.
        mocker.patch(
            "pipeline.main.search_recent_papers", new=AsyncMock(return_value=["111"])
        )
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new=AsyncMock(side_effect=DatabaseConfigError("missing DB_HOST")),
        )

        _, new_pmids = await pipeline_main._discover_new_pmids(
            7,
            dry_run=mode == "dry_run",
            test_mode=mode == "test_mode",
            progress=MagicMock(),
        )

        assert new_pmids == ["111"]

    async def test_a_live_run_still_needs_one(self, mocker) -> None:
        mocker.patch(
            "pipeline.main.search_recent_papers", new=AsyncMock(return_value=["111"])
        )
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new=AsyncMock(side_effect=DatabaseConfigError("missing DB_HOST")),
        )

        with pytest.raises(DatabaseConfigError):
            await pipeline_main._discover_new_pmids(
                7, dry_run=False, test_mode=False, progress=MagicMock()
            )


class TestAFailedPaperContributesOnlyItsSpend:
    """Its genes are counted by the run that eventually processes it."""

    async def test_genes_are_extracted_only_once_validation_holds(
        self, make_gene_entry, mocker
    ) -> None:
        genes = [make_gene_entry(gene_symbol="NOTCH3"), make_gene_entry()]
        mocker.patch(
            "pipeline.main.extract_from_paper",
            new=AsyncMock(
                return_value=(genes, TokenUsage(input_tokens=4, output_tokens=2))
            ),
        )
        mocker.patch(
            "pipeline.main.validate_gene_entry",
            new=AsyncMock(side_effect=NcbiUnavailableError("NCBI down")),
        )
        metrics = PipelineMetrics()

        with pytest.raises(NcbiUnavailableError):
            await pipeline_main._extract_and_validate(
                "text", "111", metrics, PipelineConfig(), None
            )

        assert metrics.genes_extracted == 0
        assert metrics.token_usage.total_tokens == 6

    async def test_a_failed_papers_partial_counts_are_not_folded(self, mocker):
        # Validation can count some genes before NCBI stops answering; the
        # paper is retried, so those counts belong to the later run.
        async def fake(pmid, metrics, *, config, rate_limiter=None):
            metrics.genes_extracted += 3
            metrics.genes_validated += 1
            metrics.fulltext_retrieved += 1
            metrics.token_usage += TokenUsage(input_tokens=100, output_tokens=10)
            raise NcbiUnavailableError("NCBI down")

        mocker.patch("pipeline.main.process_paper", new=fake)
        metrics = PipelineMetrics()

        results = await pipeline_main.process_papers_concurrently(
            ["1"], metrics, PipelineConfig()
        )

        assert results[0].error == "NCBI down"
        assert metrics.genes_extracted == 0
        assert metrics.genes_validated == 0
        assert metrics.fulltext_retrieved == 0
        assert metrics.token_usage.total_tokens == 110

    async def test_batch_mode_counts_extraction_per_validated_paper(
        self, make_gene_entry, mocker, tmp_path
    ) -> None:
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
            metrics.genes_validated += len(genes)
            return genes, []

        mocker.patch("pipeline.main._validate_genes", new=_validate)
        metrics = PipelineMetrics()

        await pipeline_main._process_new_pmids_via_batch(
            ["111", "222"],
            metrics,
            PipelineConfig(),
            _ProgressReporter(_config(tmp_path)),
        )

        assert metrics.genes_extracted == 1
        assert metrics.genes_validated == 1


class TestTheEventLogCannotSilenceTheRun:
    async def test_a_sqlite_failure_still_notifies(self, mocker) -> None:
        # The event log sits between the pipeline_runs row and --export in
        # the dispatcher, with nothing catching it: a locked SQLite file
        # skipped the notification and the export and exited by traceback.
        mocker.patch(
            "pipeline.main.EventLog",
            side_effect=sqlite3.OperationalError("database is locked"),
        )
        notify = mocker.patch("pipeline.main.send_pipeline_notification")
        error = mocker.patch("pipeline.main.logger.error")

        await pipeline_main._record_and_notify(PipelineConfig(), {"timestamp": "t"})

        notify.assert_called_once()
        assert any("event log" in c.args[0] for c in error.call_args_list)

    async def test_a_record_failure_still_notifies(self, mocker) -> None:
        event_log = mocker.patch("pipeline.main.EventLog")
        entered = event_log.return_value.__enter__.return_value
        entered.record.side_effect = sqlite3.OperationalError("locked")
        notify = mocker.patch("pipeline.main.send_pipeline_notification")

        await pipeline_main._record_and_notify(PipelineConfig(), {"timestamp": "t"})

        notify.assert_called_once()


class TestProvenanceSurvivesARestore:
    """The quote counts belong to the paper, so the checkpoint carries them."""

    def setup_method(self) -> None:
        reset_tally()

    async def test_each_paper_is_attributed_its_own_quotes(self, mocker) -> None:
        # Two papers in flight at once: the tally is one module-level
        # accumulator, so attribution has to come from the task, not from a
        # before/after delta that the other paper would land inside.
        import asyncio

        gate = asyncio.Event()

        async def fake(pmid, metrics, *, config, rate_limiter=None):
            if pmid == "1":
                current_tally().record(genes=2, verbatim=2, cited=1)
                await gate.wait()
            else:
                current_tally().record(genes=5, verbatim=4, cited=0)
                gate.set()
            return {
                "genes": [],
                "rejected_genes": [],
                "fulltext": True,
                "source": "pmc",
                "text_truncated": False,
            }

        mocker.patch("pipeline.main.process_paper", new=fake)

        await pipeline_main.process_papers_concurrently(
            ["1", "2"], PipelineMetrics(), PipelineConfig()
        )

        tally = current_tally()
        assert tally.genes == 7
        assert tally.paper("1") == {
            "genes": 2, "verbatim": 2, "cited": 1, "dropped_unverified": 0,
        }
        assert tally.paper("2")["genes"] == 5

    async def test_the_checkpoint_stores_and_restores_the_counts(
        self, mocker, tmp_path: Path
    ) -> None:
        config = _config(tmp_path)

        async def fake(pmid, metrics, *, config, rate_limiter=None):
            current_tally().record(genes=3, verbatim=2, cited=1, dropped_unverified=1)
            return {
                "genes": [],
                "rejected_genes": [],
                "fulltext": True,
                "source": "pmc",
                "text_truncated": False,
            }

        mocker.patch("pipeline.main.process_paper", new=fake)
        await pipeline_main._process_new_pmids(
            ["111"], PipelineMetrics(), config, AsyncMock(), MagicMock()
        )
        records = checkpoint.load(
            config.checkpoint_file, checkpoint.fingerprint(config)
        )
        assert records[0]["provenance"] == {
            "genes": 3, "verbatim": 2, "cited": 1, "dropped_unverified": 1,
        }

        reset_tally()
        mocker.patch(
            "pipeline.main.process_papers_concurrently", new=AsyncMock(return_value=[])
        )
        await pipeline_main._process_new_pmids(
            ["111"], PipelineMetrics(), config, AsyncMock(), MagicMock()
        )

        tally = current_tally()
        assert (tally.genes, tally.verbatim, tally.cited) == (3, 2, 1)
        assert tally.paper("111") == {
            "genes": 3,
            "verbatim": 2,
            "cited": 1,
            "dropped_unverified": 1,
        }

    def test_a_record_without_provenance_restores_nothing(self) -> None:
        # Files written before the counts were stored.
        record = {"result": {"pmid": "111", "source": "pmc"}, "metrics": {}}

        _, _, provenance = pipeline_main._restored_paper(record)

        assert provenance is None


class TestTruncationSurvivesTheCheckpoint:
    def test_the_flag_round_trips(self) -> None:
        # A restored paper is published by this run, so the warning naming
        # the papers read only in part has to see it too.
        record = pipeline_main._checkpoint_record(
            PaperResult(
                pmid="111", fulltext=True, source="europepmc", text_truncated=True
            ),
            PipelineMetrics(papers_processed=1),
        )

        assert record["result"]["text_truncated"] is True
        restored, _, _ = pipeline_main._restored_paper(record)
        assert restored.text_truncated is True

    def test_a_record_written_before_the_flag_existed_reads_false(self) -> None:
        record = {"result": {"pmid": "111", "source": "pmc"}, "metrics": {}}

        restored, _, _ = pipeline_main._restored_paper(record)

        assert restored.text_truncated is False


class TestAFailedPapersQuotesAreNotCounted:
    """Provenance follows the same rule the gene counts follow.

    `report_provenance` runs during extraction, before NCBI validation, so
    a paper that then fails has its quotes in the tally while its genes are
    in neither `extracted`, `validated` nor `rejected` -- and the run that
    retries it counts them again.
    """

    def setup_method(self) -> None:
        reset_tally()

    async def test_a_paper_that_failed_validation_leaves_no_quotes_behind(
        self, mocker
    ) -> None:
        async def fake(pmid, metrics, *, config, rate_limiter=None):
            current_tally().record(genes=5, verbatim=5, cited=2)
            raise NcbiUnavailableError("NCBI did not answer")

        mocker.patch("pipeline.main.process_paper", new=fake)

        results = await pipeline_main.process_papers_concurrently(
            ["222"], PipelineMetrics(), PipelineConfig()
        )

        assert [result.succeeded for result in results] == [False]
        tally = current_tally()
        assert (tally.genes, tally.verbatim, tally.cited) == (0, 0, 0)
        assert tally.paper("222") == {
            "genes": 0, "verbatim": 0, "cited": 0, "dropped_unverified": 0,
        }

    async def test_only_the_failed_papers_share_is_removed(self, mocker) -> None:
        # The report read "7 of 7 quotes found in the paper" under a funnel
        # of 2 extracted genes: paper A's 2 plus paper B's 5, with B failed.
        async def fake(pmid, metrics, *, config, rate_limiter=None):
            if pmid == "A":
                current_tally().record(genes=2, verbatim=2, cited=1)
                return {
                    "genes": [],
                    "rejected_genes": [],
                    "fulltext": True,
                    "source": "pmc",
                    "text_truncated": False,
                }
            current_tally().record(genes=5, verbatim=5, cited=1)
            raise NcbiUnavailableError("NCBI did not answer")

        mocker.patch("pipeline.main.process_paper", new=fake)

        await pipeline_main.process_papers_concurrently(
            ["A", "B"], PipelineMetrics(), PipelineConfig()
        )

        tally = current_tally()
        assert (tally.genes, tally.verbatim, tally.cited) == (2, 2, 1)

    async def test_the_batch_path_discards_a_failed_papers_quotes(
        self, mocker, tmp_path: Path
    ) -> None:
        # The batch records provenance when its results are parsed, so the
        # same gap is there once validation refuses the paper.
        config = _config(tmp_path)
        mocker.patch(
            "pipeline.main._fetch_paper_text_for_batch",
            new=AsyncMock(return_value=("paper text", True, "europepmc")),
        )

        async def submit(papers, cfg, *, usage=None):
            current_tally().record(genes=4, verbatim=3, cited=1)
            return {"333": [_gene(pmid="333")]}

        mocker.patch("pipeline.main.submit_and_collect", new=submit)
        mocker.patch(
            "pipeline.main._validate_genes",
            new=AsyncMock(side_effect=NcbiUnavailableError("NCBI did not answer")),
        )

        # `paper_scope` is what attributes the counts, and the batch enters
        # it inside `results_by_custom_id`; stand in for it here.
        with pipeline_main.paper_scope("333"):
            batch = await pipeline_main._process_new_pmids_via_batch(
                ["333"],
                PipelineMetrics(),
                config,
                _ProgressReporter(config),
            )

        assert [result.succeeded for result in batch.results] == [False]
        assert current_tally().genes == 0
