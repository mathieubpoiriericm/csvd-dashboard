"""Tests for pipeline.clinical_trials_fetch — CTG v2 discovery + refresh."""

import json
import logging
from pathlib import Path
from unittest.mock import AsyncMock

import httpx
import pytest

from pipeline.clinical_trials_fetch import (
    RADAR_PHASES,
    ClinicalTrialRecord,
    _completion_label,
    _drug_interventions,
    _fetch_page_with_retry,
    _first_primary_outcome,
    _get_path,
    _map_study_to_records,
    _phase_label,
    _search_condition_term,
    _sponsor_label,
    _unplaceable_phases,
    close_ctg_client,
    fetch_disease_studies,
    fetch_trial_statuses,
    is_disease_study,
    sync_clinical_trials,
)
from pipeline.config import PipelineConfig
from pipeline.database import TrialUpsertResult

_REPO_ROOT = Path(__file__).resolve().parents[2]

# ---------------------------------------------------------------------------
# Study dict builders (inline fixtures)
# ---------------------------------------------------------------------------


def _make_study(
    nct_id: str = "NCT00000001",
    brief_title: str | None = "A cSVD trial",
    phases: list[str] | None = None,
    interventions: list[dict] | None = None,
    enrollment_count: int | None = 100,
    completion_date: str | None = "2026-12-31",
    completion_type: str | None = None,
    primary_outcomes: list[dict] | None = None,
    sponsor_class: str | None = "INDUSTRY",
    study_type: str | None = None,
    overall_status: str | None = None,
) -> dict:
    """Build a minimal CTG v2 study dict matching the protocolSection shape."""
    study: dict = {
        "protocolSection": {
            "identificationModule": {"nctId": nct_id},
            "designModule": {},
            "armsInterventionsModule": {},
            "statusModule": {},
            "outcomesModule": {},
            "sponsorCollaboratorsModule": {},
        }
    }
    if brief_title is not None:
        study["protocolSection"]["identificationModule"]["briefTitle"] = brief_title
    if phases is not None:
        study["protocolSection"]["designModule"]["phases"] = phases
    if study_type is not None:
        study["protocolSection"]["designModule"]["studyType"] = study_type
    if enrollment_count is not None:
        study["protocolSection"]["designModule"]["enrollmentInfo"] = {
            "count": enrollment_count
        }
    if interventions is not None:
        study["protocolSection"]["armsInterventionsModule"]["interventions"] = (
            interventions
        )
    if completion_date is not None:
        struct: dict = {"date": completion_date}
        if completion_type is not None:
            struct["type"] = completion_type
        study["protocolSection"]["statusModule"]["completionDateStruct"] = struct
    if primary_outcomes is not None:
        study["protocolSection"]["outcomesModule"]["primaryOutcomes"] = primary_outcomes
    if sponsor_class is not None:
        study["protocolSection"]["sponsorCollaboratorsModule"]["leadSponsor"] = {
            "class": sponsor_class
        }
    if overall_status is not None:
        study["protocolSection"]["statusModule"]["overallStatus"] = overall_status
    return study


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class TestGetPath:
    def test_traverses_nested_dicts(self):
        data = {"a": {"b": {"c": "value"}}}
        assert _get_path(data, "a", "b", "c") == "value"

    def test_returns_none_on_missing_key(self):
        data = {"a": {"b": 1}}
        assert _get_path(data, "a", "missing") is None

    def test_returns_none_on_non_dict(self):
        data = {"a": [1, 2, 3]}
        assert _get_path(data, "a", "b") is None


class TestDrugInterventions:
    def test_extracts_drug_only(self):
        study = _make_study(
            interventions=[
                {"type": "DRUG", "name": "aspirin"},
                {"type": "BEHAVIORAL", "name": "education"},
                {"type": "DEVICE", "name": "pump"},
                {"type": "DRUG", "name": "clopidogrel"},
            ]
        )
        assert _drug_interventions(study) == ["aspirin", "clopidogrel"]

    def test_biological_and_genetic_agents_count_as_drugs(self):
        # CT.gov types antibodies as BIOLOGICAL and siRNA/ASO agents as
        # GENETIC. Those are the class of agent the curated table already
        # holds (ALN-APP), and a DRUG-only filter dropped their trials as
        # "no drug".
        study = _make_study(
            interventions=[
                {"type": "BIOLOGICAL", "name": "lecanemab"},
                {"type": "GENETIC", "name": "ALN-APP"},
                {"type": "PROCEDURE", "name": "thrombectomy"},
            ]
        )
        assert _drug_interventions(study) == ["lecanemab", "ALN-APP"]

    def test_deduplicates_by_name(self):
        study = _make_study(
            interventions=[
                {"type": "DRUG", "name": "aspirin"},
                {"type": "DRUG", "name": "aspirin"},
            ]
        )
        assert _drug_interventions(study) == ["aspirin"]

    def test_empty_when_no_drugs(self):
        study = _make_study(interventions=[{"type": "BEHAVIORAL", "name": "education"}])
        assert _drug_interventions(study) == []

    def test_skips_missing_name_or_type(self):
        study = _make_study(
            interventions=[
                {"type": "DRUG"},  # no name
                {"name": "aspirin"},  # no type
                {"type": "DRUG", "name": ""},  # empty name
                {"type": "DRUG", "name": "valid"},
            ]
        )
        assert _drug_interventions(study) == ["valid"]

    def test_case_insensitive_type_match(self):
        study = _make_study(interventions=[{"type": "drug", "name": "aspirin"}])
        assert _drug_interventions(study) == ["aspirin"]

    def test_deduplicates_whitespace_variants(self):
        # Whitespace-padded duplicates used to bypass the dedup check and
        # produce two records that violated the UNIQUE(registry_id, drug)
        # constraint on upsert.
        study = _make_study(
            interventions=[
                {"type": "DRUG", "name": "aspirin"},
                {"type": "DRUG", "name": " aspirin "},
                {"type": "DRUG", "name": "aspirin\t"},
            ]
        )
        assert _drug_interventions(study) == ["aspirin"]

    def test_comparator_arms_are_not_drugs(self):
        """CT.gov types a placebo as DRUG; the curated table never lists one."""
        study = _make_study(
            interventions=[
                {"type": "DRUG", "name": "Placebo"},
                {"type": "DRUG", "name": "placebo tablet"},
                {"type": "DRUG", "name": "Sham injection"},
                {"type": "DRUG", "name": "Vehicle"},
                {"type": "DRUG", "name": "Saline"},
                {"type": "DRUG", "name": "aspirin"},
            ]
        )
        assert _drug_interventions(study) == ["aspirin"]

    def test_a_comparator_named_after_the_drug_is_still_a_comparator(self):
        """Live CT.gov names on the curated trials, verbatim.

        A prefix test read all four of these as trial drugs: NCT07026994's
        "Matching placebo" and NCT05755997's "0.9 % NaCl" were one sync
        away from Table 2 with every curator column "(unknown)".
        """
        study = _make_study(
            interventions=[
                {"type": "DRUG", "name": "Matching placebo"},
                {"type": "DRUG", "name": "Isosorbide Mononitrate Placebo"},
                {"type": "DRUG", "name": "0.9 % NaCl"},
                {"type": "DRUG", "name": "Normal Saline"},
                {"type": "DRUG", "name": "Cilostazol"},
            ]
        )
        assert _drug_interventions(study) == ["Cilostazol"]

    def test_a_synonym_can_be_what_names_the_comparator(self):
        """NCT05755997 calls it "0.9 % NaCl", with "Sodium Chloride" only in
        otherNames; a sponsor is free to put the plain word in either field.
        """
        study = _make_study(
            interventions=[
                {
                    "type": "DRUG",
                    "name": "Control solution",
                    "otherNames": ["Sodium Chloride"],
                },
                {"type": "DRUG", "name": "Cerebrolysin", "otherNames": ["FPF 1070"]},
            ]
        )
        assert _drug_interventions(study) == ["Cerebrolysin"]

    def test_a_saline_therapy_is_not_read_as_a_control_arm(self):
        """Hypertonic saline is an agent under study, not a comparator.

        The word rule stops at placebo/sham/vehicle for exactly this
        reason: dropping a real agent hides it from the curator, which is
        worse than leaving an unrecognised comparator in the table, where
        the export's curation gate keeps it unpublished.
        """
        study = _make_study(
            interventions=[
                {"type": "DRUG", "name": "Hypertonic saline 3%"},
                {"type": "DRUG", "name": "Saline"},
            ]
        )
        assert _drug_interventions(study) == ["Hypertonic saline 3%"]

    def test_skips_non_dict_intervention(self):
        study = {
            "protocolSection": {
                "armsInterventionsModule": {"interventions": [None, "drug"]}
            }
        }

        assert _drug_interventions(study) == []


