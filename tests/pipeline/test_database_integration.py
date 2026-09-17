"""The database layer against a real PostgreSQL, not a mock.

Every other test of `record_pipeline_run` patches `Database.connection`,
which is what let migration 003's first live run fail on a `DataError`
that no amount of asserting the SQL text could have caught -- and, more
recently, what hid a duplicate revision id: `009_add_run_report` was
never applied to any database a test could see, so nothing noticed that
`pipeline_runs` had no `report` column.

The gene merge is here for the same reason. `test_database.py` asserts
the merge CTE's three invariants as substrings of the statement asyncpg
was handed, which proves their spelling and nothing about what the
planner computes: dropping the value predicate from its NOT EXISTS keeps
every one of those assertions passing while a re-run silently stops
appending. The round-trip tests at the bottom of this file are what fail
on that.

These tests run against `dhi.io/postgres:18-alpine3.23` in a container the
`throwaway_postgres` fixture creates and destroys under Apple's
`container` runtime, migrated to head -- or against whatever
`CSVD_TEST_DB_URL` names, which is how they run in CI against its
`postgres` service. They skip only when neither is available.
Never point them at the developer's production database; that is what
`_isolate_credentials` exists to prevent.
"""

import argparse
import json
from datetime import UTC, datetime
from typing import Any, Final
from unittest.mock import AsyncMock

import pytest

import pipeline.export.main as export_main
import pipeline.main as pipeline_main
from pipeline.config import PipelineConfig
from pipeline.database import (
    Database,
    merge_genes_transactional,
    record_pipeline_run,
)
from pipeline.export.lookups import read_pipeline_run
from pipeline.run_errors import RunError
from pipeline.run_report import build_run_report
from pipeline.steps import PIPELINE_STEPS, StepRecorder

pytestmark = pytest.mark.usefixtures("database_env")


@pytest.fixture(autouse=True)
async def _close_pool():
    """Release the pool this module opens against the container."""
    yield
    await Database.close()


def _report_wire(status_source: StepRecorder) -> dict[str, Any]:
    run_data: dict[str, Any] = {
        "timestamp": datetime.now(UTC).isoformat(),
        "total_processing_time": 12.5,
        "total_compute_time": 9.0,
        "pipeline_config": {},
        "papers": {"processed": 3, "fulltext": 2, "abstract_only": 1, "failed": 0},
        "genes": {"extracted": 7, "validated": 5, "rejected": 2},
        "token_usage": {},
        "batch_validation_warnings": [],
        "papers_detail": [],
    }
    report = build_run_report(
        run_data,
        steps=status_source.records(),
        apis=[],
        run_mode="standard",
    )
    return report.to_wire()


async def test_the_container_is_migrated_to_a_single_head() -> None:
    """The schema the pipeline writes to is the one Alembic describes."""
    async with Database.connection() as conn:
        version = await conn.fetchval("SELECT version_num FROM alembic_version")
        columns = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'pipeline_runs'"
        )
        sync_columns = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'sync_runs'"
        )
        ncbi_columns = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'ncbi_gene_info'"
        )
        trial_columns = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'clinical_trials'"
        )

    names = {row["column_name"] for row in columns}
    assert version == "013"
    # The three migration 009 adds. Their absence is not a schema detail:
    # without them the run report has nowhere to be stored and the About
    # page silently falls back to its summary card.
    assert {"status", "duration_seconds", "report"} <= names
    # Migration 011's table. It is separate from pipeline_runs on purpose:
    # a refresh has no papers, genes or steps, and read_pipeline_status
    # would otherwise date the whole dashboard from one.
    assert {row["column_name"] for row in sync_columns} == {
        "id",
        "mode",
        "run_timestamp",
        "status",
        "duration_seconds",
        "report",
    }
    # Migration 012's column. Without it nothing in the schema carries a
    # chromosomal band, so a gene a run inserts publishes as "(unknown)"
    # and reaches no chromosome of the phenogram.
    assert "map_location" in {row["column_name"] for row in ncbi_columns}
    # Migration 013's column. Without it the export has nothing to read, so
    # terminated and withdrawn trials publish into Table 2 and onto the
    # radar beside the running ones.
    assert "overall_status" in {row["column_name"] for row in trial_columns}


