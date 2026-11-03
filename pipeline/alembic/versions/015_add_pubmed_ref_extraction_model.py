"""Add pubmed_refs.extraction_model.

Which model extracted each processed paper. Claude Opus 5.5 is pinned, but a
paper it declines is extracted by the server-side fallback, Claude Opus 4.8,
and the ledger is the durable per-paper record of that: joined to
gene_references on pmid it finds every gene an Opus 4.8 extraction
contributed to, which the run report -- capped, and one per run -- cannot.

NULL means no model ran (a paper with no retrievable text is processed and
recorded all the same) or a row written before this revision. Nullable, no
default: a default would state a model for rows no one recorded one for.

Revision ID: 015
Revises: 014
Create Date: 2026-11-03
"""

from collections.abc import Sequence

from alembic import op

revision: str = "015"
down_revision: str | None = "014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE pubmed_refs ADD COLUMN extraction_model VARCHAR(100)")


def downgrade() -> None:
    op.execute("ALTER TABLE pubmed_refs DROP COLUMN extraction_model")
