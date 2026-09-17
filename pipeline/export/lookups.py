"""Cache-table reads for the export, ported from read_external_data.R.

Every lookup returns exactly one row per requested key, in request order —
the dashboard indexes these by position-independent key, but the four JSON
files are asserted row-for-row against their request lists.
"""

import json
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

import asyncpg
from pydantic import ValidationError

from pipeline.api_telemetry import relabel_api_rows
from pipeline.database import Database
from pipeline.run_report import PipelineRunReport
from pipeline.sync_report import SyncRunReport
from pipeline.xrefs import is_omim_series, xref_prefix

logger = logging.getLogger(__name__)


def complete_lookup(
    rows: Sequence[dict[str, Any]],
    requested: Sequence[str],
    key: str,
    defaults: dict[str, Any | Callable[[str], Any]],
) -> list[dict[str, Any]]:
    """Add a fallback row per missing key, then restore request order."""
    by_key = {row[key]: row for row in rows}
    out: list[dict[str, Any]] = []
    for wanted in requested:
        found = by_key.get(wanted)
        if found is not None:
            out.append(found)
            continue
        filled: dict[str, Any] = {key: wanted}
        for column, default in defaults.items():
            filled[column] = default(wanted) if callable(default) else default
        out.append(filled)
    return out


async def read_ncbi_gene_info(symbols: Sequence[str]) -> list[dict[str, Any]]:
    """Cached NCBI gene metadata, one row per requested symbol."""
    if not symbols:
        return []
    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol AS name, ncbi_uid AS uid,
                   description, aliases AS otheraliases
            FROM ncbi_gene_info
            WHERE gene_symbol = ANY($1::text[])
            """,
            list(symbols),
        )
    records = [
        {
            "name": r["name"],
            # The dashboard's uid is a string; do not let an integer column
            # type leak into the generated wire format.
            "uid": None if r["uid"] is None else str(r["uid"]),
            "description": r["description"],
            "otheraliases": r["otheraliases"],
        }
        for r in rows
    ]
    return complete_lookup(
        records,
        symbols,
        "name",
        {"uid": None, "description": None, "otheraliases": None},
    )


async def read_uniprot_info(symbols: Sequence[str]) -> list[dict[str, Any]]:
    """Cached UniProt protein metadata, one row per requested symbol."""
    if not symbols:
        return []
    async with Database.connection() as conn:
        rows = await conn.fetch(
            """
            SELECT gene_symbol AS gene, accession, url
            FROM uniprot_info
            WHERE gene_symbol = ANY($1::text[])
            """,
            list(symbols),
        )
    records = [dict(r) for r in rows]
    return complete_lookup(records, symbols, "gene", {"accession": None, "url": None})


async def read_pubmed_refs(pmids: Sequence[str]) -> list[dict[str, Any]]:
    """Cached PubMed citations, one row per requested PMID."""
    if not pmids:
        return []
    async with Database.connection() as conn:
        # A non-str element in pmids fails encoding this $1::text[] bind
        # with asyncpg.DataError right here, before complete_lookup ever
        # runs -- a caller's type violation raises loudly instead of
        # silently completing every requested key as a fallback row.
        # The discrete fields are published alongside the formatted string,
        # not instead of it. The string is one HTML fragment built for a
        # tooltip; the table cell needs an author and a year on their own,
        # and recovering those by splitting the fragment would make the
        # citation depend on _format_citation's punctuation.
        rows = await conn.fetch(
            """
            SELECT pmid, authors, title, journal, publication_date, doi,
                   formatted_ref
            FROM pubmed_citations
            WHERE pmid::text = ANY($1::text[])
            """,
            list(pmids),
        )
    records = [
        {
            # PostgreSQL schemas sometimes store PMID as an integer. The
            # dashboard's lookup and JSON contract use strings, so do not
            # let a schema detail leak into the generated wire format.
            "pmid": str(r["pmid"]),
            "authors": r["authors"],
            "title": r["title"],
            "journal": r["journal"],
            "publication_date": r["publication_date"],
            "doi": r["doi"],
            "formatted_ref": r["formatted_ref"],
        }
        for r in rows
    ]
    return complete_lookup(
        records,
        pmids,
        "pmid",
        {
            # A PMID with no cached citation keeps the sentinel it has
            # always had. The discrete fields go out empty rather than
            # sentinel-valued: the dashboard falls back to the bare PMID
            # when they are, and "(none found)" is not an author.
            "authors": None,
            "title": None,
            "journal": None,
            "publication_date": None,
            "doi": None,
            "formatted_ref": lambda key: f"PMID: {key} (citation not available)",
        },
    )


# The newest run that finished as a whole. A failed run writes a row too --
# that is how the widget shows it -- but it did not get to the end, so it
# must not move the About page's "up-to-date as of" date. That is not the
# offline modes' reasoning: they write no row because they publish nothing,
# while a failed run may well have merged before it died (the merge commits
# in its own transaction, and --export ships those rows). What the failed
# run wrote is read from its report's `database` block, not from here.
_STATUS_QUERY: Final[str] = """
    SELECT run_timestamp, papers_processed, fulltext_retrieved,
           genes_extracted, genes_validated
    FROM pipeline_runs
    {where}
    ORDER BY run_timestamp DESC
    LIMIT 1