async def test_a_run_report_round_trips_through_the_json_column() -> None:
    """What `record_pipeline_run` stores is what `read_pipeline_run` returns.

    The document crosses two boundaries a mock cannot exercise: asyncpg
    binds a JSON column from text rather than from a dict, and the export
    re-validates the stored bytes through `PipelineRunReport`.
    """
    recorder = StepRecorder()
    recorder.enter(0)
    recorder.action("Searched PubMed for the last 7 days")
    wire = _report_wire(recorder)

    row_id = await record_pipeline_run(
        run_timestamp=wire["runTimestamp"],
        papers_processed=3,
        fulltext_retrieved=2,
        genes_extracted=7,
        genes_validated=5,
        status=wire["status"],
        duration_seconds=wire["durationSeconds"],
        report=wire,
    )
    assert isinstance(row_id, int)

    published = await read_pipeline_run()
    assert published is not None
    assert published["status"] == "completed"
    assert published["papers"]["processed"] == 3
    assert published["genes"]["validated"] == 5
    assert len(published["steps"]) == len(PIPELINE_STEPS)
    assert published["steps"][0]["actions"] == [
        "Searched PubMed for the last 7 days"
    ]


async def test_an_iso_timestamp_reaches_a_timestamp_column() -> None:
    """asyncpg will not coerce a string into TIMESTAMP; the boundary does.

    `test_database.py` asserts the *bound type* against a mock. This
    asserts the value PostgreSQL actually stored.
    """
    moment = datetime(2026, 3, 24, 10, 0, tzinfo=UTC)

    row_id = await record_pipeline_run(
        run_timestamp=moment.isoformat(),
        papers_processed=1,
        fulltext_retrieved=1,
        genes_extracted=1,
        genes_validated=1,
    )

    async with Database.connection() as conn:
        stored = await conn.fetchval(
            "SELECT run_timestamp FROM pipeline_runs WHERE id = $1", row_id
        )
    assert stored == moment


async def test_a_failed_run_is_stored_as_failed() -> None:
    """The status column carries the badge the widget renders.

    A run that died before its first step used to reach this column as
    `completed`, because the failure was attributed to no step at all.
    """
    recorder = StepRecorder()
    recorder.fail(RunError(kind="unknown", title="search broke"), index=0)
    wire = _report_wire(recorder)
    assert wire["status"] == "failed"

    row_id = await record_pipeline_run(
        run_timestamp=wire["runTimestamp"],
        papers_processed=0,
        fulltext_retrieved=0,
        genes_extracted=0,
        genes_validated=0,
        status=wire["status"],
        duration_seconds=wire["durationSeconds"],
        report=wire,
    )

    async with Database.connection() as conn:
        stored = await conn.fetchval(
            "SELECT status FROM pipeline_runs WHERE id = $1", row_id
        )
    assert stored == "failed"


