"""Tests for pipeline.data_merger — pure helpers and async merge logic."""

import json
import logging
from pathlib import Path

from pipeline.data_merger import (
    _CANONICAL_GENE_SYMBOLS,
    _build_combined_gene_data,
    canonical_gene_symbol,
    dedupe_list,
    format_omics,
    merge_gene_entries,
)


def _build_gene_data(entry):
    """Test helper: build DB row for a single entry."""
    return _build_combined_gene_data([entry])


# ---------------------------------------------------------------------------
# dedupe_list
# ---------------------------------------------------------------------------


class TestDedupeList:
    def test_no_duplicates(self):
        assert dedupe_list(["a", "b", "c"]) == ["a", "b", "c"]

    def test_with_duplicates(self):
        assert dedupe_list(["a", "b", "a", "c", "b"]) == ["a", "b", "c"]

    def test_empty(self):
        assert dedupe_list([]) == []

    def test_all_same(self):
        assert dedupe_list(["x", "x", "x"]) == ["x"]

    def test_preserves_order(self):
        assert dedupe_list(["c", "a", "b", "a"]) == ["c", "a", "b"]

    def test_with_ints(self):
        assert dedupe_list([1, 2, 1, 3]) == [1, 2, 3]


# ---------------------------------------------------------------------------
# format_omics
# ---------------------------------------------------------------------------


class TestFormatOmics:
    def test_empty(self):
        assert format_omics([]) == ""

    def test_single(self):
        assert format_omics(["TWAS"]) == "TWAS*"

    def test_multiple(self):
        assert format_omics(["TWAS", "PWAS"]) == "TWAS*;PWAS*"

    def test_three_types(self):
        result = format_omics(["TWAS", "PWAS", "EWAS"])
        assert result == "TWAS*;PWAS*;EWAS*"


# ---------------------------------------------------------------------------
# _build_gene_data
# ---------------------------------------------------------------------------


