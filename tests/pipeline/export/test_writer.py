import json
import re
from pathlib import Path

import pytest

from pipeline.export.writer import to_camel, write_rows, write_value

_DATA_DIR = Path(__file__).resolve().parents[3] / "data"

# Which writer entry point emits each committed data/*.json. Ten come
# from pipeline/export/main.py's run_export, the eleventh
# (geocoded_trials.json) from pipeline/export/geocode.py -- so every file
# the export produces is covered here. The one committed file that is not
# the export's is named in _NOT_WRITER_PRODUCED below.
# test_every_committed_data_file_has_a_round_trip_case fails if a new file
# appears in data/ without an entry in one of the two, rather than letting
# the round-trip quietly cover less than the directory.
_COMMITTED_FILES: dict[str, str] = {
    "gene_annotations.json": "rows",
    "gene_info.json": "rows",
    "gene_info_table2.json": "rows",
    "geocoded_trials.json": "value",
    "omim_info.json": "rows",
    "pipeline_run.json": "value",
    "pipeline_status.json": "value",
    "pipeline_syncs.json": "value",
    "protein_info.json": "rows",
    "refs.json": "rows",
    "table1.json": "rows",
    "table2.json": "rows",
}

# data/cytobands_hg38.json is committed but is not the writer's output:
# scripts/fetch_cytobands.py writes it and `deno task cytobands` formats it
# with `deno fmt`, which is also what gates it -- `deno fmt --check .` covers
# data/ and runs in CI. Its bytes do happen to match write_value's today, but
# asserting that here would pin Deno's formatter from a test of the Python
# writer, and a Deno release that changed JSON style would fail the pipeline
# suite for a reason that has nothing to do with the pipeline. Listing it
# keeps the exhaustiveness check below honest: a genuinely new export file
# still has to be added to _COMMITTED_FILES.
_NOT_WRITER_PRODUCED = frozenset({"cytobands_hg38.json"})

_CAMEL_BOUNDARY = re.compile(r"(?<=[^A-Z])(?=[A-Z])")


def _display_name(camel_key: str) -> str:
    """Recover the display column name write_rows was handed for a key.

    write_rows camelCases every row key through to_camel, so a committed
    file's keys are that function's *output*: feeding them straight back
    re-mangles them (to_camel("chromosomalLocation") is
    "chromosomallocation"). Splitting on each capital inverts it --
    "chromosomalLocation" -> "chromosomal Location" -> back to
    "chromosomalLocation". Every round-trip case asserts the inversion
    held for its own keys, so a key shape this cannot invert fails the
    test instead of silently testing the wrong input.
    """
    return _CAMEL_BOUNDARY.sub(" ", camel_key)


def test_to_camel_lowercases_mid_name_acronyms() -> None:
    """'Registry ID' -> 'registryId', not 'registryID'."""
    assert to_camel("Registry ID") == "registryId"


def test_to_camel_returns_empty_for_separator_only_name() -> None:
    assert to_camel(" -- ") == ""


def test_empty_object_value_is_encoded_as_object(tmp_path: Path) -> None:
    path = tmp_path / "empty-object.json"

    write_rows([{"Metadata": {}}], path)

    assert json.loads(path.read_text()) == [{"metadata": {}}]
    assert to_camel("GWAS Trait") == "gwasTrait"
    assert to_camel("SVD Population Details") == "svdPopulationDetails"
    assert to_camel("Gene") == "gene"
    assert to_camel("Link to Monogenic Disease") == "linkToMonogenicDisease"


def test_write_rows_matches_the_committed_json_format(tmp_path: Path) -> None:
    """2-space indent, trailing newline, UTF-8 preserved."""
    path = tmp_path / "out.json"
    write_rows([{"Gene": "LAMB1", "GWAS Trait": ["(none found)"]}], path)
    raw = path.read_text(encoding="utf-8")
    assert raw.endswith("]\n")
    assert '\n  {\n    "gene": "LAMB1"' in raw
    assert json.loads(raw) == [{"gene": "LAMB1", "gwasTrait": ["(none found)"]}]


def test_single_element_lists_stay_arrays(tmp_path: Path) -> None:
    """The R I() invariant, now structural: a 1-element list is an array."""
    path = tmp_path / "out.json"
    write_rows([{"References": ["37063705"]}], path)
    assert json.loads(path.read_text())[0]["references"] == ["37063705"]


