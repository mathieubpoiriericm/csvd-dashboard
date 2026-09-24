"""The v7 template renderer: slots, orphans, step numbering, the hash.

The byte-identity record -- v7 plus this repository's disease file equals
the v6 literals -- is tests/pipeline/csvd/test_prompt_assembly.py, because
it pins one disease's rendering; everything here holds for any disease file.
"""

import dataclasses
import hashlib
import re

import pytest

from pipeline.disease import load_disease
from pipeline.prompts import (
    _PROMPTS,
    PROMPT_VERSIONS,
    _assemble,
    _refuse_orphan_sections,
    _render_steps,
    prompt_sha256,
    render_prompt,
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
    # An empty section is an empty list: a disease with no monogenic gene
    # leaves the section blank, and "".split(",") is [""] rather than [].
    section = d.prompt_sections["strategy.monogenic_genes"]
    listed = tuple(s.strip() for s in section.split(",") if s.strip())
    assert listed == d.monogenic_genes


def _step_numbers(instructions: str) -> list[int]:
    block = instructions.split("<extraction_strategy>")[1]
    block = block.split("</extraction_strategy>")[0]
    return [int(m.group(1)) for m in re.finditer(r"^(\d+)\. ", block, re.M)]


def test_a_disease_with_no_monogenic_gene_is_told_of_none() -> None:
    """No "monogenic genes ()", and no "(e.g., )" naming nothing."""
    d = load_disease()

    def with_monogenic(genes: str, background: str, examples: str) -> str:
        sections = {
            **d.prompt_sections,
            "strategy.monogenic_genes": genes,
            "strategy.background_example": background,
            "rubric.monogenic_examples": examples,
        }
        return _assemble(dataclasses.replace(d, prompt_sections=sections))[1]

    instructions = with_monogenic("", "", "")
    assert "()" not in instructions
    assert "(e.g., )" not in instructions
    assert "background sentences like" not in instructions
    assert "monogenic cause with understood mechanism OR GWAS" in instructions
    numbers = _step_numbers(instructions)
    assert numbers == list(range(1, len(numbers) + 1))

    # With genes, the step and the examples are there, one step longer.
    full = with_monogenic("GENEX", "GENEX causes the familial form.", "GENEX")
    assert full.count("background sentences like") == 1
    assert "understood mechanism (e.g., GENEX)" in full
    assert len(_step_numbers(full)) == len(numbers) + 1
