"""Unit tests for scripts/timeline_figure.py.

The rules pinned here are the same ones tests/timeline_layout_test.ts pins
for lib/timeline.ts: the island and the print figure implement one rule over
one encoding file, and these two suites are what keep them in step. Every
test holds for any dataset -- the committed rows are only ever looped over,
and the constructed cases build their rows from the encoding. The cSVD
figure's own counts are pinned in tests/scripts/csvd/.
"""

import json
import re
from pathlib import Path
from typing import Any

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


@pytest.fixture(scope="module")
def trials() -> list[dict[str, str]]:
    return load_trials(DEFAULT_TRIALS)


@pytest.fixture(scope="module")
def encoding() -> dict:
    return load_encoding(DEFAULT_ENCODING)


def _trial(encoding: dict, **overrides: Any) -> dict[str, str]:
    """A trial row every rule accepts, built from the encoding's own keys."""
    row = {
        "drug": "Drug A",
        "mechanismOfAction": next(iter(encoding["mechanisms"])),
        "geneticTarget": "(none)",
        "geneticEvidence": "No",
        "trialName": "Trial A",
        "registryId": "NCT00000001",
        "clinicalTrialPhase": encoding["rings"][0]["phase"],
        "targetPopulation": encoding["populations"][0]["key"],
        "targetPopulationDetails": "(unknown)",
        "targetSampleSize": "120",
        "estimatedCompletionDate": "7/2028",
        "primaryOutcome": "(unknown)",
        "sponsorType": "Academic",
        "overallStatus": "RECRUITING",
    }
    row.update(overrides)
    return row


