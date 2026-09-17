"""Normalize the genes list-columns into join tables.

Three columns on `genes` hold delimited lists inside TEXT: `references`
(comma-separated PMIDs), `gwas_trait`, and `link_to_monogenetic_disease`.
The first has already been destroyed once -- a spreadsheet round-trip read
the whole PMID list as one number for ten rows -- and one value per row
makes that class of corruption impossible rather than merely detectable.

This revision is additive. The source columns stay until 006, so the
backfill, the export switch and the ingest switch can land between the two
and be verified against the byte-exact JSON gate before anything is dropped.

`ordinal` preserves source order, which the JSON arrays depend on.

Revision ID: 005
Revises: 004
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "005"
down_revision: str | None = "004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS gene_references (
            gene_id INTEGER NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            pmid VARCHAR(20) NOT NULL,
            PRIMARY KEY (gene_id, ordinal)
        )
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS gene_gwas_traits (
            gene_id INTEGER NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            trait VARCHAR(100) NOT NULL,
            PRIMARY KEY (gene_id, ordinal)
        )
    """)
    op.execute("""
        CREATE TABLE IF NOT EXISTS gene_monogenic_links (
            gene_id INTEGER NOT NULL REFERENCES genes(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL,
            omim_id VARCHAR(20) NOT NULL,
            PRIMARY KEY (gene_id, ordinal)
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS gene_monogenic_links")
    op.execute("DROP TABLE IF EXISTS gene_gwas_traits")
    op.execute("DROP TABLE IF EXISTS gene_references")
