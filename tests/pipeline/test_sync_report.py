"""Tests for pipeline.sync_report -- the refresh record.

The record exists so the upstreams only the syncs touch -- ClinVar,
Orphadata, Open Targets, UniProt, ClinicalTrials.gov -- reach the About
page at all. Its status rule is its own rather than `derive_status`'s,
and that is the thing most worth pinning: `derive_status([])` returns
`completed`, so a step-less report would publish a green badge over a
refresh that failed outright.
"""

import pytest

from pipeline.api_telemetry import ApiServiceRecord
from pipeline.cache_utils import SyncResult
from pipeline.external_data_sync import AnnotationSyncResult
from pipeline.main import _result_summary
from pipeline.run_report import DETAIL_CAP
from pipeline.steps import SYNC_MODES
from pipeline.sync_report import (
    build_sources,
    build_sync_report,
    derive_sync_status,
)

_APIS = [
    ApiServiceRecord(
        service="opentargets",
        label="Open Targets",
        endpoint="/api/v4/graphql",
        method="POST",
        calls=63,
        ok=63,
    )
]


def _summary(status: str = "ok", **overrides) -> dict:
    summary = {
        "name": "annotation_sync",
        "status": status,
        "metrics": {},
        "errors": [],
    }
    summary.update(overrides)
    return summary


def _build(**overrides):
    return build_sync_report(
        _summary(**overrides),
        mode=overrides.pop("mode", "annotation_sync"),
        apis=_APIS,
        run_timestamp="2026-09-02T03:00:00Z",
        duration_seconds=91.23456789,
    )


class TestDeriveSyncStatus:
    def test_a_clean_refresh_is_completed(self) -> None:
        assert derive_sync_status("ok", build_sources("annotation_sync", {}), []) == (
            "completed"
        )

    def test_a_per_source_failure_is_a_warning_not_a_failure(self) -> None:
        # The sync carried on and wrote what it could, which is the same
        # reasoning that makes a run with rejected genes amber, not red.
        sources = build_sources("annotation_sync", {"clinvar_failed": 3})
        assert derive_sync_status("ok", sources, []) == "completed_with_warnings"

    def test_a_listed_error_is_a_warning_not_a_failure(self) -> None:
        # Every sync appends one error string per gene, ORPHAcode or study
        # it could not fetch, so reading `failed` off a non-empty list
        # painted every real refresh red and left the amber branch above
        # unreachable. The error still has to be seen, so it is amber.
        sources = build_sources("annotation_sync", {})
        assert derive_sync_status("ok", sources, ["boom"]) == (
            "completed_with_warnings"
        )

    def test_a_failed_summary_is_a_failure_even_with_no_errors_listed(self) -> None:
        # _failure_summary reports status="failed" with the exception in
        # errors, but a pipeline that sets one without the other must not
        # publish green.
        assert derive_sync_status("failed", [], []) == "failed"


class TestTheRefreshStatusEndToEnd:
    """`_result_summary` -> `build_sync_report`, the path a real refresh takes."""

    @staticmethod
    def _report(result, mode: str = "annotation_sync"):
        return build_sync_report(
            _result_summary(mode, result),
            mode=mode,
            apis=[],
            run_timestamp="2026-09-02T03:00:00Z",
            duration_seconds=1.0,
        )

    def test_one_failed_gene_is_amber_not_red(self) -> None:
        # ClinVar timing out on 1 of 63 genes published a red badge over a
        # refresh that wrote the other 62, and exited the process 1.
        report = self._report(
            AnnotationSyncResult(
                clinvar_fetched=62,
                clinvar_failed=1,
                errors=["ClinVar fetch failed: NOTCH3"],
            )
        )

        assert report.status == "completed_with_warnings"
        assert report.errors.items == ["ClinVar fetch failed: NOTCH3"]
        clinvar = next(s for s in report.sources if s.key == "clinvar")
        assert (clinvar.fetched, clinvar.failed) == (62, 1)

    def test_a_clean_refresh_is_still_green(self) -> None:
        assert self._report(AnnotationSyncResult(clinvar_fetched=63)).status == (
            "completed"
        )

    def test_a_sync_that_stopped_is_red(self) -> None:
        # The 3600 s timeout: the sources after the one that hung were
        # never consulted, so this is not "wrote what it could".
        report = self._report(
            AnnotationSyncResult(
                clinvar_fetched=12,
                errors=["Annotation sync timed out after 3600s"],
                aborted=True,
            )
        )

        assert report.status == "failed"

    def test_a_trials_refresh_takes_the_same_two_branches(self) -> None:
        amber = self._report(
            SyncResult(fetched=5, cached=4, failed=1, errors=["CTG term: boom"]),
            mode="clinical_trials",
        )
        red = self._report(
            SyncResult(fetched=5, failed=5, errors=["CTG upsert: boom"], aborted=True),
            mode="clinical_trials",
        )

        assert amber.status == "completed_with_warnings"
        assert red.status == "failed"


