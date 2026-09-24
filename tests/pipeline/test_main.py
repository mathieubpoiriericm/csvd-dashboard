"""Tests for pipeline.main — PMID validation, PaperResult, metadata, run_pipeline."""

import argparse
from unittest.mock import AsyncMock

import httpx
import pytest

from pipeline.config import PipelineConfig
from pipeline.main import (
    ExtractionFailedError,
    PaperResult,
    _build_parser,
    _extract_and_validate,
    _filter_genes_by_confidence,
    _load_pmids,
    _prepare_cli_args,
    _RedactSecrets,
    _resolve_pdf_files,
    _run_selected_pipelines,
    _validate_genes,
    fetch_paper_metadata,
    run_pipeline,
)
from pipeline.quality_metrics import PipelineMetrics, TokenUsage
from pipeline.validation import ValidationResult

# ---------------------------------------------------------------------------
# _validate_genes — None guard (Bug 5)
# ---------------------------------------------------------------------------


class TestValidateGenesNoneGuard:
    async def test_none_normalized_data_skipped(self, make_gene_entry, mocker):
        """Bug 5: is_valid=True with normalized_data=None must not crash."""
        gene = make_gene_entry(confidence=0.9)
        # Return a valid result but with None normalized_data
        mocker.patch(
            "pipeline.main.validate_gene_entry",
            return_value=ValidationResult(
                is_valid=True, errors=[], normalized_data=None
            ),
        )
        config = PipelineConfig()
        metrics = PipelineMetrics()
        validated, rejected = await _validate_genes([gene], metrics, config)
        assert validated == []
        # Gene with None data should not be counted as validated
        assert metrics.genes_validated == 0

    async def test_valid_normalized_data_included(self, make_gene_entry, mocker):
        """Normal case: is_valid=True with actual normalized_data."""
        gene = make_gene_entry(confidence=0.9)
        mocker.patch(
            "pipeline.main.validate_gene_entry",
            return_value=ValidationResult(
                is_valid=True, errors=[], normalized_data=gene
            ),
        )
        config = PipelineConfig()
        metrics = PipelineMetrics()
        validated, rejected = await _validate_genes([gene], metrics, config)
        assert len(validated) == 1
        assert metrics.genes_validated == 1


# ---------------------------------------------------------------------------
# Shared extraction and input helpers
# ---------------------------------------------------------------------------


class TestSharedPipelineHelpers:
    def test_confidence_filter_partitions_and_counts(self, make_gene_entry):
        accepted_gene = make_gene_entry(gene_symbol="NOTCH3", confidence=0.9)
        rejected_gene = make_gene_entry(gene_symbol="HTRA1", confidence=0.4)
        metrics = PipelineMetrics()

        accepted, rejected = _filter_genes_by_confidence(
            [accepted_gene, rejected_gene], metrics, threshold=0.65
        )

        assert accepted == [accepted_gene]
        assert [item.gene for item in rejected] == [rejected_gene]
        assert rejected[0].reasons == ["Low confidence: 0.40 < 0.65"]
        assert metrics.genes_validated == 1
        assert metrics.genes_rejected == 1

    async def test_extract_and_validate_owns_shared_metrics(
        self, make_gene_entry, mocker
    ):
        accepted_gene = make_gene_entry(gene_symbol="NOTCH3", confidence=0.9)
        rejected_gene = make_gene_entry(gene_symbol="HTRA1", confidence=0.4)
        usage = TokenUsage(input_tokens=100, output_tokens=20)
        mocker.patch(
            "pipeline.main.extract_from_paper",
            new=AsyncMock(return_value=([accepted_gene, rejected_gene], usage)),
        )
        metrics = PipelineMetrics()
        config = PipelineConfig(confidence_threshold_update=0.65)

        outcome = await _extract_and_validate(
            "paper text",
            "987654",
            metrics,
            config,
            None,
            skip_validation=True,
        )

        assert outcome.genes == [accepted_gene]
        assert [item.gene for item in outcome.rejected_genes] == [rejected_gene]
        assert outcome.extracted_count == 2
        assert accepted_gene.pmid == "987654"
        assert rejected_gene.pmid == "987654"
        assert metrics.genes_extracted == 2
        assert metrics.genes_validated == 1
        assert metrics.genes_rejected == 1
        assert metrics.token_usage.total_tokens == 120

    def test_resolve_pdf_files_handles_file_and_sorted_directory(self, tmp_path):
        later = tmp_path / "z.pdf"
        earlier = tmp_path / "a.pdf"
        later.touch()
        earlier.touch()

        directory, files = _resolve_pdf_files(tmp_path)
        assert directory == tmp_path
        assert files == [earlier, later]
        assert _resolve_pdf_files(later) == (tmp_path, [later])

    def test_load_pmids_ignores_comments_invalid_values_and_duplicates(
        self, tmp_path, caplog
    ):
        pmid_file = tmp_path / "pmids.txt"
        pmid_file.write_text("# papers\n123\ninvalid\n456\n123\n\n")

        assert _load_pmids(pmid_file) == ["123", "456"]
        assert "Skipping invalid PMID" in caplog.text


