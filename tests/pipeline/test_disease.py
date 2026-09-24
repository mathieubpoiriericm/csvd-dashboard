"""The disease manifest is the one place the pipeline learns which disease it serves."""

import copy
import hashlib
import json
from pathlib import Path

import pytest

# jsonschema ships no py.typed marker, so `ty` cannot resolve its types;
# `unresolved-import` is a warning in pyproject.toml and this import is
# test-only, which is why the dependency sits in the `dev` group.
from jsonschema import Draft202012Validator

from pipeline import disease as disease_module
from pipeline.disease import (
    DISEASE_DIR,
    PIPELINE_PATH,
    PROMPT_PATH,
    Disease,
    load_disease,
)

_ROOT = Path(__file__).resolve().parents[2]

_MANIFEST_RAW = json.loads((DISEASE_DIR / "manifest.json").read_text(encoding="utf-8"))
_PIPELINE_RAW = json.loads((DISEASE_DIR / "pipeline.json").read_text(encoding="utf-8"))


def test_the_directory_is_the_repository_s_disease_folder() -> None:
    assert DISEASE_DIR == _ROOT / "disease"
    assert (DISEASE_DIR / "manifest.json").is_file()


def test_the_pipeline_document_lives_beside_the_manifest() -> None:
    assert PIPELINE_PATH.is_file()
    for key in ("search", "monogenicGenes", "geneAliases", "pipeline"):
        assert key not in _MANIFEST_RAW


def test_both_documents_validate_against_their_schemas() -> None:
    """Each document keeps the contract its own schema states.

    `additionalProperties: false` at the root of both is what keeps a gene
    symbol from being dropped into the web-facing manifest by hand, so the
    negative case is the point of the test as much as the positive one.
    """
    for document, schema_name in (
        (_MANIFEST_RAW, "manifest.schema.json"),
        (_PIPELINE_RAW, "pipeline.schema.json"),
    ):
        schema = json.loads((DISEASE_DIR / schema_name).read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema)
        assert list(validator.iter_errors(document)) == [], schema_name

        stray = copy.deepcopy(document)
        stray["strayKey"] = "x"
        messages = [error.message for error in validator.iter_errors(stray)]
        assert any("strayKey" in message for message in messages), schema_name


def test_load_disease_is_cached() -> None:
    assert load_disease() is load_disease()


def test_the_manifest_fills_every_field_from_the_two_documents() -> None:
    """Every field is filled from disease/, whatever the disease says there."""
    d = load_disease()
    assert isinstance(d, Disease)
    assert d.key == _MANIFEST_RAW["disease"]["key"]
    assert d.name == _MANIFEST_RAW["disease"]["name"]
    assert d.abbreviation == _MANIFEST_RAW["disease"]["abbreviation"]
    assert d.short == _MANIFEST_RAW["disease"]["short"]
    assert d.run_label == _PIPELINE_RAW["pipeline"]["runLabel"]
    assert d.max_genes_per_paper == _PIPELINE_RAW["pipeline"]["maxGenesPerPaper"]
    assert d.pubmed_disease_terms == tuple(
        _PIPELINE_RAW["search"]["pubmed"]["diseaseTerms"]
    )
    assert d.pubmed_mesh_terms == tuple(_PIPELINE_RAW["search"]["pubmed"]["meshTerms"])
    assert d.pubmed_marker_terms == tuple(
        _PIPELINE_RAW["search"]["pubmed"]["markerTerms"]
    )
    assert d.ct_search_terms == tuple(
        _PIPELINE_RAW["search"]["clinicalTrials"]["searchTerms"]
    )
    assert d.ct_condition_substrings == tuple(
        _PIPELINE_RAW["search"]["clinicalTrials"]["conditions"]
    )
    pairs = _PIPELINE_RAW["search"]["clinicalTrials"]["conditionPairs"]
    assert d.ct_condition_pairs == tuple(tuple(pair) for pair in pairs)
    assert d.gene_aliases == {
        key: tuple(value) for key, value in _PIPELINE_RAW["geneAliases"].items()
    }
    assert d.monogenic_genes == tuple(_PIPELINE_RAW["monogenicGenes"])
    assert d.population_keys == tuple(p["key"] for p in _MANIFEST_RAW["populations"])
    assert d.population_label == _MANIFEST_RAW["populationField"]["label"]


def test_the_parser_refuses_a_missing_key() -> None:
    pipeline_raw = copy.deepcopy(_PIPELINE_RAW)
    del pipeline_raw["search"]["pubmed"]["meshTerms"]
    with pytest.raises(ValueError, match="search.pubmed.meshTerms"):
        disease_module._parse_manifest(_MANIFEST_RAW, pipeline_raw)


def test_the_parser_refuses_a_wrong_schema_version() -> None:
    manifest_raw = copy.deepcopy(_MANIFEST_RAW)
    manifest_raw["schemaVersion"] = 2
    with pytest.raises(ValueError, match="schemaVersion"):
        disease_module._parse_manifest(manifest_raw, _PIPELINE_RAW)


def test_the_parser_refuses_an_empty_term() -> None:
    pipeline_raw = copy.deepcopy(_PIPELINE_RAW)
    pipeline_raw["search"]["clinicalTrials"]["searchTerms"].append("  ")
    with pytest.raises(ValueError, match="search.clinicalTrials.searchTerms"):
        disease_module._parse_manifest(_MANIFEST_RAW, pipeline_raw)


def test_the_prompt_sections_are_read_from_the_prompt_file() -> None:
    d = load_disease()
    assert PROMPT_PATH.is_file()
    assert d.prompt_file_sha256 == hashlib.sha256(PROMPT_PATH.read_bytes()).hexdigest()
    assert d.prompt_sections["strategy.monogenic_genes"] == ", ".join(d.monogenic_genes)


def test_the_prompt_parser_splits_on_headings() -> None:
    parsed = disease_module._parse_prompt_sections(
        "# Title\n\nlead\n\n## a.b\n\nbody one\n\n## c\n\nbody two\n"
    )
    assert parsed == {"a.b": "body one", "c": "body two"}


def test_the_prompt_parser_refuses_a_file_with_no_headings() -> None:
    with pytest.raises(ValueError, match="no '## <section.id>' headings"):
        disease_module._parse_prompt_sections("# Title\n\njust prose\n")


def test_the_prompt_parser_refuses_a_duplicate_section() -> None:
    with pytest.raises(ValueError, match="duplicate section a.b"):
        disease_module._parse_prompt_sections("## a.b\n\none\n\n## a.b\n\ntwo\n")


def test_the_prompt_parser_refuses_a_heading_that_is_not_a_section_id() -> None:
    """Absorbing it into the section above would render it into the prompt."""
    with pytest.raises(ValueError, match="'## Provenance' is not a"):
        disease_module._parse_prompt_sections(
            "## a.b\n\none\n\n## Provenance\n\nwritten by hand\n"
        )
