#!/usr/bin/env python3
# PYTHON_ARGCOMPLETE_OK
"""
Main entry point for the dashboard's data pipeline.

Runs one or more of three independently-selectable pipelines:

- PubMed gene extraction (``--pubmed``, also the default when no flag is set)
- ClinicalTrials.gov fetch (``--clinical-trials``)
- External metadata enrichment: NCBI Gene, UniProt, PubMed citations
  (``--sync-external-data``)
- Machine-fetched gene annotations: ClinVar, Orphadata, Open Targets
  (``--sync-annotations``)

Flags can be combined; selected pipelines run in sequence with a single
notification per invocation.

Usage:
    python pipeline/main.py [--days-back N] [--dry-run] [--test-mode] [--batch]
    python pipeline/main.py --clinical-trials
    python pipeline/main.py --pubmed --clinical-trials
    python pipeline/main.py --sync-external-data
    python pipeline/main.py --sync-annotations
    python pipeline/main.py --local-pdfs PATH [--skip-validation]
    python pipeline/main.py --pmids FILE [--skip-validation]
"""

import argparse
import sys
from pathlib import Path

DEFAULT_DAYS_BACK = 7


def _build_parser() -> argparse.ArgumentParser:
    """Build the CLI argument parser (stdlib-only, no heavy imports)."""
    parser = argparse.ArgumentParser(description="Dashboard data pipeline")
    parser.add_argument(
        "--days-back",
        type=int,
        default=DEFAULT_DAYS_BACK,
        help="Number of days to look back for new papers (default: 7)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Extract, but write nothing to the database. Papers already in"
            " pubmed_refs are still skipped, so this costs what the same"
            " real run would cost."
        ),
    )
    parser.add_argument(
        "--test-mode",
        action="store_true",
        help=(
            "Search and deduplicate only -- no LLM extraction, no database"
            " merge, no spend. Use it to count what a window would actually"
            " process before paying for it."
        ),
    )
    parser.add_argument(
        "--batch",
        action="store_true",
        help=(
            "Submit every paper in one Batch API request at half price"
            " (PubMed pipeline only). Results usually arrive within an hour;"
            " the default streaming path stays better for small runs."
        ),
    )
    parser.add_argument(
        "--pubmed",
        action="store_true",
        help=(
            "Explicitly run the PubMed gene extraction pipeline."
            " Also runs by default when no pipeline selector flag is given."
        ),
    )
    parser.add_argument(
        "--clinical-trials",
        action="store_true",
        help="Run the ClinicalTrials.gov discovery pipeline.",
    )
    parser.add_argument(
        "--sync-external-data",
        action="store_true",
        help=(
            "Sync external metadata (NCBI Gene, UniProt, PubMed citations)"
            " for all genes in the database. Clinical trial discovery is"
            " a separate pipeline (use --clinical-trials)."
        ),
    )
    parser.add_argument(
        "--sync-annotations",
        action="store_true",
        help=(
            "Fetch ClinVar, Orphadata and Open Targets annotations for the "
            "curated genes. Writes only the annotation tables; the genes table "
            "is never touched."
        ),
    )
    parser.add_argument(
        "--export",
        action="store_true",
        help=(
            "After the selected pipelines finish, regenerate data/*.json from"
            " the database (the same work as `deno task data`). Leaves the"
            " files in the working tree; nothing is committed."
        ),
    )
    parser.add_argument(
        "--local-pdfs",
        type=Path,
        metavar="PATH",
        help="Extract genes from a local PDF file or directory of PDFs"
        " (no PubMed search or database)",
    )
    parser.add_argument(
        "--pmids",
        type=Path,
        metavar="FILE",
        help="Process specific PMIDs from a text file (one per line, no database)",
    )
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="Skip NCBI gene validation (only valid with --local-pdfs or --pmids)",
    )
    return parser


# --- Fast path for tab-completion ---
# argcomplete.autocomplete() calls sys.exit() during completion,
# so heavy imports below never load. This keeps <TAB> instant.
if __name__ == "__main__":
    try:
        import argcomplete

        _parser = _build_parser()
        argcomplete.autocomplete(_parser)
        del _parser
    except ImportError:
        pass
# --- End fast path ---

import asyncio
import contextlib
import json
import logging
import re
import time
import traceback
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any, Final, Literal, TypedDict, cast

ProgressStatus = Literal["running", "completed", "error"]

import asyncpg
import httpx
from lxml import etree  # type: ignore[import-untyped]

# Add project root to path for imports when running as script
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Load environment variables from .env file
from dotenv import load_dotenv

load_dotenv(PROJECT_ROOT / ".env")

import os
import signal


# macOS Python framework builds may lack a default CA bundle at the compiled-in
# OpenSSL path.  When SSL_CERT_FILE is not already set, point it at the certifi
# bundle so that urllib/httpx/etc. can verify TLS certificates out of the box.
def _configure_ca_bundle() -> None:
    if not os.environ.get("SSL_CERT_FILE"):
        import certifi

        os.environ["SSL_CERT_FILE"] = certifi.where()


_configure_ca_bundle()

from pipeline import checkpoint, europepmc, ncbi_http
from pipeline.api_telemetry import current_recorder, reset_recorder
from pipeline.batch_extraction import submit_and_collect
from pipeline.batch_validation import batch_validate
from pipeline.citations import current_tally, paper_scope, reset_tally
from pipeline.clinical_trials_fetch import close_ctg_client, sync_clinical_trials
from pipeline.config import (
    NCBI_EFETCH_URL,
    SAFE_XML_PARSER,
    PipelineConfig,
    validate_pmid,
)
from pipeline.data_merger import (
    MergeResult,
    canonical_gene_symbol,
    merge_gene_entries,
)
from pipeline.database import (
    Database,
    DatabaseConfigError,
    get_existing_pmids,
    record_pipeline_run,
    record_processed_pmids_batch,
    record_sync_run,
    reset_gene_sequence,
)
from pipeline.disease import load_disease
from pipeline.event_log import EventLog
from pipeline.extraction_models import GeneEntry
from pipeline.http_client import AsyncHttpClientManager
from pipeline.llm_extraction import (
    ExtractionFailedError,
    close_async_client,
    extract_from_paper,
)
from pipeline.notifications import send_pipeline_notification
from pipeline.pdf_retrieval import (
    close_http_client,
    get_fulltext,
    parse_local_pdf,
)
from pipeline.prompts import paper_text_truncated
from pipeline.pubmed_search import filter_new_pmids, search_recent_papers
from pipeline.quality_metrics import PipelineMetrics, TokenUsage
from pipeline.rate_limiter import AsyncRateLimiter
from pipeline.report import (
    PipelineRunData,
    build_local_pdf_run_data,
    build_pmid_run_data,
    build_run_data,
    print_rich_summary,
    write_comprehensive_report,
)
from pipeline.run_errors import RunWarning, classify
from pipeline.run_report import build_run_report
from pipeline.steps import (
    STEP_KEYS,
    SYNC_MODES,
    TOTAL_STEPS,
    StepRecord,
    StepRecorder,
)
from pipeline.sync_report import build_sync_report
from pipeline.validation import (
    NcbiUnavailableError,
    clear_gene_cache,
    close_validation_client,
    init_validation_state,
    validate_gene_entry,
)

# --- Constants ---
LOG_SEPARATOR: Final[str] = "=" * 50

# "The database is not there", as asyncpg reports it: a refused or reset
# socket (OSError, which builtin TimeoutError also subclasses) and a server
# that answered with an error (PostgresError) -- and as the pipeline itself
# reports it when no DB_* variable is set at all, which is a fresh clone or
# CI and raises before any socket is opened. Tolerated only for --dry-run
# and --test-mode, where working without a database is the point.
_PREVIEW_DB_FAILURES: Final[tuple[type[Exception], ...]] = (
    OSError,
    asyncpg.PostgresError,
    DatabaseConfigError,
)
# How many of a pre-export lookup refresh's per-source errors reach the log
# line. The sync itself already truncates its list; this keeps one unlucky
# run from burying the diagnostic under a hundred gene names.
_MAX_LOOKUP_ERRORS_LOGGED: Final[int] = 5
# Configure logging
LOG_DIR = Path(os.getenv("PIPELINE_LOG_DIR", PROJECT_ROOT / "logs"))
LOG_DIR.mkdir(exist_ok=True)
LOG_LOG_DIR = LOG_DIR / "log"
LOG_LOG_DIR.mkdir(exist_ok=True)
# UTC matches every other timestamp in the pipeline; PID suffix survives
# same-second invocations (e.g. scheduler overlap, manual re-runs).
LOG_FILE = LOG_LOG_DIR / (
    f"pipeline_{datetime.now(UTC).strftime('%Y-%m-%d_%Hh%Mm%Ss')}_{os.getpid()}.log"
)

from rich.logging import RichHandler

# httpx logs every request at INFO with the full URL, and NCBI takes its
# credential as a query parameter (see config.add_api_key), so an unfiltered
# run wrote the real NCBI api_key into logs/log/*.log on every abstract
# fetch and gene validation -- 11 times in a three-paper run. The key is a
# rate-limit token rather than a billing credential, and logs/ is gitignored,
# but log files are exactly what gets attached to bug reports.
#
# Redacting here rather than silencing httpx keeps the request log, which is
# how the retrieval cascade is actually traced. `email=` is deliberately not
# redacted: Unpaywall and NCBI require a contact address by policy, and it is
# not a secret.
_SECRET_QUERY_PARAM: Final[re.Pattern[str]] = re.compile(
    r"(?i)\b(api_key|apikey|access_token|token|password|secret)=[^&\s\"']+"
)


class _RedactSecrets(logging.Filter):
    """Strip credential query parameters from every record."""

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted = _SECRET_QUERY_PARAM.sub(r"\1=<redacted>", message)
        if redacted != message:
            # Collapse to the formatted string only when something was
            # actually removed, so ordinary records keep lazy formatting.
            record.msg = redacted
            record.args = ()
        return True


logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
    datefmt="[%X]",
    handlers=[
        RichHandler(
            rich_tracebacks=True,
            markup=True,
            show_path=False,
        ),
        logging.FileHandler(LOG_FILE),
    ],
)
# Keep file handler plain-text (no ANSI codes)
logging.getLogger().handlers[1].setFormatter(
    logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
)
# On the handlers, not the logger: a logger-level filter would not see
# records propagated up from httpx, validation, or any other module.
for _handler in logging.getLogger().handlers:
    _handler.addFilter(_RedactSecrets())
logger = logging.getLogger(__name__)


# -------------------------------------------------------------------------
# PIPELINE PROGRESS REPORTING
# -------------------------------------------------------------------------


def _write_progress(
    config: PipelineConfig,
    *,
    status: ProgressStatus,
    stage: str,
    stage_number: int,
    error_message: str | None = None,
) -> None:
    """Write pipeline progress to JSON for dashboard consumption.

    Uses atomic write (tmp + rename) so readers never see partial data.
    Logs but does not raise on write failures to avoid disrupting the pipeline.
    """
    progress_path = Path(config.progress_file)
    # Per process: two overlapping runs (a scheduler firing over a manual
    # re-run, which LOG_FILE already anticipates) sharing one .tmp could
    # rename each other's half-written file into place.
    tmp_path = progress_path.with_name(f"{progress_path.name}.{os.getpid()}.tmp")
    data = {
        "status": status,
        "stage": stage,
        "stage_number": stage_number,
        "total_stages": TOTAL_STEPS,
        "updated_at": datetime.now(tz=UTC).isoformat(),
        "error_message": error_message,
    }
    try:
        tmp_path.write_text(json.dumps(data) + "\n")
        tmp_path.replace(progress_path)
    except OSError:
        logger.debug("Failed to write progress file %s", progress_path, exc_info=True)


