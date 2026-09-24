"""Tests for pipeline.run_report -- the document the dashboard publishes."""

from typing import Any

import pytest

from pipeline.api_telemetry import ApiRecorder
from pipeline.citations import ProvenanceTally
from pipeline.run_errors import RunError, RunWarning
from pipeline.run_report import (
    DETAIL_CAP,
    CappedList,
    GeneRecord,
    PipelineRunReport,
    RunConfigRecord,
    build_run_report,
    derive_status,
)
from pipeline.steps import StepRecorder


def _gene(symbol: str, confidence: float = 0.9) -> dict[str, Any]:
    return {
        "gene_symbol": symbol,
        "protein_name": f"{symbol} protein",
        "gwas_trait": ["PVWMH"],
        "mendelian_randomization": False,
        "omics_evidence": ["MAGMA"],
        "confidence": confidence,
        "causal_evidence_summary": f"Why {symbol} qualifies.",
        "pmid": "32517579",
        "source_quote": f"A sentence naming {symbol}.",
    }


def _run_data(**overrides: Any) -> dict[str, Any]:
    """A PipelineRunData dict shaped like the ones report.py builds."""
    data: dict[str, Any] = {
        "timestamp": "2026-08-31T02:46:33.181802+00:00",
        "total_processing_time": 166.81302512501134,
        "total_compute_time": 763.2548729160044,
        "pipeline_config": {
            "llm_provider": "anthropic",
            "model": "claude-opus-5",
            "effort": "high",
            "prompt_version": "v6",
            "mode": "pmid_list",
            "skip_validation": False,
            "confidence_threshold_update": 0.45,
            "confidence_threshold_insert": 0.65,
        },
        "papers": {
            "processed": 15,
            "fulltext": 10,
            "abstract_only": 5,
            "fulltext_rate": 0.6667,
            "failed": 1,
        },
        "genes": {
            "extracted": 3,
            "validated": 2,
            "rejected": 1,
            "acceptance_rate": 0.67,
        },
        "token_usage": {
            "input_tokens": 153712,
            "output_tokens": 21872,
            "thinking_tokens": 3624,
            "cache_read_input_tokens": 134985,
            "total_tokens": 175584,
            "cache_hit_rate": 0.4676,
            "truncated_responses": 0,
            "estimated_cost_usd": 1.38,
        },
        "batch_validation_warnings": [],
        "papers_detail": [
            {
                "pmid": "32517579",
                "fulltext": True,
                "source": "europepmc",
                "error": None,
                "gene_count": 2,
                "genes": [_gene("HTRA1", 1.0), _gene("COL4A1", 0.8)],
                "rejected_genes": [
                    {
                        "gene": _gene("POLR2F", 0.6),
                        "reasons": ["Low confidence: 0.60 < 0.65"],
                    }
                ],
                "processing_time": 10.664427833005902,
            }
        ],
    }
    data.update(overrides)
    return data


def _report(
    provenance: ProvenanceTally | None = None, **overrides: Any
) -> PipelineRunReport:
    recorder = StepRecorder()
    recorder.enter(0)
    api = ApiRecorder()
    api.record(host="rest.uniprot.org", path="/uniprotkb/P1", method="GET", status=200)
    return build_run_report(
        _run_data(**overrides),
        steps=recorder.records(),
        apis=api.records(),
        run_mode="pmid_list",
        provenance=provenance,
    )


def test_run_config_record_carries_disease_and_prompt_hash() -> None:
    record = RunConfigRecord.model_validate(
        {"prompt_version": "v7", "disease": "csvd", "prompt_sha256": "ab" * 32}
    )
    assert record.model_dump(by_alias=True)["promptSha256"] == "ab" * 32
    assert record.model_dump(by_alias=True)["disease"] == "csvd"
    # A row written before the fields existed still validates.
    assert RunConfigRecord.model_validate({"prompt_version": "v6"}).disease is None


