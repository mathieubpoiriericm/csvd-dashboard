"""ClinicalTrials.gov (CTG) v2 discovery and refresh module.

Searches CTG for disease-relevant drug trials, maps the JSON studies to flat
records, and upserts them into the ``clinical_trials`` Postgres table.

The upsert is intentionally write-only for API-sourced columns. Curator-owned
columns (mechanism_of_action, genetic_target, genetic_evidence,
target_population, target_population_details) are never populated here — they
default to NULL on INSERT and are omitted from the update set, so existing
curator edits are preserved across runs. ``trial_name`` and
``primary_outcome`` are refreshed only while a row is uncurated, because the
curated spellings normalize what the registry states; ``sponsor_type`` yields
to any existing value. A registry id the curated table already holds is
*refreshed*, never added to: see ``upsert_clinical_trials_batch``.
"""

import asyncio
import json
import logging
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import httpx

from pipeline.cache_utils import SyncResult
from pipeline.config import PROJECT_ROOT, PipelineConfig
from pipeline.disease import load_disease
from pipeline.drug_names import normalize_drug_name
from pipeline.http_client import AsyncHttpClientManager
from pipeline.rate_limiter import compute_backoff, resolve_retry_delay

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------

CTG_BASE_URL: Final[str] = "https://clinicaltrials.gov/api/v2"
CTG_STUDIES_URL: Final[str] = f"{CTG_BASE_URL}/studies"

# CTG v2 intervention types that are a therapeutic agent. Behavioral,
# device, procedure and the like are skipped. BIOLOGICAL and GENETIC are in
# because CT.gov types an antibody as the first and an siRNA or ASO as the
# second -- the class of agent the curated table already holds (ALN-APP) --
# and a DRUG-only set dropped their trials as "no drug".
DRUG_INTERVENTION_TYPES: Final[frozenset[str]] = frozenset(
    {"DRUG", "BIOLOGICAL", "GENETIC"}
)

# `query.cond` expands a term into CT.gov's own concept graph, and nothing
# downstream narrowed it again: the only gate was DRUG_INTERVENTION_TYPES, so
# every study the expansion reached was written as a discovery. Measured
# against the live registry, ten terms returned 1,423 studies of which the
# most common stated condition was **Fabry disease** (215), followed by
# cancer, leukaemia, ANCA-associated vasculitis, Parkinson's and MS. That is
# what put 594 rows in front of a curator.
#
# A study is kept only if one of the conditions it *states* names an entity
# of the disease. The vocabulary is the scope the curated rows already
# describe -- lacunar stroke, SVS, CMB, WMH, CAA, CADASIL and vascular
# cognitive impairment -- and deliberately excludes the systemic diseases
# that can cause the disease: a Fabry enzyme-replacement trial is a Fabry
# trial, and the curated table has never held one. Validated against the
# eight curated NCT trials: the filter drops none of them, and 1,045 of the
# 1,423 studies.
_DISEASE = load_disease()
_CONDITIONS: Final[tuple[str, ...]] = _DISEASE.ct_condition_substrings

# MeSH inverts the phrase -- "Dementia, Vascular" beside "Vascular Dementia",
# 64 and 87 times in one fetch -- so these are matched as a co-occurrence
# inside a single condition string rather than as a phrase. Both words must
# sit in the *same* condition: "Cardiovascular Diseases" listed beside
# "Cognitive Decline" is two conditions and neither names the disease.
_CONDITION_PAIRS: Final[tuple[tuple[str, str], ...]] = _DISEASE.ct_condition_pairs

_CONDITION_NOISE: Final[re.Pattern[str]] = re.compile(r"[^a-z0-9 ]+")


def _stated_conditions(study: dict[str, Any]) -> list[str]:
    """The conditions a study declares, or an empty list."""
    section = study.get("protocolSection")
    if not isinstance(section, dict):
        return []
    module = section.get("conditionsModule")
    if not isinstance(module, dict):
        return []
    conditions = module.get("conditions")
    return [c for c in conditions if isinstance(c, str)] if isinstance(
        conditions, list
    ) else []


def is_disease_study(study: dict[str, Any]) -> bool:
    """Whether a study states a condition naming an entity of the disease.

    A study stating no condition at all is kept: the absence is CT.gov's,
    not evidence that the trial is off-topic, and a curator can read it.
    """
    conditions = _stated_conditions(study)
    if not conditions:
        return True
    for condition in conditions:
        normalised = _CONDITION_NOISE.sub(" ", condition.lower())
        if any(term in normalised for term in _CONDITIONS):
            return True
        if any(a in normalised and b in normalised
               for a, b in _CONDITION_PAIRS):
            return True
    return False


