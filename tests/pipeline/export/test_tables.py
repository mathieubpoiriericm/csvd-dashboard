import json
import logging
import re
from pathlib import Path

import pytest

from pipeline.export.tables import (
    _OMICS_TYPE_KEYS,
    _publishable_omics,
    clean_gene_row,
    clean_omics_value,
    clean_trial_row,
    split_gwas_traits,
)
from pipeline.export.writer import to_camel

_TRIAL = {
    "drug": "Butylphthalide (NBP)",
    "mechanism_of_action": "Neuroprotective",
    "genetic_target": None,
    "genetic_evidence": "N",
    "trial_name": "Isosorbide Mononitrate and Butylphthalide",
    "registry_id": "ChiCTR2500109773",
    "clinical_trial_phase": "III",
    "target_population": "CAA",
    "target_population_details": "CAA-related ICH",
    "target_sample_size": 3156,
    "estimated_completion_date": "7/2028",
    "primary_outcome": "Post-stroke disability at 6 months",
    "sponsor_type": "Academic",
    "overall_status": "RECRUITING",
}


def test_omics_strips_the_star_suffix() -> None:
    assert clean_omics_value("TWAS*") == ["TWAS"]


def test_omics_expands_the_mentr_sentence() -> None:
    raw = "Evidence for causal implication from ML-based functional prediction (MENTR)"
    assert clean_omics_value(raw) == [
        "mutation effect prediction on ncRNA transcription"
    ]


def test_omics_leaves_no_dangling_separator() -> None:
    """Deleting a whole tissue name must not strand its separator.

    'TWAS:YFS.BLOOD.RNAARR' would otherwise render as 'TWAS;' in the cell.
    """
    assert clean_omics_value("TWAS:YFS.BLOOD.RNAARR") == ["TWAS"]


def test_omics_entry_that_is_only_a_deleted_tissue_collapses_away() -> None:
    assert clean_omics_value("YFS.BLOOD.RNAARR") == ["(none found)"]


def test_omics_rewrites_gtex_cross_tissue() -> None:
    assert clean_omics_value("TWAS:GTEX - Cross-tissue sCCA3") == ["TWAS;cross-tissue"]


def test_omics_splits_multiple_studies_on_comma() -> None:
    assert clean_omics_value("TWAS*;PWAS*") == ["TWAS", "PWAS"]


def test_omics_keeps_a_comma_inside_an_entrys_own_parentheses() -> None:
    """The extraction writes free text; "(plasma, CSF)" is one study, not two.

    The curated prose uses "," and ";" as study separators, but
    `format_omics` joins the model's `omics_evidence` elements on ";" and
    an element may carry a parenthetical list. Splitting inside it left a
    second entry -- "CSF)" -- with no omics type and no filter that could
    reach it.

    The kept entry is then normalized to the wire form the filter reads:
    lib/filters.ts keys on the text before the first ";", so
    "Proteomics (plasma, CSF)" would have been unselectable as a whole.
    """
    assert clean_omics_value("Proteomics (plasma, CSF)*;TWAS*") == [
        "Proteomics;plasma, CSF",
        "TWAS",
    ]


def test_omics_missing_becomes_the_sentinel() -> None:
    assert clean_omics_value(None) == ["(none found)"]
    assert clean_omics_value("") == ["(none found)"]


# ---------------------------------------------------------------------------
# The omics vocabulary -- reconciled against lib/constants.ts
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).resolve().parents[3]
_OMICS_CHOICE = re.compile(r'value:\s*(?:"([^"]*)"|SHOW_ALL|NONE_FOUND)')


def _filter_choice_values() -> set[str]:
    """The omics values lib/constants.ts offers, normalized as the filter is.

    Read from the TypeScript rather than restated, the way
    tests/pipeline/test_prompt_vocabulary.py reads disease/vocabulary.json: a
    choice added there has to reach the export, or the export publishes a
    value the UI cannot select.
    """
    source = (_REPO_ROOT / "lib" / "constants.ts").read_text(encoding="utf-8")
    start = source.index("export const OMICS_CHOICES")
    block = source[start : source.index("];", start)]
    assert "SHOW_ALL" in block, (
        "OMICS_CHOICES no longer opens with the Show All choice; if the block "
        "moved, update this reader -- do not delete this test."
    )
    values = {match.group(1) for match in _OMICS_CHOICE.finditer(block)}
    # NONE_FOUND is written as the identifier, not a literal.
    return {value.strip().lower() for value in values if value} | {"(none found)"}


