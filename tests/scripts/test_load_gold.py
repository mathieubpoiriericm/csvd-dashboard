"""Unit tests for scripts/load_gold.py, on synthetic rows.

`testpaths` is `["tests/pipeline"]`, so nothing collects this file unless it
is named: `uv run pytest tests/scripts`. These hold for any disease: the one
trait they need is read from disease/vocabulary.json, and the population map
is replaced by a synthetic one. The committed gold tables are pinned in
tests/scripts/csvd/test_load_gold_csvd.py, and the write against a real
database in tests/pipeline/test_load_gold_integration.py.
"""

import csv
import json
from pathlib import Path
from typing import Any

import pytest
from scripts import load_gold
from scripts.load_gold import (
    GoldRefused,
    build_gold_plan,
    gene_from_gold,
    trial_from_gold,
)
from scripts.restore_from_json import export_gene

from pipeline.disease import VOCABULARY_PATH
from pipeline.export.main import _is_curated_trial, _is_running_trial
from pipeline.export.tables import clean_trial_row

_TRAIT_KEYS = [
    trait["key"]
    for trait in json.loads(VOCABULARY_PATH.read_text(encoding="utf-8"))["traits"]
]

_ST1_COLUMNS = (
    "source_row",
    "row_fingerprint",
    "tier",
    "protein",
    "gene",
    "chr_location",
    "gwas_trait",
    "proteomic_trait",
    "ngs_rare_deleterious_or_protective_variant",
    "proteogenomics_mr",
    "other_omics",
    "other_incl_experimental",
    "monogenic",
    "brain_cell_types_mice",
    "brain_cell_types_human",
    "pathway_goa_function",
    "gps_druggability_score_drug_ses",
    "drug_repositioning_candidate",
    "references",
)

_ST3_COLUMNS = (
    "source_row",
    "row_fingerprint",
    "agent",
    "mechanism_of_action",
    "genetic_evidence",
    "genetic_target",
    "trial_name",
    "registry_id",
    "trial_phase",
    "population",
    "target_n",
    "estimated_completion",
    "completion_note",
    "trial_primary_outcome",
    "trial_sponsor_type",
)

_POPULATIONS = {"REG-0001": "Population A", "REG-0002": "Population B"}


