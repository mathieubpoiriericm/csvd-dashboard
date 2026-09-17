"""The run report the dashboard publishes.

This model is the schema on both sides of the database: the pipeline
builds one, `pipeline_runs.report` stores its JSON, and the export reads
it back through the same class before writing `data/pipeline_run.json`.
Field order here **is** the wire order, so a reordering is a visible diff
in a byte-gated file rather than a silent one.

It is assembled from `PipelineRunData` -- the dict `pipeline/report.py`
already builds for the log file, the rich summary and the notification --
plus the step and API records, which are new. Nothing here recomputes a
metric that module already computed.
"""

from typing import Any, Final, Literal

from pydantic import Field

from pipeline.api_telemetry import ApiServiceRecord
from pipeline.citations import ProvenanceTally
from pipeline.data_merger import canonical_gene_symbol
from pipeline.steps import StepRecord
from pipeline.wire_model import WireModel

# Detail lists are capped so a 500-paper run cannot turn a committed,
# byte-gated file into an unreviewable megabyte diff. Counts above are
# always exact; only the enumerations are trimmed, and every capped list
# says so in its own `total`.
DETAIL_CAP: Final[int] = 200

RunStatus = Literal["completed", "completed_with_warnings", "failed"]


class CappedList[T](WireModel):
    """An enumeration that may be shorter than what it counts.

    `shown` and `total` are separate so the UI can say "showing 200 of
    1,412" rather than quietly presenting a truncated list as complete.
    """

    shown: int
    total: int
    items: list[T] = Field(default_factory=list)

    @classmethod
    def of(cls, values: list[T], cap: int = DETAIL_CAP) -> CappedList[T]:
        """Cap a list, recording what was left out."""
        return cls(shown=min(len(values), cap), total=len(values), items=values[:cap])

    @property
    def truncated(self) -> bool:
        """Whether anything was left out."""
        return self.shown < self.total


class RunConfigRecord(WireModel):
    """What the run was configured to do.

    The two confidence floors are named because they are the reason a
    gene was rejected, and the widget quotes them back in the rejection.
    """

    model: str | None = None
    effort: str | None = None
    prompt_version: str | None = None
    disease: str | None = None
    prompt_sha256: str | None = None
    mode: str | None = None
    skip_validation: bool = False
    dry_run: bool = False
    confidence_threshold_update: float | None = None
    confidence_threshold_insert: float | None = None


class PaperCounts(WireModel):
    """Papers fetched versus accepted.

    `found` and `newlySeen` exist only on a PubMed run: an offline run
    was handed its identifiers and never searched.

    `noTextAvailable` is its own count rather than part of `failed`, and
    that distinction is load-bearing. The two online paths deliberately
    treat a paper with no retrievable text as *processed* -- it is a
    stable fact about the paper, not a transient error, so recording it
    stops the pipeline retrying that paper on every future run. Folding
    it into `failed` would either misreport those runs or invite someone
    to "fix" the pipeline into retrying forever. The offline PMID mode
    records the same situation as an error because it never writes
    processed PMIDs, so nothing there retries either way; counting the
    condition itself is what makes the two comparable.
    """

    found: int | None = None
    newly_seen: int | None = None
    already_seen: int | None = None
    processed: int = 0
    fulltext: int = 0
    abstract_only: int = 0
    no_text_available: int = 0
    failed: int = 0


class GeneCounts(WireModel):
    """Genes fetched versus accepted, and where the losses happened.

    `rejectedAtInsertFloor` is counted separately because it is a
    different decision from validation: a gene can clear the update floor,
    reach the merge, and still be refused as a *new* row. Before this it
    was logged by symbol and counted nowhere, so the acceptance rate
    overstated.
    """

    extracted: int = 0
    validated: int = 0
    rejected: int = 0
    rejected_at_insert_floor: int = 0
    # Two different claims, kept apart. `quotesVerbatim` asks whether the
    # sentence is in the paper, of every gene. `quotesCited` asks whether
    # the API attested to that span -- stronger where it exists, but
    # bounded by how much prose the model wrote rather than by quote
    # quality, so it runs far lower and is not a quality signal on its own.
    quotes_checked: int = 0
    quotes_verbatim: int = 0
    quotes_cited: int = 0


