---
paths:
  - "pipeline/alembic/**"
  - "pipeline/alembic.ini"
  - "tests/pipeline/test_alembic_migrations.py"
---

# Migrations: the run report's `009`, and Alembic rather than Atlas

- **The migration is `009`, and the number is load-bearing.** It was authored as
  `008` while another branch's `008_add_gene_annotations` was in flight. Both
  declared `down_revision = "007"` and the two files never touched, so git
  merged them cleanly and CI, which has no database, saw nothing.
  `alembic_version` then held the ambiguous string `"008"`,
  `alembic upgrade head` considered itself finished, and `pipeline_runs` never
  gained `status`, `duration_seconds` or `report`. Every layer below swallows
  that: alembic warns and continues, `read_pipeline_run` catches the read error,
  and the About page renders its fallback card -- so the widget simply never
  appears and nothing says why. `tests/pipeline/test_alembic_migrations.py`
  walks the revision graph and fails on a duplicate id, a second head or a
  dangling `down_revision`.

Alembic stays the only definition of the schema. Atlas was evaluated for that
role and rejected: it gates PostgreSQL triggers and functions behind its Pro
plan, and this schema has five triggers and a plpgsql function, so its diff
engine would plan against an incomplete picture. The maintained Python
alternatives are dead ends (`yoyo-migrations` last released August 2024, `migra`
2022).
