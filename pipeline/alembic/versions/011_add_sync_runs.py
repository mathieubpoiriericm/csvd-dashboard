"""Record what the reference-data refreshes did.

`--clinical-trials`, `--sync-external-data` and `--sync-annotations` talk
to ClinicalTrials.gov, ClinVar, Orphadata, Open Targets and UniProt, and
none of that reached the dashboard: `build_run_report` is reachable only
from inside `run_pipeline`, so the API rows those syncs recorded were
discarded at the end of the process.

**Its own table, not a `pipeline_runs` row.** `PipelineRunReport` defaults
every field but three, so a sync document in `pipeline_runs.report` would
validate rather than fail and publish a zero-filled PubMed run over the
real one; `read_pipeline_status` would also date the dataset from it.
Sharing the table would mean a `WHERE run_mode = 'standard'` clause in two
readers that each swallow their own errors -- guarded only by tests, and
failing silently and plausibly when one is missed. A separate table means
no query that feeds the widget or the date badge can see a sync at all.

**JSON, not JSONB**, for the reason 009 gives: jsonb normalises key order
and the export is gated on bytes.

Revision ID: 011
Revises: 010
Create Date: 2026-09-02
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "011"
down_revision: str | None = "010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_runs (
            id SERIAL PRIMARY KEY,
            mode TEXT NOT NULL,
            run_timestamp TIMESTAMPTZ NOT NULL,
            status TEXT,
            duration_seconds DOUBLE PRECISION,
            report JSON NOT NULL
        )
        """
    )
    # The export reads the newest row per mode; this is the index that
    # `SELECT DISTINCT ON (mode) ... ORDER BY mode, run_timestamp DESC`
    # walks.
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_sync_runs_mode_timestamp "
        "ON sync_runs (mode, run_timestamp DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_sync_runs_mode_timestamp")
    op.execute("DROP TABLE IF EXISTS sync_runs")
