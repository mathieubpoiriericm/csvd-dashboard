"""The disease this pipeline serves, read once from ``disease/manifest.json``,
``disease/pipeline.json`` and ``disease/prompt.md``.

Stdlib only, and it imports nothing from ``pipeline``: ``extraction_models``
and ``config`` both read it, and ``config`` imports ``extraction_models``,
so anything heavier here is a cycle waiting to happen. The directory is
resolved from this file rather than from ``config.PROJECT_ROOT`` for the
same reason.

Every term list is a tuple and every mapping is read-only so a caller
cannot mutate the shared instance; ``load_disease`` is cached and the
dataclass is frozen.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final

DISEASE_DIR: Final[Path] = Path(__file__).resolve().parent.parent / "disease"
MANIFEST_PATH: Final[Path] = DISEASE_DIR / "manifest.json"
PIPELINE_PATH: Final[Path] = DISEASE_DIR / "pipeline.json"
VOCABULARY_PATH: Final[Path] = DISEASE_DIR / "vocabulary.json"
OMIM_CSV_PATH: Final[Path] = DISEASE_DIR / "omim_info.csv"
PROMPT_PATH: Final[Path] = DISEASE_DIR / "prompt.md"
PHENOGRAM_PATH: Final[Path] = DISEASE_DIR / "phenogram.json"
TIMELINE_PATH: Final[Path] = DISEASE_DIR / "timeline.json"

SCHEMA_VERSION: Final[int] = 1

_MANIFEST = "disease/manifest.json"
_PIPELINE = "disease/pipeline.json"
_PROMPT = "disease/prompt.md"

_HEADING: Final[re.Pattern[str]] = re.compile(
    r"^## (?P<id>[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*$", re.M
)


@dataclass(frozen=True, slots=True)
class Disease:
    """What the manifest and pipeline document say, in the pipeline's shapes."""

    key: str
    name: str
    short: str
    abbreviation: str
    run_label: str
    pubmed_disease_terms: tuple[str, ...]
    pubmed_marker_terms: tuple[str, ...]
    pubmed_mesh_terms: tuple[str, ...]
    ct_search_terms: tuple[str, ...]
    ct_condition_substrings: tuple[str, ...]
    ct_condition_pairs: tuple[tuple[str, str], ...]
    gene_aliases: Mapping[str, tuple[str, ...]]
    monogenic_genes: tuple[str, ...]
    max_genes_per_paper: int
    population_keys: tuple[str, ...]
    population_label: str
    population_details_label: str
    # The prose halves of the extraction prompt, one entry per `## id`
    # heading in disease/prompt.md, and the hash of the file they were read
    # from: an edit to the prompt changes what the model is asked, so the
    # run record carries the file's bytes as well as the version name.
    prompt_sections: Mapping[str, str]
    prompt_file_sha256: str


def _at(raw: Mapping[str, Any], path: str, filename: str) -> Any:
    """Walk a dotted path, naming the file and the missing key in the error."""
    node: Any = raw
    for part in path.split("."):
        if not isinstance(node, Mapping) or part not in node:
            raise ValueError(f"{filename}: missing {path}")
        node = node[part]
    return node


def _text(raw: Mapping[str, Any], path: str, filename: str) -> str:
    value = _at(raw, path, filename)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{filename}: {path} must be a non-empty string")
    return value.strip()


def _terms(raw: Mapping[str, Any], path: str, filename: str) -> tuple[str, ...]:
    value = _at(raw, path, filename)
    if not isinstance(value, list) or not all(
        isinstance(t, str) and t.strip() for t in value
    ):
        raise ValueError(f"{filename}: {path} must be a list of non-empty strings")
    return tuple(t.strip() for t in value)


def _check_schema_version(raw: Mapping[str, Any], filename: str) -> None:
    if _at(raw, "schemaVersion", filename) != SCHEMA_VERSION:
        raise ValueError(f"{filename}: schemaVersion must be {SCHEMA_VERSION}")


def _parse_prompt_sections(text: str) -> dict[str, str]:
    """``## id`` headings to bodies, blank lines at either end stripped."""
    matches = list(_HEADING.finditer(text))
    if not matches:
        raise ValueError(f"{_PROMPT}: no '## <section.id>' headings")
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        key = match.group("id")
        if key in sections:
            raise ValueError(f"{_PROMPT}: duplicate section {key}")
        sections[key] = text[start:end].strip("\n")
    return sections