class TestBuildSources:
    def test_each_mode_names_the_upstreams_it_consults(self) -> None:
        assert [s.label for s in build_sources("clinical_trials", {})] == [
            "ClinicalTrials.gov"
        ]
        assert [s.key for s in build_sources("external_sync", {})] == [
            "ncbi_gene",
            "uniprot",
            "pubmed_citations",
        ]
        assert [s.key for s in build_sources("annotation_sync", {})] == [
            "clinvar",
            "orphadata",
            "opentargets",
            "opentargets_drugs",
        ]

    @pytest.mark.parametrize("mode", SYNC_MODES)
    def test_every_declared_sync_mode_has_sources(self, mode: str) -> None:
        assert build_sources(mode, {})

    def test_counts_are_read_off_the_metrics_the_sync_reported(self) -> None:
        sources = build_sources(
            "external_sync",
            {"uniprot_fetched": 7, "uniprot_cached": 56, "uniprot_failed": 1},
        )
        uniprot = next(s for s in sources if s.key == "uniprot")
        assert (uniprot.fetched, uniprot.cached, uniprot.failed) == (7, 56, 1)

    def test_the_drug_records_read_their_own_metric_name(self) -> None:
        # `drugs_written`, not `drugs_fetched`: the three pipelines do not
        # share one metric convention, so the names are declared rather
        # than derived. A rule would read this row as a silent zero.
        sources = build_sources("annotation_sync", {"drugs_written": 41})
        drugs = next(s for s in sources if s.key == "opentargets_drugs")
        assert drugs.fetched == 41

    def test_the_drug_records_are_never_cached(self) -> None:
        # One uncached GraphQL search per drug on every run, so publishing
        # the write count in `cached` told a reader the mechanisms came
        # from cache beside an API row counting the POSTs that fetched them.
        sources = build_sources("annotation_sync", {"drugs_written": 41})
        drugs = next(s for s in sources if s.key == "opentargets_drugs")
        assert drugs.cached == 0

    def test_a_missing_metric_is_zero_not_a_crash(self) -> None:
        sources = build_sources("annotation_sync", {"clinvar_fetched": "not a number"})
        clinvar = next(s for s in sources if s.key == "clinvar")
        assert clinvar.fetched == 0


class TestBuildSyncReport:
    def test_the_api_rows_are_the_recorders_verbatim(self) -> None:
        report = _build()
        assert [row.label for row in report.apis] == ["Open Targets"]
        assert report.apis[0].calls == 63

    def test_the_duration_is_rounded_for_a_byte_gated_file(self) -> None:
        # A raw monotonic delta serialises as 91.23456789, which is noise
        # in a file a human reviews in `git diff`.
        assert _build().duration_seconds == 91.235

    def test_errors_are_capped_and_counted(self) -> None:
        report = _build(errors=[f"error {n}" for n in range(DETAIL_CAP + 5)])
        assert report.errors.total == DETAIL_CAP + 5
        assert report.errors.shown == DETAIL_CAP
        assert report.errors.truncated

    def test_the_wire_document_is_camel_case(self) -> None:
        wire = _build().to_wire()
        assert wire["runTimestamp"] == "2026-09-02T03:00:00Z"
        assert wire["durationSeconds"] == 91.235
        assert wire["apis"][0]["notFound"] == 0
