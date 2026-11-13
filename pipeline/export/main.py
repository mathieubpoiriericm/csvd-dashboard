"""Generate the dashboard's committed JSON from PostgreSQL.

Replaces data-prep/export.R. Run with:  uv run python -m pipeline.export.main
"""

import argparse
import asyncio
import logging
import sys
import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any, Final

import asyncpg
from dotenv import load_dotenv

from pipeline import profiling
from pipeline.config import PROJECT_ROOT
from pipeline.database import Database
from pipeline.export.lookups import (
    read_disease_annotations,
    read_ncbi_gene_info,
    read_pipeline_run,
    read_pipeline_status,
    read_pubmed_refs,
    read_sync_runs,
    read_uniprot_info,
)
from pipeline.export.omim import read_omim_csv, referenced_omim_rows
from pipeline.export.publish import publish_atomically
from pipeline.export.review_round import (
    ROUND_FILE,
    read_review_round,
    warn_if_round_stale,
)
from pipeline.export.tables import clean_gene_row, clean_trial_row
from pipeline.export.text import is_doi, split_genetic_targets
from pipeline.export.writer import to_camel, write_rows, write_value
from pipeline.gold_only import gold_only
from pipeline.preview_run import enter_preview_database, require_preview_database
from pipeline.steps import PREVIEW_RUN_MODE

logger = logging.getLogger(__name__)

# Every other entry point loads .env itself -- pipeline/main.py:144 and
# pipeline/alembic/env.py:22 -- but this one did not, so `deno task data`
# could only work when DB_* was already exported in the shell, despite the
# documented workflow being "populate .env". Database.get_pool() reads the
# variables at call time, so loading at import is early enough.
load_dotenv(PROJECT_ROOT / ".env")

_METADATA_COLUMNS = frozenset({"id", "created_at", "updated_at"})

_GENE_LIST_SOURCES: Final[tuple[tuple[str, str, str], ...]] = (
    ("references", "gene_references", "pmid"),
    ("gwas_trait", "gene_gwas_traits", "trait"),
    ("link_to_monogenetic_disease", "gene_monogenic_links", "omim_id"),
)

# Every published `genes` column, in the order data/table1.json carries it.
# clean_gene_row hoists "gene" to the front; the rest keep this order, and
# write_rows serialises it verbatim. The three list columns are named here
# but selected as NULL -- their values come from the join tables, and naming
# them is what holds their position once migration 006 removes them.
# source_quote and confidence are last: they are the extraction's own
# provenance for the row, not a curated fact about the gene, so they read as
# an appendix to everything above them.
_GENE_COLUMNS: Final[tuple[str, ...]] = (
    "protein",
    "gene",
    "chromosomal_location",
    "gwas_trait",
    "mendelian_randomization",
    "evidence_from_other_omics_studies",
    "link_to_monogenetic_disease",
    "brain_cell_types",
    "affected_pathway",
    "references",
    "source_quote",
    "confidence",
)


def _publishable(row: Mapping[str, object]) -> dict[str, object]:
    """Drop database-only metadata."""
    return {key: value for key, value in row.items() if key not in _METADATA_COLUMNS}


def _pubmed_ids(genes: Iterable[Mapping[str, Any]]) -> list[str]:
    """The distinct citation keys among the genes' references, first-seen order.

    A PMID, or a DOI: a preprint's citation is cached under its DOI (read
    from Europe PMC), so it gets a refs.json row like any other paper.
    """
    return list(
        dict.fromkeys(
            ref.strip() if is_doi(ref) else ref
            for row in genes
            for ref in row["References"]
            if is_doi(ref) or (ref.isdigit() and not ref.startswith("0"))
        )
    )


def _gene_select() -> str:
    """SELECT id plus every published column, list columns as NULL."""
    listed = {key for key, _, _ in _GENE_LIST_SOURCES}
    projected = ", ".join(
        f'NULL AS "{name}"' if name in listed else f'"{name}"' for name in _GENE_COLUMNS
    )
    # Both names come from module constants, never from input. Quoting every
    # column keeps "references" -- a reserved word -- from needing a special
    # case.
    return f"SELECT id, {projected} FROM genes ORDER BY id"


