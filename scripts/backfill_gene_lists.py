"""Backfill the gene list join tables from the legacy TEXT columns.

One-off, idempotent, and safe to re-run: each table is emptied and rewritten
inside one transaction. It reuses the export's own parsers, so the join
tables and data/table1.json cannot disagree.

A gene whose cell yields nothing gets zero rows -- the sentinel stays a
presentation concern, produced by the export, never stored.

Migration 006 dropped the three delimited columns once this had run, so on
a database at or past it there is nothing left to read: the script checks
information_schema first and exits saying so, rather than raising
UndefinedColumnError out of the SELECT.

Run it as a module, not as a path: `uv run scripts/...` puts scripts/ on
sys.path rather than the repo root, and the pipeline imports below would not
resolve.

    uv run python -m scripts.backfill_gene_lists [--dry-run]
"""

import argparse
import asyncio
from pathlib import Path

from dotenv import load_dotenv

from pipeline.database import Database
from pipeline.export.tables import _OMIM_ID, split_gwas_traits
from pipeline.export.text import extract_matches, extract_pmids, normalize_text

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# (join table, value column, source column, parser). Every parser is the one
# the export itself applies, so a disagreement between the join tables and
# data/table1.json is impossible by construction rather than by review.
_TARGETS = (
    ("gene_references", "pmid", "references", extract_pmids),
    ("gene_gwas_traits", "trait", "gwas_trait", split_gwas_traits),
    (
        "gene_monogenic_links",
        "omim_id",
        "link_to_monogenetic_disease",
        lambda v: extract_matches(v, _OMIM_ID),
    ),
)

# The columns the SELECT below reads, derived from _TARGETS so the probe and
# the query cannot name different ones.
_LEGACY_COLUMNS = tuple(source for _, _, source, _ in _TARGETS)


async def _legacy_columns_present(conn) -> set[str]:
    rows = await conn.fetch(
        """
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'genes' AND column_name = ANY($1::text[])
        """,
        list(_LEGACY_COLUMNS),
    )
    return {row["column_name"] for row in rows}


async def backfill(dry_run: bool = False) -> dict[str, int]:
    counts: dict[str, int] = {}
    async with Database.connection() as conn:
        present = await _legacy_columns_present(conn)
        missing = [c for c in _LEGACY_COLUMNS if c not in present]
        if missing:
            # All three or nothing: skipping one table would leave the join
            # tables disagreeing with data/table1.json, the one thing this
            # script exists to make impossible.
            raise SystemExit(
                f"genes has no {', '.join(missing)} column: the delimited "
                "columns were dropped in migration 006; there is nothing to "
                "backfill."
            )
        rows = await conn.fetch(
            'SELECT id, "references", gwas_trait, link_to_monogenetic_disease '
            "FROM genes ORDER BY id"
        )
        for table, column, source, parse in _TARGETS:
            written = 0
            async with conn.transaction():
                if not dry_run:
                    await conn.execute(f"DELETE FROM {table}")  # noqa: S608
                for row in rows:
                    # normalize_text mirrors clean_gene_row's first step
                    # (tables.py:146): the export has always parsed the
                    # trimmed cell, so the backfill must too.
                    for ordinal, value in enumerate(parse(normalize_text(row[source]))):
                        written += 1
                        if not dry_run:
                            await conn.execute(
                                f"INSERT INTO {table} (gene_id, ordinal, {column}) "  # noqa: S608
                                "VALUES ($1, $2, $3)",
                                row["id"],
                                ordinal,
                                value,
                            )
            counts[table] = written
    return counts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    for table, count in asyncio.run(backfill(args.dry_run)).items():
        print(f"{table}: {count} rows")


if __name__ == "__main__":
    main()
