"""Widen pubmed_citations.pmid to hold DOIs.

A preprint the curators cite by DOI has no PubMed record, so its citation is
read from Europe PMC and cached under the DOI, the key the gene references
already use (migration 016 widened ``gene_references.pmid`` for the same
reason). "10.21203/rs.3.rs-5926137/v1" is 27 characters, past VARCHAR(20).

The downgrade restores VARCHAR(20) and refuses while any value is longer, so
it cannot silently truncate a DOI.

Revision ID: 017
Revises: 016
Create Date: 2026-11-08
"""

from collections.abc import Sequence

from alembic import op

revision: str = "017"
down_revision: str | None = "016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE pubmed_citations ALTER COLUMN pmid TYPE VARCHAR(100)")


def downgrade() -> None:
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pubmed_citations WHERE length(pmid) > 20) THEN
                RAISE EXCEPTION
                    'pubmed_citations.pmid holds values longer than 20 characters (DOIs); delete them before downgrading';
            END IF;
        END $$
        """
    )
    op.execute("ALTER TABLE pubmed_citations ALTER COLUMN pmid TYPE VARCHAR(20)")
