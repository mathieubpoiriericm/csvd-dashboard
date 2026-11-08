"""v8 plus the cSVD disease file is v6, byte for byte, but for its omics lines.

The fixtures are the v6 literals as they were before the v7 split, pinned by
sha256 so the fixture itself cannot drift. v7 reproduced them exactly; v8
changes only what `_V8_CHANGES` lists -- the `omics_evidence` field guidance
and the examples' `omics_evidence=` -- so every other byte the recall
baseline was measured on is still pinned here. The generic renderer tests
stay in tests/pipeline/test_prompt_assembly.py; this module is the cSVD
record and a fork deletes it with the rest of csvd/.
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


_V7_OMICS_GUIDANCE = (
    '- omics_evidence: Type of omics/analytical study. Use labels such as: "TWAS", '
    '"PWAS", "EWAS", "colocalization", "MAGMA", "MTAG", "pQTL-MR", "WES/WGS", '
    '"cell-type enrichment", "scRNA-seq annotation", "PRS", "fine-mapping".'
)
_V8_OMICS_GUIDANCE = (
    "- omics_evidence: One entry per omics or analytical study the paper reports "
    "for this gene, other than the GWAS itself. For each: study_type, one of "
    '"EWAS", "TWAS", "PWAS", "Proteomics", "WES/WGS", "Proteogenomic MR", '
    '"Fine-mapping", "Experimental", "mutation effect prediction on ncRNA '
    'transcription" ("Experimental" for functional or animal-model work); '
    "biomarker, the phenotype the study tested, using the canonical trait "
    "abbreviations above where one applies; items, each tissue, cell type or "
    "reference dataset the gene was significant in, written as the paper names "
    'it (a reference dataset as "<dataset>: <tissue>", e.g. "YFS: blood"), with '
    "colocalized set to true only when the paper reports significant "
    "colocalization for that tissue, and as a last item any other evidence the "
    'study adds (e.g. "RNA-Seq"). Colocalization, MAGMA, MTAG and PRS are not '
    "study types: colocalization is the per-item flag, and the others belong to "
    "the GWAS evidence."
)

# Each (v6/v7 text, v8 text) pair occurs exactly once in the v6 fixture.
_V8_CHANGES = (
    (_V7_OMICS_GUIDANCE, _V8_OMICS_GUIDANCE),
    (
        'omics_evidence=["TWAS", "colocalization"], confidence=1.0',
        'omics_evidence=[{"study_type": "TWAS", "biomarker": "WMH"}, '
        '{"study_type": "Experimental", "items": [{"text": "siRNA knockdown in '
        'brain endothelial cells"}, {"text": "Trim47-deficient mice"}]}], '
        "confidence=1.0",
    ),
    (
        'omics_evidence=["TWAS", "MAGMA"]',
        'omics_evidence=[{"study_type": "TWAS", "biomarker": "WMH"}]',
    ),
    (', omics_evidence=["MTAG"], confidence=0.60', ", confidence=0.60"),
    (
        "as transcriptome-wide significant (p = 2.8e-6) with colocalization",
        "as transcriptome-wide significant in brain cortex (p = 2.8e-6) with "
        "colocalization",
    ),
    (
        'omics_evidence=["TWAS", "colocalization"], confidence=0.75',
        'omics_evidence=[{"study_type": "TWAS", "biomarker": "WM-PVS", "items": '
        '[{"text": "brain cortex", "colocalized": true}]}], confidence=0.75',
    ),
    (
        'omics_evidence=["TWAS"], confidence=0.70',
        'omics_evidence=[{"study_type": "TWAS", "biomarker": "BG-PVS", "items": '
        '[{"text": "brain cortex"}]}], confidence=0.70',
    ),
    (
        'omics_evidence=["pQTL-MR"]',
        'omics_evidence=[{"study_type": "Proteogenomic MR", "biomarker": "WMH"}]',
    ),
)


def test_v8_with_the_csvd_sections_is_v6_but_for_the_omics_lines() -> None:
    system, instructions = _PROMPTS["v8"]
    assert system == _fixture("prompt_v6_system.txt", _SYSTEM_SHA)
    expected = _fixture("prompt_v6_instructions.txt", _INSTRUCTIONS_SHA)
    for old, new in _V8_CHANGES:
        assert expected.count(old) == 1, old
        expected = expected.replace(old, new)
    assert instructions == expected


def test_the_task_instruction_and_tool_description_are_unchanged() -> None:
    prompt = build_extraction_prompt("paper", "1", 1000, prompt_version="v8")
    assert (
        hashlib.sha256(prompt.task_instruction.encode("utf-8")).hexdigest() == _TASK_SHA
    )
    assert PipelineConfig().extraction_tool["description"] == (
        "Report every gene with a putative causal link to cerebral small vessel "
        "disease found in the document."
    )