def test_the_export_gates_omics_on_the_dashboards_own_choices() -> None:
    """_OMICS_TYPES is what makes every published element selectable, so it
    has to be exactly lib/constants.ts's OMICS_CHOICES minus "all" -- which
    means "no filter" rather than a value. Drift in either direction is a
    published study nobody can filter to, or a filter choice that matches
    nothing.
    """
    assert _filter_choice_values() == _OMICS_TYPE_KEYS


@pytest.mark.parametrize(
    ("stored", "published"),
    [
        # Every label the prompt merely *suggests* -- omics_evidence is free
        # text, unlike gwas_trait -- and every tail a colon-and-comma form
        # leaves behind.
        ("colocalization*", ["(none found)"]),
        ("MAGMA*", ["(none found)"]),
        ("pQTL-MR*;TWAS*", ["TWAS"]),
        ("PWAS: plasma, CSF*", ["PWAS; plasma"]),
    ],
)
def test_omics_evidence_with_no_filterable_type_is_not_published(
    stored: str, published: list[str], caplog
) -> None:
    """An unfilterable element is invisible in the UI whatever the export
    does with it, and publishing it fails tests/data_contract_test.ts. It is
    dropped and logged, the disposition pipeline/data_merger.py already gives
    an untracked GWAS trait.
    """
    with caplog.at_level(logging.INFO, logger="pipeline.export.tables"):
        assert clean_omics_value(stored, "BTN3A2") == published

    assert "BTN3A2" in caplog.text
    assert "no filterable study type" in caplog.text


def test_a_dropped_element_is_logged_without_a_gene_too(caplog) -> None:
    """clean_omics_value is callable without a row -- the direct tests above
    do it -- and the log line must still name what was dropped."""
    with caplog.at_level(logging.INFO, logger="pipeline.export.tables"):
        assert clean_omics_value("colocalization*") == ["(none found)"]

    assert "'colocalization'" in caplog.text


def test_a_parenthetical_type_outside_the_vocabulary_is_still_dropped() -> None:
    """The rewrite recovers a *known* type wearing its detail as a
    parenthetical. It never invents one: "single-cell (cortex)" names no
    study the dashboard carries, and publishing "single-cell;cortex" would
    only move the unfilterable value.
    """
    assert clean_omics_value("single-cell (cortex)*;TWAS*") == ["TWAS"]


def test_a_bare_parenthetical_type_keeps_its_type_alone() -> None:
    assert clean_omics_value("Proteomics ()*") == ["Proteomics"]


def test_the_gate_republishes_every_committed_value_unchanged() -> None:
    """The published file is the regression bar: this fix may make a new
    shape reachable, but it must not rewrite or drop a value already in
    data/table1.json.
    """
    rows = json.loads(
        (_REPO_ROOT / "data" / "table1.json").read_text(encoding="utf-8")
    )
    published = [
        value for row in rows for value in row["evidenceFromOtherOmicsStudies"]
    ]
    assert published  # the file would otherwise prove nothing
    assert _publishable_omics(published, "committed") == published


def test_gene_row_produces_the_display_contract() -> None:
    row = clean_gene_row(
        {
            "gene": "LAMB1",
            "protein": "LAMB1",
            "chromosomal_location": "7q31.1",
            "gwas_trait": ["SVS", "WMH"],
            "mendelian_randomization": None,
            "evidence_from_other_omics_studies": None,
            "link_to_monogenetic_disease": None,
            "brain_cell_types": "ALL",
            "affected_pathway": "Extracellular Matrix Organization",
            "references": ["37063705", "34606115"],
        }
    )
    assert row["Gene"] == "LAMB1"
    assert row["GWAS Trait"] == ["SVS", "WMH"]
    assert row["Mendelian Randomization"] == "No"
    assert row["Evidence From Other Omics Studies"] == ["(none found)"]
    assert row["Link to Monogenic Disease"] == ["(none found)"]
    assert row["Brain Cell Types"] == "all"
    assert row["Affected Pathway"] == "extracellular matrix organization"
    assert row["References"] == ["37063705", "34606115"]


