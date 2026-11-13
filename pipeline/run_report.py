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

import re
from typing import Any, Final, Literal

from pydantic import Field

from pipeline.api_telemetry import ApiServiceRecord
from pipeline.citations import ProvenanceTally
from pipeline.data_merger import canonical_gene_symbol
from pipeline.omics import wire_strings
from pipeline.steps import PREVIEW_RUN_MODE, StepRecord
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
    # The fallback model the run could send a declined paper to: through
    # the server-side fallback on a streaming request, or directly after a
    # --batch entry was refused or a streaming refusal the server-side
    # fallback did not answer. None on a report written before it existed
    # and on a --batch report written before batch runs used it.
    fallback_model: str | None = None
    effort: str | None = None
    prompt_version: str | None = None
    disease: str | None = None
    prompt_sha256: str | None = None
    mode: str | None = None
    skip_validation: bool = False
    dry_run: bool = False
    confidence_threshold_update: float | None = None
    confidence_threshold_insert: float | None = None
    # Appended last: field order is wire order. Whether the Message Batches
    # API extracted the run, which halves its cost; None on a report
    # written before this was published.
    batch: bool | None = None
    # How many days back the run searched PubMed; None on an offline run,
    # which was handed its identifiers, and on a report written before this
    # was published (`recover_search_window` reads it back from the step's
    # own sentence).
    days_back: int | None = None


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
    records it the same way now, so `failed` means one thing whichever
    mode ran.
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
    overstated. It counts a paper's mention, as `validated` does, so
    `validated` is the accepted list's total plus this.
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
    # Appended last: field order is wire order. Cache writes are billed
    # above the input rate and counted in neither `input_tokens` nor
    # `total_tokens`, so without them the cost above cannot be reconciled
    # from this block. None on a report written before it was published:
    # the run wrote some, and 0 would say it did not.
    cache_creation_input_tokens: int | None = None


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
    # Appended last: field order is wire order. True when the merge wrote
    # this gene's PMID, quote and score and withheld its claims
    # (`_citation_only` in pipeline/data_merger.py); the three claim fields
    # above are then empty, as the row is.
    citation_only: bool = False


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
    """One paper, and what came out of it.

    `gene_count` is what the drawer prints as "N accepted", so it counts
    what `accepted_genes` lists for the paper: a gene the insert floor
    held is in `rejected_count` instead, as it is in `rejected_genes`.
    `processing_seconds` is null for a paper nobody timed.
    """

    pmid: str
    source: str
    fulltext: bool = False
    gene_count: int = 0
    rejected_count: int = 0
    processing_seconds: float | None = None
    error: str | None = None
    # Appended last: field order is wire order. Null on a report written
    # before the fallback, which is why both are optional.
    extraction_model: str | None = None
    refusal: str | None = None


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


def bring_up_to_date(report: PipelineRunReport) -> PipelineRunReport:
    """Tell an older stored report what can still be told about it.

    The export re-validates a stored report rather than passing it
    through, and this is the half of that which a default cannot do: a
    count whose *meaning* moved, and a fact the run knew and did not
    store. Both are read back from the accepted list, so both need it
    complete -- a capped list cannot say what a paper had accepted -- and
    a run that never merged has nothing to correct. A report built by the
    current pipeline already agrees, so this is a no-op on it.

    **A paper's `gene_count`** is what the drawer prints as "N accepted".
    A report stored before `_paper_records` took the holds out of it
    counts the genes the insert floor held, so a paper read "2 accepted"
    with neither in the accepted list. The difference moves to the paper's
    rejected count, where the drawer lists a hold.

    **`citation_only`.** An accepted gene is an existing one, since a new
    gene below the insert floor is held; so one whose best score in the
    run sat below that floor took its PMID, quote and score and no claim
    (`_citation_only` in pipeline/data_merger.py), and its record is
    emptied of the claims the way `_gene_records` empties one now.

    What cannot be recovered is left alone: an older report's holds are
    one record per gene, with no paper named, and which papers proposed a
    gene held from two is not in the document.
    """
    accepted = report.accepted_genes
    if (
        report.database is None
        or accepted.truncated
        or any(gene.pmid is None for gene in accepted.items)
    ):
        return report

    per_paper: dict[str, int] = {}
    best: dict[str, float | None] = {}
    for gene in accepted.items:
        if gene.pmid is not None:
            per_paper[gene.pmid] = per_paper.get(gene.pmid, 0) + 1
        key = canonical_gene_symbol(gene.symbol).upper()
        known = best.get(key, 0.0)
        # One unscored mention and the gene's best score is unknown.
        best[key] = (
            None
            if known is None or gene.confidence is None
            else max(known, gene.confidence)
        )

    papers = [
        paper.model_copy(
            update={
                "gene_count": accepted_here,
                "rejected_count": paper.rejected_count
                + paper.gene_count
                - accepted_here,
            }
        )
        if (accepted_here := per_paper.get(paper.pmid, 0)) < paper.gene_count
        else paper
        for paper in report.papers_detail.items
    ]

    floor = report.config.confidence_threshold_insert
    genes = [
        gene.model_copy(
            update={
                "gwas_traits": [],
                "mendelian_randomization": None,
                "omics_evidence": [],
                "citation_only": True,
            }
        )
        if floor is not None
        and (score := best[canonical_gene_symbol(gene.symbol).upper()]) is not None
        and score < floor
        else gene
        for gene in accepted.items
    ]
    return report.model_copy(
        update={
            "papers_detail": report.papers_detail.model_copy(update={"items": papers}),
            "accepted_genes": accepted.model_copy(update={"items": genes}),
        }
    )


