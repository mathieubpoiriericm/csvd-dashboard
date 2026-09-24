"""The cSVD trait abbreviations the rendered prompt names.

The structural prompt tests are in tests/pipeline/test_prompts.py; this one
pins the first disease's vocabulary and a fork deletes it with csvd/.
"""

from pipeline.prompts import _PROMPTS

_, DEFAULT_EXTRACTION_INSTRUCTIONS = _PROMPTS["v7"]


def test_gwas_trait_vocabulary() -> None:
    """GWAS traits in the prompt use the canonical cSVD abbreviations."""
    for trait in (
        "WMH",
        "DWMH",
        "PVWMH",
        "SVS",
        "BG-PVS",
        "WM-PVS",
        "HIP-PVS",
        "PSMD",
        "MD",
        "extreme-cSVD",
        "FA",
        "ICH-lobar",
        "ICH-non-lobar",
        "DTI-ALPS",
        "ICVF",
        "ISOVF",
        "WMH-cortical-atrophy",
        "WM-BAG",
        "retinal-vessels",
    ):
        assert trait in DEFAULT_EXTRACTION_INSTRUCTIONS, trait


def test_the_examples_block_carries_the_cSVD_cases() -> None:
    """The worked examples the v6 prompt shipped with, one type each."""
    for kind in (
        "include_validated",
        "include_high_confidence",
        "exclude_general_stroke",
        "exclude_pathway_only",
        "exclude_background_monogenic",
        "exclude_positional_candidate",
        "include_orf_gene",
    ):
        assert f'type="{kind}"' in DEFAULT_EXTRACTION_INSTRUCTIONS, kind