@dataclass(slots=True)
class _ProgressReporter:
    """Track and persist the current PubMed pipeline stage."""

    config: PipelineConfig
    stage_index: int = 0
    finalized: bool = False
    # Set once the run's pipeline_runs row is written, so a failure after
    # that point (the notification, say) cannot add a second, failed, row
    # for a run that merged -- the export publishes the newest.
    run_recorded: bool = False
    # The recorder rides along with the progress file rather than being
    # driven separately: every call site already calls report(), so a
    # second "now record the step" call would be one more thing an edit
    # could forget at a single site with nothing failing.
    recorder: StepRecorder = field(default_factory=StepRecorder)

    def __post_init__(self) -> None:
        Path(self.config.progress_file).parent.mkdir(parents=True, exist_ok=True)

    def report(self, stage_index: int) -> None:
        """Advance to and persist a running stage."""
        self.stage_index = stage_index
        self.recorder.enter(stage_index)
        _write_progress(
            self.config,
            status="running",
            stage=STEP_KEYS[stage_index],
            stage_number=stage_index + 1,
        )

    def action(self, text: str) -> None:
        """Record something the current step did, for the run report."""
        self.recorder.action(text)

    def warn(self, warning: RunWarning) -> None:
        """Attach a non-fatal finding to the current step."""
        self.recorder.warn(warning)

    def steps(self) -> list[StepRecord]:
        """Every step in run order, for the run report."""
        return self.recorder.records()

    def finalize(
        self,
        *,
        status: ProgressStatus,
        stage_number: int | None = None,
        error_message: str | None = None,
    ) -> None:
        """Persist a terminal progress state."""
        _write_progress(
            self.config,
            status=status,
            stage=STEP_KEYS[self.stage_index],
            stage_number=(
                stage_number if stage_number is not None else self.stage_index + 1
            ),
            error_message=error_message,
        )
        self.finalized = True

    def fail(self, exc: BaseException) -> None:
        """Persist an interrupted or failed terminal state."""
        if isinstance(exc, (KeyboardInterrupt, asyncio.CancelledError)):
            error_message = f"Run was interrupted ({type(exc).__name__})"
        else:
            # Keep the tail, not the head: a traceback's last line carries the
            # exception type and message, while its first characters are the
            # header and the outermost frames. Truncating from the front drops
            # the error itself as soon as the absolute paths are long enough --
            # which is what happens in a git worktree, where this assertion
            # first failed.
            error_message = traceback.format_exc()[-500:]
        # The traceback stays in the progress file and the log, where a
        # maintainer wants it. classify() is what the dashboard reads: a
        # sentence naming what went wrong, with the tail as supporting
        # detail rather than as the headline. No subject: the failure is
        # rendered under the step it belongs to, and a step key is not a
        # PMID, a gene or a service -- as "(merging_database)" it put an
        # internal token in the headline of every failure.
        self.recorder.fail(classify(exc), index=self.stage_index)
        self.finalize(
            status="error",
            error_message=error_message,
        )

    def ensure_terminal_state(self) -> None:
        """Write a defensive failure state if no explicit final state exists."""
        if not self.finalized:
            self.finalize(
                status="error",
                error_message="Pipeline exited without finalizing progress",
            )


# --- Type definitions ---
class MetadataResult(TypedDict):
    """Result from metadata fetch."""

    doi: str | None


@dataclass(slots=True)
class RejectedGene:
    """A gene that failed validation, preserved for reporting."""

    gene: GeneEntry
    reasons: list[str]


class PaperProcessResult(TypedDict):
    """Result from processing a single paper."""

    genes: list[GeneEntry]
    rejected_genes: list[RejectedGene]
    fulltext: bool
    source: str
    text_truncated: bool


@dataclass(slots=True)
class PaperResult:
    """Result from processing a single paper with error handling."""

    pmid: str
    genes: list[GeneEntry] = field(default_factory=list)
    rejected_genes: list[RejectedGene] = field(default_factory=list)
    fulltext: bool = False
    # "unknown", not "none". "none" means *retrieval succeeded and found
    # no text*, which the run report counts as `noTextAvailable`; it used
    # to be the default, so every paper that died on an exception carried
    # it too and was counted and warned about twice -- once as failed and
    # once as having no text, with fulltext + abstractOnly + noTextAvailable
    # able to exceed processed.
    source: str = "unknown"
    # The paper was longer than `max_paper_text_chars`, so the model saw
    # only its first characters. The paper is still recorded as processed
    # -- re-fetching it would truncate it again -- which is exactly why
    # the report has to say so rather than leave it to a log line.
    text_truncated: bool = False
    error: str | None = None
    processing_time: float = 0.0
    pdf_parse_time: float = 0.0
    llm_time: float = 0.0
    validation_time: float = 0.0

    @property
    def succeeded(self) -> bool:
        return self.error is None


@dataclass(slots=True)
class ExtractionOutcome:
    """Validated extraction data and timings shared by all input modes."""

    genes: list[GeneEntry]
    rejected_genes: list[RejectedGene]
    extracted_count: int
    llm_time: float
    validation_time: float
    text_truncated: bool = False


async def _validate_genes(
    genes: list[GeneEntry],
    metrics: PipelineMetrics,
    config: PipelineConfig,
) -> tuple[list[GeneEntry], list[RejectedGene]]:
    """Validate genes concurrently against NCBI and return (valid, rejected) lists."""
    validated_genes: list[GeneEntry] = []
    rejected_genes: list[RejectedGene] = []
    results = await asyncio.gather(
        *(validate_gene_entry(gene, config=config) for gene in genes),
        return_exceptions=True,
    )

    # NCBI not answering says nothing about the gene, so it is not a
    # rejection: the paper fails and is retried on a later run, the way a
    # retrieval failure is. Rejecting it would record the paper as
    # processed with the gene missing, and it would never be seen again.
    for result in results:
        if isinstance(result, NcbiUnavailableError):
            raise result

    for gene, result in zip(genes, results, strict=True):
        # gather(return_exceptions=True) can yield BaseException (e.g. CancelledError),
        # not just Exception — narrow on the wider type so downstream attribute
        # access on the ValidationResult branch is type-safe.
        if isinstance(result, BaseException):
            logger.error(f"  Validation error for {gene.gene_symbol}: {result}")
            metrics.genes_rejected += 1
            rejected_genes.append(RejectedGene(gene=gene, reasons=[str(result)]))
        elif result.is_valid and result.normalized_data is not None:
            validated_genes.append(result.normalized_data)
            metrics.genes_validated += 1
        else:
            metrics.genes_rejected += 1
            logger.debug(f"  Gene rejected: {result.errors}")
            rejected_genes.append(RejectedGene(gene=gene, reasons=result.errors))

    return validated_genes, rejected_genes


_QUOTE_NOT_FOUND_REASON: Final[str] = "Quote not found in the paper"


def _quote_rejections(pmid: str) -> list[RejectedGene]:
    """The genes `require_verified_quotes` removed from *pmid*, as rejections.

    The gate runs inside extraction, so these genes never reach
    `_validate_genes` and were never made into `RejectedGene` records:
    the published report carried a count and no symbol, and
    `rejectedGenes` did not list them at all. They are listed here rather
    than counted into `genes_rejected`, which is the validation floor's
    number -- these were dropped before that floor scored anything, and
    the `quote_unverified` warning is what counts them.
    """
    rejections: list[RejectedGene] = []
    for gene in current_tally().dropped(pmid):
        # As `_extract_and_validate` does for the genes it keeps: the
        # published rejection has to name the paper the quote was
        # supposed to come from, whatever the extraction path set.
        gene.pmid = pmid
        rejections.append(RejectedGene(gene=gene, reasons=[_QUOTE_NOT_FOUND_REASON]))
    return rejections


def _filter_genes_by_confidence(
    genes: list[GeneEntry],
    metrics: PipelineMetrics,
    threshold: float,
) -> tuple[list[GeneEntry], list[RejectedGene]]:
    """Apply the local confidence check used when NCBI validation is skipped."""
    validated: list[GeneEntry] = []
    rejected: list[RejectedGene] = []
    for gene in genes:
        if gene.confidence < threshold:
            rejected.append(
                RejectedGene(
                    gene=gene,
                    reasons=[f"Low confidence: {gene.confidence:.2f} < {threshold}"],
                )
            )
            metrics.genes_rejected += 1
        else:
            validated.append(gene)
            metrics.genes_validated += 1
    return validated, rejected


async def _extract_and_validate(
    text: str,
    paper_id: str,
    metrics: PipelineMetrics,
    config: PipelineConfig,
    rate_limiter: AsyncRateLimiter | None,
    *,
    skip_validation: bool = False,
) -> ExtractionOutcome:
    """Run the LLM and the validation policy shared by all pipeline modes."""
    llm_start = time.monotonic()
    try:
        genes, token_usage = await extract_from_paper(
            text,
            paper_id,
            config=config,
            rate_limiter=rate_limiter,
        )
    except ExtractionFailedError as exc:
        if exc.token_usage is not None:
            metrics.token_usage += exc.token_usage
        raise
    llm_time = time.monotonic() - llm_start

    metrics.token_usage += token_usage
    for gene in genes:
        gene.pmid = paper_id

    validation_start = time.monotonic()
    if skip_validation:
        validated, rejected = _filter_genes_by_confidence(
            genes, metrics, config.confidence_threshold_update
        )
    else:
        validated, rejected = await _validate_genes(genes, metrics, config)
    # Counted once validation held. An NCBI outage fails the paper, which a
    # later run retries and counts; counting its genes here as well put
    # them in `extracted` with nothing on the validated or rejected side.
    metrics.genes_extracted += len(genes)

    # The quote gate's drops first, for the reason the insert floor's
    # holds come first in `_rejected_records`: the published list is
    # capped, these are always few and validation rejections are many.
    return ExtractionOutcome(
        genes=validated,
        rejected_genes=[*_quote_rejections(paper_id), *rejected],
        extracted_count=len(genes),
        llm_time=llm_time,
        validation_time=time.monotonic() - validation_start,
        text_truncated=paper_text_truncated(text, config.max_paper_text_chars),
    )


def _collect_successful_genes(results: list[PaperResult]) -> list[GeneEntry]:
    """Flatten genes from successful paper results."""
    return [gene for result in results if result.succeeded for gene in result.genes]


def _run_batch_validation(genes: list[GeneEntry]) -> list[str]:
    """Run warning-only batch checks and emit each warning consistently."""
    warnings = batch_validate(genes) if genes else []
    for warning in warnings:
        logger.warning(f"  Batch check: {warning}")
    return warnings


def _resolve_pdf_files(path: Path) -> tuple[Path, list[Path]]:
    """Resolve one PDF or a directory into its parent and sorted PDF files."""
    if path.is_file():
        if path.suffix.lower() != ".pdf":
            raise ValueError(f"Not a PDF file: {path}")
        return path.parent, [path]
    if not path.is_dir():
        raise FileNotFoundError(f"Path not found: {path}")

    # Case-insensitive, as the single-file branch above is: a scanner or
    # Windows export names them .PDF.
    pdf_files = sorted(p for p in path.iterdir() if p.suffix.lower() == ".pdf")
    if not pdf_files:
        raise ValueError(f"No .pdf files found in {path}")
    return path, pdf_files


def _load_pmids(path: Path) -> list[str]:
    """Load, validate, and order-deduplicate PMIDs from a text file."""
    if not path.exists():
        raise FileNotFoundError(f"PMID file not found: {path}")

    pmids: list[str] = []
    for line in path.read_text().splitlines():
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        try:
            pmids.append(validate_pmid(value))
        except ValueError:
            logger.warning(f"Skipping invalid PMID: {value!r}")

    if not (unique_pmids := list(dict.fromkeys(pmids))):
        raise ValueError(f"No valid PMIDs found in {path}")
    return unique_pmids


# --- Shared HTTP client for metadata ---
# AsyncHttpClientManager serialises lazy init under an asyncio.Lock so the
# first wave of concurrent paper-processing tasks doesn't each build (and
# leak) its own httpx.AsyncClient.
_metadata_client_manager = AsyncHttpClientManager(
    timeout=httpx.Timeout(30.0),
    limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
)


async def _get_metadata_client() -> httpx.AsyncClient:
    """Get or create shared HTTP client for metadata fetching."""
    return await _metadata_client_manager.get()


async def _close_metadata_client() -> None:
    """Close shared metadata HTTP client."""
    await _metadata_client_manager.close()


async def fetch_paper_metadata(pmid: str) -> MetadataResult:
    """Fetch DOI and other metadata for a PMID using NCBI efetch.

    Args:
        pmid: PubMed ID.

    Returns:
        MetadataResult with the paper DOI, when available.
    """
    pmid = validate_pmid(pmid)

    params: dict[str, str] = {"db": "pubmed", "id": pmid, "retmode": "xml"}

    try:
        client = await _get_metadata_client()
        resp = await ncbi_http.get_with_retry(
            client, NCBI_EFETCH_URL, params, context=f"efetch metadata {pmid}"
        )

        if resp is None:
            logger.warning(f"Metadata fetch got no answer for PMID {pmid}")
        elif resp.status_code != 200:
            logger.warning(f"Metadata fetch failed for PMID {pmid}: {resp.status_code}")
        else:
            root = etree.fromstring(resp.content, parser=SAFE_XML_PARSER)
            if root.tag != "PubmedArticleSet":
                # NCBI's maintenance page is a 200 whose body is HTML. The
                # DOI only steers Unpaywall, so this is not fatal, but it
                # is not "no DOI" either.
                logger.warning(
                    f"Metadata fetch for PMID {pmid} answered with a document "
                    f"that is not a PubMed record (<{root.tag}>)"
                )
                return {"doi": None}
            return {"doi": _own_doi(root)}

    except etree.XMLSyntaxError as e:
        logger.error(f"XML parsing failed for PMID {pmid}: {e}")

    return {"doi": None}


