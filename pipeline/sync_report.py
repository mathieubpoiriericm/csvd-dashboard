"""The record a reference-data refresh publishes.

`--clinical-trials`, `--sync-external-data` and `--sync-annotations` each
talk to upstreams the PubMed run never touches -- ClinicalTrials.gov,
ClinVar, Orphadata, Open Targets, UniProt -- and until this module existed
every one of those calls was recorded into the API recorder and then
dropped on the floor: `build_run_report` is reachable only from inside
`run_pipeline`, so no published report could contain a row for any of
them.

**Why not `pipeline_runs`.** `PipelineRunReport` requires three fields and
defaults the rest, so a sync document stored in `pipeline_runs.report`
would *validate* in `read_pipeline_run` rather than being rejected, and
the About page would publish a zero-filled PubMed run over the real one --
no exception, no log line. `read_pipeline_status` would also date the
whole dataset from it. Sharing that table would put two
`WHERE run_mode = 'standard'` clauses in two functions that each swallow
their own errors; a separate table makes the mistake unavailable instead.

Small on purpose, and it reuses rather than parallels: `RunStatus` so the
existing badge encoding applies with no new vocabulary, `ApiServiceRecord`
verbatim because that inventory is the whole point, and `CappedList` for
the errors.
"""

from dataclasses import dataclass
from typing import Any, Final

from pydantic import Field

from pipeline.api_telemetry import ApiServiceRecord
from pipeline.run_report import CappedList, RunStatus
from pipeline.wire_model import WireModel


class SyncSourceRecord(WireModel):
    """One upstream a sync consulted, and how it went.

    The label rides the wire, as `ApiServiceRecord.label` does: which
    database was consulted is data, not appearance, and these names are
    the ones the About page's Data Sources panel already uses.
    """

    key: str
    label: str
    fetched: int = 0
    cached: int = 0
    failed: int = 0


class SyncRunReport(WireModel):
    """One reference-data refresh, as the dashboard publishes it.

    Field order here **is** the wire order, as in `run_report.py`, so a
    reordering shows up as a diff in a byte-gated file.

    `duration_seconds` is wall-clock across an `asyncio.timeout(3600)`, so
    a sync that times out reads `failed` with a flat 3600 s rather than
    the time it spent doing useful work. That is the honest number for
    what the run took; do not "fix" it to something smaller.
    """

    run_timestamp: str
    mode: str
    status: RunStatus
    duration_seconds: float = 0.0
    sources: list[SyncSourceRecord] = Field(default_factory=list)
    apis: list[ApiServiceRecord] = Field(default_factory=list)
    errors: CappedList[str] = Field(
        default_factory=lambda: CappedList[str](shown=0, total=0)
    )

    def to_wire(self) -> dict[str, Any]:
        """One camelCase entry of `data/pipeline_syncs.json`."""
        return self.model_dump(mode="json", by_alias=True)


@dataclass(frozen=True, slots=True)
class _SourceSpec:
    """Which metric names carry one upstream's three counts.

    Named explicitly rather than derived from a `<source>_<count>` rule:
    the three pipelines do not share one convention -- clinical trials
    reports bare `fetched`/`cached`/`failed`, and the Open Targets drug
    records report `drugs_written` and no cache count at all -- so a rule
    would have to carry exceptions anyway, and an exception that looks
    like a convention is how a count silently reads zero.
    """

    key: str
    label: str
    fetched: str = ""
    cached: str = ""
    failed: str = ""