class TestCompletionLabel:
    @pytest.mark.parametrize(
        ("raw", "label"),
        [
            ("2027-06-30", "6/2027"),
            ("2026-12", "12/2026"),
            ("2026-01-05", "1/2026"),
        ],
    )
    def test_iso_dates_take_the_curated_month_year_spelling(self, raw, label):
        assert _completion_label(raw) == label

    @pytest.mark.parametrize("raw", ["12/2026", "Completed (unpublished)", "2027"])
    def test_anything_else_passes_through(self, raw):
        assert _completion_label(raw) == raw

    def test_none_stays_none(self):
        assert _completion_label(None) is None


class TestPhaseLabel:
    """The label has to be what the dashboard's phase filter reads.

    lib/filters.ts matches whole Roman-numeral tokens against PHASE_CHOICES
    ("I", "II", "III"), and the curated rows in data/table2.json are spelled
    that way. "Phase 2" carries no such token, so every synced row was
    invisible under any phase filter, and the upsert overwrote curated "II"
    with it.
    """

    @pytest.mark.parametrize(
        ("raw", "label"),
        [
            ("EARLY_PHASE1", "Early Phase I"),
            ("PHASE1", "I"),
            ("PHASE2", "II"),
            ("PHASE3", "III"),
            ("PHASE4", "IV"),
        ],
    )
    def test_maps_each_ctg_phase_to_the_curated_spelling(self, raw, label):
        assert _phase_label(_make_study(phases=[raw])) == label

    def test_joins_a_multi_phase_trial(self):
        # A Phase 2/3 trial is both, and the filter reads each token, so it
        # must not be collapsed to its first phase.
        study = _make_study(phases=["PHASE2", "PHASE3"])
        assert _phase_label(study) == "II/III"

    def test_unmapped_phase_passes_through(self):
        study = _make_study(phases=["UNKNOWN_PHASE"])
        assert _phase_label(study) == "UNKNOWN_PHASE"

    def test_none_when_missing(self):
        study = _make_study(phases=None)
        assert _phase_label(study) is None

    def test_none_when_empty(self):
        study = _make_study(phases=[])
        assert _phase_label(study) is None


class TestRadarPhases:
    """The figure's ring set, read from the encoding rather than restated."""

    def test_the_accepted_vocabulary_is_the_encodings_rings(self):
        encoding = json.loads(
            (_REPO_ROOT / "lib" / "timeline_encoding.json").read_text(encoding="utf-8")
        )
        rings = frozenset(ring["phase"] for ring in encoding["rings"])
        # The encoding names the unphased ring in wire spelling; a record
        # carries the registry's own "N/A". _load_ring_phases folds one to
        # the other, so the two sets agree on everything else.
        assert rings - {"(unknown)"} == RADAR_PHASES - {"N/A"}
        assert (
            frozenset({"I", "I/II", "II", "II/III", "III", "IV", "N/A"})
            == RADAR_PHASES
        )

    @pytest.mark.parametrize("label", ["I/II", "II/III"])
    def test_a_seamless_trial_has_a_ring_of_its_own(self, label):
        """The two joins the registry actually uses are placeable.

        Collapsing them onto a component ring would have the print figure --
        which has no drawer to correct it -- state a phase the registry
        does not: NCT03451591 is LACI-2, a seamless II/III trial.
        """
        assert label in RADAR_PHASES

    @pytest.mark.parametrize("label", ["Early Phase I", "I/III", "III/IV"])
    def test_the_labels_the_radar_cannot_place(self, label):
        """lib/timeline.ts and scripts/timeline_figure.py both compare the
        published phase to the ring's for equality, so a label with no ring
        is placed nowhere even though lib/filters.ts reads its tokens.
        """
        assert label not in RADAR_PHASES


class TestUnplaceablePhases:
    @staticmethod
    def _record(registry_id, phase):
        return ClinicalTrialRecord(
            drug="drug",
            trial_name="Trial",
            registry_id=registry_id,
            clinical_trial_phase=phase,
            target_sample_size=10,
            estimated_completion_date="1/2030",
            primary_outcome="Outcome",
            sponsor_type="Academic",
        )

    def test_a_refreshed_trial_with_no_ring_is_reported(self):
        records = [
            self._record("NCT1", "Early Phase I"),
            self._record("NCT1", "Early Phase I"),
        ]

        assert _unplaceable_phases(records, frozenset({"NCT1"})) == [
            ("NCT1", "Early Phase I")
        ]

    @pytest.mark.parametrize("phase", ["II", "II/III", "I/II"])
    def test_a_ring_phase_is_not_reported(self, phase):
        """The two seamless joins have rings of their own now."""
        records = [self._record("NCT1", phase)]

        assert _unplaceable_phases(records, frozenset({"NCT1"})) == []

    def test_a_discovery_is_not_reported(self):
        """It is not published until a curator fills the population in, and
        the phase they will see is the one they correct.
        """
        records = [self._record("NCT2", "N/A")]

        assert _unplaceable_phases(records, frozenset({"NCT1"})) == []

    def test_a_missing_phase_is_not_reported(self):
        """A refresh never overwrites a curated phase with nothing."""
        records = [self._record("NCT1", None)]

        assert _unplaceable_phases(records, frozenset({"NCT1"})) == []

    def test_none_when_no_phase_is_a_nonempty_string(self):
        study = {"protocolSection": {"designModule": {"phases": [""]}}}

        assert _phase_label(study) is None