_SEARCHED: Final = re.compile(r"^Searched PubMed over the last (\d+) days: ")


def recover_search_window(report: PipelineRunReport) -> PipelineRunReport:
    """Give an older stored report the search window it did not store.

    `days_back` was in `PipelineRunData` all along and was not published,
    so the run card could say "1,571 papers matched" and not of what. The
    run's own first step says it in a sentence this pipeline wrote ("Searched
    PubMed over the last 730 days: ..."), and that number is read back here.
    A report that stored the window, or whose search step holds no such
    sentence (an offline run searched nothing), is returned as it is.
    """
    if report.config.days_back is not None:
        return report
    for step in report.steps:
        if step.key != "searching_pubmed":
            continue
        for action in step.actions:
            if (found := _SEARCHED.match(action)) is not None:
                return report.model_copy(
                    update={
                        "config": report.config.model_copy(
                            update={"days_back": int(found.group(1))}
                        )
                    }
                )
    return report


def _findings(count: str) -> str:
    """ "1 finding", "33 findings": the noun in the number its count takes."""
    return f"{count} finding" if count == "1" else f"{count} findings"


# The sentences that count findings and used to say "genes", as this
# pipeline wrote them before, and how each reads now. Whole sentences,
# anchored at both ends: anything else in a stored report is left alone.
_FINDING_SENTENCES: Final = (
    (
        re.compile(r"^Extracted (\d+) genes?, of which (\d+) passed validation$"),
        lambda m: (
            f"Extracted {_findings(m.group(1))}, "
            f"of which {m.group(2)} passed validation"
        ),
    ),
    (
        re.compile(r"^Cross-checked (\d+) genes? against the rest of the batch$"),
        lambda m: (
            f"Cross-checked {_findings(m.group(1))} against the rest of the batch"
        ),
    ),
    (
        re.compile(r"^(\d+) genes? did not clear the validation floor$"),
        lambda m: f"{_findings(m.group(1))} did not clear the validation floor",
    ),
    (
        re.compile(
            r"^(\d+) genes? (was|were) dropped because "
            r"the quoted sentence was not found in the paper$"
        ),
        lambda m: (
            f"{_findings(m.group(1))} {m.group(2)} dropped because "
            "the quoted sentence was not found in the paper"
        ),
    ),
)


def _reworded(sentence: str) -> str:
    for pattern, rewrite in _FINDING_SENTENCES:
        if (found := pattern.match(sentence)) is not None:
            return rewrite(found)
    return sentence


