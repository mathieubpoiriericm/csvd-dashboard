"""v7 plus the cSVD disease file *is* v6, byte for byte.

The fixtures are the v6 literals as they were before the split, pinned by
sha256 so the fixture itself cannot drift. Every recorded cassette, the
recall baseline and Anthropic's prompt cache depend on these bytes. The
generic renderer tests stay in tests/pipeline/test_prompt_assembly.py; this
module is the cSVD record and a fork deletes it with the rest of csvd/.
"""

import hashlib
from pathlib import Path

from pipeline.config import PipelineConfig
from pipeline.prompts import _PROMPTS, build_extraction_prompt

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
