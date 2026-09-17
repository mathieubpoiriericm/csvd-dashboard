"""Tests for pipeline.export.geocode -- CT.gov coordinates for the map.

The first four tests come straight from the plan (brief Step 1, verbatim,
except one assertion split across two lines to fit this repo's 88-column
limit -- unchanged logic). The rest were added to satisfy the task's two
pinned properties and the network-free constraint:

- Key order against the *committed* data/geocoded_trials.json, read from the
  file rather than hard-coded -- field-order divergence has bitten this plan
  before.
- Jitter determinism across independent runs (no RNG, no seed).
- Output order follows the requested nct_ids, not ClinicalTrials.gov's
  response order -- an unchanged trial set must regenerate byte-identical
  output, which a review round caught this module getting wrong.
- The write is atomic: a failure mid-write must not corrupt or truncate the
  previously committed file, and must leave no stray tempfile behind.
- Fail-closed behaviour of fetch_trial_locations: it must raise -- never
  silently shrink the map -- when ClinicalTrials.gov omits a requested trial
  or returns an HTTP error, and it must make no request at all for an empty
  ID list. The HTTP client manager is mocked throughout; no test touches
  the network.
"""

import asyncio
import json
import logging
import math
import stat
import sys
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from pipeline.export.geocode import (
    CTG_STUDIES_URL,
    fetch_trial_locations,
    jitter_duplicate_coordinates,
    main,
    parse_study_locations,
    run_geocode,
)

_REPO_ROOT = Path(__file__).resolve().parents[3]

_STUDY = {
    "protocolSection": {
        "identificationModule": {"nctId": "NCT05755997", "briefTitle": "CADASIL"},
        "statusModule": {"overallStatus": "ACTIVE_NOT_RECRUITING"},
        "contactsLocationsModule": {
            "locations": [
                {
                    "facility": "Motol University Hospital",
                    "city": "Prague",
                    "country": "Czechia",
                    "geoPoint": {"lat": 50.08804, "lon": 14.42076},
                },
                {"facility": "No Coordinates", "city": "Nowhere", "country": "X"},
            ]
        },
    }
}


def test_parse_uses_the_geopoint_the_api_already_returns() -> None:
    locations = parse_study_locations(_STUDY)
    assert len(locations) == 1
    assert locations[0] == {
        "nctId": "NCT05755997",
        "facilityName": "Motol University Hospital",
        "city": "Prague",
        "state": None,
        "country": "Czechia",
        "trialTitle": "CADASIL",
        "status": "ACTIVE_NOT_RECRUITING",
        "lat": 50.08804,
        "lon": 14.42076,
    }


def test_locations_without_coordinates_are_dropped_not_defaulted() -> None:
    locations = parse_study_locations(_STUDY)
    assert all(loc["facilityName"] != "No Coordinates" for loc in locations)


def test_a_dropped_location_is_counted_and_named(caplog) -> None:
    """Dropping silently is how a trial gets no marker and no explanation."""
    with caplog.at_level(logging.WARNING, logger="pipeline.export.geocode"):
        parse_study_locations(_STUDY)

    assert "NCT05755997" in caplog.text
    assert "1 facility location(s) carry no usable coordinates" in caplog.text


def test_a_study_whose_sites_all_map_says_nothing(caplog) -> None:
    study = {
        "protocolSection": {
            "identificationModule": {"nctId": "NCT00000009"},
            "contactsLocationsModule": {
                "locations": [{"facility": "Here", "geoPoint": {"lat": 1, "lon": 2}}]
            },
        }
    }

    with caplog.at_level(logging.WARNING, logger="pipeline.export.geocode"):
        assert len(parse_study_locations(study)) == 1

    assert caplog.text == ""


def test_out_of_range_coordinates_are_dropped() -> None:
    study = {
        "protocolSection": {
            "contactsLocationsModule": {
                "locations": [
                    {"facility": "North", "geoPoint": {"lat": 91, "lon": 0}},
                    {"facility": "East", "geoPoint": {"lat": 0, "lon": 181}},
                ]
            }
        }
    }

    assert parse_study_locations(study) == []