async def _read_genes_with_lists(
    conn: asyncpg.Connection | None = None,
) -> list[dict[str, object]]:
    """Read genes with their three list join tables attached, ordered by id.

    `id` is read but never published: it is the join key, and _publishable
    drops it on the way out. Both ORDER BY clauses are load-bearing -- the
    row order and the within-gene ordinal order both reach the JSON.

    *conn* reads inside a caller's transaction -- scripts.reset_to_baseline
    re-checks the table under the lock it then writes under; without one,
    a connection of its own.
    """
    if conn is None:
        async with Database.connection() as own:
            return await _read_genes_with_lists(own)
    rows = [dict(r) for r in await conn.fetch(_gene_select())]
    lists: dict[int, dict[str, list[str]]] = {}
    for key, table, column in _GENE_LIST_SOURCES:
        fetched = await conn.fetch(
            f"SELECT gene_id, {column} FROM {table} "  # allowlisted above
            "ORDER BY gene_id, ordinal"
        )
        for record in fetched:
            gene_lists = lists.setdefault(record["gene_id"], {})
            gene_lists.setdefault(key, []).append(record[column])

    merged: list[dict[str, object]] = []
    for row in rows:
        published = _publishable(row)
        published.update(lists.get(row["id"], {}))
        merged.append(published)
    return merged


async def read_published_genes(
    conn: asyncpg.Connection | None = None,
) -> list[dict[str, object]]:
    """The rows `run_export` writes to table1.json, keys camelCased.

    For a caller that compares the live table with a published file without
    exporting first -- scripts.reset_to_baseline checks a baseline against it,
    on *conn* when it must read inside its own transaction.
    """
    return [
        {to_camel(key): value for key, value in clean_gene_row(row).items()}
        for row in await _read_genes_with_lists(conn)
    ]


async def _read_table(name: str) -> list[dict[str, object]]:
    """Read a source table, dropping database-only metadata columns."""
    if name not in {"genes", "clinical_trials"}:
        raise ValueError(f"Unsupported dashboard table: {name}")
    async with Database.connection() as conn:
        # ORDER BY is load-bearing, not cosmetic. Without it PostgreSQL is
        # free to return rows in any physical order, so the export is not
        # reproducible -- and because split_genetic_targets() feeds the
        # lookup request lists, one unordered SELECT reorders
        # gene_info_table2.json too. complete_lookup() already restores
        # request order, so making this deterministic is enough to make
        # every generated file deterministic.
        rows = await conn.fetch(
            f"SELECT * FROM {name} ORDER BY id"  # allowlisted above
        )
    return [_publishable(dict(row)) for row in rows]


def _is_curated_trial(row: Mapping[str, object]) -> bool:
    """Whether a `clinical_trials` row has been through a curator.

    `target_population` is the test because it is the first thing a curator
    decides about a trial and the only curator column the dashboard makes
    structural use of: `lib/timeline.ts` groups the radar's sectors by it,
    and `POPULATION_CHOICES` filters on it. A row that has none is a
    ClinicalTrials.gov discovery nobody has read yet. (Renamed from
    `svd_population` by migration 014 so the wire key does not spell the
    disease.)
    """
    population = row.get("target_population")
    return population is not None and bool(str(population).strip())


# ClinicalTrials.gov's words for a trial that produced no completed result:
# TERMINATED stopped early, WITHDRAWN never enrolled a participant. Neither
# belongs in a picture of the trial landscape.
#
# **A denylist, not an allowlist**, and the two rejected members say why:
# SUSPENDED intends to resume, and UNKNOWN is CT.gov reporting that a
# still-recruiting sponsor stopped updating -- an information gap, not a
# stopped trial. Publishing is the default and this set is the exception to
# it, so a status nobody here has an opinion about goes on publishing.
#
# The vocabulary lives in the export because the export owns *what
# publishes*, exactly as it owns the curation gate above. The fetch records
# what CT.gov said and takes no view.
_UNPUBLISHED_TRIAL_STATUSES: Final[frozenset[str]] = frozenset(
    {"TERMINATED", "WITHDRAWN"}
)