# The record's own DOI. Not `.//ArticleId[@IdType='doi']`: PubmedData
# carries the article's ArticleIdList and then a ReferenceList whose
# entries use the same element, so a record without a DOI of its own sent
# Unpaywall after the first paper it cites -- and the genes in that other
# paper's PDF were attributed to this PMID.
_OWN_DOI_PATHS: Final[tuple[str, ...]] = (
    ".//PubmedArticle/PubmedData/ArticleIdList/ArticleId[@IdType='doi']",
    ".//PubmedArticle/MedlineCitation/Article/ELocationID[@EIdType='doi']",
    ".//PubmedBookArticle/BookDocument/ArticleIdList/ArticleId[@IdType='doi']",
)


def _own_doi(root: Any) -> str | None:
    """The DOI a fetched record carries for itself, if any."""
    for path in _OWN_DOI_PATHS:
        element = root.find(path)
        if element is not None and isinstance(element.text, str) and element.text:
            return element.text.strip()
    return None


async def _record_and_notify(config: PipelineConfig, run_data: Any) -> None:
    """Record pipeline run to event log and send a notification.

    Offloads the blocking SQLite + Apprise work to a worker thread so the
    asyncio event loop isn't stalled during the final flush.
    """

    def _run() -> None:
        # The event log is a convenience file beside the run, and SQLite can
        # refuse it -- locked by an overlapping run, or on a read-only
        # filesystem. It sits after the pipeline_runs row and before
        # --export in the dispatcher, so letting it raise skipped the
        # notification and the export and exited by traceback while the
        # database had already moved.
        try:
            with EventLog(config.event_db_path) as event_log:
                event_log.record("pipeline_completed", run_data)
        except Exception:
            logger.error("Could not write the event log", exc_info=True)
        send_pipeline_notification(run_data, config)

    await asyncio.to_thread(_run)


async def _finalize_run(
    metrics: PipelineMetrics,
    run_data: PipelineRunData,
    run_mode: str,
    progress: _ProgressReporter | None = None,
) -> None:
    """Record run stats and the published report to the database.

    Notifications are handled separately by the caller (see ``main()``) so
    they can be coalesced across multiple pipelines in one invocation.

    The six summary columns stay as they were -- `read_pipeline_status()`
    and `data/pipeline_status.json` still read them, and the About page
    still degrades to that summary if the report is absent. The report
    column is additive.

    `run_recorded` is set from inside `record_pipeline_run`, the instant
    the INSERT returns, and not here afterwards: releasing the pooled
    connection is a further await, and a SIGTERM delivered there left the
    flag False, so `_record_failed_run` wrote a second, `failed` row for a
    run that had merged -- and `--export` publishes the newest row.
    """
    report = build_run_report(
        cast(dict[str, Any], run_data),
        steps=progress.steps() if progress is not None else [],
        apis=current_recorder().records(),
        run_mode=run_mode,
        provenance=current_tally(),
    )

    def mark_recorded() -> None:
        if progress is not None:
            progress.run_recorded = True

    await record_pipeline_run(
        run_timestamp=run_data["timestamp"],
        papers_processed=metrics.papers_processed,
        fulltext_retrieved=metrics.fulltext_retrieved,
        genes_extracted=metrics.genes_extracted,
        genes_validated=metrics.genes_validated,
        run_mode=run_mode,
        status=report.status,
        duration_seconds=report.duration_seconds,
        report=report.to_wire(),
        on_committed=mark_recorded,
    )


async def process_paper(
    pmid: str,
    metrics: PipelineMetrics,
    config: PipelineConfig,
    rate_limiter: AsyncRateLimiter | None = None,
) -> PaperProcessResult:
    """Process a single paper: fetch text, extract data, validate.

    Args:
        pmid: PubMed ID.
        metrics: Metrics accumulator.
        config: Pipeline configuration.
        rate_limiter: Optional rate limiter for LLM calls.

    Returns:
        PaperProcessResult with genes, fulltext flag, and source.
    """
    logger.info(f"Processing PMID {pmid}")

    # Get DOI for Unpaywall lookup
    metadata = await fetch_paper_metadata(pmid)
    doi = metadata.get("doi")

    # Retrieve full text or abstract
    text_result = await get_fulltext(pmid, doi)

    text = text_result.get("text")
    if not text:
        # Processed, with nothing to extract from: a stable fact about the
        # paper, recorded so it is not fetched again on every run.
        logger.warning(f"  No text available for PMID {pmid}, skipping")
        metrics.papers_processed += 1
        return {
            "genes": [],
            "rejected_genes": [],
            "fulltext": False,
            "source": "none",
            "text_truncated": False,
        }

    if text_result["fulltext"]:
        logger.info(f"  Retrieved full text from {text_result['source']}")
    else:
        logger.info("  Using abstract only")

    outcome = await _extract_and_validate(
        text,
        pmid,
        metrics,
        config,
        rate_limiter,
    )
    logger.info(f"  Extracted {outcome.extracted_count} genes")
    # Counted once the paper was processed, not once its text arrived:
    # papers_processed counts successes, so counting retrieval first let
    # three full texts and two extraction failures publish a 300% rate.
    # And counted *here*, per paper, like every other metric: adding the
    # total in bulk once every paper had returned meant a run that died in
    # step 3 published `processed: 0` beside the full texts, genes and
    # tokens of the papers that had finished.
    metrics.papers_processed += 1
    if text_result["fulltext"]:
        metrics.fulltext_retrieved += 1
    else:
        metrics.abstract_only += 1

    return {
        "genes": outcome.genes,
        "rejected_genes": outcome.rejected_genes,
        "fulltext": text_result["fulltext"],
        "source": text_result["source"],
        "text_truncated": outcome.text_truncated,
    }


async def process_paper_safe(
    pmid: str,
    metrics: PipelineMetrics,
    semaphore: asyncio.Semaphore,
    progress: dict[str, int],
    config: PipelineConfig,
    rate_limiter: AsyncRateLimiter | None = None,
) -> PaperResult:
    """Process a single paper with error handling and concurrency control.

    Args:
        pmid: PubMed ID.
        metrics: Metrics accumulator.
        semaphore: Semaphore for concurrency control.
        progress: Shared dict with 'current' counter and 'total' count.
        config: Pipeline configuration.
        rate_limiter: Optional rate limiter for LLM calls.

    Returns:
        PaperResult with processing outcome.
    """
    async with semaphore:
        progress["current"] += 1
        current = progress["current"]
        total = progress["total"]
        logger.info(f"[{current}/{total}] Starting PMID {pmid}")
        start_time = time.monotonic()
        try:
            result = await process_paper(
                pmid, metrics, config=config, rate_limiter=rate_limiter
            )
            return PaperResult(
                pmid=pmid,
                genes=result["genes"],
                rejected_genes=result["rejected_genes"],
                fulltext=result["fulltext"],
                source=result["source"],
                text_truncated=result["text_truncated"],
                processing_time=time.monotonic() - start_time,
            )
        except Exception as e:
            logger.exception(f"Error processing PMID {pmid}")
            return PaperResult(
                pmid=pmid,
                error=str(e),
                processing_time=time.monotonic() - start_time,
            )


async def process_papers_concurrently(
    pmids: list[str],
    metrics: PipelineMetrics,
    config: PipelineConfig,
    rate_limiter: AsyncRateLimiter | None = None,
    on_complete: Callable[[PaperResult, PipelineMetrics], None] | None = None,
) -> list[PaperResult]:
    """Process multiple papers concurrently with bounded concurrency.

    Args:
        pmids: List of PubMed IDs.
        metrics: Metrics accumulator for the run.
        config: Pipeline configuration.
        rate_limiter: Optional rate limiter for LLM calls.
        on_complete: Called with each *successful* paper and the metrics that
            paper alone produced, as soon as it finishes. This is the
            checkpoint's write hook: the run holds every result in memory
            until step 5, so without it a crash discards them all.

    Returns:
        List of PaperResult for each paper.
    """
    semaphore = asyncio.Semaphore(config.max_concurrent_papers)
    progress = {"current": 0, "total": len(pmids)}

    async def run_one(pmid: str) -> PaperResult:
        # A fresh accumulator per paper, folded into the run's when the paper
        # finishes: that is what gives *on_complete* the paper's own
        # contribution rather than the running total, which is what the
        # checkpoint has to store to be restorable one paper at a time.
        paper_metrics = PipelineMetrics()
        with paper_scope(pmid):
            result = await process_paper_safe(
                pmid,
                paper_metrics,
                semaphore,
                progress,
                config=config,
                rate_limiter=rate_limiter,
            )
        if result.succeeded:
            metrics.fold(paper_metrics)
        else:
            # A failed paper is retried by a later run, which counts its
            # genes then; validation may have counted some of them before
            # NCBI stopped answering, and those would reconcile with
            # nothing. Its spend is real now, and is counted now.
            metrics.token_usage += paper_metrics.token_usage
            # Its quotes follow its genes. Extraction records them before
            # validation runs, so without this the report published
            # "7 of 7 quotes found" over a funnel of 2 extracted genes.
            current_tally().discard(pmid)
        # Only successes. A failed paper is never written to pubmed_refs, so
        # the next run retries it; checkpointing one would instead restore the
        # failure on resume and retire the paper without ever extracting it.
        if on_complete is not None and result.succeeded:
            on_complete(result, paper_metrics)
        return result

    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(run_one(pmid)) for pmid in pmids]

    return [task.result() for task in tasks]


@dataclass(slots=True)
class _ProcessedBatch:
    """Paper-processing outputs needed by reporting and database merge stages."""

    results: list[PaperResult]
    warnings: list[str]

    @property
    def successful_results(self) -> list[PaperResult]:
        """Results safe to record as processed."""
        return [result for result in self.results if result.succeeded]

    @property
    def genes(self) -> list[GeneEntry]:
        """Accepted genes from successful papers."""
        return _collect_successful_genes(self.results)


def _count(n: int, singular: str, plural: str | None = None) -> str:
    """"1 paper", "3 papers": a count with a noun that agrees with it.

    Every warning title is reader-facing prose, and "1 gene(s)" is not.
    """
    return f"{n} {singular if n == 1 else (plural or singular + 's')}"


def _were(n: int) -> str:
    """The verb that agrees with `_count`."""
    return "was" if n == 1 else "were"


def _record_validation_actions(
    progress: _ProgressReporter,
    genes: list[GeneEntry],
    warnings: list[str],
) -> None:
    """Describe the batch-validation step, and warn on its findings.

    `batch_validate` flags things like a gene extracted from more than
    three papers. Those reached the log file only, so a run that flagged
    over-extraction still badged this step a clean pass -- and the
    `batch_validation` warning kind was unreachable.
    """
    progress.action(f"Cross-checked {len(genes)} genes against the rest of the batch")
    if warnings:
        progress.warn(
            RunWarning(
                kind="batch_validation",
                title=f"{_count(len(warnings), 'batch check')} flagged something",
                count=len(warnings),
                detail="; ".join(warnings[:5]),
            )
        )


def _record_merge_actions(
    progress: _ProgressReporter,
    result: MergeResult,
    recorded: int,
) -> None:
    """Describe the merge step, and warn on what it refused.

    The insert floor's holds were returned by `merge_gene_entries` and
    counted in the report, but nothing raised them here, so a run that
    refused new genes still showed this step as a clean pass.
    """
    progress.action(
        f"Inserted {result['inserted']} genes and updated {result['updated']}"
    )
    progress.action(f"Recorded {recorded} processed PMIDs")
    # isinstance-guarded for the same reason build_run_report is: a bare
    # AsyncMock in a test makes .get() return a coroutine, and len() on
    # one raises inside the reporting path rather than in the test's
    # subject.
    raw = result.get("held_below_insert_floor") if isinstance(result, dict) else None
    held = raw if isinstance(raw, list) else []
    if held:
        progress.warn(
            RunWarning(
                kind="genes_rejected",
                title=(
                    f"{_count(len(held), 'new gene')} {_were(len(held))} held "
                    "below the insert floor"
                ),
                count=len(held),
                subjects=[str(entry["gene_symbol"]) for entry in held],
            )
        )


