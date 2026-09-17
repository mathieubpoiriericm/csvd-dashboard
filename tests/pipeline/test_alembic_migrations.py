"""Coverage for Alembic environment setup and raw-SQL revisions."""

import runpy
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_ALEMBIC = _ROOT / "pipeline" / "alembic"


_SQL_CASES: list[tuple[str, str, str]] = [
    ("001_baseline_schema.py", "CREATE TABLE", "DROP TABLE"),
    ("002_add_upper_gene_index.py", "CREATE INDEX", "DROP INDEX"),
    ("003_add_pipeline_runs_table.py", "CREATE TABLE", "DROP TABLE"),
    ("004_add_source_quote.py", "ADD COLUMN", "DROP COLUMN"),
    ("005_normalize_gene_lists.py", "CREATE TABLE", "DROP TABLE"),
    ("006_drop_gene_list_columns.py", "DROP COLUMN", "ADD COLUMN"),
    ("007_mendelian_randomization_boolean.py", "TYPE BOOLEAN", "VARCHAR(10)"),
    ("008_add_gene_annotations.py", "CREATE TABLE", "DROP TABLE"),
    ("009_add_run_report.py", "ADD COLUMN", "DROP COLUMN"),
    ("010_add_confidence.py", "ADD COLUMN", "DROP COLUMN"),
    ("011_add_sync_runs.py", "CREATE TABLE", "DROP TABLE"),
    ("012_add_ncbi_map_location.py", "ADD COLUMN", "DROP COLUMN"),
    ("013_add_trial_overall_status.py", "ADD COLUMN", "DROP COLUMN"),
]


@pytest.mark.parametrize(
    ("revision", "upgrade_marker", "downgrade_marker"), _SQL_CASES
)
def test_revision_upgrade_and_downgrade_execute_expected_sql(
    revision: str,
    upgrade_marker: str,
    downgrade_marker: str,
    mocker,
) -> None:
    execute = mocker.patch("alembic.op.execute")
    namespace = runpy.run_path(str(_ALEMBIC / "versions" / revision))

    namespace["upgrade"]()
    upgrade_sql = "\n".join(call.args[0] for call in execute.call_args_list)
    assert upgrade_marker in upgrade_sql

    execute.reset_mock()
    namespace["downgrade"]()
    downgrade_sql = "\n".join(call.args[0] for call in execute.call_args_list)
    assert downgrade_marker in downgrade_sql


def _set_database_environment(monkeypatch) -> None:
    monkeypatch.setenv("DB_HOST", "db.example")
    monkeypatch.setenv("DB_PORT", "6543")
    monkeypatch.setenv("DB_NAME", "cSVD/data")
    monkeypatch.setenv("DB_USER", "pipeline@example")
    monkeypatch.setenv("DB_PASSWORD", "p@ss/#word")


def test_alembic_offline_mode_configures_encoded_url(monkeypatch, mocker) -> None:
    _set_database_environment(monkeypatch)
    mocker.patch("dotenv.load_dotenv")
    context = mocker.patch("alembic.context")
    context.config.config_file_name = "alembic.ini"
    context.is_offline_mode.return_value = True
    file_config = mocker.patch("logging.config.fileConfig")

    namespace = runpy.run_path(str(_ALEMBIC / "env.py"))

    file_config.assert_called_once_with("alembic.ini")
    context.configure.assert_called_once_with(
        url=(
            "postgresql://pipeline%40example:p%40ss%2F%23word"
            "@db.example:6543/cSVD%2Fdata"
        ),
        target_metadata=None,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    context.begin_transaction.return_value.__enter__.assert_called_once_with()
    context.run_migrations.assert_called_once_with()
    assert callable(namespace["run_migrations_online"])


def test_alembic_online_mode_uses_engine_connection(monkeypatch, mocker) -> None:
    _set_database_environment(monkeypatch)
    mocker.patch("dotenv.load_dotenv")
    context = mocker.patch("alembic.context")
    context.config.config_file_name = None
    context.is_offline_mode.return_value = False
    engine = MagicMock()
    connection = engine.connect.return_value.__enter__.return_value
    create_engine = mocker.patch("sqlalchemy.create_engine", return_value=engine)

    runpy.run_path(str(_ALEMBIC / "env.py"))

    create_engine.assert_called_once_with(
        "postgresql://pipeline%40example:p%40ss%2F%23word"
        "@db.example:6543/cSVD%2Fdata"
    )
    context.configure.assert_called_once_with(
        connection=connection,
        target_metadata=None,
    )
    context.run_migrations.assert_called_once_with()


def test_alembic_reports_all_missing_database_variables(monkeypatch, mocker) -> None:
    for name in ("DB_NAME", "DB_USER", "DB_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    mocker.patch("dotenv.load_dotenv")
    context = mocker.patch("alembic.context")
    context.config.config_file_name = None
    context.is_offline_mode.return_value = True

    with pytest.raises(RuntimeError, match="DB_NAME.*DB_USER.*DB_PASSWORD"):
        runpy.run_path(str(_ALEMBIC / "env.py"))


def _revision_files() -> list[Path]:
    return sorted((_ALEMBIC / "versions").glob("[0-9]*.py"))


def _revision_graph() -> dict[str, str | None]:
    """Map each revision id to the one it revises, read from the files."""
    graph: dict[str, str | None] = {}
    for path in _revision_files():
        namespace = runpy.run_path(str(path))
        revision = namespace["revision"]
        assert revision not in graph, (
            f"revision {revision!r} is claimed by more than one file. "
            "Two branches numbered the same migration; alembic records one "
            "version string, so the second is unreachable and silently never "
            "applied. Renumber the later one."
        )
        graph[revision] = namespace["down_revision"]
    return graph


def test_every_migration_file_has_an_sql_case() -> None:
    """The SQL cases above cannot quietly cover less than the directory."""
    cased = {case[0] for case in _SQL_CASES}
    assert {path.name for path in _revision_files()} == cased


def test_revision_ids_are_unique_and_form_one_head() -> None:
    """Two migrations sharing an id leaves one of them unreachable.

    Merging two branches that each added an ``008`` produced exactly
    that: ``alembic_version`` held the ambiguous string ``"008"``,
    ``alembic upgrade head`` considered itself finished, and the second
    migration's columns were never created. Nothing failed loudly --
    alembic warns and moves on -- so the run report had nowhere to be
    written and the About page kept rendering its fallback card.
    """
    graph = _revision_graph()
    revised = {down for down in graph.values() if down is not None}
    heads = sorted(set(graph) - revised)
    assert heads == [max(graph)], f"expected one head, found {heads}"

    roots = [revision for revision, down in graph.items() if down is None]
    assert len(roots) == 1, f"expected one root, found {sorted(roots)}"

    for revision, down in graph.items():
        assert down is None or down in graph, (
            f"revision {revision!r} revises {down!r}, which does not exist"
        )
