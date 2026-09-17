"""ClinVar monogenic-disease annotations."""

import asyncio
import json
import logging
from collections import OrderedDict
from typing import Any, cast
from unittest.mock import AsyncMock

import httpx
import pytest

import pipeline.clinvar_fetch as clinvar
from pipeline.clinvar_fetch import (
    _aggregate_records,
    clear_clinvar_cache,
    close_clinvar_client,
    fetch_clinvar_diseases,
    sync_clinvar_annotations,
)


def _record(
    genes: list[str],
    trait_name: str,
    xrefs: list[tuple[str, str]],
    description: str = "Pathogenic",
    obj_type: str = "single nucleotide variant",
    span: int | None = None,
) -> dict[str, Any]:
    """One esummary record in the shape the live API returns.

    ``span`` places the variant on a chromosome ``span`` bases wide. Left
    unset the record carries no ``variation_loc``, which is how most of
    these fixtures read and what ``_record_span`` treats as unplaced.
    """
    variation: dict[str, Any] = {"variant_type": obj_type}
    if span is not None:
        variation["variation_loc"] = [
            {"start": "1000000", "stop": str(1000000 + span)}
        ]
    return {
        "obj_type": obj_type,
        "variation_set": [variation],
        "genes": [{"symbol": s, "geneid": "1"} for s in genes],
        "germline_classification": {
            "description": description,
            "trait_set": [
                {
                    "trait_name": trait_name,
                    "trait_xrefs": [
                        {"db_source": s, "db_id": i} for s, i in xrefs
                    ],
                }
            ],
        },
    }


_CARASIL_XREFS = [
    ("Orphanet", "199354"),
    ("MedGen", "C6022615"),
    ("MONDO", "MONDO:0010829"),
    ("OMIM", "600142"),
]


