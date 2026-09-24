"""Tests for pipeline.export.main -- the ten-step export orchestration
and CLI entrypoint, ported from export.R's run_export().

_read_table gets its own direct tests against a mocked Database.connection
(mirroring tests/pipeline/export/test_lookups.py's pattern). run_export
itself is tested with _read_table, the table cleaners, and the four
lookups all mocked -- per the task brief, this isolates the orchestration
logic that is genuinely main.py's own: gene-symbol/target/PMID extraction,
staging file names, and the final atomic publish. Nothing here touches a
real database.
"""

import asyncio
import json
import logging
from collections.abc import Mapping, Sequence
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from pipeline.database import Database
from pipeline.export.main import (
    _GENE_COLUMNS,
    _UNPUBLISHED_TRIAL_STATUSES,
    _read_curated_trials,
    _read_genes_with_lists,
    _read_table,
    main,
    run_export,
)
from pipeline.export.tables import _RENAMES
from pipeline.export.text import clean_column_name
from pipeline.export.writer import to_camel


def _mock_connection(mocker, conn: AsyncMock) -> None:
    """Patch Database.connection() to yield `conn` as an async context
    manager, mirroring tests/pipeline/test_database.py.
    """
    mocker.patch.object(
        Database,
        "connection",
        return_value=AsyncMock(
            __aenter__=AsyncMock(return_value=conn),
            __aexit__=AsyncMock(return_value=False),
        ),
    )


# ---------------------------------------------------------------------------
# _read_table
# ---------------------------------------------------------------------------


class TestReadTable:
    async def test_rejects_a_table_outside_the_allowlist(self) -> None:
        with pytest.raises(ValueError, match="Unsupported dashboard table"):
            await _read_table("pubmed_citations")

    async def test_drops_database_only_metadata_columns(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(
            return_value=[
                {
                    "id": 1,
                    "gene": "LAMB1",
                    "protein": "LAMB1",
                    "created_at": "2026-01-01",
                    "updated_at": "2026-01-02",
                }
            ]
        )
        _mock_connection(mocker, mock_conn)

        rows = await _read_table("genes")

        assert rows == [{"gene": "LAMB1", "protein": "LAMB1"}]

    async def test_queries_the_requested_table_by_name(self, mocker) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        _mock_connection(mocker, mock_conn)

        await _read_table("clinical_trials")

        await_args = mock_conn.fetch.await_args
        assert await_args is not None, "_read_table executed no SQL"
        assert "clinical_trials" in await_args.args[0]

    async def test_the_rows_are_read_in_a_deterministic_order(
        self, mocker
    ) -> None:
        """Without ORDER BY, PostgreSQL returns rows in whatever physical
        order it likes, and the byte-exact contract
        (tests/pipeline/export/test_writer.py) cannot hold across runs. The
        mock returns rows already in order, so nothing else in this file can
        see the clause disappear -- the regression would surface only as a
        whole-file row shuffle at the next `deno task data`.
        """
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        _mock_connection(mocker, mock_conn)

        await _read_table("clinical_trials")

        await_args = mock_conn.fetch.await_args
        assert await_args is not None, "_read_table executed no SQL"
        assert "ORDER BY id" in await_args.args[0]

    async def test_a_row_with_no_metadata_columns_passes_through_unchanged(
        self, mocker
    ) -> None:
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[{"drug": "Butylphthalide"}])
        _mock_connection(mocker, mock_conn)

        rows = await _read_table("clinical_trials")

        assert rows == [{"drug": "Butylphthalide"}]


# ---------------------------------------------------------------------------
# run_export -- fixtures
# ---------------------------------------------------------------------------

# _read_table's raw return value is irrelevant content-wise once
# clean_gene_row/clean_trial_row are mocked -- only its length matters,
# since main.py calls the cleaner once per row.
_RAW_GENES: list[dict[str, object]] = [
    {"gene": "g1"},
    {"gene": "g2"},
    {"gene": "g3"},
]
# target_population is what makes a trial row publishable -- an uncurated
# ClinicalTrials.gov discovery has none, and run_export drops it before the
# cleaner ever sees it -- so every row here carries one.
_RAW_TRIALS: list[dict[str, object]] = [
    {"drug": "d1", "target_population": "SVD"},
    {"drug": "d2", "target_population": "Stroke"},
]

