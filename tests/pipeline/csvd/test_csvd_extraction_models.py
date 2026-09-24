"""The cSVD vocabulary as the extraction schema sees it, pinned.

The rules -- a prompt spelling is admitted and folds, a curated spelling is
refused, every untracked term is admitted and never stored -- are tested for
any vocabulary in tests/pipeline/test_extraction_models.py; a fork deletes
this tree.
"""

import pytest
from pydantic import ValidationError

from pipeline.extraction_models import (
    CANONICAL_TRAITS,
    TRACKED_TRAITS,
    TRAIT_SYNONYMS,
    GeneEntry,
)


def test_cerebral_microbleeds_is_admitted_and_folds_onto_cmb() -> None:
    entry = GeneEntry(
        gene_symbol="NOTCH3",
        confidence=0.9,
        gwas_trait=["cerebral-microbleeds"],
        source_quote="NOTCH3 variants were associated with microbleeds.",
    )
    assert entry.gwas_trait == ["cerebral-microbleeds"]
    assert TRAIT_SYNONYMS["cerebral-microbleeds"] == "CMB"


def test_small_vessel_stroke_is_a_curated_spelling_the_schema_refuses() -> None:
    with pytest.raises(ValidationError):
        GeneEntry(
            gene_symbol="NOTCH3",
            confidence=0.9,
            gwas_trait=["small vessel stroke"],
            source_quote="NOTCH3 variants were associated with stroke.",
        )


def test_ich_non_lobar_is_admitted_but_never_stored() -> None:
    assert "ICH-non-lobar" in CANONICAL_TRAITS
    assert "ICH-non-lobar" not in TRACKED_TRAITS
