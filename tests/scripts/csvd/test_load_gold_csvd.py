"""scripts/load_gold.py against the committed cSVD gold tables.

Pins the counts and the cells the generic tests cannot name: the gold
tables are cSVD's, so a fork deletes this file with the rest of the tree.
"""

import json
from functools import cache

from scripts.load_gold import _GOLD_DIR, GoldPlan, build_gold_plan
from scripts.restore_from_json import GeneRestore, export_gene

from pipeline.disease import VOCABULARY_PATH
from pipeline.export.main import _is_curated_trial, _is_running_trial
from pipeline.export.text import is_doi


@cache
def _plan() -> GoldPlan:
    return build_gold_plan(_GOLD_DIR)


def _gene(symbol: str) -> GeneRestore:
    return next(g for g in _plan().genes if g.columns["gene"] == symbol)


def test_the_plan_has_every_gold_gene_and_trial() -> None:
    assert len(_plan().genes) == 115
    assert len(_plan().trials) == 16


def test_every_gold_trial_is_published() -> None:
    trials = _plan().trials
    assert len(trials) == 16
    assert all(_is_curated_trial(t) and _is_running_trial(t) for t in trials)


def test_a_protein_named_by_its_gene_symbol_is_published() -> None:
    assert export_gene(_gene("HTRA1"))["protein"] == "HTRA1"
    assert export_gene(_gene("STN1"))["protein"] == "STN1 (OBFC1)"


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


def test_only_the_preprint_is_cited_by_doi() -> None:
    """A DOI shows on the Genes table as a bare link, so only a source with no
    PubMed record may be one. The two published papers the workbook cites by
    DOI are corrected to their PMIDs in disease/gold/corrections.csv."""
    published = [
        ref
        for gene in _plan().genes
        for ref in export_gene(gene)["references"]
        if is_doi(ref)
    ]
    assert published == ["10.21203/rs.3.rs-5926137/v1"] * 14


def test_the_published_dois_are_cited_by_pmid() -> None:
    assert "39298701" in export_gene(_gene("APOE"))["references"]
    assert "37069360" in export_gene(_gene("SERPIND1"))["references"]


def test_stn1_links_only_its_omim_number() -> None:
    assert _gene("STN1").links == ["617341"]
    assert export_gene(_gene("STN1"))["linkToMonogenicDisease"] == ["617341"]


def test_colocalization_stars_and_details_survive_the_export() -> None:
    """ST1's footnote: "*" marks significant colocalization. The gold cell,
    as corrections.csv writes it, is "TWAS AIS: cross-tissue sCCA3*"."""
    assert export_gene(_gene("HTRA1"))["evidenceFromOtherOmicsStudies"] == [
        "TWAS;AIS: cross-tissue sCCA3*",
        "WES/WGS;stroke & WMH: burden of rare variants",
        "Proteogenomic MR;HIP-PVS",
    ]


def test_a_multiline_cell_keeps_every_study() -> None:
    published = export_gene(_gene("TRIM47"))["evidenceFromOtherOmicsStudies"]
    assert published == [
        "TWAS;PSMD: brain anterior cingulate cortex BA24*, brain cerebellar "
        "hemisphere, brain cortex*, brain frontal cortex BA9*",
        "TWAS;PSMD (Age>65): cells cultured fibroblasts*, brain hippocampus",
        "PWAS;PSMD: dPFC*",
        "TWAS;WMH: CMC: brain dlPFC sQTL, brain hippocampus*, brain "
        "cerebellum*, brain cerebellar hemisphere*, artery tibial",
    ]


def test_the_mentr_sentence_keeps_its_wording() -> None:
    assert export_gene(_gene("SH3PXD2A"))["evidenceFromOtherOmicsStudies"] == [
        "TWAS;AS: cross-tissue sCCA3*",
        "mutation effect prediction on ncRNA transcription;Evidence for causal "
        "implication from ML-based functional prediction (MENTR)",
        "Fine-mapping;multi-ancestry",
    ]


def test_cell_types_carry_both_species() -> None:
    assert _gene("HTRA1").columns["brain_cell_types"] == (
        "Mouse: AC>OL>FB; Human: MG > RBC >> OPC > OL"
    )
    assert _gene("STN1").columns["brain_cell_types"] == "Mouse: FB"


def _omics(symbol: str) -> list[str]:
    return export_gene(_gene(symbol))["evidenceFromOtherOmicsStudies"]


def test_omics_entries_follow_the_reviewed_format() -> None:
    """The 2026-11-08 review's rewrites, through corrections.csv. NMT1's is
    the curator's own worked example; a `[?]` marks what the curator left
    verbatim for clarification, and the 2026-11-09 follow-up review settled
    all but one of them from the cited papers."""
    assert _omics("NMT1")[0] == (
        "TWAS;WMH: nerve tibial, brain spinal cord cervical C1, brain"
        " hippocampus, brain caudate basal ganglia*, brain anterior cingulate"
        " cortex BA24*, heart left ventricle*, artery tibial, artery coronary*,"
        " artery aorta*, YFS: blood*, CMC: brain (RNA-Seq)"
    )
    assert _omics("SMG6") == [
        "TWAS;PSMD: cells cultured fibroblasts, brain frontal cortex BA9*"
    ]
    assert _omics("HTRA1")[2] == "Proteogenomic MR;HIP-PVS"
    assert _omics("LRRC25") == ["TWAS;WM-PVS: nerve tibial*"]
    assert "TWAS;PSMD (Age>65): brain cortex*" in _omics("ICA1L")
    # The one term the papers could not settle stays marked.
    assert any("cross-tissue sCCA2[?]" in v for v in _omics("NBEAL1"))
    assert _omics("PMF1")[0] == (
        "WES/WGS;non-lobar ICH: 1q22 locus resequencing, multivariable MR"
        " (PMF1 overexpression)"
    )
    assert _omics("SH3PXD2A")[2] == "Fine-mapping;multi-ancestry"


def test_a_bare_proteomics_entry_beside_proteomics_wmh_is_gone() -> None:
    assert _omics("TAGLN") == ["Proteomics;WMH", "Proteogenomic MR;WMH"]
    assert _omics("CHRDL1") == ["Proteomics;WMH", "Proteogenomic MR;WMH"]