def _record_processing_actions(
    progress: _ProgressReporter,
    results: list[PaperResult],
    metrics: PipelineMetrics,
) -> None:
    """Describe what the retrieve-and-extract step did, for the widget.

    Reader-facing prose, not a log excerpt: this is what expands under
    the step in the dashboard. The warnings are the same facts the run
    already counts -- they are raised here so the step's badge reflects
    them rather than showing a clean pass over real losses.
    """
    no_text = [r.pmid for r in results if r.succeeded and r.source == "none"]
    failed = [r.pmid for r in results if not r.succeeded]

    progress.action(
        f"Retrieved full text for {metrics.fulltext_retrieved}, "
        f"abstract only for {metrics.abstract_only}"
    )
    progress.action(
        f"Extracted {metrics.genes_extracted} genes, "
        f"of which {metrics.genes_validated} passed validation"
    )

    if no_text:
        progress.warn(
            RunWarning(
                kind="paper_retrieval_failed",
                title=f"{_count(len(no_text), 'paper')} had no retrievable text",
                count=len(no_text),
                subjects=no_text,
            )
        )
    if failed:
        progress.warn(
            RunWarning(
                kind="paper_retrieval_failed",
                title=f"{_count(len(failed), 'paper')} could not be processed",
                count=len(failed),
                subjects=failed,
            )
        )
    if metrics.genes_rejected:
        progress.warn(
            RunWarning(
                kind="genes_rejected",
                title=(
                    f"{_count(metrics.genes_rejected, 'gene')} did not clear "
                    "the validation floor"
                ),
                count=metrics.genes_rejected,
            )
        )
    # Removed inside extraction when `require_verified_quotes` is on, so
    # these genes reach no other count: `extracted` never saw them and
    # the validation gate never scored them. Read off the papers' own
    # rejections rather than off the run tally, so the warning can name
    # the genes -- a bare count told a reader something had been thrown
    # away without saying what -- and so a paper that later failed, whose
    # genes this run does not publish, cannot contribute to it.
    dropped_symbols = [
        rejection.gene.gene_symbol
        for result in results
        for rejection in result.rejected_genes
        if _QUOTE_NOT_FOUND_REASON in rejection.reasons
    ]
    if dropped_symbols:
        dropped = len(dropped_symbols)
        progress.warn(
            RunWarning(
                kind="quote_unverified",
                title=(
                    f"{_count(dropped, 'gene')} {_were(dropped)} dropped because "
                    "the quoted sentence was not found in the paper"
                ),
                count=dropped,
                subjects=dropped_symbols,
            )
        )
    # The model read the first `max_paper_text_chars` of these papers and
    # no further, and they are recorded as processed -- so a later run
    # will not revisit them and the tail, where the supplementary tables
    # are, is this dataset's loss. A log line was the only record.
    truncated_papers = [result.pmid for result in results if result.text_truncated]
    if truncated_papers:
        count = len(truncated_papers)
        progress.warn(
            RunWarning(
                kind="paper_truncated",
                title=(
                    f"{_count(count, 'paper')} {_were(count)} read only as far "
                    "as the text limit"
                ),
                count=count,
                detail=(
                    "PIPELINE_MAX_PAPER_TEXT_CHARS cut these papers short, so "
                    "anything after it -- supplementary tables, usually -- was "
                    "not read. They are recorded as processed and will not be "
                    "fetched again."
                ),
                subjects=truncated_papers,
            )
        )
    truncated = metrics.token_usage.truncated_responses
    if truncated:
        progress.warn(
            RunWarning(
                kind="model_truncated",
                title=(
                    f"{_count(truncated, 'model response')} {_were(truncated)} "
                    "cut short by the token ceiling"
                ),
                count=truncated,
            )
        )
    for row in current_recorder().trouble():
        progress.warn(
            RunWarning(
                kind="api_retried" if row.retries else "api_errored",
                title=(
                    f"{row.label} needed {_count(row.retries, 'retry', 'retries')}"
                    if row.retries
                    else f"{row.label} returned {_count(row.errors, 'error')}"
                ),
                count=row.retries or row.errors,
                subjects=[f"{row.method} {row.endpoint}"],
            )
        )


def _finalize_processed_batch(
    results: list[PaperResult],
    metrics: PipelineMetrics,
    progress: _ProgressReporter,
) -> _ProcessedBatch:
    """Log, validate, and package results shared by both extraction paths."""
    genes = _collect_successful_genes(results)
    logger.info(f"  Processed {metrics.papers_processed} papers")
    logger.info(f"  Validated: {metrics.genes_validated} genes")
    _record_processing_actions(progress, results, metrics)

    progress.report(3)
    warnings = _run_batch_validation(genes)
    _record_validation_actions(progress, genes, warnings)
    return _ProcessedBatch(results=results, warnings=warnings)


async def _discover_new_pmids(
    days_back: int,
    *,
    dry_run: bool,
    test_mode: bool,
    progress: _ProgressReporter,
) -> tuple[list[str], list[str]]:
    """Search PubMed and filter previously processed identifiers."""
    progress.report(0)
    logger.info(
        f"Step 1: Searching PubMed for recent {load_disease().short} genetic "
        "papers..."
    )

    def truncated(retrieved: int, total: int) -> None:
        # The search returns what it did retrieve -- a pagination failure,
        # a result cap, a window PubMed would not page through; the papers
        # it could not reach are this run's loss and the widget has to say
        # so rather than badge the step a clean pass.
        missing = total - retrieved
        progress.warn(
            RunWarning(
                kind="search_truncated",
                title=(
                    f"{missing} of {total} matching papers could not be "
                    "retrieved"
                ),
                count=missing,
                detail=(
                    "PubMed returned fewer results than it said it had; the "
                    "papers retrieved are processed, the rest are not in this "
                    "run. See the run log for which limit was reached."
                ),
            )
        )

    all_pmids = await search_recent_papers(days_back, on_truncated=truncated)
    logger.info(
        f"  Found {len(all_pmids)} papers matching "
        f"{load_disease().short} genetic criteria"
    )
    progress.action(
        f"Searched PubMed over the last {days_back} days: "
        f"{len(all_pmids)} papers matched"
    )
    if not all_pmids:
        return [], []

    progress.report(1)
    logger.info("Step 2: Filtering already-processed papers...")
    # Deduplication runs in every mode. --dry-run and --test-mode used to skip
    # it, which made the preview lie in both directions: --test-mode reported
    # the whole window as new, and --dry-run -- documented as "skip database
    # writes" -- re-extracted papers already in pubmed_refs at full price,
    # which is the opposite of a cheap rehearsal. Reading is not writing.
    try:
        existing_pmids: set[str] = await get_existing_pmids()
    except asyncpg.UndefinedTableError:
        # A missing table is expected only on the first run.
        logger.warning("  pubmed_refs table missing; treating as empty (first run?)")
        existing_pmids = set()
    except _PREVIEW_DB_FAILURES:
        # A preview is still required to work with no database at all; a live
        # run is not. Swallowing this on a live run would silently reprocess
        # the entire window, and the cost of that is the whole run.
        if not (dry_run or test_mode):
            raise
        logger.warning(
            "  Database unreachable; skipping PMID deduplication for this "
            "preview, so every paper in the window counts as new.",
            exc_info=True,
        )
        existing_pmids = set()

    new_pmids = filter_new_pmids(all_pmids, existing_pmids)
    logger.info(f"  {len(new_pmids)} new papers to process")
    already = len(all_pmids) - len(new_pmids)
    progress.action(
        f"{len(new_pmids)} papers are new; {already} were processed before"
    )
    return all_pmids, new_pmids


def _log_test_preview(pmids: list[str], config: PipelineConfig) -> None:
    """Log the bounded PMID preview used by test mode."""
    logger.info("Test mode enabled - skipping LLM extraction and database merge")
    logger.info(f"  Would process {len(pmids)} papers:")
    for pmid in pmids[: config.test_mode_preview_count]:
        logger.info(f"    PMID: {pmid}")
    if len(pmids) > config.test_mode_preview_count:
        remaining = len(pmids) - config.test_mode_preview_count
        logger.info(f"    ... and {remaining} more")


def _checkpoint_record(
    result: PaperResult,
    paper_metrics: PipelineMetrics,
    *,
    provenance: dict[str, int] | None = None,
) -> dict[str, Any]:
    """One completed paper, in the shape the checkpoint stores.

    Written out field by field rather than through `asdict`, which would
    leave the pydantic `GeneEntry` objects in place and produce something
    json.dumps cannot encode. `provenance` is the paper's share of the
    quote tally, which the report publishes as a rate and which a restored
    paper would otherwise fall out of.
    """
    return {
        "result": {
            "pmid": result.pmid,
            "genes": [gene.model_dump(mode="json") for gene in result.genes],
            "rejected_genes": [
                {
                    "gene": rejected.gene.model_dump(mode="json"),
                    "reasons": list(rejected.reasons),
                }
                for rejected in result.rejected_genes
            ],
            "fulltext": result.fulltext,
            "source": result.source,
            "text_truncated": result.text_truncated,
            "processing_time": result.processing_time,
            "pdf_parse_time": result.pdf_parse_time,
            "llm_time": result.llm_time,
            "validation_time": result.validation_time,
        },
        "metrics": asdict(paper_metrics),
        "provenance": provenance,
    }


def _restored_paper(
    record: dict[str, Any],
) -> tuple[PaperResult, PipelineMetrics, dict[str, int] | None]:
    """Rebuild one checkpointed paper, its metrics and its quote counts.

    Raises whatever the record's shape earns -- KeyError, TypeError or
    pydantic's ValidationError, which is a ValueError -- for the caller to
    turn into "extract this one again".
    """
    stored = record["result"]
    result = PaperResult(
        pmid=stored["pmid"],
        genes=[GeneEntry.model_validate(gene) for gene in stored.get("genes", [])],
        rejected_genes=[
            RejectedGene(
                gene=GeneEntry.model_validate(rejected["gene"]),
                reasons=list(rejected["reasons"]),
            )
            for rejected in stored.get("rejected_genes", [])
        ],
        fulltext=stored.get("fulltext", False),
        source=stored.get("source", "unknown"),
        text_truncated=stored.get("text_truncated", False),
        processing_time=stored.get("processing_time", 0.0),
        pdf_parse_time=stored.get("pdf_parse_time", 0.0),
        llm_time=stored.get("llm_time", 0.0),
        validation_time=stored.get("validation_time", 0.0),
    )
    stored_metrics = dict(record.get("metrics") or {})
    usage = TokenUsage(**(stored_metrics.pop("token_usage", None) or {}))
    # A checkpointed paper is a processed paper by definition. Files written
    # before `papers_processed` was counted per paper carry 0 here, because
    # the run added the total after the hook had already seen the paper.
    stored_metrics["papers_processed"] = 1
    provenance = record.get("provenance")
    return (
        result,
        PipelineMetrics(token_usage=usage, **stored_metrics),
        provenance if isinstance(provenance, dict) else None,
    )


def _restore_checkpoint(
    pmids: list[str],
    metrics: PipelineMetrics,
    config: PipelineConfig,
    progress: _ProgressReporter,
) -> tuple[list[PaperResult], list[str]]:
    """Split *pmids* into papers a previous run finished and papers still to do.

    Only papers in this run's window are restored, and only their metrics are
    folded in: a checkpoint written by a wider window can hold papers this run
    is not publishing, and counting those would inflate the report.
    """
    records = checkpoint.load(config.checkpoint_file, checkpoint.fingerprint(config))
    if not records:
        return [], list(pmids)

    available: dict[
        str, tuple[PaperResult, PipelineMetrics, dict[str, int] | None]
    ] = {}
    for record in records:
        try:
            result, paper_metrics, provenance = _restored_paper(record)
        except (KeyError, TypeError, ValueError) as exc:
            logger.warning("Dropping an unreadable checkpoint record: %s", exc)
            continue
        available[result.pmid] = (result, paper_metrics, provenance)

    restored: list[PaperResult] = []
    pending: list[str] = []
    for pmid in pmids:
        if pmid not in available:
            pending.append(pmid)
            continue
        result, paper_metrics, provenance = available[pmid]
        metrics.fold(paper_metrics)
        if provenance:
            # Replayed under the paper's scope, so a run that restores and
            # then checkpoints again keeps the attribution.
            with paper_scope(pmid):
                current_tally().record(
                    genes=provenance.get("genes", 0),
                    verbatim=provenance.get("verbatim", 0),
                    cited=provenance.get("cited", 0),
                    dropped_unverified=provenance.get("dropped_unverified", 0),
                )
        restored.append(result)

    if restored:
        logger.info(f"  Restored {len(restored)} papers from the checkpoint")
        # Named in the report because the restored papers' tokens are counted
        # here *and* in the failed report of the run that extracted them --
        # the two only read correctly together if this says so.
        progress.action(
            f"Restored {_count(len(restored), 'paper')} already extracted by "
            "an earlier run that did not finish; their token cost is counted "
            "in both runs"
        )
    return restored, pending


def _paper_finished_hook(
    config: PipelineConfig,
    collected: list[PaperResult],
    *,
    checkpointing: bool,
) -> Callable[[PaperResult, PipelineMetrics], None]:
    """Hand each finished paper to the run, then checkpoint it.

    *collected* is owned by ``run_pipeline`` and is what a failed run
    reports when step 3 never returned. ``batch`` is assigned only when
    ``_process_new_pmids`` returns, so a cancellation inside it -- SIGTERM,
    Ctrl+C, an unexpected error propagating out of the TaskGroup --
    published the metrics of every paper that had finished beside an empty
    ``papersDetail``, an empty ``acceptedGenes`` and ``failed: 0``, and the
    funnel no longer added up.

    The collection happens whether or not the run is checkpointing: a dry
    run has not earned the right to write a real run's saved work, but its
    papers are still what its report is about.
    """
    run_fingerprint = checkpoint.fingerprint(config)

    def on_complete(result: PaperResult, paper_metrics: PipelineMetrics) -> None:
        collected.append(result)
        if not checkpointing:
            return
        # Best effort: a checkpoint that cannot be written leaves the run
        # exactly as exposed as it was before there was one, which is not
        # a reason to end it.
        try:
            checkpoint.append(
                config.checkpoint_file,
                run_fingerprint,
                _checkpoint_record(
                    result,
                    paper_metrics,
                    provenance=current_tally().paper(result.pmid),
                ),
            )
        except OSError:
            logger.warning(
                "Could not checkpoint PMID %s; a crash will lose it",
                result.pmid,
                exc_info=True,
            )

    return on_complete