"""


async def read_pipeline_status() -> dict[str, Any] | None:
    """Latest successful run summary, or None when there is not one.

    ``pipeline_runs`` arrives with migration 003, so a database below that
    revision has no table to read: the About page reports the update date as
    unavailable and the contract test accepts a bare null. **Only that
    migration-lag case is tolerated.** Every other failure -- a dropped
    connection, a revoked SELECT -- propagates and fails the export, because
    the alternative is publishing ``null`` over the committed
    ``pipeline_status.json`` and exiting 0, which reads on the site as "no
    run has ever happened".

    Failed runs are skipped. A database that has not taken migration 009
    has no ``status`` column to filter on -- and no failed rows either,
    since only the report-writing pipeline records those -- so that one
    case falls back to the unfiltered query rather than to no date.
    """
    try:
        async with Database.connection() as conn:
            try:
                row = await conn.fetchrow(
                    _STATUS_QUERY.format(
                        where="WHERE status IS DISTINCT FROM 'failed'"
                    )
                )
            except asyncpg.UndefinedColumnError:
                row = await conn.fetchrow(_STATUS_QUERY.format(where=""))
    except asyncpg.UndefinedTableError as exc:
        logger.warning("Could not read pipeline_runs: %s", exc)
        return None
    if row is None:
        return None
    return {
        "runTimestamp": row["run_timestamp"].strftime("%Y-%m-%dT%H:%M:%SZ"),
        "papersProcessed": row["papers_processed"],
        "fulltextRetrieved": row["fulltext_retrieved"],
        "genesExtracted": row["genes_extracted"],
        "genesValidated": row["genes_validated"],
    }


async def read_pipeline_run() -> dict[str, Any] | None:
    """The newest run's full report, or None when there is not one.

    Only the migration-lag shapes of "not one" are tolerated, exactly as in
    ``read_pipeline_status``: a database below migration 003 has no
    ``pipeline_runs`` table and one below 008 has no ``report`` column. Any
    other read failure propagates, because ``run_export`` stages this value
    unconditionally -- swallowing the error publishes ``null`` over the
    committed ``data/pipeline_run.json`` and takes the About page's run
    widget down with a successful exit code.

    The stored document is re-validated through ``PipelineRunReport``
    rather than passed through. That is what makes the model the schema
    on both sides of the database: a row written by an older pipeline is
    either brought up to the current shape here or rejected, so the
    dashboard never receives a document its TypeScript does not describe.
    A rejection fails the export rather than publishing ``null``: the row
    exists and says a run happened, so "no run" would be a false report,
    and the fix is to migrate or re-record the document.

    API labels are re-derived from the registry on the way out
    (``relabel_api_rows``), so a rename in ``SERVICES`` reaches the
    committed file at the next export.
    """
    try:
        async with Database.connection() as conn:
            row = await conn.fetchrow(
                """
                SELECT report
                FROM pipeline_runs
                WHERE report IS NOT NULL
                ORDER BY run_timestamp DESC
                LIMIT 1
                """
            )
    except (asyncpg.UndefinedTableError, asyncpg.UndefinedColumnError) as exc:
        logger.warning("Could not read pipeline_runs.report: %s", exc)
        return None
    if row is None or row["report"] is None:
        return None
    try:
        stored = json.loads(row["report"])
        wire = PipelineRunReport.model_validate(stored).to_wire()
        wire["apis"] = relabel_api_rows(wire["apis"])
        return wire
    except (ValueError, ValidationError) as exc:
        raise ValueError(
            f"Stored run report is not readable: {exc}. The export cannot "
            "publish a run widget for it, and publishing null would report "
            "that no run has happened."
        ) from exc


# Newest row per mode. `DISTINCT ON` requires its own expression to lead
# the sort, which is convenient: `ORDER BY mode` is also what makes this
# deterministic, and every export query needs an order for the byte-exact
# contract to hold across runs.
_SYNC_RUNS_QUERY: Final[str] = """
    SELECT DISTINCT ON (mode) mode, report
    FROM sync_runs
    ORDER BY mode, run_timestamp DESC
