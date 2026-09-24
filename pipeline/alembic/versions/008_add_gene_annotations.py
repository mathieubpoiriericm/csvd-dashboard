"""Add machine-fetched gene annotations.

ClinVar, Orphadata and Open Targets produce the same kind of fact -- a gene, a
relation, an object with an identifier, and provenance -- in three envelopes.
One edge table holds all of them with typed columns, so the curated genes row
is never written by an API client and a reviewer can adopt the machine
annotations column by column.

group_key is what makes an enrichment joinable: every row describing one
disease repeats that disease's canonical identifier there. It defaults to ''
rather than NULL because PostgreSQL treats NULL as distinct from itself in a
UNIQUE constraint, so two identical GO rows would both insert.

gene_annotation_status is the TTL anchor and the negative cache: a gene with no
annotations has no rows in gene_annotations, which is otherwise
indistinguishable from a gene never fetched.

Revision ID: 008
Revises: 007
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "008"
down_revision: str | None = "007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS gene_annotations (
            id SERIAL PRIMARY KEY,
            gene_symbol VARCHAR(100) NOT NULL,
            source VARCHAR(20) NOT NULL,
            relation VARCHAR(20) NOT NULL,
            group_key TEXT NOT NULL DEFAULT '',
            object_id TEXT NOT NULL,
            object_label TEXT,
            qualifier TEXT,
            score DOUBLE PRECISION,
            evidence_count INTEGER,
            source_version TEXT,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (gene_symbol, source, relation, group_key, object_id)
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS gene_annotation_status (
            id SERIAL PRIMARY KEY,
            gene_symbol VARCHAR(100) NOT NULL,
            source VARCHAR(20) NOT NULL,
            row_count INTEGER NOT NULL DEFAULT 0,
            source_version TEXT,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (gene_symbol, source)
        )
    """)

    op.execute("""
        CREATE TABLE IF NOT EXISTS trial_drug_annotations (
            id SERIAL PRIMARY KEY,
            drug VARCHAR(255) NOT NULL UNIQUE,
            chembl_id VARCHAR(30),
            action_type TEXT,
            mechanism_of_action TEXT,
            target_symbols TEXT,
            source_version TEXT,
            resolved BOOLEAN NOT NULL DEFAULT FALSE,
            fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gene_annotations_symbol "
        "ON gene_annotations(gene_symbol)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gene_annotations_group "
        "ON gene_annotations(group_key)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_gene_annotation_status_symbol "
        "ON gene_annotation_status(gene_symbol)"
    )

    for table in (
        "gene_annotations",
        "gene_annotation_status",
        "trial_drug_annotations",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_updated ON {table}")
        op.execute(f"""
            CREATE TRIGGER {table}_updated
                BEFORE UPDATE ON {table}
                FOR EACH ROW EXECUTE FUNCTION update_timestamp()
        """)


def downgrade() -> None:
    for table in (
        "trial_drug_annotations",
        "gene_annotation_status",
        "gene_annotations",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS {table}_updated ON {table}")
    op.execute("DROP TABLE IF EXISTS trial_drug_annotations")
    op.execute("DROP TABLE IF EXISTS gene_annotation_status")
    op.execute("DROP TABLE IF EXISTS gene_annotations")