# Duplicate "LAMB1" (rows 0 and 2) and a duplicate PMID ("37063705" in rows
# 0 and 2) exercise the dict.fromkeys de-duplication in run_export itself.
# "012345" (leading zero) and "(reference needed)" (non-numeric) must both
# be filtered out of the PMID list, mirroring export.R's
# grep("^[1-9][0-9]*$", ...).
_CLEANED_GENES = [
    {"Gene": "LAMB1", "References": ["37063705", "(reference needed)"]},
    {"Gene": "HTRA1", "References": ["012345", "12345678"]},
    {"Gene": "LAMB1", "References": ["37063705"]},
]
_CLEANED_TRIALS = [
    {"Genetic Target": "NOTCH3, HTRA1"},
    {"Genetic Target": "N/A"},
]

_STAGED_FILENAMES = (
    "table1.json",
    "table2.json",
    "gene_info.json",
    "gene_info_table2.json",
    "protein_info.json",
    "refs.json",
    "omim_info.json",
    "pipeline_status.json",
    "gene_annotations.json",
    "pipeline_run.json",
    "pipeline_syncs.json",
)


async def _fake_read_table(name: str) -> list[dict[str, object]]:
    return {"genes": _RAW_GENES, "clinical_trials": _RAW_TRIALS}[name]


async def _fake_read_genes_with_lists() -> list[dict[str, object]]:
    """run_export reads genes through the join-table reader now, not
    _read_table -- the trials still come through the latter."""
    return _RAW_GENES


def _patch_export_dependencies(mocker, *, pubmed_side_effect=None):
    """Patch every DB-backed step run_export calls, per the brief's
    guidance: the orchestration is tested with the lookups and table
    cleaners mocked. write_rows/write_value/publish_atomically are left
    real, so the staged files are genuinely written and published.
    """
    mocker.patch("pipeline.export.main._read_table", side_effect=_fake_read_table)
    mocker.patch(
        "pipeline.export.main._read_genes_with_lists",
        side_effect=_fake_read_genes_with_lists,
    )
    mocker.patch(
        "pipeline.export.main.clean_gene_row", side_effect=list(_CLEANED_GENES)
    )
    mocker.patch(
        "pipeline.export.main.clean_trial_row", side_effect=list(_CLEANED_TRIALS)
    )
    mock_ncbi = mocker.patch(
        "pipeline.export.main.read_ncbi_gene_info",
        new_callable=AsyncMock,
        return_value=[{"name": "x"}],
    )
    mock_uniprot = mocker.patch(
        "pipeline.export.main.read_uniprot_info",
        new_callable=AsyncMock,
        return_value=[{"gene": "x"}],
    )
    mock_pubmed = mocker.patch(
        "pipeline.export.main.read_pubmed_refs",
        new_callable=AsyncMock,
        return_value=[{"pmid": "x"}],
        side_effect=pubmed_side_effect,
    )
    mock_status = mocker.patch(
        "pipeline.export.main.read_pipeline_status",
        new_callable=AsyncMock,
        return_value={"runTimestamp": "2026-01-01T00:00:00Z"},
    )
    mock_omim = mocker.patch(
        "pipeline.export.main.read_omim_csv",
        return_value=[{"omim_num": 1}],
    )
    mock_annotations = mocker.patch(
        "pipeline.export.main.read_disease_annotations",
        new_callable=AsyncMock,
        return_value=[{"gene_symbol": "HTRA1"}],
    )
    mock_run = mocker.patch(
        "pipeline.export.main.read_pipeline_run",
        new_callable=AsyncMock,
        return_value={"runTimestamp": "2026-01-01T00:00:00Z", "status": "completed"},
    )
    mock_syncs = mocker.patch(
        "pipeline.export.main.read_sync_runs",
        new_callable=AsyncMock,
        return_value=[{"mode": "annotation_sync", "status": "completed"}],
    )
    return {
        "ncbi": mock_ncbi,
        "uniprot": mock_uniprot,
        "pubmed": mock_pubmed,
        "status": mock_status,
        "omim": mock_omim,
        "annotations": mock_annotations,
        "run": mock_run,
        "syncs": mock_syncs,
    }


