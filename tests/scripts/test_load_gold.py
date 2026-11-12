"""Unit tests for scripts/load_gold.py, on synthetic rows.

`testpaths` is `["tests/pipeline"]`, so nothing collects this file unless it
is named: `uv run pytest tests/scripts`. These hold for any disease: the one
trait they need is read from disease/vocabulary.json, and the populations
their trials are filed under are the manifest's own. The committed gold
tables are pinned in tests/scripts/csvd/test_load_gold_csvd.py, and the write
against a real database in tests/pipeline/test_load_gold_integration.py.
"""

import csv
import json
from pathlib import Path
from typing import Any

import pytest
from scripts import load_gold
from scripts.load_gold import (
    GoldPlan,
    GoldRefused,
    build_gold_plan,
    gene_from_gold,
    read_population_groups,
    trial_from_gold,
)
from scripts.restore_from_json import export_gene

from pipeline.disease import VOCABULARY_PATH, load_disease
from pipeline.export.main import _is_curated_trial, _is_running_trial
from pipeline.export.tables import clean_trial_row
from pipeline.omics import OMICS_STUDY_TYPES

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

# A group is one of the manifest's populations, so the two trials take its
# first and its last: one and the same where a fork has a single population.
_POPULATION_KEYS = load_disease().population_keys
_GROUPS = {"REG-0001": _POPULATION_KEYS[0], "REG-0002": _POPULATION_KEYS[-1]}
_POPULATIONS_FILE = "trial_populations.csv"
_NO_SUCH_POPULATION = "NOT-A-POPULATION-ANYWHERE"


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


@pytest.mark.parametrize("kind", OMICS_STUDY_TYPES)
def test_every_published_study_type_can_lead_a_study(kind: str) -> None:
    """The loader's list is the export's own vocabulary, not a copy of it."""
    gene = gene_from_gold(_gene_row(other_omics=f"{kind.lower()} TRAIT-A: x"), [])
    assert export_gene(gene)["evidenceFromOtherOmicsStudies"] == [f"{kind};TRAIT-A: x"]


def test_traits_split_on_commas_and_semicolons_outside_parentheses() -> None:
    if len(_TRAIT_KEYS) < 2:
        pytest.skip("disease/vocabulary.json carries fewer than two traits")
    first, second = _TRAIT_KEYS[:2]
    gene = gene_from_gold(_gene_row(gwas_trait=f" {first}; {second}, {first}"), [])
    assert gene.traits == [first, second]


# ----------------------------------------------------------------- trials


def test_trial_from_gold_maps_the_columns() -> None:
    trial = trial_from_gold(_trial_row(genetic_target=""), _GROUPS)
    assert trial == {
        "drug": "Drug A",
        "mechanism_of_action": "Inhibitor",
        "genetic_target": None,
        "genetic_evidence": "No",
        "trial_name": "TRIAL-A",
        "registry_id": "REG-0001",
        "clinical_trial_phase": "II",
        "target_population": _GROUPS["REG-0001"],
        "target_population_details": "Adults with condition A",
        "target_sample_size": 120,
        "estimated_completion_date": "7/2028",
        "primary_outcome": "Outcome A at 6 months",
        "sponsor_type": "Academic",
        "overall_status": None,
    }


def test_trial_completion_note_used_when_date_blank() -> None:
    trial = trial_from_gold(
        _trial_row(estimated_completion="", completion_note="Completed"), _GROUPS
    )
    assert trial["estimated_completion_date"] == "Completed"


def test_trial_completion_note_appended_to_a_date() -> None:
    """The spec: completion_note is appended to the completion date."""
    trial = trial_from_gold(
        _trial_row(
            estimated_completion="2028-07", completion_note="primary completion"
        ),
        _GROUPS,
    )
    assert trial["estimated_completion_date"] == "7/2028 (primary completion)"
    assert clean_trial_row(dict(trial))["Estimated Completion Date"] == (
        "7/2028 (primary completion)"
    )


def test_unknown_registry_refused() -> None:
    with pytest.raises(GoldRefused, match=f"REG-9999.*{_POPULATIONS_FILE}"):
        trial_from_gold(_trial_row(registry_id="REG-9999"), _GROUPS)


