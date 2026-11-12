"""Skip machinery for the gitignored inputs of test_extraction_golden.py.

This tree holds the cSVD regression tests -- the ones that name cSVD genes,
papers and measured numbers -- and a fork deletes it whole (`git rm -r
tests/pipeline/csvd`). The hook below exists only for the golden extraction
suite, so it lives here rather than in the root conftest, which stays
disease-neutral. The root conftest's fixtures still apply: pytest loads every
conftest on the path from the rootdir down.
"""

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any, Final

import pytest

from pipeline.anthropic_client import AnthropicClient
from pipeline.quality_metrics import TokenUsage

# The seven full-text paper fixtures are publisher text and the golden
# cassettes embed them, so neither is committed (see .gitignore). The manifest
# beside the fixtures is: it lists the seven PMIDs and the hash of the text the
# cassettes were recorded against, and scripts/fetch_paper_fixtures.py writes
# the fixtures from it. CI and a fresh clone have neither, and must skip the
# tests that read them with a reason that says what to run -- not raise
# FileNotFoundError from inside a test, and not hit VCR's cannot-overwrite
# error, which is what a `.env` with a real key used to produce here.
PAPER_FIXTURES_DIR: Final = Path(__file__).parent / "fixtures" / "papers"
PAPER_MANIFEST: Final = PAPER_FIXTURES_DIR / "manifest.json"
GOLDEN_CASSETTE_DIR: Final = (
    Path(__file__).parent / "cassettes" / "test_extraction_golden"
)
FETCH_FIXTURES_HINT: Final = "uv run python -m scripts.fetch_paper_fixtures"

# The effort sweep. `--golden-effort=<level>` records and scores one effort
# "arm" in a cassette directory of its own, beside the baseline's and never
# inside it, so an arm can be recorded and read without touching the
# cassettes every committed figure was measured on. An option rather than
# `PIPELINE_LLM_EFFORT`: the root conftest's `_isolate_credentials` clears the
# whole `PIPELINE_*` namespace before every test, so the variable would never
# reach the config the suite builds.
#
# pytest reads `pytest_addoption` only from the conftests it loads before
# collection -- the ones on the path of the arguments it was given -- so the
# option exists when the run names this tree or a file in it, which is how
# the commands in test_extraction_golden.py's docstring run it.
GOLDEN_EFFORT_LEVELS: Final = ("low", "medium", "high")
_ARM_RESULTS: Final = pytest.StashKey[dict[str, dict[str, Any]]]()
_ARM_EXPECTED: Final = pytest.StashKey[list[str]]()
# The fixture a golden test takes to report its figures under an arm; the
# tests that take it are the ones the summary line needs a result from.
_ARM_RECORD_FIXTURE: Final = "golden_arm_record"


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--golden-effort",
        choices=GOLDEN_EFFORT_LEVELS,
        default=None,
        help=(
            "record or replay the golden extraction suite at this effort, "
            "under cassettes/test_extraction_golden-<level>/, and print its "
            "recall, quote and cost figures instead of asserting the "
            "baseline's recall floors"
        ),
    )


def pytest_configure(config: pytest.Config) -> None:
    # The figures are gathered in this process's stash; xdist workers would
    # each hold a share of them and the summary would see none.
    if golden_effort(config) and getattr(config.option, "numprocesses", None):
        raise pytest.UsageError("--golden-effort cannot run under xdist (-n)")
    config.stash[_ARM_RESULTS] = {}
    config.stash[_ARM_EXPECTED] = []


def golden_effort(config: pytest.Config) -> str | None:
    """The effort arm this run selected, or None for the baseline."""
    return config.getoption("--golden-effort", default=None)


def golden_cassette_dir(config: pytest.Config) -> Path:
    """Where this run's golden cassettes are read from and written to.

    The baseline's own directory when no arm is selected, which is also
    pytest-recording's default for test_extraction_golden.py, so an unset
    option resolves to exactly the path the suite always used.
    """
    effort = golden_effort(config)
    if effort is None:
        return GOLDEN_CASSETTE_DIR
    return GOLDEN_CASSETTE_DIR.with_name(f"{GOLDEN_CASSETTE_DIR.name}-{effort}")


@pytest.fixture(scope="session")
def golden_arm_cassette_dir(pytestconfig: pytest.Config) -> Path:
    """`golden_cassette_dir` as a fixture; session-scoped so the module-scoped
    `vcr_cassette_dir` override in test_extraction_golden.py can take it."""
    return golden_cassette_dir(pytestconfig)


@pytest.fixture(scope="session")
def golden_arm_effort(pytestconfig: pytest.Config) -> str | None:
    return golden_effort(pytestconfig)


@pytest.fixture
def golden_arm_record(request: pytest.FixtureRequest) -> Callable[..., None]:
    """Store this test's figures for the arm's summary line.

    Keyed by node id, so `pytest_terminal_summary` can tell a test that
    produced its figures from one that failed, was skipped or never ran --
    the difference between a result and a directory with a cassette missing.
    """
    results = request.config.stash[_ARM_RESULTS]
    nodeid = request.node.nodeid

    def record(**figures: Any) -> None:
        results[nodeid] = figures

    return record


def fulltext_fixture_pmids() -> tuple[str, ...]:
    """The PMIDs whose fixture is fetched rather than committed."""
    return tuple(json.loads(PAPER_MANIFEST.read_text(encoding="utf-8")))


def missing_paper_fixtures() -> list[str]:
    return [
        pmid
        for pmid in fulltext_fixture_pmids()
        if not (PAPER_FIXTURES_DIR / f"{pmid}.txt").is_file()
    ]