class TestAggregateRecords:
    def test_a_span_naming_hundreds_of_genes_is_dropped(self) -> None:
        """The first live hit for HTRA1 is a 32-Mb CNV listing 724 genes."""
        records = [
            _record(
                ["HTRA1", *[f"GENE{i}" for i in range(723)]],
                "Distal 10q deletion syndrome",
                [("Orphanet", "96148"), ("MONDO", "MONDO:0012315")],
            )
        ]
        result = _aggregate_records("HTRA1", records)
        assert result.diseases == ()

    def test_a_copy_number_record_is_dropped_however_few_genes_it_names(
        self,
    ) -> None:
        """Its traits are the contiguous-gene syndrome's, not the gene's."""
        records = [
            _record(
                ["ABCC2", "ABLIM1", "HTRA1"],
                "Distal 10q deletion syndrome",
                [("Orphanet", "96148"), ("MONDO", "MONDO:0012315")],
                obj_type="copy number loss",
            )
        ]
        result = _aggregate_records("HTRA1", records)
        assert result.diseases == ()

    def test_an_overlapping_readthrough_does_not_drop_the_record(self) -> None:
        """None of TREX1's 61 pathogenic records names TREX1 alone.

        ClinVar files every locus a variant overlaps, so reading a multi-gene
        record as a copy-number event published TREX1 -- RVCL-S included --
        with no disease at all.
        """
        records = [
            _record(
                ["ATRIP", "ATRIP-TREX1", "TREX1"],
                "Aicardi-Goutieres syndrome 1",
                [("Orphanet", "51"), ("OMIM", "225750")],
            )
        ]
        result = _aggregate_records("TREX1", records)
        assert [d.trait_name for d in result.diseases] == [
            "Aicardi-Goutieres syndrome 1"
        ]

    def test_an_antisense_neighbour_does_not_drop_the_record(self) -> None:
        """TIMP3 is filed under ('SYN3', 'TIMP3'); Sorsby was lost with it."""
        records = [
            _record(
                ["SYN3", "TIMP3"],
                "Sorsby fundus dystrophy",
                [("Orphanet", "59181"), ("OMIM", "136900")],
            )
        ]
        result = _aggregate_records("TIMP3", records)
        assert [d.trait_name for d in result.diseases] == ["Sorsby fundus dystrophy"]

    def test_a_wide_multi_gene_deletion_is_dropped_though_it_is_not_typed_cnv(
        self,
    ) -> None:
        """FDFT1's 120-kb 8p23.1 deletion published its disease as CTSB's.

        It is typed ``Deletion`` rather than ``copy number loss`` and names
        two genes, so neither the type rule nor the gene-count rule sees it;
        CTSB is only the neighbouring locus the deletion removes.
        """
        records = [
            _record(
                ["FDFT1", "CTSB"],
                "Squalene synthase deficiency",
                [("MONDO", "MONDO:0032566"), ("OMIM", "618156")],
                obj_type="Deletion",
                span=119_983,
            )
        ]
        result = _aggregate_records("CTSB", records)
        assert result.diseases == ()

    def test_a_small_overlapping_deletion_is_kept(self) -> None:
        """The span rule must not cost a readthrough its record.

        TREX1's overlaps are ordinary variants: the widest measured across
        all 63 genes is 152 bp, against 40,877 for the narrowest span event.
        """
        records = [
            _record(
                ["ATRIP", "ATRIP-TREX1", "TREX1"],
                "Aicardi-Goutieres syndrome 1",
                [("Orphanet", "51"), ("OMIM", "225750")],
                obj_type="Deletion",
                span=22,
            )
        ]
        result = _aggregate_records("TREX1", records)
        assert [d.trait_name for d in result.diseases] == [
            "Aicardi-Goutieres syndrome 1"
        ]

    def test_a_wide_single_gene_deletion_is_still_kept(self) -> None:
        """A whole-gene deletion is megabases wide and is the gene's own."""
        records = [
            _record(
                ["HTRA1"],
                "CARASIL syndrome",
                _CARASIL_XREFS,
                obj_type="Deletion",
                span=2_000_000,
            )
        ]
        result = _aggregate_records("HTRA1", records)
        assert [d.trait_name for d in result.diseases] == ["CARASIL syndrome"]

    def test_an_unparseable_coordinate_does_not_drop_the_record(self) -> None:
        """A missing or malformed span is ClinVar's omission, not a span.

        `variation_loc` carries empty strings for the placement fields on
        records ClinVar has not placed, and the span rule must not read that
        as evidence either way -- the other three rules still decide.
        """
        record = _record(
            ["ATRIP", "ATRIP-TREX1", "TREX1"],
            "Aicardi-Goutieres syndrome 1",
            [("Orphanet", "51"), ("OMIM", "225750")],
            obj_type="Deletion",
        )
        record["variation_set"][0]["variation_loc"] = [
            {"start": "", "stop": ""},
            {"start": "not a number", "stop": "12"},
            {"start": None, "stop": None},
        ]
        result = _aggregate_records("TREX1", [record])
        assert [d.trait_name for d in result.diseases] == [
            "Aicardi-Goutieres syndrome 1"
        ]

    def test_a_multi_gene_record_not_naming_the_gene_is_dropped(self) -> None:
        """A neighbour's record must not be attributed to the gene searched."""
        records = [
            _record(
                ["ATRIP", "ATRIP-TREX1"],
                "Aicardi-Goutieres syndrome 1",
                [("Orphanet", "51"), ("OMIM", "225750")],
            )
        ]
        result = _aggregate_records("TREX1", records)
        assert result.diseases == ()

    def test_a_single_gene_record_is_kept_under_an_obsolete_symbol(self) -> None:
        """ClinVar answers an obsolete symbol under the current one.

        The symbol check applies to multi-gene records only, so a rename does
        not cost the gene its diseases -- ``C6orf195`` is ``LINC01600`` now.
        """
        records = [_record(["LINC01600"], "CARASIL syndrome", _CARASIL_XREFS)]
        result = _aggregate_records("C6orf195", records)
        assert [d.trait_name for d in result.diseases] == ["CARASIL syndrome"]

    def test_a_single_gene_copy_number_record_is_kept(self) -> None:
        """One gene deleted is a whole-gene deletion, not a CNV syndrome."""
        records = [
            _record(
                ["HTRA1"],
                "CARASIL syndrome",
                _CARASIL_XREFS,
                obj_type="copy number loss",
            )
        ]
        result = _aggregate_records("HTRA1", records)
        assert [d.trait_name for d in result.diseases] == ["CARASIL syndrome"]

    def test_a_record_naming_no_gene_is_dropped(self) -> None:
        records = [_record([], "CARASIL syndrome", _CARASIL_XREFS)]
        result = _aggregate_records("HTRA1", records)
        assert result.diseases == ()

    def test_a_placeholder_trait_is_dropped(self) -> None:
        """"not provided" is the most frequent trait name in the real data."""
        records = [
            _record(["HTRA1"], "not provided", [("MedGen", "C3661900")]),
            _record(["HTRA1"], "See cases", []),
            _record(["HTRA1"], "not specified", [("MedGen", "CN169374")]),
        ]
        result = _aggregate_records("HTRA1", records)
        assert result.diseases == ()

    def test_a_real_disease_survives_both_filters(self) -> None:
        records = [_record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS)]
        result = _aggregate_records("HTRA1", records)
        assert len(result.diseases) == 1
        disease = result.diseases[0]
        assert disease.trait_name == "CARASIL syndrome"
        assert disease.group_key == "MONDO:0010829"
        assert disease.xrefs == (
            "MONDO:0010829",
            "MedGen:C6022615",
            "OMIM:600142",
            "Orphanet:199354",
        )
        assert disease.record_count == 1

    def test_diseases_rank_by_supporting_record_count(self) -> None:
        records = [
            _record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS),
            *[
                _record(
                    ["HTRA1"],
                    "Cerebral arteriopathy, autosomal dominant, type 2",
                    [("MONDO", "MONDO:0014768"), ("OMIM", "616779")],
                )
                for _ in range(3)
            ],
        ]
        result = _aggregate_records("HTRA1", records)
        assert [d.record_count for d in result.diseases] == [3, 1]
        assert result.diseases[0].group_key == "MONDO:0014768"

    def test_ties_break_on_trait_name_so_the_order_is_reproducible(self) -> None:
        records = [
            _record(["HTRA1"], "Zeta disease", [("OMIM", "600001")]),
            _record(["HTRA1"], "Alpha disease", [("OMIM", "600002")]),
        ]
        result = _aggregate_records("HTRA1", records)
        assert [d.trait_name for d in result.diseases] == [
            "Alpha disease",
            "Zeta disease",
        ]

    def test_the_most_common_classification_wins(self) -> None:
        records = [
            _record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS, "Pathogenic"),
            _record(
                ["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS,
                "Pathogenic/Likely pathogenic",
            ),
            _record(
                ["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS,
                "Pathogenic/Likely pathogenic",
            ),
        ]
        result = _aggregate_records("HTRA1", records)
        assert result.diseases[0].classification == "Pathogenic/Likely pathogenic"

    def test_one_row_per_xref_all_sharing_a_group_key(self) -> None:
        records = [_record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS)]
        result = _aggregate_records("HTRA1", records)
        rows = result.to_annotation_rows()
        assert len(rows) == 4
        assert {r.group_key for r in rows} == {"MONDO:0010829"}
        assert {r.object_id for r in rows} == {
            "MONDO:0010829",
            "MedGen:C6022615",
            "OMIM:600142",
            "Orphanet:199354",
        }
        assert all(r.source == "clinvar" for r in rows)
        assert all(r.relation == "disease" for r in rows)
        assert all(r.object_label == "CARASIL syndrome" for r in rows)
        assert all(r.evidence_count == 1 for r in rows)