def test_every_gold_trial_publishes() -> None:
    trials = [
        trial_from_gold(_trial_row(), _GROUPS),
        trial_from_gold(
            _trial_row(
                agent="Drug B",
                registry_id="REG-0002",
                genetic_target="TARGET1",
                genetic_evidence="Yes",
                estimated_completion="",
                completion_note="Completed",
            ),
            _GROUPS,
        ),
    ]
    published = [
        clean_trial_row(dict(trial))
        for trial in trials
        if _is_curated_trial(trial) and _is_running_trial(trial)
    ]
    assert len(published) == len(trials)
    assert [row["Target Population"] for row in published] == [
        _GROUPS["REG-0001"],
        _GROUPS["REG-0002"],
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
    populations: list[dict[str, str]] | None = None,
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
    # A group for each registry the trials name, and for no other: a row no
    # trial has is refused.
    named = {
        row["registry_id"] for row in ([_trial_row()] if trials is None else trials)
    }
    _write_csv(
        directory / _POPULATIONS_FILE,
        ("registry_id", "population"),
        [
            {"registry_id": registry_id, "population": group}
            for registry_id, group in _GROUPS.items()
            if registry_id in named
        ]
        if populations is None
        else populations,
    )
    return directory


def _build(gold_dir: Path) -> GoldPlan:
    """The plan of a directory `_gold_dir` wrote, its populations file included."""
    return build_gold_plan(gold_dir, gold_dir / _POPULATIONS_FILE)


def test_the_plan_attaches_st1_references_in_position_order(tmp_path: Path) -> None:
    plan = _build(_gold_dir(tmp_path))
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
        ({"populations": [{"registry_id": "REG-0001", "population": ""}]},
         f"{_POPULATIONS_FILE} line 2: registry_id and population"),
        ({"populations": [{"registry_id": "", "population": _GROUPS["REG-0001"]}]},
         f"{_POPULATIONS_FILE} line 2: registry_id and population"),
        ({"populations": [
            {"registry_id": "REG-0001", "population": _GROUPS["REG-0001"]},
            {"registry_id": "REG-0001", "population": _GROUPS["REG-0002"]},
        ]}, f"{_POPULATIONS_FILE} line 3: REG-0001 is listed twice"),
        ({"populations": [
            {"registry_id": "REG-0001", "population": _NO_SUCH_POPULATION},
        ]}, f"{_POPULATIONS_FILE} line 2: REG-0001 has the group "
            f"'{_NO_SUCH_POPULATION}'"),
    ],
)
def test_the_plan_refuses(
    tmp_path: Path, files: dict[str, Any], reason: str
) -> None:
    with pytest.raises(GoldRefused, match=reason):
        _build(_gold_dir(tmp_path, **files))


def test_a_scalar_the_export_would_rewrite_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = load_gold.export_gene

    def rewriting(gene: Any) -> dict[str, Any]:
        return real(gene) | {"protein": "(unknown)"}

    monkeypatch.setattr(load_gold, "export_gene", rewriting)
    with pytest.raises(GoldRefused, match="protein"):
        _build(_gold_dir(tmp_path))


