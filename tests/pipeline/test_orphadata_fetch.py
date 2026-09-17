"""Orphadata cross-reference and phenotype enrichment."""

import json
import logging
from collections import OrderedDict
from datetime import datetime
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx
import pytest

import pipeline.orphadata_fetch as orphadata
from pipeline.orphadata_fetch import (
    OrphadataDisease,
    OrphadataReference,
    _parse_cross_references,
    _parse_phenotypes,
    clear_orphadata_cache,
    close_orphadata_client,
    fetch_orphadata_disease,
    orphacodes_by_gene,
    sync_orphadata_annotations,
)

_LICENCE = {
    "identifier": "CC-BY-4.0",
    "link": "https://creativecommons.org/licenses/by/4.0",
    "name": "Creative Commons Attribution 4.0 International",
}


def _xref_payload() -> dict[str, Any]:
    """The live rd-cross-referencing shape for ORPHAcode 199354."""
    return {
        "data": {
            "__count": 1,
            "__licence": _LICENCE,
            "results": {
                "Date": "2026-06-23 07:53:50",
                "ORPHAcode": 199354,
                "Preferred term": (
                    "Cerebral autosomal recessive arteriopathy-subcortical "
                    "infarcts-leukoencephalopathy"
                ),
                "ExternalReference": [
                    {
                        "DisorderMappingRelation": (
                            "E (Exact mapping: the two concepts are equivalent)"
                        ),
                        "Reference": "0010829",
                        "Source": "MONDO",
                    },
                    {
                        "DisorderMappingRelation": (
                            "E (Exact mapping: the two concepts are equivalent)"
                        ),
                        "Reference": "600142",
                        "Source": "OMIM",
                    },
                    {
                        "DisorderMappingRelation": (
                            "NTBT (ORPHAcode is narrower than the targeted code "
                            "used to represent it)"
                        ),
                        "Reference": "I67.8",
                        "Source": "ICD-10",
                    },
                    {
                        "DisorderMappingRelation": (
                            "E (Exact mapping: the two concepts are equivalent)"
                        ),
                        "Reference": "C563990",
                        "Source": "MeSH",
                    },
                ],
            },
        }
    }


def _phenotype_payload() -> dict[str, Any]:
    """The live rd-phenotypes shape -- note the extra Disorder level."""
    return {
        "data": {
            "__count": 1,
            "__licence": _LICENCE,
            "results": {
                "Date": "2026-06-23 07:57:18",
                "Disorder": {
                    "DisorderGroup": "Disorder",
                    "HPODisorderAssociation": [
                        {
                            "DiagnosticCriteria": None,
                            "HPO": {
                                "HPOId": "HP:0000708",
                                "HPOTerm": "Atypical behavior",
                            },
                            "HPOFrequency": "Frequent (79-30%)",
                        },
                        {
                            "DiagnosticCriteria": None,
                            "HPO": {
                                "HPOId": "HP:0001257",
                                "HPOTerm": "Spasticity",
                            },
                            "HPOFrequency": "Frequent (79-30%)",
                        },
                    ],
                },
            },
        }
    }


class TestParseCrossReferences:
    def test_keeps_only_prefixes_this_pipeline_stores(self) -> None:
        refs = _parse_cross_references(_xref_payload()["data"]["results"])
        assert [r.object_id for r in refs] == [
            "MONDO:0010829",
            "MeSH:C563990",
            "OMIM:600142",
        ]

    def test_records_only_the_leading_qualifier_token(self) -> None:
        refs = _parse_cross_references(_xref_payload()["data"]["results"])
        assert {r.qualifier for r in refs} == {"E"}

    def test_an_icd_row_is_dropped_rather_than_stored_uninterpreted(self) -> None:
        refs = _parse_cross_references(_xref_payload()["data"]["results"])
        assert not any("I67.8" in r.object_id for r in refs)

    def test_a_narrower_than_mapping_keeps_its_ntbt_token(self) -> None:
        results = _xref_payload()["data"]["results"]
        results["ExternalReference"][1]["DisorderMappingRelation"] = (
            "NTBT (ORPHAcode is narrower than the targeted code used to represent it)"
        )
        refs = _parse_cross_references(results)
        by_id = {r.object_id: r.qualifier for r in refs}
        assert by_id["OMIM:600142"] == "NTBT"


