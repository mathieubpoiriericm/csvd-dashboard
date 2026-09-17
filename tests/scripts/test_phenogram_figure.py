"""Unit tests for scripts/phenogram_figure.py.

The numbers pinned here are the ones tests/phenogram_layout_test.ts pins for
lib/phenogram.ts: the island and the print figure implement one rule over one
encoding file and one cytoband table, and these two suites keep them in step.
"""

import re
from pathlib import Path

import pytest
from scripts.phenogram_figure import (
    DEFAULT_CYTOBANDS,
    DEFAULT_ENCODING,
    DEFAULT_GENES,
    block_height,
    compute_layout,
    draw,
    glyph_lift,
    glyph_marker,
    glyph_scale,
    glyphs_for,
    load_cytobands,
    load_encoding,
    load_genes,
    main,
    normalize_gene,
    pills_for,
    place_gene,
    resolve_collisions,
)

DRAWN = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
    "13",
    "14",
    "16",
    "17",
    "18",
    "19",
    "20",
    "21",
    "22",
    "X",
]


@pytest.fixture(scope="module")
def genes() -> list[dict]:
    return load_genes(DEFAULT_GENES)


@pytest.fixture(scope="module")
def cytobands() -> dict:
    return load_cytobands(DEFAULT_CYTOBANDS)


@pytest.fixture(scope="module")
def encoding() -> dict:
    return load_encoding(DEFAULT_ENCODING)


@pytest.fixture(scope="module")
def layout(genes, encoding, cytobands):
    return compute_layout(genes, encoding, cytobands)


def by_gene(layout, symbol: str):
    return next(block for block in layout.blocks if block.symbol == symbol)


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

    def test_every_gene_is_placed_on_twenty_one_chromosomes(self, layout) -> None:
        # X joined the list when the 365-day run added GLA (Xq22.1) and 18
        # when it added AQP4 (18q11.2). Mirrored in
        # tests/phenogram_layout_test.ts.
        assert len(layout.blocks) == 79
        assert layout.unplaced == ()
        assert [c.name for c in layout.chromosomes] == DRAWN
        assert [[c.name for c in row] for row in layout.rows] == [
            DRAWN[:10],
            DRAWN[10:],
        ]
        assert layout.canvas == (1732, 1160)

    def test_the_rasters_errors_are_gone(self, layout) -> None:
        assert by_gene(layout, "ABO").chromosome == "9"
        assert by_gene(layout, "APOE").chromosome == "19"
        assert by_gene(layout, "C6orf195").chromosome == "6"
        assert by_gene(layout, "COL4A1/2").chromosome == "13"

    def test_chromosomes_are_to_scale_and_bands_tile_them(
        self, layout, encoding
    ) -> None:
        one = next(c for c in layout.chromosomes if c.name == "1")
        assert one.height == pytest.approx(encoding["layout"]["rowHeight"])
        thirteen = next(c for c in layout.chromosomes if c.name == "13")
        assert thirteen.height == pytest.approx(
            114364328 / 248956422 * encoding["layout"]["rowHeight"]
        )
        for chromosome in layout.chromosomes:
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
            assert block.width == geometry["labelColumn"]
            assert block.marker_y >= previous_marker_y.get(
                block.chromosome, block.marker_y
            )
            previous_marker_y[block.chromosome] = block.marker_y

    def test_cenpf_marker_position_is_pinned(self, layout) -> None:
        """Absolute numbers computed from the TypeScript layout
        (computePhenogramLayout in lib/phenogram.ts, over the committed
        genes) and pinned in both suites, so the print twin and the browser
        renderer cannot silently drift apart. Mirrored in
        tests/phenogram_layout_test.ts.
        """
        cenpf = by_gene(layout, "CENPF")
        assert cenpf.marker_y == pytest.approx(487.74276110057525)
        assert cenpf.y == pytest.approx(402)