async def test_export_after_a_run_publishes_from_the_live_pool(
    tmp_path, monkeypatch, mocker
) -> None:
    """`--export` drives the real export on the pool the run already opened.

    Every other --export test mocks `run_export`, so none of them touches
    what the flag actually rests on: that the export runs *inside* the
    dispatcher's `try`, reusing the run's pool, before the `finally` closes
    it. Moving it after that `finally` still passes those mocked tests --
    the export would silently open a second pool -- and fails here.

    `PROJECT_ROOT` is redirected so the real writer publishes into tmp_path
    rather than over the repo's committed data/.
    """
    monkeypatch.setattr(export_main, "PROJECT_ROOT", tmp_path)
    mocker.patch("pipeline.main._record_and_notify", new=AsyncMock())
    mocker.patch("pipeline.main.close_async_client", new=AsyncMock())

    seen: dict[str, Any] = {}

    async def _sync_touching_the_database(**kwargs: Any) -> dict[str, Any]:
        async with Database.connection() as conn:
            await conn.fetchval("SELECT 1")
        seen["run_pool"] = Database._pool
        return {
            "name": "external_sync",
            "status": "ok",
            "metrics": {},
            "errors": [],
        }

    mocker.patch(
        "pipeline.main.run_external_data_sync",
        new=AsyncMock(side_effect=_sync_touching_the_database),
    )

    # _publish_export imports run_export inside the function, so patching
    # the module attribute is seen at call time. Record the pool, then run
    # the real export rather than a stand-in.
    real_run_export = export_main.run_export

    async def _recording_export(target_dir=None) -> None:
        seen["export_pool"] = Database._pool
        await real_run_export(target_dir)

    monkeypatch.setattr(export_main, "run_export", _recording_export)

    args = argparse.Namespace(
        pubmed=False,
        clinical_trials=False,
        sync_external_data=True,
        sync_annotations=False,
        days_back=7,
        dry_run=False,
        test_mode=False,
        batch=False,
        export=True,
    )
    exit_code = await pipeline_main._run_selected_pipelines(args, PipelineConfig())

    assert exit_code == 0
    # The pool the export used is the one the run opened, not a second one.
    assert seen["export_pool"] is not None
    assert seen["export_pool"] is seen["run_pool"]

    published = tmp_path / "data"
    # gene_annotations.json is skipped rather than emptied when its table
    # has no rows, so it is deliberately absent from an empty database.
    assert {p.name for p in published.glob("*.json")} == {
        "table1.json",
        "table2.json",
        "gene_info.json",
        "gene_info_table2.json",
        "protein_info.json",
        "refs.json",
        "omim_info.json",
        "pipeline_status.json",
        "pipeline_run.json",
        # Written unconditionally, unlike gene_annotations.json: sync_runs
        # rows are never deleted, so an empty read means no refresh has
        # been recorded and `[]` is the true answer.
        "pipeline_syncs.json",
    }
    # Real writer output, not a stand-in: no test inserts a gene, so the
    # published table is the empty array the writer produces.
    assert json.loads((published / "table1.json").read_text()) == []
    # Whatever the lookup returns is what reached the file. Asserted against
    # the lookup rather than a literal because the container is session-
    # scoped: the rows the other tests in this module record are visible
    # here, and under pytest-randomly their order is not fixed.
    assert json.loads((published / "pipeline_run.json").read_text()) == (
        await read_pipeline_run()
    )
    # The refresh this invocation just ran reached the committed file. This
    # is the end-to-end proof of migration 011's whole point: the dispatcher
    # recorded a sync, the export read it back, and it is on disk. Before
    # it, --sync-external-data wrote no row and published nothing at all.
    syncs = json.loads((published / "pipeline_syncs.json").read_text())
    assert "external_sync" in {entry["mode"] for entry in syncs}


async def test_a_refresh_round_trips_from_the_dispatcher_to_the_export() -> None:
    """The whole chain a refresh takes, against a real PostgreSQL.

    `_run_summary_pipeline` records what the API recorder saw,
    `record_sync_run` binds it into a JSON column, and `read_sync_runs`
    re-validates the stored bytes through `SyncRunReport`. Every step of
    that is mocked somewhere else; this is the one place the document
    crosses asyncpg, which binds a JSON column from text and not from a
    dict.
    """
    from pipeline.api_telemetry import current_recorder, reset_recorder
    from pipeline.export.lookups import read_sync_runs

    reset_recorder()

    async def sync() -> dict[str, Any]:
        # The two providers this whole record exists to publish. Before
        # migration 011 they reached no committed file at all.
        current_recorder().record(
            host="api.platform.opentargets.org",
            path="/api/v4/graphql",
            method="POST",
            status=200,
        )
        current_recorder().record(
            host="api.orphadata.com",
            path="/rd-cross-referencing/orphacodes/166024",
            method="GET",
            status=200,
        )
        return {
            "name": "annotation_sync",
            "status": "ok",
            "metrics": {
                "clinvar_fetched": 3,
                "clinvar_cached": 60,
                "orphadata_fetched": 12,
                "opentargets_fetched": 63,
                "drugs_written": 41,
            },
            "errors": [],
        }

    await pipeline_main._run_summary_pipeline(
        sync(), "annotation_sync", "Annotation sync"
    )

    # Selected by mode rather than taken as the only row: the container is
    # session-scoped, so the other tests in this module have recorded
    # refreshes of their own by the time this runs.
    published = await read_sync_runs()
    refresh = next(row for row in published if row["mode"] == "annotation_sync")
    assert refresh["status"] == "completed"
    # Named, not recorded under a bare hostname -- the point of the whole
    # change. `SERVICES` resolved both of these.
    assert sorted(row["label"] for row in refresh["apis"]) == [
        "Open Targets",
        "Orphadata",
    ]
    assert {row["key"]: row["cached"] for row in refresh["sources"]} == {
        "clinvar": 60,
        "orphadata": 0,
        "opentargets": 0,
        "opentargets_drugs": 0,
    }
    # The drug records are one uncached GraphQL search per drug, so they
    # are published as fetched -- `cached: 41` used to say the opposite.
    assert {row["key"]: row["fetched"] for row in refresh["sources"]} == {
        "clinvar": 3,
        "orphadata": 12,
        "opentargets": 63,
        "opentargets_drugs": 41,
    }


