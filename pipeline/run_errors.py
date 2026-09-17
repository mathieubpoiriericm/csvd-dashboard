"""Structured run failures and warnings.

The dashboard's pipeline widget publishes why a step failed. Before this
module the only durable record was ``traceback.format_exc()[-500:]`` in
the progress file, which is a console artifact: it names Python frames and
absolute paths rather than the thing that went wrong, and it cannot be
styled, grouped or counted.

``classify()`` is the one place an exception becomes a reader-facing
reason. The traceback is not discarded -- it stays in the log file, and its
tail rides along as ``detail`` -- but it is never the headline.
"""

import asyncio
import re
from typing import Final, Literal

from pydantic import Field

from pipeline.wire_model import WireModel

ErrorKind = Literal[
    "http_error",
    "timeout",
    "rate_limited",
    "database_error",
    "interrupted",
    "unknown",
]

WarningKind = Literal[
    "search_truncated",
    "paper_retrieval_failed",
    "genes_rejected",
    "api_retried",
    "api_errored",
    "model_truncated",
    "quote_unverified",
    "batch_validation",
    "paper_truncated",
]


class RunError(WireModel):
    """One reader-facing failure.

    Args:
        kind: The category the UI styles and captions from.
        title: A single sentence naming what failed, already readable.
        detail: Supporting text -- a response body, a traceback tail. May
            be long; the UI treats it as secondary.
        subject: What the failure concerns -- a PMID, a gene symbol, a
            service name -- so the UI can label it without parsing prose.
    """

    kind: ErrorKind
    title: str
    detail: str | None = None
    subject: str | None = None


class RunWarning(WireModel):
    """A non-fatal finding, aggregated rather than repeated.

    ``count`` is why this is not a list of RunErrors: three papers with no
    retrievable text is one warning saying three, not three warnings. A
    step showing "⚠ 24" means 24 things happened across its warnings, not
    that 24 rows follow.
    """

    kind: WarningKind
    title: str
    count: int = 1
    detail: str | None = None
    subjects: list[str] = Field(default_factory=list)


# Phrases that identify a rate-limit response regardless of the client
# that raised it. NCBI answers with 429, Europe PMC with 503 plus a body
# saying so, and the Anthropic SDK raises its own typed error whose
# message says so -- so matching on status alone would miss two of three.
#
# A bare "429" is deliberately NOT here. PMIDs are eight digits and
# exception text routinely carries one -- "Error processing PMID
# 34291234" contains it -- as do row numbers and byte offsets, so the
# substring reported ordinary parsing and database failures to the reader
# as rate limiting. The status code is checked separately and exactly.
#
# Matched as whole words against the message only, never the class name:
# the pipeline's own identifiers carry these words too. An
# `AttributeError` naming `rate_limit_retry_delay`, a `TypeError` naming
# `AsyncRateLimiter` or anything mentioning `llm_timeout` is a bug in our
# code, and as substrings they were published as "the service asked us to
# slow down" -- sending the reader to the wrong service. `\b` does not
# treat `_` as a boundary, so `rate_limit_retry_delay` is one word to it
# and `rate_limit` inside it cannot match.
_RATE_LIMIT_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"\brate[ _-]?limit(?:ed|ing)?\b|\btoo many requests\b|\bretry-after\b"
)

_TIMEOUT_PATTERN: Final[re.Pattern[str]] = re.compile(r"\btime(?:d)? ?out\b")


# How far down `__cause__` / `__context__` a status is looked for. The
# pipeline wraps once (`PubMedSearchError(...) from HTTPError`), tenacity
# and asyncio add a frame or two; anything deeper is not this run's error.
_CHAIN_DEPTH: Final[int] = 5


