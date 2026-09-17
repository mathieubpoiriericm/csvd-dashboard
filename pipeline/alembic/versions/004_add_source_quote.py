"""Add source_quote to genes.

The Citations API cannot be combined with structured outputs (400), so
provenance for each extracted gene travels inside the schema instead, as a
required verbatim sentence copied from the paper. This column persists it.

Revision ID: 004
Revises: 003
Create Date: 2026-08-29
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "004"
down_revision: str | None = "003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE genes ADD COLUMN IF NOT EXISTS source_quote TEXT")


def downgrade() -> None:
    op.execute("ALTER TABLE genes DROP COLUMN IF EXISTS source_quote")
