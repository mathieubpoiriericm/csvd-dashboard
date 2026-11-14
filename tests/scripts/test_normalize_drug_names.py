"""scripts/normalize_drug_names.py's gold-only refusal.

While `GOLD_ONLY` is true the stored drugs are the curated gold spellings,
research codes included, and the script would rewrite them; it refuses to
write and still reports a dry run. Synthetic names only, so it holds for any
disease.
"""

import asyncio
from unittest.mock import AsyncMock

import pytest
from scripts import normalize_drug_names, reconcile_drug_names


def test_a_write_is_refused_while_gold_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(normalize_drug_names, "gold_only", lambda: True)
    load = AsyncMock(return_value=[])
    monkeypatch.setattr(normalize_drug_names, "_load", load)

    with pytest.raises(SystemExit) as exc:
        asyncio.run(normalize_drug_names.main([]))

    assert exc.value.code == 2
    load.assert_not_awaited()


def test_a_dry_run_is_allowed_while_gold_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(normalize_drug_names, "gold_only", lambda: True)
    monkeypatch.setattr(normalize_drug_names, "Database", lambda: None)
    load = AsyncMock(
        return_value=[
            {
                "id": 1,
                "registry_id": "REG-0001",
                "drug": "Drug A (XY-123)",
                **dict.fromkeys(normalize_drug_names._CURATED),
            }
        ]
    )
    monkeypatch.setattr(normalize_drug_names, "_load", load)

    assert asyncio.run(normalize_drug_names.main(["--dry-run"])) == 0
    load.assert_awaited_once()


def test_an_unreadable_switch_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def broken() -> bool:
        raise ValueError("no declaration")

    monkeypatch.setattr(normalize_drug_names, "gold_only", broken)
    with pytest.raises(ValueError):
        asyncio.run(normalize_drug_names.main([]))


def test_the_report_sends_no_one_to_the_rewrite_while_gold_only() -> None:
    assert "refuses" in reconcile_drug_names._unclean_heading(True)
    assert "-- run scripts.normalize_drug_names" not in (
        reconcile_drug_names._unclean_heading(True)
    )
    assert "run scripts.normalize_drug_names" in (
        reconcile_drug_names._unclean_heading(False)
    )