def _own_status_code(exc: BaseException) -> int | None:
    """HTTP status carried by *this* exception, without importing any client.

    Both ``httpx.HTTPStatusError`` and the Anthropic SDK's ``APIError``
    expose ``.response.status_code``; the SDK also exposes a bare
    ``.status_code``; ``urllib.error.HTTPError`` -- what Biopython raises
    under the search step -- exposes ``.code`` and ``.status``. Reading
    them duck-typed keeps this module free of every one of those imports,
    so it stays importable in a test that stubs the network away entirely.
    A value outside 100-599 is not a status, whatever the attribute is named.
    """
    response = getattr(exc, "response", None)
    candidates = (
        getattr(response, "status_code", None),
        getattr(exc, "status_code", None),
        getattr(exc, "status", None),
        getattr(exc, "code", None),
    )
    for code in candidates:
        if isinstance(code, int) and not isinstance(code, bool) and 100 <= code <= 599:
            return code
    return None


def _status_code(exc: BaseException) -> int | None:
    """HTTP status from the exception or the ones it was raised from.

    Step 1 raises ``PubMedSearchError(...) from e`` where ``e`` is the
    urllib error carrying the status, so reading only the outermost
    exception classified every NCBI HTTP failure on the search step as
    ``unknown`` while ``http_error`` sat there for it. ``__cause__`` is
    preferred over ``__context__`` at each hop because it is the explicit
    chain; the walk is bounded and cycle-safe.
    """
    seen: set[int] = set()
    current: BaseException | None = exc
    for _ in range(_CHAIN_DEPTH):
        if current is None or id(current) in seen:
            break
        seen.add(id(current))
        code = _own_status_code(current)
        if code is not None:
            return code
        current = current.__cause__ or current.__context__
    return None


def classify(exc: BaseException, *, subject: str | None = None) -> RunError:
    """Turn an exception into a reader-facing failure.

    Args:
        exc: The exception to classify.
        subject: What it concerns -- a PMID, gene symbol or service name.

    Returns:
        A ``RunError`` whose ``title`` reads as a sentence and whose
        ``kind`` the UI can style. Unrecognised exceptions become
        ``unknown`` carrying the exception class name, which is still far
        more useful than a truncated traceback and keeps the widget honest
        about not knowing.
    """
    if isinstance(exc, (KeyboardInterrupt, asyncio.CancelledError)):
        return RunError(
            kind="interrupted",
            title=f"The run was interrupted ({type(exc).__name__})",
            subject=subject,
        )

    message = str(exc)
    text = message.lower()
    status = _status_code(exc)

    if status == 429 or _RATE_LIMIT_PATTERN.search(text):
        kind: ErrorKind = "rate_limited"
        title = "The service asked us to slow down"
    elif isinstance(exc, TimeoutError) or _TIMEOUT_PATTERN.search(text):
        kind = "timeout"
        title = "The request timed out"
    elif status is not None:
        kind = "http_error"
        title = f"The service returned HTTP {status}"

    # asyncpg carries `sqlstate`, never an HTTP status, so every database
    # failure fell through to `unknown` -- including the
    # UndefinedColumnError a database that has not taken migration 008
    # raises, which is the first failure this feature can cause. Matched
    # duck-typed to keep this module importable without asyncpg.
    elif hasattr(exc, "sqlstate") or type(exc).__module__.startswith("asyncpg"):
        kind = "database_error"
        title = f"The database rejected the query ({type(exc).__name__})"

    # A PostgreSQL that is not listening surfaces from asyncpg as a bare
    # ConnectionRefusedError, and missing DB_* configuration as the
    # pipeline's own error, raised before any socket is opened. Both are
    # the failures step 2 and step 5 most often raise on a live run, and
    # both read as "an unexpected ConnectionRefusedError stopped the step".
    elif isinstance(exc, ConnectionRefusedError):
        kind = "database_error"
        title = f"The database could not be reached ({type(exc).__name__})"
    elif type(exc).__module__ == "pipeline.database":
        kind = "database_error"
        title = f"The database is not configured ({type(exc).__name__})"
    else:
        kind = "unknown"
        title = f"An unexpected {type(exc).__name__} stopped the step"

    return RunError(kind=kind, title=title, detail=message or None, subject=subject)
