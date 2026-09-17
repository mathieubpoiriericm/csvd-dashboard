"""The annotation row contract."""


from pipeline.annotations import (
    _LOOKUP_ALIASES,
    AnnotationRow,
    AnnotationStatus,
    DrugAnnotationRow,
    expand_lookup_symbols,
    group_key_for,
    lookup_symbols,
)


class TestGroupKeyFor:
    def test_prefers_mondo(self) -> None:
        assert group_key_for(
            ["OMIM:600142", "Orphanet:199354", "MONDO:0010829", "MedGen:C6022615"]
        ) == "MONDO:0010829"

    def test_falls_back_through_omim_then_orphanet_then_medgen(self) -> None:
        assert group_key_for(["OMIM:616779", "MedGen:C4225211"]) == "OMIM:616779"
        assert group_key_for(["Orphanet:482072", "MedGen:C5680099"]) == (
            "Orphanet:482072"
        )
        assert group_key_for(["MedGen:C0007774"]) == "MedGen:C0007774"

    def test_an_unrankable_set_groups_under_the_empty_string(self) -> None:
        # A GO term or an Ensembl id is not a disease and groups with nothing.
        assert group_key_for(["GO:0005515"]) == ""
        assert group_key_for([]) == ""

    def test_the_choice_is_deterministic_across_input_order(self) -> None:
        forward = group_key_for(["MONDO:0010829", "MONDO:0014768"])
        reverse = group_key_for(["MONDO:0014768", "MONDO:0010829"])
        assert forward == reverse == "MONDO:0010829"


class TestAnnotationRow:
    def test_carries_every_field_the_table_stores(self) -> None:
        row = AnnotationRow(
            gene_symbol="HTRA1",
            source="clinvar",
            relation="disease",
            group_key="MONDO:0010829",
            object_id="Orphanet:199354",
            object_label="CARASIL syndrome",
            qualifier="Pathogenic/Likely pathogenic",
            score=None,
            evidence_count=5,
            source_version=None,
        )
        assert row.gene_symbol == "HTRA1"
        assert row.evidence_count == 5

    def test_sorts_deterministically(self) -> None:
        """Rows are written in sorted order so the export stays reproducible."""
        rows = [
            AnnotationRow("HTRA1", "clinvar", "disease", "MONDO:0010829",
                          "OMIM:600142", None, None, None, None, None),
            AnnotationRow("HTRA1", "clinvar", "disease", "MONDO:0010829",
                          "MONDO:0010829", None, None, None, None, None),
        ]
        assert [r.object_id for r in sorted(rows, key=AnnotationRow.sort_key)] == [
            "MONDO:0010829",
            "OMIM:600142",
        ]


class TestAnnotationStatus:
    def test_records_a_zero_row_fetch(self) -> None:
        status = AnnotationStatus(
            gene_symbol="C6orf195", source="clinvar", row_count=0, source_version=None
        )
        assert status.row_count == 0


class TestDrugAnnotationRow:
    def test_records_an_unresolved_drug(self) -> None:
        row = DrugAnnotationRow(
            drug="THN391",
            chembl_id=None,
            action_type=None,
            mechanism_of_action=None,
            target_symbols=None,
            source_version="26.06",
            resolved=False,
        )
        assert row.resolved is False
        assert row.chembl_id is None


class TestLookupAliases:
    """A curated key that is not a gene symbol is queried by what it stands for."""

    def test_an_ordinary_symbol_is_returned_unchanged(self) -> None:
        assert lookup_symbols("HTRA1") == ("HTRA1",)

    def test_the_collagen_pair_fans_out_to_both_chains(self) -> None:
        """COL4A1/2 is a curator label; no external database carries it.

        Queried literally it returned nothing from all three sources, so the
        pair that causes Gould syndrome, PADMAL and HANAC published no disease
        at all -- a blank that reads as "none known" rather than "not a symbol".
        """
        assert lookup_symbols("COL4A1/2") == ("COL4A1", "COL4A2")

    def test_a_retired_symbol_is_queried_under_its_current_name(self) -> None:
        assert lookup_symbols("C6orf195") == ("LINC01600",)

    def test_expansion_maps_every_query_back_to_its_curated_key(self) -> None:
        queries, curated_by_query = expand_lookup_symbols(
            ["HTRA1", "COL4A1/2", "C6orf195"]
        )
        assert queries == ["HTRA1", "COL4A1", "COL4A2", "LINC01600"]
        assert curated_by_query == {
            "HTRA1": "HTRA1",
            "COL4A1": "COL4A1/2",
            "COL4A2": "COL4A1/2",
            "LINC01600": "C6orf195",
        }

    def test_a_repeated_symbol_is_queried_once(self) -> None:
        queries, _ = expand_lookup_symbols(["HTRA1", "HTRA1"])
        assert queries == ["HTRA1"]

    def test_the_alias_map_reconciles_with_the_merge_s_canonical_map(self) -> None:
        """The two directions of one correspondence, kept in step.

        `_CANONICAL_GENE_SYMBOLS` folds an extracted `COL4A1` onto the curated
        `COL4A1/2` on the way in; `_LOOKUP_ALIASES` fans the curated key back
        out to `COL4A1` on the way to an external database. Both derive from
        `geneAliases` in disease/pipeline.json, one forward and one inverted,
        rather than one importing the other -- `pipeline.annotations` imports
        nothing from the pipeline, which is what keeps the row contract free
        of the merge's dependencies -- so this test guards that neither stops
        deriving from that map and gains an entry the other lacks.
        """
        from pipeline.data_merger import _CANONICAL_GENE_SYMBOLS

        inverted: dict[str, tuple[str, ...]] = {}
        for member, curated in _CANONICAL_GENE_SYMBOLS.items():
            inverted[curated] = (*inverted.get(curated, ()), member)
        assert inverted == _LOOKUP_ALIASES
