"""LLM-based gene extraction over the Anthropic API."""

import logging

from pipeline.anthropic_client import AnthropicClient
from pipeline.config import PipelineConfig
from pipeline.extraction_models import ExtractionFailedError, GeneEntry, ServedBy
from pipeline.quality_metrics import TokenUsage
from pipeline.rate_limiter import AsyncRateLimiter

logger = logging.getLogger(__name__)

__all__ = [
    "ExtractionFailedError",
    "GeneEntry",
    "close_async_client",
    "extract_from_paper",
]

_client: AnthropicClient | None = None


async def extract_from_paper(
    text: str,
    pmid: str,
    config: PipelineConfig | None = None,
    rate_limiter: AsyncRateLimiter | None = None,
    *,
    model: str | None = None,
    declined: str | None = None,
) -> tuple[list[GeneEntry], TokenUsage, ServedBy | None]:
    """Extract genes from paper text. Caches one client for the process.

    The third value says which model served the extraction, and is None
    when no call was made (empty text): no model ran. *model* and
    *declined* send the paper straight to that model with no server-side
    fallback; see `AnthropicClient.extract`.
    """
    global _client
    if not text or not text.strip():
        logger.warning("Empty text provided for PMID %s", pmid)
        return [], TokenUsage(), None

    config = config or PipelineConfig()
    if _client is None:
        _client = AnthropicClient()
    return await _client.extract(
        text, pmid, config, rate_limiter, model=model, declined=declined
    )


async def close_async_client() -> None:
    """Close the cached client. Idempotent: safe before any init."""
    global _client
    if _client is not None:
        await _client.close()
    _client = None
