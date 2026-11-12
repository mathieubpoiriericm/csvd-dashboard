"""Anthropic Claude backend for gene extraction.

Uses the Anthropic streaming API with adaptive thinking, a tool that
carries the extraction schema (advisory, not `strict`: validated here and
retried, see `PipelineConfig.extraction_tool`), citations and prompt
caching.
"""

import asyncio
import copy
import json
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Final

import anthropic
import httpx2

from pipeline.api_telemetry import (
    note_service_retry,
    record_service_call,
    record_service_failure,
)
from pipeline.citations import collect_spans, report_provenance
from pipeline.config import EXTRACTION_TOOL_NAME, FALLBACK_BETA, PipelineConfig
from pipeline.disease import load_disease
from pipeline.event_log import EventLog
from pipeline.extraction_models import (
    ExtractionFailedError,
    ExtractionRefusedError,
    ExtractionResult,
    GeneEntry,
    ServedBy,
)
from pipeline.prompts import build_extraction_prompt, prompt_sha256
from pipeline.quality_metrics import (
    TokenUsage,
    accumulate_usage,
    reported_thinking_tokens,
)
from pipeline.rate_limiter import AsyncRateLimiter, compute_backoff, resolve_retry_delay
from pipeline.run_errors import refusal_category

# Pricing per 1M tokens (input, output) for EXTRACTION_MODEL. Bump when
# Anthropic changes published rates.
MODEL_PRICING: Final[tuple[float, float]] = (4.0, 20.0)
# The same for EXTRACTION_FALLBACK_MODEL, Claude Opus 4.8. A fallback attempt
# is billed at the fallback model's rates (usage.iterations is per attempt);
# the declined attempt before it is billed too, unless it was refused before
# any output in a category the API does not bill (BILLED_REFUSAL_CATEGORIES).
FALLBACK_MODEL_PRICING: Final[tuple[float, float]] = (5.0, 25.0)

# Where the SDK's calls land in the run report's External services panel.
# The SDK owns its own transport, so no httpx event hook fires for it and
# every call, error and retry *the pipeline sees* has to be named here.
# What it cannot name is the SDK's own retry loop: the client keeps
# `anthropic.DEFAULT_MAX_RETRIES` deliberately (see build_async_client), so
# a 408, 409, 429 or 5xx it absorbs never reaches these recorders. The row
# therefore counts the calls this module made, not the HTTP attempts that
# went out, and under transient pressure it undercounts by up to two per
# call. It never reports a failure as a success -- a failure the SDK could
# not absorb still lands in one of the branches below -- but a run that
# succeeded only because of those retries publishes a clean Anthropic row
# and raises no `api_retried` warning.
_ANTHROPIC_SERVICE: Final[str] = "anthropic"
_MESSAGES_ENDPOINT: Final[str] = "/v1/messages"

# Prompt-caching multipliers applied to the base input price. The pipeline
# writes 1h TTL caches (see prompts.py), so writes cost 2x base. Claude
# Opus 5.5 reads its cache at 0.05x base ($0.20/M), not the 0.1x the
# earlier Opus models charged.
_CACHE_WRITE_MULTIPLIER: float = 2.0  # 1h TTL
_CACHE_READ_MULTIPLIER: float = 0.05
# Claude Opus 4.8 reads its cache at the 0.1x earlier Opus models charged.
_FALLBACK_CACHE_READ_MULTIPLIER: float = 0.1
# The Message Batches API bills every token at half the streaming rate.
_BATCH_MULTIPLIER: float = 0.5

# The reasoning trace stored per paper is an audit artifact, not a bounded
# API payload, so it needs its own cap: uncapped, a long paper's trace could
# run the SQLite event log past a reasonable size over a `--days-back 365`
# run's ~795 papers. 20,000 characters is generous for hand inspection
# (Anthropic's own thinking summaries rarely approach it) while keeping the
# log's growth bounded and predictable.
_MAX_THINKING_CHARS_LOGGED: Final[int] = 20_000

logger = logging.getLogger(__name__)


def _declining_hop_category(response: Any) -> str | None:
    """The category the first `fallback` block's trigger names, if any.

    One block marks each hop where a model ran and declined; the first is
    the requested model's. None when no model handed over this turn, and
    when the trigger names no category -- so the caller can still look at
    `stop_details` rather than settle for "unspecified" first.
    """
    for block in getattr(response, "content", None) or []:
        if getattr(block, "type", None) == "fallback":
            raw = getattr(getattr(block, "trigger", None), "category", None)
            return raw if isinstance(raw, str) and raw else None
    return None


def _serving_hop(response: Any, *, pmid: str) -> Any:
    """The response as the model that served it wrote it.

    A model that declines mid-stream has already written into `content`,
    and the SDK keeps those blocks, then appends a `fallback` block and the
    next model's. The partial output is the declined model's and is to be
    discarded: read whole, its tool calls were published as the serving
    model's genes (and a gene both wrote was counted twice), and its
    reasoning was saved as the serving model's trace. Everything after the
    last `fallback` block is the serving hop. A response with no block is
    returned as it is.
    """
    content = list(getattr(response, "content", None) or [])
    cut = max(
        (i for i, b in enumerate(content) if getattr(b, "type", None) == "fallback"),
        default=-1,
    )
    if cut < 0:
        return response
    if cut > 0:
        logger.warning(
            f"  Discarded {cut} block(s) a declining model wrote before the "
            f"fallback for PMID {pmid}"
        )
    serving = content[cut + 1 :]
    copier = getattr(response, "model_copy", None)
    if callable(copier):
        return copier(update={"content": serving})
    clone = copy.copy(response)
    clone.content = serving
    return clone


def _refusal_category(response: Any) -> str:
    """The classifier category a refusal names.

    Claude Opus 5.5 runs a biology classifier beside the cyber one Opus 5
    had, and this pipeline reads biology papers, so which classifier
    declined is the first thing an operator needs to tell a false positive
    from a prompt problem. When the fallback ran and declined too, the
    requested model's reason is the one the run groups by: it is in the
    fallback block's trigger, while the final `stop_details` belong to the
    fallback model, whose reason `_fallback_declined_too` adds to the
    message. `stop_details` is informational and may be null, so a missing
    category reads as "unspecified" rather than failing.
    """
    declined = _declining_hop_category(response)
    if declined is not None:
        return declined
    details = getattr(response, "stop_details", None)
    return refusal_category(getattr(details, "category", None))


