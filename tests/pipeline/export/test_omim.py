"""Tests for pipeline.export.omim -- the static OMIM CSV reader ported from
export.R step 7.

The first two tests cover the encoding: the committed CSV is UTF-8, the
reader still folds a correctly-encoded non-breaking space, and a Mac Roman
re-paste fails loudly rather than being admitted. The byte-identity test is
the real-data fidelity proof: the actual committed CSV, read by this module
and re-serialized by write_rows, must reproduce the committed
data/omim_info.json exactly.
"""

import json
from pathlib import Path
from typing import Final

import pytest

from pipeline.export.omim import DEFAULT_OMIM_CSV, read_omim_csv
from pipeline.export.writer import write_rows

_REPO_ROOT = Path(__file__).resolve().parents[3]


_HEADER: Final[bytes] = (
    b"omim_num,omim_link,phenotype,inheritance,gene_or_locus,"
    b"gene_or_locus_mim_number\n"
)


def test_omim_csv_folds_a_utf8_non_breaking_space(tmp_path: Path) -> None:
    """OMIM's site is the source, so a nbsp is the next thing to arrive.

    The committed CSV no longer carries one -- the seven it had were folded
    at the source when the file was normalized to UTF-8 -- but a correctly
    encoded U+00A0 still collapses, including when it sits beside an
    ordinary space, which .strip() alone would leave as a double space.
    """
    path = tmp_path / "omim.csv"
    path.write_bytes(
        _HEADER
        + "617168,https://omim.org/entry/617168,"
        "Aortic\xa0 aneurysm,AD,LOX,153455\n".encode()
    )
    rows = read_omim_csv(path)
    assert rows[0]["phenotype"] == "Aortic aneurysm"
    assert rows[0]["omim_num"] == 617168
    assert rows[0]["gene_or_locus_mim_number"] == "153455"


def test_omim_csv_rejects_a_mac_roman_repaste(tmp_path: Path) -> None:
    """A bare 0xCA is not UTF-8, and the reader must say so.

    The old reader decoded Mac Roman, which admitted this byte silently;
    latin-1 would have turned it into a visible "E-circumflex". Failing is
    what keeps the repository single-encoding.
    """
    path = tmp_path / "omim.csv"
    path.write_bytes(
        _HEADER
        + b"617168,https://omim.org/entry/617168,Aortic\xca aneurysm,AD,LOX,153455\n"
    )
    with pytest.raises(UnicodeDecodeError):
        read_omim_csv(path)


def test_the_committed_csv_is_pure_ascii() -> None:
    """The normalization is the fix; this is what keeps it fixed."""
    assert DEFAULT_OMIM_CSV.read_bytes().decode("utf-8").isascii()


def test_omim_csv_round_trips_byte_identical_to_the_committed_json(
    tmp_path: Path,
) -> None:
    """Real-data fidelity proof for one ninth of the export: read the
    actual committed CSV, write it back out with the real writer, and
    diff against the actual committed JSON. No mocks, no fixtures.
    """
    rows = read_omim_csv(DEFAULT_OMIM_CSV)
    out = tmp_path / "omim_info.json"
    write_rows(rows, out)

    committed = _REPO_ROOT / "data" / "omim_info.json"
    assert out.read_bytes() == committed.read_bytes()


def test_default_path_points_at_the_committed_csv() -> None:
    assert DEFAULT_OMIM_CSV.name == "omim_info.csv"
    assert DEFAULT_OMIM_CSV.is_file()


def test_the_csv_lives_in_the_disease_directory() -> None:
    from pipeline.disease import OMIM_CSV_PATH

    assert DEFAULT_OMIM_CSV == OMIM_CSV_PATH
    assert DEFAULT_OMIM_CSV.parent.name == "disease"


def test_missing_fields_become_empty_strings_not_a_sentinel(tmp_path: Path) -> None:
    """Mirrors the real CSV's row 575553: an OMIM number with no
    associated phenotype/inheritance/gene data yet. export.R's
    read.csv() leaves these NA, which jsonlite serializes as "" once
    passed through normalize_text_columns's blank-to-NA pass reversed by
    write_json's na="null" -- but this column is read straight off
    read.csv() without going through normalize_text_columns, so a blank
    field is an empty string, not the "(unknown)"/"(none found)"
    sentinels used elsewhere in the export.
    """
    path = tmp_path / "omim.csv"
    path.write_bytes(
        b"omim_num,omim_link,phenotype,inheritance,gene_or_locus,"
        b"gene_or_locus_mim_number\n"
        b"575553,https://omim.org/entry/575553,,,,\n"
    )
    rows = read_omim_csv(path)
    assert rows[0] == {
        "omim_num": 575553,
        "omim_link": "https://omim.org/entry/575553",
        "phenotype": "",
        "inheritance": "",
        "gene_or_locus": "",
        "gene_or_locus_mim_number": "",
    }


def test_semicolon_joined_multi_gene_rows_stay_plain_strings(tmp_path: Path) -> None:
    """One OMIM number can map to several genes/phenotypes, semicolon
    joined in the source (e.g. real row 617347). Unlike the genes and
    trials tables, this is not a list-column: the joined string passes
    through untouched.
    """
    path = tmp_path / "omim.csv"
    path.write_bytes(
        b"omim_num,omim_link,phenotype,inheritance,gene_or_locus,"
        b"gene_or_locus_mim_number\n"
        b"617347,https://omim.org/entry/617347,Pheno A;Pheno B,,APOE;APOE,"
        b"107741;107741\n"
    )
    rows = read_omim_csv(path)
    assert rows[0]["gene_or_locus"] == "APOE;APOE"
    assert rows[0]["gene_or_locus_mim_number"] == "107741;107741"
    assert isinstance(rows[0]["gene_or_locus_mim_number"], str)


def test_omim_num_is_a_number_gene_or_locus_mim_number_is_a_string(
    tmp_path: Path,
) -> None:
    """tests/data_contract_test.ts pins this: omimNum is a JSON number,
    every other field -- including the numeric-looking MIM number -- is
    a string.
    """
    path = tmp_path / "omim.csv"
    path.write_bytes(
        b"omim_num,omim_link,phenotype,inheritance,gene_or_locus,"
        b"gene_or_locus_mim_number\n"
        b"617168,https://omim.org/entry/617168,Aortic aneurysm,AD,LOX,153455\n"
    )
    rows = read_omim_csv(path)
    assert rows[0]["omim_num"] == 617168
    assert isinstance(rows[0]["omim_num"], int)
    assert rows[0]["gene_or_locus_mim_number"] == "153455"
    assert isinstance(rows[0]["gene_or_locus_mim_number"], str)


def test_write_rows_produces_the_contract_key_order(tmp_path: Path) -> None:
    """data/omim_info.json's key order is omimNum, omimLink, phenotype,
    inheritance, geneOrLocus, geneOrLocusMimNumber -- the same order
    _COLUMNS is declared in, since write_rows preserves dict insertion
    order verbatim.
    """
    rows = read_omim_csv(DEFAULT_OMIM_CSV)
    if not rows:
        pytest.skip("disease/omim_info.csv has no rows -- nothing to pin against")
    out = tmp_path / "omim_info.json"
    write_rows(rows, out)
    first = json.loads(out.read_text(encoding="utf-8"))[0]
    assert list(first.keys()) == [
        "omimNum",
        "omimLink",
        "phenotype",
        "inheritance",
        "geneOrLocus",
        "geneOrLocusMimNumber",
    ]