class TestBuildGeneData:
    def test_basic_fields(self, sample_gene_entry):
        data = _build_gene_data(sample_gene_entry)
        assert data["gene"] == "NOTCH3"
        assert data["protein"] == "Notch receptor 3"
        assert data["references"] == ["12345678"]

    def test_source_quote_carried_through(self, sample_gene_entry):
        """A field that validates but never reaches the assembled row would
        imply provenance that isn't stored — this pins that it does."""
        data = _build_gene_data(sample_gene_entry)
        assert data["source_quote"] == sample_gene_entry.source_quote
        assert data["source_quote"] != ""

    def test_source_quote_ties_break_to_the_first_paper(self, make_gene_entry):
        """Multiple mentions of the same gene at the same confidence: the
        quote from the first paper wins, matching the "gene": first.gene_symbol
        rule. `max` returns the first maximal element, which is that."""
        entries = [
            make_gene_entry(
                gene_symbol="NOTCH3",
                pmid="111",
                source_quote="First paper's NOTCH3 quote.",
            ),
            make_gene_entry(
                gene_symbol="NOTCH3",
                pmid="222",
                source_quote="Second paper's NOTCH3 quote.",
            ),
        ]
        data = _build_combined_gene_data(entries)
        assert data["source_quote"] == "First paper's NOTCH3 quote."

    def test_confidence_carried_through(self, make_gene_entry):
        """Kept beside its quote: one entry names both, so the published
        confidence and sentence describe one extraction."""
        entry = make_gene_entry(confidence=0.87)
        data = _build_gene_data(entry)
        assert data["confidence"] == 0.87

    def test_the_published_pair_is_the_one_the_insert_floor_reads(
        self, make_gene_entry
    ):
        """The gate reads the best score in the group, so the row must too.

        Publishing the first paper's pair while admitting on the highest
        score put rows in data/table1.json below the insert floor that
        data/pipeline_run.json names for the same run, with the sentence
        that actually cleared the floor published nowhere.
        """
        entries = [
            make_gene_entry(
                gene_symbol="NOTCH3",
                pmid="111",
                confidence=0.50,
                source_quote="The weaker paper's NOTCH3 sentence.",
            ),
            make_gene_entry(
                gene_symbol="NOTCH3",
                pmid="222",
                confidence=0.80,
                source_quote="The deciding paper's NOTCH3 sentence.",
            ),
        ]
        data = _build_combined_gene_data(entries)
        assert data["confidence"] == 0.80
        assert data["source_quote"] == "The deciding paper's NOTCH3 sentence."
        # The other fields still merge across every entry, and the curated
        # key still comes from the first: only the provenance pair moved.
        assert data["references"] == ["111", "222"]

    def test_protein_fallback_to_gene(self, make_gene_entry):
        entry = make_gene_entry(protein_name=None)
        data = _build_gene_data(entry)
        assert data["protein"] == "NOTCH3"

    def test_gwas_trait_is_a_deduped_list(self, make_gene_entry):
        """The join table takes one row per trait, so the merge stops joining."""
        data = _build_combined_gene_data(
            [
                make_gene_entry(gwas_trait=["WMH", "SVS"]),
                make_gene_entry(gwas_trait=["SVS", "lacunes"]),
            ]
        )
        assert data["gwas_trait"] == ["WMH", "SVS", "lacunes"]
        # References dedupe across entries the same way -- both fixtures
        # carry the same PMID, and it appears once.
        assert data["references"] == ["12345678"]

    def test_an_untracked_trait_is_dropped_before_it_is_stored(
        self, make_gene_entry, caplog
    ):
        """The schema admits the `untracked` vocabulary terms so the model
        can name a phenotype the dashboard does not carry, and leaves the
        disposition to a later layer. This is that layer: a term stored in
        gene_gwas_traits publishes as a filter choice the dashboard does not
        have, and the first online run merging COL4A1's ICH-non-lobar would
        have failed tests/data_contract_test.ts. Dropped, and said so."""
        caplog.set_level(logging.INFO)
        data = _build_combined_gene_data(
            [
                make_gene_entry(
                    gene_symbol="COL4A1", gwas_trait=["ICH-non-lobar", "WMH"]
                ),
                make_gene_entry(gene_symbol="COL4A1", gwas_trait=["OD", "WMH"]),
            ]
        )
        assert data["gwas_trait"] == ["WMH"]
        assert "COL4A1" in caplog.text
        assert "ICH-non-lobar" in caplog.text
        assert "OD" in caplog.text

    def test_tracked_traits_are_kept_without_a_log_line(self, make_gene_entry, caplog):
        caplog.set_level(logging.INFO)
        data = _build_combined_gene_data([make_gene_entry(gwas_trait=["WMH", "CMB"])])
        assert data["gwas_trait"] == ["WMH", "CMB"]
        assert "untracked" not in caplog.text

    def test_a_prompt_synonym_is_folded_onto_its_trait(self, make_gene_entry):
        """The prompt asks for `cerebral-microbleeds`; the dashboard stores CMB.

        disease/vocabulary.json records the fold, and the schema admits the
        prompt's spelling so the model can obey the instruction it was
        given. Folded by exact key -- the export's substring rewrites are a
        different tool for curated prose -- and before the tracked filter,
        or the term would be dropped as untracked. Deduped with the target,
        so a paper naming both spellings stores CMB once.
        """
        data = _build_combined_gene_data(
            [
                make_gene_entry(gwas_trait=["cerebral-microbleeds", "WMH"]),
                make_gene_entry(gwas_trait=["CMB"]),
            ]
        )
        assert data["gwas_trait"] == ["CMB", "WMH"]

    def test_mendelian_randomization_yes(self, make_gene_entry):
        entry = make_gene_entry(mendelian_randomization=True)
        data = _build_gene_data(entry)
        assert data["mendelian_randomization"] is True

    def test_mendelian_randomization_no(self, make_gene_entry):
        """Migration 007 made the column BOOLEAN. "" is not a castable
        boolean, so asyncpg would reject it before PostgreSQL saw it."""
        entry = make_gene_entry(mendelian_randomization=False)
        data = _build_gene_data(entry)
        assert data["mendelian_randomization"] is False

    def test_omics_evidence_formatted(self, make_gene_entry):
        entry = make_gene_entry(omics_evidence=["TWAS", "PWAS"])
        data = _build_gene_data(entry)
        assert data["evidence_from_other_omics_studies"] == "TWAS*;PWAS*"

    def test_empty_defaults(self, make_gene_entry):
        entry = make_gene_entry()
        data = _build_gene_data(entry)
        assert data["chromosomal_location"] == ""
        # link_to_monogenetic_disease is absent, not empty: the column went
        # with migration 006 and the extraction never produced OMIM links.
        assert "link_to_monogenetic_disease" not in data
        assert data["brain_cell_types"] == ""
        assert data["affected_pathway"] == ""
        assert data["gwas_trait"] == []


