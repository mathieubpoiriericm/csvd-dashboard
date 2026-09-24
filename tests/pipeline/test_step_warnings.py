"""What earns a step its warning badge.

These are the four conditions the dashboard promises to surface. A step
that warned about none of them shows a clean pass, so a gap here is a
run that looks better than it went.
"""

from typing import Any, cast
from unittest.mock import AsyncMock, MagicMock

import pipeline.main as pipeline_main
from pipeline.api_telemetry import current_recorder, reset_recorder
from pipeline.citations import current_tally, reset_tally
from pipeline.config import PipelineConfig
from pipeline.extraction_models import GeneEntry
from pipeline.main import (
    PaperResult,
    RejectedGene,
    _ProgressReporter,
    _record_processing_actions,
)
from pipeline.quality_metrics import PipelineMetrics, TokenUsage
from pipeline.run_errors import RunError


def _progress(tmp_path) -> _ProgressReporter:
    reporter = _ProgressReporter(
        PipelineConfig(progress_file=str(tmp_path / "progress.json"))
    )
    reporter.report(2)
    return reporter


def _warnings(reporter: _ProgressReporter) -> list:
    return reporter.steps()[2].warnings


def _gene(symbol: str, pmid: str = "1") -> GeneEntry:
    return GeneEntry(
        gene_symbol=symbol, confidence=0.9, pmid=pmid, source_quote="A sentence."
    )


def _paper_dropping_quotes(pmid: str, symbols: list[str]) -> PaperResult:
    """A processed paper whose quote gate removed *symbols*.

    The shape `_quote_rejections` produces, which is where the warning
    now reads its subjects from.
    """
    result = PaperResult(pmid=pmid, fulltext=True, source="europepmc")
    result.rejected_genes = [
        RejectedGene(
            gene=_gene(symbol, pmid), reasons=[pipeline_main._QUOTE_NOT_FOUND_REASON]
        )
        for symbol in symbols
    ]
    return result


