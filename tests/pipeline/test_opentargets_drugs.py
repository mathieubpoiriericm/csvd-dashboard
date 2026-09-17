"""Open Targets verification of the trial drug mechanisms."""

import logging
from typing import Any
from unittest.mock import AsyncMock

from pipeline.opentargets_drugs import (
    fetch_drug_mechanism,
    strip_trade_suffix,
    sync_trial_drug_annotations,
)


class TestStripTradeSuffix:
    def test_removes_a_development_code(self) -> None:
        assert strip_trade_suffix("Mivelsiran (ALN-APP)") == "Mivelsiran"
        assert strip_trade_suffix("Butylphthalide (NBP)") == "Butylphthalide"
        assert (
            strip_trade_suffix("Palm tocotrienols complex (HOV-12020)")
            == "Palm tocotrienols complex"
        )

    def test_leaves_a_bare_name_alone(self) -> None:
        assert strip_trade_suffix("Cilostazol") == "Cilostazol"
        assert strip_trade_suffix("Tranexamic acid") == "Tranexamic acid"
        assert strip_trade_suffix("THN391") == "THN391"


class TestFetchDrugMechanism:
    def _hit(
        self,
        rows: list[dict[str, Any]],
        name: str = "CILOSTAZOL",
        chembl_id: str = "CHEMBL799",
    ) -> dict[str, Any]:
        return {
            "search": {
                "hits": [
                    {
                        "object": {
                            "id": chembl_id,
                            "name": name,
                            "mechanismsOfAction": {"rows": rows},
                        }
                    }
                ]
            }
        }

    async def test_records_action_type_mechanism_and_targets(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_drugs.graphql",
            AsyncMock(
                return_value=self._hit(
                    [
                        {
                            "actionType": "INHIBITOR",
                            "mechanismOfAction": "Phosphodiesterase 3A inhibitor",
                            "targets": [{"approvedSymbol": "PDE3A"}],
                        }
                    ]
                )
            ),
        )

        row = await fetch_drug_mechanism("Cilostazol", "26.06")

        assert row is not None
        assert row.resolved is True
        assert row.chembl_id == "CHEMBL799"
        assert row.action_type == "INHIBITOR"
        assert row.mechanism_of_action == "Phosphodiesterase 3A inhibitor"
        assert row.target_symbols == "PDE3A"
        assert row.source_version == "26.06"

    async def test_multiple_targets_join_in_sorted_order(self, mocker) -> None:
        """The guanylate cyclase activator hits four GUCY1 subunits."""
        mocker.patch(
            "pipeline.opentargets_drugs.graphql",
            AsyncMock(
                return_value=self._hit(
                    [
                        {
                            "actionType": "ACTIVATOR",
                            "mechanismOfAction": "Soluble guanylate cyclase activator",
                            "targets": [
                                {"approvedSymbol": "GUCY1B1"},
                                {"approvedSymbol": "GUCY1A1"},
                            ],
                        }
                    ],
                    name="ISOSORBIDE MONONITRATE",
                    chembl_id="CHEMBL1311",
                )
            ),
        )

        row = await fetch_drug_mechanism("Isosorbide mononitrate", "26.06")

        assert row is not None
        assert row.target_symbols == "GUCY1A1, GUCY1B1"

    async def test_a_resolved_drug_with_no_mechanism_is_still_resolved(
        self, mocker
    ) -> None:
        """Edaravone resolves to CHEMBL290916 and carries no mechanism rows."""
        mocker.patch(
            "pipeline.opentargets_drugs.graphql",
            AsyncMock(
                return_value=self._hit(
                    [], name="EDARAVONE", chembl_id="CHEMBL290916"
                )
            ),
        )

        row = await fetch_drug_mechanism("Edaravone", "26.06")

        assert row is not None
        assert row.resolved is True
        assert row.action_type is None
        assert row.mechanism_of_action is None

    async def test_an_unresolvable_drug_is_recorded_as_unresolved(
        self, mocker
    ) -> None:
        """5 of 11 trial drugs are not in ChEMBL. That is data, not an error."""
        mocker.patch(
            "pipeline.opentargets_drugs.graphql",
            AsyncMock(return_value={"search": {"hits": []}}),
        )

        row = await fetch_drug_mechanism("THN391", "26.06")

        assert row is not None
        assert row.resolved is False
        assert row.chembl_id is None
        assert row.drug == "THN391"

    async def test_a_transport_failure_is_none_not_an_unresolved_row(
        self, mocker
    ) -> None:
        """A 500 must not be recorded as "ChEMBL does not have this drug"."""
        mocker.patch(
            "pipeline.opentargets_drugs.graphql", AsyncMock(return_value=None)
        )

        assert await fetch_drug_mechanism("Cilostazol", "26.06") is None


