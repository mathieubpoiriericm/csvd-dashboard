"""The pipeline's disease-specific constants are the manifest's, not restated."""

from pipeline import annotations, batch_validation, data_merger, pubmed_search
from pipeline.clinical_trials_fetch import _CONDITION_PAIRS, _CONDITIONS
from pipeline.config import DEFAULT_CT_SEARCH_TERMS
from pipeline.disease import load_disease


def test_the_pubmed_term_lists_are_the_manifest_s() -> None:
    d = load_disease()
    assert d.pubmed_disease_terms == pubmed_search.DISEASE_TERMS
    assert d.pubmed_marker_terms == pubmed_search.MARKER_TERMS
    assert d.pubmed_mesh_terms == pubmed_search.MESH_TERMS


def test_the_clinical_trials_terms_and_gate_are_the_manifest_s() -> None:
    d = load_disease()
    assert d.ct_search_terms == DEFAULT_CT_SEARCH_TERMS
    assert d.ct_condition_substrings == _CONDITIONS
    assert d.ct_condition_pairs == _CONDITION_PAIRS


def test_the_gene_aliases_feed_both_directions() -> None:
    d = load_disease()
    assert dict(d.gene_aliases) == annotations._LOOKUP_ALIASES
    # The merge looks a symbol up upper-cased, so its map is keyed so too.
    inverted = {
        m.upper(): k for k, members in d.gene_aliases.items() for m in members
    }
    assert inverted == data_merger._CANONICAL_GENE_SYMBOLS


def test_the_gene_cap_is_the_manifest_s() -> None:
    assert load_disease().max_genes_per_paper == batch_validation._MAX_GENES_PER_PAPER
