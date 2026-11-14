"""Tests for pipeline.run_errors -- exceptions become reader-facing reasons."""

import asyncio
from email.message import Message
from pathlib import Path
from unittest.mock import MagicMock
from urllib.error import HTTPError

import httpx
import pytest

from pipeline.pubmed_search import PubMedSearchError
from pipeline.run_errors import (
    NoPaperProcessedError,
    RunError,
    RunWarning,
    classifier_phrase,
    classify,
    publishable_text,
    refusal_category,
)


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


@pytest.mark.parametrize(
    ("category", "phrase"),
    [
        ("bio", "the biology safety classifier"),
        ("cyber", "the cybersecurity safety classifier"),
        ("frontier_llm", "the frontier-AI safety classifier"),
        ("reasoning_extraction", "the reasoning-extraction safety classifier"),
        ("general_harms", "the general-harms safety classifier"),
        ("unspecified", "a safety classifier"),
        ("something_new", "a safety classifier"),
    ],
)
def test_classifier_phrase_names_each_category(category: str, phrase: str) -> None:
    assert classifier_phrase(category) == phrase


def test_refusal_category_reads_a_missing_one_as_unspecified() -> None:
    assert refusal_category(None) == refusal_category("") == "unspecified"
    assert refusal_category("bio") == "bio"


def test_a_run_with_no_paper_processed_keeps_its_own_sentence() -> None:
    # Its detail is one paper's error, and "timed out" in there is that
    # paper's story: matched against the message it would have published
    # the run's failure as a timeout.
    error = classify(
        NoPaperProcessedError(
            "None of the 3 new papers could be processed",
            detail="PMID 111: The request timed out",
        )
    )
    assert error.kind == "no_paper_processed"
    assert error.title == "None of the 3 new papers could be processed"
    assert error.detail == "PMID 111: The request timed out"


class TestATransportTimeoutIsATimeout:
    """httpx's timeouts do not subclass ``TimeoutError`` and say nothing.

    The message comes from the transport's own exception and is normally
    empty, so neither the type test nor the phrase test saw one: a read
    timeout while a batch's results streamed was published as "an
    unexpected ReadTimeout", with no detail.
    """

    def test_an_httpx_timeout_with_no_message(self) -> None:
        error = classify(httpx.ReadTimeout(""))
        assert error.kind == "timeout"
        assert error.title == "The request timed out"

    def test_the_sdks_transport_timeout_with_no_message(self) -> None:
        httpx2 = pytest.importorskip("httpx2")
        assert classify(httpx2.ReadTimeout("")).kind == "timeout"

    def test_a_class_merely_named_like_one_is_not(self) -> None:
        class TimeoutSettingsError(Exception):
            pass

        assert classify(TimeoutSettingsError("bad value")).kind == "unknown"


class TestWhatIsPublishedIsSanitised:
    """`detail` reaches data/pipeline_run.json, which is public.

    The log has `_RedactSecrets`; the report had nothing, so an exception's
    own text -- a credential in a URL, the operator's home directory, the
    database's address -- was stored and exported as written.
    """

    def test_a_credential_in_a_url_is_redacted(self) -> None:
        error = classify(
            RuntimeError("GET https://example.org/x?db=gene&api_key=s3cr3t&id=1")
        )
        assert error.detail == (
            "GET https://example.org/x?db=gene&api_key=<redacted>&id=1"
        )

    def test_the_checkout_and_home_directory_are_not_named(self) -> None:
        import pipeline

        repo = Path(pipeline.__file__).resolve().parent.parent
        inside = repo / "logs" / "json" / "report.json"
        beside = Path.home() / "elsewhere" / "file.txt"
        error = classify(
            OSError(28, f"No space left on device: '{inside}' (and '{beside}')")
        )
        assert error.detail is not None
        assert "'<repo>/logs/json/report.json'" in error.detail
        assert str(repo) not in error.detail
        if len(Path.home().parts) > 1:
            assert "'~/elsewhere/file.txt'" in error.detail
            assert str(Path.home()) not in error.detail

    def test_an_over_long_message_is_capped(self) -> None:
        error = classify(RuntimeError("Error code: 500 - " + "x" * 5000))
        assert error.detail is not None
        assert len(error.detail) <= 500
        assert error.detail.startswith("Error code: 500 - ")
        assert error.detail.endswith("…")

    def test_ordinary_text_is_left_as_written(self) -> None:
        assert publishable_text("Error processing PMID 34291234") == (
            "Error processing PMID 34291234"
        )
        assert publishable_text(None) is None
        assert publishable_text("") == ""

    def test_a_refused_connection_publishes_no_address(self) -> None:
        error = classify(
            ConnectionRefusedError(
                111, "Connect call failed ('10.1.2.3', 5432)"
            )
        )
        assert error.kind == "database_error"
        assert error.detail is None

    def test_an_address_in_any_other_error_is_withheld(self) -> None:
        error = classify(
            OSError(
                "Multiple exceptions: [Errno 111] Connect call failed "
                "('::1', 5432, 0, 0), [Errno 111] Connect call failed "
                "('127.0.0.1', 5432)"
            )
        )
        assert error.detail is not None
        assert "5432" not in error.detail
        assert "127.0.0.1" not in error.detail

    @pytest.mark.parametrize("sqlstate", ["28P01", "28000", "3D000", "08006"])
    def test_a_login_failure_names_no_role_or_database(self, sqlstate: str) -> None:
        class Rejected(Exception):
            def __init__(self, message: str, code: str) -> None:
                super().__init__(message)
                self.sqlstate = code

        error = classify(
            Rejected('password authentication failed for user "someone"', sqlstate)
        )
        assert error.kind == "database_error"
        assert error.detail is None

    def test_a_rejected_query_keeps_its_message(self) -> None:
        import asyncpg

        error = classify(
            asyncpg.exceptions.UndefinedColumnError('column "x" does not exist')
        )
        assert error.detail == 'column "x" does not exist'

    def test_a_run_with_no_paper_processed_sanitises_the_papers_error(self) -> None:
        error = classify(
            NoPaperProcessedError(
                "None of the 3 new papers could be processed",
                detail="PMID 111: https://example.org/?api_key=s3cr3t",
            )
        )
        assert error.detail == "PMID 111: https://example.org/?api_key=<redacted>"