def reword_findings(report: PipelineRunReport) -> PipelineRunReport:
    """Say "findings" where an older stored report counted them as genes.

    A finding is one paper's proposal of a gene, and a gene is a row of
    the database: a gene found in two papers is two findings. The step
    sentences that count proposals said "genes" ("Extracted 33 genes, of
    which 19 passed validation"), beside a card whose rows say "findings"
    for the same numbers. The pipeline writes the word now; this brings a
    report stored before that into line, sentence by whole sentence
    (`_FINDING_SENTENCES`).

    The merge's own sentences are not among them: it writes rows and holds
    genes, so "Inserted 1 gene and updated 4" and "8 new genes were held
    below the insert floor" are right as they stand. A report with nothing
    to reword is returned as it is.
    """
    steps = [
        step.model_copy(
            update={
                "actions": [_reworded(action) for action in step.actions],
                "warnings": [
                    warning.model_copy(update={"title": _reworded(warning.title)})
                    for warning in step.warnings
                ],
            }
        )
        for step in report.steps
    ]
    if steps == report.steps:
        return report
    return report.model_copy(update={"steps": steps})


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
    papers_detail: list[dict[str, Any]],
    held: set[str],
    citation_only: set[str],
) -> list[GeneRecord]:
    """Every gene the run accepted, in paper order.

    Accepted means what reached the database, which holds for a run that
    merged. One that failed before its merge has no `database` block and
    still lists the genes its papers validated here, because they are what
    it has to show; the widget reads that block and calls them validated.

    Genes the insert floor refused are excluded. They pass validation and
    so appear in `papers_detail[*].genes`, but they never reach the
    database -- listing them under "Genes accepted" while the section
    below called them rejected was two answers to the same question.

    A gene in *citation_only* is an existing row the merge gave its PMID,
    quote and score and nothing else, because its best score sat below the
    insert floor. The record carries what was written: its trait, omics
    and Mendelian randomization fields are empty, as the row's
    contribution is, and the flag says why. They used to carry what the
    model extracted, so the drawer showed claims the table never took.
    """
    records: list[GeneRecord] = []
    for paper in papers_detail:
        for gene in paper.get("genes", []):
            if _is_held(gene, held):
                continue
            cited = _merge_key(gene) in citation_only
            records.append(
                GeneRecord(
                    symbol=gene.get("gene_symbol", ""),
                    pmid=gene.get("pmid"),
                    confidence=gene.get("confidence"),
                    gwas_traits=[] if cited else list(gene.get("gwas_trait") or []),
                    protein_name=gene.get("protein_name"),
                    mendelian_randomization=(
                        None if cited else gene.get("mendelian_randomization")
                    ),
                    omics_evidence=(
                        []
                        if cited
                        else wire_strings(gene.get("omics_evidence") or [])
                    ),
                    causal_evidence_summary=gene.get("causal_evidence_summary"),
                    source_quote=gene.get("source_quote"),
                    citation_only=cited,
                )
            )
    return records


def _held_keys(held: list[dict[str, Any]]) -> set[str]:
    """The curated keys the insert floor refused, for exclusion.

    `held` carries the canonical uppercase key `merge_gene_entries`
    groups on, so an extracted pair member's own symbol has to go through
    the same mapping to be recognised as the held shared alias key. Both
    sides go through `canonical_gene_symbol` -- a no-op on a key that is
    already canonical -- so the comparison is in one key space whichever shape
    arrives.
    """
    return {_merge_key(entry) for entry in held if entry.get("gene_symbol")}


def _merge_key(entry: dict[str, Any]) -> str:
    """The key `merge_gene_entries` groups a gene or a hold under."""
    return canonical_gene_symbol(str(entry.get("gene_symbol", ""))).upper()


def _is_held(gene: dict[str, Any], held: set[str]) -> bool:
    """Whether one paper's gene is a key the insert floor refused.

    Through the same mapping the merge grouped on: `held` says the shared
    alias key, the paper says one pair member's own symbol, and without it
    the gene was listed as accepted *and* rejected -- the double count
    this exclusion exists to remove.
    """
    return _merge_key(gene) in held


