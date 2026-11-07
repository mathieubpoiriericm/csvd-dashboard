"""scripts/load_gold.py against the committed cSVD gold tables.

Pins the counts and the cells the generic tests cannot name: the gold
tables are cSVD's, so a fork deletes this file with the rest of the tree.
"""

import json
from functools import cache

from scripts.load_gold import _GOLD_DIR, GoldPlan, build_gold_plan
from scripts.restore_from_json import GeneRestore, export_gene

from pipeline.disease import VOCABULARY_PATH
from pipeline.export.text import is_doi


@cache
def _plan() -> GoldPlan:
    return build_gold_plan(_GOLD_DIR)


def _gene(symbol: str) -> GeneRestore:
    return next(g for g in _plan().genes if g.columns["gene"] == symbol)


def test_the_plan_has_every_gold_gene_and_trial() -> None:
    assert len(_plan().genes) == 115
    assert len(_plan().trials) == 16


def test_every_published_trait_is_in_the_vocabulary() -> None:
    """GWAS_TRAIT_CHOICES in lib/constants.ts derives from these keys."""
    keys = {
        trait["key"]
        for trait in json.loads(VOCABULARY_PATH.read_text(encoding="utf-8"))[
            "traits"
        ]
    }
    published = {
        trait for gene in _plan().genes for trait in export_gene(gene)["gwasTrait"]
    }
    assert published - {"(none found)"} <= keys


def test_the_19_dois_survive() -> None:
    published = [
        ref
        for gene in _plan().genes
        for ref in export_gene(gene)["references"]
        if is_doi(ref)
    ]
    assert len(published) == 19


def test_stn1_links_only_its_omim_number() -> None:
    assert _gene("STN1").links == ["617341"]
    assert export_gene(_gene("STN1"))["linkToMonogenicDisease"] == ["617341"]


def test_colocalization_stars_and_details_survive_the_export() -> None:
    """ST1's footnote: "*" marks significant colocalization. The gold cell is
    "TWAS AIS: Cross-tissue sCCA3*;"."""
    assert export_gene(_gene("HTRA1"))["evidenceFromOtherOmicsStudies"] == [
        "TWAS;AIS: Cross-tissue sCCA3*",
        "WES/WGS;stroke, WMH (burden of rare variants)",
        "Proteogenomic MR;HV-PVS",
    ]


def test_a_multiline_cell_keeps_every_study_verbatim() -> None:
    published = export_gene(_gene("TRIM47"))["evidenceFromOtherOmicsStudies"]
    assert published == [
        "TWAS;PSMD: Brain anterior cingulate cortex BA24*, brain cerebellar "
        "hemisphere, brain cortex*, brain frontal cortex BA9*, (Age>65): cells "
        "cultured fibroblasts*, brain hippocampus",
        "PWAS;PSMD: dPFC*",
        "TWAS;WMH: CMC brain dlPFC qTTL, brain hippocampus*, brain cerebellum*, "
        "brain cerebellar hemisphere*, artery tibial",
    ]


def test_the_mentr_sentence_and_fine_mapping_keep_their_wording() -> None:
    assert export_gene(_gene("SH3PXD2A"))["evidenceFromOtherOmicsStudies"] == [
        "TWAS;AS: Cross-tissue sCCA3*",
        "mutation effect prediction on ncRNA transcription;Evidence for causal "
        "implication from ML-based functional prediction (MENTR)",
        "Fine-mapping;multiancestry fine-mapping",
    ]


def test_cell_types_carry_both_species() -> None:
    assert _gene("HTRA1").columns["brain_cell_types"] == (
        "Mouse: AC>OL>FB; Human: MG > RBC >> OPC > OL"
    )
    assert _gene("STN1").columns["brain_cell_types"] == "Mouse: FB"