class TestSponsorLabel:
    """lib/filters.ts wants exact "Academic" or an "Industry" prefix.

    CT.gov's leadSponsor.class enum (OTHER, NIH, INDUSTRY, ...) matches
    neither, so the sponsor filter hid every synced row.
    """

    def test_industry_class_is_industry(self):
        assert _sponsor_label("INDUSTRY") == "Industry"

    @pytest.mark.parametrize("raw", ["OTHER", "NIH", "FED", "NETWORK", "INDIV"])
    def test_every_named_non_industry_class_is_academic(self, raw):
        """The fold is deliberate: these classes all name a non-commercial
        sponsor, and the dashboard offers two choices.
        """
        assert _sponsor_label(raw) == "Academic"

    @pytest.mark.parametrize("raw", ["UNKNOWN", "AMBIG", "unknown"])
    def test_a_class_that_states_nothing_is_not_called_academic(self, raw):
        """"Academic" is a claim about who ran the trial. UNKNOWN and AMBIG
        make no such claim, and folding them into one published "Academic"
        beside the real ones invents the registry's answer -- which the
        COALESCE on refresh then keeps until a curator notices. None
        publishes as "(unknown)".
        """
        assert _sponsor_label(raw) is None

    def test_missing_class_stays_none(self):
        assert _sponsor_label(None) is None


class TestFirstPrimaryOutcome:
    def test_returns_first_measure(self):
        study = _make_study(
            primary_outcomes=[
                {"measure": "Change in WMH volume"},
                {"measure": "Second outcome"},
            ]
        )
        assert _first_primary_outcome(study) == "Change in WMH volume"

    def test_none_when_missing(self):
        study = _make_study(primary_outcomes=None)
        assert _first_primary_outcome(study) is None

    def test_none_when_no_measure_field(self):
        study = _make_study(primary_outcomes=[{"timeFrame": "6 months"}])
        assert _first_primary_outcome(study) is None

    def test_none_when_first_outcome_is_not_a_mapping(self):
        study = {
            "protocolSection": {"outcomesModule": {"primaryOutcomes": ["bad"]}}
        }

        assert _first_primary_outcome(study) is None


# ---------------------------------------------------------------------------
# _map_study_to_records
# ---------------------------------------------------------------------------


class TestMapStudyToRecords:
    def test_single_drug_emits_one_record(self):
        study = _make_study(
            nct_id="NCT12345678",
            brief_title="Aspirin for lacunar stroke",
            phases=["PHASE3"],
            interventions=[{"type": "DRUG", "name": "aspirin"}],
            enrollment_count=500,
            completion_date="2027-06-30",
            primary_outcomes=[{"measure": "Recurrent stroke rate"}],
            sponsor_class="NIH",
        )
        records = _map_study_to_records(study)

        assert len(records) == 1
        r = records[0]
        assert r.registry_id == "NCT12345678"
        # `_map_study_to_records` normalises on the way in.
        assert r.drug == "Aspirin"
        assert r.trial_name == "Aspirin for lacunar stroke"
        assert r.clinical_trial_phase == "III"
        assert r.target_sample_size == 500
        # CT.gov answers ISO dates; the curated rows and the dashboard's
        # completion-date sort key both read M/YYYY.
        assert r.estimated_completion_date == "6/2027"
        assert r.primary_outcome == "Recurrent stroke rate"
        assert r.sponsor_type == "Academic"

    def test_an_actual_completion_date_is_named_in_the_log(self, caplog):
        """The dashboard has one column and it is headed "Estimated".

        NCT04658823 is the live case: CT.gov reports
        {"date": "2024-10-31", "type": "ACTUAL"}, and the mapper emits the
        same M/YYYY shape an estimate would, so the published cell reads as
        a forecast for a trial that has already finished.
        """
        study = _make_study(
            nct_id="NCT04658823",
            interventions=[{"type": "DRUG", "name": "aspirin"}],
            completion_date="2024-10-31",
            completion_type="ACTUAL",
        )

        import logging

        with caplog.at_level(
            logging.INFO, logger="pipeline.clinical_trials_fetch"
        ):
            (r,) = _map_study_to_records(study)

        assert r.estimated_completion_date == "10/2024"
        assert "NCT04658823" in caplog.text
        assert "ACTUAL" in caplog.text

    def test_an_estimated_completion_date_says_nothing(self, caplog):
        study = _make_study(
            interventions=[{"type": "DRUG", "name": "aspirin"}],
            completion_type="ESTIMATED",
        )

        import logging

        with caplog.at_level(
            logging.INFO, logger="pipeline.clinical_trials_fetch"
        ):
            _map_study_to_records(study)

        assert "ACTUAL" not in caplog.text

    def test_a_year_month_completion_date_is_relabelled_too(self):
        study = _make_study(
            interventions=[{"type": "DRUG", "name": "aspirin"}],
            completion_date="2026-12",
        )
        (r,) = _map_study_to_records(study)

        assert r.estimated_completion_date == "12/2026"

    def test_an_observational_study_yields_no_trial_rows(self):
        """A DRUG intervention on an observational study is not a trial."""
        study = _make_study(
            interventions=[{"type": "DRUG", "name": "aspirin"}],
            study_type="OBSERVATIONAL",
        )

        assert _map_study_to_records(study) == []

    def test_an_interventional_study_is_kept(self):
        study = _make_study(
            interventions=[{"type": "DRUG", "name": "aspirin"}],
            study_type="INTERVENTIONAL",
        )

        assert len(_map_study_to_records(study)) == 1

    def test_a_study_naming_no_type_is_kept(self):
        """Only a type that says non-interventional excludes the study."""
        study = _make_study(interventions=[{"type": "DRUG", "name": "aspirin"}])

        assert len(_map_study_to_records(study)) == 1

    def test_industry_sponsor_and_multi_phase_reach_the_record(self):
        study = _make_study(
            phases=["PHASE2", "PHASE3"],
            interventions=[{"type": "DRUG", "name": "aspirin"}],
            sponsor_class="INDUSTRY",
        )
        (r,) = _map_study_to_records(study)

        assert r.clinical_trial_phase == "II/III"
        assert r.sponsor_type == "Industry"

    def test_multi_drug_emits_one_record_per_drug(self):
        study = _make_study(
            nct_id="NCT99999999",
            interventions=[
                {"type": "DRUG", "name": "aspirin"},
                {"type": "DRUG", "name": "clopidogrel"},
                {"type": "BEHAVIORAL", "name": "education"},
            ],
        )
        records = _map_study_to_records(study)
        assert len(records) == 2
        drugs = sorted(r.drug for r in records)
        assert drugs == ["Aspirin", "Clopidogrel"]
        assert all(r.registry_id == "NCT99999999" for r in records)

    def test_non_drug_interventions_yield_empty(self):
        study = _make_study(
            interventions=[
                {"type": "BEHAVIORAL", "name": "education"},
                {"type": "DEVICE", "name": "pump"},
            ]
        )
        assert _map_study_to_records(study) == []

    def test_missing_optional_fields_resolve_to_none(self):
        study = _make_study(
            nct_id="NCT00000002",
            brief_title=None,
            phases=None,
            interventions=[{"type": "DRUG", "name": "drug1"}],
            enrollment_count=None,
            completion_date=None,
            primary_outcomes=None,
            sponsor_class=None,
        )
        records = _map_study_to_records(study)
        assert len(records) == 1
        r = records[0]
        assert r.registry_id == "NCT00000002"
        assert r.drug == "Drug1"
        assert r.trial_name is None
        assert r.clinical_trial_phase is None
        assert r.target_sample_size is None
        assert r.estimated_completion_date is None
        assert r.primary_outcome is None
        assert r.sponsor_type is None

    def test_missing_nct_id_yields_empty(self):
        study = {"protocolSection": {"identificationModule": {}}}
        assert _map_study_to_records(study) == []

    def test_no_interventions_yields_empty(self):
        study = _make_study(interventions=None)
        assert _map_study_to_records(study) == []

    def test_non_int_enrollment_becomes_none(self):
        # CTG is mostly consistent but a stringified count has been observed —
        # we must not crash and must resolve to None.
        study = _make_study(
            interventions=[{"type": "DRUG", "name": "d"}],
            enrollment_count=None,
        )
        study["protocolSection"]["designModule"]["enrollmentInfo"] = {"count": "500"}
        records = _map_study_to_records(study)
        assert records[0].target_sample_size is None