def _is_running_trial(row: Mapping[str, object]) -> bool:
    """Whether a `clinical_trials` row is not a stopped trial.

    **This fails open, three ways, and that is the whole design.** A NULL
    status is "ClinicalTrials.gov has not answered for this row" -- the
    ISRCTN, ChiCTR and ANZCTR trials it can never answer for, and any row a
    sweep has not reached yet. A missing key is a database that has not
    taken migration 013. An unrecognised token is a status this module has
    no opinion about. All three publish. The only thing that removes a row
    is a status this code fetched *and* recognises as stopped.
    """
    status = row.get("overall_status")
    if status is None:
        return True
    token = str(status).strip().upper()
    return not token or token not in _UNPUBLISHED_TRIAL_STATUSES


async def _read_curated_trials() -> list[dict[str, object]]:
    """The clinical trial rows a curator has placed in a target population.

    `--clinical-trials` writes discoveries straight into the curated table:
    ten broad search terms against ClinicalTrials.gov match hundreds of
    interventional drug studies, and each one arrives with every curator
    column NULL. Published, those rows read `"(unknown)"` for mechanism,
    population and genetic evidence -- values no filter choice offers, the
    timeline encoding does not carry and the radar draws nowhere -- so a
    single sync would have added several hundred rows to Table 2 that the
    figure silently omits. Curation is what makes a trial publishable, and
    this is where that is enforced.

    A second gate follows it: a trial ClinicalTrials.gov reports as
    TERMINATED or WITHDRAWN is not published either. The curation gate runs
    first, so a row that is both uncurated and stopped is reported once, as
    uncurated -- it was never going to publish anyway.

    `overall_status` is published with the row -- as `overallStatus`, the
    fourteenth key -- so the dashboard can offer a "Study status" filter
    whose default hides completed trials while keeping them in the record.
    A NULL (a registry ClinicalTrials.gov cannot speak for, or a row no
    sweep has reached) publishes as "(unknown)" through `_UNKNOWN_COLUMNS`.
    """
    rows = await _read_table("clinical_trials")
    curated = [row for row in rows if _is_curated_trial(row)]
    if uncurated := len(rows) - len(curated):
        logger.warning(
            "Skipping %d of %d clinical trial row(s) with no curated target "
            "population: they are ClinicalTrials.gov discoveries and are not "
            "published until a curator fills in the population, mechanism and "
            "genetic evidence",
            uncurated,
            len(rows),
        )

    running = [row for row in curated if _is_running_trial(row)]
    if stopped := len(curated) - len(running):
        # Named, unlike the warning above: this gate drops a handful rather
        # than hundreds, and which trials left Table 2 is exactly what the
        # operator needs to see against the diff.
        logger.warning(
            "Skipping %d of %d curated clinical trial row(s) that "
            "ClinicalTrials.gov reports as %s: %s. A stopped trial is not "
            "published in Table 2, on the trials radar or on the map",
            stopped,
            len(curated),
            " or ".join(sorted(_UNPUBLISHED_TRIAL_STATUSES)),
            ", ".join(
                sorted(
                    {
                        f"{row.get('registry_id')} ({row.get('overall_status')})"
                        for row in curated
                        if not _is_running_trial(row)
                    }
                )
            ),
        )

    return running