async def test_only_the_newest_refresh_per_mode_is_published() -> None:
    """`DISTINCT ON (mode)` against the real planner, not a mocked cursor.

    The About page shows the latest state of each kind of refresh, so a
    mode that has run twice must publish once.
    """
    from pipeline.database import record_sync_run
    from pipeline.export.lookups import read_sync_runs
    from pipeline.sync_report import build_sync_report

    summary: dict[str, Any] = {
        "name": "clinical_trials",
        "status": "ok",
        "metrics": {"fetched": 16, "cached": 16, "failed": 0},
        "errors": [],
    }
    for stamp in ("2026-09-01T01:00:00Z", "2026-09-02T01:00:00Z"):
        report = build_sync_report(
            summary,
            mode="clinical_trials",
            apis=[],
            run_timestamp=stamp,
            duration_seconds=1.0,
        )
        await record_sync_run(
            "clinical_trials",
            stamp,
            report.status,
            report.duration_seconds,
            report.to_wire(),
        )

    published = await read_sync_runs()
    trials = [row for row in published if row["mode"] == "clinical_trials"]
    assert len(trials) == 1
    assert trials[0]["runTimestamp"] == "2026-09-02T01:00:00Z"


# ---------------------------------------------------------------------------
# The gene merge, executed rather than spelled
# ---------------------------------------------------------------------------

_MERGE_GENE: Final = "ZZTESTMERGE"


def _gene_row(**overrides: Any) -> dict[str, Any]:
    """One `_build_combined_gene_data`-shaped row for the merge."""
    row: dict[str, Any] = {
        "protein": "Test protein",
        "gene": _MERGE_GENE,
        "chromosomal_location": "1p36.13",
        "gwas_trait": ["WMH"],
        "mendelian_randomization": False,
        "evidence_from_other_omics_studies": "",
        "brain_cell_types": "",
        "affected_pathway": "",
        "references": ["1", "1 ", "2"],
        "source_quote": "The first sentence.",
        "confidence": 0.9,
    }
    row.update(overrides)
    return row


async def _delete_merge_gene() -> None:
    async with Database.connection() as conn:
        await conn.execute("DELETE FROM genes WHERE UPPER(gene) = $1", _MERGE_GENE)


@pytest.fixture
async def scratch_gene():
    """Delete the merge tests' gene either side of each of them.

    The container is session-scoped, and
    `test_export_after_a_run_publishes_from_the_live_pool` asserts the
    published `table1.json` is the empty array on the grounds that no test
    inserts a gene -- pytest-randomly fixes no order between them, so a row
    these tests write must not outlive them. The three join tables cascade
    off `genes.id`, so one DELETE clears the lot.
    """
    await _delete_merge_gene()
    yield _MERGE_GENE
    await _delete_merge_gene()


async def _list_values(table: str, column: str) -> list[tuple[int, str]]:
    """(ordinal, value) for the scratch gene, in ordinal order."""
    async with Database.connection() as conn:
        rows = await conn.fetch(
            f"SELECT t.ordinal, t.{column} AS value FROM {table} t "
            "JOIN genes g ON g.id = t.gene_id "
            "WHERE UPPER(g.gene) = $1 ORDER BY t.ordinal",
            _MERGE_GENE,
        )
    return [(row["ordinal"], row["value"]) for row in rows]


async def _provenance() -> tuple[str | None, float | None]:
    async with Database.connection() as conn:
        row = await conn.fetchrow(
            "SELECT source_quote, confidence FROM genes WHERE UPPER(gene) = $1",
            _MERGE_GENE,
        )
    assert row is not None
    return row["source_quote"], row["confidence"]


