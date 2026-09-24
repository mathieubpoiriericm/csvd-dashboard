"""Draw the trials radar (population sectors x phase rings) for print.

The dashboard draws the same figure in the browser (islands/TrialsTimeline.tsx
from lib/timeline.ts). Both renderers read lib/timeline_encoding.json for the
rings and chrome and disease/timeline.json for the populations, mechanisms and
families -- together the one place the colours, ring radii and population
order live -- and both apply the same layout rule: sector span proportional to
unique drugs per population,
markers at (j+1)/(m+1) of the sector in table order, radius staggered by 18 %
of the ring thickness, alternating, when a cell holds more than one marker.
Angles are degrees clockwise from 12 o'clock; pyCirclize shares that
convention, so its sectors are sized straight from the drug counts.

Usage:
    uv run --group figure scripts/timeline_figure.py
    uv run --group figure scripts/timeline_figure.py --out figures/ --format svg pdf
    uv run --group figure scripts/timeline_figure.py --font /path/to/Arial.ttf --dpi 600
"""

import argparse
import json
import math
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TRIALS = _PROJECT_ROOT / "data" / "table2.json"
DEFAULT_ENCODING = _PROJECT_ROOT / "lib" / "timeline_encoding.json"
DEFAULT_DISEASE_ENCODING = _PROJECT_ROOT / "disease" / "timeline.json"
DEFAULT_OUT = _PROJECT_ROOT / "figures"
FORMATS = ("svg", "pdf", "png")

# Layout constants shared with lib/timeline.ts.
STAGGER_FRACTION = 0.18
SIDE_THRESHOLD = 0.2
# pyCirclize draws the plate on a 0-100 radius and refuses tracks beyond it,
# so the rim band and the population labels are drawn on the axes instead.
PLATE_RADIUS = 100.0
# Beyond the band's outer edge, in plate units. This is the island's
# POPULATION_LABEL_OFFSET = 24 rescaled from its OUTER_RADIUS = 416 to the
# plate's 100; 8.0 put the printed names 0.5 % of the outer radius further out
# than the web figure's. The offset stayed 24 when the island's radius grew
# from 320 to 416 -- it is a gap for absolutely-sized text, so it is the plate
# it is measured against that moved, not the gap -- and this literal follows,
# from 7.5 to 5.77.
POPULATION_LABEL_GAP = 24 / 416 * PLATE_RADIUS

# Print sizing, in points.
MARKER_AREA_PT2 = 63.0
MARKER_EDGE_PT = 1.2
# The genetic-evidence ring: 1.5× the marker's radius, like the island's.
RING_AREA_PT2 = 142.0
RING_LINEWIDTH_PT = 0.9
# The hollow centre of a flagged marker. Scatter sizes are areas, so the
# encoding's `gapRadius` fraction of the marker radius squares here.
GAP_AREA_PT2 = MARKER_AREA_PT2 * 0.4**2
BOUNDARY_LINEWIDTH_PT = 0.5
BAND_SEPARATOR_PT = 0.9
HALO_LINEWIDTH_PT = 2.0
LABEL_OFFSET_PT = 12.0
NUDGE_PT = 8.0
MAX_NUDGE_PASSES = 3
LABEL_GAP_PT = 2.0
LEADER_LINEWIDTH_PT = 0.5
LEADER_ALPHA = 0.35
# The placement pass in `separate_labels`, twinned with lib/timeline.ts. Its
# search grid is in multiples of the median label height, so the same four
# numbers mean the same thing here, measuring in display pixels, as they do in
# the island, measuring in SVG user units. The derivations below were measured
# on the island, which is where the collision count is observable; the two
# `separate_labels` cases in tests/scripts/test_timeline_figure.py pin each of
# the four from both sides, as their island twins do.
#
# Rounds of the pass. Each re-places every label still caught in an overlap
# against the labels already clear, so a label that moved into somebody else's
# slot gets another turn. Eight is four more than the committed rows need.
PLACEMENT_ROUNDS = 8
# How far apart the vertical offsets tried are -- resolution, not reach. A
# coarser grid overshoots the nearest free slot: 0.5 and 1 both still clear the
# committed figure but leave 59 and 58 labels beyond the leader threshold
# rather than 55, and 0.125 finds the same 55, so this is the coarsest step
# that reaches the minimum.
PLACEMENT_STEP = 0.25
# How far up and down the pass will look, and a cliff rather than a cost: at 12
# and below the committed figure keeps one colliding pair in Cognitive
# Impairment's phase IV ring, the densest cell on the plate, and 13 is the
# first value that clears it. Fourteen is that plus a box-height of headroom
# for the macOS/Linux metric spread.
PLACEMENT_REACH = 14
# How far apart the radial offsets are. Resolution again, and the search is
# greedy, so neither direction is monotone: 1 and 0.25 both clear the figure
# and both leave 56 labels beyond the leader threshold against this value's 55.
RADIAL_STEP = 0.5
# How far out along `outward` the pass will look, and a cliff like
# PLACEMENT_REACH. Five box-heights cleared the figure of label-on-label
# overlaps but left one pair in that same phase IV ring once labels stuck on a
# marker joined the pass. Eight clears both.
RADIAL_REACH = 8
DRUG_FONT_PT = 7.0
POPULATION_FONT_PT = 10.0
PHASE_FONT_PT = 7.0
LEGEND_FONT_PT = 7.5
LEGEND_DOT_PT = 6.5
# Handle box for a _Swatch, in font units: wide and tall enough for a ring at
# 1.5x the dot, which the default one-line box clips.
SWATCH_BOX_EM = 1.6
# Axes-fraction x of the legends: clear of the "Cognitive Impairment" label,
# which sits just outside the band on the right.
LEGEND_X = 1.2
# The dashboard's --svd-figure-ink: the one fixed ink of the plate.
INK = "#14172b"
PLATE = "#ffffff"