class TestParsePhenotypes:
    def test_reads_through_the_extra_disorder_level(self) -> None:
        """results.HPODisorderAssociation is empty; the data is one level down."""
        phenotypes = _parse_phenotypes(_phenotype_payload()["data"]["results"])
        assert [p.object_id for p in phenotypes] == ["HP:0000708", "HP:0001257"]
        assert phenotypes[0].object_label == "Atypical behavior"
        assert phenotypes[0].qualifier == "Frequent (79-30%)"

    def test_a_disorder_with_no_phenotypes_yields_nothing(self) -> None:
        assert _parse_phenotypes({"Disorder": {}}) == []
        assert _parse_phenotypes({}) == []


class TestFetchOrphadataDisease:
    async def test_combines_both_endpoints(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[
                httpx.Response(200, text=json.dumps(_xref_payload())),
                httpx.Response(200, text=json.dumps(_phenotype_payload())),
            ]
        )
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        disease = await fetch_orphadata_disease("199354")

        assert disease is not None
        assert len(disease.cross_references) == 3
        assert len(disease.phenotypes) == 2
        assert disease.preferred_term.startswith("Cerebral autosomal recessive")

    async def test_a_404_is_a_confirmed_absence_not_a_failure(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=httpx.Response(404))
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        disease = await fetch_orphadata_disease("999999")

        assert disease is not None
        assert disease.cross_references == ()
        assert disease.phenotypes == ()

    async def test_a_500_is_a_transient_miss(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=httpx.Response(500))
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_orphadata_disease("199354") is None

    async def test_an_unexpected_licence_is_logged_loudly(self, mocker, caplog) -> None:
        payload = _xref_payload()
        payload["data"]["__licence"]["identifier"] = "CC-BY-NC-4.0"
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[
                httpx.Response(200, text=json.dumps(payload)),
                httpx.Response(200, text=json.dumps(_phenotype_payload())),
            ]
        )
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        await fetch_orphadata_disease("199354")

        assert "CC-BY-NC-4.0" in caplog.text
        assert "attribution" in caplog.text.lower()


class TestOrphacodesByGene:
    async def test_reads_the_orphanet_rows_clinvar_wrote(self, mocker) -> None:
        mocker.patch(
            "pipeline.database.read_gene_annotations",
            AsyncMock(
                return_value=[
                    {
                        "gene_symbol": "HTRA1",
                        "object_id": "Orphanet:199354",
                        "group_key": "MONDO:0010829",
                    },
                    {
                        "gene_symbol": "HTRA1",
                        "object_id": "OMIM:600142",
                        "group_key": "MONDO:0010829",
                    },
                    {
                        "gene_symbol": "HTRA1",
                        "object_id": "Orphanet:482072",
                        "group_key": "Orphanet:482072",
                    },
                ]
            ),
        )

        found = await orphacodes_by_gene()

        assert found == {
            "HTRA1": [("199354", "MONDO:0010829"), ("482072", "Orphanet:482072")]
        }


class TestSyncOrphadataAnnotations:
    async def test_a_gene_with_no_orphacode_gets_a_zero_status_row(
        self, mocker
    ) -> None:
        """There is no gene entry point, so no ORPHAcode means no enrichment."""
        mocker.patch(
            "pipeline.database.get_annotation_statuses",
            _statuses(clinvar=_clinvar_answered("FOXF2", row_count=0)),
        )
        mocker.patch(
            "pipeline.orphadata_fetch.orphacodes_by_gene", AsyncMock(return_value={})
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )

        result = await sync_orphadata_annotations(["FOXF2"])

        statuses = replace.await_args.args[1]
        assert [(s.gene_symbol, s.row_count) for s in statuses] == [("FOXF2", 0)]
        assert result.failed == 0