# One entry per upstream each mode consults, in the order the sync runs
# them, which is the order they are published in.
_SOURCES: Final[dict[str, tuple[_SourceSpec, ...]]] = {
    "clinical_trials": (
        _SourceSpec(
            "clinicaltrials",
            "ClinicalTrials.gov",
            fetched="fetched",
            cached="cached",
            failed="failed",
        ),
    ),
    "external_sync": (
        _SourceSpec(
            "ncbi_gene",
            "NCBI Gene",
            fetched="ncbi_fetched",
            cached="ncbi_cached",
            failed="ncbi_failed",
        ),
        _SourceSpec(
            "uniprot",
            "UniProt",
            fetched="uniprot_fetched",
            cached="uniprot_cached",
            failed="uniprot_failed",
        ),
        _SourceSpec(
            "pubmed_citations",
            "PubMed citations",
            fetched="pubmed_fetched",
            cached="pubmed_cached",
            failed="pubmed_failed",
        ),
    ),
    "annotation_sync": (
        _SourceSpec(
            "clinvar",
            "ClinVar",
            fetched="clinvar_fetched",
            cached="clinvar_cached",
            failed="clinvar_failed",
        ),
        _SourceSpec(
            "orphadata",
            "Orphadata",
            fetched="orphadata_fetched",
            cached="orphadata_cached",
            failed="orphadata_failed",
        ),
        _SourceSpec(
            "opentargets",
            "Open Targets",
            fetched="opentargets_fetched",
            cached="opentargets_cached",
            failed="opentargets_failed",
        ),
        # Fetched, with no cache at all: `sync_trial_drug_annotations`
        # issues one GraphQL search per drug on every run -- there is no
        # status row and no TTL for them -- and writes what comes back to
        # `trial_drug_annotations`. `drugs_written` was published in the
        # `cached` field, which told a reader the mechanisms were served
        # from cache beside an API row counting the very POSTs that
        # fetched them.
        _SourceSpec(
            "opentargets_drugs",
            "Open Targets drug records",
            fetched="drugs_written",
            failed="drugs_failed",
        ),
    ),
}


def _count(metrics: dict[str, Any], name: str) -> int:
    """One metric, defaulting to zero when the pipeline does not report it."""
    if not name:
        return 0
    value = metrics.get(name, 0)
    return value if isinstance(value, int) else 0


def _seconds(value: float) -> float:
    """Round a duration to milliseconds, as the run report does.

    A raw monotonic delta serialises as 3042.086376051884, which is noise
    in a committed file gated on its bytes.
    """
    return round(value, 3)


def build_sources(mode: str, metrics: dict[str, Any]) -> list[SyncSourceRecord]:
    """The upstream rows for one mode's metrics dict.

    A mode with no declared sources yields none rather than raising: the
    report is still worth storing for its API inventory, which is what
    this record exists for.
    """
    return [
        SyncSourceRecord(
            key=spec.key,
            label=spec.label,
            fetched=_count(metrics, spec.fetched),
            cached=_count(metrics, spec.cached),
            failed=_count(metrics, spec.failed),
        )
        for spec in _SOURCES.get(mode, ())
    ]


def derive_sync_status(
    summary_status: str, sources: list[SyncSourceRecord], errors: list[str]
) -> RunStatus:
    """The headline badge for a refresh.

    A per-source failure is a warning rather than a failure because the
    sync carried on and wrote what it could -- the same reasoning that
    makes a run with rejected genes `completed_with_warnings` rather than
    green. `derive_status` cannot be reused: it reads `StepRecord`s, and a
    sync has no steps. That matters more than it looks, because
    `derive_status([])` returns `completed` -- an empty-step report would
    publish a green badge over a sync that failed outright.

    **Only the summary's own status is red.** The errors a sync collects
    are per item -- one string per gene or study it could not fetch -- so
    reading `failed` off a non-empty list made this branch fire for every
    refresh with a single failed lookup and left the amber branch
    unreachable from any real run. `_result_summary` and
    `_failure_summary` decide `failed`; a listed error still shows amber,
    because an error nobody counted in `source.failed` is still something
    the reader has to see.
    """
    if summary_status == "failed":
        return "failed"
    if errors or any(source.failed for source in sources):
        return "completed_with_warnings"
    return "completed"


def build_sync_report(
    summary: dict[str, Any],
    *,
    mode: str,
    apis: list[ApiServiceRecord],
    run_timestamp: str,
    duration_seconds: float,
) -> SyncRunReport:
    """Assemble the record from what the sync already reported.

    Args:
        summary: The `{"name", "status", "metrics", "errors"}` dict the
            three sync entry points already return for the notification.
        mode: One of `pipeline.steps.SYNC_MODES`.
        apis: `ApiRecorder.records()`, the reason this record exists.
        run_timestamp: When the sync started, ISO-8601.
        duration_seconds: Wall-clock time for the sync.

    Returns:
        The record, ready to store and to publish.
    """
    metrics = summary.get("metrics") or {}
    errors = [str(error) for error in summary.get("errors") or []]
    sources = build_sources(mode, metrics)
    return SyncRunReport(
        run_timestamp=run_timestamp,
        mode=mode,
        status=derive_sync_status(str(summary.get("status", "")), sources, errors),
        duration_seconds=_seconds(duration_seconds),
        sources=sources,
        apis=apis,
        errors=CappedList[str].of(errors),
    )