class TestProcessingWarnings:
    def setup_method(self) -> None:
        reset_recorder()
        reset_tally()

    def test_a_clean_step_raises_nothing(self, tmp_path) -> None:
        reporter = _progress(tmp_path)
        _record_processing_actions(
            reporter,
            [PaperResult(pmid="1", fulltext=True, source="europepmc")],
            PipelineMetrics(papers_processed=1, fulltext_retrieved=1),
        )
        assert _warnings(reporter) == []
        assert reporter.steps()[2].status == "ok"

    def test_a_paper_with_no_text_warns(self, tmp_path) -> None:
        reporter = _progress(tmp_path)
        _record_processing_actions(
            reporter,
            [PaperResult(pmid="19539236", source="none")],
            PipelineMetrics(),
        )
        warning = _warnings(reporter)[0]
        assert warning.kind == "paper_retrieval_failed"
        assert warning.title == "1 paper had no retrievable text"
        assert warning.subjects == ["19539236"]

    def test_several_papers_with_no_text_are_one_warning(self, tmp_path) -> None:
        reporter = _progress(tmp_path)
        _record_processing_actions(
            reporter,
            [PaperResult(pmid=str(i), source="none") for i in range(3)],
            PipelineMetrics(),
        )
        warning = _warnings(reporter)[0]
        assert warning.count == 3
        assert warning.title == "3 papers had no retrievable text"

    def test_a_failed_paper_warns(self, tmp_path) -> None:
        reporter = _progress(tmp_path)
        _record_processing_actions(
            reporter,
            [PaperResult(pmid="7", error="boom")],
            PipelineMetrics(),
        )
        titles = [w.title for w in _warnings(reporter)]
        assert "1 paper could not be processed" in titles

    def test_rejected_genes_warn(self, tmp_path) -> None:
        reporter = _progress(tmp_path)
        _record_processing_actions(
            reporter, [], PipelineMetrics(genes_extracted=50, genes_rejected=24)
        )
        warning = next(w for w in _warnings(reporter) if w.kind == "genes_rejected")
        assert warning.count == 24
        assert "validation floor" in warning.title

    def test_genes_dropped_for_an_unverified_quote_warn(self, tmp_path) -> None:
        # Removed inside extraction when require_verified_quotes is on, so
        # they reach no other count: `extracted` never saw them. The tally
        # was the only record and nothing read it, which left the one
        # warning kind declared for this unreachable.
        reporter = _progress(tmp_path)
        _record_processing_actions(
            reporter,
            [_paper_dropping_quotes("37069360", ["CENPF", "ABO"])],
            PipelineMetrics(),
        )
        warning = _warnings(reporter)[0]
        assert warning.kind == "quote_unverified"
        assert warning.count == 2
        assert warning.title == (
            "2 genes were dropped because the quoted sentence was not found "
            "in the paper"
        )
        # The count alone could not say which gene the run threw away.
        assert warning.subjects == ["CENPF", "ABO"]
        assert reporter.steps()[2].status == "warning"

    def test_the_quote_warning_ignores_other_rejections(self, tmp_path) -> None:
        # A gene the validation floor refused is a different warning with a
        # different count; only the quote gate's own reason feeds this one.
        reporter = _progress(tmp_path)
        result = PaperResult(pmid="1", fulltext=True, source="pmc")
        result.rejected_genes = [
            RejectedGene(gene=_gene("BTN3A2"), reasons=["Low confidence: 0.40 < 0.45"])
        ]
        _record_processing_actions(reporter, [result], PipelineMetrics())
        assert [w.kind for w in _warnings(reporter)] == []

    def test_a_run_that_dropped_no_quotes_does_not_warn(self, tmp_path) -> None:
        current_tally().record(genes=5, verbatim=5, cited=2)
        reporter = _progress(tmp_path)
        _record_processing_actions(reporter, [], PipelineMetrics())
        assert _warnings(reporter) == []

    def test_a_paper_cut_short_at_the_text_limit_warns(self, tmp_path) -> None:
        # The tail -- where the supplementary gene-level tables are -- was
        # never read, and the paper is retired as processed all the same, so
        # a log line was the whole record of a permanent loss.
        reporter = _progress(tmp_path)
        _record_processing_actions(
            reporter,
            [
                PaperResult(
                    pmid="36180795",
                    fulltext=True,
                    source="europepmc",
                    text_truncated=True,
                ),
                PaperResult(pmid="1", fulltext=True, source="pmc"),
            ],
            PipelineMetrics(),
        )
        warning = next(w for w in _warnings(reporter) if w.kind == "paper_truncated")
        assert warning.count == 1
        assert warning.title == "1 paper was read only as far as the text limit"
        assert warning.subjects == ["36180795"]

    def test_titles_agree_with_their_counts(self, tmp_path) -> None:
        # Reader-facing prose, so "1 gene(s)" is not acceptable.
        reporter = _progress(tmp_path)
        _record_processing_actions(
            reporter,
            [PaperResult(pmid="1", error="boom")],
            PipelineMetrics(
                genes_rejected=1, token_usage=TokenUsage(truncated_responses=1)
            ),
        )
        titles = [w.title for w in _warnings(reporter)]
        assert "1 paper could not be processed" in titles
        assert "1 gene did not clear the validation floor" in titles
        assert "1 model response was cut short by the token ceiling" in titles

    def test_a_truncated_model_response_warns(self, tmp_path) -> None:
        reporter = _progress(tmp_path)
        _record_processing_actions(
            reporter,
            [],
            PipelineMetrics(token_usage=TokenUsage(truncated_responses=2)),
        )
        warning = next(w for w in _warnings(reporter) if w.kind == "model_truncated")
        assert warning.count == 2
        assert "token ceiling" in warning.title

    def test_an_api_retry_warns_and_names_the_endpoint(self, tmp_path) -> None:
        current_recorder().note_retry(
            host="eutils.ncbi.nlm.nih.gov",
            path="/entrez/eutils/efetch.fcgi",
            method="GET",
        )
        reporter = _progress(tmp_path)
        _record_processing_actions(reporter, [], PipelineMetrics())
        warning = next(w for w in _warnings(reporter) if w.kind == "api_retried")
        assert "E-utilities fetch" in warning.title
        assert warning.subjects == ["GET /entrez/eutils/efetch.fcgi"]

    def test_an_api_error_warns(self, tmp_path) -> None:
        current_recorder().record(
            host="api.unpaywall.org", path="/v2/x", method="GET", status=503
        )
        reporter = _progress(tmp_path)
        _record_processing_actions(reporter, [], PipelineMetrics())
        warning = next(w for w in _warnings(reporter) if w.kind == "api_errored")
        assert "Unpaywall" in warning.title
        assert warning.count == 1

    def test_a_successful_api_call_raises_nothing(self, tmp_path) -> None:
        current_recorder().record(
            host="api.unpaywall.org", path="/v2/x", method="GET", status=200
        )
        reporter = _progress(tmp_path)
        _record_processing_actions(reporter, [], PipelineMetrics())
        assert _warnings(reporter) == []

    def test_the_step_reports_what_it_did_in_prose(self, tmp_path) -> None:
        # This is what expands under the step in the dashboard, so it has
        # to read as sentences rather than as a log excerpt.
        reporter = _progress(tmp_path)
        _record_processing_actions(
            reporter,
            [],
            PipelineMetrics(
                fulltext_retrieved=10,
                abstract_only=5,
                genes_extracted=50,
                genes_validated=26,
            ),
        )
        actions = reporter.steps()[2].actions
        assert actions == [
            "Retrieved full text for 10, abstract only for 5",
            "Extracted 50 genes, of which 26 passed validation",
        ]