def test_gene_row_puts_gene_first() -> None:
    row = clean_gene_row({"protein": "X", "gene": "ABC", "references": ["1234567"]})
    assert next(iter(row)) == "Gene"


# Every scalar text field of the published gene row. Confidence is excluded on
# purpose: it is a nullable number, not a sentineled string (lib/types.ts).
_GENE_STRING_FIELDS = (
    "Gene",
    "Protein",
    "Chromosomal Location",
    "Mendelian Randomization",
    "Brain Cell Types",
    "Affected Pathway",
    "Source Quote",
)


@pytest.mark.parametrize("absent", ["", "   ", None])
def test_gene_row_is_string_only(absent: str | None) -> None:
    """The companion to test_trial_row_is_string_only.

    tests/data_contract_test.ts asserts every one of these is a nonblank
    string, and lib/data/genes.ts rewrites a null to "(unknown)" at runtime --
    so a column with no fill here is a gap the UI hides rather than reports.
    """
    row = clean_gene_row(
        {
            "protein": absent,
            "gene": "BTN3A2",
            "chromosomal_location": absent,
            "gwas_trait": None,
            "mendelian_randomization": None,
            "evidence_from_other_omics_studies": absent,
            "link_to_monogenetic_disease": None,
            "brain_cell_types": absent,
            "affected_pathway": absent,
            "references": None,
            "source_quote": absent,
            "confidence": None,
        }
    )
    for name in _GENE_STRING_FIELDS:
        value = row[name]
        assert isinstance(value, str) and value.strip(), name


def test_a_pipeline_inserted_gene_publishes_a_location_sentinel() -> None:
    """pipeline/data_merger.py stores "" here for every gene it admits --
    nothing in pipeline/ writes a cytogenetic band, the curators do -- so
    without the fill a newly accepted gene ships
    `"chromosomalLocation": null`. "(unknown)" is the sentinel
    lib/cytobands.ts refuses to place, so the phenogram lists the gene as
    unplaced instead of guessing a band.
    """
    row = clean_gene_row({"gene": "BTN3A2", "chromosomal_location": ""})
    assert row["Chromosomal Location"] == "(unknown)"


def test_the_gene_symbol_placeholder_is_not_published_as_a_protein_name() -> None:
    """The merge stores the symbol when no paper named a protein, and both
    write paths in pipeline/database.py read `protein = gene` back as "still
    missing". The export says the same thing rather than showing a gene
    symbol in the Protein column.
    """
    row = clean_gene_row({"gene": "BTN3A2", "protein": "BTN3A2"})
    assert row["Protein"] == "(unknown)"


@pytest.mark.parametrize(("gene", "protein"), [("EPHB4", "EphB4"), ("EPO", "Epo")])
def test_a_protein_written_the_way_proteins_are_written_is_kept(
    gene: str, protein: str
) -> None:
    """Exact equality, as the SQL uses. Both of these are real curated names
    in data/table1.json, and a case-insensitive rule would sentinel them.
    """
    assert clean_gene_row({"gene": gene, "protein": protein})["Protein"] == protein


def test_a_real_protein_name_is_published_verbatim() -> None:
    name = "Neurogenic locus notch homolog protein 3"
    assert clean_gene_row({"gene": "NOTCH3", "protein": name})["Protein"] == name


def test_gene_row_publishes_a_real_source_quote_verbatim() -> None:
    row = clean_gene_row(
        {
            "gene": "NOTCH3",
            "references": ["1234567"],
            "source_quote": "NOTCH3 variants were associated with WMH (p=1e-12).",
        }
    )
    assert row["Source Quote"] == "NOTCH3 variants were associated with WMH (p=1e-12)."


def test_gene_row_sentinels_a_missing_source_quote() -> None:
    """61 of 63 curated rows predate migration 004's provenance prompt and
    carry no quote at all; a null key on a string-typed field is the thing
    the sentinel exists to avoid.
    """
    row = clean_gene_row({"gene": "ABC", "references": ["1234567"]})
    assert row["Source Quote"] == "(not yet extracted)"

    row = clean_gene_row(
        {"gene": "ABC", "references": ["1234567"], "source_quote": None}
    )
    assert row["Source Quote"] == "(not yet extracted)"

    row = clean_gene_row(
        {"gene": "ABC", "references": ["1234567"], "source_quote": "   "}
    )
    assert row["Source Quote"] == "(not yet extracted)"


