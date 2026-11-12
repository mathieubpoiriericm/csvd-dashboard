"""Pipeline notification dispatch via Apprise.

Sends pipeline run digests via Apprise (multi-channel) using a
Jinja2-rendered Markdown body.
"""

import logging
from collections.abc import Callable, Mapping, Sequence
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Final

import apprise
import jinja2
from apprise import NotifyFormat, NotifyType
from tenacity import retry, stop_after_attempt, wait_exponential

from pipeline.disease import load_disease
from pipeline.steps import PREVIEW_RUN_MODE

if TYPE_CHECKING:
    from pipeline.config import PipelineConfig
    from pipeline.report import PipelineRunData

logger = logging.getLogger(__name__)

# Jinja2 environment pointing at pipeline/templates/
_TEMPLATE_DIR = Path(__file__).resolve().parent / "templates"
_jinja_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(str(_TEMPLATE_DIR)),
    autoescape=False,
    trim_blocks=True,
    lstrip_blocks=True,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _format_duration(seconds: float) -> str:
    """Format a duration in seconds to a human-readable string.

    Examples:
        5.3  -> "5.3s"
        125  -> "2m 5s"
        3661 -> "1h 1m 1s"
    """
    if seconds < 60:
        return f"{seconds:.1f}s"

    total_seconds = int(seconds)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, secs = divmod(remainder, 60)

    if hours > 0:
        return f"{hours}h {minutes}m {secs}s"
    return f"{minutes}m {secs}s"


_MODE_LABELS: Final[Mapping[str | None, str]] = MappingProxyType(
    {
        "local_pdf": "Local PDF",
        "pmid_list": "PMID List",
        "combined": "Combined",
        PREVIEW_RUN_MODE: "Preview",
        None: "Standard",
    }
)


# What one mode of a multi-mode invocation is called when it ran alone. The
# dispatcher wraps a failed --pubmed run in the combined shape, and
# "Combined" over a single mode named nothing.
_PIPELINE_LABELS: Final[Mapping[str, str]] = MappingProxyType(
    {
        "pubmed": "PubMed",
        "clinical_trials": "Clinical Trials",
        "external_sync": "External Sync",
        "annotation_sync": "Annotation Sync",
    }
)

# The one mode that runs a model; a digest without it names none.
_EXTRACTING_PIPELINE: Final[str] = "pubmed"


def _pipeline_names(run_data: Mapping[str, Any]) -> list[str]:
    """The modes a combined digest covers, in the order they ran."""
    return [str(p.get("name", "")) for p in run_data.get("pipelines") or []]


def _mode_label(cfg: dict[str, Any], pipelines: Sequence[str] = ()) -> str:
    """Human-readable label for a pipeline run mode."""
    label = _MODE_LABELS.get(cfg.get("mode"), "Standard")
    if cfg.get("mode") == "combined" and len(pipelines) == 1:
        label = _PIPELINE_LABELS.get(pipelines[0], label)
    if cfg.get("dry_run"):
        label += " (Dry Run)"
    return label


