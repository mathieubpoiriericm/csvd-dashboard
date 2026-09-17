"""Unit tests for scripts/fetch_paper_fixtures.py.

`testpaths` is `["tests/pipeline"]`, so nothing collects this file -- in CI
either -- unless it is named: `uv run pytest tests/scripts`.
"""

import json
from pathlib import Path

import pytest
from scripts import fetch_paper_fixtures as script
from scripts.fetch_paper_fixtures import (
    FIXTURES_DIR,
    MANIFEST,
    digest,
    drifted,
    fetch_papers,
    load_manifest,
    main,
    updated_manifest,
    write_fixtures,
)

TEXTS = {"11111111": "Paper one.\n", "22222222": "Paper two.\n"}


def _manifest_for(texts: dict[str, str]) -> dict[str, dict[str, str]]:
    return {
        pmid: {"sha256": digest(text), "fetched": "2026-09-01"}
        for pmid, text in texts.items()
    }


@pytest.fixture
def fake_fetch(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[str]]:
    """Stand in for Europe PMC; records the PMIDs asked for and the close."""
    calls: dict[str, list[str]] = {"fetched": [], "closed": []}

    async def fetch(pmid: str) -> str | None:
        calls["fetched"].append(pmid)
        return TEXTS.get(pmid)

    async def close() -> None:
        calls["closed"].append("closed")

    monkeypatch.setattr(script, "fetch_europepmc_fulltext", fetch)
    monkeypatch.setattr(script, "close_http_client", close)
    return calls


class TestManifest:
    def test_the_committed_manifest_lists_every_gitignored_fixture(self) -> None:
        """The three abstract-only fixtures stay tracked; the rest are listed."""
        manifest = load_manifest(MANIFEST)
        tracked = {"15905468", "31430377", "34358307"}
        assert set(manifest) == {
            "33293549",
            "33773637",
            "35511193",
            "35943854",
            "36180795",
            "37069360",
            "39216230",
        }
        assert not set(manifest) & tracked
        for entry in manifest.values():
            assert len(entry["sha256"]) == 64
            assert entry["fetched"]
        assert MANIFEST.parent == FIXTURES_DIR

    def test_drift_names_only_the_papers_whose_text_moved(self) -> None:
        manifest = _manifest_for(TEXTS)
        assert drifted(manifest, TEXTS) == []
        moved = {**TEXTS, "22222222": "Paper two, re-rendered.\n"}
        assert drifted(manifest, moved) == ["22222222"]

    def test_updating_rewrites_hash_and_date_for_fetched_papers_only(self) -> None:
        manifest = _manifest_for(TEXTS)
        fetched = {"22222222": "Paper two, re-rendered.\n"}
        updated = updated_manifest(manifest, fetched, today="2026-09-11")
        assert updated["11111111"] == manifest["11111111"]
        assert updated["22222222"] == {
            "sha256": digest(fetched["22222222"]),
            "fetched": "2026-09-11",
        }
        assert manifest["22222222"]["fetched"] == "2026-09-01", "input untouched"


class TestFetch:
    async def test_returns_every_text_and_closes_the_client(
        self, fake_fetch: dict[str, list[str]]
    ) -> None:
        texts = await fetch_papers(["11111111", "22222222"])
        assert texts == TEXTS
        assert fake_fetch["closed"] == ["closed"]

    async def test_refuses_a_paper_with_no_full_text(
        self, fake_fetch: dict[str, list[str]]
    ) -> None:
        """Never write an abstract, or nothing, under a full-text PMID."""
        with pytest.raises(LookupError, match="99999999"):
            await fetch_papers(["11111111", "99999999"])
        assert fake_fetch["closed"] == ["closed"], "closed on the error path too"

    def test_writes_one_file_per_pmid(self, tmp_path: Path) -> None:
        written = write_fixtures(TEXTS, tmp_path)
        assert [p.name for p in written] == ["11111111.txt", "22222222.txt"]
        assert (tmp_path / "11111111.txt").read_text(encoding="utf-8") == "Paper one.\n"


class TestMain:
    @pytest.fixture
    def manifest_path(self, tmp_path: Path) -> Path:
        path = tmp_path / "manifest.json"
        path.write_text(json.dumps(_manifest_for(TEXTS)), encoding="utf-8")
        return path

    def _run(self, tmp_path: Path, manifest_path: Path, *extra: str) -> int:
        out, manifest = str(tmp_path / "papers"), str(manifest_path)
        return main(["--out", out, "--manifest", manifest, *extra])

    def test_writes_every_manifest_paper_when_nothing_drifted(
        self, tmp_path: Path, manifest_path: Path, fake_fetch: dict[str, list[str]]
    ) -> None:
        assert self._run(tmp_path, manifest_path) == 0
        assert fake_fetch["fetched"] == ["11111111", "22222222"]
        out = tmp_path / "papers"
        assert (out / "22222222.txt").read_text(encoding="utf-8") == "Paper two.\n"

    def test_pmid_limits_the_fetch(
        self, tmp_path: Path, manifest_path: Path, fake_fetch: dict[str, list[str]]
    ) -> None:
        assert self._run(tmp_path, manifest_path, "--pmid", "22222222") == 0
        assert fake_fetch["fetched"] == ["22222222"]
        assert not (tmp_path / "papers" / "11111111.txt").exists()

    def test_a_pmid_outside_the_manifest_is_refused(
        self, tmp_path: Path, manifest_path: Path, fake_fetch: dict[str, list[str]]
    ) -> None:
        with pytest.raises(SystemExit) as excinfo:
            self._run(tmp_path, manifest_path, "--pmid", "99999999")
        assert excinfo.value.code == 2
        assert fake_fetch["fetched"] == []

    def test_drift_still_writes_the_text_but_fails_and_says_why(
        self,
        tmp_path: Path,
        manifest_path: Path,
        fake_fetch: dict[str, list[str]],
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.setitem(TEXTS, "22222222", "Paper two, re-rendered.\n")
        assert self._run(tmp_path, manifest_path) == 1
        out = tmp_path / "papers"
        text = (out / "22222222.txt").read_text(encoding="utf-8")
        assert text.endswith("rendered.\n")
        message = capsys.readouterr().err
        assert "22222222" in message
        assert "--update-manifest" in message
        assert "re-record" in message
        # The manifest itself is untouched until the cassettes catch up.
        assert load_manifest(manifest_path) == _manifest_for(
            {"11111111": "Paper one.\n", "22222222": "Paper two.\n"}
        )

    def test_update_manifest_records_the_new_hash(
        self,
        tmp_path: Path,
        manifest_path: Path,
        fake_fetch: dict[str, list[str]],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setitem(TEXTS, "22222222", "Paper two, re-rendered.\n")
        assert self._run(tmp_path, manifest_path, "--update-manifest") == 0
        manifest = load_manifest(manifest_path)
        assert manifest["22222222"]["sha256"] == digest("Paper two, re-rendered.\n")
        assert manifest["22222222"]["fetched"] == script.date.today().isoformat()
        assert manifest["11111111"]["fetched"] == script.date.today().isoformat()
        assert manifest_path.read_text(encoding="utf-8").endswith("}\n")

    def test_a_missing_full_text_fails_naming_the_pmid(
        self,
        tmp_path: Path,
        manifest_path: Path,
        fake_fetch: dict[str, list[str]],
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str],
    ) -> None:
        monkeypatch.delitem(TEXTS, "22222222")
        assert self._run(tmp_path, manifest_path) == 1
        assert "22222222" in capsys.readouterr().err
        assert not (tmp_path / "papers").exists(), "nothing written on failure"