class TokenRecord(WireModel):
    """What the extraction cost."""

    input_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    cache_read_input_tokens: int = 0
    total_tokens: int = 0
    cache_hit_rate: float = 0.0
    truncated_responses: int = 0
    estimated_cost_usd: float = 0.0


class DatabaseRecord(WireModel):
    """What the run wrote."""

    inserted: int = 0
    updated: int = 0


class GeneRecord(WireModel):
    """One gene the run accepted, with everything stored about it.

    The drawer's promise is "everything this run recorded", so this
    carries the curated columns rather than a summary of them --
    including `causalEvidenceSummary`, which is the model's own account
    of why the gene qualifies, and `sourceQuote`, the sentence it came
    from. Those two are the transparency artifacts; omitting them would
    leave the drawer showing identifiers and no evidence.
    """

    symbol: str
    pmid: str | None = None
    confidence: float | None = None
    gwas_traits: list[str] = Field(default_factory=list)
    protein_name: str | None = None
    mendelian_randomization: bool | None = None
    omics_evidence: list[str] = Field(default_factory=list)
    causal_evidence_summary: str | None = None
    source_quote: str | None = None


class RejectedGeneRecord(WireModel):
    """One gene the run did not accept, and why.

    `reasons` are the strings the gates already produce -- "Low
    confidence: 0.60 < 0.65" -- kept verbatim rather than re-worded, so
    the widget shows the pipeline's own account of the decision.
    """

    symbol: str
    pmid: str | None = None
    confidence: float | None = None
    reasons: list[str] = Field(default_factory=list)


class PaperRecord(WireModel):
    """One paper, and what came out of it."""

    pmid: str
    source: str
    fulltext: bool = False
    gene_count: int = 0
    rejected_count: int = 0
    processing_seconds: float | None = None
    error: str | None = None


class PipelineRunReport(WireModel):
    """Everything the dashboard's pipeline widget renders."""

    run_timestamp: str
    status: RunStatus
    run_mode: str
    duration_seconds: float = 0.0
    compute_seconds: float = 0.0
    config: RunConfigRecord = Field(default_factory=RunConfigRecord)
    papers: PaperCounts = Field(default_factory=PaperCounts)
    genes: GeneCounts = Field(default_factory=GeneCounts)
    tokens: TokenRecord = Field(default_factory=TokenRecord)
    database: DatabaseRecord | None = None
    steps: list[StepRecord] = Field(default_factory=list)
    apis: list[ApiServiceRecord] = Field(default_factory=list)
    papers_detail: CappedList[PaperRecord] = Field(
        default_factory=lambda: CappedList[PaperRecord](shown=0, total=0)
    )
    accepted_genes: CappedList[GeneRecord] = Field(
        default_factory=lambda: CappedList[GeneRecord](shown=0, total=0)
    )
    rejected_genes: CappedList[RejectedGeneRecord] = Field(
        default_factory=lambda: CappedList[RejectedGeneRecord](shown=0, total=0)
    )

    def to_wire(self) -> dict[str, Any]:
        """The camelCase document `data/pipeline_run.json` carries."""
        return self.model_dump(mode="json", by_alias=True)


def _no_text_count(papers_detail: list[dict[str, Any]]) -> int:
    """Papers the run could retrieve no text for, however each path said so.

    All three paths mark it the same way now: retrieval succeeded and
    returned nothing, so the paper is recorded as processed with
    `source: "none"` and no error.

    A paper that carries an error is excluded even if its source says
    "none". Errored results used to inherit that string from
    `PaperResult`'s default, so an HTTP 500 was counted here *and* in
    `papers.failed`, and the three retrieval counts could sum past
    `processed`.
    """
    return sum(
        1
        for paper in papers_detail
        if paper.get("error") is None and paper.get("source") == "none"
    )