class TestFetchClinVarDiseases:
    async def test_an_empty_search_yields_no_diseases_and_no_summary_call(
        self, mocker
    ) -> None:
        search = httpx.Response(
            200, text=json.dumps({"esearchresult": {"count": "0", "idlist": []}})
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        mock_client.post = AsyncMock()
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        result = await fetch_clinvar_diseases("COL4A1/2")

        assert result is not None
        assert result.diseases == ()
        mock_client.post.assert_not_awaited()

    async def test_a_non_200_search_is_a_transient_miss(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=httpx.Response(500))
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_clinvar_diseases("HTRA1") is None

    async def test_a_timeout_is_a_transient_miss(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.TimeoutException("slow"))
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_clinvar_diseases("HTRA1") is None

    async def test_the_api_key_reaches_the_search_params(self, mocker) -> None:
        mocker.patch.dict("os.environ", {"NCBI_API_KEY": "test-key-123"})
        search = httpx.Response(
            200, text=json.dumps({"esearchresult": {"count": "0", "idlist": []}})
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        await fetch_clinvar_diseases("HTRA1")

        params = mock_client.get.call_args.kwargs["params"]
        assert params["api_key"] == "test-key-123"
        assert params["db"] == "clinvar"

    async def test_uids_are_summarised_by_post_in_batches(self, mocker) -> None:
        """A 248-record gene exceeds any sane URL length, so esummary is POSTed."""
        uids = [str(n) for n in range(450)]
        search = httpx.Response(
            200,
            text=json.dumps({"esearchresult": {"count": "450", "idlist": uids}}),
        )
        summary = httpx.Response(
            200, text=json.dumps({"result": {"uids": []}})
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        mock_client.post = AsyncMock(return_value=summary)
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        result = await fetch_clinvar_diseases("NOTCH3")

        assert result is not None
        assert mock_client.post.await_count == 3  # 200 + 200 + 50

    async def test_exceeding_the_cap_logs_that_record_counts_are_a_floor(
        self, mocker, caplog
    ) -> None:
        from pipeline.config import PipelineConfig

        config = PipelineConfig()
        config.clinvar_max_records = 2
        uids = ["1", "2"]
        search = httpx.Response(
            200,
            text=json.dumps({"esearchresult": {"count": "500", "idlist": uids}}),
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        mock_client.post = AsyncMock(
            return_value=httpx.Response(200, text=json.dumps({"result": {"uids": []}}))
        )
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        with caplog.at_level(logging.INFO, logger="pipeline.clinvar_fetch"):
            result = await fetch_clinvar_diseases("NOTCH3", config=config)

        assert result is not None
        assert (
            "ClinVar returned 500 records for NOTCH3, capped at 2 -- "
            "record counts are a floor, not a total"
        ) in caplog.text


class TestSyncClinVarAnnotations:
    async def test_a_fresh_cache_skips_the_fetch(self, mocker) -> None:
        mocker.patch(
            "pipeline.database.get_annotation_statuses",
            AsyncMock(return_value={"HTRA1": {"row_count": 4, "source_version": None}}),
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )
        fetch = mocker.patch("pipeline.clinvar_fetch.fetch_clinvar_diseases")

        result = await sync_clinvar_annotations(["HTRA1"])

        assert result.cached == 1
        assert result.fetched == 0
        fetch.assert_not_called()
        replace.assert_not_awaited()

    async def test_a_gene_with_no_diseases_still_writes_a_status_row(
        self, mocker
    ) -> None:
        """The negative cache: zero rows and never-fetched must be distinct."""
        from pipeline.clinvar_fetch import ClinVarGeneResult

        mocker.patch(
            "pipeline.database.get_annotation_statuses", AsyncMock(return_value={})
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )
        mocker.patch(
            "pipeline.clinvar_fetch.fetch_clinvar_diseases",
            AsyncMock(
                return_value=ClinVarGeneResult(
                    gene_symbol="C6orf195",
                    diseases=(),
                )
            ),
        )

        result = await sync_clinvar_annotations(["C6orf195"])

        statuses = replace.await_args.args[1]
        assert [s.gene_symbol for s in statuses] == ["C6orf195"]
        assert statuses[0].row_count == 0
        assert result.failed == 0

    async def test_a_transient_failure_writes_no_status_row(self, mocker) -> None:
        """A 500 must not be cached as "this gene has no diseases" for 30 days."""
        mocker.patch(
            "pipeline.database.get_annotation_statuses", AsyncMock(return_value={})
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=0)
        )
        mocker.patch(
            "pipeline.clinvar_fetch.fetch_clinvar_diseases",
            AsyncMock(return_value=None),
        )

        result = await sync_clinvar_annotations(["HTRA1"])

        assert result.failed == 1
        assert replace.await_args.args[1] == []


class TestRecordShapesThatCarryNoClassification:
    def test_a_trait_with_xrefs_but_no_name_is_dropped(self) -> None:
        record = _record(["HTRA1"], "", [("OMIM", "600142")])
        result = _aggregate_records("HTRA1", [record])
        assert result.diseases == ()

    def test_a_record_with_no_description_leaves_classification_none(self) -> None:
        """ClinVar omits the description on some records."""
        record = _record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS)
        record["germline_classification"]["description"] = ""

        result = _aggregate_records("HTRA1", [record])

        assert result.diseases[0].classification is None


class TestTransportFailureModes:
    async def test_a_request_error_on_search_is_a_transient_miss(self, mocker) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=httpx.ConnectError("refused"))
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_clinvar_diseases("HTRA1") is None

    async def test_a_search_response_missing_its_envelope_is_a_transient_miss(
        self, mocker
    ) -> None:
        """A 200 carrying no esearchresult is malformed, not an empty gene."""
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            return_value=httpx.Response(200, text=json.dumps({"header": {}}))
        )
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_clinvar_diseases("HTRA1") is None

    @pytest.mark.parametrize(
        "failure",
        [
            httpx.Response(500),
            httpx.TimeoutException("slow"),
            httpx.ConnectError("refused"),
            httpx.Response(200, text="not json"),
        ],
        ids=["non-200", "timeout", "request-error", "unparseable"],
    )
    async def test_a_failed_summary_batch_fails_the_gene(
        self, mocker, failure
    ) -> None:
        """A partial answer must never be cached as a complete one.

        NOTCH3's 248 uids are two batches. Skipping one published a truncated
        disease set and skipping both published none -- either way as a fresh
        status row that suppressed the retry for DB_CACHE_TTL_DAYS, which is
        exactly what sync_clinvar_annotations' docstring says never happens.
        """
        search = httpx.Response(
            200,
            text=json.dumps({"esearchresult": {"count": "1", "idlist": ["1"]}}),
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        if isinstance(failure, httpx.Response):
            mock_client.post = AsyncMock(return_value=failure)
        else:
            mock_client.post = AsyncMock(side_effect=failure)
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_clinvar_diseases("HTRA1") is None

    async def test_a_summarised_record_reaches_the_aggregator(self, mocker) -> None:
        """The whole path, so the uid-to-record indirection is exercised."""
        search = httpx.Response(
            200,
            text=json.dumps({"esearchresult": {"count": "2", "idlist": ["1", "2"]}}),
        )
        summary = httpx.Response(
            200,
            text=json.dumps(
                {
                    "result": {
                        "uids": ["1", "2"],
                        "1": _record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS),
                        # ClinVar returns a bare error string for a withdrawn uid.
                        "2": "record removed",
                    }
                }
            ),
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        mock_client.post = AsyncMock(return_value=summary)
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        result = await fetch_clinvar_diseases("HTRA1")

        assert result is not None
        assert [d.trait_name for d in result.diseases] == ["CARASIL syndrome"]
        assert result.diseases[0].record_count == 1

    async def test_a_per_record_error_dict_fails_the_gene(self, mocker) -> None:
        """NCBI reports a failed uid as a dict inside a 200, not a string.

        Live-probed: ``{"uid": "...", "error": "cannot get document summary"}``.
        It has no ``genes`` key, so _describes_gene drops it as though it were
        a region event and the gene's status row would be written with fewer
        diseases -- a partial answer cached as a complete one for
        DB_CACHE_TTL_DAYS.
        """
        search = httpx.Response(
            200,
            text=json.dumps({"esearchresult": {"count": "2", "idlist": ["1", "2"]}}),
        )
        summary = httpx.Response(
            200,
            text=json.dumps(
                {
                    "result": {
                        "uids": ["1", "2"],
                        "1": _record(["HTRA1"], "CARASIL syndrome", _CARASIL_XREFS),
                        "2": {"uid": "2", "error": "cannot get document summary"},
                    }
                }
            ),
        )
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=search)
        mock_client.post = AsyncMock(return_value=summary)
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_clinvar_diseases("HTRA1") is None


