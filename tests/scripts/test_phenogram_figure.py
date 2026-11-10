"""Unit tests for scripts/phenogram_figure.py.

The rules pinned here are the ones tests/phenogram_layout_test.ts pins for
lib/phenogram.ts: the island and the print figure implement one rule over one
encoding file and one cytoband table, and these two suites keep them in step.
Every test holds for any dataset -- the committed rows are only ever looped
over, and the constructed cases build their rows from the encoding. The
cSVD karyogram's own numbers are pinned in tests/scripts/csvd/.
"""

import itertools
import json
import math
import re
from pathlib import Path
from typing import Any

import pytest
from scripts import phenogram_figure
from scripts.phenogram_figure import (
    CHROMOSOME_LABEL_DESCENT,
    DEFAULT_CYTOBANDS,
    DEFAULT_GENES,
    Layout,
    block_height,
    canvas_for,
    chromosome_shapes,
    column_width,
    compute_layout,
    draw,
    glyph_lift,
    glyph_marker,
    glyph_scale,
    glyphs_for,
    label_width,
    load_cytobands,
    load_encoding,
    load_font_metrics,
    load_genes,
    main,
    normalize_gene,
    pills_for,
    place_gene,
    resolve_collisions,
    split_rows,
    text_width,
)


@pytest.fixture(scope="module")
def genes() -> list[dict]:
    return load_genes(DEFAULT_GENES)


@pytest.fixture(scope="module")
def cytobands() -> dict:
    return load_cytobands(DEFAULT_CYTOBANDS)


@pytest.fixture(scope="module")
def encoding() -> dict:
    return load_encoding()


@pytest.fixture(scope="module")
def metrics() -> dict:
    return load_font_metrics()


@pytest.fixture(scope="module")
def layout(genes, encoding, cytobands):
    return compute_layout(genes, encoding, cytobands)


def assert_fits(placed: Layout, encoding: dict, metrics: dict) -> None:
    """What every layout owes its canvas; the twin of assertFits in
    tests/phenogram_layout_test.ts."""
    geometry = encoding["layout"]
    width, height = placed.canvas

    def pitch(shape) -> float:
        return geometry["chromosomeWidth"] + geometry["leaderGap"] + shape.column_width

    for row in placed.rows:
        right = geometry["margin"]
        for shape in row:
            assert shape.x == pytest.approx(right), f"chr{shape.name} x"
            right = shape.x + pitch(shape)
            assert right <= width - geometry["margin"] + 1e-6
            assert (
                shape.label_point[1] + CHROMOSOME_LABEL_DESCENT
                <= height - geometry["margin"] + 1e-6
            )
    by_name = {c.name: c for c in placed.chromosomes}
    for block in placed.blocks:
        shape = by_name[block.chromosome]
        assert block.width == shape.column_width
        drawn = label_width(
            block.symbol, block.pills, len(block.glyphs), geometry, metrics
        )
        assert block.x + drawn <= shape.x + pitch(shape) + 1e-6, block.symbol
        assert block.x >= 0 and block.y >= 0
        assert block.x + block.width <= width + 1e-6
        assert block.y + block.height <= height + 1e-6
    pitches = [pitch(c) for c in placed.chromosomes]
    widest = max(sum(pitch(c) for c in row) for row in placed.rows)
    for k in range(1, len(pitches)):
        assert widest <= max(sum(pitches[:k]), sum(pitches[k:])), f"cut at {k}"
    if placed.chromosomes:
        assert width == math.ceil(2 * geometry["margin"] + widest)
        bottom = max(
            [c.label_point[1] + CHROMOSOME_LABEL_DESCENT for c in placed.chromosomes]
            + [b.y + b.height for b in placed.blocks]
        )
        assert height == math.ceil(bottom + geometry["margin"])


