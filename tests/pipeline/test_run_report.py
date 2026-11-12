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
    recover_search_window,
    reword_findings,
)
from pipeline.steps import StepRecorder


def _gene(symbol: str, confidence: float = 0.9) -> dict[str, Any]:
    return {
        "gene_symbol": symbol,
        "protein_name": f"{symbol} protein",
        "gwas_trait": ["TRAIT-A"],
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
                "genes": [_gene("GENE1", 1.0), _gene("GENE2", 0.8)],
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
                    {"gene_symbol": "GENE3", "confidence": 0.6},
                    {"gene_symbol": "GENE4", "confidence": 0.55},
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
                    {"gene_symbol": "GENE2", "confidence": 0.6}
                ],
            },
            papers_detail=[
                {
                    "pmid": "1",
                    "source": "europepmc",
                    "fulltext": True,
                    "gene_count": 2,
                    "genes": [_gene("GENE1"), _gene("GENE2", 0.6)],
                    "rejected_genes": [],
                    "processing_time": 1.0,
                }
            ],
        )
        accepted = [gene.symbol for gene in report.accepted_genes.items]
        rejected = [gene.symbol for gene in report.rejected_genes.items]
        assert accepted == ["GENE1"]
        assert "GENE2" in rejected
        assert set(accepted).isdisjoint(rejected)

    def test_a_held_gene_is_matched_under_its_canonical_key(
        self, gene_aliases
    ) -> None:
        # `merge_gene_entries` groups on the canonical key, so a held
        # member symbol (GENEA) is recorded under the curated label
        # (GENEA/B). The extracted symbol has to go through the same
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
                    "genes": [_gene("GENE1"), _gene("GENEA", 0.6)],
                    "rejected_genes": [],
                    "processing_time": 1.0,
                }
            ],
        )
        accepted = [gene.symbol for gene in report.accepted_genes.items]
        rejected = [gene.symbol for gene in report.rejected_genes.items]
        assert accepted == ["GENE1"]
        # Under the paper's own spelling, as the accepted list names a gene.
        assert rejected == ["GENEA"]

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
                    {"gene_symbol": "GENE3", "confidence": 0.6}
                ],
            },
        )
        assert report.rejected_genes.truncated
        assert "GENE3" in [gene.symbol for gene in report.rejected_genes.items]

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
            "GENE1",
            "GENE2",
        ]

    def test_a_gene_carries_its_evidence_not_just_its_name(self) -> None:
        gene = _report().accepted_genes.items[0]
        assert gene.source_quote == "A sentence naming GENE1."
        assert gene.causal_evidence_summary == "Why GENE1 qualifies."
        assert gene.omics_evidence == ["MAGMA"]
        assert gene.mendelian_randomization is False

    def test_a_structured_study_is_published_in_its_wire_form(self) -> None:
        """Prompt v8's studies reach papers_detail as dicts; the report keeps
        publishing strings, so a report stored before v8 still validates."""
        gene = _gene("GENE1")
        gene["omics_evidence"] = [
            {
                "study_type": "TWAS",
                "biomarker": "Q",
                "items": [{"text": "a", "colocalized": True}],
            }
        ]
        report = _report(
            papers_detail=[
                {
                    "pmid": "1",
                    "source": "europepmc",
                    "fulltext": True,
                    "gene_count": 1,
                    "genes": [gene],
                    "rejected_genes": [],
                    "processing_time": 1.0,
                }
            ],
        )
        assert report.accepted_genes.items[0].omics_evidence == ["TWAS;Q: a*"]

    def test_insert_floor_rejections_join_the_rejected_list(self) -> None:
        # They were logged by symbol and counted nowhere before, so the
        # drawer would have shown an acceptance rate that overstated.
        report = _report(
            database={
                "inserted": 0,
                "updated": 0,
                "held_below_insert_floor": [
                    {"gene_symbol": "GENE3", "confidence": 0.6}
                ],
            }
        )
        held = [r for r in report.rejected_genes.items if r.symbol == "GENE3"]
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
                    {"gene_symbol": "GENE3", "confidence": 0.6}
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

    def test_a_paper_counts_a_held_gene_as_rejected_not_accepted(self) -> None:
        # `gene_count` is what the drawer prints as "N accepted" on a
        # paper's row. A gene the insert floor held passed validation, so
        # the paper's own count included it: PMID 42957517 read "2
        # accepted" on 2026-11-03 with neither gene in the accepted list,
        # and the rows summed to 19 under a headline of 10.
        report = _report(
            database={
                "inserted": 0,
                "updated": 0,
                "held_below_insert_floor": [
                    {"gene_symbol": "GENE2", "confidence": 0.6}
                ],
            },
            papers_detail=[
                {
                    "pmid": "1",
                    "source": "europepmc",
                    "fulltext": True,
                    "gene_count": 2,
                    "genes": [_gene("GENE1"), _gene("GENE2", 0.6)],
                    "rejected_genes": [
                        {
                            "gene": _gene("POLR2F", 0.3),
                            "reasons": ["Low confidence: 0.30 < 0.45"],
                        }
                    ],
                    "processing_time": 1.0,
                }
            ],
        )
        paper = report.papers_detail.items[0]
        assert paper.gene_count == 1
        assert paper.rejected_count == 2
        assert paper.gene_count == sum(
            gene.pmid == "32517579" for gene in report.accepted_genes.items
        )

    def test_a_hold_is_listed_once_per_paper_that_proposed_it(self) -> None:
        # The merge groups by gene, so it returns one hold per gene with no
        # PMID. Every other number beside it counts a paper's mention, so
        # one gene held from two papers left the funnel one short: the
        # 2026-11-03 run validated 19, accepted 10 and held 8. A hold is
        # now a record per mention, with the paper and the score that
        # mention carried.
        papers = [
            {
                "pmid": pmid,
                "source": "europepmc",
                "fulltext": True,
                "gene_count": len(genes),
                "genes": genes,
                "rejected_genes": [],
                "processing_time": 1.0,
            }
            for pmid, genes in (
                ("1", [_gene("GENE1"), _gene("GENE3", 0.6), _gene("GENE4", 0.55)]),
                ("2", [_gene("GENE4", 0.5)]),
            )
        ]
        report = _report(
            genes={"extracted": 4, "validated": 4, "rejected": 0},
            database={
                "inserted": 0,
                "updated": 1,
                "held_below_insert_floor": [
                    {"gene_symbol": "GENE3", "confidence": 0.6},
                    {"gene_symbol": "GENE4", "confidence": 0.55},
                ],
            },
            papers_detail=papers,
        )
        held = [
            (gene.symbol, gene.pmid, gene.confidence)
            for gene in report.rejected_genes.items
        ]
        assert held == [
            ("GENE3", "1", 0.6),
            ("GENE4", "1", 0.55),
            ("GENE4", "2", 0.5),
        ]
        assert report.rejected_genes.items[2].reasons == [
            "Held below the insert floor: 0.50 < 0.65 (new gene)"
        ]
        # The funnel closes, and each paper's row agrees with the lists.
        assert report.genes.rejected_at_insert_floor == 3
        assert report.genes.validated == (
            report.accepted_genes.total + report.genes.rejected_at_insert_floor
        )
        assert [p.rejected_count for p in report.papers_detail.items] == [2, 1]

    def test_a_hold_no_paper_proposed_is_still_listed(self) -> None:
        # Nothing produces one today; dropping it would be the wrong way
        # to find out, so it keeps the merge's own key and score.
        report = _report(
            database={
                "inserted": 0,
                "updated": 0,
                "held_below_insert_floor": [
                    {"gene_symbol": "GENE3", "confidence": 0.6}
                ],
            }
        )
        (held,) = [g for g in report.rejected_genes.items if g.symbol == "GENE3"]
        assert held.pmid is None
        assert report.genes.rejected_at_insert_floor == 1

    def test_a_citation_only_gene_shows_what_was_written(self) -> None:
        # An existing gene below the insert floor takes the PMID, the quote
        # and the score, and nothing else (`_citation_only`). The drawer's
        # record still carried the extracted trait, omics evidence and
        # Mendelian randomization, with nothing saying the row took none.
        report = _report(
            database={
                "inserted": 0,
                "updated": 2,
                "held_below_insert_floor": [],
                "citation_only": ["GENE2"],
            },
        )
        cited, claimed = (
            next(g for g in report.accepted_genes.items if g.symbol == symbol)
            for symbol in ("GENE2", "GENE1")
        )
        assert cited.citation_only is True
        assert cited.gwas_traits == []
        assert cited.omics_evidence == []
        assert cited.mendelian_randomization is None
        # What the citation is made of stays.
        assert cited.source_quote == "A sentence naming GENE2."
        assert cited.confidence == 0.8
        assert claimed.citation_only is False
        assert claimed.gwas_traits == ["TRAIT-A"]

    def test_the_report_says_how_it_was_run_and_what_it_cached(self) -> None:
        # `--batch` halves the cost and cache writes are billed above
        # input, so without these two the published cost could not be
        # reconciled from the published document.
        report = _report(
            pipeline_config={"model": "claude-opus-5", "batch": True},
            token_usage={"input_tokens": 10, "cache_creation_input_tokens": 7},
        )
        assert report.config.batch is True
        assert report.tokens.cache_creation_input_tokens == 7
        wire = report.to_wire()
        # Each was appended after the last, so no earlier key moved: field
        # order is wire order, and the search window came after these.
        assert list(wire["config"])[-2:] == ["batch", "daysBack"]
        assert list(wire["tokens"])[-1] == "cacheCreationInputTokens"

    def test_a_report_stored_before_them_reads_unknown_not_zero(self) -> None:
        report = _report()
        assert report.config.batch is None
        assert report.tokens.cache_creation_input_tokens is None

    def test_a_paper_nobody_timed_publishes_no_duration(self) -> None:
        # A --batch entry is never timed (`PaperResult.processing_time`
        # stays 0.0), and "0 ms" on every row of a day-long batch is a
        # measurement nobody took.
        report = _report(
            papers_detail=[
                {
                    "pmid": "1",
                    "source": "europepmc",
                    "fulltext": True,
                    "gene_count": 0,
                    "genes": [],
                    "rejected_genes": [],
                    "processing_time": 0.0,
                }
            ]
        )
        assert report.papers_detail.items[0].processing_seconds is None

    def test_paper_records_carry_the_serving_model_and_refusal(self) -> None:
        papers = [
            {**_run_data()["papers_detail"][0], "extraction_model": "claude-opus-4-8",
             "refusal": "bio"},
            {**_run_data()["papers_detail"][0], "pmid": "2", "error": "Refused",
             "refusal": "cyber", "extraction_model": None},
        ]
        report = _report(papers_detail=papers)
        served, refused = report.papers_detail.items
        assert (served.extraction_model, served.refusal) == ("claude-opus-4-8", "bio")
        assert (refused.extraction_model, refused.refusal) == (None, "cyber")
        wire = served.model_dump(by_alias=True)
        assert list(wire)[-3:] == ["error", "extractionModel", "refusal"]

    def test_the_config_names_the_fallback_model(self) -> None:
        config = {**_run_data()["pipeline_config"], "fallback_model": "claude-opus-4-8"}
        report = _report(pipeline_config=config)
        assert report.config.fallback_model == "claude-opus-4-8"
        assert list(report.config.model_dump(by_alias=True))[:2] == [
            "model",
            "fallbackModel",
        ]

    def test_a_report_stored_before_the_fallback_still_validates(self) -> None:
        """A stored report with none of the new keys re-validates, null-filled."""
        import json
        from pathlib import Path

        from pipeline.run_report import PipelineRunReport

        committed = json.loads(Path("data/pipeline_run.json").read_text())
        if committed is None:
            pytest.skip("data/pipeline_run.json is null (empty-data mode)")
        committed["config"].pop("fallbackModel", None)
        for paper in committed["papersDetail"]["items"]:
            paper.pop("extractionModel", None)
            paper.pop("refusal", None)
        report = PipelineRunReport.model_validate(committed)
        assert report.config.fallback_model is None
        assert all(p.refusal is None for p in report.papers_detail.items)

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