# ---------------------------------------------------------------------------
# run_export
# ---------------------------------------------------------------------------


class TestRunExport:
    async def test_stages_and_publishes_all_ten_files_with_correct_wiring(
        self, tmp_path: Path, mocker
    ) -> None:
        target_dir = tmp_path / "data"  # deliberately not pre-created
        mocks = _patch_export_dependencies(mocker)

        await run_export(target_dir=target_dir)

        # Exactly the ten generated files land in target_dir -- no
        # leftover staging tempdir, no .previous-export backup.
        assert sorted(p.name for p in target_dir.iterdir()) == sorted(_STAGED_FILENAMES)

        table1 = json.loads((target_dir / "table1.json").read_text())
        assert [row["gene"] for row in table1] == ["LAMB1", "HTRA1", "LAMB1"]

        status = json.loads((target_dir / "pipeline_status.json").read_text())
        assert status == {"runTimestamp": "2026-01-01T00:00:00Z"}

        # The full report is a separate file from the summary above: the
        # date badge reads the summary, and keeping both means the page
        # still renders when no run has recorded a report yet.
        run = json.loads((target_dir / "pipeline_run.json").read_text())
        assert run == {"runTimestamp": "2026-01-01T00:00:00Z", "status": "completed"}

        # gene_symbols: unique Gene values from the cleaned rows, in
        # first-occurrence order.
        assert mocks["ncbi"].call_args_list[0].args[0] == ["LAMB1", "HTRA1"]
        # targets: split_genetic_targets applied to the REAL (unmocked)
        # function against the cleaned trials' "Genetic Target" column --
        # "N/A" must contribute nothing.
        assert mocks["ncbi"].call_args_list[1].args[0] == ["NOTCH3", "HTRA1"]
        assert mocks["uniprot"].call_args_list[0].args[0] == ["LAMB1", "HTRA1"]
        mocks["omim"].assert_called_once_with()
        mocks["status"].assert_called_once_with()
        mocks["annotations"].assert_awaited_once_with()
    async def test_an_unsynced_annotation_table_keeps_the_committed_file(
        self, tmp_path: Path, mocker, caplog
    ) -> None:
        """An empty read must not publish `[]` over 36 KB of committed data.

        Every other export step reads a table the main pipeline fills, or goes
        through complete_lookup, which guarantees a row per requested key. This
        one reads a table only `--sync-annotations` fills, so a fresh database
        restore or a schema rebuild would otherwise blank the file -- and
        publish_atomically is, by design, not reversible after it returns.
        """
        target_dir = tmp_path / "data"
        target_dir.mkdir()
        committed = target_dir / "gene_annotations.json"
        committed.write_text('[\n  {\n    "geneSymbol": "HTRA1"\n  }\n]\n')

        mocks = _patch_export_dependencies(mocker)
        mocks["annotations"].return_value = []

        with caplog.at_level(logging.WARNING):
            await run_export(target_dir=target_dir)

        assert committed.read_text() == '[\n  {\n    "geneSymbol": "HTRA1"\n  }\n]\n'
        assert "--sync-annotations" in caplog.text
        # Every other file was still published.
        assert (target_dir / "table1.json").exists()

    async def test_pmid_extraction_filters_non_numeric_and_leading_zero_refs(
        self, tmp_path: Path, mocker
    ) -> None:
        """Mirrors export.R's extract_unique_pmids: grep('^[1-9][0-9]*$', ...)
        after flattening the References list-column.
        """
        mocker.patch("pipeline.export.main._read_table", side_effect=_fake_read_table)
        mocker.patch(
            "pipeline.export.main._read_genes_with_lists",
            side_effect=_fake_read_genes_with_lists,
        )
        mocker.patch(
            "pipeline.export.main.clean_gene_row",
            side_effect=[
                {
                    "Gene": "A",
                    "References": [
                        "37063705",
                        "(reference needed)",
                        "0",
                        "0765",
                        "7654321",
                        "37063705",
                    ],
                },
                {"Gene": "B", "References": ["(reference needed)"]},
                {"Gene": "C", "References": []},
            ],
        )
        mocker.patch(
            "pipeline.export.main.clean_trial_row", side_effect=list(_CLEANED_TRIALS)
        )
        mocker.patch(
            "pipeline.export.main.read_ncbi_gene_info",
            new_callable=AsyncMock,
            return_value=[],
        )
        mocker.patch(
            "pipeline.export.main.read_uniprot_info",
            new_callable=AsyncMock,
            return_value=[],
        )
        mock_pubmed = mocker.patch(
            "pipeline.export.main.read_pubmed_refs",
            new_callable=AsyncMock,
            return_value=[],
        )
        mocker.patch(
            "pipeline.export.main.read_pipeline_status",
            new_callable=AsyncMock,
            return_value=None,
        )
        # The three report readers reach a real Database.connection() when
        # they are not mocked. They used to swallow the resulting
        # DatabaseConfigError; now only migration lag is tolerated, so this
        # test has to say what they return like every other reader here.
        mocker.patch(
            "pipeline.export.main.read_disease_annotations",
            new_callable=AsyncMock,
            return_value=[],
        )
        mocker.patch(
            "pipeline.export.main.read_pipeline_run",
            new_callable=AsyncMock,
            return_value=None,
        )
        mocker.patch(
            "pipeline.export.main.read_sync_runs",
            new_callable=AsyncMock,
            return_value=[],
        )
        mocker.patch("pipeline.export.main.read_omim_csv", return_value=[])

        await run_export(target_dir=tmp_path / "data")

        assert mock_pubmed.call_args.args[0] == ["37063705", "7654321"]

    async def test_a_failure_partway_through_leaves_target_dir_untouched(
        self, tmp_path: Path, mocker
    ) -> None:
        """A failed step must not publish anything and must not leave the
        staging tempdir behind either -- the same "no mixed generation"
        guarantee publish_atomically gives the final publish step, but for
        a failure that happens before publish is even reached.
        """
        target_dir = tmp_path / "data"
        target_dir.mkdir()
        (target_dir / "table1.json").write_text("OLD\n")

        _patch_export_dependencies(
            mocker, pubmed_side_effect=RuntimeError("db exploded")
        )

        with pytest.raises(RuntimeError, match="db exploded"):
            await run_export(target_dir=target_dir)

        assert (target_dir / "table1.json").read_text() == "OLD\n"
        assert [p.name for p in target_dir.iterdir()] == ["table1.json"]