class TestAnUnparseableSearchPhrase:
    """esearch reports a phrase it could not parse in-band, as a 200.

    The body carries ``count: "0"`` and ``errorlist.phrasesnotfound``, so a
    property token that stopped parsing looks exactly like a gene with no
    pathogenic records -- and every gene would be negative-cached that way
    for DB_CACHE_TTL_DAYS.
    """

    @staticmethod
    def _search(phrases: list[str]) -> httpx.Response:
        return httpx.Response(
            200,
            text=json.dumps(
                {
                    "esearchresult": {
                        "count": "0",
                        "idlist": [],
                        "errorlist": {
                            "phrasesnotfound": phrases,
                            "fieldsnotfound": [],
                        },
                        "warninglist": {
                            "phrasesignored": [],
                            "quotedphrasenotfound": [],
                        },
                    }
                }
            ),
        )

    async def test_a_property_token_that_failed_to_parse_is_a_transient_miss(
        self, mocker, caplog
    ) -> None:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(
            return_value=self._search(['"clinsig pathogenic"[Properties]'])
        )
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_clinvar_diseases("HTRA1") is None
        assert "[Properties]" in caplog.text

    async def test_a_gene_term_alone_not_found_is_a_genuine_zero(
        self, mocker
    ) -> None:
        """COL4A1/2 is a curator label, not a symbol; ClinVar has no such gene."""
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=self._search(["COL4A1/2[gene]"]))
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        result = await fetch_clinvar_diseases("COL4A1/2")

        assert result is not None
        assert result.diseases == ()


