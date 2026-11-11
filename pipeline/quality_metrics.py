"""Pipeline quality metrics and token usage tracking.

Provides lightweight, memory-efficient dataclasses for accumulating
metrics during pipeline execution.
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class TokenUsage:
    """Accumulated LLM token usage across one or more API calls."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    # Thinking tokens, as the API reports them in
    # usage.output_tokens_details.thinking_tokens (accumulate_usage). Only a
    # response that reports no split is estimated instead, from the
    # character ratio of its blocks -- see _account_reasoning.
    thinking_tokens: int = 0
    # Count of responses that hit the max_tokens ceiling
    # (stop_reason=max_tokens for Anthropic). Providers set this to 1 on
    # truncation; __iadd__ sums it so the metrics total surfaces how many
    # extractions were silently cut short by an undersized token budget.
    truncated_responses: int = 0
    # The subset of the four counts above that the fallback model ran, from
    # its entries in `usage.iterations` -- the attempt that served, and one
    # that declined as well (see `accumulate_usage`). The totals stay
    # totals across both models, so every panel reading them is unchanged;
    # these exist so `estimate_cost` can price each model's share at its own
    # rates. A batch never falls back, so they stay 0 there.
    fallback_input_tokens: int = 0
    fallback_output_tokens: int = 0
    fallback_cache_creation_input_tokens: int = 0
    fallback_cache_read_input_tokens: int = 0

    @property
    def text_output_tokens(self) -> int:
        """Non-thinking output tokens: output less the thinking count."""
        return max(0, self.output_tokens - self.thinking_tokens)

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    @property
    def cache_hit_rate(self) -> float:
        """Fraction of input tokens served from cache.

        The API's ``input_tokens`` excludes both cache counts (which is how
        ``_priced`` bills the three), so a prefix written to the cache is
        input that was *not* served from it and belongs in the
        denominator. Without it two abstract-only papers -- one writing an
        18k-token prefix, one reading it -- published 90% where 18k of
        38k input tokens were cached.
        """
        total_input = (
            self.input_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
        )
        if total_input == 0:
            return 0.0
        return self.cache_read_input_tokens / total_input

    def __iadd__(self, other: TokenUsage) -> TokenUsage:
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.cache_creation_input_tokens += other.cache_creation_input_tokens
        self.cache_read_input_tokens += other.cache_read_input_tokens
        self.thinking_tokens += other.thinking_tokens
        self.truncated_responses += other.truncated_responses
        self.fallback_input_tokens += other.fallback_input_tokens
        self.fallback_output_tokens += other.fallback_output_tokens
        self.fallback_cache_creation_input_tokens += (
            other.fallback_cache_creation_input_tokens
        )
        self.fallback_cache_read_input_tokens += other.fallback_cache_read_input_tokens
        return self


def reported_thinking_tokens(response_usage: Any) -> int | None:
    """The thinking tokens the API reports for one response, or None.

    `usage.output_tokens_details.thinking_tokens` counts the raw reasoning
    the model generated -- billed as output, never shown -- so it is the
    exact split. The character-ratio estimate it replaces overstated it
    2.2x on the golden cassettes, by charging the tool call's JSON to
    thinking. The SDK types the field optional, and None
    means "not reported" rather than "no thinking", so the caller can
    estimate instead of publishing a zero beside a real output count.
    """
    details = getattr(response_usage, "output_tokens_details", None)
    reported = getattr(details, "thinking_tokens", None)
    return reported if isinstance(reported, int) else None


def _counts(entry: Any) -> tuple[int, int, int, int]:
    """Input, output, cache-write and cache-read tokens of one usage entry."""
    return (
        getattr(entry, "input_tokens", 0) or 0,
        getattr(entry, "output_tokens", 0) or 0,
        getattr(entry, "cache_creation_input_tokens", 0) or 0,
        getattr(entry, "cache_read_input_tokens", 0) or 0,
    )


def _is_fallback_attempt(entry: Any, fallback_model: str | None) -> bool:
    """Whether one `usage.iterations` entry is the fallback model's attempt.

    A `fallback_message` entry always is: it is the fallback attempt that
    served the message. An attempt that *declined* is a plain `message`
    entry whatever model ran it, so the fallback's declined attempt -- both
    models declining -- is told apart only by the `model` it names, which
    the API marks optional. An entry naming no model is the requested one's.
    """
    if getattr(entry, "type", None) == "fallback_message":
        return True
    model = getattr(entry, "model", None)
    return fallback_model is not None and model == fallback_model