def test_slash_is_escaped_only_when_it_follows_a_left_angle_bracket(
    tmp_path: Path,
) -> None:
    """jsonlite's `</` -> `<\\/` rule, which json.dumps does not implement.

    Verified against jsonlite 2.0.0 directly: toJSON() emits "a/b" and
    "http://a/b" unescaped, "</b>" as "<\\/b>", and "<//x" as "<\\//x" --
    only the slash that actually follows the bracket. data/refs.json's
    formatted_ref column is HTML, so all 22 of its rows depend on this;
    the round-trip case for that file is the check against real data,
    and this one pins the rule itself, both writers included.
    """
    source = "<b>x</b> 1/2 http://a/b <//y"
    expected = r'"<b>x<\/b> 1/2 http://a/b <\//y"'

    rows_path = tmp_path / "rows.json"
    write_rows([{"Ref": source}], rows_path)
    assert f'"ref": {expected}' in rows_path.read_text(encoding="utf-8")

    value_path = tmp_path / "value.json"
    write_value({source: source}, value_path)
    assert f"{expected}: {expected}" in value_path.read_text(encoding="utf-8")


def test_write_value_emits_bare_null(tmp_path: Path) -> None:
    path = tmp_path / "status.json"
    write_value(None, path)
    assert path.read_text(encoding="utf-8") == "null\n"


def test_non_ascii_is_preserved_not_escaped(tmp_path: Path) -> None:
    path = tmp_path / "out.json"
    write_rows([{"City": "Zürich"}], path)
    assert "Zürich" in path.read_text(encoding="utf-8")


def test_scalar_array_is_inlined_in_write_rows(tmp_path: Path) -> None:
    """jsonlite's pretty=TRUE keeps a scalar array on one line; a bare
    json.dumps(indent=2) would explode it across three lines instead."""
    path = tmp_path / "out.json"
    write_rows(
        [{"Gene": "LAMB1", "GWAS Trait": ["(none found)"], "City": "Paris"}],
        path,
    )
    raw = path.read_text(encoding="utf-8")
    assert '    "gwasTrait": ["(none found)"],' in raw


def test_multi_element_scalar_array_uses_comma_space_separator(
    tmp_path: Path,
) -> None:
    """Matches data/table1.json's own references column exactly."""
    path = tmp_path / "out.json"
    write_rows([{"References": ["37063705", "34606115"]}], path)
    raw = path.read_text(encoding="utf-8")
    assert '    "references": ["37063705", "34606115"]' in raw


def test_write_value_still_expands_scalar_arrays(tmp_path: Path) -> None:
    """Regression guard: write_value and write_rows now deliberately differ.

    write_value's one caller with array content (geocoded_trials.json)
    already expands arrays one element per line -- plain json.dumps(indent=2)
    behaviour -- and must keep doing so.
    """
    path = tmp_path / "status.json"
    write_value({"nctIds": ["NCT05755997", "NCT06530537"]}, path)
    raw = path.read_text(encoding="utf-8")
    assert '"nctIds": [\n    "NCT05755997",\n    "NCT06530537"\n  ]' in raw


def test_scalar_array_expands_past_the_inline_width_threshold(
    tmp_path: Path,
) -> None:
    """A real boundary pair measured out of data/table1.json: a candidate
    line of 79 columns stays inline, one of 80 columns expands instead.

    Width = 4-space indent + '"key": [' + ", ".join(encoded elements) + ']',
    trailing comma excluded from the measurement. This is not a synthetic
    threshold -- it is the exact split jsonlite's own output shows, with no
    exceptions anywhere in the committed file.
    """
    path = tmp_path / "out.json"
    write_rows(
        [
            {
                # 79 columns inline (data/table1.json line 44).
                "Evidence From Other Omics Studies": [
                    "TWAS;cross tissue",
                    "PWAS;brain tissue",
                ]
            },
            {
                # 80 columns if inlined -- expands instead (line ~518).
                "Link to Monogenic Disease": [
                    "125310",
                    "621295",
                    "615293",
                    "130720",
                    "608600",
                ]
            },
        ],
        path,
    )
    raw = path.read_text(encoding="utf-8")
    assert (
        '"evidenceFromOtherOmicsStudies": ["TWAS;cross tissue", "PWAS;brain tissue"]'
    ) in raw
    assert (
        '"linkToMonogenicDisease": [\n'
        '      "125310",\n'
        '      "621295",\n'
        '      "615293",\n'
        '      "130720",\n'
        '      "608600"\n'
        "    ]"
    ) in raw


# Display-column names clean_table1.R actually produces, in the committed
# file's own key order -- see data-prep/clean_table1.R:32-34 for the initial
# rename and :142-154 for the two post-hoc renames baked into these final
# names. to_camel is not idempotent on already-camelCase input
# (to_camel("chromosomalLocation") loses its inner capital), so reproducing
# the file requires feeding write_rows these display names, not the file's
# own camelCase keys.
_TABLE1_DISPLAY_NAMES = {
    "gene": "Gene",
    "protein": "Protein",
    "chromosomalLocation": "Chromosomal Location",
    "gwasTrait": "GWAS Trait",
    "mendelianRandomization": "Mendelian Randomization",
    "evidenceFromOtherOmicsStudies": "Evidence From Other Omics Studies",
    "linkToMonogenicDisease": "Link to Monogenic Disease",
    "brainCellTypes": "Brain Cell Types",
    "affectedPathway": "Affected Pathway",
    "references": "References",
    "sourceQuote": "Source Quote",
    "confidence": "Confidence",
}