# An axis-aligned box: x, y, width, height, in whatever units measured them.
Box = tuple[float, float, float, float]


@dataclass(frozen=True)
class Sector:
    key: str
    label: list[str]
    color: str
    band: str
    start_deg: float
    end_deg: float
    drug_count: int


@dataclass(frozen=True)
class RimBand:
    """The arc just outside the rings that carries a population's hue."""

    population: str
    inner: float
    outer: float
    color: str


@dataclass(frozen=True)
class Cell:
    population: str
    phase: str
    filled: bool
    color: str
    opacity: float


@dataclass(frozen=True)
class Marker:
    index: int
    trial: dict[str, str]
    population: str
    phase: str
    theta_deg: float
    r: float
    color: str
    evidence_state: str
    evidence_ring: str | None
    evidence_dash: str | None
    flag_reasons: tuple[str, ...]
    anchor: str


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------


def load_trials(path: Path = DEFAULT_TRIALS) -> list[dict[str, str]]:
    """Table 2 rows with every string trimmed, as lib/data.ts normalizes them."""
    with path.open(encoding="utf-8") as handle:
        rows = json.load(handle)
    return [
        {
            key: value.strip() if isinstance(value, str) else value
            for key, value in row.items()
        }
        for row in rows
    ]


def load_encoding(
    path: Path = DEFAULT_ENCODING,
    disease: Path = DEFAULT_DISEASE_ENCODING,
) -> dict[str, Any]:
    """Rings and chrome from lib/, populations and mechanisms from disease/."""
    with path.open(encoding="utf-8") as handle:
        encoding = json.load(handle)
    with disease.open(encoding="utf-8") as handle:
        encoding.update(json.load(handle))
    return encoding


# ---------------------------------------------------------------------------
# Layout (twin of lib/timeline.ts)
# ---------------------------------------------------------------------------


def _unique_drug_count(rows: list[dict[str, str]]) -> int:
    return len({row["drug"] for row in rows})


def _rows_for(trials: list[dict[str, str]], population: str) -> list[dict[str, str]]:
    return [row for row in trials if row["targetPopulation"] == population]


def sector_spans(
    trials: list[dict[str, str]], encoding: dict[str, Any]
) -> list[Sector]:
    populations = encoding["populations"]
    counts = [_unique_drug_count(_rows_for(trials, p["key"])) for p in populations]
    total = sum(counts) or 1
    sectors: list[Sector] = []
    cursor = 0.0
    for population, count in zip(populations, counts, strict=True):
        start = cursor
        cursor += count / total * 360
        sectors.append(
            Sector(
                key=population["key"],
                label=list(population["label"]),
                color=population["color"],
                band=population["band"],
                start_deg=start,
                end_deg=cursor,
                drug_count=count,
            )
        )
    return sectors


def stagger(j: int, m: int, ring_thickness: float) -> float:
    """Radial offset for the j-th of m markers in one cell; zero for a lone one."""
    if m < 2:
        return 0.0
    return (-1 if j % 2 == 0 else 1) * STAGGER_FRACTION * ring_thickness


def cells(
    trials: list[dict[str, str]], encoding: dict[str, Any], sectors: list[Sector]
) -> list[Cell]:
    out: list[Cell] = []
    for sector in sectors:
        rows = _rows_for(trials, sector.key)
        for ring in encoding["rings"]:
            filled = any(row["clinicalTrialPhase"] == ring["phase"] for row in rows)
            out.append(
                Cell(
                    population=sector.key,
                    phase=ring["phase"],
                    filled=filled,
                    color=sector.color,
                    opacity=(
                        ring["opacity"] if filled else encoding["emptyCell"]["opacity"]
                    ),
                )
            )
    return out


def rim_bands(sectors: list[Sector], encoding: dict[str, Any]) -> list[RimBand]:
    """One band per populated sector, just outside the rings."""
    rim = encoding["rimBand"]
    inner = PLATE_RADIUS * (1 + rim["gap"])
    outer = inner + PLATE_RADIUS * rim["width"]
    return [
        RimBand(population=s.key, inner=inner, outer=outer, color=s.band)
        for s in sectors
        if s.drug_count > 0
    ]


