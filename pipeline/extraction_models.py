"""Shared Pydantic models and parsing for LLM gene extraction."""

import json
from pathlib import Path
from typing import Annotated, Final

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, WithJsonSchema

from pipeline.disease import VOCABULARY_PATH
from pipeline.quality_metrics import TokenUsage

# ---------------------------------------------------------------------------
# VOCABULARY
# ---------------------------------------------------------------------------

# Resolved through `pipeline.disease`, which is stdlib-only: config imports
# ExtractionResult from here to build the tool schema, so importing config
# back would be a cycle.
_VOCABULARY: Final[Path] = VOCABULARY_PATH


def _load_trait_vocabulary() -> tuple[tuple[str, ...], dict[str, str], frozenset[str]]:
    """Load the schema terms, synonym folds, and stored traits together.

    Tracked traits, the prompt's own spellings of them, *and* `untracked`
    ones. Constraining the schema to the tracked set would destroy the
    signal the vocabulary exists to surface: PVWMH was extracted 29 times
    because the model was correctly naming a phenotype the dashboard did
    not carry, and ICH-non-lobar 13 times across the committed cassettes.
    Narrowed to the tracked set, a term like that either silently becomes
    its nearest tracked neighbour or vanishes. The full list keeps the
    model able to say a term the dashboard does not carry, guarantees the
    string is a *known* one, and leaves disposition to the merge, which
    folds the synonyms, keeps TRACKED_TRAITS and logs the rest.

    The prompt-sourced synonyms are here because the enum is what the
    model is told it may say, and the prompt's frozen canonical sentence
    asks for `cerebral-microbleeds` while the tracked key is `CMB`. With
    the spelling refused, a model that obeyed the prompt failed the paper
    after two paid calls; which instruction it followed decided whether
    the paper was lost. A curated synonym stays out: it is a spreadsheet
    spelling the prompt has never asked for.

    All three views come from one read so the schema and merge filters are
    guaranteed to describe the same vocabulary snapshot.
    """
    with _VOCABULARY.open(encoding="utf-8") as handle:
        vocabulary = json.load(handle)

    canonical = tuple(
        [trait["key"] for trait in vocabulary["traits"]]
        + [
            synonym["from"]
            for synonym in vocabulary["synonyms"]
            if synonym["source"] == "prompt"
        ]
        + [entry["term"] for entry in vocabulary["untracked"]]
    )
    synonyms = {synonym["from"]: synonym["to"] for synonym in vocabulary["synonyms"]}
    tracked = frozenset(trait["key"] for trait in vocabulary["traits"])
    return canonical, synonyms, tracked


_TRAIT_VOCABULARY = _load_trait_vocabulary()

CANONICAL_TRAITS: Final[tuple[str, ...]] = _TRAIT_VOCABULARY[0]

# What the merge folds before it filters: the prompt's `cerebral-microbleeds`
# becomes CMB rather than being dropped as untracked. Exact keys only; the
# export's ordered substring rewrites serve curated prose and are not this.
TRAIT_SYNONYMS: Final[dict[str, str]] = _TRAIT_VOCABULARY[1]

# The subset of CANONICAL_TRAITS that may be stored. Every entry is a filter
# choice and a phenogram pill; an `untracked` term stored beside them reaches
# data/table1.json with neither, and tests/data_contract_test.ts fails on
# the first export. Read from the same file so the schema's enum and the
# merge's filter cannot drift apart.
TRACKED_TRAITS: Final[frozenset[str]] = _TRAIT_VOCABULARY[2]
del _TRAIT_VOCABULARY

def _validate_canonical_trait(value: str) -> str:
    """Reject a trait outside the vocabulary loaded above."""
    if value not in CANONICAL_TRAITS:
        raise ValueError(f"Unknown canonical trait: {value}")
    return value


# The validator constrains Pydantic at runtime while WithJsonSchema gives the
# strict extraction tool the same real JSON-Schema enum the previous dynamic
# Literal produced. Annotated keeps the Python-facing type honestly `str`:
# values loaded from JSON cannot be expressed as static Literal parameters.
CanonicalTrait = Annotated[
    str,
    AfterValidator(_validate_canonical_trait),
    WithJsonSchema({"enum": list(CANONICAL_TRAITS), "type": "string"}),
]

# ---------------------------------------------------------------------------
# MODELS
# ---------------------------------------------------------------------------


class GeneEntry(BaseModel):
    """Extracted gene entry from paper analysis."""

    model_config = ConfigDict(
        str_strip_whitespace=True,
        validate_default=True,
    )

    # Non-blank after str_strip_whitespace: an empty symbol would reach NCBI
    # as `[Sym] AND Homo sapiens[Organism]` and validate as whatever that
    # query happens to return first.
    gene_symbol: str = Field(min_length=1)
    protein_name: str | None = None
    gwas_trait: list[CanonicalTrait] = Field(default_factory=list)
    mendelian_randomization: bool = False
    omics_evidence: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    causal_evidence_summary: str | None = None
    pmid: str = ""
    # Verbatim sentence from the paper supporting this entry. Required.
    # Citations cannot be combined with output_config.format (400), which
    # is why the schema travels on a tool instead -- see
    # PipelineConfig.extraction_tool. With that in place the API also
    # returns citation spans, and pipeline/citations.py checks this field
    # against them, so the quote is verified rather than merely requested.
    source_quote: str = Field(min_length=1)


class ExtractionResult(BaseModel):
    """Wrapper model for structured extraction."""

    genes: list[GeneEntry] = Field(default_factory=list)


class ExtractionFailedError(RuntimeError):
    """Raised when an extraction attempt failed rather than found no genes."""

    def __init__(self, message: str, token_usage: TokenUsage | None = None) -> None:
        super().__init__(message)
        self.token_usage = token_usage