def test_jitter_fans_out_co_located_sites_deterministically() -> None:
    """CT.gov geoPoints are city-level, so same-city sites arrive identical."""
    same: list[dict[str, Any]] = [
        {"nctId": "A", "lat": 40.71427, "lon": -74.00597},
        {"nctId": "B", "lat": 40.71427, "lon": -74.00597},
        {"nctId": "C", "lat": 40.71427, "lon": -74.00597},
    ]
    out = jitter_duplicate_coordinates([dict(x) for x in same])
    coords = {(round(o["lat"], 6), round(o["lon"], 6)) for o in out}
    assert len(coords) == 3
    for original, moved in zip(same, out, strict=True):
        assert math.isclose(moved["lat"], original["lat"], abs_tol=0.01)
    # Deterministic: no RNG, no seed.
    assert jitter_duplicate_coordinates([dict(x) for x in same]) == out


def test_a_lone_location_is_not_moved() -> None:
    lone = [{"nctId": "A", "lat": 1.0, "lon": 2.0}]
    assert jitter_duplicate_coordinates([dict(x) for x in lone]) == lone


# ---------------------------------------------------------------------------
# Determinism, pinned independently of the fan-out test above.
# ---------------------------------------------------------------------------


def test_jitter_is_deterministic_across_independent_runs() -> None:
    """Regenerating from unchanged input must be byte-identical -- no RNG, no
    seed, just sin/cos over each group's index. Mirrors the real data: four
    NYC facilities and two Dallas facilities share one point apiece.
    """
    base = [
        {"nctId": "A1", "lat": 40.71427, "lon": -74.00597},
        {"nctId": "A2", "lat": 40.71427, "lon": -74.00597},
        {"nctId": "A3", "lat": 40.71427, "lon": -74.00597},
        {"nctId": "A4", "lat": 40.71427, "lon": -74.00597},
        {"nctId": "B1", "lat": 32.78306, "lon": -96.80667},
        {"nctId": "B2", "lat": 32.78306, "lon": -96.80667},
        {"nctId": "C1", "lat": 50.08804, "lon": 14.42076},
    ]
    first = jitter_duplicate_coordinates([dict(x) for x in base])
    second = jitter_duplicate_coordinates([dict(x) for x in base])
    assert first == second
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


# ---------------------------------------------------------------------------
# Key order against the committed file -- read, not hard-coded.
# ---------------------------------------------------------------------------


def test_location_key_order_matches_the_committed_file() -> None:
    """Guards parse_study_locations's field order against the real
    data/geocoded_trials.json, reading the expected order from the file
    itself rather than hard-coding it here.
    """
    committed = json.loads(
        (_REPO_ROOT / "data" / "geocoded_trials.json").read_text(encoding="utf-8")
    )
    expected = list(committed["locations"][0].keys())
    actual = list(parse_study_locations(_STUDY)[0].keys())
    assert actual == expected


async def test_top_level_key_order_matches_the_committed_file(
    tmp_path: Path, mocker
) -> None:
    """Same guard, for run_geocode's top-level nctIds/generatedAt/locations
    object. fetch_trial_locations is mocked -- this is about the shape
    write_value receives, not live coordinates.
    """
    committed = json.loads(
        (_REPO_ROOT / "data" / "geocoded_trials.json").read_text(encoding="utf-8")
    )
    expected = list(committed.keys())

    (tmp_path / "table2.json").write_text(
        json.dumps([{"registryId": "NCT05755997"}]), encoding="utf-8"
    )
    mocker.patch(
        "pipeline.export.geocode.fetch_trial_locations",
        new=AsyncMock(return_value=[]),
    )

    await run_geocode(target_dir=tmp_path)

    produced_text = (tmp_path / "geocoded_trials.json").read_text(encoding="utf-8")
    assert list(json.loads(produced_text).keys()) == expected


async def test_run_geocode_filters_to_valid_nct_ids_only(
    tmp_path: Path, mocker
) -> None:
    """Mirrors geocode.R's extract_nct_ids: only NCT + 8 digits qualifies,
    case is normalized, and duplicates collapse -- before the one CT.gov
    request is even built.
    """
    (tmp_path / "table2.json").write_text(
        json.dumps(
            [
                {"registryId": "nct05755997"},  # lower-case, upper-cased
                {"registryId": "ISRCTN14632228"},  # not NCT, dropped
                {"registryId": "NCT123"},  # too short, dropped
                {"registryId": "NCT05755997"},  # duplicate, collapses
            ]
        ),
        encoding="utf-8",
    )
    fetch = mocker.patch(
        "pipeline.export.geocode.fetch_trial_locations",
        new=AsyncMock(return_value=[]),
    )

    await run_geocode(target_dir=tmp_path)

    fetch.assert_awaited_once_with(["NCT05755997"])
    written_text = (tmp_path / "geocoded_trials.json").read_text(encoding="utf-8")
    assert json.loads(written_text)["nctIds"] == ["NCT05755997"]