class TestWireShape:
    def test_keys_are_camel_case(self) -> None:
        wire = _report().to_wire()
        assert "runTimestamp" in wire
        assert "run_timestamp" not in wire
        assert wire["papers"]["abstractOnly"] == 5

    def test_field_order_is_the_wire_order(self) -> None:
        # The export is byte-gated, so a reordering here must be a visible
        # diff rather than a silent one.
        assert list(_report().to_wire()) == [
            "runTimestamp",
            "status",
            "runMode",
            "durationSeconds",
            "computeSeconds",
            "config",
            "papers",
            "genes",
            "tokens",
            "database",
            "steps",
            "apis",
            "papersDetail",
            "acceptedGenes",
            "rejectedGenes",
        ]

    def test_the_document_round_trips_through_the_model(self) -> None:
        # This is the database boundary: stored as JSON, read back here.
        wire = _report().to_wire()
        assert PipelineRunReport.model_validate(wire).to_wire() == wire


class TestCounts:
    def test_counts_come_from_the_run_data_unchanged(self) -> None:
        report = _report()
        assert report.papers.processed == 15
        assert report.papers.failed == 1
        assert report.genes.extracted == 3
        assert report.genes.validated == 2
        assert report.genes.rejected == 1

    def test_search_counts_are_absent_on_an_offline_run(self) -> None:
        # An offline run was handed its identifiers and never searched, so
        # reporting zero found would be a claim it cannot make.
        report = _report()
        assert report.papers.found is None
        assert report.papers.newly_seen is None

    def test_search_counts_are_carried_on_a_pubmed_run(self) -> None:
        report = _report(
            search={"pmids_found": 40, "pmids_new": 9, "pmids_skipped": 31}
        )
        assert report.papers.found == 40
        assert report.papers.newly_seen == 9
        assert report.papers.already_seen == 31

    def test_the_insert_floor_count_is_separate_from_validation(self) -> None:
        # Two different gates. The validation floor rejects per paper; the
        # insert floor rejects at the merge and only for a new row.
        report = _report(
            database={
                "inserted": 1,
                "updated": 0,
                "held_below_insert_floor": [
                    {"gene_symbol": "WDR12", "confidence": 0.6},
                    {"gene_symbol": "CALCRL", "confidence": 0.55},
                ],
            }
        )
        assert report.genes.rejected == 1
        assert report.genes.rejected_at_insert_floor == 2

    def test_a_held_gene_is_not_also_listed_as_accepted(self) -> None:
        # It passes validation, so it is in papers_detail[*].genes; it is
        # refused at the merge, so it is in `held`. Listing it under both
        # "Genes accepted" and "Genes rejected" was two answers to the
        # same question.
        report = _report(
            database={
                "inserted": 0,
                "updated": 0,
                "held_below_insert_floor": [
                    {"gene_symbol": "COL4A1", "confidence": 0.6}
                ],
            },
            papers_detail=[
                {
                    "pmid": "1",
                    "source": "europepmc",
                    "fulltext": True,
                    "gene_count": 2,
                    "genes": [_gene("HTRA1"), _gene("COL4A1", 0.6)],
                    "rejected_genes": [],
                    "processing_time": 1.0,
                }
            ],
        )
        accepted = [gene.symbol for gene in report.accepted_genes.items]
        rejected = [gene.symbol for gene in report.rejected_genes.items]
        assert accepted == ["HTRA1"]
        assert "COL4A1" in rejected
        assert set(accepted).isdisjoint(rejected)

    def test_a_held_gene_is_matched_under_its_canonical_key(
        self, gene_aliases
    ) -> None:
        # `merge_gene_entries` groups on the canonical key, so a held
        # member symbol (cSVD's COL4A1) is recorded under the curated label
        # (COL4A1/2). The extracted symbol has to go through the same
        # mapping, or the gene is listed under both accepted and rejected --
        # the double count this exclusion exists to remove.
        report = _report(
            database={
                "inserted": 0,
                "updated": 0,
                "held_below_insert_floor": [
                    {"gene_symbol": "GENEA/B", "confidence": 0.6}
                ],
            },
            papers_detail=[
                {
                    "pmid": "1",
                    "source": "europepmc",
                    "fulltext": True,
                    "gene_count": 2,
                    "genes": [_gene("HTRA1"), _gene("GENEA", 0.6)],
                    "rejected_genes": [],
                    "processing_time": 1.0,
                }
            ],
        )
        accepted = [gene.symbol for gene in report.accepted_genes.items]
        rejected = [gene.symbol for gene in report.rejected_genes.items]
        assert accepted == ["HTRA1"]
        assert rejected == ["GENEA/B"]

    def test_insert_floor_holds_survive_the_cap(self) -> None:
        # Holds are few and validation rejections are many, so appending
        # holds last truncated the whole category away on a large run
        # while its count still published.
        papers = [
            {
                "pmid": str(i),
                "source": "abstract",
                "fulltext": False,
                "gene_count": 0,
                "genes": [],
                "rejected_genes": [
                    {"gene": _gene(f"G{i}", 0.4), "reasons": ["Low confidence"]}
                ],
                "processing_time": 1.0,
            }
            for i in range(DETAIL_CAP + 40)
        ]
        report = _report(
            papers_detail=papers,
            database={
                "inserted": 0,
                "updated": 0,
                "held_below_insert_floor": [
                    {"gene_symbol": "WDR12", "confidence": 0.6}
                ],
            },
        )
        assert report.rejected_genes.truncated
        assert "WDR12" in [gene.symbol for gene in report.rejected_genes.items]

    def test_a_run_that_wrote_nothing_holds_nothing(self) -> None:
        assert _report().genes.rejected_at_insert_floor == 0

    def test_no_text_counts_only_papers_that_actually_retrieved(self) -> None:
        # "none" means retrieval succeeded and returned nothing. A paper
        # that errored is not that, and counting it here double-counted it
        # against papers.failed -- which happened for every errored paper
        # while "none" was PaperResult's default source.
        report = _report(
            papers_detail=[
                {"pmid": "1", "source": "none", "fulltext": False, "genes": []},
                {
                    "pmid": "2",
                    "source": "unknown",
                    "error": "boom",
                    "fulltext": False,
                    "genes": [],
                },
                {
                    "pmid": "3",
                    "source": "europepmc",
                    "fulltext": True,
                    "genes": [],
                },
            ]
        )
        assert report.papers.no_text_available == 1

    def test_the_retrieval_counts_cannot_exceed_processed(self) -> None:
        report = _report(
            papers={
                "processed": 2,
                "fulltext": 1,
                "abstract_only": 0,
                "failed": 1,
            },
            papers_detail=[
                {"pmid": "1", "source": "none", "fulltext": False, "genes": []},
                {"pmid": "2", "source": "unknown", "error": "boom", "genes": []},
                {"pmid": "3", "source": "europepmc", "fulltext": True, "genes": []},
            ],
        )
        papers = report.papers
        assert (
            papers.fulltext + papers.abstract_only + papers.no_text_available
            <= papers.processed
        )

    def test_no_text_is_not_folded_into_failed(self) -> None:
        # The online paths record it as *processed* on purpose, so that a
        # paper with no retrievable text is not retried on every run.
        # Folding it into `failed` would misreport those runs.
        report = _report(
            papers={"processed": 3, "fulltext": 1, "abstract_only": 0, "failed": 0},
            papers_detail=[
                {"pmid": "1", "source": "none", "fulltext": False, "genes": []},
            ],
        )
        assert report.papers.failed == 0
        assert report.papers.no_text_available == 1

    def test_a_dry_run_records_no_database_writes(self) -> None:
        assert _report().database is None

    def test_database_writes_are_carried_when_present(self) -> None:
        report = _report(database={"inserted": 4, "updated": 7})
        assert report.database is not None
        assert (report.database.inserted, report.database.updated) == (4, 7)