def _seconds(value: float) -> float:
    """Round a duration to milliseconds.

    A raw monotonic delta serialises as 6.291986210271716e-06. That is
    noise in a file a human reviews in `git diff`, and no part of the
    widget renders below a millisecond.
    """
    return round(value, 3)


def _optional_seconds(value: float | None) -> float | None:
    """Round a duration that may be absent.

    Split from `_seconds` rather than folded into it: the run's own
    duration is always a number and the model types it as one, so a
    single helper returning `float | None` made every required field
    optional at the call site and `ty` rejected it.
    """
    return None if value is None else _seconds(value)


def derive_status(steps: list[StepRecord]) -> RunStatus:
    """The run's headline badge, from its steps.

    A run is only `completed` when nothing warned. That is deliberate:
    the widget exists to make the losses visible, and a green badge over
    24 rejected genes would be the same silence this replaces.
    """
    if any(step.status == "failed" for step in steps):
        return "failed"
    if any(step.status == "warning" for step in steps):
        return "completed_with_warnings"
    return "completed"


def _gene_records(
    papers_detail: list[dict[str, Any]], held: set[str]
) -> list[GeneRecord]:
    """Every gene the run actually wrote, in paper order.

    Genes the insert floor refused are excluded. They pass validation and
    so appear in `papers_detail[*].genes`, but they never reach the
    database -- listing them under "Genes accepted" while the section
    below called them rejected was two answers to the same question.
    """
    return [
        GeneRecord(
            symbol=gene.get("gene_symbol", ""),
            pmid=gene.get("pmid"),
            confidence=gene.get("confidence"),
            gwas_traits=list(gene.get("gwas_trait") or []),
            protein_name=gene.get("protein_name"),
            mendelian_randomization=gene.get("mendelian_randomization"),
            omics_evidence=list(gene.get("omics_evidence") or []),
            causal_evidence_summary=gene.get("causal_evidence_summary"),
            source_quote=gene.get("source_quote"),
        )
        for paper in papers_detail
        for gene in paper.get("genes", [])
        # Through the same mapping the merge grouped on: `held` says
        # `COL4A1/2`, the paper says `COL4A1`, and without it the gene
        # was listed as accepted *and* rejected -- the double count this
        # exclusion exists to remove.
        if canonical_gene_symbol(str(gene.get("gene_symbol", ""))).upper()
        not in held
    ]


def _held_keys(held: list[dict[str, Any]]) -> set[str]:
    """The curated keys the insert floor refused, for exclusion.

    `held` carries the canonical uppercase key `merge_gene_entries`
    groups on, so an extracted `COL4A1` has to go through the same
    mapping to be recognised as the held `COL4A1/2`. Both sides go
    through `canonical_gene_symbol` -- a no-op on a key that is already
    canonical -- so the comparison is in one key space whichever shape
    arrives.
    """
    return {
        canonical_gene_symbol(str(entry.get("gene_symbol", ""))).upper()
        for entry in held
        if entry.get("gene_symbol")
    }


def _rejected_records(
    papers_detail: list[dict[str, Any]],
    held: list[dict[str, Any]],
    insert_floor: float | None,
) -> list[RejectedGeneRecord]:
    """Every gene the run did not accept, from both gates.

    The two gates are different decisions and the reasons say so. The
    validation floor rejects during extraction, per paper. The insert
    floor rejects at the merge, and only for a gene that would be a *new*
    row -- which is why a gene can appear here having passed everything
    the per-paper gate asked of it.
    """
    records: list[RejectedGeneRecord] = []
    # Insert-floor holds come first, and that ordering is load-bearing:
    # the list is capped at DETAIL_CAP, holds are always few (only a new
    # gene can be held) and validation rejections are many, so appending
    # them last meant a large run truncated the entire category away
    # while still publishing its count.
    for entry in held:
        confidence = entry.get("confidence")
        floor = f" < {insert_floor}" if insert_floor is not None else ""
        scored = f"{confidence:.2f}" if isinstance(confidence, (int, float)) else "?"
        records.append(
            RejectedGeneRecord(
                symbol=entry.get("gene_symbol", ""),
                confidence=confidence,
                reasons=[f"Held below the insert floor: {scored}{floor} (new gene)"],
            )
        )
    for paper in papers_detail:
        for rejection in paper.get("rejected_genes", []):
            gene = rejection.get("gene", {})
            records.append(
                RejectedGeneRecord(
                    symbol=gene.get("gene_symbol", ""),
                    pmid=gene.get("pmid"),
                    confidence=gene.get("confidence"),
                    reasons=list(rejection.get("reasons") or []),
                )
            )
    return records