class TestPhenotypeRowsThatNameNothing:
    def test_an_association_with_no_hpo_id_is_dropped(self) -> None:
        results = _phenotype_payload()["data"]["results"]
        results["Disorder"]["HPODisorderAssociation"].append(
            {
                "DiagnosticCriteria": None,
                "HPO": {"HPOTerm": "Nameless"},
                "HPOFrequency": None,
            }
        )

        phenotypes = _parse_phenotypes(results)

        assert [p.object_id for p in phenotypes] == ["HP:0000708", "HP:0001257"]


class TestTransportFailureModes:
    @pytest.mark.parametrize(
        "failure",
        [
            httpx.TimeoutException("slow"),
            httpx.ConnectError("refused"),
        ],
        ids=["timeout", "request-error"],
    )
    async def test_a_transport_error_is_a_transient_miss(self, mocker, failure) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=failure)
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_orphadata_disease("199354") is None

    async def test_an_unparseable_body_is_a_transient_miss(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=httpx.Response(200, text="not json"))
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_orphadata_disease("199354") is None

    async def test_a_failed_phenotype_call_fails_the_whole_disease(
        self, mocker
    ) -> None:
        """Half a disease is worse than none: it would cache as "no phenotypes"."""
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[
                httpx.Response(200, text=json.dumps(_xref_payload())),
                httpx.Response(500),
            ]
        )
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_orphadata_disease("199354") is None

    async def test_a_404_on_phenotypes_alone_keeps_the_cross_references(
        self, mocker
    ) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            side_effect=[
                httpx.Response(200, text=json.dumps(_xref_payload())),
                httpx.Response(404),
            ]
        )
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        disease = await fetch_orphadata_disease("199354")

        assert disease is not None
        assert len(disease.cross_references) == 3
        assert disease.phenotypes == ()


class TestA200WithoutTheEnvelope:
    @pytest.mark.parametrize(
        "body",
        [
            json.dumps({"message": "service degraded"}),
            json.dumps({"data": {"__licence": _LICENCE}}),
            json.dumps([]),
        ],
        ids=["no-data", "no-results", "not-an-object"],
    )
    async def test_it_is_a_transient_miss_not_an_empty_disease(
        self, mocker, body
    ) -> None:
        """An in-band error must not negative-cache "no cross-references".

        The disease would be built empty, a zero-count status row written and
        the previous enrichment deleted -- held for DB_CACHE_TTL_DAYS while
        the run reported success.
        """
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=httpx.Response(200, text=body))
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_orphadata_disease("251393") is None

    async def test_a_present_but_empty_results_is_still_an_answer(
        self, mocker
    ) -> None:
        """Only the key's absence is the failure; `{}` is a real empty answer."""
        empty = json.dumps({"data": {"__licence": _LICENCE, "results": {}}})
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=httpx.Response(200, text=empty))
        mocker.patch(
            "pipeline.orphadata_fetch._client_manager.get", return_value=mock_client
        )

        disease = await fetch_orphadata_disease("251393")

        assert disease is not None
        assert disease.cross_references == ()


class TestOrphacodesByGeneDeduplicates:
    async def test_the_same_code_twice_is_recorded_once(self, mocker) -> None:
        """Two ClinVar xref rows for one disease name the same ORPHAcode."""
        mocker.patch(
            "pipeline.database.read_gene_annotations",
            AsyncMock(
                return_value=[
                    {
                        "gene_symbol": "HTRA1",
                        "object_id": "Orphanet:199354",
                        "group_key": "MONDO:0010829",
                    },
                    {
                        "gene_symbol": "HTRA1",
                        "object_id": "Orphanet:199354",
                        "group_key": "MONDO:0010829",
                    },
                ]
            ),
        )

        assert await orphacodes_by_gene() == {"HTRA1": [("199354", "MONDO:0010829")]}