async def test_a_second_merge_appends_only_new_values_and_continues_the_ordinals(
    scratch_gene,
) -> None:
    """The three `_append_gene_list_sql` invariants, computed by PostgreSQL.

    `test_database.py` pins the spelling of NOT EXISTS, MAX(ordinal) + 1
    and GROUP BY btrim(value); none of that says what the planner does with
    them. Dropping the value predicate from the NOT EXISTS -- which every
    substring assertion survives -- leaves the second merge writing nothing
    at all, and this is what fails on it.

    One batch carries `"1"` twice, once with a trailing space: btrim and
    MIN(ord) collapse the pair onto its first position, the way
    string_agg(val, ', ' ORDER BY first_ord) did on the old TEXT column.
    """
    await merge_genes_transactional(
        [_gene_row(references=["1", "1 ", "2"], gwas_trait=["WMH"])], []
    )
    assert await _list_values("gene_references", "pmid") == [(0, "1"), (1, "2")]

    await merge_genes_transactional(
        [], [_gene_row(references=["2", "3"], gwas_trait=["WMH", "PVWMH"])]
    )

    # "2" is already stored, so only "3" is appended -- at ordinal 2, off
    # the pre-statement MAX, not back at 0.
    assert await _list_values("gene_references", "pmid") == [
        (0, "1"),
        (1, "2"),
        (2, "3"),
    ]
    assert await _list_values("gene_gwas_traits", "trait") == [(0, "WMH"), (1, "PVWMH")]


async def test_re_running_the_same_merge_writes_no_new_rows(scratch_gene) -> None:
    """Idempotence, which is what makes a window safe to re-run.

    `references` was destroyed once already; a merge that re-appended what
    it had appended before would double every PMID in `data/table1.json`
    on the first repeat of a `--days-back` window.
    """
    batch = [_gene_row(references=["1", "2"], gwas_trait=["WMH"])]
    await merge_genes_transactional(batch, [])
    # Both branches land on the same row (ON CONFLICT and UPPER(gene)), so
    # the append runs for each of them.
    await merge_genes_transactional(batch, [])
    await merge_genes_transactional([], batch)

    assert await _list_values("gene_references", "pmid") == [(0, "1"), (1, "2")]
    assert await _list_values("gene_gwas_traits", "trait") == [(0, "WMH")]


async def test_a_stored_quote_keeps_the_confidence_it_was_scored_with(
    scratch_gene,
) -> None:
    """A later paper fills neither half of the pair.

    The two curated rows that carry a quote have no confidence, because
    the column post-dates them. Filling the two columns independently put
    the next paper's score beside this paper's sentence -- a number that
    describes an extraction the reader cannot see.
    """
    await merge_genes_transactional(
        [_gene_row(source_quote="The first sentence.", confidence=None)], []
    )
    assert await _provenance() == ("The first sentence.", None)

    await merge_genes_transactional(
        [], [_gene_row(source_quote="A later sentence.", confidence=0.8)]
    )
    assert await _provenance() == ("The first sentence.", None)

    # The ON CONFLICT branch is the same rule, not a second one.
    await merge_genes_transactional(
        [_gene_row(source_quote="A later sentence.", confidence=0.8)], []
    )
    assert await _provenance() == ("The first sentence.", None)


async def test_a_row_with_no_quote_takes_both_halves_from_one_extraction(
    scratch_gene,
) -> None:
    """The 61 rows that predate the provenance prompt fill as a pair."""
    await merge_genes_transactional([_gene_row(source_quote=None, confidence=None)], [])
    assert await _provenance() == (None, None)

    await merge_genes_transactional(
        [],
        [
            _gene_row(
                source_quote="The sentence it was scored beside.", confidence=0.72
            )
        ],
    )
    assert await _provenance() == ("The sentence it was scored beside.", 0.72)


async def test_a_score_without_a_quote_is_never_stored_alone(scratch_gene) -> None:
    """An extraction that carries no sentence carries no publishable score.

    `confidence` is published beside `sourceQuote` in `data/table1.json`;
    a score with no sentence would be a number the reader cannot check.
    """
    await merge_genes_transactional([_gene_row(source_quote=None, confidence=None)], [])

    await merge_genes_transactional([], [_gene_row(source_quote=None, confidence=0.95)])

    assert await _provenance() == (None, None)

# The clinical-trials upsert, against real SQL
# ---------------------------------------------------------------------------

_CURATED_NCT = "NCT09999999"


async def _clear_trial(registry_id: str) -> None:
    async with Database.connection() as conn:
        await conn.execute(
            "DELETE FROM clinical_trials WHERE registry_id = $1", registry_id
        )


