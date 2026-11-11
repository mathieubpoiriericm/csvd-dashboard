"""Tests for pipeline.quality_metrics — TokenUsage, PipelineMetrics."""

from types import SimpleNamespace

from pipeline.quality_metrics import (
    PipelineMetrics,
    TokenUsage,
    accumulate_usage,
)

# ---------------------------------------------------------------------------
# TokenUsage
# ---------------------------------------------------------------------------


class TestTokenUsage:
    def test_defaults_zero(self):
        tu = TokenUsage()
        assert tu.input_tokens == 0
        assert tu.output_tokens == 0
        assert tu.cache_creation_input_tokens == 0
        assert tu.cache_read_input_tokens == 0

    def test_total_tokens(self):
        tu = TokenUsage(input_tokens=100, output_tokens=50)
        assert tu.total_tokens == 150

    def test_cache_hit_rate_zero_input(self):
        tu = TokenUsage()
        assert tu.cache_hit_rate == 0.0

    def test_cache_hit_rate_calculated(self):
        tu = TokenUsage(input_tokens=80, cache_read_input_tokens=20)
        assert tu.cache_hit_rate == pytest.approx(0.2)

    def test_cache_hit_rate_counts_cache_writes_as_input(self):
        # The API's input_tokens excludes both cache counts, so a prefix
        # written to the cache is input that was not served from it. Two
        # abstract-only papers -- one writes the 18k prefix, one reads it
        # -- published 90% where 18k of 38k input tokens were cached.
        tu = TokenUsage(
            input_tokens=2_000,
            cache_creation_input_tokens=18_000,
            cache_read_input_tokens=18_000,
        )
        assert tu.cache_hit_rate == pytest.approx(18_000 / 38_000)

    def test_cache_hit_rate_all_cached(self):
        tu = TokenUsage(input_tokens=0, cache_read_input_tokens=100)
        assert tu.cache_hit_rate == 1.0

    def test_iadd(self):
        a = TokenUsage(input_tokens=100, output_tokens=50)
        b = TokenUsage(
            input_tokens=200,
            output_tokens=100,
            cache_creation_input_tokens=10,
            cache_read_input_tokens=20,
        )
        a += b
        assert a.input_tokens == 300
        assert a.output_tokens == 150
        assert a.cache_creation_input_tokens == 10
        assert a.cache_read_input_tokens == 20

    def test_iadd_returns_self(self):
        a = TokenUsage(input_tokens=10)
        b = TokenUsage(input_tokens=5)
        result = a.__iadd__(b)
        assert result is a

    def test_iadd_chain(self):
        total = TokenUsage()
        for _i in range(5):
            total += TokenUsage(input_tokens=10, output_tokens=5)
        assert total.input_tokens == 50
        assert total.output_tokens == 25


# ---------------------------------------------------------------------------
# accumulate_usage
# ---------------------------------------------------------------------------


class TestAccumulateUsage:
    def test_accumulate_from_response(self, mock_anthropic_response):
        usage = TokenUsage()
        resp = mock_anthropic_response(input_tokens=500, output_tokens=200)
        accumulate_usage(usage, resp)
        assert usage.input_tokens == 500
        assert usage.output_tokens == 200

    def test_accumulate_no_usage_attr(self):
        usage = TokenUsage()

        class NoUsage:
            pass

        accumulate_usage(usage, NoUsage())
        assert usage.total_tokens == 0

    def test_accumulate_none_usage(self):
        usage = TokenUsage()

        class NullUsage:
            usage = None

        accumulate_usage(usage, NullUsage())
        assert usage.total_tokens == 0

    def test_accumulate_with_cache_tokens(self):
        usage = TokenUsage()

        class CachedResponse:
            class usage:
                input_tokens = 100
                output_tokens = 50
                cache_creation_input_tokens = 30
                cache_read_input_tokens = 20

        accumulate_usage(usage, CachedResponse())
        assert usage.cache_creation_input_tokens == 30
        assert usage.cache_read_input_tokens == 20

    def test_accumulate_takes_the_reported_thinking_tokens(self):
        """`output_tokens_details.thinking_tokens` is the exact split.

        It is the raw reasoning the model generated. Nothing in the
        response's content measures it: the trace is a summary, and the
        tool call's JSON is output that is neither thinking nor text.
        """
        usage = TokenUsage()

        class ThinkingResponse:
            class usage:
                input_tokens = 100
                output_tokens = 5_000
                cache_creation_input_tokens = 0
                cache_read_input_tokens = 0

                class output_tokens_details:
                    thinking_tokens = 4_200

        accumulate_usage(usage, ThinkingResponse())
        accumulate_usage(usage, ThinkingResponse())
        assert usage.thinking_tokens == 8_400
        assert usage.text_output_tokens == 1_600

    def test_accumulate_leaves_an_unreported_split_at_zero(
        self, mock_anthropic_response
    ):
        """No details is not a measurement; the caller estimates instead."""
        usage = TokenUsage()
        accumulate_usage(usage, mock_anthropic_response(output_tokens=500))
        assert usage.thinking_tokens == 0

    def test_accumulate_multiple(self, mock_anthropic_response):
        usage = TokenUsage()
        for _ in range(3):
            resp = mock_anthropic_response(input_tokens=100, output_tokens=50)
            accumulate_usage(usage, resp)
        assert usage.input_tokens == 300
        assert usage.output_tokens == 150