@pytest.fixture(autouse=True)
def _synthetic_populations(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(load_gold, "POPULATION_GROUP", _POPULATIONS)


def _gene_row(**cells: str) -> dict[str, str]:
    return {column: "" for column in _ST1_COLUMNS} | {
        "source_row": "2",
        "protein": "ABC protein one",
        "gene": "ABC1",
        "chr_location": "1p36.3",
    } | cells


def _trial_row(**cells: str) -> dict[str, str]:
    return {column: "" for column in _ST3_COLUMNS} | {
        "source_row": "3",
        "agent": "Drug A",
        "mechanism_of_action": "Inhibitor",
        "genetic_evidence": "No",
        "trial_name": "TRIAL-A",
        "registry_id": "REG-0001",
        "trial_phase": "II",
        "population": "Adults with condition A",
        "target_n": "120",
        "estimated_completion": "2028-07",
        "trial_primary_outcome": "Outcome A at 6 months",
        "trial_sponsor_type": "Academic",
    } | cells


# ------------------------------------------------------------------ genes


def test_gene_from_gold_folds_columns() -> None:
    gene = gene_from_gold(
        _gene_row(
            other_omics="TWAS TRAIT-A: tissue one*, tissue two",
            proteomic_trait="TRAIT-B",
            ngs_rare_deleterious_or_protective_variant="rare variant burden",
            proteogenomics_mr="TRAIT-C",
            other_incl_experimental="CRISPR, experimental",
            monogenic="Syndrome A, 123456, AD; Syndrome B, 654321, AR; 123456 again",
            brain_cell_types_mice="EC>PC",
            brain_cell_types_human="Arterial, EC > Venous, EC",
            pathway_goa_function="angiogenesis",
        ),
        ["11111111", "10.1000/xyz.1"],
    )

    assert gene.columns["protein"] == "ABC protein one"
    assert gene.columns["chromosomal_location"] == "1p36.3"
    assert gene.columns["affected_pathway"] == "angiogenesis"
    assert gene.columns["brain_cell_types"] == (
        "Mouse: EC>PC; Human: Arterial, EC > Venous, EC"
    )
    assert gene.columns["mendelian_randomization"] is True
    assert gene.columns["source_quote"] is None
    assert gene.columns["confidence"] is None
    assert gene.links == ["123456", "654321"]
    assert gene.references == ["11111111", "10.1000/xyz.1"]
    assert export_gene(gene)["evidenceFromOtherOmicsStudies"] == [
        "TWAS;TRAIT-A: tissue one*, tissue two",
        "Proteomics;TRAIT-B",
        "WES/WGS;rare variant burden",
        "Proteogenomic MR;TRAIT-C",
        "Experimental;CRISPR, experimental",
    ]


def test_blank_cells_become_null_and_no_mr() -> None:
    gene = gene_from_gold(_gene_row(protein="", chr_location=""), [])
    assert gene.columns["protein"] is None
    assert gene.columns["chromosomal_location"] is None
    assert gene.columns["brain_cell_types"] is None
    assert gene.columns["affected_pathway"] is None
    assert gene.columns["mendelian_randomization"] is False
    assert gene.columns["evidence_from_other_omics_studies"] is None
    assert gene.traits == gene.links == gene.references == []


def test_one_sided_cell_types_omit_the_empty_side() -> None:
    mouse = gene_from_gold(_gene_row(brain_cell_types_mice="FB"), [])
    human = gene_from_gold(_gene_row(brain_cell_types_human="PC > EC"), [])
    assert mouse.columns["brain_cell_types"] == "Mouse: FB"
    assert human.columns["brain_cell_types"] == "Human: PC > EC"


def test_multiline_omics_split() -> None:
    """Newlines and ";" both separate studies; a trailing separator is debris,
    "proteomics" takes the filter's spelling, a parenthesised detail becomes
    the wire form, "sequencing" names WES/WGS and "multiancestry
    fine-mapping" names Fine-mapping."""
    gene = gene_from_gold(
        _gene_row(
            other_omics=(
                "proteomics;\n"
                "TWAS TRAIT-A: tissue one*, (age>65): tissue two*;\n"
                "PWAS:tissue three*\n"
                "TWAS TRAIT-B: tissue four; proteomics (plasma)\n"
                "sequencing and a follow-up analysis\n"
                "multiancestry fine-mapping"
            )
        ),
        [],
    )
    assert export_gene(gene)["evidenceFromOtherOmicsStudies"] == [
        "Proteomics",
        "TWAS;TRAIT-A: tissue one*, (age>65): tissue two*",
        "PWAS;tissue three*",
        "TWAS;TRAIT-B: tissue four",
        "Proteomics;plasma",
        "WES/WGS;sequencing and a follow-up analysis",
        "Fine-mapping;multiancestry fine-mapping",
    ]


def test_a_study_may_lead_with_any_published_type() -> None:
    """A study written with its type first takes that type, in the filter's
    spelling, whatever the type -- so a curated entry can be written in the
    wire form's own order, and a `[?]` clarification mark rides through."""
    gene = gene_from_gold(
        _gene_row(
            other_omics=(
                "WES/WGS TRAIT-A: a locus, a follow-up (a gene)\n"
                "fine-mapping: multi-ancestry\n"
                "TWAS [?]: tissue one*, tissue two[?]"
            )
        ),
        [],
    )
    assert export_gene(gene)["evidenceFromOtherOmicsStudies"] == [
        "WES/WGS;TRAIT-A: a locus, a follow-up (a gene)",
        "Fine-mapping;multi-ancestry",
        "TWAS;[?]: tissue one*, tissue two[?]",
    ]


def test_traits_split_on_commas_and_semicolons_outside_parentheses() -> None:
    if len(_TRAIT_KEYS) < 2:
        pytest.skip("disease/vocabulary.json carries fewer than two traits")
    first, second = _TRAIT_KEYS[:2]
    gene = gene_from_gold(_gene_row(gwas_trait=f" {first}; {second}, {first}"), [])
    assert gene.traits == [first, second]


# ----------------------------------------------------------------- trials


def test_trial_from_gold_maps_the_columns() -> None:
    trial = trial_from_gold(_trial_row(genetic_target=""))
    assert trial == {
        "drug": "Drug A",
        "mechanism_of_action": "Inhibitor",
        "genetic_target": None,
        "genetic_evidence": "No",
        "trial_name": "TRIAL-A",
        "registry_id": "REG-0001",
        "clinical_trial_phase": "II",
        "target_population": "Population A",
        "target_population_details": "Adults with condition A",
        "target_sample_size": 120,
        "estimated_completion_date": "7/2028",
        "primary_outcome": "Outcome A at 6 months",
        "sponsor_type": "Academic",
        "overall_status": None,
    }


def test_trial_completion_note_used_when_date_blank() -> None:
    trial = trial_from_gold(
        _trial_row(estimated_completion="", completion_note="Completed")
    )
    assert trial["estimated_completion_date"] == "Completed"


def test_trial_completion_note_appended_to_a_date() -> None:
    """The spec: completion_note is appended to the completion date."""
    trial = trial_from_gold(
        _trial_row(
            estimated_completion="2028-07", completion_note="primary completion"
        )
    )
    assert trial["estimated_completion_date"] == "7/2028 (primary completion)"
    assert clean_trial_row(dict(trial))["Estimated Completion Date"] == (
        "7/2028 (primary completion)"
    )


def test_unknown_registry_refused() -> None:
    with pytest.raises(GoldRefused, match="REG-9999"):
        trial_from_gold(_trial_row(registry_id="REG-9999"))


def test_every_gold_trial_publishes() -> None:
    trials = [
        trial_from_gold(_trial_row()),
        trial_from_gold(
            _trial_row(
                agent="Drug B",
                registry_id="REG-0002",
                genetic_target="TARGET1",
                genetic_evidence="Yes",
                estimated_completion="",
                completion_note="Completed",
            )
        ),
    ]
    published = [
        clean_trial_row(dict(trial))
        for trial in trials
        if _is_curated_trial(trial) and _is_running_trial(trial)
    ]
    assert len(published) == len(trials)
    assert [row["Target Population"] for row in published] == [
        "Population A",
        "Population B",
    ]


# ------------------------------------------------------------------- plan


def _write_csv(
    path: Path, columns: tuple[str, ...], rows: list[dict[str, Any]]
) -> None:
    # utf-8-sig: the gold export writes a byte-order mark.
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)