def _fallback_declined_too(response: Any) -> str:
    """The clause naming the fallback's own reason, on a chain refusal.

    `_refusal_category` reports the requested model's reason, because that
    decline is what sent the paper on; but the fallback ran and declined as
    well, and its reason -- the final `stop_details`, which are the last
    model's to run -- was dropped, so a paper Opus 4.8 declined under a
    different classifier read as one classifier's verdict. The last
    `fallback` block's `to` names that model. Empty when no model handed
    over: then the one refusal is the whole story.
    """
    blocks = [
        block
        for block in getattr(response, "content", None) or []
        if getattr(block, "type", None) == "fallback"
    ]
    if not blocks:
        return ""
    model = getattr(getattr(blocks[-1], "to", None), "model", None)
    details = getattr(response, "stop_details", None)
    category = refusal_category(getattr(details, "category", None))
    return (
        f"; {model or 'the fallback model'} declined it too (category: {category})"
    )


def _fallback_served(response: Any, fallback_model: str) -> bool:
    """Whether the fallback model produced this response, block or none.

    A refusal with no `fallback` block can still be the fallback's own: a
    retry of a paper that fell back is answered by it directly for about an
    hour (sticky routing), with a `fallback_message` iteration and the
    response's `model` naming it but no hand-over block, because the
    requested model never ran. Sending that paper to the fallback again
    would ask the model that has just declined it.
    """
    if getattr(response, "model", None) == fallback_model:
        return True
    iterations = getattr(getattr(response, "usage", None), "iterations", None)
    return isinstance(iterations, list) and any(
        getattr(entry, "type", None) == "fallback_message" for entry in iterations
    )


def _extract_response_text(response: Any) -> tuple[str, str]:
    """Return answer text and the reasoning trace.

    A `redacted_thinking` block carries no readable text (the API encrypts
    it), so it is folded into the trace as a placeholder rather than being
    silently counted as neither thinking nor text -- the gap the original
    two-case match left.
    """
    text_parts: list[str] = []
    thinking_parts: list[str] = []
    for block in response.content:
        match getattr(block, "type", None):
            case "thinking":
                thinking_parts.append(getattr(block, "thinking", ""))
            case "redacted_thinking":
                thinking_parts.append("[redacted_thinking]")
            case "text":
                block_text: str = getattr(block, "text", "")
                text_parts.append(block_text)
    return "".join(text_parts), "".join(thinking_parts)


def _record_thinking_trace(
    config: PipelineConfig,
    *,
    pmid: str,
    thinking: str,
    attempt: int,
    accepted: bool,
    model: str | None = None,
) -> None:
    """Persist the reasoning trace to the audit event log, capped in size.

    One event per *response*, not per paper. A validation retry re-sends
    the paper, and the second response reasons again: two events for one
    PMID, identical in shape, with nothing saying which of them produced
    the genes that were stored. So both are kept -- a discarded attempt's
    reasoning is the interesting one when a paper needed a retry -- and
    both say which they are. ``attempt`` is 1-based over the calls this run
    made for this PMID (the batch path makes exactly one), and ``accepted``
    is whether this response's tool call parsed into the genes the run went
    on to store.

    Scientific caveat, and it is load-bearing: an extended-thinking block is
    not a verified causal account of how the model reached its answer.
    Presenting one as "the reason this gene was extracted" is a claim this
    pipeline cannot defend -- source_quote remains the cited evidence. This
    is stored as an audit trail -- what the run produced, retained for
    inspection -- and is never published: no data/*.json key, no
    lib/types.ts field. The event log is the right home for that distinction:
    it is already documented as "payloads are for human audit, not
    round-trip typed," and `config.event_db_path` already keeps it out of
    Postgres and out of anything the export reads.
    """
    if not thinking:
        return
    thinking_chars = len(thinking)
    with EventLog(config.event_db_path) as event_log:
        event_log.record(
            "paper_extraction_thinking",
            {
                "pmid": pmid,
                "thinking": thinking[:_MAX_THINKING_CHARS_LOGGED],
                "thinking_chars": thinking_chars,
                "truncated": thinking_chars > _MAX_THINKING_CHARS_LOGGED,
                "attempt": attempt,
                "accepted": accepted,
                # Under the fallback this is Opus 4.8's reasoning, not 5.5's.
                "model": model,
            },
        )


def _account_reasoning(response: Any, usage: TokenUsage | None) -> tuple[str, str]:
    """Split one response into answer text and reasoning trace, and charge
    the trace its share of the output tokens when the API did not.

    The API reports the split in `usage.output_tokens_details`, and
    accumulate_usage has already taken it from there; this adds nothing
    then. Only a response that reports none is estimated, from the
    character ratio of its thinking and text blocks, and the estimate is
    poor: the tool call's JSON -- most of an extraction's output -- is in
    neither, so its tokens are charged to thinking in proportion. Over the
    seven Opus 5 golden cassettes it gave 55,631 thinking tokens where the
    API reported 24,958. *This* response's own output tokens, not the
    accumulated total: ``usage`` carries every attempt of a retried paper,
    and applying one response's thinking ratio to all of them overstated
    the estimate by the earlier attempts' whole output.

    ``usage`` is optional because a caller parsing batch results on its own
    may not be counting; the split is returned either way. Shared with
    ``batch_extraction`` so a ``--batch`` run stops publishing
    ``thinkingTokens: 0`` beside a real output count.
    """
    text_content, thinking_text = _extract_response_text(response)
    response_usage = getattr(response, "usage", None)
    if usage is None or reported_thinking_tokens(response_usage) is not None:
        return text_content, thinking_text
    thinking_chars = len(thinking_text)
    total_chars = thinking_chars + len(text_content)
    response_output = response_usage.output_tokens if response_usage else 0
    if total_chars > 0 and response_output > 0:
        usage.thinking_tokens += int(response_output * thinking_chars / total_chars)
    return text_content, thinking_text


