"""Store Mendelian randomization as a boolean.

The column is varchar(10) holding Y, N, Yes and No -- four spellings for two
states, folded by normalize_yes_no on the way out. The wire format keeps
"Yes"/"No" strings, so data/table1.json and the binary filter in
lib/constants.ts are unaffected.

The merge is where the loose type cost something: both branches tested
`mendelian_randomization = 'Y'`, which a curated 'Yes' row does not match,
so the sticky-OR silently did not stick for those rows. Folding both
spellings to TRUE takes the bug with the type.

NULL is preserved as NULL; the export renders it "No", as it already does
for a missing cell.

Revision ID: 007
Revises: 006
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op

revision: str = "007"
down_revision: str | None = "006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        ALTER TABLE genes
        ALTER COLUMN mendelian_randomization TYPE BOOLEAN
        USING CASE
            WHEN UPPER(TRIM(mendelian_randomization)) IN ('Y', 'YES') THEN TRUE
            WHEN UPPER(TRIM(mendelian_randomization)) IN ('N', 'NO') THEN FALSE
            ELSE NULL
        END
    """)


def downgrade() -> None:
    op.execute("""
        ALTER TABLE genes
        ALTER COLUMN mendelian_randomization TYPE VARCHAR(10)
        USING CASE
            WHEN mendelian_randomization THEN 'Yes'
            WHEN NOT mendelian_randomization THEN 'No'
            ELSE NULL
        END
    """)