# ---------------------------------------------------------------------------
# main() -- the sync CLI entrypoint
# ---------------------------------------------------------------------------


class TestMain:
    """main() drives its own event loop via asyncio.run(), so these tests
    must stay synchronous: calling asyncio.run() from inside an
    already-running loop (as pytest-asyncio's auto mode would give an
    `async def` test) raises RuntimeError.
    """

    def test_closes_the_database_after_a_successful_export(self, mocker) -> None:
        mock_run_export = mocker.patch(
            "pipeline.export.main.run_export", new_callable=AsyncMock
        )
        mock_close = mocker.patch.object(Database, "close", new_callable=AsyncMock)

        main()

        mock_run_export.assert_awaited_once_with()
        mock_close.assert_awaited_once_with()

    def test_closes_the_database_even_when_export_raises(self, mocker) -> None:
        mocker.patch(
            "pipeline.export.main.run_export",
            new_callable=AsyncMock,
            side_effect=RuntimeError("boom"),
        )
        mock_close = mocker.patch.object(Database, "close", new_callable=AsyncMock)

        with pytest.raises(RuntimeError, match="boom"):
            main()

        mock_close.assert_awaited_once_with()

    def test_completes_when_the_pool_is_bound_to_the_run_loop(self, mocker) -> None:
        """The two tests above replace Database.close with a plain
        AsyncMock, which has no loop-bound state to violate -- so they
        cannot catch a real bug: asyncpg.Pool captures
        asyncio.get_running_loop() at construction (pool.py's __init__
        sets self._loop = loop) and Pool.close() later does
        self._loop.call_later(60, self._warn_on_long_close). If main()
        ran run_export() and Database.close() under two SEPARATE
        asyncio.run() calls, the pool would bind to the first call's loop,
        that loop would be closed by the time the second call reached
        close(), and call_later would raise "RuntimeError: Event loop is
        closed" on every real, database-backed run.

        This fake pool reproduces exactly that loop-capture shape without
        needing a real connection. It is deliberately NOT an AsyncMock:
        an AsyncMock's close() has no loop of its own to be closed out
        from under it, which is exactly why the tests above cannot see
        this bug.
        """

        class _LoopBoundFakePool:
            def __init__(self) -> None:
                self._loop = asyncio.get_running_loop()

            async def close(self) -> None:
                self._loop.call_later(60, lambda: None)

        async def fake_run_export(*args: object, **kwargs: object) -> None:
            # Mirrors what a real run_export does: the first DB touch
            # lazily creates the pool via Database.get_pool(), binding it
            # to whatever loop is running at that moment.
            # _LoopBoundFakePool deliberately isn't an asyncpg.Pool -- it
            # only reproduces the one loop-binding behavior under test.
            mocker.patch.object(Database, "_pool", _LoopBoundFakePool())

        mocker.patch(
            "pipeline.export.main.run_export",
            new_callable=AsyncMock,
            side_effect=fake_run_export,
        )
        # Database.close() itself is real here -- only the pool under it
        # is fake -- so this exercises the actual close() classmethod
        # calling the actual (fake) pool's close() from whatever loop
        # main() runs it in.

        main()  # must not raise RuntimeError: Event loop is closed