async def _release_reservation(
    rate_limiter: AsyncRateLimiter | None,
    request_id: int | None,
) -> None:
    """Release a failed call's pre-reserved token budget, when present."""
    if rate_limiter is not None and request_id is not None:
        await rate_limiter.record_actual_usage(request_id, 0)


def _build_message_params(
    text: str,
    pmid: str,
    config: PipelineConfig,
    *,
    model: str | None = None,
) -> dict[str, Any]:
    """Build message parameters shared by streaming and batch requests.

    *model* names a model other than the pinned one, for a request sent
    straight to the fallback model; it changes the `model` field and
    nothing else, so the request the fallback reads is the one the
    requested model would have read.
    """
    prompt = build_extraction_prompt(
        paper_text=text,
        pmid=pmid,
        max_chars=config.max_paper_text_chars,
        prompt_version=config.prompt_version,
    )
    # thinking, the tool and output_config all live on config, shared with
    # the batch path, so the two cannot drift apart — see
    # PipelineConfig.thinking_config for what happened when only the schema
    # was shared.
    kwargs: dict[str, Any] = {
        "model": model or config.llm_model,
        "max_tokens": config.llm_max_tokens,
        "system": [
            {
                "type": "text",
                "text": prompt.system_prompt,
                "cache_control": {"type": "ephemeral", "ttl": "1h"},
            },
            {
                "type": "text",
                "text": prompt.extraction_instructions,
                "cache_control": {"type": "ephemeral", "ttl": "1h"},
            },
        ],
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "document",
                        "source": {
                            "type": "text",
                            "media_type": "text/plain",
                            "data": prompt.document_text,
                        },
                        "title": f"PMID {pmid}",
                        # Legal only because the schema moved off
                        # output_config.format: citations beside it are
                        # a 400. Offsets index the document block's
                        # bytes, which is why document_text carries no
                        # wrapper.
                        "citations": {"enabled": True},
                    },
                    {"type": "text", "text": prompt.task_instruction},
                ],
            }
        ],
        "thinking": config.thinking_config,
        "tools": [config.extraction_tool],
        # auto, not a forced call: citations attach to text blocks, and a
        # forced tool call emits none. Probed -- forcing the call returns
        # 200 with zero citation objects.
        "tool_choice": {"type": "auto"},
        # Always present: Claude Opus 5.5 defaults to "medium", so leaving
        # effort out is not the same as asking for "high".
        "output_config": config.output_config,
    }
    return kwargs


def _document_text(stream_kwargs: dict[str, Any]) -> str:
    """The paper text as the document block carried it.

    build_extraction_prompt truncates to max_paper_text_chars, so this is
    not the same string the caller passed extract(). Citation offsets index
    the block's bytes, and locate_quote's offsets have to mean the same
    thing, so both read the request rather than the source.

    Indexed rather than searched: _build_message_params is the only producer
    of this payload and always puts the document block first. A search with
    an empty-string fallback would be an untested branch guarding a shape
    this module controls, and it would fail in the worst direction -- every
    quote reported as non-verbatim, and under require_verified_quotes every
    gene silently dropped. A KeyError says what went wrong.
    """
    return stream_kwargs["messages"][0]["content"][0]["source"]["data"]


@dataclass(slots=True)
class _PaperCalls:
    """What the calls `extract` has sent for one paper established.

    `sent` labels each response's reasoning trace in the audit log.
    `declined` is the classifier that declined the requested model on an
    earlier call: once a paper falls back, the API answers its next
    requests from the fallback model directly for about an hour (sticky
    routing), with no `fallback` block, because the requested model never
    ran. So a validation retry Opus 4.8 serves learns why the paper is on
    Opus 4.8 from here or not at all -- read off that response alone, a
    paper Opus 5.5 declined as `bio` was recorded as declined by "a safety
    classifier".

    `direct` is a paper sent straight to a model other than the requested
    one -- the fallback, for a paper the requested model already declined
    on another path (a batch entry), or in a refusal the server-side
    fallback did not answer (`extract` sets it mid-loop then). Its calls
    carry no `fallbacks`, so every retry stays on that model, and
    `declined` is seeded with the decline that sent it there: the answer
    itself has no `fallback` block or `fallback_message` iteration to read
    one from.
    """

    sent: int = 0
    declined: str | None = None
    direct: bool = False