def population_label_radius(encoding: dict[str, Any]) -> float:
    """Where population names are anchored: clear of the rim band."""
    rim = encoding["rimBand"]
    return PLATE_RADIUS * (1 + rim["gap"] + rim["width"]) + POPULATION_LABEL_GAP


# Reason keys resolve_record_flag can emit, in the order the key lists them.
# The twin of FLAG_REASONS in lib/timeline.ts; the wording lives in the
# encoding, and tests/timeline_encoding_test.ts reconciles the two.
FLAG_REASONS = (
    "mechanism-uncharacterised",
    "enrolment-unstated",
    "completion-unstated",
)


def resolve_evidence_state(trial: dict[str, str]) -> str:
    """What is known about this drug's genetics.

    `geneticEvidence` alone cannot say. The ClinicalTrials.gov sweep that added
    most of the committed rows left `genetic_target` NULL and defaulted
    `genetic_evidence` to "No", so a bare "No" covers both "assessed, nothing
    found" and "never assessed". The target is what separates them: it is the
    column a curator fills in to record that they looked.

    The twin of resolveEvidenceState in lib/timeline.ts.
    """
    if trial["geneticEvidence"] == "Yes":
        return "supported"
    return "unassessed" if trial["geneticTarget"] == "(none)" else "unsupported"


def resolve_record_flag(
    trial: dict[str, str], encoding: dict[str, Any]
) -> tuple[str, ...]:
    """Why this record is too thin to read at face value, or an empty tuple.

    Every rule is exact -- a sentinel, a numeric zero, or membership of the
    encoding's `uncharacterised` family. None is a fuzzy judgement about
    whether a stated value is *right*. The twin of resolveRecordFlag in
    lib/timeline.ts.
    """
    reasons: list[str] = []
    uncharacterised = next(
        (f for f in encoding["families"] if f["key"] == "uncharacterised"), None
    )
    if uncharacterised and trial["mechanismOfAction"] in uncharacterised["mechanisms"]:
        reasons.append("mechanism-uncharacterised")
    size = trial["targetSampleSize"]
    if size == "(unknown)" or (size.lstrip("-").isdigit() and int(size) == 0):
        reasons.append("enrolment-unstated")
    if trial["estimatedCompletionDate"] == "(unknown)":
        reasons.append("completion-unstated")
    return tuple(reasons)


def markers(
    trials: list[dict[str, str]], encoding: dict[str, Any], sectors: list[Sector]
) -> list[Marker]:
    states = {s["key"]: s for s in encoding["evidenceStates"]}
    out: list[Marker] = []
    for sector in sectors:
        rows = _rows_for(trials, sector.key)
        for ring in encoding["rings"]:
            in_cell = [r for r in rows if r["clinicalTrialPhase"] == ring["phase"]]
            thickness = (ring["outerRadius"] - ring["innerRadius"]) * PLATE_RADIUS
            midpoint = (ring["innerRadius"] + ring["outerRadius"]) / 2 * PLATE_RADIUS
            for j, trial in enumerate(in_cell):
                fraction = (j + 1) / (len(in_cell) + 1)
                theta = sector.start_deg + fraction * (
                    sector.end_deg - sector.start_deg
                )
                anchor = "start" if math.sin(math.radians(theta)) >= 0 else "end"
                evidence_state = resolve_evidence_state(trial)
                state = states.get(evidence_state, {})
                out.append(
                    Marker(
                        index=len(out),
                        trial=trial,
                        population=sector.key,
                        phase=ring["phase"],
                        theta_deg=theta,
                        r=midpoint + stagger(j, len(in_cell), thickness),
                        color=encoding["mechanisms"].get(
                            trial["mechanismOfAction"], encoding["unknownMechanism"]
                        ),
                        evidence_state=evidence_state,
                        evidence_ring=state.get("ring"),
                        evidence_dash=state.get("dash"),
                        flag_reasons=resolve_record_flag(trial, encoding),
                        anchor=anchor,
                    )
                )
    return out


def mechanism_order(trials: list[dict[str, str]]) -> list[str]:
    """Mechanisms in first-appearance order, as the island's legend lists them."""
    seen: list[str] = []
    for row in trials:
        if row["mechanismOfAction"] not in seen:
            seen.append(row["mechanismOfAction"])
    return seen


def _overlaps(a: Box, b: Box) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by