# ---------------------------------------------------------------------------
# PipelineMetrics
# ---------------------------------------------------------------------------


class TestPipelineMetrics:
    def test_defaults_zero(self):
        m = PipelineMetrics()
        assert m.papers_processed == 0
        assert m.genes_extracted == 0
        assert m.genes_validated == 0
        assert m.genes_rejected == 0

    def test_gene_acceptance_rate_zero(self, empty_metrics):
        assert empty_metrics.gene_acceptance_rate == 0.0

    def test_gene_acceptance_rate_calculated(self, populated_metrics):
        # 20/25 = 0.8
        assert populated_metrics.gene_acceptance_rate == pytest.approx(0.8)

    def test_fulltext_rate_zero(self, empty_metrics):
        assert empty_metrics.fulltext_rate == 0.0

    def test_fulltext_rate_calculated(self, populated_metrics):
        # 7/10 = 0.7
        assert populated_metrics.fulltext_rate == pytest.approx(0.7)

    def test_folding_one_paper_into_the_run_sums_every_counter(self):
        # Papers accumulate into their own metrics so a completed one can be
        # checkpointed with exactly what it contributed; this is how that
        # contribution reaches the run.
        run = PipelineMetrics(
            papers_processed=1,
            fulltext_retrieved=1,
            abstract_only=0,
            genes_extracted=4,
            genes_validated=3,
            genes_rejected=1,
            token_usage=TokenUsage(input_tokens=10, output_tokens=2),
        )
        paper = PipelineMetrics(
            papers_processed=1,
            fulltext_retrieved=0,
            abstract_only=1,
            genes_extracted=2,
            genes_validated=2,
            genes_rejected=0,
            token_usage=TokenUsage(input_tokens=5, output_tokens=1),
        )

        run += paper

        assert run.papers_processed == 2
        assert run.fulltext_retrieved == 1
        assert run.abstract_only == 1
        assert run.genes_extracted == 6
        assert run.genes_validated == 5
        assert run.genes_rejected == 1
        assert run.token_usage.input_tokens == 15
        assert run.token_usage.output_tokens == 3

    def test_folding_does_not_alias_the_token_usage(self):
        # += on TokenUsage mutates in place, so a shared instance would make
        # every later fold double-count through the other metrics object.
        run = PipelineMetrics()
        paper = PipelineMetrics(token_usage=TokenUsage(input_tokens=5))

        run += paper
        run += paper

        assert run.token_usage.input_tokens == 10
        assert paper.token_usage.input_tokens == 5


import pytest  # noqa: E402


def _iteration(kind: str, model: str, inp: int, out: int, write: int, read: int):
    return SimpleNamespace(
        type=kind,
        model=model,
        input_tokens=inp,
        output_tokens=out,
        cache_creation_input_tokens=write,
        cache_read_input_tokens=read,
    )


