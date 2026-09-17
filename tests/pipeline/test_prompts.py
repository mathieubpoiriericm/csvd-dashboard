"""Tests for pipeline.prompts — message structure and content checks."""

import pytest

from pipeline.prompts import (
    _PROMPTS,
    PROMPT_VERSIONS,
    build_extraction_prompt,
    paper_text_truncated,
)

DEFAULT_SYSTEM_PROMPT, DEFAULT_EXTRACTION_INSTRUCTIONS = _PROMPTS["v6"]


def test_prompt_versions_is_derived_from_the_registry() -> None:
    """PipelineConfig refuses every name outside this set, so a hand-listed
    one would refuse a version that exists (or accept one that does not)
    the moment the table changes."""
    assert frozenset(_PROMPTS) == PROMPT_VERSIONS


def test_only_v6_remains() -> None:
    """One prompt, and v4 is gone because it was measured, not assumed.

    v4 held two exclusion guards v5 relaxed (MTAG locus labels,
    multi-phenotype positional candidates), and was kept until the harness
    could say whether they recovered precision. Recording both arms over
    the same ten fixtures gave identical pooled recall (42/46) while the
    stricter arm returned *more* genes, 144 against 138. The guards are
    ruled out rather than assumed.
    """
    assert set(_PROMPTS) == {"v6"}


class TestSystemPrompt:
    def test_contains_csvd(self):
        assert "cSVD" in DEFAULT_SYSTEM_PROMPT

    def test_contains_role(self):
        assert "systematic reviewer" in DEFAULT_SYSTEM_PROMPT

    def test_mentions_causal_distinction(self):
        assert "causal" in DEFAULT_SYSTEM_PROMPT
        assert "association" in DEFAULT_SYSTEM_PROMPT


class TestExtractionInstructions:
    def test_contains_task_xml(self):
        assert "<task>" in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_contains_confidence_scoring_xml(self):
        assert "<confidence_scoring>" in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_mentions_gwas(self):
        assert "GWAS" in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_mentions_mendelian_randomization(self):
        assert "Mendelian randomization" in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_mentions_omics(self):
        assert "TWAS" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "PWAS" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "EWAS" in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_has_xml_structure(self):
        assert "<instructions>" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "</instructions>" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "<inclusion_criteria>" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "<extraction_strategy>" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "<field_guidance>" in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_has_examples(self):
        assert "<examples>" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert 'type="include_validated"' in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert 'type="include_high_confidence"' in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert 'type="exclude_general_stroke"' in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert 'type="exclude_pathway_only"' in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert 'type="exclude_background_monogenic"' in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_has_positional_candidate_exclusion_example(self):
        assert 'type="exclude_positional_candidate"' in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_has_orf_gene_example(self):
        assert 'type="include_orf_gene"' in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_positional_candidate_warning(self):
        assert "positional candidate" in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_confidence_hard_cap(self):
        assert "maximum score is 0.30" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "hard cap of 0.20" in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_gwas_trait_vocabulary(self):
        """GWAS traits in prompt should use canonical abbreviations."""
        assert "WMH" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "DWMH" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "PVWMH" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "SVS" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "BG-PVS" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "WM-PVS" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "HIP-PVS" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "PSMD" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "MD" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "extreme-cSVD" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "FA" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "ICH-lobar" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "ICH-non-lobar" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "DTI-ALPS" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "ICVF" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "ISOVF" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "WMH-cortical-atrophy" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "WM-BAG" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "retinal-vessels" in DEFAULT_EXTRACTION_INSTRUCTIONS

    def test_grounding_instruction(self):
        """Should instruct the model to verify evidence before extracting."""
        assert "Identify all passages" in DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "Verify" in DEFAULT_EXTRACTION_INSTRUCTIONS