def _overlaps_with_gap(a: Box, b: Box, gap: float) -> bool:
    """`a` grown by `gap` on every side still clear of `b`."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return (
        ax - gap < bx + bw
        and ax + aw + gap > bx
        and ay - gap < by + bh
        and ay + ah + gap > by
    )


def _placement_candidates(height: float, outward: bool) -> list[tuple[float, float]]:
    """Offsets to try, nearest first; radial ties lose to vertical ones.

    Twin of `placementCandidates()` in lib/timeline.ts, including the tie
    order: the same cost sorts by radial step, then by distance, then puts the
    positive offset first, so both renderers pick the same slot.
    """
    step = height * PLACEMENT_STEP
    reach = height * PLACEMENT_REACH
    radial_step = height * RADIAL_STEP
    radial_reach = height * RADIAL_REACH if outward else 0.0
    out: list[tuple[float, float]] = []
    radial = 0.0
    while radial <= radial_reach + 1e-9:
        k = 0
        while k * step <= reach + 1e-9:
            for sign in (1, -1) if k else (1,):
                out.append((sign * k * step, radial))
            k += 1
        radial += radial_step
    out.sort(key=lambda c: (abs(c[0]) + c[1], c[1], abs(c[0]), -c[0]))
    return out


def separate_labels(
    movable: Sequence[Box],
    fixed: Sequence[Box] = (),
    gap: float = 2.0,
    max_passes: int = 12,
    outward: Sequence[tuple[float, float]] = (),
) -> list[tuple[float, float]]:
    """Where each label box has to go to come clear, one (dx, dy) per box.

    Twin of `separateLabels()` in lib/timeline.ts. Two passes, and the second
    is why a shift has a dx. The first relaxes the boxes vertically: two
    movable boxes split the overlap between them, the one with the greater y
    moving further that way; a movable box overlapping a `fixed` one moves the
    whole way, away from the fixed box's centre. That deadlocks against the
    markers, which a label may not settle across, so the second pass re-places
    every label still caught in an overlap at the nearest free offset on a
    grid of vertical and radial steps -- radial meaning along that label's own
    `outward` unit vector, empty for callers that have none. Deterministic
    given the input order, so both renderers agree on the same boxes.

    The island hangs `outward` on the box, which is a TypeScript interface; a
    Box here is a plain 4-tuple, so it arrives as a parallel sequence instead.
    The rule is the same.
    """
    shifts = [(0.0, 0.0)] * len(movable)

    def current(i: int) -> Box:
        x, y, width, height = movable[i]
        return (x + shifts[i][0], y + shifts[i][1], width, height)

    def overlap_height(a: Box, b: Box) -> float:
        return min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]) + gap

    def centre_y(box: Box) -> float:
        return box[1] + box[3] / 2

    def push(i: int, dy: float) -> None:
        shifts[i] = (shifts[i][0], shifts[i][1] + dy)

    for _ in range(max_passes):
        moved = False
        for i in range(len(movable)):
            for obstacle in fixed:
                a = current(i)
                if not _overlaps(a, obstacle):
                    continue
                shove = overlap_height(a, obstacle)
                push(i, shove if centre_y(a) >= centre_y(obstacle) else -shove)
                moved = True
            for j in range(i + 1, len(movable)):
                a = current(i)
                b = current(j)
                if not _overlaps(a, b):
                    continue
                half = overlap_height(a, b) / 2
                a_lower = centre_y(a) > centre_y(b)
                push(i, half if a_lower else -half)
                push(j, -half if a_lower else half)
                moved = True
        if not moved:
            break

    if not movable:
        return shifts
    heights = sorted(box[3] for box in movable)
    height = heights[len(heights) // 2]
    candidates = _placement_candidates(height, bool(outward))

    for _ in range(PLACEMENT_ROUNDS):
        boxes = [current(i) for i in range(len(movable))]
        caught: set[int] = set()
        for i in range(len(boxes)):
            # Relaxation gives up after `max_passes`, so a box can be left
            # sitting on an obstacle as well as on a neighbour. Both are
            # overlaps this pass can place its way out of, and a label lying
            # across somebody else's marker is the worse of the two -- it
            # reassigns the marker.
            if any(_overlaps(boxes[i], obstacle) for obstacle in fixed):
                caught.add(i)
            for j in range(i + 1, len(boxes)):
                if _overlaps(boxes[i], boxes[j]):
                    caught.add(i)
                    caught.add(j)
        if not caught:
            break
        settled = [box for i, box in enumerate(boxes) if i not in caught]
        for i in sorted(caught):
            unit = outward[i] if outward else (0.0, 0.0)
            x, y, width, height_i = movable[i]
            for vertical, radial in candidates:
                dx = unit[0] * radial
                dy = vertical + unit[1] * radial
                box = (x + dx, y + dy, width, height_i)
                if any(_overlaps(box, obstacle) for obstacle in fixed):
                    continue
                if any(_overlaps_with_gap(box, other, gap) for other in settled):
                    continue
                shifts[i] = (dx, dy)
                break
            settled.append(current(i))
    return shifts


# ---------------------------------------------------------------------------
# Drawing
# ---------------------------------------------------------------------------


def configure_fonts(font: Path | None) -> None:
    from matplotlib import font_manager, rcParams

    # Text stays text: the SVG is editable in Illustrator/Inkscape and the PDF
    # embeds the face as TrueType rather than Type 3 outlines.
    rcParams["svg.fonttype"] = "none"
    rcParams["pdf.fonttype"] = 42
    rcParams["ps.fonttype"] = 42
    if font is not None:
        font_manager.fontManager.addfont(str(font))
        properties = font_manager.FontProperties(fname=str(font))
        rcParams["font.family"] = properties.get_name()


def _sector_x(marker: Marker, sector: Sector, sector_size: float) -> float:
    """pyCirclize x within a sector for a marker's absolute angle."""
    span = sector.end_deg - sector.start_deg
    return (marker.theta_deg - sector.start_deg) / span * sector_size