"""


async def read_sync_runs() -> list[dict[str, Any]]:
    """The newest reference-data refresh per mode, oldest mode first.

    Empty rather than absent when there is nothing to report, and the one
    tolerated failure is the one ``read_pipeline_run`` tolerates: a database
    that has not taken migration 011 has no ``sync_runs`` table, which is the
    shape of "none yet" rather than a fault. Any other read failure
    propagates -- ``run_export`` stages this value unconditionally, so
    returning ``[]`` would publish "no refresh has ever run" over the
    committed ``data/pipeline_syncs.json`` and still exit 0.

    Each row is re-validated through ``SyncRunReport`` rather than passed
    through, which is what makes the model the schema on both sides of the
    database. A row that fails validation fails the read: skipping it would
    silently drop one mode from the published list, which the About page
    renders as a refresh that never happened.

    API labels are re-derived from the registry on the way out
    (``relabel_api_rows``), so a rename in ``SERVICES`` reaches the
    committed file at the next export.
    """
    try:
        async with Database.connection() as conn:
            rows = await conn.fetch(_SYNC_RUNS_QUERY)
    except (asyncpg.UndefinedTableError, asyncpg.UndefinedColumnError) as exc:
        logger.warning("Could not read sync_runs: %s", exc)
        return []
    published: list[dict[str, Any]] = []
    for row in rows:
        try:
            stored = json.loads(row["report"])
            wire = SyncRunReport.model_validate(stored).to_wire()
            wire["apis"] = relabel_api_rows(wire["apis"])
            published.append(wire)
        except (ValueError, ValidationError) as exc:
            raise ValueError(
                f"Stored {row['mode']} refresh record is not readable: {exc}"
            ) from exc
    return published


# Which authority fills which published column. Everything else Orphadata
# returns -- MeSH, UMLS -- has no column of its own and reaches the reader
# through ``related_xrefs``.
_XREF_COLUMNS: Final[dict[str, str]] = {
    "OMIM": "omim_id",
    "MONDO": "mondo_id",
    "Orphanet": "orphacode",
    "MedGen": "medgen_id",
}

# Sources whose rows are published. Open Targets' associatedDiseases is a
# ranked association list rather than a monogenic-disease claim -- 1513 rows
# against ClinVar's 281, and the published file is bundled into every island
# that imports it -- so it stays in PostgreSQL for the query that wants it.
_PUBLISHED_SOURCES: Final[frozenset[str]] = frozenset({"clinvar", "orphadata"})

# Orphanet's DisorderMappingRelation for an equivalent concept. Only an exact
# mapping may name this disease; every other value -- including one Orphanet
# has not decided yet -- describes a different concept.
_EXACT_MAPPING: Final[str] = "E"


def _local_id(object_id: str) -> str:
    """The published form of a canonical xref.

    MONDO keeps its prefix -- "MONDO:0010829" is how MONDO is written
    everywhere. OMIM and Orphanet are bare numbers on the wire, as they have
    been since the R original, and lib/tooltips.ts keys data/omim_info.json on
    exactly that.
    """
    prefix, _, local = object_id.partition(":")
    return object_id if prefix == "MONDO" else local


@dataclass(slots=True)
class _DiseaseGroup:
    """Mutable aggregation state for one published gene-disease row."""

    gene_symbol: str
    group_key: str
    published_ids: set[str] = field(default_factory=set)
    related_xrefs: dict[str, str | None] = field(default_factory=dict)
    omim_series: set[str] = field(default_factory=set)
    source_versions: dict[str, str] = field(default_factory=dict)
    filled_columns: dict[str, str] = field(default_factory=dict)
    attested: bool = False
    entry: dict[str, Any] = field(init=False)

    def __post_init__(self) -> None:
        self.entry = {
            "gene_symbol": self.gene_symbol,
            "group_key": self.group_key,
            "disease_name": "",
            "omim_id": None,
            "mondo_id": None,
            "orphacode": None,
            "medgen_id": None,
            "omim_series": [],
            "classification": None,
            "record_count": None,
            "related_xrefs": [],
            # One version per contributing source, never one for the row.
            # A published row is assembled from ClinVar and Orphadata and
            # the two are versioned separately, so a single field had to
            # name one of them: `ORDER BY … source` reads clinvar first and
            # orphadata last, and last write won, so every row that had any
            # Orphadata at all was stamped with Orphadata's version alone --
            # 63 of the 111 committed rows, with ClinVar's contribution
            # attributed to a date it had nothing to do with. ClinVar writes
            # no version of its own today (`AnnotationStatus.source_version`
            # is None for it), so its key is present and null rather than
            # absent: the shape says which sources were read, and a null
            # says this one does not version itself.
            "source_versions": {},
        }

    def add(self, row: dict[str, Any]) -> None:
        """Fold one ClinVar or Orphadata row into this disease group."""
        source = str(row.get("source") or "")
        object_id = str(row["object_id"])
        qualifier = row.get("qualifier")
        column = _XREF_COLUMNS.get(xref_prefix(object_id))

        if source == "clinvar":
            self.attested = True
            self.entry["disease_name"] = str(row.get("object_label") or "")
            self.entry["classification"] = qualifier
            self.entry["record_count"] = row.get("evidence_count")

        # A series is a series whoever reports it. Keeping this before the
        # source branch prevents an exact Orphadata mapping such as
        # OMIM:PS143890 from filling the disease's own OMIM identifier.
        if is_omim_series(object_id):
            self.omim_series.add(_local_id(object_id))
        elif source == "clinvar":
            self._add_clinvar_xref(object_id, column)
        elif (
            qualifier == _EXACT_MAPPING
            and column
            and self.entry[column] is None
        ):
            self.entry[column] = _local_id(object_id)
            self.filled_columns[column] = object_id
            self.published_ids.add(object_id)
        elif self.related_xrefs.get(object_id) is None:
            # A None placeholder from ClinVar is not a reported mapping
            # relation, so a later Orphadata relation may replace it.
            self.related_xrefs[object_id] = qualifier

        # Recorded per source, and for every source seen -- a source that
        # contributed rows but names no version is part of the provenance.
        self.source_versions.setdefault(source, "")
        if row.get("source_version"):
            self.source_versions[source] = str(row["source_version"])

    def _add_clinvar_xref(self, object_id: str, column: str | None) -> None:
        """Prefer the group's own ClinVar id and retain displaced ids."""
        if column and (
            self.filled_columns.get(column) is None or object_id == self.group_key
        ):
            displaced = self.filled_columns.get(column)
            if displaced is not None:
                self.published_ids.discard(displaced)
                self.related_xrefs.setdefault(displaced, None)
            self.entry[column] = _local_id(object_id)
            self.filled_columns[column] = object_id
            self.published_ids.add(object_id)
            return

        # ClinVar's qualifier is a clinical significance, not a mapping
        # relation, so identifiers without an available column carry None.
        self.related_xrefs.setdefault(object_id, None)

    def to_wire(self) -> dict[str, Any]:
        """Finalize sorted collection fields and return the wire row."""
        self.entry["omim_series"] = sorted(self.omim_series)
        self.entry["related_xrefs"] = [
            {"id": object_id, "relation": relation}
            for object_id, relation in sorted(self.related_xrefs.items())
            if object_id not in self.published_ids
        ]
        # Sorted, like every other collection here: the byte-exact contract
        # cannot hold on a dict built in row-arrival order.
        self.entry["source_versions"] = {
            source: self.source_versions[source] or None
            for source in sorted(self.source_versions)
        }
        return self.entry