class TestLayout:
    def test_sector_spans_tile_the_circle_in_population_order(
        self, trials, encoding
    ) -> None:
        sectors = sector_spans(trials, encoding)
        assert [s.key for s in sectors] == [p["key"] for p in encoding["populations"]]
        assert sectors[0].start_deg == 0
        for previous, current in zip(sectors, sectors[1:], strict=False):
            assert current.start_deg == previous.end_deg
        if any(s.drug_count for s in sectors):
            assert sectors[-1].end_deg == pytest.approx(360)

    def test_every_cell_takes_its_population_colour_and_ring_opacity(
        self, trials, encoding
    ) -> None:
        sectors = sector_spans(trials, encoding)
        cell_list = cells(trials, encoding, sectors)
        assert len(cell_list) == len(encoding["populations"]) * len(encoding["rings"])
        colours = {p["key"]: p["color"] for p in encoding["populations"]}
        rings = {r["phase"]: r for r in encoding["rings"]}
        for cell in cell_list:
            assert cell.color == colours[cell.population]
            if not cell.filled:
                assert cell.opacity == encoding["emptyCell"]["opacity"]
            else:
                assert cell.opacity == rings[cell.phase]["opacity"]
                assert cell.opacity > encoding["emptyCell"]["opacity"], (
                    "a filled cell reads darker than an empty one"
                )

    def test_every_marker_sits_inside_its_cell(self, trials, encoding) -> None:
        sectors = sector_spans(trials, encoding)
        marker_list = markers(trials, encoding, sectors)
        assert [m.index for m in marker_list] == list(range(len(marker_list)))
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
            assessed = marker.evidence_state != "unassessed"
            assert (marker.evidence_ring is not None) is assessed

    def test_a_constructed_figure_draws_one_marker_per_trial(self, encoding) -> None:
        """Two trials in one cell: two markers, staggered, one populated sector."""
        rows = [
            _trial(encoding, drug="Drug A", registryId="NCT00000001"),
            _trial(encoding, drug="Drug B", registryId="NCT00000002"),
        ]
        sectors = sector_spans(rows, encoding)
        assert [s.drug_count for s in sectors][0] == 2
        assert sum(s.drug_count for s in sectors) == 2
        assert sectors[-1].end_deg == pytest.approx(360)
        marker_list = markers(rows, encoding, sectors)
        assert len(marker_list) == 2
        assert marker_list[0].r != marker_list[1].r
        assert [b.population for b in tf.rim_bands(sectors, encoding)] == [
            encoding["populations"][0]["key"]
        ]

    def test_the_loaded_encoding_has_an_unknown_mechanism_colour(
        self, encoding
    ) -> None:
        colour = encoding["unknownMechanism"]
        assert re.fullmatch(r"#[0-9a-f]{6}", colour, re.IGNORECASE)
        assert colour not in encoding["mechanisms"].values()

    def test_resolve_evidence_state_separates_a_default_no_from_an_assessed_one(
        self, encoding
    ) -> None:
        base = _trial(encoding)
        assert resolve_evidence_state({**base, "geneticEvidence": "Yes"}) == "supported"
        assert (
            resolve_evidence_state(
                {**base, "geneticEvidence": "No", "geneticTarget": "GENE1"}
            )
            == "unsupported"
        )
        assert (
            resolve_evidence_state(
                {**base, "geneticEvidence": "No", "geneticTarget": "(none)"}
            )
            == "unassessed"
        )

    def test_record_flag_rules_fire_on_exact_values_and_nothing_near_them(
        self, encoding
    ) -> None:
        clean = _trial(
            encoding,
            mechanismOfAction="Vasodilator (nitrate)",
            targetSampleSize="120",
            estimatedCompletionDate="7/2028",
        )
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
        # The mechanism rule reads the encoding's `uncharacterised` family,
        # which a disease declares or does not -- so the test brings its own.
        zed = "Zed (mechanism not characterised)"
        families = [f for f in encoding["families"] if f["key"] != "uncharacterised"]
        with_family = {
            **encoding,
            "families": [
                *families,
                {
                    "key": "uncharacterised",
                    "label": "Uncharacterised",
                    "mechanisms": [zed],
                },
            ],
        }
        assert resolve_record_flag({**clean, "mechanismOfAction": zed}, encoding) == ()
        assert resolve_record_flag(
            {**clean, "mechanismOfAction": zed}, with_family
        ) == ("mechanism-uncharacterised",)
        # The rules are independent and can co-occur.
        thin = {
            **clean,
            "targetSampleSize": "(unknown)",
            "estimatedCompletionDate": "(unknown)",
        }
        assert resolve_record_flag(thin, encoding) == (
            "enrolment-unstated",
            "completion-unstated",
        )

    def test_rim_bands_frame_only_the_populated_sectors(
        self, trials, encoding
    ) -> None:
        sectors = sector_spans(trials, encoding)
        bands = tf.rim_bands(sectors, encoding)
        assert [b.population for b in bands] == [
            s.key for s in sectors if s.drug_count > 0
        ]
        rim = encoding["rimBand"]
        colours = {p["key"]: p["band"] for p in encoding["populations"]}
        for band in bands:
            assert band.inner == pytest.approx(100 * (1 + rim["gap"]))
            assert band.outer == pytest.approx(100 * (1 + rim["gap"] + rim["width"]))
            assert band.color == colours[band.population]

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
    def test_svg_carries_a_marker_and_a_label_per_trial_and_both_legends(
        self, encoding, tmp_path: Path
    ) -> None:
        rows = [
            _trial(encoding, drug="Drug A", registryId="NCT00000001"),
            _trial(
                encoding,
                drug="Drug B",
                registryId="NCT00000002",
                geneticEvidence="Yes",
                targetSampleSize="(unknown)",
            ),
        ]
        fig = draw(rows, encoding)
        target = tmp_path / "timeline.svg"
        fig.savefig(target, format="svg", bbox_inches="tight")
        svg = target.read_text(encoding="utf-8")
        assert svg.count('id="marker-') == 2
        assert svg.count('id="label-') == 2
        assert svg.count('id="band-') == 1
        assert svg.count('id="ring-') == 1
        assert svg.count('id="gap-') == 1
        assert "Genetic evidence" in svg
        assert "Record completeness" in svg
        assert "Mechanism of action" in svg
        # Text stays text: no glyph outlines in place of the drug names.
        assert "Drug A" in svg

    def test_main_writes_the_requested_formats(
        self, encoding, tmp_path: Path
    ) -> None:
        rows = tmp_path / "table2.json"
        rows.write_text(json.dumps([_trial(encoding)]), encoding="utf-8")
        out = tmp_path / "fig"
        argv = ["--trials", str(rows), "--out", str(out), "--format", "svg", "pdf"]
        code = main([*argv, "--dpi", "72"])
        assert code == 0
        assert (out / "timeline.svg").stat().st_size > 0
        assert (out / "timeline.pdf").stat().st_size > 0
        assert not (out / "timeline.png").exists()

    def test_main_reports_an_empty_table_and_writes_nothing(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A fork starts from `deno task data:empty`; there is nothing to draw
        and the script says so rather than writing a blank plate."""
        rows = tmp_path / "table2.json"
        rows.write_text("[]\n", encoding="utf-8")
        out = tmp_path / "fig"
        assert main(["--trials", str(rows), "--out", str(out)]) == 0
        assert not out.exists()
        assert "no trial rows" in capsys.readouterr().err
