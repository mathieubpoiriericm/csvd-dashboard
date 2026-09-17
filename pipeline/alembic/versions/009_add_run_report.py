"""Carry the full run report on pipeline_runs.

`pipeline_runs` held six numbers, which is all the About page's date
badge needed. The pipeline builds far more than that -- per-step
outcomes, the external services it called, every gene it accepted and
every one it refused with the reason -- and wrote it only to
`logs/json/pipeline_report_*.json`, which is gitignored and so never
reaches the site.

`report` carries that document so the export can publish it.
`pipeline/run_report.py`'s `PipelineRunReport` is its schema; PostgreSQL
is only the store.

**JSON, not JSONB.** jsonb normalises key order, and the export is gated
on bytes (`tests/pipeline/export/test_writer.py`). The reader rebuilds
order from the model either way, so this is belt and braces -- but a
write-once audit record that is never queried by value has no use for
jsonb's indexing, and storing it as authored is the honest choice.

Revision ID: 009
Revises: 008
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "009"
down_revision: str | None = "008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS status TEXT")
    op.execute(
        "ALTER TABLE pipeline_runs "
        "ADD COLUMN IF NOT EXISTS duration_seconds DOUBLE PRECISION"
    )
    op.execute("ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS report JSON")


def downgrade() -> None:
    op.execute("ALTER TABLE pipeline_runs DROP COLUMN IF EXISTS report")
    op.execute("ALTER TABLE pipeline_runs DROP COLUMN IF EXISTS duration_seconds")
    op.execute("ALTER TABLE pipeline_runs DROP COLUMN IF EXISTS status")
