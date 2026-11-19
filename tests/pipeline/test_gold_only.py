"""The gold-only switch as Python reads it, and the runs it refuses.

`pipeline.gold_only.gold_only` reads `GOLD_ONLY` out of lib/gold_only.ts, and
`pipeline.main` refuses the PubMed extraction and ClinicalTrials.gov
discovery while it is true. The guard is tested both ways round whatever the
committed switch says, so these hold before and after gold-only is undone.
"""

import argparse
import inspect
import itertools
import re
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


@pytest.mark.parametrize(
    "argv",
    [
        ["--preview"],
        ["--pubmed", "--preview", "--days-back", "365"],
        ["--preview", "--test-mode"],
    ],
)
def test_gold_only_lets_a_preview_run_through(argv: list[str]) -> None:
    parser, args = _args(argv)
    _refuse_while_gold_only(parser, args, gold_only_on=True)  # no SystemExit


@pytest.mark.parametrize(
    "argv",
    [
        ["--preview", "--clinical-trials"],
        ["--preview", "--sync-annotations"],
        ["--preview", "--sync-external-data"],
        ["--preview", "--pmids", "f"],
        ["--preview", "--local-pdfs", "d"],
    ],
)
def test_a_preview_run_is_the_pubmed_pipeline_alone(argv: list[str]) -> None:
    parser = _build_parser()
    with pytest.raises(SystemExit):
        _prepare_cli_args(parser, parser.parse_args(argv))


def test_without_gold_only_a_preview_run_is_refused() -> None:
    parser, args = _args(["--preview"])
    with pytest.raises(SystemExit):
        _refuse_while_gold_only(parser, args, gold_only_on=False)


def test_a_namespace_without_the_flag_is_still_refused() -> None:
    # scripts.backfill_pubmed builds its own namespace.
    args = argparse.Namespace(pubmed=True, clinical_trials=False)
    with pytest.raises(SystemExit):
        _refuse_while_gold_only(_build_parser(), args, gold_only_on=True)


def _expected_refusal(
    *,
    local_pdfs: bool,
    pmids: bool,
    pubmed: bool,
    clinical_trials: bool,
    sync_external_data: bool,
    sync_annotations: bool,
    preview: bool,
    skip_validation: bool,
    export: bool,
    gold_only_on: bool,
) -> str | None:
    """The rules as written down, first match wins; None means not refused.

    Deliberately shares nothing with pipeline.main: it is a second statement
    of the same rules, and the test fails where the two disagree.
    """
    offline = local_pdfs or pmids
    online = pubmed or clinical_trials or sync_external_data or sync_annotations
    if local_pdfs and pmids:
        return "--local-pdfs and --pmids cannot be combined"
    if offline and online:
        return "cannot be combined with --pubmed"
    if preview and (
        offline or clinical_trials or sync_external_data or sync_annotations
    ):
        return "--preview runs the PubMed pipeline alone"
    if skip_validation and not offline:
        return "--skip-validation requires"
    if export and offline:
        return "--export cannot be combined"
    if preview and not gold_only_on:
        return "--preview refused"
    pubmed_selected = pubmed or not (offline or online)
    if gold_only_on and (clinical_trials or (pubmed_selected and not preview)):
        return "refused: GOLD_ONLY is true"
    return None


_MODE_FLAGS = (
    "local_pdfs",
    "pmids",
    "pubmed",
    "clinical_trials",
    "sync_external_data",
    "sync_annotations",
    "preview",
    "skip_validation",
    "export",
)


def test_every_combination_of_modes_is_refused_or_run_as_the_rules_say(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    parser = _build_parser()
    wrong: list[str] = []
    for gold_only_on in (True, False):
        for values in itertools.product((False, True), repeat=len(_MODE_FLAGS)):
            on = dict(zip(_MODE_FLAGS, values, strict=True))
            argv: list[str] = []
            for name in _MODE_FLAGS:
                if not on[name]:
                    continue
                flag = "--" + name.replace("_", "-")
                argv.append(flag)
                if name == "local_pdfs":
                    argv.append(str(tmp_path))
                elif name == "pmids":
                    argv.append(str(tmp_path / "pmids.txt"))
            expected = _expected_refusal(**on, gold_only_on=gold_only_on)
            capsys.readouterr()
            refused: str | None = None
            try:
                args = _prepare_cli_args(parser, parser.parse_args(argv))
                _refuse_while_gold_only(parser, args, gold_only_on=gold_only_on)
            except SystemExit as exit_info:
                assert exit_info.code == 2
                refused = capsys.readouterr().err
            where = f"{' '.join(argv) or '(no flags)'} with gold_only_on={gold_only_on}"
            if expected is None:
                if refused is not None:
                    wrong.append(f"{where}: table says run, refused with {refused!r}")
            elif refused is None:
                wrong.append(f"{where}: table says refused ({expected!r}), it ran")
            elif expected not in refused:
                wrong.append(f"{where}: table says {expected!r}, got {refused!r}")
    assert not wrong, f"{len(wrong)} of 1024 command lines disagree:\n" + "\n".join(
        wrong[:20]
    )


def test_the_mode_table_knows_every_mode_flag() -> None:
    source = inspect.getsource(_prepare_cli_args)
    found: set[str] = set()
    for tuple_name in ("offline_modes", "online_modes"):
        match = re.search(rf"{tuple_name} = \((.*?)\)", source, re.DOTALL)
        assert match, f"{tuple_name} is gone from _prepare_cli_args; update this test"
        found |= set(re.findall(r"args\.(\w+)", match.group(1)))
    assert found == {
        "local_pdfs",
        "pmids",
        "pubmed",
        "clinical_trials",
        "sync_external_data",
        "sync_annotations",
    }, (
        f"_prepare_cli_args now names {sorted(found)} as modes: add the new mode"
        " to _MODE_FLAGS and _expected_refusal in"
        " test_every_combination_of_modes_is_refused_or_run_as_the_rules_say"
    )