# ---------------------------------------------------------------------------
# fetch_disease_studies (pagination + dedup)
# ---------------------------------------------------------------------------


def _mock_http_response(json_body: dict, status_code: int = 200) -> AsyncMock:
    """Build an AsyncMock that mimics an httpx.Response."""
    resp = AsyncMock()
    resp.status_code = status_code
    resp.json = lambda: json_body  # sync method on httpx.Response
    resp.raise_for_status = AsyncMock()
    # A real dict, because the retry path reads Retry-After off it: an
    # AsyncMock attribute would hand `resolve_retry_delay` a Mock to float().
    resp.headers = {}
    return resp


class TestIsCsvdStudy:
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

    def test_a_study_stating_no_condition_is_kept(self):
        """The absence is CT.gov's, not evidence the trial is off-topic."""
        assert is_disease_study({"protocolSection": {}})
        assert is_disease_study(self._study())


class TestFetchCSVDStudies:
    async def test_single_page_single_term(self, mocker):
        body = {
            "studies": [
                _make_study(
                    nct_id="NCT11111111",
                    interventions=[{"type": "DRUG", "name": "aspirin"}],
                )
            ],
        }
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=_mock_http_response(body))
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=mock_client,
        )

        studies, errors = await fetch_disease_studies(
            search_terms=("lacunar stroke",),
            page_size=100,
            max_retries=0,
        )
        assert len(studies) == 1
        assert errors == []
        # One HTTP GET per term when there's no pagination
        assert mock_client.get.call_count == 1

    async def test_pagination_follows_next_page_token(self, mocker):
        page1 = {
            "studies": [_make_study(nct_id="NCT1")],
            "nextPageToken": "tok-2",
        }
        page2 = {
            "studies": [_make_study(nct_id="NCT2")],
            # no nextPageToken -> loop terminates
        }
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[
                _mock_http_response(page1),
                _mock_http_response(page2),
            ]
        )
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=mock_client,
        )

        studies, errors = await fetch_disease_studies(
            search_terms=("lacunar stroke",),
            page_size=100,
            max_retries=0,
        )
        nct_ids = sorted(
            _get_path(s, "protocolSection", "identificationModule", "nctId")
            for s in studies
        )
        assert nct_ids == ["NCT1", "NCT2"]
        assert errors == []

    async def test_dedup_across_terms(self, mocker):
        # Term1 returns NCT1 + NCT2; Term2 returns NCT2 + NCT3.
        # Expect NCT1, NCT2, NCT3 (NCT2 deduped).
        term1_body = {
            "studies": [_make_study(nct_id="NCT1"), _make_study(nct_id="NCT2")],
        }
        term2_body = {
            "studies": [_make_study(nct_id="NCT2"), _make_study(nct_id="NCT3")],
        }
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[
                _mock_http_response(term1_body),
                _mock_http_response(term2_body),
            ]
        )
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=mock_client,
        )

        studies, errors = await fetch_disease_studies(
            search_terms=("term1", "term2"),
            page_size=100,
            max_retries=0,
        )
        nct_ids = sorted(
            _get_path(s, "protocolSection", "identificationModule", "nctId")
            for s in studies
        )
        assert nct_ids == ["NCT1", "NCT2", "NCT3"]
        assert errors == []

    async def test_empty_terms_returns_empty(self):
        studies, errors = await fetch_disease_studies(
            search_terms=(),
            page_size=100,
            max_retries=0,
        )
        assert studies == []
        assert errors == []

    async def test_retry_on_5xx(self, mocker):
        good = {"studies": [_make_study(nct_id="NCT1")]}
        mock_client = AsyncMock()
        fail_resp = AsyncMock()
        fail_resp.status_code = 503
        fail_resp.request = httpx.Request("GET", "https://x/y")
        fail_resp.json = lambda: {}
        fail_resp.raise_for_status = AsyncMock()
        fail_resp.headers = {}
        mock_client.get = AsyncMock(side_effect=[fail_resp, _mock_http_response(good)])
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=mock_client,
        )
        mocker.patch("pipeline.clinical_trials_fetch.asyncio.sleep", new=AsyncMock())

        studies, errors = await fetch_disease_studies(
            search_terms=("term",),
            page_size=100,
            max_retries=2,
        )
        assert len(studies) == 1
        assert errors == []

    async def test_partial_term_failure_preserves_others(self, mocker):
        # One term returns studies, the other raises after retry exhaustion;
        # with gather, the successful term's results must survive.
        from pipeline import clinical_trials_fetch as ctg

        good = [_make_study(nct_id="NCT_GOOD")]

        async def fake_search(term, page_size, max_retries):
            if term == "bad":
                raise RuntimeError("term bad blew up")
            return good, None

        mocker.patch.object(ctg, "_search_condition_term", side_effect=fake_search)

        studies, errors = await fetch_disease_studies(
            search_terms=("good", "bad"),
            page_size=100,
            max_retries=0,
        )
        assert len(studies) == 1
        assert (
            _get_path(studies[0], "protocolSection", "identificationModule", "nctId")
            == "NCT_GOOD"
        )
        assert len(errors) == 1
        assert "bad" in errors[0]

    async def test_page_level_failure_preserves_earlier_pages(self, mocker):
        # Page 1 succeeds and has a nextPageToken; page 2 fails all retries.
        # Expect page 1's studies preserved rather than discarded.
        page1 = {
            "studies": [_make_study(nct_id="NCT_P1")],
            "nextPageToken": "tok-2",
        }

        call_count = {"n": 0}

        def get_side_effect(*_args, **_kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return _mock_http_response(page1)
            fail = AsyncMock()
            fail.status_code = 503
            fail.request = httpx.Request("GET", "https://x/y")
            fail.json = lambda: {}
            fail.raise_for_status = AsyncMock()
            fail.headers = {}
            return fail

        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=get_side_effect)
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=mock_client,
        )
        mocker.patch("pipeline.clinical_trials_fetch.asyncio.sleep", new=AsyncMock())

        studies, errors = await fetch_disease_studies(
            search_terms=("term",),
            page_size=100,
            max_retries=1,
        )
        assert len(studies) == 1
        # The partial result is kept, and the truncation is an error the sync
        # reports rather than a log line: a green badge over a result set that
        # stopped at page 1 would read as the whole registry.
        assert len(errors) == 1
        assert "term" in errors[0]
        assert "503" in errors[0]

    async def test_a_truncated_term_returns_its_pages_and_the_error(self, mocker):
        page1 = {"studies": [_make_study(nct_id="NCT_P1")], "nextPageToken": "t2"}
        mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            AsyncMock(side_effect=[page1, RuntimeError("page 2 exhausted")]),
        )

        studies, error = await _search_condition_term("term", 100, 0)

        assert len(studies) == 1
        assert error == "CTG term 'term' truncated after 1 studies: page 2 exhausted"

    async def test_a_complete_term_returns_no_error(self, mocker):
        mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            AsyncMock(return_value={"studies": [_make_study(nct_id="NCT_P1")]}),
        )

        studies, error = await _search_condition_term("term", 100, 0)

        assert len(studies) == 1
        assert error is None

    async def test_non_list_studies_payload_is_ignored(self, mocker):
        mock_client = AsyncMock()
        mock_client.get.return_value = _mock_http_response({"studies": "invalid"})
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=mock_client,
        )

        assert await fetch_disease_studies(("term",), 100, 0) == ([], [])

    async def test_studies_without_nct_are_not_deduped(self, mocker):
        from pipeline import clinical_trials_fetch as ctg

        mocker.patch.object(
            ctg,
            "_search_condition_term",
            return_value=(
                [
                    {"protocolSection": {"identificationModule": {}}},
                    _make_study(nct_id="NCT_OK"),
                ],
                None,
            ),
        )

        studies, errors = await fetch_disease_studies(("term",), 100, 0)

        assert len(studies) == 1
        assert errors == []