class TestRecorderIsolation:
    def test_each_run_starts_from_an_empty_api_inventory(self, mocker) -> None:
        # main() can dispatch several pipelines in one invocation; without
        # a reset the second reports the first's traffic as its own.
        reset_recorder()
        current_recorder().record(
            host="rest.uniprot.org", path="/uniprotkb/P1", method="GET", status=200
        )
        assert current_recorder().total_calls() == 1

        mocker.patch.object(pipeline_main.Database, "set_config")
        reset_recorder()
        assert current_recorder().total_calls() == 0


class TestOtherStepsCanWarnToo:
    """Every warn() call used to sit in one function on step 3.

    Four of the six steps therefore had no path to a warning at all, so
    the `batch_validation` warning kind was unreachable and a run that
    refused six new genes at the insert floor still badged every step
    Passed -- the exact silence the widget replaces.
    """

    def setup_method(self) -> None:
        reset_recorder()

    def _validation_step(self, tmp_path):
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        reporter.report(3)
        return reporter

    def test_batch_validation_findings_warn(self, tmp_path) -> None:
        reporter = self._validation_step(tmp_path)
        pipeline_main._record_validation_actions(
            reporter,
            [],
            ["Gene 'HTRA1' extracted from 5 different papers"],
        )
        step = reporter.steps()[3]
        assert step.status == "warning"
        assert step.warnings[0].kind == "batch_validation"
        assert "HTRA1" in (step.warnings[0].detail or "")

    def test_a_clean_batch_check_does_not_warn(self, tmp_path) -> None:
        reporter = self._validation_step(tmp_path)
        pipeline_main._record_validation_actions(reporter, [], [])
        step = reporter.steps()[3]
        assert step.status == "ok"
        assert step.actions == ["Cross-checked 0 genes against the rest of the batch"]

    def test_the_merge_warns_on_what_the_insert_floor_refused(self, tmp_path) -> None:
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        reporter.report(4)
        pipeline_main._record_merge_actions(
            reporter,
            {
                "inserted": 1,
                "updated": 2,
                "held_below_insert_floor": [
                    {"gene_symbol": "WDR12", "confidence": 0.6},
                    {"gene_symbol": "CALCRL", "confidence": 0.55},
                ],
            },
            recorded=3,
        )
        step = reporter.steps()[4]
        assert step.status == "warning"
        assert step.warnings[0].count == 2
        assert step.warnings[0].subjects == ["WDR12", "CALCRL"]
        assert "Inserted 1 genes and updated 2" in step.actions

    def test_a_merge_that_refused_nothing_does_not_warn(self, tmp_path) -> None:
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        reporter.report(4)
        pipeline_main._record_merge_actions(
            reporter,
            {"inserted": 1, "updated": 2, "held_below_insert_floor": []},
            recorded=3,
        )
        assert reporter.steps()[4].status == "ok"

    def test_a_non_dict_merge_result_is_survived(self, tmp_path) -> None:
        # A bare AsyncMock in a test makes .get() return a coroutine.
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        reporter.report(4)
        pipeline_main._record_merge_actions(
            reporter, cast(Any, MagicMock()), recorded=0
        )
        assert reporter.steps()[4].status == "ok"


