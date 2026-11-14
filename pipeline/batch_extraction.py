"""Batch API submission for gene extraction.

Half the price of the streaming path, and this pipeline is offline and
manual so the latency costs nothing. Caching uses the 1-hour TTL: the
5-minute default would expire partway through a batch.
"""

import asyncio
import hashlib
import json
import logging
import time
from datetime import datetime
from typing import Any, cast

import anthropic
import httpx2
from anthropic.types.messages import batch_create_params

from pipeline import batch_state, checkpoint
from pipeline.anthropic_client import (
    _account_reasoning,
    _build_message_params,
    _document_text,
    _extraction_tool_blocks,
    _merge_tool_blocks,
    _record_thinking_trace,
    _refusal_category,
    build_async_client,
)
from pipeline.api_telemetry import record_service_call
from pipeline.batch_state import PendingBatch
from pipeline.citations import collect_spans, paper_scope, report_provenance
from pipeline.config import EXTRACTION_TOOL_NAME, PipelineConfig
from pipeline.extraction_models import ExtractionFailedError, GeneEntry
from pipeline.quality_metrics import TokenUsage, accumulate_usage
from pipeline.rate_limiter import compute_backoff

logger = logging.getLogger(__name__)

_POLL_SECONDS = 30

# Anthropic's published target is that a batch completes within 24 hours,
# and the API expires a batch that has not after 24 hours (results stay
# retrievable for 29 days). Polling past that is waiting on something that
# will not happen, so the loop gives up there instead of running forever on
# an unattended machine.
_MAX_WAIT_SECONDS = 24 * 60 * 60

# The Message Batches API takes at most 256 MB or 100,000 requests in one
# batch, whichever comes first, and answers more with a 413. Every request
# repeats the system prompt and the tool schema beside its paper, so a long
# window passes the size limit long before the count. The byte ceiling
# leaves room for what the measure below does not see (the envelope, and
# any difference in how the SDK serializes).
_MAX_BATCH_BYTES = 200 * 1024 * 1024
_MAX_BATCH_REQUESTS = 100_000

# A create the API refused outright (429, 529) made no batch, so it is sent
# again, this many times in all, backing off from this many seconds.
_CREATE_ATTEMPTS = 4
_CREATE_RETRY_SECONDS = 5.0

# How often the results of an ended batch are read again from the start
# when the read breaks off, and the pause between two reads.
_FETCH_ATTEMPTS = 3
_FETCH_RETRY_SECONDS = 5.0


def _is_transient(error: BaseException) -> bool:
    """Whether *error* is the API being out of reach rather than a verdict.

    A connection that failed or timed out, a read that broke off (raw
    `httpx2`, see `AnthropicClient.extract`), a 5xx, a 408 or a 429. A 404,
    an authentication failure and every other 4xx say something about the
    request, and waiting does not change them.
    """
    if isinstance(error, (anthropic.APIConnectionError, httpx2.TransportError)):
        return True
    if isinstance(error, anthropic.APIStatusError):
        return error.status_code >= 500 or error.status_code in (408, 429)
    return False


