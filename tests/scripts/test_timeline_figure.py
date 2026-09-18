"""Unit tests for scripts/timeline_figure.py.

The layout numbers pinned here are the same ones tests/timeline_layout_test.ts
pins for lib/timeline.ts: the island and the print figure implement one rule
over one encoding file, and these two suites are what keep them in step.
"""

import re
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
    resolve_evidence_state,
    resolve_record_flag,
    sector_spans,
    separate_labels,
    stagger,
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
        for previous, current in zip(sectors, sectors[1:], strict=False):
            assert current.start_deg == previous.end_deg

    def test_every_cell_with_the_expected_empties(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        cell_list = cells(trials, encoding, sectors)
        # Four populations over seven rings; nine are empty, because only
        # eight trials are registered as seamless.
        assert len(cell_list) == 28
        assert [(c.population, c.phase) for c in cell_list if not c.filled] == (
            EMPTY_CELLS
        )
        colours = {p["key"]: p["color"] for p in encoding["populations"]}
        rings = {r["phase"]: r for r in encoding["rings"]}
        for cell in cell_list:
            expected = colours[cell.population]
            assert cell.color == expected
            if not cell.filled:
                assert cell.opacity == encoding["emptyCell"]["opacity"]
            else:
                assert cell.opacity == rings[cell.phase]["opacity"]
                assert cell.opacity > encoding["emptyCell"]["opacity"], \
                    "a filled cell reads darker than an empty one"

    def test_every_marker_inside_its_cell(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        marker_list = markers(trials, encoding, sectors)
        assert len(marker_list) == 102
        assert [m.index for m in marker_list] == list(range(102))
        rings = {r["phase"]: r for r in encoding["rings"]}
        for marker in marker_list:
            sector = next(s for s in sectors if s.key == marker.population)
            ring = rings[marker.phase]
            assert sector.start_deg < marker.theta_deg < sector.end_deg
            assert ring["innerRadius"] * 100 < marker.r < ring["outerRadius"] * 100
            mechanism = marker.trial["mechanismOfAction"]
            assert marker.color == encoding["mechanisms"][mechanism]
            state = next(
                s
                for s in encoding["evidenceStates"]
                if s["key"] == marker.evidence_state
            )
            assert marker.evidence_ring == state["ring"]
            assert marker.evidence_dash == state["dash"]

    def test_the_loaded_encoding_has_an_unknown_mechanism_colour(
        self, encoding
    ) -> None:
        colour = encoding["unknownMechanism"]
        assert re.fullmatch(r"#[0-9a-f]{6}", colour, re.IGNORECASE)
        assert colour not in encoding["mechanisms"].values()

    def test_genetics_assessed_is_a_ring_and_a_bare_default_is_not(
        self, trials, encoding
    ) -> None:
        """The same split tests/timeline_layout_test.ts pins for the island."""
        sectors = sector_spans(trials, encoding)
        marker_list = markers(trials, encoding, sectors)
        states = [m.evidence_state for m in marker_list]
        assert states.count("supported") == 12
        assert states.count("unsupported") == 9
        assert states.count("unassessed") == 81
        assert sum(1 for m in marker_list if m.evidence_ring) == 21
        assert sum(1 for m in marker_list if m.evidence_dash) == 9
        for marker in marker_list:
            assessed = marker.evidence_state != "unassessed"
            assert (marker.evidence_ring is not None) is assessed

    def test_resolve_evidence_state_separates_a_default_no_from_an_assessed_one(
        self, trials
    ) -> None:
        base = trials[0]
        assert resolve_evidence_state({**base, "geneticEvidence": "Yes"}) == "supported"
        assert (
            resolve_evidence_state(
                {**base, "geneticEvidence": "No", "geneticTarget": "PDE3A"}
            )
            == "unsupported"
        )
        assert (
            resolve_evidence_state(
                {**base, "geneticEvidence": "No", "geneticTarget": "(none)"}
            )
            == "unassessed"
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
        # and can co-occur, which the constructed case below pins.
        assert [m.trial["registryId"] for m in flagged if len(m.flag_reasons) > 1] == []

    def test_record_flag_rules_fire_on_exact_values_and_nothing_near_them(
        self, trials, encoding
    ) -> None:
        clean = {
            **trials[0],
            "mechanismOfAction": "Vasodilator (nitrate)",
            "targetSampleSize": "120",
            "estimatedCompletionDate": "7/2028",
        }
        assert resolve_record_flag(clean, encoding) == ()
        # A stated enrolment of zero is as absent as none at all; one is not.
        assert resolve_record_flag({**clean, "targetSampleSize": "0"}, encoding) == (
            "enrolment-unstated",
        )
        assert resolve_record_flag({**clean, "targetSampleSize": "1"}, encoding) == ()
        assert resolve_record_flag(
            {**clean, "targetSampleSize": "(unknown)"}, encoding
        ) == ("enrolment-unstated",)
        assert resolve_record_flag(
            {**clean, "estimatedCompletionDate": "(unknown)"}, encoding
        ) == ("completion-unstated",)
        # A completed trial is not a thin record, and a phase the registry
        # never stated has a ring of its own.
        past = {**clean, "estimatedCompletionDate": "8/2019"}
        assert resolve_record_flag(past, encoding) == ()
        assert (
            resolve_record_flag({**clean, "clinicalTrialPhase": "(unknown)"}, encoding)
            == ()
        )
        assert resolve_record_flag(
            {
                **clean,
                "mechanismOfAction": (
                    "Multi-component herbal preparation "
                    "(mechanism not characterised)"
                ),
            },
            encoding,
        ) == ("mechanism-uncharacterised",)

    def test_rim_bands_frame_each_populated_sector(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        bands = tf.rim_bands(sectors, encoding)
        assert [b.population for b in bands] == [
            "CAA",
            "Cognitive Impairment",
            "Stroke",
            "SVD",
        ]
        rim = encoding["rimBand"]
        colours = {p["key"]: p["band"] for p in encoding["populations"]}
        for band in bands:
            assert band.inner == pytest.approx(100 * (1 + rim["gap"]))
            assert band.outer == pytest.approx(100 * (1 + rim["gap"] + rim["width"]))
            assert band.color == colours[band.population]

        stroke = [t for t in trials if t["targetPopulation"] == "Stroke"]
        only = tf.rim_bands(sector_spans(stroke, encoding), encoding)
        assert [b.population for b in only] == ["Stroke"]

    def test_population_labels_clear_the_rim_band(self, encoding) -> None:
        rim = encoding["rimBand"]
        assert tf.population_label_radius(encoding) == pytest.approx(
            100 * (1 + rim["gap"] + rim["width"]) + 24 / 416 * 100
        )

    def test_population_label_gap_matches_the_island(self) -> None:
        """The twin of tests/timeline_layout_test.ts's `bandOuter + 24`.

        The island anchors names 24 units beyond the band on a 416-unit outer
        radius; this figure draws on pyCirclize's 100-unit plate. Pinning the
        ratio rather than each side's constant is what makes the two fail
        together when the rule changes -- as it did when the island's radius
        grew from 320 to 416 and its 24-unit gap, being a gap for
        absolutely-sized text, stayed 24.
        """
        assert pytest.approx(
            24 / 416
        ) == tf.POPULATION_LABEL_GAP / tf.PLATE_RADIUS

    def test_stagger_alternates_only_in_shared_cells(self) -> None:
        assert stagger(0, 1, 100) == 0
        assert stagger(0, 2, 100) == pytest.approx(-18)
        assert stagger(1, 2, 100) == pytest.approx(18)
        assert stagger(2, 3, 100) == pytest.approx(-18)

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


class TestSeparateLabels:
    """Same cases as tests/timeline_layout_test.ts, same expected shifts.

    The relaxation pass's four cases keep the numbers they had when a shift
    was a bare dy: each is settled before the placement pass looks at it. What
    moved is the shape around them, which now carries the dx the placement
    pass needs.
    """

    def test_leaves_clear_boxes_alone(self) -> None:
        assert separate_labels([(0, 0, 50, 20), (0, 30, 50, 20), (100, 5, 50, 20)]) == [
            (0, 0),
            (0, 0),
            (0, 0),
        ]
        # Nothing to place: the median height the placement grid is built from
        # does not exist for an empty figure, so the pass has to be skipped.
        assert separate_labels([]) == []

    def test_splits_an_overlap_lower_box_down(self) -> None:
        assert separate_labels([(0, 10, 50, 20), (20, 0, 50, 20)], gap=2) == [
            (0, 6),
            (0, -6),
        ]

    def test_resolves_a_tie_by_index(self) -> None:
        assert separate_labels([(0, 0, 40, 10), (0, 0, 40, 10)], gap=2) == [
            (0, -6),
            (0, 6),
        ]

    def test_moves_clear_of_a_fixed_box(self) -> None:
        shifts = separate_labels(
            [(10, 20, 40, 20), (10, -15, 40, 20)], fixed=[(0, 0, 100, 30)], gap=2
        )
        assert shifts == [(0, 12), (0, -7)]

    def test_displaces_along_outward_when_the_vertical_is_walled_in(self) -> None:
        """Twin of the island's placement case, box for box and number for number.

        A corridor 20 units tall holds one 10-unit box; three are stacked in
        it. Relaxation splits them into the walls and stops, which is the
        deadlock the committed figure hits against its markers, so the
        placement pass moves the two that cannot stay put out along their own
        outward vector.
        """
        boxes = [(0, 0, 40, 10)] * 3
        walls = [(-50, -500, 80, 495), (-50, 15, 80, 500)]
        outward = [(1.0, 0.0)] * 3
        assert separate_labels(boxes, walls, gap=2, outward=outward) == [
            (0, 0),
            (30, 12.5),
            (30, -12.5),
        ]
        # The same boxes with nowhere to go: no dx, and still stacked.
        assert separate_labels(boxes, walls, gap=2) == [(0, 0), (0, -3), (0, 3)]

    def test_reaches_an_opening_at_the_far_end_of_each_axis(self) -> None:
        """Twin of the island's reach case, and why it exists.

        The case above pins only the two step sizes -- 12.5 is five vertical
        steps and 30 is six radial ones -- so either reach could be halved
        with it still green. Each box here is 20 tall, so relaxation shoves it
        22 a pass and runs out at 264 after its twelve, short of both
        openings, and the placement pass is what has to find them.
        """
        box = (0, 0, 40, 20)
        outward = [(1.0, 0.0)]

        # A wall 540 tall and wider than the radial reach: the only way out is
        # vertical, at 270 = 13.5 box heights. PLACEMENT_REACH of 13 falls
        # back to relaxation's 264, 14 finds it.
        assert separate_labels(
            [box], [(-50, -270, 1050, 540)], gap=2, outward=outward
        ) == [(0, 270)]

        # A wall 800 tall and 200 wide: taller than the vertical reach, so the
        # only way out is radial, at 150 = 7.5 box heights. RADIAL_REACH of 7
        # falls back to relaxation's 264, 8 finds it -- and the 150 is 15
        # radial steps, so a coarser RADIAL_STEP overshoots to 160.
        assert separate_labels(
            [box], [(-50, -400, 200, 800)], gap=2, outward=outward
        ) == [(150, 0)]


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
        assert "Genetic evidence" in svg
        assert "Record completeness" in svg
        assert "Mechanism of action" in svg
        assert "Any SVD" in svg
        # Text stays text: no glyph outlines in place of the drug names.
        assert "Cilostazol" in svg

    def test_main_writes_the_requested_formats(self, tmp_path: Path) -> None:
        code = main(["--out", str(tmp_path), "--format", "svg", "pdf", "--dpi", "72"])
        assert code == 0
        assert (tmp_path / "timeline.svg").stat().st_size > 0
        assert (tmp_path / "timeline.pdf").stat().st_size > 0
        assert not (tmp_path / "timeline.png").exists()