class TestFetchPageWithRetry:
    async def test_nonretryable_http_error_is_raised(self, mocker):
        request = httpx.Request("GET", "https://example.test")
        response = httpx.Response(404, request=request)
        client = AsyncMock()
        client.get.return_value = response
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=client,
        )

        with pytest.raises(httpx.HTTPStatusError):
            await _fetch_page_with_retry({}, 0)

    async def test_unexpected_nonerror_status_is_raised_explicitly(self, mocker):
        response = AsyncMock(status_code=304)
        response.request = httpx.Request("GET", "https://example.test")
        response.raise_for_status = lambda: None
        client = AsyncMock()
        client.get.return_value = response
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=client,
        )

        with pytest.raises(httpx.HTTPStatusError, match="Unexpected CTG status 304"):
            await _fetch_page_with_retry({}, 0)

    async def test_a_429_waits_the_retry_after_ctgov_states(self, mocker):
        """The header wins over the curve, as it does for NCBI and Anthropic.

        Four attempts of 1s/2s/4s were not enough for CTG's throttle on a
        30-day run: three of ten search terms exhausted their retries and
        returned one page each.
        """
        good = {"studies": [_make_study(nct_id="NCT1")]}
        throttled = _mock_http_response({}, status_code=429)
        throttled.request = httpx.Request("GET", "https://x/y")
        throttled.headers = {"Retry-After": "30"}
        client = AsyncMock()
        client.get = AsyncMock(side_effect=[throttled, _mock_http_response(good)])
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=client,
        )
        sleep = mocker.patch(
            "pipeline.clinical_trials_fetch.asyncio.sleep", new=AsyncMock()
        )

        body = await _fetch_page_with_retry({}, 1)

        assert body == good
        sleep.assert_awaited_once_with(30.0)

    async def test_a_429_without_a_header_falls_back_to_the_curve(self, mocker):
        """No Retry-After, so the exponential curve still applies."""
        good = {"studies": [_make_study(nct_id="NCT1")]}
        throttled = _mock_http_response({}, status_code=429)
        throttled.request = httpx.Request("GET", "https://x/y")
        client = AsyncMock()
        client.get = AsyncMock(side_effect=[throttled, _mock_http_response(good)])
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=client,
        )
        sleep = mocker.patch(
            "pipeline.clinical_trials_fetch.asyncio.sleep", new=AsyncMock()
        )

        assert await _fetch_page_with_retry({}, 1) == good

        # compute_backoff(1.0, 1) is 1s ±25%.
        (delay,) = sleep.await_args.args
        assert 0.75 <= delay <= 1.25

    @pytest.mark.parametrize(
        "error",
        [
            httpx.TimeoutException("timeout"),
            httpx.RequestError("network"),
        ],
    )
    async def test_transient_error_is_retried_then_raised(self, mocker, error):
        client = AsyncMock()
        client.get.side_effect = error
        mocker.patch(
            "pipeline.clinical_trials_fetch._client_manager.get",
            return_value=client,
        )

        with pytest.raises(type(error)):
            await _fetch_page_with_retry({}, 0)


class TestMapStudyOverallStatus:
    """The status is free: the search sends no `fields` list, so it is
    already in every payload the mapper is handed.
    """

    @staticmethod
    def _records(overall_status: str | None) -> list[ClinicalTrialRecord]:
        return _map_study_to_records(
            _make_study(
                interventions=[
                    {"type": "DRUG", "name": "drug-a"},
                    {"type": "DRUG", "name": "drug-b"},
                ],
                overall_status=overall_status,
            )
        )

    def test_every_record_of_a_study_carries_it(self):
        """It is a property of the study, not of the arm."""
        records = self._records("Terminated")

        assert [r.overall_status for r in records] == ["TERMINATED", "TERMINATED"]

    def test_a_study_stating_none_yields_none(self):
        """The same thing a NULL column means -- no answer, so it publishes."""
        assert self._records(None)[0].overall_status is None


# ---------------------------------------------------------------------------
# fetch_trial_statuses -- the by-id status sweep
# ---------------------------------------------------------------------------


def _status_page(*pairs: tuple[str, str | None]) -> dict:
    """A CTG /studies body carrying nctId + overallStatus, as the sweep asks."""
    return {
        "studies": [
            _make_study(nct_id=nct, overall_status=status) for nct, status in pairs
        ]
    }