def _parse_manifest(
    manifest_raw: Mapping[str, Any],
    pipeline_raw: Mapping[str, Any],
    prompt_sections: Mapping[str, str] = MappingProxyType({}),
    prompt_file_sha256: str = "",
) -> Disease:
    """Read disease/site prose from the manifest, gene symbols and search
    terms from the pipeline document. Neither carries the other: the manifest
    is bundled into every island's client chunk, so a gene symbol belongs in
    the pipeline document or nowhere.
    """
    _check_schema_version(manifest_raw, _MANIFEST)
    _check_schema_version(pipeline_raw, _PIPELINE)

    pairs_raw = _at(pipeline_raw, "search.clinicalTrials.conditionPairs", _PIPELINE)
    if not isinstance(pairs_raw, list) or not all(
        isinstance(p, list) and len(p) == 2 and all(isinstance(w, str) for w in p)
        for p in pairs_raw
    ):
        raise ValueError(
            f"{_PIPELINE}: search.clinicalTrials.conditionPairs must be "
            "a list of two-string lists"
        )
    aliases_raw = _at(pipeline_raw, "geneAliases", _PIPELINE)
    if not isinstance(aliases_raw, Mapping):
        raise ValueError(f"{_PIPELINE}: geneAliases must be an object")
    aliases = {
        key: tuple(_terms({"v": members}, "v", _PIPELINE))
        for key, members in aliases_raw.items()
    }
    populations = _at(manifest_raw, "populations", _MANIFEST)
    if not isinstance(populations, list) or not populations:
        raise ValueError(f"{_MANIFEST}: populations must be a non-empty list")
    keys = tuple(_text(p, "key", _MANIFEST) for p in populations)
    cap = _at(pipeline_raw, "pipeline.maxGenesPerPaper", _PIPELINE)
    if not isinstance(cap, int) or cap < 1:
        raise ValueError(
            f"{_PIPELINE}: pipeline.maxGenesPerPaper must be a positive integer"
        )
    return Disease(
        key=_text(manifest_raw, "disease.key", _MANIFEST),
        name=_text(manifest_raw, "disease.name", _MANIFEST),
        short=_text(manifest_raw, "disease.short", _MANIFEST),
        abbreviation=_text(manifest_raw, "disease.abbreviation", _MANIFEST),
        run_label=_text(pipeline_raw, "pipeline.runLabel", _PIPELINE),
        pubmed_disease_terms=_terms(
            pipeline_raw, "search.pubmed.diseaseTerms", _PIPELINE
        ),
        pubmed_marker_terms=_terms(
            pipeline_raw, "search.pubmed.markerTerms", _PIPELINE
        ),
        pubmed_mesh_terms=_terms(pipeline_raw, "search.pubmed.meshTerms", _PIPELINE),
        ct_search_terms=_terms(
            pipeline_raw, "search.clinicalTrials.searchTerms", _PIPELINE
        ),
        ct_condition_substrings=_terms(
            pipeline_raw, "search.clinicalTrials.conditions", _PIPELINE
        ),
        ct_condition_pairs=tuple((a, b) for a, b in pairs_raw),
        gene_aliases=MappingProxyType(aliases),
        monogenic_genes=_terms(pipeline_raw, "monogenicGenes", _PIPELINE),
        max_genes_per_paper=cap,
        population_keys=keys,
        population_label=_text(manifest_raw, "populationField.label", _MANIFEST),
        population_details_label=_text(
            manifest_raw, "populationField.detailsLabel", _MANIFEST
        ),
        prompt_sections=MappingProxyType(dict(prompt_sections)),
        prompt_file_sha256=prompt_file_sha256,
    )


@cache
def load_disease() -> Disease:
    """Read the manifest, the pipeline document and the prompt once per process."""
    with MANIFEST_PATH.open(encoding="utf-8") as handle:
        manifest_raw = json.load(handle)
    with PIPELINE_PATH.open(encoding="utf-8") as handle:
        pipeline_raw = json.load(handle)
    prompt_bytes = PROMPT_PATH.read_bytes()
    return _parse_manifest(
        manifest_raw,
        pipeline_raw,
        prompt_sections=_parse_prompt_sections(prompt_bytes.decode("utf-8")),
        prompt_file_sha256=hashlib.sha256(prompt_bytes).hexdigest(),
    )