async def _insert_curated_trial(**overrides: Any) -> None:
    """One curated row, the shape data/table2.json is exported from.

    `estimated_completion_date` is VARCHAR(20), which is why the stored
    sentinel is "Completed unpublish" and `_COMPLETED_UNPUBLISHED` in
    `pipeline/export/tables.py` expands it on the way out.
    """
    values: dict[str, Any] = {
        "drug": "Mivelsiran (ALN-APP)",
        "trial_name": "Curated title",
        "registry_id": _CURATED_NCT,
        "clinical_trial_phase": "II",
        "target_sample_size": 15,
        "estimated_completion_date": "Completed unpublish",
        "primary_outcome": "Curated outcome",
        "sponsor_type": "Industry (Alnylam Pharmaceuticals)",
        "mechanism_of_action": "APP mRNA reduction",
        "svd_population": "CAA",
    }
    values.update(overrides)
    columns = ", ".join(values)
    placeholders = ", ".join(f"${i}" for i in range(1, len(values) + 1))
    async with Database.connection() as conn:
        await conn.execute(
            f"INSERT INTO clinical_trials ({columns}) VALUES ({placeholders})",
            *values.values(),
        )


def _api_record(**overrides: Any) -> Any:
    from pipeline.clinical_trials_fetch import ClinicalTrialRecord

    fields: dict[str, Any] = {
        "drug": "ALN-APP",
        "trial_name": "Refreshed title",
        "registry_id": _CURATED_NCT,
        "clinical_trial_phase": "II",
        "target_sample_size": 42,
        "estimated_completion_date": "10/2024",
        "primary_outcome": "Refreshed outcome",
        "sponsor_type": "Academic",
    }
    fields.update(overrides)
    return ClinicalTrialRecord(**fields)


async def test_a_curated_trial_is_refreshed_rather_than_duplicated() -> None:
    """The registry-first rule, against the rows PostgreSQL actually holds.

    CT.gov names the intervention its sponsor registered ("ALN-APP"); the
    curated row names the agent ("Mivelsiran (ALN-APP)"). Five of the eight
    curated trials spell the two differently, so
    `ON CONFLICT (registry_id, drug)` never fired for them: each sync
    inserted a second, wholly uncurated row instead of refreshing the
    curated one. No assertion about the statement text can show which rows
    are left behind.
    """
    from pipeline.database import upsert_clinical_trials_batch

    try:
        await _insert_curated_trial()

        result = await upsert_clinical_trials_batch([_api_record()])

        assert result.discovered == 0
        assert result.refreshed == 1

        async with Database.connection() as conn:
            rows = await conn.fetch(
                "SELECT * FROM clinical_trials WHERE registry_id = $1",
                _CURATED_NCT,
            )

        assert len(rows) == 1, "the sync added a second row for one trial"
        row = rows[0]
        assert row["drug"] == "Mivelsiran (ALN-APP)"
        # The API columns moved forward -- the point of the sync.
        assert row["target_sample_size"] == 42
        # The curated ones did not. trial_name and primary_outcome are in
        # this half because the row is curated: see the contrast case below.
        assert row["trial_name"] == "Curated title"
        assert row["primary_outcome"] == "Curated outcome"
        assert row["estimated_completion_date"] == "Completed unpublish"
        assert row["sponsor_type"] == "Industry (Alnylam Pharmaceuticals)"
        assert row["mechanism_of_action"] == "APP mRNA reduction"
        assert row["svd_population"] == "CAA"
    finally:
        await _clear_trial(_CURATED_NCT)


async def test_an_uncurated_row_still_tracks_the_registry_title() -> None:
    """The contrast case for the curation gate on title and outcome.

    A discovery no curator has read carries the registry's own wording and
    nothing else, so there is no prose to protect and freezing it at the
    first sync would leave the row stale for as long as it stays uncurated.
    The gate is `svd_population`, the same column `_read_curated_trials`
    publishes on.
    """
    from pipeline.database import upsert_clinical_trials_batch

    try:
        await _insert_curated_trial(
            svd_population=None,
            mechanism_of_action=None,
            trial_name="Discovered title",
            primary_outcome="Discovered outcome",
        )

        await upsert_clinical_trials_batch([_api_record()])

        async with Database.connection() as conn:
            row = await conn.fetchrow(
                "SELECT trial_name, primary_outcome FROM clinical_trials "
                "WHERE registry_id = $1",
                _CURATED_NCT,
            )

        assert row is not None
        assert row["trial_name"] == "Refreshed title"
        assert row["primary_outcome"] == "Refreshed outcome"
    finally:
        await _clear_trial(_CURATED_NCT)