class TestTheSearchWindow:
    """How far back the run searched, as a field of its own.

    The run card's Search row says "1,571 papers matched" and could not say
    of what: the window was only inside the step's sentence.
    """

    def _searched(self, sentence: str | None, **config: Any) -> PipelineRunReport:
        recorder = StepRecorder()
        recorder.enter(0)
        if sentence is not None:
            recorder.action(sentence)
        data = _run_data()
        data["pipeline_config"] = {**data["pipeline_config"], **config}
        return build_run_report(
            data, steps=recorder.records(), apis=[], run_mode="standard"
        )

    def test_the_config_carries_it(self) -> None:
        report = self._searched(None, days_back=730)
        assert report.config.days_back == 730
        assert report.to_wire()["config"]["daysBack"] == 730

    def test_a_run_that_searched_nothing_has_none(self) -> None:
        # An offline run was handed its identifiers.
        assert _report().config.days_back is None
        assert _report().to_wire()["config"]["daysBack"] is None

    def test_an_older_report_gets_it_back_from_its_own_sentence(self) -> None:
        # The pipeline wrote the sentence, so its number is the run's own.
        stored = self._searched(
            "Searched PubMed over the last 730 days: 1571 papers matched"
        )
        assert stored.config.days_back is None
        assert recover_search_window(stored).config.days_back == 730

    def test_one_day_is_recovered_too(self) -> None:
        stored = self._searched(
            "Searched PubMed over the last 1 days: 3 papers matched"
        )
        assert recover_search_window(stored).config.days_back == 1

    def test_a_recorded_window_is_left_alone(self) -> None:
        stored = self._searched(
            "Searched PubMed over the last 730 days: 1571 papers matched",
            days_back=30,
        )
        assert recover_search_window(stored) is stored

    def test_a_sentence_that_names_none_recovers_nothing(self) -> None:
        for sentence in (None, "Read 12 PMIDs from the list"):
            stored = self._searched(sentence)
            assert recover_search_window(stored) is stored