def _in_request_order(
    pmids: Sequence[str], results: list[PaperResult]
) -> list[PaperResult]:
    """Order *results* by the run's PMID list, whatever order they finished in.

    The merge keeps the *first* occurrence of a gene -- its quote, its
    confidence, its protein -- and inserts rows in the order it grouped
    them, so this order reaches `source_quote`, `confidence` and the `id`s
    `data/table1.json` is ordered by. Restored papers used to be prepended
    to the papers still pending, so a run resumed from a checkpoint merged
    the same two papers in the opposite order and published a different
    quote and a different row order than the same run without the crash.
    The batch path assembled its results by arrival stage for the same
    reason, so both paths order here rather than only the resumed one.

    A result whose PMID is not in *pmids* keeps its place at the end;
    nothing produces one today, and inventing a position for it would be
    the wrong way to find out.
    """
    position = {pmid: index for index, pmid in enumerate(pmids)}
    return sorted(results, key=lambda r: position.get(r.pmid, len(position)))


async def _process_new_pmids(
    pmids: list[str],
    metrics: PipelineMetrics,
    config: PipelineConfig,
    rate_limiter: AsyncRateLimiter,
    progress: _ProgressReporter,
    *,
    use_checkpoint: bool = True,
    collected: list[PaperResult] | None = None,
) -> _ProcessedBatch:
    """Process, flatten, and batch-validate a set of new papers."""
    progress.report(2)
    logger.info("Step 3: Processing papers concurrently...")

    collected = [] if collected is None else collected
    restored: list[PaperResult] = []
    pending = list(pmids)
    if use_checkpoint:
        restored, pending = _restore_checkpoint(pmids, metrics, config, progress)
    collected.extend(restored)

    results = restored + await process_papers_concurrently(
        pending,
        metrics,
        config=config,
        rate_limiter=rate_limiter,
        on_complete=_paper_finished_hook(
            config, collected, checkpointing=use_checkpoint
        ),
    )
    return _finalize_processed_batch(
        _in_request_order(pmids, results), metrics, progress
    )


async def _fetch_paper_text_for_batch(
    pmid: str, semaphore: asyncio.Semaphore
) -> tuple[str, bool, str]:
    """Fetch one paper's text ahead of Batch API submission (no LLM call)."""
    async with semaphore:
        metadata = await fetch_paper_metadata(pmid)
        text_result = await get_fulltext(pmid, metadata.get("doi"))
        return (
            text_result.get("text") or "",
            text_result["fulltext"],
            text_result["source"],
        )


async def _validate_batch_paper(
    pmid: str,
    genes: list[GeneEntry],
    text_meta: tuple[bool, str, bool],
    metrics: PipelineMetrics,
    config: PipelineConfig,
) -> PaperResult:
    """Validate one batch paper's genes with the streaming path's isolation.

    An NCBI outage during validation raises rather than rejecting genes
    (see ``_validate_genes``); caught here per paper so it fails that
    paper alone instead of the whole run after the batch was paid for.
    """
    fulltext, source, truncated = text_meta
    try:
        validated, rejected = await _validate_genes(genes, metrics, config)
    except Exception as exc:
        logger.exception(f"Error validating PMID {pmid}")
        return PaperResult(pmid=pmid, error=str(exc))
    # As in process_paper: the paper, its retrieval and its extracted genes
    # count once the paper was processed, and per paper.
    metrics.papers_processed += 1
    metrics.genes_extracted += len(genes)
    if fulltext:
        metrics.fulltext_retrieved += 1
    else:
        metrics.abstract_only += 1
    return PaperResult(
        pmid=pmid,
        genes=validated,
        rejected_genes=[*_quote_rejections(pmid), *rejected],
        fulltext=fulltext,
        source=source,
        text_truncated=truncated,
    )


async def _process_new_pmids_via_batch(
    pmids: list[str],
    metrics: PipelineMetrics,
    config: PipelineConfig,
    progress: _ProgressReporter,
    *,
    use_checkpoint: bool = True,
    collected: list[PaperResult] | None = None,
) -> _ProcessedBatch:
    """Fetch every paper's text, then extract genes in one Batch API call.

    Mirrors the streaming default's isolation and retry conventions
    (``process_paper`` / ``process_paper_safe``): a fetch exception for one
    paper is caught and marked failed rather than aborting every other
    paper's already-fetched text and submitting nothing, and a paper with
    no retrievable text is recorded as processed with zero genes — a
    stable fact, not worth retrying forever — exactly like ``--pubmed``
    without ``--batch``. Only a batch entry that itself failed or could not
    be parsed (logged and skipped inside ``submit_and_collect``) is marked
    failed and retried.
    """
    progress.report(2)
    logger.info("Step 3: Fetching paper text for batch submission...")

    # The batch's results arrive together, but they are paid for the moment
    # they do, and validation and the merge still lie between them and
    # `pubmed_refs`. Each paper is checkpointed as its validation finishes,
    # exactly as the streaming path does, so a crash at either step restores
    # the batch rather than resubmitting it. The run's tokens are one batch
    # figure, not per paper, so a restored batch paper carries none; the
    # crashed run's own failed report holds the spend.
    collected = [] if collected is None else collected
    restored: list[PaperResult] = []
    pending = list(pmids)
    if use_checkpoint:
        restored, pending = _restore_checkpoint(pmids, metrics, config, progress)
    collected.extend(restored)
    on_complete = _paper_finished_hook(config, collected, checkpointing=use_checkpoint)

    semaphore = asyncio.Semaphore(config.max_concurrent_papers)
    fetched = await asyncio.gather(
        *(_fetch_paper_text_for_batch(pmid, semaphore) for pmid in pending),
        return_exceptions=True,
    )

    papers: dict[str, str] = {}
    text_meta: dict[str, tuple[bool, str, bool]] = {}
    for pmid, outcome in zip(pending, fetched, strict=True):
        if isinstance(outcome, BaseException):
            # One paper's fetch failure must not abort the whole batch —
            # the same isolation process_paper_safe gives the streaming
            # path. Retryable: not recorded as processed, so it goes to the
            # run's list directly rather than through the checkpoint hook.
            logger.error(f"  Error fetching text for PMID {pmid}: {outcome}")
            collected.append(PaperResult(pmid=pmid, error=str(outcome)))
            continue
        text, fulltext, source = outcome
        if not text:
            # Matches --pubmed's streaming default (process_paper): no
            # retrievable text is a stable fact, not a transient failure,
            # so it is recorded as processed rather than retried forever.
            logger.warning(f"  No text available for PMID {pmid}")
            paper_metrics = PipelineMetrics(papers_processed=1)
            metrics.fold(paper_metrics)
            on_complete(
                PaperResult(pmid=pmid, fulltext=False, source="none"), paper_metrics
            )
            continue
        papers[pmid] = text
        text_meta[pmid] = (
            fulltext,
            source,
            paper_text_truncated(text, config.max_paper_text_chars),
        )

    logger.info(f"  Submitting {len(papers)} papers to the Batch API...")
    batch_usage = TokenUsage()
    genes_by_pmid = (
        await submit_and_collect(papers, config, usage=batch_usage) if papers else {}
    )
    metrics.token_usage += batch_usage

    # A pmid absent from genes_by_pmid (vs. present with an empty list) is
    # how results_by_custom_id signals a batch entry that failed or could
    # not be parsed — see pipeline.batch_extraction. Treat it as a failure
    # so the PMID is not recorded as processed and gets retried next run,
    # instead of being silently indistinguishable from "zero genes found".
    extracted_pmids = [pmid for pmid in papers if pmid in genes_by_pmid]

    async def validate_one(pmid: str) -> None:
        # Its own accumulator, as `process_papers_concurrently` gives each
        # paper: the checkpoint stores what this paper contributed, and a
        # paper that failed validation contributes nothing -- the run that
        # retries it counts its genes.
        paper_metrics = PipelineMetrics()
        result = await _validate_batch_paper(
            pmid, genes_by_pmid[pmid], text_meta[pmid], paper_metrics, config
        )
        if result.succeeded:
            metrics.fold(paper_metrics)
            on_complete(result, paper_metrics)
        else:
            # As on the streaming path: the paper is retried, so its
            # quotes are the retrying run's to count, not this one's --
            # and never checkpointed, but still the run's to report, as
            # the fetch failures above are.
            current_tally().discard(pmid)
            collected.append(result)

    await asyncio.gather(*(validate_one(pmid) for pmid in extracted_pmids))
    for pmid in papers:
        if pmid not in genes_by_pmid:
            logger.warning(f"  No batch result for PMID {pmid}, marking as failed")
            collected.append(
                PaperResult(pmid=pmid, error="no result returned by the batch")
            )

    # The same record the streaming path makes. Without it a --batch run
    # published step 3 with no actions, no warnings and a green badge over
    # papers the batch returned nothing for or validation refused.
    return _finalize_processed_batch(
        _in_request_order(pmids, collected), metrics, progress
    )


async def _merge_processed_batch(
    batch: _ProcessedBatch,
    progress: _ProgressReporter,
    config: PipelineConfig,
    *,
    on_merged: Callable[[MergeResult], None] | None = None,
) -> MergeResult:
    """Merge accepted genes and record successfully processed PMIDs.

    Always returns counts, never None. ``None`` is the report's sentinel for
    *dry run*, so returning it for a real run that merged nothing -- every
    gene rejected by the confidence gate, say -- made the summary claim "no
    database writes" while this function was recording processed PMIDs.
    ``merge_gene_entries`` already short-circuits an empty sequence to
    zeroed counts before it opens a connection, so calling it
    unconditionally costs nothing.

    *on_merged* is called with those counts the moment
    ``merge_gene_entries`` returns, before ``record_processed_pmids_batch``
    opens its own transaction. The merge commits in a transaction of its
    own, so a failure anywhere after it -- the PMID records, the checkpoint
    prune, the report -- leaves rows in ``genes`` that the run has to own;
    returning the counts only at the end meant such a failure published
    ``database: null`` and moved the insert-floor holds into the accepted
    list while ``--export`` shipped the merged rows.
    """
    progress.report(4)
    logger.info("Step 4: Merging validated data into database...")
    await reset_gene_sequence()

    # The run's config, not a fresh PipelineConfig(): the report names
    # this config's insert floor, so the merge has to apply the same one.
    gene_result = await merge_gene_entries(batch.genes, config)
    if on_merged is not None:
        on_merged(gene_result)
    logger.info(
        f"  Genes: {gene_result['inserted']} inserted, "
        f"{gene_result['updated']} updated"
    )

    pmid_records = [
        (result.pmid, result.fulltext, result.source, len(result.genes))
        for result in batch.successful_results
    ]
    recorded = await record_processed_pmids_batch(pmid_records)
    logger.info(f"  Recorded {recorded} processed PMIDs")
    _record_merge_actions(progress, gene_result, recorded)
    progress.report(5)
    return gene_result