def _gene(encoding: dict, **overrides: Any) -> dict[str, Any]:
    """A gene row every rule accepts, on a band the hg38 table carries."""
    row = {
        "gene": "GENE1",
        "protein": "Protein one",
        "chromosomalLocation": "7q31.1",
        "gwasTrait": [encoding["traits"][0]["key"]],
        "mendelianRandomization": "No",
        "evidenceFromOtherOmicsStudies": ["(none found)"],
        "linkToMonogenicDisease": ["(none found)"],
        "brainCellTypes": "(unknown)",
        "affectedPathway": "(unknown)",
        "references": ["10000001"],
        "sourceQuote": "GENE1 was associated with the phenotype.",
        "confidence": 0.9,
    }
    row.update(overrides)
    return normalize_gene(row)


def _bare(encoding: dict, symbol: str, location: str) -> dict[str, Any]:
    """A gene with no pills or glyphs, so its column is the minimum."""
    return _gene(
        encoding, gene=symbol, chromosomalLocation=location, gwasTrait=["(none found)"]
    )


class TestPlacement:
    def test_place_gene_is_exact(self, cytobands) -> None:
        hit = place_gene("7q31.1", cytobands)
        assert hit is not None
        assert (hit.chromosome, hit.band, hit.start, hit.end) == (
            "7",
            "q31.1",
            107800000,
            115000000,
        )
        assert hit.midpoint == 111400000
        assert place_gene("1p3", cytobands) is None
        assert place_gene("23q11", cytobands) is None
        assert place_gene("(unknown)", cytobands) is None

    def test_place_gene_spans_a_band_range(self, cytobands) -> None:
        """NCBI's range for a gene across a band edge, as lib/cytobands.ts."""
        hit = place_gene("10q24.33-q25.1", cytobands)
        assert hit is not None
        assert (hit.chromosome, hit.band, hit.start, hit.end) == (
            "10",
            "q24.33-q25.1",
            103100000,
            110100000,
        )
        assert hit.midpoint == 106600000
        reversed_hit = place_gene("10q25.1-q24.33", cytobands)
        assert reversed_hit is not None
        assert (reversed_hit.start, reversed_hit.end) == (103100000, 110100000)
        assert place_gene("10q24.33-q25", cytobands) is None
        assert place_gene("10q24.33-", cytobands) is None
        assert place_gene("10q24.33-11q25.1", cytobands) is None
        assert place_gene("10q24.33-q25.1-q25.2", cytobands) is None

    def test_place_gene_refuses_a_range_across_the_centromere(self, cytobands) -> None:
        """A p-to-q range is placed nowhere, as lib/cytobands.ts."""
        assert place_gene("1p36.33-q44", cytobands) is None
        assert place_gene("1q21.1-p13.3", cytobands) is None
        assert place_gene("10q24.33-q25.1", cytobands) is not None

    def test_only_chromosomes_with_a_gene_are_drawn(self, layout, genes) -> None:
        drawn = [c.name for c in layout.chromosomes]
        assert len(drawn) == len(set(drawn))
        assert set(drawn) == {b.chromosome for b in layout.blocks}
        assert len(layout.blocks) + len(layout.unplaced) == len(genes)
        assert [c.name for row in layout.rows for c in row] == drawn

    def test_a_constructed_table_places_its_genes_and_reports_the_unplaceable(
        self, encoding, cytobands
    ) -> None:
        rows = [
            _gene(encoding, gene="GENE1", chromosomalLocation="7q31.1"),
            _gene(encoding, gene="GENE2", chromosomalLocation="Xq22.1"),
            _gene(encoding, gene="GENE3", chromosomalLocation="(unknown)"),
        ]
        placed = compute_layout(rows, encoding, cytobands)
        assert [b.symbol for b in placed.blocks] == ["GENE1", "GENE2"]
        assert [c.name for c in placed.chromosomes] == ["7", "X"]
        assert [g["gene"] for g in placed.unplaced] == ["GENE3"]
        assert placed.canvas == canvas_for(
            placed.rows, placed.blocks, encoding["layout"]
        )

    def test_an_empty_table_draws_no_chromosome(self, encoding, cytobands) -> None:
        empty = compute_layout([], encoding, cytobands)
        assert empty.blocks == ()
        assert empty.chromosomes == ()
        assert empty.unplaced == ()

    def test_chromosomes_are_to_scale_and_bands_tile_them(
        self, encoding, cytobands
    ) -> None:
        rows = [
            _gene(encoding, gene="GENE1", chromosomalLocation="1p36.33"),
            _gene(encoding, gene="GENE2", chromosomalLocation="13q34"),
        ]
        placed = compute_layout(rows, encoding, cytobands)
        one = next(c for c in placed.chromosomes if c.name == "1")
        assert one.height == pytest.approx(encoding["layout"]["rowHeight"])
        thirteen = next(c for c in placed.chromosomes if c.name == "13")
        assert thirteen.height == pytest.approx(
            114364328 / 248956422 * encoding["layout"]["rowHeight"]
        )
        for chromosome in placed.chromosomes:
            cursor = chromosome.y
            for band in chromosome.bands:
                assert band.y == pytest.approx(cursor)
                assert band.fill == encoding["stains"][band.stain]
                cursor += band.height
            assert cursor == pytest.approx(chromosome.y + chromosome.height)

    def test_blocks_stay_in_their_row_and_never_overlap(self, layout, encoding) -> None:
        gap = encoding["layout"]["blockGap"]
        row_height = encoding["layout"]["rowHeight"]
        for chromosome in layout.chromosomes:
            blocks = [b for b in layout.blocks if b.chromosome == chromosome.name]
            for previous, block in zip(blocks, blocks[1:], strict=False):
                assert block.y >= previous.y + previous.height + gap - 1e-6
            for block in blocks:
                assert block.y >= chromosome.y - 1e-6
                assert block.y + block.height <= chromosome.y + row_height + 1e-6

    def test_markers_sit_at_their_band_midpoint_in_order(
        self, layout, cytobands, encoding
    ) -> None:
        geometry = encoding["layout"]
        by_chromosome = {c.name: c for c in layout.chromosomes}
        previous_marker_y: dict[str, float] = {}
        for block in layout.blocks:
            shape = by_chromosome[block.chromosome]
            hit = place_gene(block.gene["chromosomalLocation"], cytobands)
            assert hit is not None
            assert block.marker_y == pytest.approx(
                shape.y + hit.midpoint / shape.length * shape.height
            )
            assert shape.y <= block.marker_y <= shape.y + shape.height
            assert (
                block.x == shape.x + geometry["chromosomeWidth"] + geometry["leaderGap"]
            )
            assert block.width == shape.column_width
            assert block.marker_y >= previous_marker_y.get(
                block.chromosome, block.marker_y
            )
            previous_marker_y[block.chromosome] = block.marker_y


