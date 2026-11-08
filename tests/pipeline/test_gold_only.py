"""The gold-only switch as Python reads it, and the runs it refuses.

`pipeline.gold_only.gold_only` reads `GOLD_ONLY` out of lib/gold_only.ts, and
`pipeline.main` refuses the PubMed extraction and ClinicalTrials.gov
discovery while it is true. The guard is tested both ways round whatever the
committed switch says, so these hold before and after gold-only is undone.
"""

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

import pipeline.main as pipeline_main
from pipeline.gold_only import GOLD_ONLY_SOURCE, gold_only
from pipeline.main import _build_parser, _prepare_cli_args, _refuse_while_gold_only


def _source(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "gold_only.ts"
    path.write_text(text, encoding="utf-8")
    return path


@pytest.mark.parametrize(("literal", "expected"), [("true", True), ("false", False)])
def test_the_switch_is_read_from_its_declaration(
    tmp_path: Path, literal: str, expected: bool
) -> None:
    source = _source(
        tmp_path,
        "/** The switch. */\n"
        f"export const GOLD_ONLY = {literal};\n"
        'export const GOLD_DATA_DATE = "2026-11-06";\n',
    )
    assert gold_only(source) is expected


@pytest.mark.parametrize(
    "text",
    [
        "export const GOLD_ONLY = Deno.env.has('GOLD');\n",
        "export let GOLD_ONLY = true;\n",
        "// export const GOLD_ONLY = true;\n",
        "",
    ],
    ids=["computed", "let", "commented-out", "missing"],
)
def test_a_switch_that_is_not_a_bare_literal_is_refused(
    tmp_path: Path, text: str
) -> None:
    with pytest.raises(ValueError, match="GOLD_ONLY"):
        gold_only(_source(tmp_path, text))


def test_the_committed_switch_is_readable() -> None:
    assert GOLD_ONLY_SOURCE.name == "gold_only.ts"
    assert isinstance(gold_only(), bool)


def _args(argv: list[str]):
    parser = _build_parser()
    return parser, _prepare_cli_args(parser, parser.parse_args(argv))


@pytest.mark.parametrize(
    ("argv", "named"),
    [
        (["--pubmed"], "--pubmed"),
        ([], "--pubmed"),
        (["--export"], "--pubmed"),
        (["--clinical-trials"], "--clinical-trials"),
        (["--clinical-trials", "--export"], "--clinical-trials"),
        (["--pubmed", "--clinical-trials"], "--pubmed and --clinical-trials"),
        (["--sync-external-data", "--pubmed"], "--pubmed"),
    ],
    ids=[
        "pubmed",
        "bare",
        "bare-export",
        "clinical-trials",
        "clinical-trials-export",
        "both",
        "pubmed-beside-a-sync",
    ],
)
def test_gold_only_refuses_the_runs_that_add_rows(
    capsys: pytest.CaptureFixture[str], argv: list[str], named: str
) -> None:
    parser, args = _args(argv)
    with pytest.raises(SystemExit) as exit_info:
        _refuse_while_gold_only(parser, args, gold_only_on=True)
    assert exit_info.value.code == 2
    message = capsys.readouterr().err
    assert f"{named} refused" in message
    assert "GOLD_ONLY" in message
    assert "lib/gold_only.ts" in message
    assert "undo checklist" in message


@pytest.mark.parametrize(
    "argv",
    [
        ["--sync-external-data"],
        ["--sync-annotations"],
        ["--sync-external-data", "--export"],
        ["--sync-annotations", "--export"],
        ["--sync-external-data", "--sync-annotations", "--export"],
    ],
)
def test_gold_only_lets_the_syncs_and_the_export_run(argv: list[str]) -> None:
    parser, args = _args(argv)
    _refuse_while_gold_only(parser, args, gold_only_on=True)


@pytest.mark.parametrize(
    "argv", [[], ["--pubmed"], ["--clinical-trials", "--export"]]
)
def test_without_gold_only_nothing_is_refused(argv: list[str]) -> None:
    parser, args = _args(argv)
    _refuse_while_gold_only(parser, args, gold_only_on=False)


@pytest.mark.parametrize("switch", [True, False])
def test_main_reads_the_switch_before_running_anything(
    monkeypatch: pytest.MonkeyPatch, mocker, switch: bool
) -> None:
    run = mocker.patch(
        "pipeline.main._run_selected_pipelines", new=AsyncMock(return_value=0)
    )
    monkeypatch.setattr(pipeline_main, "gold_only", lambda: switch)
    monkeypatch.setattr(pipeline_main.sys, "argv", ["pipeline", "--clinical-trials"])

    if switch:
        with pytest.raises(SystemExit) as exit_info:
            pipeline_main.main()
        assert exit_info.value.code == 2
        run.assert_not_awaited()
    else:
        pipeline_main.main()
        run.assert_awaited_once()