async def _record_failed_run(
    metrics: PipelineMetrics,
    progress: _ProgressReporter,
    *,
    dry_run: bool,
    started_at: float,
    config: PipelineConfig,
    use_batch_api: bool = False,
    batch: _ProcessedBatch | None = None,
    partial_results: list[PaperResult] | None = None,
    gene_result: MergeResult | None = None,
    days_back: int = DEFAULT_DAYS_BACK,
    total_pmids_found: int | None = None,
    new_pmids_count: int = 0,
) -> None:
    """Persist a report for a run that did not finish.

    `_finalize_run` sits on the success path, so a failed run wrote no
    `pipeline_runs` row at all: `status: "failed"`, every classified
    `RunError`, and the whole error half of the dashboard were computed
    and thrown away, while the About page went on showing a green badge
    dated to the last run that *had* succeeded.

    The report is built by `build_run_data`, exactly as a completed run's
    is, from whatever the run had in hand: a failure at the merge has every
    paper's result in *batch*, and publishing `failed: 0` with empty paper
    lists beside step 3's own "3 papers could not be processed" was two
    answers to one question on the same document.

    Two of those are what the run had in hand *before* step 3 or step 4
    returned. *partial_results* is every paper that finished before a
    cancellation inside step 3, which is where the papers of a run stopped
    by SIGTERM live -- `batch` is assigned only when step 3 returns, so
    without them the report carried the finished papers' metrics beside
    empty lists. *gene_result* is the merge's counts, reported the moment
    `merge_gene_entries` commits: a failure after that point publishes rows
    `--export` then ships, so `database: null` claimed the run wrote
    nothing and the insert-floor holds it names moved silently into
    `acceptedGenes`.

    Best-effort by construction. The database is often the thing that
    just failed, and an exception raised here would replace the real one
    on its way up -- so anything this raises is logged and swallowed.
    """
    # A dry or test-mode run touches no database, and once the run's own
    # row is written a later failure (the notification) must not add a
    # second one.
    if dry_run or progress.run_recorded:
        return
    try:
        steps = progress.steps()
        # What is known here is recorded: the run's wall-clock and its
        # token spend were zeroed before, so a run that extracted for an
        # hour and died at the merge published 0 s and $0.00.
        run_data = build_run_data(
            metrics=metrics,
            results=(
                batch.results if batch is not None else list(partial_results or [])
            ),
            gene_result=gene_result,
            batch_warnings=batch.warnings if batch is not None else [],
            config=config,
            days_back=days_back,
            dry_run=False,
            total_pmids_found=total_pmids_found or 0,
            new_pmids_count=new_pmids_count,
            total_duration=time.monotonic() - started_at,
            use_batch_api=use_batch_api,
        )
        if total_pmids_found is None:
            # The search never answered, so there is no count to publish;
            # zeros would read as an empty window.
            del run_data["search"]
        report = build_run_report(
            cast(dict[str, Any], run_data),
            steps=steps,
            apis=current_recorder().records(),
            run_mode="standard",
            provenance=current_tally(),
        )
        await record_pipeline_run(
            run_timestamp=run_data["timestamp"],
            papers_processed=metrics.papers_processed,
            fulltext_retrieved=metrics.fulltext_retrieved,
            genes_extracted=metrics.genes_extracted,
            genes_validated=metrics.genes_validated,
            run_mode="standard",
            status=report.status,
            duration_seconds=report.duration_seconds,
            report=report.to_wire(),
        )
    except Exception:
        logger.warning("Could not record the failed run", exc_info=True)


async def _complete_pubmed_run(
    metrics: PipelineMetrics,
    run_data: PipelineRunData,
    config: PipelineConfig,
    progress: _ProgressReporter,
    *,
    dry_run: bool,
    manage_lifecycle: bool,
) -> None:
    """Persist live-run stats, notify, and finalize live-run progress."""
    if not dry_run:
        await _finalize_run(metrics, run_data, "standard", progress)
    if manage_lifecycle:
        await _record_and_notify(config, run_data)
    if not dry_run:
        progress.finalize(
            status="completed",
            stage_number=TOTAL_STEPS,
        )


async def _close_extraction_resources(
    *,
    retrieval_clients: bool,
    database: bool,
) -> None:
    """Close the shared clients used by an extraction run."""
    if retrieval_clients:
        await _close_metadata_client()
        await europepmc.close_http_client()
        await close_http_client()
    await close_validation_client()
    await close_async_client()
    if database:
        await Database.close()
    clear_gene_cache()


def _emit_report(run_data: PipelineRunData) -> None:
    """Write and print a pipeline report consistently across run modes."""
    report_path = write_comprehensive_report(run_data, LOG_DIR / "json")
    logger.info(f"JSON report written to: {report_path}")
    print_rich_summary(run_data)


def _build_pubmed_report(
    metrics: PipelineMetrics,
    batch: _ProcessedBatch,
    gene_result: MergeResult | None,
    config: PipelineConfig,
    *,
    days_back: int,
    dry_run: bool,
    total_pmids_found: int,
    started_at: float,
    use_batch_api: bool = False,
) -> PipelineRunData:
    """Build, persist, and print a standard PubMed run report."""
    run_data = build_run_data(
        metrics=metrics,
        results=batch.results,
        gene_result=gene_result,
        batch_warnings=batch.warnings,
        config=config,
        days_back=days_back,
        dry_run=dry_run,
        total_pmids_found=total_pmids_found,
        new_pmids_count=len(batch.results),
        total_duration=time.monotonic() - started_at,
        use_batch_api=use_batch_api,
    )
    _emit_report(run_data)
    return run_data


async def _process_local_pdf_file(
    pdf_path: Path,
    metrics: PipelineMetrics,
    config: PipelineConfig,
    rate_limiter: AsyncRateLimiter,
    *,
    skip_validation: bool,
) -> PaperResult:
    """Parse and process one local PDF with per-step timings."""
    file_id = pdf_path.stem
    started_at = time.monotonic()
    try:
        parse_started_at = time.monotonic()
        text = await asyncio.to_thread(parse_local_pdf, pdf_path)
        parse_time = time.monotonic() - parse_started_at
        if not text:
            logger.warning(f"  No text extracted from {pdf_path.name}")
            return PaperResult(
                pmid=file_id,
                error="empty or corrupt PDF",
                processing_time=time.monotonic() - started_at,
                pdf_parse_time=parse_time,
            )

        outcome = await _extract_and_validate(
            text,
            file_id,
            metrics,
            config,
            rate_limiter,
            skip_validation=skip_validation,
        )
        logger.info(f"  Extracted {outcome.extracted_count} genes from {pdf_path.name}")
        metrics.papers_processed += 1
        metrics.fulltext_retrieved += 1
        return PaperResult(
            pmid=file_id,
            genes=outcome.genes,
            rejected_genes=outcome.rejected_genes,
            fulltext=True,
            source="local_pdf",
            text_truncated=outcome.text_truncated,
            processing_time=time.monotonic() - started_at,
            pdf_parse_time=parse_time,
            llm_time=outcome.llm_time,
            validation_time=outcome.validation_time,
        )
    except ImportError:
        # parse_pdf_bytes re-raises this deliberately: Docling is a hard
        # requirement, so a failed import is a broken install and not a bad
        # PDF. Every file in the directory would fail it, so recording one
        # per-file error apiece would report a broken environment as a
        # corpus of unreadable papers.
        raise
    except Exception as exc:
        logger.exception(f"Error processing {pdf_path.name}")
        return PaperResult(
            pmid=file_id,
            error=str(exc),
            processing_time=time.monotonic() - started_at,
        )


async def _process_pmid_item(
    pmid: str,
    metrics: PipelineMetrics,
    config: PipelineConfig,
    rate_limiter: AsyncRateLimiter,
    *,
    skip_validation: bool,
) -> PaperResult:
    """Fetch and process one PMID for the offline PMID-list mode."""
    started_at = time.monotonic()
    try:
        metadata = await fetch_paper_metadata(pmid)
        text_result = await get_fulltext(pmid, metadata.get("doi"))
        text = text_result.get("text")
        if not text:
            # Recorded as processed with source "none", exactly as the
            # streaming and batch paths record it. No retrievable text is
            # a stable fact about the paper rather than a transient
            # failure, and until this agreed with them `papers.failed`
            # meant two different things depending on which mode had run.
            # `papers.noTextAvailable` is what counts the condition.
            logger.warning(f"  No text available for PMID {pmid}")
            metrics.papers_processed += 1
            return PaperResult(
                pmid=pmid,
                fulltext=False,
                source="none",
                processing_time=time.monotonic() - started_at,
            )

        is_fulltext = text_result["fulltext"]
        source = text_result["source"]
        logger.info(
            f"  Retrieved full text from {source}"
            if is_fulltext
            else "  Using abstract only"
        )
        outcome = await _extract_and_validate(
            text,
            pmid,
            metrics,
            config,
            rate_limiter,
            skip_validation=skip_validation,
        )
        logger.info(f"  Extracted {outcome.extracted_count} genes")

        if is_fulltext:
            metrics.fulltext_retrieved += 1
        else:
            metrics.abstract_only += 1
        metrics.papers_processed += 1
        return PaperResult(
            pmid=pmid,
            genes=outcome.genes,
            rejected_genes=outcome.rejected_genes,
            fulltext=is_fulltext,
            source=source,
            text_truncated=outcome.text_truncated,
            processing_time=time.monotonic() - started_at,
            llm_time=outcome.llm_time,
            validation_time=outcome.validation_time,
        )
    except Exception as exc:
        logger.exception(f"Error processing PMID {pmid}")
        return PaperResult(
            pmid=pmid,
            error=str(exc),
            processing_time=time.monotonic() - started_at,
        )


def _install_termination_handlers(
    task: asyncio.Task[Any],
) -> tuple[asyncio.AbstractEventLoop, list[int]]:
    """Install supported SIGTERM/SIGHUP handlers that cancel *task*."""
    loop = asyncio.get_running_loop()
    signals = [signal.SIGTERM]
    if hasattr(signal, "SIGHUP"):
        signals.append(signal.SIGHUP)

    def _cancel(sig: int) -> None:
        logger.warning("Received signal %s; cancelling pipeline run", sig)
        task.cancel()

    installed: list[int] = []
    for sig in signals:
        try:
            loop.add_signal_handler(sig, _cancel, sig)
        except NotImplementedError, RuntimeError, ValueError:
            continue
        installed.append(sig)
    return loop, installed


def _remove_signal_handlers(
    loop: asyncio.AbstractEventLoop, signals: list[int]
) -> None:
    """Remove any termination handlers installed for this run."""
    for sig in signals:
        with contextlib.suppress(NotImplementedError, ValueError):
            loop.remove_signal_handler(sig)


async def run_pipeline(
    days_back: int = DEFAULT_DAYS_BACK,
    dry_run: bool = False,
    test_mode: bool = False,
    use_batch_api: bool = False,
    config: PipelineConfig | None = None,
    manage_lifecycle: bool = True,
) -> tuple[PipelineMetrics, PipelineRunData | None]:
    """Run the PubMed gene extraction pipeline.

    Args:
        days_back: Number of days to look back (1-3650).
        dry_run: If True, skip database writes.
        test_mode: If True, skip LLM extraction.
        use_batch_api: If True, extract via one Batch API submission at half
            price instead of concurrent streaming calls. Results usually
            arrive within an hour, so this trades latency (free here — the
            pipeline runs offline and unattended) for cost.
        config: Pipeline configuration (uses defaults if None).
        manage_lifecycle: When True (default, for direct callers and tests),
            this function sends its own completion notification. When False
            (set by the ``main()`` dispatcher for combined runs), notifications
            are skipped so the dispatcher can coalesce them across pipelines.

    Returns:
        A tuple of (PipelineMetrics, run_data). ``run_data`` is ``None`` on
        early exits where no pipeline summary is built (no papers found, all
        PMIDs already processed, test-mode preview).

    Raises:
        ValueError: If days_back is out of valid range.
    """
    config = config or PipelineConfig()

    # Input validation
    if not config.min_days_back <= days_back <= config.max_days_back:
        raise ValueError(
            f"days_back must be between {config.min_days_back} "
            f"and {config.max_days_back}, got {days_back}"
        )

    metrics = PipelineMetrics()
    # A fresh inventory per run: main() can dispatch several pipelines in
    # one invocation, and without this the second would report the
    # first's API traffic as its own. The quote tally is per-run for the
    # same reason.
    reset_recorder()
    reset_tally()

    # Set up database config
    Database.set_config(config)

    # Eagerly initialize async locks/semaphores (safe under free-threading)
    init_validation_state(config)
    # Set up rate limiter
    rate_limiter = AsyncRateLimiter(rpm=config.rpm_limit, tpm=config.tpm_limit)

    pipeline_start_time = time.monotonic()

    logger.info(
        f"Starting {load_disease().short} Dashboard pipeline "
        f"(looking back {days_back} days)"
    )
    logger.info(
        f"Config: model={config.llm_model}, "
        f"concurrency={config.max_concurrent_papers}, "
        f"RPM={config.rpm_limit}, TPM={config.tpm_limit}"
    )

    progress = _ProgressReporter(config)

    # Convert SIGTERM/SIGHUP into task cancellation so the except/finally
    # blocks below can write a terminal progress state. SIGINT is left to
    # asyncio's default handling (which raises KeyboardInterrupt).
    current_task = asyncio.current_task()
    assert current_task is not None  # always set inside `async def`
    loop, installed_signals = _install_termination_handlers(current_task)

    # What a failed run can still report: the search counts once step 1
    # has answered, every paper's result once step 3 has -- and, for a run
    # that never gets that far, each paper as it finishes. `gene_result`
    # arrives from inside step 4, because the merge commits before the run
    # is anywhere near done with it.
    all_pmids: list[str] | None = None
    new_pmids: list[str] = []
    batch: _ProcessedBatch | None = None
    processed_so_far: list[PaperResult] = []
    gene_result: MergeResult | None = None

    def _remember_merge(merged: MergeResult) -> None:
        nonlocal gene_result
        gene_result = merged

    try:
        all_pmids, new_pmids = await _discover_new_pmids(
            days_back,
            dry_run=dry_run,
            test_mode=test_mode,
            progress=progress,
        )
        if not all_pmids:
            logger.info("No new papers found. Pipeline complete.")
            progress.finalize(
                status="completed",
            )
            return metrics, None

        if not new_pmids:
            logger.info("All papers already processed. Pipeline complete.")
            progress.finalize(
                status="completed",
            )
            return metrics, None

        # Test mode: skip LLM extraction and database merge
        if test_mode:
            _log_test_preview(new_pmids, config)
            progress.finalize(
                status="completed",
            )
            return metrics, None

        if use_batch_api:
            batch = await _process_new_pmids_via_batch(
                new_pmids,
                metrics,
                config,
                progress,
                use_checkpoint=not dry_run,
                collected=processed_so_far,
            )
        else:
            batch = await _process_new_pmids(
                new_pmids,
                metrics,
                config,
                rate_limiter,
                progress,
                # A dry run merges nothing, so it never earns the right to
                # clear a real run's saved work -- and leaving its own behind
                # would let it be restored by a run that never paid for it.
                use_checkpoint=not dry_run,
                collected=processed_so_far,
            )
        if dry_run:
            logger.info("Dry run mode - skipping database merge")
            progress.finalize(
                status="completed",
            )
        else:
            gene_result = await _merge_processed_batch(
                batch, progress, config, on_merged=_remember_merge
            )
            # pubmed_refs is the durable record for these papers now, so the
            # checkpoint has nothing left to protect *for them*. Papers it
            # holds outside this run's window were paid for by a wider run
            # and stay until that run merges them.
            checkpoint.remove(
                config.checkpoint_file,
                {result.pmid for result in batch.successful_results},
            )

        run_data = _build_pubmed_report(
            metrics,
            batch,
            gene_result,
            config,
            days_back=days_back,
            dry_run=dry_run,
            total_pmids_found=len(all_pmids),
            started_at=pipeline_start_time,
            use_batch_api=use_batch_api,
        )

        await _complete_pubmed_run(
            metrics,
            run_data,
            config,
            progress,
            dry_run=dry_run,
            manage_lifecycle=manage_lifecycle,
        )

        return metrics, run_data

    except BaseException as exc:
        # Include cancellation and Ctrl+C so they also write a terminal state.
        progress.fail(exc)
        await _record_failed_run(
            metrics,
            progress,
            dry_run=dry_run or test_mode,
            started_at=pipeline_start_time,
            config=config,
            use_batch_api=use_batch_api,
            batch=batch,
            partial_results=processed_so_far,
            gene_result=gene_result,
            days_back=days_back,
            total_pmids_found=None if all_pmids is None else len(all_pmids),
            new_pmids_count=len(new_pmids),
        )
        raise

    finally:
        progress.ensure_terminal_state()
        _remove_signal_handlers(loop, installed_signals)

        # Cleanup shared resources used only by this pipeline. The DB pool
        # is kept open for subsequent pipelines when the dispatcher is
        # managing the lifecycle — it closes the pool itself after all
        # selected pipelines have run.
        await _close_extraction_resources(
            retrieval_clients=True,
            database=manage_lifecycle,
        )


