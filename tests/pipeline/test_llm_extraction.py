"""Tests for pipeline.llm_extraction — the cached-client wrapper.

Claude-specific streaming / retry / thinking tests live in
tests/pipeline/test_anthropic_client.py.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

import pipeline.llm_extraction as llm_extraction
from pipeline.config import PipelineConfig
from pipeline.extraction_models import ExtractionResult
from pipeline.llm_extraction import GeneEntry, close_async_client, extract_from_paper
from pipeline.quality_metrics import TokenUsage

# ---------------------------------------------------------------------------
# GeneEntry Pydantic model
# ---------------------------------------------------------------------------


class TestGeneEntryModel:
    def test_minimal_valid(self):
        ge = GeneEntry(
            gene_symbol="NOTCH3",
            confidence=0.9,
            source_quote="NOTCH3 variants were associated with WMH (p=1e-12).",
        )
        assert ge.gene_symbol == "NOTCH3"
        assert ge.confidence == 0.9
        assert ge.protein_name is None
        assert ge.gwas_trait == []
        assert ge.omics_evidence == []
        assert ge.mendelian_randomization is False
        assert ge.pmid == ""

    def test_full_fields(self, tracked_traits):
        ge = GeneEntry(
            gene_symbol="HTRA1",
            protein_name="Serine protease HTRA1",
            gwas_trait=[tracked_traits[0]],
            mendelian_randomization=True,
            omics_evidence=["TWAS"],
            confidence=0.95,
            causal_evidence_summary="Strong evidence",
            pmid="12345678",
            source_quote=(
                "HTRA1 reached genome-wide significance for WMH volume "
                "(p=4.2e-15) with confirmatory TWAS evidence in brain tissue."
            ),
        )
        assert ge.gene_symbol == "HTRA1"
        assert ge.mendelian_randomization is True

    def test_confidence_lower_bound(self):
        ge = GeneEntry(
            gene_symbol="X",
            confidence=0.0,
            source_quote="X was tested but showed no association with WMH.",
        )
        assert ge.confidence == 0.0

    def test_confidence_upper_bound(self):
        ge = GeneEntry(
            gene_symbol="X",
            confidence=1.0,
            source_quote="X is a validated monogenic cause of cSVD.",
        )
        assert ge.confidence == 1.0

    def test_confidence_below_zero_rejected(self):
        with pytest.raises(ValidationError):
            GeneEntry(
                gene_symbol="X",
                confidence=-0.1,
                source_quote="X was associated with WMH (p=1e-8).",
            )

    def test_confidence_above_one_rejected(self):
        with pytest.raises(ValidationError):
            GeneEntry(
                gene_symbol="X",
                confidence=1.1,
                source_quote="X was associated with WMH (p=1e-8).",
            )

    def test_whitespace_stripped(self):
        ge = GeneEntry(
            gene_symbol="  NOTCH3  ",
            confidence=0.9,
            source_quote="NOTCH3 variants were associated with WMH (p=1e-12).",
        )
        assert ge.gene_symbol == "NOTCH3"

    def test_missing_gene_symbol_rejected(self):
        with pytest.raises(ValidationError):
            GeneEntry.model_validate({"confidence": 0.9})

    def test_missing_confidence_rejected(self):
        with pytest.raises(ValidationError):
            GeneEntry.model_validate({"gene_symbol": "X"})

    def test_pmid_mutable(self):
        ge = GeneEntry(
            gene_symbol="X",
            confidence=0.9,
            source_quote="X was associated with WMH (p=1e-8).",
        )
        ge.pmid = "99999999"
        assert ge.pmid == "99999999"


class TestExtractionResult:
    def test_empty_genes(self):
        er = ExtractionResult(genes=[])
        assert er.genes == []

    def test_default_empty(self):
        er = ExtractionResult()
        assert er.genes == []

    def test_with_genes(self):
        er = ExtractionResult(
            genes=[
                GeneEntry(
                    gene_symbol="X",
                    confidence=0.9,
                    source_quote="X was associated with WMH (p=1e-8).",
                )
            ]
        )
        assert len(er.genes) == 1

    def test_model_json_schema(self):
        schema = ExtractionResult.model_json_schema()
        assert "properties" in schema
        assert "genes" in schema["properties"]


# ---------------------------------------------------------------------------
# ExtractionResult.model_validate — the parse, now that the genes arrive as
# a strict tool call's input dict rather than as JSON text
# ---------------------------------------------------------------------------


class TestValidateToolInput:
    def test_one_gene(self):
        result = ExtractionResult.model_validate(
            {
                "genes": [
                    {
                        "gene_symbol": "NOTCH3",
                        "confidence": 0.9,
                        "source_quote": (
                            "NOTCH3 variants were associated with WMH (p=1e-12)."
                        ),
                    }
                ]
            }
        )
        assert len(result.genes) == 1
        assert result.genes[0].gene_symbol == "NOTCH3"

    def test_empty_genes(self):
        assert ExtractionResult.model_validate({"genes": []}).genes == []

    def test_missing_genes_key_returns_empty(self):
        # ExtractionResult defaults genes to [], so an input without the
        # key does not raise — it produces an empty result.
        assert ExtractionResult.model_validate({"not_genes": []}).genes == []

    def test_multiple_genes(self):
        data = {
            "genes": [
                {
                    "gene_symbol": "A",
                    "confidence": 0.9,
                    "source_quote": "A was associated with WMH (p=1e-9).",
                },
                {
                    "gene_symbol": "B",
                    "confidence": 0.8,
                    "source_quote": "B was associated with SVS (p=2e-8).",
                },
                {
                    "gene_symbol": "C",
                    "confidence": 0.7,
                    "source_quote": "C reached significance for lacunar stroke.",
                },
            ]
        }
        assert len(ExtractionResult.model_validate(data).genes) == 3

    def test_confidence_out_of_range_raises(self):
        with pytest.raises(ValidationError):
            ExtractionResult.model_validate(
                {
                    "genes": [
                        {
                            "gene_symbol": "X",
                            "confidence": 1.5,
                            "source_quote": "X was associated with WMH (p=1e-8).",
                        }
                    ]
                }
            )

    def test_an_off_vocabulary_trait_raises(self):
        """The enum is a decoding constraint *and* a validation one.

        Strict tool use should make an off-vocabulary trait impossible on
        the wire; this is what catches one arriving anyway -- from the
        batch path, a retry, or a schema that stopped being sent.
        """
        with pytest.raises(ValidationError):
            ExtractionResult.model_validate(
                {
                    "genes": [
                        {
                            "gene_symbol": "X",
                            "confidence": 0.9,
                            "gwas_trait": ["white matter hyperintensities"],
                            "source_quote": "X was associated with WMH (p=1e-8).",
                        }
                    ]
                }
            )


# ---------------------------------------------------------------------------
# extract_from_paper — module-level interface tests (no LLM call)
# ---------------------------------------------------------------------------


class TestExtractFromPaper:
    async def test_empty_text_returns_empty(self):
        genes, usage = await extract_from_paper("", "12345678")
        assert genes == []
        assert usage.total_tokens == 0

    async def test_whitespace_text_returns_empty(self):
        genes, usage = await extract_from_paper("   \n  ", "12345678")
        assert genes == []

    async def test_nonempty_text_creates_and_caches_client(
        self, mocker, monkeypatch
    ):
        client = MagicMock()
        expected = ([], TokenUsage(input_tokens=4, output_tokens=2))
        client.extract = AsyncMock(return_value=expected)
        constructor = mocker.patch(
            "pipeline.llm_extraction.AnthropicClient", return_value=client
        )
        monkeypatch.setattr(llm_extraction, "_client", None)

        result = await extract_from_paper("paper text", "12345678")

        assert result == expected
        constructor.assert_called_once_with()
        client.extract.assert_awaited_once()
        await_args = client.extract.await_args
        assert await_args is not None
        config = await_args.args[2]
        assert isinstance(config, PipelineConfig)

    async def test_passes_explicit_config_and_limiter_to_cached_client(
        self, monkeypatch
    ):
        client = MagicMock()
        client.extract = AsyncMock(return_value=([], TokenUsage()))
        monkeypatch.setattr(llm_extraction, "_client", client)
        config = PipelineConfig(llm_max_tokens=4096)
        limiter = MagicMock()

        await extract_from_paper("paper text", "1", config, limiter)

        client.extract.assert_awaited_once_with("paper text", "1", config, limiter)


class TestCloseAsyncClient:
    async def test_closes_and_clears_cached_client(self, monkeypatch):
        client = MagicMock()
        client.close = AsyncMock()
        monkeypatch.setattr(llm_extraction, "_client", client)

        await close_async_client()

        client.close.assert_awaited_once_with()
        assert llm_extraction._client is None

    async def test_is_idempotent_before_initialization(self, monkeypatch):
        monkeypatch.setattr(llm_extraction, "_client", None)

        await close_async_client()

        assert llm_extraction._client is None