# ---------------------------------------------------------------------------
# _read_curated_trials -- the curation gate on Table 2
# ---------------------------------------------------------------------------


class TestReadCuratedTrials:
    """`--clinical-trials` writes discoveries into the curated table.

    Ten broad search terms match hundreds of interventional drug studies,
    each arriving with every curator column NULL. Published, those rows
    read "(unknown)" for mechanism, population and genetic evidence --
    values no filter choice offers and lib/timeline_encoding.json does not
    carry, so the radar draws them nowhere while Table 2 lists them.
    """

    @staticmethod
    def _rows(mocker, rows: Sequence[Mapping[str, object]]) -> None:
        mocker.patch(
            "pipeline.export.main._read_table",
            new_callable=AsyncMock,
            return_value=rows,
        )

    async def test_a_row_with_no_target_population_is_not_published(
        self, mocker, caplog
    ) -> None:
        self._rows(
            mocker,
            [
                {"drug": "Cilostazol", "target_population": "Stroke"},
                {"drug": "Discovered", "target_population": None},
            ],
        )

        with caplog.at_level(logging.WARNING, logger="pipeline.export.main"):
            rows = await _read_curated_trials()

        assert rows == [{"drug": "Cilostazol", "target_population": "Stroke"}]
        assert "Skipping 1 of 2 clinical trial row(s)" in caplog.text

    async def test_a_blank_population_counts_as_uncurated(self, mocker) -> None:
        self._rows(mocker, [{"drug": "Discovered", "target_population": "   "}])

        assert await _read_curated_trials() == []

    async def test_a_fully_curated_table_is_published_whole_and_silently(
        self, mocker, caplog
    ) -> None:
        rows = [
            {"drug": "Cilostazol", "target_population": "Stroke"},
            {"drug": "Cerebrolysin", "target_population": "SVD"},
        ]
        self._rows(mocker, rows)

        with caplog.at_level(logging.WARNING, logger="pipeline.export.main"):
            assert await _read_curated_trials() == rows

        assert caplog.text == ""


# ---------------------------------------------------------------------------
# _read_genes_with_lists, and the published column order
# ---------------------------------------------------------------------------


def test_the_published_gene_columns_match_the_committed_key_order(
    committed_rows,
) -> None:
    """_GENE_COLUMNS is the only thing holding the JSON key order once the
    three list columns leave the table, so it is pinned against the file
    rather than against a hand-written list."""
    committed = list(committed_rows("table1.json")[0])
    labels = [clean_column_name(name) for name in _GENE_COLUMNS]
    expected = [to_camel(_RENAMES.get(label, label)) for label in labels]
    expected.remove("gene")  # clean_gene_row hoists it to the front
    assert ["gene", *expected] == committed


