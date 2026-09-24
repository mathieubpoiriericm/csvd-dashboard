"""Unit tests for scripts/reconcile_omim.py.

`testpaths` is `["tests/pipeline"]`, so nothing collects this file -- in CI
either -- unless it is named: `uv run pytest tests/scripts`.
"""

import json
from pathlib import Path

from scripts.reconcile_omim import (
    Disagreement,
    curated_omim_ids,
    fetched_omim_ids,
    main,
    reconcile,
)

_TABLE1 = [
    {"gene": "HTRA1", "linkToMonogenicDisease": ["600142", "616779"]},
    {"gene": "LAMB1", "linkToMonogenicDisease": ["(none found)"]},
    {"gene": "LOX", "linkToMonogenicDisease": ["617168"]},
    # The curated column is free text, not an identifier field: the export
    # mines it with the same six-digit regex this script uses.
    {"gene": "VCAN", "linkToMonogenicDisease": ["Wagner syndrome (MIM 143200)"]},
    {"gene": "NBEAL1"},
]

_ANNOTATIONS = [
    {"geneSymbol": "HTRA1", "groupKey": "MONDO:0010829", "omimId": "600142"},
    {"geneSymbol": "HTRA1", "groupKey": "MONDO:0014768", "omimId": "616779"},
    {"geneSymbol": "LAMB1", "groupKey": "MONDO:0014369", "omimId": "615191"},
    # A disease ClinVar names with no OMIM number at all.
    {"geneSymbol": "CST6", "groupKey": "MONDO:0000001", "omimId": None},
]


class TestCuratedOmimIds:
    def test_mines_six_digit_numbers_out_of_prose(self) -> None:
        found = curated_omim_ids(_TABLE1)
        assert found["VCAN"] == {"143200"}

    def test_the_sentinel_contributes_nothing(self) -> None:
        assert curated_omim_ids(_TABLE1)["LAMB1"] == set()

    def test_a_row_with_no_column_at_all_is_empty_not_missing(self) -> None:
        found = curated_omim_ids(_TABLE1)
        assert found["NBEAL1"] == set()

    def test_every_gene_is_represented(self) -> None:
        assert set(curated_omim_ids(_TABLE1)) == {
            "HTRA1",
            "LAMB1",
            "LOX",
            "VCAN",
            "NBEAL1",
        }


class TestFetchedOmimIds:
    def test_collects_every_disease_row_for_a_gene(self) -> None:
        assert fetched_omim_ids(_ANNOTATIONS)["HTRA1"] == {"600142", "616779"}

    def test_a_disease_with_no_omim_number_leaves_the_gene_present_but_empty(
        self,
    ) -> None:
        """A gene ClinVar answered about is not a gene never fetched."""
        found = fetched_omim_ids(_ANNOTATIONS)
        assert found["CST6"] == set()


class TestReconcile:
    def test_agreement_is_reported_as_nothing(self) -> None:
        curated_only, fetched_only, differing = reconcile(
            {"HTRA1": {"600142"}}, {"HTRA1": {"600142"}}
        )
        assert (curated_only, fetched_only, differing) == ([], [], [])

    def test_the_three_classes_are_separated(self) -> None:
        curated_only, fetched_only, differing = reconcile(
            curated_omim_ids(_TABLE1), fetched_omim_ids(_ANNOTATIONS)
        )

        assert [row.gene for row in curated_only] == ["LOX", "VCAN"]
        assert [row.gene for row in fetched_only] == ["LAMB1"]
        assert differing == []

    def test_a_true_disagreement_is_its_own_class(self) -> None:
        _, _, differing = reconcile(
            {"ADAMTSL4": {"225100"}}, {"ADAMTSL4": {"225100", "225200"}}
        )
        assert differing == [
            Disagreement("ADAMTSL4", ("225100",), ("225100", "225200"))
        ]

    def test_output_is_sorted_so_two_runs_read_the_same(self) -> None:
        curated_only, _, _ = reconcile(
            {"ZZZ": {"1"}, "AAA": {"2"}}, {}
        )
        assert [row.gene for row in curated_only] == ["AAA", "ZZZ"]


class TestMain:
    def test_prints_every_section_and_writes_nothing(
        self, tmp_path: Path, capsys
    ) -> None:
        table1 = tmp_path / "table1.json"
        table1.write_text(json.dumps(_TABLE1))
        annotations = tmp_path / "gene_annotations.json"
        annotations.write_text(json.dumps(_ANNOTATIONS))
        before = sorted(p.name for p in tmp_path.iterdir())

        code = main(["--table1", str(table1), "--annotations", str(annotations)])

        assert code == 0
        out = capsys.readouterr().out
        assert "Curated only (2)" in out
        assert "Fetched only (1)" in out
        assert "Differing (0)" in out
        assert "(none)" in out  # the empty Differing section
        assert "Nothing was written" in out
        assert sorted(p.name for p in tmp_path.iterdir()) == before

    def test_reports_against_the_committed_files_by_default(self, capsys) -> None:
        """The defaults resolve, so the documented invocation works."""
        assert main([]) == 0
        assert "OMIM reconciliation" in capsys.readouterr().out