class TestFallbackIterations:
    def test_accumulate_usage_sums_iterations_without_double_counting(self) -> None:
        """Top-level usage repeats only the attempt that served the message;
        `iterations` holds every attempt, the declined one included."""
        response = SimpleNamespace(
            usage=SimpleNamespace(
                input_tokens=1200,
                output_tokens=3000,
                cache_creation_input_tokens=5000,
                cache_read_input_tokens=0,
                output_tokens_details=None,
                iterations=[
                    _iteration("message", "claude-opus-5-5", 1000, 0, 5000, 0),
                    _iteration(
                        "fallback_message", "claude-opus-4-8", 1200, 3000, 5000, 0
                    ),
                ],
            )
        )
        usage = TokenUsage()
        delta = accumulate_usage(usage, response)
        assert (
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_creation_input_tokens,
        ) == (2200, 3000, 10000)
        assert (
            usage.fallback_input_tokens,
            usage.fallback_output_tokens,
            usage.fallback_cache_creation_input_tokens,
            usage.fallback_cache_read_input_tokens,
        ) == (1200, 3000, 5000, 0)
        assert delta.input_tokens == 2200
        assert delta.output_tokens == 3000

    def test_a_declining_fallback_attempt_is_counted_as_the_fallbacks(self) -> None:
        """Both models declined: every attempt is a plain `message` entry.

        Only a *serving* fallback attempt is a `fallback_message`; one that
        declines is a `message` entry naming its model. Counted by type
        alone, Opus 4.8's declined attempt was priced at Opus 5.5's rates.
        """
        response = SimpleNamespace(
            usage=SimpleNamespace(
                input_tokens=1100,
                output_tokens=200,
                cache_creation_input_tokens=0,
                cache_read_input_tokens=0,
                output_tokens_details=None,
                iterations=[
                    _iteration("message", "claude-opus-5-5", 1000, 0, 5000, 0),
                    _iteration("message", "claude-opus-4-8", 1100, 200, 5000, 0),
                ],
            )
        )
        usage = TokenUsage()
        accumulate_usage(usage, response, fallback_model="claude-opus-4-8")
        assert (usage.input_tokens, usage.output_tokens) == (2100, 200)
        assert (
            usage.fallback_input_tokens,
            usage.fallback_output_tokens,
            usage.fallback_cache_creation_input_tokens,
        ) == (1100, 200, 5000)

    def test_an_entry_naming_no_model_stays_the_requested_models(self) -> None:
        """`model` is optional on a `message` entry; one without it is the
        requested model's, as before."""
        entry = _iteration("message", None, 1000, 10, 0, 0)  # ty: ignore[invalid-argument-type]
        response = SimpleNamespace(
            usage=SimpleNamespace(
                input_tokens=1000,
                output_tokens=10,
                cache_creation_input_tokens=0,
                cache_read_input_tokens=0,
                output_tokens_details=None,
                iterations=[entry],
            )
        )
        usage = TokenUsage()
        accumulate_usage(usage, response, fallback_model="claude-opus-4-8")
        assert usage.fallback_input_tokens == 0

    def test_accumulate_usage_reads_top_level_without_iterations(self) -> None:
        response = SimpleNamespace(
            usage=SimpleNamespace(
                input_tokens=10,
                output_tokens=20,
                cache_creation_input_tokens=0,
                cache_read_input_tokens=0,
                output_tokens_details=None,
                iterations=None,
            )
        )
        usage = TokenUsage()
        delta = accumulate_usage(usage, response)
        assert (usage.input_tokens, usage.output_tokens) == (10, 20)
        assert usage.fallback_input_tokens == 0
        assert delta.output_tokens == 20

    @pytest.mark.parametrize(
        ("category", "declined_output", "unbilled"),
        [
            # Refused before any output: billed only in the billed categories.
            ("cyber", 0, (1000, 5000, 200)),
            ("general_harms", 0, (1000, 5000, 200)),
            (None, 0, (1000, 5000, 200)),
            ("bio", 0, (0, 0, 0)),
            ("frontier_llm", 0, (0, 0, 0)),
            ("reasoning_extraction", 0, (0, 0, 0)),
            # Mid-stream: output was written, so it is billed whatever the
            # category.
            ("cyber", 40, (0, 0, 0)),
        ],
    )
    def test_a_decline_before_any_output_is_billed_by_category(
        self, category: str | None, declined_output: int, unbilled: tuple[int, ...]
    ) -> None:
        """The declined attempt stays in the totals either way; only the
        categories the API bills before any output stay in the cost."""
        response = SimpleNamespace(
            stop_reason="tool_use",
            stop_details=None,
            content=[
                SimpleNamespace(
                    type="fallback", trigger=SimpleNamespace(category=category)
                )
            ],
            usage=SimpleNamespace(
                input_tokens=1200,
                output_tokens=3000,
                cache_creation_input_tokens=5000,
                cache_read_input_tokens=0,
                output_tokens_details=None,
                iterations=[
                    _iteration(
                        "message", "claude-opus-5-5", 1000, declined_output, 5000, 200
                    ),
                    _iteration(
                        "fallback_message", "claude-opus-4-8", 1200, 3000, 5000, 0
                    ),
                ],
            ),
        )
        usage = TokenUsage()
        accumulate_usage(usage, response, fallback_model="claude-opus-4-8")
        assert (usage.input_tokens, usage.cache_creation_input_tokens) == (2200, 10000)
        assert (
            usage.unbilled_input_tokens,
            usage.unbilled_cache_creation_input_tokens,
            usage.unbilled_cache_read_input_tokens,
        ) == unbilled
        assert usage.fallback_input_tokens == 1200

    def test_an_unbilled_refusal_with_no_fallback_is_kept_out_of_the_cost(
        self,
    ) -> None:
        """The batch path, and a streaming refusal whose fallback could not
        run: one attempt, top-level usage, `stop_details` naming the
        category."""
        response = SimpleNamespace(
            stop_reason="refusal",
            stop_details=SimpleNamespace(category="cyber"),
            content=[],
            usage=SimpleNamespace(
                input_tokens=900,
                output_tokens=0,
                cache_creation_input_tokens=0,
                cache_read_input_tokens=4000,
                output_tokens_details=None,
                iterations=None,
            ),
        )
        usage = TokenUsage()
        accumulate_usage(usage, response)
        assert (usage.input_tokens, usage.cache_read_input_tokens) == (900, 4000)
        assert (
            usage.unbilled_input_tokens,
            usage.unbilled_cache_read_input_tokens,
        ) == (900, 4000)

    def test_a_fallback_refusing_unbilled_is_not_priced_as_the_fallbacks(
        self,
    ) -> None:
        """Both declined: Opus 5.5 as `bio`, billed, then Opus 4.8 as `cyber`
        before any output, which is not. The second attempt joins neither
        the fallback's share nor the cost."""
        response = SimpleNamespace(
            stop_reason="refusal",
            stop_details=SimpleNamespace(category="cyber"),
            content=[
                SimpleNamespace(
                    type="fallback", trigger=SimpleNamespace(category="bio")
                )
            ],
            usage=SimpleNamespace(
                input_tokens=1100,
                output_tokens=0,
                cache_creation_input_tokens=0,
                cache_read_input_tokens=0,
                output_tokens_details=None,
                iterations=[
                    _iteration("message", "claude-opus-5-5", 1000, 0, 5000, 0),
                    _iteration("fallback_message", "claude-opus-4-8", 1100, 0, 0, 0),
                ],
            ),
        )
        usage = TokenUsage()
        accumulate_usage(usage, response, fallback_model="claude-opus-4-8")
        assert usage.input_tokens == 2100
        assert usage.unbilled_input_tokens == 1100
        assert usage.unbilled_cache_creation_input_tokens == 0
        assert usage.fallback_input_tokens == 0

    def test_unbilled_counts_add_up(self) -> None:
        usage = TokenUsage(unbilled_input_tokens=1)
        usage += TokenUsage(
            unbilled_input_tokens=2,
            unbilled_cache_creation_input_tokens=3,
            unbilled_cache_read_input_tokens=4,
        )
        assert (
            usage.unbilled_input_tokens,
            usage.unbilled_cache_creation_input_tokens,
            usage.unbilled_cache_read_input_tokens,
        ) == (3, 3, 4)

    def test_fallback_counts_add_up(self) -> None:
        usage = TokenUsage(fallback_input_tokens=1, fallback_output_tokens=2)
        usage += TokenUsage(fallback_input_tokens=3, fallback_cache_read_input_tokens=4)
        assert (
            usage.fallback_input_tokens,
            usage.fallback_output_tokens,
            usage.fallback_cache_read_input_tokens,
        ) == (4, 2, 4)