def pivot_disease_annotations(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse cross-reference rows into one row per (gene, disease).

    The published file is bundled into every island that imports it, so one row
    per cross-reference -- let alone per GO term -- is the wrong shape. Rows
    with no disease group (GO terms, identity) are dropped entirely, and so is
    any source outside ``_PUBLISHED_SOURCES``.

    **The four identifier columns name this disease and nothing else.** ClinVar
    attests them for this gene; an exact Orphanet mapping may fill one ClinVar
    left empty. Every other cross-reference goes to ``related_xrefs`` carrying
    the relation its source reported, because it names a *different* concept:
    Orphanet:1885 ("Ectopia lentis") maps BTNT to three OMIM subtypes, only one
    of which is the row's disease, and publishing another as ``omim_id`` is the
    class of error these annotations exist to remove.

    ``related_xrefs`` therefore holds two kinds of entry, and the relation
    is what separates them: a mapping to a *different* concept, carrying
    the relation its source reported, and an identifier for *this* disease
    in a vocabulary with no column of its own -- MeSH and UMLS -- carrying
    none. It never invents one. An absent relation stays absent rather
    than becoming a "broader" claim Orphanet did not make, and ClinVar's
    qualifier is a clinical significance rather than a relation, so it is
    never borrowed for the field.

    An OMIM phenotypic series is split out to ``omim_series``: ClinVar returns
    them beside six-digit entry numbers, but a series names a *group* of
    phenotypes, so it is not the disease's own OMIM number and a consumer keyed
    on entry numbers can never resolve one.

    **Everything Orphadata contributes rests on one assumption, and it is
    worth naming.** Orphadata is reached through the ORPHAcodes ClinVar
    returns in a trait's ``trait_xrefs``, so a published row that mixes the
    two sources is a two-hop claim: ClinVar asserts *this trait is
    Orphanet:X*, and Orphanet asserts something about X. The first hop is an
    identity -- ``trait_xrefs`` are identifiers **for** the trait rather than
    concepts related to it -- which is what makes the second hop usable at
    all:

    * an exact (``E``) Orphanet mapping may fill an identifier column ClinVar
      left empty, because equivalence composed with identity is equivalence;
    * a non-exact mapping keeps the relation Orphanet reported and goes to
      ``related_xrefs``, where it reads as a relation *of this row's
      disease* -- which it is, by the same identity.

    Neither hop is inferred and neither is invented, but both are recorded
    here because the composition is not visible in the published row: the
    wire format has one ``sourceVersion`` and no per-column provenance, so a
    reader cannot tell a ClinVar-attested ``omimId`` from an Orphanet-filled
    one. A stale first hop is the failure mode, and it is handled below: an
    Orphadata group the current ClinVar rows no longer attest is dropped
    rather than published on its own.
    """
    grouped: dict[tuple[str, str], _DiseaseGroup] = {}

    for row in rows:
        group_key = str(row.get("group_key") or "")
        source = str(row.get("source") or "")
        if not group_key or source not in _PUBLISHED_SOURCES:
            continue
        key = (str(row["gene_symbol"]), group_key)
        group = grouped.get(key)
        if group is None:
            group = grouped[key] = _DiseaseGroup(*key)
        group.add(row)

    published_rows: list[dict[str, Any]] = []
    # Sorted: the byte-exact contract cannot hold without a total order.
    for key in sorted(grouped):
        group = grouped[key]
        if group.attested:
            published_rows.append(group.to_wire())
            continue
        # Orphadata rows carry the group key ClinVar had when Orphadata last
        # synced. Drop a stale group that the current ClinVar rows do not attest.
        logger.warning(
            "Dropping %s annotation group %s: no ClinVar row attests it "
            "(a stale Orphadata cache; it clears when Orphadata re-syncs)",
            *key,
        )
    return published_rows


async def read_disease_annotations() -> list[dict[str, Any]]:
    """Read the published slice of the annotation table.

    The ORDER BY puts ClinVar's rows before Orphadata's within a group, which
    the pivot relies on: an exact Orphadata mapping fills only a column ClinVar
    left empty, so ClinVar has to have been seen first.

    A missing table is tolerated, as ``read_pipeline_status`` above tolerates
    one: ``gene_annotations`` arrives with migration 008 and is filled by the
    separately-invoked ``--sync-annotations``, so a database below that
    revision would otherwise abort the whole export at its last step, after
    the four network lookup stages have already run.

    **Nothing else is tolerated.** ``run_export`` reads an empty result as
    "not synced yet" and keeps the committed ``data/gene_annotations.json``,
    so a renamed column, a revoked SELECT or a dropped connection swallowed
    here would freeze that file at its last good read -- shipping stale
    annotations beside freshly regenerated tables, indefinitely and with a
    successful exit code.
    """
    try:
        async with Database.connection() as conn:
            rows = await conn.fetch(
                """
                SELECT gene_symbol, source, relation, group_key, object_id,
                       object_label, qualifier, score, evidence_count,
                       source_version
                FROM gene_annotations
                WHERE relation IN ('disease', 'disease_xref')
                  AND source = ANY($1::text[])
                  AND group_key <> ''
                ORDER BY gene_symbol, group_key, source, object_id
                """,
                sorted(_PUBLISHED_SOURCES),
            )
    except asyncpg.UndefinedTableError:
        logger.warning(
            "No gene_annotations table; keeping the committed "
            "data/gene_annotations.json. Run `uv run alembic -c "
            "pipeline/alembic.ini upgrade head` and then "
            "`uv run python -m pipeline.main --sync-annotations`.",
            exc_info=True,
        )
        return []
    return pivot_disease_annotations([dict(row) for row in rows])
