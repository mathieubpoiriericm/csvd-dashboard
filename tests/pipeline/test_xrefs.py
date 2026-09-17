"""Canonical cross-reference identifiers."""

import logging

from pipeline.xrefs import (
    canonical_from_compact,
    canonical_xref,
    is_omim_series,
    xref_prefix,
)


class TestCanonicalXref:
    def test_a_prefixed_reference_keeps_one_prefix(self) -> None:
        assert canonical_xref("MONDO", "MONDO:0010829") == "MONDO:0010829"

    def test_a_bare_reference_gains_its_prefix(self) -> None:
        assert canonical_xref("Orphanet", "199354") == "Orphanet:199354"
        assert canonical_xref("MONDO", "0010829") == "MONDO:0010829"

    def test_the_source_argument_wins_over_the_value(self) -> None:
        # ClinVar's db_source is the field the API guarantees; a prefix
        # inside db_id is decoration.
        assert canonical_xref("OMIM", "MIM:600142") == "OMIM:600142"

    def test_prefix_matching_is_case_insensitive_but_output_is_not(self) -> None:
        assert canonical_xref("medgen", "C6022615") == "MedGen:C6022615"
        assert canonical_xref("ORPHA", "199354") == "Orphanet:199354"

    def test_an_unstored_prefix_is_rejected_rather_than_guessed(self) -> None:
        # Orphadata returns ICD-10, ICD-11, MedDRA and GARD too. Storing an
        # identifier this pipeline cannot interpret would make the table look
        # richer than it is.
        assert canonical_xref("ICD-10", "I67.8") is None
        assert canonical_xref("GARD", "10424") is None

    def test_an_empty_reference_is_rejected(self) -> None:
        assert canonical_xref("OMIM", "") is None
        assert canonical_xref("OMIM", "   ") is None

    def test_the_identity_authorities_are_stored_too(self) -> None:
        # Open Targets' Ensembl and HGNC ids are identifiers like any other
        # and go through this module rather than being f-string-built at the
        # call site, so there is still exactly one place a spelling is decided.
        assert canonical_xref("Ensembl", "ENSG00000166033") == (
            "Ensembl:ENSG00000166033"
        )
        assert canonical_xref("HGNC", "9476") == "HGNC:9476"


class TestCanonicalFromCompact:
    def test_open_targets_underscore_form(self) -> None:
        assert canonical_from_compact("MONDO_0014768") == "MONDO:0014768"
        assert canonical_from_compact("Orphanet_199354") == "Orphanet:199354"
        assert canonical_from_compact("EFO_0000651") == "EFO:0000651"

    def test_a_token_with_no_separator_is_rejected(self) -> None:
        assert canonical_from_compact("ENSG00000166033") is None

    def test_an_unstored_prefix_is_rejected(self) -> None:
        assert canonical_from_compact("OTAR_0000018") is None


class TestXrefPrefix:
    def test_returns_the_part_before_the_colon(self) -> None:
        assert xref_prefix("MONDO:0010829") == "MONDO"
        assert xref_prefix("HP:0000708") == "HP"

    def test_a_string_with_no_colon_is_its_own_prefix(self) -> None:
        assert xref_prefix("") == ""


def test_all_three_sources_collapse_to_one_spelling_for_carasil() -> None:
    """The property this module exists for.

    These are the literal payload values recorded from the three APIs on
    2026-08-31 for CARASIL. If they do not intersect, nothing downstream can
    join a ClinVar disease to its Orphadata enrichment or its Open Targets
    score.
    """
    clinvar = {
        canonical_xref(source, value)
        for source, value in (
            ("Orphanet", "199354"),
            ("MedGen", "C6022615"),
            ("MONDO", "MONDO:0010829"),
            ("OMIM", "600142"),
        )
    }
    orphadata = {
        canonical_xref(source, value)
        for source, value in (
            ("MONDO", "0010829"),
            ("OMIM", "600142"),
            ("MeSH", "C563990"),
            ("UMLS", "C1838577"),
            ("ICD-10", "I67.8"),
        )
    }
    open_targets = {
        canonical_from_compact(value)
        for value in ("MONDO_0010829", "Orphanet_199354")
    }

    assert "MONDO:0010829" in clinvar & orphadata & open_targets
    assert "OMIM:600142" in clinvar & orphadata
    assert "Orphanet:199354" in clinvar & open_targets
    # Orphadata's ICD-10 row is dropped rather than stored uninterpreted.
    assert None in orphadata


