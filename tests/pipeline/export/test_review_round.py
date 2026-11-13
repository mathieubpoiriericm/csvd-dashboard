"""Tests for build_review_round -- the diff of gold rows against a preview run."""

import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

from pipeline.export.review_round import (
    ROUND_FILE,
    ReviewRoundError,
    build_review_round,
    read_review_round,
    stale_genes,
    warn_if_round_stale,
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
        "proteinName": None,
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


def test_a_removed_list_value_is_refused_as_gold_drift():
    """A run never removes a list value, so a removal means gold moved.

    The one drift the other refusals cannot see: gold was curated after the
    preview was copied from it, on a row the run also touched.
    """
    gold = [_row("GENE1", gwasTrait=["TRAIT-A"])]
    preview = [_row("GENE1", gwasTrait=["(unknown)"])]
    with pytest.raises(ReviewRoundError, match=r"GENE1.*gwasTrait"):
        build(preview, findings=[_finding("GENE1", "7")], gold=gold)


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


def test_a_protein_changed_beside_a_citation_is_its_own_kind():
    """A run that rewrote a stored protein is told apart from a citation.

    The merge once read a protein equal to the symbol as a placeholder, and
    the rows it rewrote that way otherwise look like a citation only.
    """
    gold = [_row("GENE1", protein="GENE1", references=["1"])]
    preview = [_row("GENE1", protein="Protein one", references=["1", "7"])]
    (change,) = build(preview, findings=[_finding("GENE1", "7")], gold=gold)["changes"]
    assert change["kind"] == "citation_protein"
    assert [f["field"] for f in change["fields"]] == ["protein", "references"]


def test_a_protein_alone_is_a_citation_and_protein_change():
    gold = [_row("GENE1", protein="GENE1")]
    preview = [_row("GENE1", protein="Protein one")]
    (change,) = build(preview, findings=[_finding("GENE1", "7")], gold=gold)["changes"]
    assert change["kind"] == "citation_protein"


def test_a_changed_claim_outranks_a_changed_protein():
    gold = [_row("GENE1", protein="GENE1")]
    preview = [_row("GENE1", protein="Protein one", gwasTrait=["TRAIT-A"])]
    (change,) = build(preview, findings=[_finding("GENE1", "7")], gold=gold)["changes"]
    assert change["kind"] == "claims"


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

    # Another gold that a run could have started from: a scalar differs, so
    # no list value is removed (which would be refused as drift).
    other_gold = [GOLD[0], _row("GENE2", protein="P2")]
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
        _finding(
            "GENE2",
            "7",
            gwasTraits=["TRAIT-A"],
            proteinName="Protein two",
            omicsEvidence=["x"],
        ),
        _finding("GENE2", "9"),
    ]
    papers = {"7": {"fulltext": True, "extractionModel": "model-x"}}
    (change,) = build(preview, findings=findings, papers=papers)["changes"]
    first, second = change["findings"]
    assert first == {
        "pmid": "7",
        "confidence": 0.9,
        "gwasTraits": ["TRAIT-A"],
        "proteinName": "Protein two",
        "mendelianRandomization": False,
        "omicsEvidence": ["x"],
        "causalEvidenceSummary": "summary",
        "sourceQuote": "q",
        "citationOnly": False,
        "fulltext": True,
        "extractionModel": "model-x",
    }
    assert (second["fulltext"], second["extractionModel"]) == (None, None)
    assert second["proteinName"] is None
    # The report's own key order, then the ledger's two.
    assert list(first) == [
        "pmid",
        "confidence",
        "gwasTraits",
        "proteinName",
        "mendelianRandomization",
        "omicsEvidence",
        "causalEvidenceSummary",
        "sourceQuote",
        "citationOnly",
        "fulltext",
        "extractionModel",
    ]


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


# ---------------------------------------------------------------------------
# stale_genes and warn_if_round_stale -- a round against a curated gold
# ---------------------------------------------------------------------------


def _measured_round() -> dict[str, Any]:
    """GENE2 gains a trait, GENE3 is new: measured against GOLD."""
    preview = [GOLD[0], _row("GENE2", gwasTrait=["TRAIT-A"]), _row("GENE3")]
    return build(
        preview, findings=[_finding("GENE2", "7"), _finding("GENE3", "8")]
    )


def test_a_round_against_the_gold_it_was_measured_on_is_current():
    assert stale_genes(_measured_round(), GOLD) == []


def test_a_curated_gold_row_makes_its_change_stale():
    curated = [GOLD[0], _row("GENE2", affectedPathway="Pathway A")]
    assert stale_genes(_measured_round(), curated) == ["GENE2"]


def test_a_gold_row_gone_makes_its_change_stale():
    assert stale_genes(_measured_round(), [GOLD[0]]) == ["GENE2"]


def test_a_new_gene_now_in_gold_makes_its_change_stale():
    assert stale_genes(_measured_round(), [*GOLD, _row("GENE3")]) == ["GENE3"]


def test_a_round_with_no_changes_list_is_current():
    assert stale_genes({"id": "round"}, GOLD) == []


def _write_round(target: Path, value: Any) -> bytes:
    target.mkdir(parents=True, exist_ok=True)
    raw = (json.dumps(value) + "\n").encode()
    (target / ROUND_FILE).write_bytes(raw)
    return raw


