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
from pathlib import Path
from typing import Final

import pytest

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
    no_cassettes = not any(GOLDEN_CASSETTE_DIR.glob("*.yaml"))
    recording = _can_record(config)
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
                        "no golden cassettes recorded; they are model responses "
                        "and cannot be fetched -- record them locally with "
                        "ANTHROPIC_API_KEY and --record-mode=once (see the "
                        "docstring of test_extraction_golden.py)"
                    )
                )
            )