def test_gene_row_passes_confidence_through_as_a_nullable_number() -> None:
    """Confidence is a nullable number, not a sentineled string: a missing
    score publishes as JSON null rather than a placeholder word.
    """
    row = clean_gene_row(
        {"gene": "NOTCH3", "references": ["1234567"], "confidence": 0.87}
    )
    assert row["Confidence"] == 0.87

    row = clean_gene_row({"gene": "ABC", "references": ["1234567"]})
    assert row["Confidence"] is None


def test_gene_row_key_order_matches_the_committed_artifact() -> None:
    """Field order is part of write_rows' contract: pipeline/export/writer.py
    preserves dict insertion order verbatim into the emitted JSON, so a
    column rename must relabel a key in place rather than move it -- exactly
    what clean_table1.R's `names(table1) <- gsub(old, new, names(table1))`
    does, and what a pop()-then-reassign rename would silently break.

    The expected order is read from the committed file itself, not
    hard-coded, so drift in either direction gets caught.
    """
    repo_root = Path(__file__).resolve().parents[3]
    committed_text = (repo_root / "data" / "table1.json").read_text(encoding="utf-8")
    expected = list(json.loads(committed_text)[0].keys())

    row = clean_gene_row(
        {
            "gene": "LAMB1",
            "protein": "LAMB1",
            "chromosomal_location": "7q31.1",
            "gwas_trait": ["SVS", "WMH"],
            "mendelian_randomization": None,
            "evidence_from_other_omics_studies": None,
            "link_to_monogenetic_disease": None,
            "brain_cell_types": "ALL",
            "affected_pathway": "Extracellular Matrix Organization",
            "references": ["37063705", "34606115"],
            "source_quote": None,
            "confidence": None,
        }
    )
    assert [to_camel(key) for key in row] == expected


def test_trial_row_is_string_only() -> None:
    row = clean_trial_row(dict(_TRIAL))
    assert all(isinstance(v, str) and v.strip() for v in row.values())


def test_target_sample_size_is_stringified_not_dropped() -> None:
    """The column is nullable and mixes formats, so it ships as a string."""
    assert clean_trial_row(dict(_TRIAL))["Target Sample Size"] == "3156"
    assert (
        clean_trial_row({**_TRIAL, "target_sample_size": None})["Target Sample Size"]
        == "(unknown)"
    )


def test_genetic_target_has_its_own_sentinel_set() -> None:
    assert clean_trial_row({**_TRIAL, "genetic_target": "-"})["Genetic Target"] == (
        "(none)"
    )
    assert clean_trial_row({**_TRIAL, "genetic_target": None})["Genetic Target"] == (
        "(none)"
    )


def test_completed_unpublished_is_normalized() -> None:
    for raw in (
        "Completed, unpublished",
        "Completed; unpublish",
        "completed unpublished",
    ):
        row = clean_trial_row({**_TRIAL, "estimated_completion_date": raw})
        assert row["Estimated Completion Date"] == "Completed (unpublished)"


def test_completed_unpublished_near_miss_is_left_unchanged() -> None:
    """Verified against R's grepl(..., perl = TRUE, ignore.case = TRUE): an
    extra word between "Completed" and "unpublished" must not match, since
    the pattern only tolerates one optional comma/semicolon plus whitespace.
    """
    row = clean_trial_row(
        {**_TRIAL, "estimated_completion_date": "Completed and unpublished"}
    )
    assert row["Estimated Completion Date"] == "Completed and unpublished"


def test_genetic_evidence_is_folded_to_yes_no() -> None:
    assert clean_trial_row(dict(_TRIAL))["Genetic Evidence"] == "No"


def test_overall_status_is_published_and_a_null_becomes_the_sentinel() -> None:
    assert clean_trial_row(dict(_TRIAL))["Overall Status"] == "RECRUITING"
    assert (
        clean_trial_row({**_TRIAL, "overall_status": None})["Overall Status"]
        == "(unknown)"
    )