async def test_a_month_and_year_completion_date_is_refreshed() -> None:
    """The contrast case: an estimate is exactly what the sync is for."""
    from pipeline.database import upsert_clinical_trials_batch

    try:
        await _insert_curated_trial(estimated_completion_date="12/2026")

        await upsert_clinical_trials_batch([_api_record()])

        async with Database.connection() as conn:
            stored = await conn.fetchval(
                "SELECT estimated_completion_date FROM clinical_trials "
                "WHERE registry_id = $1",
                _CURATED_NCT,
            )
        assert stored == "10/2024"
    finally:
        await _clear_trial(_CURATED_NCT)


async def test_a_refresh_does_not_erase_a_column_ctgov_stopped_stating() -> None:
    """The COALESCE guard, on the row where it is the only thing holding.

    An uncurated row, because `primary_outcome` on a *curated* one is held by
    the curation gate whatever CT.gov states -- so this would pass without a
    COALESCE at all and stop covering the case it is named for.
    """
    from pipeline.database import upsert_clinical_trials_batch

    try:
        await _insert_curated_trial(svd_population=None)

        await upsert_clinical_trials_batch(
            [_api_record(primary_outcome=None, target_sample_size=None)]
        )

        async with Database.connection() as conn:
            row = await conn.fetchrow(
                "SELECT primary_outcome, target_sample_size FROM clinical_trials "
                "WHERE registry_id = $1",
                _CURATED_NCT,
            )
        assert row is not None
        assert row["primary_outcome"] == "Curated outcome"
        assert row["target_sample_size"] == 15
    finally:
        await _clear_trial(_CURATED_NCT)


async def test_a_registry_id_new_to_the_table_is_inserted_uncurated() -> None:
    """A discovery is written; the export is what keeps it unpublished."""
    from pipeline.database import upsert_clinical_trials_batch

    try:
        result = await upsert_clinical_trials_batch([_api_record()])

        assert result.discovered == 1
        assert result.refreshed == 0

        async with Database.connection() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM clinical_trials WHERE registry_id = $1",
                _CURATED_NCT,
            )
        assert row is not None
        assert row["drug"] == "ALN-APP"
        assert row["svd_population"] is None
        assert row["mechanism_of_action"] is None
    finally:
        await _clear_trial(_CURATED_NCT)


async def test_ncbi_fills_an_empty_band_and_never_a_curated_one() -> None:
    """The empty-only guard, computed by PostgreSQL rather than asserted.

    A run inserts genes with no `chromosomal_location` -- extraction is not
    asked for a band -- so sixteen published as "(unknown)" and reached no
    chromosome of the phenogram. NCBI states the band in the esummary the
    sync already reads. The curated rows' locations are the spreadsheet's
    spelling and must survive, which is the half a bare UPDATE would lose.
    """
    from pipeline.database import fill_missing_chromosomal_locations

    async with Database.connection() as conn:
        await conn.execute(
            "INSERT INTO genes (gene, chromosomal_location) VALUES "
            "('ZZTOPFILL', ''), ('ZZTOPKEEP', '13q34'), ('ZZTOPNONE', '')"
        )
        await conn.execute(
            "INSERT INTO ncbi_gene_info (gene_symbol, map_location) VALUES "
            "('ZZTOPFILL', '17q25.1'), ('ZZTOPKEEP', '9p21.3'), "
            "('ZZTOPNONE', '')"
        )
    try:
        filled = await fill_missing_chromosomal_locations()

        async with Database.connection() as conn:
            rows = await conn.fetch(
                "SELECT gene, chromosomal_location FROM genes "
                "WHERE gene LIKE 'ZZTOP%' ORDER BY gene"
            )
        got = {r["gene"]: r["chromosomal_location"] for r in rows}

        assert filled == 1, "only the empty row with a stated band is filled"
        # Empty + NCBI states a band -> filled.
        assert got["ZZTOPFILL"] == "17q25.1"
        # Curated value wins, even though NCBI disagrees with it.
        assert got["ZZTOPKEEP"] == "13q34"
        # NCBI states no band, so the row is left empty rather than blanked.
        assert got["ZZTOPNONE"] == ""

        # Idempotent: a second pass has nothing left to do.
        assert await fill_missing_chromosomal_locations() == 0
    finally:
        async with Database.connection() as conn:
            await conn.execute("DELETE FROM genes WHERE gene LIKE 'ZZTOP%'")
            await conn.execute(
                "DELETE FROM ncbi_gene_info WHERE gene_symbol LIKE 'ZZTOP%'"
            )