class TestDetail:
    def test_accepted_genes_are_flattened_across_papers(self) -> None:
        report = _report()
        assert [gene.symbol for gene in report.accepted_genes.items] == [
            "HTRA1",
            "COL4A1",
        ]

    def test_a_gene_carries_its_evidence_not_just_its_name(self) -> None:
        gene = _report().accepted_genes.items[0]
        assert gene.source_quote == "A sentence naming HTRA1."
        assert gene.causal_evidence_summary == "Why HTRA1 qualifies."
        assert gene.omics_evidence == ["MAGMA"]
        assert gene.mendelian_randomization is False

    def test_insert_floor_rejections_join_the_rejected_list(self) -> None:
        # They were logged by symbol and counted nowhere before, so the
        # drawer would have shown an acceptance rate that overstated.
        report = _report(
            database={
                "inserted": 0,
                "updated": 0,
                "held_below_insert_floor": [
                    {"gene_symbol": "WDR12", "confidence": 0.6}
                ],
            }
        )
        held = [r for r in report.rejected_genes.items if r.symbol == "WDR12"]
        assert len(held) == 1
        assert held[0].reasons == [
            "Held below the insert floor: 0.60 < 0.65 (new gene)"
        ]

    def test_the_two_gates_are_distinguishable_in_the_reasons(self) -> None:
        report = _report(
            database={
                "inserted": 0,
                "updated": 0,
                "held_below_insert_floor": [
                    {"gene_symbol": "WDR12", "confidence": 0.6}
                ],
            }
        )
        reasons = [r.reasons[0] for r in report.rejected_genes.items]
        assert "Low confidence: 0.60 < 0.65" in reasons
        assert "Held below the insert floor: 0.60 < 0.65 (new gene)" in reasons

    def test_a_held_gene_without_a_score_still_reads(self) -> None:
        report = _report(
            database={
                "inserted": 0,
                "updated": 0,
                "held_below_insert_floor": [{"gene_symbol": "MYSTERY"}],
            }
        )
        held = [r for r in report.rejected_genes.items if r.symbol == "MYSTERY"]
        assert held[0].reasons == ["Held below the insert floor: ? < 0.65 (new gene)"]

    def test_rejections_keep_the_pipelines_own_wording(self) -> None:
        rejected = _report().rejected_genes.items[0]
        assert rejected.symbol == "POLR2F"
        assert rejected.reasons == ["Low confidence: 0.60 < 0.65"]
        assert rejected.confidence == 0.6

    def test_paper_records_count_their_rejections(self) -> None:
        paper = _report().papers_detail.items[0]
        assert paper.pmid == "32517579"
        assert paper.gene_count == 2
        assert paper.rejected_count == 1
        assert paper.fulltext is True

    def test_durations_are_rounded_to_milliseconds(self) -> None:
        report = _report()
        assert report.duration_seconds == 166.813
        assert report.papers_detail.items[0].processing_seconds == 10.664