class TestModuleLifecycle:
    def test_the_cache_lock_is_created_once(self) -> None:
        assert orphadata._get_cache_lock() is orphadata._get_cache_lock()

    def test_the_semaphore_falls_back_to_the_default_config(self) -> None:
        semaphore = orphadata._get_orphadata_semaphore()
        assert semaphore is orphadata._get_orphadata_semaphore()

    async def test_closing_the_client_is_safe(self) -> None:
        await close_orphadata_client()

    def test_clearing_the_cache_empties_it(self) -> None:
        orphadata._orphadata_cache["199354"] = None
        # A real Task is not needed to prove clear() empties the dict.
        orphadata._in_flight["199354"] = cast(Any, None)

        clear_orphadata_cache()

        assert orphadata._orphadata_cache == OrderedDict()
        assert orphadata._in_flight == {}


def _carasil() -> OrphadataDisease:
    """ORPHAcode 199354 as the sync sees it: one xref and one phenotype."""
    return OrphadataDisease(
        preferred_term="CARASIL",
        cross_references=(
            OrphadataReference(
                object_id="OMIM:600142",
                object_label=None,
                qualifier="E",
                relation="disease_xref",
            ),
        ),
        phenotypes=(
            OrphadataReference(
                object_id="HP:0001257",
                object_label="Spasticity",
                qualifier="Frequent (79-30%)",
                relation="phenotype",
            ),
        ),
        source_date="2026-06-23 07:53:50",
    )


def _statuses(
    orphadata: dict[str, dict[str, object]] | None = None,
    clinvar: dict[str, dict[str, object]] | None = None,
) -> AsyncMock:
    """A get_annotation_statuses double answering per source.

    The sync reads its own statuses first (with the TTL) and then ClinVar's
    (any age), so a single return value cannot stand in for both.
    """
    answers = {"orphadata": orphadata or {}, "clinvar": clinvar or {}}

    async def _lookup(gene_symbols, source, max_age_days=None):
        return {s: answers[source][s] for s in gene_symbols if s in answers[source]}

    return AsyncMock(side_effect=_lookup)


def _clinvar_answered(
    *symbols: str,
    row_count: int = 4,
    updated_at: datetime | None = None,
) -> dict[str, dict[str, object]]:
    return {
        s: {
            "row_count": row_count,
            "source_version": None,
            "updated_at": updated_at,
        }
        for s in symbols
    }


def _orphadata_cached(
    *symbols: str,
    row_count: int = 7,
    updated_at: datetime | None = None,
) -> dict[str, dict[str, object]]:
    return {
        s: {
            "row_count": row_count,
            "source_version": None,
            "updated_at": updated_at,
        }
        for s in symbols
    }


def _mapped(orphacode: str, qualifier: str) -> OrphadataDisease:
    """One ORPHAcode mapping OMIM:600142 with the relation it reports."""
    return OrphadataDisease(
        preferred_term=f"Disease {orphacode}",
        cross_references=(
            OrphadataReference(
                object_id="OMIM:600142",
                object_label=None,
                qualifier=qualifier,
                relation="disease_xref",
            ),
        ),
        phenotypes=(),
        source_date="2026-06-23 07:53:50",
    )


class TestSyncOrphadataWritesEnrichment:
    async def test_a_fully_cached_run_fetches_nothing(self, mocker) -> None:
        mocker.patch(
            "pipeline.database.get_annotation_statuses",
            AsyncMock(
                return_value={"HTRA1": {"row_count": 7, "source_version": None}}
            ),
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )

        result = await sync_orphadata_annotations(["HTRA1"])

        assert result.cached == 1
        assert result.fetched == 0
        replace.assert_not_awaited()

    async def test_each_reference_becomes_a_row_under_clinvars_group_key(
        self, mocker
    ) -> None:
        """The join: Orphadata's rows carry the group_key ClinVar chose."""
        mocker.patch(
            "pipeline.database.get_annotation_statuses",
            _statuses(clinvar=_clinvar_answered("HTRA1")),
        )
        mocker.patch(
            "pipeline.orphadata_fetch.orphacodes_by_gene",
            AsyncMock(return_value={"HTRA1": [("199354", "MONDO:0010829")]}),
        )
        mocker.patch(
            "pipeline.orphadata_fetch.fetch_orphadata_disease",
            AsyncMock(return_value=_carasil()),
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=2)
        )

        result = await sync_orphadata_annotations(["HTRA1"])

        rows, statuses = replace.await_args.args
        assert [(r.relation, r.object_id, r.group_key) for r in rows] == [
            ("disease_xref", "OMIM:600142", "MONDO:0010829"),
            ("phenotype", "HP:0001257", "MONDO:0010829"),
        ]
        # A cross-reference carries no label of its own, so it inherits the
        # disorder's preferred term; a phenotype keeps the HPO term.
        assert rows[0].object_label == "CARASIL"
        assert rows[1].object_label == "Spasticity"
        assert statuses[0].row_count == 2
        assert result.failed == 0


