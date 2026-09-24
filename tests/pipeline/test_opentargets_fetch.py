"""Open Targets gene identity, disease associations and GO terms."""

import json
import logging
from collections import OrderedDict
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx
import pytest

import pipeline.opentargets_fetch as opentargets
from pipeline.annotations import AnnotationRow
from pipeline.config import PipelineConfig
from pipeline.opentargets_fetch import (
    _parse_target,
    clear_opentargets_cache,
    close_opentargets_client,
    fetch_data_version,
    fetch_opentargets_target,
    graphql,
    resolve_target,
    sync_opentargets_annotations,
)


def _ok(payload: dict[str, Any]) -> httpx.Response:
    return httpx.Response(200, text=json.dumps({"data": payload}))


class TestGraphql:
    async def test_posts_query_and_variables_as_json(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=_ok({"meta": {}}))
        mocker.patch(
            "pipeline.opentargets_fetch._client_manager.get", return_value=mock_client
        )

        await graphql("query Q($x: String!) { a }", {"x": "HTRA1"})

        body = mock_client.post.call_args.kwargs["json"]
        assert body["query"].startswith("query Q")
        assert body["variables"] == {"x": "HTRA1"}

    async def test_graphql_errors_are_logged_and_return_none(
        self, mocker, caplog
    ) -> None:
        """A schema drift arrives as a 200 with an errors array, not a 4xx."""
        resp = httpx.Response(
            200,
            text=json.dumps(
                {
                    "errors": [
                        {"message": "Cannot query field 'name' on type "
                                    "'GeneOntologyTerm'."}
                    ]
                }
            ),
        )
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=resp)
        mocker.patch(
            "pipeline.opentargets_fetch._client_manager.get", return_value=mock_client
        )

        assert await graphql("{ x }", {}) is None
        assert "GeneOntologyTerm" in caplog.text

    async def test_a_timeout_returns_none(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.TimeoutException("slow"))
        mocker.patch(
            "pipeline.opentargets_fetch._client_manager.get", return_value=mock_client
        )

        assert await graphql("{ x }", {}) is None


class TestFetchDataVersion:
    async def test_joins_year_and_month(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_fetch.graphql",
            AsyncMock(
                return_value={
                    "meta": {"dataVersion": {"year": "26", "month": "06"}}
                }
            ),
        )
        assert await fetch_data_version() == "26.06"

    async def test_a_failed_meta_query_is_none_not_a_crash(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_fetch.graphql", AsyncMock(return_value=None)
        )
        assert await fetch_data_version() is None


class TestResolveTarget:
    async def test_returns_the_first_exact_symbol_match(self, mocker) -> None:
        """HTRA1 and HTRA1-AS1 both hit; only the exact symbol is the target."""
        mocker.patch(
            "pipeline.opentargets_fetch.graphql",
            AsyncMock(
                return_value={
                    "search": {
                        "hits": [
                            {
                                "id": "ENSG00000285955",
                                "object": {"approvedSymbol": "HTRA1-AS1"},
                            },
                            {
                                "id": "ENSG00000166033",
                                "object": {"approvedSymbol": "HTRA1"},
                            },
                        ]
                    }
                }
            ),
        )
        resolution = await resolve_target("HTRA1")
        assert resolution is not None
        assert resolution.ensembl_id == "ENSG00000166033"

    async def test_no_exact_match_is_a_confirmed_absence(self, mocker) -> None:
        """COL4A1/2 is a compound curator label, not a gene symbol.

        A search that succeeded and matched nothing is a final answer. It used
        to be indistinguishable from a transport failure, so an outage was
        written as "this gene has no annotations" for DB_CACHE_TTL_DAYS after
        deleting the rows it did have.
        """
        mocker.patch(
            "pipeline.opentargets_fetch.graphql",
            AsyncMock(return_value={"search": {"hits": []}}),
        )

        resolution = await resolve_target("COL4A1/2")

        assert resolution is not None
        assert resolution.ensembl_id is None


