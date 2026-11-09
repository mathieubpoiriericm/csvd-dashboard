"""The structured omics evidence the extraction returns, and its wire form."""

import logging

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


def _entry(omics: object) -> GeneEntry:
    """A gene entry built from what the model returned, as the tool path does."""
    return GeneEntry.model_validate(
        {
            "gene_symbol": "GENE1",
            "confidence": 0.5,
            "source_quote": "A sentence.",
            "omics_evidence": omics,
        }
    )


def test_a_study_type_in_another_case_or_the_prompts_spelling_is_kept() -> None:
    """The tool is not strict, so its enum only advises; the system prompt
    still says "fine-mapping" and "pQTL-MR". A spelling slip must not fail
    the paper, which costs two paid calls and a retry on every later run."""
    entry = _entry(
        [
            {"study_type": "fine-mapping"},
            {"study_type": "proteomics", "biomarker": "Q"},
            {"study_type": "pQTL-MR", "biomarker": "Q"},
        ]
    )
    assert [e.study_type for e in entry.omics_evidence] == [
        "Fine-mapping",
        "Proteomics",
        "Proteogenomic MR",
    ]


def test_a_study_of_an_unknown_type_is_dropped_and_logged(caplog) -> None:
    with caplog.at_level(logging.INFO, logger="pipeline.omics"):
        entry = _entry([{"study_type": "MAGMA"}, {"study_type": "TWAS"}])
    assert entry.omics_evidence == [OmicsEvidence(study_type="TWAS")]
    assert "MAGMA" in caplog.text


def test_bare_strings_are_read_as_a_type_and_as_an_item() -> None:
    entry = _entry(
        [
            "TWAS",
            {
                "study_type": "PWAS",
                "items": ["brain", {"text": "a", "colocalized": True}],
            },
            7,
        ]
    )
    assert entry.omics_evidence == [
        OmicsEvidence(study_type="TWAS"),
        OmicsEvidence(
            study_type="PWAS",
            items=[OmicsItem(text="brain"), OmicsItem(text="a", colocalized=True)],
        ),
    ]


def test_omics_array_escapes_semicolons() -> None:
    assert omics_array(["TWAS;Q: a*"]) == '["TWAS\\u003bQ: a*"]'


def test_wire_strings_accepts_old_strings_and_new_dicts() -> None:
    assert wire_strings(
        ["TWAS", {"study_type": "TWAS", "biomarker": "Q", "items": []}]
    ) == ["TWAS", "TWAS;Q"]
    assert wire_strings([OmicsEvidence(study_type="PWAS")]) == ["PWAS"]