class TestAGeneWithAFailedCode:
    async def test_a_gene_whose_every_code_failed_is_not_written_at_all(
        self, mocker
    ) -> None:
        """replace_gene_annotations deletes before it inserts.

        A status row for a gene whose every ORPHAcode 502'd would drop the
        rows it already had and then suppress the retry for
        DB_CACHE_TTL_DAYS -- the invariant ClinVar and Open Targets both keep.
        """
        mocker.patch(
            "pipeline.database.get_annotation_statuses",
            _statuses(clinvar=_clinvar_answered("HTRA1")),
        )
        mocker.patch(
            "pipeline.orphadata_fetch.orphacodes_by_gene",
            AsyncMock(return_value={"HTRA1": [("199354", "MONDO:0010829")]}),
        )
        mocker.patch(
            "pipeline.orphadata_fetch.fetch_orphadata_disease",
            AsyncMock(return_value=None),
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )

        result = await sync_orphadata_annotations(["HTRA1"])

        rows, statuses = replace.await_args.args
        assert rows == []
        assert statuses == []
        assert result.failed == 1

    async def test_one_failed_code_among_several_is_not_written_either(
        self, mocker
    ) -> None:
        """A partial answer must never be cached as a complete one.

        With codes A (200) and B (502), writing A's rows plus a status row
        deletes B's enrichment from the previous run and then suppresses the
        retry for DB_CACHE_TTL_DAYS while the run reports success -- the same
        failure a skipped esummary batch was for ClinVar.
        """
        mocker.patch(
            "pipeline.database.get_annotation_statuses",
            _statuses(clinvar=_clinvar_answered("HTRA1")),
        )
        mocker.patch(
            "pipeline.orphadata_fetch.orphacodes_by_gene",
            AsyncMock(
                return_value={
                    "HTRA1": [
                        ("199354", "MONDO:0010829"),
                        ("482072", "Orphanet:482072"),
                    ]
                }
            ),
        )
        mocker.patch(
            "pipeline.orphadata_fetch.fetch_orphadata_disease",
            AsyncMock(side_effect=[_carasil(), None]),
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )

        result = await sync_orphadata_annotations(["HTRA1"])

        rows, statuses = replace.await_args.args
        assert rows == []
        assert statuses == []
        assert result.fetched == 0
        assert result.failed == 1

    async def test_a_gene_with_no_orphacode_still_gets_its_zero_row(
        self, mocker
    ) -> None:
        """No ORPHAcode is a final answer for this source, not a failure.

        That holds only once ClinVar has answered: a zero-row ClinVar status
        says the gene carries no Orphanet identifier.
        """
        mocker.patch(
            "pipeline.database.get_annotation_statuses",
            _statuses(clinvar=_clinvar_answered("FOXF2", row_count=0)),
        )
        mocker.patch(
            "pipeline.orphadata_fetch.orphacodes_by_gene", AsyncMock(return_value={})
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )

        result = await sync_orphadata_annotations(["FOXF2"])

        statuses = replace.await_args.args[1]
        assert [(s.gene_symbol, s.row_count) for s in statuses] == [("FOXF2", 0)]
        assert result.failed == 0

    async def test_a_gene_clinvar_never_answered_is_not_written(self, mocker) -> None:
        """No ClinVar rows and no ClinVar status is a failed fetch, not "none".

        ClinVar is the entry point: its transport failure writes no row, so
        the gene is indistinguishable here from one with no ORPHAcode unless
        its status is consulted. Writing a zero-count row would negative-cache
        ClinVar's outage for DB_CACHE_TTL_DAYS, one hop downstream.
        """
        mocker.patch("pipeline.database.get_annotation_statuses", _statuses())
        mocker.patch(
            "pipeline.orphadata_fetch.orphacodes_by_gene", AsyncMock(return_value={})
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )

        result = await sync_orphadata_annotations(["HTRA1"])

        rows, statuses = replace.await_args.args
        assert rows == []
        assert statuses == []
        assert result.fetched == 0
        assert result.failed == 1
        assert result.errors == ["Orphadata skipped HTRA1: no ClinVar answer yet"]

    async def test_the_clinvar_status_is_read_at_any_age(self, mocker) -> None:
        """A stale ClinVar answer is still an answer; the TTL is Orphadata's."""
        statuses = _statuses(clinvar=_clinvar_answered("FOXF2", row_count=0))
        mocker.patch("pipeline.database.get_annotation_statuses", statuses)
        mocker.patch(
            "pipeline.orphadata_fetch.orphacodes_by_gene", AsyncMock(return_value={})
        )
        mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )

        await sync_orphadata_annotations(["FOXF2"])

        clinvar_calls = [
            c for c in statuses.await_args_list if c.args[1] == "clinvar"
        ]
        assert len(clinvar_calls) == 1
        assert clinvar_calls[0].kwargs.get("max_age_days") is None