async def test_a_gene_with_no_join_rows_keeps_its_null_placeholders(mocker) -> None:
    """The empty case must never publish a scalar. Selecting the real
    column instead of a placeholder would put the raw cell here, and the
    17 rows that read "(reference needed)" hold DOI prose, not NULL --
    they would have shipped as strings in an array-typed field.
    """
    mock_conn = AsyncMock()
    mock_conn.fetch = AsyncMock(
        side_effect=[
            [{"id": 1, "gene": "HTRA1", "gwas_trait": None, "references": None}],
            [],  # gene_references
            [],  # gene_gwas_traits
            [],  # gene_monogenic_links
        ]
    )
    _mock_connection(mocker, mock_conn)

    assert await _read_genes_with_lists() == [
        {"gene": "HTRA1", "gwas_trait": None, "references": None}
    ]


async def test_join_rows_attach_to_their_gene_in_ordinal_order(mocker) -> None:
    mock_conn = AsyncMock()
    mock_conn.fetch = AsyncMock(
        side_effect=[
            [{"id": 1, "gene": "HTRA1", "references": None}],
            [
                {"gene_id": 1, "pmid": "33773636"},
                {"gene_id": 1, "pmid": "33773637"},
            ],
            [],
            [],
        ]
    )
    _mock_connection(mocker, mock_conn)

    assert await _read_genes_with_lists() == [
        {"gene": "HTRA1", "references": ["33773636", "33773637"]}
    ]


async def test_every_gene_read_orders_its_rows(mocker) -> None:
    """Four ORDER BY clauses, all load-bearing: the gene row order and each
    join table's within-gene ordinal order both reach data/table1.json.
    The three join queries share one literal, so a single deletion loses the
    order of references, gwasTrait and linkToMonogenicDisease at once -- and
    the mocks above feed pre-ordered rows, so nothing else here would notice.
    """
    mock_conn = AsyncMock()
    mock_conn.fetch = AsyncMock(side_effect=[[], [], [], []])
    _mock_connection(mocker, mock_conn)

    await _read_genes_with_lists()

    issued = [call.args[0] for call in mock_conn.fetch.await_args_list]
    assert len(issued) == 4
    assert issued[0].endswith("FROM genes ORDER BY id")
    for join_sql in issued[1:]:
        assert join_sql.endswith("ORDER BY gene_id, ordinal")


# ---------------------------------------------------------------------------
# _read_curated_trials -- the ClinicalTrials.gov status gate on Table 2
# ---------------------------------------------------------------------------


