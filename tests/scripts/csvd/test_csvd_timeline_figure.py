"""The cSVD figure, pinned: sector counts, empty cells, ring and flag tallies.

The layout numbers here are the same ones tests/csvd/timeline_layout_test.ts
pins for lib/timeline.ts over the committed cSVD trials. The geometry and
rule tests that hold for any dataset are in tests/scripts/test_timeline_figure.py;
a fork deletes this tree.
"""

from collections import Counter
from pathlib import Path

import pytest

pytest.importorskip("pycirclize")

import scripts.timeline_figure as tf
from scripts.timeline_figure import (
    DEFAULT_ENCODING,
    DEFAULT_TRIALS,
    cells,
    draw,
    load_encoding,
    load_trials,
    main,
    markers,
    sector_spans,
)

from pipeline.gold_only import gold_only

# `GOLD_ONLY` as lib/gold_only.ts sets it, so the skip below lifts with it.
_GOLD_ONLY = gold_only()

# The gold trials fill seven cells: CAA/II, Cognitive Impairment/III and II,
# Stroke/III and II, SVD/II and I (THN391's "Ib", on its parent's ring).
EMPTY_CELLS = [
    ("CAA", "IV"),
    ("CAA", "III"),
    ("CAA", "II/III"),
    ("CAA", "I/II"),
    ("CAA", "I"),
    ("CAA", "(unknown)"),
    ("Cognitive Impairment", "IV"),
    ("Cognitive Impairment", "II/III"),
    ("Cognitive Impairment", "I/II"),
    ("Cognitive Impairment", "I"),
    ("Cognitive Impairment", "(unknown)"),
    ("Stroke", "IV"),
    ("Stroke", "II/III"),
    ("Stroke", "I/II"),
    ("Stroke", "I"),
    ("Stroke", "(unknown)"),
    ("SVD", "IV"),
    ("SVD", "III"),
    ("SVD", "II/III"),
    ("SVD", "I/II"),
    ("SVD", "(unknown)"),
]


@pytest.fixture(scope="module")
def trials() -> list[dict[str, str]]:
    return load_trials(DEFAULT_TRIALS)


@pytest.fixture(scope="module")
def encoding() -> dict:
    return load_encoding(DEFAULT_ENCODING)