class TestDerivedCanvas:
    """The label columns, row split and canvas; the cases
    tests/phenogram_layout_test.ts runs, with the same expectations."""

    def test_the_drawing_constants_are_the_encodings(self, encoding) -> None:
        geometry = encoding["layout"]
        assert geometry["symbolFont"] == phenogram_figure.SYMBOL_FONT_UNITS
        assert geometry["pillFont"] == phenogram_figure.PILL_FONT_UNITS
        assert geometry["glyphSize"] == phenogram_figure.GLYPH_UNITS
        assert geometry["glyphGap"] == phenogram_figure.GLYPH_GAP
        assert geometry["pillPaddingX"] == phenogram_figure.PILL_PADDING_X
        assert "viewBox" not in geometry
        assert "rowSplitAfter" not in geometry

    def test_the_committed_layout_fits_its_canvas(
        self, layout, encoding, metrics
    ) -> None:
        assert_fits(layout, encoding, metrics)

    def test_a_gene_on_every_chromosome_splits_twelve_and_twelve(
        self, encoding, cytobands, metrics
    ) -> None:
        rows = [
            _gene(
                encoding,
                gene=f"{end}{i}",
                chromosomalLocation=f"{c['name']}{c['bands'][index]['name']}",
            )
            for i, c in enumerate(cytobands["chromosomes"])
            for end, index in (("A", 0), ("Z", -1))
        ]
        placed = compute_layout(rows, encoding, cytobands)
        assert placed.unplaced == ()
        assert [len(row) for row in placed.rows] == [12, 12]
        assert_fits(placed, encoding, metrics)

    def test_three_equal_columns_split_two_and_one(
        self, encoding, cytobands, metrics
    ) -> None:
        placed = compute_layout(
            [
                _bare(encoding, "GENE1", "1p36.33"),
                _bare(encoding, "GENE2", "13q34"),
                _bare(encoding, "GENE3", "Xq22.1"),
            ],
            encoding,
            cytobands,
        )
        assert [[c.name for c in row] for row in placed.rows] == [["1", "13"], ["X"]]
        assert placed.rows[1][0].y == (
            encoding["layout"]["margin"]
            + encoding["layout"]["rowHeight"]
            + encoding["layout"]["rowGap"]
        )
        assert_fits(placed, encoding, metrics)

    def test_text_width_sums_advances_and_charges_unknowns_the_widest(
        self, metrics
    ) -> None:
        em = metrics["unitsPerEm"]
        a = metrics["advances"]["600"][str(ord("A"))]
        assert text_width("AA", 600, 12, metrics) == pytest.approx(2 * a / em * 12)
        assert text_width("", 400, 9.5, metrics) == 0
        widest = max(metrics["advances"]["400"].values())
        assert text_width("\U0001f9ec", 400, 10, metrics) == pytest.approx(
            widest / em * 10
        )

    def test_label_width_counts_glyphs_and_pills(self, encoding, metrics) -> None:
        geometry = encoding["layout"]
        symbol = text_width("GENE1", 600, geometry["symbolFont"], metrics)
        assert label_width("GENE1", (), 0, geometry, metrics) == pytest.approx(symbol)
        assert label_width("GENE1", (), 3, geometry, metrics) == pytest.approx(
            symbol + 2 * geometry["glyphGap"] + 3 * geometry["glyphSize"]
            + 2 * geometry["glyphGap"]
        )

    def test_column_width_never_narrows_below_label_column(self, encoding) -> None:
        geometry = encoding["layout"]
        assert column_width([], geometry) == geometry["labelColumn"]
        assert column_width([10, 40], geometry) == geometry["labelColumn"]
        assert column_width([geometry["labelColumn"] + 0.25], geometry) == (
            geometry["labelColumn"] + math.ceil(0.25 + geometry["labelSlack"])
        )

    def test_split_rows_minimises_the_wider_row(self) -> None:
        assert split_rows([]) == 0
        assert split_rows([152]) == 1
        assert split_rows([1, 1]) == 1
        assert split_rows([1, 1, 1]) == 2
        assert split_rows([10, 1, 1, 1]) == 1
        assert split_rows([1, 1, 1, 10]) == 3
        for length in range(2, 7):
            for pitches in itertools.product((1, 2, 5), repeat=length):

                def cost(k: int, p=pitches) -> int:
                    return max(sum(p[:k]), sum(p[k:]))

                lowest = min(cost(j) for j in range(1, length))
                best = max(k for k in range(1, length) if cost(k) == lowest)
                assert split_rows(pitches) == best, pitches

    def test_a_wide_pill_widens_only_its_own_column(
        self, encoding, cytobands, metrics
    ) -> None:
        geometry = encoding["layout"]
        long = "MTAG (every trait this gene was ever linked with, at once)"
        wide = _gene(
            encoding, gene="GENE2", chromosomalLocation="2p25.3", gwasTrait=[long]
        )
        placed = compute_layout(
            [
                _bare(encoding, "GENE1", "1p36.33"),
                wide,
                _bare(encoding, "GENE3", "3p26.3"),
            ],
            encoding,
            cytobands,
        )
        widths = {c.name: c.column_width for c in placed.chromosomes}
        pill = text_width(long, 400, geometry["pillFont"], metrics) + 2 * geometry[
            "pillPaddingX"
        ]
        assert pill > geometry["labelColumn"]
        assert widths == {
            "1": geometry["labelColumn"],
            "2": math.ceil(pill + geometry["labelSlack"]),
            "3": geometry["labelColumn"],
        }
        assert_fits(placed, encoding, metrics)

    def test_chromosome_shapes_take_their_column_widths(
        self, encoding, cytobands
    ) -> None:
        geometry = encoding["layout"]
        rows = chromosome_shapes(["1", "2", "3"], cytobands, encoding, {"1": 400})
        assert [[c.name for c in row] for row in rows] == [["1"], ["2", "3"]]
        assert rows[0][0].column_width == 400
        assert rows[1][1].x == (
            geometry["margin"]
            + geometry["chromosomeWidth"]
            + geometry["leaderGap"]
            + geometry["labelColumn"]
        )
        assert [len(r) for r in chromosome_shapes(["7"], cytobands, encoding)] == [1, 0]

    def test_an_empty_layout_gets_the_one_column_canvas(
        self, encoding, cytobands
    ) -> None:
        geometry = encoding["layout"]
        margin = geometry["margin"]
        expected = (2 * margin + geometry["labelColumn"], 2 * margin)
        assert compute_layout([], encoding, cytobands).canvas == expected
        assert canvas_for([[], []], [], geometry) == expected


