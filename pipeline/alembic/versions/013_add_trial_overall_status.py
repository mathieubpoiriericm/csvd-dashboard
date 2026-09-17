"""Add overall_status to clinical_trials.

ClinicalTrials.gov states an ``overallStatus`` on every study and the sync
threw it away: ``_map_study_to_records`` read ``statusModule`` only for the
completion date, and the schema had nowhere to put a status anyway. So the
dashboard published terminated and withdrawn trials -- stopped early, or
registered and never enrolled -- beside the running ones in Table 2 and as
markers on the radar, with nothing anywhere saying which were which. The one
place a status existed was ``data/geocoded_trials.json``, fetched per facility
by ``deno task geocode`` *after* the export and read only by the map popup, so
no gate could ever have been written against it.

This column is what ``_read_curated_trials`` reads to refuse them. It is
deliberately nullable with no default: NULL means "ClinicalTrials.gov has not
answered for this row", which covers the ISRCTN, ChiCTR and ANZCTR trials it
can never answer for, and the export fails open on it. ``UNKNOWN`` is a real
ClinicalTrials.gov status, so a default of that would make the two
indistinguishable.

TEXT rather than a width: the registry's enum reaches 27 characters
(``TEMPORARILY_NOT_AVAILABLE``), and a guessed VARCHAR would error on data
nobody has seen yet.

Revision ID: 013
Revises: 012
Create Date: 2026-09-08
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "013"
down_revision: str | None = "012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE clinical_trials ADD COLUMN IF NOT EXISTS overall_status TEXT"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE clinical_trials DROP COLUMN IF EXISTS overall_status")