class TestOrphadataFreshnessFollowsClinVar:
    """This source's rows are keyed on ClinVar's ORPHAcodes and group_keys.

    A ClinVar refresh inside Orphadata's own TTL -- after the manual purge
    `pipeline/CLAUDE.md` prescribes, say -- can add a code or move a group,
    and the enrichment left behind either no longer joins (dropped at export
    with a warning) or is simply missing, for the rest of the 30 days.
    """

    @staticmethod
    def _sync_with(mocker, statuses: AsyncMock) -> Any:
        mocker.patch("pipeline.database.get_annotation_statuses", statuses)
        mocker.patch(
            "pipeline.orphadata_fetch.orphacodes_by_gene",
            AsyncMock(return_value={"HTRA1": [("199354", "MONDO:0010829")]}),
        )
        mocker.patch(
            "pipeline.orphadata_fetch.fetch_orphadata_disease",
            AsyncMock(return_value=_carasil()),
        )
        return mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=2)
        )

    async def test_a_newer_clinvar_status_invalidates_the_cache(
        self, mocker
    ) -> None:
        replace = self._sync_with(
            mocker,
            _statuses(
                orphadata=_orphadata_cached(
                    "HTRA1", updated_at=datetime(2026, 8, 20, 9, 0)
                ),
                clinvar=_clinvar_answered(
                    "HTRA1", updated_at=datetime(2026, 9, 1, 9, 0)
                ),
            ),
        )

        result = await sync_orphadata_annotations(["HTRA1"])

        assert result.fetched == 1
        assert result.cached == 0
        assert [s.gene_symbol for s in replace.await_args.args[1]] == ["HTRA1"]

    async def test_an_older_clinvar_status_leaves_the_cache_alone(
        self, mocker
    ) -> None:
        replace = self._sync_with(
            mocker,
            _statuses(
                orphadata=_orphadata_cached(
                    "HTRA1", updated_at=datetime(2026, 9, 1, 9, 1)
                ),
                clinvar=_clinvar_answered(
                    "HTRA1", updated_at=datetime(2026, 9, 1, 9, 0)
                ),
            ),
        )

        result = await sync_orphadata_annotations(["HTRA1"])

        assert (result.fetched, result.cached) == (0, 1)
        replace.assert_not_awaited()

    async def test_a_missing_timestamp_is_not_evidence_of_staleness(
        self, mocker
    ) -> None:
        """A cache is invalidated on evidence; "unknown" is not evidence."""
        replace = self._sync_with(
            mocker,
            _statuses(
                orphadata=_orphadata_cached("HTRA1", updated_at=None),
                clinvar=_clinvar_answered(
                    "HTRA1", updated_at=datetime(2026, 9, 1, 9, 0)
                ),
            ),
        )

        result = await sync_orphadata_annotations(["HTRA1"])

        assert (result.fetched, result.cached) == (0, 1)
        replace.assert_not_awaited()

    async def test_a_cached_gene_clinvar_never_answered_stays_cached(
        self, mocker
    ) -> None:
        replace = self._sync_with(
            mocker,
            _statuses(
                orphadata=_orphadata_cached(
                    "HTRA1", updated_at=datetime(2026, 9, 1, 9, 0)
                )
            ),
        )

        result = await sync_orphadata_annotations(["HTRA1"])

        assert (result.fetched, result.cached) == (0, 1)
        replace.assert_not_awaited()