def _extent(artist: Any, renderer: Any) -> Box:
    """Display-space box of a text artist, including its rounded background."""
    patch = artist.get_bbox_patch() if hasattr(artist, "get_bbox_patch") else None
    box = (patch or artist).get_window_extent(renderer)
    return (box.x0, box.y0, box.width, box.height)


def _marker_radius_px(marker: Marker, dpi: float) -> float:
    """How far a marker reaches on the canvas: its evidence ring when it has one."""
    area = RING_AREA_PT2 if marker.evidence_ring else MARKER_AREA_PT2
    return math.sqrt(area) / 2 * dpi / 72


def _nudge_labels(fig: Any, ax: Any, placed: list[tuple[Marker, float, Any]]) -> None:
    """Push any label whose fitted box still touches its marker outward, radially.

    The print twin of the island's nudge pass: matplotlib measures the rendered
    text, and the annotation offsets are in points, so the shove is applied in
    display space without converting back into polar coordinates.
    """
    renderer = fig.canvas.get_renderer()
    centre_x, centre_y = ax.transData.transform((0.0, 0.0))
    for _ in range(MAX_NUDGE_PASSES):
        fig.canvas.draw()
        moved = False
        for marker, rad, annotation in placed:
            marker_radius_px = _marker_radius_px(marker, fig.dpi)
            x0, y0, width, height = _extent(annotation, renderer)
            marker_x, marker_y = ax.transData.transform((rad, marker.r))
            touching = (
                marker_x + marker_radius_px > x0
                and marker_x - marker_radius_px < x0 + width
                and marker_y + marker_radius_px > y0
                and marker_y - marker_radius_px < y0 + height
            )
            if not touching:
                continue
            dx, dy = marker_x - centre_x, marker_y - centre_y
            length = math.hypot(dx, dy) or 1.0
            offset_x, offset_y = annotation.get_position()
            annotation.set_position(
                (offset_x + dx / length * NUDGE_PT, offset_y + dy / length * NUDGE_PT)
            )
            moved = True
        if not moved:
            break


def _separate_annotations(
    fig: Any, ax: Any, placed: list[tuple[Marker, float, Any]]
) -> None:
    """Move overlapping drug labels clear; labels and markers stay put.

    Population and phase labels are obstacles, and so is every marker: a label
    may not settle across a neighbouring marker's ring. `separate_labels` may
    move a label radially as well as vertically, so each one is handed the
    unit vector pointing away from the plate's centre, and any label that ends
    up further from its marker than its own height gets a leader line saying
    which marker it belongs to.
    """
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    movable = [_extent(annotation, renderer) for _, _, annotation in placed]
    fixed = [
        _extent(text, renderer)
        for text in ax.texts
        if str(text.get_gid() or "").startswith(("population-", "phase-"))
    ]
    centre_x, centre_y = ax.transData.transform((0.0, 0.0))
    outward: list[tuple[float, float]] = []
    for marker, rad, _ in placed:
        reach = _marker_radius_px(marker, fig.dpi) + 1.0
        marker_x, marker_y = ax.transData.transform((rad, marker.r))
        fixed.append((marker_x - reach, marker_y - reach, 2 * reach, 2 * reach))
        dx, dy = marker_x - centre_x, marker_y - centre_y
        length = math.hypot(dx, dy) or 1.0
        outward.append((dx / length, dy / length))
    gap_px = LABEL_GAP_PT * fig.dpi / 72
    shifts = separate_labels(movable, fixed, gap=gap_px, outward=outward)
    for (marker, rad, annotation), shift, box in zip(
        placed, shifts, movable, strict=True
    ):
        dx, dy = shift
        if math.hypot(dx, dy) < 1e-9:
            continue
        offset_x, offset_y = annotation.get_position()
        position = (offset_x + dx * 72 / fig.dpi, offset_y + dy * 72 / fig.dpi)
        annotation.set_position(position)
        if math.hypot(dx, dy) <= box[3]:
            continue
        leader = ax.annotate(
            "",
            xy=(rad, marker.r),
            xytext=position,
            textcoords="offset points",
            annotation_clip=False,
            zorder=4.5,
            gid=f"leader-{marker.index}",
            arrowprops={
                "arrowstyle": "-",
                "color": INK,
                "alpha": LEADER_ALPHA,
                "linewidth": LEADER_LINEWIDTH_PT,
                "shrinkA": 0,
                "shrinkB": 0,
            },
        )
        # An Annotation's gid lands on its text element, and this one has no
        # text -- matplotlib skips drawing an empty string, so the gid never
        # reaches the SVG and the line arrives anonymous. The arrow patch is
        # the artist that draws, so it carries the id.
        leader.arrow_patch.set_gid(f"leader-{marker.index}")


class _Swatch:
    """Legend proxy for one marker: an optional ring, an optional hollow centre.

    Line2D cannot carry either. Its `markeredgewidth` fakes a ring as a thick
    edge -- which reads nothing like the separate ring the plate draws -- and
    it has no dashed-edge property at all: `set_linestyle` turns the marker's
    connecting line on instead, which is a stray rule across the swatch.
    """

    def __init__(
        self, ring: str | None = None, dash: str | None = None, hole: float = 0.0
    ) -> None:
        self.ring = ring
        self.dash = dash
        self.hole = hole