class TestSyncTrialDrugAnnotations:
    async def test_reads_distinct_drugs_and_reports_the_resolution_rate(
        self, mocker
    ) -> None:
        from pipeline.annotations import DrugAnnotationRow

        mocker.patch(
            "pipeline.opentargets_drugs.get_trial_drugs",
            AsyncMock(
                return_value=[
                    ("Cilostazol", "Antiplatelet, vasodilator (PDE3 inhibitor)"),
                    ("THN391", "Anti-fibrin (humanized monoclonal antibody)"),
                ]
            ),
        )
        # Patch where it is used, not where it is defined -- opentargets_drugs
        # imports fetch_data_version into its own namespace at module load.
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_data_version",
            AsyncMock(return_value="26.06"),
        )
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_drug_mechanism",
            AsyncMock(
                side_effect=[
                    DrugAnnotationRow(
                        "Cilostazol", "CHEMBL799", "INHIBITOR",
                        "Phosphodiesterase 3A inhibitor", "PDE3A", "26.06", True,
                    ),
                    DrugAnnotationRow(
                        "THN391", None, None, None, None, "26.06", False
                    ),
                ]
            ),
        )
        upsert = mocker.patch(
            "pipeline.database.upsert_drug_annotations", AsyncMock(return_value=2)
        )

        result = await sync_trial_drug_annotations()

        # Both drugs were answered for, so both are written and neither is a
        # failure -- THN391 is simply not in ChEMBL.
        assert result.fetched == 2
        assert result.failed == 0
        assert result.errors == []
        assert upsert.await_args.args[0][0].drug == "Cilostazol"

    async def test_each_resolved_drug_puts_both_mechanisms_in_the_run_log(
        self, mocker, caplog
    ) -> None:
        """trial_drug_annotations is read by nothing, so the log is the record.

        The two strings are printed side by side and no verdict is reached:
        the curator's clinical class and Open Targets' target action can agree
        while sharing no word, so agreement is the reader's judgement.
        """
        from pipeline.annotations import DrugAnnotationRow

        mocker.patch(
            "pipeline.opentargets_drugs.get_trial_drugs",
            AsyncMock(
                return_value=[
                    ("Cilostazol", "Antiplatelet, vasodilator (PDE3 inhibitor)"),
                    ("THN391", "Anti-fibrin (humanized monoclonal antibody)"),
                ]
            ),
        )
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_data_version",
            AsyncMock(return_value="26.06"),
        )
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_drug_mechanism",
            AsyncMock(
                side_effect=[
                    DrugAnnotationRow(
                        "Cilostazol", "CHEMBL799", "INHIBITOR",
                        "Phosphodiesterase 3A inhibitor", "PDE3A", "26.06", True,
                    ),
                    DrugAnnotationRow(
                        "THN391", None, None, None, None, "26.06", False
                    ),
                ]
            ),
        )
        mocker.patch(
            "pipeline.database.upsert_drug_annotations", AsyncMock(return_value=2)
        )

        with caplog.at_level(logging.INFO, logger="pipeline.opentargets_drugs"):
            await sync_trial_drug_annotations()

        checks = [
            r.message
            for r in caplog.records
            if r.message.startswith("Mechanism check")
        ]
        assert len(checks) == 1
        assert "Antiplatelet, vasodilator (PDE3 inhibitor)" in checks[0]
        assert "Phosphodiesterase 3A inhibitor" in checks[0]
        assert "PDE3A" in checks[0]

    async def test_a_drug_chembl_lacks_gets_no_comparison_line(
        self, mocker, caplog
    ) -> None:
        """There is nothing to compare: the API answered and carries no row."""
        from pipeline.annotations import DrugAnnotationRow

        mocker.patch(
            "pipeline.opentargets_drugs.get_trial_drugs",
            AsyncMock(return_value=[("THN391", "Anti-fibrin")]),
        )
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_data_version",
            AsyncMock(return_value="26.06"),
        )
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_drug_mechanism",
            AsyncMock(
                return_value=DrugAnnotationRow(
                    "THN391", None, None, None, None, "26.06", False
                )
            ),
        )
        mocker.patch(
            "pipeline.database.upsert_drug_annotations", AsyncMock(return_value=1)
        )

        with caplog.at_level(logging.INFO, logger="pipeline.opentargets_drugs"):
            await sync_trial_drug_annotations()

        assert "Mechanism check" not in caplog.text

    async def test_a_transport_failure_is_counted_and_not_written(
        self, mocker
    ) -> None:
        mocker.patch(
            "pipeline.opentargets_drugs.get_trial_drugs",
            AsyncMock(return_value=[("Cilostazol", "Antiplatelet, vasodilator")]),
        )
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_data_version",
            AsyncMock(return_value="26.06"),
        )
        mocker.patch(
            "pipeline.opentargets_drugs.fetch_drug_mechanism",
            AsyncMock(return_value=None),
        )
        upsert = mocker.patch(
            "pipeline.database.upsert_drug_annotations", AsyncMock(return_value=0)
        )

        result = await sync_trial_drug_annotations()

        assert result.fetched == 0
        assert result.failed == 1
        assert upsert.await_args.args[0] == []