def _hold_records(
    papers_detail: list[dict[str, Any]],
    held: list[dict[str, Any]],
    insert_floor: float | None,
) -> list[RejectedGeneRecord]:
    """The insert floor's holds, one per paper that proposed the gene.

    The merge groups by gene, so it returns one hold per gene and names no
    paper. Everything this is published beside counts a paper's mention --
    `validated`, the accepted list, the validation rejections -- so one
    gene held from two papers left the funnel one short and its record
    without a PMID: the 2026-11-03 run validated 19, accepted 10 and held
    8. Each mention is its own record here, under the paper's spelling of
    the gene and the score that mention carried, which is below the floor
    whenever the gene's best one is.

    A hold no paper in *papers_detail* proposed keeps the merge's own key
    and score. Nothing produces one today, and dropping it would be the
    wrong way to find out.
    """
    floor = f" < {insert_floor}" if insert_floor is not None else ""

    def record(
        symbol: str, pmid: str | None, confidence: object
    ) -> RejectedGeneRecord:
        numeric = isinstance(confidence, (int, float))
        scored = f"{confidence:.2f}" if numeric else "?"
        return RejectedGeneRecord(
            symbol=symbol,
            pmid=pmid,
            confidence=confidence if numeric else None,
            reasons=[f"Held below the insert floor: {scored}{floor} (new gene)"],
        )

    mentions: dict[str, list[RejectedGeneRecord]] = {}
    keys = _held_keys(held)
    for paper in papers_detail:
        for gene in paper.get("genes", []):
            if _is_held(gene, keys):
                mentions.setdefault(_merge_key(gene), []).append(
                    record(
                        gene.get("gene_symbol", ""),
                        paper.get("pmid") or gene.get("pmid"),
                        gene.get("confidence"),
                    )
                )

    records: list[RejectedGeneRecord] = []
    for entry in held:
        records.extend(
            mentions.pop(_merge_key(entry), None)
            or [record(entry.get("gene_symbol", ""), None, entry.get("confidence"))]
        )
    return records


def _rejected_records(
    papers_detail: list[dict[str, Any]], holds: list[RejectedGeneRecord]
) -> list[RejectedGeneRecord]:
    """Every gene the run did not accept, from both gates.

    The two gates are different decisions and the reasons say so. The
    validation floor rejects during extraction, per paper. The insert
    floor rejects at the merge, and only for a gene that would be a *new*
    row -- which is why a gene can appear here having passed everything
    the per-paper gate asked of it.
    """
    # Insert-floor holds come first, and that ordering is load-bearing:
    # the list is capped at DETAIL_CAP, holds are always few (only a new
    # gene can be held) and validation rejections are many, so appending
    # them last meant a large run truncated the entire category away
    # while still publishing its count.
    records = list(holds)
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


def _paper_records(
    papers_detail: list[dict[str, Any]], held: set[str]
) -> list[PaperRecord]:
    """One record per paper the run touched.

    A paper's genes the insert floor held move from its accepted count to
    its rejected one, the side of the drawer they are listed on. They pass
    validation, so `gene_count` included them: PMID 42957517 read "2
    accepted" on 2026-11-03 with neither gene in `acceptedGenes`, and the
    paper rows summed to 19 under a headline of 10.
    """
    records: list[PaperRecord] = []
    for paper in papers_detail:
        held_here = sum(_is_held(gene, held) for gene in paper.get("genes", []))
        records.append(
            PaperRecord(
                pmid=paper.get("pmid", ""),
                source=paper.get("source", "unknown"),
                fulltext=bool(paper.get("fulltext")),
                gene_count=max(0, paper.get("gene_count", 0) - held_here),
                rejected_count=len(paper.get("rejected_genes", [])) + held_here,
                # 0.0 is `PaperResult.processing_time`'s default, which is
                # what a --batch entry keeps: the batch is never timed per
                # paper, and "0 ms" on every row of a day-long poll is a
                # measurement nobody took. A paper that ran has a positive
                # monotonic delta.
                processing_seconds=_optional_seconds(
                    paper.get("processing_time") or None
                ),
                error=paper.get("error"),
                extraction_model=paper.get("extraction_model"),
                refusal=paper.get("refusal"),
            )
        )
    return records


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
        run_mode: One of `pipeline.steps.RUN_MODES`. A preview run lists
            every accepted gene, uncapped: its review round needs a finding
            behind each change, and the preview export refuses a capped list.
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
    held_keys = _held_keys(held)
    holds = _hold_records(papers_detail, held, insert_floor)
    cited = database.get("citation_only") if isinstance(database, dict) else None
    citation_only = {
        canonical_gene_symbol(str(key)).upper()
        for key in (cited if isinstance(cited, list) else [])
    }
    provenance = provenance or ProvenanceTally()
    accepted = _gene_records(papers_detail, held_keys, citation_only)

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
                # Mentions, not genes, like every count beside it: see
                # `_hold_records`.
                "rejected_at_insert_floor": len(holds),
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
        papers_detail=CappedList[PaperRecord].of(
            _paper_records(papers_detail, held_keys)
        ),
        accepted_genes=CappedList[GeneRecord].of(
            accepted, cap=len(accepted) if run_mode == PREVIEW_RUN_MODE else DETAIL_CAP
        ),
        rejected_genes=CappedList[RejectedGeneRecord].of(
            _rejected_records(papers_detail, holds)
        ),
    )