class TestModuleLifecycle:
    def test_the_cache_lock_is_created_once(self) -> None:
        assert clinvar._get_cache_lock() is clinvar._get_cache_lock()

    def test_the_semaphore_falls_back_to_the_default_config(self) -> None:
        """Called with no config, it reads PipelineConfig's own default."""
        semaphore = clinvar._get_clinvar_semaphore()
        assert semaphore is clinvar._get_clinvar_semaphore()

    async def test_closing_the_client_is_safe(self) -> None:
        await close_clinvar_client()

    def test_clearing_the_cache_empties_it(self) -> None:
        clinvar._clinvar_cache["HTRA1"] = None
        # A real Task is not needed to prove clear() empties the dict.
        clinvar._in_flight["HTRA1"] = cast(Any, None)

        clear_clinvar_cache()

        assert clinvar._clinvar_cache == OrderedDict()
        assert clinvar._in_flight == {}


class TestSyncWritesRowsForAProductiveGene:
    async def test_a_gene_with_diseases_writes_its_rows_and_status(
        self, mocker
    ) -> None:
        from pipeline.clinvar_fetch import ClinVarDisease, ClinVarGeneResult

        mocker.patch(
            "pipeline.database.get_annotation_statuses", AsyncMock(return_value={})
        )
        replace = mocker.patch(
            "pipeline.database.replace_gene_annotations", AsyncMock(return_value=4)
        )
        mocker.patch(
            "pipeline.clinvar_fetch.fetch_clinvar_diseases",
            AsyncMock(
                return_value=ClinVarGeneResult(
                    gene_symbol="HTRA1",
                    diseases=(
                        ClinVarDisease(
                            trait_name="CARASIL syndrome",
                            group_key="MONDO:0010829",
                            xrefs=("MONDO:0010829", "OMIM:600142"),
                            classification="Pathogenic",
                            record_count=5,
                        ),
                    ),
                )
            ),
        )

        result = await sync_clinvar_annotations(["HTRA1"])

        rows, statuses = replace.await_args.args
        assert [r.object_id for r in rows] == ["MONDO:0010829", "OMIM:600142"]
        assert statuses[0].row_count == 2
        assert result.fetched == 1
        assert result.failed == 0