class TestParseTarget:
    def _payload(self) -> dict[str, Any]:
        return {
            "id": "ENSG00000166033",
            "approvedSymbol": "HTRA1",
            "approvedName": "HtrA serine peptidase 1",
            "biotype": "protein_coding",
            "dbXrefs": [
                {"id": "9476", "source": "HGNC"},
                {"id": "2JOA", "source": "PDB"},
                {"id": "3NUM", "source": "PDB"},
            ],
            "geneOntology": [
                {
                    "aspect": "F",
                    "evidence": "IPI",
                    "source": "PMID:25002585",
                    "term": {"id": "GO:0005515", "label": "protein binding"},
                },
                {
                    "aspect": "C",
                    "evidence": "IEA",
                    "source": "GO_REF:0000044",
                    "term": {"id": "GO:0005576", "label": "extracellular region"},
                },
            ],
            "associatedDiseases": {
                "count": 490,
                "rows": [
                    {
                        "score": 0.7588060448267118,
                        "disease": {
                            "id": "MONDO_0014768",
                            "name": "cerebral arteriopathy, type 2",
                        },
                    },
                    {
                        "score": 0.7525744067902492,
                        "disease": {"id": "Orphanet_199354", "name": "CARASIL"},
                    },
                    {
                        "score": 0.5,
                        "disease": {"id": "OTAR_0000018", "name": "genetic disease"},
                    },
                ],
            },
        }

    def test_identity_rows_drop_the_pdb_noise(self) -> None:
        rows = _parse_target("HTRA1", self._payload(), "26.06")
        identity = [r for r in rows if r.relation == "identity"]
        assert {r.object_id for r in identity} == {
            "Ensembl:ENSG00000166033",
            "HGNC:9476",
        }
        assert all(r.qualifier == "protein_coding" for r in identity)

    def test_disease_rows_carry_the_score_and_a_canonical_id(self) -> None:
        rows = _parse_target("HTRA1", self._payload(), "26.06")
        diseases = {r.object_id: r for r in rows if r.relation == "disease"}
        assert set(diseases) == {"MONDO:0014768", "Orphanet:199354"}
        assert diseases["MONDO:0014768"].score == pytest.approx(0.7588060448267118)
        assert diseases["MONDO:0014768"].group_key == "MONDO:0014768"

    def test_a_therapeutic_area_id_is_not_stored_as_a_disease(self) -> None:
        """OTAR_ is Open Targets' own bucket, not a disease ontology."""
        rows = _parse_target("HTRA1", self._payload(), "26.06")
        assert not any("OTAR" in r.object_id for r in rows)

    def test_go_rows_join_aspect_and_evidence_into_one_qualifier(self) -> None:
        rows = _parse_target("HTRA1", self._payload(), "26.06")
        go = {r.object_id: r for r in rows if r.relation == "gene_ontology"}
        assert go["GO:0005515"].qualifier == "F/IPI"
        assert go["GO:0005515"].object_label == "protein binding"
        assert go["GO:0005515"].group_key == ""

    def test_every_row_carries_the_data_version(self) -> None:
        rows = _parse_target("HTRA1", self._payload(), "26.06")
        assert {r.source_version for r in rows} == {"26.06"}

    def test_rows_are_deduplicated(self) -> None:
        """GO returns 43 rows for HTRA1 and repeats GO:0005515 with two PMIDs."""
        payload = self._payload()
        payload["geneOntology"].append(
            {
                "aspect": "F",
                "evidence": "IPI",
                "source": "PMID:21622153",
                "term": {"id": "GO:0005515", "label": "protein binding"},
            }
        )
        rows = _parse_target("HTRA1", payload, "26.06")
        go_ids = [r.object_id for r in rows if r.relation == "gene_ontology"]
        assert len(go_ids) == len(set(go_ids))


class TestFetchOpenTargetsTarget:
    async def test_an_unresolvable_symbol_yields_an_empty_target(
        self, mocker
    ) -> None:
        mocker.patch(
            "pipeline.opentargets_fetch.resolve_target",
            AsyncMock(return_value=opentargets._Resolution(None)),
        )
        mocker.patch(
            "pipeline.opentargets_fetch.fetch_data_version",
            AsyncMock(return_value="26.06"),
        )

        target = await fetch_opentargets_target("COL4A1/2")

        assert target is not None
        assert target.rows == ()
        assert target.ensembl_id is None


class TestGraphqlTransportFailures:
    async def test_a_non_200_returns_none(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=httpx.Response(503))
        mocker.patch(
            "pipeline.opentargets_fetch._client_manager.get", return_value=mock_client
        )

        assert await graphql("{ meta { name } }", {}) is None

    async def test_a_request_error_returns_none(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=httpx.ConnectError("refused"))
        mocker.patch(
            "pipeline.opentargets_fetch._client_manager.get", return_value=mock_client
        )

        assert await graphql("{ meta { name } }", {}) is None

    async def test_an_unparseable_body_returns_none(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            return_value=httpx.Response(200, text="<html>gateway</html>")
        )
        mocker.patch(
            "pipeline.opentargets_fetch._client_manager.get", return_value=mock_client
        )

        assert await graphql("{ meta { name } }", {}) is None


class TestVersionAndResolutionEdges:
    async def test_a_meta_payload_missing_month_is_no_version(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_fetch.graphql",
            AsyncMock(return_value={"meta": {"dataVersion": {"year": "26"}}}),
        )

        assert await fetch_data_version() is None

    async def test_a_failed_search_resolves_to_nothing(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_fetch.graphql", AsyncMock(return_value=None)
        )

        # A transport or GraphQL failure, which must never be cached.
        assert await resolve_target("HTRA1") is None