def _can_record(config: pytest.Config) -> bool:
    """A recording session: `--record-mode` set to record, and a real key.

    Read at collection, before `_isolate_credentials` deletes the key for
    each test; `test_extraction_golden.py` captures it at import for the
    same reason.
    """
    mode = config.getoption("--record-mode", default=None) or "none"
    return mode != "none" and bool(os.environ.get("ANTHROPIC_API_KEY"))


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    missing = missing_paper_fixtures()
    cassette_dir = golden_cassette_dir(config)
    no_cassettes = not any(cassette_dir.glob("*.yaml"))
    recording = _can_record(config)
    if golden_effort(config) is not None:
        config.stash[_ARM_EXPECTED] = [
            item.nodeid
            for item in items
            if _ARM_RECORD_FIXTURE in getattr(item, "fixturenames", ())
        ]
    for item in items:
        if missing and item.get_closest_marker("paper_fixtures") is not None:
            item.add_marker(
                pytest.mark.skip(
                    reason=(
                        f"full-text paper fixtures missing ({', '.join(missing)}): "
                        f"{FETCH_FIXTURES_HINT}"
                    )
                )
            )
        elif no_cassettes and item.get_closest_marker("golden_cassettes") is not None:
            if item.get_closest_marker("vcr") is not None and recording:
                continue  # this run is what records them
            item.add_marker(
                pytest.mark.skip(
                    reason=(
                        f"no golden cassettes recorded in {cassette_dir.name}/; "
                        "they are model responses and cannot be fetched -- "
                        "record them locally with ANTHROPIC_API_KEY and "
                        "--record-mode=once (see the docstring of "
                        "test_extraction_golden.py)"
                    )
                )
            )


def pytest_terminal_summary(
    terminalreporter: Any, exitstatus: int, config: pytest.Config
) -> None:
    """Print one effort arm's figures, or say plainly why there are none.

    The figures are summed from what each golden test recorded through
    `golden_arm_record`; the scoring itself -- reachable genes, the split
    between genes the prompt names and the rest, the verbatim check -- is
    done in test_extraction_golden.py by the same code that scores the
    baseline. A test that failed, was skipped or did not run leaves no
    record, and then the line names the gap instead of printing a sum over
    part of the arm that would read like a result.
    """
    effort = golden_effort(config)
    if effort is None:
        return
    terminalreporter.write_line(_arm_summary(effort, config))


def _arm_summary(effort: str, config: pytest.Config) -> str:
    from pipeline.config import PipelineConfig

    return arm_summary_line(
        effort,
        golden_cassette_dir(config),
        config.stash[_ARM_EXPECTED],
        config.stash[_ARM_RESULTS],
        PipelineConfig().llm_model,
    )


@pytest.fixture(scope="session")
def golden_arm_summary_line() -> Callable[..., str]:
    """`arm_summary_line` for the tests that drive it with made-up records."""
    return arm_summary_line


def arm_summary_line(
    effort: str,
    cassette_dir: Path,
    expected: list[str],
    results: dict[str, dict[str, Any]],
    primary_model: str,
) -> str:
    """The arm's summary line from the figures its tests recorded.

    Figures are printed only for an arm that is complete and that the
    primary model answered throughout. Every extraction carries the
    fallback model, so a paper the primary model declined comes back with
    the fallback's genes and quotes; summed in, they would be scored as
    this effort's result on the model the default is being chosen for.
    """
    prefix = f"golden arm {effort}:"
    if not any(cassette_dir.glob("*.yaml")):
        return (
            f"{prefix} no result -- no cassettes in {cassette_dir}; record "
            "them with --record-mode=once (see test_extraction_golden.py)"
        )
    if not expected:
        return f"{prefix} no result -- no golden extraction test was run"
    problems = []
    absent = [nodeid for nodeid in expected if nodeid not in results]
    if absent:
        names = ", ".join(nodeid.rpartition("::")[2] for nodeid in absent)
        problems.append(
            f"incomplete: {len(absent)} of {len(expected)} golden extraction "
            "tests produced none (failed, skipped or not run; a missing "
            f"cassette in {cassette_dir} fails its test): {names}"
        )
    elsewhere = [
        f"{figures.get('pmid')} served by {figures['model']} "
        f"(declined: {figures.get('declined') or 'unspecified'})"
        for figures in results.values()
        if "model" in figures
        and (figures["model"] != primary_model or figures.get("declined"))
    ]
    if elsewhere:
        problems.append(
            f"not {primary_model}'s figures at this effort: {primary_model} "
            f"did not answer {len(elsewhere)} extraction(s) -- "
            + ", ".join(elsewhere)
        )
    if problems:
        return f"{prefix} no figures -- " + "; ".join(problems)

    def total(key: str) -> int:
        return sum(figures.get(key, 0) for figures in results.values())

    usage = TokenUsage()
    for figures in results.values():
        if figures.get("usage") is not None:
            usage += figures["usage"]
    reachable, found = total("reachable"), total("found")
    named_reachable, named_found = total("named_reachable"), total("named_found")
    cost = AnthropicClient().estimate_cost(usage)
    return (
        f"{prefix} pooled {found}/{reachable}, "
        f"clean {found - named_found}/{reachable - named_reachable}, "
        f"genes {total('genes')}, verbatim {total('verbatim')}/{total('genes')}, "
        f"output tokens {usage.output_tokens:,}, cost ${cost:.2f}"
    )