async def _export_preview_run(target: Path) -> None:
    """Publish the preview run's report and its review round, and nothing else.

    The preview database is a full copy of production, the earlier standard
    run included, with the preview run merged into it. Only two files are
    published from it -- data/pipeline_run.json and data/review_round.json,
    the round the committee reads, diffed against the gold database beside
    it -- so every other file stays as it is on disk. The two are staged
    together and published in one atomic step, so a refused round publishes
    neither, and the committed report never describes a run whose round is
    missing.
    """
    run = await read_pipeline_run()
    if run is None or run.get("runMode") != PREVIEW_RUN_MODE:
        raise ValueError(
            "no preview run to publish: the database holds no run recorded "
            f"with --preview (run mode {PREVIEW_RUN_MODE!r})"
        )
    round_ = await read_review_round(run)
    with tempfile.TemporaryDirectory(
        prefix=".dashboard-export-", dir=target
    ) as staging_name:
        staged = {
            name: Path(staging_name) / name
            for name in ("pipeline_run.json", ROUND_FILE)
        }
        write_value(run, staged["pipeline_run.json"])
        write_value(round_, staged[ROUND_FILE])
        publish_atomically(staged, target)
    logger.info(
        f"Preview export complete: data/pipeline_run.json and data/{ROUND_FILE}"
        " only."
    )