class TestTwoOrphacodesUnderOneGroup:
    """LAMC2 carries four ORPHAcodes under MONDO:0009180.

    Each reports its own DisorderMappingRelation for a shared target, and the
    rows land on one UNIQUE key -- so ON CONFLICT DO UPDATE kept whichever the
    sort wrote last and the other mapping vanished with no log line.
    """

    @staticmethod
    def _sync_two(mocker, first: str, second: str) -> Any:
        mocker.patch(
            "pipeline.database.get_annotation_statuses",
            _statuses(clinvar=_clinvar_answered("LAMC2")),
        )
        mocker.patch(
            "pipeline.orphadata_fetch.orphacodes_by_gene",
            AsyncMock(
                return_value={
                    "LAMC2": [
                        ("251393", "MONDO:0009180"),
                        ("79402", "MONDO:0009180"),
                    ]
                }
            ),
        )
        # ``wanted`` is sorted, so 251393 is fetched before 79402.
        mocker.patch(
            "pipeline.orphadata_fetch.fetch_orphadata_disease",
            AsyncMock(
                side_effect=[_mapped("251393", first), _mapped("79402", second)]
            ),
        )
        return mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=1)
        )

    async def test_the_exact_mapping_wins_whichever_code_reports_it(
        self, mocker, caplog
    ) -> None:
        replace = self._sync_two(mocker, first="BTNT", second="E")

        with caplog.at_level(logging.WARNING, logger="pipeline.orphadata_fetch"):
            await sync_orphadata_annotations(["LAMC2"])

        rows, statuses = replace.await_args.args
        assert [(r.object_id, r.qualifier) for r in rows] == [("OMIM:600142", "E")]
        assert statuses[0].row_count == 1
        assert "ORPHA:79402" in caplog.text
        assert "'BTNT'" in caplog.text

    async def test_the_first_code_wins_when_neither_mapping_is_exact(
        self, mocker, caplog
    ) -> None:
        replace = self._sync_two(mocker, first="NTBT", second="BTNT")

        with caplog.at_level(logging.WARNING, logger="pipeline.orphadata_fetch"):
            await sync_orphadata_annotations(["LAMC2"])

        rows, _ = replace.await_args.args
        assert [(r.object_id, r.qualifier) for r in rows] == [
            ("OMIM:600142", "NTBT")
        ]
        assert "keeping ORPHA:251393's" in caplog.text

    async def test_two_codes_agreeing_collapse_without_a_warning(
        self, mocker, caplog
    ) -> None:
        replace = self._sync_two(mocker, first="E", second="E")

        with caplog.at_level(logging.WARNING, logger="pipeline.orphadata_fetch"):
            await sync_orphadata_annotations(["LAMC2"])

        rows, _ = replace.await_args.args
        assert [(r.object_id, r.qualifier) for r in rows] == [("OMIM:600142", "E")]
        assert caplog.text == ""
