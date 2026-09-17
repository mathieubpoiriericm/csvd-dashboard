"""Unit tests for scripts/fetch_cytobands.py."""

import gzip
import json
from pathlib import Path

import pytest
from scripts.fetch_cytobands import (
    CHROMOSOMES,
    OUTPUT,
    SOURCE,
    build_table,
    main,
    parse_cytobands,
)

CHR1 = [
    "chr1\t2300000\t5300000\tp36.32\tgpos25",
    "chr1\t0\t2300000\tp36.33\tgneg",
    "chr1\t123400000\t125100000\tp11.1\tacen",
    "chr1\t125100000\t143200000\tq11\tacen",
    "chr1\t143200000\t248956422\tq12\tgvar",
]
NOISE = [
    "chr1_KI270706v1_random\t0\t175055\t\tgneg",
    "chrUn_KI270302v1\t0\t2274\t\tgneg",
    "chrM\t0\t16569\t\tgneg",
    "",
]


def complete_rows() -> list[str]:
    """CHR1 in detail, one band for every other chromosome, plus noise."""
    others = [
        f"chr{name}\t0\t5000000\tq11\tgneg" for name in CHROMOSOMES if name != "1"
    ]
    return CHR1 + others + NOISE


class TestParse:
    def test_orders_bands_and_drops_other_contigs(self) -> None:
        chromosomes = parse_cytobands("\n".join(complete_rows()))
        assert [c["name"] for c in chromosomes] == CHROMOSOMES
        chr1 = chromosomes[0]
        assert chr1["length"] == 248956422
        assert [b["name"] for b in chr1["bands"]] == [
            "p36.33",
            "p36.32",
            "p11.1",
            "q11",
            "q12",
        ]
        assert chr1["bands"][1] == {
            "name": "p36.32",
            "start": 2300000,
            "end": 5300000,
            "stain": "gpos25",
        }
        assert all(len(c["bands"]) == 1 for c in chromosomes[1:])

    def test_a_missing_chromosome_is_left_out(self) -> None:
        assert [c["name"] for c in parse_cytobands("\n".join(CHR1))] == ["1"]


class TestBuildTable:
    def test_records_assembly_and_source(self) -> None:
        table = build_table("\n".join(complete_rows()), "file:///sample")
        assert table["assembly"] == "hg38"
        assert table["source"] == "file:///sample"
        assert len(table["chromosomes"]) == 24

    def test_refuses_an_incomplete_genome(self) -> None:
        with pytest.raises(ValueError, match="chr2"):
            build_table("\n".join(CHR1))


class TestMain:
    def test_writes_the_table_from_a_gzipped_source(self, tmp_path: Path) -> None:
        source = tmp_path / "cytoBandIdeo.txt.gz"
        source.write_bytes(gzip.compress("\n".join(complete_rows()).encode()))
        out = tmp_path / "cytobands.json"
        assert main(["--source", source.as_uri(), "--out", str(out)]) == 0
        table = json.loads(out.read_text())
        assert table["source"] == source.as_uri()
        assert [c["name"] for c in table["chromosomes"]] == CHROMOSOMES


def test_the_committed_table_is_the_generator_output_shape() -> None:
    table = json.loads(OUTPUT.read_text(encoding="utf-8"))
    assert table["assembly"] == "hg38"
    assert table["source"] == SOURCE
    assert [c["name"] for c in table["chromosomes"]] == CHROMOSOMES
    assert sum(len(c["bands"]) for c in table["chromosomes"]) == 862
    chr13 = next(c for c in table["chromosomes"] if c["name"] == "13")
    assert chr13["length"] == 114364328