async def run_export(
    target_dir: Path | None = None,
    *,
    preview_run: bool = False,
    gold_only_on: bool | None = None,
) -> None:
    """Generate all eleven files, publishing only after every step succeeds.

    A twelfth committed file, data/geocoded_trials.json, is produced
    separately by `deno task geocode` -- see the closing log message.

    While gold-only is on, data/pipeline_run.json is not regenerated: the
    database an ordinary export reads holds an older run than the preview
    report committed there, and would publish over it. ``preview_run``
    publishes that file and data/review_round.json from the preview
    database instead, together or not at all, and refuses unless gold-only
    is on. Without gold-only an ordinary export also publishes
    data/review_round.json as ``null``, since there is no review to show; with
    it, the committed round is left alone like the report.
    ``gold_only_on=None`` reads the repository's switch.
    """
    if gold_only_on is None:
        gold_only_on = gold_only()
    if preview_run and not gold_only_on:
        raise ValueError(
            "a preview export needs GOLD_ONLY: it is true in lib/gold_only.ts "
            "only while the dashboard publishes hand-curated data"
        )
    target = target_dir or PROJECT_ROOT / "data"
    target.mkdir(parents=True, exist_ok=True)
    if preview_run:
        await _export_preview_run(target)
        return

    with (
        tempfile.TemporaryDirectory(
            prefix=".dashboard-export-", dir=target
        ) as staging_name,
        # One Tracy zone per step, inert unless run through `deno task
        # tracy:run`. The steps await one at a time, so the zones never
        # interleave.
        profiling.stages() as zones,
    ):
        staging = Path(staging_name)
        staged: dict[str, Path] = {}

        def step(label: str) -> None:
            logger.info(label)
            zones(label)

        def stage(name: str) -> Path:
            path = staging / name
            staged[name] = path
            return path

        step("[1/11] Cleaning Table 1 (genes)")
        genes = [clean_gene_row(row) for row in await _read_genes_with_lists()]
        write_rows(genes, stage("table1.json"))
        gene_symbols = list(dict.fromkeys(row["Gene"] for row in genes))

        step("[2/11] Cleaning Table 2 (clinical trials)")
        trials = [clean_trial_row(row) for row in await _read_curated_trials()]
        write_rows(trials, stage("table2.json"))

        step("[3/11] NCBI gene info for Table 1 genes")
        write_rows(await read_ncbi_gene_info(gene_symbols), stage("gene_info.json"))

        step("[4/11] NCBI gene info for Table 2 targets")
        targets = split_genetic_targets(r["Genetic Target"] for r in trials)
        write_rows(await read_ncbi_gene_info(targets), stage("gene_info_table2.json"))

        step("[5/11] UniProt protein info")
        write_rows(await read_uniprot_info(gene_symbols), stage("protein_info.json"))

        step("[6/11] PubMed references")
        pmids = _pubmed_ids(genes)
        write_rows(await read_pubmed_refs(pmids), stage("refs.json"))

        step("[7/11] OMIM reference table")
        monogenic_links = [
            link for row in genes for link in row["Link to Monogenic Disease"]
        ]
        write_rows(
            referenced_omim_rows(read_omim_csv(), monogenic_links),
            stage("omim_info.json"),
        )

        step("[8/11] Latest pipeline run status")
        write_value(await read_pipeline_status(), stage("pipeline_status.json"))

        step("[9/11] Machine-fetched disease annotations")
        # Pivoted to one row per (gene, disease) -- this file is bundled into
        # the islands that import it, so the raw cross-reference rows would
        # multiply the payload.
        annotations = await read_disease_annotations()
        if annotations:
            write_rows(annotations, stage("gene_annotations.json"))
        else:
            # Every other file here comes from a table the main pipeline fills,
            # or from complete_lookup, which guarantees a row per requested key.
            # This one comes from a table only the separately-invoked
            # --sync-annotations fills, so an empty read is far more likely to
            # mean "not synced yet" than "no annotations exist" -- and staging
            # `[]` would publish that over the committed file, atomically and
            # irreversibly. Leaving it unstaged keeps what is already there.
            logger.warning(
                "No disease annotations in the database; keeping the committed "
                "data/gene_annotations.json. Run `uv run python -m pipeline.main "
                "--sync-annotations` to refresh it."
            )

        # The full report, for the About page's pipeline widget. Separate
        # from pipeline_status.json rather than replacing it: that file is
        # a tested contract the date badge reads, and keeping it means the
        # page still renders its summary card when no run has recorded a
        # report yet.
        step("[10/11] Latest pipeline run report")
        if gold_only_on:
            # Left unstaged, like gene_annotations.json above: the committed
            # file is the preview run's report, which the production database
            # does not hold. The review round beside it is the preview
            # export's too, and stays for the same reason.
            logger.info(
                "GOLD_ONLY is on; keeping the committed data/pipeline_run.json"
                f" and data/{ROUND_FILE}"
            )
            # A gold edit to a gene the round touches leaves the round stale.
            # The dashboard hides it by itself; this says so where the edit
            # is made, and changes nothing on disk.
            warn_if_round_stale(
                target,
                [{to_camel(key): value for key, value in row.items()} for row in genes],
            )
        else:
            write_value(await read_pipeline_run(), stage("pipeline_run.json"))
            # Without gold-only there is no review, so no round: a fork that
            # merged upstream, or this repository once GOLD_ONLY is off, must
            # not keep a round of another database in data/ and its bundle.
            write_value(None, stage(ROUND_FILE))

        # The reference-data refreshes, which record their own smaller
        # document: they have no papers, genes or steps, and the upstreams
        # they call -- ClinVar, Orphadata, Open Targets, UniProt,
        # ClinicalTrials.gov -- appear in no run report, because
        # build_run_report is reachable only from inside run_pipeline.
        # Written unconditionally rather than skipped when empty, unlike
        # gene_annotations.json: sync_runs rows are never deleted, so an
        # empty read means no refresh has ever been recorded and `[]` is
        # the true answer rather than a file to publish over.
        step("[11/11] Reference data refreshes")
        write_value(await read_sync_runs(), stage("pipeline_syncs.json"))

        zones("publish")
        publish_atomically(staged, target)

    logger.info("Export complete. Run `deno task geocode` for the map locations.")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Generate data/*.json from PostgreSQL."
    )
    parser.add_argument(
        "--preview",
        action="store_true",
        help=(
            "Publish data/pipeline_run.json and data/review_round.json alone, "
            "from the <DB_NAME>_preview database a `--preview` PubMed run "
            "wrote, diffed against <DB_NAME>. Needs GOLD_ONLY."
        ),
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.preview:
        try:
            enter_preview_database()
        except ValueError as e:
            logger.error(f"Invalid argument: {e}")
            sys.exit(1)
    profiling.start("pipeline export", "data/*.json from PostgreSQL")

    async def _run() -> None:
        try:
            if args.preview:
                try:
                    # A missing or wrong database is the same readable refusal
                    # the pipeline's --preview gives, not an asyncpg traceback.
                    await require_preview_database()
                    await run_export(preview_run=True)
                except ValueError as e:
                    logger.error(f"Preview export refused: {e}")
                    sys.exit(1)
            else:
                await run_export()
        finally:
            await Database.close()

    asyncio.run(_run())


if __name__ == "__main__":
    main()
