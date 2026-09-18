"""v7 plus the cSVD disease file *is* v6, byte for byte.

The fixtures are the v6 literals as they were before the split, pinned by
sha256 so the fixture itself cannot drift. Every recorded cassette, the
recall baseline and Anthropic's prompt cache depend on these bytes.
"""

import hashlib
from pathlib import Path

import pytest

from pipeline.config import PipelineConfig
from pipeline.disease import load_disease
from pipeline.prompts import (
    _PROMPTS,
    PROMPT_VERSIONS,
    _refuse_orphan_sections,
    _render_steps,
    build_extraction_prompt,
    prompt_sha256,
    render_prompt,
)

_FIXTURES = Path(__file__).parent / "fixtures"
_SYSTEM_SHA = "f571dedb6f88abf2291d4c8568482150db1c1b2e94f1f778d3fc145e01b5f3e4"
_INSTRUCTIONS_SHA = "70908abc03022ed389fda9c8351cab8f1eb46a9afc1aa62383bd5d72812ba853"
_TASK_SHA = "b3b2344a9a5d220b53f120985d4a1330dea6f301344e8bbf3f73c7209da4ba9a"


def _fixture(name: str, sha: str) -> str:
    text = (_FIXTURES / name).read_text(encoding="utf-8")
    assert hashlib.sha256(text.encode("utf-8")).hexdigest() == sha, name
    return text


def test_v7_with_the_csvd_sections_reproduces_v6_byte_for_byte() -> None:
    system, instructions = _PROMPTS["v7"]
    assert system == _fixture("prompt_v6_system.txt", _SYSTEM_SHA)
    assert instructions == _fixture("prompt_v6_instructions.txt", _INSTRUCTIONS_SHA)
    assert len(instructions) == 18469


def test_the_task_instruction_and_tool_description_are_unchanged() -> None:
    prompt = build_extraction_prompt("paper", "1", 1000, prompt_version="v7")
    assert (
        hashlib.sha256(prompt.task_instruction.encode("utf-8")).hexdigest() == _TASK_SHA
    )
    assert PipelineConfig().extraction_tool["description"] == (
        "Report every gene with a putative causal link to cerebral small vessel "
        "disease found in the document."
    )


def test_only_v7_exists() -> None:
    assert set(PROMPT_VERSIONS) == {"v7"}


def test_prompt_sha256_covers_system_and_instructions() -> None:
    system, instructions = _PROMPTS["v7"]
    expected = hashlib.sha256(
        system.encode("utf-8") + b"\n\n" + instructions.encode("utf-8")
    ).hexdigest()
    assert prompt_sha256() == expected


class TestRenderer:
    def test_substitutes_a_slot(self) -> None:
        assert render_prompt("a {{ x.y }} b", {"x.y": "Z"}) == "a Z b"

    def test_refuses_an_unknown_slot(self) -> None:
        with pytest.raises(ValueError, match="x.y"):
            render_prompt("{{ x.y }}", {})

    def test_refuses_an_unreferenced_section(self) -> None:
        with pytest.raises(ValueError, match="unused"):
            render_prompt("plain", {"unused": "v"})

    def test_refuses_a_residual_brace_pair(self) -> None:
        with pytest.raises(ValueError, match="unrendered"):
            render_prompt("{{ a }}", {"a": "{{ b }}", "b": "x"})


class TestOrphanSections:
    """No template reads it, so an edit to it changes nothing and says nothing."""

    def test_accepts_a_section_some_template_reads(self) -> None:
        _refuse_orphan_sections(["a.b"], {"a.b"})

    def test_refuses_a_section_no_template_reads(self) -> None:
        with pytest.raises(ValueError, match="a.b"):
            _refuse_orphan_sections(["a.b"], set())


def test_every_rendered_step_is_stripped() -> None:
    """One step per line is the shape; padding would break the numbering."""
    rendered = _render_steps("\n  padded disease step  \n\n\n  a second one\n")
    assert "10. padded disease step" in rendered
    assert "11. a second one" in rendered
    for line in rendered.split("\n"):
        number, body = line.split(". ", 1)
        assert number.isdigit()
        assert body == body.strip()


def test_the_monogenic_list_in_the_prompt_matches_the_manifest() -> None:
    d = load_disease()
    listed = tuple(
        s.strip() for s in d.prompt_sections["strategy.monogenic_genes"].split(",")
    )
    assert listed == d.monogenic_genes