async def _process_offline_items[T](
    items: Sequence[T],
    *,
    concurrency: int,
    describe: Callable[[T], str],
    process: Callable[[T], Awaitable[PaperResult]],
) -> list[PaperResult]:
    """Process an offline input set concurrently while preserving its order."""
    semaphore = asyncio.Semaphore(concurrency)

    async def run_one(index: int, item: T) -> PaperResult:
        async with semaphore:
            logger.info(f"[{index}/{len(items)}] Processing {describe(item)}")
            return await process(item)

    async with asyncio.TaskGroup() as task_group:
        tasks = [
            task_group.create_task(run_one(index, item))
            for index, item in enumerate(items, 1)
        ]
    return [task.result() for task in tasks]


async def run_local_pdf_pipeline(
    pdf_dir: Path,
    skip_validation: bool = False,
    config: PipelineConfig | None = None,
) -> None:
    """Run LLM extraction on local PDF files (no database, no PubMed search).

    Results are written as a JSON report and printed as a rich console summary.

    Args:
        pdf_dir: Path to a single .pdf file or a directory containing .pdf files.
        skip_validation: If True, skip NCBI gene validation.
        config: Pipeline configuration (uses defaults if None).

    Raises:
        FileNotFoundError: If pdf_dir does not exist.
        ValueError: If path is not a .pdf file, or directory contains no .pdf files.
    """
    config = config or PipelineConfig()

    pdf_dir, pdf_files = _resolve_pdf_files(pdf_dir)

    metrics = PipelineMetrics()
    rate_limiter = AsyncRateLimiter(rpm=config.rpm_limit, tpm=config.tpm_limit)

    init_validation_state(config)
    pipeline_start_time = time.monotonic()

    logger.info(f"Starting local PDF pipeline: {len(pdf_files)} files in {pdf_dir}")
    logger.info(
        f"Config: model={config.llm_model}, "
        f"validation={'disabled' if skip_validation else 'enabled'}"
    )

    try:
        results = await _process_offline_items(
            pdf_files,
            concurrency=config.max_concurrent_papers,
            describe=lambda path: path.name,
            process=lambda path: _process_local_pdf_file(
                path,
                metrics,
                config,
                rate_limiter,
                skip_validation=skip_validation,
            ),
        )

        all_genes = _collect_successful_genes(results)
        batch_warnings = _run_batch_validation(all_genes)

        # Report
        total_duration = time.monotonic() - pipeline_start_time
        run_data = build_local_pdf_run_data(
            metrics=metrics,
            results=results,
            batch_warnings=batch_warnings,
            config=config,
            pdf_dir=pdf_dir,
            skip_validation=skip_validation,
            total_duration=total_duration,
        )
        _emit_report(run_data)

        await _record_and_notify(config, run_data)

    finally:
        await _close_extraction_resources(
            retrieval_clients=False,
            database=True,
        )


async def run_pmid_pipeline(
    pmid_file: Path,
    skip_validation: bool = False,
    config: PipelineConfig | None = None,
) -> None:
    """Run LLM extraction on specific PMIDs from a text file (no database).

    Reads PMIDs from a plain text file (one per line, blank lines and
    ``#`` comment lines ignored), fetches fulltext via PubMed/Unpaywall,
    runs LLM extraction + optional NCBI validation, and writes a JSON
    report with a rich console summary.

    Args:
        pmid_file: Path to a text file containing one PMID per line.
        skip_validation: If True, skip NCBI gene validation.
        config: Pipeline configuration (uses defaults if None).

    Raises:
        FileNotFoundError: If pmid_file does not exist.
        ValueError: If the file contains no valid PMIDs.
    """
    config = config or PipelineConfig()

    pmids = _load_pmids(pmid_file)

    metrics = PipelineMetrics()
    rate_limiter = AsyncRateLimiter(rpm=config.rpm_limit, tpm=config.tpm_limit)

    init_validation_state(config)
    pipeline_start_time = time.monotonic()

    logger.info(f"Starting PMID pipeline: {len(pmids)} PMIDs from {pmid_file}")
    logger.info(
        f"Config: model={config.llm_model}, "
        f"validation={'disabled' if skip_validation else 'enabled'}"
    )

    try:
        results = await _process_offline_items(
            pmids,
            concurrency=config.max_concurrent_papers,
            describe=lambda pmid: f"PMID {pmid}",
            process=lambda pmid: _process_pmid_item(
                pmid,
                metrics,
                config,
                rate_limiter,
                skip_validation=skip_validation,
            ),
        )

        all_genes = _collect_successful_genes(results)
        batch_warnings = _run_batch_validation(all_genes)

        # Report
        total_duration = time.monotonic() - pipeline_start_time
        run_data = build_pmid_run_data(
            metrics=metrics,
            results=results,
            batch_warnings=batch_warnings,
            config=config,
            pmid_file=pmid_file,
            skip_validation=skip_validation,
            total_duration=total_duration,
        )
        _emit_report(run_data)

        await _record_and_notify(config, run_data)

    finally:
        await _close_extraction_resources(
            retrieval_clients=True,
            database=True,
        )


def _result_summary(name: str, result: Any) -> dict[str, Any]:
    """Turn a dataclass sync result into the combined-notification shape.

    A per-item failure is **not** a failed refresh. Every sync appends
    one error string for each gene, ORPHAcode or study it could not
    fetch, so reading `failed` off a non-empty `errors` list painted a
    refresh that wrote 62 of 63 genes red, exited the process 1 and
    logged "Exporting despite failures" -- and made
    `derive_sync_status`'s documented amber branch unreachable from any
    real run. Only `aborted`, which the syncs set where they stop rather
    than carry on, is red here; the errors still ride the summary and
    turn the badge amber in `derive_sync_status`.
    """
    metrics = asdict(result)
    errors = metrics.pop("errors")
    # Popped so it stays out of the metrics line the notification renders
    # key=value; it is a status, not a count.
    aborted = bool(metrics.pop("aborted", False))
    if aborted:
        status = "failed"
    elif errors:
        status = "warnings"
    else:
        status = "ok"
    return {
        "name": name,
        "status": status,
        "metrics": metrics,
        "errors": errors,
    }


async def run_external_data_sync(
    config: PipelineConfig | None = None,
    manage_lifecycle: bool = True,
) -> dict[str, Any]:
    """Sync NCBI Gene / UniProt / PubMed-citation metadata for all genes.

    Clinical trial discovery is a separate pipeline; this function reads
    whatever rows the most recent CT sync wrote to the ``clinical_trials``
    table to build its Table 2 gene list.

    Args:
        config: Pipeline configuration (uses defaults if None).
        manage_lifecycle: When True, close the database pool on exit.
            Set to False by the dispatcher when coalescing multiple pipelines.

    Returns:
        Per-pipeline summary dict suitable for combined notification rendering.
    """
    from pipeline.external_data_sync import sync_all_external_data

    config = config or PipelineConfig()

    logger.info("Starting external data sync...")
    try:
        result = await sync_all_external_data(config=config)
        logger.info(LOG_SEPARATOR)
        logger.info("External Data Sync Summary:")
        logger.info(result.summary())
        logger.info(LOG_SEPARATOR)
        return _result_summary("external_sync", result)
    finally:
        if manage_lifecycle:
            await Database.close()


async def run_annotation_sync(
    config: PipelineConfig | None = None,
    manage_lifecycle: bool = True,
) -> dict[str, Any]:
    """Fetch ClinVar, Orphadata and Open Targets annotations for Table 1.

    Writes only the three annotation tables; the curated ``genes`` row is
    never touched.

    Args:
        config: Pipeline configuration (uses defaults if None).
        manage_lifecycle: When True, close the database pool on exit.
            Set to False by the dispatcher when coalescing multiple pipelines.

    Returns:
        Per-pipeline summary dict suitable for combined notification rendering.
    """
    from pipeline.external_data_sync import sync_all_annotations

    config = config or PipelineConfig()

    logger.info("Starting annotation sync...")
    try:
        result = await sync_all_annotations(config=config)
        logger.info(LOG_SEPARATOR)
        logger.info("Annotation Sync Summary:")
        logger.info(result.summary())
        logger.info(LOG_SEPARATOR)
        return _result_summary("annotation_sync", result)
    finally:
        if manage_lifecycle:
            await Database.close()


async def run_clinical_trials_pipeline(
    config: PipelineConfig | None = None,
    manage_lifecycle: bool = True,
) -> dict[str, Any]:
    """Run the ClinicalTrials.gov discovery pipeline.

    Fetches disease-relevant drug trials from the ClinicalTrials.gov v2 API
    and upserts them into the ``clinical_trials`` table. Curator-owned
    columns are preserved; only API-sourced columns are written.

    When ``config.ct_enabled`` is False, the pipeline is a no-op and the
    summary reports ``status="skipped"``.

    Args:
        config: Pipeline configuration (uses defaults if None).
        manage_lifecycle: When True, close the database pool on exit.
            Set to False by the dispatcher when coalescing multiple pipelines.

    Returns:
        Per-pipeline summary dict suitable for combined notification rendering.
    """
    config = config or PipelineConfig()

    if not config.ct_enabled:
        logger.warning("ClinicalTrials.gov sync disabled (ct_enabled=False); skipping")
        return {
            "name": "clinical_trials",
            "status": "skipped",
            "metrics": {"fetched": 0, "cached": 0, "failed": 0},
            "errors": [],
        }

    Database.set_config(config)
    logger.info("Starting ClinicalTrials.gov pipeline...")

    try:
        ctg_result = await sync_clinical_trials(config)
        logger.info(LOG_SEPARATOR)
        logger.info(
            f"ClinicalTrials.gov: {ctg_result.fetched} fetched, "
            f"{ctg_result.cached} upserted, "
            f"{ctg_result.failed} failed"
        )
        logger.info(LOG_SEPARATOR)
        return _result_summary("clinical_trials", ctg_result)
    finally:
        await close_ctg_client()
        if manage_lifecycle:
            await Database.close()


def _failure_summary(name: str, error: BaseException) -> dict[str, Any]:
    return {
        "name": name,
        "status": "failed",
        "metrics": {},
        "errors": [str(error)],
    }