class TestLayout:
    def test_sector_spans_follow_unique_drug_counts(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        assert [s.key for s in sectors] == [
            "CAA",
            "Cognitive Impairment",
            "Stroke",
            "SVD",
        ]
        assert [s.drug_count for s in sectors] == [3, 2, 4, 3]
        assert sectors[0].start_deg == 0
        # 12 unique drugs over the four populations; CAA holds 3 of them.
        assert sectors[0].end_deg == pytest.approx(3 / 12 * 360)
        assert sectors[2].end_deg - sectors[2].start_deg == pytest.approx(
            4 / 12 * 360
        )
        assert sectors[-1].end_deg == pytest.approx(360)

    def test_every_cell_with_the_expected_empties(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        cell_list = cells(trials, encoding, sectors)
        # Four populations over seven rings; 21 are empty, because the 16
        # gold trials sit in phases II and III, and one in I.
        assert len(cell_list) == 28
        assert [(c.population, c.phase) for c in cell_list if not c.filled] == (
            EMPTY_CELLS
        )

    def test_every_marker_is_drawn(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        marker_list = markers(trials, encoding, sectors)
        assert len(marker_list) == 16
        assert [m.index for m in marker_list] == list(range(16))

    def test_genetics_assessed_is_a_ring_and_a_bare_default_is_not(
        self, trials, encoding
    ) -> None:
        """The same split tests/csvd/timeline_layout_test.ts pins for the island."""
        sectors = sector_spans(trials, encoding)
        marker_list = markers(trials, encoding, sectors)
        states = [m.evidence_state for m in marker_list]
        assert states.count("supported") == 5
        assert states.count("unsupported") == 6
        assert states.count("unassessed") == 5
        assert sum(1 for m in marker_list if m.evidence_ring) == 11
        assert sum(1 for m in marker_list if m.evidence_dash) == 6

    @pytest.mark.skipif(
        _GOLD_ONLY,
        reason=(
            "gold-only: no gold trial is a thin record, so the committed data"
            " cannot exercise the flag; tests/scripts/test_timeline_figure.py"
            " tests its rules on constructed rows"
        ),
    )
    def test_the_record_flag_marks_sixteen_thin_records(
        self, trials, encoding
    ) -> None:
        sectors = sector_spans(trials, encoding)
        marker_list = markers(trials, encoding, sectors)
        flagged = [m for m in marker_list if m.flag_reasons]
        assert len(flagged) == 16
        counts = Counter(r for m in flagged for r in m.flag_reasons)
        assert counts["mechanism-uncharacterised"] == 14
        assert counts["enrolment-unstated"] == 1
        assert counts["completion-unstated"] == 1
        # No committed row earns two reasons at once any more: NCT02467413
        # was the only one, and it is WITHDRAWN. The rules stay independent
        # and can co-occur, which the generic suite pins on a constructed case.
        assert [m.trial["registryId"] for m in flagged if len(m.flag_reasons) > 1] == []

    def test_rim_bands_frame_each_populated_sector(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        bands = tf.rim_bands(sectors, encoding)
        assert [b.population for b in bands] == [
            "CAA",
            "Cognitive Impairment",
            "Stroke",
            "SVD",
        ]
        stroke = [t for t in trials if t["targetPopulation"] == "Stroke"]
        only = tf.rim_bands(sector_spans(stroke, encoding), encoding)
        assert [b.population for b in only] == ["Stroke"]

    def test_shared_cell_markers_differ_in_radius(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        # The six Phase III Stroke trials, the gold table's fullest cell.
        # Before gold-only this was the seven SVD trials with no phase; the
        # gold table states a phase for every trial.
        shared = [
            m
            for m in markers(trials, encoding, sectors)
            if m.population == "Stroke" and m.phase == "III"
        ]
        assert len(shared) == 6
        # Twice 18 % of the Phase III ring's thickness (0.09 of radius 100).
        assert shared[1].r - shared[0].r == pytest.approx(2 * 0.18 * 9)


class TestRender:
    def test_svg_carries_every_marker_and_label_and_both_legends(
        self, trials, encoding, tmp_path: Path
    ) -> None:
        fig = draw(trials, encoding)
        target = tmp_path / "timeline.svg"
        fig.savefig(target, format="svg", bbox_inches="tight")
        svg = target.read_text(encoding="utf-8")
        assert svg.count('id="marker-') == 16
        assert svg.count('id="label-') == 16
        # One band per populated sector; one ring per trial whose genetics
        # somebody assessed, and one hollow centre per flagged record.
        assert svg.count('id="band-') == 4
        assert svg.count('id="ring-') == 11
        # No gold trial is a thin record, so no marker has a hollow centre.
        assert svg.count('id="gap-') == 0
        # A leader line per label the separation pass moved further than its
        # own height. How many that is depends on the rendered text metrics,
        # so it is bounded rather than pinned -- but it is never none, because
        # the placement pass has to move labels to clear this figure at all.
        leaders = svg.count('id="leader-')
        assert 0 < leaders <= 16
        assert "Any SVD" in svg
        # Text stays text: no glyph outlines in place of the drug names.
        assert "Cilostazol" in svg

    def test_main_draws_the_committed_figure(self, tmp_path: Path) -> None:
        code = main(["--out", str(tmp_path), "--format", "svg", "pdf", "--dpi", "72"])
        assert code == 0
        assert (tmp_path / "timeline.svg").stat().st_size > 0
        assert (tmp_path / "timeline.pdf").stat().st_size > 0
        assert not (tmp_path / "timeline.png").exists()