class TestFindingsAreNotGenes:
    """A finding is one paper's proposal of a gene; a gene is a row.

    The sentences that count proposals said "genes", beside rows of the
    card that say "findings" for the same numbers. An older stored report
    is reworded on the way out, so the page does not say both.
    """

    def _stored(self) -> PipelineRunReport:
        recorder = StepRecorder()
        recorder.enter(2)
        recorder.action("Retrieved full text for 27, abstract only for 10")
        recorder.action("Extracted 33 genes, of which 19 passed validation")
        recorder.warn(
            RunWarning(
                kind="genes_rejected",
                title="14 genes did not clear the validation floor",
                count=14,
            )
        )
        recorder.warn(
            RunWarning(
                kind="quote_unverified",
                title=(
                    "1 gene was dropped because the quoted sentence was not "
                    "found in the paper"
                ),
                count=1,
                subjects=["GENE1"],
            )
        )
        recorder.enter(3)
        recorder.action("Cross-checked 19 genes against the rest of the batch")
        recorder.enter(4)
        recorder.action("Inserted 1 gene and updated 4")
        recorder.warn(
            RunWarning(
                kind="genes_rejected",
                title="8 new genes were held below the insert floor",
                count=8,
            )
        )
        return build_run_report(
            _run_data(), steps=recorder.records(), apis=[], run_mode="standard"
        )

    def test_the_sentences_that_count_findings_say_so(self) -> None:
        steps = {step.key: step for step in reword_findings(self._stored()).steps}
        assert steps["processing_papers"].actions == [
            "Retrieved full text for 27, abstract only for 10",
            "Extracted 33 findings, of which 19 passed validation",
        ]
        assert [w.title for w in steps["processing_papers"].warnings] == [
            "14 findings did not clear the validation floor",
            "1 finding was dropped because the quoted sentence was not "
            "found in the paper",
        ]
        assert steps["batch_validation"].actions == [
            "Cross-checked 19 findings against the rest of the batch"
        ]

    def test_the_sentences_that_count_genes_keep_the_word(self) -> None:
        # The merge writes rows and holds genes: those are genes.
        merge = next(
            step
            for step in reword_findings(self._stored()).steps
            if step.key == "merging_database"
        )
        assert merge.actions == ["Inserted 1 gene and updated 4"]
        assert [w.title for w in merge.warnings] == [
            "8 new genes were held below the insert floor"
        ]

    def test_a_single_finding_is_singular(self) -> None:
        recorder = StepRecorder()
        recorder.enter(2)
        recorder.action("Extracted 1 genes, of which 1 passed validation")
        recorder.warn(
            RunWarning(
                kind="genes_rejected",
                title="1 gene did not clear the validation floor",
                count=1,
            )
        )
        recorder.enter(3)
        recorder.action("Cross-checked 1 genes against the rest of the batch")
        stored = build_run_report(
            _run_data(), steps=recorder.records(), apis=[], run_mode="standard"
        )
        steps = {step.key: step for step in reword_findings(stored).steps}
        assert steps["processing_papers"].actions == [
            "Extracted 1 finding, of which 1 passed validation"
        ]
        assert steps["processing_papers"].warnings[0].title == (
            "1 finding did not clear the validation floor"
        )
        assert steps["batch_validation"].actions == [
            "Cross-checked 1 finding against the rest of the batch"
        ]

    def test_a_report_already_in_these_words_is_left_alone(self) -> None:
        once = reword_findings(self._stored())
        assert reword_findings(once) is once
