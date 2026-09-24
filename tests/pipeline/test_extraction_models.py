"""Tests for the shared types in pipeline.extraction_models."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from pipeline.extraction_models import (
    CANONICAL_TRAITS,
    TRACKED_TRAITS,
    TRAIT_SYNONYMS,
    ExtractionResult,
    GeneEntry,
)


def test_source_quote_is_required() -> None:
    with pytest.raises(ValidationError, match="source_quote"):
        GeneEntry.model_validate({"gene_symbol": "NOTCH3", "confidence": 0.9})


def test_source_quote_must_not_be_blank() -> None:
    with pytest.raises(ValidationError):
        GeneEntry(gene_symbol="NOTCH3", confidence=0.9, source_quote="   ")


def test_a_quoted_entry_validates() -> None:
    entry = GeneEntry(
        gene_symbol="NOTCH3",
        confidence=0.9,
        source_quote="NOTCH3 variants were associated with WMH (p=1e-12).",
    )
    assert entry.source_quote.startswith("NOTCH3 variants")


class TestGeneEntry:
    def test_minimal_valid_entry(self):
        g = GeneEntry(
            gene_symbol="NOTCH3",
            confidence=0.9,
            source_quote="NOTCH3 variants were associated with WMH (p=1e-12).",
        )
        assert g.gene_symbol == "NOTCH3"
        assert g.confidence == 0.9
        assert g.gwas_trait == []
        assert g.mendelian_randomization is False
        assert g.pmid == ""

    def test_confidence_out_of_range_rejected(self):
        with pytest.raises(ValidationError):
            GeneEntry(
                gene_symbol="X",
                confidence=1.5,
                source_quote="X was associated with WMH (p=1e-8).",
            )
        with pytest.raises(ValidationError):
            GeneEntry(
                gene_symbol="X",
                confidence=-0.1,
                source_quote="X was associated with WMH (p=1e-8).",
            )

    def test_whitespace_stripped(self):
        g = GeneEntry(
            gene_symbol="  NOTCH3  ",
            confidence=0.9,
            source_quote="NOTCH3 variants were associated with WMH (p=1e-12).",
        )
        assert g.gene_symbol == "NOTCH3"


class TestExtractionResult:
    def test_empty(self):
        r = ExtractionResult()
        assert r.genes == []

    def test_roundtrip(self):
        payload = {
            "genes": [
                {
                    "gene_symbol": "NOTCH3",
                    "confidence": 0.85,
                    "source_quote": (
                        "NOTCH3 variants were associated with WMH (p=1e-12)."
                    ),
                }
            ]
        }
        r = ExtractionResult.model_validate(payload)
        assert r.genes[0].gene_symbol == "NOTCH3"


def test_the_canonical_traits_come_from_the_shared_vocabulary() -> None:
    """disease/vocabulary.json is the single source; nothing restates it.

    The list is the full canonical one -- tracked traits and `untracked`
    terms alike. Constraining the schema to the tracked set would delete
    exactly the signal the vocabulary exists to surface: a term the model
    names correctly and the dashboard does not yet carry.
    """
    with (
        Path(__file__).resolve().parents[2] / "disease" / "vocabulary.json"
    ).open(encoding="utf-8") as handle:
        vocabulary = json.load(handle)

    expected = (
        [trait["key"] for trait in vocabulary["traits"]]
        + [s["from"] for s in vocabulary["synonyms"] if s["source"] == "prompt"]
        + [entry["term"] for entry in vocabulary["untracked"]]
    )
    assert list(CANONICAL_TRAITS) == expected


def _vocabulary() -> dict:
    with (
        Path(__file__).resolve().parents[2] / "disease" / "vocabulary.json"
    ).open(encoding="utf-8") as handle:
        return json.load(handle)


def test_a_prompt_spelling_of_a_tracked_trait_is_admitted() -> None:
    """A spelling the prompt asks for (cSVD's `cerebral-microbleeds`) is admitted.

    Refusing the prompt's own word turned a model that obeyed the prompt
    into a ValidationError, one retry, and a lost paper. The merge folds
    the spelling onto its trait; the schema's job is only to admit it.
    """
    spellings = [s for s in _vocabulary()["synonyms"] if s["source"] == "prompt"]
    if not spellings:
        pytest.skip("disease/vocabulary.json declares no prompt-sourced synonym")
    for synonym in spellings:
        entry = GeneEntry(
            gene_symbol="GENE1",
            confidence=0.9,
            gwas_trait=[synonym["from"]],
            source_quote="GENE1 variants were associated with the trait.",
        )
        assert entry.gwas_trait == [synonym["from"]]
        assert TRAIT_SYNONYMS[synonym["from"]] == synonym["to"]


def test_a_curated_spelling_is_not_admitted() -> None:
    """A spreadsheet spelling the prompt never asks for is refused."""
    curated = [s for s in _vocabulary()["synonyms"] if s["source"] == "curated"]
    if not curated:
        pytest.skip("disease/vocabulary.json declares no curated synonym")
    for synonym in curated:
        with pytest.raises(ValidationError):
            GeneEntry(
                gene_symbol="GENE1",
                confidence=0.9,
                gwas_trait=[synonym["from"]],
                source_quote="GENE1 variants were associated with the trait.",
            )


def test_a_blank_gene_symbol_is_refused() -> None:
    with pytest.raises(ValidationError, match="gene_symbol"):
        GeneEntry(gene_symbol="   ", confidence=0.9, source_quote="A sentence.")


def test_an_off_vocabulary_trait_is_refused() -> None:
    with pytest.raises(ValidationError):
        GeneEntry(
            gene_symbol="NOTCH3",
            confidence=0.9,
            gwas_trait=["not a trait the vocabulary declares"],
            source_quote="NOTCH3 variants were associated with WMH (p=1e-12).",
        )


def test_the_tracked_traits_are_the_vocabularys_traits_and_nothing_else() -> None:
    """The set the merge keeps: `traits[*].key`, without the `untracked` terms.

    CANONICAL_TRAITS admits the untracked terms so the model can name them;
    TRACKED_TRAITS is what may reach the published table, and the two have
    to be read from the same file or the merge's filter drifts from the
    schema's enum.
    """
    vocabulary = _vocabulary()

    assert frozenset(trait["key"] for trait in vocabulary["traits"]) == TRACKED_TRAITS
    assert TRACKED_TRAITS.issubset(CANONICAL_TRAITS)
    for entry in vocabulary["untracked"]:
        assert entry["term"] in CANONICAL_TRAITS
        assert entry["term"] not in TRACKED_TRAITS