class TestFetchTrialStatuses:
    """The sweep asks CT.gov by id, because the search cannot cover Table 2.

    `is_disease_study` and the interventional and drug-type gates all drop
    trials a curator nonetheless published, so the ids come from the table.
    """

    async def test_statuses_are_returned_keyed_by_id_and_upper_cased(
        self, mocker
    ):
        mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            AsyncMock(
                return_value=_status_page(
                    ("NCT00000001", "terminated"), ("NCT00000002", "RECRUITING")
                )
            ),
        )

        statuses, errors = await fetch_trial_statuses(
            ["NCT00000001", "NCT00000002"], 0
        )

        assert statuses == {
            "NCT00000001": "TERMINATED",
            "NCT00000002": "RECRUITING",
        }
        assert errors == []

    async def test_no_ids_issues_no_request(self, mocker):
        fetch = mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            new_callable=AsyncMock,
        )

        assert await fetch_trial_statuses([], 0) == ({}, [])
        fetch.assert_not_awaited()

    async def test_ids_are_batched_and_every_one_is_asked_about(self, mocker):
        """URL length is the binding limit, so the batch is 100, not pageSize.

        ~600 ids is ~7.2 KB of `filter.ids`, at or past the request line
        most servers accept, and CT.gov answers an over-long one with a 400
        that `_fetch_page_with_retry` treats as non-retryable.
        """
        ids = [f"NCT{i:08d}" for i in range(250)]
        fetch = mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            AsyncMock(side_effect=lambda params, _retries: _status_page(
                *((nct, "COMPLETED") for nct in params["filter.ids"].split(","))
            )),
        )

        statuses, errors = await fetch_trial_statuses(ids, 0)

        assert errors == []
        assert set(statuses) == set(ids)

        batches = [call.args[0] for call in fetch.await_args_list]
        assert len(batches) == 3
        asked: list[str] = []
        for params in batches:
            batch = params["filter.ids"].split(",")
            assert len(batch) <= 100
            # One page always covers one batch.
            assert params["pageSize"] == str(len(batch))
            asked.extend(batch)
        assert asked == ids

    async def test_one_failing_batch_does_not_lose_the_others(self, mocker):
        """A failure costs that batch's ids and one error, never the sync.

        Trials in the failed batch keep the status they had, so the export
        goes on publishing them -- a stale status is a far cheaper error
        than a trial silently vanishing from Table 2.
        """
        ids = [f"NCT{i:08d}" for i in range(150)]

        async def side_effect(params, _retries):
            batch = params["filter.ids"].split(",")
            if ids[0] in batch:
                raise RuntimeError("CTG HTTP 400")
            return _status_page(*((nct, "COMPLETED") for nct in batch))

        mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            AsyncMock(side_effect=side_effect),
        )

        statuses, errors = await fetch_trial_statuses(ids, 0)

        assert set(statuses) == set(ids[100:])
        assert len(errors) == 1
        assert "100 trial(s) unswept" in errors[0]
        assert "CTG HTTP 400" in errors[0]

    async def test_an_id_with_no_record_is_warned_not_raised(
        self, mocker, caplog
    ):
        """The opposite of export/geocode.py, deliberately.

        `fetch_trial_locations` raises on a missing id because a silent miss
        shrinks the map. Here a miss must not delete a trial from Table 2,
        so the id is simply absent from the mapping and the row keeps
        whatever status it had.
        """
        mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            AsyncMock(return_value=_status_page(("NCT00000001", "RECRUITING"))),
        )

        with caplog.at_level(
            logging.WARNING, logger="pipeline.clinical_trials_fetch"
        ):
            statuses, errors = await fetch_trial_statuses(
                ["NCT00000001", "NCT00000002"], 0
            )

        assert statuses == {"NCT00000001": "RECRUITING"}
        assert errors == []
        assert "NCT00000002" in caplog.text

    async def test_a_next_page_token_on_a_complete_answer_is_silent(
        self, mocker, caplog
    ):
        """CT.gov sends one even when it answered every id asked for.

        Measured on both batches of a 114-id sweep that answered 114.
        Warning on the token alone cries wolf on every healthy run.
        """
        page = _status_page(("NCT00000001", "RECRUITING"))
        page["nextPageToken"] = "more"
        mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            AsyncMock(return_value=page),
        )

        with caplog.at_level(
            logging.WARNING, logger="pipeline.clinical_trials_fetch"
        ):
            statuses, errors = await fetch_trial_statuses(["NCT00000001"], 0)

        assert statuses == {"NCT00000001": "RECRUITING"}
        assert errors == []
        assert caplog.text == ""

    async def test_a_short_page_with_a_token_says_the_batch_is_unswept(
        self, mocker, caplog
    ):
        page = _status_page(("NCT00000001", "RECRUITING"))
        page["nextPageToken"] = "more"
        mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            AsyncMock(return_value=page),
        )

        with caplog.at_level(
            logging.WARNING, logger="pipeline.clinical_trials_fetch"
        ):
            await fetch_trial_statuses(["NCT00000001", "NCT00000002"], 0)

        assert "asked for 2 ids in one page, got 1" in caplog.text
        # And the id that went missing is named, not just counted.
        assert "NCT00000002" in caplog.text

    async def test_a_study_stating_no_status_contributes_nothing(self, mocker):
        mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            AsyncMock(return_value=_status_page(("NCT00000001", None))),
        )

        statuses, errors = await fetch_trial_statuses(["NCT00000001"], 0)

        assert statuses == {}
        assert errors == []

    async def test_duplicate_ids_are_asked_about_once(self, mocker):
        mocker.patch(
            "pipeline.clinical_trials_fetch._fetch_page_with_retry",
            AsyncMock(return_value=_status_page(("NCT00000001", "COMPLETED"))),
        )

        statuses, _errors = await fetch_trial_statuses(
            ["NCT00000001", "NCT00000001"], 0
        )

        assert statuses == {"NCT00000001": "COMPLETED"}


# ---------------------------------------------------------------------------
# sync_clinical_trials (end-to-end with mocked DB)
# ---------------------------------------------------------------------------