# ---------------------------------------------------------------------------
# PaperResult
# ---------------------------------------------------------------------------


class TestPaperResult:
    def test_default_values(self):
        r = PaperResult(pmid="111")
        assert r.genes == []
        assert r.fulltext is False
        assert r.source == "unknown"
        assert r.error is None
        assert r.succeeded is True

    def test_with_error(self):
        r = PaperResult(pmid="111", error="Something failed")
        assert not r.succeeded
        assert r.error == "Something failed"
        # Not "none": that means retrieval succeeded and found no text,
        # which the run report counts as noTextAvailable. While it was the
        # default, every errored paper was counted both ways.
        assert r.source == "unknown"

    def test_with_genes(self):
        from pipeline.llm_extraction import GeneEntry

        gene = GeneEntry(
            gene_symbol="NOTCH3",
            confidence=0.9,
            source_quote="NOTCH3 variants were associated with WMH (p=1e-12).",
        )
        r = PaperResult(pmid="111", genes=[gene])
        assert len(r.genes) == 1


# ---------------------------------------------------------------------------
# fetch_paper_metadata
# ---------------------------------------------------------------------------


class TestFetchPaperMetadata:
    async def test_successful_fetch(self, mocker):
        xml_response = b"""<?xml version="1.0"?>
        <PubmedArticleSet>
            <PubmedArticle>
                <PubmedData>
                    <ArticleIdList>
                        <ArticleId IdType="doi">10.1234/test</ArticleId>
                    </ArticleIdList>
                </PubmedData>
            </PubmedArticle>
        </PubmedArticleSet>"""

        mock_resp = AsyncMock()
        mock_resp.status_code = 200
        mock_resp.content = xml_response

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch(
            "pipeline.main._get_metadata_client",
            return_value=mock_client,
        )

        result = await fetch_paper_metadata("12345678")
        assert result["doi"] == "10.1234/test"

    async def test_no_doi_in_response(self, mocker):
        xml_response = b"""<?xml version="1.0"?>
        <PubmedArticleSet>
            <PubmedArticle>
                <PubmedData>
                    <ArticleIdList>
                        <ArticleId IdType="pubmed">12345678</ArticleId>
                    </ArticleIdList>
                </PubmedData>
            </PubmedArticle>
        </PubmedArticleSet>"""

        mock_resp = AsyncMock()
        mock_resp.status_code = 200
        mock_resp.content = xml_response

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch(
            "pipeline.main._get_metadata_client",
            return_value=mock_client,
        )

        result = await fetch_paper_metadata("12345678")
        assert result["doi"] is None

    async def test_http_error(self, mocker):
        mock_resp = AsyncMock()
        mock_resp.status_code = 500

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch(
            "pipeline.main._get_metadata_client",
            return_value=mock_client,
        )

        result = await fetch_paper_metadata("12345678")
        assert result["doi"] is None

    async def test_timeout(self, mocker):
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("timeout"))
        mocker.patch(
            "pipeline.main._get_metadata_client",
            return_value=mock_client,
        )

        result = await fetch_paper_metadata("12345678")
        assert result["doi"] is None

    async def test_a_cited_references_doi_is_ignored(self, mocker):
        # The first `ArticleId[@IdType='doi']` anywhere in the record was
        # taken, which for a record without its own DOI is a reference's --
        # and Unpaywall then fetched that other paper's PDF for this PMID.
        xml_response = b"""<?xml version="1.0"?>
        <PubmedArticleSet><PubmedArticle>
            <PubmedData>
                <ArticleIdList><ArticleId IdType="pubmed">1</ArticleId></ArticleIdList>
                <ReferenceList><Reference><ArticleIdList>
                    <ArticleId IdType="doi">10.9999/other-paper</ArticleId>
                </ArticleIdList></Reference></ReferenceList>
            </PubmedData>
        </PubmedArticle></PubmedArticleSet>"""
        mock_resp = AsyncMock()
        mock_resp.status_code = 200
        mock_resp.content = xml_response
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch("pipeline.main._get_metadata_client", return_value=mock_client)

        assert await fetch_paper_metadata("12345678") == {"doi": None}

    async def test_an_elocation_doi_is_the_fallback(self, mocker):
        xml_response = b"""<?xml version="1.0"?>
        <PubmedArticleSet><PubmedArticle>
            <MedlineCitation><Article>
                <ELocationID EIdType="doi">10.1000/eloc</ELocationID>
            </Article></MedlineCitation>
            <PubmedData><ArticleIdList/></PubmedData>
        </PubmedArticle></PubmedArticleSet>"""
        mock_resp = AsyncMock()
        mock_resp.status_code = 200
        mock_resp.content = xml_response
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch("pipeline.main._get_metadata_client", return_value=mock_client)

        assert await fetch_paper_metadata("12345678") == {"doi": "10.1000/eloc"}

    async def test_a_non_pubmed_document_yields_no_doi_and_says_so(self, mocker):
        # NCBI's maintenance page is a 200 whose body is HTML. The DOI is
        # only a hint for Unpaywall, so this is not fatal, but it is logged
        # rather than read as "no DOI".
        warning = mocker.patch("pipeline.main.logger.warning")
        mock_resp = AsyncMock()
        mock_resp.status_code = 200
        mock_resp.content = b"<html><body>Down for maintenance</body></html>"
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mocker.patch("pipeline.main._get_metadata_client", return_value=mock_client)

        assert await fetch_paper_metadata("12345678") == {"doi": None}
        assert any("not a PubMed" in call.args[0] for call in warning.call_args_list)

    async def test_invalid_pmid(self):
        with pytest.raises(ValueError, match="Invalid PMID"):
            await fetch_paper_metadata("invalid_pmid")