class TestCappedList:
    def test_a_short_list_is_not_truncated(self) -> None:
        capped = CappedList[GeneRecord].of([GeneRecord(symbol="A")])
        assert (capped.shown, capped.total) == (1, 1)
        assert not capped.truncated

    def test_a_long_list_reports_what_it_left_out(self) -> None:
        values = [GeneRecord(symbol=f"G{i}") for i in range(DETAIL_CAP + 50)]
        capped = CappedList[GeneRecord].of(values)
        assert capped.shown == DETAIL_CAP
        assert capped.total == DETAIL_CAP + 50
        assert len(capped.items) == DETAIL_CAP
        assert capped.truncated

    def test_counts_stay_exact_when_detail_is_capped(self) -> None:
        # The cap trims enumerations only; the headline numbers above them
        # are never trimmed.
        papers = [
            {
                "pmid": str(i),
                "fulltext": False,
                "source": "abstract",
                "gene_count": 1,
                "genes": [_gene(f"G{i}")],
                "rejected_genes": [],
                "processing_time": 1.0,
            }
            for i in range(DETAIL_CAP + 10)
        ]
        report = _report(
            papers_detail=papers, genes={"extracted": 999, "validated": 999}
        )
        assert report.genes.extracted == 999
        assert report.accepted_genes.total == DETAIL_CAP + 10
        assert report.accepted_genes.shown == DETAIL_CAP

    def test_an_empty_list_is_well_formed(self) -> None:
        report = _report(papers_detail=[])
        assert report.accepted_genes.total == 0
        assert report.accepted_genes.items == []


