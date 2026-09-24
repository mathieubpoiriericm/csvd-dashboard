"""The committed fixture manifest, pinned: the seven cSVD papers it lists.

`tests/pipeline/csvd/fixtures/papers/manifest.json` names the gitignored
full-text fixtures the golden extraction suite replays. The script's
behaviour is tested in tests/scripts/test_fetch_paper_fixtures.py; a fork
deletes this tree along with the manifest.
"""

from scripts.fetch_paper_fixtures import MANIFEST, load_manifest


def test_the_committed_manifest_lists_every_gitignored_fixture() -> None:
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