class TestADirectFallbackResponse:
    """A request sent straight to the fallback model carries no `fallbacks`,
    so its answer has no `iterations`: the top-level usage is the fallback's
    one attempt, named by the response's own `model`."""

    @staticmethod
    def _response(model: str) -> SimpleNamespace:
        return SimpleNamespace(
            model=model,
            stop_reason="tool_use",
            stop_details=None,
            content=[],
            usage=SimpleNamespace(
                input_tokens=700,
                output_tokens=300,
                cache_creation_input_tokens=50,
                cache_read_input_tokens=20,
                output_tokens_details=None,
                iterations=None,
            ),
        )

    def test_its_top_level_usage_is_the_fallbacks_share(self) -> None:
        usage = TokenUsage()
        accumulate_usage(
            usage, self._response("claude-opus-4-8"), fallback_model="claude-opus-4-8"
        )
        assert (
            usage.fallback_input_tokens,
            usage.fallback_output_tokens,
            usage.fallback_cache_creation_input_tokens,
            usage.fallback_cache_read_input_tokens,
        ) == (700, 300, 50, 20)

    def test_a_primary_response_without_iterations_is_not_the_fallbacks(
        self,
    ) -> None:
        usage = TokenUsage()
        accumulate_usage(
            usage, self._response("claude-opus-5-5"), fallback_model="claude-opus-4-8"
        )
        assert usage.input_tokens == 700
        assert usage.fallback_input_tokens == 0
        assert usage.fallback_output_tokens == 0

    def test_the_fallback_refusing_unbilled_is_kept_out_of_its_share(self) -> None:
        """Declined before any output in a category the API does not bill:
        unbilled, and so not the fallback's priced share either."""
        response = self._response("claude-opus-4-8")
        response.stop_reason = "refusal"
        response.stop_details = SimpleNamespace(category="cyber")
        response.usage.output_tokens = 0
        usage = TokenUsage()
        accumulate_usage(usage, response, fallback_model="claude-opus-4-8")
        assert usage.unbilled_input_tokens == 700
        assert usage.fallback_input_tokens == 0