class TestRatePacing:
    """NCBI limits requests per second; the semaphore only limits concurrency.

    The first full 63-gene run issued every request inside half a second and
    NCBI answered 429 to 53 of them, so pacing is the fix and these pin it.
    """

    async def test_request_starts_are_spaced_by_the_configured_rate(
        self, monkeypatch
    ) -> None:
        from pipeline.config import PipelineConfig

        # The configured rate applies as such only with a key; see below.
        monkeypatch.setenv("NCBI_API_KEY", "test-key-123")
        config = PipelineConfig()
        config.clinvar_rate_limit = 4  # 0.25s apart

        loop = asyncio.get_running_loop()
        start = loop.time()
        await clinvar._throttle(config)
        await clinvar._throttle(config)
        await clinvar._throttle(config)
        elapsed = loop.time() - start

        # The first is free; the next two wait one interval each.
        assert elapsed >= 0.5

    async def test_without_an_api_key_the_pace_is_capped_at_three_a_second(
        self, monkeypatch, mocker, caplog
    ) -> None:
        """The configured 10/s assumes a key; get_ncbi_params adds one only
        when NCBI_API_KEY is set, and NCBI allows 3/s without it."""
        from pipeline.config import PipelineConfig

        monkeypatch.delenv("NCBI_API_KEY", raising=False)
        mocker.patch.object(clinvar, "_pace_logged", False)
        config = PipelineConfig()
        config.clinvar_rate_limit = 10

        loop = asyncio.get_running_loop()
        start = loop.time()
        with caplog.at_level(logging.INFO):
            await clinvar._throttle(config)
            await clinvar._throttle(config)
            await clinvar._throttle(config)
        elapsed = loop.time() - start

        # Two waits of a third of a second, not two of a tenth.
        assert elapsed >= 0.6
        assert "NCBI_API_KEY" in caplog.text

    async def test_with_an_api_key_the_configured_rate_applies(
        self, monkeypatch, mocker, caplog
    ) -> None:
        from pipeline.config import PipelineConfig

        monkeypatch.setenv("NCBI_API_KEY", "test-key-123")
        mocker.patch.object(clinvar, "_pace_logged", False)
        config = PipelineConfig()
        config.clinvar_rate_limit = 10

        loop = asyncio.get_running_loop()
        start = loop.time()
        with caplog.at_level(logging.INFO):
            await clinvar._throttle(config)
            await clinvar._throttle(config)
            await clinvar._throttle(config)
        elapsed = loop.time() - start

        assert elapsed < 0.5
        assert "NCBI_API_KEY" not in caplog.text

    def test_a_zero_rate_is_rejected_by_the_config(self, monkeypatch) -> None:
        """Semaphore(0) hangs every fetch until the one-hour outer timeout.

        The CT client's guard names exactly this failure; the annotation
        clients build their semaphores the same way.
        """
        from pipeline.config import PipelineConfig

        monkeypatch.setenv("PIPELINE_CLINVAR_RATE_LIMIT", "0")
        with pytest.raises(ValueError, match="clinvar_rate_limit must be >= 1"):
            PipelineConfig()

    async def test_a_429_is_retried_and_can_succeed(self, mocker) -> None:
        from pipeline.config import PipelineConfig

        mocker.patch.object(clinvar, "_RATE_LIMIT_BACKOFF", 0.0)
        responses = [httpx.Response(429), httpx.Response(200, text="{}")]

        async def send() -> httpx.Response:
            return responses.pop(0)

        result = await clinvar._send_throttled(send, PipelineConfig(), "esearch")

        assert result.status_code == 200

    async def test_a_persistent_429_is_returned_rather_than_retried_forever(
        self, mocker
    ) -> None:
        from pipeline.config import PipelineConfig

        mocker.patch.object(clinvar, "_RATE_LIMIT_BACKOFF", 0.0)
        sends = 0

        async def send() -> httpx.Response:
            nonlocal sends
            sends += 1
            return httpx.Response(429)

        result = await clinvar._send_throttled(send, PipelineConfig(), "esearch")

        assert result.status_code == 429
        assert sends == clinvar._RATE_LIMIT_RETRIES + 1

    async def test_a_rate_limited_search_is_a_transient_miss_not_an_empty_gene(
        self, mocker
    ) -> None:
        """The bug this pacing exists for: a 429 must never cache as "no disease"."""
        mocker.patch.object(clinvar, "_RATE_LIMIT_BACKOFF", 0.0)
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=httpx.Response(429))
        mocker.patch(
            "pipeline.clinvar_fetch._client_manager.get", return_value=mock_client
        )

        assert await fetch_clinvar_diseases("HTRA1") is None

    def test_the_rate_lock_is_created_once(self) -> None:
        assert clinvar._get_rate_lock() is clinvar._get_rate_lock()