# CT.gov types a comparator arm as DRUG too, so "Placebo" arrived as a trial
# drug the moment a sync ran -- a row in Table 2 beside the curated agents,
# and a ChEMBL lookup that resolves "Placebo" to nicotine. A comparator is
# recognised by its name: the arm is called what it is. The word can sit
# anywhere in that name, though -- live CT.gov writes "Matching placebo",
# "Isosorbide Mononitrate Placebo" and "Butylphthalide Placebo" -- so a
# prefix test read three of the eight curated trials' control arms as drugs.
_COMPARATOR_WORDS: Final[re.Pattern[str]] = re.compile(
    r"\b(?:placebo|sham|vehicle)\b", re.IGNORECASE
)

# Saline deliberately gets a stricter rule than the three words above.
# Hypertonic saline is a therapy under study, normal saline is the control
# arm, and only the second is a comparator -- so the name has to be *nothing
# but* a saline synonym once its concentration is stripped ("0.9 % NaCl").
# Dropping every name containing "saline" would hide a real agent, which is
# the worse of the two errors: an unrecognised comparator sits uncurated in
# the table and is never published (see the export's curation gate), while a
# dropped agent never reaches a curator at all.
_SALINE_NAMES: Final[frozenset[str]] = frozenset(
    {
        "saline",
        "saline solution",
        "normal saline",
        "isotonic saline",
        "physiological saline",
        "physiologic saline",
        "nacl",
        "sodium chloride",
        "sodium chloride solution",
    }
)
_CONCENTRATION: Final[re.Pattern[str]] = re.compile(r"[\d.,%]+")

# Only an interventional study is a trial. CT.gov lists observational
# studies with a DRUG intervention as well (a cohort on aspirin users, say),
# and nothing else in the record separates them from a trial.
_INTERVENTIONAL_STUDY_TYPE: Final[str] = "INTERVENTIONAL"

# CT.gov's dates are ISO (YYYY-MM-DD, or YYYY-MM when the day is not set).
# Every curated row reads M/YYYY, and lib/sorting.ts's completionDateKey
# parses only that shape, so an ISO date sorted as no date at all.
_ISO_DATE: Final[re.Pattern[str]] = re.compile(r"^(\d{4})-(\d{2})(?:-\d{2})?$")

# Map CTG v2 raw phase enum values to the spelling the dashboard reads.
# lib/filters.ts matches whole Roman-numeral tokens against PHASE_CHOICES
# ("I", "II", "III") and the curated rows in data/table2.json are spelled
# that way; "Phase 2" carries no such token, so a row labelled that way is
# invisible under any phase filter. Unmapped values pass through verbatim.
_PHASE_DISPLAY_MAP: Final[dict[str, str]] = {
    "EARLY_PHASE1": "Early Phase I",
    "PHASE1": "I",
    "PHASE2": "II",
    "PHASE3": "III",
    "PHASE4": "IV",
    "NA": "N/A",
}

# The radar has one ring per phase and places a trial by comparing the
# published label to the ring's phase for equality -- lib/timeline.ts and
# scripts/timeline_figure.py both do. A label outside that set still passes
# the table's token filter, so the table and the figure disagree about the
# trial set with nothing said. The two seamless designs the registry
# actually uses, "II/III" and "I/II", have rings of their own; what is left
# unplaceable is "Early Phase I" and the rarer joins ("I/III", "III/IV").
# Read from the encoding rather than restated, so adding a ring is one edit.
_TIMELINE_ENCODING: Final[Path] = PROJECT_ROOT / "lib" / "timeline_encoding.json"


def _load_ring_phases() -> frozenset[str]:
    """The phase labels the trials radar has a ring for, as *records* spell them.

    The encoding names its rings in wire spelling, because that is what
    `lib/timeline.ts` compares the published row against. One of them differs
    from what a record carries: the registry states "N/A", and
    `fill_missing_text` folds that to the "(unknown)" sentinel on the way out
    (`pipeline/export/tables.py`). Comparing a record's phase against the wire
    name would report every N/A trial as unplaceable when the radar draws it
    on the outermost ring.
    """
    with _TIMELINE_ENCODING.open(encoding="utf-8") as handle:
        rings = [ring["phase"] for ring in json.load(handle)["rings"]]
    return frozenset("N/A" if phase == "(unknown)" else phase for phase in rings)


RADAR_PHASES: Final[frozenset[str]] = _load_ring_phases()

# lib/filters.ts wants exact "Academic" or an "Industry" prefix, the two
# SPONSOR_CHOICES. CT.gov's leadSponsor.class enum (INDUSTRY, NIH, OTHER,
# FED, NETWORK, INDIV, ...) matches neither, so it is folded to the pair.
# The two classes that state nothing are the exception -- see _sponsor_label.
_INDUSTRY_SPONSOR_CLASS: Final[str] = "INDUSTRY"
_UNSTATED_SPONSOR_CLASSES: Final[frozenset[str]] = frozenset({"UNKNOWN", "AMBIG"})