# ---------------------------------------------------------------------------
# run_pipeline
# ---------------------------------------------------------------------------


class TestRunPipeline:
    async def test_invalid_days_back_too_low(self):
        with pytest.raises(ValueError, match="days_back must be"):
            await run_pipeline(days_back=0)

    async def test_invalid_days_back_too_high(self):
        with pytest.raises(ValueError, match="days_back must be"):
            await run_pipeline(days_back=99999)

    async def test_no_papers_found(self, mocker):
        mocker.patch("pipeline.main.search_recent_papers", return_value=[])
        mocker.patch("pipeline.main._close_metadata_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_http_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_validation_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)
        mocker.patch("pipeline.main.clear_gene_cache")

        metrics, _ = await run_pipeline(days_back=7)
        assert metrics.papers_processed == 0

    async def test_all_papers_already_processed(self, mocker):
        mocker.patch(
            "pipeline.main.search_recent_papers",
            return_value=["111", "222"],
        )
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new_callable=AsyncMock,
            return_value={"111", "222"},
        )
        mocker.patch("pipeline.main._close_metadata_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_http_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_validation_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)
        mocker.patch("pipeline.main.clear_gene_cache")

        metrics, _ = await run_pipeline(days_back=7)
        assert metrics.papers_processed == 0

    async def test_test_mode_skips_extraction(self, mocker):
        mocker.patch(
            "pipeline.main.search_recent_papers",
            return_value=["111"],
        )
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new_callable=AsyncMock,
            return_value=set(),
        )
        mocker.patch("pipeline.main._close_metadata_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_http_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_validation_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)
        mocker.patch("pipeline.main.clear_gene_cache")

        # Should not call extract_from_paper
        mock_extract = mocker.patch("pipeline.main.extract_from_paper")

        await run_pipeline(days_back=7, test_mode=True)
        mock_extract.assert_not_called()

    async def test_extraction_failure_not_recorded_as_processed(self, mocker):
        mocker.patch("pipeline.main.search_recent_papers", return_value=["111"])
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new_callable=AsyncMock,
            return_value=set(),
        )
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new_callable=AsyncMock,
            return_value={"doi": None},
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new_callable=AsyncMock,
            return_value={
                "text": "paper text",
                "source": "abstract",
                "fulltext": False,
            },
        )
        mocker.patch(
            "pipeline.main.extract_from_paper",
            new_callable=AsyncMock,
            side_effect=ExtractionFailedError(
                "provider failed",
                TokenUsage(input_tokens=10, output_tokens=5),
            ),
        )
        mocker.patch("pipeline.main.reset_gene_sequence", new_callable=AsyncMock)
        mocker.patch("pipeline.main.merge_gene_entries", new_callable=AsyncMock)
        mock_record_pmids = mocker.patch(
            "pipeline.main.record_processed_pmids_batch",
            new_callable=AsyncMock,
            return_value=0,
        )
        mocker.patch("pipeline.main.record_pipeline_run", new_callable=AsyncMock)
        mocker.patch("pipeline.main.write_comprehensive_report")
        mocker.patch("pipeline.main.print_rich_summary")
        mocker.patch("pipeline.main._record_and_notify", new_callable=AsyncMock)
        mocker.patch("pipeline.main._close_metadata_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_http_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_validation_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_async_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)
        mocker.patch("pipeline.main.clear_gene_cache")

        metrics, run_data = await run_pipeline(days_back=7)

        assert metrics.papers_processed == 0
        assert metrics.token_usage.total_tokens == 15
        assert run_data is not None
        assert run_data["papers"]["failed"] == 1
        mock_record_pmids.assert_awaited_once_with([])

    async def test_a_database_error_during_deduplication_propagates(self, mocker):
        # Only a missing pubmed_refs table is treated as "first run"; any
        # other database failure must stop the run rather than silently
        # reprocess every paper. The old version of this test ran in
        # test_mode, which never calls get_existing_pmids, and so asserted
        # the opposite of the code without exercising it.
        mocker.patch(
            "pipeline.main.search_recent_papers",
            return_value=["111"],
        )
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new_callable=AsyncMock,
            side_effect=RuntimeError("DB not available"),
        )
        mocker.patch("pipeline.main.record_pipeline_run", new_callable=AsyncMock)
        mocker.patch("pipeline.main._close_metadata_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_http_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_validation_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)
        mocker.patch("pipeline.main.clear_gene_cache")

        with pytest.raises(RuntimeError, match="DB not available"):
            await run_pipeline(days_back=7)


# ---------------------------------------------------------------------------
# run_pipeline — use_batch_api routing (Task 15)
# ---------------------------------------------------------------------------


class TestRunPipelineBatchMode:
    async def test_batch_mode_routes_through_submit_and_collect(
        self, mocker, make_gene_entry
    ):
        """use_batch_api=True must never touch the streaming extraction
        function, and a paper's batch-returned genes must still reach
        run_data through the ordinary validate/merge/report path."""
        mocker.patch("pipeline.main.search_recent_papers", return_value=["111"])
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new_callable=AsyncMock,
            return_value=set(),
        )
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new_callable=AsyncMock,
            return_value={"doi": None},
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new_callable=AsyncMock,
            return_value={
                "text": "paper text",
                "source": "abstract",
                "fulltext": False,
            },
        )
        gene = make_gene_entry(gene_symbol="NOTCH3", pmid="111", confidence=0.9)
        mock_submit = mocker.patch(
            "pipeline.main.submit_and_collect",
            new_callable=AsyncMock,
            return_value={"111": [gene]},
        )
        mock_extract = mocker.patch("pipeline.main.extract_from_paper")
        mocker.patch(
            "pipeline.main.validate_gene_entry",
            return_value=ValidationResult(
                is_valid=True, errors=[], normalized_data=gene
            ),
        )
        mocker.patch("pipeline.main.reset_gene_sequence", new_callable=AsyncMock)
        mocker.patch("pipeline.main.merge_gene_entries", new_callable=AsyncMock)
        mock_record_pmids = mocker.patch(
            "pipeline.main.record_processed_pmids_batch",
            new_callable=AsyncMock,
            return_value=1,
        )
        mocker.patch("pipeline.main.record_pipeline_run", new_callable=AsyncMock)
        mocker.patch("pipeline.main.write_comprehensive_report")
        mocker.patch("pipeline.main.print_rich_summary")
        mocker.patch("pipeline.main._record_and_notify", new_callable=AsyncMock)
        mocker.patch("pipeline.main._close_metadata_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_http_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_validation_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_async_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)
        mocker.patch("pipeline.main.clear_gene_cache")

        metrics, run_data = await run_pipeline(days_back=7, use_batch_api=True)

        mock_extract.assert_not_called()
        mock_submit.assert_awaited_once()
        submitted_papers = mock_submit.await_args.args[0]
        assert submitted_papers == {"111": "paper text"}

        assert metrics.papers_processed == 1
        assert metrics.genes_validated == 1
        assert run_data is not None
        assert run_data["papers"]["processed"] == 1
        assert run_data["genes"]["validated"] == 1
        mock_record_pmids.assert_awaited_once_with([("111", False, "abstract", 1)])

    async def test_batch_mode_no_text_is_recorded_as_processed_not_retried(
        self, mocker
    ):
        """Ruling (Task 15 fix round 1, Finding 3): a paper with no
        retrievable text must not reach submit_and_collect, but — to match
        --pubmed's streaming default (process_paper), so the same command
        doesn't disagree with itself about the same edge case depending on
        --batch — it is recorded as processed with zero genes, not as a
        failure that gets retried forever."""
        mocker.patch("pipeline.main.search_recent_papers", return_value=["111"])
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new_callable=AsyncMock,
            return_value=set(),
        )
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new_callable=AsyncMock,
            return_value={"doi": None},
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new_callable=AsyncMock,
            return_value={"text": None, "source": "none", "fulltext": False},
        )
        mock_submit = mocker.patch(
            "pipeline.main.submit_and_collect", new_callable=AsyncMock
        )
        mocker.patch("pipeline.main.reset_gene_sequence", new_callable=AsyncMock)
        mocker.patch("pipeline.main.merge_gene_entries", new_callable=AsyncMock)
        mock_record_pmids = mocker.patch(
            "pipeline.main.record_processed_pmids_batch",
            new_callable=AsyncMock,
            return_value=1,
        )
        mocker.patch("pipeline.main.record_pipeline_run", new_callable=AsyncMock)
        mocker.patch("pipeline.main.write_comprehensive_report")
        mocker.patch("pipeline.main.print_rich_summary")
        mocker.patch("pipeline.main._record_and_notify", new_callable=AsyncMock)
        mocker.patch("pipeline.main._close_metadata_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_http_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_validation_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_async_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)
        mocker.patch("pipeline.main.clear_gene_cache")

        metrics, run_data = await run_pipeline(days_back=7, use_batch_api=True)

        mock_submit.assert_not_called()
        assert metrics.papers_processed == 1
        assert run_data is not None
        assert run_data["papers"]["failed"] == 0
        assert run_data["papers"]["processed"] == 1
        mock_record_pmids.assert_awaited_once_with([("111", False, "none", 0)])

    async def test_batch_mode_one_fetch_failure_does_not_abort_the_run(
        self, mocker, make_gene_entry
    ):
        """Finding 1: a fetch exception for one paper (e.g. validate_pmid or
        a network error inside fetch_paper_metadata/get_fulltext) must not
        abort the whole batch run before anything is submitted — the same
        per-paper isolation process_paper_safe already gives the streaming
        path. The other paper's already-fetched text must still reach
        submit_and_collect, and only the failing paper is marked failed."""
        mocker.patch("pipeline.main.search_recent_papers", return_value=["111", "222"])
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new_callable=AsyncMock,
            return_value=set(),
        )
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new_callable=AsyncMock,
            return_value={"doi": None},
        )

        async def _get_fulltext(pmid, doi):
            if pmid == "111":
                raise httpx.ConnectError("connection refused")
            return {"text": "paper text", "source": "abstract", "fulltext": False}

        mocker.patch("pipeline.main.get_fulltext", side_effect=_get_fulltext)
        gene = make_gene_entry(gene_symbol="NOTCH3", pmid="222", confidence=0.9)
        mock_submit = mocker.patch(
            "pipeline.main.submit_and_collect",
            new_callable=AsyncMock,
            return_value={"222": [gene]},
        )
        mocker.patch(
            "pipeline.main.validate_gene_entry",
            return_value=ValidationResult(
                is_valid=True, errors=[], normalized_data=gene
            ),
        )
        mocker.patch("pipeline.main.reset_gene_sequence", new_callable=AsyncMock)
        mocker.patch("pipeline.main.merge_gene_entries", new_callable=AsyncMock)
        mock_record_pmids = mocker.patch(
            "pipeline.main.record_processed_pmids_batch",
            new_callable=AsyncMock,
            return_value=1,
        )
        mocker.patch("pipeline.main.record_pipeline_run", new_callable=AsyncMock)
        mocker.patch("pipeline.main.write_comprehensive_report")
        mocker.patch("pipeline.main.print_rich_summary")
        mocker.patch("pipeline.main._record_and_notify", new_callable=AsyncMock)
        mocker.patch("pipeline.main._close_metadata_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_http_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_validation_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_async_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)
        mocker.patch("pipeline.main.clear_gene_cache")

        # Must complete without raising: this is what Finding 1 caught.
        metrics, run_data = await run_pipeline(days_back=7, use_batch_api=True)

        mock_submit.assert_awaited_once()
        submitted_papers = mock_submit.await_args.args[0]
        assert submitted_papers == {"222": "paper text"}  # 111 excluded

        assert metrics.papers_processed == 1  # only 222
        assert run_data is not None
        assert run_data["papers"]["failed"] == 1  # 111
        recorded_pmids = {rec[0] for rec in mock_record_pmids.await_args.args[0]}
        assert recorded_pmids == {"222"}

    async def test_batch_mode_marks_missing_batch_result_as_failed(self, mocker):
        """A PMID absent from submit_and_collect's return dict (how
        results_by_custom_id signals a batch entry that failed or could not
        be parsed) must not be recorded as processed — it must be retried
        on a future run, not silently conflated with a paper that
        legitimately yielded zero genes."""
        mocker.patch("pipeline.main.search_recent_papers", return_value=["111", "222"])
        mocker.patch(
            "pipeline.main.get_existing_pmids",
            new_callable=AsyncMock,
            return_value=set(),
        )
        mocker.patch(
            "pipeline.main.fetch_paper_metadata",
            new_callable=AsyncMock,
            return_value={"doi": None},
        )
        mocker.patch(
            "pipeline.main.get_fulltext",
            new_callable=AsyncMock,
            return_value={
                "text": "paper text",
                "source": "abstract",
                "fulltext": False,
            },
        )
        # 222 legitimately yielded zero genes; 111 is entirely absent —
        # the shape results_by_custom_id produces for a dropped entry.
        mocker.patch(
            "pipeline.main.submit_and_collect",
            new_callable=AsyncMock,
            return_value={"222": []},
        )
        mocker.patch("pipeline.main.reset_gene_sequence", new_callable=AsyncMock)
        mocker.patch("pipeline.main.merge_gene_entries", new_callable=AsyncMock)
        mock_record_pmids = mocker.patch(
            "pipeline.main.record_processed_pmids_batch",
            new_callable=AsyncMock,
            return_value=1,
        )
        mocker.patch("pipeline.main.record_pipeline_run", new_callable=AsyncMock)
        mocker.patch("pipeline.main.write_comprehensive_report")
        mocker.patch("pipeline.main.print_rich_summary")
        mocker.patch("pipeline.main._record_and_notify", new_callable=AsyncMock)
        mocker.patch("pipeline.main._close_metadata_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_http_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_validation_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.close_async_client", new_callable=AsyncMock)
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)
        mocker.patch("pipeline.main.clear_gene_cache")

        metrics, run_data = await run_pipeline(days_back=7, use_batch_api=True)

        assert metrics.papers_processed == 1  # only 222
        assert run_data is not None
        assert run_data["papers"]["failed"] == 1  # 111
        recorded_pmids = {rec[0] for rec in mock_record_pmids.await_args.args[0]}
        assert recorded_pmids == {"222"}


