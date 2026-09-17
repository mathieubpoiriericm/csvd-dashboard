"""Drop the genes list-columns now that the join tables carry them.

005 added gene_references, gene_gwas_traits and gene_monogenic_links; the
backfill populated them, the export was verified to regenerate
data/table1.json byte-identically from them, and merge_genes_transactional
was switched to write them. These three columns have no readers and no
writers left.

`downgrade` restores the columns but NOT their contents: the delimited text
cannot be reconstructed from the join tables without re-deciding the
separator and spacing that produced the original bytes. Re-running the
export is the supported way back.

Revision ID: 006
Revises: 005
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op

revision: str = "006"
down_revision: str | None = "005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute('ALTER TABLE genes DROP COLUMN IF EXISTS "references"')
    op.execute("ALTER TABLE genes DROP COLUMN IF EXISTS gwas_trait")
    op.execute("ALTER TABLE genes DROP COLUMN IF EXISTS link_to_monogenetic_disease")


def downgrade() -> None:
    op.execute('ALTER TABLE genes ADD COLUMN IF NOT EXISTS "references" TEXT')
    op.execute("ALTER TABLE genes ADD COLUMN IF NOT EXISTS gwas_trait TEXT")
    op.execute(
        "ALTER TABLE genes ADD COLUMN IF NOT EXISTS link_to_monogenetic_disease TEXT"
    )