class TestTraitsCollidingOnOneDiseaseGroup:
    """`by_trait` keys on trait name; group_key_for picks the best xref.

    The map is therefore not injective, and two colliding traits necessarily
    share the xref that produced the group_key -- so the UNIQUE constraint on
    (gene_symbol, source, relation, group_key, object_id) fires by
    construction and one row overwrites the other's label and evidence count.
    """

    def test_two_traits_under_one_group_merge_into_one_disease(self) -> None:
        records = [
            *[
                _record(["HTRA1"], "Alpha", [("OMIM", "600001"), ("MONDO", "0010829")])
                for _ in range(9)
            ],
            *[
                _record(["HTRA1"], "Beta", [("OMIM", "600002"), ("MONDO", "0010829")])
                for _ in range(2)
            ],
        ]

        result = _aggregate_records("HTRA1", records)

        assert len(result.diseases) == 1
        disease = result.diseases[0]
        # The better-evidenced name represents the group, and the evidence is
        # the sum -- not one trait's count with the other's label.
        assert disease.trait_name == "Alpha"
        assert disease.record_count == 11
        assert disease.xrefs == ("MONDO:0010829", "OMIM:600001", "OMIM:600002")

    def test_the_surviving_name_is_the_better_evidenced_one_either_order(
        self,
    ) -> None:
        """Insertion order must not decide which name wins."""
        few = [
            _record(["HTRA1"], "Zeta", [("OMIM", "600002"), ("MONDO", "0010829")])
        ]
        many = [
            _record(["HTRA1"], "Alpha", [("OMIM", "600001"), ("MONDO", "0010829")])
            for _ in range(3)
        ]

        forward = _aggregate_records("HTRA1", [*many, *few])
        reverse = _aggregate_records("HTRA1", [*few, *many])

        assert forward.diseases[0].trait_name == "Alpha"
        assert reverse.diseases[0].trait_name == "Alpha"

    def test_a_tie_breaks_alphabetically(self) -> None:
        records = [
            _record(["HTRA1"], "Zeta", [("OMIM", "600002"), ("MONDO", "0010829")]),
            _record(["HTRA1"], "Alpha", [("OMIM", "600001"), ("MONDO", "0010829")]),
        ]
        result = _aggregate_records("HTRA1", records)
        assert result.diseases[0].trait_name == "Alpha"

    def test_three_traits_elect_the_same_name_in_every_listing_order(self) -> None:
        """The comparison is against the owning name's own count, not the sum.

        Comparing a later trait against the group's running total means that
        once two traits have merged no third can win the name unless it
        outweighs both together -- so Alpha(3), Beta(3), Gamma(4) published
        "Alpha" when ClinVar listed them A, B, C and "Gamma" when it listed
        them C, B, A. The label then depended on the API's listing order.
        """
        import itertools

        alpha = [
            _record(["HTRA1"], "Alpha", [("OMIM", "600001"), ("MONDO", "0010829")])
            for _ in range(3)
        ]
        beta = [
            _record(["HTRA1"], "Beta", [("OMIM", "600002"), ("MONDO", "0010829")])
            for _ in range(3)
        ]
        gamma = [
            _record(["HTRA1"], "Gamma", [("OMIM", "600003"), ("MONDO", "0010829")])
            for _ in range(4)
        ]

        names = {
            _aggregate_records("HTRA1", [r for group in order for r in group])
            .diseases[0]
            .trait_name
            for order in itertools.permutations([alpha, beta, gamma])
        }

        assert names == {"Gamma"}