# ---------------------------------------------------------------------------
# merge_gene_entries (async, mocked DB)
# ---------------------------------------------------------------------------


class TestMergeGeneEntries:
    async def test_empty_input(self):
        result = await merge_gene_entries([])
        assert result == {
            "inserted": 0,
            "updated": 0,
            "held_below_insert_floor": [],
        }

    async def test_new_genes_inserted(self, sample_gene_entries, mocker):
        mocker.patch(
            "pipeline.data_merger.get_existing_genes",
            return_value=set(),
        )
        mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(3, 0),
        )
        result = await merge_gene_entries(sample_gene_entries)
        assert result["inserted"] == 3
        assert result["updated"] == 0

    async def test_a_low_confidence_entry_updates_an_existing_gene(
        self, make_gene_entry, mocker
    ):
        """The case this split exists for: BTN3A2 at 0.50 was correct.

        Adding a reference to a gene already in the table is cheap,
        reversible and visible in `git diff data/`, so it answers to the
        permissive floor. BTN3A2 scored 0.50, the single 0.65 gate rejected
        it, and independent digit recovery later confirmed the PMID it
        proposed was one of that gene's two curated references.
        """
        mocker.patch(
            "pipeline.data_merger.get_existing_genes", return_value={"NOTCH3"}
        )
        transactional = mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(0, 1),
        )
        entry = make_gene_entry(gene_symbol="NOTCH3", confidence=0.50)

        result = await merge_gene_entries([entry])

        assert (result["inserted"], result["updated"]) == (0, 1)
        to_insert, to_update = transactional.call_args[0]
        assert len(to_update) == 1
        assert to_insert == []

    async def test_a_low_confidence_update_carries_no_causal_claim(
        self, make_gene_entry, mocker, caplog
    ):
        """Below the insert floor an entry buys a citation, not a claim.

        The permissive floor is justified by the cheapness of adding a
        reference, but `mendelian_randomization` is OR-accumulated and the
        trait and omics lists are append-only, so a 0.50 extraction was
        asserting all three irreversibly. The PMID and the quote that
        describes it still land -- the quote publishes its own score.
        """
        import logging

        caplog.set_level(logging.INFO)
        mocker.patch(
            "pipeline.data_merger.get_existing_genes", return_value={"NOTCH3"}
        )
        transactional = mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(0, 1),
        )
        entry = make_gene_entry(
            gene_symbol="NOTCH3",
            confidence=0.50,
            mendelian_randomization=True,
            gwas_trait=["WMH"],
            omics_evidence=["TWAS"],
        )

        await merge_gene_entries([entry])

        (_, to_update) = transactional.call_args[0]
        (row,) = to_update
        assert row["mendelian_randomization"] is False
        assert row["gwas_trait"] == []
        assert row["evidence_from_other_omics_studies"] == ""
        # What the floor's own rationale licenses still lands.
        assert row["references"] == ["12345678"]
        assert row["confidence"] == 0.50
        assert row["source_quote"] == entry.source_quote
        assert "citation only" in caplog.text

    async def test_a_confident_update_still_carries_its_claims(
        self, make_gene_entry, mocker
    ):
        """The withholding is the sub-floor case, not every update."""
        mocker.patch(
            "pipeline.data_merger.get_existing_genes", return_value={"NOTCH3"}
        )
        transactional = mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(0, 1),
        )
        entry = make_gene_entry(
            gene_symbol="NOTCH3",
            confidence=0.80,
            mendelian_randomization=True,
            gwas_trait=["WMH"],
            omics_evidence=["TWAS"],
        )

        await merge_gene_entries([entry])

        (_, to_update) = transactional.call_args[0]
        (row,) = to_update
        assert row["mendelian_randomization"] is True
        assert row["gwas_trait"] == ["WMH"]
        assert row["evidence_from_other_omics_studies"] == "TWAS*"

    async def test_a_low_confidence_entry_does_not_create_a_new_gene(
        self, make_gene_entry, mocker, caplog
    ):
        """The same score on an unknown gene creates nothing.

        A new row is a scientific claim in a published dataset, so it
        answers to the strict floor -- and it is held at the merge, which
        is the first point that knows the gene is new. The upstream gate
        passed it on purpose.
        """
        import logging

        caplog.set_level(logging.INFO)
        mocker.patch(
            "pipeline.data_merger.get_existing_genes", return_value=set()
        )
        transactional = mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(0, 0),
        )
        entry = make_gene_entry(gene_symbol="BTN3A2", confidence=0.50)

        result = await merge_gene_entries([entry])

        assert (result["inserted"], result["updated"]) == (0, 0)
        assert transactional.call_args[0] == ([], [])
        assert "held below the 0.65 insert floor: BTN3A2" in caplog.text
        # Returned, not merely logged: this loss is counted nowhere else,
        # so the run's acceptance rate overstated by exactly these genes
        # until the merge started reporting them.
        assert result.get("held_below_insert_floor") == [
            {"gene_symbol": "BTN3A2", "confidence": 0.50}
        ]

    async def test_a_confident_new_gene_is_still_inserted(
        self, make_gene_entry, mocker
    ):
        """The strict floor must gate, not block."""
        mocker.patch(
            "pipeline.data_merger.get_existing_genes", return_value=set()
        )
        mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(1, 0),
        )
        entry = make_gene_entry(gene_symbol="BTN3A2", confidence=0.80)

        result = await merge_gene_entries([entry])

        assert (result["inserted"], result["updated"]) == (1, 0)

    async def test_the_insert_floor_reads_the_best_score_in_the_group(
        self, make_gene_entry, mocker
    ):
        """One gene can arrive from several papers in one batch.

        Grouping happens before the floor, so the decision is made on the
        strongest evidence in the batch rather than on whichever entry
        happened to be first.
        """
        mocker.patch(
            "pipeline.data_merger.get_existing_genes", return_value=set()
        )
        mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(1, 0),
        )
        weak = make_gene_entry(gene_symbol="BTN3A2", confidence=0.50, pmid="1")
        strong = make_gene_entry(gene_symbol="BTN3A2", confidence=0.90, pmid="2")

        result = await merge_gene_entries([weak, strong])

        assert result["inserted"] == 1

    async def test_the_inserted_row_carries_the_score_that_admitted_it(
        self, make_gene_entry, mocker
    ):
        """What reaches the database, not just how many rows do.

        The floor read 0.90 and the row written read 0.50, so a reviewer
        comparing data/table1.json against the insert floor in the run
        report saw a row the stated policy should have held.
        """
        mocker.patch("pipeline.data_merger.get_existing_genes", return_value=set())
        merge = mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(1, 0),
        )
        weak = make_gene_entry(
            gene_symbol="BTN3A2",
            confidence=0.50,
            pmid="1",
            source_quote="The weaker paper's BTN3A2 sentence.",
        )
        strong = make_gene_entry(
            gene_symbol="BTN3A2",
            confidence=0.90,
            pmid="2",
            source_quote="The deciding paper's BTN3A2 sentence.",
        )

        await merge_gene_entries([weak, strong])

        (to_insert, _to_update) = merge.call_args.args
        assert to_insert[0]["confidence"] == 0.90
        assert to_insert[0]["source_quote"] == "The deciding paper's BTN3A2 sentence."

    async def test_existing_genes_updated(self, sample_gene_entries, mocker):
        mocker.patch(
            "pipeline.data_merger.get_existing_genes",
            return_value={"NOTCH3", "HTRA1", "COL4A1"},
        )
        mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(0, 3),
        )
        result = await merge_gene_entries(sample_gene_entries)
        assert result["inserted"] == 0
        assert result["updated"] == 3

    async def test_mix_insert_and_update(self, sample_gene_entries, mocker):
        mocker.patch(
            "pipeline.data_merger.get_existing_genes",
            return_value={"NOTCH3"},
        )
        mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(2, 1),
        )
        result = await merge_gene_entries(sample_gene_entries)
        assert result["inserted"] == 2
        assert result["updated"] == 1

    async def test_deduplicates_within_batch(self, make_gene_entry, mocker):
        """Entries with same gene symbol are merged into a single DB row.

        This prevents data loss that would otherwise occur if the two entries
        raced as INSERT then UPDATE, where the UPDATE would overwrite the
        first entry's gwas_trait/omics with the second's values.
        """
        entries = [
            make_gene_entry(
                gene_symbol="NOTCH3",
                pmid="111",
                gwas_trait=["WMH"],
                omics_evidence=["TWAS"],
                source_quote="First paper's NOTCH3 quote.",
                confidence=0.60,
            ),
            make_gene_entry(
                gene_symbol="NOTCH3",
                pmid="222",
                gwas_trait=["SVS"],
                omics_evidence=["PWAS"],
                source_quote="Second paper's NOTCH3 quote.",
                confidence=0.95,
            ),
        ]
        mocker.patch(
            "pipeline.data_merger.get_existing_genes",
            return_value=set(),
        )
        mock_merge = mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(1, 0),
        )
        await merge_gene_entries(entries)
        # Both NOTCH3 entries collapse into a single insert row whose fields
        # are the union of the per-entry values.
        call_args = mock_merge.call_args
        to_insert = call_args[0][0]
        to_update = call_args[0][1]
        assert len(to_insert) == 1
        assert len(to_update) == 0
        merged = to_insert[0]
        assert merged["gene"] == "NOTCH3"
        assert "WMH" in merged["gwas_trait"]
        assert "SVS" in merged["gwas_trait"]
        assert "TWAS*" in merged["evidence_from_other_omics_studies"]
        assert "PWAS*" in merged["evidence_from_other_omics_studies"]
        assert "111" in merged["references"]
        assert "222" in merged["references"]
        # source_quote and confidence come from the entry the insert floor
        # was decided on -- the 0.95 one -- and travel together.
        assert merged["source_quote"] == "Second paper's NOTCH3 quote."
        assert merged["confidence"] == 0.95