# ---------------------------------------------------------------------------
# Fail-closed: raise rather than silently publish a partial map.
# ---------------------------------------------------------------------------


class _FakeClient:
    """Minimal stand-in for the client the manager hands out."""

    def __init__(self, response: httpx.Response) -> None:
        self._response = response

    async def get(self, url: str, params: dict[str, Any]) -> httpx.Response:
        return self._response


class _FakeClientManager:
    """Minimal stand-in for AsyncHttpClientManager.

    `fetch_trial_locations` goes through the shared manager rather than
    building its own client, so that the telemetry hooks reach its one
    request. The manager and the client are separate objects here because
    they both answer to `get`, with different signatures.
    """

    def __init__(self, response: httpx.Response) -> None:
        self._client = _FakeClient(response)
        self.closed = False

    async def get(self) -> _FakeClient:
        return self._client

    async def close(self) -> None:
        self.closed = True


def _studies_response(nct_ids: list[str]) -> httpx.Response:
    """A minimal /studies response naming exactly these NCT IDs."""
    request = httpx.Request("GET", CTG_STUDIES_URL)
    studies = [
        {"protocolSection": {"identificationModule": {"nctId": nct}}} for nct in nct_ids
    ]
    return httpx.Response(200, json={"studies": studies}, request=request)


def _studies_response_with_locations(nct_ids: list[str]) -> httpx.Response:
    """Like _studies_response, but each study also carries one location, so
    the *order* of the flattened output is actually observable.
    """
    request = httpx.Request("GET", CTG_STUDIES_URL)
    studies = [
        {
            "protocolSection": {
                "identificationModule": {"nctId": nct},
                "contactsLocationsModule": {
                    "locations": [
                        {
                            "facility": f"Site {nct}",
                            "geoPoint": {"lat": 1.0, "lon": 2.0},
                        }
                    ]
                },
            }
        }
        for nct in nct_ids
    ]
    return httpx.Response(200, json={"studies": studies}, request=request)


# ---------------------------------------------------------------------------
# Output order follows the requested nct_ids, not the API's response order.
# ---------------------------------------------------------------------------


async def test_fetch_orders_output_by_requested_ids_not_api_response_order(
    mocker,
) -> None:
    """Regression: an unchanged trial set must regenerate byte-identical
    output. ClinicalTrials.gov does not promise to echo `filter.ids` back in
    the order given, so this response deliberately scrambles it relative to
    what was requested.
    """
    requested = ["NCT00000001", "NCT00000002", "NCT00000003"]
    response = _studies_response_with_locations(
        ["NCT00000003", "NCT00000001", "NCT00000002"]
    )
    mocker.patch(
        "pipeline.export.geocode.AsyncHttpClientManager",
        return_value=_FakeClientManager(response),
    )

    result = await fetch_trial_locations(requested)

    assert [loc["nctId"] for loc in result] == requested


async def test_fetch_raises_when_ctgov_omits_a_requested_trial(mocker) -> None:
    """The core fail-closed property: a short response must raise, not
    silently return fewer locations than requested.
    """
    response = _studies_response(["NCT00000001"])  # NCT00000002 never comes back
    mocker.patch(
        "pipeline.export.geocode.AsyncHttpClientManager",
        return_value=_FakeClientManager(response),
    )

    with pytest.raises(RuntimeError, match="NCT00000002"):
        await fetch_trial_locations(["NCT00000001", "NCT00000002"])


async def test_fetch_succeeds_when_every_requested_trial_comes_back(
    mocker,
) -> None:
    """Contrast case: the completeness check does not raise when nothing
    is actually missing.
    """
    response = _studies_response(["NCT00000001", "NCT00000002"])
    mocker.patch(
        "pipeline.export.geocode.AsyncHttpClientManager",
        return_value=_FakeClientManager(response),
    )

    result = await fetch_trial_locations(["NCT00000001", "NCT00000002"])
    assert result == []  # no contactsLocationsModule in this minimal fixture


async def test_fetch_names_a_trial_that_contributed_no_marker(
    mocker, caplog
) -> None:
    """A trial can come back complete and still be nowhere on the map.

    `nctIds` is written from data/table2.json, so the trial is published in
    the committed file either way, and tests/data_contract_test.ts compares
    only that set. Without this line nothing anywhere says the map is
    missing it.
    """
    response = _studies_response(["NCT00000001"])  # no locations at all
    mocker.patch(
        "pipeline.export.geocode.AsyncHttpClientManager",
        return_value=_FakeClientManager(response),
    )

    with caplog.at_level(logging.WARNING, logger="pipeline.export.geocode"):
        assert await fetch_trial_locations(["NCT00000001"]) == []

    assert "NCT00000001" in caplog.text
    assert "no marker on the map" in caplog.text