# ---------------------------------------------------------------------------
# CLI parser — new pipeline selector flags
# ---------------------------------------------------------------------------


class TestCliParser:
    def test_pubmed_flag(self):
        args = _build_parser().parse_args(["--pubmed"])
        assert args.pubmed is True
        assert args.clinical_trials is False
        assert args.sync_external_data is False

    def test_clinical_trials_flag(self):
        args = _build_parser().parse_args(["--clinical-trials"])
        assert args.clinical_trials is True
        assert args.pubmed is False
        assert args.sync_external_data is False

    def test_combine_pubmed_and_clinical_trials(self):
        args = _build_parser().parse_args(["--pubmed", "--clinical-trials"])
        assert args.pubmed is True
        assert args.clinical_trials is True

    def test_combine_all_three_online_flags(self):
        args = _build_parser().parse_args(
            ["--pubmed", "--clinical-trials", "--sync-external-data"]
        )
        assert args.pubmed is True
        assert args.clinical_trials is True
        assert args.sync_external_data is True

    def test_no_flags_defaults_false(self):
        args = _build_parser().parse_args([])
        # All selector flags default False at the parser level;
        # main() promotes --pubmed when nothing else is selected.
        assert args.pubmed is False
        assert args.clinical_trials is False
        assert args.sync_external_data is False

    def test_prepare_args_selects_pubmed_by_default(self):
        parser = _build_parser()
        args = _prepare_cli_args(parser, parser.parse_args([]))
        assert args.pubmed is True

    def test_batch_flag_defaults_false(self):
        args = _build_parser().parse_args(["--pubmed"])
        assert args.batch is False

    def test_batch_flag_parses(self):
        args = _build_parser().parse_args(["--pubmed", "--batch"])
        assert args.batch is True

    def test_batch_is_pubmed_only_warning(self, caplog):
        """--batch alongside a non-pubmed online pipeline should warn, the
        same way --dry-run / --test-mode already do."""
        parser = _build_parser()
        args = _prepare_cli_args(
            parser, parser.parse_args(["--clinical-trials", "--batch"])
        )
        assert args.pubmed is False
        assert "PubMed-only" in caplog.text

    @pytest.mark.parametrize(
        "arguments",
        [
            ["--local-pdfs", "/tmp/papers", "--pmids", "/tmp/pmids.txt"],
            ["--local-pdfs", "/tmp/papers", "--pubmed"],
            ["--skip-validation"],
        ],
    )
    def test_prepare_args_rejects_incompatible_modes(self, arguments):
        parser = _build_parser()
        with pytest.raises(SystemExit):
            _prepare_cli_args(parser, parser.parse_args(arguments))