class TestParseTargetEdges:
    def test_a_target_with_no_id_writes_no_ensembl_row(self) -> None:
        rows = _parse_target("HTRA1", {"approvedName": "HtrA serine peptidase 1"}, None)
        assert rows == []

    def test_an_identity_xref_with_no_value_is_dropped(self) -> None:
        """An HGNC entry carrying an empty id names nothing."""
        rows = _parse_target(
            "HTRA1",
            {"id": "ENSG00000166033", "dbXrefs": [{"id": "", "source": "HGNC"}]},
            None,
        )
        assert [r.object_id for r in rows] == ["Ensembl:ENSG00000166033"]

    def test_a_go_entry_with_no_accession_is_dropped(self) -> None:
        rows = _parse_target(
            "HTRA1",
            {
                "id": "ENSG00000166033",
                "geneOntology": [
                    {"aspect": "F", "evidence": "IPI", "term": {"label": "nameless"}}
                ],
            },
            None,
        )
        assert not [r for r in rows if r.relation == "gene_ontology"]


class TestVersionDrift:
    def test_a_live_version_past_the_pin_warns(self, caplog) -> None:
        """The Beta API's schema has already moved once; drift is not silent."""
        config = PipelineConfig()
        config.opentargets_data_version = "26.06"

        with caplog.at_level(logging.WARNING):
            opentargets._warn_on_version_drift("26.09", config)

        assert "26.09" in caplog.text
        assert "PIPELINE_OPENTARGETS_DATA_VERSION" in caplog.text

    def test_the_pinned_version_is_silent(self, caplog) -> None:
        config = PipelineConfig()
        config.opentargets_data_version = "26.06"

        with caplog.at_level(logging.WARNING):
            opentargets._warn_on_version_drift("26.06", config)

        assert caplog.text == ""


class TestFetchTargetPaths:
    async def test_a_failed_target_query_is_a_transient_miss(self, mocker) -> None:
        mocker.patch(
            "pipeline.opentargets_fetch.resolve_target",
            AsyncMock(return_value=opentargets._Resolution("ENSG00000166033")),
        )
        mocker.patch(
            "pipeline.opentargets_fetch.graphql", AsyncMock(return_value=None)
        )

        assert (
            await fetch_opentargets_target("HTRA1", data_version="26.06") is None
        )

    async def test_a_failed_search_is_a_transient_miss_not_an_empty_gene(
        self, mocker
    ) -> None:
        """The bug the _Resolution wrapper exists for.

        resolve_target returned None for a timeout, a 5xx, a JSON error and the
        GraphQL errors array alike, and this function turned all of them into a
        non-None empty target -- so the sync wrote a 30-day zero-count status
        after deleting the gene's rows, and reported success. One outage during
        a run wiped 3,096 live rows across 61 genes.
        """
        mocker.patch(
            "pipeline.opentargets_fetch.resolve_target", AsyncMock(return_value=None)
        )
        target_query = mocker.patch(
            "pipeline.opentargets_fetch.graphql", AsyncMock()
        )

        assert await fetch_opentargets_target("HTRA1", data_version="26.06") is None
        target_query.assert_not_awaited()

    async def test_a_resolved_target_parses_into_rows(self, mocker) -> None:
        """The caller supplying data_version skips the per-gene meta query."""
        mocker.patch(
            "pipeline.opentargets_fetch.resolve_target",
            AsyncMock(return_value=opentargets._Resolution("ENSG00000166033")),
        )
        meta = mocker.patch(
            "pipeline.opentargets_fetch.fetch_data_version", AsyncMock()
        )
        mocker.patch(
            "pipeline.opentargets_fetch.graphql",
            AsyncMock(
                return_value={
                    "target": {
                        "id": "ENSG00000166033",
                        "approvedName": "HtrA serine peptidase 1",
                        "biotype": "protein_coding",
                    }
                }
            ),
        )

        target = await fetch_opentargets_target("HTRA1", data_version="26.06")

        assert target is not None
        assert target.ensembl_id == "ENSG00000166033"
        assert [r.object_id for r in target.rows] == ["Ensembl:ENSG00000166033"]
        meta.assert_not_awaited()


class TestModuleLifecycle:
    def test_the_cache_lock_is_created_once(self) -> None:
        assert opentargets._get_cache_lock() is opentargets._get_cache_lock()

    def test_the_semaphore_falls_back_to_the_default_config(self) -> None:
        semaphore = opentargets._get_opentargets_semaphore()
        assert semaphore is opentargets._get_opentargets_semaphore()

    async def test_closing_the_client_is_safe(self) -> None:
        await close_opentargets_client()

    def test_clearing_the_cache_empties_it(self) -> None:
        opentargets._target_cache["HTRA1"] = None
        # A real Task is not needed to prove clear() empties the dict.
        opentargets._in_flight["HTRA1"] = cast(Any, None)

        clear_opentargets_cache()

        assert opentargets._target_cache == OrderedDict()
        assert opentargets._in_flight == {}