async def _stream_and_parse(
    client: anthropic.AsyncAnthropic,
    stream_kwargs: dict[str, Any],
    usage: TokenUsage,
    *,
    pmid: str,
    config: PipelineConfig,
    rate_limiter: AsyncRateLimiter | None,
    request_id: int | None,
    calls: _PaperCalls,
) -> tuple[list[GeneEntry], ServedBy]:
    """Consume one streamed response, account for it, and parse its genes.

    Returns the genes and who served them: the response's own `model`, and
    -- when a `fallback_message` iteration shows the fallback served it --
    the category of the classifier that declined the requested model.

    ``calls.sent`` is 1-based over the calls ``extract`` has made for
    this PMID, and only labels the audit event -- see
    _record_thinking_trace. ``calls.declined`` carries a decline this call
    learns of to the paper's next one, and supplies the one a sticky answer
    cannot name (see _PaperCalls).
    """
    stream_start = time.monotonic()
    # The fallback rides on this call rather than in the shared params: the
    # Batches API rejects `fallbacks`, so `_build_message_params` -- shared
    # with it, and what the golden cassettes' recorded bodies are compared
    # against -- must not carry it. The beta stream posts to the same
    # /v1/messages, so the cassettes, matched on method and URI, replay.
    # A direct request already names the fallback model, and has nowhere
    # further to fall back to: it sends neither the field nor its beta.
    fallback_kwargs: dict[str, Any] = (
        {}
        if calls.direct
        else {"betas": [FALLBACK_BETA], "fallbacks": [{"model": config.fallback_model}]}
    )
    async with client.beta.messages.stream(
        **stream_kwargs, **fallback_kwargs
    ) as stream:
        response = await stream.get_final_message()
    stream_elapsed = time.monotonic() - stream_start
    # The SDK owns its own transport, so no event hook fires for it. Without
    # this the External services panel omitted the extraction calls
    # entirely -- the dominant cost of every run.
    record_service_call(
        _ANTHROPIC_SERVICE,
        endpoint=_MESSAGES_ENDPOINT,
        method="POST",
        status=200,
        elapsed_ms=stream_elapsed * 1000.0,
    )

    # Every attempt, the declined one included: top-level usage covers only
    # the attempt that served the message (see accumulate_usage).
    delta = accumulate_usage(usage, response, fallback_model=config.fallback_model)
    if rate_limiter is not None and request_id is not None and response.usage:
        actual = delta.input_tokens + delta.output_tokens
        await rate_limiter.record_actual_usage(request_id, actual)

    # A declined request is a normal 200 whose content is not an
    # extraction. Treating it as one would burn the validation-retry budget
    # reporting a missing tool call, so the check has to come before
    # _extract_response_text. With the server-side fallback on, a refusal
    # here means one of three things: every model in the chain declined --
    # Opus 5.5, then Opus 4.8 -- or the fallback could not be attempted
    # (rate-limited), or the decline arrived with the tool call already on
    # the stream, which the API returns directly (see fallback.md). Only
    # the first is the fallback's verdict, and `fallback_declined` says
    # which: `extract` sends a paper the fallback never saw straight to it,
    # and lets the rest fail so that the next run retries them.
    if response.stop_reason == "refusal":
        category = _refusal_category(response)
        # Set only when the fallback could not be attempted (its model was
        # rate-limited or overloaded): then only the requested model ran,
        # which is a different fact from both declining, and a retry is
        # worth paying for.
        recommended = getattr(
            getattr(response, "stop_details", None), "recommended_model", None
        )
        skipped = (
            f"; the fallback was not attempted (recommended model: {recommended})"
            if isinstance(recommended, str) and recommended
            else ""
        )
        also = _fallback_declined_too(response)
        # The message gives each model its own reason. `category` is what
        # the run groups by, and with no category on the first hop it falls
        # through to the fallback's, which `also` already names.
        first = (
            (_declining_hop_category(response) or "unspecified") if also else category
        )
        fallback_declined = (
            bool(also)
            or calls.direct
            or _fallback_served(response, config.fallback_model)
        )
        # A refusal the fallback has not seen is not final: `extract` sends
        # the paper on, so it is a warning here and the paper may well
        # succeed. One the fallback declined, or that was already the
        # fallback's own request, ends it.
        logger.log(
            logging.ERROR if fallback_declined else logging.WARNING,
            f"Request refused by safety classifier for PMID {pmid} "
            f"(category: {first}){also}{skipped}",
        )
        raise ExtractionRefusedError(
            f"Refused by safety classifier for PMID {pmid} "
            f"(category: {first}){also}{skipped}",
            usage,
            category=category,
            fallback_declined=fallback_declined,
        )

    # Truncation is a deterministic token-budget problem, so retrying the
    # identical request cannot help.
    if response.stop_reason == "max_tokens":
        used = response.usage.output_tokens if response.usage else "?"
        logger.error(
            f"Response truncated for PMID {pmid} "
            f"(stop_reason=max_tokens, "
            f"output_tokens={used}/{config.llm_max_tokens}). "
            f"Raise PIPELINE_LLM_MAX_TOKENS or reduce effort level."
        )
        usage.truncated_responses = 1
        raise ExtractionFailedError(f"Response truncated for PMID {pmid}", usage)

    # Who served it is read off the whole response (the iterations and the
    # fallback blocks); what it said, off the serving hop alone.
    served = _served_by(
        response, declined_earlier=calls.declined, direct=calls.direct
    )
    if served.declined is not None:
        calls.declined = served.declined
    response = _serving_hop(response, pmid=pmid)
    text_content, thinking_text = _account_reasoning(response, usage)

    tokens_per_second = (
        usage.output_tokens / stream_elapsed if stream_elapsed > 0 else 0
    )
    logger.info(
        f"  LLM stream: {stream_elapsed:.1f}s, "
        f"{usage.output_tokens:,} output tokens "
        f"(~{usage.thinking_tokens:,} thinking + "
        f"~{usage.text_output_tokens:,} text), "
        f"{tokens_per_second:.0f} tok/s"
    )

    # The trace is written whichever way the parse goes, labelled with this
    # attempt's number and whether it was the accepted one: a validation
    # retry appends a second event for the same PMID, and unlabelled they
    # said nothing about which produced the stored genes.
    accepted = False
    try:
        # list[Any]: the blocks are duck-typed on both sides -- the SDK
        # returns a 13-member content-block union with no shared `input`,
        # and the tests hand in their own stand-ins.
        tool_blocks = _extraction_tool_blocks(response)
        if not tool_blocks:
            # tool_choice is "auto", so a turn that answers in prose without
            # calling the tool is possible. It is a retryable malformed
            # response, not a refusal and not an empty one.
            raise ValueError(
                f"No {EXTRACTION_TOOL_NAME} tool call in response for PMID {pmid}"
            )

        # After the tool-block check, not before: with tool_choice "auto" the
        # model may legitimately emit little prose, so empty text is only a
        # fault when the tool call is missing too.
        if not text_content.strip():
            logger.warning(f"Empty text response for PMID {pmid}")

        genes = _merge_tool_blocks(tool_blocks, pmid=pmid, model=response.model)
        accepted = True
    finally:
        _record_thinking_trace(
            config,
            pmid=pmid,
            thinking=thinking_text,
            attempt=calls.sent,
            accepted=accepted,
            model=response.model,
        )
    if len(tool_blocks) > 1:
        logger.warning(
            f"  {len(tool_blocks)} {EXTRACTION_TOOL_NAME} calls in one response "
            f"for PMID {pmid}; merged into {len(genes)} gene(s)"
        )
    logger.info(f"Extracted {len(genes)} gene(s) from PMID {pmid}")

    # Read back out of the request rather than from the caller's `text`:
    # that one is the untruncated paper, and offsets are only meaningful
    # against the bytes the document block actually carried.
    genes = report_provenance(
        genes,
        spans=collect_spans(response),
        document=_document_text(stream_kwargs),
        pmid=pmid,
        require_verified_quotes=config.require_verified_quotes,
    )
    return genes, served