def _paper_records(papers_detail: list[dict[str, Any]]) -> list[PaperRecord]:
    """One record per paper the run touched."""
    return [
        PaperRecord(
            pmid=paper.get("pmid", ""),
            source=paper.get("source", "unknown"),
            fulltext=bool(paper.get("fulltext")),
            gene_count=paper.get("gene_count", 0),
            rejected_count=len(paper.get("rejected_genes", [])),
            processing_seconds=_optional_seconds(paper.get("processing_time")),
            error=paper.get("error"),
        )
        for paper in papers_detail
    ]


def build_run_report(
    run_data: dict[str, Any],
    *,
    steps: list[StepRecord],
    apis: list[ApiServiceRecord],
    run_mode: str,
    provenance: ProvenanceTally | None = None,
) -> PipelineRunReport:
    """Assemble the published report from what the run already recorded.

    Args:
        run_data: The `PipelineRunData` dict `pipeline/report.py` builds.
        steps: `StepRecorder.records()`.
        apis: `ApiRecorder.records()`.
        run_mode: `standard`, `local_pdf` or `pmid_list`.
        provenance: `citations.current_tally()`; an empty tally when the
            run did no extraction.

    Returns:
        The report, ready to store and to publish.
    """
    papers_detail = run_data.get("papers_detail", [])
    papers = run_data.get("papers", {})
    genes = run_data.get("genes", {})
    tokens = run_data.get("token_usage", {})
    config = run_data.get("pipeline_config", {})
    search = run_data.get("search", {})
    database = run_data.get("database")
    # A gene refused as a new row at the merge is a rejection the
    # per-paper gate never saw, so it is counted and listed here rather
    # than only logged by symbol as it used to be.
    held: list[dict[str, Any]] = (
        list(database.get("held_below_insert_floor") or [])
        if isinstance(database, dict)
        else []
    )
    insert_floor = config.get("confidence_threshold_insert")
    provenance = provenance or ProvenanceTally()

    return PipelineRunReport(
        run_timestamp=run_data.get("timestamp", ""),
        status=derive_status(steps),
        run_mode=run_mode,
        duration_seconds=_seconds(run_data.get("total_processing_time", 0.0)),
        compute_seconds=_seconds(run_data.get("total_compute_time", 0.0)),
        config=RunConfigRecord.model_validate(config),
        papers=PaperCounts.model_validate(
            {
                **papers,
                "found": search.get("pmids_found"),
                "newly_seen": search.get("pmids_new"),
                "already_seen": search.get("pmids_skipped"),
                "no_text_available": _no_text_count(papers_detail),
            }
        ),
        genes=GeneCounts.model_validate(
            {
                **genes,
                "rejected_at_insert_floor": len(held),
                "quotes_checked": provenance.genes,
                "quotes_verbatim": provenance.verbatim,
                "quotes_cited": provenance.cited,
            }
        ),
        tokens=TokenRecord.model_validate(tokens),
        database=(
            DatabaseRecord.model_validate(database)
            if isinstance(database, dict)
            else None
        ),
        steps=steps,
        apis=apis,
        papers_detail=CappedList[PaperRecord].of(_paper_records(papers_detail)),
        accepted_genes=CappedList[GeneRecord].of(
            _gene_records(papers_detail, _held_keys(held))
        ),
        rejected_genes=CappedList[RejectedGeneRecord].of(
            _rejected_records(papers_detail, held, insert_floor)
        ),
    )
