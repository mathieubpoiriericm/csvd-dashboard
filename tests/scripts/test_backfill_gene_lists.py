"""Coverage for the gene-list backfill.

`testpaths` is `["tests/pipeline"]`, so nothing collects this file -- in CI
either -- unless it is named: `uv run pytest tests/scripts`.
"""

import asyncio
import runpy
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from pipeline.database import Database

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "backfill_gene_lists.py"

_LEGACY_COLUMNS = {"references", "gwas_trait", "link_to_monogenetic_disease"}


def _connection_with(monkeypatch: pytest.MonkeyPatch, columns: set[str]) -> AsyncMock:
    """Patch Database.connection() to yield a connection whose only answer
    is the information_schema probe, mirroring tests/pipeline/export."""
    conn = AsyncMock()
    conn.fetch = AsyncMock(return_value=[{"column_name": c} for c in columns])
    # asyncpg's transaction() is a plain call returning an async context
    # manager; an AsyncMock child would hand back a coroutine instead.
    conn.transaction = MagicMock(
        return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=None),
            __aexit__=AsyncMock(return_value=False),
        )
    )
    monkeypatch.setattr(
        Database,
        "connection",
        lambda: AsyncMock(
            __aenter__=AsyncMock(return_value=conn),
            __aexit__=AsyncMock(return_value=False),
        ),
    )
    return conn


def test_parsers_agree_with_the_export_for_a_mangled_cell() -> None:
    """The corruption case must produce zero rows, never a fabricated PMID."""
    namespace = runpy.run_path(str(_SCRIPT))
    _, _, _, parse = namespace["_TARGETS"][0]
    assert parse("2,606,365,833,773,630,000") == []


def test_ordinals_start_at_zero_and_follow_source_order() -> None:
    namespace = runpy.run_path(str(_SCRIPT))
    _, _, _, parse = namespace["_TARGETS"][0]
    assert list(enumerate(parse("33773636, 32358547"))) == [
        (0, "33773636"),
        (1, "32358547"),
    ]


def test_every_target_names_a_column_the_script_probes_for() -> None:
    """Migration 006 dropped the three delimited columns, so on a current
    database the SELECT raised UndefinedColumnError before doing anything.
    The script now asks information_schema first; the probe and _TARGETS
    must name the same columns or one of them drifts from the SELECT."""
    namespace = runpy.run_path(str(_SCRIPT))
    sources = {source for _, _, source, _ in namespace["_TARGETS"]}
    assert sources == _LEGACY_COLUMNS
    assert set(namespace["_LEGACY_COLUMNS"]) == _LEGACY_COLUMNS


def test_a_database_past_migration_006_exits_before_touching_anything(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = _connection_with(monkeypatch, set())
    namespace = runpy.run_path(str(_SCRIPT))

    with pytest.raises(SystemExit, match="migration 006"):
        asyncio.run(namespace["backfill"](dry_run=False))

    # Only the probe ran: nothing was selected from genes, nothing deleted.
    assert conn.fetch.await_count == 1
    assert "information_schema.columns" in conn.fetch.await_args.args[0]
    conn.execute.assert_not_awaited()


def test_a_partially_dropped_table_is_refused_too(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """All three or nothing: a backfill that silently skipped one table
    would leave the join tables disagreeing with data/table1.json."""
    _connection_with(monkeypatch, {"references", "gwas_trait"})
    namespace = runpy.run_path(str(_SCRIPT))

    with pytest.raises(SystemExit, match="link_to_monogenetic_disease"):
        asyncio.run(namespace["backfill"](dry_run=True))


def test_a_database_that_still_has_the_columns_is_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = _connection_with(monkeypatch, _LEGACY_COLUMNS)
    probe = [{"column_name": c} for c in _LEGACY_COLUMNS]
    conn.fetch = AsyncMock(side_effect=[probe, []])
    namespace = runpy.run_path(str(_SCRIPT))

    counts = asyncio.run(namespace["backfill"](dry_run=True))

    assert counts == {
        "gene_references": 0,
        "gene_gwas_traits": 0,
        "gene_monogenic_links": 0,
    }
    assert conn.fetch.await_count == 2
