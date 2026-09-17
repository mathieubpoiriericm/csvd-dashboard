"""Trial facility locations for the map.

ClinicalTrials.gov returns a geoPoint per location, so no geocoding service
is involved: one request with filter.ids covers every trial. The geoPoint is
computed by the API as GeoPoint(City, State, Country) — city-level, not
facility-level — so co-located facilities arrive with identical coordinates
and still need fanning out. That was true of the Nominatim results too.
"""

import asyncio
import json
import logging
import math
import os
import tempfile
from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

import httpx

from pipeline.config import PROJECT_ROOT
from pipeline.export.writer import write_value
from pipeline.http_client import AsyncHttpClientManager

logger = logging.getLogger(__name__)

CTG_STUDIES_URL: Final[str] = "https://clinicaltrials.gov/api/v2/studies"
_FIELDS: Final[str] = (
    "protocolSection.identificationModule.nctId,"
    "protocolSection.identificationModule.briefTitle,"
    "protocolSection.statusModule.overallStatus,"
    "protocolSection.contactsLocationsModule.locations"
)
_TIMEOUT: Final[httpx.Timeout] = httpx.Timeout(30.0)
JITTER_RADIUS_DEGREES: Final[float] = 0.003


def parse_study_locations(study: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten one study into map-ready location rows."""
    protocol = study.get("protocolSection", {})
    identification = protocol.get("identificationModule", {})
    nct_id = identification.get("nctId")
    title = identification.get("briefTitle")
    status = protocol.get("statusModule", {}).get("overallStatus")

    out: list[dict[str, Any]] = []
    dropped = 0
    for location in protocol.get("contactsLocationsModule", {}).get("locations", []):
        point = location.get("geoPoint") or {}
        lat, lon = point.get("lat"), point.get("lon")
        # Drop rows without usable coordinates rather than defaulting them:
        # a marker at (0, 0) is worse than no marker. Count them, though --
        # dropping silently is how a trial listed in `nctIds` ends up with no
        # marker anywhere on the map and nothing to say why.
        if not isinstance(lat, int | float) or not isinstance(lon, int | float):
            dropped += 1
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            dropped += 1
            continue
        out.append(
            {
                "nctId": nct_id,
                "facilityName": location.get("facility"),
                "city": location.get("city"),
                "state": location.get("state"),
                "country": location.get("country"),
                "trialTitle": title,
                "status": status,
                "lat": float(lat),
                "lon": float(lon),
            }
        )
    if dropped:
        logger.warning(
            "%s: %d facility location(s) carry no usable coordinates and are "
            "not on the map",
            nct_id,
            dropped,
        )
    return out


async def fetch_trial_locations(nct_ids: Sequence[str]) -> list[dict[str, Any]]:
    """Fetch every trial's locations in a single request.

    Fails closed: any HTTP error raises rather than publishing a partial map.
    Output order follows `nct_ids`, not ClinicalTrials.gov's response order --
    the API does not promise to echo studies back in `filter.ids` order, and
    if this function did, an unchanged trial set could still rewrite the
    whole committed file on every regeneration.
    """
    if not nct_ids:
        return []
    # One page, no pagination: ClinicalTrials.gov caps pageSize at 1000, so
    # this design holds up to 1000 trials (there are 16 today). Past that
    # the API silently returns the first 1000 and the missing check below
    # raises, naming every trial that did not come back -- the right
    # failure, but the fix would be to paginate, not to raise pageSize.
    params = {
        "filter.ids": ",".join(nct_ids),
        "fields": _FIELDS,
        "pageSize": str(max(len(nct_ids), 10)),
        "countTotal": "true",
    }
    # Through the shared manager rather than a bare httpx.AsyncClient so
    # that pipeline/ has one way to make an HTTP call and the telemetry
    # hooks reach every one of them. Nothing reads the recorder in this
    # process -- the geocode writes no run report -- but an exemption here
    # is a hole in the inventory that the next caller would copy.
    # Function-scoped, not a module singleton: this module makes exactly one
    # request per process, which is what the `async with` already scoped it
    # to.
    manager = AsyncHttpClientManager(timeout=_TIMEOUT, follow_redirects=True)
    try:
        client = await manager.get()
        response = await client.get(CTG_STUDIES_URL, params=params)
        response.raise_for_status()
        body = response.json()
    finally:
        await manager.close()

    studies = body.get("studies", [])
    by_id = {
        s.get("protocolSection", {}).get("identificationModule", {}).get("nctId"): s
        for s in studies
    }
    if missing := [n for n in nct_ids if n not in by_id]:
        raise RuntimeError(
            f"ClinicalTrials.gov returned no record for: {', '.join(missing)}; "
            "the previous geocode output was not replaced"
        )
    rows: list[dict[str, Any]] = []
    for nct_id in nct_ids:
        study_rows = parse_study_locations(by_id[nct_id])
        # A trial that came back but contributed nothing is published in
        # `nctIds` with no marker on the map. That is not an error -- a trial
        # can legitimately have no site listed yet -- but it is invisible in
        # the committed file, and tests/data_contract_test.ts compares only
        # the nctIds set, so this line is the only place it is said.
        if not study_rows:
            logger.warning(
                "%s: ClinicalTrials.gov lists no mappable facility; the trial "
                "is in nctIds with no marker on the map",
                nct_id,
            )
        rows.extend(study_rows)
    return rows


def jitter_duplicate_coordinates(
    locations: list[dict[str, Any]], radius: float = JITTER_RADIUS_DEGREES
) -> list[dict[str, Any]]:
    """Fan co-located markers around a circle so each stays clickable.

    Deterministic by construction — position in the group sets the angle.
    No RNG, so regenerating produces byte-identical output.
    """
    groups: dict[tuple[float, float], list[dict[str, Any]]] = defaultdict(list)
    for location in locations:
        groups[(location["lat"], location["lon"])].append(location)

    for (lat, lon), group in groups.items():
        if len(group) < 2:
            continue
        for index, location in enumerate(group):
            angle = 2 * math.pi * index / len(group)
            location["lat"] = round(lat + radius * math.sin(angle), 6)
            location["lon"] = round(lon + radius * math.cos(angle), 6)
    return locations


async def run_geocode(target_dir: Path | None = None) -> None:
    """Regenerate data/geocoded_trials.json from the trials table.

    Written via a same-directory tempfile plus `Path.replace()` -- mirroring
    what geocode.R did with `tempfile()` + `file.rename()` -- so a crash or a
    disk error mid-write can never corrupt the committed file. `write_value`
    itself is a plain write; the atomicity is layered on here rather than
    there, since this is the only one of the nine committed files with no
    staging directory of its own to publish through.
    """
    target = target_dir or PROJECT_ROOT / "data"
    trials = json.loads((target / "table2.json").read_text(encoding="utf-8"))
    registry_ids = (
        str(trial.get("registryId", "")).strip().upper() for trial in trials
    )
    nct_ids = sorted(
        {
            registry
            for registry in registry_ids
            if registry.startswith("NCT")
            and len(registry) == 11
            and registry[3:].isdigit()
        }
    )
    logger.info("Fetching locations for %d trials in one request", len(nct_ids))
    locations = jitter_duplicate_coordinates(await fetch_trial_locations(nct_ids))
    payload = {
        "nctIds": nct_ids,
        "generatedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "locations": locations,
    }

    final_path = target / "geocoded_trials.json"
    fd, temp_name = tempfile.mkstemp(
        dir=target, prefix=".geocoded_trials-", suffix=".json"
    )
    os.close(fd)
    temp_path = Path(temp_name)
    # mkstemp() creates the file mode 0600 for callers with secrets to
    # protect; this file has none, and Path.replace() would otherwise leave
    # the published JSON less readable than its nine siblings.
    os.chmod(temp_path, 0o644)
    try:
        write_value(payload, temp_path)
        temp_path.replace(final_path)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise
    logger.info("Wrote %d locations", len(locations))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    asyncio.run(run_geocode())


if __name__ == "__main__":
    main()