# ---------------------------------------------------------------------------
# _run_selected_pipelines — multi-pipeline dispatcher
# ---------------------------------------------------------------------------


def _make_dispatcher_args(**overrides):
    defaults = {
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
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


class TestRunSelectedPipelines:
    async def test_pubmed_only_calls_run_pipeline(self, mocker):
        mock_run = mocker.patch("pipeline.main.run_pipeline", new_callable=AsyncMock)
        mock_run.return_value = (PipelineMetrics(), {"pipeline_config": {"mode": None}})
        mocker.patch("pipeline.main._record_and_notify")
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)

        args = _make_dispatcher_args(pubmed=True)
        exit_code = await _run_selected_pipelines(args, PipelineConfig())

        assert exit_code == 0
        mock_run.assert_awaited_once()
        # Dispatcher must tell run_pipeline to skip its own lifecycle.
        assert mock_run.await_args.kwargs["manage_lifecycle"] is False

    async def test_clinical_trials_only(self, mocker):
        mock_ct = mocker.patch(
            "pipeline.main.run_clinical_trials_pipeline", new_callable=AsyncMock
        )
        mock_ct.return_value = {
            "name": "clinical_trials",
            "status": "ok",
            "metrics": {"fetched": 1, "cached": 1, "failed": 0},
            "errors": [],
        }
        mock_run = mocker.patch("pipeline.main.run_pipeline", new_callable=AsyncMock)
        mocker.patch("pipeline.main._record_and_notify")
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)

        args = _make_dispatcher_args(clinical_trials=True)
        exit_code = await _run_selected_pipelines(args, PipelineConfig())

        assert exit_code == 0
        mock_ct.assert_awaited_once()
        mock_run.assert_not_awaited()

    async def test_pubmed_and_clinical_trials_run_sequentially(self, mocker):
        mock_run = mocker.patch("pipeline.main.run_pipeline", new_callable=AsyncMock)
        mock_run.return_value = (PipelineMetrics(), None)
        mock_ct = mocker.patch(
            "pipeline.main.run_clinical_trials_pipeline", new_callable=AsyncMock
        )
        mock_ct.return_value = {
            "name": "clinical_trials",
            "status": "ok",
            "metrics": {},
            "errors": [],
        }
        mocker.patch("pipeline.main._record_and_notify")
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)

        args = _make_dispatcher_args(pubmed=True, clinical_trials=True)
        exit_code = await _run_selected_pipelines(args, PipelineConfig())

        assert exit_code == 0
        mock_run.assert_awaited_once()
        mock_ct.assert_awaited_once()

    async def test_pubmed_failure_still_runs_clinical_trials(self, mocker):
        """Continue-on-error: one pipeline's failure doesn't skip the next."""
        mock_run = mocker.patch("pipeline.main.run_pipeline", new_callable=AsyncMock)
        mock_run.side_effect = RuntimeError("pubmed exploded")
        mock_ct = mocker.patch(
            "pipeline.main.run_clinical_trials_pipeline", new_callable=AsyncMock
        )
        mock_ct.return_value = {
            "name": "clinical_trials",
            "status": "ok",
            "metrics": {},
            "errors": [],
        }
        mocker.patch("pipeline.main._record_and_notify")
        mocker.patch("pipeline.main.Database.close", new_callable=AsyncMock)

        args = _make_dispatcher_args(pubmed=True, clinical_trials=True)
        exit_code = await _run_selected_pipelines(args, PipelineConfig())

        assert exit_code == 1  # failure reported
        mock_ct.assert_awaited_once()  # still ran CT after PubMed failed


