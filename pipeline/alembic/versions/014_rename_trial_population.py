"""Rename clinical_trials.svd_population to target_population.

The column name reaches the JSON contract: ``clean_column_name`` turns it
into the display name, ``to_camel`` into the wire key, and the trials
table and the population filter read that key. With the dashboard
re-targetable to another disease, a wire key that spells one disease's
abbreviation is the one identifier this work renames; the header text a
reader sees comes from ``populationField`` in ``disease/manifest.json``.

``ALTER TABLE ... RENAME COLUMN`` keeps the data, the NOT NULL state and
every index; nothing is copied.

Revision ID: 014
Revises: 013
Create Date: 2026-09-17
"""

from collections.abc import Sequence

from alembic import op

revision: str = "014"
down_revision: str | None = "013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE clinical_trials RENAME COLUMN svd_population TO target_population"
    )
    op.execute(
        "ALTER TABLE clinical_trials RENAME COLUMN svd_population_details "
        "TO target_population_details"
    )


def downgrade() -> None:
    op.execute(
        "ALTER TABLE clinical_trials RENAME COLUMN target_population TO svd_population"
    )
    op.execute(
        "ALTER TABLE clinical_trials RENAME COLUMN target_population_details "
        "TO svd_population_details"
    )