def _gold_dir(
    directory: Path,
    *,
    genes: list[dict[str, str]] | None = None,
    trials: list[dict[str, str]] | None = None,
    references: list[dict[str, Any]] | None = None,
    suspects: list[dict[str, str]] | None = None,
) -> Path:
    _write_csv(
        directory / "st1_genes.csv",
        _ST1_COLUMNS,
        [_gene_row()] if genes is None else genes,
    )
    _write_csv(
        directory / "st3_trials.csv",
        _ST3_COLUMNS,
        [_trial_row()] if trials is None else trials,
    )
    _write_csv(
        directory / "references.csv",
        ("sheet", "source_row", "position", "kind", "id"),
        references
        if references is not None
        else [
            # Out of order on disk, and another sheet's row under the same
            # source_row, which must not attach to the gene.
            {"sheet": "ST1", "source_row": 2, "position": 2, "kind": "doi",
             "id": "10.1000/xyz.1"},
            {"sheet": "ST1", "source_row": 2, "position": 1, "kind": "pmid",
             "id": "11111111"},
            {"sheet": "ST6", "source_row": 2, "position": 1, "kind": "pmid",
             "id": "99999999"},
        ],
    )
    _write_csv(
        directory / "suspects.csv",
        ("sheet", "source_row", "row_fingerprint", "column", "value", "rule",
         "detail"),
        suspects or [],
    )
    return directory


