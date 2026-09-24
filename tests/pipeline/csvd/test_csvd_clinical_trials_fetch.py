"""The ClinicalTrials.gov condition gate, calibrated on the cSVD vocabulary.

`is_disease_study` resolves against disease/pipeline.json's `conditions` and
`conditionPairs`; the generic behaviour is in
tests/pipeline/test_clinical_trials_fetch.py. This module pins what the cSVD
vocabulary keeps and drops, and a fork deletes it with csvd/.
"""

import pytest

from pipeline.clinical_trials_fetch import is_disease_study


class TestIsDiseaseStudyForCsvd:
    """The gate that keeps a curator's queue readable.

    `query.cond` expands into CT.gov's concept graph, and with no gate the
    most common stated condition across ten terms was Fabry disease (215 of
    1,423 studies), beside cancer, ANCA vasculitis, Parkinson's and MS.
    """

    @staticmethod
    def _study(*conditions: str) -> dict:
        return {
            "protocolSection": {"conditionsModule": {"conditions": list(conditions)}}
        }

    @pytest.mark.parametrize(
        "condition",
        [
            "Cerebral Small Vessel Diseases",
            "Cerebral Small Vascular Disease",
            "Lacunar Stroke",
            "Lacunar Infarction",
            "CADASIL",
            "Cerebral Microbleeds",
            "White Matter Hyperintensities",
            "Leukoaraiosis",
            "Cerebral Amyloid Angiopathy",
            "Vascular Dementia",
            # MeSH inverts it; both spellings arrive in one fetch.
            "Dementia, Vascular",
            "Vascular Cognitive Impairment",
            "Subcortical Ischemic Vascular Dementia",
        ],
    )
    def test_a_csvd_condition_is_kept(self, condition):
        assert is_disease_study(self._study(condition))

    @pytest.mark.parametrize(
        "condition",
        [
            "Fabry Disease",
            "Microscopic Polyangiitis",
            "Granulomatosis With Polyangiitis",
            "Parkinson Disease",
            "Multiple Sclerosis",
            "Alzheimer Disease",
            "Leukemia",
            "Hypertension",
            "Depression",
            "MELAS Syndrome",
        ],
    )
    def test_an_unrelated_condition_is_dropped(self, condition):
        assert not is_disease_study(self._study(condition))

    def test_one_matching_condition_carries_the_study(self):
        """A mixed-dementia trial listing both is in scope."""
        assert is_disease_study(self._study("Alzheimer Disease", "Vascular Dementia"))

    def test_the_pair_must_sit_in_one_condition(self):
        """"Cardiovascular Diseases" beside "Cognitive Decline" is not cSVD.

        The words are matched inside a single condition string precisely so
        two unrelated entries cannot combine into a false positive.
        """
        assert not is_disease_study(
            self._study("Cardiovascular Diseases", "Cognitive Decline")
        )
