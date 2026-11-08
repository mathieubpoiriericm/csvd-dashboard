"""The structured omics evidence the extraction returns, and its wire form."""

import pytest
from pydantic import ValidationError

from pipeline.export.tables import _OMICS_TYPES
from pipeline.extraction_models import ExtractionResult, GeneEntry
from pipeline.omics import (
    OMICS_STUDY_TYPES,
    OmicsEvidence,
    OmicsItem,
    omics_array,
    to_wire,
    wire_strings,
)


def test_to_wire_writes_the_format_and_stars_only_colocalized_items() -> None:
    evidence = OmicsEvidence(
        study_type="TWAS",
        biomarker="Q",
        items=[
            OmicsItem(text="artery aorta", colocalized=True),
            OmicsItem(text="YFS: blood"),
        ],
    )
    assert to_wire(evidence) == "TWAS;Q: artery aorta*, YFS: blood"
    assert to_wire(OmicsEvidence(study_type="Proteomics")) == "Proteomics"
    assert to_wire(OmicsEvidence(study_type="TWAS", biomarker="Q")) == "TWAS;Q"
    assert (
        to_wire(OmicsEvidence(study_type="TWAS", items=[OmicsItem(text="a;b*")]))
        == "TWAS;a,b"
    )


def test_a_star_the_model_writes_into_text_is_no_claim() -> None:
    evidence = OmicsEvidence(
        study_type="TWAS", biomarker="Q*", items=[OmicsItem(text="tissue*")]
    )
    assert to_wire(evidence) == "TWAS;Q: tissue"


def test_the_study_type_is_the_published_vocabulary() -> None:
    schema = ExtractionResult.model_json_schema()
    study_type = schema["$defs"]["OmicsEvidence"]["properties"]["study_type"]
    assert study_type["enum"] == list(OMICS_STUDY_TYPES)
    assert {*OMICS_STUDY_TYPES, "(none found)"} == set(_OMICS_TYPES)
    with pytest.raises(ValidationError):
        OmicsEvidence(study_type="MAGMA")


def test_a_gene_entry_carries_structured_omics_evidence() -> None:
    entry = GeneEntry(
        gene_symbol="GENE1",
        confidence=0.5,
        source_quote="A sentence.",
        omics_evidence=[{"study_type": "TWAS", "biomarker": "Q", "items": []}],
    )
    assert entry.omics_evidence == [OmicsEvidence(study_type="TWAS", biomarker="Q")]


def test_omics_array_escapes_semicolons() -> None:
    assert omics_array(["TWAS;Q: a*"]) == '["TWAS\\u003bQ: a*"]'


def test_wire_strings_accepts_old_strings_and_new_dicts() -> None:
    assert wire_strings(
        ["TWAS", {"study_type": "TWAS", "biomarker": "Q", "items": []}]
    ) == ["TWAS", "TWAS;Q"]
    assert wire_strings([OmicsEvidence(study_type="PWAS")]) == ["PWAS"]