class TestSyncClinicalTrials:
    @pytest.fixture(autouse=True)
    def _no_status_sweep(self, mocker):
        """Sweep no ids by default, so no test here reaches a database.

        With an empty id list `fetch_trial_statuses` short-circuits and
        `update_trial_statuses` is never called, so the sweep is inert
        rather than mocked away -- the tests that are about it opt back in
        by patching `read_nct_registry_ids` themselves.
        """
        return mocker.patch(
            "pipeline.database.read_nct_registry_ids",
            new_callable=AsyncMock,
            return_value=[],
        )

    async def test_happy_path(self, mocker):
        studies = [
            _make_study(
                nct_id="NCT1",
                interventions=[{"type": "DRUG", "name": "aspirin"}],
            ),
            _make_study(
                nct_id="NCT2",
                interventions=[
                    {"type": "DRUG", "name": "drug-a"},
                    {"type": "DRUG", "name": "drug-b"},
                ],
            ),
        ]
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=(studies, []),
        )
        mock_upsert = mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            return_value=TrialUpsertResult(discovered=3),
        )

        config = PipelineConfig()
        result = await sync_clinical_trials(config)

        # 2 studies hit, 3 records (1 from NCT1 + 2 from NCT2) written --
        # all three for registry ids the table did not hold, so all three
        # are uncurated discoveries the export will not publish.
        assert result.fetched == 2
        assert result.cached == 3
        assert result.discovered == 3
        assert result.failed == 0
        assert result.errors == []

        # Upsert was called with exactly 3 records
        args, _kwargs = mock_upsert.call_args
        passed_records = args[0]
        assert len(passed_records) == 3
        assert all(isinstance(r, ClinicalTrialRecord) for r in passed_records)

    @staticmethod
    def _unplaceable_study() -> list[dict]:
        # EARLY_PHASE1 has no ring; PHASE2/PHASE3 does, so a seamless trial
        # is no longer an example of a phase the radar cannot place.
        return [
            _make_study(
                nct_id="NCT1",
                phases=["EARLY_PHASE1"],
                interventions=[{"type": "DRUG", "name": "drug"}],
            )
        ]

    async def test_the_status_sweep_runs_over_every_nct_id_in_the_table(
        self, mocker
    ):
        """Every id, not just the search's hits and not just curated rows.

        Gating on `target_population` would cost the status of every trial a
        curator publishes tomorrow, which would then ship NULL until the
        next sync.
        """
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=([], []),
        )
        mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            return_value=TrialUpsertResult(),
        )
        mocker.patch(
            "pipeline.database.read_nct_registry_ids",
            new_callable=AsyncMock,
            return_value=["NCT00000001", "NCT00000002"],
        )
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_trial_statuses",
            new_callable=AsyncMock,
            return_value=({"NCT00000001": "TERMINATED"}, []),
        )
        update = mocker.patch(
            "pipeline.database.update_trial_statuses",
            new_callable=AsyncMock,
            return_value=1,
        )

        result = await sync_clinical_trials(PipelineConfig())

        update.assert_awaited_once_with({"NCT00000001": "TERMINATED"})
        assert result.status_refreshed == 1
        assert result.errors == []

    async def test_a_sweep_failure_is_an_error_and_not_an_abort(self, mocker):
        """The trials keep the status they had and go on publishing.

        A stale status is a far cheaper error than the sync stopping, or
        than a trial silently vanishing from Table 2.
        """
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=([], []),
        )
        mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            return_value=TrialUpsertResult(),
        )
        mocker.patch(
            "pipeline.database.read_nct_registry_ids",
            new_callable=AsyncMock,
            side_effect=RuntimeError("no database"),
        )

        result = await sync_clinical_trials(PipelineConfig())

        assert result.aborted is False
        assert result.status_refreshed == 0
        assert result.errors == ["CTG status sweep: no database"]

    async def test_a_curated_trial_the_radar_cannot_place_is_an_error(
        self, mocker
    ):
        """A curated trial publishes immediately, so a phase with no ring
        puts it in Table 2 and on no ring of the figure, silently.
        """
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=(self._unplaceable_study(), []),
        )
        mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            return_value=TrialUpsertResult(
                refreshed=1,
                curated_ids=frozenset({"NCT1"}),
            ),
        )

        result = await sync_clinical_trials(PipelineConfig())

        assert result.errors == [
            "CTG NCT1: phase 'Early Phase I' has no ring on the trials radar, "
            "so the trial publishes in Table 2 and on no ring of the figure"
        ]
        # Nothing failed to be written; the row is there, just unplaceable.
        assert result.failed == 0

    async def test_an_uncurated_row_the_radar_cannot_place_is_not_an_error(
        self, mocker
    ):
        """The second sync of a discovery, which is the case that regressed.

        A discovery inserts on the run that finds it and *refreshes* on
        every run after, so treating every refreshed row as curated reported
        every uncurated row from the second sync onwards -- 35 of them on the
        first live re-run -- each claiming a Table 2 publication the export's
        curation gate skips.
        """
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=(self._unplaceable_study(), []),
        )
        mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            return_value=TrialUpsertResult(
                refreshed=1,
                curated_ids=frozenset(),
            ),
        )

        result = await sync_clinical_trials(PipelineConfig())

        assert result.errors == []
        assert result.failed == 0

    async def test_a_discovery_is_counted_and_named_as_unpublished(
        self, mocker, caplog
    ):
        studies = [
            _make_study(
                nct_id="NCT_NEW",
                phases=["PHASE4"],
                interventions=[{"type": "DRUG", "name": "drug"}],
            )
        ]
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=(studies, []),
        )
        mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            return_value=TrialUpsertResult(discovered=1),
        )

        import logging

        with caplog.at_level(
            logging.INFO, logger="pipeline.clinical_trials_fetch"
        ):
            result = await sync_clinical_trials(PipelineConfig())

        assert result.discovered == 1
        assert result.cached == 1
        # An uncurated discovery's phase is not an error: it is not
        # published at all until someone curates the row.
        assert result.errors == []
        assert "no curator has seen" in caplog.text

    async def test_fetch_failure_returns_error(self, mocker):
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            side_effect=RuntimeError("boom"),
        )
        config = PipelineConfig()
        result = await sync_clinical_trials(config)

        assert result.fetched == 0
        assert result.cached == 0
        assert "boom" in result.errors[0]

    async def test_upsert_failure_returns_error(self, mocker):
        studies = [
            _make_study(
                nct_id="NCT1",
                interventions=[{"type": "DRUG", "name": "drug"}],
            )
        ]
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=(studies, []),
        )
        mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            side_effect=RuntimeError("db down"),
        )

        config = PipelineConfig()
        result = await sync_clinical_trials(config)

        assert result.fetched == 1
        assert result.cached == 0
        assert result.failed == 1
        assert any("db down" in e for e in result.errors)

    async def test_studies_without_drugs_are_skipped(self, mocker):
        studies = [
            _make_study(nct_id="NCT1", interventions=[{"type": "DRUG", "name": "d"}]),
            _make_study(
                nct_id="NCT2",
                interventions=[{"type": "BEHAVIORAL", "name": "edu"}],
            ),
        ]
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=(studies, []),
        )
        mock_upsert = mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            return_value=TrialUpsertResult(discovered=1),
        )
        config = PipelineConfig()
        result = await sync_clinical_trials(config)

        # Both studies are reported as "fetched", but only NCT1 becomes a record
        assert result.fetched == 2
        args, _ = mock_upsert.call_args
        assert len(args[0]) == 1
        assert args[0][0].registry_id == "NCT1"

    async def test_term_failures_surfaced_in_errors(self, mocker):
        # fetch_disease_studies returns (studies, term_errors); the term errors
        # must propagate into SyncResult.errors.
        studies = [
            _make_study(
                nct_id="NCT_OK",
                interventions=[{"type": "DRUG", "name": "drug"}],
            )
        ]
        term_errors = ["CTG term 'bad': boom"]
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=(studies, term_errors),
        )
        mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            return_value=TrialUpsertResult(discovered=1),
        )
        config = PipelineConfig()
        result = await sync_clinical_trials(config)

        assert "CTG term 'bad'" in "\n".join(result.errors)
        assert result.cached == 1
        # A term that stopped short is an error and no failed row: nothing
        # about it failed to be written, and reading one truncated term as
        # "1 trial failed" understates a hundred studies never fetched.
        assert result.failed == 0

    async def test_separates_no_nct_from_no_drug_counters(self, mocker, caplog):
        # One study missing NCT, one study missing drug — each should hit its
        # own counter and emit its own log line.
        studies = [
            {"protocolSection": {"identificationModule": {}}},  # no NCT
            _make_study(
                nct_id="NCT_NO_DRUG",
                interventions=[{"type": "BEHAVIORAL", "name": "edu"}],
            ),
        ]
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=(studies, []),
        )
        mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            return_value=TrialUpsertResult(),
        )
        import logging

        caplog.set_level(logging.DEBUG, logger="pipeline.clinical_trials_fetch")
        config = PipelineConfig()
        await sync_clinical_trials(config)

        messages = [rec.message for rec in caplog.records]
        assert any("missing NCT ID" in m for m in messages)
        assert any("no DRUG-type intervention" in m for m in messages)

    async def test_mapping_error_is_reported_and_other_studies_continue(self, mocker):
        study = _make_study(
            nct_id="NCT_BAD", interventions=[{"type": "DRUG", "name": "drug"}]
        )
        mocker.patch(
            "pipeline.clinical_trials_fetch.fetch_disease_studies",
            return_value=([study], []),
        )
        mocker.patch(
            "pipeline.clinical_trials_fetch._map_study_to_records",
            side_effect=RuntimeError("malformed"),
        )
        upsert = mocker.patch(
            "pipeline.database.upsert_clinical_trials_batch",
            new_callable=AsyncMock,
            return_value=TrialUpsertResult(),
        )

        result = await sync_clinical_trials(PipelineConfig())

        assert result.errors == ["CTG map NCT_BAD: malformed"]
        # A study whose mapping blew up IS a failed row, unlike a truncation.
        assert result.failed == 1
        upsert.assert_awaited_once_with([])


