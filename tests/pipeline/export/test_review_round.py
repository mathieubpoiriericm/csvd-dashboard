"""Tests for build_review_round -- the diff of gold rows against a preview run."""

import logging
from typing import Any

import pytest

from pipeline.export.review_round import (
    ROUND_FILE,
    ReviewRoundError,
    build_review_round,
)

STAMP = "2026-01-01T00:00:00+00:00"

_DEFAULTS: dict[str, Any] = {
    "gene": "GENE",
    "protein": "(unknown)",
    "chromosomalLocation": "(unknown)",
    "gwasTrait": ["(none found)"],
    "mendelianRandomization": "(none)",
    "evidenceFromOtherOmicsStudies": ["(none found)"],
    "linkToMonogenicDisease": ["(none found)"],
    "brainCellTypes": "(unknown)",
    "affectedPathway": "(unknown)",
    "references": ["(reference needed)"],
    "sourceQuote": "(not yet extracted)",
    "confidence": None,
}


def _row(gene: str, **overrides: Any) -> dict[str, Any]:
    return {**_DEFAULTS, "gene": gene, **overrides}


def _finding(symbol: str, pmid: str, **overrides: Any) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "pmid": pmid,
        "confidence": 0.9,
        "gwasTraits": [],
        "mendelianRandomization": False,
        "omicsEvidence": [],
        "causalEvidenceSummary": "summary",
        "sourceQuote": "q",
        "citationOnly": False,
        **overrides,
    }


GOLD = [_row("GENE1", references=["1"]), _row("GENE2", gwasTrait=["(none found)"])]


def build(preview, *, findings, papers=None, gold=None):
    return build_review_round(
        gold_rows=GOLD if gold is None else gold,
        preview_rows=preview,
        findings=findings,
        papers=papers or {},
        run_timestamp=STAMP,
    )


def test_the_round_file_is_named():
    assert ROUND_FILE == "review_round.json"


def test_a_row_only_the_preview_holds_is_a_new_gene():
    preview = [*GOLD, _row("GENE3")]
    round_ = build(preview, findings=[_finding("GENE3", "7")])
    (change,) = round_["changes"]
    assert (change["gene"], change["kind"], change["before"], change["fields"]) == (
        "GENE3",
        "new",
        None,
        [],
    )
    assert change["after"] == preview[2]


def test_a_changed_claim_field_makes_the_change_claims():
    preview = [GOLD[0], _row("GENE2", gwasTrait=["TRAIT-A"], references=["1", "7"])]
    (change,) = build(preview, findings=[_finding("GENE2", "7")])["changes"]
    assert change["kind"] == "claims"
    assert change["fields"][0] == {
        "field": "gwasTrait",
        "before": ["(none found)"],
        "after": ["TRAIT-A"],
        "added": ["TRAIT-A"],
        "removed": [],
    }
    assert [f["field"] for f in change["fields"]] == ["gwasTrait", "references"]
    assert change["fields"][1]["added"] == ["1", "7"]
    assert change["fields"][1]["removed"] == []


def test_sentinels_are_left_out_of_added_and_removed():
    preview = [GOLD[0], _row("GENE2", gwasTrait=["TRAIT-A"])]
    (change,) = build(preview, findings=[_finding("GENE2", "7")])["changes"]
    assert change["fields"][0]["removed"] == []
    gold = [_row("GENE1", gwasTrait=["TRAIT-A"])]
    preview = [_row("GENE1", gwasTrait=["(unknown)"])]
    (change,) = build(preview, findings=[_finding("GENE1", "7")], gold=gold)["changes"]
    assert change["fields"][0]["removed"] == ["TRAIT-A"]
    assert change["fields"][0]["added"] == []


def test_a_scalar_field_has_no_added_or_removed():
    gold = [_row("GENE1", mendelianRandomization="no")]
    preview = [_row("GENE1", mendelianRandomization="yes")]
    (change,) = build(preview, findings=[_finding("GENE1", "7")], gold=gold)["changes"]
    assert change["kind"] == "claims"
    assert change["fields"] == [
        {
            "field": "mendelianRandomization",
            "before": "no",
            "after": "yes",
            "added": [],
            "removed": [],
        }
    ]


def test_a_quote_alone_is_a_citation_change():
    changed = _row("GENE1", references=["1"], sourceQuote="q", confidence=0.5)
    preview = [changed, GOLD[1]]
    (change,) = build(preview, findings=[_finding("GENE1", "1", citationOnly=True)])[
        "changes"
    ]
    assert change["kind"] == "citation"
    assert [f["field"] for f in change["fields"]] == ["sourceQuote", "confidence"]