class TestEncoding:
    def test_pills_and_glyphs_follow_the_evidence_columns(
        self, layout, genes, encoding
    ) -> None:
        cenpf = by_gene(layout, "CENPF")
        assert [p.label for p in cenpf.pills] == ["WM-PVS", "HIP-PVS", "PSMD"]
        assert [g.key for g in cenpf.glyphs] == ["omics", "monogenic"]
        assert cenpf.pills[0].fill == "#d8edff"
        assert cenpf.pills[0].stroke == "#2a78d6"
        assert cenpf.height == block_height(3, encoding["layout"]) == 64
        pcsk9 = next(g for g in genes if g["gene"] == "PCSK9")
        assert pills_for(pcsk9, encoding) == ()
        assert [g.key for g in glyphs_for(pcsk9, encoding)] == [
            "omics",
            "monogenic",
            "mr",
        ]
        lamb1 = next(g for g in genes if g["gene"] == "LAMB1")
        assert glyphs_for(lamb1, encoding) == ()


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
    only these two tests reach it. The layout tests above need none of it.
    """

    @pytest.fixture(autouse=True)
    def _needs_matplotlib(self) -> None:
        pytest.importorskip("matplotlib")

    def test_svg_carries_every_gene_and_both_legends(
        self, genes, encoding, cytobands, tmp_path: Path
    ) -> None:
        fig = draw(genes, encoding, cytobands)
        target = tmp_path / "phenogram.svg"
        fig.savefig(target, format="svg", bbox_inches="tight")
        svg = target.read_text(encoding="utf-8")
        assert svg.count('id="gene-') == 79
        # A gene symbol can carry a "/" (COL4A1/2); the gid is sanitized so
        # the id stays a valid XML Name.
        assert 'id="gene-COL4A1-2"' in svg
        assert "Supporting evidence" in svg
        assert "GWAS phenotypes" in svg
        assert "Perivascular spaces" in svg
        # Text stays text: real <text> elements, not glyph outlines. Comments
        # and gids carry the symbols regardless of svg.fonttype, so look for
        # the symbol as element content.
        assert svg.count("<text") >= 79
        assert re.search(r"<text[^>]*>(?:<tspan[^>]*>)?COL4A1/2<", svg)

    def test_main_writes_the_requested_formats(self, tmp_path: Path) -> None:
        code = main(["--out", str(tmp_path), "--format", "svg", "pdf", "--dpi", "72"])
        assert code == 0
        assert (tmp_path / "phenogram.svg").stat().st_size > 0
        assert (tmp_path / "phenogram.pdf").stat().st_size > 0
        assert not (tmp_path / "phenogram.png").exists()


class TestNormalization:
    """normalize_gene mirrors lib/data/genes.ts's normalizeGene (Important 2): a
    regenerated table1.json carrying stray whitespace or blank list entries
    must render the same pills and glyphs in print as it does on screen.
    """

    RAW_ROW = {
        "gene": "TESTGENE",
        "chromosomalLocation": " 7q31.1 ",
        "gwasTrait": ["WMH ", ""],
        "evidenceFromOtherOmicsStudies": [" proteomics"],
        "linkToMonogenicDisease": [],
        "mendelianRandomization": "Yes ",
    }

    def test_normalize_gene_trims_and_falls_back_like_lib_data_ts(self) -> None:
        row = normalize_gene(self.RAW_ROW)
        assert row["chromosomalLocation"] == "7q31.1"
        assert row["gwasTrait"] == ["WMH"]
        assert row["evidenceFromOtherOmicsStudies"] == ["proteomics"]
        assert row["linkToMonogenicDisease"] == ["(none found)"]
        assert row["mendelianRandomization"] == "Yes"

    def test_normalized_row_yields_one_wmh_pill_and_two_glyphs(self, encoding) -> None:
        row = normalize_gene(self.RAW_ROW)
        pills = pills_for(row, encoding)
        assert [p.label for p in pills] == ["WMH"]
        assert pills[0].family == "wmh"
        wmh_family = next(f for f in encoding["families"] if f["key"] == "wmh")
        assert pills[0].fill == wmh_family["tint"]
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
