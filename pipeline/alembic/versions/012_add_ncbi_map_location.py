"""Add map_location to ncbi_gene_info.

NCBI's esummary returns ``maplocation`` -- "17q25.1", "Xq22.1" -- in the very
payload ``_fetch_gene_summary`` already reads ``description`` and
``otheraliases`` out of, and the field was dropped on the floor. Nothing else
in the schema carried a chromosomal band, so the first run to insert genes it
had not been given one for published all sixteen as "(unknown)": they reached
Table 1 and no chromosome of the phenogram, and `tests/cytobands_test.ts`
failed on every one.

The column caches what that call already returns. `genes.chromosomal_location`
stays the published source and is filled from here only where it is empty, so
the curated rows keep the spreadsheet's spelling.

Revision ID: 012
Revises: 011
Create Date: 2026-09-03
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "012"
down_revision: str | None = "011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE ncbi_gene_info ADD COLUMN IF NOT EXISTS map_location TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE ncbi_gene_info DROP COLUMN IF EXISTS map_location")