class _SwatchHandler:
    """Draws a _Swatch at the marker's own proportions: ring at 1.5x, hole at
    the encoding's fraction, exactly as the radar and the island do."""

    def legend_artist(
        self, legend: Any, orig_handle: Any, fontsize: Any, handlebox: Any
    ) -> Any:
        from matplotlib.patches import Circle

        cx = handlebox.xdescent + handlebox.width / 2
        cy = handlebox.ydescent + handlebox.height / 2
        radius = LEGEND_DOT_PT / 2
        artists = [
            Circle(
                (cx, cy), radius, facecolor="#9aa0b8", edgecolor=PLATE, linewidth=0.6
            )
        ]
        if orig_handle.ring:
            artists.append(
                Circle(
                    (cx, cy),
                    radius * 1.5,
                    facecolor="none",
                    edgecolor=orig_handle.ring,
                    linewidth=RING_LINEWIDTH_PT,
                    linestyle=(0, (3, 2)) if orig_handle.dash else "solid",
                )
            )
        if orig_handle.hole:
            artists.append(
                Circle(
                    (cx, cy),
                    radius * orig_handle.hole,
                    facecolor=PLATE,
                    edgecolor="none",
                )
            )
        for artist in artists:
            handlebox.add_artist(artist)
        return artists[0]


def _dot(color: str, edge: str, edge_width: float, label: str) -> Any:
    from matplotlib.lines import Line2D

    return Line2D(
        [],
        [],
        marker="o",
        linestyle="",
        markersize=LEGEND_DOT_PT,
        markerfacecolor=color,
        markeredgecolor=edge,
        markeredgewidth=edge_width,
        label=label,
    )


def _anchor_below(ax: Any, legend: Any, gap_pt: float = 8.0) -> float:
    """Axes-fraction y just under a legend already placed.

    The mechanism key used to hang from a hardcoded 0.88, tuned when the
    evidence key above it had two rows; a third state and a completeness row
    ran it straight through the "Mechanism of action" title. Measuring is what
    the label passes in this file already do, and it survives the next row.
    """
    fig = ax.get_figure()
    fig.canvas.draw()
    lower = ax.transAxes.inverted().transform(
        (0, legend.get_window_extent().y0)
    )[1]
    gap = (gap_pt * fig.dpi / 72) / ax.get_window_extent().height
    return lower - gap


def _add_legends(
    ax: Any,
    encoding: dict[str, Any],
    trials: list[dict[str, str]],
    marker_list: list[Marker],
) -> None:
    from matplotlib.patches import Patch

    # The island's evidence samples: a neutral dot, ringed or plain. The
    # wording is the encoding's, so the two renderers cannot drift apart.
    evidence = ax.legend(
        handles=[
            _Swatch(ring=state["ring"], dash=state["dash"])
            for state in encoding["evidenceStates"]
        ],
        labels=[state["legend"] for state in encoding["evidenceStates"]],
        handler_map={_Swatch: _SwatchHandler()},
        title="Genetic evidence",
        loc="upper left",
        bbox_to_anchor=(LEGEND_X, 1.0),
        fontsize=LEGEND_FONT_PT,
        title_fontsize=LEGEND_FONT_PT + 1,
        handlelength=SWATCH_BOX_EM,
        handleheight=SWATCH_BOX_EM,
        frameon=False,
    )
    # A later ax.legend() replaces an earlier one unless it is re-added.
    ax.add_artist(evidence)

    # Its own panel, as it is in the island's key: completeness is a statement
    # about the record, not another thing known about the drug's genetics.
    flag = encoding["recordFlag"]
    flagged = sum(1 for m in marker_list if m.flag_reasons)
    # A hole at the encoding's fraction. A flat dot is what the "no ring"
    # sample already is, so the key would have shown one swatch for two things.
    completeness = ax.legend(
        handles=[_Swatch(hole=flag["gapRadius"])],
        labels=[f"{flag['legend']} ({flagged} of {len(marker_list)})"],
        handler_map={_Swatch: _SwatchHandler()},
        title="Record completeness",
        loc="upper left",
        bbox_to_anchor=(LEGEND_X, _anchor_below(ax, evidence)),
        fontsize=LEGEND_FONT_PT,
        title_fontsize=LEGEND_FONT_PT + 1,
        handlelength=SWATCH_BOX_EM,
        handleheight=SWATCH_BOX_EM,
        frameon=False,
    )
    ax.add_artist(completeness)

    # Grouped by family, as the island's key is: an unpainted handle carries
    # each family name, then its members darkest step first.
    present = set(mechanism_order(trials))
    handles = []
    headers: list[str] = []
    for family in encoding["families"]:
        members = [m for m in family["mechanisms"] if m in present]
        if not members:
            continue
        handles.append(Patch(fc="none", ec="none", label=family["label"]))
        headers.append(family["label"])
        for mechanism in members:
            colour = encoding["mechanisms"].get(
                mechanism, encoding["unknownMechanism"]
            )
            handles.append(_dot(colour, PLATE, 0.6, mechanism))
    mechanisms = ax.legend(
        handles=handles,
        title="Mechanism of action",
        loc="upper left",
        bbox_to_anchor=(LEGEND_X, _anchor_below(ax, completeness)),
        fontsize=LEGEND_FONT_PT,
        title_fontsize=LEGEND_FONT_PT + 1,
        frameon=False,
    )
    for text in mechanisms.get_texts():
        if text.get_text() in headers:
            text.set_fontweight("semibold")