class TestDeriveStatus:
    def test_a_clean_run_is_completed(self) -> None:
        recorder = StepRecorder()
        recorder.enter(0)
        assert derive_status(recorder.records()) == "completed"

    def test_a_warning_downgrades_the_headline(self) -> None:
        # The widget exists to make losses visible; a green badge over 24
        # rejected genes would be the same silence it replaces.
        recorder = StepRecorder()
        recorder.enter(0)
        recorder.warn(RunWarning(kind="genes_rejected", title="24 rejected", count=24))
        assert derive_status(recorder.records()) == "completed_with_warnings"

    def test_a_failure_outranks_a_warning(self) -> None:
        recorder = StepRecorder()
        recorder.enter(0)
        recorder.warn(RunWarning(kind="genes_rejected", title="x"))
        recorder.enter(1)
        recorder.fail(RunError(kind="timeout", title="timed out"))
        assert derive_status(recorder.records()) == "failed"

    def test_the_report_carries_the_derived_status(self) -> None:
        assert _report().status == "completed"


class TestMissingFields:
    """The builder reads a dict, so it must not assume every key is there."""

    @pytest.mark.parametrize(
        "missing",
        ["papers", "genes", "token_usage", "pipeline_config", "papers_detail"],
    )
    def test_a_missing_block_falls_back_to_defaults(self, missing: str) -> None:
        data = _run_data()
        del data[missing]
        report = build_run_report(data, steps=[], apis=[], run_mode="standard")
        assert isinstance(report.to_wire(), dict)

    def test_a_run_without_a_tally_reports_no_quote_checks(self) -> None:
        report = _report()
        assert report.genes.quotes_checked == 0
        assert report.genes.quotes_verbatim == 0
        assert report.genes.quotes_cited == 0

    def test_an_empty_run_produces_a_valid_document(self) -> None:
        report = build_run_report({}, steps=[], apis=[], run_mode="standard")
        assert report.run_timestamp == ""
        assert report.status == "completed"
        assert report.papers.processed == 0


class TestProvenanceCounts:
    """The two quote numbers, which are not the same claim."""

    def test_the_tally_reaches_the_report(self) -> None:
        report = _report(
            ProvenanceTally(genes=138, verbatim=137, cited=45)
        )
        assert report.genes.quotes_checked == 138
        assert report.genes.quotes_verbatim == 137
        assert report.genes.quotes_cited == 45

    def test_the_two_numbers_stay_apart(self) -> None:
        # `cited` is bounded by how much prose the model wrote rather than
        # by quote quality, so it running far below `verbatim` is expected
        # and must not be collapsed into one figure.
        report = _report(ProvenanceTally(genes=138, verbatim=137, cited=45))
        assert report.genes.quotes_verbatim > report.genes.quotes_cited

    def test_the_counts_survive_the_wire(self) -> None:
        wire = _report(ProvenanceTally(genes=10, verbatim=9, cited=3)).to_wire()
        assert wire["genes"]["quotesChecked"] == 10
        assert wire["genes"]["quotesVerbatim"] == 9
        assert wire["genes"]["quotesCited"] == 3