class TestStoppedTrialsAreNotPublished:
    """A trial CT.gov reports as TERMINATED or WITHDRAWN is not published.

    TERMINATED stopped early; WITHDRAWN never enrolled a participant.
    Neither produced a completed result, so neither belongs in Table 2, on
    the trials radar or on the map -- all three of which read
    data/table2.json, so this one gate covers every surface.

    Everything here fails open. The only thing that removes a row is a
    status the export fetched and recognises as stopped; a NULL, a missing
    column, a blank and an unrecognised token all publish.
    """

    @staticmethod
    def _rows(mocker, rows: Sequence[Mapping[str, object]]) -> None:
        mocker.patch(
            "pipeline.export.main._read_table",
            new_callable=AsyncMock,
            return_value=rows,
        )

    @staticmethod
    def _trial(**overrides: object) -> dict[str, object]:
        row: dict[str, object] = {
            "drug": "Cilostazol",
            "registry_id": "NCT01011011",
            "target_population": "Stroke",
            "overall_status": "RECRUITING",
        }
        row.update(overrides)
        return row

    @pytest.mark.parametrize("status", sorted(_UNPUBLISHED_TRIAL_STATUSES))
    async def test_a_stopped_trial_is_not_published(
        self, mocker, caplog, status: str
    ) -> None:
        self._rows(
            mocker,
            [
                self._trial(),
                self._trial(
                    drug="Donepezil",
                    registry_id="NCT00174382",
                    overall_status=status,
                ),
            ],
        )

        with caplog.at_level(logging.WARNING, logger="pipeline.export.main"):
            rows = await _read_curated_trials()

        assert [row["drug"] for row in rows] == ["Cilostazol"]
        # Named, not just counted: which trials left Table 2 is what the
        # operator reads the diff against.
        assert "Skipping 1 of 2 curated clinical trial row(s)" in caplog.text
        assert f"NCT00174382 ({status})" in caplog.text

    async def test_every_row_of_a_stopped_trial_goes(self, mocker) -> None:
        """NCT03082014 carries three drug rows; the trial stopped, not one arm."""
        self._rows(
            mocker,
            [
                self._trial(drug=drug, registry_id="NCT03082014",
                            overall_status="TERMINATED")
                for drug in ("Amlodipine", "Losartan", "Atenolol")
            ],
        )

        assert await _read_curated_trials() == []

    async def test_a_trial_ct_gov_cannot_speak_for_is_published(
        self, mocker, caplog
    ) -> None:
        """ISRCTN, ChiCTR and ANZCTR rows are never swept, so they stay NULL."""
        self._rows(
            mocker,
            [self._trial(registry_id="ISRCTN14632228", overall_status=None)],
        )

        with caplog.at_level(logging.WARNING, logger="pipeline.export.main"):
            rows = await _read_curated_trials()

        assert len(rows) == 1
        assert caplog.text == ""

    async def test_a_database_without_the_column_publishes_everything(
        self, mocker
    ) -> None:
        """Migration 013 not taken: no key at all, and the gate is inert.

        The row itself still comes back -- _is_running_trial fails open on a
        missing key -- but it now carries no `overall_status` key at all, so
        clean_trial_row's `out["Overall Status"]` indexing raises KeyError
        downstream. That is the loud failure the export wants on a database
        below migration 013, rather than a silently absent column.
        """
        self._rows(mocker, [{"drug": "Cilostazol", "target_population": "Stroke"}])

        assert await _read_curated_trials() == [
            {"drug": "Cilostazol", "target_population": "Stroke"}
        ]

    async def test_a_blank_status_publishes(self, mocker) -> None:
        self._rows(mocker, [self._trial(overall_status="   ")])

        assert len(await _read_curated_trials()) == 1

    @pytest.mark.parametrize("status", ["terminated", " Terminated ", "wIthdrawn"])
    async def test_the_comparison_normalises_case_and_whitespace(
        self, mocker, status: str
    ) -> None:
        self._rows(mocker, [self._trial(overall_status=status)])

        assert await _read_curated_trials() == []

    @pytest.mark.parametrize(
        "status",
        [
            "SUSPENDED",
            "UNKNOWN",
            "COMPLETED",
            "ACTIVE_NOT_RECRUITING",
            "NO_LONGER_A_WORD",
        ],
    )
    async def test_a_status_outside_the_denylist_publishes(
        self, mocker, status: str
    ) -> None:
        """SUSPENDED intends to resume; UNKNOWN is a gap, not a stopped trial.

        The last case is the point of a denylist: a status this module has
        never heard of goes on publishing rather than vanishing.
        """
        self._rows(mocker, [self._trial(overall_status=status)])

        assert len(await _read_curated_trials()) == 1

    async def test_the_status_is_published_on_every_surviving_row(self, mocker) -> None:
        # It used to be stripped here. The dashboard now filters on it.
        self._rows(mocker, [self._trial(), self._trial(
            registry_id="ISRCTN14632228", overall_status=None)])

        rows = await _read_curated_trials()

        assert [row["overall_status"] for row in rows] == ["RECRUITING", None]

    async def test_an_uncurated_stopped_row_is_counted_once(
        self, mocker, caplog
    ) -> None:
        """Curation runs first: it was never going to publish anyway."""
        self._rows(
            mocker,
            [
                self._trial(),
                self._trial(
                    drug="Discovered",
                    target_population=None,
                    overall_status="TERMINATED",
                ),
            ],
        )

        with caplog.at_level(logging.WARNING, logger="pipeline.export.main"):
            rows = await _read_curated_trials()

        assert [row["drug"] for row in rows] == ["Cilostazol"]
        assert "Skipping 1 of 2 clinical trial row(s)" in caplog.text
        assert "curated clinical trial row(s)" not in caplog.text

    async def test_a_table_of_running_trials_publishes_whole_and_silently(
        self, mocker, caplog
    ) -> None:
        self._rows(
            mocker,
            [
                self._trial(),
                self._trial(drug="Cerebrolysin", overall_status="COMPLETED"),
            ],
        )

        with caplog.at_level(logging.WARNING, logger="pipeline.export.main"):
            rows = await _read_curated_trials()

        assert len(rows) == 2
        assert caplog.text == ""
