"""`deno task data:empty` writes the export's empty shape with no database."""

import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path

import pytest

from pipeline.export.empty import EMPTY_FILES, UNTOUCHED, main, write_empty_export
from pipeline.export.omim import read_omim_csv
from pipeline.export.writer import write_rows, write_value

_DATA_DIR = Path(__file__).resolve().parents[3] / "data"
_NOW = datetime(2026, 9, 20, 12, 0, 0, tzinfo=UTC)
# to_camel is not idempotent (see test_writer.py's _display_name), so a row
# file's keys are split back into display names before re-encoding.
_CAMEL_BOUNDARY = re.compile(r"(?<=[^A-Z])(?=[A-Z])")


def test_the_empty_export_covers_every_committed_file_but_the_cytobands() -> None:
    """The set is pinned to the directory listing, the way test_writer.py pins
    its round-trip cases: a file added to data/ without an empty shape fails
    here rather than shipping cSVD rows into a fork."""
    committed = {p.name for p in _DATA_DIR.glob("*.json")}
    assert committed == EMPTY_FILES | UNTOUCHED
    assert {"cytobands_hg38.json"} == UNTOUCHED


def test_write_empty_export_writes_exactly_the_empty_set(tmp_path: Path) -> None:
    written = write_empty_export(tmp_path, now=_NOW)
    assert set(written) == EMPTY_FILES
    assert {p.name for p in tmp_path.glob("*.json")} == EMPTY_FILES
    assert all(path == tmp_path / name for name, path in written.items())


@pytest.mark.parametrize("name", sorted(EMPTY_FILES))
def test_each_empty_file_round_trips_byte_for_byte(name: str, tmp_path: Path) -> None:
    """Same gate as test_writer.py: parse, re-encode, compare bytes."""
    write_empty_export(tmp_path / "out", now=_NOW)
    text = (tmp_path / "out" / name).read_text(encoding="utf-8")
    parsed = json.loads(text)
    again = tmp_path / name
    if isinstance(parsed, list):
        rows = [
            {_CAMEL_BOUNDARY.sub(" ", key): value for key, value in row.items()}
            for row in parsed
        ]
        write_rows(rows, again)
    else:
        write_value(parsed, again)
    assert again.read_text(encoding="utf-8") == text


def test_row_tables_are_empty_arrays_and_run_files_are_null(tmp_path: Path) -> None:
    write_empty_export(tmp_path, now=_NOW)
    for name in (
        "table1.json",
        "table2.json",
        "gene_info.json",
        "gene_info_table2.json",
        "protein_info.json",
        "refs.json",
        "gene_annotations.json",
        "pipeline_syncs.json",
    ):
        assert (tmp_path / name).read_text(encoding="utf-8") == "[]\n", name
    for name in ("pipeline_status.json", "pipeline_run.json"):
        assert (tmp_path / name).read_text(encoding="utf-8") == "null\n", name


def test_gene_annotations_is_emptied_not_skipped(tmp_path: Path) -> None:
    """The database export keeps a committed gene_annotations.json when its
    table is empty; the empty export must not, or a fork ships cSVD
    annotations."""
    (tmp_path / "gene_annotations.json").write_text('[{"geneSymbol": "X"}]\n')
    write_empty_export(tmp_path, now=_NOW)
    assert (tmp_path / "gene_annotations.json").read_text() == "[]\n"


def test_geocoded_trials_carries_the_generation_time(tmp_path: Path) -> None:
    write_empty_export(tmp_path, now=_NOW)
    payload = json.loads((tmp_path / "geocoded_trials.json").read_text())
    assert payload == {
        "nctIds": [],
        "generatedAt": "2026-09-20T12:00:00Z",
        "locations": [],
    }
    assert list(payload) == ["nctIds", "generatedAt", "locations"]


def test_the_generation_time_defaults_to_now(tmp_path: Path) -> None:
    before = datetime.now(UTC).replace(microsecond=0)
    write_empty_export(tmp_path)
    stamp = json.loads((tmp_path / "geocoded_trials.json").read_text())["generatedAt"]
    assert datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC) >= before


def test_omim_info_comes_from_the_disease_csv(tmp_path: Path) -> None:
    write_empty_export(tmp_path, now=_NOW)
    expected = tmp_path / "expected.json"
    write_rows(read_omim_csv(), expected)
    assert (tmp_path / "omim_info.json").read_bytes() == expected.read_bytes()


def test_the_cytobands_are_left_untouched(tmp_path: Path) -> None:
    sentinel = tmp_path / "cytobands_hg38.json"
    sentinel.write_text('{"assembly": "hg38"}\n')
    write_empty_export(tmp_path, now=_NOW)
    assert sentinel.read_text() == '{"assembly": "hg38"}\n'


def test_write_empty_export_creates_the_target_directory(tmp_path: Path) -> None:
    target = tmp_path / "fresh" / "data"
    write_empty_export(target, now=_NOW)
    assert (target / "table1.json").exists()


def test_main_writes_into_the_given_directory(tmp_path: Path, caplog) -> None:
    caplog.set_level(logging.INFO)
    main(["--target", str(tmp_path)])
    assert (tmp_path / "table2.json").read_text() == "[]\n"
    assert "12 files" in caplog.text
    assert "cytobands_hg38.json" in caplog.text