def test_the_plan_attaches_st1_references_in_position_order(tmp_path: Path) -> None:
    plan = build_gold_plan(_gold_dir(tmp_path))
    assert [gene.references for gene in plan.genes] == [
        ["11111111", "10.1000/xyz.1"]
    ]
    assert len(plan.trials) == 1


@pytest.mark.parametrize(
    ("files", "reason"),
    [
        ({"suspects": [{"sheet": "ST1", "source_row": "2", "row_fingerprint": "x",
                        "column": "gene", "value": "?", "rule": "r",
                        "detail": "d"}]}, "suspects.csv"),
        ({"trials": [_trial_row(), _trial_row()]}, "duplicate"),
        ({"trials": [_trial_row(registry_id="REG-9999")]}, "REG-9999"),
        ({"genes": [_gene_row(gwas_trait="NOT-A-TRAIT-ANYWHERE")]},
         "NOT-A-TRAIT-ANYWHERE"),
        ({"genes": [_gene_row(other_omics="colocalization: tissue")]},
         "colocalization"),
        ({"genes": [_gene_row(chr_location="x" * 51)]}, "chromosomal_location"),
        ({"trials": [_trial_row(trial_phase="x" * 21)]}, "clinical_trial_phase"),
        ({"genes": [_gene_row(), _gene_row(source_row="3")]}, "duplicate"),
        ({"trials": [_trial_row(estimated_completion="July 2028")]}, "YYYY-MM"),
        ({"trials": [_trial_row(estimated_completion="2028-13")]}, "YYYY-MM"),
        ({"trials": [_trial_row(target_n="about 100")]}, "target_n"),
    ],
)
def test_the_plan_refuses(
    tmp_path: Path, files: dict[str, Any], reason: str
) -> None:
    with pytest.raises(GoldRefused, match=reason):
        build_gold_plan(_gold_dir(tmp_path, **files))


def test_a_scalar_the_export_would_rewrite_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = load_gold.export_gene

    def rewriting(gene: Any) -> dict[str, Any]:
        return real(gene) | {"protein": "(unknown)"}

    monkeypatch.setattr(load_gold, "export_gene", rewriting)
    with pytest.raises(GoldRefused, match="protein"):
        build_gold_plan(_gold_dir(tmp_path))


def test_case_is_the_only_tolerated_rewrite(tmp_path: Path) -> None:
    """The export lowercases "ALL" in the cell types; gold spelt with capitals
    loads, and publishes lowercased. The pathway publishes as gold writes it."""
    plan = build_gold_plan(
        _gold_dir(
            tmp_path,
            genes=[
                _gene_row(
                    brain_cell_types_mice="ALL < 40",
                    pathway_goa_function="Wnt/Notch signaling pathway",
                )
            ],
        )
    )
    published = export_gene(plan.genes[0])
    assert published["brainCellTypes"] == "Mouse: all < 40"
    assert published["affectedPathway"] == "Wnt/Notch signaling pathway"


def test_a_pathway_whose_case_the_export_would_change_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Case is tolerated in the cell types alone: an export that lowercased the
    pathway again would rewrite gold's proper nouns, so the plan refuses it."""
    real = load_gold.export_gene

    def lowercasing(gene: Any) -> dict[str, Any]:
        published = real(gene)
        return published | {"affectedPathway": published["affectedPathway"].lower()}

    monkeypatch.setattr(load_gold, "export_gene", lowercasing)
    with pytest.raises(GoldRefused, match="affectedPathway"):
        build_gold_plan(
            _gold_dir(
                tmp_path,
                genes=[_gene_row(pathway_goa_function="Wnt signaling pathway")],
            )
        )


def test_a_trial_the_export_cannot_read_is_refused_not_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unreadable(row: dict[str, Any]) -> dict[str, Any]:
        raise KeyError("Genetic Target")

    monkeypatch.setattr(load_gold, "clean_trial_row", unreadable)
    with pytest.raises(GoldRefused, match="cannot read"):
        build_gold_plan(_gold_dir(tmp_path))
