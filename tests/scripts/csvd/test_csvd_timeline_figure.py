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

import scripts.timeline_figure as tf  # noqa: E402
from scripts.timeline_figure import (  # noqa: E402
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

EMPTY_CELLS = [
    ("CAA", "IV"),
    ("CAA", "II/III"),
    ("CAA", "I"),
    ("CAA", "(unknown)"),
    ("Cognitive Impairment", "I/II"),
    ("Stroke", "I"),
    # SVD/III emptied when the three arms of NCT03082014 -- amlodipine,
    # losartan and atenolol, all TERMINATED -- stopped being published.
    ("SVD", "III"),
    ("SVD", "II/III"),
    ("SVD", "I/II"),
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
        assert [s.drug_count for s in sectors] == [8, 32, 14, 23]
        assert sectors[0].start_deg == 0
        # 77 unique drugs over the four populations; CAA holds 8 of them.
        assert sectors[0].end_deg == pytest.approx(8 / 77 * 360)
        assert sectors[2].end_deg - sectors[2].start_deg == pytest.approx(
            14 / 77 * 360
        )
        assert sectors[-1].end_deg == pytest.approx(360)

    def test_every_cell_with_the_expected_empties(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        cell_list = cells(trials, encoding, sectors)
        # Four populations over seven rings; nine are empty, because only
        # eight trials are registered as seamless.
        assert len(cell_list) == 28
        assert [(c.population, c.phase) for c in cell_list if not c.filled] == (
            EMPTY_CELLS
        )

    def test_every_marker_is_drawn(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        marker_list = markers(trials, encoding, sectors)
        assert len(marker_list) == 102
        assert [m.index for m in marker_list] == list(range(102))

    def test_genetics_assessed_is_a_ring_and_a_bare_default_is_not(
        self, trials, encoding
    ) -> None:
        """The same split tests/csvd/timeline_layout_test.ts pins for the island."""
        sectors = sector_spans(trials, encoding)
        marker_list = markers(trials, encoding, sectors)
        states = [m.evidence_state for m in marker_list]
        assert states.count("supported") == 12
        assert states.count("unsupported") == 9
        assert states.count("unassessed") == 81
        assert sum(1 for m in marker_list if m.evidence_ring) == 21
        assert sum(1 for m in marker_list if m.evidence_dash) == 9

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
        # The SVD trials the registry states no phase for. This was the pair
        # of stroke trials until one of them, NCT03783754, was published as
        # TERMINATED and stopped being drawn.
        shared = [
            m
            for m in markers(trials, encoding, sectors)
            if m.population == "SVD" and m.phase == "(unknown)"
        ]
        assert len(shared) == 7
        # Twice 18 % of the unknown-phase ring's thickness (0.15 of radius
        # 100, which the two seamless rings deliberately did not narrow).
        assert shared[1].r - shared[0].r == pytest.approx(2 * 0.18 * 15)


class TestRender:
    def test_svg_carries_every_marker_and_label_and_both_legends(
        self, trials, encoding, tmp_path: Path
    ) -> None:
        fig = draw(trials, encoding)
        target = tmp_path / "timeline.svg"
        fig.savefig(target, format="svg", bbox_inches="tight")
        svg = target.read_text(encoding="utf-8")
        assert svg.count('id="marker-') == 102
        assert svg.count('id="label-') == 102
        # One band per populated sector; one ring per trial whose genetics
        # somebody assessed, and one hollow centre per flagged record.
        assert svg.count('id="band-') == 4
        assert svg.count('id="ring-') == 21
        assert svg.count('id="gap-') == 16
        # A leader line per label the separation pass moved further than its
        # own height. How many that is depends on the rendered text metrics,
        # so it is bounded rather than pinned -- but it is never none, because
        # the placement pass has to move labels to clear this figure at all.
        leaders = svg.count('id="leader-')
        assert 0 < leaders <= 102
        assert "Any SVD" in svg
        # Text stays text: no glyph outlines in place of the drug names.
        assert "Cilostazol" in svg

    def test_main_draws_the_committed_figure(self, tmp_path: Path) -> None:
        code = main(["--out", str(tmp_path), "--format", "svg", "pdf", "--dpi", "72"])
        assert code == 0
        assert (tmp_path / "timeline.svg").stat().st_size > 0
        assert (tmp_path / "timeline.pdf").stat().st_size > 0
        assert not (tmp_path / "timeline.png").exists()