# ---------------------------------------------------------------------------
# MODELS
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ClinicalTrialRecord:
    """Flat CTG-derived record for the ``clinical_trials`` table.

    Only API-sourced columns are represented here. Curator-owned columns
    are handled at the SQL layer (NULL on INSERT; excluded from UPDATE).
    """

    drug: str
    trial_name: str | None
    registry_id: str
    clinical_trial_phase: str | None
    target_sample_size: int | None
    estimated_completion_date: str | None
    primary_outcome: str | None
    sponsor_type: str | None
    # The registry's own recruitment status, verbatim ("TERMINATED",
    # "RECRUITING", ...). It is last because it is not a column Table 2
    # publishes: the export reads it to refuse a stopped trial and drops it
    # on the way out. None means the study stated none, which is the same
    # thing a NULL column means -- no answer, so the row publishes.
    overall_status: str | None = None


# ---------------------------------------------------------------------------
# HTTP CLIENT AND CONCURRENCY
# ---------------------------------------------------------------------------

_client_manager = AsyncHttpClientManager(timeout=30.0)
_ctg_semaphore: asyncio.Semaphore | None = None


def init_ctg_fetch_state(config: PipelineConfig | None = None) -> None:
    """Eagerly initialize the CTG concurrency semaphore.

    Must be called once from inside the running event loop. Idempotent.
    """
    global _ctg_semaphore
    if _ctg_semaphore is not None:
        return
    # asyncio.Semaphore silently ties itself to whatever loop happens to be
    # current, so mis-use (sync context) only surfaces much later as
    # "attached to a different loop" errors. Fail fast instead.
    try:
        asyncio.get_running_loop()
    except RuntimeError as e:
        raise RuntimeError(
            "init_ctg_fetch_state() must be called from inside a running event loop"
        ) from e
    _ctg_semaphore = asyncio.Semaphore((config or PipelineConfig()).ct_max_concurrency)


def _get_ctg_semaphore() -> asyncio.Semaphore:
    """Get or lazily create the CTG concurrency semaphore."""
    if _ctg_semaphore is None:
        init_ctg_fetch_state()
    assert _ctg_semaphore is not None
    return _ctg_semaphore


async def close_ctg_client() -> None:
    """Close the shared CTG HTTP client (call at shutdown)."""
    await _client_manager.close()


# ---------------------------------------------------------------------------
# JSON → RECORD MAPPING
# ---------------------------------------------------------------------------


def _get_path(obj: Any, *path: str) -> Any:
    """Safely traverse nested dicts; return None on missing keys."""
    current = obj
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
        if current is None:
            return None
    return current


def _nonempty_str(value: Any) -> str | None:
    """Return non-empty strings unchanged and normalize other values to None."""
    return value if isinstance(value, str) and value else None


def _nct_id(study: dict[str, Any]) -> str | None:
    """Return a study's non-empty registry identifier, if present."""
    return _nonempty_str(
        _get_path(study, "protocolSection", "identificationModule", "nctId")
    )


def _first_primary_outcome(study: dict[str, Any]) -> str | None:
    """Extract the first primary outcome measure, if any."""
    outcomes = _get_path(study, "protocolSection", "outcomesModule", "primaryOutcomes")
    if not isinstance(outcomes, list) or not outcomes:
        return None
    first = outcomes[0]
    if not isinstance(first, dict):
        return None
    return _nonempty_str(first.get("measure"))


def _phase_label(study: dict[str, Any]) -> str | None:
    """The trial's phases in the curated spelling, ``"II/III"`` for a multi-phase trial.

    Every phase is kept, not the first: a Phase 2/3 trial is both, and the
    dashboard's filter reads each Roman-numeral token.
    """
    phases = _get_path(study, "protocolSection", "designModule", "phases")
    if not isinstance(phases, list):
        return None
    labels = [
        _PHASE_DISPLAY_MAP.get(phase, phase)
        for raw in phases
        if (phase := _nonempty_str(raw)) is not None
    ]
    return "/".join(labels) if labels else None


def _completion_label(date: str | None) -> str | None:
    """An ISO completion date in the curated ``M/YYYY`` spelling.

    Anything that is not an ISO date passes through unchanged.
    """
    if date is None:
        return None
    match = _ISO_DATE.match(date)
    if match is None:
        return date
    year, month = match.groups()
    return f"{int(month)}/{year}"


def _is_saline(name: str) -> bool:
    """Whether a name is a saline control arm and nothing else."""
    stripped = " ".join(_CONCENTRATION.sub(" ", name).lower().split())
    return stripped in _SALINE_NAMES