def draw(
    trials: list[dict[str, str]],
    encoding: dict[str, Any],
    *,
    font: Path | None = None,
) -> Any:
    """Render the radar and return the matplotlib Figure."""
    import matplotlib

    matplotlib.use("Agg")
    import numpy as np
    from matplotlib.patheffects import withStroke
    from pycirclize import Circos

    configure_fonts(font)
    sectors = sector_spans(trials, encoding)
    cell_list = cells(trials, encoding, sectors)
    marker_list = markers(trials, encoding, sectors)
    band_list = rim_bands(sectors, encoding)
    sector_by_key = {sector.key: sector for sector in sectors}
    cell_by_key = {(cell.population, cell.phase): cell for cell in cell_list}
    boundary = encoding["boundary"]
    halo = [withStroke(linewidth=HALO_LINEWIDTH_PT, foreground=PLATE)]
    label_radius = population_label_radius(encoding)

    # A population with no drugs has a zero-width sector; pyCirclize rejects
    # zero sizes, and there is nothing to draw for it anyway.
    circos = Circos(
        {s.key: s.drug_count for s in sectors if s.drug_count > 0},
        start=0,
        end=360,
        space=0,
    )

    tracks: dict[tuple[str, str], Any] = {}
    for circos_sector in circos.sectors:
        sector = sector_by_key[circos_sector.name]
        for ring in encoding["rings"]:
            track = circos_sector.add_track(
                (ring["innerRadius"] * PLATE_RADIUS, ring["outerRadius"] * PLATE_RADIUS)
            )
            cell = cell_by_key[(sector.key, ring["phase"])]
            track.rect(
                circos_sector.start,
                circos_sector.end,
                fc=cell.color,
                alpha=cell.opacity,
                ec="none",
            )
            # The hairline is its own patch: a stroke on the fill would fade
            # with the cell's opacity, and SVG keeps the two separate.
            track.rect(
                circos_sector.start,
                circos_sector.end,
                fc="none",
                ec=boundary["color"],
                alpha=boundary["opacity"],
                lw=BOUNDARY_LINEWIDTH_PT,
                zorder=3,
            )
            tracks[(sector.key, ring["phase"])] = track

        sine = math.sin(math.radians((sector.start_deg + sector.end_deg) / 2))
        if sine > SIDE_THRESHOLD:
            ha = "left"
        elif sine < -SIDE_THRESHOLD:
            ha = "right"
        else:
            ha = "center"
        circos_sector.text(
            "\n".join(sector.label),
            r=label_radius,
            adjust_rotation=False,
            orientation="horizontal",
            size=POPULATION_FONT_PT,
            weight="bold",
            ha=ha,
            va="center",
            color=INK,
            gid=f"population-{sector.key}",
        )

    for marker in marker_list:
        track = tracks[(marker.population, marker.phase)]
        x = _sector_x(
            marker, sector_by_key[marker.population], track.parent_sector.size
        )
        track.scatter(
            [x],
            [marker.r],
            vmin=track.r_lim[0],
            vmax=track.r_lim[1],
            color=marker.color,
            edgecolor=PLATE,
            linewidth=MARKER_EDGE_PT,
            s=MARKER_AREA_PT2,
            zorder=5,
            gid=f"marker-{marker.index}",
        )
        if marker.flag_reasons:
            track.scatter(
                [x],
                [marker.r],
                vmin=track.r_lim[0],
                vmax=track.r_lim[1],
                color=PLATE,
                edgecolor="none",
                s=GAP_AREA_PT2,
                zorder=5.5,
                gid=f"gap-{marker.index}",
            )
        if marker.evidence_ring:
            track.scatter(
                [x],
                [marker.r],
                vmin=track.r_lim[0],
                vmax=track.r_lim[1],
                facecolor="none",
                edgecolor=marker.evidence_ring,
                linewidth=RING_LINEWIDTH_PT,
                linestyle=(0, (3, 2)) if marker.evidence_dash else "solid",
                s=RING_AREA_PT2,
                zorder=6,
                gid=f"ring-{marker.index}",
            )

    # A halo is a path effect, and matplotlib draws text with path effects as
    # outlines — so the SVG would lose the words. Each haloed label is
    # therefore two artists: a pathified twin carrying the contour, and the
    # plain text on top of it, which stays text in the SVG and the PDF.
    for ring in encoding["rings"]:
        # Typed as Any so the ** spread satisfies Circos.text's keyword-only
        # `r`/`deg` floats; the values are what they always were.
        phase_text: dict[str, Any] = {
            "r": (ring["innerRadius"] + ring["outerRadius"]) / 2 * PLATE_RADIUS,
            "deg": sectors[0].start_deg,
            "size": PHASE_FONT_PT,
            "weight": "bold",
            "ha": "center",
            "va": "center",
            "color": INK,
            "alpha": 0.72,
        }
        # The twin is plate-coloured throughout, so any sub-pixel drift
        # between glyph and outline rendering shows as plate, not as a ghost.
        halo_text: dict[str, Any] = {**phase_text, "color": PLATE, "alpha": 1.0}
        circos.text(
            f"PHASE {ring['phase']}",
            path_effects=halo,
            zorder=3.9,
            gid=f"halo-phase-{ring['phase']}",
            **halo_text,
        )
        circos.text(
            f"PHASE {ring['phase']}",
            zorder=4,
            gid=f"phase-{ring['phase']}",
            **phase_text,
        )

    # 8 x 1.3, the factor the island's plate radius grew by (320 -> 416)
    # against an unchanged label size. The point fonts here are fixed the same
    # way, so a bigger figure is what buys the labels the same extra arc
    # length -- the print twin of raising CANVAS and OUTER_RADIUS together.
    fig = circos.plotfig(figsize=(10.4, 10.4))
    ax = circos.ax
    # pyCirclize builds the figure with tight_layout=True. Left on, the engine
    # shrinks the plate at save time to fit the legends inside the canvas,
    # after the label passes below have measured everything at full size.
    # The tight save bbox still captures the legends and the rim labels.
    fig.set_layout_engine("none")

    # The rim band lies beyond the 0-100 plate pyCirclize manages, so it is
    # filled on the polar axes directly, unclipped, one arc per sector.
    for band in band_list:
        circos_sector = circos.get_sector(band.population)
        rad_start, rad_end = circos_sector.rad_lim
        theta = np.linspace(rad_start, rad_end, 64)
        ax.fill_between(
            theta,
            band.inner,
            band.outer,
            facecolor=band.color,
            edgecolor=PLATE,
            linewidth=BAND_SEPARATOR_PT,
            clip_on=False,
            zorder=2,
            gid=f"band-{band.population}",
        )

    placed: list[tuple[Marker, float, Any]] = []
    for marker in marker_list:
        track = tracks[(marker.population, marker.phase)]
        x = _sector_x(
            marker, sector_by_key[marker.population], track.parent_sector.size
        )
        rad = track.x_to_rad(x)
        sign = 1 if marker.anchor == "start" else -1
        annotation = ax.annotate(
            marker.trial["drug"],
            xy=(rad, marker.r),
            xytext=(sign * LABEL_OFFSET_PT, 0),
            textcoords="offset points",
            ha="left" if sign > 0 else "right",
            va="center",
            size=DRUG_FONT_PT,
            color=INK,
            zorder=7,
            gid=f"label-{marker.index}",
        )
        placed.append((marker, rad, annotation))

    _nudge_labels(fig, ax, placed)
    _separate_annotations(fig, ax, placed)
    _add_halos(ax, placed, halo)
    _add_legends(ax, encoding, trials, marker_list)
    return fig