def _chunk_requests(requests: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """*requests* in order, split into batches the API will accept.

    Each holds at most `_MAX_BATCH_BYTES` of serialized requests and
    `_MAX_BATCH_REQUESTS` of them, and at least one: a single request over
    the ceiling is sent alone, for the API to judge. The size is measured
    with ASCII escapes, an upper bound on any UTF-8 encoding of it.
    """
    chunks: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    size = 0
    for request in requests:
        request_size = len(json.dumps(request))
        if current and (
            size + request_size > _MAX_BATCH_BYTES
            or len(current) >= _MAX_BATCH_REQUESTS
        ):
            chunks.append(current)
            current, size = [], 0
        current.append(request)
        size += request_size
    if current:
        chunks.append(current)
    return chunks


async def _create_batch(client: Any, requests: list[dict[str, Any]]) -> Any:
    """Submit one batch, never twice.

    Creating a batch is not idempotent and the SDK sends no idempotency
    key, so its own retries are turned off for this one call: when the API
    accepted the batch and the answer was lost (a timeout or a reset while
    a body of tens of megabytes was acknowledged, a gateway's 5xx), the
    SDK sent it again, and the first batch ran and was billed with its id
    recorded nowhere. A 429 or a 529 is the API saying it took nothing, so
    those are sent again here. Any other failure whose outcome is unknown
    raises ExtractionFailedError, for a person to look before paying twice.
    A 4xx is the request's own fault and is raised as it is.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            return await client.with_options(max_retries=0).messages.batches.create(
                requests=cast(list[batch_create_params.Request], requests)
            )
        except (anthropic.RateLimitError, anthropic.OverloadedError) as error:
            if attempt >= _CREATE_ATTEMPTS:
                raise
            delay = compute_backoff(_CREATE_RETRY_SECONDS, attempt)
            logger.warning(
                "The API did not take the batch (%s); submitting it again in "
                "%.1fs (attempt %d/%d)",
                type(error).__name__,
                delay,
                attempt + 1,
                _CREATE_ATTEMPTS,
            )
            await asyncio.sleep(delay)
        except (anthropic.APIConnectionError, anthropic.APIStatusError) as error:
            if not _is_transient(error):
                raise
            raise ExtractionFailedError(
                f"Submitting a batch of {len(requests)} papers failed with no "
                f"answer from the API ({type(error).__name__}). The batch may "
                "have been created, and is billed if it was: look for one "
                "submitted at this time in the Console's batch list before "
                "re-running, since a re-run submits these papers again."
            ) from error


def _error_detail(result: Any) -> str:
    """The API's own account of why one entry failed, when it gave one.

    Only an ``errored`` result carries an ``error`` payload -- expired and
    canceled ones genuinely have none, hence the getattr -- and it is the
    whole diagnosis when a request-level rejection applies to every entry
    (an oversized document block, an invalid parameter after an SDK
    upgrade). Without it the run log said only "errored" over every paper
    in the batch, and the operator's only move was to re-submit and pay
    for the same rejection again.
    """
    error = getattr(getattr(result, "error", None), "error", None)
    if error is None:
        return ""
    return f" ({getattr(error, 'type', None)}: {getattr(error, 'message', None)})"


def _parse_batch_genes(message: Any, *, custom_id: str) -> list[GeneEntry] | None:
    """Parse one succeeded entry's tool calls, or None when there are none
    to parse.

    None is a dropped paper. There is no retry on this path -- the batch
    has already run -- so a missing tool call and an unparseable one are
    both logged and skipped rather than re-sent.
    """
    tool_blocks = _extraction_tool_blocks(message)
    if not tool_blocks:
        # tool_choice is "auto", so a turn can answer in prose without
        # calling the tool.
        logger.warning(
            "No %s tool call in batch entry %s", EXTRACTION_TOOL_NAME, custom_id
        )
        return None
    try:
        # Every block, not the first: parallel tool use can split the
        # genes across two calls in one turn.
        return _merge_tool_blocks(
            tool_blocks, pmid=custom_id, model=getattr(message, "model", None)
        )
    # One malformed row must not discard the rest of the batch.
    except Exception as exc:
        logger.warning("Could not parse batch entry %s: %s", custom_id, exc)
        return None


def build_batch_request(pmid: str, text: str, config: PipelineConfig) -> dict[str, Any]:
    """Build one batch request. custom_id is the PMID."""
    return {
        "custom_id": pmid,
        "params": _build_message_params(text, pmid, config),
    }


def results_by_custom_id(
    results: Any,
    *,
    usage: TokenUsage | None = None,
    documents: dict[str, str] | None = None,
    config: PipelineConfig | None = None,
    refusals: dict[str, str] | None = None,
) -> dict[str, list[GeneEntry]]:
    """Key results by custom_id — batch results arrive in any order.

    A custom_id absent from the result is a paper the batch did not
    answer: an entry that errored, expired, was refused, was cut short by
    the token ceiling, never called the tool, or could not be parsed. The
    caller marks those failed so they are retried on a later run.

    Every succeeded entry's usage accumulates into ``usage`` and each entry
    is recorded as one Anthropic call. The streaming path does both inside
    ``_stream_and_parse``, which this path never calls -- so a ``--batch``
    run published zero tokens, $0.00, no Anthropic row in the services
    panel, and could never raise the token-ceiling warning. The reasoning
    trace goes the same way: ``_account_reasoning`` charges it its share of
    the entry's output tokens and ``_record_thinking_trace`` writes it to
    the audit event log, both shared with the streaming path, because a
    ``--batch`` run otherwise reported ``thinkingTokens: 0`` and left no
    trace for an auditor to read.

    A non-succeeded entry is logged with the ``error`` payload the API
    attached to it, when it attached one: without it a request-level
    rejection that applies to every entry reads as an unexplained
    "errored" over every paper in the batch.

    ``documents`` maps each custom_id to the text its document block
    carried -- the truncated paper, so citation offsets line up -- and
    turns on the same provenance check the streaming path runs: every
    quote is looked for in the paper, the run tally counts it, and
    ``require_verified_quotes`` drops the ones that fail. Without it the
    batch path parsed the tool blocks and returned, so the gate did
    nothing under ``--batch`` and the report published 0/0 quotes checked.
    ``submit_and_collect`` always passes it; callers parsing results on
    their own get the parse only.

    ``refusals``, when given, receives custom_id -> classifier category for
    every refused entry. A refused entry is still absent from the result --
    the caller fails it, and the next run retries it -- but the run report
    can then say the classifier declined it, not that the batch returned
    nothing.
    """
    settings = config or PipelineConfig()
    out: dict[str, list[GeneEntry]] = {}
    for entry in results:
        if entry.result.type != "succeeded":
            # No HTTP status exists for one entry of a batch. A result the
            # API could not produce is a failed request all the same, and
            # is counted as one so the panel does not read as clean.
            record_service_call(
                "anthropic", endpoint="/v1/messages", method="POST", status=500
            )
            logger.warning(
                "Batch entry %s: %s%s",
                entry.custom_id,
                entry.result.type,
                _error_detail(entry.result),
            )
            continue
        message = entry.result.message
        record_service_call(
            "anthropic", endpoint="/v1/messages", method="POST", status=200
        )
        if usage is not None:
            accumulate_usage(usage, message)
        # The same two guards _stream_and_parse applies, in the same order
        # and before any content is read. The server-side `fallbacks`
        # parameter is unavailable on the Message Batches API, so this is
        # the only refusal handling the batch path has.
        stop_reason = getattr(message, "stop_reason", None)
        if stop_reason == "refusal":
            category = _refusal_category(message)
            logger.error(
                "Batch entry %s was refused by the safety classifier (category: %s)",
                entry.custom_id,
                category,
            )
            if refusals is not None:
                refusals[entry.custom_id] = category
            continue
        if stop_reason == "max_tokens":
            logger.error(
                "Batch entry %s was cut short by the token ceiling "
                "(stop_reason=max_tokens); raise PIPELINE_LLM_MAX_TOKENS",
                entry.custom_id,
            )
            if usage is not None:
                usage.truncated_responses += 1
            continue
        # The reasoning trace and its share of the output tokens, as the
        # streaming path accounts for them: a `--batch` run wrote no
        # `paper_extraction_thinking` event at all and published
        # `thinkingTokens: 0` beside the batch's real output count. One
        # attempt per entry -- the batch has already run, so there is no
        # second one to distinguish.
        _, thinking_text = _account_reasoning(message, usage)
        genes = _parse_batch_genes(message, custom_id=entry.custom_id)
        _record_thinking_trace(
            settings,
            pmid=entry.custom_id,
            thinking=thinking_text,
            attempt=1,
            accepted=genes is not None,
            model=getattr(message, "model", None),
        )
        if genes is None:
            continue
        if documents is not None and entry.custom_id in documents:
            # Under the paper's scope, as the streaming path records: the
            # checkpoint stores each paper's share of the tally.
            with paper_scope(entry.custom_id):
                genes = report_provenance(
                    genes,
                    spans=collect_spans(message),
                    document=documents[entry.custom_id],
                    pmid=entry.custom_id,
                    require_verified_quotes=settings.require_verified_quotes,
                )
        out[entry.custom_id] = genes
    return out


def _document_sha256(text: str) -> str:
    """The sha256 of one paper's text, as the records of paid answers keep it.

    The batch state file takes it over the document block a request carried;
    the checkpoint's record of a rescued answer, over the text as fetched.
    """
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _claim_pending(
    pending: list[PendingBatch], documents: dict[str, str]
) -> list[tuple[PendingBatch, set[str]]]:
    """Each recorded batch paired with the papers of this run it can answer.

    A paper is reusable only if the batch was sent exactly the text this run
    would send: the window may have moved, and a paper's text may have
    changed (a PDF that now parses, a new truncation limit), and collecting
    the old answer would then check its quotes against a document it never
    saw. The first batch holding a paper claims it, and a batch that claims
    nothing is left out here, so it is never even looked up; it stays on
    record for the run whose papers it holds.
    """
    claimed: set[str] = set()
    out: list[tuple[PendingBatch, set[str]]] = []
    for batch in pending:
        pmids = {
            pmid
            for pmid, digest in batch.document_sha256.items()
            if pmid in documents
            and pmid not in claimed
            and _document_sha256(documents[pmid]) == digest
        }
        if pmids:
            claimed |= pmids
            out.append((batch, pmids))
    return out


def _created_at(batch: Any) -> float:
    """When the API created *batch*, in seconds since the epoch.

    The batch object's own `created_at` when it carries one, since the
    retention of its results counts from it; the local clock otherwise.
    """
    created = getattr(batch, "created_at", None)
    if isinstance(created, datetime):
        return created.timestamp()
    return time.time()


async def _poll_until_ended(client: Any, batch_id: str, *, recorded: bool) -> Any:
    """Poll a batch until it ends, and return it as it ended.

    Raises ExtractionFailedError if it is still running after
    _MAX_WAIT_SECONDS -- the batch itself is not cancelled, so its id is in
    the message and results stay retrievable. *recorded* says the state file
    holds it, and then the way back is the same command run again, which
    collects it; without one, the id is all there is.
    """
    deadline = time.monotonic() + _MAX_WAIT_SECONDS
    # The last status the API gave, and the error of the poll just made
    # when it could not be reached. The wait is for something already paid
    # for, so an outage is waited out like a batch still running: the SDK's
    # two retries span a few seconds, and a router restart used to end a
    # run that had a day to wait.
    status = "unconfirmed (the API could not be reached)"
    while True:
        outage: Exception | None = None
        try:
            current = await client.messages.batches.retrieve(batch_id)
        except (
            anthropic.APIConnectionError,
            anthropic.APIStatusError,
            httpx2.TransportError,
        ) as error:
            if not _is_transient(error):
                raise
            outage = error
            logger.warning(
                "Could not poll batch %s (%r); trying again in %ds",
                batch_id,
                error,
                _POLL_SECONDS,
            )
        else:
            if current.processing_status == "ended":
                return current
            status = current.processing_status
        if time.monotonic() >= deadline:
            advice = (
                "re-run the same command to collect it once it finishes."
                if recorded
                else "retrieve its results directly if it finishes later."
            )
            raise ExtractionFailedError(
                f"Batch {batch_id} is still "
                f"{status} after "
                f"{_MAX_WAIT_SECONDS // 3600}h. It was not cancelled; {advice}"
            ) from outage
        if outage is None:
            logger.info("Batch %s: %s", batch_id, status)
        await asyncio.sleep(_POLL_SECONDS)


async def _fetch_entries(
    client: Any, batch_id: str, pmids: set[str] | None
) -> list[Any]:
    """The batch's result entries, narrowed to ``pmids`` when given.

    A recorded batch can hold papers this run no longer wants; their
    entries are dropped here, before ``results_by_custom_id`` would count
    their tokens or check their quotes.

    A read that breaks off is made again from the start, `_FETCH_ATTEMPTS`
    times in all, so no entry is kept twice; the batch has ended and is
    paid for, and its results are a download of every paper's answer.
    """
    attempt = 0
    while True:
        attempt += 1
        try:
            entries = [
                r async for r in await client.messages.batches.results(batch_id)
            ]
            break
        except (
            anthropic.APIConnectionError,
            anthropic.APIStatusError,
            httpx2.TransportError,
        ) as error:
            if not _is_transient(error) or attempt >= _FETCH_ATTEMPTS:
                raise
            logger.warning(
                "Reading the results of batch %s broke off (%r); reading "
                "them again (attempt %d/%d)",
                batch_id,
                error,
                attempt + 1,
                _FETCH_ATTEMPTS,
            )
            await asyncio.sleep(_FETCH_RETRY_SECONDS)
    if pmids is None:
        return entries
    return [entry for entry in entries if entry.custom_id in pmids]


async def _fetch_recorded_entries(
    client: Any, batch: Any, pmids: set[str]
) -> list[Any] | None:
    """A recorded batch's entries for ``pmids``, or None when they are gone.

    The API keeps results for 29 days. Past that an ended batch has no
    ``results_url``, and its papers have to be paid for again.
    """
    if batch.results_url is None:
        logger.warning(
            "Recorded batch %s has ended but its results are no longer "
            "available; its papers will be submitted again.",
            batch.id,
        )
        return None
    try:
        return await _fetch_entries(client, batch.id, pmids)
    except anthropic.NotFoundError:
        logger.warning(
            "The results of recorded batch %s could not be fetched; its "
            "papers will be submitted again.",
            batch.id,
        )
        return None


async def submit_and_collect(
    papers: dict[str, str],
    config: PipelineConfig,
    *,
    usage: TokenUsage | None = None,
    refusals: dict[str, str] | None = None,
    state_path: str | None = None,
    reused: set[str] | None = None,
) -> dict[str, list[GeneEntry]]:
    """Submit every paper by batch and poll until every batch ends.

    One batch for an ordinary window; a window over the API's limits for
    one batch is split (``_chunk_requests``), and each batch is recorded as
    it is accepted, so a later one failing leaves the earlier on record.
    Each is submitted once (``_create_batch``): a submission whose outcome
    is unknown raises ExtractionFailedError rather than being sent again.

    Raises ExtractionFailedError without a key, and again if the batch is
    still running after _MAX_WAIT_SECONDS -- the batch itself is not
    cancelled, so its id is in the message and results stay retrievable:
    with ``state_path`` set the same command run again collects it, and
    without one its results have to be retrieved by that id.

    ``usage`` receives the token usage of every entry collected and
    ``refusals`` the category of every refused one; see
    ``results_by_custom_id``. ``reused`` receives the PMIDs collected from
    a batch an earlier call recorded rather than from one this call
    submitted, so the caller can say so: if the earlier run had collected
    that batch before it crashed, its failed report counted those tokens
    too.

    ``state_path`` makes a submitted batch survive a crash. Every batch is
    recorded there (``pipeline.batch_state``) the moment the API accepts
    it, before the first poll, and a later call collects a recorded batch
    for the papers it was sent the same text for, instead of paying for
    them again; only the rest are submitted. A recorded batch the API no
    longer knows, or whose results have expired, is logged and its papers
    submitted again. When a new batch is recorded, every other recorded
    batch is written back beside it, claimed by this call or not: one
    window's run must not erase a batch paid for by another's. When nothing
    new is submitted the file is left as it was, apart from records
    ``batch_state.load`` dates or prunes by age. This function never takes
    a paper off the record: the caller does (``batch_state.forget``), once
    its result is safely stored. With ``state_path`` None nothing is read or
    written and the API calls are exactly those of a plain submission.
    """
    # Shared with the streaming path so the key precheck and the
    # identity-linked-key workspace header cannot drift between the two.
    client = build_async_client()
    try:
        requests = [build_batch_request(p, t, config) for p, t in papers.items()]
        # What each document block carried, for the provenance check: the
        # truncated text, so locate_quote's offsets mean what the API's do.
        # The state file hashes the same text, for the same reason.
        documents = {
            request["custom_id"]: _document_text(request["params"])
            for request in requests
        }
        run_fingerprint = (
            checkpoint.fingerprint(config) if state_path is not None else {}
        )
        recorded = (
            batch_state.load(state_path, run_fingerprint)
            if state_path is not None
            else []
        )
        claimed = _claim_pending(recorded, documents)

        # Entries already in hand, and batches still to be polled, each
        # with the papers it is collected for (None: all of them).
        entries: list[Any] = []
        to_poll: list[tuple[str, set[str] | None]] = []
        # The batches this call submitted that made it into the state
        # file; a recorded batch being polled is in it by definition.
        newly_recorded: set[str] = set()
        # Recorded batches with nothing left to retrieve: the API no longer
        # knows them, or their results have expired. Only these are left
        # out when the file is written back; every other record, claimed by
        # this run or not, is still paid for and stays.
        gone: set[str] = set()
        covered: set[str] = set()
        for pending, pmids in claimed:
            try:
                current = await client.messages.batches.retrieve(pending.batch_id)
            except anthropic.NotFoundError:
                logger.warning(
                    "Recorded batch %s is unknown to the API; its papers "
                    "will be submitted again.",
                    pending.batch_id,
                )
                gone.add(pending.batch_id)
                continue
            if current.processing_status == "ended":
                collected = await _fetch_recorded_entries(client, current, pmids)
                if collected is None:
                    gone.add(pending.batch_id)
                    continue
                entries.extend(collected)
            else:
                to_poll.append((pending.batch_id, pmids))
            logger.info(
                "Collecting %d papers from recorded batch %s instead of "
                "submitting them again",
                len(pmids),
                pending.batch_id,
            )
            covered |= pmids

        if reused is not None:
            reused |= covered
        remainder = [r for r in requests if r["custom_id"] not in covered]
        kept = [p for p in recorded if p.batch_id not in gone]
        submitted: list[PendingBatch] = []
        for chunk in _chunk_requests(remainder):
            batch = await _create_batch(client, chunk)
            logger.info("Submitted batch %s (%d papers)", batch.id, len(chunk))
            to_poll.append((batch.id, None))
            if state_path is None:
                continue
            # Before the first poll, and before the next batch is created:
            # a crash or a failed submission from here on has paid for this
            # batch, and the next run must find it.
            submitted.append(
                PendingBatch(
                    batch_id=batch.id,
                    document_sha256={
                        r["custom_id"]: _document_sha256(documents[r["custom_id"]])
                        for r in chunk
                    },
                    submitted_at=_created_at(batch),
                )
            )
            try:
                batch_state.save(state_path, run_fingerprint, [*kept, *submitted])
                newly_recorded = {p.batch_id for p in submitted}
            except OSError:
                # The batch is already paid for; ending the run here
                # would lose it as surely as the crash this guards
                # against, so it is polled unrecorded, as the
                # checkpoint hook carries on past an unwritable file.
                logger.warning(
                    "Could not record batch %s; a crash before its "
                    "results are collected will lose it",
                    batch.id,
                    exc_info=True,
                )

        for batch_id, pmids in to_poll:
            ended = await _poll_until_ended(
                client,
                batch_id,
                recorded=pmids is not None or batch_id in newly_recorded,
            )
            if pmids is None:
                entries.extend(await _fetch_entries(client, batch_id, None))
                continue
            # A recorded batch that was still running when this call found
            # it. Its results expiring before it ended is not expected, but
            # if they did, its papers are absent from the result and the
            # caller fails them for a later run.
            collected = await _fetch_recorded_entries(client, ended, pmids)
            entries.extend(collected or [])

        return results_by_custom_id(
            entries,
            usage=usage,
            documents=documents,
            config=config,
            refusals=refusals,
        )
    finally:
        await client.close()
