"""The disease manifest is the one place the pipeline learns which disease it serves."""

import json
from pathlib import Path

import pytest

from pipeline import disease as disease_module
from pipeline.disease import DISEASE_DIR, Disease, load_disease

_ROOT = Path(__file__).resolve().parents[2]


def test_the_directory_is_the_repository_s_disease_folder() -> None:
    assert DISEASE_DIR == _ROOT / "disease"
    assert (DISEASE_DIR / "manifest.json").is_file()


def test_load_disease_is_cached() -> None:
    assert load_disease() is load_disease()


def test_the_manifest_fills_every_field() -> None:
    d = load_disease()
    assert isinstance(d, Disease)
    assert d.key == "csvd"
    assert d.name == "cerebral small vessel disease"
    assert d.abbreviation == "cSVD"
    assert d.short == "SVD"
    assert d.run_label == "SVD Pipeline"
    assert d.pubmed_disease_terms == ("cerebral small vessel disease",)
    assert d.pubmed_mesh_terms == ("Cerebral Small Vessel Diseases", "White Matter")
    assert len(d.pubmed_marker_terms) == 7
    assert len(d.ct_search_terms) == 10
    assert len(d.ct_condition_substrings) == 19
    assert d.ct_condition_pairs == (("vascular", "dementia"), ("vascular", "cognitive"))
    assert d.gene_aliases == {
        "COL4A1/2": ("COL4A1", "COL4A2"),
        "C6orf195": ("LINC01600",),
    }
    assert d.monogenic_genes == ("NOTCH3", "COL4A1", "COL4A2", "HTRA1", "TREX1", "GLA")
    assert d.max_genes_per_paper == 20
    assert d.population_keys == ("CAA", "Cognitive Impairment", "Stroke", "SVD")
    assert d.population_label == "SVD Population"


def test_the_parser_refuses_a_missing_key() -> None:
    raw = json.loads((DISEASE_DIR / "manifest.json").read_text(encoding="utf-8"))
    del raw["search"]["pubmed"]["meshTerms"]
    with pytest.raises(ValueError, match="search.pubmed.meshTerms"):
        disease_module._parse_manifest(raw)


def test_the_parser_refuses_a_wrong_schema_version() -> None:
    raw = json.loads((DISEASE_DIR / "manifest.json").read_text(encoding="utf-8"))
    raw["schemaVersion"] = 2
    with pytest.raises(ValueError, match="schemaVersion"):
        disease_module._parse_manifest(raw)


def test_the_parser_refuses_an_empty_term() -> None:
    raw = json.loads((DISEASE_DIR / "manifest.json").read_text(encoding="utf-8"))
    raw["search"]["clinicalTrials"]["searchTerms"].append("  ")
    with pytest.raises(ValueError, match="search.clinicalTrials.searchTerms"):
        disease_module._parse_manifest(raw)