async def test_fetch_with_no_ids_makes_no_request(mocker) -> None:
    spy = mocker.patch("pipeline.export.geocode.AsyncHttpClientManager")
    assert await fetch_trial_locations([]) == []
    spy.assert_not_called()


async def test_fetch_propagates_http_errors_instead_of_swallowing_them(
    mocker,
) -> None:
    """Fails closed on transport failure too, not just on a short response:
    there is no retry-then-swallow path left once Nominatim's retry/backoff
    logic is gone.
    """
    request = httpx.Request("GET", CTG_STUDIES_URL)
    response = httpx.Response(500, request=request)
    mocker.patch(
        "pipeline.export.geocode.AsyncHttpClientManager",
        return_value=_FakeClientManager(response),
    )

    with pytest.raises(httpx.HTTPStatusError):
        await fetch_trial_locations(["NCT00000001"])


# ---------------------------------------------------------------------------
# Atomic write: a crash mid-write must not corrupt the committed file.
# ---------------------------------------------------------------------------


async def test_run_geocode_leaves_no_temp_file_behind_on_success(
    tmp_path: Path, mocker
) -> None:
    (tmp_path / "table2.json").write_text(
        json.dumps([{"registryId": "NCT05755997"}]), encoding="utf-8"
    )
    mocker.patch(
        "pipeline.export.geocode.fetch_trial_locations",
        new=AsyncMock(return_value=[]),
    )

    await run_geocode(target_dir=tmp_path)

    assert {p.name for p in tmp_path.iterdir()} == {
        "table2.json",
        "geocoded_trials.json",
    }


async def test_run_geocode_does_not_clobber_the_existing_file_if_the_write_fails(
    tmp_path: Path, mocker
) -> None:
    """A crash *during* the write must leave the previously committed file
    intact and drop no stray tempfile -- the whole reason for writing through
    a same-directory tempfile plus Path.replace() instead of straight to the
    final path.
    """
    (tmp_path / "table2.json").write_text(
        json.dumps([{"registryId": "NCT05755997"}]), encoding="utf-8"
    )
    original = (
        '{"nctIds": [], "generatedAt": "2020-01-01T00:00:00Z", "locations": []}\n'
    )
    (tmp_path / "geocoded_trials.json").write_text(original, encoding="utf-8")
    mocker.patch(
        "pipeline.export.geocode.fetch_trial_locations",
        new=AsyncMock(return_value=[]),
    )
    mocker.patch(
        "pipeline.export.geocode.write_value",
        side_effect=OSError("disk full"),
    )

    with pytest.raises(OSError, match="disk full"):
        await run_geocode(target_dir=tmp_path)

    assert (tmp_path / "geocoded_trials.json").read_text(encoding="utf-8") == original
    assert {p.name for p in tmp_path.iterdir()} == {
        "table2.json",
        "geocoded_trials.json",
    }


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits only")
async def test_run_geocode_output_is_world_readable_like_its_siblings(
    tmp_path: Path, mocker
) -> None:
    """mkstemp() creates its file mode 0600 -- fine for callers with secrets
    to protect, but this JSON has none, and Path.replace() would otherwise
    carry that restrictive mode onto the published file, leaving it less
    readable than the other nine committed files.
    """
    (tmp_path / "table2.json").write_text(
        json.dumps([{"registryId": "NCT05755997"}]), encoding="utf-8"
    )
    mocker.patch(
        "pipeline.export.geocode.fetch_trial_locations",
        new=AsyncMock(return_value=[]),
    )

    await run_geocode(target_dir=tmp_path)

    mode = stat.S_IMODE((tmp_path / "geocoded_trials.json").stat().st_mode)
    assert mode == 0o644


def test_main_configures_logging_and_runs_geocode(mocker) -> None:
    configure = mocker.patch("pipeline.export.geocode.logging.basicConfig")
    run_geocode_mock = mocker.patch("pipeline.export.geocode.run_geocode")
    asyncio_run = mocker.patch("pipeline.export.geocode.asyncio.run")

    main()

    configure.assert_called_once_with(level=logging.INFO, format="%(message)s")
    run_geocode_mock.assert_called_once_with()
    asyncio_run.assert_called_once()
    coroutine = asyncio_run.call_args.args[0]
    assert asyncio.iscoroutine(coroutine)
    coroutine.close()