def _is_comparator(name: str) -> bool:
    """Whether an intervention name is a placebo, sham, vehicle or saline arm."""
    return _COMPARATOR_WORDS.search(name) is not None or _is_saline(name)


def _intervention_names(item: dict[str, Any]) -> list[str]:
    """An intervention's own name plus every synonym CT.gov lists for it.

    The comparator test reads all of them: CT.gov named one curated trial's
    control arm "0.9 % NaCl" with "Sodium Chloride" only in ``otherNames``,
    and a sponsor is free to put the plain word in either field.
    """
    names = [item.get("name")]
    other = item.get("otherNames")
    if isinstance(other, list):
        names.extend(other)
    return [name for name in names if isinstance(name, str) and name.strip()]


def _sponsor_label(sponsor_class: Any) -> str | None:
    """Fold CT.gov's lead-sponsor class onto the dashboard's Academic/Industry pair.

    UNKNOWN and AMBIG are the two classes that state nothing, and they
    return None -- the export publishes that as "(unknown)". Folding them
    to "Academic" published an affirmative claim about who ran a trial that
    the registry never made, and once stored the COALESCE on conflict would
    keep it there until a curator noticed.
    """
    if (raw := _nonempty_str(sponsor_class)) is None:
        return None
    upper = raw.upper()
    if upper in _UNSTATED_SPONSOR_CLASSES:
        return None
    return "Industry" if upper == _INDUSTRY_SPONSOR_CLASS else "Academic"


def _drug_interventions(study: dict[str, Any]) -> list[str]:
    """Extract therapeutic-agent intervention names from a CTG v2 study."""
    interventions = _get_path(
        study, "protocolSection", "armsInterventionsModule", "interventions"
    )
    if not isinstance(interventions, list):
        return []
    drugs: list[str] = []
    seen: set[str] = set()
    for item in interventions:
        if not isinstance(item, dict):
            continue
        itype = item.get("type")
        name = item.get("name")
        if not isinstance(itype, str) or itype.upper() not in DRUG_INTERVENTION_TYPES:
            continue
        if not isinstance(name, str):
            continue
        stripped = name.strip()
        if not stripped or stripped in seen:
            continue
        if any(_is_comparator(alias) for alias in _intervention_names(item)):
            continue
        drugs.append(stripped)
        seen.add(stripped)
    return drugs


def _is_interventional(study: dict[str, Any]) -> bool:
    """Whether the study is a trial; a record naming no type is kept."""
    study_type = _get_path(study, "protocolSection", "designModule", "studyType")
    if (raw := _nonempty_str(study_type)) is None:
        return True
    return raw.upper() == _INTERVENTIONAL_STUDY_TYPE


def _map_study_to_records(study: dict[str, Any]) -> list[ClinicalTrialRecord]:
    """Map a CTG v2 study dict to zero or more ClinicalTrialRecord rows.

    One record per intervention in DRUG_INTERVENTION_TYPES. Other
    interventions are skipped. Trials with none yield no records, and so
    does a study that is not interventional.
    """
    nct_id = _nct_id(study)
    if nct_id is None:
        return []
    if not _is_interventional(study):
        return []

    drugs = _drug_interventions(study)
    if not drugs:
        return []

    trial_name = _get_path(
        study, "protocolSection", "identificationModule", "briefTitle"
    )
    phase = _phase_label(study)

    enrollment = _get_path(
        study, "protocolSection", "designModule", "enrollmentInfo", "count"
    )
    sample_size = enrollment if isinstance(enrollment, int) else None

    completion = _get_path(
        study, "protocolSection", "statusModule", "completionDateStruct", "date"
    )
    completion_label = _completion_label(_nonempty_str(completion))
    # CT.gov marks a completion date ESTIMATED or ACTUAL; the dashboard has
    # one column, headed "Estimated Completion Date", and no place to say
    # which. An ACTUAL date published there reads as a forecast for a trial
    # that has already finished, so the run log says so per trial until the
    # table carries the distinction.
    completion_type = _nonempty_str(
        _get_path(
            study, "protocolSection", "statusModule", "completionDateStruct", "type"
        )
    )
    if completion_type is not None and completion_type.upper() == "ACTUAL":
        logger.info(
            "CTG %s: completion %s is ACTUAL, not an estimate; it publishes "
            "under 'Estimated Completion Date'",
            nct_id,
            completion_label,
        )
    primary_outcome = _first_primary_outcome(study)

    # Free: the search sends no `fields` list, so overallStatus is already in
    # every payload this mapper is handed. It is a property of the study, not
    # of the arm, so every record below carries the same one.
    overall_status = _nonempty_str(
        _get_path(study, "protocolSection", "statusModule", "overallStatus")
    )
    if overall_status is not None:
        overall_status = overall_status.upper()

    sponsor_type = _get_path(
        study,
        "protocolSection",
        "sponsorCollaboratorsModule",
        "leadSponsor",
        "class",
    )
    # The intervention name is normalised on the way in, so the table never
    # holds "Atorvastatin 40 Mg Oral Tablet" beside "Atorvastatin" -- the
    # column is what a Table 2 row is about, and the radar's sector spans
    # count unique drugs. A name that resolves to no agent (a comparator the
    # type filter missed, a bare arm label) yields no record.
    return [
        ClinicalTrialRecord(
            drug=drug,
            trial_name=_nonempty_str(trial_name),
            registry_id=nct_id,
            clinical_trial_phase=phase,
            target_sample_size=sample_size,
            estimated_completion_date=completion_label,
            primary_outcome=primary_outcome,
            sponsor_type=_sponsor_label(sponsor_type),
            overall_status=overall_status,
        )
        for drug in (normalize_drug_name(name) for name in drugs)
        if drug
    ]


