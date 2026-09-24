"""Normalise `clinical_trials.drug` in place, once, for rows written before
`pipeline/drug_names.py` existed.

`_map_study_to_records` normalises on the way in now, so a future
`--clinical-trials` sync writes clean names. This is the one-off pass over
what is already stored.

Two things it does that the per-name rule cannot. It applies
`fold_case_variants` across the whole column, which is what folds
"Isosorbide Mononitrate" onto "Isosorbide mononitrate" -- both are already
capitalised, so no per-name rule can prefer one. And it resolves the
`(registry_id, drug)` collisions the fold creates: two dose arms of one drug
in one trial become one row, which is a fix rather than a loss -- the radar
draws a marker per row and was drawing two for one intervention.

**A collision is only merged when the rows agree on every curated column.**
Population, mechanism, genetic target and genetic evidence are a curator's
judgement; two rows that disagree on any of them are two different records
whatever their drug says, so the script reports them and changes neither.

Run as a module, as `scripts/backfill_gene_lists.py` is:

    uv run python -m scripts.normalize_drug_names --dry-run
    uv run python -m scripts.normalize_drug_names
"""

import argparse
import asyncio
import logging
from collections import defaultdict
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from pipeline.database import Database
from pipeline.drug_names import fold_case_variants, normalize_drug_name

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

logger = logging.getLogger(__name__)

# The columns a curator owns. Two rows sharing a registry id and a normalised
# drug are the same record only if they agree on all of them.
_CURATED = (
    "target_population",
    "target_population_details",
    "mechanism_of_action",
    "genetic_target",
    "genetic_evidence",
)


async def _load(db: Database) -> list[dict[str, Any]]:
    async with db.connection() as conn:
        rows = await conn.fetch(
            "SELECT id, registry_id, drug, "
            + ", ".join(_CURATED)
            + " FROM clinical_trials ORDER BY id"
        )
    return [dict(row) for row in rows]


def plan(rows: list[dict[str, Any]]) -> tuple[
    list[tuple[int, str]], list[int], list[list[dict[str, Any]]]
]:
    """(renames, ids to delete, collisions left alone)."""
    normalised: dict[int, str] = {}
    for row in rows:
        name = normalize_drug_name(row["drug"])
        # A row whose drug names no agent keeps what it has: deleting a
        # published row is a curation decision, not a text one.
        normalised[row["id"]] = name if name else row["drug"]

    folded = fold_case_variants(normalised.values())
    final = {row_id: folded[name] for row_id, name in normalised.items()}

    groups: dict[tuple[str | None, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        groups[(row["registry_id"], final[row["id"]])].append(row)

    renames: list[tuple[int, str]] = []
    delete: list[int] = []
    conflicts: list[list[dict[str, Any]]] = []

    for (_registry, name), group in groups.items():
        if len(group) > 1:
            curated = {tuple(row[column] for column in _CURATED) for row in group}
            if len(curated) > 1:
                conflicts.append(group)
                continue
            # Same trial, same agent, same curation: one record, two dose
            # arms. Keep the lowest id so the export's ORDER BY is stable.
            keeper, *rest = sorted(group, key=lambda row: row["id"])
            delete.extend(row["id"] for row in rest)
            group = [keeper]
        for row in group:
            if row["drug"] != name:
                renames.append((row["id"], name))

    return sorted(renames), sorted(delete), conflicts


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true", help="report the plan and write nothing"
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    db = Database()
    rows = await _load(db)
    renames, delete, conflicts = plan(rows)

    by_id = {row["id"]: row for row in rows}
    logger.info("%d rows; %d renames, %d merges", len(rows), len(renames), len(delete))
    for row_id, name in renames:
        logger.info("  rename %-6s %r -> %r", row_id, by_id[row_id]["drug"], name)
    for row_id in delete:
        row = by_id[row_id]
        logger.info("  merge  %-6s %s %r into its sibling", row_id,
                    row["registry_id"], row["drug"])
    for group in conflicts:
        logger.warning(
            "  CONFLICT %s: %s share a normalised name and disagree on a "
            "curated column; left alone for a curator",
            group[0]["registry_id"],
            ", ".join(repr(row["drug"]) for row in group),
        )

    if args.dry_run:
        logger.info("dry run: nothing written")
        return 0
    if not renames and not delete:
        logger.info("nothing to do")
        return 0

    async with db.connection() as conn, conn.transaction():
        if delete:
            await conn.execute(
                "DELETE FROM clinical_trials WHERE id = ANY($1::int[])", delete
            )
        for row_id, name in renames:
            await conn.execute(
                "UPDATE clinical_trials SET drug = $1 WHERE id = $2", name, row_id
            )
    logger.info("wrote %d renames and %d merges", len(renames), len(delete))
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