class TestSyncOpenTargetsAnnotations:
    async def test_a_fresh_cache_skips_the_fetch(self, mocker) -> None:
        mocker.patch(
            "pipeline.database.get_annotation_statuses",
            AsyncMock(
                return_value={"HTRA1": {"row_count": 40, "source_version": "26.06"}}
            ),
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )

        result = await sync_opentargets_annotations(["HTRA1"])

        assert result.cached == 1
        assert result.fetched == 0
        replace.assert_not_awaited()

    async def test_the_meta_query_runs_once_for_the_whole_run(
        self, mocker, gene_aliases
    ) -> None:
        """One round trip per sync, not 63, and one drift warning, not 63."""
        from pipeline.opentargets_fetch import OpenTargetsTarget

        mocker.patch(
            "pipeline.database.get_annotation_statuses", AsyncMock(return_value={})
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=1)
        )
        meta = mocker.patch(
            "pipeline.opentargets_fetch.fetch_data_version",
            AsyncMock(return_value="26.06"),
        )
        row = AnnotationRow(
            gene_symbol="HTRA1",
            source="opentargets",
            relation="identity",
            group_key="",
            object_id="Ensembl:ENSG00000166033",
            object_label="HtrA serine peptidase 1",
            qualifier="protein_coding",
            score=None,
            evidence_count=None,
            source_version="26.06",
        )
        mocker.patch(
            "pipeline.opentargets_fetch.fetch_opentargets_target",
            AsyncMock(
                side_effect=[
                    OpenTargetsTarget(
                        gene_symbol="HTRA1",
                        ensembl_id="ENSG00000166033",
                        rows=(row,),
                        data_version="26.06",
                    ),
                    # A curated label (cSVD's COL4A1/2) is not a gene symbol,
                    # so it is queried as its member symbols -- two calls,
                    # one status row. An unresolvable symbol is a finding,
                    # not a failure.
                    OpenTargetsTarget(
                        gene_symbol="GENEA",
                        ensembl_id=None,
                        rows=(),
                        data_version="26.06",
                    ),
                    OpenTargetsTarget(
                        gene_symbol="GENEB",
                        ensembl_id=None,
                        rows=(),
                        data_version="26.06",
                    ),
                    None,
                ]
            ),
        )

        result = await sync_opentargets_annotations(["HTRA1", "GENEA/B", "FOXF2"])

        assert meta.await_count == 1
        rows, statuses = replace.await_args.args
        assert [r.object_id for r in rows] == ["Ensembl:ENSG00000166033"]
        assert [(s.gene_symbol, s.row_count) for s in statuses] == [
            ("HTRA1", 1),
            ("GENEA/B", 0),
        ]
        assert statuses[0].source_version == "26.06"
        assert result.fetched == 2
        assert result.failed == 1

    async def test_a_failed_meta_query_is_not_retried_per_gene(self, mocker) -> None:
        """The sync passes its result through even when that result is None.

        A ``None`` default on fetch_opentargets_target could not tell "not
        resolved yet" from "resolved, and it failed", so one failed meta query
        became 63 more -- each outside single_flight_get and its semaphore.
        """
        mocker.patch(
            "pipeline.database.get_annotation_statuses", AsyncMock(return_value={})
        )
        mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )
        meta = mocker.patch(
            "pipeline.opentargets_fetch.fetch_data_version",
            AsyncMock(return_value=None),
        )
        mocker.patch(
            "pipeline.opentargets_fetch.resolve_target",
            AsyncMock(return_value=opentargets._Resolution(None)),
        )

        result = await sync_opentargets_annotations(["HTRA1", "NOTCH3", "FOXF2"])

        assert meta.await_count == 1
        assert result.fetched == 3

    async def test_a_run_where_every_symbol_resolves_logs_no_finding(
        self, mocker
    ) -> None:
        from pipeline.opentargets_fetch import OpenTargetsTarget

        mocker.patch(
            "pipeline.database.get_annotation_statuses", AsyncMock(return_value={})
        )
        mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )
        mocker.patch(
            "pipeline.opentargets_fetch.fetch_data_version",
            AsyncMock(return_value="26.06"),
        )
        mocker.patch(
            "pipeline.opentargets_fetch.fetch_opentargets_target",
            AsyncMock(
                return_value=OpenTargetsTarget(
                    gene_symbol="HTRA1",
                    ensembl_id="ENSG00000166033",
                    rows=(),
                    data_version="26.06",
                )
            ),
        )

        result = await sync_opentargets_annotations(["HTRA1"])

        assert result.fetched == 1
        assert result.failed == 0