def test_write_rows_reproduces_committed_table1_byte_for_byte(
    tmp_path: Path,
) -> None:
    """The fidelity check Task 10 performs, run here against real data.

    Every row of the committed data/table1.json is mapped back to its
    display-name keys and round-tripped through write_rows; the emitted
    text must equal the committed bytes exactly. json.loads()-based
    equality would not catch either the original all-expanded defect or the
    later always-inlined one, since both are invisible once parsed.
    """
    repo_root = Path(__file__).resolve().parents[3]
    committed_text = (repo_root / "data" / "table1.json").read_text(encoding="utf-8")
    committed_rows = json.loads(committed_text)

    all_keys = {key for row in committed_rows for key in row}
    assert all_keys == set(_TABLE1_DISPLAY_NAMES), (
        "data/table1.json's columns no longer match this test's "
        "display-name map -- update _TABLE1_DISPLAY_NAMES from "
        "pipeline/export/tables.py"
    )

    display_rows = [
        {_TABLE1_DISPLAY_NAMES[key]: value for key, value in row.items()}
        for row in committed_rows
    ]

    out_path = tmp_path / "table1.json"
    write_rows(display_rows, out_path)

    assert out_path.read_text(encoding="utf-8") == committed_text


def test_nested_array_uses_the_true_rendered_width(tmp_path: Path) -> None:
    """Regression: an array nested directly inside another array must be
    measured against its real indent, not a blank default prefix.

    A scalar-only inner array is a width-inlining candidate in its own
    right. If the enclosing array's expand branch forgets to pass down the
    indent that will actually precede it on the page, the width check
    under-counts and can inline something whose true rendered line is over
    the threshold -- exactly the bug this pins.
    """
    path = tmp_path / "out.json"
    long_value = "A" * 72
    write_rows([{"D": [[long_value]]}], path)
    raw = path.read_text(encoding="utf-8")
    assert (f'"d": [\n      [\n        "{long_value}"\n      ]\n    ]') in raw
    # The buggy (wrongly inlined) shape must never appear.
    assert f'["{long_value}"]' not in raw


def test_array_containing_a_dict_always_expands(tmp_path: Path) -> None:
    """The non-scalar-array guard: an array holding a dict routes to the
    expand branch regardless of width, never the inline one."""
    path = tmp_path / "out.json"
    write_rows([{"X": [{"a": 1}]}], path)
    raw = path.read_text(encoding="utf-8")
    assert '"x": [\n      {\n        "a": 1\n      }\n    ]' in raw


def test_empty_array_renders_as_brackets_not_malformed(tmp_path: Path) -> None:
    """An empty list is vacuously scalar-only and must render as "[]", not
    the malformed "[\\n\\n]" an unguarded expand branch would produce."""
    path = tmp_path / "out.json"
    write_rows([{"Tags": []}], path)
    raw = path.read_text(encoding="utf-8")
    assert '"tags": []' in raw


def test_every_committed_data_file_has_a_round_trip_case() -> None:
    """The byte-identity gate must cover data/ exhaustively, not partially.

    The `</` escaping defect that reached final review was invisible for
    the whole branch because the byte-exact tests named table1.json and
    omim_info.json by hand, and refs.json -- the only committed file
    whose content exercises string escaping at all -- was not among them.
    Pinning the parametrisation to the directory listing is what stops
    that from recurring.
    """
    assert {p.name for p in _DATA_DIR.glob("*.json")} == (
        set(_COMMITTED_FILES) | _NOT_WRITER_PRODUCED
    )


@pytest.mark.parametrize("name", sorted(_COMMITTED_FILES))
def test_committed_data_round_trips_through_the_writer_byte_for_byte(
    name: str, tmp_path: Path
) -> None:
    """Parse each committed data/*.json, re-encode it, compare the bytes.

    This is the offline half of the byte-fidelity gate: no database, no
    network, no credentials -- the writer's output format is verifiable
    against real data on its own. json.loads()-based equality would pass
    on every defect this can catch, because indentation, inline-array
    width and `/` escaping are all invisible once parsed.
    """
    committed = _DATA_DIR / name
    committed_text = committed.read_text(encoding="utf-8")
    parsed = json.loads(committed_text)

    out_path = tmp_path / name
    if _COMMITTED_FILES[name] == "rows":
        rows = [
            {_display_name(key): value for key, value in row.items()} for row in parsed
        ]
        for row, source in zip(rows, parsed, strict=True):
            assert [to_camel(k) for k in row] == list(source), (
                f"{name}: a key in this file does not survive the "
                "display-name inversion _display_name performs, so the "
                "round-trip would test the wrong input -- see its docstring"
            )
        write_rows(rows, out_path)
    else:
        write_value(parsed, out_path)

    assert out_path.read_text(encoding="utf-8") == committed_text