class TestSecretRedaction:
    """httpx logs every request at INFO with the full URL, and NCBI takes
    its credential as a query parameter, so an unfiltered run wrote the real
    api_key into logs/log/*.log on every abstract fetch and gene validation.
    Found by reading the log of the first live ingest run.
    """

    @staticmethod
    def _emit(msg, *args):
        import logging

        record = logging.LogRecord(
            "probe", logging.INFO, __file__, 1, msg, args, None
        )
        assert _RedactSecrets().filter(record) is True
        return record.getMessage()

    def test_api_key_in_a_url_argument_is_redacted(self):
        """The realistic shape: httpx passes the URL as an *arg*, so a
        filter that only rewrote record.msg would miss it entirely."""
        out = self._emit(
            'HTTP Request: %s %s "%s"',
            "GET",
            "https://eutils.ncbi.nlm.nih.gov/efetch.fcgi?db=pubmed&api_key=SEKRIT123",
            "HTTP/1.1 200 OK",
        )
        assert "SEKRIT123" not in out
        assert "api_key=<redacted>" in out
        # The rest of the record must survive -- the request log is how the
        # retrieval cascade gets traced.
        assert "eutils.ncbi.nlm.nih.gov" in out
        assert "db=pubmed" in out
        assert "HTTP/1.1 200 OK" in out

    @pytest.mark.parametrize(
        "param", ["api_key", "apikey", "access_token", "token", "password", "secret"]
    )
    def test_every_credential_parameter_is_redacted(self, param):
        out = self._emit(f"GET https://x.test/a?{param}=SEKRIT123&b=2")
        assert "SEKRIT123" not in out
        assert "b=2" in out

    def test_contact_email_is_deliberately_kept(self):
        """Unpaywall and NCBI require a contact address by policy; it is not
        a secret, and redacting it would make their logs unusable."""
        out = self._emit("GET https://api.unpaywall.org/v2/10.1/x?email=a@b.edu")
        assert "a@b.edu" in out

    def test_records_without_a_secret_keep_lazy_formatting(self):
        """Only a record that actually changed gets collapsed, so ordinary
        logging keeps deferring its %-formatting to the handler."""
        import logging

        record = logging.LogRecord(
            "probe", logging.INFO, __file__, 1, "processed %d papers", (3,), None
        )
        _RedactSecrets().filter(record)
        assert record.args == (3,)
        assert record.getMessage() == "processed 3 papers"