def _served_by(
    response: Any, *, declined_earlier: str | None = None, direct: bool = False
) -> ServedBy:
    """Who produced a response that was not a refusal.

    The served-by signal is a `fallback_message` entry in
    `usage.iterations`, not the `fallback` block (a sticky-served turn has
    none); the model is the response's top-level `model`, which names the
    model that produced the message. Only a fallback-served response has a
    declined hop to report: its block's category, or -- on a sticky turn,
    which has no block -- *declined_earlier*, the category an earlier call
    for the same paper saw. With neither, "unspecified": the paper fell
    back before this run, and nothing here saw why.

    A *direct* request was sent to the fallback model by name, so its
    answer carries neither signal; it is the fallback's by construction,
    and *declined_earlier* is the decline the caller said sent it there.
    """
    if direct:
        return ServedBy(
            model=response.model, declined=declined_earlier or "unspecified"
        )
    iterations = getattr(getattr(response, "usage", None), "iterations", None)
    fell_back = isinstance(iterations, list) and any(
        getattr(entry, "type", None) == "fallback_message" for entry in iterations
    )
    declined = _declining_hop_category(response) if fell_back else None
    if fell_back and declined is None:
        declined = declined_earlier or "unspecified"
    return ServedBy(model=response.model, declined=declined)


def _extraction_tool_blocks(response: Any) -> list[Any]:
    """Return every extraction tool call in a message response."""
    return [
        block
        for block in response.content
        if getattr(block, "type", None) == "tool_use"
        and getattr(block, "name", None) == EXTRACTION_TOOL_NAME
    ]


def _decoded_input(raw: Any) -> Any:
    """The tool input, with a JSON-encoded `genes` value decoded.

    Claude Opus 4.8 -- the fallback model -- answered the golden fixtures'
    first paper with `{"genes": "<JSON string>"}`, the whole object
    encoded into its one field (2026-11-03). The tool is deliberately not
    strict (see `extraction_tool` in config.py), so the decoder does not
    stop it, and validating it raw sent the paper into the validation
    retry, which paid for the same shape again. A string that decodes to
    the object, or to the list, is exactly what the schema asks for; any
    other string is left alone to fail validation as before.
    """
    if not isinstance(raw, dict) or not isinstance(raw.get("genes"), str):
        return raw
    try:
        decoded = json.loads(raw["genes"])
    except json.JSONDecodeError:
        return raw
    if isinstance(decoded, dict) and set(decoded) == {"genes"}:
        return decoded
    if isinstance(decoded, list):
        return {**raw, "genes": decoded}
    return raw


def _merge_tool_blocks(
    tool_blocks: list[Any], *, pmid: str, model: str | None
) -> list[GeneEntry]:
    """Parse every report_genes call in the turn into one gene list.

    tool_choice is "auto" and parallel tool use is on by default, so one
    turn can carry more than one call -- the main text's genes in one and
    a supplementary table's in another. Reading only the first silently
    dropped the rest. Each block is validated on its own so a malformed
    second block still fails the whole turn into the validation retry.

    *model* is the response's own, named only in the log line a decoded
    input leaves: how often each model double-encodes is a measurement,
    and an input repaired without a trace measured nothing.
    """
    genes: list[GeneEntry] = []
    for block in tool_blocks:
        tool_input = _decoded_input(block.input)
        if tool_input is not block.input:
            logger.warning(
                f"  Decoded a JSON-encoded genes value from "
                f"{model or 'an unnamed model'} for PMID {pmid}"
            )
        genes.extend(ExtractionResult.model_validate(tool_input).genes)
    # Ignore any PMID supplied by the model in favor of the caller's value.
    for gene in genes:
        gene.pmid = pmid
    return genes


def _is_retryable_status_error(error: anthropic.APIError) -> bool:
    """Whether an API error is the stream breaking rather than a verdict.

    Two shapes qualify. A 529 arrives as `OverloadedError`, the one status
    Anthropic documents as retryable, after the SDK's own retries. And an
    SSE `error` event mid-stream -- `overloaded_error` eight minutes into a
    paper is the common one -- is raised by the SDK through
    `_make_status_error` with the *stream's* response, which is the 200
    that opened it: a bare `APIStatusError` whose `status_code` is 200.
    Both used to land in the generic API-error branch as fatal, and the
    second was recorded as a clean 200 call.
    """
    if isinstance(error, anthropic.OverloadedError):
        return True
    return isinstance(error, anthropic.APIStatusError) and error.status_code == 200


async def _retry_rate_limit(
    error: anthropic.RateLimitError,
    retry_count: int,
    *,
    pmid: str,
    config: PipelineConfig,
    usage: TokenUsage,
    rate_limiter: AsyncRateLimiter | None,
) -> int:
    """Back off after a rate limit, or raise when its retry budget is spent."""
    record_service_call(
        _ANTHROPIC_SERVICE, endpoint=_MESSAGES_ENDPOINT, method="POST", status=429
    )
    retry_count += 1
    if retry_count > config.max_rate_limit_retries:
        logger.error(
            f"Rate limit retries exhausted for PMID {pmid} "
            f"({retry_count}/{config.max_rate_limit_retries})"
        )
        raise ExtractionFailedError(
            f"Rate limit retries exhausted for PMID {pmid}", usage
        ) from error

    backoff_delay = compute_backoff(config.rate_limit_retry_delay, retry_count)
    retry_after = error.response.headers.get("retry-after") if error.response else None
    delay, delay_source = resolve_retry_delay(retry_after, backoff_delay)
    logger.warning(
        f"Rate limited on PMID {pmid}. "
        f"Waiting {delay:.1f}s ({delay_source}) "
        f"(rate limit retry {retry_count}/{config.max_rate_limit_retries})..."
    )
    if rate_limiter is not None:
        await rate_limiter.signal_rate_limit(delay)
    note_service_retry(_ANTHROPIC_SERVICE, endpoint=_MESSAGES_ENDPOINT, method="POST")
    await asyncio.sleep(delay)
    return retry_count


