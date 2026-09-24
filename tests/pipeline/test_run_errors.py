"""Tests for pipeline.run_errors -- exceptions become reader-facing reasons."""

import asyncio
from email.message import Message
from unittest.mock import MagicMock
from urllib.error import HTTPError

import httpx
import pytest

from pipeline.pubmed_search import PubMedSearchError
from pipeline.run_errors import RunError, RunWarning, classify


def _http_error(status: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", "https://example.org/thing")
    response = httpx.Response(status, request=request)
    return httpx.HTTPStatusError(
        f"Server error '{status}'", request=request, response=response
    )


def _chained_from_urllib(status: int) -> PubMedSearchError:
    """The shape step 1 raises: a wrapper chained from Biopython's HTTPError."""
    cause = HTTPError(
        "https://eutils.ncbi.nlm.nih.gov/", status, "boom", hdrs=Message(), fp=None
    )
    try:
        raise PubMedSearchError(f"Entrez API call failed: {cause}") from cause
    except PubMedSearchError as exc:
        return exc


class TestClassify:
    def test_interrupt_is_named_rather_than_traced(self) -> None:
        error = classify(KeyboardInterrupt())
        assert error.kind == "interrupted"
        assert "interrupted" in error.title

    def test_cancellation_is_an_interrupt_too(self) -> None:
        assert classify(asyncio.CancelledError()).kind == "interrupted"

    def test_429_is_rate_limiting_not_a_bare_http_error(self) -> None:
        error = classify(_http_error(429))
        assert error.kind == "rate_limited"
        assert error.title == "The service asked us to slow down"

    @pytest.mark.parametrize(
        "message",
        [
            "Error processing PMID 34291234",
            "duplicate key value violates unique constraint at row 4290",
            "read 4290 bytes",
        ],
    )
    def test_a_digit_run_containing_429_is_not_rate_limiting(
        self, message: str
    ) -> None:
        # "429" was matched as a substring, and PMIDs are eight digits, so
        # ordinary parsing and database failures were reported to the
        # reader as "the request rate needs lowering".
        assert classify(RuntimeError(message)).kind == "unknown"

    def test_a_real_429_status_is_still_rate_limiting(self) -> None:
        assert classify(_http_error(429)).kind == "rate_limited"

    def test_rate_limit_is_recognised_without_a_status_code(self) -> None:
        # The Anthropic SDK raises typed errors that carry no
        # .response.status_code, so matching on status alone would miss them.
        assert classify(RuntimeError("Rate limit exceeded")).kind == "rate_limited"

    @pytest.mark.parametrize(
        "exc",
        [
            AttributeError(
                "'PipelineConfig' object has no attribute 'rate_limit_retry_delay'"
            ),
            TypeError("AsyncRateLimiter.__init__() missing 1 required argument"),
            AttributeError("'PipelineConfig' object has no attribute 'llm_timeout'"),
        ],
        ids=["config-attribute", "class-name", "timeout-attribute"],
    )
    def test_the_pipelines_own_identifiers_are_not_service_messages(
        self, exc: Exception
    ) -> None:
        # The markers were matched as substrings of the class name and the
        # message, so a bug in our own code that happened to name
        # `rate_limit_retry_delay` or `AsyncRateLimiter` was published as
        # "the service asked us to slow down", and `llm_timeout` as a
        # timeout -- sending the reader to the wrong service.
        assert classify(exc).kind == "unknown"

    def test_the_sdks_typed_rate_limit_error_is_still_recognised(self) -> None:
        import anthropic

        exc = anthropic.RateLimitError(
            message="limited",
            response=MagicMock(headers={}, status_code=429),
            body=None,
        )
        assert classify(exc).kind == "rate_limited"

    def test_a_rate_limit_phrase_is_matched_as_words(self) -> None:
        assert classify(RuntimeError("Too Many Requests")).kind == "rate_limited"
        assert classify(RuntimeError("retry-after: 30")).kind == "rate_limited"
        assert classify(RuntimeError("we were rate-limited")).kind == "rate_limited"

    def test_timeout_from_the_exception_type(self) -> None:
        assert classify(TimeoutError()).kind == "timeout"

    def test_timeout_from_an_httpx_error(self) -> None:
        assert classify(httpx.ReadTimeout("timed out")).kind == "timeout"

    def test_other_statuses_name_the_code(self) -> None:
        error = classify(_http_error(503))
        assert error.kind == "http_error"
        assert error.title == "The service returned HTTP 503"

    def test_a_database_failure_is_recognised(self) -> None:
        # asyncpg carries sqlstate, never an HTTP status, so these all
        # fell through to `unknown` -- including the UndefinedColumnError
        # a database without migration 008 raises, which is the first
        # failure this feature can cause.
        import asyncpg

        error = classify(asyncpg.exceptions.UndefinedColumnError("no column"))
        assert error.kind == "database_error"
        assert "UndefinedColumnError" in error.title

    def test_a_sqlstate_carrying_error_is_a_database_failure(self) -> None:
        class Weird(Exception):
            sqlstate = "42703"

        assert classify(Weird("boom")).kind == "database_error"

    def test_unknown_exceptions_name_their_class(self) -> None:
        error = classify(ValueError("bad thing"))
        assert error.kind == "unknown"
        assert "ValueError" in error.title
        assert error.detail == "bad thing"

    def test_an_empty_message_leaves_detail_unset(self) -> None:
        assert classify(ValueError()).detail is None

    def test_the_subject_rides_along(self) -> None:
        assert classify(ValueError("x"), subject="12345678").subject == "12345678"

    def test_a_bare_status_code_attribute_is_read(self) -> None:
        # Some SDK errors expose .status_code directly rather than through
        # a .response, so both shapes have to resolve.
        class SdkError(Exception):
            status_code = 500

        assert classify(SdkError("boom")).kind == "http_error"

    def test_a_status_on_the_cause_is_read_through_the_chain(self) -> None:
        # Step 1 raises PubMedSearchError(...) from Biopython's
        # urllib HTTPError, which carries the status as `.code` on the
        # cause and nothing on the wrapper -- so every NCBI HTTP failure on
        # the search step classified as `unknown` with `http_error` there
        # for it.
        error = classify(_chained_from_urllib(500))
        assert error.kind == "http_error"
        assert error.title == "The service returned HTTP 500"

    def test_a_429_on_the_cause_is_still_rate_limiting(self) -> None:
        assert classify(_chained_from_urllib(429)).kind == "rate_limited"

    @pytest.mark.parametrize("value", ["not-an-int", None])
    def test_a_non_integer_status_is_ignored(self, value: object) -> None:
        # Declared rather than suppressed: `_status_code` reads this
        # attribute duck-typed, so the stub has to actually carry it.
        class Weird(Exception):
            status_code: object

        exc = Weird("boom")
        exc.status_code = value
        assert classify(exc).kind == "unknown"


class TestRunWarning:
    def test_a_warning_counts_things_not_rows(self) -> None:
        warning = RunWarning(
            kind="paper_retrieval_failed",
            title="3 papers had no retrievable text",
            count=3,
            subjects=["1", "2", "3"],
        )
        assert warning.count == 3
        assert len(warning.subjects) == 3

    def test_count_defaults_to_one(self) -> None:
        assert RunWarning(kind="batch_validation", title="x").count == 1


class TestRunError:
    def test_detail_and_subject_are_optional(self) -> None:
        error = RunError(kind="unknown", title="x")
        assert error.detail is None
        assert error.subject is None


class TestTheCauseWalkIsBounded:
    def test_a_deep_chain_without_a_status_is_unknown(self) -> None:
        exc: BaseException | None = None
        for depth in range(8):
            try:
                raise RuntimeError(f"layer {depth}") from exc
            except RuntimeError as raised:
                exc = raised
        assert exc is not None
        assert classify(exc).kind == "unknown"


class TestTheDatabaseBeingDownIsADatabaseError:
    """asyncpg raises a bare OSError for a server that is not listening."""

    def test_a_refused_connection(self) -> None:
        error = classify(ConnectionRefusedError(61, "Connection refused"))
        assert error.kind == "database_error"
        assert "could not be reached" in error.title

    def test_missing_configuration(self) -> None:
        from pipeline.database import DatabaseConfigError

        error = classify(DatabaseConfigError("Missing DB_HOST"))
        assert error.kind == "database_error"
        assert "not configured" in error.title

    def test_a_query_the_server_rejected_reads_as_such(self) -> None:
        import asyncpg

        error = classify(asyncpg.exceptions.UndefinedColumnError("no column"))
        assert error.title == "The database rejected the query (UndefinedColumnError)"