def test_case_is_the_only_tolerated_rewrite(tmp_path: Path) -> None:
    """The export lowercases "ALL" in the cell types; gold spelt with capitals
    loads, and publishes lowercased. The pathway publishes as gold writes it."""
    plan = _build(
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
        _build(
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
        _build(_gold_dir(tmp_path))


# ------------------------------------------------------------- populations


def test_the_population_groups_are_read_by_registry_id(tmp_path: Path) -> None:
    both = [_trial_row(), _trial_row(registry_id="REG-0002")]
    path = _gold_dir(tmp_path, trials=both) / _POPULATIONS_FILE
    assert read_population_groups(path) == (
        _GROUPS,
        {"REG-0001": 2, "REG-0002": 3},
        [],
    )


def test_a_trial_takes_the_group_its_registry_id_is_filed_under(
    tmp_path: Path,
) -> None:
    """Two rows of one registry share its group, and the file's row order
    decides nothing."""
    plan = _build(
        _gold_dir(
            tmp_path,
            trials=[
                _trial_row(registry_id="REG-0002"),
                _trial_row(agent="Drug B", registry_id="REG-0002"),
                _trial_row(),
            ],
        )
    )
    assert [trial["target_population"] for trial in plan.trials] == [
        _GROUPS["REG-0002"],
        _GROUPS["REG-0002"],
        _GROUPS["REG-0001"],
    ]


def test_a_group_for_a_trial_the_gold_table_does_not_have_is_refused(
    tmp_path: Path,
) -> None:
    """Named once, by its ID and its line in the file: the trials that have
    a group are not refused with it."""
    with pytest.raises(GoldRefused) as refused:
        _build(
            _gold_dir(
                tmp_path,
                populations=[
                    {"registry_id": registry_id, "population": group}
                    for registry_id, group in {
                        **_GROUPS,
                        "REG-9999": _GROUPS["REG-0001"],
                    }.items()
                ],
            )
        )
    assert str(refused.value).splitlines()[1:] == [
        f"  {_POPULATIONS_FILE} line 3: REG-0002 is not the registry ID of "
        "any gold trial",
        f"  {_POPULATIONS_FILE} line 4: REG-9999 is not the registry ID of "
        "any gold trial",
    ]


def test_a_group_is_used_by_a_trial_the_plan_refuses_for_another_reason(
    tmp_path: Path,
) -> None:
    """The trial's row is refused; its group is not reported as unused."""
    with pytest.raises(GoldRefused) as refused:
        _build(_gold_dir(tmp_path, trials=[_trial_row(target_n="about 100")]))
    assert "is not the registry ID" not in str(refused.value)


def test_a_missing_populations_file_is_refused_by_name(tmp_path: Path) -> None:
    gold_dir = _gold_dir(tmp_path)
    (gold_dir / _POPULATIONS_FILE).unlink()
    with pytest.raises(GoldRefused, match=f"{_POPULATIONS_FILE} is missing"):
        _build(gold_dir)


@pytest.mark.parametrize(
    ("text", "found"),
    [
        ("", "it is missing"),
        ("REG-0001,GROUP\n", "it is REG-0001,GROUP"),
        ("registry,group\nREG-0001,GROUP\n", "it is registry,group"),
        ("registry_id,population,note\n", "it is registry_id,population,note"),
    ],
)
def test_a_populations_file_without_its_header_is_refused(
    tmp_path: Path, text: str, found: str
) -> None:
    gold_dir = _gold_dir(tmp_path)
    (gold_dir / _POPULATIONS_FILE).write_text(text, encoding="utf-8")
    with pytest.raises(GoldRefused) as refused:
        _build(gold_dir)
    assert str(refused.value) == (
        f"{_POPULATIONS_FILE}: the first line must be the header "
        f"registry_id,population, and {found}"
    )


def test_a_populations_row_is_named_by_its_line_in_the_file(
    tmp_path: Path,
) -> None:
    """A blank line is skipped and still counted, and a byte-order mark
    before the header is read past."""
    path = tmp_path / _POPULATIONS_FILE
    path.write_text(
        "registry_id,population\n"
        f"REG-0001,{_GROUPS['REG-0001']}\n"
        "\n"
        f"REG-0001,{_GROUPS['REG-0001']}\n"
        f"REG-0002,{_GROUPS['REG-0002']},a third cell\n",
        encoding="utf-8-sig",
    )
    assert read_population_groups(path) == (
        {"REG-0001": _GROUPS["REG-0001"]},
        # The line a registry ID was filed on, not the one that repeats it.
        {"REG-0001": 2},
        [
            f"{_POPULATIONS_FILE} line 4: REG-0001 is listed twice",
            f"{_POPULATIONS_FILE} line 5: more than two cells",
        ],
    )


def test_a_group_the_manifest_does_not_list_is_reported_once(
    tmp_path: Path,
) -> None:
    """The refused row still files its trial, so the trial is not refused a
    second time for having no group."""
    with pytest.raises(GoldRefused) as refused:
        _build(
            _gold_dir(
                tmp_path,
                populations=[
                    {"registry_id": "REG-0001", "population": _NO_SUCH_POPULATION}
                ],
            )
        )
    message = str(refused.value)
    assert message.count("REG-0001") == 1
    assert all(key in message for key in _POPULATION_KEYS)
    assert "no target-population group" not in message