class TestBuildExtractionPrompt:
    def test_returns_extraction_prompt(self):
        prompt = build_extraction_prompt(
            paper_text="Test paper", pmid="12345678", max_chars=50000
        )
        assert isinstance(prompt.system_prompt, str)
        assert isinstance(prompt.extraction_instructions, str)
        assert isinstance(prompt.document_text, str)
        assert isinstance(prompt.task_instruction, str)

    def test_parts_match_canonical_constants(self):
        """Pins the v6 dispatch specifically — independent of whichever
        version the function currently defaults to."""
        prompt = build_extraction_prompt(
            paper_text="Test", pmid="111", max_chars=50000, prompt_version="v6"
        )
        assert prompt.system_prompt == DEFAULT_SYSTEM_PROMPT
        assert prompt.extraction_instructions == DEFAULT_EXTRACTION_INSTRUCTIONS
        assert "<instructions>" in prompt.extraction_instructions

    def test_the_task_instruction_asks_for_prose_before_the_tool_call(self):
        """Citations attach to text blocks, so there has to be one.

        A turn that goes straight to report_genes emits no text and
        therefore no citation spans, which leaves every source_quote
        unverifiable -- the measurement pipeline/citations.py exists to
        make would report 0/N on every paper.
        """
        prompt = build_extraction_prompt(paper_text="Test", pmid="111", max_chars=50000)
        instruction = prompt.task_instruction
        assert "one sentence" in instruction
        assert instruction.index("first state") < instruction.index("report_genes")

    def test_paper_text_arrives_verbatim(self):
        prompt = build_extraction_prompt(
            paper_text="Specific paper content here",
            pmid="111",
            max_chars=50000,
        )
        assert prompt.document_text == "Specific paper content here"

    def test_max_chars_truncation(self):
        long_text = "A" * 100_000
        prompt = build_extraction_prompt(
            paper_text=long_text, pmid="111", max_chars=1000
        )
        assert len(prompt.document_text) == 1000

    def test_the_report_asks_the_same_question_the_builder_answers(self):
        """One predicate, or the run report goes quiet about a real loss.

        The tail of a truncated paper -- its supplementary gene-level
        tables -- is never read, and the paper is still retired as
        processed, so `_record_processing_actions` has to be able to name
        it. It reads `paper_text_truncated`, and so does the builder.
        """
        for length, max_chars in ((1000, 1000), (1001, 1000), (999, 1000)):
            text = "A" * length
            cut = len(build_extraction_prompt(text, "111", max_chars).document_text)
            assert paper_text_truncated(text, max_chars) == (cut < length)

    def test_a_closing_document_tag_is_no_longer_escaped(self):
        """The API owns the boundary now, so the paper is sent as-is.

        The old wrapper escaped </document> to stop the paper closing the
        tag early. Escaping it now would corrupt the text -- and shift
        every citation offset past the substitution.
        """
        prompt = build_extraction_prompt(
            paper_text="A sentence mentioning </document> literally.",
            pmid="111",
            max_chars=50000,
        )
        assert prompt.document_text == "A sentence mentioning </document> literally."

    def test_document_text_is_raw_paper_text_without_an_xml_wrapper(self):
        """Citation offsets index the document block's bytes.

        The old user_text wrapped the paper in <document source="PubMed">
        and escaped </document> to stop the tag closing early. A real
        document block needs neither, and a wrapper would shift every
        citation offset by the length of the opening tag.
        """
        prompt = build_extraction_prompt(
            paper_text="ICA1L is significant.",
            pmid="12345678",
            max_chars=1000,
            prompt_version="v6",
        )
        assert prompt.document_text == "ICA1L is significant."
        assert "<document" not in prompt.document_text
        assert "12345678" not in prompt.document_text

    def test_truncation_still_applies_to_the_document_text(self):
        prompt = build_extraction_prompt(
            paper_text="x" * 500,
            pmid="12345678",
            max_chars=100,
            prompt_version="v6",
        )
        assert len(prompt.document_text) == 100

    def test_v6_dispatch_adds_provenance_instruction(self):
        """v6 prompt should demand a verbatim source_quote and forbid paraphrase."""
        prompt = build_extraction_prompt(
            paper_text="Test", pmid="111", max_chars=50000, prompt_version="v6"
        )
        instructions = prompt.extraction_instructions
        assert "## Provenance" in instructions
        assert "source_quote" in instructions
        assert "verbatim sentence" in instructions
        assert "not paraphrase" in instructions.lower()
        assert "stitch two sentences" in instructions

    def test_default_version_is_v6(self):
        """The parameter default must track production (config.py defaults
        PIPELINE_PROMPT_VERSION to v6). v4 carries no verbatim-quote
        instruction, so a stale v4 default would silently let paraphrased
        quotes pass GeneEntry.source_quote validation undetected."""
        prompt = build_extraction_prompt(paper_text="Test", pmid="111", max_chars=50000)
        v6_prompt = build_extraction_prompt(
            paper_text="Test", pmid="111", max_chars=50000, prompt_version="v6"
        )
        assert prompt.extraction_instructions == v6_prompt.extraction_instructions
        assert prompt.system_prompt == v6_prompt.system_prompt

    def test_an_unknown_version_raises_rather_than_falling_back(self):
        """The fallback to v6 built the right prompt under the wrong name.

        Nothing downstream re-derived the version actually used:
        report_metadata, the published run report and the checkpoint
        fingerprint all read `config.prompt_version`, so the fallback made
        every record of the run name a prompt that does not exist.
        PipelineConfig refuses the name first now; this is the backstop for
        a direct caller.
        """
        with pytest.raises(ValueError, match="Unknown prompt version"):
            build_extraction_prompt(
                paper_text="Test",
                pmid="111",
                max_chars=50000,
                prompt_version="not-a-real-version",
            )