class TestAFailedRunIsRecorded:
    """`_finalize_run` sits on the success path only.

    So a failed run wrote no pipeline_runs row at all: `status: "failed"`,
    every classified RunError, and the whole error half of the dashboard
    were computed and thrown away, while the About page went on showing a
    green badge dated to the last run that succeeded.
    """

    async def test_a_failure_persists_a_failed_report(self, tmp_path, mocker):
        reset_recorder()
        recorded = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        reporter.report(4)
        reporter.recorder.fail(
            RunError(kind="database_error", title="The database refused")
        )

        await pipeline_main._record_failed_run(
            PipelineMetrics(papers_processed=9, genes_extracted=6),
            reporter,
            dry_run=False,
            started_at=0.0,
            config=PipelineConfig(),
        )

        recorded.assert_awaited_once()
        kwargs = recorded.await_args.kwargs
        assert kwargs["status"] == "failed"
        assert kwargs["papers_processed"] == 9
        report = kwargs["report"]
        assert report["status"] == "failed"
        # The classified failure travels with it, which is the whole point.
        merging = next(s for s in report["steps"] if s["key"] == "merging_database")
        assert merging["status"] == "failed"
        assert merging["error"]["kind"] == "database_error"

    async def test_a_failed_run_still_names_its_configuration(
        self, tmp_path, mocker
    ):
        # An empty config block published a failed run with no model and
        # no confidence floors, so its rejections quoted a floor the
        # report did not name.
        reset_recorder()
        recorded = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        config = PipelineConfig(confidence_threshold_insert=0.7)
        await pipeline_main._record_failed_run(
            PipelineMetrics(),
            reporter,
            dry_run=False,
            started_at=0.0,
            config=config,
        )
        report = recorded.await_args.kwargs["report"]
        assert report["config"]["model"] == config.llm_model
        assert report["config"]["effort"] == config.llm_effort
        assert report["config"]["promptVersion"] == config.prompt_version
        assert report["config"]["confidenceThresholdInsert"] == 0.7
        assert report["config"]["dryRun"] is False

    async def test_a_failure_is_not_captioned_with_the_step_key(
        self, tmp_path
    ) -> None:
        # The failure renders under its step; "(merging_database)" in the
        # headline was an internal token where a PMID or service belongs.
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        reporter.report(4)
        reporter.fail(RuntimeError("no connection"))
        error = reporter.steps()[4].error
        assert error is not None
        assert error.subject is None
        assert "merging_database" not in error.title

    async def test_a_dry_run_records_nothing(self, tmp_path, mocker):
        recorded = mocker.patch(
            "pipeline.main.record_pipeline_run", new=AsyncMock(return_value=1)
        )
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        await pipeline_main._record_failed_run(
            PipelineMetrics(),
            reporter,
            dry_run=True,
            started_at=0.0,
            config=PipelineConfig(),
        )
        recorded.assert_not_awaited()

    async def test_a_database_that_is_itself_down_does_not_mask_the_failure(
        self, tmp_path, mocker, caplog
    ):
        # The database is often the thing that just failed, so an
        # exception raised here would replace the real one on its way up.
        mocker.patch(
            "pipeline.main.record_pipeline_run",
            new=AsyncMock(side_effect=RuntimeError("no connection")),
        )
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )
        await pipeline_main._record_failed_run(
            PipelineMetrics(),
            reporter,
            dry_run=False,
            started_at=0.0,
            config=PipelineConfig(),
        )
        assert "Could not record the failed run" in caplog.text


class TestSearchWarnings:
    async def test_a_truncated_search_warns_on_the_search_step(
        self, tmp_path, mocker
    ) -> None:
        # A pagination failure returned the papers retrieved so far and the
        # run ended `completed` -- the missing part of the window was a log
        # line nobody read. The search reports the truncation to its caller,
        # which raises it where the widget will show it.
        reporter = _ProgressReporter(
            PipelineConfig(progress_file=str(tmp_path / "progress.json"))
        )

        async def truncated_search(days_back: int, *, on_truncated=None):
            assert on_truncated is not None
            on_truncated(500, 1000)
            return [str(i) for i in range(500)]

        mocker.patch("pipeline.main.search_recent_papers", new=truncated_search)
        mocker.patch(
            "pipeline.main.get_existing_pmids", new=AsyncMock(return_value=set())
        )

        await pipeline_main._discover_new_pmids(
            7, dry_run=False, test_mode=False, progress=reporter
        )

        step = reporter.steps()[0]
        assert step.status == "warning"
        warning = step.warnings[0]
        assert warning.kind == "search_truncated"
        assert warning.count == 500
        assert warning.title == "500 of 1000 matching papers could not be retrieved"