class TestEncoding:
    def test_pills_and_glyphs_follow_the_evidence_columns(self, encoding) -> None:
        first = encoding["traits"][0]
        family = next(f for f in encoding["families"] if f["key"] == first["family"])
        evidence = _gene(
            encoding,
            gwasTrait=[first["key"]],
            evidenceFromOtherOmicsStudies=["TWAS"],
            linkToMonogenicDisease=["100000"],
            mendelianRandomization="Yes",
        )
        pills = pills_for(evidence, encoding)
        assert [p.label for p in pills] == [first["key"]]
        assert pills[0].family == family["key"]
        assert pills[0].fill == family["tint"]
        assert pills[0].stroke == family["hue"]
        assert [g.key for g in glyphs_for(evidence, encoding)] == [
            "omics",
            "monogenic",
            "mr",
        ]
        bare = _gene(encoding, gwasTrait=["(none found)"])
        assert pills_for(bare, encoding) == ()
        assert glyphs_for(bare, encoding) == ()
        assert block_height(len(pills), encoding["layout"]) > block_height(
            0, encoding["layout"]
        )


class TestResolveCollisions:
    """Same cases as tests/phenogram_layout_test.ts, same expected tops."""

    def test_leaves_separated_blocks_alone(self) -> None:
        assert resolve_collisions([0, 50], [20, 20], 0, 400, 6) == [0, 50]

    def test_pushes_a_following_block_down(self) -> None:
        assert resolve_collisions([0, 10], [20, 20], 0, 400, 6) == [0, 26]

    def test_pulls_a_stack_up_at_the_bottom(self) -> None:
        assert resolve_collisions([380, 390], [20, 20], 0, 400, 6) == [354, 380]

    def test_clamps_a_lone_block(self) -> None:
        assert resolve_collisions([-10], [20], 0, 400, 6) == [0]
        assert resolve_collisions([395], [20], 0, 400, 6) == [380]
        assert resolve_collisions([], [], 0, 400, 6) == []