class TestGetTrialDrugs:
    async def test_reads_each_drug_once_with_its_curated_mechanism(
        self, mocker
    ) -> None:
        """ORDER BY is what makes two runs write the same rows.

        The curated mechanism rides along so the sync can log the two values
        side by side; grouping keeps one row per drug, so a drug in several
        trials is still searched once.
        """
        from pipeline.database import Database
        from pipeline.opentargets_drugs import get_trial_drugs

        conn = AsyncMock()
        conn.fetch.return_value = [
            {"drug": "Cilostazol", "mechanism_of_action": "Antiplatelet"},
            {"drug": "Colchicine", "mechanism_of_action": None},
        ]
        mocker.patch.object(
            Database,
            "connection",
            return_value=AsyncMock(
                __aenter__=AsyncMock(return_value=conn),
                __aexit__=AsyncMock(return_value=False),
            ),
        )

        assert await get_trial_drugs() == [
            ("Cilostazol", "Antiplatelet"),
            ("Colchicine", None),
        ]
        assert "GROUP BY drug" in conn.fetch.await_args.args[0]
        assert "ORDER BY drug" in conn.fetch.await_args.args[0]

    async def test_an_empty_trials_table_queries_no_api(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_drugs.get_trial_drugs", AsyncMock(return_value=[])
        )
        version = mocker.patch("pipeline.opentargets_drugs.fetch_data_version")
        upsert = mocker.patch("pipeline.database.upsert_drug_annotations")

        result = await sync_trial_drug_annotations()

        assert result.fetched == 0
        version.assert_not_called()
        upsert.assert_not_called()