async def _retry_connection(
    error: Exception,
    retry_count: int,
    *,
    pmid: str,
    config: PipelineConfig,
    usage: TokenUsage,
) -> int:
    """Back off after a connection failure, or raise when retries are spent."""
    # No status to report: the connection failed or the stream broke off.
    # Counted as a call so the panel's total agrees with what was sent, and
    # as an error, because it was one -- `status=None` reads as success to
    # the recorder, so four failed attempts used to publish as four clean
    # calls with three retries beside them.
    record_service_failure(
        _ANTHROPIC_SERVICE, endpoint=_MESSAGES_ENDPOINT, method="POST"
    )
    retry_count += 1
    if retry_count > config.max_connection_retries:
        logger.error(
            f"Connection retries exhausted for PMID {pmid} "
            f"({retry_count}/{config.max_connection_retries}): {error}"
        )
        raise ExtractionFailedError(
            f"Connection retries exhausted for PMID {pmid}: {error}", usage
        ) from error

    delay = compute_backoff(config.connection_retry_delay, retry_count)
    logger.warning(
        f"Connection error on PMID {pmid}: {error!r}. "
        f"Retrying in {delay:.1f}s "
        f"(connection retry {retry_count}/{config.max_connection_retries})..."
    )
    note_service_retry(_ANTHROPIC_SERVICE, endpoint=_MESSAGES_ENDPOINT, method="POST")
    await asyncio.sleep(delay)
    return retry_count


def _retry_validation(
    error: Exception,
    retry_count: int,
    *,
    pmid: str,
    config: PipelineConfig,
    usage: TokenUsage,
) -> int:
    """Record a schema retry, or raise when its retry budget is spent."""
    retry_count += 1
    if retry_count > config.max_retries:
        logger.error(
            f"Validation retries exhausted for PMID {pmid} "
            f"({retry_count}/{config.max_retries}): {error}"
        )
        raise ExtractionFailedError(
            f"Validation retries exhausted for PMID {pmid}: {error}", usage
        ) from error
    logger.warning(
        f"Validation retry {retry_count}/{config.max_retries} for PMID {pmid}: {error}"
    )
    return retry_count


# ---------------------------------------------------------------------------
# CLIENT
# ---------------------------------------------------------------------------