class TestCanonicalGeneSymbol:
    """The curated dataset combines the COL4A1/COL4A2 pair under one key.

    An extraction names whichever chain its paper discusses, so without this
    a run adds "COL4A1" as a new gene beside the curated "COL4A1/2" row --
    genes.gene is UNIQUE, so nothing collapses them and the published table
    gains a duplicate. That is exactly what the first live run did, from
    PMID 42437605.
    """

    def test_both_chains_map_to_the_curated_key(self):
        assert canonical_gene_symbol("COL4A1") == "COL4A1/2"
        assert canonical_gene_symbol("COL4A2") == "COL4A1/2"

    def test_matching_ignores_case_and_surrounding_space(self):
        assert canonical_gene_symbol(" col4a1 ") == "COL4A1/2"

    def test_the_curated_key_is_stable_under_a_second_pass(self):
        assert canonical_gene_symbol("COL4A1/2") == "COL4A1/2"

    def test_every_other_symbol_is_returned_untouched(self):
        """A no-op for all but the one pair the curators combine, so this
        cannot quietly rewrite the other 63 genes."""
        for symbol in ("NOTCH3", "HTRA1", "LAMB1", "COL4A3", "COL6A1"):
            assert canonical_gene_symbol(symbol) == symbol

    def test_an_obsolete_curated_symbol_keeps_its_row(self):
        """NCBI answers C6orf195 under its current name, LINC01600.

        Validation rewrites the extracted symbol to NCBI's official one, so
        without this map the merge saw LINC01600, found no such curated
        gene, and inserted a 64th row beside C6orf195 -- the COL4A1 bug in
        a second form.
        """
        assert canonical_gene_symbol("LINC01600") == "C6orf195"
        assert canonical_gene_symbol("linc01600") == "C6orf195"

    def test_every_renamed_curated_gene_has_a_map_entry(self):
        """A curated symbol NCBI files under another name needs a map entry.

        data/gene_info.json keeps the curated symbol as `name` and NCBI's
        alias list beside it. NCBI never lists a record's own symbol among
        its aliases, so a curated symbol that appears in its own row's
        `otheraliases` is one NCBI has renamed -- exactly the case
        validation rewrites, and the next paper naming it would insert a
        duplicate row unless the current name maps back here. Read from the
        committed file so the next rename fails a test instead of shipping.
        """
        root = Path(__file__).resolve().parents[2]
        with (root / "data" / "gene_info.json").open(encoding="utf-8") as handle:
            rows = json.load(handle)
        renamed = [
            row["name"]
            for row in rows
            if row.get("otheraliases")
            and row["name"] in {a.strip() for a in row["otheraliases"].split(",")}
        ]
        assert "C6orf195" in renamed, "the committed data no longer shows the case"
        for curated in renamed:
            assert curated in _CANONICAL_GENE_SYMBOLS.values(), (
                f"NCBI files curated {curated} under another symbol; map that "
                "symbol back in _CANONICAL_GENE_SYMBOLS or the merge inserts a "
                "duplicate row"
            )

    def test_the_stored_row_carries_the_curated_key(self, make_gene_entry):
        data = _build_combined_gene_data([make_gene_entry(gene_symbol="COL4A1")])
        assert data["gene"] == "COL4A1/2"

    async def test_both_chains_in_one_batch_collapse_into_one_row(
        self, make_gene_entry, mocker
    ):
        """Grouping happens on the curated key, so COL4A1 and COL4A2 arriving
        together merge into one row instead of colliding on genes.gene's
        UNIQUE constraint.

        Asserts the arguments actually handed to merge_genes_transactional,
        not a mocked return value -- the routing is the behaviour under test.
        """
        mocker.patch(
            "pipeline.data_merger.get_existing_genes",
            return_value={"COL4A1/2"},
        )
        merge = mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(0, 1),
        )

        await merge_gene_entries(
            [
                make_gene_entry(gene_symbol="COL4A1", pmid="11111111"),
                make_gene_entry(gene_symbol="COL4A2", pmid="22222222"),
            ]
        )

        to_insert, to_update = merge.call_args[0]
        assert to_insert == []
        assert len(to_update) == 1
        assert to_update[0]["gene"] == "COL4A1/2"
        # Both papers survive the collapse rather than one overwriting the other.
        assert to_update[0]["references"] == ["11111111", "22222222"]

    async def test_a_new_chain_does_not_create_a_second_row(
        self, make_gene_entry, mocker
    ):
        """The bug as it actually happened: COL4A1/2 already exists, a paper
        names COL4A1, and the run inserted a 64th gene beside it."""
        mocker.patch(
            "pipeline.data_merger.get_existing_genes",
            return_value={"COL4A1/2"},
        )
        merge = mocker.patch(
            "pipeline.data_merger.merge_genes_transactional",
            return_value=(0, 1),
        )

        await merge_gene_entries([make_gene_entry(gene_symbol="COL4A1")])

        to_insert, to_update = merge.call_args[0]
        assert to_insert == []
        assert [row["gene"] for row in to_update] == ["COL4A1/2"]