class TestTheHitMustNameTheDrug:
    """Open Targets' search is fuzzy and returns something for almost anything.

    Measured live: 'Placebo' comes back as CHEMBL3 NICOTINE with a nicotinic
    agonist mechanism, and 'Minocyclin' as MINOCYCLINE HYDROCHLORIDE.
    get_trial_drugs reads CT.gov intervention names verbatim, so 'Placebo'
    becomes a row the moment --clinical-trials runs, and recording a mechanism
    for a drug nobody asked about -- against a curated column -- is worse than
    recording nothing.
    """

    def _named(self, name: str) -> dict[str, Any]:
        return {
            "search": {
                "hits": [
                    {
                        "object": {
                            "id": "CHEMBL3",
                            "name": name,
                            "mechanismsOfAction": {
                                "rows": [
                                    {
                                        "actionType": "AGONIST",
                                        "mechanismOfAction": "nAChR agonist",
                                        "targets": [{"approvedSymbol": "CHRNA4"}],
                                    }
                                ]
                            },
                        }
                    }
                ]
            }
        }

    async def test_a_near_miss_is_not_a_match(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_drugs.graphql",
            AsyncMock(return_value=self._named("NICOTINE")),
        )

        row = await fetch_drug_mechanism("Placebo", "26.06")

        assert row is not None
        assert row.resolved is False
        assert row.chembl_id is None
        assert row.mechanism_of_action is None

    async def test_the_match_is_case_and_space_insensitive(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_drugs.graphql",
            AsyncMock(return_value=self._named("  cilostazol  ")),
        )

        row = await fetch_drug_mechanism("Cilostazol", "26.06")

        assert row is not None
        assert row.resolved is True

    async def test_a_later_hit_may_be_the_right_one(self, mocker) -> None:
        """size: 1 would have hidden the correct drug behind a closer string."""
        payload = self._named("NICOTINE")
        payload["search"]["hits"].append(
            {
                "object": {
                    "id": "CHEMBL799",
                    "name": "CILOSTAZOL",
                    "mechanismsOfAction": {"rows": []},
                }
            }
        )
        mocker.patch(
            "pipeline.opentargets_drugs.graphql", AsyncMock(return_value=payload)
        )

        row = await fetch_drug_mechanism("Cilostazol", "26.06")

        assert row is not None
        assert row.chembl_id == "CHEMBL799"

    async def test_a_name_that_is_only_a_parenthetical_searches_nothing(
        self, mocker
    ) -> None:
        """A global strip turned "(ALN-APP)" into a search for the empty string."""
        graphql = mocker.patch("pipeline.opentargets_drugs.graphql", AsyncMock())

        row = await fetch_drug_mechanism("(ALN-APP)", "26.06")

        assert row is not None
        assert row.resolved is False
        graphql.assert_not_awaited()


class TestEveryMechanismIsRecorded:
    async def test_all_rows_are_joined_not_just_the_first(self, mocker) -> None:
        """rows[0] silently picked one of several; the API does not rank them."""
        mocker.patch(
            "pipeline.opentargets_drugs.graphql",
            AsyncMock(
                return_value={
                    "search": {
                        "hits": [
                            {
                                "object": {
                                    "id": "CHEMBL1234",
                                    "name": "NIMODIPINE",
                                    "mechanismsOfAction": {
                                        "rows": [
                                            {
                                                "actionType": "ANTAGONIST",
                                                "mechanismOfAction": "MR antagonist",
                                                "targets": [
                                                    {"approvedSymbol": "NR3C2"}
                                                ],
                                            },
                                            {
                                                "actionType": "BLOCKER",
                                                "mechanismOfAction": "CCB",
                                                "targets": [
                                                    {"approvedSymbol": "CACNA1C"}
                                                ],
                                            },
                                        ]
                                    },
                                }
                            }
                        ]
                    }
                }
            ),
        )

        row = await fetch_drug_mechanism("Nimodipine", "26.06")

        assert row is not None
        assert row.action_type == "ANTAGONIST, BLOCKER"
        assert row.mechanism_of_action == "CCB, MR antagonist"
        assert row.target_symbols == "CACNA1C, NR3C2"


class TestStripTradeSuffixIsAnchored:
    def test_only_a_trailing_parenthetical_is_dropped(self) -> None:
        assert strip_trade_suffix("Mivelsiran (ALN-APP)") == "Mivelsiran"
        assert strip_trade_suffix("Nimodipine (extended release)") == "Nimodipine"

    def test_a_bare_parenthetical_leaves_nothing(self) -> None:
        assert strip_trade_suffix("(ALN-APP)") == ""

    def test_an_interior_parenthetical_is_kept(self) -> None:
        # A global strip would have searched for "vitamin E" here.
        assert strip_trade_suffix("alpha (RRR) vitamin E") == "alpha (RRR) vitamin E"