# ---------------------------------------------------------------------------
# FETCH FUNCTIONS
# ---------------------------------------------------------------------------


async def _fetch_page_with_retry(
    params: dict[str, str],
    max_retries: int,
) -> dict[str, Any]:
    """Fetch a single CTG /studies page, retrying on 429/5xx or transient errors.

    The concurrency semaphore is held only around the HTTP call — backoff
    sleeps run outside it so one failing request cannot starve concurrent
    peers waiting for a slot.
    """
    last_error: Exception | None = None
    for attempt in range(max_retries + 1):
        retry_after: str | None = None
        try:
            async with _get_ctg_semaphore():
                client = await _client_manager.get()
                resp = await client.get(CTG_STUDIES_URL, params=params)
            if resp.status_code == 200:
                body: dict[str, Any] = resp.json()
                return body
            if resp.status_code == 429 or 500 <= resp.status_code < 600:
                retry_after = resp.headers.get("Retry-After")
                logger.warning(
                    f"CTG returned {resp.status_code} "
                    f"(attempt {attempt + 1}/{max_retries + 1})"
                )
                last_error = httpx.HTTPStatusError(
                    f"CTG HTTP {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
            else:
                # Non-retryable (4xx other than 429); raise_for_status handles
                # 4xx/5xx, and we raise explicitly for the rare 3xx/other case.
                resp.raise_for_status()
                raise httpx.HTTPStatusError(
                    f"Unexpected CTG status {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )
        except (httpx.RequestError, json.JSONDecodeError) as e:
            logger.warning(
                f"CTG transient error (attempt {attempt + 1}/{max_retries + 1}): {e}"
            )
            last_error = e

        if attempt < max_retries:
            # 1s, 2s, 4s, ... with ±25% jitter, capped at the shared module
            # cap so raising max_retries can't stall fetches for minutes.
            # **CTG states no Retry-After**: across two live syncs every
            # retry here logged "(backoff)" and not one "(retry-after=...)",
            # so the curve is what actually paces this client and the
            # header path below has never fired. It is kept because it is
            # what ncbi_http and anthropic_client do and costs nothing if
            # CTG ever starts sending one -- but it is not what fixed the
            # truncation. Four attempts over ~7s of curve was, and the fix
            # was the budget: see `ct_max_retries` in config.py, which
            # carries the measurement. The delay_source label is the only
            # thing that distinguishes the two, which is why it is logged.
            delay, delay_source = resolve_retry_delay(
                retry_after, compute_backoff(1.0, attempt + 1)
            )
            logger.info(f"CTG retrying in {delay:.1f}s ({delay_source})")
            await asyncio.sleep(delay)

    raise last_error or RuntimeError(
        f"CTG fetch exhausted {max_retries + 1} attempts with no error captured"
    )


async def _search_condition_term(
    term: str,
    page_size: int,
    max_retries: int,
) -> tuple[list[dict[str, Any]], str | None]:
    """Paginated search for a single condition term.

    Returns the concatenated list of study dicts across all pages, and the
    error if pagination stopped short. If a page fails after all retries,
    earlier pages' studies are preserved — only the failed page (and any
    beyond it) are lost — and the truncation is returned rather than merely
    logged, so the sync reports it instead of badging a partial result set
    as the whole registry.
    """
    collected: list[dict[str, Any]] = []
    error: str | None = None
    page_token: str | None = None
    while True:
        params: dict[str, str] = {
            "query.cond": term,
            "pageSize": str(page_size),
            "format": "json",
        }
        if page_token:
            params["pageToken"] = page_token

        try:
            body = await _fetch_page_with_retry(params, max_retries)
        except Exception as e:
            error = f"CTG term {term!r} truncated after {len(collected)} studies: {e}"
            logger.warning(error)
            break

        studies = body.get("studies")
        if isinstance(studies, list):
            collected.extend(s for s in studies if isinstance(s, dict))

        next_token = body.get("nextPageToken")
        if not isinstance(next_token, str) or not next_token:
            break
        page_token = next_token

    logger.info(f"CTG term {term!r}: {len(collected)} studies")
    return collected, error


async def fetch_disease_studies(
    search_terms: tuple[str, ...] | list[str],
    page_size: int,
    max_retries: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Search CTG across all disease-relevant terms and deduplicate by NCT ID.

    Returns (studies, errors). A failure in one term does not abort the rest;
    failed terms appear in the errors list while successful terms contribute
    their studies. A term whose pagination stopped short contributes the
    pages it reached and an error for the rest.
    """
    if not search_terms:
        return [], []

    results = await asyncio.gather(
        *(
            _search_condition_term(term, page_size, max_retries)
            for term in search_terms
        ),
        return_exceptions=True,
    )

    deduped: dict[str, dict[str, Any]] = {}
    term_errors: list[str] = []
    for term, result in zip(search_terms, results, strict=True):
        if isinstance(result, BaseException):
            logger.warning(f"CTG term {term!r} failed: {result}")
            term_errors.append(f"CTG term {term!r}: {result}")
            continue
        term_studies, truncation = result
        if truncation is not None:
            term_errors.append(truncation)
        for study in term_studies:
            if (nct := _nct_id(study)) is not None:
                deduped.setdefault(nct, study)

    relevant = {nct: s for nct, s in deduped.items() if is_disease_study(s)}
    if (skipped := len(deduped) - len(relevant)):
        logger.info(
            "CTG: %d/%d studies state no %s condition (skipped)",
            skipped,
            len(deduped),
            _DISEASE.abbreviation,
        )

    logger.info(
        f"CTG: {len(relevant)} unique {_DISEASE.abbreviation}-relevant studies "
        f"across {len(search_terms)} search terms "
        f"({len(term_errors)} term failures)"
    )
    return list(relevant.values()), term_errors


# The two fields the status sweep asks for. The search deliberately sends no
# `fields` list -- it needs the whole study -- but this sweep runs over every
# NCT id in the table on every sync, so it asks for the two it reads.
_STATUS_FIELDS: Final[str] = (
    "protocolSection.identificationModule.nctId,"
    "protocolSection.statusModule.overallStatus"
)

# **URL length is the binding limit here, not `pageSize`.** CT.gov accepts a
# pageSize up to 1000, but ~600 ids is ~7.2 KB of `filter.ids` query string,
# at or past the 8 KB request line most servers accept -- and CT.gov answers
# an over-long one with a 400, which `_fetch_page_with_retry` classifies as
# non-retryable and raises. 100 ids is ~1.2 KB.
_STATUS_BATCH_SIZE: Final[int] = 100


async def _fetch_status_batch(
    nct_ids: Sequence[str],
    max_retries: int,
) -> dict[str, str]:
    """Fetch overall status for one batch of NCT ids, keyed by id."""
    body = await _fetch_page_with_retry(
        {
            "filter.ids": ",".join(nct_ids),
            "fields": _STATUS_FIELDS,
            # One page always covers one batch, so a next-page token would
            # mean CT.gov paged us anyway and the batch is short.
            "pageSize": str(len(nct_ids)),
            "format": "json",
        },
        max_retries,
    )
    statuses: dict[str, str] = {}
    studies = body.get("studies")
    for study in studies if isinstance(studies, list) else []:
        if not isinstance(study, dict):
            continue
        nct = _nct_id(study)
        status = _nonempty_str(
            _get_path(study, "protocolSection", "statusModule", "overallStatus")
        )
        if nct is None or status is None:
            continue
        statuses[nct] = status.upper()

    # **A next-page token alone is not a short answer.** CT.gov returns one
    # on a page that already carries every id asked for -- measured, on both
    # batches of a 114-id sweep that answered 114 -- so warning on the token
    # by itself cries wolf on every healthy run. It is a diagnosis, not a
    # symptom: report it only when the batch actually came back short, and
    # let `fetch_trial_statuses` name the ids that went missing.
    if len(statuses) < len(nct_ids):
        token = body.get("nextPageToken")
        if isinstance(token, str) and token:
            logger.warning(
                "CTG status: asked for %d ids in one page, got %d and a "
                "next-page token; the rest of this batch is unswept",
                len(nct_ids),
                len(statuses),
            )
    return statuses


async def fetch_trial_statuses(
    nct_ids: Sequence[str],
    max_retries: int,
) -> tuple[dict[str, str], list[str]]:
    """Overall status for every NCT id given, in batches, keyed by id.

    The search cannot supply this. `is_disease_study` and the interventional
    and drug-type gates all drop trials a curator nonetheless published --
    the terminated rows in the committed data are exactly the old,
    off-vocabulary trials the ten `query.cond` terms are least likely to
    reach -- so the ids come from the table rather than from the search.

    **This fails open, which is the opposite of `export/geocode.py`.**
    `fetch_trial_locations` raises when a requested id comes back with no
    record, because a silent miss shrinks the map. Here a miss must not
    silently *delete a trial from Table 2*: an id CT.gov returns nothing for
    is left out of the mapping, so the row keeps whatever status it had (in
    the common case, NULL) and the export publishes it. A batch that fails
    outright costs that batch's ids and one `errors` entry; nothing here
    aborts the sync.

    Returns (statuses, errors).
    """
    ids = list(dict.fromkeys(i for i in nct_ids if i))
    if not ids:
        return {}, []

    batches = [
        ids[start : start + _STATUS_BATCH_SIZE]
        for start in range(0, len(ids), _STATUS_BATCH_SIZE)
    ]
    results = await asyncio.gather(
        *(_fetch_status_batch(batch, max_retries) for batch in batches),
        return_exceptions=True,
    )

    statuses: dict[str, str] = {}
    errors: list[str] = []
    for batch, result in zip(batches, results, strict=True):
        if isinstance(result, BaseException):
            logger.warning(
                "CTG status batch of %d failed: %s", len(batch), result
            )
            errors.append(
                f"CTG status: {len(batch)} trial(s) unswept "
                f"({batch[0]}...{batch[-1]}): {result}"
            )
            continue
        statuses.update(result)

    if missing := [i for i in ids if i not in statuses]:
        logger.warning(
            "CTG status: no record returned for %d id(s); their stored "
            "status is unchanged and they keep publishing: %s",
            len(missing),
            ", ".join(missing),
        )

    logger.info("CTG status: %d/%d trial(s) answered", len(statuses), len(ids))
    return statuses, errors


# ---------------------------------------------------------------------------
# DATABASE SYNC
# ---------------------------------------------------------------------------


def _unplaceable_phases(
    records: list[ClinicalTrialRecord], curated_ids: frozenset[str]
) -> list[tuple[str, str]]:
    """(registry id, phase) for every curated row the radar cannot place.

    Only curated rows are reported. A trial no curator has filled a
    population in for is not published at all, and the phase they see is
    the one they will correct; a curated trial, on the other hand,
    publishes immediately -- and a label outside RADAR_PHASES puts it in
    Table 2 and on no ring of the figure, with nothing said. A record
    whose phase is None is not reported either: a refresh never overwrites
    a curated value with nothing, so nothing moved.

    The gate is `target_population`, not `refreshed_ids`. The two agree only
    on the run that first discovers a trial: after that the discovery is
    an existing row, so it refreshes rather than inserts, and gating on
    "refreshed" reported all 131 uncurated discoveries as publishing in
    Table 2 -- 35 of them with a phase the radar has no ring for -- on
    every subsequent sync. The export skips those rows entirely, so the
    error was false in its own terms as well as noisy.
    """
    return sorted(
        {
            (record.registry_id, record.clinical_trial_phase)
            for record in records
            if record.registry_id in curated_ids
            and record.clinical_trial_phase is not None
            and record.clinical_trial_phase not in RADAR_PHASES
        }
    )


@dataclass(slots=True)
class ClinicalTrialSyncResult(SyncResult):
    """A SyncResult that also says how much of the write was uncurated.

    ``discovered`` rides beside the three published counts rather than
    inside them: a discovery is a trial nobody has curated yet, so it is
    written but not published, and reading it as part of ``cached`` would
    make the refresh look bigger than it was. `_result_summary` turns the
    dataclass into the run's metrics dict, so the number reaches the sync's
    own summary and log without changing the three-count wire shape.
    """

    discovered: int = 0

    # Trials whose ClinicalTrials.gov status moved on this sync. It rides
    # into the run's metrics dict through `_result_summary` and is
    # deliberately not a `_SOURCES` count: `data/pipeline_syncs.json` is
    # byte-gated on the three published ones.
    status_refreshed: int = 0


async def sync_clinical_trials(config: PipelineConfig) -> ClinicalTrialSyncResult:
    """Discover + refresh disease trials in the clinical_trials table.

    1. Search CTG for each configured term, paginated, deduplicated by NCT ID.
    2. Map studies to one record per therapeutic-agent intervention
       (DRUG_INTERVENTION_TYPES).
    3. Refresh every row of a registry id the table already holds, and insert
       the rest as uncurated discoveries — curator-owned columns are named in
       neither write, so they default to NULL on INSERT and survive a refresh.
    4. Sweep every NCT id the table holds for its current overall status,
       which the search cannot supply for the curated rows it never reaches.

    Returns a ClinicalTrialSyncResult. ``fetched`` = distinct NCT studies
    hit; ``cached`` = rows written (refreshed plus discovered); ``failed`` =
    the studies whose mapping or write failed, which is a count of rows and
    not of messages — a truncated search term is one `errors` entry and no
    failed row, because nothing about it failed to be written.
    ``discovered`` = rows written for a trial no curator has seen, which
    the export does not publish. ``status_refreshed`` = trials whose
    ClinicalTrials.gov status moved, which is the count to read before
    exporting: a terminated or withdrawn trial stops publishing.
    """
    from pipeline.database import (
        read_nct_registry_ids,
        update_trial_statuses,
        upsert_clinical_trials_batch,
    )

    init_ctg_fetch_state(config)

    try:
        studies, term_errors = await fetch_disease_studies(
            search_terms=config.ct_search_terms,
            page_size=config.ct_page_size,
            max_retries=config.ct_max_retries,
        )
    except Exception as e:
        # The search itself failed, so nothing was fetched and nothing
        # written: the sync stopped rather than carried on, which is what
        # `aborted` says and what makes the refresh red.
        logger.exception("CTG fetch failed")
        return ClinicalTrialSyncResult(errors=[f"CTG fetch: {e}"], aborted=True)

    errors = term_errors.copy()

    records: list[ClinicalTrialRecord] = []
    studies_without_nct = 0
    studies_without_drug = 0
    map_failures = 0
    for study in studies:
        try:
            nct = _nct_id(study)
            if nct is None:
                studies_without_nct += 1
                continue
            mapped = _map_study_to_records(study)
            if not mapped:
                studies_without_drug += 1
            records.extend(mapped)
        except Exception as e:  # defensive — malformed study dict
            nct = _nct_id(study)
            map_failures += 1
            errors.append(f"CTG map {nct or '?'}: {e}")

    if studies_without_nct:
        logger.debug(f"CTG: {studies_without_nct} studies dropped (missing NCT ID)")
    if studies_without_drug:
        logger.info(
            f"CTG: {studies_without_drug}/{len(studies)} studies had "
            "no DRUG-type intervention (skipped)"
        )

    try:
        written = await upsert_clinical_trials_batch(records)
    except Exception as e:
        logger.exception("CTG upsert failed")
        errors.append(f"CTG upsert: {e}")
        # One statement writes every record, so a failure here wrote none
        # of them: the refresh is red, not amber.
        return ClinicalTrialSyncResult(
            fetched=len(studies),
            failed=len(records),
            errors=errors,
            aborted=True,
        )

    # The search cannot cover the curated set -- `is_disease_study` and the
    # interventional and drug-type gates all drop trials a curator
    # nonetheless published -- so every NCT id in the table is swept by id,
    # whether the search reached it or not. It is best effort by
    # construction: a failed batch is an `errors` entry and those trials keep
    # the status they had, because the alternative to a stale status here is
    # a trial silently vanishing from Table 2.
    status_refreshed = 0
    try:
        statuses, status_errors = await fetch_trial_statuses(
            await read_nct_registry_ids(), config.ct_max_retries
        )
        errors.extend(status_errors)
        status_refreshed = await update_trial_statuses(statuses)
    except Exception as e:  # pragma: no cover - defensive
        logger.exception("CTG status sweep failed")
        errors.append(f"CTG status sweep: {e}")

    # A phase the radar has no ring for is an error, not a log line: the
    # trial still publishes into Table 2, so the table and the figure
    # disagree about the trial set until someone respells it. The unmatched
    # intervention names beside it are not -- CT.gov names an agent
    # differently from the curated row on most trials, every run, and a
    # standing red badge would say nothing. `upsert_clinical_trials_batch`
    # warns with the whole list.
    errors.extend(
        f"CTG {registry}: phase {phase!r} has no ring on the trials radar, "
        "so the trial publishes in Table 2 and on no ring of the figure"
        for registry, phase in _unplaceable_phases(records, written.curated_ids)
    )

    if written.discovered:
        logger.info(
            "CTG: %d row(s) written for trials no curator has seen; they stay "
            "out of data/table2.json until target_population is filled in",
            written.discovered,
        )
    logger.info(
        f"CTG sync: {len(studies)} studies fetched, "
        f"{written.refreshed} rows refreshed, "
        f"{written.discovered} uncurated rows discovered, "
        f"{status_refreshed} status(es) changed "
        f"(errors={len(errors)})"
    )
    return ClinicalTrialSyncResult(
        fetched=len(studies),
        cached=written.written,
        failed=map_failures,
        discovered=written.discovered,
        status_refreshed=status_refreshed,
        errors=errors,
    )