def build_async_client() -> anthropic.AsyncAnthropic:
    """Build the SDK client, honouring an identity-linked API key.

    An identity-linked key does not imply a workspace, so the API rejects
    every request with a 400 -- "anthropic-workspace-id is required" --
    until one is named. The SDK reads ANTHROPIC_WORKSPACE_ID only on its
    Workload-Identity path: with ANTHROPIC_API_KEY set, the credential
    chain short-circuits before reaching it (step 2a in the SDK's
    lib/credentials/_chain.py: the client sends the key itself, so it
    "doesn't flow through this chain"), and the client takes no workspace
    argument. That holds on anthropic 2.x, where the key itself now goes
    out as `Authorization: Bearer`. So the workspace has to travel as a
    request header instead.

    Unset is the normal case -- a workspace-scoped key carries its own
    workspace -- and then no header is sent at all.

    Raising here rather than letting the SDK fail keeps the message on the
    thing an operator actually has to fix, several frames earlier.

    **`max_retries` is left at the SDK's default of 2, and that is a
    decision.** The SDK retries 408, 409, 429 and every 5xx inside
    `client.send()`, before any pipeline branch runs, so those attempts are
    counted neither as calls nor as retries -- see the note on
    `_ANTHROPIC_SERVICE`. Setting it to 0 would make the inventory exact,
    and it is not done because the pipeline's own retry paths do not cover
    the same ground: `_is_retryable_status_error` retries only 529 and the
    mid-stream 200, so a 500 or 503 would become fatal on the first
    attempt, and `messages.batches.retrieve` -- polled for up to 24 hours
    with no retry wrapper at all -- would abort a submitted batch on one
    transient 502. Buying exact telemetry with lost papers is the wrong
    trade; the undercount is documented instead, in
    `.claude/rules/pipeline/api-telemetry.md`.
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise ExtractionFailedError(
            "ANTHROPIC_API_KEY is required to use the Anthropic API. "
            "Set it in .env before running the pipeline."
        )
    workspace = os.getenv("ANTHROPIC_WORKSPACE_ID", "").strip()
    return anthropic.AsyncAnthropic(
        default_headers={"anthropic-workspace-id": workspace} if workspace else None
    )


# Long enough for a request that generates nothing, short enough that a hung
# connection costs a minute of the run rather than the SDK's ten.
_WARMUP_TIMEOUT_SECONDS = 60


async def prewarm_cache(config: PipelineConfig) -> TokenUsage:
    """Write the shared prompt prefix once, before the papers fan out.

    A cache entry becomes readable only after the first response starts, so
    the papers launched together at the start of a run each wrote the same
    large prefix (tools and both system blocks) at the write rate. One
    request with `max_tokens: 0` writes it and generates nothing, and every
    paper after it reads.

    The request is `_build_message_params`' own, with a placeholder document,
    because two things besides the system blocks shape the cached prefix --
    the citations toggle on the document block and the set of beta headers --
    and a warm-up that differed in either would warm an entry no extraction
    reads. It therefore sends the same `betas` and `fallbacks` the stream
    call does. It is not streamed, because the API rejects `max_tokens: 0`
    with `stream: true`.

    Bounded to `_WARMUP_TIMEOUT_SECONDS` with no SDK retries, through
    `with_options`: the client's own 600 s timeout and two retries could
    hold a run for half an hour before any paper started, for a saving.

    Never raises (cancellation aside): a warm-up that fails costs the
    saving, not the run, so it logs one warning and returns an empty
    `TokenUsage`, whatever the error -- an `anthropic.APIError`, a missing
    key, or something nobody anticipated in a response it could not read.
    A request that was sent and failed is recorded as a failed Anthropic
    call, as the streaming path records one, so the run report shows it
    beside the log line. One the API answered is recorded as the 200 it was
    and accounted like any other call, so the cache write is priced and
    reported rather than hidden; if its usage then cannot be read, one
    warning says so and the tokens are not counted, but the call is not
    recorded as a failure.
    """
    params = _build_message_params("warmup", "warmup", config)
    params["max_tokens"] = 0
    usage = TokenUsage()
    client: anthropic.AsyncAnthropic | None = None
    start = time.monotonic()
    try:
        client = build_async_client()
        response = await client.with_options(
            timeout=_WARMUP_TIMEOUT_SECONDS, max_retries=0
        ).beta.messages.create(
            **params,
            betas=[FALLBACK_BETA],
            fallbacks=[{"model": config.fallback_model}],
        )
        elapsed_ms = (time.monotonic() - start) * 1000.0
    except Exception as error:
        if isinstance(error, anthropic.APIStatusError):
            record_service_call(
                _ANTHROPIC_SERVICE,
                endpoint=_MESSAGES_ENDPOINT,
                method="POST",
                status=error.status_code,
            )
        elif client is not None:
            # Sent, or tried to be, with no status to show: a timeout, a
            # dropped connection, an answer that could not be read.
            record_service_failure(
                _ANTHROPIC_SERVICE, endpoint=_MESSAGES_ENDPOINT, method="POST"
            )
        logger.warning(
            f"Cache warm-up failed ({type(error).__name__}: {error}); "
            "the papers will each write the prompt cache themselves"
        )
        return TokenUsage()
    finally:
        if client is not None:
            await client.close()
    # The API answered and wrote the cache, so the call is the 200 it was,
    # whatever the usage then turns out to look like.
    record_service_call(
        _ANTHROPIC_SERVICE,
        endpoint=_MESSAGES_ENDPOINT,
        method="POST",
        status=200,
        elapsed_ms=elapsed_ms,
    )
    try:
        accumulate_usage(usage, response, fallback_model=config.fallback_model)
    except Exception as error:
        logger.warning(
            "Cache warm-up was answered but its usage could not be read "
            f"({type(error).__name__}: {error}); its tokens are not counted"
        )
        return TokenUsage()
    return usage


def _priced(
    pricing: tuple[float, float],
    cache_read_multiplier: float,
    input_tokens: int,
    output_tokens: int,
    cache_write_tokens: int,
    cache_read_tokens: int,
) -> float:
    """USD for one model's share of a run's tokens."""
    input_price, output_price = pricing
    return (
        input_tokens * input_price
        + cache_write_tokens * input_price * _CACHE_WRITE_MULTIPLIER
        + cache_read_tokens * input_price * cache_read_multiplier
        + output_tokens * output_price
    ) / 1_000_000


class AnthropicClient:
    """Streaming Claude client for gene extraction."""

    def __init__(self) -> None:
        self._client: anthropic.AsyncAnthropic | None = None

    def _get_client(self) -> anthropic.AsyncAnthropic:
        """Lazily build the raw AsyncAnthropic client.

        Raw (not Instructor-wrapped) because we use the streaming API,
        which is required for adaptive-thinking requests that may exceed
        10 minutes of wall-clock time.
        """
        if self._client is None:
            self._client = build_async_client()
        return self._client

    async def close(self) -> None:
        """Close the underlying client. Idempotent."""
        if self._client is not None:
            await self._client.close()
            self._client = None

    def report_metadata(self, config: PipelineConfig) -> dict[str, Any]:
        return {
            "model": config.llm_model,
            # Named on both paths. A batch *entry* cannot fall back (the
            # Batches API rejects `fallbacks`), but a batch *run* sends each
            # paper the batch declined straight to this model, so a --batch
            # report that said null could carry papers it extracted.
            "fallback_model": config.fallback_model,
            "model_version": config.model_version,
            "thinking_mode": config.thinking_mode,
            "effort": config.llm_effort,
            "prompt_version": config.prompt_version,
            "disease": load_disease().key,
            "prompt_sha256": prompt_sha256(config.prompt_version),
        }

    def estimate_cost(self, usage: TokenUsage, *, batched: bool = False) -> float:
        """Cost of one run's token usage, in USD.

        Always a number now that the model is pinned: the old dict keyed
        off the configured model name and returned None on a miss, so a
        selectable model missing from it silently dropped the cost line out
        of the run report.

        ``batched`` applies the Message Batches API's 50% discount, which
        is the whole reason ``--batch`` exists and which the report could
        not show while the cost model did not know which path had run.
        """
        # Less the attempts the API reported and did not bill -- a refusal
        # before any output, outside the billed categories. Those are in
        # the totals and never in `fallback_*`, so they come off here
        # whichever model declined (see accumulate_usage).
        primary = _priced(
            MODEL_PRICING,
            _CACHE_READ_MULTIPLIER,
            usage.input_tokens
            - usage.fallback_input_tokens
            - usage.unbilled_input_tokens,
            usage.output_tokens - usage.fallback_output_tokens,
            usage.cache_creation_input_tokens
            - usage.fallback_cache_creation_input_tokens
            - usage.unbilled_cache_creation_input_tokens,
            usage.cache_read_input_tokens
            - usage.fallback_cache_read_input_tokens
            - usage.unbilled_cache_read_input_tokens,
        )
        # The totals hold both models; the fallback_* counts are Opus 4.8's
        # share, billed at its own rates. A batch entry never falls back, but
        # a batch run's papers rescued after a refusal are in this share.
        fallback = _priced(
            FALLBACK_MODEL_PRICING,
            _FALLBACK_CACHE_READ_MULTIPLIER,
            usage.fallback_input_tokens,
            usage.fallback_output_tokens,
            usage.fallback_cache_creation_input_tokens,
            usage.fallback_cache_read_input_tokens,
        )
        cost = primary + fallback
        return cost * _BATCH_MULTIPLIER if batched else cost

    async def extract(
        self,
        text: str,
        pmid: str,
        config: PipelineConfig,
        rate_limiter: AsyncRateLimiter | None,
        *,
        model: str | None = None,
        declined: str | None = None,
    ) -> tuple[list[GeneEntry], TokenUsage, ServedBy]:
        """Extract genes using Claude API with streaming and Pydantic validation.

        Uses the Anthropic streaming API (required for adaptive thinking
        when requests may exceed 10 minutes) with the extraction tool's
        schema, which is not `strict`, enforced by Pydantic validation and
        the validation retry.

        Args:
            text: Full text content of the paper.
            pmid: PubMed ID for context.
            config: Pipeline configuration.
            rate_limiter: Optional rate limiter for coordinated throttling.
            model: Send the paper straight to this model, with no
                `fallbacks` -- the fallback model, for a paper the requested
                model already declined on another path. None, every normal
                request, is the pinned model with the server-side fallback.
            declined: With *model*, the category of the decline that sent
                the paper there, which the returned ``served_by`` reports.

        A refusal the fallback model never saw -- the decline arrived with
        the tool call on the stream, which the API returns without falling
        back, or the fallback could not be attempted -- is not the end:
        the paper is sent once more, straight to the fallback model, as a
        direct request (see *model*), and every retry after that stays
        there. If the fallback declines it too, the `ExtractionRefusedError`
        keeps the first refusal's category and names both. A request the
        caller already sent to *model* is never sent on.

        Returns:
            Tuple of (gene_entries, token_usage, served_by). ``served_by``
            names Claude Opus 4.8 when Opus 5.5 declined and the server-side
            fallback extracted the paper instead, when a refusal it never
            saw was sent on to it, or when *model* sent it to Opus 4.8
            directly. ``token_usage`` holds every attempt, a refused one
            included.
        """
        usage = TokenUsage()
        client = self._get_client()
        stream_kwargs = _build_message_params(text, pmid, config, model=model)

        rate_limit_retries = 0
        validation_retries = 0
        connection_retries = 0
        # Every call sent for this paper, whatever sent it again, and the
        # decline the first fallback named -- or, for a direct request, the
        # one the caller says sent it (see _PaperCalls).
        calls = (
            _PaperCalls(declined=declined, direct=True)
            if model is not None
            else _PaperCalls()
        )
        # The category of the refusal that sent this paper to the fallback
        # model mid-loop; set at most once, and never for a request the
        # caller already sent there.
        rescued_from: str | None = None

        while True:
            request_id: int | None = None
            try:
                if rate_limiter is not None:
                    request_id = await rate_limiter.acquire(
                        estimated_tokens=config.estimated_tokens_per_call
                    )
                calls.sent += 1
                genes, served = await _stream_and_parse(
                    client,
                    stream_kwargs,
                    usage,
                    pmid=pmid,
                    config=config,
                    rate_limiter=rate_limiter,
                    request_id=request_id,
                    calls=calls,
                )
                return genes, usage, served

            # Ahead of ExtractionFailedError, which it subclasses. The
            # refused call settled its own reservation in _stream_and_parse
            # (a refusal is a 200 whose usage was recorded), so there is
            # nothing to release; the rescue acquires one of its own.
            except ExtractionRefusedError as e:
                if rescued_from is not None:
                    # The fallback has now declined it too. Grouped under
                    # the requested model's classifier, as the batch rescue
                    # groups its own, with the fallback's named beside it.
                    raise ExtractionRefusedError(
                        f"Refused by safety classifier for PMID {pmid} "
                        f"(category: {rescued_from}; {config.fallback_model} "
                        f"also declined: {e.category})",
                        usage,
                        category=rescued_from,
                        fallback_declined=True,
                    ) from e
                if e.fallback_declined or calls.direct:
                    raise
                # Only the requested model has seen this paper: the
                # server-side fallback did not run. Send it straight to the
                # fallback, once, as a direct request -- every later retry
                # stays there, with no `fallbacks` and no beta header.
                logger.warning(
                    f"PMID {pmid} was refused (category: {e.category}) with no "
                    f"fallback attempt; sending it straight to "
                    f"{config.fallback_model}"
                )
                rescued_from = e.category
                stream_kwargs = _build_message_params(
                    text, pmid, config, model=config.fallback_model
                )
                calls.direct = True
                calls.declined = e.category

            except anthropic.RateLimitError as e:
                await _release_reservation(rate_limiter, request_id)
                rate_limit_retries = await _retry_rate_limit(
                    e,
                    rate_limit_retries,
                    pmid=pmid,
                    config=config,
                    usage=usage,
                    rate_limiter=rate_limiter,
                )

            # The SDK wraps a failure to *open* the request in
            # APIConnectionError, but with stream=True it returns as soon
            # as the headers arrive and the body is read by
            # get_final_message(), where a disconnect or read timeout
            # surfaces as a raw httpx2 exception -- httpx2, the package the
            # SDK is built on, not the httpx the pipeline pins for its own
            # clients. The two are unrelated classes, so naming httpx's
            # here matched nothing the SDK can raise, and the one failure a
            # ten-minute stream is exposed to fell through to the generic
            # branch with zero retries.
            except (anthropic.APIConnectionError, httpx2.TransportError) as e:
                await _release_reservation(rate_limiter, request_id)
                connection_retries = await _retry_connection(
                    e,
                    connection_retries,
                    pmid=pmid,
                    config=config,
                    usage=usage,
                )

            except ValueError as e:
                validation_retries = _retry_validation(
                    e,
                    validation_retries,
                    pmid=pmid,
                    config=config,
                    usage=usage,
                )

            except anthropic.APIError as e:
                # Released on every failing branch, not only the two that
                # retry: the reservation is estimated_tokens_per_call in
                # the TPM window, and a burst of five failed papers left
                # the window full for the next minute with no log line.
                await _release_reservation(rate_limiter, request_id)
                if _is_retryable_status_error(e):
                    connection_retries = await _retry_connection(
                        e,
                        connection_retries,
                        pmid=pmid,
                        config=config,
                        usage=usage,
                    )
                    continue
                record_service_call(
                    _ANTHROPIC_SERVICE,
                    endpoint=_MESSAGES_ENDPOINT,
                    method="POST",
                    status=getattr(e, "status_code", None),
                )
                logger.error(f"Claude API error for PMID {pmid}: {e}")
                raise ExtractionFailedError(
                    f"Claude API error for PMID {pmid}: {e}", usage
                ) from e

            except ExtractionFailedError:
                raise

            except Exception as e:
                await _release_reservation(rate_limiter, request_id)
                logger.error(f"Extraction failed for PMID {pmid}: {e}")
                raise ExtractionFailedError(
                    f"Extraction failed for PMID {pmid}: {e}", usage
                ) from e
