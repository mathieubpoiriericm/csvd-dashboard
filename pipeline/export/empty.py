"""Write the export's empty shape for every committed data file, no database.

`deno task data:empty`. A repository generated for another disease ships
empty data: the tests derive their expectations from the committed JSON, so
the empty shape is what a fork starts from and what the `empty-data` CI job
proves the suite passes on.

Two files are deliberately handled differently from `run_export`:

- `gene_annotations.json` is EMPTIED here. The database export skips it when
  its table has no rows, because there an empty read almost always means
  "not synced yet". Here the file must not survive: a fork that kept it
  would ship the upstream disease's annotations.
- `cytobands_hg38.json` is UNTOUCHED. It is the hg38 karyotype from
  `scripts/fetch_cytobands.py`, genome reference rather than disease data,
  and the phenogram cannot draw without it.

`omim_info.json` is rendered from `disease/omim_info.csv` exactly as the
database export renders it: the CSV is a disease file the new-disease skill
replaces, so the JSON follows it rather than being blanked.
"""

import argparse
import logging
import tempfile
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from pipeline.config import PROJECT_ROOT
from pipeline.export.omim import read_omim_csv
from pipeline.export.publish import publish_atomically
from pipeline.export.writer import write_rows, write_value

logger = logging.getLogger(__name__)

ROW_TABLES: Final[tuple[str, ...]] = (
    "table1.json",
    "table2.json",
    "gene_info.json",
    "gene_info_table2.json",
    "protein_info.json",
    "refs.json",
    "gene_annotations.json",
    "pipeline_syncs.json",
)
NULL_VALUES: Final[tuple[str, ...]] = ("pipeline_status.json", "pipeline_run.json")
GEOCODED: Final[str] = "geocoded_trials.json"
OMIM: Final[str] = "omim_info.json"

EMPTY_FILES: Final[frozenset[str]] = frozenset(
    (*ROW_TABLES, *NULL_VALUES, GEOCODED, OMIM)
)
UNTOUCHED: Final[frozenset[str]] = frozenset({"cytobands_hg38.json"})


def write_empty_export(
    target_dir: Path, *, now: datetime | None = None
) -> dict[str, Path]:
    """Stage every empty file, then publish them atomically into `target_dir`.

    Returns the written paths by file name. `publish_atomically` snapshots
    the previous generation into `.previous-export` inside the target, as
    `run_export` does, so a failure part-way restores the committed files.
    """
    target_dir.mkdir(parents=True, exist_ok=True)
    stamp = (now or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with tempfile.TemporaryDirectory(
        prefix=".dashboard-export-", dir=target_dir
    ) as staging_name:
        staging = Path(staging_name)
        staged: dict[str, Path] = {}

        def stage(name: str) -> Path:
            path = staging / name
            staged[name] = path
            return path

        for name in ROW_TABLES:
            write_rows([], stage(name))
        for name in NULL_VALUES:
            write_value(None, stage(name))
        write_value(
            {"nctIds": [], "generatedAt": stamp, "locations": []}, stage(GEOCODED)
        )
        write_rows(read_omim_csv(), stage(OMIM))
        publish_atomically(staged, target_dir)
    return {name: target_dir / name for name in staged}


def main(argv: Sequence[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(
        description=(
            "Write the empty shape of every committed data/*.json, no database needed."
        )
    )
    parser.add_argument(
        "--target",
        type=Path,
        default=PROJECT_ROOT / "data",
        help="directory to write into (default: the repository's data/)",
    )
    args = parser.parse_args(argv)
    written = write_empty_export(args.target)
    logger.info(
        "Wrote %d files into %s; %s left untouched.",
        len(written),
        args.target,
        ", ".join(sorted(UNTOUCHED)),
    )


if __name__ == "__main__":
    main()