def _add_halos(
    ax: Any, placed: list[tuple[Marker, float, Any]], halo: list[Any]
) -> None:
    """Give every settled drug label a pathified twin that carries its halo.

    The twin is plate-coloured throughout — outline and fill — so any
    sub-pixel drift between glyph and outline rendering shows as plate under
    the ink text on top, never as a ghost of it.
    """
    for marker, _, annotation in placed:
        ax.annotate(
            annotation.get_text(),
            xy=annotation.xy,
            xytext=annotation.get_position(),
            textcoords="offset points",
            ha=annotation.get_ha(),
            va=annotation.get_va(),
            size=DRUG_FONT_PT,
            color=PLATE,
            path_effects=halo,
            zorder=6.9,
            gid=f"halo-{marker.index}",
        )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(__doc__ or "").split("\n\n")[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--trials", type=Path, default=DEFAULT_TRIALS)
    parser.add_argument("--encoding", type=Path, default=DEFAULT_ENCODING)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--format", nargs="+", choices=FORMATS, default=list(FORMATS))
    parser.add_argument("--dpi", type=int, default=300)
    parser.add_argument(
        "--font",
        type=Path,
        default=None,
        help="TTF/OTF to register and use (journals often require Arial/Helvetica)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    trials = load_trials(args.trials)
    if not trials:
        # A repository generated for another disease starts from
        # `deno task data:empty`; a blank plate would only look like a bug.
        print(f"{args.trials}: no trial rows; nothing to draw.", file=sys.stderr)
        return 0
    fig = draw(trials, load_encoding(args.encoding), font=args.font)
    args.out.mkdir(parents=True, exist_ok=True)
    for fmt in args.format:
        target = args.out / f"timeline.{fmt}"
        fig.savefig(target, format=fmt, dpi=args.dpi, bbox_inches="tight")
        print(f"wrote {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