async def _record_sync_summary(
    summary: dict[str, Any],
    *,
    mode: str,
    started_at: datetime,
    duration_seconds: float,
) -> None:
    """Store one refresh's record, best-effort.

    A `skipped` summary records nothing: it made no calls and changed
    nothing, which is the reasoning that also keeps the offline run modes
    out of `pipeline_runs`.

    The write is swallowed on failure for the reason `_record_failed_run`
    swallows its own: the database is often the thing that just went
    wrong, and raising here would replace the refresh's real error, on its
    way up, with one about recording it.
    """
    if mode not in SYNC_MODES or summary.get("status") == "skipped":
        return
    report = build_sync_report(
        summary,
        mode=mode,
        apis=current_recorder().records(),
        run_timestamp=started_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        duration_seconds=duration_seconds,
    )
    try:
        await record_sync_run(
            mode,
            started_at,
            report.status,
            report.duration_seconds,
            report.to_wire(),
        )
    except Exception as exc:
        logger.warning("Could not record the %s refresh: %s", mode, exc)


async def _run_summary_pipeline(
    coro: Awaitable[dict[str, Any]],
    pipeline_name: str,
    display_label: str,
) -> dict[str, Any]:
    """Run a pipeline coroutine that returns a summary dict, catching errors.

    Also records the refresh, which is the one place all three of them
    pass through. `reset_recorder()` is load-bearing here and not obvious:
    the API recorder is module-level and reset only at the top of
    `run_pipeline`, so without this a `--pubmed --sync-annotations`
    invocation would publish the PubMed run's rows as the sync's own. It
    is safe because `_finalize_run` snapshots the recorder *inside*
    `run_pipeline`, before the dispatcher ever reaches this function.
    """
    reset_recorder()
    started_at = datetime.now(tz=UTC)
    started = time.monotonic()
    try:
        summary = await coro
    except Exception as e:
        logger.exception(f"{display_label} failed")
        summary = _failure_summary(pipeline_name, e)
    await _record_sync_summary(
        summary,
        mode=pipeline_name,
        started_at=started_at,
        duration_seconds=time.monotonic() - started,
    )
    return summary


def _published_lookup_keys(run_data: PipelineRunData) -> tuple[list[str], list[str]]:
    """The gene keys and PMIDs a PubMed run added, in first-seen order.

    Only papers that yielded a gene are named: the export asks the citation
    cache for the PMIDs in `gene_references`, so a paper that attached no
    reference reaches no lookup. The symbols go through
    ``canonical_gene_symbol`` because that is the key the merge stored and
    therefore the key the export requests -- caching a pair member's own
    symbol would leave the row published under the shared alias key looking
    up nothing.

    A gene the insert floor refused is named here too: the report says what
    the run extracted, not what the merge kept. Caching it costs one lookup
    the export does not read, and saves it when the gene clears the floor
    on a later paper; reading the held list back to exclude it would trade
    that for a second way of deciding which genes the run is about.
    """
    symbols: list[str] = []
    pmids: list[str] = []
    for paper in run_data.get("papers_detail", []):
        genes = paper.get("genes") or []
        if not genes:
            continue
        pmids.append(paper.get("pmid") or "")
        symbols.extend(
            canonical_gene_symbol(str(gene.get("gene_symbol") or "")) for gene in genes
        )
    return (
        [symbol for symbol in dict.fromkeys(symbols) if symbol],
        [pmid for pmid in dict.fromkeys(pmids) if pmid],
    )


async def _refresh_lookup_caches(
    run_data: PipelineRunData,
    config: PipelineConfig,
) -> None:
    """Cache NCBI, UniProt and PubMed metadata for what the run just merged.

    A PubMed run writes to none of the three lookup tables, and the export
    completes a key it cannot find into a row of nulls, so `--export`
    published every newly inserted gene with an empty tooltip and every
    newly attached reference as "(citation not available)". Skipped when
    `--sync-external-data` ran in the same invocation, which covers every
    row in the database including these.
    """
    from pipeline.external_data_sync import sync_external_data_for

    symbols, pmids = _published_lookup_keys(run_data)
    if not symbols:
        logger.info("No new genes for the lookup caches before the export")
        return

    logger.info(
        f"Refreshing the lookup caches for {len(symbols)} gene(s) and "
        f"{len(pmids)} PMID(s) before the export"
    )
    try:
        result = await sync_external_data_for(symbols, pmids, config=config)
    except Exception:
        # The export still has to run -- the database has moved and the
        # files have not -- but the rows it publishes for these genes will
        # carry nulls, so this is an error and not a shrug.
        logger.error(
            "Could not refresh the lookup caches; the export will publish the"
            " new genes and references without their metadata",
            exc_info=True,
        )
        return
    if result.errors:
        logger.error(
            "Lookup refresh incomplete; some new genes or references will be"
            " published without their metadata: %s",
            "; ".join(result.errors[:_MAX_LOOKUP_ERRORS_LOGGED]),
        )


async def _publish_export(summaries: list[dict[str, Any]]) -> bool:
    """Regenerate data/*.json from the database. True if it failed.

    Called from inside _run_selected_pipelines' `try`, so it runs before the
    `finally` closes the pool and reuses the connection the run already has.
    """
    # Imported here rather than at module scope: pipeline/export/main.py
    # calls load_dotenv at import time, and the argcomplete fast path above
    # exists to keep heavy imports out of the graph. pipeline/pdf_parse.py is
    # the house precedent for a local import held for startup cost.
    from pipeline.export.main import run_export

    failed = [s["name"] for s in summaries if s["status"] == "failed"]
    if failed:
        # A failed run still persists its pipeline_runs row so the About
        # page's widget can report it; not exporting is what would keep that
        # failure invisible. The database is a consistent snapshot whichever
        # pipeline failed, and publish_atomically is all-or-nothing.
        logger.info(f"Exporting despite failures in: {', '.join(failed)}")

    try:
        await run_export()
    except Exception as e:
        # The database moved and the files did not -- exactly the condition
        # --export exists to remove -- so this must not pass silently on an
        # unattended run, whatever raised it: the export reads the database
        # (asyncpg, a missing DB_* variable) and re-validates the stored
        # report (pydantic), and none of those is an OSError. The caller
        # folds it into the exit code.
        logger.error(f"Export failed; data/*.json is behind the database: {e}")
        return True
    return False


async def _run_selected_pipelines(
    args: argparse.Namespace,
    config: PipelineConfig,
) -> int:
    """Run the online pipelines selected on the command line, in sequence.

    Owns the single combined notification for the invocation. Continues on
    per-pipeline failure so that one pipeline's error doesn't silently skip
    the others.

    Returns the process exit code (0 on full success, 1 if any pipeline failed).
    """
    summaries: list[dict[str, Any]] = []
    pubmed_run_data: PipelineRunData | None = None
    pubmed_early_exit = False

    try:
        if args.pubmed:
            try:
                metrics, pubmed_run_data = await run_pipeline(
                    days_back=args.days_back,
                    dry_run=args.dry_run,
                    test_mode=args.test_mode,
                    use_batch_api=args.batch,
                    config=config,
                    manage_lifecycle=False,
                )
                summaries.append(
                    {
                        "name": "pubmed",
                        "status": "ok",
                        "metrics": {
                            "papers_processed": metrics.papers_processed,
                            "fulltext_retrieved": metrics.fulltext_retrieved,
                            "genes_extracted": metrics.genes_extracted,
                            "genes_validated": metrics.genes_validated,
                            "genes_rejected": metrics.genes_rejected,
                        },
                        "errors": [],
                    }
                )
                pubmed_early_exit = pubmed_run_data is None
            except Exception as e:
                logger.exception("PubMed pipeline failed")
                summaries.append(_failure_summary("pubmed", e))

        summary_pipelines = (
            (
                args.clinical_trials,
                run_clinical_trials_pipeline,
                "clinical_trials",
                "Clinical trials pipeline",
            ),
            (
                args.sync_external_data,
                run_external_data_sync,
                "external_sync",
                "External data sync",
            ),
            (
                args.sync_annotations,
                run_annotation_sync,
                "annotation_sync",
                "Annotation sync",
            ),
        )
        for selected, runner, name, label in summary_pipelines:
            if selected:
                summaries.append(
                    await _run_summary_pipeline(
                        runner(config=config, manage_lifecycle=False),
                        name,
                        label,
                    )
                )

        any_failed = any(s["status"] == "failed" for s in summaries)
        pubmed_only = len(summaries) == 1 and summaries[0]["name"] == "pubmed"

        # PubMed early-exits (no new papers, all already processed, test-mode
        # preview) leave pubmed_run_data=None. Preserve the pre-split behavior
        # of emitting no notification in that specific case. Tracked as its
        # own flag: a *raised* run leaves run_data None too, and keying on
        # that silenced the one channel meant to report the failure -- for
        # the default, unattended invocation and no other.
        if pubmed_only and pubmed_run_data is not None:
            await _record_and_notify(config, pubmed_run_data)
        elif summaries and not (pubmed_only and pubmed_early_exit):
            combined: dict[str, Any] = {
                "timestamp": datetime.now(tz=UTC).isoformat(),
                "pipelines": summaries,
                "pipeline_config": {
                    "mode": "combined",
                    "model": config.llm_model,
                    "effort": config.llm_effort,
                },
            }
            await _record_and_notify(config, combined)

        export_failed = False
        if args.export:
            if pubmed_only and (args.dry_run or args.test_mode):
                # A preview writes nothing, so the export would republish the
                # committed files unchanged for no reason.
                logger.info(
                    "Skipping --export: --dry-run / --test-mode wrote nothing"
                )
            else:
                if pubmed_run_data is not None and not args.sync_external_data:
                    await _refresh_lookup_caches(pubmed_run_data, config)
                export_failed = await _publish_export(summaries)

        return int(any_failed or export_failed)

    finally:
        await close_async_client()
        await Database.close()


def _prepare_cli_args(
    parser: argparse.ArgumentParser,
    args: argparse.Namespace,
) -> argparse.Namespace:
    """Validate mode combinations and apply the default pipeline selection."""
    offline_modes = (args.local_pdfs, args.pmids)
    online_modes = (
        args.pubmed,
        args.clinical_trials,
        args.sync_external_data,
        args.sync_annotations,
    )

    if sum(map(bool, offline_modes)) > 1:
        parser.error("--local-pdfs and --pmids cannot be combined")

    offline_selected = any(offline_modes)
    online_selected = any(online_modes)
    if offline_selected and online_selected:
        parser.error(
            "--local-pdfs / --pmids cannot be combined with --pubmed,"
            " --clinical-trials, --sync-external-data, or --sync-annotations"
        )
    if args.skip_validation and not offline_selected:
        parser.error("--skip-validation requires --local-pdfs or --pmids")
    # An error rather than the warning the PubMed-only flags below get: the
    # offline modes bypass _run_selected_pipelines entirely and publish no
    # data, so a silently ignored --export would leave the caller believing
    # data/*.json had been regenerated.
    if args.export and offline_selected:
        parser.error("--export cannot be combined with --local-pdfs or --pmids")

    # The default selection is applied *before* the warning below, not
    # after: a bare `--dry-run`, `--test-mode`, `--batch` or `--days-back N`
    # selects the PubMed pipeline and the flag is honoured, so warning first
    # told the operator their preview was being ignored and then ran the
    # preview -- and told them `--batch` was ignored and then submitted the
    # whole window to the Batch API.
    if not offline_selected and not online_selected:
        args.pubmed = True

    pubmed_options_set = (
        args.test_mode
        or args.dry_run
        or args.batch
        or args.days_back != DEFAULT_DAYS_BACK
    )
    # Offline modes included: `--pmids f --batch` ran the streaming path
    # at full price with nothing said.
    if pubmed_options_set and not args.pubmed:
        logger.warning(
            "--days-back / --dry-run / --test-mode / --batch are PubMed-only;"
            " ignoring because --pubmed was not selected"
        )
    return args


def main() -> None:
    """CLI entry point."""
    parser = _build_parser()
    args = _prepare_cli_args(parser, parser.parse_args())

    config = PipelineConfig()

    try:
        if args.local_pdfs:
            asyncio.run(
                run_local_pdf_pipeline(
                    pdf_dir=args.local_pdfs,
                    skip_validation=args.skip_validation,
                    config=config,
                )
            )
        elif args.pmids:
            asyncio.run(
                run_pmid_pipeline(
                    pmid_file=args.pmids,
                    skip_validation=args.skip_validation,
                    config=config,
                )
            )
        else:
            exit_code = asyncio.run(_run_selected_pipelines(args, config))
            if exit_code:
                sys.exit(exit_code)
    except (ValueError, FileNotFoundError) as e:
        logger.error(f"Invalid argument: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        logger.info("Pipeline interrupted by user")
        sys.exit(130)
    except asyncio.CancelledError:
        # SIGTERM/SIGHUP cancel the main task (see
        # _install_termination_handlers) and asyncio.run re-raises the
        # cancellation; uncaught, a clean `systemctl stop` printed a
        # traceback and exited 1. 143 is the conventional SIGTERM status.
        logger.info("Pipeline terminated")
        sys.exit(143)


if __name__ == "__main__":
    main()
