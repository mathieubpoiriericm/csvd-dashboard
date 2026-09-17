"""The disease this pipeline serves, read once from ``disease/manifest.json``.

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

import json
from collections.abc import Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from types import MappingProxyType
from typing import Any, Final

DISEASE_DIR: Final[Path] = Path(__file__).resolve().parent.parent / "disease"
MANIFEST_PATH: Final[Path] = DISEASE_DIR / "manifest.json"
VOCABULARY_PATH: Final[Path] = DISEASE_DIR / "vocabulary.json"
OMIM_CSV_PATH: Final[Path] = DISEASE_DIR / "omim_info.csv"
PROMPT_PATH: Final[Path] = DISEASE_DIR / "prompt.md"
PHENOGRAM_PATH: Final[Path] = DISEASE_DIR / "phenogram.json"
TIMELINE_PATH: Final[Path] = DISEASE_DIR / "timeline.json"

SCHEMA_VERSION: Final[int] = 1


@dataclass(frozen=True, slots=True)
class Disease:
    """What the manifest says, in the shapes the pipeline consumes."""

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


def _at(raw: Mapping[str, Any], path: str) -> Any:
    """Walk a dotted path, naming the missing key in the error."""
    node: Any = raw
    for part in path.split("."):
        if not isinstance(node, Mapping) or part not in node:
            raise ValueError(f"disease/manifest.json: missing {path}")
        node = node[part]
    return node


def _text(raw: Mapping[str, Any], path: str) -> str:
    value = _at(raw, path)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"disease/manifest.json: {path} must be a non-empty string")
    return value.strip()


def _terms(raw: Mapping[str, Any], path: str) -> tuple[str, ...]:
    value = _at(raw, path)
    if not isinstance(value, list) or not all(
        isinstance(t, str) and t.strip() for t in value
    ):
        raise ValueError(
            f"disease/manifest.json: {path} must be a list of non-empty strings"
        )
    return tuple(t.strip() for t in value)


def _parse_manifest(raw: Mapping[str, Any]) -> Disease:
    if _at(raw, "schemaVersion") != SCHEMA_VERSION:
        raise ValueError(
            f"disease/manifest.json: schemaVersion must be {SCHEMA_VERSION}"
        )
    pairs_raw = _at(raw, "search.clinicalTrials.conditionPairs")
    if not isinstance(pairs_raw, list) or not all(
        isinstance(p, list) and len(p) == 2 and all(isinstance(w, str) for w in p)
        for p in pairs_raw
    ):
        raise ValueError(
            "disease/manifest.json: search.clinicalTrials.conditionPairs must be "
            "a list of two-string lists"
        )
    aliases_raw = _at(raw, "geneAliases")
    if not isinstance(aliases_raw, Mapping):
        raise ValueError("disease/manifest.json: geneAliases must be an object")
    aliases = {
        key: tuple(_terms({"v": members}, "v"))
        for key, members in aliases_raw.items()
    }
    populations = _at(raw, "populations")
    if not isinstance(populations, list) or not populations:
        raise ValueError("disease/manifest.json: populations must be a non-empty list")
    keys = tuple(_text(p, "key") for p in populations)
    cap = _at(raw, "pipeline.maxGenesPerPaper")
    if not isinstance(cap, int) or cap < 1:
        raise ValueError(
            "disease/manifest.json: pipeline.maxGenesPerPaper must be "
            "a positive integer"
        )
    return Disease(
        key=_text(raw, "disease.key"),
        name=_text(raw, "disease.name"),
        short=_text(raw, "disease.short"),
        abbreviation=_text(raw, "disease.abbreviation"),
        run_label=_text(raw, "pipeline.runLabel"),
        pubmed_disease_terms=_terms(raw, "search.pubmed.diseaseTerms"),
        pubmed_marker_terms=_terms(raw, "search.pubmed.markerTerms"),
        pubmed_mesh_terms=_terms(raw, "search.pubmed.meshTerms"),
        ct_search_terms=_terms(raw, "search.clinicalTrials.searchTerms"),
        ct_condition_substrings=_terms(raw, "search.clinicalTrials.conditions"),
        ct_condition_pairs=tuple((a, b) for a, b in pairs_raw),
        gene_aliases=MappingProxyType(aliases),
        monogenic_genes=_terms(raw, "monogenicGenes"),
        max_genes_per_paper=cap,
        population_keys=keys,
        population_label=_text(raw, "populationField.label"),
        population_details_label=_text(raw, "populationField.detailsLabel"),
    )


@cache
def load_disease() -> Disease:
    """Read the manifest once for the life of the process."""
    with MANIFEST_PATH.open(encoding="utf-8") as handle:
        return _parse_manifest(json.load(handle))
