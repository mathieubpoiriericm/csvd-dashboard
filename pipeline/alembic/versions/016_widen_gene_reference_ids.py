"""Widen gene_references.pmid to hold DOIs.

A gene's reference is a PMID or, for a source with no PubMed record, a DOI;
"10.21203/rs.3.rs-5926137/v1" alone is 27 characters, past VARCHAR(20). The
column keeps its name -- renaming it would touch every reader for no gain --
and ``pipeline.export.text.is_doi`` tells the two apart.

The downgrade restores VARCHAR(20) and refuses while any value is longer, so
it cannot silently truncate a DOI.

Revision ID: 016
Revises: 015
Create Date: 2026-11-07
"""

from collections.abc import Sequence

from alembic import op

revision: str = "016"
down_revision: str | None = "015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE gene_references ALTER COLUMN pmid TYPE VARCHAR(100)")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM gene_references WHERE length(pmid) > 20) THEN
                RAISE EXCEPTION
                    'gene_references.pmid holds values longer than 20 characters (DOIs); delete them before downgrading';
            END IF;
        END $$
        """
    )
    op.execute("ALTER TABLE gene_references ALTER COLUMN pmid TYPE VARCHAR(20)")
