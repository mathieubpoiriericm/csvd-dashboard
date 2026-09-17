"""Add confidence to genes.

GeneEntry.confidence is required and bounded (ge=0.0, le=1.0), but until now
nothing stored it: the model scores every extraction and the score was
dropped on the floor. This column persists it, following source_quote
(migration 004) both in shape and in reason -- it is per-extraction
provenance, kept beside the sentence it was scored alongside.

Revision ID: 010
Revises: 009
Create Date: 2026-09-02
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "010"
down_revision: str | None = "009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE genes ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION")


def downgrade() -> None:
    op.execute("ALTER TABLE genes DROP COLUMN IF EXISTS confidence")