def test_trial_row_key_order_matches_the_committed_artifact() -> None:
    """Field order is part of write_rows' contract: pipeline/export/writer.py
    preserves dict insertion order verbatim into the emitted JSON. Every
    write inside clean_trial_row must therefore update an existing key in
    place rather than insert a new one -- exactly the failure mode Task 7
    shipped when a pop()-then-reassign rename silently appended a key at
    the end.

    The expected order is read from the committed file itself, not
    hard-coded, so drift in either direction gets caught.
    """
    repo_root = Path(__file__).resolve().parents[3]
    committed_text = (repo_root / "data" / "table2.json").read_text(encoding="utf-8")
    expected = list(json.loads(committed_text)[0].keys())

    row = clean_trial_row(dict(_TRIAL))
    assert [to_camel(key) for key in row] == expected


def test_known_trait_synonyms_fold_onto_the_controlled_vocabulary() -> None:
    """lib/constants.ts GWAS_TRAIT_CHOICES and phenogram_encoding.json both
    key on short STRIVE-style codes. A synonym that never reaches that
    vocabulary is unreachable in the UI and fails tests/data_contract_test.ts
    ("every committed GWAS trait is available as a filter choice").

    The folding itself is publishable_traits' job, and has its own cases (as
    does split_gwas_traits, which only scripts/backfill_gene_lists.py still
    calls); what this pins is that clean_gene_row publishes the vocabulary it
    is handed, in order, rather than re-deriving it.
    """
    row = clean_gene_row(
        {
            "gene": "COL4A1/2",
            "protein": "COL4A1",
            "chromosomal_location": "13q34",
            "gwas_trait": ["WMH", "SVS", "lacunes", "CMB"],
            "mendelian_randomization": None,
            "evidence_from_other_omics_studies": None,
            "link_to_monogenetic_disease": None,
            "brain_cell_types": None,
            "affected_pathway": None,
            "references": ["42437605"],
        }
    )
    assert row["GWAS Trait"] == ["WMH", "SVS", "lacunes", "CMB"]


def test_an_unmapped_trait_is_left_alone() -> None:
    """A trait the rewrite does not know reaches the join table verbatim and
    must publish that way -- clean_gene_row may not mangle a value the
    curators wrote deliberately."""
    row = clean_gene_row(
        {
            "gene": "NOTCH3",
            "protein": "NOTCH3",
            "chromosomal_location": "19p13.12",
            "gwas_trait": ["WMH", "PSMD", "extreme-cSVD"],
            "mendelian_randomization": None,
            "evidence_from_other_omics_studies": None,
            "link_to_monogenetic_disease": None,
            "brain_cell_types": None,
            "affected_pathway": None,
            "references": ["12345678"],
        }
    )
    assert row["GWAS Trait"] == ["WMH", "PSMD", "extreme-cSVD"]


def test_clean_gene_row_folds_synonyms_and_drops_untracked_terms() -> None:
    """The join table holds what the merge stored, and until the merge
    learned to drop them that included the `untracked` vocabulary terms:
    the 2026-09-01 run left COL4A1/2 carrying ICH-non-lobar. A trait with
    no filter choice fails tests/data_contract_test.ts, so the export is
    the second layer: fold the synonyms, drop the untracked terms, and
    collapse whatever the fold made identical -- in order, as always."""
    row = clean_gene_row(
        {
            "gene": "COL4A1/2",
            "gwas_trait": ["ICH-non-lobar", "cerebral-microbleeds", "WMH", "CMB"],
            "references": ["42437605"],
        }
    )
    assert row["GWAS Trait"] == ["CMB", "WMH"]


def test_clean_gene_row_publishes_the_sentinel_when_only_untracked_terms_remain() -> (
    None
):
    row = clean_gene_row(
        {"gene": "X", "gwas_trait": ["ICH-lobar", "OD"], "references": ["1"]}
    )
    assert row["GWAS Trait"] == ["(none found)"]


def test_split_gwas_traits_folds_synonyms_in_source_order() -> None:
    assert split_gwas_traits("small vessel stroke, WMH") == ["SVS", "WMH"]