def accumulate_usage(
    usage: TokenUsage, response: Any, *, fallback_model: str | None = None
) -> TokenUsage:
    """Accumulate an Anthropic response's token counts into *usage*.

    Returns what this one response added, for the TPM reservation.

    Thinking tokens are taken here when the API reports them, which is
    before any refusal or truncation check: a response cut off or declined
    after reasoning was still billed for that reasoning.

    **Under the server-side fallback, top-level `usage` is one attempt.** It
    covers only the attempt that produced the returned message, while
    `usage.iterations` lists every attempt -- the declined Opus 5.5 one as a
    `message` entry, the Opus 4.8 one that served it as `fallback_message`.
    So a non-empty `iterations` is summed instead of the top level, never as
    well, and the *fallback_model*'s attempts are also counted on their own
    for `estimate_cost`: the one that served, and one that declined too,
    which is a `message` entry naming that model (see
    `_is_fallback_attempt`). Thinking stays top-level: only the served
    attempt reports it.
    """
    response_usage = getattr(response, "usage", None)
    if response_usage is None:
        return TokenUsage()
    iterations = getattr(response_usage, "iterations", None)
    delta = TokenUsage(thinking_tokens=reported_thinking_tokens(response_usage) or 0)
    entries = iterations if isinstance(iterations, list) and iterations else None
    for entry in entries or [response_usage]:
        inp, out, write, read = _counts(entry)
        delta.input_tokens += inp
        delta.output_tokens += out
        delta.cache_creation_input_tokens += write
        delta.cache_read_input_tokens += read
        if entries is not None and _is_fallback_attempt(entry, fallback_model):
            delta.fallback_input_tokens += inp
            delta.fallback_output_tokens += out
            delta.fallback_cache_creation_input_tokens += write
            delta.fallback_cache_read_input_tokens += read
    usage += delta
    return delta


@dataclass(slots=True)
class PipelineMetrics:
    """Tracks quality metrics throughout a pipeline run.

    This is a mutable accumulator — metrics are incremented as the
    pipeline processes papers.

    Attributes:
        papers_processed: Total papers successfully processed.
        fulltext_retrieved: Papers with full text (Europe PMC, PMC, or
            Unpaywall).
        abstract_only: Papers where only abstract was available.
        genes_extracted: Raw genes extracted by LLM (pre-validation).
        genes_validated: Genes passing NCBI validation.
        genes_rejected: Genes failing confidence or NCBI checks.
        token_usage: Accumulated LLM token usage.
        streamed_token_usage: The share of ``token_usage`` a ``--batch``
            run restored from a checkpoint. A batch entry's record carries
            no tokens, so all of it was paid for by a streaming run at the
            full rate, and the cost estimate must not halve it.
    """

    papers_processed: int = 0
    fulltext_retrieved: int = 0
    abstract_only: int = 0
    genes_extracted: int = 0
    genes_validated: int = 0
    genes_rejected: int = 0
    token_usage: TokenUsage = field(default_factory=TokenUsage)
    streamed_token_usage: TokenUsage = field(default_factory=TokenUsage)

    def fold(self, other: PipelineMetrics) -> None:
        """Add one paper's own metrics into this accumulator, in place.

        Papers are processed into a fresh PipelineMetrics each, so a paper
        that finished carries exactly what it contributed and can be
        checkpointed with it -- which is what lets a resumed run restore the
        contribution without re-extracting the paper. TokenUsage.__iadd__ reads
        the source counters and mutates only this accumulator, so the paper's
        own usage remains independent.

        Named as well as spelled `+=` because the accumulator is usually a
        function parameter, and `metrics += paper` there is an assignment:
        it would make the name local and raise UnboundLocalError.
        """
        self.papers_processed += other.papers_processed
        self.fulltext_retrieved += other.fulltext_retrieved
        self.abstract_only += other.abstract_only
        self.genes_extracted += other.genes_extracted
        self.genes_validated += other.genes_validated
        self.genes_rejected += other.genes_rejected
        self.token_usage += other.token_usage
        self.streamed_token_usage += other.streamed_token_usage

    def __iadd__(self, other: PipelineMetrics) -> PipelineMetrics:
        self.fold(other)
        return self

    @property
    def gene_acceptance_rate(self) -> float:
        """Ratio of validated to extracted genes (0.0 if none extracted)."""
        if (total := self.genes_extracted) == 0:
            return 0.0
        return self.genes_validated / total

    @property
    def fulltext_rate(self) -> float:
        """Ratio of papers with full text to total processed."""
        if (total := self.papers_processed) == 0:
            return 0.0
        return self.fulltext_retrieved / total
