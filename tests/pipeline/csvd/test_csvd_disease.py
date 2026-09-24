"""The cSVD values disease/ carries, pinned field by field.

The parser and schema tests that hold for any disease are in
tests/pipeline/test_disease.py; this one is the record of what the first
instance says, and a fork deletes it with the rest of csvd/.
"""

from pipeline.disease import Disease, load_disease


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