async def test_close_ctg_client(mocker):
    close = mocker.patch(
        "pipeline.clinical_trials_fetch._client_manager.close", AsyncMock()
    )

    await close_ctg_client()

    close.assert_awaited_once_with()


# ---------------------------------------------------------------------------
# upsert_clinical_trials_batch — SQL invariant
# ---------------------------------------------------------------------------


class TestUpsertClinicalTrialsBatchSQL:
    """Pin down the load-bearing invariant: curator columns are NOT in SET."""

    @pytest.fixture
    def sample_record(self):
        return ClinicalTrialRecord(
            drug="aspirin",
            trial_name="Title",
            registry_id="NCT1",
            clinical_trial_phase="PHASE2",
            target_sample_size=100,
            estimated_completion_date="2026-12-31",
            primary_outcome="Outcome",
            sponsor_type="INDUSTRY",
        )

    async def test_sql_omits_curator_columns_from_set(self, mocker, sample_record):
        from pipeline.database import upsert_clinical_trials_batch

        captured_sql: list[str] = []

        async def fake_executemany(sql: str, rows):
            captured_sql.append(sql)

        mock_conn = AsyncMock()
        mock_conn.executemany = fake_executemany
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mocker.patch("pipeline.database.Database.connection", return_value=mock_ctx)

        await upsert_clinical_trials_batch([sample_record])

        assert len(captured_sql) == 1
        sql = captured_sql[0]

        # Confirm ON CONFLICT shape
        assert "ON CONFLICT (registry_id, drug) DO UPDATE SET" in sql

        # Isolate the SET clause so we don't false-positive on WHERE/other text
        set_clause = sql.split("DO UPDATE SET", 1)[1]

        # Curator columns must NOT appear in the SET clause
        for curator_col in (
            "mechanism_of_action",
            "genetic_target",
            "genetic_evidence",
            "target_population",
            "target_population_details",
        ):
            assert curator_col not in set_clause, (
                f"Curator column {curator_col!r} leaked into UPDATE SET — "
                "curator edits would be clobbered on refresh"
            )

        # API columns MUST appear in SET clause
        for api_col in (
            "trial_name",
            "clinical_trial_phase",
            "target_sample_size",
            "estimated_completion_date",
            "primary_outcome",
            "sponsor_type",
        ):
            assert api_col in set_clause

    async def test_sponsor_detail_is_kept_on_conflict(self, mocker, sample_record):
        """The curated column reads "Industry (Ever Neuro Pharma GmbH)".

        CT.gov only knows the class, so an exact (registry_id, drug) match
        must not replace the curator's prose with the bare word.
        """
        from pipeline.database import upsert_clinical_trials_batch

        captured_sql: list[str] = []

        async def fake_executemany(sql: str, rows):
            captured_sql.append(sql)

        mock_conn = AsyncMock()
        mock_conn.executemany = fake_executemany
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mocker.patch("pipeline.database.Database.connection", return_value=mock_ctx)

        await upsert_clinical_trials_batch([sample_record])

        set_clause = " ".join(captured_sql[0].split("DO UPDATE SET", 1)[1].split())
        assert (
            "sponsor_type = COALESCE( clinical_trials.sponsor_type, "
            "EXCLUDED.sponsor_type )"
        ) in set_clause
        assert "sponsor_type = EXCLUDED.sponsor_type" not in set_clause

    async def test_empty_list_short_circuits(self):
        from pipeline.database import TrialUpsertResult, upsert_clinical_trials_batch

        assert await upsert_clinical_trials_batch([]) == TrialUpsertResult()

    async def test_returns_row_counts(self, mocker, sample_record):
        from pipeline.database import upsert_clinical_trials_batch

        mock_conn = AsyncMock()
        mock_conn.executemany = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_ctx.__aexit__ = AsyncMock(return_value=None)
        mocker.patch("pipeline.database.Database.connection", return_value=mock_ctx)

        result = await upsert_clinical_trials_batch([sample_record, sample_record])
        assert result.discovered == 2
        assert result.written == 2


# ---------------------------------------------------------------------------
# Config validation
# ---------------------------------------------------------------------------


class TestConfigValidation:
    """PipelineConfig must reject CT misconfig that would hang or crash later."""

    def test_defaults_accepted(self):
        PipelineConfig()  # no raise

    def test_ct_max_concurrency_zero_rejected(self):
        with pytest.raises(ValueError, match="ct_max_concurrency"):
            PipelineConfig(ct_max_concurrency=0)

    def test_ct_max_concurrency_negative_rejected(self):
        with pytest.raises(ValueError, match="ct_max_concurrency"):
            PipelineConfig(ct_max_concurrency=-1)

    def test_ct_page_size_zero_rejected(self):
        with pytest.raises(ValueError, match="ct_page_size"):
            PipelineConfig(ct_page_size=0)

    def test_ct_page_size_too_large_rejected(self):
        with pytest.raises(ValueError, match="ct_page_size"):
            PipelineConfig(ct_page_size=1001)

    def test_ct_max_retries_negative_rejected(self):
        with pytest.raises(ValueError, match="ct_max_retries"):
            PipelineConfig(ct_max_retries=-1)

    def test_ct_max_retries_zero_accepted(self):
        PipelineConfig(ct_max_retries=0)  # no raise — 0 means "try once, no retry"


# ---------------------------------------------------------------------------
# init_ctg_fetch_state event-loop requirement
# ---------------------------------------------------------------------------


class TestInitState:
    def test_raises_outside_event_loop(self):
        # Called from a sync function with no running loop — must fail fast
        # with a clear message rather than creating an orphan Semaphore that
        # misbehaves at first use.
        from pipeline.clinical_trials_fetch import init_ctg_fetch_state

        with pytest.raises(RuntimeError, match="event loop"):
            init_ctg_fetch_state()

    async def test_idempotent_inside_loop(self):
        from pipeline.clinical_trials_fetch import init_ctg_fetch_state

        init_ctg_fetch_state()
        init_ctg_fetch_state()  # second call is a no-op, not an error