def test_a_stale_committed_round_is_warned_of_and_left_alone(tmp_path, caplog):
    raw = _write_round(tmp_path, _measured_round())
    curated = [GOLD[0], _row("GENE2", affectedPathway="Pathway A"), _row("GENE3")]
    with caplog.at_level(logging.WARNING):
        warn_if_round_stale(tmp_path, curated)
    (record,) = [r for r in caplog.records if r.levelno == logging.WARNING]
    message = record.getMessage()
    assert "no longer matches gold for 2 genes (GENE2, GENE3)" in message
    assert "hides the review area" in message
    assert "deno task data:preview" in message
    assert (tmp_path / ROUND_FILE).read_bytes() == raw


def test_only_the_first_five_stale_genes_are_named(tmp_path, caplog):
    genes = [f"GENE{i}" for i in range(1, 8)]
    round_ = {
        "changes": [{"gene": g, "kind": "new", "before": None} for g in genes]
    }
    _write_round(tmp_path, round_)
    with caplog.at_level(logging.WARNING):
        warn_if_round_stale(tmp_path, [_row(g) for g in genes])
    assert "for 7 genes (GENE1, GENE2, GENE3, GENE4, GENE5, ...)" in caplog.text


def test_a_current_round_is_not_warned_of(tmp_path, caplog):
    raw = _write_round(tmp_path, _measured_round())
    with caplog.at_level(logging.DEBUG):
        warn_if_round_stale(tmp_path, GOLD)
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert (tmp_path / ROUND_FILE).read_bytes() == raw


@pytest.mark.parametrize("content", [None, b"null\n", b"{not json", b"[1]\n"])
def test_no_round_to_compare_is_not_an_error(tmp_path, caplog, content):
    if content is not None:
        (tmp_path / ROUND_FILE).write_bytes(content)
    with caplog.at_level(logging.DEBUG):
        warn_if_round_stale(tmp_path, GOLD)
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


# ---------------------------------------------------------------------------
# read_review_round -- both connections mocked
# ---------------------------------------------------------------------------


def _report(findings: list[dict[str, Any]], *, shown=None, total=None):
    """The slice of a published preview report read_review_round reads."""
    return {
        "runTimestamp": STAMP,
        "runMode": "preview",
        "acceptedGenes": {
            "shown": len(findings) if shown is None else shown,
            "total": len(findings) if total is None else total,
            "items": findings,
        },
    }


class _Databases:
    """The preview pool, the gold connection and the gene reader, mocked."""

    def __init__(self, mocker, *, runs: int, gold, preview, papers=()):
        self.preview_conn = AsyncMock()
        self.preview_conn.fetchval = AsyncMock(return_value=runs)
        self.preview_conn.fetch = AsyncMock(return_value=list(papers))
        mocker.patch(
            "pipeline.export.review_round.Database.connection",
            return_value=AsyncMock(
                __aenter__=AsyncMock(return_value=self.preview_conn),
                __aexit__=AsyncMock(return_value=False),
            ),
        )
        self.gold_conn = object()
        self.gold_opened = 0

        @asynccontextmanager
        async def gold_connection():
            self.gold_opened += 1
            yield self.gold_conn

        mocker.patch(
            "pipeline.export.review_round.gold_connection", new=gold_connection
        )

        async def read_published_genes(conn=None):
            return gold if conn is self.gold_conn else preview

        self.genes = mocker.patch(
            "pipeline.export.main.read_published_genes",
            new=AsyncMock(side_effect=read_published_genes),
        )


@pytest.mark.parametrize("runs", [0, 2])
async def test_two_preview_runs_are_refused_before_gold_is_read(mocker, runs):
    dbs = _Databases(mocker, runs=runs, gold=GOLD, preview=GOLD)
    with pytest.raises(ReviewRoundError, match=f"{runs} preview runs"):
        await read_review_round(_report([]))
    sql, mode = dbs.preview_conn.fetchval.await_args.args
    assert "FROM pipeline_runs WHERE run_mode = $1" in sql
    assert mode == "preview"
    assert dbs.gold_opened == 0
    dbs.genes.assert_not_awaited()


async def test_capped_findings_are_refused(mocker):
    dbs = _Databases(mocker, runs=1, gold=GOLD, preview=GOLD)
    findings = [_finding("GENE1", "7")] * 200
    with pytest.raises(ReviewRoundError, match="200 of 201"):
        await read_review_round(_report(findings, shown=200, total=201))
    assert dbs.gold_opened == 0
    dbs.genes.assert_not_awaited()


async def test_the_round_diffs_gold_against_the_preview_with_each_papers_ledger(
    mocker,
):
    preview = [_row("GENE1", references=["1", "7"]), GOLD[1], _row("GENE3")]
    dbs = _Databases(
        mocker,
        runs=1,
        gold=GOLD,
        preview=preview,
        papers=[
            {"pmid": "7", "fulltext_available": True, "extraction_model": "model-x"},
            {"pmid": "9", "fulltext_available": False, "extraction_model": None},
        ],
    )
    findings = [_finding("GENE3", "9"), _finding("GENE1", "7"), _finding("GENE3", "7")]

    round_ = await read_review_round(_report(findings))

    assert round_ == build_review_round(
        gold_rows=GOLD,
        preview_rows=preview,
        findings=findings,
        papers={
            "7": {"fulltext": True, "extractionModel": "model-x"},
            "9": {"fulltext": False, "extractionModel": None},
        },
        run_timestamp=STAMP,
    )
    assert [(c["gene"], c["kind"]) for c in round_["changes"]] == [
        ("GENE1", "citation"),
        ("GENE3", "new"),
    ]
    assert dbs.gold_opened == 1
    sql, pmids = dbs.preview_conn.fetch.await_args.args
    assert sql == (
        "SELECT pmid, fulltext_available, extraction_model FROM pubmed_refs"
        " WHERE pmid = ANY($1) ORDER BY pmid"
    )
    assert pmids == ["7", "9"]