def test_changes_keep_the_preview_order_and_unchanged_rows_are_skipped():
    preview = [
        _row("GENE2", gwasTrait=["TRAIT-A"]),
        GOLD[0],
        _row("GENE0"),
    ]
    round_ = build(
        preview, findings=[_finding("GENE0", "8"), _finding("GENE2", "7")]
    )
    assert [c["gene"] for c in round_["changes"]] == ["GENE2", "GENE0"]


def test_rows_match_on_the_upper_cased_stripped_gene():
    gold = [_row("gene1 ", references=["1"])]
    preview = [_row("GENE1", references=["1", "7"])]
    (change,) = build(preview, findings=[_finding("GENE1", "7")], gold=gold)["changes"]
    assert change["kind"] == "citation"
    assert change["before"] == gold[0]


def test_the_version_names_the_proposal_and_the_base_names_gold():
    preview = [GOLD[0], _row("GENE2", gwasTrait=["TRAIT-A"])]
    findings = [_finding("GENE2", "7")]
    first = build(preview, findings=findings)
    again = build(preview, findings=findings)
    assert first["changes"][0]["version"] == again["changes"][0]["version"]
    assert first["base"] == again["base"]
    assert len(first["base"]) == 16 and len(first["changes"][0]["version"]) == 16

    other = build(
        [GOLD[0], _row("GENE2", gwasTrait=["TRAIT-B"])], findings=findings
    )
    assert other["changes"][0]["version"] != first["changes"][0]["version"]
    assert other["base"] == first["base"]

    other_gold = [GOLD[0], _row("GENE2", gwasTrait=["TRAIT-C"])]
    moved = build(preview, findings=findings, gold=other_gold)
    assert moved["base"] != first["base"]


def test_a_finding_reaches_its_row_through_the_curated_alias(gene_aliases):
    gold = [_row("OLDSYM")]
    preview = [_row("OLDSYM", references=["7"])]
    (change,) = build(
        preview, findings=[_finding("NEWSYM", "7")], gold=gold
    )["changes"]
    assert change["gene"] == "OLDSYM"
    assert [f["pmid"] for f in change["findings"]] == ["7"]


def test_a_finding_carries_its_papers_full_text_and_model():
    preview = [GOLD[0], _row("GENE2", references=["7", "9"])]
    findings = [
        _finding("GENE2", "7", gwasTraits=["TRAIT-A"], omicsEvidence=["x"]),
        _finding("GENE2", "9"),
    ]
    papers = {"7": {"fulltext": True, "extractionModel": "model-x"}}
    (change,) = build(preview, findings=findings, papers=papers)["changes"]
    first, second = change["findings"]
    assert first == {
        "pmid": "7",
        "confidence": 0.9,
        "gwasTraits": ["TRAIT-A"],
        "mendelianRandomization": False,
        "omicsEvidence": ["x"],
        "causalEvidenceSummary": "summary",
        "sourceQuote": "q",
        "citationOnly": False,
        "fulltext": True,
        "extractionModel": "model-x",
    }
    assert (second["fulltext"], second["extractionModel"]) == (None, None)


def test_a_finding_for_an_unchanged_row_is_dropped_and_counted(caplog):
    preview = [GOLD[0], _row("GENE2", gwasTrait=["TRAIT-A"])]
    findings = [_finding("GENE1", "1"), _finding("GENE2", "7")]
    with caplog.at_level(logging.INFO):
        (change,) = build(preview, findings=findings)["changes"]
    assert [f["pmid"] for f in change["findings"]] == ["7"]
    assert len([r for r in caplog.records if "unchanged" in r.getMessage()]) == 1


def test_a_gold_gene_the_preview_lacks_is_refused():
    with pytest.raises(ReviewRoundError, match="GENE2"):
        build([GOLD[0]], findings=[])


def test_a_change_no_finding_explains_is_refused():
    with pytest.raises(ReviewRoundError, match="GENE3"):
        build([*GOLD, _row("GENE3")], findings=[])


def test_the_round_is_open_and_names_its_run():
    round_ = build(GOLD, findings=[])
    assert (
        round_["id"],
        round_["state"],
        round_["runTimestamp"],
        round_["changes"],
    ) == (
        "round-2026-01-01T00:00:00+00:00",
        "open",
        "2026-01-01T00:00:00+00:00",
        [],
    )