def test_split_gwas_traits_trims_the_whole_cell_before_splitting() -> None:
    """clean_gene_row applied normalize_text first, and _SPLIT_ON_COMMA
    reaches neither the first part's leading nor the last part's trailing
    whitespace. "PSMD " is a real stored value, not a hypothetical."""
    assert split_gwas_traits("  PSMD , WMH  ") == ["PSMD", "WMH"]


def test_split_gwas_traits_treats_the_missing_sentinels_as_no_traits() -> None:
    """fill_missing_text's fold has to happen before a value is stored:
    without it "NA" backfills as the trait "NA" and publishes as ["NA"]
    where the export has always emitted ["(none found)"]."""
    assert split_gwas_traits(None) == []
    assert split_gwas_traits("") == []
    assert split_gwas_traits("NA") == []
    assert split_gwas_traits("n/a") == []


def test_clean_gene_row_applies_sentinels_to_empty_lists() -> None:
    row = {
        "gene": "HTRA1",
        "references": [],
        "gwas_trait": [],
        "link_to_monogenetic_disease": [],
        "evidence_from_other_omics_studies": None,
    }
    out = clean_gene_row(row)
    assert out["References"] == ["(reference needed)"]
    assert out["GWAS Trait"] == ["(none found)"]
    assert out["Link to Monogenic Disease"] == ["(none found)"]


def test_clean_gene_row_applies_sentinels_to_absent_lists() -> None:
    """A gene with no rows in a join table reaches clean_gene_row with None
    in that key -- the NULL placeholder _read_genes_with_lists selects."""
    out = clean_gene_row(
        {
            "gene": "HTRA1",
            "references": None,
            "gwas_trait": None,
            "link_to_monogenetic_disease": None,
            "evidence_from_other_omics_studies": None,
        }
    )
    assert out["References"] == ["(reference needed)"]
    assert out["GWAS Trait"] == ["(none found)"]


def test_clean_gene_row_passes_populated_lists_through_in_order() -> None:
    row = {
        "gene": "HTRA1",
        "references": ["33773636", "33773637"],
        "gwas_trait": ["WMH"],
        "link_to_monogenetic_disease": ["600142"],
        "evidence_from_other_omics_studies": None,
    }
    out = clean_gene_row(row)
    assert out["References"] == ["33773636", "33773637"]
    assert out["GWAS Trait"] == ["WMH"]


def test_clean_gene_row_renders_boolean_mr_as_yes_no() -> None:
    """NULL renders "No", matching the varchar behaviour: clean_gene_row
    filled a missing value with "N" before normalize_yes_no saw it, because
    missing and textual-NA both mean no MR support in the source schema."""
    assert (
        clean_gene_row({"gene": "X", "mendelian_randomization": True})[
            "Mendelian Randomization"
        ]
        == "Yes"
    )
    assert (
        clean_gene_row({"gene": "X", "mendelian_randomization": False})[
            "Mendelian Randomization"
        ]
        == "No"
    )
    assert (
        clean_gene_row({"gene": "X", "mendelian_randomization": None})[
            "Mendelian Randomization"
        ]
        == "No"
    )


_SENTINEL_LITERAL = re.compile(r'^export const [A-Z_]+ = "(\([^"]+\))";', re.MULTILINE)


def test_the_dashboards_absent_sentinels_are_the_ones_the_export_writes() -> None:
    """lib/sentinels.ts is the dashboard's one spelling of the absent-value
    sentinels: the data layer fills with them, the filter choices match them
    and the tables render them as an em dash. Each has to be a string this
    module actually writes, or the UI is checking for a value that never
    arrives -- read from the TypeScript rather than restated, the way
    test_the_export_gates_omics_on_the_dashboards_own_choices reads
    OMICS_CHOICES.
    """
    source = (_REPO_ROOT / "lib" / "sentinels.ts").read_text(encoding="utf-8")
    sentinels = set(_SENTINEL_LITERAL.findall(source))
    assert len(sentinels) == 5, (
        "lib/sentinels.ts no longer declares five `export const X = \"(...)\"` "
        "lines; if the shape moved, update this reader -- do not delete it."
    )
    tables = (_REPO_ROOT / "pipeline" / "export" / "tables.py").read_text(
        encoding="utf-8"
    )
    missing = {sentinel for sentinel in sentinels if f'"{sentinel}"' not in tables}
    assert not missing, f"the export never writes {sorted(missing)}"