def _build_template_context(run_data: PipelineRunData) -> dict[str, Any]:
    """Extract template variables from PipelineRunData."""
    cfg = run_data.get("pipeline_config", {})
    # A preview run searched and merged like a standard one; only its label differs.
    is_standard = cfg.get("mode") in (None, PREVIEW_RUN_MODE)
    names = _pipeline_names(run_data)
    mode_label = _mode_label(cfg, names)

    # Combined / multi-pipeline invocations carry a ``pipelines`` list.
    # Cost / papers / genes aren't always applicable in that shape, so we
    # fall back to zeros and only show sections the template is guarded
    # against.
    pipelines = run_data.get("pipelines") or []

    # Database visibility
    show_database = (
        is_standard
        and not cfg.get("dry_run", False)
        and run_data.get("database") is not None
    )

    # Cost string
    tu = run_data.get("token_usage", {})
    cost = tu.get("estimated_cost_usd")
    cost_str = f"${cost:.2f}" if cost is not None else "N/A"

    return {
        "run_label": load_disease().run_label,
        "mode_label": mode_label,
        "model": cfg.get("model", "N/A"),
        "duration": _format_duration(run_data.get("total_processing_time", 0.0)),
        "effort": cfg.get("effort", "N/A"),
        "show_search": is_standard,
        "search": run_data.get("search", {}),
        "papers": run_data.get("papers", {}),
        "genes": run_data.get("genes", {}),
        "token_usage": tu,
        "cost_str": cost_str,
        "show_database": show_database,
        "database": run_data.get("database") or {},
        "batch_warnings": run_data.get("batch_validation_warnings", []),
        "pipelines": pipelines,
        # A refresh runs no model, so a digest of refreshes alone names none.
        "show_model": not pipelines or _EXTRACTING_PIPELINE in names,
    }


def _render_markdown(run_data: PipelineRunData) -> str:
    """Render the Markdown body for push notifications."""
    template = _jinja_env.get_template("digest.md.j2")
    return template.render(_build_template_context(run_data))


def _make_send_notification(
    config: PipelineConfig,
) -> Callable[[str, str, NotifyType], None]:
    """Return a Tenacity-wrapped sender function bound to *config*."""
    ap = apprise.Apprise()
    for url in map(str.strip, config.notify_urls.split(",")):
        if url:
            ap.add(url)

    @retry(
        stop=stop_after_attempt(config.notify_max_retries),
        wait=wait_exponential(
            min=config.notify_retry_min_wait,
            max=config.notify_retry_max_wait,
        ),
        reraise=True,
    )
    def _send(title: str, body_text: str, notify_type: NotifyType) -> None:
        # Apprise reports failure through its return value, not an
        # exception: False when any service failed, None when no service
        # could be loaded from the URLs. Tenacity retries on exceptions
        # only, so without raising here the configured retries were dead
        # and the caller logged success over an undelivered digest.
        delivered = ap.notify(
            title=title,
            body=body_text,
            body_format=NotifyFormat.MARKDOWN,
            notify_type=notify_type,
        )
        if delivered is not True:
            raise RuntimeError("Apprise reported a delivery failure")

    return _send


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def send_pipeline_notification(
    run_data: PipelineRunData, config: PipelineConfig
) -> None:
    """Send a pipeline run summary via all configured Apprise channels.

    Non-fatal: errors are logged but never propagate.

    Args:
        run_data: Full run data dict from ``build_run_data`` / etc.
        config: Pipeline configuration with ``notify_urls``.
    """
    if not config.notify_urls:
        logger.warning(
            "Notification URLs not configured (PIPELINE_NOTIFY_URLS). "
            "Skipping notification."
        )
        return

    mode_label = _mode_label(
        run_data.get("pipeline_config", {}), _pipeline_names(run_data)
    )
    # Apprise colours and routes on the type, and a failed invocation sent
    # as INFO is the digest nobody opens.
    failed = any(
        p.get("status") == "failed" for p in run_data.get("pipelines") or []
    )
    # UTC matches the report body's `timestamp` field \u2014 otherwise the
    # notification title can show a different date than the run's own log.
    date_str = datetime.now(UTC).strftime("%Y-%m-%d")
    title = (
        f"[{load_disease().run_label}] Run Summary \u2014 {mode_label} ({date_str})"
    )

    # The render is inside the try because this runs after the `completed`
    # pipeline_runs row is written: a template error escaping here turned
    # a merged run into a second, `failed` row over a digest that was
    # never going to matter.
    try:
        body_md = _render_markdown(run_data)
        sender = _make_send_notification(config)
        sender(title, body_md, NotifyType.FAILURE if failed else NotifyType.INFO)
        logger.info("Pipeline notification sent successfully")
    except Exception as exc:
        logger.error(f"Failed to send pipeline notification: {exc}")