class TestLocalIdNormalisation:
    """The bug this padding exists for.

    Orphadata returns MONDO local ids both padded and bare. Before this,
    ``MONDO:18831`` and ``MONDO:0018831`` were two different strings for one
    disease -- so Orphadata's MONDO could never join ClinVar's, and the short
    form was published on HTRA1 where it resolves to nothing.
    """

    def test_a_short_mondo_id_is_padded_to_the_authority_width(self) -> None:
        assert canonical_xref("MONDO", "18831") == "MONDO:0018831"
        assert canonical_xref("MONDO", "9477") == "MONDO:0009477"

    def test_padding_is_what_makes_the_two_spellings_join(self) -> None:
        assert canonical_xref("MONDO", "18831") == canonical_xref(
            "MONDO", "MONDO:0018831"
        )

    def test_the_other_fixed_width_authorities_pad_too(self) -> None:
        assert canonical_xref("HP", "708") == "HP:0000708"
        assert canonical_xref("GO", "5515") == "GO:0005515"
        assert canonical_xref("EFO", "651") == "EFO:0000651"

    def test_an_already_padded_id_is_unchanged(self) -> None:
        assert canonical_xref("MONDO", "0018831") == "MONDO:0018831"

    def test_orphacodes_and_hgnc_ids_are_not_padded(self) -> None:
        """These authorities genuinely use bare numbers of varying length."""
        assert canonical_xref("Orphanet", "30") == "Orphanet:30"
        assert canonical_xref("Orphanet", "199354") == "Orphanet:199354"
        assert canonical_xref("HGNC", "79") == "HGNC:79"


class TestLocalIdShape:
    def test_a_value_the_authority_would_never_issue_is_rejected(self) -> None:
        # A prefix this pipeline stores is not a licence to store anything
        # under it -- the table must not look richer than it is.
        assert canonical_xref("OMIM", "not a number") is None
        assert canonical_xref("MONDO", "abc") is None
        assert canonical_xref("UMLS", "12345") is None

    def test_the_rejection_is_logged_rather_than_silent(self, caplog) -> None:
        with caplog.at_level(logging.WARNING):
            canonical_xref("OMIM", "12345")
        assert "Unrecognised OMIM identifier" in caplog.text

    def test_every_shape_the_live_table_holds_is_accepted(self) -> None:
        """Measured, not guessed: these are the real shapes per authority."""
        for source, reference in (
            ("EFO", "0003924"),
            ("Ensembl", "ENSG00000120278"),
            ("GO", "0038043"),
            ("HGNC", "12563"),
            ("HP", "0010760"),
            ("MONDO", "0019632"),
            ("MeSH", "C535602"),
            ("MeSH", "D000090542"),
            ("MedGen", "C5676938"),
            ("MedGen", "CN117976"),
            ("OMIM", "619785"),
            ("OMIM", "PS226650"),
            ("Orphanet", "139027"),
            ("UMLS", "C0751587"),
        ):
            assert canonical_xref(source, reference) is not None, (
                f"{source}:{reference} was rejected"
            )

    def test_gene_ontology_terms_go_through_this_module_too(self) -> None:
        # Open Targets' GO ids used to be stored raw, bypassing the one place
        # a spelling is decided.
        assert canonical_xref("GO", "GO:0005515") == "GO:0005515"


class TestIsOmimSeries:
    def test_a_phenotypic_series_is_recognised(self) -> None:
        # PS143890 names a *group* of phenotypes, so it is not the disease's
        # own OMIM number even though it is a real OMIM identifier.
        assert is_omim_series("OMIM:PS143890") is True

    def test_an_entry_number_is_not(self) -> None:
        assert is_omim_series("OMIM:143890") is False

    def test_another_authority_is_not(self) -> None:
        assert is_omim_series("MONDO:0010829") is False
        assert is_omim_series("") is False
