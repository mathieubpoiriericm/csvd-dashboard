"""The cSVD karyogram, pinned: the 22 chromosomes, 114 blocks, CENPF's row.

The numbers here are the ones tests/csvd/phenogram_layout_test.ts pins for
lib/phenogram.ts over the committed cSVD genes. The rules that hold for any
dataset are in tests/scripts/test_phenogram_figure.py; a fork deletes this
tree.
"""

import re
from pathlib import Path

import pytest
from scripts.phenogram_figure import (
    DEFAULT_CYTOBANDS,
    DEFAULT_GENES,
    block_height,
    compute_layout,
    draw,
    glyphs_for,
    load_cytobands,
    load_encoding,
    load_genes,
    main,
    pills_for,
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
    "12",
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
    return load_encoding()


@pytest.fixture(scope="module")
def layout(genes, encoding, cytobands):
    return compute_layout(genes, encoding, cytobands)


def by_gene(layout, symbol: str):
    return next(block for block in layout.blocks if block.symbol == symbol)


class TestPlacement:
    def test_every_placeable_gene_is_placed_on_twenty_two_chromosomes(
        self, layout
    ) -> None:
        # The gold-only switch publishes the hand-curated table, which puts
        # genes on 12 and 18 as well and writes MSMP's band as "9q13.3", which
        # hg38 does not have: gold is published verbatim, so MSMP is left off
        # the figure. Mirrored in tests/csvd/phenogram_layout_test.ts.
        assert len(layout.blocks) == 114
        assert [
            f"{g['gene']} {g['chromosomalLocation']}" for g in layout.unplaced
        ] == ["MSMP 9q13.3"]
        assert [c.name for c in layout.chromosomes] == DRAWN

    def test_the_canvas_row_split_and_wide_columns_are_pinned(self, layout) -> None:
        """The numbers tests/csvd/phenogram_layout_test.ts pins for
        lib/phenogram.ts, so the two renderers cannot drift apart. Before the
        canvas was derived it was a fixed 1732x1640 split after 10."""
        assert layout.canvas == (1848, 1379)
        assert [[c.name for c in row] for row in layout.rows] == [
            DRAWN[:11],
            DRAWN[11:],
        ]
        assert {
            c.name: c.column_width for c in layout.chromosomes if c.column_width != 128
        } == {"2": 172, "5": 156, "10": 172, "13": 172, "19": 172}
        assert sum(b.x + b.y + b.width + b.height for b in layout.blocks) == (
            pytest.approx(164469.93730683517, abs=1e-6)
        )

    def test_the_rasters_errors_are_gone(self, layout) -> None:
        assert by_gene(layout, "ABO").chromosome == "9"
        assert by_gene(layout, "APOE").chromosome == "19"
        assert by_gene(layout, "C6orf195").chromosome == "6"
        assert by_gene(layout, "COL4A1/2").chromosome == "13"

    def test_cenpf_marker_position_is_pinned(self, layout) -> None:
        """Absolute numbers computed from the TypeScript layout
        (computePhenogramLayout in lib/phenogram.ts, over the committed
        genes) and pinned in both suites, so the print twin and the browser
        renderer cannot silently drift apart. Mirrored in
        tests/csvd/phenogram_layout_test.ts.
        """
        cenpf = by_gene(layout, "CENPF")
        assert cenpf.marker_y == pytest.approx(699.0086508393023)
        assert cenpf.y == pytest.approx(572)


class TestEncoding:
    def test_pills_and_glyphs_follow_the_evidence_columns(
        self, layout, genes, encoding
    ) -> None:
        cenpf = by_gene(layout, "CENPF")
        assert [p.label for p in cenpf.pills] == ["WM-PVS", "HIP-PVS", "PSMD"]
        # Gold gives CENPF no other-omics entry, so the omics glyph is gone.
        assert [g.key for g in cenpf.glyphs] == ["monogenic"]
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
        # LAMB1 carries gold's OMIM 621424, so it has the monogenic glyph.
        lamb1 = next(g for g in genes if g["gene"] == "LAMB1")
        assert [g.key for g in glyphs_for(lamb1, encoding)] == ["monogenic"]


class TestRender:
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
        assert svg.count('id="gene-') == 114
        # A gene symbol can carry a "/" (COL4A1/2); the gid is sanitized so
        # the id stays a valid XML Name.
        assert 'id="gene-COL4A1-2"' in svg
        assert "Perivascular spaces" in svg
        # Text stays text: real <text> elements, not glyph outlines. Comments
        # and gids carry the symbols regardless of svg.fonttype, so look for
        # the symbol as element content.
        assert svg.count("<text") >= 114
        assert re.search(r"<text[^>]*>(?:<tspan[^>]*>)?COL4A1/2<", svg)

    def test_main_draws_the_committed_figure(self, tmp_path: Path) -> None:
        code = main(["--out", str(tmp_path), "--format", "svg", "pdf", "--dpi", "72"])
        assert code == 0
        assert (tmp_path / "phenogram.svg").stat().st_size > 0
        assert (tmp_path / "phenogram.pdf").stat().st_size > 0
        assert not (tmp_path / "phenogram.png").exists()