class TestRender:
    """matplotlib is not a base dependency -- it arrives with the `figure`
    group, through pyCirclize. CI installs that group, but a plain
    `uv sync --group dev` does not, and phenogram_figure.py imports
    matplotlib inside the drawing functions rather than at module scope, so
    only these tests reach it. The layout tests above need none of it.
    """

    @pytest.fixture(autouse=True)
    def _needs_matplotlib(self) -> None:
        pytest.importorskip("matplotlib")

    def test_svg_carries_every_gene_and_both_legends(
        self, encoding, cytobands, tmp_path: Path
    ) -> None:
        rows = [
            _gene(encoding, gene="GENE1", chromosomalLocation="7q31.1"),
            _gene(encoding, gene="GENE2/3", chromosomalLocation="13q34"),
        ]
        fig = draw(rows, encoding, cytobands)
        target = tmp_path / "phenogram.svg"
        fig.savefig(target, format="svg", bbox_inches="tight")
        svg = target.read_text(encoding="utf-8")
        assert svg.count('id="gene-') == 2
        # A gene symbol can carry a "/"; the gid is sanitized so the id stays
        # a valid XML Name.
        assert 'id="gene-GENE2-3"' in svg
        assert "Supporting evidence" in svg
        assert "GWAS phenotypes" in svg
        assert encoding["families"][0]["label"] in svg
        # Text stays text: real <text> elements, not glyph outlines. Comments
        # and gids carry the symbols regardless of svg.fonttype, so look for
        # the symbol as element content.
        assert svg.count("<text") >= 2
        assert re.search(r"<text[^>]*>(?:<tspan[^>]*>)?GENE2/3<", svg)

    def test_main_writes_the_requested_formats(
        self, encoding, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        rows = tmp_path / "table1.json"
        unplaced = _gene(encoding, gene="GENE2", chromosomalLocation="(unknown)")
        rows.write_text(json.dumps([_gene(encoding), unplaced]), encoding="utf-8")
        out = tmp_path / "fig"
        argv = ["--genes", str(rows), "--out", str(out), "--format", "svg", "pdf"]
        code = main([*argv, "--dpi", "72"])
        assert code == 0
        assert (out / "phenogram.svg").stat().st_size > 0
        assert (out / "phenogram.pdf").stat().st_size > 0
        assert not (out / "phenogram.png").exists()
        assert "Unplaced (no hg38 band): GENE2 ((unknown))" in capsys.readouterr().err

    def test_main_reports_an_empty_table_and_writes_nothing(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """A fork starts from `deno task data:empty`; there is nothing to draw
        and the script says so rather than writing an empty karyogram."""
        rows = tmp_path / "table1.json"
        rows.write_text("[]\n", encoding="utf-8")
        out = tmp_path / "fig"
        assert main(["--genes", str(rows), "--out", str(out)]) == 0
        assert not out.exists()
        assert "no gene rows" in capsys.readouterr().err


class TestNormalization:
    """normalize_gene mirrors lib/data/genes.ts's normalizeGene (Important 2): a
    regenerated table1.json carrying stray whitespace or blank list entries
    must render the same pills and glyphs in print as it does on screen.
    """

    @pytest.fixture
    def raw_row(self, encoding) -> dict[str, Any]:
        return {
            "gene": "TESTGENE",
            "chromosomalLocation": " 7q31.1 ",
            "gwasTrait": [f"{encoding['traits'][0]['key']} ", ""],
            "evidenceFromOtherOmicsStudies": [" proteomics"],
            "linkToMonogenicDisease": [],
            "mendelianRandomization": "Yes ",
        }

    def test_normalize_gene_trims_and_falls_back_like_lib_data_ts(
        self, raw_row, encoding
    ) -> None:
        row = normalize_gene(raw_row)
        assert row["chromosomalLocation"] == "7q31.1"
        assert row["gwasTrait"] == [encoding["traits"][0]["key"]]
        assert row["evidenceFromOtherOmicsStudies"] == ["proteomics"]
        assert row["linkToMonogenicDisease"] == ["(none found)"]
        assert row["mendelianRandomization"] == "Yes"

    def test_normalized_row_yields_one_pill_and_two_glyphs(
        self, raw_row, encoding
    ) -> None:
        row = normalize_gene(raw_row)
        first = encoding["traits"][0]
        pills = pills_for(row, encoding)
        assert [p.label for p in pills] == [first["key"]]
        assert pills[0].family == first["family"]
        family = next(f for f in encoding["families"] if f["key"] == first["family"])
        assert pills[0].fill == family["tint"]
        assert [g.key for g in glyphs_for(row, encoding)] == ["omics", "mr"]


class TestGlyphGeometry:
    """The three evidence marks are a symbol set, and it spans two renderers.

    tests/phenogram_encoding_test.ts pins the encoding side; these pin that this
    renderer actually reads it. The star is the case that matters: matplotlib's
    built-in ``*`` hard-codes ``innerCircle=0.381966``, so for as long as each
    renderer owned its own star the print figure carried a different mark from
    the island and no test in either suite could tell.

    matplotlib arrives only with the `figure` group (see TestRender), and
    two of these tests import it, so they skip rather than fail without it.
    """

    @pytest.fixture(autouse=True)
    def _needs_matplotlib(self) -> None:
        pytest.importorskip("matplotlib")

    def test_star_is_built_from_the_encoding_not_matplotlibs_builtin(
        self, encoding
    ) -> None:
        from matplotlib.markers import MarkerStyle
        from matplotlib.path import Path as MarkerPath

        ratio = encoding["glyphs"]["star"]["innerRatio"]
        marker = glyph_marker("star", encoding["glyphs"])
        assert isinstance(marker, MarkerPath), "star fell back to the builtin '*'"

        expected = MarkerPath.unit_regular_star(5, innerCircle=ratio)
        assert marker.vertices == pytest.approx(expected.vertices)

        builtin = MarkerStyle("*").get_path()
        assert marker.vertices != pytest.approx(builtin.vertices), (
            f"innerRatio {ratio} reproduces matplotlib's 0.381966"
        )

    def test_a_custom_star_is_sized_like_the_builtin_one(self, encoding) -> None:
        """Both normalise by 0.5 / max(|vertices|), so markersize means the same."""
        from matplotlib.markers import MarkerStyle
        from matplotlib.transforms import Affine2DBase

        def values(marker: MarkerStyle) -> tuple[float, ...]:
            # A marker's transform is always affine, but `get_transform` is
            # annotated with the base class, which carries no `to_values`.
            transform = marker.get_transform()
            assert isinstance(transform, Affine2DBase)
            return transform.to_values()

        custom = MarkerStyle(glyph_marker("star", encoding["glyphs"]))
        builtin = MarkerStyle("*")
        assert values(custom) == pytest.approx(values(builtin))

    def test_triangle_and_square_keep_matplotlibs_own_marks(self, encoding) -> None:
        assert glyph_marker("triangle", encoding["glyphs"]) == "^"
        assert glyph_marker("square", encoding["glyphs"]) == "s"

    def test_the_three_glyphs_carry_comparable_ink(self, encoding) -> None:
        """Ink is area, not bounding box; the gap this geometry closes was 3.24x."""
        import math

        glyphs = encoding["glyphs"]
        box = 9.0

        def area(shape: str) -> float:
            side = box * glyph_scale(shape, glyphs)
            if shape == "square":
                return side * side
            if shape == "triangle":
                return side * side / 2
            outer = side / 2
            return 5 * outer * (outer * glyphs["star"]["innerRatio"]) * math.sin(
                math.pi / 5
            )

        areas = [area(s) for s in ("square", "triangle", "star")]
        spread = max(areas) / min(areas)
        assert spread <= 1.75, f"glyph ink spread {spread:.2f}x: {areas}"

    def test_only_the_triangle_is_lifted(self, encoding) -> None:
        glyphs = encoding["glyphs"]
        assert glyph_lift("triangle", glyphs) > 0
        assert glyph_lift("square", glyphs) == 0
        assert glyph_lift("star", glyphs) == 0
