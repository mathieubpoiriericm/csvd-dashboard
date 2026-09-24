"""The one curated cSVD gene NCBI files under another symbol.

The generic guarantee -- every renamed curated gene has a map entry -- is in
tests/pipeline/test_data_merger.py and passes vacuously on empty data. This
pins that the committed cSVD data still shows the case at all, so the
generic test is known to be exercising something; a fork deletes it with
csvd/.
"""

import json
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]


def test_the_committed_data_still_shows_a_renamed_curated_gene() -> None:
    with (_REPO_ROOT / "data" / "gene_info.json").open(encoding="utf-8") as handle:
        rows = json.load(handle)
    renamed = [
        row["name"]
        for row in rows
        if row.get("otheraliases")
        and row["name"] in {a.strip() for a in row["otheraliases"].split(",")}
    ]
    assert "C6orf195" in renamed, "the committed data no longer shows the case"
