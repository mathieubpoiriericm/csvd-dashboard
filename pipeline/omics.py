"""Omics evidence as the extraction reports it, and its wire form.

The model reports each study as a type, the biomarker it tested and the items
-- tissues, cell types, reference datasets -- the gene was significant in,
each flagged when the paper reports significant colocalization there. The
dashboard stores and publishes it in the curated table's wire form,
`Type;<biomarker>: <item>, <item>*`, where `*` marks a colocalized item, so
an extracted entry and a curated one read alike (`lib/omics.ts` parses both).

Only the flag writes a `*`. The model's own text has every `*` removed, so a
star it copied from a paper's table cannot claim a colocalization, and every
`;` becomes `,`, because `;` separates the type from its detail.

Stdlib and pydantic only: `pipeline/extraction_models.py` and the export both
import it.
"""

import json
from collections.abc import Iterable, Sequence
from typing import Annotated, Final

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, WithJsonSchema

# The sentence the curated table uses for one study, and the type it stands
# for -- a filter choice of its own.
MENTR_SENTENCE: Final[str] = (
    "Evidence for causal implication from ML-based functional prediction (MENTR)"
)
MENTR_LABEL: Final[str] = "mutation effect prediction on ncRNA transcription"

# Every study type the dashboard publishes and can filter on, in the order of
# `OMICS_CHOICES` in lib/constants.ts (tests/pipeline/export/test_tables.py
# reconciles the two). The extraction's enum is this tuple, so the model
# cannot name a study the export would drop.
OMICS_STUDY_TYPES: Final[tuple[str, ...]] = (
    "EWAS",
    "TWAS",
    "PWAS",
    "Proteomics",
    "WES/WGS",
    "Proteogenomic MR",
    "Fine-mapping",
    "Experimental",
    MENTR_LABEL,
)


def _validate_study_type(value: str) -> str:
    if value not in OMICS_STUDY_TYPES:
        raise ValueError(f"Unknown omics study type: {value}")
    return value


OmicsStudyType = Annotated[
    str,
    AfterValidator(_validate_study_type),
    WithJsonSchema({"enum": list(OMICS_STUDY_TYPES), "type": "string"}),
]


class OmicsItem(BaseModel):
    """One tissue, cell type or reference dataset of a study."""

    model_config = ConfigDict(str_strip_whitespace=True)

    text: str = Field(min_length=1)
    colocalized: bool = False


class OmicsEvidence(BaseModel):
    """One omics study the paper reports for a gene."""

    model_config = ConfigDict(str_strip_whitespace=True)

    study_type: OmicsStudyType
    biomarker: str | None = None
    items: list[OmicsItem] = Field(default_factory=list)


def _clean(text: str) -> str:
    return text.replace("*", "").replace(";", ",").strip()


def to_wire(evidence: OmicsEvidence) -> str:
    """`Type`, `Type;biomarker`, `Type;biomarker: a*, b` or `Type;a*, b`."""
    items = ", ".join(
        _clean(item.text) + ("*" if item.colocalized else "")
        for item in evidence.items
        if _clean(item.text)
    )
    biomarker = _clean(evidence.biomarker or "")
    detail = f"{biomarker}: {items}" if biomarker and items else biomarker or items
    return f"{evidence.study_type};{detail}" if detail else evidence.study_type


def omics_array(entries: Sequence[str]) -> str:
    """The stored form `clean_omics_value` publishes verbatim: a JSON array
    of wire entries, each `;` escaped so the gene merge's `;` split sees one
    element (see "The omics column has two stored forms" in
    .claude/rules/gene-lists.md)."""
    return json.dumps(list(entries), ensure_ascii=False).replace(";", "\\u003b")


def wire_strings(values: Iterable[object]) -> list[str]:
    """Wire entries from what a report or checkpoint holds: a string from
    before v8, a dict of a structured entry, or the model itself."""
    out: list[str] = []
    for value in values:
        if isinstance(value, str):
            out.append(value)
        elif isinstance(value, OmicsEvidence):
            out.append(to_wire(value))
        else:
            out.append(to_wire(OmicsEvidence.model_validate(value)))
    return out
